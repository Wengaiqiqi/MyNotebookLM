import { classifyProviderError, type ProviderFailure } from "./provider-errors";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Streaming responses may legitimately run for minutes; the read watchdog
 *  only fires when no bytes arrive at all (idle), not on total duration. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HttpClientOptions = Readonly<{
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type HttpRequestOptions = RequestInit & Readonly<{ signal: AbortSignal }>;

type RequestedResponse = Readonly<{
  response: Response;
  originalSignal: AbortSignal;
}>;

export class ProviderRequestError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.error.messageKey);
    this.name = "ProviderRequestError";
  }
}

class ResponseTooLargeError extends Error {}

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

  async *sse<T>(baseUrl: string, endpoint: string, options: HttpRequestOptions): AsyncIterable<T> {
    const requested = await this.request(baseUrl, endpoint, options);
    let pending = "";
    for await (const chunk of this.readChunks(requested)) {
      pending += chunk;
      const records = pending.split(/\r?\n\r?\n/);
      pending = records.pop() ?? "";
      for (const record of records) {
        const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        yield this.parseRecord<T>(data);
      }
    }
    if (pending.trim()) {
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
      for (const line of lines) if (line.trim()) yield this.parseRecord<T>(line);
    }
    if (pending.trim()) yield this.parseRecord<T>(pending);
  }

  private async request(baseUrl: string, endpoint: string, options: HttpRequestOptions): Promise<RequestedResponse> {
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
    const { signal: _callerSignal, ...init } = options;
    try {
      const response = await this.fetchImpl(joinUrl(baseUrl, endpoint), { ...init, signal: controller.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new ProviderRequestError(classifyProviderError({ status: response.status, headers: response.headers }));
      }
      return { response, originalSignal: options.signal };
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
    const { response, originalSignal } = requested;
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let completed = false;
    class IdleTimeout extends Error {}
    // Body reads race three outcomes: a chunk, the idle watchdog, or the
    // caller's cancellation (which no longer flows through the fetch signal).
    let rejectCancelled: ((reason: Error) => void) | undefined;
    const onCallerAbort = () => rejectCancelled?.(new DOMException("aborted", "AbortError"));
    if (!originalSignal.aborted) originalSignal.addEventListener("abort", onCallerAbort, { once: true });
    const readIdle = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new IdleTimeout()), this.idleTimeoutMs); }),
          ...(originalSignal.aborted ? [] : [new Promise<never>((_, reject) => { rejectCancelled = reject; })])
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      while (true) {
        const { done, value } = await readIdle();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) throw new ResponseTooLargeError();
        const text = decoder.decode(value, { stream: true });
        if (text) yield text;
      }
      completed = true;
      const tail = decoder.decode();
      if (tail) yield tail;
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
