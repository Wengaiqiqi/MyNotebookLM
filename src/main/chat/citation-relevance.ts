const STOP_WORDS = new Set(["that", "this", "with", "from", "have", "will", "your", "about", "into", "there", "their", "what", "when", "where", "which"]);

export function citationClaim(content: string, start: number): string {
  const before = content.slice(0, Math.max(0, start)).replace(/[\s。！？.!?]+$/u, "");
  const boundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"), before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"));
  return before.slice(boundary + 1).trim();
}

export function relevantSourceRange(text: string, claim: string): { start: number; end: number } | null {
  const claimKeys = keywords(claim);
  if (claimKeys.size === 0) return null;
  let best: { start: number; end: number; score: number } | null = null;
  for (const range of sentenceRanges(text)) {
    const keys = keywords(text.slice(range.start, range.end));
    let overlap = 0;
    for (const key of claimKeys) if (keys.has(key)) overlap += 1;
    const score = overlap / Math.sqrt(claimKeys.size * Math.max(1, keys.size));
    if (score > (best?.score ?? 0)) best = { ...range, score };
  }
  return best?.score ? { start: best.start, end: best.end } : null;
}

export function relevantSourceExcerpt(text: string, claim: string, limit = 240): string {
  const range = relevantSourceRange(text, claim);
  return (range ? text.slice(range.start, range.end) : text).slice(0, limit).trim();
}

function sentenceRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  for (const sentence of segmenter.segment(text)) {
    for (const match of sentence.segment.matchAll(/[^\r\n]+/g)) {
      const line = match[0];
      const offset = sentence.index + (match.index ?? 0);
      const start = offset + line.search(/\S|$/);
      const end = offset + line.trimEnd().length;
      if (end > start) ranges.push({ start, end });
    }
  }
  return ranges;
}

function keywords(text: string): Set<string> {
  const result = new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((word) => !STOP_WORDS.has(word)));
  for (const sequence of text.match(/[\p{Script=Han}\u3040-\u30ff\uac00-\ud7af]+/gu) ?? []) {
    if (sequence.length === 1) result.add(sequence);
    else for (let index = 0; index < sequence.length - 1; index += 1) result.add(sequence.slice(index, index + 2));
  }
  return result;
}
