import type Database from "better-sqlite3";
import type { ModelProfileDto } from "../../shared/models";
import type { AppErrorDto, Result } from "../../shared/app-errors";
import type { ChatTurn, ModelProvider } from "../models/provider";
import { ModelRouter } from "../models/model-router";
import { generateRouted } from "../models/routed-generation";
import type { ConversationDto, MessageDto } from "../../shared/chat";
import type { RetrievedCitation } from "./citation-parser";
import { CitationStreamBuffer, finalizeCitations } from "./citation-parser";
import { persistParsedCitations } from "./citation-persist";
import { assembleContext } from "./context-builder";
import { ConversationRepository } from "./conversation-repository";
import { ChatSessionRegistry, type SessionOwner } from "./chat-session-registry";

const CHECKPOINT_INTERVAL_MS = 1_000;
const CHECKPOINT_INTERVAL_BYTES = 2_048;
const SESSION_USER = "owner";

export type RetrievableChunk = RetrievedCitation & { locatorSummary: string; text: string };

export type RetrievalFn = (input: { projectId: string; question: string }) => Promise<RetrievableChunk[]>;

export type ChatSendDeps = {
  db: Database.Database;
  generationProfile?: ModelProfileDto | undefined;
  router?: Pick<ModelRouter, "resolve">;
  providerFactory: (profile: ModelProfileDto) => ModelProvider;
  retrieval: RetrievalFn;
  now?: () => Date;
  randomId?: (n: number) => string;
};

export type SendInput = { requestId: string; projectId: string; conversationId: string; question: string };
export type RegenerateInput = { requestId: string; projectId: string; conversationId: string; messageId: string };
type ConversationQuery = { projectId: string; conversationId: string };

type StreamEvent =
  | { type: "started"; requestId: string; messageId: string }
  | { type: "delta"; requestId: string; messageId: string; text: string }
  | { type: "completed"; requestId: string; messageId: string; message: MessageDto }
  | { type: "cancelled"; requestId: string; messageId: string; message: MessageDto }
  | { type: "fallback"; requestId: string; attempted: { provider: string; model: string; profileId: string | null }; next: { provider: string; model: string; profileId: string | null }; errorCode: string }
  | { type: "failed"; requestId: string; messageId: string; error: { code: string; messageKey: string; recoverable: boolean } };

function appError(code: AppErrorDto["code"], messageKey: string, recoverable = false): AppErrorDto {
  return { code, messageKey, recoverable };
}

/** Startup recovery: abandoned streaming drafts become cancelled with interruption metadata. */
export function recoverInterruptedStreams(db: Database.Database, now = new Date()): number {
  const result = db.prepare(
    "UPDATE messages SET state='cancelled', completion_reason='interruption', error_code='INTERRUPTED', updated_at=? WHERE state='streaming'"
  ).run(now.toISOString());
  return result.changes;
}

type TurnContext = {
  requestId: string;
  turn: ConversationQuery & { requestId: string };
  repo: ConversationRepository;
  profile: ModelProfileDto;
  owner: SessionOwner;
  nextId: () => string;
  userMessage: MessageDto;
  /** When set, this turn replaces an earlier assistant reply instead of appending after a fresh user message. */
  supersedesMessageId: string | null;
  emit: (event: StreamEvent) => void;
};

export class ChatService {
  private readonly registry = new ChatSessionRegistry();
  private readonly inFlightConversations = new Set<string>();

  constructor(private readonly deps: ChatSendDeps) {}

  activeRequests(): string[] {
    return this.registry.activeRequests();
  }

  stopRequest(requestId: string, caller: SessionOwner): boolean {
    return this.registry.cancel(requestId, caller);
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
      const profile = this.generationProfiles()[0];
      if (!profile) return { ok: false, error: appError("VALIDATION", "errors.generationProfileMissing") };
      // Ownership is validated inside the repository before anything is written.
      const conversation = repo.getConversation(input.projectId, input.conversationId);
      if (!conversation || conversation.archivedAt) return { ok: false, error: appError("CONFLICT", "errors.chatArchived") };
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
      return await this.runTurn({ requestId: input.requestId, turn: input, repo, profile, owner, nextId, userMessage, supersedesMessageId: null, emit });
    } catch (reason) {
      return internalResult(reason);
    }
  }

  async regenerate(input: RegenerateInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const owner: SessionOwner = { projectId: input.projectId, userId: SESSION_USER };
    try {
      const repo = this.repo();
      const profile = this.generationProfiles()[0];
      if (!profile) return { ok: false, error: appError("VALIDATION", "errors.generationProfileMissing") };
      const conversation = repo.getConversation(input.projectId, input.conversationId);
      if (!conversation || conversation.archivedAt) return { ok: false, error: appError("CONFLICT", "errors.chatArchived") };
      const old = repo.getMessage(input.projectId, input.messageId);
      if (!old || old.role !== "assistant" || !old.replyToMessageId) return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      if (old.superseded) return { ok: false, error: appError("CONFLICT", "errors.chatRegenerateSuperseded") };
      const userMessage = repo.getMessage(input.projectId, old.replyToMessageId);
      if (!userMessage || userMessage.role !== "user" || userMessage.content === "") {
        return { ok: false, error: appError("NOT_FOUND", "errors.notFound") };
      }
      if (this.inFlightConversations.has(input.conversationId)) {
        return { ok: false, error: appError("CONFLICT", "errors.chatSendInFlight", true) };
      }
      let counter = 0;
      const nextId = (): string => (this.deps.randomId ? this.deps.randomId(++counter) : crypto.randomUUID());
      return await this.runTurn({ requestId: input.requestId, turn: input, repo, profile, owner, nextId, userMessage, supersedesMessageId: old.id, emit });
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
    const { turn, repo, profile, owner, nextId, userMessage, supersedesMessageId, emit } = args;
    let retrieved: RetrievableChunk[];
    try {
      retrieved = await this.deps.retrieval({ projectId: turn.projectId, question: userMessage.content });
    } catch {
      // Retrieval outage must surface as a repairable failure, never as a no-evidence answer.
      const indexError = appError("INDEX_UNAVAILABLE", "errors.indexUnavailable", true);
      const draft = repo.startAssistantMessage({
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        id: nextId(),
        replyToMessageId: userMessage.id,
        provider: profile.provider,
        profileId: profile.id,
        model: profile.modelId,
        createdAt: this.clock().toISOString()
      });
      repo.failAssistantMessage({ projectId: turn.projectId, messageId: draft.id, errorCode: indexError.code, updatedAt: this.clock().toISOString() });
      emit({ type: "failed", requestId: turn.requestId, messageId: draft.id, error: { code: indexError.code, messageKey: indexError.messageKey, recoverable: indexError.recoverable } });
      return { ok: false, error: indexError };
    }
    const retrievalsByLabel: Record<string, RetrievedCitation> = {};
    for (const item of retrieved) retrievalsByLabel[item.label] = item;

    const context = assembleContext({ question: userMessage.content, retrieved, priorTurns: [], locale: "en" });
    // Context builder owns deterministic S-labels; align the citation map to what it issued.
    for (const c of context.citations) {
      const match = retrieved.find((r) => r.chunkId === c.chunkId);
      if (match) retrievalsByLabel[c.label] = match;
    }

    const startedAt = this.clock().toISOString();
    const draftId = nextId();
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

    const requestId = turn.requestId;
    // Reserve BEFORE generation work so stop/conflict see a consistent state.
    const { signal } = this.registry.register(requestId, owner);
    this.inFlightConversations.add(turn.conversationId);
    emit({ type: "started", requestId, messageId: assistant.id });

    const outcome = await this.runGeneration({ repo, turn, profile, retrievals: retrievalsByLabel, contextMessages: context.messages, assistantId: assistant.id, requestId, signal, emit });
    this.registry.complete(requestId, owner);
    this.inFlightConversations.delete(turn.conversationId);
    return outcome;
  }

  private async runGeneration(args: {
    repo: ConversationRepository;
    turn: ConversationQuery;
    profile: ModelProfileDto;
    retrievals: Record<string, RetrievedCitation>;
    contextMessages: ChatTurn[];
    assistantId: string;
    requestId: string;
    signal: AbortSignal;
    emit: (event: StreamEvent) => void;
  }): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const { repo, turn, profile, retrievals, contextMessages, assistantId, requestId, signal, emit } = args;
    const now = this.clock.bind(this);
    let fullText = "";
    let lastCheckpointAt = now().getTime();
    let bytesSinceCheckpoint = 0;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    let finishReason = "stop";
    let sawDone = false;
    let failure: AppErrorDto | null = null;
    let actualProfile: { provider: string; model: string; profileId: string | null } = { provider: profile.provider, model: profile.modelId, profileId: profile.id };
    const buffer = new CitationStreamBuffer();

    const checkpoint = (): void => {
      repo.checkpointAssistantContent({
        projectId: turn.projectId,
        messageId: assistantId,
        content: fullText,
        updatedAt: now().toISOString()
      });
      lastCheckpointAt = now().getTime();
      bytesSinceCheckpoint = 0;
    };

    try {
      const routedRequest = { projectId: turn.projectId, operationId: requestId, model: profile.modelId, messages: contextMessages };
      for await (const event of generateRouted(this.routedDeps(), "chat", routedRequest, undefined, signal)) {
        if (event.type === "attempt-started") {
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
          const visible = buffer.push(event.text);
          fullText += visible;
          emit({ type: "delta", requestId, messageId: assistantId, text: visible });
          bytesSinceCheckpoint += Buffer.byteLength(event.text, "utf8");
          const elapsed = now().getTime() - lastCheckpointAt;
          // Checkpoint at most every 1s or 2KiB, whichever comes first.
          if (bytesSinceCheckpoint >= CHECKPOINT_INTERVAL_BYTES || elapsed >= CHECKPOINT_INTERVAL_MS) checkpoint();
        } else if (event.type === "usage") {
          usage = {
            inputTokens: event.inputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            totalTokens: (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
          };
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

    if (signal.aborted || failure?.code === "CANCELLED") {
      const cancelled = repo.cancelAssistantMessage({
        projectId: turn.projectId,
        messageId: assistantId,
        updatedAt: now().toISOString()
      });
      emit({ type: "cancelled", requestId, messageId: assistantId, message: cancelled });
      return { ok: true, value: { requestId, assistantMessageId: assistantId } };
    }

    if (failure) {
      repo.failAssistantMessage({
        projectId: turn.projectId,
        messageId: assistantId,
        errorCode: failure.code,
        updatedAt: now().toISOString()
      });
      emit({ type: "failed", requestId, messageId: assistantId, error: { code: failure.code, messageKey: failure.messageKey, recoverable: failure.recoverable } });
      return { ok: false, error: failure };
    }

    // Finalize citations strictly against this request's retrieval map, then persist completion.
    const parsed = finalizeCitations(fullText, retrievals);
    for (const citation of parsed.citations) {
      persistParsedCitations(this.deps.db, {
        projectId: turn.projectId,
        messageId: assistantId,
        parsed: { citations: [citation], hasInvalidCitations: false, content: fullText },
        retrievals
      });
    }
    const completed = repo.completeAssistantMessage({
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      id: assistantId,
      content: fullText,
      provider: actualProfile.provider,
      profileId: actualProfile.profileId ?? profile.id,
      model: actualProfile.model,
      usage: usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      completionReason: finishReason,
      updatedAt: now().toISOString()
    });
    emit({ type: "completed", requestId, messageId: completed.id, message: completed });
    return { ok: true, value: { requestId, assistantMessageId: completed.id } };
  }

  private repo(): ConversationRepository {
    return new ConversationRepository(this.deps.db);
  }

  private clock(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private generationProfiles(): readonly ModelProfileDto[] {
    if (this.deps.router) return this.deps.router.resolve("chat");
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

function internalResult(reason: unknown): Result<never> {
  const message = reason instanceof Error ? reason.message : String(reason);
  return { ok: false, error: appError("INTERNAL", `errors.internal:${message}`) };
}

export async function sendChatMessage(deps: ChatSendDeps, input: SendInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
  return new ChatService(deps).send(input, emit);
}
