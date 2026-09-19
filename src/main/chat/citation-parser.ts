
export type CitationRegion =
  | { type: "text"; text: string }
  | { type: "code"; text: string };

export type RetrievedCitation = {
  label: string;
  chunkId: string;
  sourceId: string;
  revisionId?: string;
  contentHash?: string;
  sourceDisplayName: string;
  sourceKind: string;
  locator: Record<string, unknown>;
  text?: string;
};

export type ParsedCitation = { label: string; start: number; end: number };

export type ParsedCitations = {
  citations: ParsedCitation[];
  hasInvalidCitations: boolean;
  /** Original answer text, byte-identical; unknown markers stay visible. */
  content: string;
};

const MARKER_RE = /\[S(\d{1,16})\]/g;
type Region = CitationRegion & { start: number };

/** Split answer into code / non-code regions; [S#] markers only count in "text". */
function splitCodeRegions(text: string): Region[] {
  const regions: Region[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    const lineStart = i === 0 || text[i - 1] === "\n";
    const fence = lineStart ? /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(i)) : null;
    const inline = !fence && text[i] === "`" ? /^`+/.exec(text.slice(i)) : null;
    if (!fence && !inline) { i++; continue; }
    let end = text.length;
    if (fence) {
      const delimiter = fence[1]!;
      const closing = new RegExp("^ {0,3}" + delimiter[0] + "{" + delimiter.length + ",}[ \t]*\r?$", "gm");
      closing.lastIndex = i + fence[0].length;
      const match = closing.exec(text);
      if (match) end = match.index + match[0].length;
    } else {
      const delimiter = inline![0];
      const runs = /`+/g;
      runs.lastIndex = i + delimiter.length;
      let match: RegExpExecArray | null;
      while ((match = runs.exec(text))) { if (match[0].length === delimiter.length) { end = match.index + match[0].length; break; } }
    }
    if (plainStart < i) regions.push({ type: "text", text: text.slice(plainStart, i), start: plainStart });
    regions.push({ type: "code", text: text.slice(i, end), start: i });
    plainStart = i = end;
  }
  if (plainStart < text.length) regions.push({ type: "text", text: text.slice(plainStart), start: plainStart });
  return regions;
}

function findMarkers(text: string): { valid: ParsedCitation[]; invalid: boolean } {
  const valid: ParsedCitation[] = [];
  let invalid = false;
  const regions = splitCodeRegions(text);
  const tail = regions.at(-1);
  // A truncated prose marker may be completed by the next request. Treat it
  // as uncertain evidence, not as proof that the answer has no citations.
  if (tail?.type === "text" && /\[(?:S[0-9]{0,16})?$/.test(tail.text)) invalid = true;
  // Loose shape used only for diagnostics: bracketed S+digits or bare digits.
  const LOOSE_RE = /\[[Ss]?[ \t]*-?[ \t]*\d{1,16}(?:[ \t]*-[ \t]*\d{1,16})?[ \t]*\]/g;
  for (let idx = 0; idx < regions.length; idx++) {
    const region = regions[idx]!;
    if (region.type !== "text") continue;
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(region.text)) !== null) {
      const n = Number(m[1]);
      const start = region.start + m.index;
      if (Number.isSafeInteger(n) && n >= 1 && m[1] === String(n)) {
        valid.push({ label: `S${n}`, start, end: start + m[0].length });
      } else {
        // Well-formed but outside the safe positive integer label range.
        invalid = true;
      }
    }
    LOOSE_RE.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = LOOSE_RE.exec(region.text)) !== null) {
      const start = region.start + d.index;
      const overlapsValid = valid.some((v) => start >= v.start && start < v.end);
      if (!overlapsValid) {
        // Malformed citation attempt ([s1], [ S2 ], [S-3], ...) or stale id text:
        // keep visible, flag for diagnostics only.
        invalid = true;
      }
    }
  }
  return { valid, invalid };
}
export function finalizeCitations(text: string, retrievals: Record<string, RetrievedCitation>): ParsedCitations {
  const { valid, invalid } = findMarkers(text);
  const citations = valid.filter((c) => Boolean(retrievals[c.label]));
  // Unknown labels for this request are removed from records yet stay visible in text.
  const hasInvalid = invalid || valid.some((c) => !retrievals[c.label]);
  return { citations, hasInvalidCitations: hasInvalid, content: text };
}

/** Only prose citation markers are rewritten; offsets preserve code verbatim. */
export function neutralizeHistoricalCitations(text: string): string {
  const markers = findMarkers(text).valid;
  for (const marker of markers.reverse()) {
    text = text.slice(0, marker.start) + "[previous citation]" + text.slice(marker.end);
  }
  return text;
}

function trailingHoldLength(text: string): number {
  const m = /\[[Ss]?[0-9]{0,16}\]?$/.exec(text);
  return m ? m[0].length : 0;
}

/** Incremental streaming buffer; holds back a trailing partial marker so "[S1]" split across chunks still resolves. */
export class CitationStreamBuffer {
  private buf = "";

  push(chunk: string): string {
    this.buf += chunk;
    const hold = trailingHoldLength(this.buf);
    const emitLen = this.buf.length - hold;
    const out = this.buf.slice(0, emitLen);
    this.buf = this.buf.slice(emitLen);
    return out;
  }

  /** Characters held back awaiting more input. */
  pendingSuffixLength(): number {
    return this.buf.length;
  }

  flush(): string {
    const out = this.buf;
    this.buf = "";
    return out;
  }
}
