import { afterEach, describe, expect, it } from "vitest";
import { GeminiProvider } from "./gemini-provider";
import { ProviderRequestError } from "./http-client";
import type { GenerationEvent } from "./provider";
import { sendJson, startFakeProviderServer, type FakeProviderServer } from "./test/fake-provider-server";

const secret = "gemini-test-secret";
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

describe("Gemini provider", () => {
  it("uses Gemini's default address", () => {
    expect(new GeminiProvider({ apiKey: secret }).baseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  it("filters discovered models and maps their supported capabilities", async () => {
    const fake = await server((_request, response) => sendJson(response, {
      models: [
        { name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-test", displayName: "Embedding Test", supportedGenerationMethods: ["embedContent"] },
        { name: "models/both-test", supportedGenerationMethods: ["generateContent", "embedContent"] },
        { name: "models/unsupported", supportedGenerationMethods: ["countTokens"] }
      ]
    }));
    const provider = new GeminiProvider({ baseUrl: origin(fake), apiKey: secret });

    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "models/gemini-test", displayName: "Gemini Test", capabilities: ["generation"], capabilityEvidence: "authoritative" },
      { id: "models/embedding-test", displayName: "Embedding Test", capabilities: ["embedding"], capabilityEvidence: "authoritative" },
      { id: "models/both-test", displayName: "models/both-test", capabilities: ["generation", "embedding"], capabilityEvidence: "authoritative" }
    ]);
    expect(fake.requests).toEqual([expect.objectContaining({
      method: "GET",
      path: "/v1beta/models",
      headers: expect.objectContaining({ "x-goog-api-key": secret })
    })]);
  });

  it("sends generateContent payloads and maps SSE text, usage, and completion", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n');
      response.end('data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n');
    });
    const provider = new GeminiProvider({ baseUrl: origin(fake), apiKey: secret });
    const events: GenerationEvent[] = [];
    for await (const event of provider.generate({
      model: "models/gemini-test",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" }
      ],
      temperature: 0.2,
      maxTokens: 50
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", inputTokens: 4, outputTokens: 2 },
      { type: "done", finishReason: "STOP" }
    ]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
      headers: { "x-goog-api-key": secret, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: "Hi" }] }
        ],
        systemInstruction: { parts: [{ text: "Be concise" }] },
        generationConfig: { temperature: 0.2, maxOutputTokens: 50 }
      })
    });
  });

  it("calls embedContent for every input and returns embedding arrays", async () => {
    const fake = await server((_request, response) => sendJson(response, {
      embedding: { values: fake.requests.length === 1 ? [1, 2] : [3, 4] }
    }));
    const provider = new GeminiProvider({ baseUrl: origin(fake), apiKey: secret });

    await expect(provider.embed({ model: "embedding-test", inputs: ["one", "two"], dimensions: 2 }, new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(fake.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1beta/models/embedding-test:embedContent",
        headers: expect.objectContaining({ "x-goog-api-key": secret, "content-type": "application/json" }),
        body: JSON.stringify({
          model: "models/embedding-test",
          content: { parts: [{ text: "one" }] },
          outputDimensionality: 2
        })
      }),
      expect.objectContaining({
        method: "POST",
        path: "/v1beta/models/embedding-test:embedContent",
        body: JSON.stringify({
          model: "models/embedding-test",
          content: { parts: [{ text: "two" }] },
          outputDimensionality: 2
        })
      })
    ]);
  });

  it("maps caller aborts to cancellation", async () => {
    const fake = await server(async (_request, response) => {
      await new Promise<void>((resolve) => response.once("close", resolve));
    });
    const provider = new GeminiProvider({ baseUrl: origin(fake), apiKey: secret });
    const controller = new AbortController();
    const pending = provider.discover(controller.signal);
    controller.abort();

    const error = await providerError(() => pending);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "CANCELLED" } });
  });

  it("rejects Gemini in-stream errors without finalizing partial output or retaining the message", async () => {
    const streamSecret = "gemini-stream-secret";
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n');
      response.end(`data: {"error":{"code":429,"message":"${streamSecret}","status":"RESOURCE_EXHAUSTED"}}\n\n`);
    });
    const provider = new GeminiProvider({ baseUrl: origin(fake), apiKey: secret });
    const events: GenerationEvent[] = [];

    const error = await providerError(async () => {
      for await (const event of provider.generate({
        model: "gemini-test", messages: [{ role: "user", content: "Hello" }]
      }, new AbortController().signal)) events.push(event);
    });
    expect(events).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(error.failure).toMatchObject({ fallbackEligible: true, error: { code: "RATE_LIMITED" } });
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
    const provider = new GeminiProvider({ baseUrl: origin(fake), apiKey: secret });

    const error = await providerError(() => provider.discover(new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible, error: { code } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
