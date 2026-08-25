import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv-parser";

describe("parseCsv", () => {
  it("detects delimiters, preserves quoted commas/newlines, headers, and row ranges", () => {
    expect(parseCsv(`Name,Note\r\nAlice,"hello, world"\r\nBob,"line1\nline2"\r\n`))
      .toMatchSnapshot();
  });

  it("keeps physical row numbers across blank CSV lines and detects tabs", () => {
    expect(parseCsv("Name\tNote\n\nAlice\thello\nBob\tworld\n").map((b) => b.locator))
      .toEqual([
        { kind: "row", sheet: "CSV", startRow: 3, endRow: 3 },
        { kind: "row", sheet: "CSV", startRow: 4, endRow: 4 }
      ]);
  });
});
