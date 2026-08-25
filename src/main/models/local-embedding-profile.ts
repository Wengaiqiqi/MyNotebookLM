import type { EmbeddingMetadata, ModelProfileInput } from "../../shared/models";

export const BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID = "00000000-0000-4000-8000-000000000001";

const BUILT_IN_LOCAL_EMBEDDING_METADATA: EmbeddingMetadata = Object.freeze({
  dimension: 384,
  distance: "cosine",
  pooling: "mean",
  normalized: true,
  preprocessingVersion: "e5-query-passage-v1"
});

export type BuiltInLocalEmbeddingProfile = Readonly<ModelProfileInput & EmbeddingMetadata & {
  metadata: EmbeddingMetadata;
  editable: false;
  requiresCredential: false;
}>;

export const BUILT_IN_LOCAL_EMBEDDING_PROFILE: BuiltInLocalEmbeddingProfile = Object.freeze({
  id: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
  name: "Multilingual E5 Small",
  provider: "local",
  capability: "embedding",
  baseUrl: "",
  modelId: "Xenova/multilingual-e5-small",
  enabled: true,
  ...BUILT_IN_LOCAL_EMBEDDING_METADATA,
  metadata: BUILT_IN_LOCAL_EMBEDDING_METADATA,
  editable: false,
  requiresCredential: false
});

export function isBuiltInLocalEmbeddingProfile(profileOrId: string | Pick<ModelProfileInput, "id">): boolean {
  return (typeof profileOrId === "string" ? profileOrId : profileOrId.id) === BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID;
}
