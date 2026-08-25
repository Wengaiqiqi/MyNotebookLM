import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown-parser";

describe("parseMarkdown", () => {
  it("emits heading ancestry, list, code and table text", () => {
    expect(parseMarkdown("# Root\n## Child\nbody\n- one\n- two\n```ts\nconst x = 1;\n```\n| A | B |\n|---|---|\n| 1 | 2 |"))
      .toMatchSnapshot();
  });

  it("merges multiline paragraphs, uses half-open offsets, and avoids table false positives", () => {
    const blocks = parseMarkdown("first line\nsecond line\n\nlabel | value\nnot a separator\n");
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "first line\nsecond line", locator: { kind: "paragraph", paragraph: 1 } });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", text: "label | value\nnot a separator" });
    expect(blocks[1]!.locator).toEqual({ kind: "paragraph", paragraph: 2 });
  });

  it("emits fenced code as a paragraph block with its source offset", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n```\n");
    expect(blocks[0]).toEqual({ kind: "paragraph", text: "const x = 1;", locator: { kind: "offset", start: 0, end: 23 } });
  });

  it("uses original UTF-16 half-open offsets for BOM and CRLF input", () => {
    const source = "\uFEFF# Title\r\n\r\n```\r\ncode\r\n```\r\n";
    expect(parseMarkdown(source)).toContainEqual({
      kind: "paragraph",
      text: "code",
      locator: { kind: "offset", start: 12, end: 28 }
    });
  });
});
