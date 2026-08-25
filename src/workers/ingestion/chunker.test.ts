import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DocumentBlock } from "./types";
import { CHUNKING_VERSION, chunkBlocks, estimateTokens } from "./chunker";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../test/fixtures/text/bilingual-sample.txt", import.meta.url)
);

function makeParagraphs(count: number, wordsPerBlock: number): DocumentBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "paragraph" as const,
    text: Array.from({ length: wordsPerBlock }, (_, j) => `w${i}-${j}`).join(" "),
    locator: { kind: "paragraph" as const, paragraph: i + 1 }
  }));
}

function fixtureToBlocks(raw: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let paragraph = 0;
  let offset = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("|");
    if (sep < 0) continue;
    const kind = trimmed.slice(0, sep);
    const content = trimmed.slice(sep + 1);
    let block: DocumentBlock;
    switch (kind) {
      case "heading":
        block = { kind: "heading", text: content, locator: { kind: "heading", depth: 2, headingPath: content } };
        break;
      case "table":
        block = { kind: "table", text: content, locator: { kind: "offset", start: offset, end: offset + content.length + 1 } };
        break;
      case "list":
        block = { kind: "list", text: content, locator: { kind: "offset", start: offset, end: offset + content.length + 1 } };
        break;
      case "sheet-row":
        block = { kind: "sheet-row", text: content, locator: { kind: "row", sheet: "Sheet1", startRow: 1, endRow: 1 } };
        break;
      default:
        paragraph += 1;
        block = { kind: "paragraph", text: content, locator: { kind: "paragraph", paragraph } };
        break;
    }
    blocks.push(block);
    offset += content.length + 1;
  }
  return blocks;
}

describe("estimateTokens", () => {
  it("counts CJK code points directly", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("这是一个测试")).toBe(6);
  });

  it("inflates non-CJK words by ceil(wordCount * 1.3)", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a")).toBe(2);
  });

  it("mixes CJK code points and non-CJK words", () => {
    expect(estimateTokens("hello 你好 world")).toBe(5);
  });

  it("treats empty text as zero", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("CHUNKING_VERSION", () => {
  it("records the blocks-900-150-v1 contract", () => {
    expect(CHUNKING_VERSION).toBe("blocks-900-150-v1");
  });
});

describe("chunkBlocks locator range merging", () => {
  it("merges consecutive offset locators into a single start/end range", () => {
    const blocks: DocumentBlock[] = [
      { kind: "paragraph", text: "alpha", locator: { kind: "offset", start: 0, end: 10 } },
      { kind: "paragraph", text: "beta", locator: { kind: "offset", start: 10, end: 20 } },
      { kind: "paragraph", text: "gamma", locator: { kind: "offset", start: 20, end: 40 } }
    ];
    const chunks = chunkBlocks(blocks);
    expect(chunks[0]?.locator).toEqual({ kind: "offset", start: 0, end: 40 });
  });

  it("merges consecutive row locators with the same sheet into a row range", () => {
    const blocks: DocumentBlock[] = [
      { kind: "sheet-row", text: "alpha", locator: { kind: "row", sheet: "Sheet1", startRow: 1, endRow: 2 } },
      { kind: "sheet-row", text: "beta", locator: { kind: "row", sheet: "Sheet1", startRow: 3, endRow: 5 } }
    ];
    const chunks = chunkBlocks(blocks);
    expect(chunks[0]?.locator).toEqual({ kind: "row", sheet: "Sheet1", startRow: 1, endRow: 5 });
  });

  it("keeps the first locator when block kinds differ", () => {
    const blocks: DocumentBlock[] = [
      { kind: "heading", text: "Title", locator: { kind: "heading", depth: 1, headingPath: "Title" } },
      { kind: "paragraph", text: "body text here", locator: { kind: "paragraph", paragraph: 1 } }
    ];
    const chunks = chunkBlocks(blocks);
    expect(chunks[0]?.locator).toEqual({ kind: "heading", depth: 1, headingPath: "Title" });
  });
});

describe("chunkBlocks heading context", () => {
  it("carries the active heading into a following chunk as a context prefix", () => {
    const paragraph = Array.from({ length: 700 }, () => "word").join(" ");
    const blocks: DocumentBlock[] = [
      { kind: "heading", text: "Chapter 1", locator: { kind: "heading", depth: 1, headingPath: "Chapter 1" } },
      { kind: "paragraph", text: paragraph, locator: { kind: "paragraph", paragraph: 1 } }
    ];
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.text).toBe("Chapter 1");
    expect(chunks[1]?.text.startsWith("Chapter 1\n\n")).toBe(true);
  });
});

describe("chunkBlocks table boundaries", () => {
  it("keeps a table atomic inside a single chunk", () => {
    const table = "TABLE\n" + Array.from({ length: 2000 }, (_, i) => `row${i} value`).join("\n");
    const blocks: DocumentBlock[] = [
      { kind: "paragraph", text: "before table", locator: { kind: "paragraph", paragraph: 1 } },
      { kind: "table", text: table, locator: { kind: "offset", start: 0, end: table.length } },
      { kind: "paragraph", text: "after table", locator: { kind: "paragraph", paragraph: 2 } }
    ];
    const chunks = chunkBlocks(blocks);
    const tableChunks = chunks.filter((c) => c.text.includes("TABLE"));
    expect(tableChunks).toHaveLength(1);
    expect(tableChunks[0]?.text).toContain(table);
  });
});

describe("chunkBlocks 900-token target", () => {
  it("keeps paragraph-only chunks inside the 900-token target with no empty chunk", () => {
    const blocks = makeParagraphs(60, 25);
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.tokenEstimate <= 900)).toBe(true);
    expect(chunks.every((c) => c.text.trim().length > 0 && c.tokenEstimate > 0)).toBe(true);
  });
});

describe("chunkBlocks 150-token overlap", () => {
  it("re-includes trailing blocks of a chunk at the head of the next by default", () => {
    const blocks = makeParagraphs(40, 25);
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const shared = blocks.find(
        (b) => chunks[i]!.text.includes(b.text) && chunks[i + 1]!.text.includes(b.text)
      );
      expect(shared).toBeDefined();
    }
  });

  it("bounds the reused overlap tail to the overlap window", () => {
    const blocks = makeParagraphs(20, 25);
    const chunks = chunkBlocks(blocks, { targetTokens: 100, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(2);
    const shared = blocks.find(
      (b) => chunks[0]!.text.includes(b.text) && chunks[1]!.text.includes(b.text)
    );
    expect(shared).toBeDefined();
    expect(estimateTokens(shared!.text)).toBeLessThanOrEqual(40);
  });
});

describe("chunkBlocks contentHash", () => {
  it("hashes each chunk text with stable SHA-256", () => {
    const blocks = makeParagraphs(40, 25);
    const chunks = chunkBlocks(blocks);
    for (const chunk of chunks) {
      expect(chunk.contentHash).toBe(createHash("sha256").update(chunk.text).digest("hex"));
    }
  });
});

describe("chunkBlocks determinism", () => {
  it("orders ordinals strictly from zero with no gaps", () => {
    const blocks = makeParagraphs(40, 25);
    const ordinals = chunkBlocks(blocks).map((c) => c.ordinal);
    expect(ordinals).toEqual(ordinals.map((_, i) => i));
  });

  it("is byte-identical across two consecutive runs", () => {
    const blocks = makeParagraphs(60, 25);
    expect(JSON.stringify(chunkBlocks(blocks))).toBe(JSON.stringify(chunkBlocks(blocks)));
  });

  it("matches the stored bilingual fixture snapshot byte-for-byte", () => {
    const blocks = fixtureToBlocks(readFileSync(FIXTURE_PATH, "utf8"));
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
    expect(JSON.stringify(chunks)).toBe(JSON.stringify(chunkBlocks(blocks)));
    expect(JSON.stringify(chunks)).toMatchSnapshot();
  });
});
