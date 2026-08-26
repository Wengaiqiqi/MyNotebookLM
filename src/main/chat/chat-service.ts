import type Database from "better-sqlite3";
import type { ModelProfileDto } from "../../shared/models";
import type { AppErrorDto, Result } from "../../shared/app-errors";
import type { ChatTurn, GenerationEvent, ModelProvider } from "../models/provider";
import type { MessageDto } from "../../shared/chat";
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
  providerFactory: (profile: ModelProfileDto) => ModelProvider;
  retrieval: RetrievalFn;
  now?: () => Date;
  randomId?: (n: number) => string;
};

export type SendInput = { projectId: string; conversationId: string; question: string };

type StreamEvent =
  | { type: "started"; requestId: string; messageId: string }
  | { type: "delta"; messageId: string; text: string }
  | { type: "completed"; messageId: string; message: MessageDto }
  | { type: "cancelled"; messageId: string; message: MessageDto }
  | { type: "failed"; messageId: string; error: { code: string; messageKey: string; recoverable: boolean } };

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

  async send(input: SendInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const owner: SessionOwner = { projectId: input.projectId, userId: SESSION_USER };
    try {
      return await this.sendInner(input, owner, emit);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      return { ok: false, error: appError("INTERNAL", `errors.internal:${message}`) };
    }
  }

  private async sendInner(input: SendInput, owner: SessionOwner, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const now = this.deps.now ?? (() => new Date());
    let idCounter = 0;
    const nextId = (_n: number) => (this.deps.randomId ? this.deps.randomId(++idCounter) : crypto.randomUUID());
    const repo = new ConversationRepository(this.deps.db);
    const profile = this.deps.generationProfile;
    if (!profile || !profile.enabled || profile.capability !== "generation") {
      return { ok: false, error: appError("VALIDATION", "errors.generationProfileMissing") };
    }

    // Ownership is validated inside the repository before anything is written.
    repo.getConversation(input.projectId, input.conversationId);
    if (this.inFlightConversations.has(input.conversationId)) {
      return { ok: false, error: appError("CONFLICT", "errors.chatSendInFlight", true) };
    }

    const userMessage = repo.appendUserMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      id: nextId(1),
      content: input.question,
      createdAt: now().toISOString()
    });

    let retrieved: RetrievableChunk[];
    try {
      retrieved = await this.deps.retrieval({ projectId: input.projectId, question: input.question });
    } catch {
      // ponytail: retrieval outage degrades to no-evidence answer; Task 5 adds repair surfacing.
      retrieved = [];
    }
    const retrievalsByLabel: Record<string, RetrievedCitation> = {};
    for (const item of retrieved) retrievalsByLabel[item.label] = item;

    const context = assembleContext({ question: input.question, retrieved, priorTurns: [], locale: "en" });
    // Context builder owns deterministic S-labels; align the citation map to what it issued.
    for (const c of context.citations) {
      const match = retrieved.find((r) => r.chunkId === c.chunkId);
      if (match) retrievalsByLabel[c.label] = match;
    }

    const provider = this.deps.providerFactory(profile);
    const assistant = repo.startAssistantMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      id: nextId(2),
      replyToMessageId: userMessage.id,
      provider: profile.provider,
      profileId: profile.id,
      model: profile.modelId,
      createdAt: now().toISOString()
    });

    const requestId = nextId(3);
    // Reserve BEFORE generation work so stop/conflict see a consistent state.
    const { signal } = this.registry.register(requestId, owner);
    this.inFlightConversations.add(input.conversationId);
    emit({ type: "started", requestId, messageId: assistant.id });

    const outcome = await this.runGeneration({ repo, input, profile, provider, retrievals: retrievalsByLabel, contextMessages: context.messages, assistantId: assistant.id, signal, emit });
    this.registry.complete(requestId, owner);
    this.inFlightConversations.delete(input.conversationId);
    return outcome;
  }

  private async runGeneration(args: {
    repo: ConversationRepository;
    input: SendInput;
    profile: ModelProfileDto;
    provider: ModelProvider;
    retrievals: Record<string, RetrievedCitation>;
    contextMessages: ChatTurn[];
    assistantId: string;
    signal: AbortSignal;
    emit: (event: StreamEvent) => void;
  }): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
    const { repo, input, profile, provider, retrievals, contextMessages, assistantId, signal, emit } = args;
    const now = this.deps.now ?? (() => new Date());
    let fullText = "";
    let lastCheckpointAt = now().getTime();
    let bytesSinceCheckpoint = 0;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    let finishReason = "stop";
    let sawDone = false;
    let failure: AppErrorDto | null = null;
    const buffer = new CitationStreamBuffer();

    const checkpoint = (): void => {
      repo.checkpointAssistantContent({
        projectId: input.projectId,
        messageId: assistantId,
        content: fullText,
        updatedAt: now().toISOString()
      });
      lastCheckpointAt = now().getTime();
      bytesSinceCheckpoint = 0;
    };

    try {
      for await (const event of provider.generate({ model: profile.modelId, messages: contextMessages }, signal)) {
        if (event.type === "text-delta") {
          if (signal.aborted) break;
          const visible = buffer.push(event.text);
          fullText += visible;
          emit({ type: "delta", messageId: assistantId, text: visible });
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
    } catch {
      failure = signal.aborted
        ? appError("CANCELLED", "errors.chatCancelled", true)
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
        projectId: input.projectId,
        messageId: assistantId,
        updatedAt: now().toISOString()
      });
      emit({ type: "cancelled", messageId: assistantId, message: cancelled });
      return { ok: true, value: { requestId: "", assistantMessageId: assistantId } };
    }

    if (failure) {
      repo.failAssistantMessage({
        projectId: input.projectId,
        messageId: assistantId,
        errorCode: failure.code,
        updatedAt: now().toISOString()
      });
      emit({ type: "failed", messageId: assistantId, error: { code: failure.code, messageKey: failure.messageKey, recoverable: failure.recoverable } });
      return { ok: false, error: failure };
    }

    // Finalize citations strictly against this request's retrieval map, then persist completion.
    const parsed = finalizeCitations(fullText, retrievals);
    for (const citation of parsed.citations) {
      persistParsedCitations(this.deps.db, {
        projectId: input.projectId,
        messageId: assistantId,
        parsed: { citations: [citation], hasInvalidCitations: false, content: fullText },
        retrievals
      });
    }
    const completed = repo.completeAssistantMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      id: assistantId,
      content: fullText,
      usage: usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      completionReason: finishReason,
      updatedAt: now().toISOString()
    });
    emit({ type: "completed", messageId: completed.id, message: completed });
    return { ok: true, value: { requestId: "", assistantMessageId: completed.id } };
  }
}

export async function sendChatMessage(deps: ChatSendDeps, input: SendInput, emit: (event: StreamEvent) => void): Promise<Result<{ requestId: string; assistantMessageId: string }>> {
  return new ChatService(deps).send(input, emit);
}
