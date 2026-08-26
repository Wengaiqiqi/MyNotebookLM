import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LanceStore } from "./lance-store";

const space = { id: "00000000-0000-4000-8000-000000000001", dimension: 3 } as const;
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
      for (const [key, value] of [["projectId", "project-1"], ["sourceId", "source-1"], ["revisionId", "revision-1"], ["spaceId", space.id]] as const) {
        expect((await store.vectorSearch(space, [1, 0, 0], 10, { [key]: value })).length).toBe(2);
      }
      expect((await store.vectorSearch(space, [1, 0, 0], 10, { projectId: "other" })).length).toBe(0);
      await store.upsert(space, [row("quoted", [1, 0, 0], "quoted", { projectId: "O'Reilly" })]);
      expect((await store.vectorSearch(space, [1, 0, 0], 10, { projectId: "O'Reilly" })).map(item => item.chunkId)).toEqual(["quoted"]);
      await expect(store.vectorSearch(space, [1, 0, 0], 10, { unknown: "value" })).rejects.toThrow(/filter field/);
      const reopened = await LanceStore.open(dir);
      expect(await reopened.count(space)).toBe(3);
      await reopened.close();
      await store.deleteRevision(space, "revision-1");
      expect(await store.count(space)).toBe(0);
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("counts only the requested revision with a safe metadata filter", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-count-filter-")); const store = await LanceStore.open(dir);
    try { await store.createSpace(space); await store.upsert(space, [row("r1-a", [1, 0, 0], "a"), row("r2-a", [0, 1, 0], "b", { revisionId: "revision-2" })]); expect(await store.count(space)).toBe(2); expect(await store.count(space, { revisionId: "revision-1" })).toBe(1); expect(await store.count(space, { revisionId: "revision-2" })).toBe(1); await expect(store.count(space, { unknown: "x" } as never)).rejects.toThrow(/filter field/); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
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
      const indexes = await (store as any).db.openTable("space_00000000_0000_4000_8000_000000000001").then((t: any) => t.listIndices());
      expect(indexes.map((index: any) => index.name)).toEqual(expect.arrayContaining(["projectId_idx", "sourceId_idx", "revisionId_idx", "spaceId_idx"]));
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("serializes concurrent operations and releases the space lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-lock-"));
    const store = await LanceStore.open(dir);
    try {
      await store.createSpace(space);
      await Promise.all([store.deleteSpace(space), store.deleteSpace(space)]);
      await store.createSpace(space);
      await store.upsert(space, [row("after-lock", [1, 0, 0], "x")]);
      expect(await store.count(space)).toBe(1);
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("optimizes explicitly while reads remain available", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-optimize-")); const store = await LanceStore.open(dir);
    try { await store.createSpace(space); await store.upsert(space, [row("read", [1, 0, 0], "read")]); const started = Date.now(); await Promise.all([store.optimize(space), store.count(space)]); expect(Date.now() - started).toBeLessThan(5000); expect(await store.count(space)).toBe(1); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("serializes filtered count and optimize with writes and deletes, and close waits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-lifecycle-")); const store = await LanceStore.open(dir);
    try {
      await store.createSpace(space); await store.upsert(space, [row("one", [1, 0, 0], "one")]);
      const pending = store.optimize(space); const closing = store.close();
      await expect(store.count(space)).rejects.toThrow(/closed|closing/); await pending; await closing;
      await expect(store.rows(space)).rejects.toThrow(/closed|closing/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects non-UUID spaces and rows with invalid columns or vectors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-validation-"));
    const store = await LanceStore.open(dir);
    try {
      await expect(store.createSpace({ id: "space-1", dimension: 3 })).rejects.toThrow(/UUID/);
      await store.createSpace(space);
      await expect(store.upsert(space, [row("wrong-space", [1, 0, 0], "x", { spaceId: "00000000-0000-4000-8000-000000000002" })])).rejects.toThrow(/spaceId/);
      await expect(store.upsert(space, [row("nan", [1, Number.NaN, 0], "x")])).rejects.toThrow(/finite/);
      await expect(store.upsert(space, [row("missing", [1, 0, 0], "x", { text: undefined })])).rejects.toThrow(/text/);
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("builds ANN only at a reliable size and verifies recall on distinct vectors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lance-ann-"));
    const store = await LanceStore.open(dir);
    try {
      await store.createSpace(space);
      await store.upsert(space, [row("small", [1, 0, 0], "x")]);
      const smallIndexes = await (await (store as any).db.openTable("space_00000000_0000_4000_8000_000000000001")).listIndices();
      expect(smallIndexes).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "vector_ann_idx" })]));
      await store.upsert(space, Array.from({ length: 4094 }, (_, i) => {
        const angle = (i / 4095) * Math.PI * 2;
        return row(`large-${i}`, [Math.cos(angle), Math.sin(angle), (i % 17) / 17], "x");
      }));
      const beforeThreshold = await (await (store as any).db.openTable("space_00000000_0000_4000_8000_000000000001")).listIndices();
      expect(beforeThreshold).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "vector_ann_idx" })]));
      await store.upsert(space, [row("target", [0, 1, 0], "target")]);
      const indexes = await (store as any).db.openTable("space_00000000_0000_4000_8000_000000000001").then((t: any) => t.listIndices());
      expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ name: "vector_ann_idx" })]));
      expect((await store.vectorSearch(space, [0, 1, 0], 1))[0]?.chunkId).toBe("target");
      await expect(store.upsert(space, [row("target", [0, 1, 0], "target")])).resolves.toBeUndefined();
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});
