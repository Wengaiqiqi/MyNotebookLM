import { copyFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskDto } from "../../shared/tasks";
import { openAppDatabase, type AppDatabase } from "../db/database";
import {
  StaleTaskStateError,
  TaskNotFoundError,
  TaskRepository
} from "./task-repository";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "77777777-7777-4777-8777-777777777771";
const OTHER_TASK_ID = "77777777-7777-4777-8777-777777777772";

describe("TaskRepository", () => {
  let temporaryRoot: string;
  let appDatabase: AppDatabase;
  let repository: TaskRepository;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-tasks-"));
    appDatabase = openAppDatabase(
      path.join(temporaryRoot, "app.db"),
      path.resolve("src/main/db/migrations")
    );
    appDatabase.connection
      .prepare("INSERT INTO projects(id, name, archived) VALUES (?, ?, 0)")
      .run(PROJECT_ID, "Project");
    repository = new TaskRepository(appDatabase.connection);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function createTask(overrides: Partial<Parameters<TaskRepository["create"]>[0]> = {}): TaskDto {
    return repository.create({
      id: TASK_ID,
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest",
      idempotencyKey: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
      ...overrides
    });
  }

  it("creates a queued task at attempt zero with a non-negative progress", () => {
    const task = createTask();
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(0);
    expect(task.progress).toBe(0);
    expect(task.error).toBeNull();
    const row = repository.findById(TASK_ID);
    expect(row && row.state).toBe("queued");
  });

  it("accepts the transformation kind and preparing/generating/saving stages after migration", () => {
    const task = createTask({ id: TASK_ID, kind: "transformation", idempotencyKey: "transform-repo" });
    expect(task.kind).toBe("transformation");
    expect(repository.findByIdempotencyKey("transform-repo")?.id).toBe(TASK_ID);
    expect(repository.transition({ id: TASK_ID, expectedState: "queued", nextState: "running", stage: "preparing", updatedAt: "2026-08-25T00:00:00.001Z" }).stage).toBe("preparing");
    expect(repository.transition({ id: TASK_ID, expectedState: "running", nextState: "running", stage: "generating", updatedAt: "2026-08-25T00:00:00.002Z" }).stage).toBe("generating");
    expect(repository.transition({ id: TASK_ID, expectedState: "running", nextState: "running", stage: "saving", updatedAt: "2026-08-25T00:00:00.003Z" }).stage).toBe("saving");
  });

  it("upgrades a pre-011 database while retaining legacy tasks and foreign keys", () => {
    const upgradeRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-migration-011-"));
    const legacyMigrations = path.join(upgradeRoot, "migrations");
    mkdirSync(legacyMigrations);
    for (const file of readdirSync(path.resolve("src/main/db/migrations"))) {
      if (file < "011_transformation_tasks.sql") copyFileSync(path.resolve("src/main/db/migrations", file), path.join(legacyMigrations, file));
    }
    const databasePath = path.join(upgradeRoot, "app.db");
    const legacy = openAppDatabase(databasePath, legacyMigrations);
    legacy.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Legacy");
    legacy.connection.prepare("INSERT INTO tasks(id, project_id, kind, state, stage) VALUES (?, ?, 'ingest', 'queued', 'validating')").run(TASK_ID, PROJECT_ID);
    legacy.close();
    copyFileSync(path.resolve("src/main/db/migrations/011_transformation_tasks.sql"), path.join(legacyMigrations, "011_transformation_tasks.sql"));
    const upgraded = openAppDatabase(databasePath, legacyMigrations);
    expect(upgraded.connection.prepare("SELECT kind, stage FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ kind: "ingest", stage: "validating" });
    upgraded.connection.prepare("INSERT INTO tasks(id, project_id, kind, stage) VALUES (?, ?, 'transformation', 'preparing')").run(OTHER_TASK_ID, PROJECT_ID);
    expect(upgraded.connection.prepare("SELECT name FROM pragma_index_list('tasks')").pluck().all()).toEqual(expect.arrayContaining(["idx_tasks_project_state_created", "idx_tasks_source_created"]));
    expect(() => upgraded.connection.prepare("INSERT INTO insights(id, project_id, task_id, content, idempotency_key) VALUES (?, ?, ?, 'x', 'migration-fk')").run("99999999-9999-4999-8999-999999999990", PROJECT_ID, OTHER_TASK_ID)).not.toThrow();
    upgraded.close();
    rmSync(upgradeRoot, { recursive: true, force: true });
  });

  it("throws TaskNotFoundError when creating/transitioning unknown IDs", () => {
    expect(() => repository.transition({
      id: OTHER_TASK_ID,
      expectedState: "queued",
      nextState: "running",
      stage: "validating",
      updatedAt: "2026-08-25T00:00:00.001Z"
    })).toThrow(TaskNotFoundError);
    expect(() => repository.requestCancellation(OTHER_TASK_ID, "2026-08-25T00:00:00.001Z"))
      .toThrow(TaskNotFoundError);
  });

  it("leaves successful parsing tasks running for the awaiting_embedding stage", () => {
    let task = createTask();
    task = repository.transition({
      id: TASK_ID,
      expectedState: "queued",
      nextState: "running",
      stage: "parsing",
      updatedAt: "2026-08-25T00:00:00.001Z"
    });
    expect(task.state).toBe("running");
    task = repository.transition({
      id: TASK_ID,
      expectedState: "running",
      nextState: "running",
      stage: "parsing",
      updatedAt: "2026-08-25T00:00:00.002Z"
    });
    expect(task.state).toBe("running");
    expect(task.stage).toBe("parsing");
  });

  it("rejects an illegal transition via compare-and-swap", () => {
    createTask();
    expect(() => repository.transition({
      id: TASK_ID,
      expectedState: "running",
      nextState: "completed",
      stage: "finalizing",
      updatedAt: "2026-08-25T00:00:00.001Z"
    })).toThrow(StaleTaskStateError);
  });

  it("guards against regressing progress during a monotonic transition", () => {
    let task = createTask();
    task = repository.transition({
      id: TASK_ID,
      expectedState: "queued",
      nextState: "running",
      stage: "parsing",
      progress: 500,
      updatedAt: "2026-08-25T00:00:00.001Z"
    });
    expect(task.progress).toBe(500);
    expect(() => repository.transition({
      id: TASK_ID,
      expectedState: "running",
      nextState: "running",
      stage: "parsing",
      progress: 250,
      updatedAt: "2026-08-25T00:00:00.002Z"
    })).toThrow();
  });

  it("records a cancellation request by moving a queued/running task to cancelled", () => {
    let task = createTask();
    task = repository.requestCancellation(TASK_ID, "2026-08-25T00:00:00.001Z");
    expect(task.state).toBe("cancelled");
    expect(task.stage).toBe("validating");
  });

  it("rejects cancellation for an already finished task", () => {
    let task = createTask();
    task = repository.transition({
      id: TASK_ID,
      expectedState: "queued",
      nextState: "completed",
      stage: "finalizing",
      updatedAt: "2026-08-25T00:00:00.001Z"
    });
    expect(task.state).toBe("completed");
    expect(() => repository.requestCancellation(TASK_ID, "2026-08-25T00:00:00.002Z"))
      .toThrow(StaleTaskStateError);
  });

  it("maps error code/message into a safe DTO error summary", () => {
    createTask();
    const task = repository.transition({
      id: TASK_ID,
      expectedState: "queued",
      nextState: "failed",
      stage: "parsing",
      error: {
        code: "UNSAFE_INPUT",
        messageKey: "errors.unsafeInput",
        recoverable: false
      },
      updatedAt: "2026-08-25T00:00:00.001Z"
    });
    expect(task.error).toEqual({
      code: "UNSAFE_INPUT",
      messageKey: "errors.unsafeInput",
      recoverable: false
    });
  });

  it("rejects a duplicate idempotency key on create", () => {
    createTask({ id: TASK_ID, idempotencyKey: "op-1" });
    expect(() => createTask({ id: OTHER_TASK_ID, idempotencyKey: "op-1" }))
      .toThrow(/unique/i);
  });

  it("recovers stale running tasks only when they are older than the grace period", () => {
    createTask();
    repository.transition({
      id: TASK_ID,
      expectedState: "queued",
      nextState: "running",
      stage: "parsing",
      updatedAt: "2026-08-20T00:00:00.000Z"
    });
    const stale = repository.listRecoverableRunning("2026-08-25T00:00:00.000Z");
    expect(stale.map((t) => t.id)).toEqual([TASK_ID]);
    const fresh = repository.listRecoverableRunning("2026-08-19T00:00:00.000Z");
    expect(fresh).toEqual([]);
  });

  it("rejects a stale writer that would clobber a concurrent completion", () => {
    createTask();
    repository.transition({
      id: TASK_ID,
      expectedState: "queued",
      nextState: "running",
      stage: "parsing",
      updatedAt: "2026-08-25T00:00:00.001Z"
    });

    // A second, independent SQLite connection lets a concurrent actor write
    // at the exact read-check-then-write window that the transition hook
    // exposes. The actor's write commits on its own, so it is not rolled back
    // by the transition's own transaction.
    const secondConnection = new Database(path.join(temporaryRoot, "app.db"));
    secondConnection.pragma("busy_timeout = 5000");
    try {
      const hooked = new TaskRepository(appDatabase.connection, {
        beforeTransitionWrite: () => {
          secondConnection.prepare(
            "UPDATE tasks SET state = 'completed', updated_at = ? WHERE id = ?"
          ).run("2026-08-25T00:00:01.000Z", TASK_ID);
        }
      });

      expect(() => hooked.transition({
        id: TASK_ID,
        expectedState: "running",
        nextState: "running",
        stage: "parsing",
        progress: 400,
        updatedAt: "2026-08-25T00:00:02.000Z"
      })).toThrow(StaleTaskStateError);

      expect(repository.findById(TASK_ID)!.state).toBe("completed");
    } finally {
      secondConnection.close();
    }
  });
});
