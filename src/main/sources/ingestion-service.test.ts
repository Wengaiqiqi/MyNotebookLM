import { describe, expect, it } from "vitest";
import { IngestionService, throttleProgress } from "./ingestion-service";

describe("ingestion progress", () => {
  it("emits at most ten progress events per task per second", () => {
    const emitted: number[] = [];
    const send = throttleProgress("task", (value) => emitted.push(value), () => 1000);
    for (let i = 0; i < 20; i++) send(i);
    expect(emitted).toHaveLength(10);
  });
  it("persists only a successful worker result through the service boundary", async () => {
    const calls: unknown[] = [];
    const db = { transaction: (fn: () => void) => () => fn(), prepare: () => ({ all: () => [], get: () => undefined, run: (...args: unknown[]) => ({ changes: calls.push(args) && 1 }) }) } as any;
    const service = new IngestionService({ start: async () => ({ version: 1, type: "result", taskId: "task", chunks: [] }), cancel: () => undefined }, db);
    await service.run({ taskId: "task", revisionId: "revision", kind: "text", data: new Uint8Array(), updatedAt: "now" });
    expect(calls.length).toBeGreaterThan(0);
  });
  it("registers durable payload loading for crash recovery", () => {
    let loaded = "";
    const pool = { start: async () => ({ version: 1, type: "result", taskId: "task", chunks: [] }), cancel: () => undefined, setDurablePayloadLoader: (load: (taskId: string) => unknown) => { loaded = String(load("task")); } } as any;
    new IngestionService(pool, {} as any, () => ({ kind: "text", data: new Uint8Array() }));
    expect(loaded).toContain("object");
  });

  it("continues indexing with the active space bound to the revision project", async () => {
    const indexed: unknown[] = [];
    const db = { transaction: (fn: () => void) => () => fn(), prepare: (sql: string) => ({
      all: () => [],
      run: () => ({ changes: 1 }),
      get: () => sql.includes("project_embedding_spaces") ? { id: "space-1", dimension: 2 } : { project_id: "project-1" }
    }) } as never;
    const service = new IngestionService({ start: async () => ({ version: 1, type: "result", taskId: "task", chunks: [] }), cancel: () => undefined }, db, undefined, undefined, { index: async (value: { revisionId: string; space: unknown }) => { indexed.push(value); } } as unknown as import("../vector/indexing-service").IndexingService);
    await service.run({ taskId: "task", revisionId: "revision", kind: "text", data: new Uint8Array(), updatedAt: "now" });
    expect(indexed[0]).toMatchObject({ revisionId: "revision", space: { id: "space-1" } });
  });
});
