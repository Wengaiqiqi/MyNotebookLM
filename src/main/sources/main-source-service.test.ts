import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MainSourceService } from "./main-source-service";

describe("main source import orchestration", () => {
  it("runs file preflight before creating a source task", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-preflight-"));
    const file = path.join(root, "report.pdf");
    writeFileSync(file, "not a pdf");
    try {
      const service = new MainSourceService({} as any, { createTask: vi.fn() } as any, { run: vi.fn() } as any);
      await expect(service.importFile({ projectId: "project-1", path: file })).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects private URL targets before network access", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const service = new MainSourceService({} as any, {} as any, {} as any);
    await expect(service.importUrl({ projectId: "project-1", url: "http://127.0.0.1/secret" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when no safe URL adapter is configured", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const service = new MainSourceService({} as any, {} as any, {} as any);
    await expect(service.importUrl({ projectId: "project-1", url: "https://public.example/article" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries a failed task by reading the authoritative revision and restarting ingestion", async () => {
    const task = { id: "44444444-4444-4444-8444-444444444444", projectId: "project-1", sourceId: "55555555-5555-4555-8555-555555555555", state: "failed", stage: "parsing", kind: "ingest" };
    const calls: string[] = [];
    const db = { prepare: vi.fn((sql: string) => ({ get: vi.fn(() => sql.includes("source_revisions") ? { id: "66666666-6666-4666-8666-666666666666", stored_path: "src/test/fixtures/text/bilingual-sample.txt", kind: "text", source_id: task.sourceId } : task), run: vi.fn(), all: vi.fn(() => []) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const tasks = { getById: vi.fn(() => task), retry: vi.fn(() => ({ ...task, state: "queued" })), start: vi.fn(() => { calls.push("start"); return { ...task, state: "running" }; }), fail: vi.fn() } as any;
    const ingestion = { run: vi.fn(async () => { calls.push("run"); }) } as any;
    const service = new MainSourceService(db, tasks, ingestion);
    await service.retryTask({ projectId: task.projectId, sourceId: task.sourceId });
    expect(tasks.retry).toHaveBeenCalledWith(task.id, "staging");
    expect(tasks.start).toHaveBeenCalledWith(task.id, "parsing");
    await vi.waitFor(() => expect(ingestion.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, revisionId: "66666666-6666-4666-8666-666666666666", kind: "text" })));
    expect(calls).toEqual(["start", "run"]);
  });

  it("stops active ingestion and cleans derived source data before marking deleted", () => {
    const sql: string[] = [];
    const db = { prepare: vi.fn((query: string) => { sql.push(query); return { get: vi.fn(() => ({})), all: vi.fn(() => query.includes("tasks") ? [{ id: "77777777-7777-4777-8777-777777777777" }] : []), run: vi.fn() }; }), transaction: (fn: () => unknown) => () => fn() } as any;
    const ingestion = { cancel: vi.fn() } as any;
    const tasks = { cancel: vi.fn() } as any;
    const service = new MainSourceService(db, tasks, ingestion);
    service.removeSource({ projectId: "project-1", sourceId: "66666666-6666-4666-8666-666666666666" });
    expect(ingestion.cancel).toHaveBeenCalledWith("77777777-7777-4777-8777-777777777777");
    expect(tasks.cancel).toHaveBeenCalledWith("77777777-7777-4777-8777-777777777777");
    expect(sql.some((query) => query.includes("DELETE FROM source_chunks"))).toBe(true);
    expect(sql.some((query) => query.includes("DELETE FROM source_revisions"))).toBe(true);
    expect(sql.filter((query) => query.includes("UPDATE sources SET status")).length).toBe(2);
  });

  it("stores URL payload and passes its bound revision to ingestion", async () => {
    const db = { prepare: vi.fn((sql: string) => ({ run: vi.fn(), get: vi.fn(() => ({ id: "task-1", project_id: "project-1", kind: "url", display_name: "example.com", status: "active", current_revision_id: null, created_at: "now", updated_at: "now", deleted_at: null })), all: vi.fn(() => []) })), transaction: (fn: () => unknown) => () => fn() } as any;
    const tasks = { createTask: vi.fn(() => ({ id: "task-1" })) } as any;
    const ingestion = { run: vi.fn(() => Promise.resolve()) } as any;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("payload", { status: 200 })));
    const service = new MainSourceService(db, tasks, ingestion, "D:/managed-files", undefined, { fetch: vi.fn(async () => ({ finalUrl: "https://example.com/article", title: "Article", text: "payload", sections: [], contentHash: "hash" })) });
    await service.importUrl({ projectId: "project-1", url: "https://example.com/article" });
    expect(ingestion.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", revisionId: expect.any(String) }));
    const revisionInsert = db.prepare.mock.calls.find(([sql]: [string]) => String(sql).includes("source_revisions"));
    expect(revisionInsert).toBeTruthy();
    expect(String(revisionInsert![0])).toContain("stored_path");
    expect(revisionInsert![0]).not.toContain("https://example.com/article");
  });
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

  it("persists sanitized error evidence when ingestion fails", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = { prepare: vi.fn((sql: string) => ({
      run: (...args: unknown[]) => { if (sql.includes("sources")) rows.push({ id: args[0], project_id: args[1], kind: args[2], display_name: args[3], status: "active", current_revision_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null }); },
      get: () => rows[0],
      all: () => rows
    })), transaction: (fn: () => void) => () => fn() } as any;
    const fail = vi.fn();
    const tasks = { createTask: vi.fn(() => ({ id: "00000000-0000-4000-8000-000000000003" })), fail } as any;
    const ingestion = { run: vi.fn(async () => { throw Object.assign(new Error("provider failed api_key=SECRET"), { code: "PROVIDER" }); }) } as any;
    const service = new MainSourceService(db, tasks, ingestion);
    await service.importFile({ projectId: "00000000-0000-4000-8000-000000000001", path: "src/test/fixtures/text/bilingual-sample.txt" });
    await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
    expect(fail).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000003", expect.objectContaining({ code: "PROVIDER", recoverable: true }), false);
    expect(fail.mock.calls[0]![1].messageKey).toBe("errors.provider");
  });

  it("returns persisted failure evidence when listing tasks", () => {
    const taskRow = {
      id: "00000000-0000-4000-8000-000000000003",
      project_id: "00000000-0000-4000-8000-000000000001",
      source_id: null,
      kind: "ingest",
      state: "failed",
      stage: "parsing",
      progress_1000: 0,
      attempt: 0,
      error_code: "PROVIDER",
      error_message: "errors.provider_failed",
      idempotency_key: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    const db = { prepare: vi.fn(() => ({ all: vi.fn(() => [taskRow]) })) } as any;
    const service = new MainSourceService(db, {} as any, {} as any);

    expect(service.listTasks(taskRow.project_id)[0]?.error).toEqual({
      code: "PROVIDER",
      messageKey: "errors.provider",
      recoverable: true
    });
  });

  it("never exposes arbitrary persisted error text in task DTOs", () => {
    const row = { id: "task", project_id: "project", source_id: null, kind: "ingest", state: "failed", stage: "parsing", progress_1000: 0, attempt: 0, error_code: "PROVIDER", error_message: "provider failed: api_key=SECRET", idempotency_key: null, created_at: "now", updated_at: "now" };
    const service = new MainSourceService({ prepare: vi.fn(() => ({ all: () => [row] })) } as any, {} as any, {} as any);
    expect(service.listTasks("project")[0]?.error).toEqual({ code: "PROVIDER", messageKey: "errors.provider", recoverable: true });
  });

  it("returns managed file size without exposing its stored path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-source-size-"));
    const stored = path.join(root, "managed.bin");
    writeFileSync(stored, "123456");
    const row = { id: "22222222-2222-4222-8222-222222222222", project_id: "11111111-1111-4111-8111-111111111111", kind: "pdf", display_name: "Report.pdf", status: "active", current_revision_id: "33333333-3333-4333-8333-333333333333", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null, current_locator: "C:\\original\\Report.pdf", current_stored_path: stored, current_revision_state: "ready" };
    try {
      const db = { prepare: vi.fn(() => ({ all: () => [row] })) } as any;
      const service = new MainSourceService(db, {} as any, {} as any, root);
      const result = service.listSources(row.project_id)[0]!;
      expect(result.sizeBytes).toBe(6);
      expect(result).not.toHaveProperty("storedPath");
      expect(result.locator).toBe("Report.pdf");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("lists the latest failed revision while current_revision_id is still null", () => {
    const row = { id: "22222222-2222-4222-8222-222222222222", project_id: "11111111-1111-4111-8111-111111111111", kind: "pdf", display_name: "Report.pdf", status: "active", current_revision_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null, current_locator: "C:\\original\\Report.pdf", current_stored_path: "C:\\managed\\content", current_revision_state: "failed" };
    const prepare = vi.fn((_sql: string) => ({ all: () => [row] }));
    const result = new MainSourceService({ prepare } as any, {} as any, {} as any).listSources(row.project_id)[0]!;
    expect(result.currentRevisionState).toBe("failed");
    expect(String(prepare.mock.calls[0]?.[0])).toMatch(/current_revision_id.*source_revisions|COALESCE|ORDER BY.*created_at/is);
  });

  it("omits size when the managed file is unavailable or the source is a URL", () => {
    const rows = [
      { id: "22222222-2222-4222-8222-222222222222", project_id: "project", kind: "pdf", display_name: "Missing.pdf", status: "active", current_revision_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null, current_locator: "C:\\original\\Missing.pdf", current_stored_path: "C:\\missing\\managed.pdf", current_revision_state: "ready" },
      { id: "33333333-3333-4333-8333-333333333333", project_id: "project", kind: "url", display_name: "Public", status: "active", current_revision_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null, current_locator: "https://example.com/public", current_stored_path: "C:\\managed\\secret", current_revision_state: "ready" }
    ];
    const db = { prepare: vi.fn(() => ({ all: () => rows })) } as any;
    const result = new MainSourceService(db, {} as any, {} as any).listSources("project");
    expect(result[0]).not.toHaveProperty("sizeBytes");
    expect(result[1]).not.toHaveProperty("sizeBytes");
    expect(result[1]).not.toHaveProperty("storedPath");
    expect(result[1]?.locator).toBe("https://example.com/public");
  });

  it("omits size for managed paths outside the storage root and intermediate symlinks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-source-boundary-"));
    const outside = mkdtempSync(path.join(tmpdir(), "mynotebooklm-source-outside-"));
    const file = path.join(outside, "outside.txt"); writeFileSync(file, "outside");
    const linkDir = path.join(root, "link-dir");
    try {
      const row = (stored: string) => ({ id: "22222222-2222-4222-8222-222222222222", project_id: "project", kind: "text", display_name: "Note", status: "active", current_revision_id: "revision", created_at: "now", updated_at: "now", deleted_at: null, current_locator: "Note.txt", current_stored_path: stored, current_revision_state: "ready" });
      const outsideResult = new MainSourceService({ prepare: vi.fn(() => ({ all: () => [row(file)] })) } as any, {} as any, {} as any, root).listSources("project");
      expect(outsideResult[0]).not.toHaveProperty("sizeBytes");
      symlinkSync(outside, linkDir, process.platform === "win32" ? "junction" : "dir");
      const symlinkResult = new MainSourceService({ prepare: vi.fn(() => ({ all: () => [row(path.join(linkDir, "outside.txt"))] })) } as any, {} as any, {} as any, root).listSources("project");
      expect(symlinkResult[0]).not.toHaveProperty("sizeBytes");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
