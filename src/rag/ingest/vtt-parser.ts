export interface VttCue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMESTAMP_RE =
  /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

function toMs(h: string, m: string, s: string, ms: string): number {
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(m, 10) * 60_000 +
    parseInt(s, 10) * 1_000 +
    parseInt(ms, 10)
  );
}

/**
 * Minimal WebVTT / SRT parser. Returns cues with millisecond timestamps and
 * normalized text (whitespace collapsed, inline cue settings stripped).
 */
export function parseVtt(raw: string): VttCue[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const cues: VttCue[] = [];
  let i = 0;
  // Skip WEBVTT header if present
  if (lines[0]?.startsWith('WEBVTT')) i = 1;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    const tsMatch = line.match(TIMESTAMP_RE);
    if (!tsMatch) {
      i++;
      continue;
    }
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = tsMatch;
    const startMs = toMs(h1, m1, s1, ms1);
    const endMs = toMs(h2, m2, s2, ms2);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }
    const text = textLines
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) cues.push({ startMs, endMs, text });
  }
  return cues;
}
