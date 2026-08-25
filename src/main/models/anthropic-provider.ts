import { ProviderHttpClient, ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";
import type {
  EmbeddingRequest,
  GenerateRequest,
  GenerationEvent,
  ModelDescriptor,
  ModelProvider
} from "./provider";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicProviderOptions = Readonly<{
  baseUrl?: string;
  apiKey?: string;
}>;

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

function anthropicStreamError(value: unknown): ProviderRequestError {
  if (!isRecord(value) || typeof value.type !== "string") return malformedResponse();
  const status = {
    invalid_request_error: 400,
    authentication_error: 401,
    billing_error: 403,
    permission_error: 403,
    not_found_error: 404,
    rate_limit_error: 429,
    api_error: 500,
    overloaded_error: 503
  }[value.type] ?? 500;
  return new ProviderRequestError(classifyProviderError({ status }));
}

export class AnthropicProvider implements ModelProvider {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly client = new ProviderHttpClient();

  constructor(options: AnthropicProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? ANTHROPIC_BASE_URL;
    this.apiKey = options.apiKey;
  }

  async discover(signal: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.client.json<unknown>(this.baseUrl, "/v1/models", {
      method: "GET",
      headers: this.headers(),
      signal
    });
    if (!isRecord(response) || !Array.isArray(response.data)) throw malformedResponse();
    return response.data.map((model) => {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) throw malformedResponse();
      if (model.display_name !== undefined && typeof model.display_name !== "string") throw malformedResponse();
      return {
        id: model.id,
        displayName: model.display_name || model.id,
        capabilities: ["generation"]
      };
    });
  }

  async *generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const body = {
      model: request.model,
      messages: request.messages.filter((message) => message.role !== "system"),
      stream: true,
      max_tokens: request.maxTokens ?? 1024,
      ...(system ? { system } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature })
    };
    let emittedDone = false;
    for await (const event of this.client.sse<unknown>(this.baseUrl, "/v1/messages", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal
    })) {
      if (!isRecord(event) || typeof event.type !== "string") throw malformedResponse();
      if (event.type === "error") {
        throw anthropicStreamError(event.error);
      } else if (event.type === "message_start") {
        if (!isRecord(event.message) || !isRecord(event.message.usage)) throw malformedResponse();
        const inputTokens = optionalFiniteNumber(event.message.usage.input_tokens);
        if (inputTokens !== undefined) yield { type: "usage", inputTokens };
      } else if (event.type === "content_block_delta") {
        if (!isRecord(event.delta)) throw malformedResponse();
        if (event.delta.type === "text_delta") {
          if (typeof event.delta.text !== "string") throw malformedResponse();
          if (event.delta.text) yield { type: "text-delta", text: event.delta.text };
        }
      } else if (event.type === "message_delta") {
        if (!isRecord(event.delta)) throw malformedResponse();
        if (event.usage !== undefined) {
          if (!isRecord(event.usage)) throw malformedResponse();
          const outputTokens = optionalFiniteNumber(event.usage.output_tokens);
          if (outputTokens !== undefined) yield { type: "usage", outputTokens };
        }
        if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
          if (typeof event.delta.stop_reason !== "string") throw malformedResponse();
          emittedDone = true;
          yield { type: "done", finishReason: event.delta.stop_reason };
        }
      } else if (event.type === "message_stop" && !emittedDone) {
        emittedDone = true;
        yield { type: "done" };
      }
    }
    if (!emittedDone) yield { type: "done" };
  }

  async embed(_request: EmbeddingRequest, _signal: AbortSignal): Promise<number[][]> {
    throw new ProviderRequestError(classifyProviderError({ configuration: true }));
  }

  private headers(json = false): Headers {
    const headers = new Headers({ "anthropic-version": ANTHROPIC_VERSION });
    if (json) headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    return headers;
  }
}
