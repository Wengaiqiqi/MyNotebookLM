import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalModelManager, type ModelDownloader } from "./local-model-manager";
import { LOCAL_MODEL_MANIFEST } from "./local-model-manifest";

const manifest = { modelId: "fake/model", revision: "rev1", dimension: 2, files: { "tokenizer.json": "UNRESOLVED", "onnx/model.onnx": "UNRESOLVED" } } as const;
describe("LocalModelManager", () => {
  it("uses a fully resolved immutable Hugging Face manifest", () => {
    expect(LOCAL_MODEL_MANIFEST.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(LOCAL_MODEL_MANIFEST.files).toEqual({
      "onnx/model_quantized.onnx": expect.stringMatching(/^[0-9a-f]{64}$/),
      "tokenizer.json": expect.stringMatching(/^[0-9a-f]{64}$/),
      "tokenizer_config.json": expect.stringMatching(/^[0-9a-f]{64}$/)
    });
  });
  it("downloads atomically, resumes partial files, and single-flights", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "model-")); let calls = 0;
    const download: ModelDownloader = async (_file, offset, progress) => { calls++; progress(.5); return new Uint8Array([offset, 2, 3]); };
    const manager = new LocalModelManager(root, download, async dir => readFile(path.join(dir, "tokenizer.json")), manifest);
    const [a, b] = await Promise.all([manager.ensureReady(), manager.ensureReady()]); expect(a).toEqual(b); expect(calls).toBe(2);
    await expect(readFile(path.join(root, "fake__model-rev1.partial"))).rejects.toThrow(); await rm(root, { recursive: true, force: true });
  });
  it("fails offline when the model is absent", async () => { const root = await mkdtemp(path.join(os.tmpdir(), "model-")); const m = new LocalModelManager(root, async () => new Uint8Array(), async () => ({}), manifest); await expect(m.ensureReady(true)).rejects.toThrow("离线"); await rm(root, { recursive: true, force: true }); });
});
