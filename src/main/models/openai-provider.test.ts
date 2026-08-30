import { afterEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider, OpenAiProvider } from "./openai-provider";
import { ProviderRequestError } from "./http-client";
import { sendJson, startFakeProviderServer, type FakeProviderServer } from "./test/fake-provider-server";

const secret = "test-secret-key";
const servers: FakeProviderServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function server(handler: Parameters<typeof startFakeProviderServer>[0]): Promise<FakeProviderServer> {
  const instance = await startFakeProviderServer(handler);
  servers.push(instance);
  return instance;
}

async function providerError(action: () => Promise<unknown>): Promise<ProviderRequestError> {
  const error = await action().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ProviderRequestError);
  return error as ProviderRequestError;
}

describe("OpenAI-compatible provider", () => {
  it("uses the editable base URL and bearer token while mapping discovered models", async () => {
    const fake = await server((_request, response) => sendJson(response, {
      data: [{ id: "gpt-test" }, { id: "text-embedding-test" }]
    }));
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${fake.baseUrl}/`, apiKey: secret });

    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "gpt-test", displayName: "gpt-test", capabilities: [], capabilityEvidence: "probe-required" },
      { id: "text-embedding-test", displayName: "text-embedding-test", capabilities: [], capabilityEvidence: "probe-required" }
    ]);
    expect(fake.requests).toEqual([expect.objectContaining({
      method: "GET", path: "/v1/models", headers: expect.objectContaining({ authorization: `Bearer ${secret}` })
    })]);
  });

  it("uses OpenAI's default address when no base URL is supplied", () => {
    expect(new OpenAiProvider({ apiKey: secret }).baseUrl).toBe("https://api.openai.com/v1");
  });

  it("omits authorization when a compatible endpoint does not need an API key", async () => {
    const fake = await server((_request, response) => sendJson(response, { data: [] }));
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl });

    await provider.discover(new AbortController().signal);
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("sends OpenAI chat payloads and maps text, usage, and completion chunks", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });
    const events = [];
    for await (const event of provider.generate({
      model: "gpt-test", messages: [{ role: "user", content: "Hello" }], temperature: 0.2, maxTokens: 50
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", finishReason: "stop" }
    ]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test", messages: [{ role: "user", content: "Hello" }], stream: true,
        stream_options: { include_usage: true }, temperature: 0.2, max_tokens: 50
      })
    });
  });

  it("maps thinking levels onto the GLM dialect for glm models", async () => {
    const fake = await server((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    });
    const events = [];
    for await (const event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
      model: "glm-5.3-flash", messages: [{ role: "user", content: "Hi" }], thinking: "high"
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "done", finishReason: "stop" }
    ]);
    expect(JSON.parse((fake.requests[0]?.body ?? "{}") as string).thinking).toEqual({ type: "enabled" });
  });

  it("maps thinking off to reasoning_effort low on reasoning-effort models", async () => {
    const fake = await server((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    });
    const events = [];
    for await (const event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
      model: "o4-mini", messages: [{ role: "user", content: "Hi" }], thinking: "off"
    }, new AbortController().signal)) events.push(event);

    expect(JSON.parse((fake.requests[0]?.body ?? "{}") as string).reasoning_effort).toBe("low");
    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("probes dialects on unknown models, degrades to plain, and remembers", async () => {
    const bodies: string[] = [];
    const fake = await server((request, response) => {
      bodies.push(request.body as string);
      if (bodies.length < 4) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unknown parameter" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    });
    const provider = new OpenAiProvider({ baseUrl: fake.baseUrl });
    const events = [];
    for await (const event of provider.generate({
      model: "mystery-model", messages: [{ role: "user", content: "Hi" }], thinking: "medium"
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "done", finishReason: "stop" }
    ]);
    // glm-style, then reasoning_effort, then enable_thinking, then plain.
    expect(bodies).toHaveLength(4);
    expect(JSON.parse(bodies[0]!).thinking).toEqual({ type: "enabled" });
    expect(JSON.parse(bodies[1]!).reasoning_effort).toBe("medium");
    expect(JSON.parse(bodies[2]!).enable_thinking).toBe(true);
    expect(JSON.parse(bodies[3]!)).not.toHaveProperty("thinking");
    expect(JSON.parse(bodies[3]!)).not.toHaveProperty("reasoning_effort");
    expect(JSON.parse(bodies[3]!)).not.toHaveProperty("enable_thinking");

    // The resolved dialect ("plain") is remembered for the session.
    events.length = 0;
    for await (const event of provider.generate({
      model: "mystery-model", messages: [{ role: "user", content: "Hi again" }], thinking: "high"
    }, new AbortController().signal)) events.push(event);
    expect(bodies).toHaveLength(5);
    expect(JSON.parse(bodies[4]!)).not.toHaveProperty("thinking");
  });

  it("remembers a working dialect instead of re-probing every turn", async () => {
    const bodies: string[] = [];
    const fake = await server((request, response) => {
      bodies.push(request.body as string);
      const parsed = JSON.parse(request.body as string);
      if (parsed.reasoning_effort === undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unknown parameter" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    });
    const provider = new OpenAiProvider({ baseUrl: fake.baseUrl });
    for await (const _event of provider.generate({
      model: "mystery-model", messages: [{ role: "user", content: "Hi" }], thinking: "low"
    }, new AbortController().signal)) { /* drain */ }

    const events = [];
    for await (const event of provider.generate({
      model: "mystery-model", messages: [{ role: "user", content: "Hi again" }], thinking: "medium"
    }, new AbortController().signal)) events.push(event);

    // Turn one probed glm (rejected), then landed on reasoning_effort.
    // Second turn: straight to the working dialect, no probing.
    expect(bodies).toHaveLength(3);
    expect(JSON.parse(bodies[0]!).reasoning_effort).toBeUndefined();
    expect(JSON.parse(bodies[1]!).reasoning_effort).toBe("low");
    expect(JSON.parse(bodies[2]!).reasoning_effort).toBe("medium");
    expect(events.map((event) => event.type)).toEqual(["text-delta", "done"]);
  });

  it("rejects malformed usage without emitting completion", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":-1}}\n\n');
    });
    const events: unknown[] = [];
    const error = await providerError(async () => {
      for await (const event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
        model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).not.toContainEqual({ type: "done", finishReason: "stop" });
    expect(error.failure.error.code).toBe("PROVIDER");
  });

  it("emits usage-only tail usage before the single final completion", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const events: unknown[] = [];
    for await (const event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
      model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("ignores usage null on ordinary chunks before the usage-only tail", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}\n\n');
      response.write('data: {"choices":[{"finish_reason":"stop"}],"usage":null}\n\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const events: unknown[] = [];
    for await (const event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
      model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("rejects a non-null non-object usage value", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"finish_reason":"stop"}],"usage":"invalid"}\n\n');
    });
    const error = await providerError(async () => {
      for await (const _event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
        model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) { /* malformed usage */ }
    });
    expect(error.failure.error.code).toBe("PROVIDER");
  });

  it.each([
    ["text", '{"choices":[{"delta":{"content":"late"}}]}'],
    ["second completion", '{"choices":[{"finish_reason":"length"}]}']
  ])("rejects %s after completion", async (_label, lateChunk) => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      response.end(`data: ${lateChunk}\n\n`);
    });
    const events: unknown[] = [];
    const error = await providerError(async () => {
      for await (const event of new OpenAiProvider({ baseUrl: fake.baseUrl }).generate({
        model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
    expect(error.failure.error.code).toBe("PROVIDER");
  });

  it("rejects a truncated stream without a completion marker instead of faking done", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
      response.end();
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });
    const events: unknown[] = [];

    const error = await providerError(async () => {
      for await (const event of provider.generate({
        model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).toEqual([{ type: "text-delta", text: "Hel" }]);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "PROVIDER" } });
  });

  it("sends a batch embedding request and restores result order by index", async () => {
    const fake = await server((_request, response) => sendJson(response, {
      data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }]
    }));
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });

    await expect(provider.embed({ model: "embedding-test", inputs: ["one", "two"], dimensions: 2 }, new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST", path: "/v1/embeddings", body: JSON.stringify({ model: "embedding-test", input: ["one", "two"], dimensions: 2 })
    });
  });

  it.each([
    [[[]], "empty"],
    [[[1, Number.NaN]], "non-finite"],
    [[[1, 2], [3]], "mixed dimensions"]
  ])("rejects %s embedding vectors as malformed provider data", async (vectors) => {
    const fake = await server((_request, response) => sendJson(response, {
      data: vectors.map((embedding, index) => ({ index, embedding }))
    }));
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });

    const error = await providerError(() => provider.embed({ model: "embedding-test", inputs: vectors.map((_, index) => `input-${index}`) }, new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "PROVIDER" } });
  });

  it("rejects a stream chunk with non-string delta content as malformed", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":42}}]}\n\n');
      response.end();
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });
    const events: unknown[] = [];

    const error = await providerError(async () => {
      for await (const event of provider.generate({
        model: "gpt-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).toEqual([]);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "PROVIDER" } });
  });

  it("does not retain malformed response contents or API keys", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"data":[{"index":0,"embedding":["${secret}"]}]}`);
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });

    const error = await providerError(() => provider.embed({ model: "embedding-test", inputs: ["one"] }, new AbortController().signal));
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("maps caller aborts to cancellation", async () => {
    const fake = await server(async (_request, response) => {
      await new Promise<void>((resolve) => response.once("close", resolve));
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });
    const controller = new AbortController();
    const pending = provider.discover(controller.signal);
    controller.abort();

    const error = await providerError(() => pending);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "CANCELLED" } });
  });

  it.each([
    [401, "AUTH", false], [403, "AUTH", false], [404, "NOT_FOUND", false],
    [429, "RATE_LIMITED", true], [503, "PROVIDER", true],
    [400, "PROVIDER", false], [409, "PROVIDER", false], [422, "PROVIDER", false]
  ])("maps HTTP %i through the shared error classifier", async (status, code, fallbackEligible) => {
    const fake = await server((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain", "retry-after": "2" });
      response.end(`Authorization: Bearer ${secret}`);
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret });

    const error = await providerError(() => provider.discover(new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible, error: { code } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
