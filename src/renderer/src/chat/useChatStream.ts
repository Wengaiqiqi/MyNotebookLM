import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appErrorCodeSchema, type AppErrorDto } from "../../../shared/app-errors";
import type { MessageDto } from "../../../shared/chat";
import type { ChatRequestEvent, DesktopApi } from "../../../shared/ipc";

export type ChatStreamState = "idle" | "streaming" | "failed" | "cancelled";

type ChatApi = DesktopApi["chat"];
type SendResult = Awaited<ReturnType<ChatApi["send"]>>;

export interface UseChatStreamResult {
  messages: MessageDto[];
  streamingMessageId: string | null;
  /** Id of a failed/cancelled assistant draft that can be repaired via regenerate. */
  repairableMessageId: string | null;
  state: ChatStreamState;
  error: AppErrorDto | null;
  fallback: Extract<ChatRequestEvent, { type: "fallback" }> | null;
  canSend: boolean;
  send(question: string, options?: { thinking?: "off" | "low" | "medium" | "high"; conversationId?: string }): Promise<boolean>;
  stop(): Promise<boolean>;
  regenerate(messageId: string, options?: { thinking?: "off" | "low" | "medium" | "high"; question?: string }): Promise<boolean>;
  repair(options?: { thinking?: "off" | "low" | "medium" | "high" }): Promise<boolean>;
}

/**
 * Renderer chat state machine over the Task 6 IPC stream. Main owns persisted
 * rows; this hook keeps the optimistic transcript and live deltas. Every turn
 * subscribes as soon as main returns the requestId and tears the subscription
 * down on terminal event or unmount, so late/foreign events stay inert.
 */
export function useChatStream(
  chat: ChatApi,
  projectId: string,
  conversationId: string,
  restoredMessages: MessageDto[] = [],
  generationProfileId?: string
): UseChatStreamResult {
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, MessageDto[]>>({
    [conversationId]: restoredMessages
  });
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [state, setState] = useState<ChatStreamState>("idle");
  const [statusConversationId, setStatusConversationId] = useState(conversationId);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [fallback, setFallback] = useState<Extract<ChatRequestEvent, { type: "fallback" }> | null>(null);
  const [repairableMessageId, setRepairableMessageId] = useState<string | null>(null);
  // Optimistic user rows are keyed by request id so the completed reconciliation
  // can drop them once the persisted transcript arrives, preventing duplicates.
  const optimisticUserRef = useRef<Map<string, string>>(new Map());
  // Live turn info in a ref so the event sink never goes stale mid-stream.
  const turnRef = useRef<{ requestId: string; conversationId: string; messageId?: string } | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const prevConversationRef = useRef(conversationId);
  const restoredRef = useRef(new Map([[conversationId, restoredMessages]]));

  const updateMessages = useCallback((targetConversationId: string, update: (messages: MessageDto[]) => MessageDto[]): void => {
    setMessagesByConversation((current) => ({
      ...current,
      [targetConversationId]: update(current[targetConversationId] ?? [])
    }));
  }, []);

  // Each conversation keeps its own live transcript, so switching views cannot
  // redirect an older request's deltas into the newly selected conversation.
  useEffect(() => {
    if (prevConversationRef.current !== conversationId) {
      prevConversationRef.current = conversationId;
      restoredRef.current.set(conversationId, restoredMessages);
      setMessagesByConversation((current) => conversationId in current ? current : { ...current, [conversationId]: [] });
      return;
    }
    const previous = restoredRef.current.get(conversationId);
    if (previous === restoredMessages || (previous?.length === 0 && restoredMessages.length === 0)) return;
    restoredRef.current.set(conversationId, restoredMessages);
    if (turnRef.current?.conversationId !== conversationId) {
      setMessagesByConversation((current) => ({ ...current, [conversationId]: restoredMessages }));
    }
  }, [conversationId, restoredMessages]);

  const teardown = useCallback((): void => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnRef.current = null;
    setStreamingMessageId(null);
  }, []);

  const applyEvent = useCallback((targetConversationId: string, event: ChatRequestEvent): void => {
    const reconcileTerminal = (requestId: string, assistant: MessageDto): void => {
      updateMessages(targetConversationId, (prev) => {
        const optimisticUserId = optimisticUserRef.current.get(requestId);
        const persistedUserId = assistant.replyToMessageId;
        const alreadyPersisted = persistedUserId !== null && prev.some((message) => message.id === persistedUserId);
        optimisticUserRef.current.delete(requestId);
        return prev.flatMap((message) => {
          if (message.id === assistant.id) return [assistant];
          if (message.id !== optimisticUserId) return [message];
          if (alreadyPersisted) return [];
          return [{ ...message, id: persistedUserId ?? message.id, sequence: Math.max(0, assistant.sequence - 1) }];
        });
      });
    };
    switch (event.type) {
      case "text-delta":
        updateMessages(targetConversationId, (prev) => prev.map((m) => (m.id === event.messageId ? { ...m, content: m.content + event.text } : m)));
        break;
      case "completed":
        reconcileTerminal(event.requestId, event.message);
        setState("idle");
        setError(null);
        setRepairableMessageId(null);
        break;
      case "cancelled":
        reconcileTerminal(event.requestId, event.message);
        setState("idle");
        setRepairableMessageId(event.message.id);
        break;
      case "failed":
        setState("failed");
        {
          // Main may report a transport-level code string; normalize it into
          // the renderer AppErrorDto vocabulary without inventing codes.
          const code = appErrorCodeSchema.safeParse(event.error.code);
          setError({
            code: code.success ? code.data : "INTERNAL",
            messageKey: event.error.messageKey,
            recoverable: event.error.recoverable
          });
        }
        setRepairableMessageId(event.messageId);
        break;
      case "fallback":
        setFallback(event);
        break;
      default:
        break;
    }
  }, [updateMessages]);

  const addAssistantDraft = useCallback((targetConversationId: string, messageId: string): void => {
    updateMessages(targetConversationId, (prev) => prev.some((message) => message.id === messageId) ? prev : [...prev, {
      id: messageId, conversationId: targetConversationId, sequence: (prev.at(-1)?.sequence ?? 0) + 1, role: "assistant", content: "", state: "streaming", replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: null, profileId: null, model: null, usage: null, errorCode: null, completionReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), citations: []
    }]);
  }, [updateMessages]);

  /** Run one IPC call, then subscribe to its requestId-scoped stream. */
  const runTurn = useCallback(async (targetConversationId: string, invoke: (requestId: string) => Promise<SendResult>): Promise<boolean> => {
    if (turnRef.current) return false; // one live turn at a time
    try {
      const requestId = crypto.randomUUID();
      turnRef.current = { requestId, conversationId: targetConversationId };
      setStatusConversationId(targetConversationId);
      const sink = (event: ChatRequestEvent): void => {
        if (!turnRef.current || event.requestId !== turnRef.current.requestId) return;
        if ("messageId" in event) turnRef.current.messageId = event.messageId;
        if (event.type === "text-delta" || event.type === "started") {
          setStreamingMessageId(event.messageId);
          addAssistantDraft(targetConversationId, event.messageId);
        }
        applyEvent(targetConversationId, event);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") teardown();
      };
      unsubscribeRef.current = chat.subscribe(requestId, sink);
      setState("streaming");
      const result = await invoke(requestId);
      if (!result.ok) { teardown(); setState("failed"); setError(result.error); return false; }
      if (result.value.requestId !== requestId) { teardown(); return false; }
      if (!turnRef.current) return true;
      const draftId = result.value.assistantMessageId;
      turnRef.current.messageId = draftId;
      setStreamingMessageId(draftId);
      addAssistantDraft(targetConversationId, draftId);
      return true;
    } catch {
      teardown();
      setState("failed");
      setError({
        code: "INTERNAL",
        messageKey: "errors.internal",
        recoverable: true
      });
      return false;
    }
  }, [chat, addAssistantDraft, applyEvent, teardown]);

  const send = useCallback((question: string, options?: { thinking?: "off" | "low" | "medium" | "high"; conversationId?: string }): Promise<boolean> => {
    setError(null);
    setFallback(null);
    setRepairableMessageId(null);
    const targetConversationId = options?.conversationId ?? conversationId;
    const localUserMessage = {
      id: "local-user-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      conversationId: targetConversationId,
      sequence: Number.MAX_SAFE_INTEGER,
      role: "user" as const,
      content: question,
      state: "completed" as const,
      replyToMessageId: null,
      supersedesMessageId: null,
      superseded: false,
      provider: null,
      profileId: null,
      model: null,
      usage: null,
      errorCode: null,
      completionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      citations: []
    };
    updateMessages(targetConversationId, (prev) => [...prev, localUserMessage]);
    return runTurn(targetConversationId, (requestId) => {
      optimisticUserRef.current.set(requestId, localUserMessage.id);
      return chat.send({ requestId, projectId, conversationId: targetConversationId, question, ...(generationProfileId ? { generationProfileId } : {}), ...(options?.thinking ? { thinking: options.thinking } : {}) });
    });
  }, [runTurn, chat, projectId, conversationId, generationProfileId, updateMessages]);

  const regenerate = useCallback((messageId: string, options?: { thinking?: "off" | "low" | "medium" | "high"; question?: string }): Promise<boolean> => {
    setError(null);
    if (options?.question) {
      updateMessages(conversationId, (current) => {
        const userId = current.find((message) => message.id === messageId)?.replyToMessageId;
        return current.map((message) => message.id === userId ? { ...message, content: options.question! } : message);
      });
    }
    return runTurn(conversationId, (requestId) => chat.regenerate({ requestId, projectId, conversationId, messageId, ...(options?.question ? { question: options.question } : {}), ...(options?.thinking ? { thinking: options.thinking } : {}) }));
  }, [runTurn, chat, projectId, conversationId, updateMessages]);

  const stop = useCallback(async (): Promise<boolean> => {
    const current = turnRef.current;
    if (!current) return false;
    setState("cancelled");
    setStreamingMessageId(null);
    if (current.messageId) {
      updateMessages(current.conversationId, (prev) => prev.map((message) => message.id === current.messageId
        ? { ...message, state: "cancelled", completionReason: "user_abort" }
        : message));
    }
    const result = await chat.stop({ projectId, requestId: current.requestId });
    const stopped = result.ok ? result.value : false;
    if (!stopped && turnRef.current?.requestId === current.requestId) {
      setState("streaming");
      if (current.messageId) {
        setStreamingMessageId(current.messageId);
        updateMessages(current.conversationId, (prev) => prev.map((message) => message.id === current.messageId
          ? { ...message, state: "streaming", completionReason: null }
          : message));
      }
    }
    return stopped;
  }, [chat, projectId, updateMessages]);

  const repair = useCallback((options?: { thinking?: "off" | "low" | "medium" | "high" }): Promise<boolean> => {
    const target = repairableMessageId;
    return target ? regenerate(target, options) : Promise.resolve(false);
  }, [regenerate, repairableMessageId]);

  // Unmount cleanup: drop subscription so late provider events are ignored.
  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnRef.current = null;
  }, []);

  const ownsStatus = statusConversationId === conversationId;
  const visibleState = ownsStatus ? state : "idle";
  const canSend = !turnRef.current && (!ownsStatus || state === "idle");
  const messages = messagesByConversation[conversationId] ?? [];
  return useMemo(() => ({
    messages,
    streamingMessageId: ownsStatus ? streamingMessageId : null,
    repairableMessageId: ownsStatus ? repairableMessageId : null,
    state: visibleState,
    error: ownsStatus ? error : null,
    fallback: ownsStatus ? fallback : null,
    canSend,
    send,
    stop,
    regenerate,
    repair
  }), [messages, ownsStatus, streamingMessageId, repairableMessageId, visibleState, error, fallback, canSend, send, stop, regenerate, repair]);
}
