import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const DEFAULT_MODEL = 'gemini-2.5-flash';

const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Gemma doesn't support `responseSchema` / `responseMimeType: 'application/json'`.
 * For Gemma models we inline the schema into the prompt and parse JSON from the
 * raw text response (stripping optional ```json fences).
 */
function isGemma(model: string): boolean {
  return model.toLowerCase().startsWith('gemma');
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  // Common ```json ... ``` wrapping
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  // Sometimes there's prose before the JSON — grab from the first { or [
  const firstBrace = trimmed.search(/[\{\[]/);
  if (firstBrace > 0) return trimmed.slice(firstBrace);
  return trimmed;
}

/**
 * Extracts all top-level balanced JSON objects from a string.
 * Gemma sometimes writes multiple JSON sketches/refinements — this returns
 * them all so the caller can pick the one matching the expected schema.
 */
function extractAllJsonObjects(text: string): string[] {
  const results: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') {
      i++;
      continue;
    }
    const open = ch;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    results.push(text.slice(i, end + 1));
    i = end + 1;
  }
  return results;
}

@Injectable()
export class GeminiService {
  private readonly log = new Logger(GeminiService.name);

  constructor(private readonly config: ConfigService) {}

  get apiKey(): string | undefined {
    return this.config.get<string>('GEMINI_API_KEY');
  }

  get provider(): 'gemini' | 'ollama' {
    return this.config.get<string>('LLM_PROVIDER') === 'ollama'
      ? 'ollama'
      : 'gemini';
  }

  /** True when *some* LLM backend is configured (Gemini key OR Ollama). */
  get hasLlm(): boolean {
    return this.provider === 'ollama' || !!this.apiKey;
  }

  /** Generate JSON using Gemini structured output, Gemma prompt-embedded schema, or Ollama. */
  async generateJson<T>(
    prompt: string,
    responseSchema: Record<string, unknown>,
    options: {
      model?: string;
      temperature?: number;
      maxAttempts?: number;
      maxOutputTokens?: number;
    } = {},
  ): Promise<T | null> {
    if (this.provider === 'ollama') {
      return this.generateJsonOllama<T>(prompt, responseSchema, options);
    }
    const key = this.apiKey;
    if (!key) {
      this.log.warn('GEMINI_API_KEY missing — skipping LLM call');
      return null;
    }
    const model = options.model ?? DEFAULT_MODEL;
    const maxAttempts = options.maxAttempts ?? 3;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    const gemma = isGemma(model);
    const finalPrompt = gemma
      ? `${prompt}\n\n---\nResponda APENAS com UM ÚNICO objeto JSON válido seguindo EXATAMENTE este schema. NÃO adicione explicações, raciocínio, comentários ou texto após o JSON. NÃO refine ou repita a resposta. Use APENAS aspas duplas (").\n\n${JSON.stringify(responseSchema, null, 2)}`
      : prompt;

    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
    };
    if (!gemma) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = responseSchema;
    }

    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
      generationConfig,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
        if (!r.ok) {
          const text = await r.text();
          const isQuotaExceeded =
            r.status === 429 &&
            /quota|exceeded|FreeTier|PerDay/i.test(text);
          if (isQuotaExceeded) {
            this.log.error(
              `${model} quota exhausted — aborting retries. ${text.slice(0, 200)}`,
            );
            return null;
          }
          if (RETRYABLE_STATUSES.has(r.status) && attempt < maxAttempts) {
            const backoff = 500 * Math.pow(2, attempt - 1);
            this.log.warn(
              `${model} ${r.status} (attempt ${attempt}/${maxAttempts}) — retrying in ${backoff}ms`,
            );
            await new Promise((res) => setTimeout(res, backoff));
            continue;
          }
          this.log.error(`${model} ${r.status}: ${text.slice(0, 300)}`);
          return null;
        }
        const data = (await r.json()) as {
          candidates?: {
            content?: { parts?: { text?: string }[] };
            finishReason?: string;
          }[];
        };
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;
        const finishReason = candidate?.finishReason;
        if (!text) {
          this.log.error(`${model} empty response (finishReason=${finishReason})`);
          return null;
        }
        if (finishReason === 'MAX_TOKENS') {
          this.log.warn(
            `${model} output truncated (MAX_TOKENS). Bump maxOutputTokens for this call.`,
          );
        }
        const jsonText = gemma ? stripJsonFence(text) : text;
        try {
          return JSON.parse(jsonText) as T;
        } catch {
          const requiredKeys = Array.isArray(
            (responseSchema as { required?: unknown }).required,
          )
            ? ((responseSchema as { required: string[] }).required)
            : [];
          const candidates = gemma ? extractAllJsonObjects(jsonText) : [];
          for (const extracted of candidates) {
            try {
              const parsed = JSON.parse(extracted) as Record<string, unknown>;
              const hasAllRequired =
                requiredKeys.length === 0 ||
                requiredKeys.every((k) =>
                  Object.prototype.hasOwnProperty.call(parsed, k),
                );
              if (!hasAllRequired) continue;
              this.log.debug(
                `${model} recovered JSON via balanced-brace extraction (${jsonText.length}→${extracted.length} chars)`,
              );
              return parsed as T;
            } catch {
              // try next candidate
            }
          }
          if (candidates.length > 0) {
            this.log.error(
              `${model} JSON candidates parsed but none had all required keys [${requiredKeys.join(', ')}]. Tried ${candidates.length} object(s). First candidate:\n${candidates[0].slice(0, 800)}`,
            );
            return null;
          }
          this.log.error(
            `${model} JSON parse failed (finishReason=${finishReason}, len=${jsonText.length})\n--- raw output ---\n${jsonText.slice(0, 1500)}\n--- end ---`,
          );
          return null;
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt < maxAttempts) {
          const backoff = 500 * Math.pow(2, attempt - 1);
          this.log.warn(
            `${model} network exception (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${backoff}ms`,
          );
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }
        this.log.error(`${model} exception (final): ${msg}`);
        return null;
      }
    }
    return null;
  }

  /**
   * Ollama adapter. Mirrors generateJson<T>() contract: returns parsed JSON or null.
   * Uses /api/chat with `format: <schema>` (Ollama ≥0.5 supports strict JSON schema;
   * older versions accept `format: "json"` as a loose fallback).
   */
  private async generateJsonOllama<T>(
    prompt: string,
    responseSchema: Record<string, unknown>,
    options: {
      model?: string;
      temperature?: number;
      maxAttempts?: number;
      maxOutputTokens?: number;
    } = {},
  ): Promise<T | null> {
    const baseUrl =
      this.config.get<string>('OLLAMA_URL') ?? 'http://host.docker.internal:11434';
    const model =
      options.model && !/^(gemini|gemma)/i.test(options.model)
        ? options.model
        : this.config.get<string>('OLLAMA_MODEL') ?? 'qwen2.5:7b-instruct';
    const maxAttempts = options.maxAttempts ?? 2;

    const finalPrompt = `${prompt}\n\n---\nResponda APENAS com UM ÚNICO objeto JSON válido seguindo EXATAMENTE este schema. NÃO adicione explicações, raciocínio, comentários ou texto após o JSON. Use APENAS aspas duplas (").\n\nSchema:\n${JSON.stringify(responseSchema, null, 2)}`;

    const body = JSON.stringify({
      model,
      stream: false,
      format: responseSchema,
      messages: [{ role: 'user', content: finalPrompt }],
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxOutputTokens ?? 2048,
      },
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS * 4, // local models are slower
      );
      try {
        const r = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
        if (!r.ok) {
          const text = await r.text();
          this.log.error(
            `ollama(${model}) ${r.status} (attempt ${attempt}/${maxAttempts}): ${text.slice(0, 300)}`,
          );
          if (attempt < maxAttempts) continue;
          return null;
        }
        const data = (await r.json()) as {
          message?: { content?: string };
          done_reason?: string;
        };
        const text = data?.message?.content;
        if (!text) {
          this.log.error(
            `ollama(${model}) empty response (done_reason=${data?.done_reason})`,
          );
          return null;
        }
        const jsonText = stripJsonFence(text);
        try {
          return JSON.parse(jsonText) as T;
        } catch {
          const requiredKeys = Array.isArray(
            (responseSchema as { required?: unknown }).required,
          )
            ? (responseSchema as { required: string[] }).required
            : [];
          const candidates = extractAllJsonObjects(jsonText);
          for (const extracted of candidates) {
            try {
              const parsed = JSON.parse(extracted) as Record<string, unknown>;
              const hasAllRequired =
                requiredKeys.length === 0 ||
                requiredKeys.every((k) =>
                  Object.prototype.hasOwnProperty.call(parsed, k),
                );
              if (!hasAllRequired) continue;
              this.log.debug(
                `ollama(${model}) recovered JSON via brace extraction`,
              );
              return parsed as T;
            } catch {
              // try next
            }
          }
          this.log.error(
            `ollama(${model}) JSON parse failed (len=${jsonText.length})\n--- raw ---\n${jsonText.slice(0, 1500)}\n--- end ---`,
          );
          return null;
        }
      } catch (e) {
        const msg = (e as Error).message;
        this.log.error(
          `ollama(${model}) exception (attempt ${attempt}/${maxAttempts}): ${msg}`,
        );
        if (attempt < maxAttempts) continue;
        return null;
      }
    }
    return null;
  }
}
