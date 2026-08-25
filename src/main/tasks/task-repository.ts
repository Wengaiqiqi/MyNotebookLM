import type Database from "better-sqlite3";
import type { AppErrorCode } from "../../shared/app-errors";
import type { TaskDto, TaskErrorSummaryDto, TaskKind, TaskStage } from "../../shared/tasks";
import { isRetryableCode } from "./retry-policy";

type TaskRow = {
  id: string;
  project_id: string;
  source_id: string | null;
  kind: TaskKind;
  state: TaskDto["state"];
  stage: TaskStage;
  progress_1000: number;
  attempt: number;
  error_code: AppErrorCode | null;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
};

function toTaskDto(row: TaskRow): TaskDto {
  const errorCode = row.error_code;
  const error = errorCode
    ? {
        code: errorCode,
        messageKey: row.error_message ?? "errors.internal",
        recoverable: isRetryableCode(errorCode)
      }
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    kind: row.kind,
    state: row.state,
    stage: row.stage,
    progress: row.progress_1000,
    attempt: row.attempt,
    error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

export class StaleTaskStateError extends Error {
  constructor(id: string) {
    super(`Task state changed concurrently: ${id}`);
    this.name = "StaleTaskStateError";
  }
}

export type TaskTransition = {
  id: string;
  expectedState: "queued" | "running";
  nextState: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: TaskStage;
  progress?: number;
  attempt?: number;
  error?: TaskErrorSummaryDto;
  updatedAt: string;
};

export class TaskRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    id: string;
    projectId: string;
    sourceId: string | null;
    kind: TaskKind;
    idempotencyKey: string | null;
    updatedAt: string;
  }): TaskDto {
    this.db.prepare(`
      INSERT INTO tasks(
        id, project_id, source_id, kind, state, stage, progress_1000,
        attempt, error_code, error_message, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 'validating', 0, 0, NULL, NULL, ?, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.sourceId,
      input.kind,
      input.idempotencyKey,
      input.updatedAt,
      input.updatedAt
    );
    return this.read(input.id);
  }

  findById(id: string): TaskDto | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? toTaskDto(row) : null;
  }

  requestCancellation(id: string, updatedAt: string): TaskDto {
    const result = this.db.prepare(`
      UPDATE tasks
      SET state = 'cancelled', updated_at = ?
      WHERE id = ? AND state IN ('queued', 'running')
    `).run(updatedAt, id);
    if (result.changes === 0) {
      const current = this.findById(id);
      if (!current) throw new TaskNotFoundError(id);
      throw new StaleTaskStateError(id);
    }
    return this.read(id);
  }

  transition(input: TaskTransition): TaskDto {
    return this.db.transaction(() => {
      const current = this.findById(input.id);
      if (!current) throw new TaskNotFoundError(input.id);
      if (current.state !== input.expectedState) throw new StaleTaskStateError(input.id);

      const progress = input.progress ?? current.progress;
      if (input.progress !== undefined && progress < current.progress) {
        throw new StaleTaskStateError(input.id);
      }

      const attempt = input.attempt ?? current.attempt;
      const errorCode = input.error?.code ?? null;
      const errorMessage = input.error?.messageKey ?? null;
      this.db.prepare(`
        UPDATE tasks
        SET state = ?, stage = ?, progress_1000 = ?, attempt = ?,
            error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.nextState,
        input.stage,
        progress,
        attempt,
        errorCode,
        errorMessage,
        input.updatedAt,
        input.id
      );
      return this.read(input.id);
    })();
  }

  listRecoverableRunning(updatedBefore: string): TaskDto[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks WHERE state = 'running' AND updated_at < ?
    `).all(updatedBefore) as TaskRow[];
    return rows.map(toTaskDto);
  }

  private read(id: string): TaskDto {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    if (!row) throw new TaskNotFoundError(id);
    return toTaskDto(row);
  }
}
