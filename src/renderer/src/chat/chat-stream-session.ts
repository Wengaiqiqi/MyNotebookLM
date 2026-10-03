import { appErrorCodeSchema, type AppErrorDto } from "../../../shared/app-errors";
import type { MessageDto } from "../../../shared/chat";
import type { ChatRequestEvent, DesktopApi } from "../../../shared/ipc";

export type ChatStreamState = "idle" | "streaming" | "failed" | "cancelled";
type ChatApi = DesktopApi["chat"];
type SendResult = Awaited<ReturnType<ChatApi["send"]>>;
type ThinkingOptions = { thinking?: "off" | "low" | "medium" | "high" };

interface ChatStreamSnapshot {
  messages: MessageDto[];
  streamingMessageId: string | null;
  repairableMessageId: string | null;
  continuableMessageId: string | null;
  state: ChatStreamState;
  error: AppErrorDto | null;
  fallback: Extract<ChatRequestEvent, { type: "fallback" }> | null;
  canSend: boolean;
}

interface LiveTurn {
  requestId: string;
  messageId?: string;
  optimisticUserId?: string;
  continuation?: boolean;
  accepted: boolean;
  unsubscribe?: () => void;
}

/** Owns a conversation's IPC subscription until its terminal event, across view changes. */
class ChatStreamSession {
  private snapshot: ChatStreamSnapshot;
  private readonly listeners = new Set<() => void>();
  private turn: LiveTurn | null = null;

  constructor(private readonly chat: ChatApi, private readonly projectId: string, private readonly conversationId: string, messages: MessageDto[]) {
    this.snapshot = {
      messages: messages.filter((message) => message.conversationId === conversationId),
      streamingMessageId: null, repairableMessageId: null, continuableMessageId: null,
      state: "idle", error: null, fallback: null, canSend: true
    };
  }

  getSnapshot = (): ChatStreamSnapshot => this.snapshot;

  // React subscribers only observe state. Removing a view never removes the IPC sink.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<ChatStreamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  restore(messages: MessageDto[]): void {
    if (this.turn || messages.some((message) => message.conversationId !== this.conversationId)) return;
    // A transcript read started before completion can return an older streaming row.
    this.update({ messages: messages.map((message) => {
      const current = this.snapshot.messages.find((item) => item.id === message.id);
      return message.state === "streaming" && current && current.state !== "streaming" ? current : message;
    }) });
  }

  private updateMessages(update: (messages: MessageDto[]) => MessageDto[]): void {
    this.update({ messages: update(this.snapshot.messages) });
  }

  private upsert(message: MessageDto): void {
    this.updateMessages((messages) => messages.some((item) => item.id === message.id)
      ? messages.map((item) => item.id === message.id ? message : item)
      : [...messages, message]);
  }

  private addAssistantDraft(messageId: string): void {
    if (this.snapshot.messages.some((message) => message.id === messageId)) return;
    const now = new Date().toISOString();
    this.upsert({
      id: messageId, conversationId: this.conversationId, sequence: (this.snapshot.messages.at(-1)?.sequence ?? 0) + 1,
      role: "assistant", content: "", state: "streaming", replyToMessageId: null, supersedesMessageId: null,
      superseded: false, provider: null, profileId: null, model: null, usage: null, errorCode: null,
      completionReason: null, createdAt: now, updatedAt: now, citations: []
    });
  }

  private reconcileTerminal(turn: LiveTurn, assistant: MessageDto): void {
    this.updateMessages((messages) => {
      const persistedUserId = assistant.replyToMessageId;
      const alreadyPersisted = persistedUserId !== null && messages.some((message) => message.id === persistedUserId);
      const reconciled = messages.flatMap((message) => {
        if (message.id === assistant.id) return [assistant];
        if (message.id !== turn.optimisticUserId) return [message];
        if (alreadyPersisted) return [];
        return [{ ...message, id: persistedUserId ?? message.id, sequence: Math.max(0, assistant.sequence - 1) }];
      });
      return reconciled.some((message) => message.id === assistant.id) ? reconciled : [...reconciled, assistant];
    });
  }

  private applyEvent(turn: LiveTurn, event: ChatRequestEvent): void {
    switch (event.type) {
      case "started":
        if (event.message) this.upsert(event.message);
        break;
      case "text-delta":
        this.updateMessages((messages) => messages.map((message) => {
          if (message.id !== event.messageId) return message;
          // Replayed fragments and gaps are reconciled by the terminal message.
          if (event.offset !== undefined && event.offset !== message.content.length) return message;
          return { ...message, content: message.content + event.text };
        }));
        break;
      case "completed":
        this.reconcileTerminal(turn, event.message);
        this.update({ state: "idle", error: null, repairableMessageId: null, continuableMessageId: null });
        break;
      case "cancelled":
        this.reconcileTerminal(turn, event.message);
        this.update({
          state: "idle",
          repairableMessageId: event.operation === "continue" ? null : event.message.id,
          continuableMessageId: event.operation === "continue" && event.message.generation?.canContinue ? event.message.id : null
        });
        break;
      case "failed": {
        if (event.message) this.reconcileTerminal(turn, event.message);
        const code = appErrorCodeSchema.safeParse(event.error.code);
        const error = { ...event.error, code: code.success ? code.data : "INTERNAL" as const };
        if (event.operation === "continue" && event.message) {
          this.update({
            state: "idle", error, repairableMessageId: null,
            continuableMessageId: event.message.generation?.canContinue ? event.message.id : null
          });
        } else {
          this.updateMessages((messages) => messages.map((message) => message.id === event.messageId
            ? { ...message, state: "failed", errorCode: event.error.code, completionReason: null } : message));
          this.update({ state: "failed", error, repairableMessageId: event.messageId, continuableMessageId: null });
        }
        break;
      }
      case "fallback":
        this.update({ fallback: event });
        break;
    }
  }

  private finish(turn: LiveTurn): void {
    if (this.turn !== turn) return;
    turn.unsubscribe?.();
    this.turn = null;
    this.update({ streamingMessageId: null, canSend: true });
  }

  private async runTurn(invoke: (requestId: string) => Promise<SendResult>, options: {
    continuation?: boolean;
    optimisticUserId?: string;
    onAccepted?: () => void;
  } = {}): Promise<boolean> {
    if (this.turn) return false;
    let turn: LiveTurn | null = null;
    try {
      const current: LiveTurn = { requestId: crypto.randomUUID(), accepted: false, ...options };
      turn = current;
      this.turn = current;
      this.update({ state: "streaming", canSend: false, error: null, fallback: null, repairableMessageId: null, continuableMessageId: null });
      const accept = (): void => {
        if (current.accepted) return;
        current.accepted = true;
        options.onAccepted?.();
      };
      current.unsubscribe = this.chat.subscribe(current.requestId, (event) => {
        if (this.turn !== current || event.requestId !== current.requestId) return;
        if ("messageId" in event) current.messageId = event.messageId;
        if (event.type === "text-delta" || event.type === "started") {
          accept();
          this.update({ streamingMessageId: event.messageId });
          this.addAssistantDraft(event.messageId);
        }
        this.applyEvent(current, event);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") this.finish(current);
      });
      const result = await invoke(current.requestId);
      if (!result.ok) {
        // Main may have delivered the terminal event before invoke resolves.
        if (this.turn === current) {
          if (!current.accepted && current.optimisticUserId) {
            this.updateMessages((messages) => messages.filter((message) => message.id !== current.optimisticUserId));
          }
          this.finish(current);
          this.update({ state: "failed", error: result.error });
        }
        return false;
      }
      // A newer turn may already own this session while an older invoke returns.
      if (this.turn !== current) return true;
      if (result.value.requestId !== current.requestId) {
        this.finish(current);
        this.update({ state: "idle" });
        return false;
      }
      accept();
      current.messageId = result.value.assistantMessageId;
      this.update({ streamingMessageId: current.messageId });
      this.addAssistantDraft(current.messageId);
      return true;
    } catch {
      if (!turn || this.turn === turn) {
        if (turn) this.finish(turn);
        this.update({ state: "failed", error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } });
      }
      return false;
    }
  }

  send(question: string, generationProfileId?: string, options?: ThinkingOptions): Promise<boolean> {
    if (this.turn) return Promise.resolve(false);
    const now = new Date().toISOString();
    const localUser: MessageDto = {
      id: "local-user-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      conversationId: this.conversationId, sequence: Number.MAX_SAFE_INTEGER, role: "user", content: question,
      state: "completed", replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: null,
      profileId: null, model: null, usage: null, errorCode: null, completionReason: null, createdAt: now, updatedAt: now, citations: []
    };
    this.upsert(localUser);
    return this.runTurn((requestId) => this.chat.send({
      requestId, projectId: this.projectId, conversationId: this.conversationId, question,
      ...(generationProfileId ? { generationProfileId } : {}), ...(options?.thinking ? { thinking: options.thinking } : {})
    }), { optimisticUserId: localUser.id });
  }

  regenerate(messageId: string, options?: ThinkingOptions & { question?: string }): Promise<boolean> {
    return this.runTurn((requestId) => this.chat.regenerate({
      requestId, projectId: this.projectId, conversationId: this.conversationId, messageId,
      ...(options?.question ? { question: options.question } : {}), ...(options?.thinking ? { thinking: options.thinking } : {})
    }), { onAccepted: () => {
      if (!options?.question) return;
      const userId = this.snapshot.messages.find((message) => message.id === messageId)?.replyToMessageId;
      this.updateMessages((messages) => messages.map((message) => message.id === userId ? { ...message, content: options.question! } : message));
    } });
  }

  stop = async (): Promise<boolean> => {
    const current = this.turn;
    if (!current) return false;
    this.update({ state: current.continuation ? "streaming" : "cancelled", streamingMessageId: null });
    if (!current.continuation && current.messageId) {
      this.updateMessages((messages) => messages.map((message) => message.id === current.messageId
        ? { ...message, state: "cancelled", completionReason: "user_abort" } : message));
    }
    const result = await this.chat.stop({ projectId: this.projectId, requestId: current.requestId });
    const stopped = result.ok ? result.value : false;
    if (!stopped && this.turn === current) {
      this.update({ state: "streaming", streamingMessageId: current.messageId ?? null });
      this.updateMessages((messages) => messages.map((message) => message.id === current.messageId
        ? { ...message, state: "streaming", completionReason: null } : message));
    }
    return stopped;
  };

  continueGeneration = (messageId: string, expectedRevision: number): Promise<boolean> => this.runTurn(
    (requestId) => this.chat.continue({ requestId, projectId: this.projectId, conversationId: this.conversationId, messageId, expectedRevision }),
    { continuation: true }
  );

  repair = (options?: ThinkingOptions): Promise<boolean> => {
    const { repairableMessageId, continuableMessageId, messages } = this.snapshot;
    if (repairableMessageId) return this.regenerate(repairableMessageId, options);
    const message = messages.find((item) => item.id === continuableMessageId);
    return message?.generation ? this.continueGeneration(message.id, message.generation.revision) : Promise.resolve(false);
  };
}

// The preload API lives for the renderer's lifetime; sessions are scoped to it and
// to both ownership IDs so mounting another view cannot replace a live request.
const sessions = new WeakMap<ChatApi, Map<string, ChatStreamSession>>();

export function getChatStreamSession(chat: ChatApi, projectId: string, conversationId: string, messages: MessageDto[] = []): ChatStreamSession {
  let byConversation = sessions.get(chat);
  if (!byConversation) {
    byConversation = new Map();
    sessions.set(chat, byConversation);
  }
  const key = JSON.stringify([projectId, conversationId]);
  let session = byConversation.get(key);
  if (!session) {
    session = new ChatStreamSession(chat, projectId, conversationId, messages);
    byConversation.set(key, session);
  }
  return session;
}
