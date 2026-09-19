import type { AppErrorDto } from "../../shared/app-errors";

export type ProviderFailure = Readonly<{
  error: AppErrorDto;
  fallbackEligible: boolean;
}>;

export type ProviderFailureInput = Readonly<{
  status?: number;
  headers?: Headers;
  body?: string;
  cause?: unknown;
  cancelled?: boolean;
  configuration?: boolean;
  timeout?: boolean;
  malformedResponse?: boolean;
  responseTooLarge?: boolean;
  /** Bounded, already-sanitized diagnostics from a classified provider failure. */
  details?: Record<string, string | number>;
}>;

function error(code: AppErrorDto["code"], messageKey: string, recoverable: boolean, retryAfterMs?: number): AppErrorDto {
  return retryAfterMs === undefined
    ? { code, messageKey, recoverable }
    : { code, messageKey, recoverable, retryAfterMs };
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Keeps only whitelisted, non-secret diagnostics. Raw provider text is never
 * echoed: it can contain the question, source text, or credentials.
 */
function withDetails(base: AppErrorDto, input: ProviderFailureInput): AppErrorDto {
  const details: Record<string, string | number> = {};
  for (const key of ["requestedTokens", "limitTokens"] as const) {
    const value = input.details?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) details[key] = value;
  }
  if (["context_length_exceeded", "max_tokens_exceeded"].includes(String(input.details?.providerCode))) details.providerCode = String(input.details!.providerCode);
  if (input.status !== undefined) details.status = input.status;
  return Object.keys(details).length === 0 ? base : { ...base, details };
}

/** Main-process-only metadata; only `error` is safe to send to the renderer. */
export function classifyProviderError(input: ProviderFailureInput): ProviderFailure {
  if (input.cancelled) return { error: error("CANCELLED", "errors.cancelled", false), fallbackEligible: false };
  if (input.configuration) return { error: error("VALIDATION", "errors.configuration", false), fallbackEligible: false };
  if (input.timeout) return { error: error("TIMEOUT", "errors.timeout", true), fallbackEligible: true };
  if (input.malformedResponse) return { error: error("PROVIDER", "errors.provider", false), fallbackEligible: false };
  if (input.responseTooLarge) return { error: error("PROVIDER", "errors.responseTooLarge", false), fallbackEligible: false };
  switch (input.status) {
    case 401:
    case 403:
      return { error: error("AUTH", "errors.authentication", false), fallbackEligible: false };
    case 404:
      return { error: error("NOT_FOUND", "errors.modelNotFound", false), fallbackEligible: false };
    case 429:
      return {
        error: error("RATE_LIMITED", "errors.rateLimited", true, retryAfterMs(input.headers)),
        fallbackEligible: true
      };
  }
  const body = input.body?.toLowerCase() ?? "";
  if (body.includes("context_length_exceeded") || body.includes("context window") || body.includes("maximum context") || body.includes("prompt is too long")) {
    return { error: withDetails(error("VALIDATION", "errors.contextBudgetExceeded", true), input), fallbackEligible: true };
  }
  if ((body.includes("max_tokens") || body.includes("max_output_tokens") || body.includes("maxtokens") || body.includes("maxoutputtokens") || body.includes("max_completion_tokens")) && (body.includes("too large") || body.includes("exceed") || body.includes("maximum"))) {
    return { error: withDetails(error("VALIDATION", "errors.generationOutputRejected", true), input), fallbackEligible: false };
  }

  switch (input.status) {
    default:
      if (input.status !== undefined && input.status >= 500) {
        return { error: error("PROVIDER", "errors.provider", true), fallbackEligible: true };
      }
      if (input.status !== undefined) {
        return { error: error("PROVIDER", "errors.provider", false), fallbackEligible: false };
      }
      return { error: error("NETWORK", "errors.network", true), fallbackEligible: true };
  }
}
