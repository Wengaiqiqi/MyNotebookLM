import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ProjectRepository } from "./project-repository";
import { ProjectService } from "./project-service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("durable project deletion", () => {
  let root: string;
  let database: AppDatabase;
  let repository: ProjectRepository;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-project-delete-"));
    database = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    repository = new ProjectRepository(database.connection);
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("upgrades projects with a forward deletion state and deleted_at", () => {
    const columns = database.connection.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["status", "deleted_at"]));
    repository.create({ id: PROJECT_ID, name: "Research" });
    expect(database.connection.prepare("SELECT status, deleted_at FROM projects WHERE id = ?").get(PROJECT_ID)).toEqual({ status: "active", deleted_at: null });
  });

  it("starts deletion as a queued cleanup with an undo grace period", () => {
    const service = new ProjectService(repository, () => PROJECT_ID);
    service.create({ name: "Research" });
    const deleted = (service as unknown as { remove(input: { id: string }): { status: string; deletedAt: string | null } }).remove({ id: PROJECT_ID });
    expect(deleted.status).toBe("deleting");
    expect(deleted.deletedAt).not.toBeNull();
    expect(database.connection.prepare("SELECT kind, state, stage FROM tasks WHERE project_id = ?").get(PROJECT_ID)).toMatchObject({ kind: "delete", state: "queued", stage: "cleanup" });
    expect((service as unknown as { restore(input: { id: string }): unknown }).restore({ id: PROJECT_ID })).toMatchObject({ status: "active", deletedAt: null });
  });

  it("keeps a failed cleanup retryable and does not repeat successful owners", async () => {
    let fail = true;
    let filesCalls = 0;
    const cleanup = { managedFiles: async () => { filesCalls += 1; if (fail) throw new Error("files unavailable"); }, lanceRows: async () => undefined };
    const service = new ProjectService(repository, () => PROJECT_ID, { ...cleanup, now: () => "2026-08-28T00:00:00.000Z" });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID, true)).rejects.toThrow("files unavailable");
    expect(repository.findById(PROJECT_ID)).toMatchObject({ status: "delete_failed" });
    fail = false;
    service.retryDelete({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID, true)).resolves.toBeNull();
    expect(filesCalls).toBe(2);
  });

  it("does not restore the project when managed files cannot be restored", () => {
    const service = new ProjectService(repository, () => PROJECT_ID, {
      restoreProjectFiles: () => { throw new Error("restore unavailable"); }
    });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    expect(() => service.restore({ id: PROJECT_ID })).toThrow("restore unavailable");
    expect(repository.findById(PROJECT_ID)).toMatchObject({ status: "delete_failed" });
  });

  it("keeps a successfully deleted project deleted when trash purge fails", async () => {
    const service = new ProjectService(repository, () => PROJECT_ID, {
      managedFiles: () => ({ rollback() {}, purge() { throw new Error("purge unavailable"); } }),
      lanceRows: () => undefined
    });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID, true)).resolves.toBeNull();
    expect(repository.findById(PROJECT_ID)).toBeNull();
  });

  it("publishes running, finalizing, and completed deletion task states", async () => {
    const states: string[] = [];
    const taskService = {
      start: vi.fn((id: string, stage: "cleanup") => { states.push(`running:${stage}`); return { id } as never; }),
      advance: vi.fn((_id: string, stage: "finalizing") => { states.push(`running:${stage}`); return {} as never; }),
      publishCompleted: vi.fn((_id: string) => { states.push("completed:finalizing"); return {} as never; }),
      fail: vi.fn()
    };
    const service = new ProjectService(repository, () => PROJECT_ID, { taskService, managedFiles: async () => undefined, lanceRows: async () => undefined });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID, true)).resolves.toBeNull();
    expect(states).toEqual(["running:cleanup", "running:finalizing", "completed:finalizing"]);
  });

  it("invalidates every embedding space when Lance cleanup is partial", async () => {
    const service = new ProjectService(repository, () => PROJECT_ID, {
      managedFiles: async () => undefined,
      lanceRows: async () => { throw new Error("second space failed"); },
      invalidateEmbeddingSpaces: (id) => {
        database.connection.prepare("UPDATE embedding_spaces SET state = 'failed' WHERE project_id = ?").run(id);
        database.connection.prepare("DELETE FROM project_embedding_spaces WHERE project_id = ?").run(id);
      }
    });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    database.connection.prepare("INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, progress_1000, created_at, updated_at) VALUES (?, ?, 'local', 'm', 'r', 2, 'cosine', 'mean', 'p', 'c', ?, ?, 1000, 'now', 'now')").run("33333333-3333-4333-8333-333333333333", PROJECT_ID, "fp", "active");
    expect(repository.findById(PROJECT_ID)?.status).toBe("deleting");
    await expect(service.runDeletion(PROJECT_ID, true)).rejects.toThrow("second space failed");
    expect(database.connection.prepare("SELECT state FROM embedding_spaces WHERE project_id = ?").get(PROJECT_ID)).toEqual({ state: "failed" });
    expect(database.connection.prepare("SELECT * FROM project_embedding_spaces WHERE project_id = ?").get(PROJECT_ID)).toBeUndefined();
  });

  it("does not publish completed when the final database delete fails", async () => {
    const states: string[] = [];
    const taskService = {
      start: vi.fn(() => { states.push("running"); return {} as never; }),
      advance: vi.fn(() => { states.push("finalizing"); return {} as never; }),
      publishCompleted: vi.fn(() => { states.push("completed"); return {} as never; }),
      fail: vi.fn(() => { states.push("failed"); return {} as never; })
    };
    const service = new ProjectService(repository, () => PROJECT_ID, { taskService, managedFiles: async () => undefined, lanceRows: async () => undefined });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    vi.spyOn(repository, "finishDeletion").mockImplementation(() => { throw new Error("delete failed"); });
    await expect(service.runDeletion(PROJECT_ID, true)).rejects.toThrow("delete failed");
    expect(states).not.toContain("completed");
    expect(states).toContain("failed");
  });

  it("keeps deletion successful when completion notification fails post-commit", async () => {
    const taskService = {
      start: vi.fn(() => ({}) as never),
      advance: vi.fn(() => ({}) as never),
      publishCompleted: vi.fn(() => { throw new Error("fanout failed"); }),
      fail: vi.fn()
    };
    const service = new ProjectService(repository, () => PROJECT_ID, { taskService, managedFiles: async () => undefined, lanceRows: async () => undefined });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID, true)).resolves.toBeNull();
    expect(repository.findById(PROJECT_ID)).toBeNull();
  });

  it("uses CAS so cleanup cannot start after undo", async () => {
    const service = new ProjectService(repository, () => PROJECT_ID, { managedFiles: async () => undefined, lanceRows: async () => undefined });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    service.undo({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID, true)).resolves.toMatchObject({ status: "active" });
    expect(repository.findById(PROJECT_ID)).toMatchObject({ status: "active" });
  });

  it("does not hard-delete before the thirty second undo grace", async () => {
    let now = "2026-08-28T00:00:00.000Z";
    const service = new ProjectService(repository, () => PROJECT_ID, { now: () => now, managedFiles: async () => undefined, lanceRows: async () => undefined });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    await expect(service.runDeletion(PROJECT_ID)).resolves.toMatchObject({ status: "deleting" });
    now = "2026-08-28T00:00:31.000Z";
    await expect(service.runDeletion(PROJECT_ID)).resolves.toBeNull();
    expect(repository.findById(PROJECT_ID)).toBeNull();
  });

  it("requeues stale running deletion after a restart", async () => {
    const service = new ProjectService(repository, () => PROJECT_ID, { now: () => "2026-08-28T00:01:00.000Z", managedFiles: async () => undefined, lanceRows: async () => undefined });
    service.create({ name: "Research" });
    service.remove({ id: PROJECT_ID });
    database.connection.prepare("UPDATE projects SET deleted_at = ?, status = 'deleting' WHERE id = ?").run("2026-08-27T23:00:00.000Z", PROJECT_ID);
    database.connection.prepare("UPDATE tasks SET state = 'running', stage = 'cleanup' WHERE project_id = ? AND kind = 'delete'").run(PROJECT_ID);
    await service.recoverStaleDeletions();
    expect(repository.findById(PROJECT_ID)).toBeNull();
  });

  it("reschedules a deletion still inside grace after restart", async () => {
    vi.useFakeTimers();
    try {
      let now = "2026-08-28T00:00:00.000Z";
      const service = new ProjectService(repository, () => PROJECT_ID, { now: () => now, autoStartDeletion: true, managedFiles: async () => undefined, lanceRows: async () => undefined });
      service.create({ name: "Research" });
      service.remove({ id: PROJECT_ID });
      now = "2026-08-28T00:00:10.000Z";
      await service.recoverStaleDeletions();
      now = "2026-08-28T00:00:31.000Z";
      await vi.advanceTimersByTimeAsync(20_001);
      expect(repository.findById(PROJECT_ID)).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
