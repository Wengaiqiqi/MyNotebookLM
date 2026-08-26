import type { EmbeddingFingerprint } from "../../shared/vector";

export interface EmbeddingAdapter {
  embed(request: { model: string; inputs: string[]; dimensions?: number }, signal: AbortSignal): Promise<number[][]>;
  describe(): EmbeddingFingerprint;
}

export interface EmbeddingProviderOptions {
  provider: string;
  model: string;
  adapter: EmbeddingAdapter;
  batchSize?: number;
}

export interface EmbeddingProvider {
  embedBatch(texts: string[], signal: AbortSignal, batchSize?: number): Promise<number[][]>;
  describe(): EmbeddingFingerprint;
}

const DEFAULT_BATCHES: Record<string, number> = { openai: 64, gemini: 32, ollama: 32 };

export function createEmbeddingProvider(options: EmbeddingProviderOptions): EmbeddingProvider {
  let fingerprint = options.adapter.describe();
  return {
    async embedBatch(texts, signal, requestedBatchSize) {
      if (!texts.length) throw new Error("Embedding input cannot be empty");
      const size = Math.max(1, Math.min(requestedBatchSize ?? options.batchSize ?? DEFAULT_BATCHES[options.provider] ?? 32, texts.length));
      const result: number[][] = [];
      let expectedDimension: number | undefined;
      for (let offset = 0; offset < texts.length; offset += size) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const vectors = await options.adapter.embed({ model: options.model, inputs: texts.slice(offset, offset + size) }, signal);
        if (vectors.length !== Math.min(size, texts.length - offset)) throw new Error("Embedding response count mismatch");
        const dimension = vectors[0]?.length;
        if (!dimension || (expectedDimension !== undefined && dimension !== expectedDimension)) throw new Error("Embedding dimension is invalid or inconsistent");
        expectedDimension = dimension;
        for (const vector of vectors) {
          if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding vectors must be finite and have consistent dimensions");
          const norm = Math.hypot(...vector);
          if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding vector cannot be zero or non-finite");
          result.push(vector.map((value) => value / norm));
        }
        if (fingerprint.dimension !== dimension) fingerprint = { ...fingerprint, dimension };
      }
      return result;
    },
    describe: () => fingerprint
  };
}
