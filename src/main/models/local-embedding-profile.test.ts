import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LOCAL_EMBEDDING_PROFILE,
  BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
  isBuiltInLocalEmbeddingProfile
} from "./local-embedding-profile";

describe("built-in local embedding profile", () => {
  it("exposes immutable embedding metadata for the bundled model", () => {
    expect(BUILT_IN_LOCAL_EMBEDDING_PROFILE).toMatchObject({
      id: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
      provider: "local",
      capability: "embedding",
      baseUrl: "",
      modelId: "Xenova/multilingual-e5-small",
      dimension: 384,
      distance: "cosine",
      pooling: "mean",
      normalized: true,
      preprocessingVersion: "e5-query-passage-v1",
      editable: false,
      requiresCredential: false
    });
    expect(Object.isFrozen(BUILT_IN_LOCAL_EMBEDDING_PROFILE)).toBe(true);
    expect(Object.isFrozen(BUILT_IN_LOCAL_EMBEDDING_PROFILE.metadata)).toBe(true);
  });

  it("provides no address or credential and can be recognized for default selection", () => {
    expect("apiKey" in BUILT_IN_LOCAL_EMBEDDING_PROFILE).toBe(false);
    expect(isBuiltInLocalEmbeddingProfile({ id: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID })).toBe(true);
    expect(isBuiltInLocalEmbeddingProfile(BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID)).toBe(true);
    expect(isBuiltInLocalEmbeddingProfile({ id: "11111111-1111-4111-8111-111111111111" })).toBe(false);
  });
});
