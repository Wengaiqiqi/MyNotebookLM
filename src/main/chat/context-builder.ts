import type { ChatTurn } from "../models/provider";
import { buildSystemPrompt, type PromptLocale } from "./prompts";

export const MAX_CITED_CHUNKS = 12;
const DEFAULT_CONTEXT_TOKENS = 16_000;
const OUTPUT_RESERVE_RATIO = 0.2;
const MIN_OUTPUT_TOKEN_RESERVE = 1_024;
const OVERHEAD_RATIO = 0.1;
// ponytail: ~4 chars/token heuristic; swap for a provider tokenizer if budgets drift in practice.
const CHARS_PER_TOKEN = 4;
type RetrievedChunk = { chunkId: string; sourceDisplayName: string; locatorSummary: string; text: string };
export type TokenBudget = { contextTokens: number; outputTokenReserve: number; inputTokenTarget: number };
export type ContextCitation = { label: string; chunkId: string; sourceDisplayName: string; locatorSummary: string };
export type AssembledContext = { messages: ChatTurn[]; citations: ContextCitation[]; tokenBudget: TokenBudget };
export function estimateTokens(text: string): number { return Math.ceil(text.length / CHARS_PER_TOKEN); }
function computeBudget(contextTokens?: number): TokenBudget {
  const total = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const outputTokenReserve = Math.max(MIN_OUTPUT_TOKEN_RESERVE, Math.round(total * OUTPUT_RESERVE_RATIO));
  const inputTokenTarget = Math.floor((total - outputTokenReserve) * (1 - OVERHEAD_RATIO));
  return { contextTokens: total, outputTokenReserve, inputTokenTarget };
}
function escapeEvidenceText(text: string): string {
  return text.replaceAll("</evidence>", "<\\/evidence>").replaceAll(/<evidence(\s[^>]*)?>/g, "(evidence tag)");
}
function evidenceBlock(label: string, chunk: RetrievedChunk): string {
  const safeText = escapeEvidenceText(chunk.text);
  return [`<evidence id="${label}">`, `Source: ${chunk.sourceDisplayName}`, `Location: ${chunk.locatorSummary}`, "```", safeText, "```", "</evidence>"].join("\n");
}
export function assembleContext(input: { question: string; retrieved: RetrievedChunk[]; priorTurns?: ChatTurn[]; locale?: PromptLocale; contextTokens?: number }): AssembledContext {
  const budget = computeBudget(input.contextTokens);
  const systemPrompt = buildSystemPrompt(input.locale ?? "en");
  const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(input.question) + 64;
  let remaining = Math.max(0, budget.inputTokenTarget - fixedTokens);
  const citations: ContextCitation[] = [];
  const blocks: string[] = [];
  for (const chunk of input.retrieved.slice(0, MAX_CITED_CHUNKS)) {
    if (remaining <= 0) break;
    const label = `S${citations.length + 1}`;
    const header = `Source: ${chunk.sourceDisplayName}\nLocation: ${chunk.locatorSummary}\n`;
    const maxTextChars = Math.max(0, (remaining - estimateTokens(header) - 16) * CHARS_PER_TOKEN);
    if (maxTextChars === 0) break;
    let text = escapeEvidenceText(chunk.text);
    if (text.length > maxTextChars) { text = `${text.slice(0, maxTextChars)}\u2026 [truncated]`; }
    const block = evidenceBlock(label, { ...chunk, text });
    if (estimateTokens(block) > remaining) break;
    remaining -= estimateTokens(block);
    citations.push({ label, chunkId: chunk.chunkId, sourceDisplayName: chunk.sourceDisplayName, locatorSummary: chunk.locatorSummary });
    blocks.push(block);
  }
  const retrievalSection = blocks.length > 0 ? ["<retrieved-evidence>", ...blocks, "</retrieved-evidence>"].join("\n") : "<retrieved-evidence>(no retrieved sources available)</retrieved-evidence>";
  const historyBudget = Math.max(0, remaining - estimateTokens(retrievalSection));
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
