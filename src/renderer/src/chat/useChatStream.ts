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
  canSend: boolean;
  send(question: string): Promise<boolean>;
  stop(): Promise<boolean>;
  regenerate(messageId: string): Promise<boolean>;
  repair(): Promise<boolean>;
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
  restoredMessages: MessageDto[] = []
): UseChatStreamResult {
  const [messages, setMessages] = useState<MessageDto[]>(restoredMessages);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [state, setState] = useState<ChatStreamState>("idle");
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [repairableMessageId, setRepairableMessageId] = useState<string | null>(null);
  // Live turn info in a ref so the event sink never goes stale mid-stream.
  const turnRef = useRef<{ requestId: string } | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const prevConversationRef = useRef(conversationId);

  // Restart hydration: replace transcript when conversation switches or restored
  // history arrives. A fresh-but-empty array identity (e.g. default param) must
  // not wipe an in-flight draft.
  useEffect(() => {
    if (prevConversationRef.current !== conversationId) {
      prevConversationRef.current = conversationId;
      setMessages(restoredMessages);
      return;
    }
    if (restoredMessages.length > 0 && !turnRef.current) {
      setMessages(restoredMessages);
    }
  }, [conversationId, restoredMessages]);

  const teardown = useCallback((): void => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnRef.current = null;
    setStreamingMessageId(null);
  }, []);

  const applyEvent = useCallback((event: ChatRequestEvent): void => {
    switch (event.type) {
      case "text-delta":
        setMessages((prev) => prev.map((m) => (m.id === event.messageId ? { ...m, content: m.content + event.text } : m)));
        break;
      case "completed":
        setMessages((prev) => prev.map((m) => (m.id === event.message.id ? event.message : m)));
        setState("idle");
        setError(null);
        setRepairableMessageId(null);
        break;
      case "cancelled":
        setMessages((prev) => prev.map((m) => (m.id === event.message.id ? event.message : m)));
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
      default:
        break;
    }
  }, []);

  /** Run one IPC call, then subscribe to its requestId-scoped stream. */
  const runTurn = useCallback(async (invoke: () => Promise<SendResult>): Promise<boolean> => {
    if (turnRef.current) return false; // one live turn at a time
    try {
      const result = await invoke();
      if (!result.ok) {
        setState("failed");
        setError(result.error);
        return false;
      }
      const draftId = result.value.assistantMessageId;
      // Optimistic streaming draft row; the authoritative copy arrives with the
      // terminal event. Without it there is nowhere to splice live deltas.
      if (draftId !== "") {
        setMessages((prev) => prev.some((m) => m.id === draftId) ? prev : [
          ...prev,
          {
            id: draftId,
            conversationId,
            sequence: (prev.at(-1)?.sequence ?? 0) + 1,
            role: "assistant",
            content: "",
            state: "streaming",
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
          }
        ]);
      }
      if (result.value.requestId === "") {
        // Synchronous stream finished inside the invoke; nothing to subscribe to.
        return true;
      }
      const sink = (event: ChatRequestEvent): void => {
        if (!turnRef.current || event.requestId !== turnRef.current.requestId) return;
        applyEvent(event);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") teardown();
      };
      unsubscribeRef.current = chat.subscribe(result.value.requestId, sink);
      turnRef.current = { requestId: result.value.requestId };
      setStreamingMessageId(result.value.assistantMessageId);
      setState("streaming");
      return true;
    } catch {
      teardown();
      return false;
    }
  }, [chat, applyEvent, teardown, conversationId]);

  const send = useCallback((question: string): Promise<boolean> => {
    setError(null);
    setRepairableMessageId(null);
    // Main persists the user message with the assistant draft; delta events drive
    // the visible draft so no optimistic assistant row is invented here.
    return runTurn(() => chat.send({ projectId, conversationId, question }));
  }, [runTurn, chat, projectId, conversationId]);

  const regenerate = useCallback((messageId: string): Promise<boolean> => {
    setError(null);
    return runTurn(() => chat.regenerate({ projectId, conversationId, messageId }));
  }, [runTurn, chat, projectId, conversationId]);

  const stop = useCallback(async (): Promise<boolean> => {
    const current = turnRef.current;
    if (!current) return false;
    const result = await chat.stop({ projectId, requestId: current.requestId });
    return result.ok ? result.value : false;
  }, [chat, projectId]);

  const repair = useCallback((): Promise<boolean> => {
    const target = repairableMessageId;
    return target ? regenerate(target) : Promise.resolve(false);
  }, [regenerate, repairableMessageId]);

  // Unmount cleanup: drop subscription so late provider events are ignored.
  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnRef.current = null;
  }, []);

  const canSend = state === "idle" && !turnRef.current;
  return useMemo(() => ({
    messages,
    streamingMessageId,
    repairableMessageId,
    state,
    error,
    canSend,
    send,
    stop,
    regenerate,
    repair
  }), [messages, streamingMessageId, repairableMessageId, state, error, canSend, send, stop, regenerate, repair]);
}
