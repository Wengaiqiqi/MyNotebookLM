import { LocalModelManager } from "./local-model-manager";
import { pipeline, env } from "@huggingface/transformers";
import { BUILT_IN_LOCAL_EMBEDDING_PROFILE } from "../models/local-embedding-profile";
import { LOCAL_MODEL_MANIFEST, LOCAL_MODEL_REVISION } from "./local-model-manifest";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import type { EmbeddingFingerprint } from "../../shared/vector";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
export type EmbeddingRuntime = (model: unknown, inputs: string[], signal: AbortSignal) => Promise<number[][]>;
export function isAuthoritativeLocalCapability(value: EmbeddingFingerprint, expected: EmbeddingFingerprint): boolean { return value.provider === expected.provider && value.modelId === expected.modelId && value.modelRevision === expected.modelRevision && value.dimension === expected.dimension && value.distance === expected.distance && value.pooling === expected.pooling && value.preprocessVersion === expected.preprocessVersion && value.chunkingVersion === expected.chunkingVersion; }
export class LocalEmbeddingProvider {
  constructor(private readonly manager: LocalModelManager, private readonly embed: EmbeddingRuntime, private readonly batchSize = 16) {}
  describe(): EmbeddingFingerprint { return { provider: BUILT_IN_LOCAL_EMBEDDING_PROFILE.provider, modelId: LOCAL_MODEL_MANIFEST.modelId, modelRevision: LOCAL_MODEL_MANIFEST.revision, dimension: LOCAL_MODEL_MANIFEST.dimension, distance: BUILT_IN_LOCAL_EMBEDDING_PROFILE.distance, pooling: BUILT_IN_LOCAL_EMBEDDING_PROFILE.pooling, preprocessVersion: BUILT_IN_LOCAL_EMBEDDING_PROFILE.metadata.preprocessingVersion, chunkingVersion: "persisted" }; }
  embedBatch(inputs: string[], signal: AbortSignal, batchSize = this.batchSize): Promise<number[][]> {
    return this.embedTexts(inputs, "document", signal, () => {}, batchSize);
  }
  async embedTexts(inputs: string[], kind: "query" | "document", signal = new AbortController().signal, onProgress = (_: number) => {}, batchSize = this.batchSize): Promise<number[][]> {
    const model = await this.manager.ensureReady(false, onProgress, signal);
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += batchSize) { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); const prefix = kind === "query" ? "query: " : "passage: "; const vectors = await this.embed(model, inputs.slice(i, i + batchSize).map(x => prefix + x), signal); if (vectors.length !== Math.min(batchSize, inputs.length - i)) throw new Error("embedding response count mismatch"); if (vectors.some(v => v.length !== 384 || v.some(x => !Number.isFinite(x)))) throw new Error("embedding dimension or finite-value mismatch"); out.push(...vectors.map(normalize)); onProgress(Math.min(1, (i + batchSize) / inputs.length)); } return out;
  }
}
const singletons = new Map<string, Promise<any>>();
const directoryProviders = new Map<string, EmbeddingProvider>();
export function createTransformersEmbeddingRuntime(modelDir?: string, managedActiveDir?: string, revision?: string): EmbeddingRuntime {
  env.allowRemoteModels = false;
  return async (model, inputs) => {
    if (typeof model !== "string") throw new Error("模型目录未由 manager 校验");
    if (!modelDir) throw new Error("模型根目录未配置");
    const active = canonicalLocalModelPath(model);
    const expected = canonicalLocalModelPath(managedActiveDir ?? modelDir);
    if (active.toLowerCase() !== expected.toLowerCase()) throw new Error("模型目录未由 manager 校验");
    const root = canonicalLocalModelPath(modelDir);
    env.localModelPath = root;
    const requestedRevision = revision ?? (managedActiveDir ? LOCAL_MODEL_REVISION : undefined);
    const key = `${expected}|${requestedRevision ?? ""}`;
    let singleton = singletons.get(key);
    if (!singleton) {
      singleton = pipeline("feature-extraction", expected, {
        ...(requestedRevision ? { revision: requestedRevision } : {}),
        local_files_only: true
      });
      singletons.set(key, singleton);
      // A transient model-load failure must not poison this process forever.
      void singleton.catch(() => {
        if (singletons.get(key) === singleton) singletons.delete(key);
      });
    }
    const extractor: any = await singleton; const result: any = await extractor(inputs, { pooling: "mean", normalize: true }); return (result.tolist?.() ?? result) as number[][];
  };
}
export function createLocalDirectoryEmbeddingProvider(selectedPath: string, modelId: string): EmbeddingProvider {
  const persistedPath = selectedPath.trim();
  if (!persistedPath) throw new Error("本机模型路径不能为空");
  const resolved = canonicalLocalModelPath(persistedPath);
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(resolved); } catch { throw new Error("本机模型文件或目录不存在"); }
  const directory = stats.isDirectory() ? resolved : findModelDirectory(path.dirname(resolved));
  const key = `${resolved}\u0000${modelId.trim()}`;
  const cached = directoryProviders.get(key);
  if (cached) return cached;
  const runtime = createTransformersEmbeddingRuntime(directory);
  const provider = createEmbeddingProvider({
    provider: "local",
    model: modelId.trim(),
    adapter: {
      describe: () => ({
        provider: "local",
        modelId: modelId.trim(),
        modelRevision: resolved,
        dimension: 1,
        distance: "cosine",
        pooling: "mean",
        preprocessVersion: "local-provider-v1",
        chunkingVersion: "persisted"
      }),
      embed: ({ inputs }, signal) => runtime(directory, inputs, signal)
    }
  });
  directoryProviders.set(key, provider);
  return provider;
}
function normalize(v: number[]) { const n = Math.hypot(...v); return n ? v.map(x => x / n) : v; }
export function canonicalLocalModelPath(value: string): string { return /^[a-z]:[\\/]/i.test(value) ? path.win32.resolve(value) : path.resolve(value); }

function findModelDirectory(start: string): string {
  let current = start;
  for (let depth = 0; depth < 4; depth += 1) {
    if (["config.json", "tokenizer.json", "tokenizer_config.json"].some((file) => existsSync(path.join(current, file)))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}
