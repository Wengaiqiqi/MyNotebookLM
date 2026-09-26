import { Buffer } from "node:buffer";
import { classifyProviderError, type ProviderFailure } from "./provider-errors";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Streaming responses may legitimately run for minutes; the read watchdog
 *  only fires when no bytes arrive at all (idle), not on total duration. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_STREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Single SSE/NDJSON record ceiling; an unterminated record must not grow without bound. */
const MAX_EVENT_BYTES = 1_048_576;
const ERROR_BODY_LIMIT_BYTES = 16 * 1024;
const ERROR_BODY_TOTAL_TIMEOUT_MS = 2_000;
// Long enough for a body that arrives just after the headers on a slow link
// (25ms dropped real context-limit messages), short enough that a hanging
// body never delays the HTTP classification for long.
const ERROR_BODY_READ_TIMEOUT_MS = 250;

export function responseByteBudget(outputTokens?: number): number {
  return Math.min(MAX_STREAM_RESPONSE_BYTES, Math.max(8 * 1024 * 1024, 2 * 1024 * 1024 + Math.max(0, outputTokens ?? 1_024) * 1_024));
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HttpClientOptions = Readonly<{
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type HttpRequestOptions = RequestInit & Readonly<{ signal: AbortSignal; maxResponseBytes?: number }>;

type RequestedResponse = Readonly<{
  response: Response;
  originalSignal: AbortSignal;
  maxResponseBytes?: number;
}>;

export class ProviderRequestError extends Error {
  constructor(readonly failure: ProviderFailure, readonly status?: number) {
    super(failure.error.messageKey);
    this.name = "ProviderRequestError";
  }
}

class ResponseTooLargeError extends Error {}

async function readErrorBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  const deadline = Date.now() + ERROR_BODY_TOTAL_TIMEOUT_MS;
  try {
    while (!signal.aborted && total < ERROR_BODY_LIMIT_BYTES) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            timer = setTimeout(() => resolve({ done: true, value: undefined }), Math.min(ERROR_BODY_READ_TIMEOUT_MS, remaining));
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) break;
      const slice = next.value.subarray(0, Math.max(0, ERROR_BODY_LIMIT_BYTES - total));
      total += slice.byteLength;
      text += decoder.decode(slice, { stream: total < ERROR_BODY_LIMIT_BYTES });
      if (slice.byteLength < next.value.byteLength) break;
    }
  } catch {
    return text;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text;
}

export function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

export class ProviderHttpClient {
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    options: HttpClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async json<T>(baseUrl: string, endpoint: string, options: HttpRequestOptions): Promise<T> {
    const requested = await this.request(baseUrl, endpoint, options);
    const text = await this.readText(requested);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderRequestError(classifyProviderError({ malformedResponse: true }));
    }
  }

  async binary(baseUrl: string, endpoint: string, options: HttpRequestOptions): Promise<Buffer> {
    const requested = await this.request(baseUrl, endpoint, options);
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.readBytes(requested)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async *sse<T>(baseUrl: string, endpoint: string, options: HttpRequestOptions): AsyncIterable<T> {
    const requested = await this.request(baseUrl, endpoint, options);
    let pending = "";
    for await (const chunk of this.readChunks(requested)) {
      pending += chunk;
      const records = pending.split(/\r?\n\r?\n/);
      pending = records.pop() ?? "";
      if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
      for (const record of records) {
        if (Buffer.byteLength(record, "utf8") > MAX_EVENT_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
        const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        yield this.parseRecord<T>(data);
      }
    }
    if (pending.trim()) {
      if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
      const data = pending.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") yield this.parseRecord<T>(data);
    }
  }

  async *ndjson<T>(baseUrl: string, endpoint: string, options: HttpRequestOptions): AsyncIterable<T> {
    const requested = await this.request(baseUrl, endpoint, options);
    let pending = "";
    for await (const chunk of this.readChunks(requested)) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
      for (const line of lines) {
        if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
        if (line.trim()) yield this.parseRecord<T>(line);
      }
    }
    if (pending.trim()) {
      if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
      yield this.parseRecord<T>(pending);
    }
  }

  private async request(baseUrl: string, endpoint: string, options: HttpRequestOptions): Promise<RequestedResponse> {
    if (options.signal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
    // The connect deadline covers dialing + response headers only and is
    // disarmed once headers arrive: aborting a fetch signal afterwards would
    // also kill the body stream, cutting off long legitimate generations.
    // Body reads are governed by the idle watchdog in readChunks instead.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const propagateCancel = () => controller.abort();
    if (options.signal.aborted) propagateCancel();
    else options.signal.addEventListener("abort", propagateCancel);
    const { signal: _callerSignal, maxResponseBytes, ...init } = options;
    try {
      const response = await this.fetchImpl(joinUrl(baseUrl, endpoint), { ...init, signal: controller.signal });
      if (!response.ok) {
        // Chunked/error responses commonly omit Content-Length. The reader is
        // already bounded to 16 KiB, so always inspect the body before classifying.
        const body = await readErrorBody(response, options.signal);
        if (options.signal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
        if (!body) void response.body?.cancel().catch(() => undefined);
        throw new ProviderRequestError(classifyProviderError({ status: response.status, headers: response.headers, body }), response.status);
      }
      return { response, originalSignal: options.signal, ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }) };
    } catch (reason) {
      if (reason instanceof ProviderRequestError) throw reason;
      if (options.signal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
      if (timedOut) throw new ProviderRequestError(classifyProviderError({ timeout: true }));
      throw new ProviderRequestError(classifyProviderError({ cause: reason }));
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", propagateCancel);
    }
  }

  private async readText(requested: RequestedResponse): Promise<string> {
    let text = "";
    for await (const chunk of this.readChunks(requested)) text += chunk;
    return text;
  }

  private async *readChunks(requested: RequestedResponse): AsyncIterable<string> {
    const decoder = new TextDecoder();
    for await (const chunk of this.readBytes(requested)) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  }

  private async *readBytes(requested: RequestedResponse): AsyncIterable<Uint8Array> {
    const { response, originalSignal } = requested;
    if (!response.body) return;
    const reader = response.body.getReader();
    let total = 0;
    let completed = false;
    class IdleTimeout extends Error {}
    // Body reads race three outcomes: a chunk, the idle watchdog, or the
    // caller's cancellation (which no longer flows through the fetch signal).
    let rejectCancelled: ((reason: Error) => void) | undefined;
    const onCallerAbort = () => rejectCancelled?.(new DOMException("aborted", "AbortError"));
    if (!originalSignal.aborted) originalSignal.addEventListener("abort", onCallerAbort, { once: true });
    const readIdle = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (originalSignal.aborted) throw new DOMException("aborted", "AbortError");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new IdleTimeout()), this.idleTimeoutMs); }),
          ...(originalSignal.aborted ? [] : [new Promise<never>((_, reject) => { rejectCancelled = reject; })])
        ]);
      } finally {
        clearTimeout(timer);
        rejectCancelled = undefined;
      }
    };
    try {
      while (true) {
        const { done, value } = await readIdle();
        if (done) break;
        total += value.byteLength;
        if (total > (requested.maxResponseBytes ?? this.maxResponseBytes)) throw new ResponseTooLargeError();
        yield value;
      }
      completed = true;
    } catch (reason) {
      if (reason instanceof ProviderRequestError) throw reason;
      if (reason instanceof ResponseTooLargeError) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
      if (reason instanceof IdleTimeout) throw new ProviderRequestError(classifyProviderError({ timeout: true }));
      if (originalSignal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
      throw new ProviderRequestError(classifyProviderError({ cause: reason }));
    } finally {
      originalSignal.removeEventListener("abort", onCallerAbort);
      if (!completed) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private parseRecord<T>(record: string): T {
    try {
      return JSON.parse(record) as T;
    } catch {
      throw new ProviderRequestError(classifyProviderError({ malformedResponse: true }));
    }
  }
}
