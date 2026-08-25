import { createHash } from "node:crypto";
import type { SourceLocator } from "../../shared/sources";
import type { DocumentBlock, PreparedChunk } from "./types";

export const CHUNKING_VERSION = "blocks-900-150-v1";

export const DEFAULT_TARGET_TOKENS = 900;
export const DEFAULT_OVERLAP_TOKENS = 150;

const CJK_CODE_POINT =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/**
 * Deterministic token estimate: CJK code points cost 1 token each, and
 * non-CJK UTF-8 words are inflated by ceil(wordCount * 1.3).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let nonCjkWords = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    let hasNonCjk = false;
    for (const char of token) {
      if (CJK_CODE_POINT.test(char)) cjk += 1;
      else hasNonCjk = true;
    }
    if (hasNonCjk) nonCjkWords += 1;
  }
  return cjk + Math.ceil(nonCjkWords * 1.3);
}

function chunkHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mergeLocators(first: SourceLocator, last: SourceLocator): SourceLocator {
  if (first.kind === "offset" && last.kind === "offset") {
    return {
      kind: "offset",
      start: Math.min(first.start, last.start),
      end: Math.max(first.end, last.end)
    };
  }
  if (first.kind === "row" && last.kind === "row" && first.sheet === last.sheet) {
    return {
      kind: "row",
      sheet: first.sheet,
      startRow: Math.min(first.startRow, last.startRow),
      endRow: Math.max(first.endRow, last.endRow)
    };
  }
  if (first.kind === "paragraph" && last.kind === "paragraph") {
    return { kind: "paragraph", paragraph: Math.min(first.paragraph, last.paragraph) };
  }
  return first;
}

interface Fragment {
  block: DocumentBlock;
  text: string;
  tokens: number;
  isHeading: boolean;
  isAtomic: boolean;
}

function toFragments(block: DocumentBlock, targetTokens: number): Fragment[] {
  if (block.kind === "heading" || block.kind === "table") {
    return [
      {
        block,
        text: block.text,
        tokens: estimateTokens(block.text),
        isHeading: block.kind === "heading",
        isAtomic: true
      }
    ];
  }
  const sentences = splitSentences(block.text);
  const fragments: Fragment[] = [];
  for (const sentence of sentences) {
    const tokens = estimateTokens(sentence);
    if (tokens <= targetTokens) {
      fragments.push({ block, text: sentence, tokens, isHeading: false, isAtomic: false });
      continue;
    }
    for (const piece of splitByTokens(sentence, targetTokens)) {
      fragments.push({ block, text: piece, tokens: estimateTokens(piece), isHeading: false, isAtomic: false });
    }
  }
  return fragments;
}

interface ChunkState {
  fragments: Fragment[];
  tokens: number;
  firstLocator: SourceLocator | undefined;
  lastLocator: SourceLocator | undefined;
}

function emptyState(): ChunkState {
  return { fragments: [], tokens: 0, firstLocator: undefined, lastLocator: undefined };
}

function joinFragments(fragments: Fragment[]): string {
  let out = "";
  for (let i = 0; i < fragments.length; i += 1) {
    if (i > 0) {
      const prev = fragments[i - 1]!;
      const next = fragments[i]!;
      const tight = prev.block.kind === "list" || prev.block.kind === "sheet-row" ||
        next.block.kind === "list" || next.block.kind === "sheet-row";
      out += tight ? "\n" : "\n\n";
    }
    out += fragments[i]!.text;
  }
  return out;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

export function chunkBlocks(
  blocks: DocumentBlock[],
  options: ChunkOptions = {}
): PreparedChunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (blocks.length === 0) return [];

  const fragments: Fragment[] = [];
  for (const block of blocks) fragments.push(...toFragments(block, targetTokens));

  const chunks: PreparedChunk[] = [];
  const lastChunkFragments = new Map<PreparedChunk, Fragment[]>();
  let state = emptyState();
  let activeHeading: DocumentBlock | undefined;

  const flush = (): void => {
    if (state.fragments.length === 0) return;
    const isHeadingOnly = state.fragments.length === 1 && state.fragments[0]!.isHeading;
    const body = joinFragments(state.fragments);
    const prefix = !isHeadingOnly && activeHeading ? activeHeading.text + "\n\n" : "";
    const text = (prefix + body).trim();
    if (text.length === 0) return;
    const prefixTokens = prefix.length > 0 ? estimateTokens(activeHeading!.text) : 0;
    const locator = state.firstLocator && state.lastLocator
      ? mergeLocators(state.firstLocator, state.lastLocator)
      : state.firstLocator!;
    const chunk: PreparedChunk = {
      ordinal: chunks.length,
      text,
      locator,
      contentHash: chunkHash(text),
      tokenEstimate: state.tokens + prefixTokens
    };
    chunks.push(chunk);
    lastChunkFragments.set(chunk, state.fragments.slice());
    state = emptyState();
  };

  const startOverlap = (): void => {
    if (chunks.length === 0) return;
    const prevChunk = chunks[chunks.length - 1]!;
    const prevFragments = lastChunkFragments.get(prevChunk) ?? [];
    const tail: Fragment[] = [];
    let tailTokens = 0;
    for (let i = prevFragments.length - 1; i >= 0; i -= 1) {
      const f = prevFragments[i]!;
      if (f.isAtomic) break;
      if (tailTokens + f.tokens > overlapTokens) break;
      tail.unshift(f);
      tailTokens += f.tokens;
    }
    for (const f of tail) {
      if (state.fragments.length === 0) state.firstLocator = f.block.locator;
      state.fragments.push(f);
      state.tokens += f.tokens;
      state.lastLocator = f.block.locator;
    }
  };

  for (const fragment of fragments) {
    if (fragment.block.kind === "table") {
      flush();
      state.fragments.push(fragment);
      state.tokens += fragment.tokens;
      state.firstLocator = fragment.block.locator;
      state.lastLocator = fragment.block.locator;
      flush();
      continue;
    }
    if (fragment.isHeading) {
      flush();
      activeHeading = fragment.block;
      state.fragments.push(fragment);
      state.tokens += fragment.tokens;
      state.firstLocator = fragment.block.locator;
      state.lastLocator = fragment.block.locator;
      flush();
      continue;
    }
    if (state.fragments.length > 0 && state.tokens + fragment.tokens > targetTokens) {
      flush();
      startOverlap();
    }
    if (state.fragments.length === 0) state.firstLocator = fragment.block.locator;
    state.fragments.push(fragment);
    state.tokens += fragment.tokens;
    state.lastLocator = fragment.block.locator;
  }
  flush();

  return chunks;
}

function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [text];
  const parts = trimmed.split(/(?<=[.!?。！？])\s+/);
  return parts.length > 0 ? parts : [text];
}

function splitByTokens(text: string, targetTokens: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const word of words) {
    const tokens = estimateTokens(word);
    if (current.length > 0 && currentTokens + tokens > targetTokens) {
      pieces.push(current.join(" "));
      current = [];
      currentTokens = 0;
    }
    current.push(word);
    currentTokens += tokens;
  }
  if (current.length > 0) pieces.push(current.join(" "));
  return pieces;
}
