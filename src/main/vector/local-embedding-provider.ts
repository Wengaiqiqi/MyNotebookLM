import { LocalModelManager } from "./local-model-manager";
export type EmbeddingRuntime = (model: unknown, inputs: string[], signal: AbortSignal) => Promise<number[][]>;
export class LocalEmbeddingProvider {
  constructor(private readonly manager: LocalModelManager, private readonly embed: EmbeddingRuntime, private readonly batchSize = 16) {}
  async embedTexts(inputs: string[], kind: "query" | "document", signal = new AbortController().signal, onProgress = (_: number) => {}): Promise<number[][]> {
    const model = await this.manager.ensureReady(false, onProgress, signal);
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); const prefix = kind === "query" ? "query: " : "passage: "; const vectors = await this.embed(model, inputs.slice(i, i + this.batchSize).map(x => prefix + x), signal); out.push(...vectors.map(normalize)); onProgress(Math.min(1, (i + this.batchSize) / inputs.length)); } return out;
  }
}
function normalize(v: number[]) { const n = Math.hypot(...v); return n ? v.map(x => x / n) : v; }
