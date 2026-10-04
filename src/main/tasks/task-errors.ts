import type { AppErrorCode } from "../../shared/app-errors";

// Used by both live task transitions and the durable task list. Provider text
// must never cross this boundary, while known application errors stay intact.
const MESSAGE_KEYS = new Set([
  "errors.mindMapInvalidJson", "errors.mindMapInvalidStructure", "errors.mindMapInvalidReferences", "errors.mindMapInvalid",
  "errors.transformationOutputIncomplete", "errors.transformationReductionFailed", "errors.contextBudgetExceeded", "errors.outputLimitEmpty",
  "errors.generationOutputRejected", "errors.generationProfileMissing", "errors.configuration", "errors.modelNotFound", "errors.providerFailure",
  "errors.interrupted", "errors.internal", "errors.validation", "errors.notFound", "errors.conflict", "errors.cancelled",
  "errors.auth", "errors.authentication", "errors.credentialUnreadable", "errors.rateLimited", "errors.timeout", "errors.network",
  "errors.provider", "errors.unsupportedFormat", "errors.unsafeInput", "errors.indexUnavailable", "errors.modelCapability",
  "errors.embeddingProfileUnavailable", "errors.taskConflict", "errors.embeddingRejected"
]);

export function safeTaskMessageKey(code: AppErrorCode, value: unknown): string {
  if (typeof value === "string" && MESSAGE_KEYS.has(value)) return value;
  return ({ UNSAFE_INPUT: "errors.unsafeInput", UNSUPPORTED_FORMAT: "errors.unsupportedFormat", RATE_LIMITED: "errors.rateLimited",
    INDEX_UNAVAILABLE: "errors.indexUnavailable", INTERNAL: "errors.internal" } as Partial<Record<AppErrorCode, string>>)[code] ?? `errors.${code.toLowerCase()}`;
}
