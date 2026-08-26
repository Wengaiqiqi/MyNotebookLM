import { LocalModelManager } from "./local-model-manager";
import { pipeline, env, mean_pooling } from "@huggingface/transformers";
import { LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "./local-model-manifest";
export type EmbeddingRuntime = (model: unknown, inputs: string[], signal: AbortSignal) => Promise<number[][]>;
export class LocalEmbeddingProvider {
  constructor(private readonly manager: LocalModelManager, private readonly embed: EmbeddingRuntime, private readonly batchSize = 16) {}
  async embedTexts(inputs: string[], kind: "query" | "document", signal = new AbortController().signal, onProgress = (_: number) => {}): Promise<number[][]> {
    const model = await this.manager.ensureReady(false, onProgress, signal);
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); const prefix = kind === "query" ? "query: " : "passage: "; const vectors = await this.embed(model, inputs.slice(i, i + this.batchSize).map(x => prefix + x), signal); if (vectors.length !== Math.min(this.batchSize, inputs.length - i)) throw new Error("embedding response count mismatch"); if (vectors.some(v => v.length !== 384 || v.some(x => !Number.isFinite(x)))) throw new Error("embedding dimension or finite-value mismatch"); out.push(...vectors.map(normalize)); onProgress(Math.min(1, (i + this.batchSize) / inputs.length)); } return out;
  }
}
let singleton: Promise<any> | undefined;
export function createTransformersEmbeddingRuntime(modelDir?: string): EmbeddingRuntime {
  env.allowRemoteModels = false; env.localModelPath = modelDir ?? env.localModelPath;
  return async (_model, inputs) => { singleton ??= pipeline("feature-extraction", LOCAL_MODEL_ID, { revision: LOCAL_MODEL_REVISION, local_files_only: true }); const extractor: any = await singleton; const result: any = await extractor(inputs, { pooling: "mean", normalize: true }); return (result.tolist?.() ?? result) as number[][]; };
}
function normalize(v: number[]) { const n = Math.hypot(...v); return n ? v.map(x => x / n) : v; }
