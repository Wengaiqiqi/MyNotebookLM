import type Database from "better-sqlite3";
import type { ModelProfileDto } from "../../shared/models";
import type { AppErrorDto, Result } from "../../shared/app-errors";
import type { ChatTurn, ModelProvider } from "../models/provider";
import { ModelRouter } from "../models/model-router";
import { generationSettingsError, resolveGenerationLimits } from "../models/generation-limits";
import { generateRouted } from "../models/routed-generation";
import { ProviderRequestError } from "../models/http-client";
import type { ConversationDto, MessageDto } from "../../shared/chat";
import type { RetrievedCitation } from "./citation-parser";
import { CitationStreamBuffer, finalizeCitations } from "./citation-parser";
import { buildCitationRows, persistParsedCitations } from "./citation-persist";
import { assembleContext, estimateHistoryPairTokens, historyLoadBudgetTokens, type FrozenEvidence, type HistoryPair } from "./context-builder";
import { ConversationRepository } from "./conversation-repository";
import { ChatSessionRegistry, type SessionOwner } from "./chat-session-registry";

const CHECKPOINT_INTERVAL_MS = 1_000;
const CHECKPOINT_INTERVAL_BYTES = 2_048;
const SESSION_USER = "owner";

export type RetrievableChunk = RetrievedCitation & { locatorSummary: string; text: string };
export type ChatRetrievalDiagnostics = Readonly<Record<string, string | number | boolean>>;
export type RetrievalResult = RetrievableChunk[] & { diagnostics?: ChatRetrievalDiagnostics };

export type RetrievalFn = (input: { projectId: string; question: string; evidenceTokenBudget?: number; signal?: AbortSignal }) => Promise<RetrievalResult>;

export type ChatSendDeps = {
  db: Database.Database;
  generationProfile?: ModelProfileDto | undefined;
  router?: Pick<ModelRouter, "resolve">;
  providerFactory: (profile: ModelProfileDto) => ModelProvider;
  retrieval: RetrievalFn;
  now?: () => Date;
  randomId?: (n: number) => string;
};

export type SendInput = { requestId: string; projectId: string; conversationId: string; question: string; generationProfileId?: string; thinking?: "off" | "low" | "medium" | "high" };
export type RegenerateInput = { requestId: string; projectId: string; conversationId: string; messageId: string; question?: string; thinking?: "off" | "low" | "medium" | "high" };
export type ContinueInput = { requestId: string; projectId: string; conversationId: string; messageId: string; expectedRevision: number };
type ConversationQuery = { projectId: string; conversationId: string };
type PreparedGenerationRequest = {
  messages: ChatTurn[];
  maxTokens: number;
  retrievals?: Record<string, RetrievedCitation>;
  evidence?: ReturnType<typeof assembleContext>["citations"];
  historyPairs?: HistoryPair[];
  diagnostics?: ReturnType<typeof assembleContext>["diagnostics"];
  historyMessageIds?: string[];
};

type StreamEvent =
  | { type: "started"; requestId: string; messageId: string; operation?: "initial" | "continue"; message?: MessageDto; offset?: number }
  | { type: "delta"; requestId: string; messageId: string; text: string; offset?: number }
  | { type: "completed"; requestId: string; messageId: string; message: MessageDto }
  | { type: "cancelled"; requestId: string; messageId: string; message: MessageDto; operation?: "initial" | "continue" }
  | { type: "fallback"; requestId: string; attempted: { provider: string; model: string; profileId: string | null }; next: { provider: string; model: string; profileId: string | null }; errorCode: string }
  | { type: "failed"; requestId: string; messageId: string; error: AppErrorDto; operation?: "initial" | "continue"; message?: MessageDto };

export { normalizeFinishReason, type FinishKind } from "../models/finish-reason";
import { normalizeFinishReason, type FinishKind } from "../models/finish-reason";

function appError(code: AppErrorDto["code"], messageKey: string, recoverable = false): AppErrorDto {
  return { code, messageKey, recoverable };
}

function mapContextCitations(
  citations: ReadonlyArray<{ label: string; chunkId: string; sentText?: string }>,
  retrieved: ReadonlyArray<RetrievedCitation>
): Record<string, RetrievedCitation> {
  const byChunk = new Map(retrieved.map((item) => [item.chunkId, item]));
  return Object.fromEntries(citations.flatMap((citation) => {
    const match = byChunk.get(citation.chunkId);
    return match ? [[citation.label, { ...match, ...(citation.sentText === undefined ? {} : { text: citation.sentText }) }] as const] : [];
  }));
}

function evidenceIsCurrent(db: Database.Database, projectId: string, evidence: readonly RetrievedCitation[]): boolean {
  const complete = evidence.filter((item) => item.revisionId && item.contentHash);
  for (let offset = 0; offset < complete.length; offset += 400) {
    const batch = complete.slice(offset, offset + 400);
    const rows = db.prepare(`SELECT sc.id,sc.content_hash,sr.id revision_id,s.id source_id FROM source_chunks sc JOIN source_revisions sr ON sr.id=sc.revision_id JOIN sources s ON s.id=sr.source_id WHERE s.project_id=? AND s.status='active' AND s.current_revision_id=sr.id AND sr.state='ready' AND sc.id IN (${batch.map(() => "?").join(",")})`).all(projectId, ...batch.map((item) => item.chunkId)) as Array<{ id: string; content_hash: string; revision_id: string; source_id: string }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (batch.some((item) => { const row = byId.get(item.chunkId); return !row || row.source_id !== item.sourceId || row.revision_id !== item.revisionId || row.content_hash !== item.contentHash; })) return false;
  }
  return true;
}

/** Startup recovery: abandoned streaming drafts become cancelled with interruption metadata. */
export function recoverInterruptedStreams(db: Database.Database, now = new Date()): number {
  const recovered = db.transaction(() => {
    let count = 0;
    const rows = db.prepare("SELECT c.message_id,c.runtime_json,c.snapshot_json,m.content,m.usage_json,v.project_id FROM chat_generation_contexts c JOIN messages m ON m.id=c.message_id JOIN conversations v ON v.id=m.conversation_id WHERE m.state='streaming' AND c.active_request_id IS NOT NULL").all() as Array<{ message_id: string; runtime_json: string; snapshot_json: string; content: string; usage_json: string | null; project_id: string }>;
    for (const row of rows) {
      let runtime: Record<string, unknown>;
      try { runtime = JSON.parse(row.runtime_json) as Record<string, unknown>; } catch { runtime = {}; }
      const snapshot = JSON.parse(row.snapshot_json) as { retrievals?: Record<string, RetrievedCitation> };
      const retrievals = Object.fromEntries(Object.entries(snapshot.retrievals ?? {}).filter(([, item]) =>
        db.prepare("SELECT 1 FROM source_chunks sc JOIN source_revisions sr ON sr.id=sc.revision_id JOIN sources s ON s.id=sr.source_id WHERE sc.id=? AND sr.source_id=? AND s.project_id=?").get(item.chunkId, item.sourceId, row.project_id)
      ));
      persistParsedCitations(db, { projectId: row.project_id, messageId: row.message_id, parsed: finalizeCitations(row.content, retrievals), retrievals });
      if (runtime.operation !== "continue") {
        runtime.status = "interrupted";
        runtime.lastError = "errors.interrupted";
        runtime.canContinue = false;
        runtime.usageComplete = false;
        db.prepare("UPDATE messages SET usage_json=? WHERE id=?").run(runtime.attemptUsage ? JSON.stringify(runtime.attemptUsage) : row.usage_json, row.message_id);
        db.prepare("UPDATE messages SET state='cancelled',completion_reason='interruption',error_code='INTERRUPTED',updated_at=? WHERE id=? AND state='streaming'").run(now.toISOString(), row.message_id);
        db.prepare("UPDATE chat_generation_contexts SET runtime_json=?,revision=revision+1,active_request_id=NULL WHERE message_id=? AND active_request_id IS NOT NULL").run(JSON.stringify(runtime), row.message_id);
        count++;
        continue;
      }
      runtime.status = "interrupted";
      runtime.finishKind = "length";
      runtime.rawFinishReason = runtime.rawFinishReason ?? "length";
      runtime.lastError = "errors.interrupted";
      runtime.canContinue = true;
      runtime.usageComplete = false;
      const usage = addUsage(
        (typeof runtime.baseUsageComplete === "boolean" ? runtime.baseUsage ?? null : (row.usage_json ? JSON.parse(row.usage_json) : null)) as Parameters<typeof addUsage>[0],
        // Older running snapshots retained the previous attempt's usage.
        (typeof runtime.baseUsageComplete === "boolean" ? runtime.attemptUsage ?? null : null) as Parameters<typeof addUsage>[1]
      );
      db.prepare("UPDATE messages SET usage_json=? WHERE id=?").run(usage ? JSON.stringify(usage) : null, row.message_id);
      db.prepare("UPDATE messages SET state='completed',completion_reason='interruption',error_code='INTERRUPTED',updated_at=? WHERE id=? AND state='streaming'").run(now.toISOString(), row.message_id);
      db.prepare("UPDATE chat_generation_contexts SET runtime_json=?,revision=revision+1,active_request_id=NULL WHERE message_id=? AND active_request_id IS NOT NULL").run(JSON.stringify(runtime), row.message_id);
      count++;
    }
    const result = db.prepare(
      "UPDATE messages SET state='cancelled', completion_reason='interruption', error_code='INTERRUPTED', updated_at=? WHERE state='streaming' AND NOT EXISTS (SELECT 1 FROM chat_generation_contexts WHERE message_id=messages.id AND active_request_id IS NOT NULL)"
    ).run(now.toISOString());
    // A terminal write that failed after the message row was already updated
    // leaves a completed answer on a still-running context. Nothing is
    // streaming any more, so clear the lock and mark it interrupted.
    const stranded = db.prepare(
      "UPDATE chat_generation_contexts SET runtime_json=json_set(runtime_json,'$.status','interrupted','$.canContinue',json(CASE WHEN json_extract(runtime_json,'$.operation')='continue' AND length(COALESCE((SELECT content FROM messages WHERE id=chat_generation_contexts.message_id),''))>0 THEN 'true' ELSE 'false' END),'$.lastError','errors.interrupted'),revision=revision+1,active_request_id=NULL WHERE active_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id=chat_generation_contexts.message_id AND m.state='streaming')"
    ).run();
    return count + result.changes + stranded.changes;
  })();
  return recovered;
}

type TurnContext = {
  requestId: string;
  turn: ConversationQuery & { requestId: string };
  repo: ConversationRepository;
  profile: ModelProfileDto;
  profiles: readonly ModelProfileDto[];
  owner: SessionOwner;
  nextId: () => string;
  userMessage: MessageDto;
  /** When set, this turn replaces an earlier assistant reply instead of appending after a fresh user message. */
  supersedesMessageId: string | null;
  generationProfileId?: string | undefined;
  thinking?: "off" | "low" | "medium" | "high" | undefined;
  emit: (event: StreamEvent) => void;
};

export class ChatService {
  private readonly registry = new ChatSessionRegistry();
  private readonly inFlightConversations = new Set<string>();

  constructor(private readonly deps: ChatSendDeps) {}

  activeRequests(): string[] {
    return this.registry.activeRequests();
  }

  stopRequest(requestId: string, caller: Pick<SessionOwner, "projectId">): boolean {
    return this.registry.cancel(requestId, { projectId: caller.projectId, userId: SESSION_USER });
  }

  // ---------- Conversation operations (Task 5) ----------

  listConversations(projectId: string): ConversationDto[] {
    return this.repo().listConversations(projectId);
  }

  createConversation(input: { projectId: string; title: string }): ConversationDto {
    return this.repo().createConversation({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title.trim() || "New conversation",
      createdAt: this.clock().toISOString()
    });
  }

  renameConversation(input: ConversationQuery & { title: string }): ConversationDto {
    const repo = this.repo();
    const conversation = repo.getConversation(input.projectId, input.conversationId);
    if (!conversation || conversation.archivedAt || conversation.deletedAt) throw new Error("conversation archived");
    return repo.renameConversation(input.projectId, input.conversationId, input.title.trim(), this.clock().toISOString());
  }

  archiveConversation(input: ConversationQuery): ConversationDto {
    const repo = this.repo();
    repo.getConversation(input.projectId, input.conversationId);
    return repo.archiveConversation(input.projectId, input.conversationId, this.clock().toISOString());
  }

  deleteConversation(input: ConversationQuery): void {
    this.repo().removeConversation(input.projectId, input.conversationId, this.clock().toISOString());
  }

  listMessages(input: ConversationQuery): MessageDto[] {
    return this.repo().listMessages(input.projectId, input.conversationId);
  }

  async send(input: SendInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const owner: SessionOwner = { projectId: input.projectId, userId: SESSION_USER };
    try {
      const repo = this.repo();
      const profiles = this.generationProfiles(input.generationProfileId);
      const profile = profiles[0];
      if (!profile) return { ok: false, error: appError("VALIDATION", "errors.generationProfileMissing") };
      const configurationError = generationSettingsError(profile);
      if (configurationError) return { ok: false, error: configurationError };
      // Ownership is validated inside the repository before anything is written.
      const conversation = repo.getConversation(input.projectId, input.conversationId);
      if (!conversation || conversation.archivedAt || conversation.deletedAt) return { ok: false, error: appError("CONFLICT", "errors.chatArchived") };
      if (this.inFlightConversations.has(input.conversationId)) {
        return { ok: false, error: appError("CONFLICT", "errors.chatSendInFlight", true) };
      }
      let counter = 0;
      const nextId = (): string => (this.deps.randomId ? this.deps.randomId(++counter) : crypto.randomUUID());
      const userMessage = repo.appendUserMessage({
        projectId: input.projectId,
        conversationId: input.conversationId,
        id: nextId(),
        content: input.question,
        createdAt: this.clock().toISOString()
      });
      return await this.runTurn({ requestId: input.requestId, turn: input, repo, profile, profiles, owner, nextId, userMessage, supersedesMessageId: null, ...(input.generationProfileId ? { generationProfileId: input.generationProfileId } : {}), ...(input.thinking ? { thinking: input.thinking } : {}), emit });
    } catch (reason) {
      return internalResult(reason);
    }
  }

  async regenerate(input: RegenerateInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const owner: SessionOwner = { projectId: input.projectId, userId: SESSION_USER };
    try {
      const repo = this.repo();
      const profiles = this.generationProfiles();
      const profile = profiles[0];
      if (!profile) return { ok: false, error: appError("VALIDATION", "errors.generationProfileMissing") };
      const configurationError = generationSettingsError(profile);
      if (configurationError) return { ok: false, error: configurationError };
      const conversation = repo.getConversation(input.projectId, input.conversationId);
      if (!conversation || conversation.archivedAt || conversation.deletedAt) return { ok: false, error: appError("CONFLICT", "errors.chatArchived") };
      const old = repo.getMessage(input.projectId, input.messageId);
      if (!old || old.role !== "assistant" || !old.replyToMessageId) return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      if (old.conversationId !== input.conversationId) return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      if (old.superseded) return { ok: false, error: appError("CONFLICT", "errors.chatRegenerateSuperseded") };
      let userMessage = repo.getMessage(input.projectId, old.replyToMessageId);
      if (!userMessage || userMessage.role !== "user" || userMessage.content === "") {
        return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      }
      if (userMessage.conversationId !== input.conversationId) return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      if (this.inFlightConversations.has(input.conversationId)) {
        return { ok: false, error: appError("CONFLICT", "errors.chatSendInFlight", true) };
      }
      if (input.question !== undefined) {
        const question = input.question.trim();
        if (!question) return { ok: false, error: appError("VALIDATION", "errors.validation") };
        userMessage = repo.updateUserMessage({ projectId: input.projectId, id: userMessage.id, content: question, updatedAt: this.clock().toISOString() });
      }
      let counter = 0;
      const nextId = (): string => (this.deps.randomId ? this.deps.randomId(++counter) : crypto.randomUUID());
      return await this.runTurn({ requestId: input.requestId, turn: input, repo, profile, profiles, owner, nextId, userMessage, supersedesMessageId: old.id, ...(input.thinking ? { thinking: input.thinking } : {}), emit });
    } catch (reason) {
      return internalResult(reason);
    }
  }

  async continue(input: ContinueInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const owner: SessionOwner = { projectId: input.projectId, userId: SESSION_USER };
    try {
      const repo = this.repo();
      const message = repo.getMessage(input.projectId, input.messageId);
      if (!message || message.role !== "assistant" || message.conversationId !== input.conversationId || message.superseded) return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      const conversation = repo.getConversation(input.projectId, input.conversationId);
      if (conversation.archivedAt || conversation.deletedAt) return { ok: false, error: appError("CONFLICT", "errors.chatArchived") };
      const latest = this.deps.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='assistant' AND superseded=0 ORDER BY sequence DESC LIMIT 1").get(input.conversationId) as { id?: string } | undefined;
      if (latest?.id !== message.id) return { ok: false, error: appError("CONFLICT", "errors.continueUnavailable", true) };
      const saved = repo.getGenerationContext(input.projectId, input.messageId);
      if (!saved) return { ok: false, error: appError("CONFLICT", "errors.continueUnavailable", true) };
      // Idempotent replay is checked before the canContinue guard: a finished
      // continuation clears canContinue, so re-checking that flag first would
      // turn a legitimate replay into a conflict and leave the caller waiting.
      if (saved.activeRequestId === null
        && saved.runtime.lastRequestId === input.requestId
        && saved.runtime.status !== "running") {
        const interrupted = saved.runtime.status === "interrupted";
        if (interrupted) emit({ type: "cancelled", requestId: input.requestId, messageId: input.messageId, message, operation: "continue" });
        else emit({ type: "completed", requestId: input.requestId, messageId: input.messageId, message });
        return interrupted
          ? { ok: false, error: appError("PROVIDER", "errors.providerIncomplete", true) }
          : { ok: true, value: { requestId: input.requestId, assistantMessageId: input.messageId } };
      }
      if (message.state !== "completed" || !message.generation?.canContinue) return { ok: false, error: appError("CONFLICT", "errors.continueUnavailable", true) };
      const snapshot = saved.snapshot as {
        questionMessageId?: string;
        profile?: { id?: string; provider?: string; modelId?: string; baseUrl?: string };
        contextMessages?: ChatTurn[];
        retrievals?: Record<string, RetrievedCitation & { locatorSummary?: string }>;
        evidence?: Array<{
          label: string;
          chunkId: string;
          sourceId: string;
          revisionId?: string;
          contentHash?: string;
          sourceDisplayName: string;
          sourceKind?: string;
          locator?: Record<string, unknown>;
          locatorSummary: string;
          sentText: string;
          truncated: boolean;
        }>;
        historyPairs?: HistoryPair[];
        priorTurns?: ChatTurn[];
        question?: string;
        thinking?: "off" | "low" | "medium" | "high";
      };
      const originalQuestion = repo.getMessage(input.projectId, message.replyToMessageId ?? "");
      if (!originalQuestion || originalQuestion.content !== snapshot.question || (snapshot.questionMessageId && snapshot.questionMessageId !== originalQuestion.id)) {
        return { ok: false, error: appError("CONFLICT", "errors.continueUnavailable", true) };
      }
      for (const source of Object.values(snapshot.retrievals ?? {})) {
        const row = this.deps.db.prepare("SELECT sc.content_hash, sr.id AS revision_id FROM source_chunks sc JOIN source_revisions sr ON sr.id=sc.revision_id JOIN sources s ON s.id=sr.source_id WHERE sc.id=? AND s.id=? AND s.project_id=? AND s.status='active' AND s.current_revision_id=sr.id AND sr.state='ready'").get(source.chunkId, source.sourceId, input.projectId) as { content_hash?: string; revision_id?: string } | undefined;
        if (!row || (source.revisionId && row.revision_id !== source.revisionId) || (source.contentHash && row.content_hash !== source.contentHash)) return { ok: false, error: appError("CONFLICT", "errors.continueSourceUnavailable", true) };
      }
      const profile = this.generationProfiles(message.profileId ?? undefined)[0];
      if (!profile || profile.id !== message.profileId || profile.provider !== snapshot.profile?.provider || profile.modelId !== snapshot.profile?.modelId || profile.baseUrl !== snapshot.profile?.baseUrl) {
        return { ok: false, error: appError("CONFLICT", "errors.continueUnavailable", true) };
      }
      const configurationError = generationSettingsError(profile);
      if (configurationError) return { ok: false, error: configurationError };
      const retrieved = Object.values(snapshot.retrievals ?? {}).filter((item): item is RetrievableChunk =>
        typeof item.text === "string" && typeof item.locatorSummary === "string"
      );
      const parsedAnswer = finalizeCitations(message.content, snapshot.retrievals ?? {});
      const citedLabels = new Set(parsedAnswer.citations.map((citation) => citation.label));
      // Replay exactly what the model already saw: previously sent slices are
      // frozen (never re-truncated) and already-cited labels are required.
      const frozenEvidence: FrozenEvidence[] = (snapshot.evidence ?? []).flatMap((item) => {
        const chunk = snapshot.retrievals?.[item.label];
        if (!chunk || typeof chunk.text !== "string" || typeof item.sentText !== "string") return [];
        return [{
          label: item.label,
          chunk: {
            ...chunk,
            chunkId: item.chunkId,
            sourceId: item.sourceId,
            text: chunk.text,
            locatorSummary: item.locatorSummary
          },
          sentText: item.sentText,
          truncated: item.truncated === true
        }];
      });
      const requiredLabels = parsedAnswer.hasInvalidCitations ? frozenEvidence.map((item) => item.label) : [...citedLabels];
      const continuationMessage = { role: "assistant" as const, content: message.content };
      const continuationInstruction = {
        role: "user" as const,
        content: "Continue the previous answer from exactly where it ended. Do not repeat the existing answer."
      };
      const historyPairs = snapshot.historyPairs;
      const legacyPriorTurns = snapshot.priorTurns ?? (historyPairs === undefined && snapshot.contextMessages?.length && snapshot.contextMessages.length >= 3
        ? snapshot.contextMessages.slice(1, -2)
        : []);
      const continuationContext = assembleContext({
        question: snapshot.question ?? "",
        retrieved,
        ...(historyPairs !== undefined ? { historyPairs } : {}),
        ...(historyPairs === undefined && legacyPriorTurns.length > 0 ? { priorTurns: legacyPriorTurns } : {}),
        limits: resolveGenerationLimits(profile),
        locale: "en",
        additionalMessages: [continuationMessage, continuationInstruction],
        ...(frozenEvidence.length > 0 ? { frozenEvidence } : {}),
        requiredLabels
      });
      if (continuationContext.diagnostics.reasons.includes("required-evidence-missing")) {
        return { ok: false, error: appError("VALIDATION", "errors.continueEvidenceMissing", true) };
      }
      if (continuationContext.fixedOverflow || continuationContext.diagnostics.reasons.includes("context-budget")) {
        return { ok: false, error: appError("VALIDATION", "errors.contextBudgetExceeded", true) };
      }
      if (this.inFlightConversations.has(input.conversationId)) return { ok: false, error: appError("CONFLICT", "errors.chatSendInFlight", true) };
      const continuationRetrievals = mapContextCitations(continuationContext.citations, retrieved);
      // Claim and prepared snapshot are one unit: preparation-write failure
      // must not strand the previously completed answer in streaming state.
      const claimTransaction = this.deps.db.transaction(() => {
      const claim = repo.claimContinuation({ projectId: input.projectId, messageId: input.messageId, requestId: input.requestId, expectedRevision: input.expectedRevision, updatedAt: this.clock().toISOString() });
      if (claim.kind !== "claimed") return claim;
      repo.updateGenerationSnapshot({ projectId: input.projectId, messageId: input.messageId, snapshot: {
        ...snapshot, contextMessages: continuationContext.messages, retrievals: continuationRetrievals,
        evidence: continuationContext.citations,
        ...(historyPairs !== undefined ? { historyPairs } : { priorTurns: legacyPriorTurns })
      } });
      repo.updateGenerationRuntime({ projectId: input.projectId, messageId: input.messageId, runtime: { ...claim.context.runtime, outputTokenLimit: continuationContext.tokenBudget.outputTokenReserve } });
      return claim;
      });
      const claim = claimTransaction();
      if (claim.kind === "conflict") return { ok: false, error: appError("CONFLICT", "errors.continueConflict", true) };
      if (claim.kind === "replay") {
        // Same requestId, already terminal: re-emit the stored outcome so a
        // reconnecting renderer sees a terminal event instead of waiting forever.
        const runtime = claim.context.runtime;
        const interrupted = runtime.status === "interrupted";
        if (interrupted) emit({ type: "cancelled", requestId: input.requestId, messageId: input.messageId, message: claim.message, operation: "continue" });
        else emit({ type: "completed", requestId: input.requestId, messageId: input.messageId, message: claim.message });
        return interrupted
          ? { ok: false, error: appError("PROVIDER", "errors.providerIncomplete", true) }
          : { ok: true, value: { requestId: input.requestId, assistantMessageId: input.messageId } };
      }
      const { signal } = this.registry.register(input.requestId, owner);
      this.inFlightConversations.add(input.conversationId);
      emit({
        type: "started",
        requestId: input.requestId,
        messageId: input.messageId,
        operation: "continue",
        message: repo.getMessage(input.projectId, input.messageId)!,
        offset: message.content.length
      });
      try {
        return await this.runGeneration({
          repo,
          turn: { projectId: input.projectId, conversationId: input.conversationId },
          profile,
          profiles: [profile],
          generationProfileId: profile.id,
          ...(snapshot.thinking ? { thinking: snapshot.thinking } : {}),
          retrievals: continuationRetrievals,
          contextMessages: continuationContext.messages,
          outputTokenReserve: continuationContext.tokenBudget.outputTokenReserve,
          assistantId: input.messageId,
          requestId: input.requestId,
          signal,
          emit,
          continuation: true,
          initialContent: message.content,
          allowFallback: false
        });
      } finally {
        this.registry.complete(input.requestId, owner);
        this.inFlightConversations.delete(input.conversationId);
      }
    } catch (reason) {
      return internalResult(reason);
    }
  }

  /**
   * Shared streaming turn: retrieve -> draft -> generate -> finalize.
   * A plain send already persisted the fresh user message; regeneration points at the
   * existing user/assistant pair, so no duplicate user row can be created.
   */
  private async runTurn(args: TurnContext): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const { turn, repo, profile, profiles, owner, nextId, userMessage, supersedesMessageId, generationProfileId, thinking, emit } = args;
    const requestId = turn.requestId;
    const { signal } = this.registry.register(requestId, owner);
    this.inFlightConversations.add(turn.conversationId);
    const startedAt = this.clock().toISOString();
    const draftId = nextId();
    try {
      const assistant = supersedesMessageId
        ? repo.regenerateAssistantMessage({
          projectId: turn.projectId,
          conversationId: turn.conversationId,
          id: draftId,
          provider: profile.provider,
          profileId: profile.id,
          model: profile.modelId,
          supersedesMessageId,
          createdAt: startedAt
          })
        : repo.startAssistantMessage({
          projectId: turn.projectId,
          conversationId: turn.conversationId,
          id: draftId,
          replyToMessageId: userMessage.id,
          provider: profile.provider,
          profileId: profile.id,
          model: profile.modelId,
          createdAt: startedAt
          });
      emit({ type: "started", requestId, messageId: assistant.id });

      const limits = resolveGenerationLimits(profile);
      const historyPairs: HistoryPair[] = [];
      let historyCursor = userMessage.sequence;
      let loadedHistoryTokens = 0;
      let historyExhausted = false;
      const loadHistory = (historyBudget: number): void => {
      while (!historyExhausted && loadedHistoryTokens < historyBudget) {
        const page = repo.listHistoryPairs({
          projectId: turn.projectId,
          conversationId: turn.conversationId,
          beforeSequence: userMessage.sequence,
          cursor: historyCursor,
          limit: 32
        });
        if (page.length === 0) { historyExhausted = true; break; }
        historyPairs.unshift(...page);
        historyCursor = page[0]!.user.sequence;
        loadedHistoryTokens += page.reduce((sum, pair) => sum + estimateHistoryPairTokens(pair), 0);
        if (page.length < 32) historyExhausted = true;
      }
      };
      loadHistory(historyLoadBudgetTokens({ question: userMessage.content, limits, locale: "en" }));
      // Version identity is cheap metadata, never the body of the whole project.
      const sourceVersion = (): string => JSON.stringify(this.deps.db.prepare("SELECT id,current_revision_id,status FROM sources WHERE project_id=? ORDER BY id").all(turn.projectId));
      const initialSourceVersion = sourceVersion();
      const embeddingVersion = (): string => JSON.stringify(this.deps.db.prepare("SELECT space_id FROM project_embedding_spaces WHERE project_id=?").all(turn.projectId));
      const initialEmbeddingVersion = embeddingVersion();
      let retrievalBudget = historyLoadBudgetTokens({ question: userMessage.content, limits, locale: "en" });

      let retrieved: RetrievableChunk[];
      let retrievalDiagnostics: ChatRetrievalDiagnostics | undefined;
      try {
        // Same effective output reserve and fixed-input allowance as assembly.
        const evidenceTokenBudget = retrievalBudget;
        const retrievalResult = await this.deps.retrieval({ projectId: turn.projectId, question: userMessage.content, evidenceTokenBudget, signal });
        retrieved = retrievalResult;
        retrievalDiagnostics = retrievalResult.diagnostics;
      } catch {
        if (signal.aborted) retrieved = [];
        else {
          // Retrieval outage must surface as a repairable failure, never as a no-evidence answer.
          const indexError = appError("INDEX_UNAVAILABLE", "errors.indexUnavailable", true);
          repo.failAssistantMessage({ projectId: turn.projectId, messageId: assistant.id, errorCode: indexError.code, updatedAt: this.clock().toISOString() });
          emit({ type: "failed", requestId, messageId: assistant.id, error: { code: indexError.code, messageKey: indexError.messageKey, recoverable: indexError.recoverable } });
          return { ok: false, error: indexError };
        }
      }

      if (signal.aborted) {
        const cancelled = repo.cancelAssistantMessage({ projectId: turn.projectId, messageId: assistant.id, updatedAt: this.clock().toISOString() });
        emit({ type: "cancelled", requestId, messageId: assistant.id, message: cancelled });
        return { ok: true, value: { requestId, assistantMessageId: assistant.id } };
      }

      const retrievalsByLabel: Record<string, RetrievedCitation> = {};
      const context = assembleContext({ question: userMessage.content, retrieved, historyPairs, limits, locale: "en" });
      // Context builder owns deterministic S-labels; align the citation map to what it issued.
      for (const c of context.citations) {
        const match = retrieved.find((r) => r.chunkId === c.chunkId);
        if (match) retrievalsByLabel[c.label] = match;
      }

      repo.createGenerationContext({
        projectId: turn.projectId,
        messageId: assistant.id,
        requestId,
        snapshot: {
          version: 1,
          projectId: turn.projectId,
          conversationId: turn.conversationId,
          questionMessageId: userMessage.id,
          question: userMessage.content,
          historyPairs,
          ...(retrievalDiagnostics ? { retrievalDiagnostics } : {}),
          profile: { id: profile.id, provider: profile.provider, modelId: profile.modelId, baseUrl: profile.baseUrl },
          contextMessages: context.messages,
          retrievals: retrievalsByLabel,
          evidence: context.citations.map((citation) => ({
            label: citation.label,
            chunkId: citation.chunkId,
            sourceId: citation.sourceId,
            ...(citation.revisionId ? { revisionId: citation.revisionId } : {}),
            ...(citation.contentHash ? { contentHash: citation.contentHash } : {}),
            sourceDisplayName: citation.sourceDisplayName,
            ...(citation.sourceKind ? { sourceKind: citation.sourceKind } : {}),
            ...(citation.locator ? { locator: citation.locator } : {}),
            locatorSummary: citation.locatorSummary,
            sentText: citation.sentText,
            truncated: citation.truncated
          })),
          thinking: thinking ?? "off"
        },
        runtime: {
          version: 1,
          operation: "initial",
          status: "running",
          lastRequestId: requestId,
          finishKind: null,
          rawFinishReason: null,
          outputTokenLimit: context.tokenBudget.outputTokenReserve,
          baseUsage: null,
          attemptUsage: null,
          usageComplete: false,
          lastError: null,
          blockedReason: null,
          canContinue: false
        }
      });

      return await this.runGeneration({
        repo,
        turn,
        profile,
        profiles,
        generationProfileId,
        ...(thinking ? { thinking } : {}),
        retrievals: retrievalsByLabel,
        contextMessages: context.messages,
        outputTokenReserve: context.tokenBudget.outputTokenReserve,
        assistantId: assistant.id,
        requestId,
        signal,
        emit,
        prepareRequest: async (candidate) => {
          const configurationError = generationSettingsError(candidate);
          if (configurationError) throw new ProviderRequestError({ error: configurationError, fallbackEligible: false });
          const candidateBudget = historyLoadBudgetTokens({ question: userMessage.content, limits: resolveGenerationLimits(candidate), locale: "en" });
          if (candidateBudget > retrievalBudget) {
            if (sourceVersion() !== initialSourceVersion || embeddingVersion() !== initialEmbeddingVersion) throw new ProviderRequestError({ error: appError("CONFLICT", "errors.continueSourceUnavailable", true), fallbackEligible: false });
            loadHistory(candidateBudget);
            try {
              const expanded = await this.deps.retrieval({ projectId: turn.projectId, question: userMessage.content, evidenceTokenBudget: candidateBudget, signal });
              retrieved = expanded;
              retrievalDiagnostics = expanded.diagnostics;
              retrievalBudget = candidateBudget;
            } catch {
              throw new ProviderRequestError({ error: appError("INDEX_UNAVAILABLE", "errors.indexUnavailable", true), fallbackEligible: false });
            }
          }
          if (sourceVersion() !== initialSourceVersion || embeddingVersion() !== initialEmbeddingVersion || !evidenceIsCurrent(this.deps.db, turn.projectId, retrieved)) {
            throw new ProviderRequestError({ error: appError("CONFLICT", "errors.continueSourceUnavailable", true), fallbackEligible: false });
          }
          const candidateContext = assembleContext({ question: userMessage.content, retrieved, historyPairs, limits: resolveGenerationLimits(candidate), locale: "en" });
          // Each actual attempt is checked against its own window before the
          // provider is called; an over-budget request must never be sent.
          if (candidateContext.fixedOverflow || candidateContext.diagnostics.reasons.includes("context-budget")) {
            throw new ProviderRequestError({
              error: appError("VALIDATION", "errors.contextBudgetExceeded", true),
              fallbackEligible: true
            });
          }
          return {
            messages: candidateContext.messages,
            maxTokens: candidateContext.tokenBudget.outputTokenReserve,
            evidence: candidateContext.citations,
            historyPairs,
            historyMessageIds: candidateContext.historyMessageIds,
            diagnostics: candidateContext.diagnostics,
            retrievals: mapContextCitations(candidateContext.citations, retrieved)
          };
        }
      });
    } finally {
      this.registry.complete(requestId, owner);
      this.inFlightConversations.delete(turn.conversationId);
    }
  }

  private async runGeneration(args: {
    repo: ConversationRepository;
    turn: ConversationQuery;
    profile: ModelProfileDto;
    profiles?: readonly ModelProfileDto[];
    generationProfileId?: string | undefined;
    thinking?: "off" | "low" | "medium" | "high" | undefined;
    retrievals: Record<string, RetrievedCitation>;
    contextMessages: ChatTurn[];
    outputTokenReserve: number;
    assistantId: string;
    requestId: string;
    signal: AbortSignal;
    emit: (event: StreamEvent) => void;
    continuation?: boolean;
    initialContent?: string;
    allowFallback?: boolean;
    prepareRequest?: (profile: ModelProfileDto) => Promise<PreparedGenerationRequest> | PreparedGenerationRequest;
  }): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const { repo, turn, profile, generationProfileId, thinking, retrievals, contextMessages, outputTokenReserve, assistantId, requestId, signal, emit, continuation = false, initialContent = "", allowFallback = true, prepareRequest } = args;
    const now = this.clock.bind(this);
    let fullText = initialContent;
    let lastCheckpointAt = now().getTime();
    let bytesSinceCheckpoint = 0;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    let inputUsageKnown = false;
    let outputUsageKnown = false;
    const previousUsage = continuation ? (repo.getMessage(turn.projectId, assistantId)?.usage ?? null) : null;
    const previousUsageComplete = !continuation || repo.getGenerationContext(turn.projectId, assistantId)?.runtime.baseUsageComplete === true;
    let finishReason = "stop";
    let sawDone = false;
    let failure: AppErrorDto | null = null;
    let actualProfile: { provider: string; model: string; profileId: string | null } = { provider: profile.provider, model: profile.modelId, profileId: profile.id };
    let activeRetrievals = retrievals;
    let activeContextMessages = contextMessages;
    let activeOutputTokenReserve = outputTokenReserve;
    // One preparation per actual attempt, memoized by profile: the router calls
    // this immediately before the provider call, so persisting here keeps the
    // saved snapshot and the wire request derived from the same computation.
    const preparedByProfile = new Map<string, PreparedGenerationRequest>();
    const prepareForAttempt = async (candidate: ModelProfileDto): Promise<PreparedGenerationRequest> => {
      const cached = preparedByProfile.get(candidate.id);
      if (cached) return cached;
      if (!prepareRequest) return { messages: activeContextMessages, maxTokens: activeOutputTokenReserve, retrievals: activeRetrievals };
      const prepared = await prepareRequest(candidate);
      preparedByProfile.set(candidate.id, prepared);
      activeContextMessages = prepared.messages;
      activeOutputTokenReserve = prepared.maxTokens;
      if (prepared.retrievals) activeRetrievals = prepared.retrievals;
      const saved = repo.getGenerationContext(turn.projectId, assistantId);
      if (saved) {
        repo.updateGenerationSnapshot({
          projectId: turn.projectId,
          messageId: assistantId,
          snapshot: {
            ...(saved.snapshot as Record<string, unknown>),
            profile: { id: candidate.id, provider: candidate.provider, modelId: candidate.modelId, baseUrl: candidate.baseUrl },
            contextMessages: prepared.messages,
            ...(prepared.evidence ? { evidence: prepared.evidence } : {}),
            ...(prepared.historyPairs ? { historyPairs: prepared.historyPairs } : {}),
            ...(prepared.diagnostics ? { contextDiagnostics: prepared.diagnostics, historyMessageIds: prepared.historyMessageIds } : {}),
            ...(prepared.retrievals ? { retrievals: prepared.retrievals } : {})
          }
        });
        repo.updateGenerationRuntime({
          projectId: turn.projectId,
          messageId: assistantId,
          runtime: { ...saved.runtime, outputTokenLimit: prepared.maxTokens },
          expectedRevision: saved.revision
        });
      }
      return prepared;
    };
    const buffer = new CitationStreamBuffer();

    const checkpoint = (): void => {
      this.deps.db.transaction(() => {
        repo.checkpointAssistantContent({
          projectId: turn.projectId,
          messageId: assistantId,
          content: fullText,
          updatedAt: now().toISOString()
        });
        const saved = repo.getGenerationContext(turn.projectId, assistantId);
        if (saved) repo.updateGenerationRuntime({ projectId: turn.projectId, messageId: assistantId,
          runtime: { ...saved.runtime, baseUsage: previousUsage, attemptUsage: usage, usageComplete: false } });
      })();
      lastCheckpointAt = now().getTime();
      bytesSinceCheckpoint = 0;
    };

    try {
      const routedRequest = {
        projectId: turn.projectId,
        operationId: requestId,
        model: profile.modelId,
        messages: activeContextMessages,
        maxTokens: activeOutputTokenReserve,
        ...(thinking === undefined ? {} : { thinking }),
        prepareRequest: prepareForAttempt,
        ...(allowFallback ? {} : { allowFallback: false })
      };
      const deps = this.routedDeps();
      if (args.profiles) deps.router = { resolve: () => args.profiles! };
      for await (const event of generateRouted(deps, "chat", routedRequest, generationProfileId, signal)) {
        if (event.type === "attempt-started") {
          usage = null;
          inputUsageKnown = outputUsageKnown = false;
          actualProfile = event.attempt;
          this.deps.db.prepare("UPDATE messages SET provider=?,profile_id=?,model=? WHERE id=? AND state='streaming'")
            .run(actualProfile.provider, actualProfile.profileId, actualProfile.model, assistantId);
          continue;
        }
        if (event.type === "fallback") {
          emit({ type: "fallback", requestId, attempted: event.attempted, next: event.next, errorCode: event.errorCode });
          continue;
        }
        if (event.type === "routed-complete") {
          actualProfile = event.profile;
          continue;
        }
        if (event.type === "text-delta") {
          if (signal.aborted) break;
          const offset = fullText.length;
          const visible = buffer.push(event.text);
          fullText += visible;
          emit({ type: "delta", requestId, messageId: assistantId, text: visible, offset });
          bytesSinceCheckpoint += Buffer.byteLength(event.text, "utf8");
          const elapsed = now().getTime() - lastCheckpointAt;
          // Checkpoint at most every 1s or 2KiB, whichever comes first.
          if (bytesSinceCheckpoint >= CHECKPOINT_INTERVAL_BYTES || elapsed >= CHECKPOINT_INTERVAL_MS) checkpoint();
        } else if (event.type === "usage") {
          inputUsageKnown ||= event.inputTokens !== undefined;
          outputUsageKnown ||= event.outputTokens !== undefined;
          usage = mergeUsageSnapshot(usage, event);
        } else if (event.type === "done") {
          sawDone = true;
          if (event.finishReason) finishReason = event.finishReason;
        }
      }
    } catch (reason) {
      failure = signal.aborted
        ? appError("CANCELLED", "errors.chatCancelled", true)
        : reason instanceof Error && "error" in reason && (reason as { error?: AppErrorDto }).error
          ? (reason as { error: AppErrorDto }).error
          : appError("PROVIDER", "errors.providerFailure");
    }
    fullText += buffer.flush();

    if (!signal.aborted && !failure && !sawDone) {
      failure = appError("PROVIDER", "errors.providerIncomplete");
    }

    // Abort/error always ends with a final checkpoint before the terminal state.
    checkpoint();

    const runtimeFor = (status: "idle" | "interrupted", finishKind: FinishKind | null, lastError: string | null): Record<string, unknown> => ({
      version: 1,
      operation: continuation ? "continue" : "initial",
      status,
      lastRequestId: requestId,
      finishKind,
      rawFinishReason: finishReason,
      outputTokenLimit: activeOutputTokenReserve,
      baseUsage: previousUsage,
      attemptUsage: usage,
      usageComplete: inputUsageKnown && outputUsageKnown && sawDone && !failure && !signal.aborted && previousUsageComplete,
      lastError,
      blockedReason: finishKind === "context-limit" ? "context-limit" : null,
      canContinue: status === "interrupted" ? Boolean(fullText.trim()) : finishKind === "length" && Boolean(fullText.trim())
    });
    // Continuations commit text, citations, usage and runtime together. A
    // partial write would strand a completed message on a running context that
    // restart recovery skips.
    const finalizeInterruptedContinuation = (lastError: string | null): Result<{ requestId: string; assistantMessageId: string }> | null => {
      if (!continuation) return null;
      const finalUsage = addUsage(previousUsage, usage) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const rows = buildCitationRows({ messageId: assistantId, parsed: finalizeCitations(fullText, activeRetrievals), retrievals: activeRetrievals }, now().toISOString());
      const interruptionFinishKind: FinishKind = failure?.messageKey === "errors.outputLimitEmpty" || normalizeFinishReason(finishReason) === "length"
        ? "length"
        : "other";
      const interrupted = repo.finalizeContinuation({
        projectId: turn.projectId,
        messageId: assistantId,
        conversationId: turn.conversationId,
        content: fullText,
        usage: finalUsage,
        completionReason: "interruption",
        provider: actualProfile.provider,
        profileId: actualProfile.profileId ?? profile.id,
        model: actualProfile.model,
        runtime: runtimeFor("interrupted", interruptionFinishKind, lastError),
        citations: rows,
        updatedAt: now().toISOString()
      });
      if (failure && failure.code !== "CANCELLED") emit({ type: "failed", requestId, messageId: assistantId, message: interrupted, operation: "continue", error: failure });
      else emit({ type: "cancelled", requestId, messageId: assistantId, message: interrupted, operation: "continue" });
      return { ok: true, value: { requestId, assistantMessageId: assistantId } };
    };
    if (signal.aborted || failure?.code === "CANCELLED") {
      const interrupted = finalizeInterruptedContinuation(null);
      if (interrupted) return interrupted;
      const cancelled = this.deps.db.transaction(() => {
        persistParsedCitations(this.deps.db, { projectId: turn.projectId, messageId: assistantId, parsed: finalizeCitations(fullText, activeRetrievals), retrievals: activeRetrievals });
        this.deps.db.prepare("UPDATE messages SET usage_json=? WHERE id=?").run(usage ? JSON.stringify(usage) : null, assistantId);
        repo.cancelAssistantMessage({ projectId: turn.projectId, messageId: assistantId, updatedAt: now().toISOString() });
        repo.updateGenerationRuntime({ projectId: turn.projectId, messageId: assistantId, runtime: { ...runtimeFor("interrupted", null, null), canContinue: false }, activeRequestId: null });
        return repo.getMessage(turn.projectId, assistantId)!;
      })();
      emit({ type: "cancelled", requestId, messageId: assistantId, message: cancelled });
      return { ok: true, value: { requestId, assistantMessageId: assistantId } };
    }

    if (failure) {
      const interrupted = finalizeInterruptedContinuation(failure.messageKey);
      if (interrupted) return { ok: false, error: failure };
      const failureFinishKind: FinishKind = failure.messageKey === "errors.outputLimitEmpty" ? "length" : "other";
      this.deps.db.transaction(() => {
      persistParsedCitations(this.deps.db, { projectId: turn.projectId, messageId: assistantId, parsed: finalizeCitations(fullText, activeRetrievals), retrievals: activeRetrievals });
      this.deps.db.prepare("UPDATE messages SET usage_json=? WHERE id=?").run(usage ? JSON.stringify(usage) : null, assistantId);
      repo.failAssistantMessage({
        projectId: turn.projectId,
        messageId: assistantId,
        errorCode: failure.code,
        updatedAt: now().toISOString()
      });
      repo.updateGenerationRuntime({ projectId: turn.projectId, messageId: assistantId, runtime: { ...runtimeFor("idle", failureFinishKind, failure!.messageKey), canContinue: false }, activeRequestId: null });
      })();
      emit({ type: "failed", requestId, messageId: assistantId, message: repo.getMessage(turn.projectId, assistantId)!, error: failure });
      return { ok: false, error: failure };
    }

    // Finalize citations strictly against this request's retrieval map, then persist completion.
    const parsed = finalizeCitations(fullText, activeRetrievals);
    const finalUsage = addUsage(previousUsage, usage);
    const finishKind = normalizeFinishReason(finishReason);
    const citationRows = buildCitationRows({ messageId: assistantId, parsed, retrievals: activeRetrievals }, now().toISOString());
    // Text, citations, usage, and runtime land in one transaction so a failure
    // cannot leave a completed message attached to a running generation.
    const completed = continuation
      ? repo.finalizeContinuation({
        projectId: turn.projectId,
        messageId: assistantId,
        conversationId: turn.conversationId,
        content: fullText,
        usage: finalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        completionReason: finishReason,
        provider: actualProfile.provider,
        profileId: actualProfile.profileId ?? profile.id,
        model: actualProfile.model,
        runtime: runtimeFor("idle", finishKind, null),
        citations: citationRows,
        updatedAt: now().toISOString()
      })
      : repo.completeAssistantWithCitations({
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        id: assistantId,
        content: fullText,
        provider: actualProfile.provider,
        profileId: actualProfile.profileId ?? profile.id,
        model: actualProfile.model,
        usage: finalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        completionReason: finishReason,
        runtime: runtimeFor("idle", finishKind, null),
        citations: citationRows,
        updatedAt: now().toISOString()
      });
    const finalMessage = repo.getMessage(turn.projectId, completed.id)!;
    emit({ type: "completed", requestId, messageId: finalMessage.id, message: finalMessage });
    return { ok: true, value: { requestId, assistantMessageId: finalMessage.id } };
  }

  private repo(): ConversationRepository {
    return new ConversationRepository(this.deps.db);
  }

  private clock(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private generationProfiles(overrideProfileId?: string): readonly ModelProfileDto[] {
    if (this.deps.router) return this.deps.router.resolve("chat", overrideProfileId);
    const profile = this.deps.generationProfile;
    return profile && profile.enabled && profile.capability === "generation" ? [profile] : [];
  }

  private routedDeps() {
    const router = this.deps.router ?? {
      resolve: (_task: "chat", _override?: string) => {
        const profile = this.deps.generationProfile;
        return profile && profile.enabled && profile.capability === "generation" ? [Object.freeze({ ...profile })] : [];
      }
    };
    return {
      db: this.deps.db,
      router,
      providerFactory: this.deps.providerFactory,
      ...(this.deps.now ? { clock: this.deps.now } : {}),
      id: () => crypto.randomUUID()
    };
  }
}

function addUsage(
  base: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
  attempt: { inputTokens: number; outputTokens: number; totalTokens: number } | null
): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (!base && !attempt) return null;
  return {
    inputTokens: (base?.inputTokens ?? 0) + (attempt?.inputTokens ?? 0),
    outputTokens: (base?.outputTokens ?? 0) + (attempt?.outputTokens ?? 0),
    totalTokens: (base?.totalTokens ?? 0) + (attempt?.totalTokens ?? 0)
  };
}

function mergeUsageSnapshot(previous: { inputTokens: number; outputTokens: number } | null, event: { inputTokens?: number; outputTokens?: number }): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const inputTokens = event.inputTokens ?? previous?.inputTokens ?? 0;
  const outputTokens = event.outputTokens ?? previous?.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function internalResult(_reason: unknown): Result<never> {
  return { ok: false, error: appError("INTERNAL", "errors.internal") };
}

export async function sendChatMessage(deps: ChatSendDeps, input: SendInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
  return new ChatService(deps).send(input, emit);
}
