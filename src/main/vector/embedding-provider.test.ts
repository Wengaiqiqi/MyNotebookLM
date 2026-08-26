import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "./embedding-provider";

const signal = new AbortController().signal;
const fp = { provider: "openai", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "v1", chunkingVersion: "v1" };

function provider(embed: (r: { inputs: string[] }, s: AbortSignal) => Promise<number[][]>) {
  return createEmbeddingProvider({ provider: "openai", model: "m", adapter: { embed, describe: () => fp } });
}

describe("embedding provider", () => {
  it("rejects empty input and preserves stable order while splitting batches", async () => {
    const calls: string[][] = [];
    const p = provider(async ({ inputs }) => { calls.push(inputs); return inputs.map((x) => [Number(x), 1]); });
    await expect(p.embedBatch([], signal)).rejects.toThrow(/empty/i);
    const result = await p.embedBatch(["1", "2", "3"], signal, 2);
    expect(calls).toEqual([["1", "2"], ["3"]]);
    expect(result[0]?.[0]).toBeCloseTo(0.7071, 3);
    expect(result[2]?.[0]).toBeCloseTo(0.9487, 3);
  });

  it("validates dimension, finite and normalized vectors", async () => {
    const p = provider(async () => [[1, 0], [0, 1]]);
    await expect(p.embedBatch(["a", "b"], signal)).resolves.toEqual([[1, 0], [0, 1]]);
    let calls = 0;
    await expect(provider(async ({ inputs }) => calls++ === 0 ? [[1, 0], [0, 1]] : inputs.map(() => [1, 2, 3])).embedBatch(["a", "b", "c"], signal, 2)).rejects.toThrow(/dimension/i);
    await expect(provider(async () => [[1, Number.NaN]]).embedBatch(["a"], signal)).rejects.toThrow(/finite/i);
  });

  it("honors cancellation and exposes the adapter fingerprint", async () => {
    const controller = new AbortController();
    const p = provider(async (_r, s) => { await new Promise((resolve) => setTimeout(resolve, 5)); if (s.aborted) throw new DOMException("Aborted", "AbortError"); return [[1, 0]]; });
    controller.abort();
    await expect(p.embedBatch(["a"], controller.signal)).rejects.toThrow(/abort/i);
    expect(p.describe()).toEqual(fp);
  });
});
