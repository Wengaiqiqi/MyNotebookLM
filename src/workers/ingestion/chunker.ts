import { createHash } from "node:crypto";
import type { SourceLocator } from "../../shared/sources";
import type { DocumentBlock, PreparedChunk } from "./types";

export const CHUNKING_VERSION = "blocks-480-80-v5";

export const DEFAULT_TARGET_TOKENS = 480;
export const DEFAULT_OVERLAP_TOKENS = 80;

const CJK_CODE_POINT =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

// Matches a non-CJK word character: letters, digits, connectors but not
// whitespace or punctuation. Kept deliberately narrow so punctuation and
// CJK code points act as word boundaries during token estimation.
const WORD_CHAR = /[A-Za-z0-9_-]/;

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}

/**
 * Deterministic token estimate biased toward OVER-counting, because an
 * underestimate lets oversized chunks reach providers that reject them.
 * Each CJK code point costs 1 token, each digit costs 1 token (tokenizers
 * break digit runs far more aggressively than 1.3/word), each visible
 * symbol costs 1 token, and each remaining non-CJK word costs ceil(1.3)
 * tokens. CJK characters and punctuation act as word boundaries so
 * unspaced mixed text (e.g. "ab你cd") is not collapsed into a single
 * under-counted word.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let wordCount = 0;
  let digits = 0;
  let symbols = 0;
  let inWord = false;
  for (const char of text) {
    if (CJK_CODE_POINT.test(char)) {
      if (inWord) { wordCount += 1; inWord = false; }
      cjk += 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      if (inWord) { wordCount += 1; inWord = false; }
      digits += 1;
      continue;
    }
    if (isWordChar(char)) { inWord = true; continue; }
    if (inWord) { wordCount += 1; inWord = false; }
    if (!/\s/.test(char)) symbols += 1;
  }
  if (inWord) wordCount += 1;
  return cjk + digits + symbols + Math.ceil(wordCount * 1.3);
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
    return {
      kind: "paragraph",
      paragraph: Math.min(first.paragraph, last.paragraph),
      endParagraph: Math.max(first.endParagraph ?? first.paragraph, last.endParagraph ?? last.paragraph)
    };
  }
  if (first.kind === "page" && last.kind === "page") {
    return {
      kind: "page",
      page: Math.min(first.page, last.page),
      endPage: Math.max(first.endPage ?? first.page, last.endPage ?? last.page)
    };
  }
  if (first.kind === "slide" && last.kind === "slide") {
    return {
      kind: "slide",
      slide: Math.min(first.slide, last.slide),
      endSlide: Math.max(first.endSlide ?? first.slide, last.endSlide ?? last.slide)
    };
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
  if (block.kind === "heading") {
    const tokens = estimateTokens(block.text);
    if (tokens <= targetTokens) {
      return [{ block, text: block.text, tokens, isHeading: true, isAtomic: true }];
    }
    return splitByTokens(block.text, targetTokens).map((piece) => ({
      block,
      text: piece,
      tokens: estimateTokens(piece),
      isHeading: true,
      isAtomic: true
    }));
  }
  const isAtomic = block.kind === "table";
  const sentences = splitSentences(block.text);
  const fragments: Fragment[] = [];
  for (const sentence of sentences) {
    const tokens = estimateTokens(sentence);
    if (tokens <= targetTokens) {
      fragments.push({ block, text: sentence, tokens, isHeading: false, isAtomic });
      continue;
    }
    for (const piece of splitByTokens(sentence, targetTokens)) {
      fragments.push({ block, text: piece, tokens: estimateTokens(piece), isHeading: false, isAtomic });
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
      if (prev.block !== next.block) {
        const tight = prev.block.kind === "list" || prev.block.kind === "sheet-row" ||
          next.block.kind === "list" || next.block.kind === "sheet-row";
        out += tight ? "\n" : "\n\n";
      }
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
    if (activeHeading) return;
    const prevChunk = chunks[chunks.length - 1]!;
    const prevFragments = lastChunkFragments.get(prevChunk) ?? [];
    const tail: Fragment[] = [];
    let tailTokens = 0;
    const prefixTokens = 0;
    const tailBudget = Math.min(overlapTokens, targetTokens - prefixTokens);
    for (let i = prevFragments.length - 1; i >= 0; i -= 1) {
      const f = prevFragments[i]!;
      if (f.isAtomic) break;
      if (tailTokens + f.tokens > tailBudget) break;
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
      if (estimateTokens(fragment.block.text) <= targetTokens) {
        activeHeading = fragment.block.locator.kind === "heading"
          ? { ...fragment.block, text: fragment.block.locator.headingPath }
          : fragment.block;
        continue;
      }
      activeHeading = undefined;
      state.fragments.push(fragment);
      state.tokens += fragment.tokens;
      state.firstLocator = fragment.block.locator;
      state.lastLocator = fragment.block.locator;
      flush();
      continue;
    }
    const prefixTokens = activeHeading ? estimateTokens(activeHeading.text) : 0;
    const budget = targetTokens - prefixTokens;
    if (state.fragments.length > 0 && state.tokens + fragment.tokens > budget) {
      flush();
      startOverlap();
    }
    const remaining = budget - state.tokens;
    if (fragment.tokens > remaining) {
      for (const piece of splitByTokens(fragment.text, remaining)) {
        const pieceTokens = estimateTokens(piece);
        if (state.fragments.length > 0 && state.tokens + pieceTokens > budget) {
          flush();
          startOverlap();
        }
        if (state.fragments.length === 0) state.firstLocator = fragment.block.locator;
        state.fragments.push({ ...fragment, text: piece, tokens: pieceTokens });
        state.tokens += pieceTokens;
        state.lastLocator = fragment.block.locator;
      }
      continue;
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
  const parts = trimmed.split(/(?<=[。！？])|(?<=[.!?])(?=\s)/u);
  return parts.length > 0 ? parts : [text];
}

function splitByTokens(text: string, targetTokens: number): string[] {
  const words = tokenizeForChunk(text);
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const word of words) {
    const tokens = estimateTokens(word);
    if (current.length > 0 && currentTokens + tokens > targetTokens) {
      pieces.push(current.join(""));
      current = [];
      currentTokens = 0;
    }
    current.push(word);
    currentTokens += tokens;
  }
  if (current.length > 0) pieces.push(current.join(""));
  return pieces;
}

function tokenizeForChunk(text: string): string[] {
  const units: string[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer.length > 0) {
      units.push(buffer);
      buffer = "";
    }
  };
  for (const char of text) {
    if (CJK_CODE_POINT.test(char)) {
      flush();
      units.push(char);
      continue;
    }
    if (isWordChar(char)) {
      buffer += char;
      continue;
    }
    flush();
    units.push(char);
  }
  flush();
  return units;
}
