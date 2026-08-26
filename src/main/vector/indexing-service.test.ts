import { describe, expect, it, vi } from "vitest";
import { IndexingService } from "./indexing-service";
import { canonicalEmbeddingFingerprint } from "./indexing-service";
const chunk = (id: string, hash = id) => ({ id, revision_id: "r1", ordinal: Number(id.slice(1)), content_hash: hash, text: id, locator_json: "{}" });
const stored = (chunkId: string, contentHash: string, projectId = "p1", spaceId = "space", sourceId = "s1", overrides: Record<string, unknown> = {}) => ({ chunkId, projectId, sourceId, revisionId: "r1", spaceId, ordinal: Number(chunkId.slice(1)), contentHash, text: chunkId, vector: [1, 0], locator: {}, createdAt: 0, ...overrides });
const persistedSpace = { space_id: "space", space_project_id: "p1", space_dimension: 2, space_state: "active", active_space_id: "space", provider: "local", model_id: "m", model_revision: "r", distance: "cosine", pooling: "mean", preprocess_version: "v1", chunking_version: "v1", fingerprint: canonicalEmbeddingFingerprint({ provider: "local", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine", pooling: "mean", preprocessVersion: "v1", chunkingVersion: "v1" }) };
const describedProvider = { describe: () => ({ provider: "local", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "v1", chunkingVersion: "v1" }), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
describe("IndexingService", () => {
  it("rejects a persisted fingerprint mismatch before any Lance operation", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace, fingerprint: "forged" }) })) } as never;
    const lance = { createSpace: vi.fn(), upsert: vi.fn(), count: vi.fn(), rows: vi.fn(), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toMatchObject({ code: "INDEXING_SPACE_MISMATCH" });
    expect(lance.createSpace).not.toHaveBeenCalled();
  });
  it("rejects a forged rebuild fingerprint before any Lance operation", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace, space_state: "building", fingerprint: "forged" }) })) } as never;
    const lance = { createSpace: vi.fn(), upsert: vi.fn(), count: vi.fn(), rows: vi.fn(), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).rebuild({ revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toMatchObject({ code: "INDEXING_SPACE_MISMATCH" });
    expect(lance.createSpace).not.toHaveBeenCalled();
  });
  it.each([
    ["forged id", { space_id: undefined, space_project_id: undefined, space_dimension: undefined, space_state: undefined, active_space_id: undefined }, { id: "forged", dimension: 2 }],
    ["project", { space_project_id: "p2" }, { id: "space", dimension: 2 }],
    ["dimension", { space_dimension: 3 }, { id: "space", dimension: 2 }],
    ["state", { space_state: "retired" }, { id: "space", dimension: 2 }],
    ["active profile", { active_space_id: "other" }, { id: "space", dimension: 2 }]
  ])("rejects a %s Space boundary before provider or Lance", async (_case, persisted, space) => {
    const source = { project_id: "p1", source_id: "s1" };
    const db = {
      prepare: vi.fn((sql: string) => ({
        all: () => [chunk("c0")],
        get: () => sql.includes("embedding_spaces") ? { ...source, space_id: "space", space_project_id: "p1", space_dimension: 2, space_state: "active", active_space_id: "space", ...persisted } : source,
        run: vi.fn(() => ({ changes: 1 }))
      })),
      transaction: (fn: () => unknown) => () => fn()
    } as never;
    const provider = describedProvider;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, provider, lance as never).index({ taskId: "t1", revisionId: "r1", space })).rejects.toMatchObject({ code: "INDEXING_SPACE_MISMATCH" });
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(lance.upsert).not.toHaveBeenCalled();
  });

  it("rejects a failed rebuild Space before provider or Lance", async () => {
    const source = { project_id: "p1", source_id: "s1" };
    const db = {
      prepare: vi.fn((sql: string) => ({
        all: () => [chunk("c0")],
        get: () => sql.includes("embedding_spaces") ? { ...source, space_id: "space", space_project_id: "p1", space_dimension: 2, space_state: "failed" } : source
      }))
    } as never;
    const provider = describedProvider;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]) };
    await expect(new IndexingService(db, provider, lance as never).rebuild({ revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toMatchObject({ code: "INDEXING_SPACE_MISMATCH" });
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(lance.upsert).not.toHaveBeenCalled();
  });

  it("embeds SQLite chunks in batches and activates only after verification", async () => {
    const chunks = [chunk("c0"), chunk("c1")];
    const db = { prepare: vi.fn(() => ({ all: () => chunks, get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const provider = describedProvider;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 2), rows: vi.fn(async () => chunks.map(c => stored(c.id, c.content_hash))), vectorSearch: vi.fn(async () => [stored("c0", "c0")]), deleteRevision: vi.fn() };
    await new IndexingService(db, provider as never, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 }, batchSize: 1 });
    expect(provider.embedBatch).toHaveBeenCalledTimes(3); expect(lance.vectorSearch).toHaveBeenCalled();
    expect(lance.count).toHaveBeenCalledWith({ id: "space", dimension: 2 }, { revisionId: "r1" });
  });

  it("creates the Lance Space before the first indexing write", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const createSpace = vi.fn(async () => undefined);
    const lance = { createSpace, upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]), deleteRevision: vi.fn() };
    await new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } });
    expect(createSpace).toHaveBeenCalledWith({ id: "space", dimension: 2 });
    expect(createSpace.mock.invocationCallOrder[0]).toBeLessThan(lance.upsert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it("validates provider capability before creating an indexing Space", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace, provider: "local", model_id: "m", model_revision: "r", distance: "cosine", pooling: "mean", preprocess_version: "v1", chunking_version: "v1" }) })) } as any;
    const createSpace = vi.fn(async () => undefined);
    const lance = { createSpace, upsert: vi.fn(), count: vi.fn(), rows: vi.fn(), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    const provider = { describe: () => ({ provider: "cloud", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "v1", chunkingVersion: "v1" }), embedBatch: vi.fn() };
    await expect(new IndexingService(db, provider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toMatchObject({ code: "EMBEDDING_CAPABILITY_MISMATCH" });
    expect(createSpace).not.toHaveBeenCalled();
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(lance.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["missing persisted row", { project_id: "p1", source_id: "s1", space_id: undefined, space_project_id: undefined, space_dimension: undefined, space_state: undefined, active_space_id: undefined }],
    ["missing persisted capability", { project_id: "p1", source_id: "s1", ...persistedSpace, provider: undefined, model_id: undefined, model_revision: undefined, distance: undefined, pooling: undefined, preprocess_version: undefined, chunking_version: undefined }]
  ])("fails closed for %s before rebuild writes", async (_name, persisted) => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => persisted })) } as any;
    const createSpace = vi.fn(async () => undefined);
    const lance = { createSpace, upsert: vi.fn(), count: vi.fn(), rows: vi.fn(), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    const provider = { embedBatch: vi.fn(), describe: vi.fn() };
    await expect(new IndexingService(db, provider, lance as never).rebuild({ revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toBeTruthy();
    expect(createSpace).not.toHaveBeenCalled();
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(lance.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the provider has no describe contract", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace, provider: "local", model_id: "m", model_revision: "r", distance: "cosine", pooling: "mean", preprocess_version: "v1", chunking_version: "v1" }) })) } as any;
    const createSpace = vi.fn(async () => undefined);
    const lance = { createSpace, upsert: vi.fn(), count: vi.fn(), rows: vi.fn(), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    const provider = { embedBatch: vi.fn(), describe: vi.fn() };
    await expect(new IndexingService(db, provider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toMatchObject({ code: "EMBEDDING_CAPABILITY_MISMATCH" });
    expect(createSpace).not.toHaveBeenCalled();
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(lance.upsert).not.toHaveBeenCalled();
  });
  it("rejects a provider capability mismatch before embedding or Lance writes", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace, provider: "local", model_id: "expected-model", model_revision: "expected-revision", distance: "cosine", pooling: "mean", preprocess_version: "v1", chunking_version: "v1", fingerprint: canonicalEmbeddingFingerprint({ provider: "local", modelId: "expected-model", modelRevision: "expected-revision", dimension: 2, distance: "cosine", pooling: "mean", preprocessVersion: "v1", chunkingVersion: "v1" }) }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const provider = { describe: () => ({ provider: "local", modelId: "actual-model", modelRevision: "actual-revision", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "v1", chunkingVersion: "v1" }), embedBatch: vi.fn(async () => [[1, 0]]) };
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, provider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toMatchObject({ code: "EMBEDDING_CAPABILITY_MISMATCH" });
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(lance.upsert).not.toHaveBeenCalled();
  });
  it("creates the Lance Space before the first rebuild write", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace, space_state: "building" }) })) } as any;
    const createSpace = vi.fn(async () => undefined);
    const lance = { createSpace, upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]) };
    await new IndexingService(db, describedProvider, lance as never).rebuild({ revisionId: "r1", space: { id: "space", dimension: 2 } });
    expect(createSpace).toHaveBeenCalledWith({ id: "space", dimension: 2 });
    expect(createSpace.mock.invocationCallOrder[0]).toBeLessThan(lance.upsert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });
  it("deletes incomplete Lance rows on verification failure", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 0), rows: vi.fn(async () => []), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as any).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(); expect(lance.deleteRevision).toHaveBeenCalled();
  });

  it("rejects duplicate Lance chunk IDs when the SQLite revision has a different chunk set", async () => {
    const chunks = [chunk("c0"), chunk("c1")];
    const db = { prepare: vi.fn(() => ({ all: () => chunks, get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 2), rows: vi.fn(async () => [stored("c0", "c0"), stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 }, batchSize: 2 })).rejects.toThrow(/metadata|chunk/i);
    expect(lance.deleteRevision).toHaveBeenCalled();
  });

  it("rejects rows from another project or space and does not activate", async () => {
    const db = { prepare: vi.fn((sql: string) => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0", "p2", "other")]), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/metadata|project|space/i);
    expect(lance.vectorSearch).not.toHaveBeenCalled();
  });

  it("requires the probe to return the expected chunk and hash", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => []), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/probe/i);
  });

  it("rejects an index row whose sourceId differs from SQLite", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0", "p1", "space", "s2")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/metadata/i);
    expect(lance.deleteRevision).toHaveBeenCalled();
  });

  it("rejects a revision-scoped Lance count mismatch without counting other revisions", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 2), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, describedProvider, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/count/i);
    expect(lance.count).toHaveBeenCalledWith({ id: "space", dimension: 2 }, { revisionId: "r1" });
    expect(lance.vectorSearch).not.toHaveBeenCalled();
    expect(lance.deleteRevision).toHaveBeenCalledWith({ id: "space", dimension: 2 }, "r1");
  });

  it("rejects a rebuilt row whose sourceId differs from SQLite", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }) })) } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0", "p1", "space", "s2")]), vectorSearch: vi.fn(async () => [stored("c0", "c0")]) };
    await expect(new IndexingService(db, describedProvider, lance as never).rebuild({ revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/metadata/i);
  });

  it.each([
    ["chunkId", { chunkId: "wrong" }], ["contentHash", { contentHash: "wrong" }],
    ["projectId", { projectId: "wrong" }], ["sourceId", { sourceId: "wrong" }],
    ["spaceId", { spaceId: "wrong" }], ["revisionId", { revisionId: "wrong" }],
    ["ordinal", { ordinal: 9 }], ["text", { text: "wrong" }], ["locator", { locator: { line: 9 } }],
    ["vector dimension", { vector: [1] }], ["vector finite", { vector: [1, Number.NaN] }]
  ])("rebuild rejects same-chunk probe with wrong %s", async (_field, override) => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1", ...persistedSpace }) })) } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 1), rows: vi.fn(async () => [stored("c0", "c0")]), vectorSearch: vi.fn(async () => [stored("c0", "c0", "p1", "space", "s1", override as Record<string, unknown>)]) };
    await expect(new IndexingService(db, describedProvider, lance as never).rebuild({ revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/probe|metadata|vector/i);
  });
});
