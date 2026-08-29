import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../main/models/anthropic-provider";
import { GeminiProvider } from "../main/models/gemini-provider";
import { ProviderRequestError } from "../main/models/http-client";
import { OllamaProvider } from "../main/models/ollama-provider";
import { OpenAiCompatibleProvider, OpenAiProvider } from "../main/models/openai-provider";
import type { GenerationEvent, ModelProvider } from "../main/models/provider";
import { sendJson, startFakeProviderServer, type FakeProviderServer } from "../main/models/test/fake-provider-server";

const secret = "provider-matrix-secret";
const servers: FakeProviderServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fakeServer(handler: Parameters<typeof startFakeProviderServer>[0]): Promise<FakeProviderServer> {
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

async function collect(provider: ModelProvider, model: string): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of provider.generate(
    { model, messages: [{ role: "user", content: "Hello" }] },
    new AbortController().signal
  )) events.push(event);
  return events;
}

async function cancelCell(provider: ModelProvider): Promise<void> {
  const hanging = await fakeServer(async (_request, response) => {
    await new Promise<void>((resolve) => response.once("close", resolve));
  });
  const controller = new AbortController();
  const pending = provider.discover(controller.signal);
  controller.abort();
  const error = await providerError(() => pending);
  expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "CANCELLED" } });
}

async function errorCells(make: (fake: FakeProviderServer) => ModelProvider): Promise<void> {
  const cases = [
    [401, "AUTH", false],
    [429, "RATE_LIMITED", true]
  ] as const;
  for (const [status, code, fallbackEligible] of cases) {
    const failing = await fakeServer((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(secret);
    });
    const error = await providerError(() => make(failing).discover(new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible, error: { code } });
    expect(JSON.stringify(error)).not.toContain(secret);
  }
}

describe("provider contract matrix", () => {
  it("covers OpenAI and OpenAI-compatible discovery, generation, embedding, stream, cancel, and errors", async () => {
    expect(new OpenAiProvider({ apiKey: secret }).baseUrl).toBe("https://api.openai.com/v1");

    const discovery = await fakeServer((_request, response) => sendJson(response, {
      data: [{ id: "gpt-matrix" }, { id: "text-embedding-matrix" }]
    }));
    const provider = new OpenAiCompatibleProvider({ baseUrl: discovery.baseUrl, apiKey: secret });
    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "gpt-matrix", displayName: "gpt-matrix", capabilities: [], capabilityEvidence: "probe-required" },
      { id: "text-embedding-matrix", displayName: "text-embedding-matrix", capabilities: [], capabilityEvidence: "probe-required" }
    ]);
    expect(discovery.requests[0]).toMatchObject({
      method: "GET", path: "/v1/models", headers: expect.objectContaining({ authorization: `Bearer ${secret}` })
    });

    const generation = await fakeServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
    await expect(collect(new OpenAiCompatibleProvider({ baseUrl: generation.baseUrl, apiKey: secret }), "gpt-matrix"))
      .resolves.toEqual([
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        { type: "done", finishReason: "stop" }
      ]);
    expect(generation.requests[0]).toMatchObject({ method: "POST", path: "/v1/chat/completions" });

    const embeddings = await fakeServer((_request, response) => sendJson(response, {
      data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }]
    }));
    await expect(new OpenAiCompatibleProvider({ baseUrl: embeddings.baseUrl, apiKey: secret })
      .embed({ model: "text-embedding-matrix", inputs: ["one", "two"] }, new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(embeddings.requests[0]).toMatchObject({ method: "POST", path: "/v1/embeddings" });

    await cancelCell(new OpenAiCompatibleProvider({ baseUrl: discovery.baseUrl, apiKey: secret }));
    await errorCells((fake) => new OpenAiCompatibleProvider({ baseUrl: fake.baseUrl, apiKey: secret }));
  });

  it("covers Anthropic discovery, generation, unsupported embedding, stream, cancel, and errors", async () => {
    const discovery = await fakeServer((_request, response) => sendJson(response, {
      data: [{ id: "claude-matrix", display_name: "Claude Matrix" }]
    }));
    const provider = new AnthropicProvider({ baseUrl: origin(discovery), apiKey: secret });
    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "claude-matrix", displayName: "Claude Matrix", capabilities: ["generation"], capabilityEvidence: "authoritative" }
    ]);
    expect(discovery.requests[0]).toMatchObject({
      method: "GET", path: "/v1/models",
      headers: expect.objectContaining({ "x-api-key": secret, "anthropic-version": "2023-06-01" })
    });

    const generation = await fakeServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n');
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n');
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n');
      response.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
      response.end('data: {"type":"message_stop"}\n\n');
    });
    await expect(collect(new AnthropicProvider({ baseUrl: origin(generation), apiKey: secret }), "claude-matrix"))
      .resolves.toEqual([
        { type: "usage", inputTokens: 4 },
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", outputTokens: 2 },
        { type: "done", finishReason: "end_turn" }
      ]);

    const offlineEmbed = await fakeServer((_request, response) => sendJson(response, {}));
    const embedError = await providerError(() =>
      new AnthropicProvider({ baseUrl: origin(offlineEmbed), apiKey: secret })
        .embed({ model: "claude-matrix", inputs: ["one"] }, new AbortController().signal));
    expect(embedError.failure).toMatchObject({ fallbackEligible: false, error: { code: "VALIDATION" } });

    expect(offlineEmbed.requests).toEqual([]);
  });

  it("covers Gemini discovery, generation, embedding, stream, cancel, and errors", async () => {
    const discovery = await fakeServer((_request, response) => sendJson(response, {
      models: [
        { name: "models/gemini-matrix", displayName: "Gemini Matrix", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-matrix", displayName: "Embedding Matrix", supportedGenerationMethods: ["embedContent"] }
      ]
    }));
    const provider = new GeminiProvider({ baseUrl: origin(discovery), apiKey: secret });
    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "models/gemini-matrix", displayName: "Gemini Matrix", capabilities: ["generation"], capabilityEvidence: "authoritative" },
      { id: "models/embedding-matrix", displayName: "Embedding Matrix", capabilities: ["embedding"], capabilityEvidence: "authoritative" }
    ]);
    expect(discovery.requests[0]).toMatchObject({
      method: "GET", path: "/v1beta/models", headers: expect.objectContaining({ "x-goog-api-key": secret })
    });

    const generation = await fakeServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n');
      response.end('data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n');
    });
    await expect(collect(new GeminiProvider({ baseUrl: origin(generation), apiKey: secret }), "models/gemini-matrix"))
      .resolves.toEqual([
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", inputTokens: 4, outputTokens: 2 },
        { type: "done", finishReason: "STOP" }
      ]);
    expect(generation.requests[0]).toMatchObject({
      method: "POST", path: "/v1beta/models/gemini-matrix:streamGenerateContent?alt=sse"
    });

    const embedCalls: number[] = [];
    const embeddings = await fakeServer((_request, response) => {
      embedCalls.push(embedCalls.length);
      sendJson(response, { embedding: { values: embedCalls.length === 1 ? [1, 2] : [3, 4] } });
    });
    await expect(new GeminiProvider({ baseUrl: origin(embeddings), apiKey: secret })
      .embed({ model: "embedding-matrix", inputs: ["one", "two"] }, new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(embeddings.requests).toHaveLength(2);
    expect(embeddings.requests[0]).toMatchObject({ method: "POST", path: "/v1beta/models/embedding-matrix:embedContent" });

    await cancelCell(new GeminiProvider({ baseUrl: origin(discovery), apiKey: secret }));
    await errorCells((fake) => new GeminiProvider({ baseUrl: origin(fake), apiKey: secret }));
  });

  it("covers Ollama discovery, generation, embedding, stream, cancel, and errors", async () => {
    const discovery = await fakeServer((_request, response) => sendJson(response, {
      models: [{ name: "llama-matrix:latest" }, { model: "embed-matrix:latest" }]
    }));
    const provider = new OllamaProvider({ baseUrl: origin(discovery) });
    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "llama-matrix:latest", displayName: "llama-matrix:latest", capabilities: [], capabilityEvidence: "probe-required" },
      { id: "embed-matrix:latest", displayName: "embed-matrix:latest", capabilities: [], capabilityEvidence: "probe-required" }
    ]);
    expect(discovery.requests[0]).toMatchObject({ method: "GET", path: "/api/tags" });

    const generation = await fakeServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"message":{"role":"assistant","content":"Hel"},"done":false}\n');
      response.end('{"message":{"role":"assistant","content":"lo"},"done":true,"done_reason":"stop","prompt_eval_count":4,"eval_count":2}\n');
    });
    await expect(collect(new OllamaProvider({ baseUrl: origin(generation) }), "llama-matrix"))
      .resolves.toEqual([
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", inputTokens: 4, outputTokens: 2 },
        { type: "done", finishReason: "stop" }
      ]);
    expect(generation.requests[0]).toMatchObject({ method: "POST", path: "/api/chat" });

    const embeddings = await fakeServer((_request, response) => sendJson(response, { embeddings: [[1, 2], [3, 4]] }));
    await expect(new OllamaProvider({ baseUrl: origin(embeddings) })
      .embed({ model: "embed-matrix", inputs: ["one", "two"] }, new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(embeddings.requests[0]).toMatchObject({ method: "POST", path: "/api/embed" });

    await cancelCell(new OllamaProvider({ baseUrl: origin(discovery) }));
    await errorCells((fake) => new OllamaProvider({ baseUrl: origin(fake) }));
  });
});
