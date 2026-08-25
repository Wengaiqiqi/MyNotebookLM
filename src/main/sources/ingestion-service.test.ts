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
    const db = { transaction: (fn: () => void) => () => fn(), prepare: () => ({ run: (...args: unknown[]) => calls.push(args) }) } as any;
    const service = new IngestionService({ start: async () => ({ version: 1, type: "result", taskId: "task", chunks: [] }), cancel: () => undefined }, db);
    await service.run({ taskId: "task", revisionId: "revision", kind: "text", data: new Uint8Array(), updatedAt: "now" });
    expect(calls.length).toBeGreaterThan(0);
  });
});
