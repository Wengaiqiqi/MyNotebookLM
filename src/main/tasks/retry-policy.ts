import type { AppErrorCode } from "../../shared/app-errors";

export const MAX_ATTEMPTS = 5;

const RETRYABLE_CODES: ReadonlySet<AppErrorCode> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "PROVIDER"
]);

export function isRetryableCode(code: AppErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 4);
  const base = 1000 * 2 ** exponent;
  return Math.floor(base * (1 + random() * 0.5));
}

export function canRetry(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}
