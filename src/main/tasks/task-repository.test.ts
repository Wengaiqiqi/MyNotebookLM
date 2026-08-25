import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
