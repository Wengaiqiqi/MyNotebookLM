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

/** Main-process-only metadata; only `error` is safe to send to the renderer. */
export function classifyProviderError(input: ProviderFailureInput): ProviderFailure {
  if (input.cancelled) return { error: error("CANCELLED", "errors.cancelled", false), fallbackEligible: false };
  if (input.configuration) return { error: error("VALIDATION", "errors.configuration", false), fallbackEligible: false };
  if (input.timeout) return { error: error("TIMEOUT", "errors.timeout", true), fallbackEligible: true };
  if (input.malformedResponse) return { error: error("PROVIDER", "errors.provider", false), fallbackEligible: false };

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
