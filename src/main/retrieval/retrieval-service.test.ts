import { describe, expect, it, vi } from "vitest";
import { RetrievalService } from "./retrieval-service";

describe("RetrievalService", () => {
  it("runs ANN and BM25 in parallel and revalidates active revision/project", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const lance = { vectorSearch: vi.fn(async () => { await gate; return [{ chunkId: "c1", contentHash: "h1", sourceId: "s1", revisionId: "r1", ordinal: 0, text: "stale", locatorJson: "{}" }]; }), textSearch: vi.fn(async () => [{ chunkId: "c1", contentHash: "h1", sourceId: "s1", revisionId: "r1", ordinal: 0, text: "stale", locatorJson: "{}" }]) };
    const db = { prepare: vi.fn(() => ({ get: () => ({ project_id: "p1", status: "active", current_revision_id: "r1", revision_state: "ready", space_state: "active", chunk_id: "c1", source_id: "s1", revision_id: "r1", text: "authoritative", locator_json: "{\"page\":1}" }) })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn(async () => [[1, 0]]) } as any, resolveSpace: async () => ({ id: "sp1", dimension: 2, state: "active" }) });
    const promise = service.search("p1", "hello"); await new Promise(r => setTimeout(r, 0)); expect(lance.textSearch).toHaveBeenCalled(); release();
    await expect(promise).resolves.toEqual([expect.objectContaining({ text: "authoritative" })]);
  });

  it("returns typed repair action when active index is unavailable", async () => {
    const service = new RetrievalService({ db: {} as any, lance: {} as any, provider: {} as any, resolveSpace: async () => null });
    await expect(service.search("p1", "x")).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE", repair: true });
  });

  it("resolves the query provider from the active project's persisted space", async () => {
    const provider = { embedBatch: vi.fn(async () => [[1, 0]]) };
    const resolveSpace = vi.fn(async (projectId: string) => {
      expect(projectId).toBe("p1");
      return { id: "sp1", dimension: 2, state: "active", provider } as never;
    });
    const lance = { vectorSearch: vi.fn(async () => []), textSearch: vi.fn(async () => []) };
    const db = { prepare: vi.fn(() => ({ get: () => ({ space_id: "sp1", dimension: 2 }) })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn(async () => [[9, 9]]) } as any, resolveSpace });
    await service.search({ projectId: "p1", query: "hello", limit: 1 });
    expect(provider.embedBatch).toHaveBeenCalled();
  });

  it("rejects a cloud provider capability mismatch before embedding", async () => {
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const provider = {
      embedBatch,
      describe: () => ({ provider: "openai", modelId: "m", modelRevision: "wrong", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "persisted", chunkingVersion: "persisted" })
    };
    const lance = { vectorSearch: vi.fn(async () => []), textSearch: vi.fn(async () => []) };
    const db = { prepare: vi.fn((sql: string) => ({
      get: () => sql.includes("project_embedding_spaces") ? { space_id: "sp1", dimension: 2, provider: "openai", model_id: "m", model_revision: "expected" } : undefined
    })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn() } as any, resolveSpace: async () => ({ provider }) });
    await expect(service.search({ projectId: "p1", query: "hello", limit: 1 })).resolves.toMatchObject({ ok: false, error: { code: "INDEX_UNAVAILABLE" } });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it("rejects a local persisted capability mismatch before embedding", async () => {
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const provider = {
      embedBatch,
      describe: () => ({ provider: "local", modelId: "Xenova/multilingual-e5-small", modelRevision: "actual", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "persisted", chunkingVersion: "persisted" })
    };
    const lance = { vectorSearch: vi.fn(async () => []), textSearch: vi.fn(async () => []) };
    const db = { prepare: vi.fn((sql: string) => ({
      get: () => sql.includes("project_embedding_spaces") ? { space_id: "sp1", dimension: 2, provider: "local", model_id: "Xenova/multilingual-e5-small", model_revision: "expected" } : undefined
    })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn() } as any, resolveSpace: async () => ({ provider }) });
    await expect(service.search({ projectId: "p1", query: "hello", limit: 1 })).resolves.toMatchObject({ ok: false, error: { code: "INDEX_UNAVAILABLE" } });
    expect(embedBatch).not.toHaveBeenCalled();
  });
});
