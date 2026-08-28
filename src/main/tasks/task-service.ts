import type { TaskErrorSummaryDto, TaskDto, TaskKind, TaskStage } from "../../shared/tasks";
import { MAX_ATTEMPTS, canRetry, isRetryableCode, retryDelayMs } from "./retry-policy";
import type { TaskRepository } from "./task-repository";

export type TaskServiceDeps = {
  now: () => string;
  random: () => number;
  id: () => string;
  onTransition?: (task: TaskDto) => void;
};

const INTERRUPTED_ERROR: TaskErrorSummaryDto = {
  code: "INTERNAL",
  messageKey: "errors.interrupted",
  recoverable: false
};

export class TaskService {
  private readonly deletionStarts = new Map<string, TaskDto>();
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

  getById(taskId: string): TaskDto | null {
    return this.repository.findById(taskId);
  }

  start(taskId: string, stage: TaskStage): TaskDto {
    const current = this.repository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    const next = this.repository.transition({
      id: taskId,
      expectedState: "queued",
      nextState: "running",
      stage,
      attempt: current.attempt,
      updatedAt: this.deps.now()
    });
    if (next.kind === "delete") this.deletionStarts.set(taskId, next);
    return next;
  }

  /** Publish completion after an owning cascade transaction has committed. */
  publishCompleted(taskId: string): TaskDto {
    const started = this.deletionStarts.get(taskId);
    if (!started) throw new Error(`Task not found: ${taskId}`);
    const completed = { ...started, state: "completed" as const, stage: "finalizing" as const, progress: 1000, updatedAt: this.deps.now() };
    this.deps.onTransition?.(completed);
    this.deletionStarts.delete(taskId);
    return completed;
  }

  retry(taskId: string, stage: TaskStage): TaskDto {
    const current = this.repository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    return this.repository.transition({ id: taskId, expectedState: "failed", nextState: "queued", stage, attempt: current.attempt, updatedAt: this.deps.now() });
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

  complete(taskId: string, stage: TaskStage = "finalizing"): TaskDto {
    return this.repository.transition({
      id: taskId,
      expectedState: "running",
      nextState: "completed",
      stage,
      updatedAt: this.deps.now()
    });
  }

  fail(taskId: string, error: TaskErrorSummaryDto, autoRetry = true): TaskDto {
    this.deletionStarts.delete(taskId);
    const current = this.repository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    const retryable = isRetryableCode(error.code);
    const nextAttempt = retryable ? current.attempt + 1 : current.attempt;
    if (autoRetry && retryable && canRetry(nextAttempt)) {
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

  retryCancelled(taskId: string, stage: TaskStage): TaskDto {
    const current = this.repository.findById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    return this.repository.transition({ id: taskId, expectedState: "cancelled", nextState: "queued", stage, attempt: current.attempt, updatedAt: this.deps.now() });
  }

  cancel(taskId: string): TaskDto {
    this.deletionStarts.delete(taskId);
    return this.repository.requestCancellation(taskId, this.deps.now());
  }

  recoverStaleRunning(graceMs: number): TaskDto[] {
    const cutoff = new Date(Date.parse(this.deps.now()) - graceMs).toISOString();
    const stale = this.repository.listRecoverableRunning(cutoff);
    return stale.map((task) => {
      if (task.stage === "embedding") {
        return this.repository.transition({
          id: task.id,
          expectedState: "running",
          nextState: "queued",
          stage: "embedding",
          attempt: task.attempt,
          updatedAt: this.deps.now()
        });
      }
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

  recoverStale(graceMs: number): TaskDto[] { return this.recoverStaleRunning(graceMs); }

  retryDelayFor(attempt: number): number {
    return retryDelayMs(attempt, this.deps.random);
  }

  recoverAndContinueEmbedding(continueTask: (task: TaskDto) => Promise<void>, graceMs: number): Promise<TaskDto[]> {
    const recovered = this.recoverStaleRunning(graceMs);
    return Promise.all(recovered.filter(task => task.stage === "embedding" && task.state === "queued").map(async task => { await continueTask(task); return task; }));
  }
}
