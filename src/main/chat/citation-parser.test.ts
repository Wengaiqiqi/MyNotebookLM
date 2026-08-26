import { describe, expect, it } from "vitest";
import {
  CitationStreamBuffer,
  finalizeCitations,
  type RetrievedCitation,
} from "./citation-parser";

const retrievals: Record<string, RetrievedCitation> = {
  S1: { label: "S1", chunkId: "c1", sourceId: "src1", sourceDisplayName: "Doc A", sourceKind: "pdf", locator: { kind: "pdf", page: 3 } },
  S2: { label: "S2", chunkId: "c2", sourceId: "src2", sourceDisplayName: "Doc B", sourceKind: "url", locator: { kind: "url" } },
};

describe("finalizeCitations", () => {
  it("resolves single and multiple citations with exact character ranges", () => {
    const text = "Alpha [S1] then Beta [S1][S2].";
    const result = finalizeCitations(text, retrievals);
    expect(result.citations.map((c) => c.label)).toEqual(["S1", "S1", "S2"]);
    expect(result.hasInvalidCitations).toBe(false);
    expect(result.content).toBe(text);
    const first = result.citations[0]!;
    expect(text.slice(first.start, first.end)).toBe("[S1]");
    const third = result.citations[2]!;
    expect(third.start).toBe(25);
    expect(third.end).toBe(29);
  });

  it("keeps repeated markers as separate citation rows", () => {
    const result = finalizeCitations("A [S2] B [S2]", retrievals);
    expect(result.citations).toHaveLength(2);
    expect(result.citations[1]!.start).toBe(9);
  });

  it("drops unknown ids from records but keeps original text visible and flags diagnostics", () => {
    const text = "Claim [S7] and bogus [S99][S13].";
    const result = finalizeCitations(text, retrievals);
    expect(result.content).toBe(text);
    expect(result.citations).toHaveLength(0);
    expect(result.hasInvalidCitations).toBe(true);
  });

  it("rejoins markers split across stream chunks for recognition", () => {
    const buffer = new CitationStreamBuffer();
    const shown = ['Fact [', 'S1', '] end'].map((c) => buffer.push(c));
    expect(shown.join("")).toBe("Fact [S1] end");
    expect(buffer.pendingSuffixLength()).toBe(0);
  });

  it("ignores markers inside fenced code blocks", () => {
    const text = ['```', '[S1]', '```', 'outside [S2]'].join('\n');
    const result = finalizeCitations(text, retrievals);
    expect(result.citations.map((c) => c.label)).toEqual(["S2"]);
    expect(result.content).toBe(text);
  });

  it("ignores markers inside inline code", () => {
    const text = 'Use `[S1]` inline, real [S1]';
    const result = finalizeCitations(text, retrievals);
    expect(result.citations.map((c) => c.label)).toEqual(["S1"]);
  });

  it("treats malformed markers as plain text without records", () => {
    const text = '[s1] [ S2 ] [S2x] [S-3] valid [S2]';
    const result = finalizeCitations(text, retrievals);
    expect(result.citations.map((c) => c.label)).toEqual(["S2"]);
    expect(result.hasInvalidCitations).toBe(true);
  });
});
