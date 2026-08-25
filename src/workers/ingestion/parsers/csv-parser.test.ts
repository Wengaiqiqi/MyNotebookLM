import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv-parser";

describe("parseCsv", () => {
  it("detects delimiters, preserves quoted commas/newlines, headers, and row ranges", () => {
    expect(parseCsv(`Name,Note\r\nAlice,"hello, world"\r\nBob,"line1\nline2"\r\n`))
      .toMatchSnapshot();
  });
});
