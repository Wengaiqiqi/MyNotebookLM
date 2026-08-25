import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  canRetry,
  isRetryableCode,
  retryDelayMs
} from "./retry-policy";

describe("isRetryableCode", () => {
  it.each([
    ["AUTH", false],
    ["VALIDATION", false],
    ["UNSAFE_INPUT", false],
    ["UNSUPPORTED_FORMAT", false],
    ["CANCELLED", false],
    ["NOT_FOUND", false],
    ["CONFLICT", false],
    ["INDEX_UNAVAILABLE", false],
    ["INTERNAL", false],
    ["RATE_LIMITED", true],
    ["TIMEOUT", true],
    ["NETWORK", true],
    ["PROVIDER", true]
  ] as const)("classifies %s as retryable=%s", (code, expected) => {
    expect(isRetryableCode(code)).toBe(expected);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially with a zero-jitter clock", () => {
    const noJitter = () => 0;
    expect(retryDelayMs(1, noJitter)).toBe(1000);
    expect(retryDelayMs(2, noJitter)).toBe(2000);
    expect(retryDelayMs(3, noJitter)).toBe(4000);
    expect(retryDelayMs(4, noJitter)).toBe(8000);
    expect(retryDelayMs(5, noJitter)).toBe(16000);
  });

  it("caps at the fifth attempt", () => {
    const noJitter = () => 0;
    expect(retryDelayMs(6, noJitter)).toBe(16000);
    expect(retryDelayMs(50, noJitter)).toBe(16000);
  });

  it("keeps jitter bounded below the next order of magnitude", () => {
    const fullJitter = () => 1;
    expect(retryDelayMs(1, fullJitter)).toBeLessThan(2000);
    expect(retryDelayMs(2, fullJitter)).toBeLessThan(4000);
    expect(retryDelayMs(5, fullJitter)).toBeLessThan(32000);
  });
});

describe("canRetry / MAX_ATTEMPTS", () => {
  it("exposes a five-attempt ceiling", () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it("allows retry only below the attempt ceiling", () => {
    expect(canRetry(0)).toBe(true);
    expect(canRetry(1)).toBe(true);
    expect(canRetry(4)).toBe(true);
    expect(canRetry(5)).toBe(false);
    expect(canRetry(6)).toBe(false);
  });
});
