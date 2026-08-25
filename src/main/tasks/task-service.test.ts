import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskDto } from "../../shared/tasks";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { MAX_ATTEMPTS } from "./retry-policy";
import { TaskRepository } from "./task-repository";
import { TaskService } from "./task-service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "77777777-7777-4777-8777-777777777771";
const clock = { value: "2026-08-25T00:00:00.000Z" };

describe("TaskService", () => {
  let temporaryRoot: string;
  let appDatabase: AppDatabase;
  let repository: TaskRepository;
  let service: TaskService;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-task-service-"));
    appDatabase = openAppDatabase(
      path.join(temporaryRoot, "app.db"),
      path.resolve("src/main/db/migrations")
    );
    appDatabase.connection
      .prepare("INSERT INTO projects(id, name, archived) VALUES (?, ?, 0)")
      .run(PROJECT_ID, "Project");
    repository = new TaskRepository(appDatabase.connection);
    clock.value = "2026-08-25T00:00:00.000Z";
    service = new TaskService(repository, {
      now: () => clock.value,
      random: () => 0,
      id: () => TASK_ID
    });
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("creates, starts, advances, and completes a task through the legal lifecycle", () => {
    const created = service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    expect(created.state).toBe("queued");

    clock.value = "2026-08-25T00:00:01.000Z";
    const running = service.start(TASK_ID, "parsing");
    expect(running.state).toBe("running");
    expect(running.stage).toBe("parsing");

    clock.value = "2026-08-25T00:00:02.000Z";
    const advanced = service.advance(TASK_ID, "parsing", 350);
    expect(advanced.progress).toBe(350);
    expect(advanced.state).toBe("running");

    clock.value = "2026-08-25T00:00:03.000Z";
    const completed = service.complete(TASK_ID);
    expect(completed.state).toBe("completed");
  });

  it("keeps a successful parsing task running for the awaiting_embedding stage", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    service.start(TASK_ID, "parsing");
    const after = service.advance(TASK_ID, "parsing", 1000);
    expect(after.state).toBe("running");
    expect(after.stage).toBe("parsing");
  });

  it("refuses to start a task that is not queued", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    service.start(TASK_ID, "parsing");
    expect(() => service.start(TASK_ID, "parsing")).toThrow();
  });

  it("cancels a queued or running task on request", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    const cancelled = service.cancel(TASK_ID);
    expect(cancelled.state).toBe("cancelled");
  });

  it.each([
    ["AUTH", "errors.auth"],
    ["VALIDATION", "errors.validation"],
    ["UNSAFE_INPUT", "errors.unsafeInput"],
    ["UNSUPPORTED_FORMAT", "errors.unsupportedFormat"],
    ["CANCELLED", "errors.cancelled"]
  ] as const)("never auto-retries non-retryable %s", (code, messageKey) => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    service.start(TASK_ID, "parsing");
    const failed = service.fail(TASK_ID, { code, messageKey, recoverable: false });
    expect(failed.state).toBe("failed");
    expect(failed.attempt).toBe(0);
    expect(failed.error).toEqual({ code, messageKey, recoverable: false });
  });

  it("requeues a retryable failure with an incremented attempt below the cap", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    service.start(TASK_ID, "parsing");
    const failed = service.fail(TASK_ID, {
      code: "RATE_LIMITED",
      messageKey: "errors.rateLimited",
      recoverable: true
    });
    expect(failed.state).toBe("queued");
    expect(failed.attempt).toBe(1);
  });

  it("fails after exhausting the five-attempt cap", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const task = service.start(TASK_ID, "parsing");
      expect(task.attempt).toBe(attempt - 1);
      const failed = service.fail(TASK_ID, {
        code: "RATE_LIMITED",
        messageKey: "errors.rateLimited",
        recoverable: true
      });
      if (attempt < MAX_ATTEMPTS) {
        expect(failed.state).toBe("queued");
        expect(failed.attempt).toBe(attempt);
      } else {
        expect(failed.state).toBe("failed");
      }
    }
  });

  it("recovers a stale running task by requeueing with attempt + 1 when still retryable", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    service.start(TASK_ID, "parsing");
    // Simulate an idle running task left behind by a crash.
    clock.value = "2026-08-26T12:00:00.000Z";
    const recovered = service.recoverStaleRunning(60 * 60 * 1000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.state).toBe("queued");
    expect(recovered[0]!.attempt).toBe(1);
  });

  it("marks an exhausted stale running task as failed with an interrupted summary", () => {
    const created = service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    // Force the attempt count to the cap before it died.
    appDatabase.connection
      .prepare("UPDATE tasks SET attempt = ? WHERE id = ?")
      .run(MAX_ATTEMPTS, TASK_ID);
    void created;
    expect(created.attempt).toBe(0);
    service.start(TASK_ID, "parsing");
    // attempt is now 5 in db, running at cap.
    clock.value = "2026-08-26T12:00:00.000Z";
    const recovered = service.recoverStaleRunning(60 * 60 * 1000);
    expect(recovered[0]!.state).toBe("failed");
    expect(recovered[0]!.error?.messageKey).toBe("errors.interrupted");
  });

  it("computes exponential retry delays with bounded jitter through the service", () => {
    const noJitter = new TaskService(repository, {
      now: () => clock.value,
      random: () => 0,
      id: () => TASK_ID
    });
    expect(noJitter.retryDelayFor(1)).toBe(1000);
    expect(noJitter.retryDelayFor(2)).toBe(2000);
    expect(noJitter.retryDelayFor(5)).toBe(16000);
    expect(noJitter.retryDelayFor(6)).toBe(16000);
  });

  it("leaves fresh running tasks untouched during recovery", () => {
    service.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    service.start(TASK_ID, "parsing");
    const recovered = service.recoverStaleRunning(60 * 60 * 1000);
    expect(recovered).toEqual([]);
  });

  it("recovers a stale running task across a real temporary SQLite restart", () => {
    // Producer side: create, start, then simulate a crash that leaves it running.
    const crashDb = openAppDatabase(
      path.join(temporaryRoot, "restart.db"),
      path.resolve("src/main/db/migrations")
    );
    crashDb.connection
      .prepare("INSERT INTO projects(id, name, archived) VALUES (?, ?, 0)")
      .run(PROJECT_ID, "Project");
    const crashRepo = new TaskRepository(crashDb.connection);
    const crashService = new TaskService(crashRepo, {
      now: () => "2026-08-25T00:00:00.000Z",
      random: () => 0,
      id: () => TASK_ID
    });
    crashService.createTask({
      projectId: PROJECT_ID,
      sourceId: null,
      kind: "ingest"
    });
    crashService.start(TASK_ID, "parsing");
    // Leave it running, simulating a process kill before it completed.
    crashDb.close();

    // Consumer side: reopen the same physical database and recover.
    const recoveredDb = openAppDatabase(
      path.join(temporaryRoot, "restart.db"),
      path.resolve("src/main/db/migrations")
    );
    const recoveredRepo = new TaskRepository(recoveredDb.connection);
    const recoveredService = new TaskService(recoveredRepo, {
      now: () => "2026-08-26T12:00:00.000Z",
      random: () => 0,
      id: () => TASK_ID
    });
    const recovered = recoveredService.recoverStaleRunning(60 * 60 * 1000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.state).toBe("queued");
    expect(recovered[0]!.attempt).toBe(1);
    recoveredDb.close();
  });
});
