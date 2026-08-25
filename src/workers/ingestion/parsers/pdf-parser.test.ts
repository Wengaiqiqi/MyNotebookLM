import { describe, expect, it } from "vitest";
import { parsePdf } from "./pdf-parser";
import { readFileSync } from "node:fs";

describe("parsePdf", () => {
  it("keeps page order and emits page locators, including empty pages", async () => {
    const blocks = await parsePdf(new Uint8Array(readFileSync("src/test/fixtures/documents/sample.pdf")));
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Page one", locator: { kind: "page", page: 1 } },
      { kind: "paragraph", text: "Page three", locator: { kind: "page", page: 3 } }
    ]);
  });
});
