import { describe, expect, it, vi } from "vitest";
import { ProviderHttpClient, ProviderRequestError, joinUrl, type FetchLike } from "./http-client";

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

function chunkedResponse(chunks: string[], headers: HeadersInit): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { headers });
}

function byteChunkedResponse(chunks: Uint8Array[], headers: HeadersInit): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), { headers });
}

async function requestError(action: () => Promise<unknown>): Promise<ProviderRequestError> {
  const error = await action().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ProviderRequestError);
  return error as ProviderRequestError;
}

describe("ProviderHttpClient", () => {
  it("joins a normalized base URL with a relative endpoint", () => {
    expect(joinUrl("https://models.example/v1/", "/chat/completions")).toBe(
      "https://models.example/v1/chat/completions"
    );
  });

  it("turns an explicit abort into a non-fallback cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchLike = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
      else init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const client = new ProviderHttpClient(fetchImpl);

    const error = await requestError(() => client.json("https://models.example", "/models", { signal: controller.signal }));

    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "CANCELLED" } });
  });

  it("turns its own deadline into a fallback-eligible timeout", async () => {
    const fetchImpl: FetchLike = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    });
    const client = new ProviderHttpClient(fetchImpl, { timeoutMs: 5 });

    const error = await requestError(() => client.json("https://models.example", "/models", { signal: new AbortController().signal }));

    expect(error.failure).toMatchObject({ fallbackEligible: true, error: { code: "TIMEOUT" } });
  });

  it("keeps a streaming deadline distinguishable from a network reader failure", async () => {
    // Deadline: a stream that connects but never delivers a byte hits the
    // idle watchdog (TIMEOUT), while a stream that errors mid-body is a
    // network/provider failure (PROVIDER) — long streams are never killed
    // just because they take a while overall.
    const stalling: FetchLike = async () => new Response(new ReadableStream({
      start() { /* never yields, never closes */ }
    }));
    const client = new ProviderHttpClient(stalling, { idleTimeoutMs: 5 });

    const error = await requestError(async () => {
      for await (const _record of client.ndjson("https://models.example", "/stream", { signal: new AbortController().signal })) {
        // The stream only ends through its deadline.
      }
    });

    expect(error.failure).toMatchObject({ fallbackEligible: true, error: { code: "TIMEOUT" } });

    const failing: FetchLike = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection reset")); }
    }));
    const network = new ProviderHttpClient(failing);

    const networkError = await requestError(async () => {
      for await (const _record of network.ndjson("https://models.example", "/stream", { signal: new AbortController().signal })) {
        // The stream dies mid-body: a network failure, not a deadline.
      }
    });

    expect(networkError.failure).toMatchObject({ error: { code: "NETWORK" } });
  });

  it("normalizes HTTP failures and preserves only retry metadata", async () => {
    const secret = "secret-token";
    const client = new ProviderHttpClient(async () => response(
      `Authorization: Bearer ${secret}`,
      { status: 429, headers: { "retry-after": "3" } }
    ));

    const error = await requestError(() => client.json("https://models.example", "/models", { signal: new AbortController().signal }));

    expect(error.failure).toEqual({
      fallbackEligible: true,
      error: { code: "RATE_LIMITED", messageKey: "errors.rateLimited", recoverable: true, retryAfterMs: 3000 }
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("normalizes malformed JSON without retaining the provider response", async () => {
    const client = new ProviderHttpClient(async () => response('{"token":"secret-token"'));

    const error = await requestError(() => client.json("https://models.example", "/models", { signal: new AbortController().signal }));

    expect(error.failure).toMatchObject({ error: { code: "PROVIDER" } });
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });

  it("enforces the raw response byte cap before parsing", async () => {
    const client = new ProviderHttpClient(
      async () => response('{"secret":"oversized"}'),
      { maxResponseBytes: 8 }
    );

    const error = await requestError(() => client.json(
      "https://models.example",
      "/models",
      { signal: new AbortController().signal }
    ));

    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "PROVIDER" } });
    expect(JSON.stringify(error)).not.toContain("oversized");
  });

  it("does not retry failed requests automatically and exposes caller-usable retry metadata", async () => {
    let calls = 0;
    const client = new ProviderHttpClient(async () => {
      calls += 1;
      return response("busy", { status: 429, headers: { "retry-after": "2" } });
    });
    const limited = await requestError(() => client.json(
      "https://models.example", "/models", { signal: new AbortController().signal }
    ));
    expect(calls).toBe(1);
    expect(limited.failure).toMatchObject({
      fallbackEligible: true,
      error: { code: "RATE_LIMITED", retryAfterMs: 2000 }
    });

    calls = 0;
    const serverErrorClient = new ProviderHttpClient(async () => {
      calls += 1;
      return response("boom", { status: 503 });
    });
    const unavailable = await requestError(() => serverErrorClient.json(
      "https://models.example", "/models", { signal: new AbortController().signal }
    ));
    expect(calls).toBe(1);
    expect(unavailable.failure).toMatchObject({ fallbackEligible: true, error: { code: "PROVIDER" } });
  });

  it.each([429, 503])("returns HTTP %i without waiting for a hanging error body", async (status) => {
    const client = new ProviderHttpClient(async () => new Response(new ReadableStream({
      start() {
        // Deliberately never close or enqueue: HTTP classification must not read this body.
      }
    }), { status, headers: { "retry-after": "1" } }));
    const result = await Promise.race([
      client.json("https://models.example", "/models", { signal: new AbortController().signal }).catch((error: unknown) => error),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol("timed out")), 50))
    ]);

    expect(result).toBeInstanceOf(ProviderRequestError);
    expect((result as ProviderRequestError).failure.error.code).toMatch(/RATE_LIMITED|PROVIDER/);
  });

  it.each([429, 503])("cancels a non-2xx hanging body without replacing HTTP error %i", async (status) => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const client = new ProviderHttpClient(async () => new Response(new ReadableStream({
      cancel
    }), { status }));

    const error = await requestError(() => client.json(
      "https://models.example", "/models", { signal: new AbortController().signal }
    ));
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(error.failure.error.code).toMatch(/RATE_LIMITED|PROVIDER/);
  });

  it("cancels a response that becomes too large", async () => {
    const cancel = vi.fn();
    const client = new ProviderHttpClient(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel
    }), { headers: { "content-type": "application/x-ndjson" } }), { maxResponseBytes: 8 });

    const error = await requestError(async () => {
      for await (const _record of client.ndjson(
        "https://models.example", "/stream", { signal: new AbortController().signal }
      )) { /* consume */ }
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(error.failure.error.code).toBe("PROVIDER");
  });

  it("cancels a response when parsing stops consumption early", async () => {
    const cancel = vi.fn();
    const client = new ProviderHttpClient(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-json\n"));
      },
      cancel
    }), { headers: { "content-type": "application/x-ndjson" } }));

    const error = await requestError(async () => {
      for await (const _record of client.ndjson(
        "https://models.example", "/stream", { signal: new AbortController().signal }
      )) { /* parse error */ }
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(error.failure.error.code).toBe("PROVIDER");
  });

  it("cancels a response when the consumer breaks early", async () => {
    const cancel = vi.fn();
    const client = new ProviderHttpClient(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":1}\n'));
      },
      cancel
    }), { headers: { "content-type": "application/x-ndjson" } }));

    for await (const _record of client.ndjson(
      "https://models.example", "/stream", { signal: new AbortController().signal }
    )) break;

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel a response that is read to completion", async () => {
    const cancel = vi.fn();
    const client = new ProviderHttpClient(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":1}\n'));
        controller.close();
      },
      cancel
    }), { headers: { "content-type": "application/x-ndjson" } }));

    const records: unknown[] = [];
    for await (const record of client.ndjson(
      "https://models.example", "/stream", { signal: new AbortController().signal }
    )) records.push(record);

    expect(records).toEqual([{ value: 1 }]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reads SSE and NDJSON records split across byte chunks", async () => {
    const client = new ProviderHttpClient(async (_url) => chunkedResponse(
      ['data: {"text":"hel', 'lo"}\n\ndata: [DONE]\n\n'],
      { "content-type": "text/event-stream" }
    ));
    const events: unknown[] = [];
    for await (const event of client.sse("https://models.example", "/stream", { signal: new AbortController().signal })) {
      events.push(event);
    }
    expect(events).toEqual([{ text: "hello" }]);

    const ndjsonClient = new ProviderHttpClient(async (_url) => chunkedResponse(
      ['{"value":', '1}\n{"value":2}\n'],
      { "content-type": "application/x-ndjson" }
    ));
    const records: unknown[] = [];
    for await (const record of ndjsonClient.ndjson("https://models.example", "/embed", { signal: new AbortController().signal })) {
      records.push(record);
    }
    expect(records).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("preserves multibyte UTF-8 characters split across streaming chunks", async () => {
    const encoder = new TextEncoder();
    const sseBytes = encoder.encode('data: {"text":"你好"}\n\n');
    const firstMultibyte = sseBytes.findIndex((byte) => byte === 0xe4);
    const client = new ProviderHttpClient(async () => byteChunkedResponse([
      sseBytes.slice(0, firstMultibyte + 1),
      sseBytes.slice(firstMultibyte + 1)
    ], { "content-type": "text/event-stream" }));
    const events: unknown[] = [];
    for await (const event of client.sse(
      "https://models.example",
      "/stream",
      { signal: new AbortController().signal }
    )) events.push(event);
    expect(events).toEqual([{ text: "你好" }]);

    const ndjsonBytes = encoder.encode('{"text":"研究"}\n');
    const secondMultibyte = ndjsonBytes.findIndex((byte) => byte === 0xe7);
    const ndjsonClient = new ProviderHttpClient(async () => byteChunkedResponse([
      ndjsonBytes.slice(0, secondMultibyte + 2),
      ndjsonBytes.slice(secondMultibyte + 2)
    ], { "content-type": "application/x-ndjson" }));
    const records: unknown[] = [];
    for await (const record of ndjsonClient.ndjson(
      "https://models.example",
      "/stream",
      { signal: new AbortController().signal }
    )) records.push(record);
    expect(records).toEqual([{ text: "研究" }]);
  });
});
