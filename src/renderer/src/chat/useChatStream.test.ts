// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequestEvent, DesktopApi } from "../../../shared/ipc";
import type { MessageDto } from "../../../shared/chat";
import { messageStateSchema } from "../../../shared/chat";
import { useChatStream } from "./useChatStream";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "msg-1";

function makeMessage(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sequence: 2,
    role: "assistant",
    content: "",
    state: messageStateSchema.parse("completed"),
    replyToMessageId: null,
    supersedesMessageId: null,
    superseded: false,
    provider: "openai",
    profileId: "p1",
    model: "gpt-test",
    usage: null,
    errorCode: null,
    completionReason: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    citations: [],
    ...overrides
  };
}

type Listener = (event: ChatRequestEvent) => void;

function makeOk(requestId: string, messageId: string) {
  return { ok: true as const, value: { requestId, assistantMessageId: messageId } };
}

function createApi() {
  const listeners = new Map<string, Set<Listener>>();
  const removeListener = vi.fn();
  const send = vi.fn<DesktopApi["chat"]["send"]>();
  const stop = vi.fn<DesktopApi["chat"]["stop"]>().mockResolvedValue({ ok: true as const, value: true });
  const regenerate = vi.fn<DesktopApi["chat"]["regenerate"]>();
  const subscribe = vi.fn((requestId: string, listener: Listener) => {
    const set = listeners.get(requestId) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(requestId, set);
    return () => {
      set.delete(listener);
      removeListener(requestId);
    };
  });
  const api = { chat: { send, stop, regenerate, subscribe } } as unknown as DesktopApi;
  return { api, listeners, removeListener, send, stop, regenerate, subscribe };
}

function emit(api: ReturnType<typeof createApi>, requestId: string, event: ChatRequestEvent): void {
  for (const listener of api.listeners.get(requestId) ?? []) listener(event);
}

async function emitAsync(api: ReturnType<typeof createApi>, requestId: string, event: ChatRequestEvent): Promise<void> {
  await act(async () => {
    emit(api, requestId, event);
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("crypto", { randomUUID: () => REQUEST_ID });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useChatStream", () => {
  it("optimistically shows the sent question as a user message right after send", async () => {
    const h = createApi();
    h.send.mockResolvedValue(makeOk(REQUEST_ID, MESSAGE_ID));
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));

    await act(async () => {
      await result.current.send("What does the report say?");
    });

    const users = result.current.messages.filter((m) => m.role === "user");
    expect(users.length).toBe(1);
    expect(users[0]?.content).toBe("What does the report say?");
    expect(result.current.messages.at(-1)?.role).toBe("assistant");

    // Terminal reconciliation drops the temporary user row once the persisted
    // transcript arrives via completed, keeping exactly one copy.
    await emitAsync(h, REQUEST_ID, { type: "completed", requestId: REQUEST_ID, messageId: MESSAGE_ID, message: makeMessage({}) });
    expect(result.current.messages.filter((m) => m.role === "user").length).toBe(0);
    expect(result.current.messages.length).toBe(1);
  });

  it("sends a question and renders live text deltas into streaming state", async () => {
    const h = createApi();
    h.send.mockResolvedValue({ ok: true as const, value: { requestId: REQUEST_ID, assistantMessageId: MESSAGE_ID } });
    const messagesBefore: MessageDto[] = [makeMessage({ id: "u1", sequence: 1, role: "user", content: "Q?", provider: null, profileId: null, model: null })];
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, messagesBefore));

    await act(async () => {
      await result.current.send("What does the report say?");
    });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, question: "What does the report say?", requestId: expect.any(String) }));
    expect(result.current.streamingMessageId).toBe(MESSAGE_ID);
    expect(result.current.messages.map((m) => m.content)).toEqual(["Q?", "What does the report say?", ""]);

    await emitAsync(h, REQUEST_ID, { type: "started", requestId: REQUEST_ID, messageId: MESSAGE_ID });
    await emitAsync(h, REQUEST_ID, { type: "text-delta", requestId: REQUEST_ID, messageId: MESSAGE_ID, text: "The repo" });
    await emitAsync(h, REQUEST_ID, { type: "text-delta", requestId: REQUEST_ID, messageId: MESSAGE_ID, text: "rt says yes." });
    expect(result.current.messages.at(-1)?.content).toBe("The report says yes.");
    expect(result.current.state).toBe("streaming");
    expect(result.current.error).toBeNull();

    await emitAsync(h, REQUEST_ID, { type: "completed", requestId: REQUEST_ID, messageId: MESSAGE_ID, message: makeMessage({ content: "The report says yes. [S1]" }) });
    expect(result.current.state).toBe("idle");
    expect(result.current.streamingMessageId).toBeNull();
    expect(result.current.messages.at(-1)?.state).toBe("completed");
    expect(result.current.messages.at(-1)?.content).toBe("The report says yes. [S1]");
  });

  it("stops an in-flight request and keeps partial text with cancelled state", async () => {
    const h = createApi();
    h.send.mockResolvedValue({ ok: true as const, value: { requestId: REQUEST_ID, assistantMessageId: MESSAGE_ID } });
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    await act(async () => { await result.current.send("q"); });
    await emitAsync(h, REQUEST_ID, { type: "text-delta", requestId: REQUEST_ID, messageId: MESSAGE_ID, text: "partial answer kept" });

    let stopResult: boolean | undefined;
    await act(async () => { stopResult = await result.current.stop(); });
    expect(h.stop).toHaveBeenCalledWith({ projectId: PROJECT_ID, requestId: REQUEST_ID });
    expect(stopResult).toBe(true);

    // Terminal cancelled event reconciles the draft and closes the stream.
    await emitAsync(h, REQUEST_ID, {
      type: "cancelled",
      requestId: REQUEST_ID,
      messageId: MESSAGE_ID,
      message: makeMessage({ state: "cancelled", content: "partial answer kept" })
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.messages.at(-1)?.state).toBe("cancelled");
    expect(result.current.messages.at(-1)?.content).toBe("partial answer kept");
  });

  it("surfaces a failed stream with a repair action that regenerates the same turn", async () => {
    const h = createApi();
    h.send.mockResolvedValueOnce(makeOk(REQUEST_ID, MESSAGE_ID));
    // Repair routes through chat.regenerate, not a second send.
    h.regenerate.mockResolvedValueOnce(makeOk(REQUEST_ID, MESSAGE_ID));
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    await act(async () => { await result.current.send("q"); });
    await emitAsync(h, REQUEST_ID, { type: "text-delta", requestId: REQUEST_ID, messageId: MESSAGE_ID, text: "half written" });
    await emitAsync(h, REQUEST_ID, { type: "failed", requestId: REQUEST_ID, messageId: MESSAGE_ID, error: { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: true } });

    expect(result.current.state).toBe("failed");
    expect(result.current.repairableMessageId).toBe(MESSAGE_ID);
    expect(result.current.error?.code).toBe("PROVIDER");
    expect(result.current.messages.at(-1)?.content).toBe("half written");

    await act(async () => { await result.current.repair(); });
    expect(h.regenerate).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, requestId: expect.any(String) }));
    expect(result.current.state).toBe("streaming");
    expect(result.current.error).toBeNull();
  });

  it("hydrates restored conversation history on restart without re-sending", async () => {
    const h = createApi();
    const history = [
      makeMessage({ id: "u1", sequence: 1, role: "user", content: "older q", provider: null, profileId: null, model: null }),
      makeMessage({ id: "a1", sequence: 2, content: "older a" }),
      makeMessage({ id: "u2", sequence: 3, role: "user", content: "newer q", provider: null, profileId: null, model: null }),
      makeMessage({ id: "a2", sequence: 4, content: "newer a", citations: [{
        id: "a2:S1:9", label: "S1", sourceId: PROJECT_ID, sourceChunkId: "c", sourceDisplayName: "Doc", sourceKind: "pdf", locator: { kind: "page", page: 1, start: 9 }
      }] })
    ];
    const { result, rerender } = renderHook(
      ({ messages }: { messages: MessageDto[] }) => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, messages),
      { initialProps: { messages: [] as MessageDto[] } }
    );
    rerender({ messages: history });
    expect(result.current.messages).toEqual(history);
    expect(h.send).not.toHaveBeenCalled();
    expect(result.current.canSend).toBe(true);
  });

  it("regenerates from a completed assistant reply without duplicating the user message", async () => {
    const h = createApi();
    h.regenerate.mockResolvedValue({ ok: true as const, value: { requestId: REQUEST_ID, assistantMessageId: MESSAGE_ID } });
    const withHistory = [makeMessage({ id: "u1", sequence: 1, role: "user", content: "q", provider: null, profileId: null, model: null })];
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, withHistory));

    await act(async () => { await result.current.regenerate("a1"); });
    expect(h.regenerate).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, messageId: "a1", requestId: expect.any(String) }));
    expect(result.current.streamingMessageId).toBe(MESSAGE_ID);
    // Only the historical user message exists; no duplicate user row was appended.
    expect(result.current.messages.filter((m) => m.role === "user").length).toBe(1);
  });

  it("subscribes before a pending send, receives deltas, and can stop it", async () => {
    const h = createApi();
    let release!: (value: ReturnType<typeof makeOk>) => void;
    const gate = new Promise<ReturnType<typeof makeOk>>((resolve) => { release = resolve; });
    h.send.mockReturnValue(gate);
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.send("q");
      await Promise.resolve();
    });
    const requestId = (h.send.mock.calls[0]?.[0] as { requestId: string }).requestId;
    expect(requestId).toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/);
    expect(h.subscribe).toHaveBeenCalledWith(requestId, expect.any(Function));
    await emitAsync(h, requestId, { type: "started", requestId, messageId: MESSAGE_ID });
    await emitAsync(h, requestId, { type: "text-delta", requestId, messageId: MESSAGE_ID, text: "live" });
    expect(result.current.messages.at(-1)?.content).toBe("live");
    await act(async () => { await expect(result.current.stop()).resolves.toBe(true); });
    expect(h.stop).toHaveBeenCalledWith({ projectId: PROJECT_ID, requestId });
    release(makeOk(requestId, MESSAGE_ID));
    await act(async () => { await sendPromise; });
  });

  it("does not return to streaming when terminal arrives before invoke resolves", async () => {
    const h = createApi();
    let release!: (value: ReturnType<typeof makeOk>) => void;
    h.send.mockReturnValue(new Promise<ReturnType<typeof makeOk>>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.send("q");
      await Promise.resolve();
    });
    const requestId = (h.send.mock.calls[0]?.[0] as { requestId: string }).requestId;
    await emitAsync(h, requestId, { type: "started", requestId, messageId: MESSAGE_ID });
    await emitAsync(h, requestId, { type: "completed", requestId, messageId: MESSAGE_ID, message: makeMessage({ content: "done" }) });
    expect(result.current.state).toBe("idle");
    release(makeOk(requestId, MESSAGE_ID));
    await act(async () => { await sendPromise; });
    expect(result.current.state).toBe("idle");
    expect(result.current.streamingMessageId).toBeNull();
  });

  it("ignores events for other request ids while streaming", async () => {
    const h = createApi();
    h.send.mockResolvedValue({ ok: true as const, value: { requestId: REQUEST_ID, assistantMessageId: MESSAGE_ID } });
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    await act(async () => { await result.current.send("q"); });

    await emitAsync(h, "44444444-4444-4444-8444-444444444444", { type: "text-delta", requestId: "44444444-4444-4444-8444-444444444444", messageId: MESSAGE_ID, text: "foreign" });
    expect(result.current.messages.every((m) => m.content !== "foreign")).toBe(true);
  });

  it("maps send failure results to error state without inventing an assistant draft", async () => {
    const h = createApi();
    h.send.mockResolvedValue({ ok: false as const, error: { code: "CONFLICT", messageKey: "errors.chatSendInFlight", recoverable: true } });
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    await act(async () => {
      const ok = await result.current.send("q");
      expect(ok).toBe(false);
    });
    expect(result.current.state).toBe("failed");
    expect(result.current.error?.code).toBe("CONFLICT");
    expect(result.current.messages.filter((m) => m.role === "assistant").length).toBe(0);
  });

  it("maps an unexpected IPC throw to failed state with an error instead of staying silent", async () => {
    const h = createApi();
    h.send.mockRejectedValue(new Error("ipc bridge crashed"));
    const { result } = renderHook(() => useChatStream(h.api.chat, PROJECT_ID, CONVERSATION_ID, []));
    await act(async () => {
      const ok = await result.current.send("q");
      expect(ok).toBe(false);
    });
    expect(result.current.state).toBe("failed");
    expect(result.current.error).not.toBeNull();
  });
});
