import { z } from "zod";
import { internalFailure, validationFailure, type Result } from "../../shared/app-errors";
import {
  CHAT_CHANNELS,
  CITATION_CHANNELS,
  chatConversationInputSchema,
  chatCreateConversationInputSchema,
  chatListConversationsInputSchema,
  chatListMessagesInputSchema,
  chatRegenerateInputSchema,
  chatRequestIdInputSchema,
  chatRequestEventSchemas,
  chatRenameConversationInputSchema,
  chatSendInputSchema,
  chatStopInputSchema,
  citationOpenInputSchema
} from "../../shared/ipc";

type Emit = (event: unknown) => void;
type StreamOutcome = Result<{ requestId: string; assistantMessageId: string }>;

export type ChatHandlersServiceLike = {
  listConversations(projectId: string): unknown;
  createConversation(input: { projectId: string; title: string }): unknown;
  renameConversation(input: { projectId: string; conversationId: string; title: string }): unknown;
  archiveConversation(input: { projectId: string; conversationId: string }): unknown;
  deleteConversation(input: { projectId: string; conversationId: string }): void;
  listMessages(input: { projectId: string; conversationId: string }): unknown;
  send(input: ChatSendInput, emit: Emit): Promise<StreamOutcome>;
  regenerate(input: ChatRegenerateInput, emit: Emit): Promise<StreamOutcome>;
  stopRequest(requestId: string, caller: { projectId: string }): boolean;
};

export type CitationOpenerLike = (input: { projectId: string; citationId: string }) => Promise<Result<{ opened: "document" | "url" }>>;

export type ChatWindowLike = {
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, value: unknown): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };
};

type RequestHub = Map<string, Set<ChatWindowLike>>;

type ChatSendInput = z.infer<typeof chatSendInputSchema>;
type ChatRegenerateInput = z.infer<typeof chatRegenerateInputSchema>;

/** ~30 renderer events/second ceiling for text-delta fanout. */
const FLUSH_INTERVAL_MS = 34;

/**
 * Buffers streamed text between flush ticks so a burst of provider chunks fans
 * out as at most ~30 renderer events per second. Byte-exactness is preserved by
 * concatenation; stop() flushes residue before the terminal event.
 */
function createTextCoalescer(deliver: (value: Record<string, unknown>) => void): {
  push(delta: { requestId?: unknown; messageId?: unknown; text?: unknown }): void;
  stop(): void;
} {
  let buffer: string[] = [];
  let currentRequestId = "";
  let currentMessageId = "";
  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("");
    buffer = [];
    deliver({ type: "text-delta", requestId: currentRequestId, messageId: currentMessageId, text });
  };
  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  return {
    push(delta) {
      if (typeof delta.requestId === "string") currentRequestId = delta.requestId;
      if (typeof delta.messageId === "string") currentMessageId = delta.messageId;
      if (typeof delta.text === "string") buffer.push(delta.text);
    },
    stop() {
      clearInterval(timer);
      flush();
    }
  };
}

export function registerChatHandlers(args: {
  /** Sender resolution: main wires event.sender -> BrowserWindow; tests use fakes. */
  resolveWindowFromSender(sender: unknown): ChatWindowLike | undefined;
  ipc: Map<string, (event: unknown, input: unknown) => Promise<unknown>> | { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
  service: ChatHandlersServiceLike;
  requestHub: RequestHub;
  openCitation: CitationOpenerLike;
  onWindowClosed(window: ChatWindowLike): void;
}): () => void {
  const hub = args.requestHub;
  const channels = new Set<string>();
  const mapApi = args.ipc instanceof Map ? (args.ipc as Map<string, (event: unknown, input: unknown) => Promise<unknown>>) : undefined;
  const handleApi = mapApi ? undefined : (args.ipc as { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void });

  const forgetWindow = (window: ChatWindowLike): void => {
    for (const [rid, set] of hub) {
      set.delete(window);
      if (set.size === 0) hub.delete(rid);
    }
    args.onWindowClosed(window);
  };

  // One 'destroyed' listener per window regardless of how many requests subscribed.
  const trackedClosedWindows = new WeakSet<ChatWindowLike>();
  const trackWindowClosed = (window: ChatWindowLike): void => {
    if (trackedClosedWindows.has(window)) return;
    trackedClosedWindows.add(window);
    const cleanup = (): void => forgetWindow(window);
    window.webContents.on("destroyed", cleanup);
  };

  const subscribeWindow = (requestId: string, sender: unknown): boolean => {
    const window = args.resolveWindowFromSender(sender);
    if (!window || window.webContents.isDestroyed()) return false;
    trackWindowClosed(window);
    let set = hub.get(requestId);
    if (!set) {
      set = new Set();
      hub.set(requestId, set);
    }
    set.add(window);
    return true;
  };

  const deliverToRequest = (requestId: string, value: Record<string, unknown>): boolean => {
    const schema = (chatRequestEventSchemas as Record<string, z.ZodType | undefined>)[String(value["type"])];
    // Malformed or forged values never reach any window.
    if (!schema) return false;
    const parsed = schema.safeParse(value);
    if (!parsed.success) return false;
    for (const window of hub.get(requestId) ?? []) {
      if (!window.webContents.isDestroyed()) window.webContents.send(CHAT_CHANNELS.update + ":" + requestId, parsed.data);
    }
    return true;
  };

  /** Wrap a streaming call with coalesced text-delta fanout and validated events. */
  const runStream = <I extends ChatSendInput | ChatRegenerateInput>(
    inputSchema: z.ZodType<I>,
    invokeService: (input: I, emit: Emit) => Promise<StreamOutcome>
  ): ((event: unknown, rawInput: unknown) => Promise<StreamOutcome>) => {
    return async (_event, rawInput) => {
      const parsed = inputSchema.safeParse(rawInput);
      if (!parsed.success) return validationFailure();
      let coalescer: ReturnType<typeof createTextCoalescer> | undefined;
      const emit: Emit = (raw) => {
        const value = raw as Record<string, unknown>;
        const type = String(value?.["type"]);
        // ChatService emits internal "delta"; the versioned contract names it
        // "text-delta" — accept both so contract-shaped sources stay supported.
        if (type === "delta" || type === "text-delta") {
          coalescer ??= createTextCoalescer((coalesced) =>
            deliverToRequest(String(coalesced["requestId"] ?? ""), coalesced));
          coalescer.push({ requestId: value["requestId"], messageId: value["messageId"], text: value["text"] });
          return;
        }
        if (type === "completed" || type === "cancelled" || type === "failed") {
          coalescer?.stop();
          coalescer = undefined;
          deliverToRequest(String(value["requestId"] ?? ""), value);
          return;
        }
        deliverToRequest(String(value["requestId"] ?? ""), value);
      };
      try {
        return await invokeService(parsed.data, emit);
      } finally {
        coalescer?.stop();
      }
    };
  };

  async function validatedCall<I>(schema: z.ZodType<I>, rawInput: unknown, call: (value: I) => unknown): Promise<unknown> {
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) return validationFailure();
    try {
      return await call(parsed.data);
    } catch {
      return internalFailure();
    }
  }

  const registerHandler = (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void => {
    channels.add(channel);
    if (mapApi) mapApi.set(channel, handler);
    else handleApi?.handle(channel, handler);
  };

  registerHandler(CHAT_CHANNELS.listConversations, (_e, input) =>
    validatedCall(chatListConversationsInputSchema, input, (value) => args.service.listConversations(value.projectId)));
  registerHandler(CHAT_CHANNELS.createConversation, (_e, input) =>
    validatedCall(chatCreateConversationInputSchema, input, (value) => args.service.createConversation(value)));
  registerHandler(CHAT_CHANNELS.rename, (_e, input) =>
    validatedCall(chatRenameConversationInputSchema, input, (value) => args.service.renameConversation(value)));
  registerHandler(CHAT_CHANNELS.archive, (_e, input) =>
    validatedCall(chatConversationInputSchema, input, (value) => args.service.archiveConversation(value)));
  registerHandler(CHAT_CHANNELS.deleteConversation, (_e, input) =>
    validatedCall(chatConversationInputSchema, input, (value) => args.service.deleteConversation(value)));
  registerHandler(CHAT_CHANNELS.listMessages, (_e, input) =>
    validatedCall(chatListMessagesInputSchema, input, (value) => args.service.listMessages(value)));
  registerHandler(CHAT_CHANNELS.send, runStream(chatSendInputSchema, (input, emit) => args.service.send(input, emit)));
  registerHandler(CHAT_CHANNELS.regenerate, runStream(chatRegenerateInputSchema, (input, emit) => args.service.regenerate(input, emit)));
  registerHandler(CHAT_CHANNELS.stop, (_e, input) =>
    validatedCall(chatStopInputSchema, input, (value) => ({ ok: true as const, value: args.service.stopRequest(value.requestId, { projectId: value.projectId }) })));
  registerHandler(CITATION_CHANNELS.open, (_e, input) =>
    validatedCall(citationOpenInputSchema, input, (value) => args.openCitation(value)));

  // Subscribe synchronously inside the invoke so it always precedes any later send.
  registerHandler(CHAT_CHANNELS.subscribeRequest, (event, input) => {
    const parsed = chatRequestIdInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve(validationFailure());
    const sender = (event as { sender?: unknown })?.sender;
    const subscribed = subscribeWindow(parsed.data.requestId, sender);
    return Promise.resolve(subscribed ? { ok: true as const, value: undefined } : internalFailure());
  });
  registerHandler(CHAT_CHANNELS.unsubscribeRequest, (_e, input) => {
    const parsed = chatRequestIdInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve(validationFailure());
    hub.delete(parsed.data.requestId);
    return Promise.resolve({ ok: true as const, value: undefined });
  });

  return () => {
    for (const channel of channels) {
      if (mapApi) mapApi.delete(channel);
      else handleApi?.removeHandler(channel);
    }
    channels.clear();
    hub.clear();
  };
}
