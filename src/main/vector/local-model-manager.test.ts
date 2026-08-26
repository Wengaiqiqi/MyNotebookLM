import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalModelManager, createLocalModelDownloader, managedActiveDirectory, managedStagingDirectory, type ModelDownloader } from "./local-model-manager";
import { LOCAL_MODEL_MANIFEST } from "./local-model-manifest";
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: vi.fn(async () => vi.fn(async () => ({ tolist: () => [[1]] }))) }));
import { createTransformersEmbeddingRuntime } from "./local-embedding-provider";

const manifest = { modelId: "fake/model", revision: "rev1", dimension: 2, files: { "tokenizer.json": "UNRESOLVED", "onnx/model.onnx": "UNRESOLVED" } } as const;
describe("LocalModelManager", () => {
  it("uses a fully resolved immutable Hugging Face manifest", () => {
    expect(LOCAL_MODEL_MANIFEST.revision).toBe("761b726dd34fb83930e26aab4e9ac3899aa1fa78");
    expect(LOCAL_MODEL_MANIFEST.files).toEqual({
      "onnx/model_quantized.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
      "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      "tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"
    });
  });
  it("downloads atomically, resumes partial files, and single-flights", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); let calls = 0;
    const download: ModelDownloader = async (_file, offset, progress) => { calls++; progress(.5); return new Uint8Array([offset, 2, 3]); };
    const manager = new LocalModelManager(root, download, async dir => readFile(path.join(dir, "tokenizer.json")), manifest);
    const [a, b] = await Promise.all([manager.ensureReady(), manager.ensureReady()]); expect(a).toEqual(b); expect(calls).toBe(2);
    await expect(readFile(path.join(root, "fake__model-rev1.partial"))).rejects.toThrow(); await rm(root, { recursive: true, force: true });
  });
  it("keeps production staging self-check on its exact managed staging directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-"));
    const active = managedActiveDirectory(root, manifest);
    const staging = managedStagingDirectory(root, manifest);
    const activeRuntime = createTransformersEmbeddingRuntime(root, active);
    const stagingRuntime = createTransformersEmbeddingRuntime(root, staging);
    const download: ModelDownloader = async file => new TextEncoder().encode(file);
    const manager = new LocalModelManager(
      root,
      download,
      (directory, signal) => activeRuntime(directory, [], signal),
      manifest,
      (directory, signal) => stagingRuntime(directory, [], signal)
    );

    await expect(manager.ensureReady()).resolves.toEqual([[1]]);
    await expect(readFile(path.join(active, "tokenizer.json"), "utf8")).resolves.toBe("tokenizer.json");
    await expect(readFile(staging)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
  it("isolates cancellation between single-flight waiters and keeps each progress callback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const signals: AbortSignal[] = [];
    const firstProgress: number[] = [];
    const secondProgress: number[] = [];
    const downloader: ModelDownloader = async (file, _offset, progress, signal) => {
      calls++;
      signals.push(signal);
      progress(.5);
      if (calls === 1) {
        await gate;
        if (signal.aborted) throw signal.reason;
      }
      return new TextEncoder().encode(file);
    };
    const manager = new LocalModelManager(root, downloader, async directory => readFile(path.join(directory, "tokenizer.json")), manifest);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = manager.ensureReady(false, value => firstProgress.push(value), firstController.signal);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = manager.ensureReady(false, value => secondProgress.push(value), secondController.signal);
    firstController.abort();
    await expect(first).rejects.toThrow();
    release();
    await expect(second).resolves.toEqual(Buffer.from("tokenizer.json"));
    expect(signals[0]).not.toBe(firstController.signal);
    expect(firstProgress.length).toBeGreaterThan(0);
    expect(secondProgress.length).toBeGreaterThan(0);
    await rm(root, { recursive: true, force: true });
  });
  it("passes the verified active directory to runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const seen: string[] = [];
    const manager = new LocalModelManager(root, async file => new TextEncoder().encode(file.includes("tokenizer") ? "new" : "new"), async dir => { seen.push(dir); return dir; }, manifest);
    await manager.ensureReady();
    expect(seen.at(-1)).toBe(path.join(root, "fake__model-rev1"));
    await rm(root, { recursive: true, force: true });
  });
  it("fails offline when the model is absent", async () => { const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const m = new LocalModelManager(root, async () => new Uint8Array(), async () => ({}), manifest); await expect(m.ensureReady(true)).rejects.toThrow("离线"); await rm(root, { recursive: true, force: true }); });
  it("preserves the active model if activation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const active = path.join(root, "fake__model-rev1");
    await mkdir(path.join(active, "onnx"), { recursive: true }); await writeFile(path.join(active, "tokenizer.json"), "old"); await writeFile(path.join(active, "onnx/model.onnx"), "old");
    await writeFile(path.join(active, "tokenizer.json"), "corrupt");
    const manager = new LocalModelManager(root, async file => new TextEncoder().encode(file.includes("tokenizer") ? "corrupt" : "old"), async () => { throw new Error("runtime failed"); }, manifest);
    await expect(manager.ensureReady()).rejects.toThrow("runtime failed"); await expect(readFile(path.join(active, "tokenizer.json"), "utf8")).resolves.toBe("corrupt"); await rm(root, { recursive: true, force: true });
  });
  it("does not delete the backup until the new runtime succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const active = path.join(root, "fake__model-rev1");
    await mkdir(path.join(active, "onnx"), { recursive: true }); await writeFile(path.join(active, "tokenizer.json"), "old"); await writeFile(path.join(active, "onnx/model.onnx"), "old");
    const manager = new LocalModelManager(root, async file => new TextEncoder().encode(file.includes("tokenizer") ? "new" : "new"), async dir => { if (dir === active) throw new Error("old runtime failed"); throw new Error("new runtime failed"); }, manifest);
    await expect(manager.ensureReady()).rejects.toThrow("new runtime failed");
    await expect(readFile(path.join(active, "tokenizer.json"), "utf8")).resolves.toBe("old");
    await rm(root, { recursive: true, force: true });
  });
  it("restores the old active directory when runtime fails after activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const active = path.join(root, "fake__model-rev1");
    await mkdir(path.join(active, "onnx"), { recursive: true }); await writeFile(path.join(active, "tokenizer.json"), "old"); await writeFile(path.join(active, "onnx/model.onnx"), "old");
    let calls = 0; const manager = new LocalModelManager(root, async file => new TextEncoder().encode(file.includes("tokenizer") ? "new" : "new"), async dir => { calls++; if (calls === 1) return {}; throw new Error("active runtime failed"); }, manifest);
    await expect(manager.ensureReady()).rejects.toThrow("active runtime failed"); await expect(readFile(path.join(active, "tokenizer.json"), "utf8")).resolves.toBe("old");
    await rm(root, { recursive: true, force: true });
  });
  it("removes the failed active directory when installing without an old active model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-"));
    const active = managedActiveDirectory(root, manifest);
    const staging = managedStagingDirectory(root, manifest);
    let calls = 0;
    const manager = new LocalModelManager(
      root,
      async file => new TextEncoder().encode(file),
      async () => {
        calls++;
        if (calls === 1) return {};
        throw new Error("active runtime failed");
      },
      manifest
    );

    await expect(manager.ensureReady()).rejects.toThrow("active runtime failed");
    await expect(stat(active)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });
  it("appends resumed bytes and removes corrupt partial artifacts for recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const staging = path.join(root, "fake__model-rev1.partial"); await mkdir(path.join(staging, "onnx"), { recursive: true }); await writeFile(path.join(staging, "tokenizer.json.part"), Buffer.from("old"));
    const manager = new LocalModelManager(root, async (_file, offset) => new Uint8Array(offset ? Buffer.from("-new") : Buffer.from("new")), async dir => readFile(path.join(dir, "tokenizer.json"), "utf8"), manifest);
    await expect(manager.ensureReady()).resolves.toBe("old-new"); await rm(root, { recursive: true, force: true });
  });
  it("downloads only pinned manifest paths and uses Range resume", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(new Uint8Array([1, 2]), { status: init?.headers ? 206 : 200 }));
    const download = createLocalModelDownloader(fetcher as typeof fetch); const progress = vi.fn();
    await expect(download("tokenizer.json", 7, progress, new AbortController().signal)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(fetcher).toHaveBeenCalledWith("https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer.json", expect.objectContaining({ headers: { Range: "bytes=7-" } }));
    await expect(download("other.bin", 0, progress, new AbortController().signal)).rejects.toThrow("不允许");
  });
});
