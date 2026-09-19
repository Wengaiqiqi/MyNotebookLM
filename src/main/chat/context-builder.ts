import { Buffer } from "node:buffer";
import type { ChatTurn } from "../models/provider";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  MAX_SAFE_TOKEN_INPUT,
  MIN_INPUT_RESERVE,
  MIN_OUTPUT_TOKENS,
  MIN_SAFETY_MARGIN,
  SAFETY_MARGIN_RATIO,
  maxDefaultOutputTokens,
  safetyMarginTokens,
  type EffectiveGenerationLimits
} from "../models/generation-limits";
import { buildSystemPrompt, type PromptLocale } from "./prompts";
import { neutralizeHistoricalCitations } from "./citation-parser";

export { DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS, MAX_SAFE_TOKEN_INPUT } from "../models/generation-limits";
/** Legacy export retained for callers; final chat evidence is budget-driven. */
export const MAX_CITED_CHUNKS = 4_096;
const REQUEST_OVERHEAD_TOKENS = 64;
const MESSAGE_OVERHEAD_TOKENS = 8;
const HISTORY_RESERVE_RATIO = 0.25;

export type RetrievedChunk = {
  chunkId: string;
  sourceId?: string;
  revisionId?: string;
  contentHash?: string;
  sourceDisplayName: string;
  sourceKind?: string;
  locator?: Record<string, unknown>;
  locatorSummary: string;
  text: string;
};

export type HistoryPair = {
  user: { id: string; sequence: number; content: string };
  assistant: { id: string; sequence: number; content: string };
};

export type TokenBudget = {
  contextTokens: number;
  outputTokenReserve: number;
  inputTokenTarget: number;
  safetyMargin: number;
  estimated: boolean;
};

export type ContextCitation = RetrievedChunk & {
  label: string;
  sentText: string;
  truncated: boolean;
};

export type ContextDiagnostics = {
  historyPairsConsidered: number;
  historyPairsIncluded: number;
  evidenceConsidered: number;
  evidenceIncluded: number;
  omittedHistoryPairs: number;
  omittedEvidence: number;
  reasons: string[];
};

export type AssembledContext = {
  messages: ChatTurn[];
  citations: ContextCitation[];
  selectedEvidence: ContextCitation[];
  historyMessageIds: string[];
  tokenBudget: TokenBudget;
  diagnostics: ContextDiagnostics;
  /** True when the fixed part alone (system prompt, question, answer) exceeds the window. */
  fixedOverflow: boolean;
};

/**
 * A previously sent evidence slice, frozen so a continuation replays exactly
 * the text the model already saw instead of re-truncating it.
 */
export type FrozenEvidence = {
  label: string;
  chunk: RetrievedChunk;
  sentText: string;
  truncated: boolean;
};

/**
 * ponytail: UTF-8/2 is a dependency-free estimate, not a tokenizer. Calibrate
 * this coefficient against fixed provider fixtures and replace it when a
 * matching tokenizer is available.
 */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(Buffer.byteLength(text, "utf8") / 2));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < MIN_OUTPUT_TOKENS) return fallback;
  return Math.min(value, MAX_SAFE_TOKEN_INPUT);
}

function computeBudget(input: { contextTokens?: number; outputTokens?: number; limits?: EffectiveGenerationLimits }, fixedTokens: number): TokenBudget {
  const limits = input.limits;
  const contextTokens = positiveInteger(limits?.contextTokens ?? input.contextTokens, DEFAULT_CONTEXT_TOKENS);
  const requestedOutput = positiveInteger(limits?.outputTokens ?? input.outputTokens, DEFAULT_OUTPUT_TOKENS);
  const outputWasOverridden = limits?.outputWasOverridden ?? input.outputTokens !== undefined;
  const safetyMargin = Math.max(MIN_SAFETY_MARGIN, Math.ceil(contextTokens * SAFETY_MARGIN_RATIO));
  const maxDefaultOutput = limits?.windowKind === "input-only" ? requestedOutput : maxDefaultOutputTokens(contextTokens);
  // An explicit output value is the user's own ceiling. Only clamp it when the
  // provider confirms a smaller maxOutputTokens, never against an input-only
  // window: those two capacities are independent.
  const confirmedOutputCeiling = limits?.knownOutputTokens;
  const outputTokenReserve = outputWasOverridden
    ? Math.min(requestedOutput, confirmedOutputCeiling ?? requestedOutput)
    : Math.min(requestedOutput, maxDefaultOutput, confirmedOutputCeiling ?? requestedOutput);
  const sharedInput = Math.max(0, contextTokens - outputTokenReserve - safetyMargin);
  let inputTokenTarget = sharedInput;
  if (limits?.windowKind === "input-only") {
    const inputLimit = positiveInteger(limits.inputTokenLimit, contextTokens);
    const inputSafety = Math.max(MIN_SAFETY_MARGIN, Math.ceil(inputLimit * SAFETY_MARGIN_RATIO));
    inputTokenTarget = Math.max(0, inputLimit - inputSafety);
    if (limits.knownContextTokens !== undefined) inputTokenTarget = Math.min(inputTokenTarget, Math.max(0, limits.knownContextTokens - outputTokenReserve - safetyMarginTokens(limits.knownContextTokens)));
  } else if (limits?.knownInputTokenLimit !== undefined) {
    inputTokenTarget = Math.min(inputTokenTarget, Math.max(0, limits.knownInputTokenLimit - safetyMarginTokens(limits.knownInputTokenLimit)));
  }
  if (fixedTokens > inputTokenTarget && !outputWasOverridden && limits?.windowKind !== "input-only") {
    const reduced = Math.max(MIN_OUTPUT_TOKENS, contextTokens - safetyMargin - fixedTokens);
    const adjustedOutput = Math.min(outputTokenReserve, reduced);
    inputTokenTarget = Math.min(limits?.knownInputTokenLimit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limits.knownInputTokenLimit - safetyMarginTokens(limits.knownInputTokenLimit)), Math.max(0, contextTokens - adjustedOutput - safetyMargin));
    return { contextTokens, outputTokenReserve: adjustedOutput, inputTokenTarget, safetyMargin, estimated: true };
  }
  return { contextTokens, outputTokenReserve, inputTokenTarget, safetyMargin, estimated: true };
}

function messageCost(message: ChatTurn): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

function sanitizeHistoryText(text: string): string {
  // Historical labels belong to an earlier retrieval map. Keeping them in the
  // prompt lets an old [S1] bind to a new S1, so make them inert data.
  return neutralizeHistoricalCitations(text);
}

export function estimateHistoryPairTokens(pair: HistoryPair): number {
  return messageCost({ role: "user", content: pair.user.content })
    + messageCost({ role: "assistant", content: sanitizeHistoryText(pair.assistant.content) });
}

export function historyReserveTokens(input: {
  question: string;
  limits?: EffectiveGenerationLimits;
  contextTokens?: number;
  outputTokens?: number;
  locale?: PromptLocale;
  additionalMessages?: ChatTurn[];
}): number {
  return Math.floor(historyLoadBudgetTokens(input) * HISTORY_RESERVE_RATIO);
}

export function historyLoadBudgetTokens(input: {
  question: string;
  limits?: EffectiveGenerationLimits;
  contextTokens?: number;
  outputTokens?: number;
  locale?: PromptLocale;
  additionalMessages?: ChatTurn[];
}): number {
  const systemPrompt = buildSystemPrompt(input.locale ?? "en");
  const fixedTokens = messageCost({ role: "system", content: systemPrompt })
    + messageCost({ role: "user", content: input.question })
    + (input.additionalMessages ?? []).reduce((sum, message) => sum + messageCost(message), 0)
    + REQUEST_OVERHEAD_TOKENS
    + messageCost({ role: "user", content: retrievalSection([]) });
  const budget = computeBudget(input, fixedTokens);
  return Math.max(0, budget.inputTokenTarget - fixedTokens);
}

function clampToTokenBudget(text: string, tokenLimit: number): { text: string; truncated: boolean } {
  if (tokenLimit <= 0 || text === "") return { text: "", truncated: text !== "" };
  if (estimateTokens(text) <= tokenLimit) return { text, truncated: false };
  const suffix = "… [truncated]";
  const prefixLimit = tokenLimit - estimateTokens(suffix);
  if (prefixLimit <= 0) return { text: "", truncated: true };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= prefixLimit) low = mid;
    else high = mid - 1;
  }
  if (low <= 0) return { text: "", truncated: true };
  return { text: text.slice(0, low) + suffix, truncated: true };
}

function escapeEvidenceText(text: string): string {
  return text.replace(/[<]/g, "\u2039");
}

function evidenceBlock(label: string, chunk: RetrievedChunk, sentText: string): string {
  return [
    `<evidence id="${label}">`,
    `Source: ${escapeEvidenceText(chunk.sourceDisplayName)}`,
    `Location: ${escapeEvidenceText(chunk.locatorSummary)}`,
    "```",
    sentText,
    "```",
    "</evidence>"
  ].join("\n");
}

function retrievalSection(citations: readonly ContextCitation[]): string {
  return citations.length > 0
    ? ["<retrieved-evidence>", ...citations.map((item) => evidenceBlock(item.label, item, item.sentText)), "</retrieved-evidence>"].join("\n")
    : "<retrieved-evidence>(no retrieved sources available)</retrieved-evidence>";
}

function evidenceKey(chunk: RetrievedChunk): string {
  return `${chunk.sourceId ?? ""}:${chunk.contentHash ?? chunk.chunkId}`;
}

function uniqueChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const positions = new Map<string, number>();
  const unique: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const key = evidenceKey(chunk);
    const existing = positions.get(key);
    if (existing !== undefined) {
      if (chunk.sourceKind === "docx" && chunk.locator?.kind === "cell" && unique[existing]?.locator?.kind !== "cell") unique[existing] = chunk;
      continue;
    }
    positions.set(key, unique.length);
    unique.push(chunk);
  }
  return unique;
}

function historyTurns(input: { pairs?: HistoryPair[]; priorTurns?: ChatTurn[] }): {
  turns: ChatTurn[];
  sizes: number[];
} {
  if (input.pairs) {
    const turns: ChatTurn[] = [];
    const sizes: number[] = [];
    for (const pair of input.pairs) {
      const pairTurns: ChatTurn[] = [
        { role: "user", content: pair.user.content },
        { role: "assistant", content: sanitizeHistoryText(pair.assistant.content) }
      ];
      turns.push(...pairTurns);
      sizes.push(pairTurns.reduce((sum, turn) => sum + messageCost(turn), 0));
    }
    return { turns, sizes };
  }
  const turns = (input.priorTurns ?? []).map((turn) => ({
    ...turn,
    content: turn.role === "assistant" ? sanitizeHistoryText(turn.content) : turn.content
  }));
  return {
    turns,
    sizes: turns.map(messageCost)
  };
}

export function assembleContext(input: {
  question: string;
  retrieved: RetrievedChunk[];
  historyPairs?: HistoryPair[];
  priorTurns?: ChatTurn[];
  locale?: PromptLocale;
  contextTokens?: number;
  outputTokens?: number;
  limits?: EffectiveGenerationLimits;
  additionalMessages?: ChatTurn[];
  /** Evidence already sent to the model; replayed verbatim before new candidates. */
  frozenEvidence?: readonly FrozenEvidence[];
  /** Labels the model already cited; they are required, not optional. */
  requiredLabels?: readonly string[];
}): AssembledContext {
  const systemPrompt = buildSystemPrompt(input.locale ?? "en");
  const additionalMessages = input.additionalMessages ?? [];
  const previousEvidence = input.frozenEvidence ?? [];
  const frozen = previousEvidence.filter((item) => input.requiredLabels === undefined || input.requiredLabels.includes(item.label));
  const optionalEvidence = previousEvidence.filter((item) => !frozen.includes(item));
  const fixedTokens = messageCost({ role: "system", content: systemPrompt })
    + messageCost({ role: "user", content: input.question })
    + additionalMessages.reduce((sum, message) => sum + messageCost(message), 0)
    + REQUEST_OVERHEAD_TOKENS
    + messageCost({ role: "user", content: retrievalSection(frozen.map((item) => ({ ...item.chunk, label: item.label, sentText: item.sentText, truncated: item.truncated }))) });
  const budget = computeBudget(input, fixedTokens);
  // Required (already cited) evidence is part of the fixed input, so the
  // optional evidence/history pool only ever spends the leftover budget.
  const available = Math.max(0, budget.inputTokenTarget - fixedTokens);
  const history = input.historyPairs !== undefined
    ? historyTurns({ pairs: input.historyPairs })
    : input.priorTurns === undefined
      ? historyTurns({})
      : historyTurns({ priorTurns: input.priorTurns });
  const historyReserve = Math.floor(available * HISTORY_RESERVE_RATIO);
  const selectedHistoryTurns: ChatTurn[] = [];
  const selectedHistoryIds: string[] = [];
  let historyUsed = 0;
  let includedPairs = 0;
  let oldestSelectedIndex = input.historyPairs?.length ?? history.turns.length;

  if (input.historyPairs) {
    for (let index = input.historyPairs.length - 1; index >= 0; index--) {
      const size = history.sizes[index] ?? 0;
      if (historyUsed + size > historyReserve) {
        oldestSelectedIndex = index + 1;
        break;
      }
      const pair = input.historyPairs[index]!;
      selectedHistoryTurns.unshift(
        { role: "user", content: pair.user.content },
        { role: "assistant", content: sanitizeHistoryText(pair.assistant.content) }
      );
      selectedHistoryIds.unshift(pair.user.id, pair.assistant.id);
      historyUsed += size;
      includedPairs++;
      oldestSelectedIndex = index;
    }
  } else {
    for (let index = history.turns.length - 1; index >= 0; index--) {
      const size = history.sizes[index] ?? 0;
      if (historyUsed + size > historyReserve) {
        oldestSelectedIndex = index + 1;
        break;
      }
      selectedHistoryTurns.unshift(history.turns[index]!);
      historyUsed += size;
      oldestSelectedIndex = index;
    }
  }

  let remainingEvidence = Math.max(0, available - historyUsed);
  // Frozen slices keep their original labels and byte-identical text; new
  // candidates are appended after them and never renumbered.
  const citations: ContextCitation[] = frozen.map((item) => ({
    ...item.chunk,
    label: item.label,
    sentText: item.sentText,
    truncated: item.truncated
  }));
  const uniqueRetrieved = uniqueChunks(input.retrieved).filter((chunk) => !previousEvidence.some((item) => item.chunk.chunkId === chunk.chunkId));
  const diagnostics: ContextDiagnostics = {
    historyPairsConsidered: input.historyPairs?.length ?? 0,
    historyPairsIncluded: includedPairs,
    evidenceConsidered: input.retrieved.length,
    evidenceIncluded: 0,
    omittedHistoryPairs: 0,
    omittedEvidence: 0,
    reasons: []
  };

  for (const item of optionalEvidence) {
    const block = evidenceBlock(item.label, item.chunk, item.sentText);
    const cost = estimateTokens(block) + MESSAGE_OVERHEAD_TOKENS;
    if (cost > remainingEvidence) continue;
    remainingEvidence -= cost;
    citations.push({ ...item.chunk, label: item.label, sentText: item.sentText, truncated: item.truncated });
  }
  let nextLabel = previousEvidence.reduce((max, item) => Math.max(max, Number(item.label.slice(1))), 0) + 1;
  for (const chunk of uniqueRetrieved) {
    if (remainingEvidence <= 0) break;
    const label = `S${nextLabel++}`;
    const header = `Source: ${chunk.sourceDisplayName}\nLocation: ${chunk.locatorSummary}\n`;
    const tokenLimit = remainingEvidence - estimateTokens(header) - REQUEST_OVERHEAD_TOKENS;
    if (tokenLimit <= 0) break;
    const fitted = clampToTokenBudget(escapeEvidenceText(chunk.text), tokenLimit);
    if (!fitted.text) break;
    const block = evidenceBlock(label, chunk, fitted.text);
    const cost = estimateTokens(block) + MESSAGE_OVERHEAD_TOKENS;
    if (cost > remainingEvidence) break;
    remainingEvidence -= cost;
    const citation: ContextCitation = {
      ...chunk,
      label,
      sentText: fitted.text,
      truncated: fitted.truncated
    };
    citations.push(citation);
  }

  // If evidence did not consume its allocation, spend the remainder on older
  // complete turns. This keeps the 25% value a reserve, not a hard history cap.
  let supplementalHistoryTurns = 0;
  while (remainingEvidence > 0 && oldestSelectedIndex > 0) {
    const index = oldestSelectedIndex - 1;
    const size = history.sizes[index] ?? 0;
    if (size > remainingEvidence) break;
    if (input.historyPairs) {
      const pair = input.historyPairs[index]!;
      selectedHistoryTurns.unshift(
        { role: "user", content: pair.user.content },
        { role: "assistant", content: sanitizeHistoryText(pair.assistant.content) }
      );
      selectedHistoryIds.unshift(pair.user.id, pair.assistant.id);
      includedPairs++;
    } else {
      selectedHistoryTurns.unshift(history.turns[index]!);
    }
    historyUsed += size;
    remainingEvidence -= size;
    supplementalHistoryTurns += input.historyPairs ? 2 : 1;
    oldestSelectedIndex = index;
  }

  // Recheck the actual wire layout, then shed only optional context.
  citations.sort((left, right) => Number(left.label.slice(1)) - Number(right.label.slice(1)));
  const required = new Set([...frozen.map((item) => item.label), ...(input.requiredLabels ?? [])]);
  const buildMessages = (): ChatTurn[] => [
    { role: "system", content: systemPrompt },
    ...selectedHistoryTurns,
    { role: "user", content: retrievalSection(citations) },
    { role: "user", content: input.question },
    ...additionalMessages
  ];
  let messages = buildMessages();
  const inputCost = (): number => messages.reduce((sum, message) => sum + messageCost(message), 0) + REQUEST_OVERHEAD_TOKENS;
  const dropOldestHistory = (): void => {
    const count = input.historyPairs ? 2 : 1;
    selectedHistoryTurns.splice(0, count);
    selectedHistoryIds.splice(0, count);
    if (input.historyPairs) includedPairs--;
    supplementalHistoryTurns = Math.max(0, supplementalHistoryTurns - count);
  };
  while (inputCost() > budget.inputTokenTarget) {
    if (supplementalHistoryTurns > 0) dropOldestHistory();
    else {
      const optionalIndex = citations.findLastIndex((item) => !required.has(item.label));
      if (optionalIndex >= 0) citations.splice(optionalIndex, 1);
      else if (selectedHistoryTurns.length > 0) dropOldestHistory();
      else break;
    }
    messages = buildMessages();
  }

  diagnostics.historyPairsIncluded = includedPairs;
  diagnostics.evidenceIncluded = citations.length;
  diagnostics.omittedEvidence = Math.max(0, uniqueRetrieved.length + previousEvidence.length - citations.length);
  diagnostics.omittedHistoryPairs = input.historyPairs ? Math.max(0, input.historyPairs.length - includedPairs) : 0;
  if (diagnostics.omittedEvidence > 0) diagnostics.reasons.push("evidence-budget");
  if (diagnostics.omittedHistoryPairs > 0) diagnostics.reasons.push("history-budget");
  if (fixedTokens > budget.inputTokenTarget) diagnostics.reasons.push("fixed-input-exceeds-budget");
  for (const label of input.requiredLabels ?? []) {
    if (!citations.some((citation) => citation.label === label)) diagnostics.reasons.push("required-evidence-missing");
  }
  if (inputCost() > budget.inputTokenTarget) diagnostics.reasons.push("context-budget");
  return {
    messages,
    citations,
    selectedEvidence: citations,
    historyMessageIds: selectedHistoryIds,
    tokenBudget: budget,
    diagnostics,
    fixedOverflow: fixedTokens > budget.inputTokenTarget
  };
}
