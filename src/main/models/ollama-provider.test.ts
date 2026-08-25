import { afterEach, describe, expect, it } from "vitest";
import { OllamaProvider } from "./ollama-provider";
import { ProviderRequestError } from "./http-client";
import { sendJson, startFakeProviderServer, type FakeProviderServer } from "./test/fake-provider-server";

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

describe("Ollama provider", () => {
  it("uses Ollama's local address by default", () => {
    expect(new OllamaProvider().baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("discovers local models without authentication", async () => {
    const fake = await server((_request, response) => sendJson(response, {
      models: [{ name: "llama-test:latest" }, { model: "embed-test:latest" }]
    }));
    const provider = new OllamaProvider({ baseUrl: origin(fake) });

    await expect(provider.discover(new AbortController().signal)).resolves.toEqual([
      { id: "llama-test:latest", displayName: "llama-test:latest", capabilities: ["generation", "embedding"] },
      { id: "embed-test:latest", displayName: "embed-test:latest", capabilities: ["generation", "embedding"] }
    ]);
    expect(fake.requests).toEqual([expect.objectContaining({ method: "GET", path: "/api/tags" })]);
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(fake.requests[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("sends Ollama chat payloads and maps NDJSON text, usage, and completion", async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"message":{"role":"assistant","content":"Hel"},"done":false}\n');
      response.end('{"message":{"role":"assistant","content":"lo"},"done":true,"done_reason":"stop","prompt_eval_count":4,"eval_count":2}\n');
    });
    const provider = new OllamaProvider({ baseUrl: origin(fake) });
    const events = [];
    for await (const event of provider.generate({
      model: "llama-test",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.2,
      maxTokens: 50
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", inputTokens: 4, outputTokens: 2 },
      { type: "done", finishReason: "stop" }
    ]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/chat",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama-test",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        options: { temperature: 0.2, num_predict: 50 }
      })
    });
  });

  it("sends array embedding requests and returns array embeddings", async () => {
    const fake = await server((_request, response) => sendJson(response, { embeddings: [[1, 2], [3, 4]] }));
    const provider = new OllamaProvider({ baseUrl: origin(fake) });

    await expect(provider.embed({ model: "embed-test", inputs: ["one", "two"] }, new AbortController().signal))
      .resolves.toEqual([[1, 2], [3, 4]]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/embed",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embed-test", input: ["one", "two"] })
    });
  });

  it("maps caller aborts to cancellation", async () => {
    const fake = await server(async (_request, response) => {
      await new Promise<void>((resolve) => response.once("close", resolve));
    });
    const provider = new OllamaProvider({ baseUrl: origin(fake) });
    const controller = new AbortController();
    const pending = provider.discover(controller.signal);
    controller.abort();

    const error = await providerError(() => pending);
    expect(error.failure).toMatchObject({ fallbackEligible: false, error: { code: "CANCELLED" } });
  });

  it.each([
    [404, "NOT_FOUND", false],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER", true]
  ])("classifies HTTP %i without retaining response contents", async (status, code, fallbackEligible) => {
    const responseSecret = "ollama-response-secret";
    const fake = await server((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(responseSecret);
    });
    const provider = new OllamaProvider({ baseUrl: origin(fake) });

    const error = await providerError(() => provider.discover(new AbortController().signal));
    expect(error.failure).toMatchObject({ fallbackEligible, error: { code } });
    expect(JSON.stringify(error)).not.toContain(responseSecret);
  });
});
