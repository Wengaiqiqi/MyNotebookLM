import type { ChatTurn } from "../models/provider";
import { buildSystemPrompt, type PromptLocale } from "./prompts";

export const MAX_CITED_CHUNKS = 32;
const DEFAULT_CONTEXT_TOKENS = 16_000;
const OUTPUT_RESERVE_RATIO = 0.2;
const MIN_OUTPUT_TOKEN_RESERVE = 1_024;
const OVERHEAD_RATIO = 0.1;
const NON_CJK_TOKENS_PER_WORD = 1.3;
const CJK_PATTERN = /[\p{Script=Han}\u3000-\u303f\u3040-\u30ff\uac00-\ud7af]/gu;
type RetrievedChunk = {
  chunkId: string;
  sourceId?: string;
  sourceDisplayName: string;
  sourceKind?: string;
  locator?: Record<string, unknown>;
  locatorSummary: string;
  text: string;
};
export type TokenBudget = { contextTokens: number; outputTokenReserve: number; inputTokenTarget: number };
export type ContextCitation = { label: string; chunkId: string; sourceDisplayName: string; locatorSummary: string };
export type AssembledContext = { messages: ChatTurn[]; citations: ContextCitation[]; tokenBudget: TokenBudget };
export function estimateTokens(text: string): number {
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const rest = text.replace(CJK_PATTERN, "");
  const nonCjkWords = rest.split(/\s+/).filter(Boolean).length;
  return cjkCount + Math.ceil(nonCjkWords * NON_CJK_TOKENS_PER_WORD);
}
function computeBudget(contextTokens?: number): TokenBudget {
  const total = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const outputTokenReserve = Math.max(MIN_OUTPUT_TOKEN_RESERVE, Math.round(total * OUTPUT_RESERVE_RATIO));
  const inputTokenTarget = Math.floor((total - outputTokenReserve) * (1 - OVERHEAD_RATIO));
  return { contextTokens: total, outputTokenReserve, inputTokenTarget };
}
function escapeEvidenceText(text: string): string {
  // Neutralize any potential tag start instead of only well-formed tags,
  // so variants like "</evidence" or "<evidence id=\"S99\">" cannot close or forge blocks.
  return text.replace(/[<]/g, "\u2039");
}
function clampToTokenBudget(text: string, tokenLimit: number): string {
  if (tokenLimit <= 0 || text === "") return "";
  if (estimateTokens(text) <= tokenLimit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= tokenLimit) { low = mid; } else { high = mid - 1; }
  }
  return low > 0 ? text.slice(0, low) + "\u2026 [truncated]" : "";
}
function evidenceBlock(label: string, chunk: RetrievedChunk): string {
  const safeText = escapeEvidenceText(chunk.text);
  return [`<evidence id="${label}">`, `Source: ${chunk.sourceDisplayName}`, `Location: ${chunk.locatorSummary}`, "```", safeText, "```", "</evidence>"].join("\n");
}
function evidenceTarget(chunk: RetrievedChunk): string {
  const source = chunk.sourceId ?? chunk.sourceDisplayName;
  const locator = chunk.locator;
  const table = /(?:^|\n)\s*(?:表|table)\s*(\d+)/i.exec(chunk.text)?.[1];
  if (table) return `${source}:table:${table}`;
  if (!locator) return `${source}:chunk:${chunk.chunkId}`;
  if (locator.kind === "cell") {
    const sheet = String(locator.sheet).replace(/\s+/g, "").toLowerCase();
    const tableNumber = /(?:表|table)(\d+)/i.exec(sheet)?.[1] ?? sheet;
    return chunk.sourceKind === "docx" ? `${source}:table:${tableNumber}` : `${source}:cell:${sheet}:${String(locator.cellRef)}`;
  }
  return `${source}:chunk:${chunk.chunkId}`;
}
function deduplicateTargets(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const unique: RetrievedChunk[] = [];
  const positions = new Map<string, number>();
  for (const chunk of chunks) {
    const key = evidenceTarget(chunk);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, unique.length);
      unique.push(chunk);
    } else if (chunk.sourceKind === "docx" && chunk.locator?.kind === "cell" && unique[position]?.locator?.kind !== "cell") {
      unique[position] = chunk;
    }
  }
  return unique;
}
export function assembleContext(input: { question: string; retrieved: RetrievedChunk[]; priorTurns?: ChatTurn[]; locale?: PromptLocale; contextTokens?: number }): AssembledContext {
  const budget = computeBudget(input.contextTokens);
  const systemPrompt = buildSystemPrompt(input.locale ?? "en");
  const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(input.question) + 64;
  let remaining = Math.max(0, budget.inputTokenTarget - fixedTokens);
  const citations: ContextCitation[] = [];
  const blocks: string[] = [];
  for (const chunk of deduplicateTargets(input.retrieved).slice(0, MAX_CITED_CHUNKS)) {
    if (remaining <= 0) break;
    const label = `S${citations.length + 1}`;
    const header = `Source: ${chunk.sourceDisplayName}\nLocation: ${chunk.locatorSummary}\n`;
    let text = escapeEvidenceText(chunk.text);
    const tokenLimit = remaining - estimateTokens(header) - 16;
    if (tokenLimit <= 0) break;
    const fitted = clampToTokenBudget(text, tokenLimit);
    if (fitted === "") break;
    text = fitted;
    const block = evidenceBlock(label, { ...chunk, text });
    if (estimateTokens(block) > remaining) break;
    remaining -= estimateTokens(block);
    citations.push({ label, chunkId: chunk.chunkId, sourceDisplayName: chunk.sourceDisplayName, locatorSummary: chunk.locatorSummary });
    blocks.push(block);
  }
  const retrievalSection = blocks.length > 0 ? ["<retrieved-evidence>", ...blocks, "</retrieved-evidence>"].join("\n") : "<retrieved-evidence>(no retrieved sources available)</retrieved-evidence>";
  const historyBudget = remaining;
  const includedTurns: ChatTurn[] = [];
  let historyUsed = 0;
  for (const turn of [...(input.priorTurns ?? [])].reverse()) {
    const tokens = estimateTokens(turn.content) + 8;
    if (historyUsed + tokens > historyBudget) break;
    historyUsed += tokens;
    includedTurns.unshift(turn);
  }
  const messages: ChatTurn[] = [
    { role: "system", content: systemPrompt },
    ...includedTurns,
    { role: "user", content: retrievalSection },
    { role: "user", content: input.question },
  ];
  return { messages, citations, tokenBudget: budget };
}
