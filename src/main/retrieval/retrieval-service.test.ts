import { describe, expect, it, vi } from "vitest";
import { RetrievalService } from "./retrieval-service";

describe("RetrievalService", () => {
  it("runs ANN and BM25 in parallel and revalidates active revision/project", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const lance = { vectorSearch: vi.fn(async () => { await gate; return [{ chunkId: "c1", contentHash: "h1", sourceId: "s1", revisionId: "r1", ordinal: 0, text: "stale", locatorJson: "{}" }]; }), textSearch: vi.fn(async () => [{ chunkId: "c1", contentHash: "h1", sourceId: "s1", revisionId: "r1", ordinal: 0, text: "stale", locatorJson: "{}" }]) };
    const db = { prepare: vi.fn(() => ({ get: () => ({ project_id: "p1", status: "active", current_revision_id: "r1", revision_state: "ready", space_state: "active", chunk_id: "c1", source_id: "s1", revision_id: "r1", text: "authoritative", locator_json: "{\"page\":1}" }) })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn(async () => [[1, 0]]) } as any });
    const promise = service.search("p1", "hello"); await new Promise(r => setTimeout(r, 0)); expect(lance.textSearch).toHaveBeenCalled(); release();
    await expect(promise).resolves.toEqual([expect.objectContaining({ text: "authoritative" })]);
    expect(lance.textSearch).toHaveBeenCalledWith(expect.anything(), "hello", 160, { projectId: "p1" });
    expect(lance.vectorSearch).toHaveBeenCalledWith(expect.anything(), [1, 0], 160, { projectId: "p1" });
  });

  it("returns the complete structural parent when one question spans several chunks", async () => {
    const row = (ordinal: number, heading = "第 2 题（28 分）") => ({ chunk_id: `c${ordinal}`, content_hash: `h${ordinal}`, ordinal, source_id: "s1", revision_id: "r1", text: `${heading}\n\npart ${ordinal}`, locator_json: `{"kind":"page","page":${ordinal}}` });
    const db = { prepare: vi.fn((sql: string) => {
      if (sql.includes("project_embedding_spaces")) return { get: () => ({ space_id: "sp1", dimension: 2 }) };
      if (sql.includes("sc.id = ?")) return { get: () => row(7) };
      return { all: () => [row(4), row(5), row(6), row(7), row(8, "第 3 题（12 分）")] };
    }) } as any;
    const lance = {
      vectorSearch: vi.fn(async () => [{ chunkId: "c7", contentHash: "h7", ordinal: 7 }]),
      textSearch: vi.fn(async () => [{ chunkId: "c7", contentHash: "h7", ordinal: 7 }])
    };
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn(async () => [[1, 0]]) } as any });

    await expect(service.search({ projectId: "p1", query: "第二题", limit: 8 })).resolves.toMatchObject({
      ok: true,
      value: [{ chunkId: "c4" }, { chunkId: "c5" }, { chunkId: "c6" }, { chunkId: "c7" }]
    });
  });

  it("returns typed repair action when active index is unavailable", async () => {
    const service = new RetrievalService({ db: {} as any, lance: {} as any, provider: {} as any, resolveSpace: async () => null });
    await expect(service.search("p1", "x")).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE", repair: true });
  });

  it("fails closed without calling the fallback provider when the configured resolver returns null", async () => {
    const fallback = { embedBatch: vi.fn(async () => [[1, 0]]) };
    const lance = { vectorSearch: vi.fn(async () => []), textSearch: vi.fn(async () => []) };
    const db = { prepare: vi.fn(() => ({ get: () => ({ space_id: "sp1", provider: "local", model_id: "m", model_revision: "r", dimension: 2, distance: "cosine", pooling: "mean", preprocess_version: "v1", chunking_version: "v1", fingerprint: "persisted-fingerprint" }) })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: fallback as any, resolveSpace: async () => null });

    await expect(service.search({ projectId: "p1", query: "hello", limit: 1 })).resolves.toMatchObject({ ok: false, error: { code: "INDEX_UNAVAILABLE", recoverable: true } });
    expect(fallback.embedBatch).not.toHaveBeenCalled();
    expect(lance.textSearch).not.toHaveBeenCalled();
  });

  it.each(["local", "openai"])("resolves the %s query provider from the active project's persisted space", async (kind) => {
    const capability = { provider: kind, modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "v1", chunkingVersion: "v1" };
    const provider = { embedBatch: vi.fn(async () => [[1, 0]]), describe: () => capability };
    const resolveSpace = vi.fn(async (projectId: string, space: { fingerprint: string }) => {
      expect(projectId).toBe("p1");
      return { id: "sp1", dimension: 2, state: "active", provider } as never;
    });
    const lance = { vectorSearch: vi.fn(async () => []), textSearch: vi.fn(async () => []) };
    const db = { prepare: vi.fn(() => ({ get: () => ({ space_id: "sp1", dimension: 2, provider: kind, model_id: "m", model_revision: "r", distance: "cosine", pooling: "mean", preprocess_version: "v1", chunking_version: "v1", fingerprint: "persisted-fingerprint" }) })) } as any;
    const service = new RetrievalService({ db, lance: lance as any, provider: { embedBatch: vi.fn(async () => [[9, 9]]) } as any, resolveSpace });
    await expect(service.search({ projectId: "p1", query: "hello", limit: 1 })).resolves.toEqual({ ok: true, value: [] });
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
