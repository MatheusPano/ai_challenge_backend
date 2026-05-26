import { VttCue } from './vtt-parser';

export interface Chunk {
  startMs: number;
  endMs: number;
  text: string;
  tokenCount: number;
  cueCount: number;
}

export interface ChunkerOptions {
  /** Target tokens per chunk (chunks may overshoot by one cue). */
  targetTokens: number;
  /** Hard upper bound — split aggressively beyond this. */
  maxTokens: number;
  /** Number of cues to overlap between consecutive chunks. */
  overlapCues: number;
}

const DEFAULTS: ChunkerOptions = {
  targetTokens: 500,
  maxTokens: 800,
  overlapCues: 1,
};

/**
 * Rough token estimator for Portuguese — 1 token ≈ 4 characters. Good enough
 * for chunk sizing; exact tokenization happens later inside Gemini.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Hybrid chunker: groups VTT cues into windows of ~targetTokens while
 * preserving cue-level timestamps. Carries overlapCues cues from the previous
 * chunk into the next so context isn't lost on chunk boundaries.
 */
export function chunkCues(
  cues: VttCue[],
  opts: Partial<ChunkerOptions> = {},
): Chunk[] {
  const cfg = { ...DEFAULTS, ...opts };
  const chunks: Chunk[] = [];
  if (!cues.length) return chunks;

  let buffer: VttCue[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.map((c) => c.text).join(' ');
    chunks.push({
      startMs: buffer[0].startMs,
      endMs: buffer[buffer.length - 1].endMs,
      text,
      tokenCount: estimateTokens(text),
      cueCount: buffer.length,
    });
  };

  for (const cue of cues) {
    const cueTokens = estimateTokens(cue.text);
    const wouldExceedTarget = bufferTokens + cueTokens > cfg.targetTokens;
    const wouldExceedHardMax = bufferTokens + cueTokens > cfg.maxTokens;

    if (buffer.length && (wouldExceedHardMax || wouldExceedTarget)) {
      flush();
      const overlap = buffer.slice(-cfg.overlapCues);
      buffer = [...overlap, cue];
      bufferTokens =
        overlap.reduce((acc, c) => acc + estimateTokens(c.text), 0) + cueTokens;
    } else {
      buffer.push(cue);
      bufferTokens += cueTokens;
    }
  }
  flush();
  return chunks;
}
