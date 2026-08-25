import { describe, expect, it } from "vitest";
import { parseDocx } from "./docx-parser";
import { readFileSync } from "node:fs";

describe("parseDocx", () => {
  it("preserves document order and emits the real table cell range", async () => {
    const blocks = await parseDocx(new Uint8Array(readFileSync("src/test/fixtures/documents/sample.docx")));
    expect(blocks).toEqual([
      { kind: "heading", text: "Chapter", locator: { kind: "heading", depth: 1, headingPath: "Chapter" } },
      { kind: "paragraph", text: "Body", locator: { kind: "paragraph", paragraph: 1 } },
      { kind: "list", text: "Item", locator: { kind: "paragraph", paragraph: 2 } },
      { kind: "table", text: "A | B", locator: { kind: "cell", sheet: "Chapter", cellRef: "A1:A2" } }
    ]);
  });
});
