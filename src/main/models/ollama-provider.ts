import { ProviderHttpClient, ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";
import type {
  EmbeddingRequest,
  GenerateRequest,
  GenerationEvent,
  ModelDescriptor,
  ModelProvider
} from "./provider";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export type OllamaProviderOptions = Readonly<{ baseUrl?: string }>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedResponse(): ProviderRequestError {
  return new ProviderRequestError(classifyProviderError({ malformedResponse: true }));
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformedResponse();
  return value;
}

function embeddings(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) throw malformedResponse();
  let dimension: number | undefined;
  return value.map((item) => {
    if (!Array.isArray(item) || item.length === 0 || !item.every(Number.isFinite)) throw malformedResponse();
    if (dimension !== undefined && item.length !== dimension) throw malformedResponse();
    dimension = item.length;
    return item as number[];
  });
}

export class OllamaProvider implements ModelProvider {
  readonly baseUrl: string;
  private readonly client = new ProviderHttpClient();

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? OLLAMA_BASE_URL;
  }

  async discover(signal: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.client.json<unknown>(this.baseUrl, "/api/tags", { method: "GET", signal });
    if (!isRecord(response) || !Array.isArray(response.models)) throw malformedResponse();
    return response.models.map((model) => {
      if (!isRecord(model)) throw malformedResponse();
      const id = typeof model.name === "string" && model.name ? model.name : model.model;
      if (typeof id !== "string" || !id) throw malformedResponse();
      return { id, displayName: id, capabilities: ["generation", "embedding"] };
    });
  }

  async *generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const options = {
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens })
    };
    const body = {
      model: request.model,
      messages: request.messages,
      stream: true,
      ...(Object.keys(options).length ? { options } : {})
    };
    let emittedDone = false;
    for await (const chunk of this.client.ndjson<unknown>(this.baseUrl, "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    })) {
      if (!isRecord(chunk)) throw malformedResponse();
      if (chunk.error !== undefined) {
        if (typeof chunk.error !== "string") throw malformedResponse();
        throw new ProviderRequestError(classifyProviderError({ status: 500 }));
      }
      if (chunk.message !== undefined) {
        if (!isRecord(chunk.message) || typeof chunk.message.content !== "string") throw malformedResponse();
        if (chunk.message.content) yield { type: "text-delta", text: chunk.message.content };
      }
      if (chunk.done === true) {
        const inputTokens = optionalFiniteNumber(chunk.prompt_eval_count);
        const outputTokens = optionalFiniteNumber(chunk.eval_count);
        if (inputTokens !== undefined || outputTokens !== undefined) yield {
          type: "usage",
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens })
        };
        if (chunk.done_reason !== undefined && typeof chunk.done_reason !== "string") throw malformedResponse();
        emittedDone = true;
        yield chunk.done_reason === undefined
          ? { type: "done" }
          : { type: "done", finishReason: chunk.done_reason };
      }
    }
    if (!emittedDone) yield { type: "done" };
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<number[][]> {
    const response = await this.client.json<unknown>(this.baseUrl, "/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        input: request.inputs,
        ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions })
      }),
      signal
    });
    if (!isRecord(response)) throw malformedResponse();
    return embeddings(response.embeddings, request.inputs.length);
  }
}
