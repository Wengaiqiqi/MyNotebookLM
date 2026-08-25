import { ProviderHttpClient, ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";
import type { ModelCapability } from "../../shared/models";
import type {
  EmbeddingRequest,
  GenerateRequest,
  GenerationEvent,
  ModelDescriptor,
  ModelProvider
} from "./provider";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

export type GeminiProviderOptions = Readonly<{
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

function modelName(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function vector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Number.isFinite)) throw malformedResponse();
  return value as number[];
}

export class GeminiProvider implements ModelProvider {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly client = new ProviderHttpClient();

  constructor(options: GeminiProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.apiKey = options.apiKey;
  }

  async discover(signal: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.client.json<unknown>(this.baseUrl, "/v1beta/models", {
      method: "GET",
      headers: this.headers(),
      signal
    });
    if (!isRecord(response) || !Array.isArray(response.models)) throw malformedResponse();
    const descriptors: ModelDescriptor[] = [];
    for (const model of response.models) {
      if (!isRecord(model) || typeof model.name !== "string" || !model.name || !Array.isArray(model.supportedGenerationMethods)) {
        throw malformedResponse();
      }
      if (!model.supportedGenerationMethods.every((method) => typeof method === "string")) throw malformedResponse();
      if (model.displayName !== undefined && typeof model.displayName !== "string") throw malformedResponse();
      const capabilities: ModelCapability[] = [];
      if (model.supportedGenerationMethods.includes("generateContent")) capabilities.push("generation");
      if (model.supportedGenerationMethods.includes("embedContent")) capabilities.push("embedding");
      if (capabilities.length) descriptors.push({
        id: model.name,
        displayName: model.displayName || model.name,
        capabilities
      });
    }
    return descriptors;
  }

  async *generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const systemParts = request.messages.filter((message) => message.role === "system").map((message) => ({ text: message.content }));
    const generationConfig = {
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens })
    };
    const body = {
      contents: request.messages.filter((message) => message.role !== "system").map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      })),
      ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
    };
    let emittedDone = false;
    for await (const chunk of this.client.sse<unknown>(
      this.baseUrl,
      `/v1beta/${modelName(request.model)}:streamGenerateContent?alt=sse`,
      { method: "POST", headers: this.headers(true), body: JSON.stringify(body), signal }
    )) {
      if (!isRecord(chunk)) throw malformedResponse();
      const finishReasons: string[] = [];
      if (chunk.candidates !== undefined) {
        if (!Array.isArray(chunk.candidates)) throw malformedResponse();
        for (const candidate of chunk.candidates) {
          if (!isRecord(candidate)) throw malformedResponse();
          if (candidate.content !== undefined) {
            if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) throw malformedResponse();
            for (const part of candidate.content.parts) {
              if (!isRecord(part) || typeof part.text !== "string") throw malformedResponse();
              if (part.text) yield { type: "text-delta", text: part.text };
            }
          }
          if (candidate.finishReason !== undefined) {
            if (typeof candidate.finishReason !== "string") throw malformedResponse();
            finishReasons.push(candidate.finishReason);
          }
        }
      }
      if (chunk.usageMetadata !== undefined) {
        if (!isRecord(chunk.usageMetadata)) throw malformedResponse();
        const inputTokens = optionalFiniteNumber(chunk.usageMetadata.promptTokenCount);
        const outputTokens = optionalFiniteNumber(chunk.usageMetadata.candidatesTokenCount);
        if (inputTokens !== undefined || outputTokens !== undefined) yield {
          type: "usage",
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens })
        };
      }
      for (const finishReason of finishReasons) {
        emittedDone = true;
        yield { type: "done", finishReason };
      }
    }
    if (!emittedDone) yield { type: "done" };
  }

  async embed(request: EmbeddingRequest, signal: AbortSignal): Promise<number[][]> {
    const name = modelName(request.model);
    const embeddings: number[][] = [];
    let dimension: number | undefined;
    for (const input of request.inputs) {
      const response = await this.client.json<unknown>(this.baseUrl, `/v1beta/${name}:embedContent`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          model: name,
          content: { parts: [{ text: input }] },
          ...(request.dimensions === undefined ? {} : { outputDimensionality: request.dimensions })
        }),
        signal
      });
      if (!isRecord(response) || !isRecord(response.embedding)) throw malformedResponse();
      const embedding = vector(response.embedding.values);
      if (dimension !== undefined && embedding.length !== dimension) throw malformedResponse();
      dimension = embedding.length;
      embeddings.push(embedding);
    }
    return embeddings;
  }

  private headers(json = false): Headers {
    const headers = new Headers();
    if (json) headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("x-goog-api-key", this.apiKey);
    return headers;
  }
}
