import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

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

interface BatchEmbedResponse {
  embeddings?: { values: number[] }[];
}

@Injectable()
export class EmbeddingsService {
  private readonly log = new Logger(EmbeddingsService.name);

  constructor(private readonly config: ConfigService) { }

  private get apiKey(): string | undefined {
    return this.config.get<string>('GEMINI_API_KEY');
  }

  private get model(): string {
    return this.config.get<string>(
      'GEMINI_EMBEDDING_MODEL',
      'gemini-embedding-001',
    );
  }

  get dims(): number {
    return this.config.get<number>('GEMINI_EMBEDDING_DIMS', 768);
  }

  /** Embed a single query (RETRIEVAL_QUERY task type, optimized for search). */
  async embedQuery(text: string): Promise<number[] | null> {
    const [vec] = await this.embedBatch([text], 'RETRIEVAL_QUERY');
    return vec ?? null;
  }

  /** Embed many documents in a single batched call (Gemini supports up to 100). */
  async embedBatch(
    texts: string[],
    taskType: TaskType = 'RETRIEVAL_DOCUMENT',
  ): Promise<number[][]> {
    if (!texts.length) return [];
    const key = this.apiKey;
    if (!key) {
      this.log.warn('GEMINI_API_KEY missing — skipping embeddings');
      return texts.map(() => []);
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${key}`;
    const body = JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: this.dims,
      })),
    });
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
          const isQuota =
            r.status === 429 && /quota|FreeTier|PerDay/i.test(errText);
          if (isQuota) {
            throw new EmbeddingsQuotaExceededError(
              `embeddings quota exhausted: ${errText.slice(0, 200)}`,
            );
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
        const data = (await r.json()) as BatchEmbedResponse;
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
