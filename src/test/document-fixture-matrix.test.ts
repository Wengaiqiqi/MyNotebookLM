import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkBlocks } from "../workers/ingestion/chunker";
import { parseCsv } from "../workers/ingestion/parsers/csv-parser";
import { parseDocx } from "../workers/ingestion/parsers/docx-parser";
import { parseMarkdown } from "../workers/ingestion/parsers/markdown-parser";
import { parsePdf } from "../workers/ingestion/parsers/pdf-parser";
import { parsePptx } from "../workers/ingestion/parsers/pptx-parser";
import { parseText } from "../workers/ingestion/parsers/text-parser";
import { parseXlsx } from "../workers/ingestion/parsers/xlsx-parser";
import type { DocumentBlock } from "../workers/ingestion/types";
import { createUrlSource, type SafeHttpClient } from "../main/sources/url-source";

const FIXTURE_DIR = "src/test/fixtures/documents";

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURE_DIR}/${name}`));
}

async function expectChunkLocatorKinds(blocks: DocumentBlock[], allowedKinds: string[]) {
  const chunks = chunkBlocks(blocks);
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(allowedKinds).toContain(chunk.locator.kind);
    expect(chunk.text.length).toBeGreaterThan(0);
  }
  return chunks;
}

describe("document fixture matrix (all 8 source kinds)", () => {
  it("text: paragraph locators survive chunking", () => {
    const blocks = parseText(readFixture("sample.txt"));
    expect(blocks.map((b) => b.locator)).toEqual([
      { kind: "paragraph", paragraph: 1 },
      { kind: "paragraph", paragraph: 2 }
    ]);
    void expectChunkLocatorKinds(blocks, ["paragraph"]);
  });

  it("markdown: heading + offset locators survive chunking", () => {
    const blocks = parseMarkdown(readFixture("sample.md"));
    expect(blocks[0]).toMatchObject({
      kind: "heading",
      text: "根标题",
      locator: { kind: "heading", depth: 1, headingPath: "根标题" }
    });
    expect(blocks[1]).toMatchObject({
      kind: "heading",
      text: "子标题",
      locator: { kind: "heading", depth: 2, headingPath: "根标题 > 子标题" }
    });
    expect(blocks[2]).toMatchObject({
      kind: "paragraph",
      text: "根标题 > 子标题\n正文。",
      locator: { kind: "paragraph", paragraph: 1 }
    });
    void expectChunkLocatorKinds(blocks, ["heading", "paragraph", "offset"]);
  });

  it("pdf: page locators survive chunking", async () => {
    const blocks = await parsePdf(readFixture("sample.pdf"));
    expect(blocks.filter((b) => b.text.length > 0).map((b) => [b.text, b.locator])).toEqual([
      ["Page one", { kind: "page", page: 1 }],
      ["Page three", { kind: "page", page: 3 }]
    ]);
    void expectChunkLocatorKinds(blocks.filter((b) => b.text.length > 0), ["page"]);
  });

  it("docx: heading/paragraph/cell locators survive chunking", async () => {
    const blocks = await parseDocx(readFixture("sample.docx"));
    expect(blocks).toEqual([
      { kind: "heading", text: "Chapter", locator: { kind: "heading", depth: 1, headingPath: "Chapter" } },
      { kind: "paragraph", text: "Body", locator: { kind: "paragraph", paragraph: 1 } },
      { kind: "list", text: "Item", locator: { kind: "paragraph", paragraph: 2 } },
      { kind: "table", text: "A | B", locator: { kind: "cell", sheet: "Chapter", cellRef: "A1:A2" } }
    ]);
    void expectChunkLocatorKinds(blocks, ["heading", "paragraph", "cell"]);
  });

  it("pptx: slide locators survive chunking", async () => {
    const blocks = await parsePptx(readFixture("sample.pptx"));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.locator).toMatchObject({ kind: "slide" });
    }
    void expectChunkLocatorKinds(blocks, ["slide"]);
  });

  it("xlsx: row locators survive chunking", async () => {
    const blocks = await parseXlsx(readFixture("sample.xlsx"));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.locator).toMatchObject({ kind: "row", sheet: "Data" });
    }
    void expectChunkLocatorKinds(blocks, ["row"]);
  });

  it("csv: row locators with exact physical rows survive chunking", () => {
    const blocks = parseCsv(readFixture("sample.csv"));
    expect(blocks.map((b) => [b.text, b.locator])).toEqual([
      ["Name: Alice\nNote: hello, world", { kind: "row", sheet: "CSV", startRow: 2, endRow: 2 }],
      ["Name: Bob\nNote: line1\nline2", { kind: "row", sheet: "CSV", startRow: 3, endRow: 3 }]
    ]);
    void expectChunkLocatorKinds(blocks, ["row"]);
  });

  it("url: section locators with exact paths and url survive chunking", async () => {
    const html = readFileSync("src/test/fixtures/url/article.html", "utf8");
    const client: SafeHttpClient = {
      request: async (input) => {
        const url = new URL(String(input));
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          url: url.href,
          body: () => new TextEncoder().encode(html)
        };
      }
    };
    const source = createUrlSource({ resolver: async () => ["93.184.216.34"], client });
    const article = await source.fetch("https://blog.example/fixture");
    expect(article.title).toBe("安全导入：分布式系统演进");
    expect(article.sections.length).toBeGreaterThan(0);
    const paths = article.sections.map((s) => s.locator.sectionPath);
    expect(paths).toContain("第一章 概览 > 1.1 一致性模型");
    expect(paths).toContain("第一章 概览");
    for (const section of article.sections) {
      expect(section.locator).toMatchObject({ kind: "section", url: "https://blog.example/fixture" });
    }
  });
});
