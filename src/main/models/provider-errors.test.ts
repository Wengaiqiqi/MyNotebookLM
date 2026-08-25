import { describe, expect, it } from "vitest";
import { classifyProviderError } from "./provider-errors";

describe("classifyProviderError", () => {
  it.each([
    [401, "AUTH", false],
    [403, "AUTH", false],
    [404, "NOT_FOUND", false],
    [429, "RATE_LIMITED", true],
    [503, "PROVIDER", true]
  ] as const)("classifies HTTP %i without exposing its response body", (status, code, fallbackEligible) => {
    const failure = classifyProviderError({
      status,
      headers: new Headers({ "retry-after": "3" }),
      body: "Authorization: Bearer secret-token"
    });

    expect(failure.error.code).toBe(code);
    expect(failure.fallbackEligible).toBe(fallbackEligible);
    expect(JSON.stringify(failure.error)).not.toContain("secret-token");
  });

  it("marks timeout and network failures as fallback eligible", () => {
    expect(classifyProviderError({ timeout: true })).toMatchObject({
      fallbackEligible: true,
      error: { code: "TIMEOUT" }
    });
    expect(classifyProviderError({ cause: new TypeError("socket failed") })).toMatchObject({
      fallbackEligible: true,
      error: { code: "NETWORK" }
    });
  });

  it("keeps explicit cancellation out of fallback", () => {
    expect(classifyProviderError({ cancelled: true })).toEqual({
      fallbackEligible: false,
      error: { code: "CANCELLED", messageKey: "errors.cancelled", recoverable: false }
    });
  });

  it("keeps local configuration failures out of fallback", () => {
    expect(classifyProviderError({ configuration: true })).toMatchObject({
      fallbackEligible: false,
      error: { code: "VALIDATION", messageKey: "errors.configuration" }
    });
  });

  it("normalizes malformed provider payloads without retaining secret text", () => {
    const failure = classifyProviderError({ malformedResponse: true, body: '{"api_key":"secret-token"}' });

    expect(failure).toMatchObject({
      fallbackEligible: false,
      error: { code: "PROVIDER", messageKey: "errors.provider" }
    });
    expect(JSON.stringify(failure)).not.toContain("secret-token");
  });
});
