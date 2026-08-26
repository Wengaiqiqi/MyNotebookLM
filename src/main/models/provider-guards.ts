import { ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function malformedResponse(): ProviderRequestError {
  return new ProviderRequestError(classifyProviderError({ malformedResponse: true }));
}

export function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw malformedResponse();
  return value;
}
