import { describe, expect, it } from "vitest";
import { createTaskUpdateFanout } from "./task-updates";

const task = (projectId: string) => ({ id: "00000000-0000-4000-8000-000000000001", projectId, sourceId: null, kind: "ingest" as const, state: "running" as const, stage: "parsing" as const, progress: 1, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" });
describe("task update fanout", () => {
  it("filters by project and removes destroyed windows", () => {
    const sent: unknown[] = [];
    const alive = { webContents: { isDestroyed: () => false, send: (_c: string, value: unknown) => sent.push(value), on: () => undefined, removeListener: () => undefined } } as any;
    const dead = { webContents: { isDestroyed: () => true, send: () => { throw new Error("must not send"); }, on: () => undefined, removeListener: () => undefined } } as any;
    const project1 = "11111111-1111-4111-8111-111111111111";
    const project2 = "22222222-2222-4222-8222-222222222222";
    const fanout = createTaskUpdateFanout([alive, dead], { projectId: project1 });
    fanout(task(project2));
    fanout(task(project1));
    expect(sent).toHaveLength(1);
  });
});
