import { describe, expect, it, vi, afterEach } from "vitest";
import { CHAT_CHANNELS, CITATION_CHANNELS } from "../../shared/ipc";
import { registerChatHandlers } from "./register-chat-handlers";

type InvokeHandler = (event: unknown, input: unknown) => Promise<unknown>;
type SendHandler = (event: unknown, channel: string, value: unknown) => void;

class FakeWindow {
  static all: FakeWindow[] = [];
  destroyed = false;
  readonly sent: Array<{ channel: string; value: unknown }> = [];
  private readonly sendListeners = new Set<SendHandler>();
  private readonly closeListeners = new Set<() => void>();
  readonly webContents = {
    isDestroyed: () => this.destroyed,
    send: (channel: string, value: unknown) => {
      if (this.destroyed) return;
      this.sent.push({ channel, value });
      for (const handler of this.sendListeners) handler({}, channel, value);
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === "destroyed") this.closeListeners.add(listener as () => void);
      else this.sendListeners.add(listener as SendHandler);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === "destroyed") this.closeListeners.delete(listener as () => void);
      else this.sendListeners.delete(listener as SendHandler);
    }
  };

  constructor() {
    FakeWindow.all.push(this);
  }

  destroy(): void {
    this.destroyed = true;
    for (const listener of this.closeListeners) listener();
  }

  delivered(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => entry.value as Record<string, unknown>);
  }
}

function completedMessage(extra?: Partial<{ id: string; content: string }>) {
  return {
    id: extra?.id ?? "assistant-1",
    conversationId: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    role: "assistant" as const,
    content: extra?.content ?? "Grounded answer [S1]",
    state: "completed" as const,
    replyToMessageId: null,
    supersedesMessageId: null,
    superseded: false,
    provider: "openai",
    profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    model: "gpt-test",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    errorCode: null,
    completionReason: "stop",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    citations: [
      {
        id: "assistant-1:S1:0",
        label: "S1",
        sourceId: "88888888-8888-4888-8888-888888888888",
        sourceChunkId: "99999999-9999-4999-8999-999999999999",
        sourceDisplayName: "Research PDF",
        sourceKind: "pdf",
        locator: { kind: "page", page: 2 }
      }
    ]
  };
}

function conversation() {
  return {
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: "New chat",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    deletedAt: null,
    archivedAt: null
  };
}

type ChatServiceLike = {
  listConversations: ReturnType<typeof vi.fn>;
  createConversation: ReturnType<typeof vi.fn>;
  renameConversation: ReturnType<typeof vi.fn>;
  archiveConversation: ReturnType<typeof vi.fn>;
  deleteConversation: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  send(input: unknown, emit?: (event: unknown) => void): Promise<unknown>;
  regenerate(input: unknown, emit?: (event: unknown) => void): Promise<unknown>;
  stopRequest: ReturnType<typeof vi.fn>;
};

let counter = 0;
function nextRequestId(): string {
  counter += 1;
  return `22222222-2222-4222-8222-${String(counter).padStart(12, "0")}`;
}

function okResult(requestId: string) {
  return { ok: true as const, value: { requestId, assistantMessageId: "assistant-1" } };
}

async function invoke(ipc: Map<string, InvokeHandler>, channel: string, input: unknown): Promise<unknown> {
  const handler = ipc.get(channel);
  if (!handler) throw new Error("missing handler " + channel);
  return handler({ sender: "sender" }, input);
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "assistant-1";
const SEND_INPUT = {
  projectId: PROJECT_ID,
  conversationId: CONVERSATION_ID,
  requestId: "22222222-2222-4222-8222-222222222222",
  question: "What does S1 say?"
};

describe("registerChatHandlers", () => {
  let windows: FakeWindow[];
  let registry: Map<string, Set<FakeWindow>>;

  function makeService(sendImpl?: ChatServiceLike["send"]): ChatServiceLike {
    return {
      listConversations: vi.fn(() => [conversation()]),
      createConversation: vi.fn(() => conversation()),
      renameConversation: vi.fn(() => conversation()),
      archiveConversation: vi.fn(() => conversation()),
      deleteConversation: vi.fn(),
      listMessages: vi.fn(() => [completedMessage()]),
      send: vi.fn(
        sendImpl ??
        (async (input, emit) => {
          const requestId = (input as { requestId: string }).requestId;
          emit?.({ type: "started", requestId, messageId: MESSAGE_ID });
          return okResult(requestId);
        })
      ),
      regenerate: async () => okResult("regen"),
      stopRequest: vi.fn(() => true)
    };
  }

  function setup(service: ChatServiceLike) {
    windows = [];
    registry = new Map();
    const ipc = new Map<string, InvokeHandler>();
    // One window exists per suite; the fake sender resolves to the latest window.
    windows.push(new FakeWindow());
    registerChatHandlers({
      ipc,
      service: service as never,
      requestHub: registry as never,
      resolveWindowFromSender: (sender) => (sender === "sender" ? windows.at(-1) : undefined),
      openCitation: async () => ({ ok: true as const, value: { opened: "document" as const } }),
      onWindowClosed: () => void 0
    });
    return { ipc };
  }

  afterEach(() => {
    FakeWindow.all = [];
    vi.useRealTimers();
  });

  it("subscribes the window before provider work starts so no first event races", async () => {
    const rid = SEND_INPUT.requestId;
    let emittedDuringSend = false;
    const service = makeService(async (_input, emit) => {
      // Subscription must already exist when the first event fires.
      expect(registry.get(rid)?.size ?? 0).toBeGreaterThan(0);
      emit?.({ type: "started", requestId: rid, messageId: MESSAGE_ID });
      emittedDuringSend = true;
      return okResult(rid);
    });
    const { ipc } = setup(service);
    await invoke(ipc, CHAT_CHANNELS.subscribeRequest, { requestId: rid });
    await invoke(ipc, CHAT_CHANNELS.send, { ...SEND_INPUT, requestId: rid });
    expect(emittedDuringSend).toBe(true);
    const window = FakeWindow.all.at(-1)!;
    expect(window.delivered().some((value) => value.type === "started")).toBe(true);
  });

  it("validates every event through a schema before delivery and drops malformed values", async () => {
    const rid = nextRequestId();
    const service = makeService(async (_input, emit) => {
      emit?.({ type: "started", requestId: rid, messageId: MESSAGE_ID });
      emit?.({ type: "nonsense-type", requestId: rid });
      emit?.({ type: "text-delta", requestId: rid, messageId: MESSAGE_ID, text: 12345 as never });
      emit?.({ type: "started", requestId: "forged-other-request", messageId: "m" });
      return okResult(rid);
    });
    const { ipc } = setup(service);
    const window = new FakeWindow();
    registry.set(rid, new Set([window]));
    await invoke(ipc, CHAT_CHANNELS.send, { ...SEND_INPUT, requestId: rid });
    expect(window.delivered()).toEqual([
      { type: "started", requestId: rid, messageId: MESSAGE_ID }
    ]);
  });

  it("isolates events per opaque request ID and per project window set", async () => {
    const ridA = nextRequestId();
    const ridB = nextRequestId();
    const service = makeService(async (_input, emit) => {
      emit?.({ type: "started", requestId: ridA, messageId: MESSAGE_ID });
      emit?.({ type: "text-delta", requestId: ridA, messageId: MESSAGE_ID, text: "secret-a" });
      return okResult(ridA);
    });
    const { ipc } = setup(service);
    const windowA = new FakeWindow();
    const windowB = new FakeWindow();
    registry.set(ridA, new Set([windowA]));
    registry.set(ridB, new Set([windowB]));

    await invoke(ipc, CHAT_CHANNELS.send, { ...SEND_INPUT, requestId: ridA });

    for (const event of windowA.delivered()) expect(event.requestId).toBe(ridA);
    expect(windowB.delivered()).toEqual([]);
  });

  it("unsubscribes so later events after unsubscribe are not delivered", async () => {
    const rid = nextRequestId();
    const service = makeService();
    const { ipc } = setup(service);
    const window = new FakeWindow();
    registry.set(rid, new Set([window]));
    await invoke(ipc, CHAT_CHANNELS.unsubscribeRequest, { requestId: rid });
    expect(registry.has(rid)).toBe(false);
    expect(window.delivered()).toEqual([]);
  });

  it("cleans every subscription when the subscribing window is destroyed", async () => {
    const rid = nextRequestId();
    const service = makeService();
    const { ipc } = setup(service);
    await invoke(ipc, CHAT_CHANNELS.subscribeRequest, { requestId: rid });
    const window = FakeWindow.all.at(-1)!;
    expect(registry.get(rid)?.has(window)).toBe(true);
    window.destroy();
    expect(registry.size).toBe(0);
    expect(window.webContents.isDestroyed()).toBe(true);
  });

  it("coalesces text deltas to at most 30 renderer events per second with byte-exact final text", async () => {
    vi.useFakeTimers();
    const rid = nextRequestId();
    const expectedChunks: string[] = [];
    const service = makeService(async (_input, emit) => {
      expect(registry.get(rid)?.size ?? 0).toBeGreaterThan(0);
      emit?.({ type: "started", requestId: rid, messageId: MESSAGE_ID });
      for (let i = 0; i < 90; i++) {
        const chunk = `chunk ${i} `;
        expectedChunks.push(chunk);
        emit?.({ type: "text-delta", requestId: rid, messageId: MESSAGE_ID, text: chunk });
      }
      emit?.({
        type: "completed",
        requestId: rid,
        messageId: MESSAGE_ID,
        message: completedMessage({ content: expectedChunks.join("") })
      });
      return okResult(rid);
    });
    const { ipc } = setup(service);
    const window = new FakeWindow();
    registry.set(rid, new Set([window]));
    await invoke(ipc, CHAT_CHANNELS.send, { ...SEND_INPUT, requestId: rid });
    vi.advanceTimersByTime(4000);

    const deltas = window.delivered().filter((value) => value.type === "text-delta") as Array<{ text: string }>;
    expect(deltas.map((delta) => delta.text).join("")).toBe(expectedChunks.join(""));
    expect(deltas.length).toBeLessThanOrEqual(30);
    // The completed message content is byte-exact against what was streamed.
    const completed = window.delivered().find((value) => value.type === "completed") as { message?: { content?: string } };
    expect(completed.message?.content).toBe(expectedChunks.join(""));
  });

  it("clears the coalescer timer when a stream aborts without a terminal event", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const rid = nextRequestId();
    const service = makeService(async (_input, emit) => {
      emit?.({ type: "text-delta", requestId: rid, messageId: MESSAGE_ID, text: "partial" });
      throw new Error("provider connection lost mid-stream");
    });
    const { ipc } = setup(service);
    const window = new FakeWindow();
    registry.set(rid, new Set([window]));

    await expect(invoke(ipc, CHAT_CHANNELS.send, { ...SEND_INPUT, requestId: rid })).rejects.toThrow("provider connection lost mid-stream");
    // Even though no terminal event arrived, the flush timer must be released.
    expect(clearIntervalSpy).toHaveBeenCalled();

    const ticksBefore = window.delivered().length;
    await vi.advanceTimersByTimeAsync(4000);
    // No residual timer keeps flushing into the request after the stream died.
    expect(window.delivered().length).toBe(ticksBefore);
    clearIntervalSpy.mockRestore();
  });

  it("tracks each window once no matter how many requests subscribe it", async () => {
    const service = makeService();
    windows = [];
    registry = new Map();
    const ipc = new Map<string, InvokeHandler>();
    windows.push(new FakeWindow());
    const onWindowClosed = vi.fn();
    registerChatHandlers({
      ipc,
      service: service as never,
      requestHub: registry as never,
      resolveWindowFromSender: (sender) => (sender === "sender" ? windows.at(-1) : undefined),
      openCitation: async () => ({ ok: true as const, value: { opened: "document" as const } }),
      onWindowClosed
    });
    for (let i = 0; i < 5; i++) {
      await invoke(ipc, CHAT_CHANNELS.subscribeRequest, { requestId: nextRequestId() });
    }
    const window = FakeWindow.all.at(-1)!;
    window.destroy();
    // Duplicate 'destroyed' listeners would fire forgetWindow five times.
    expect(registry.size).toBe(0);
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it("exposes CRUD/list messages/citation/stop handlers with validated inputs", async () => {
    const openCitation = vi.fn(async () => ({ ok: true as const, value: { opened: "document" as const } }));
    const service = makeService();
    windows = [];
    registry = new Map();
    const ipc = new Map<string, InvokeHandler>();
    registerChatHandlers({
      ipc,
      service: service as never,
      requestHub: registry as never,
      resolveWindowFromSender: (sender) => (sender === "sender" ? windows.at(-1) : undefined),
      openCitation,
      onWindowClosed: () => void 0
    });

    await expect(invoke(ipc, CHAT_CHANNELS.listConversations, { projectId: PROJECT_ID })).resolves.toEqual({
      ok: true,
      value: [conversation()]
    });
    expect(service.listConversations).toHaveBeenCalledWith(PROJECT_ID);

    await expect(invoke(ipc, CHAT_CHANNELS.createConversation, { projectId: PROJECT_ID, title: "New chat" })).resolves.toEqual({
      ok: true,
      value: conversation()
    });
    await invoke(ipc, CHAT_CHANNELS.rename, { projectId: PROJECT_ID, conversationId: CONVERSATION_ID, title: "Renamed" });
    await invoke(ipc, CHAT_CHANNELS.archive, { projectId: PROJECT_ID, conversationId: CONVERSATION_ID });
    await invoke(ipc, CHAT_CHANNELS.deleteConversation, { projectId: PROJECT_ID, conversationId: CONVERSATION_ID });
    await expect(invoke(ipc, CHAT_CHANNELS.listMessages, { projectId: PROJECT_ID, conversationId: CONVERSATION_ID })).resolves.toEqual({
      ok: true,
      value: [completedMessage()]
    });
    await invoke(ipc, CHAT_CHANNELS.regenerate, { requestId: SEND_INPUT.requestId, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, messageId: MESSAGE_ID });

    const citationId = "assistant-1:S1:0";
    await invoke(ipc, CITATION_CHANNELS.open, { projectId: PROJECT_ID, citationId });
    expect(openCitation).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, citationId })
    );

    const stopRid = "22222222-2222-4222-8222-222222222299";
    await invoke(ipc, CHAT_CHANNELS.stop, { projectId: PROJECT_ID, requestId: stopRid });
    expect(service.stopRequest).toHaveBeenCalledWith(stopRid, expect.objectContaining({ projectId: PROJECT_ID }));
  });

  it("rejects forged or empty inputs before touching the service", async () => {
    const service = makeService();
    const { ipc } = setup(service);
    await expect(invoke(ipc, CHAT_CHANNELS.send, { ...SEND_INPUT, question: "" })).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(service.send).not.toHaveBeenCalled();
    await expect(invoke(ipc, CHAT_CHANNELS.stop, { projectId: PROJECT_ID, requestId: "garbage" })).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(service.stopRequest).not.toHaveBeenCalled();
  });
});
