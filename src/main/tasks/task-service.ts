import type { TaskErrorSummaryDto, TaskDto, TaskKind, TaskStage } from "../../shared/tasks";
import { MAX_ATTEMPTS, canRetry, isRetryableCode, retryDelayMs } from "./retry-policy";
import type { TaskRepository } from "./task-repository";

export type TaskServiceDeps = {
  now: () => string;
  random: () => number;
  id: () => string;
};

const INTERRUPTED_ERROR: TaskErrorSummaryDto = {
  code: "INTERNAL",
  messageKey: "errors.interrupted",
  recoverable: false
};

export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly deps: TaskServiceDeps
  ) {}

  createTask(input: {
    projectId: string;
    sourceId: string | null;
    kind: TaskKind;
    idempotencyKey?: string;
  }): TaskDto {
    return this.repository.create({
      id: this.deps.id(),
      ...input,
      idempotencyKey: input.idempotencyKey ?? null,
      updatedAt: this.deps.now()
    });
  }

  start(taskId: string, stage: TaskStage): TaskDto {
    const current = this.repository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    return this.repository.transition({
      id: taskId,
      expectedState: "queued",
      nextState: "running",
      stage,
      attempt: current.attempt,
      updatedAt: this.deps.now()
    });
  }

  advance(taskId: string, stage: TaskStage, progress: number): TaskDto {
    return this.repository.transition({
      id: taskId,
      expectedState: "running",
      nextState: "running",
      stage,
      progress,
      updatedAt: this.deps.now()
    });
  }

  complete(taskId: string): TaskDto {
    return this.repository.transition({
      id: taskId,
      expectedState: "running",
      nextState: "completed",
      stage: "finalizing",
      updatedAt: this.deps.now()
    });
  }

  fail(taskId: string, error: TaskErrorSummaryDto): TaskDto {
    const current = this.repository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    const retryable = isRetryableCode(error.code);
    const nextAttempt = retryable ? current.attempt + 1 : current.attempt;
    if (retryable && canRetry(nextAttempt)) {
      return this.repository.transition({
        id: taskId,
        expectedState: "running",
        nextState: "queued",
        stage: current.stage,
        attempt: nextAttempt,
        error,
        updatedAt: this.deps.now()
      });
    }
    return this.repository.transition({
      id: taskId,
      expectedState: "running",
      nextState: "failed",
      stage: current.stage,
      attempt: nextAttempt,
      error,
      updatedAt: this.deps.now()
    });
  }

  cancel(taskId: string): TaskDto {
    return this.repository.requestCancellation(taskId, this.deps.now());
  }

  recoverStaleRunning(graceMs: number): TaskDto[] {
    const cutoff = new Date(Date.parse(this.deps.now()) - graceMs).toISOString();
    const stale = this.repository.listRecoverableRunning(cutoff);
    return stale.map((task) => {
      const nextAttempt = task.attempt + 1;
      if (canRetry(nextAttempt)) {
        return this.repository.transition({
          id: task.id,
          expectedState: "running",
          nextState: "queued",
          stage: task.stage,
          attempt: nextAttempt,
          updatedAt: this.deps.now()
        });
      }
      return this.repository.transition({
        id: task.id,
        expectedState: "running",
        nextState: "failed",
        stage: task.stage,
        attempt: nextAttempt,
        error: INTERRUPTED_ERROR,
        updatedAt: this.deps.now()
      });
    });
  }

  retryDelayFor(attempt: number): number {
    return retryDelayMs(attempt, this.deps.random);
  }
}
