import { describe, expect, it, vi } from "vitest";
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: vi.fn(async () => vi.fn(async () => ({ tolist: () => [[1]] }))) }));
import { LocalEmbeddingProvider, createTransformersEmbeddingRuntime, isAuthoritativeLocalCapability } from "./local-embedding-provider";
import { createLocalDirectoryEmbeddingProvider } from "./local-embedding-provider";
import { BUILT_IN_LOCAL_EMBEDDING_PROFILE } from "../models/local-embedding-profile";
import { LOCAL_MODEL_MANIFEST } from "./local-model-manifest";
import path from "node:path";
import os from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
describe("LocalEmbeddingProvider", () => it("prefixes, batches, normalizes, and cancels", async () => {
  const manager = { ensureReady: vi.fn(async () => ({})) }; const seen: string[][] = [];
  const provider = new LocalEmbeddingProvider(manager as never, async (_m, input) => { seen.push(input); return input.map(() => [3, ...Array(383).fill(4)]); }, 2);
  const progress: number[] = []; const result = await provider.embedTexts(["a", "b", "c"], "query", undefined, v => progress.push(v));
  expect(seen).toEqual([["query: a", "query: b"], ["query: c"]]); expect(result).toHaveLength(3); expect(result[0]).toHaveLength(384); expect(progress.length).toBeGreaterThan(0);
}));
it("describes the authoritative local embedding capability", () => {
  const provider = new LocalEmbeddingProvider({} as never, async () => []);
  expect(provider.describe()).toEqual({
    provider: BUILT_IN_LOCAL_EMBEDDING_PROFILE.provider,
    modelId: LOCAL_MODEL_MANIFEST.modelId,
    modelRevision: LOCAL_MODEL_MANIFEST.revision,
    dimension: LOCAL_MODEL_MANIFEST.dimension,
    distance: BUILT_IN_LOCAL_EMBEDDING_PROFILE.distance,
    pooling: BUILT_IN_LOCAL_EMBEDDING_PROFILE.pooling,
    preprocessVersion: BUILT_IN_LOCAL_EMBEDDING_PROFILE.metadata.preprocessingVersion,
    chunkingVersion: "persisted"
  });
});
it("rejects persisted local capability fields that differ from the manifest", () => {
  const provider = new LocalEmbeddingProvider({} as never, async () => []);
  const capability = provider.describe();
  expect(isAuthoritativeLocalCapability({ ...capability, modelRevision: "wrong" }, capability)).toBe(false);
  expect(isAuthoritativeLocalCapability(capability, capability)).toBe(true);
});
it("passes the caller signal and validates count, finite 384-d vectors", async () => {
  const controller = new AbortController(); const manager = { ensureReady: vi.fn(async (_o: boolean, _p: unknown, signal: AbortSignal) => { expect(signal).toBe(controller.signal); return {}; }) };
  const embed = new LocalEmbeddingProvider(manager as never, async () => [[1, 2]], 2);
  await expect(embed.embedTexts(["a", "b"], "document", controller.signal)).rejects.toThrow(/count|384|dimension/i);
});
it("rejects any directory other than the manager-owned active directory", async () => {
  const transformers = await import("@huggingface/transformers");
  const runtime = createTransformersEmbeddingRuntime("C:/models", "C:/models/active-one");
  await expect(runtime("C:/models/active-two", ["x"], new AbortController().signal)).rejects.toThrow("未由 manager 校验");
  await expect(runtime("C:/models", ["x"], new AbortController().signal)).rejects.toThrow("未由 manager 校验");
  await expect(runtime("C:/models/../outside", ["x"], new AbortController().signal)).rejects.toThrow("未由 manager 校验");
  expect(transformers.pipeline).not.toHaveBeenCalled();
});
it("accepts only the exact manager active directory after Windows normalization", async () => {
  const transformers = await import("@huggingface/transformers");
  const runtime = createTransformersEmbeddingRuntime("C:/models", "C:/models/active-one");
  await runtime("c:/models/active-one", ["x"], new AbortController().signal);
  expect(transformers.pipeline).toHaveBeenCalledWith("feature-extraction", path.resolve("C:/models/active-one"), expect.anything());
});
it("retries a model load after a transient pipeline failure", async () => {
  const transformers = await import("@huggingface/transformers");
  const pipelineMock = vi.mocked(transformers.pipeline);
  const active = `C:/models/retry-${Date.now()}`;
  pipelineMock.mockRejectedValueOnce(new Error("transient model load"));
  pipelineMock.mockResolvedValueOnce(vi.fn(async () => ({ tolist: () => [[1]] })) as never);
  const runtime = createTransformersEmbeddingRuntime(active);

  await expect(runtime(active, ["first"], new AbortController().signal)).rejects.toThrow("transient model load");
  await expect(runtime(active, ["second"], new AbortController().signal)).resolves.toEqual([[1]]);
  expect(pipelineMock).toHaveBeenLastCalledWith("feature-extraction", path.resolve(active), { local_files_only: true });
});
it("loads a user-selected weight file from its model root", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mynotebook-local-"));
  const weights = path.join(root, "onnx", "model.onnx");
  mkdirSync(path.dirname(weights), { recursive: true });
  writeFileSync(path.join(root, "config.json"), "{}");
  writeFileSync(weights, "weights");
  try {
    const provider = createLocalDirectoryEmbeddingProvider(weights, "custom-local");
    expect(provider.describe()).toMatchObject({ provider: "local", modelId: "custom-local", dimension: 1 });
    await provider.embedBatch(["hello"], new AbortController().signal, 1);
    expect((await import("@huggingface/transformers")).pipeline).toHaveBeenLastCalledWith(
      "feature-extraction",
      root,
      { local_files_only: true }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
