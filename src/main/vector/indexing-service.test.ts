import { describe, expect, it, vi } from "vitest";
import { IndexingService } from "./indexing-service";
const chunk = (id: string, hash = id) => ({ id, revision_id: "r1", ordinal: Number(id.slice(1)), content_hash: hash, text: id, locator_json: "{}" });
describe("IndexingService", () => {
  it("embeds SQLite chunks in batches and activates only after verification", async () => {
    const chunks = [chunk("c0"), chunk("c1")];
    const db = { prepare: vi.fn(() => ({ all: () => chunks, get: () => ({ project_id: "p1", source_id: "s1" }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const provider = { embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 2), rows: vi.fn(async () => chunks.map(c => ({ chunkId: c.id, revisionId: "r1", contentHash: c.content_hash, projectId: "p1", spaceId: "space" }))), vectorSearch: vi.fn(async () => [{ chunkId: "c0", revisionId: "r1", contentHash: "c0", projectId: "p1", spaceId: "space" }]), deleteRevision: vi.fn() };
    await new IndexingService(db, provider as any, lance as any).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 }, batchSize: 1 });
    expect(provider.embedBatch).toHaveBeenCalledTimes(3); expect(lance.vectorSearch).toHaveBeenCalled();
  });
  it("deletes incomplete Lance rows on verification failure", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1" }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const lance = { upsert: vi.fn(), count: vi.fn(async () => 0), rows: vi.fn(async () => []), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, { embedBatch: async () => [[1, 0]] } as any, lance as any).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(); expect(lance.deleteRevision).toHaveBeenCalled();
  });

  it("rejects rows from another project or space and does not activate", async () => {
    const db = { prepare: vi.fn((sql: string) => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1" }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(), rows: vi.fn(async () => [{ chunkId: "c0", revisionId: "r1", contentHash: "c0", projectId: "p2", spaceId: "other" }]), vectorSearch: vi.fn(), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, { embedBatch: async () => [[1, 0]] }, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/metadata|project|space/i);
    expect(lance.vectorSearch).not.toHaveBeenCalled();
  });

  it("requires the probe to return the expected chunk and hash", async () => {
    const db = { prepare: vi.fn(() => ({ all: () => [chunk("c0")], get: () => ({ project_id: "p1", source_id: "s1" }), run: vi.fn(() => ({ changes: 1 })) })), transaction: (fn: () => unknown) => () => fn() } as never;
    const lance = { upsert: vi.fn(), count: vi.fn(), rows: vi.fn(async () => [{ chunkId: "c0", revisionId: "r1", contentHash: "c0", projectId: "p1", spaceId: "space" }]), vectorSearch: vi.fn(async () => []), deleteRevision: vi.fn() };
    await expect(new IndexingService(db, { embedBatch: async () => [[1, 0]] }, lance as never).index({ taskId: "t1", revisionId: "r1", space: { id: "space", dimension: 2 } })).rejects.toThrow(/probe/i);
  });
});
