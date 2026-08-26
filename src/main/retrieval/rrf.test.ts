import { describe, expect, it } from "vitest";
import { diversifyHits, fuseRrf } from "./rrf";

describe("RRF retrieval", () => {
  it("fuses missing ranks deterministically and deduplicates hashes", () => {
    const result = fuseRrf([
      [{ chunkId: "a", contentHash: "h1" }, { chunkId: "b", contentHash: "h2" }],
      [{ chunkId: "c", contentHash: "h1" }, { chunkId: "b", contentHash: "h2" }]
    ]);
    expect(result.map(x => x.chunkId)).toEqual(["a", "b"]);
    expect(result[0]!.score ?? 0).toBeGreaterThan(result[1]!.score ?? 0);
  });

  it("limits adjacent chunks per source while retaining source diversity", () => {
    const hits = [1, 2, 3, 10].map((ordinal, i) => ({ chunkId: String(i), sourceId: "s1", ordinal, contentHash: String(i), score: 1 }));
    expect(diversifyHits(hits, 4, 2).map(x => x.ordinal)).toEqual([1, 10, 2, 3]);
  });
});
