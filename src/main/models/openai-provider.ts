import { ProviderHttpClient } from "./http-client";
import { isRecord, malformedResponse, optionalFiniteNumber } from "./provider-guards";
import type {
  EmbeddingRequest,
  GenerateRequest,
  GenerationEvent,
  ModelDescriptor,
  ModelProvider
} from "./provider";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export type OpenAiProviderOptions = Readonly<{
  baseUrl?: string;
  apiKey?: string;
}>;

export class OpenAiProvider implements ModelProvider {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly client: ProviderHttpClient;

  constructor(options: OpenAiProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
    this.apiKey = options.apiKey;
    this.client = new ProviderHttpClient();
  }

  async discover(signal: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.client.json<unknown>(this.baseUrl, "/models", {
      method: "GET",
      headers: this.headers(),
      signal
    });
    if (!isRecord(response) || !Array.isArray(response.data)) throw malformedResponse();
    return response.data.map((model) => {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) throw malformedResponse();
      return {
        id: model.id,
        displayName: model.id,
        capabilities: [],
        capabilityEvidence: "probe-required"
      };
    });
  }

  async *generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const body = {
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens })
    };
    let finishReason: string | undefined;
    for await (const chunk of this.client.sse<unknown>(this.baseUrl, "/chat/completions", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal
    })) {
      if (!isRecord(chunk)) throw malformedResponse();
      const choices = chunk.choices;
      const finishReasons: string[] = [];
      if (choices !== undefined) {
        if (!Array.isArray(choices)) throw malformedResponse();
        if (finishReason !== undefined && choices.length > 0) throw malformedResponse();
        for (const choice of choices) {
          if (!isRecord(choice)) throw malformedResponse();
          if (choice.delta !== undefined) {
            if (!isRecord(choice.delta)) throw malformedResponse();
            const content = choice.delta.content;
            if (content !== undefined && typeof content !== "string") throw malformedResponse();
            if (content) yield { type: "text-delta", text: content };
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (typeof choice.finish_reason !== "string") throw malformedResponse();
            finishReasons.push(choice.finish_reason);
          }
        }
      }
      if (finishReasons.length > 1 || (finishReason !== undefined && finishReasons.length > 0)) {
        throw malformedResponse();
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        if (!isRecord(chunk.usage)) throw malformedResponse();
        const inputTokens = optionalFiniteNumber(chunk.usage.prompt_tokens);
        const outputTokens = optionalFiniteNumber(chunk.usage.completion_tokens);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          yield {
            type: "usage",
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens })
          };
        }
      }
      if (finishReasons.length) finishReason = finishReasons[0];
    }
    if (finishReason === undefined) throw malformedResponse();
    yield { type: "done", finishReason };
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<number[][]> {
    const body = {
      model: request.model,
      input: request.inputs,
      ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions })
    };
    const response = await this.client.json<unknown>(this.baseUrl, "/embeddings", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal
    });
    if (!isRecord(response) || !Array.isArray(response.data) || response.data.length !== request.inputs.length) {
      throw malformedResponse();
    }
    const vectors: Array<number[] | undefined> = Array(request.inputs.length);
    let dimension: number | undefined;
    for (const item of response.data) {
      if (!isRecord(item) || typeof item.index !== "number" || !Number.isInteger(item.index)) {
        throw malformedResponse();
      }
      const index = item.index;
      if (index < 0 || index >= vectors.length || vectors[index]) {
        throw malformedResponse();
      }
      if (!Array.isArray(item.embedding) || item.embedding.length === 0 || !item.embedding.every(Number.isFinite)) {
        throw malformedResponse();
      }
      if (dimension !== undefined && dimension !== item.embedding.length) throw malformedResponse();
      dimension = item.embedding.length;
      vectors[index] = item.embedding as number[];
    }
    if (vectors.some((vector) => vector === undefined)) throw malformedResponse();
    return vectors as number[][];
  }

  private headers(json = false): Headers {
    const headers = new Headers();
    if (json) headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    return headers;
  }
}

export class OpenAiCompatibleProvider extends OpenAiProvider {}
