import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AppErrorDto } from "../../../shared/app-errors";
import type { MessageDto } from "../../../shared/chat";
import type { ChatRequestEvent, DesktopApi } from "../../../shared/ipc";
import { getChatStreamSession, type ChatStreamState } from "./chat-stream-session";

export type { ChatStreamState } from "./chat-stream-session";
type ChatApi = DesktopApi["chat"];

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

/** Observes the selected conversation; its stream continues independently of this view. */
export function useChatStream(
  chat: ChatApi,
  projectId: string,
  conversationId: string,
  restoredMessages: MessageDto[] = [],
  generationProfileId?: string
): UseChatStreamResult {
  const session = useMemo(() => getChatStreamSession(chat, projectId, conversationId, restoredMessages), [chat, projectId, conversationId]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const restoredRef = useRef({ session, messages: restoredMessages });

  useEffect(() => {
    const previous = restoredRef.current;
    restoredRef.current = { session, messages: restoredMessages };
    // On a switch, the parent still holds the previous conversation's transcript
    // until its async read finishes. Keep the new session's own snapshot meanwhile.
    if (previous.session !== session || previous.messages === restoredMessages
      || (previous.messages.length === 0 && restoredMessages.length === 0)) return;
    session.restore(restoredMessages);
  }, [session, restoredMessages]);

  const send = useCallback<UseChatStreamResult["send"]>((question, options) => {
    // The first question may create a conversation before the selected ID updates.
    const target = options?.conversationId
      ? getChatStreamSession(chat, projectId, options.conversationId)
      : session;
    return target.send(question, generationProfileId, options);
  }, [chat, projectId, session, generationProfileId]);
  const regenerate = useCallback<UseChatStreamResult["regenerate"]>((messageId, options) => session.regenerate(messageId, options), [session]);

  return useMemo(() => ({
    ...snapshot, send, regenerate, stop: session.stop, repair: session.repair, continueGeneration: session.continueGeneration
  }), [snapshot, send, regenerate, session]);
}
