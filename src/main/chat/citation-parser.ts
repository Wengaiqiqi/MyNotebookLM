
export type CitationRegion =
  | { type: "text"; text: string }
  | { type: "code"; text: string };

export type RetrievedCitation = {
  label: string;
  chunkId: string;
  sourceId: string;
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

const MARKER_RE = /\[S(\d{1,2})\]/g;
type Region = CitationRegion & { start: number };

/** Split answer into code / non-code regions; [S#] markers only count in "text". */
function splitCodeRegions(text: string): Region[] {
  const regions: Region[] = [];
  let buf = "";
  let mode: "text" | "inline" | "fence" = "text";
  const flush = () => {
    if (!buf) return;
    regions.push({ type: mode === "text" ? "text" : "code", text: buf, start: bufStart });
    buf = "";
  };
  let bufStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      if (mode === "text" && text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
        flush();
        mode = "fence";
        const closeIdx = text.indexOf("\n```", i + 3);
        if (closeIdx === -1) {
          buf = text.slice(i);
          bufStart = i;
          flush();
          return regions;
        }
        buf = text.slice(i, closeIdx + 4);
        bufStart = i;
        flush();
        i = closeIdx + 4;
        mode = "text";
        continue;
      }
      if (mode === "text") {
        flush();
        mode = "inline";
        i++;
        bufStart = i;
        continue;
      }
      if (mode === "inline") {
        flush();
        mode = "text";
        i++;
        bufStart = i;
        continue;
      }
      // Backtick inside a fenced block is literal content.
    }
    buf += ch;
    i++;
  }
  flush();
  return regions;
}

function findMarkers(text: string): { valid: ParsedCitation[]; invalid: boolean } {
  const valid: ParsedCitation[] = [];
  let invalid = false;
  const regions = splitCodeRegions(text);
  // Loose shape used only for diagnostics: bracketed S+digits or bare digits.
  const LOOSE_RE = /\[[Ss]?[ \t]*-?[ \t]*\d{1,3}(?:[ \t]*-[ \t]*\d{1,3})?[ \t]*\]/g;
  for (let idx = 0; idx < regions.length; idx++) {
    const region = regions[idx]!;
    if (region.type !== "text") continue;
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(region.text)) !== null) {
      const n = Number(m[1]);
      const start = region.start + m.index;
      if (n >= 1 && n <= 99) {
        valid.push({ label: `S${n}`, start, end: start + m[0].length });
      } else {
        // Well-formed but outside the supported two-digit label range.
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

function trailingHoldLength(text: string): number {
  const m = /\[[Ss]?[0-9]{0,2}\]?$/.exec(text);
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
