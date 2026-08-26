import { LocalModelManager } from "./local-model-manager";
import { pipeline, env } from "@huggingface/transformers";
import { LOCAL_MODEL_REVISION } from "./local-model-manifest";
import path from "node:path";
export type EmbeddingRuntime = (model: unknown, inputs: string[], signal: AbortSignal) => Promise<number[][]>;
export class LocalEmbeddingProvider {
  constructor(private readonly manager: LocalModelManager, private readonly embed: EmbeddingRuntime, private readonly batchSize = 16) {}
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
export function createTransformersEmbeddingRuntime(modelDir?: string): EmbeddingRuntime {
  env.allowRemoteModels = false;
  return async (model, inputs) => {
    if (typeof model !== "string") throw new Error("模型目录未由 manager 校验");
    if (!modelDir) throw new Error("模型根目录未配置");
    const root = path.resolve(modelDir);
    const active = path.resolve(model);
    const relative = path.relative(root, active);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("模型目录未由 manager 校验");
    env.localModelPath = root;
    let singleton = singletons.get(active);
    if (!singleton) { singleton = pipeline("feature-extraction", active, { revision: LOCAL_MODEL_REVISION, local_files_only: true }); singletons.set(active, singleton); }
    const extractor: any = await singleton; const result: any = await extractor(inputs, { pooling: "mean", normalize: true }); return (result.tolist?.() ?? result) as number[][];
  };
}
function normalize(v: number[]) { const n = Math.hypot(...v); return n ? v.map(x => x / n) : v; }
