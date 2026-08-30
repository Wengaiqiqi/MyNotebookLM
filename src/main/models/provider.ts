import type { CapabilityEvidence, ModelCapability } from "../../shared/models";

export type ChatTurn = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export interface ModelDescriptor {
  id: string;
  displayName: string;
  capabilities: ModelCapability[];
  capabilityEvidence?: CapabilityEvidence;
}

export interface GenerateRequest {
  model: string;
  messages: ChatTurn[];
  temperature?: number;
  maxTokens?: number;
  /** Reasoning level; each provider family maps this to its own wire format. */
  thinking?: "off" | "low" | "medium" | "high";
}

export interface EmbeddingRequest {
  model: string;
  inputs: string[];
  dimensions?: number;
}

export type GenerationEvent =
  | { type: "text-delta"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "done"; finishReason?: string };

export interface ModelProvider {
  discover(signal: AbortSignal): Promise<ModelDescriptor[]>;
  generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<number[][]>;
}
