export const LOCAL_MODEL_ID = "Xenova/multilingual-e5-small";
export const LOCAL_MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";

// Resolved from the pinned Hugging Face revision. Keep this allowlist explicit:
// artifact updates require a new revision and a fresh hash review.
export const LOCAL_MODEL_MANIFEST = Object.freeze({
  modelId: LOCAL_MODEL_ID, revision: LOCAL_MODEL_REVISION, dimension: 384,
  files: Object.freeze({
    "onnx/model_quantized.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    "tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"
  })
});

export type LocalModelManifest = typeof LOCAL_MODEL_MANIFEST;
