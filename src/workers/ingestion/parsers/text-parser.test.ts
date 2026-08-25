import { describe, expect, it } from "vitest";
import { parseText } from "./text-parser";

describe("parseText", () => {
  it("normalizes BOM and CRLF, skips blank paragraphs, and locates paragraphs", () => {
    expect(parseText("\uFEFFone\r\n\r\ntwo\n\n")).toEqual([
      { kind: "paragraph", text: "one", locator: { kind: "paragraph", paragraph: 1 } },
      { kind: "paragraph", text: "two", locator: { kind: "paragraph", paragraph: 2 } }
    ]);
  });
});
