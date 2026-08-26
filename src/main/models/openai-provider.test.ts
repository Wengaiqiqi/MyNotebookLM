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
