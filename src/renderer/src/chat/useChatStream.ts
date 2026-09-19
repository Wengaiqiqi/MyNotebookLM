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
  /** Id of an answer whose continuation was interrupted and can be continued again. */
  continuableMessageId: string | null;
  state: ChatStreamState;
  error: AppErrorDto | null;
  fallback: Extract<ChatRequestEvent, { type: "fallback" }> | null;
  canSend: boolean;
  send(question: string, options?: { thinking?: "off" | "low" | "medium" | "high"; conversationId?: string }): Promise<boolean>;
  stop(): Promise<boolean>;
  regenerate(messageId: string, options?: { thinking?: "off" | "low" | "medium" | "high"; question?: string }): Promise<boolean>;
  continueGeneration(messageId: string, expectedRevision: number): Promise<boolean>;
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
  const [continuableMessageId, setContinuableMessageId] = useState<string | null>(null);
  // Optimistic user rows are keyed by request id so the completed reconciliation
  // can drop them once the persisted transcript arrives, preventing duplicates.
  const optimisticUserRef = useRef<Map<string, string>>(new Map());
  // Live turn info in a ref so the event sink never goes stale mid-stream.
  const turnRef = useRef<{ requestId: string; conversationId: string; messageId?: string; continuation?: boolean } | null>(null);
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
    const requestId = turnRef.current?.requestId;
    if (requestId) optimisticUserRef.current.delete(requestId);
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnRef.current = null;
    setStreamingMessageId(null);
  }, []);

  const applyEvent = useCallback((targetConversationId: string, event: ChatRequestEvent): void => {
    const reconcileTerminal = (requestId: string, assistant: MessageDto): void => {
      // Capture before scheduling the state updater: a terminal event tears
      // down the subscription immediately, and teardown also clears stale
      // optimistic entries.
      const optimisticUserId = optimisticUserRef.current.get(requestId);
      optimisticUserRef.current.delete(requestId);
      updateMessages(targetConversationId, (prev) => {
        const persistedUserId = assistant.replyToMessageId;
        const alreadyPersisted = persistedUserId !== null && prev.some((message) => message.id === persistedUserId);
        return prev.flatMap((message) => {
          if (message.id === assistant.id) return [assistant];
          if (message.id !== optimisticUserId) return [message];
          if (alreadyPersisted) return [];
          return [{ ...message, id: persistedUserId ?? message.id, sequence: Math.max(0, assistant.sequence - 1) }];
        });
      });
    };
    const upsertStartedMessage = (message: MessageDto): void => {
      updateMessages(targetConversationId, (prev) => {
        const index = prev.findIndex((item) => item.id === message.id);
        if (index < 0) return [...prev, message];
        const next = [...prev];
        next[index] = message;
        return next;
      });
    };
    switch (event.type) {
      case "started":
        if (event.message) upsertStartedMessage(event.message);
        break;
      case "text-delta":
        updateMessages(targetConversationId, (prev) => prev.map((m) => {
          if (m.id !== event.messageId) return m;
          // offset guards against a replayed or out-of-order fragment being
          // appended twice; a gap is resolved by the terminal message instead.
          if (event.offset !== undefined) {
            if (event.offset === m.content.length) return { ...m, content: m.content + event.text };
            if (event.offset < m.content.length) return m;
            return m;
          }
          return { ...m, content: m.content + event.text };
        }));
        break;
      case "completed":
        reconcileTerminal(event.requestId, event.message);
        setState("idle");
        setError(null);
        setRepairableMessageId(null);
        setContinuableMessageId(null);
        break;
      case "cancelled":
        reconcileTerminal(event.requestId, event.message);
        setState("idle");
        // A continuation terminal event carries the completed answer, not a
        // broken draft: retrying it must continue, never regenerate.
        if (event.operation === "continue") {
          setRepairableMessageId(null);
          setContinuableMessageId(event.message.generation?.canContinue ? event.message.id : null);
        } else {
          setRepairableMessageId(event.message.id);
          setContinuableMessageId(null);
        }
        break;
      case "failed":
        if (event.operation === "continue" && event.message) {
          reconcileTerminal(event.requestId, event.message);
          setState("idle");
          setError({
            ...event.error,
            code: appErrorCodeSchema.safeParse(event.error.code).success
              ? appErrorCodeSchema.parse(event.error.code)
              : "INTERNAL",
            messageKey: event.error.messageKey,
            recoverable: event.error.recoverable
          });
          setRepairableMessageId(null);
          setContinuableMessageId(event.message.generation?.canContinue ? event.message.id : null);
          break;
        }
        if (event.message) reconcileTerminal(event.requestId, event.message);
        updateMessages(targetConversationId, (prev) => prev.map((message) => message.id === event.messageId
          ? { ...message, state: "failed", errorCode: event.error.code, completionReason: null }
          : message));
        setState("failed");
        {
          // Main may report a transport-level code string; normalize it into
          // the renderer AppErrorDto vocabulary without inventing codes.
          const code = appErrorCodeSchema.safeParse(event.error.code);
          setError({
            ...event.error,
            code: code.success ? code.data : "INTERNAL",
            messageKey: event.error.messageKey,
            recoverable: event.error.recoverable
          });
        }
        setRepairableMessageId(event.messageId);
        setContinuableMessageId(null);
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
  const runTurn = useCallback(async (targetConversationId: string, invoke: (requestId: string) => Promise<SendResult>, options?: { continuation?: boolean; onAccepted?: () => void }): Promise<boolean> => {
    if (turnRef.current) return false; // one live turn at a time
    try {
      const requestId = crypto.randomUUID();
      let accepted = false;
      const accept = (): void => { if (!accepted) { accepted = true; options?.onAccepted?.(); } };
      turnRef.current = { requestId, conversationId: targetConversationId, ...(options?.continuation ? { continuation: true } : {}) };
      setStatusConversationId(targetConversationId);
      const sink = (event: ChatRequestEvent): void => {
        if (!turnRef.current || event.requestId !== turnRef.current.requestId) return;
        if ("messageId" in event) turnRef.current.messageId = event.messageId;
        if (event.type === "text-delta" || event.type === "started") {
          accept();
          setStreamingMessageId(event.messageId);
          addAssistantDraft(targetConversationId, event.messageId);
        }
        applyEvent(targetConversationId, event);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") teardown();
      };
      unsubscribeRef.current = chat.subscribe(requestId, sink);
      setState("streaming");
      const result = await invoke(requestId);
      if (!result.ok) {
        // A terminal event may have been delivered before the IPC call
        // returned (notably continuation interruption). Preserve that
        // authoritative state instead of overwriting it with a generic error.
        if (turnRef.current?.requestId === requestId) {
          const optimisticId = optimisticUserRef.current.get(requestId);
          if (!accepted && optimisticId) updateMessages(targetConversationId, (items) => items.filter((item) => item.id !== optimisticId));
          teardown();
          setState("failed");
          setError(result.error);
        }
        return false;
      }
      if (result.value.requestId !== requestId) { teardown(); return false; }
      accept();
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
  }, [chat, addAssistantDraft, applyEvent, teardown, updateMessages]);

  const send = useCallback((question: string, options?: { thinking?: "off" | "low" | "medium" | "high"; conversationId?: string }): Promise<boolean> => {
    if (turnRef.current) return Promise.resolve(false);
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
    if (turnRef.current) return Promise.resolve(false);
    setError(null);
    const onAccepted = (): void => {
      if (!options?.question) return;
      updateMessages(conversationId, (current) => {
        const userId = current.find((message) => message.id === messageId)?.replyToMessageId;
        return current.map((message) => message.id === userId ? { ...message, content: options.question! } : message);
      });
    };
    return runTurn(conversationId, (requestId) => chat.regenerate({ requestId, projectId, conversationId, messageId, ...(options?.question ? { question: options.question } : {}), ...(options?.thinking ? { thinking: options.thinking } : {}) }), { onAccepted });
  }, [runTurn, chat, projectId, conversationId, updateMessages]);

  const stop = useCallback(async (): Promise<boolean> => {
    const current = turnRef.current;
    if (!current) return false;
    setState(current.continuation ? "streaming" : "cancelled");
    setStreamingMessageId(null);
    if (!current.continuation && current.messageId) {
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

  const continueGeneration = useCallback((messageId: string, expectedRevision: number): Promise<boolean> => {
    if (turnRef.current) return Promise.resolve(false);
    setError(null);
    return runTurn(conversationId, (requestId) => chat.continue({ requestId, projectId, conversationId, messageId, expectedRevision }), { continuation: true });
  }, [runTurn, chat, projectId, conversationId]);

  const repair = useCallback((options?: { thinking?: "off" | "low" | "medium" | "high" }): Promise<boolean> => {
    const target = repairableMessageId;
    if (target) return regenerate(target, options);
    // Interrupted continuations retry through the continue endpoint so the
    // existing answer is appended to instead of being superseded.
    const continuationTarget = continuableMessageId;
    if (!continuationTarget) return Promise.resolve(false);
    const message = (messagesByConversation[conversationId] ?? []).find((item) => item.id === continuationTarget);
    if (!message?.generation) return Promise.resolve(false);
    return continueGeneration(continuationTarget, message.generation.revision);
  }, [regenerate, repairableMessageId, continuableMessageId, messagesByConversation, conversationId, continueGeneration]);

  // Unmount cleanup: drop subscription so late provider events are ignored.
  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnRef.current = null;
  }, []);

  const ownsStatus = statusConversationId === conversationId;
  const visibleState = ownsStatus ? state : "idle";
  const canSend = !turnRef.current && (!ownsStatus || state !== "streaming");
  const messages = messagesByConversation[conversationId] ?? [];
  return useMemo(() => ({
    messages,
    streamingMessageId: ownsStatus ? streamingMessageId : null,
    repairableMessageId: ownsStatus ? repairableMessageId : null,
    continuableMessageId: ownsStatus ? continuableMessageId : null,
    state: visibleState,
    error: ownsStatus ? error : null,
    fallback: ownsStatus ? fallback : null,
    canSend,
    send,
    stop,
    regenerate,
    repair,
    continueGeneration
  }), [messages, ownsStatus, streamingMessageId, repairableMessageId, continuableMessageId, visibleState, error, fallback, canSend, send, stop, regenerate, repair, continueGeneration]);
}
