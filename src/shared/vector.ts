import { z } from "zod";

export const embeddingFingerprintSchema = z.object({ provider: z.string().min(1), modelId: z.string().min(1), modelRevision: z.string().min(1), dimension: z.number().int().positive(), distance: z.literal("cosine"), pooling: z.literal("mean"), preprocessVersion: z.string().min(1), chunkingVersion: z.string().min(1) });
export const embeddingSpaceSchema = z.object({ id: z.uuid(), projectId: z.uuid(), fingerprint: z.string().min(1), state: z.enum(["preparing", "building", "validating", "active", "failed", "retired"]), progress: z.number().int().min(0).max(1000), fingerprintData: embeddingFingerprintSchema });
export const vectorHealthSchema = z.object({ spaceId: z.uuid(), healthy: z.boolean(), indexedCount: z.number().int().nonnegative() });
export const searchHitSchema = z.object({ chunkId: z.uuid(), score: z.number().finite(), text: z.string(), locator: z.unknown() });
export type EmbeddingFingerprint = Readonly<z.infer<typeof embeddingFingerprintSchema>>;
export type EmbeddingSpaceDto = Readonly<z.infer<typeof embeddingSpaceSchema>>;
export type VectorHealthDto = Readonly<z.infer<typeof vectorHealthSchema>>;
export type SearchHitDto = Readonly<z.infer<typeof searchHitSchema>>;
