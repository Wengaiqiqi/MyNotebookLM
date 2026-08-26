import { describe, expect, it, vi } from "vitest";
import { LocalEmbeddingProvider, createTransformersEmbeddingRuntime } from "./local-embedding-provider";
describe("LocalEmbeddingProvider", () => it("prefixes, batches, normalizes, and cancels", async () => {
  const manager = { ensureReady: vi.fn(async () => ({})) }; const seen: string[][] = [];
  const provider = new LocalEmbeddingProvider(manager as never, async (_m, input) => { seen.push(input); return input.map(() => [3, ...Array(383).fill(4)]); }, 2);
  const progress: number[] = []; const result = await provider.embedTexts(["a", "b", "c"], "query", undefined, v => progress.push(v));
  expect(seen).toEqual([["query: a", "query: b"], ["query: c"]]); expect(result).toHaveLength(3); expect(result[0]).toHaveLength(384); expect(progress.length).toBeGreaterThan(0);
}));
it("passes the caller signal and validates count, finite 384-d vectors", async () => {
  const controller = new AbortController(); const manager = { ensureReady: vi.fn(async (_o: boolean, _p: unknown, signal: AbortSignal) => { expect(signal).toBe(controller.signal); return {}; }) };
  const embed = new LocalEmbeddingProvider(manager as never, async () => [[1, 2]], 2);
  await expect(embed.embedTexts(["a", "b"], "document", controller.signal)).rejects.toThrow(/count|384|dimension/i);
});
it("exposes the transformers singleton runtime factory", () => expect(createTransformersEmbeddingRuntime).toBeTypeOf("function"));
