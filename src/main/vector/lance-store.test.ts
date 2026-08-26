import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LanceStore } from "./lance-store";

const space = { id: "space-1", dimension: 3 } as const;
const row = (id: string, vector: number[], text: string, extra = {}) => ({ chunkId: id, projectId: "project-1", sourceId: "source-1", revisionId: "revision-1", spaceId: space.id, ordinal: 0, contentHash: id, text, vector, locator: { b: 2, a: 1 }, createdAt: 1, ...extra });

describe("LanceStore", () => {
  it("creates/opens, upserts, counts, searches, filters and deletes real data", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-store-"));
    const store = await LanceStore.open(dir);
    try {
      await store.createSpace(space);
      await store.upsert(space, [row("c1", [1, 0, 0], "alpha beta"), row("c2", [0, 1, 0], "gamma")]);
      expect(await store.count(space)).toBe(2);
      expect((await store.vectorSearch(space, [1, 0, 0], 1))[0]?.chunkId).toBe("c1");
      expect((await store.textSearch(space, "alpha", 10))[0]?.chunkId).toBe("c1");
      expect((await store.vectorSearch(space, [1, 0, 0], 10, { projectId: "project-1" })).length).toBe(2);
      expect((await store.vectorSearch(space, [1, 0, 0], 10, { projectId: "other" })).length).toBe(0);
      const reopened = await LanceStore.open(dir);
      expect(await reopened.count(space)).toBe(2);
      await reopened.close();
      await store.deleteRevision(space, "revision-1");
      expect(await store.count(space)).toBe(0);
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects dimensions and serializes locators canonically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-store-"));
    const store = await LanceStore.open(dir);
    try { await store.createSpace(space); await expect(store.upsert(space, [row("bad", [1, 2], "x")])).rejects.toThrow(/dimension/); await store.upsert(space, [row("ok", [1, 0, 0], "x")]); expect((await store.rows(space))[0]?.locatorJson).toBe('{"a":1,"b":2}'); }
    finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("creates scalar indexes for metadata columns", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-index-"));
    const store = await LanceStore.open(dir);
    try {
      await store.createSpace(space);
      await store.upsert(space, [row("indexed", [1, 0, 0], "x")]);
      const indexes = await (store as any).db.openTable("space_space_1").then((t: any) => t.listIndices());
      expect(indexes.map((index: any) => index.name)).toEqual(expect.arrayContaining(["projectId_idx", "sourceId_idx", "revisionId_idx", "spaceId_idx"]));
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
