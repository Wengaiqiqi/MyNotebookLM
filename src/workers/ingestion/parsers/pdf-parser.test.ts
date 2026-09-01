import { describe, expect, it } from "vitest";
import { parsePdf, splitPdfQuestions } from "./pdf-parser";
import { readFileSync } from "node:fs";

describe("parsePdf", () => {
  it("keeps page order and emits page locators, including empty pages", async () => {
    const blocks = await parsePdf(new Uint8Array(readFileSync("src/test/fixtures/documents/sample.pdf")));
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Page one", locator: { kind: "page", page: 1 } },
      { kind: "paragraph", text: "", locator: { kind: "page", page: 2 } },
      { kind: "paragraph", text: "Page three", locator: { kind: "page", page: 3 } }
    ]);
  });

  it("keeps subquestions under the same major question across pages", () => {
    expect([
      ...splitPdfQuestions("上一题结尾 第 2 题（11分） 2-1 第一小题", 2),
      ...splitPdfQuestions("2-2 第二小题 第 3 题 (9 points) 3-1 下一题", 3)
    ]).toEqual([
      { kind: "paragraph", text: "上一题结尾", locator: { kind: "page", page: 2 } },
      { kind: "heading", text: "第 2 题（11分）", locator: { kind: "heading", depth: 1, headingPath: "第 2 题（11分）" } },
      { kind: "paragraph", text: "2-1 第一小题", locator: { kind: "page", page: 2 } },
      { kind: "paragraph", text: "2-2 第二小题", locator: { kind: "page", page: 3 } },
      { kind: "heading", text: "第 3 题 (9 points)", locator: { kind: "heading", depth: 1, headingPath: "第 3 题 (9 points)" } },
      { kind: "paragraph", text: "3-1 下一题", locator: { kind: "page", page: 3 } }
    ]);
  });
});
