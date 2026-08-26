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
});
