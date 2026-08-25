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

  it("detects semicolon and pipe delimiters without being fooled by candidate characters", () => {
    expect(parseCsv("Name;Note\nAlice;hello | world\n")).toMatchObject([
      { text: "Name: Alice\nNote: hello | world" }
    ]);
    expect(parseCsv("Name|Note\nAlice|hello;world\n")).toMatchObject([
      { text: "Name: Alice\nNote: hello;world" }
    ]);
  });

  it("does not invent a delimiter for single-column or ambiguous data", () => {
    expect(parseCsv("Name\nAlice\nBob\n")).toEqual([
      { kind: "sheet-row", text: "Name: Alice", locator: { kind: "row", sheet: "CSV", startRow: 2, endRow: 2 } },
      { kind: "sheet-row", text: "Name: Bob", locator: { kind: "row", sheet: "CSV", startRow: 3, endRow: 3 } }
    ]);
    expect(parseCsv("A,B\n1,2\n")).toHaveLength(1);
  });
});
