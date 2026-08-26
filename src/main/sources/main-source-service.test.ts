import { describe, expect, it, vi } from "vitest";
import { MainSourceService } from "./main-source-service";

describe("main source import orchestration", () => {
  it("rolls back source and revision when durable task creation fails", async () => {
    const db = {
      transaction: vi.fn((fn: () => void) => () => { throw new Error("task create failed"); }),
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) }))
    } as any;
    const service = new MainSourceService(db, { createTask: vi.fn(() => { throw new Error("task create failed"); }) } as any, { run: vi.fn() } as any);
    await expect(service.importFile({ projectId: "00000000-0000-4000-8000-000000000001", path: "src/test/fixtures/text/bilingual-sample.txt" })).rejects.toThrow("task create failed");
    expect(db.transaction).toHaveBeenCalled();
  });
  it("persists source and task then starts the real ingestion service", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = { prepare: vi.fn((sql: string) => ({ run: (...args: unknown[]) => { if (sql.includes("sources")) rows.push({ id: args[0], project_id: args[1], kind: args[2], display_name: args[3], status: "active", current_revision_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null }); }, get: () => rows[0], all: () => rows })), transaction: (fn: () => void) => () => fn() } as any;
    const tasks = { createTask: vi.fn(() => ({ id: "00000000-0000-4000-8000-000000000003" })) } as any;
    const ingestion = { run: vi.fn(() => Promise.resolve()) } as any;
    const service = new MainSourceService(db, tasks, ingestion);
    const source = await service.importFile({ projectId: "00000000-0000-4000-8000-000000000001", path: "src/test/fixtures/text/bilingual-sample.txt" });
    expect(source.projectId).toBe("00000000-0000-4000-8000-000000000001");
    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: source.projectId, kind: "ingest" }));
    expect(ingestion.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: "00000000-0000-4000-8000-000000000003", kind: "text" }));
  });
});
