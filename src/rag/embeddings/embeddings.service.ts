import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 90_000;

export class EmbeddingsQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsQuotaExceededError';
  }
}

type TaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY';

type Provider = 'gemini' | 'ollama';

interface GeminiBatchResponse {
  embeddings?: { values: number[] }[];
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

interface GeminiQuotaViolation {
  quotaId?: string;
  quotaMetric?: string;
}

interface GeminiErrorDetail {
  '@type'?: string;
  retryDelay?: string;
  violations?: GeminiQuotaViolation[];
}

interface GeminiErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GeminiErrorDetail[];
  };
}

interface ParsedGeminiError {
  isDailyQuota: boolean;
  retryAfterMs: number | null;
  quotaIds: string[];
}

function parseGeminiError(raw: string): ParsedGeminiError {
  const out: ParsedGeminiError = {
    isDailyQuota: false,
    retryAfterMs: null,
    quotaIds: [],
  };
  let parsed: GeminiErrorEnvelope | null = null;
  try {
    parsed = JSON.parse(raw) as GeminiErrorEnvelope;
  } catch {
    parsed = null;
  }
  const details = parsed?.error?.details ?? [];
  for (const d of details) {
    if (d['@type']?.endsWith('google.rpc.RetryInfo') && d.retryDelay) {
      const m = /^([\d.]+)s$/.exec(d.retryDelay);
      if (m) out.retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
    }
    if (d['@type']?.endsWith('google.rpc.QuotaFailure')) {
      for (const v of d.violations ?? []) {
        if (v.quotaId) out.quotaIds.push(v.quotaId);
      }
    }
  }
  out.isDailyQuota = out.quotaIds.some((id) => /PerDay/i.test(id));
  return out;
}

@Injectable()
export class EmbeddingsService {
  private readonly log = new Logger(EmbeddingsService.name);

  constructor(private readonly config: ConfigService) {}

  private get provider(): Provider {
    return (
      this.config.get<string>('EMBEDDINGS_PROVIDER', 'gemini').toLowerCase() ===
      'ollama'
        ? 'ollama'
        : 'gemini'
    );
  }

  get dims(): number {
    if (this.provider === 'ollama') {
      return this.config.get<number>('OLLAMA_EMBEDDING_DIMS', 768);
    }
    return this.config.get<number>('GEMINI_EMBEDDING_DIMS', 768);
  }

  /** Embed a single query (RETRIEVAL_QUERY task type, optimized for search). */
  async embedQuery(text: string): Promise<number[] | null> {
    const [vec] = await this.embedBatch([text], 'RETRIEVAL_QUERY');
    return vec ?? null;
  }

  async embedBatch(
    texts: string[],
    taskType: TaskType = 'RETRIEVAL_DOCUMENT',
  ): Promise<number[][]> {
    if (!texts.length) return [];
    if (this.provider === 'ollama') {
      return this.embedBatchOllama(texts);
    }
    return this.embedBatchGemini(texts, taskType);
  }

  /** Ollama batched embeddings via /api/embed (Ollama ≥0.2). */
  private async embedBatchOllama(texts: string[]): Promise<number[][]> {
    const baseUrl =
      this.config.get<string>('OLLAMA_URL') ?? 'http://host.docker.internal:11434';
    const model =
      this.config.get<string>('OLLAMA_EMBEDDING_MODEL') ?? 'nomic-embed-text';
    const url = `${baseUrl.replace(/\/$/, '')}/api/embed`;
    const body = JSON.stringify({ model, input: texts });
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!r.ok) {
          const errText = await r.text();
          if (RETRYABLE_STATUSES.has(r.status) && attempt < maxAttempts) {
            const backoff = 800 * Math.pow(2, attempt - 1);
            this.log.warn(
              `ollama embed ${r.status} (attempt ${attempt}/${maxAttempts}) — retry in ${backoff}ms`,
            );
            await new Promise((res) => setTimeout(res, backoff));
            continue;
          }
          this.log.error(
            `ollama embed ${r.status}: ${errText.slice(0, 250)} — giving up`,
          );
          return texts.map(() => []);
        }
        const data = (await r.json()) as OllamaEmbedResponse;
        const out = data.embeddings ?? (data.embedding ? [data.embedding] : []);
        if (out.length !== texts.length) {
          this.log.warn(
            `ollama embed length mismatch (got ${out.length}, expected ${texts.length})`,
          );
        }
        return texts.map((_, i) => out[i] ?? []);
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt < maxAttempts) {
          const backoff = 800 * Math.pow(2, attempt - 1);
          this.log.warn(
            `ollama embed exception (attempt ${attempt}/${maxAttempts}): ${msg} — retry in ${backoff}ms`,
          );
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }
        this.log.error(`ollama embed exception (final): ${msg}`);
        return texts.map(() => []);
      }
    }
    return texts.map(() => []);
  }

  /** Gemini batched embeddings (up to 100 per call). */
  private async embedBatchGemini(
    texts: string[],
    taskType: TaskType,
  ): Promise<number[][]> {
    const key = this.config.get<string>('GEMINI_API_KEY');
    if (!key) {
      this.log.warn('GEMINI_API_KEY missing — skipping embeddings');
      return texts.map(() => []);
    }
    const model = this.config.get<string>(
      'GEMINI_EMBEDDING_MODEL',
      'gemini-embedding-001',
    );
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${key}`;
    const body = JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: this.dims,
      })),
    });
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!r.ok) {
          const errText = await r.text();
          if (r.status === 429) {
            const info = parseGeminiError(errText);
            if (info.isDailyQuota) {
              throw new EmbeddingsQuotaExceededError(
                `daily embeddings quota exhausted (quotaId=${info.quotaIds.join(',')}): ${errText.slice(0, 200)}`,
              );
            }
            const waitMs = Math.min(
              info.retryAfterMs ?? 800 * Math.pow(2, attempt - 1),
              MAX_RETRY_DELAY_MS,
            );
            if (attempt < maxAttempts) {
              this.log.warn(
                `embeddings 429 rate-limit (attempt ${attempt}/${maxAttempts}, quotaId=${info.quotaIds.join(',') || 'n/a'}) — retry in ${waitMs}ms`,
              );
              await new Promise((res) => setTimeout(res, waitMs));
              continue;
            }
            this.log.error(
              `embeddings 429 (final attempt) — giving up. raw=${errText.slice(0, 250)}`,
            );
            return texts.map(() => []);
          }
          if (RETRYABLE_STATUSES.has(r.status) && attempt < maxAttempts) {
            const backoff = 800 * Math.pow(2, attempt - 1);
            this.log.warn(
              `embeddings ${r.status} (attempt ${attempt}/${maxAttempts}) — retry in ${backoff}ms`,
            );
            await new Promise((res) => setTimeout(res, backoff));
            continue;
          }
          this.log.error(
            `embeddings ${r.status}: ${errText.slice(0, 250)} — giving up`,
          );
          return texts.map(() => []);
        }
        const data = (await r.json()) as GeminiBatchResponse;
        const out = data.embeddings ?? [];
        if (out.length !== texts.length) {
          this.log.warn(
            `embeddings length mismatch (got ${out.length}, expected ${texts.length})`,
          );
        }
        return texts.map((_, i) => out[i]?.values ?? []);
      } catch (e) {
        if (e instanceof EmbeddingsQuotaExceededError) throw e;
        const msg = (e as Error).message;
        if (attempt < maxAttempts) {
          const backoff = 800 * Math.pow(2, attempt - 1);
          this.log.warn(
            `embeddings network exception (attempt ${attempt}/${maxAttempts}): ${msg} — retry in ${backoff}ms`,
          );
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }
        this.log.error(`embeddings exception (final): ${msg}`);
        return texts.map(() => []);
      }
    }
    return texts.map(() => []);
  }
}
