import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic-provider";
import { ProviderRequestError } from "./http-client";
import type { GenerationEvent } from "./provider";
import { sendJson, startFakeProviderServer, type FakeProviderServer } from "./test/fake-provider-server";

const secret = "anthropic-test-secret";
const servers: FakeProviderServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function server(handler: Parameters<typeof startFakeProviderServer>[0]): Promise<FakeProviderServer> {
  const instance = await startFakeProviderServer(handler);
  servers.push(instance);
  return instance;
}

function origin(fake: FakeProviderServer): string {
  return fake.baseUrl.replace(/\/v1$/, "");
}

async function providerError(action: () => Promise<unknown>): Promise<ProviderRequestError> {
  const error = await action().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ProviderRequestError);
  return error as ProviderRequestError;
}

describe("Anthropic provider", () => {
  it("uses Anthropic's default address", () => {
    expect(new AnthropicProvider({ apiKey: secret }).baseUrl).toBe("https://api.anthropic.com");
  });

  it("discovers generation models with Anthropic authentication headers", async () => {
    const fake = await server((_request, response) => sendJson(response, {
      data: [{ id: "claude-test", display_name: "Claude Test" }]
    }));
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });

    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "claude-test", displayName: "Claude Test", capabilities: ["generation"], capabilityEvidence: "authoritative" }
    ]);
    expect(fake.requests).toEqual([expect.objectContaining({
      method: "GET",
      path: "/v1/models",
      headers: expect.objectContaining({ "x-api-key": secret, "anthropic-version": "2023-06-01" })
    })]);
  });

  it("sends Anthropic message payloads and maps SSE text, usage, and completion", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n');
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n');
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n');
      response.end('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
    });
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });
    const events: GenerationEvent[] = [];
    for await (const event of provider.generate({
      model: "claude-test",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" }
      ],
      temperature: 0.2,
      maxTokens: 50
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "usage", inputTokens: 4 },
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", outputTokens: 2 },
      { type: "done", finishReason: "end_turn" }
    ]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/messages",
      headers: {
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-test",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" }
        ],
        stream: true,
        max_tokens: 50,
        system: "Be concise",
        temperature: 0.2
      })
    });
  });

  it("rejects a truncated stream without a stop event instead of faking done", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n');
      response.end();
    });
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });
    const events: GenerationEvent[] = [];

    const error = await providerError(async () => {
      for await (const event of provider.generate({
        model: "claude-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).toEqual([{ type: "text-delta", text: "Hel" }]);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "PROVIDER" } });
  });

  it("rejects embeddings as unsupported before network I/O", async () => {
    const fake = await server((_request, response) => sendJson(response, {}));
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });

    const error = await providerError(() => provider.embed({ model: "claude-test", inputs: ["one"] }, new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "VALIDATION" } });
    expect(fake.requests).toEqual([]);
  });

  it("maps caller aborts to cancellation", async () => {
    const fake = await server(async (_request, response) => {
      await new Promise<void>((resolve) => response.once("close", resolve));
    });
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });
    const controller = new AbortController();
    const pending = provider.discover(controller.signal);
    controller.abort();

    const error = await providerError(() => pending);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "CANCELLED" } });
  });

  it("rejects Anthropic in-stream errors without finalizing partial output or retaining the message", async () => {
    const streamSecret = "anthropic-stream-secret";
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n');
      response.end(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${streamSecret}"}}\n\n`);
    });
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });
    const events: GenerationEvent[] = [];

    const error = await providerError(async () => {
      for await (const event of provider.generate({
        model: "claude-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(error.failure).toMatchObject({ fallbackEligible: true, error: { code: "PROVIDER" } });
    expect(JSON.stringify(error)).not.toContain(streamSecret);
  });

  it.each([
    [401, "AUTH", false],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER", true]
  ])("classifies HTTP %i without retaining secrets", async (status, code, fallbackEligible) => {
    const fake = await server((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(secret);
    });
    const provider = new AnthropicProvider({ baseUrl: origin(fake), apiKey: secret });

    const error = await providerError(() => provider.discover(new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible, error: { code } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
