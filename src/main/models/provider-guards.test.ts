import { describe, expect, it } from "vitest";
import { optionalFiniteNumber } from "./provider-guards";

describe("provider usage guards", () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid token count %s",
    (value) => {
      expect(() => optionalFiniteNumber(value)).toThrow();
    }
  );

  it.each([0, 2])("accepts non-negative integer token count %s", (value) => {
    expect(optionalFiniteNumber(value)).toBe(value);
  });
});
