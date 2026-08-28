import { randomUUID } from "node:crypto";
import {
  createProjectInputSchema,
  projectDtoSchema,
  projectIdInputSchema,
  renameProjectInputSchema,
  type CreateProjectInput,
  type ProjectDto,
  type ProjectIdInput,
  type RenameProjectInput
} from "../../shared/projects";
import type { ProjectRepository } from "./project-repository";
import type { TaskDto, TaskErrorSummaryDto } from "../../shared/tasks";

type DeletionTaskService = {
  start(id: string, stage: "cleanup"): TaskDto;
  advance(id: string, stage: "finalizing", progress: number): TaskDto;
  publishCompleted(id: string): TaskDto;
  fail(id: string, error: TaskErrorSummaryDto, autoRetry?: boolean): TaskDto;
};

export type ProjectCleanupAdapter = {
  managedFiles?: (projectId: string) => Promise<void | { rollback(): void; purge(): void }> | void | { rollback(): void; purge(): void };
  restoreProjectFiles?: (projectId: string) => void;
  lanceRows?: (projectId: string) => Promise<void> | void;
  invalidateEmbeddingSpaces?: (projectId: string) => Promise<void> | void;
  taskService?: DeletionTaskService;
};

export type ProjectServiceOptions = ProjectCleanupAdapter & {
  now?: () => string;
  deletionGraceMs?: number;
  autoStartDeletion?: boolean;
};

export class ProjectService {
  private readonly deletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly repository: ProjectRepository,
    private readonly createId: () => string = randomUUID,
    private readonly options: ProjectServiceOptions = {}
  ) {}

  list(): ProjectDto[] {
    return projectDtoSchema.array().parse(this.repository.list());
  }

  listArchived(): ProjectDto[] { return projectDtoSchema.array().parse(this.repository.list({ includeArchived: true })); }
  listDeleteFailed(): ProjectDto[] { return projectDtoSchema.array().parse(this.repository.listDeleteFailed()); }

  create(input: CreateProjectInput): ProjectDto {
    const parsed = createProjectInputSchema.parse(input);
    return projectDtoSchema.parse(
      this.repository.create({ id: this.createId(), name: parsed.name })
    );
  }

  rename(input: RenameProjectInput): ProjectDto {
    const parsed = renameProjectInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.rename(parsed.id, parsed.name));
  }

  archive(input: ProjectIdInput): ProjectDto {
    const parsed = projectIdInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.archive(parsed.id));
  }

  remove(input: ProjectIdInput): ProjectDto {
    const parsed = projectIdInputSchema.parse(input);
    const project = this.repository.requestDeletion(parsed.id, this.now());
    if (this.options.autoStartDeletion) {
      this.scheduleDeletion(parsed.id, this.options.deletionGraceMs ?? 30_000);
    }
    return projectDtoSchema.parse(project);
  }

  undo(input: ProjectIdInput): ProjectDto { return this.restore(input); }

  restore(input: ProjectIdInput): ProjectDto {
    const parsed = projectIdInputSchema.parse(input);
    this.clearDeletionTimer(parsed.id);
    try { this.options.restoreProjectFiles?.(parsed.id); }
    catch (error) { this.repository.failDeletion(parsed.id, this.now()); throw error; }
    return projectDtoSchema.parse(this.repository.restore(parsed.id, this.now()));
  }

  retryDelete(input: ProjectIdInput): ProjectDto {
    const parsed = projectIdInputSchema.parse(input);
    const project = projectDtoSchema.parse(this.repository.retryDeletion(parsed.id, this.now()));
    if (this.options.autoStartDeletion) this.scheduleDeletion(parsed.id, 0);
    return project;
  }

  async runDeletion(id: string, force = false): Promise<ProjectDto | null> {
    const project = this.repository.findById(id);
    if (!project || project.status !== "deleting") return project ?? null;
    const deletedAt = project.deletedAt ? Date.parse(project.deletedAt) : NaN;
    if (!force && Number.isFinite(deletedAt) && Date.parse(this.now()) - deletedAt < (this.options.deletionGraceMs ?? 30_000)) return project;
    const deletionTask = this.repository.findDeletionTask(id);
    try {
      if (this.options.taskService && deletionTask) this.options.taskService.start(deletionTask.id, "cleanup");
      else this.repository.beginDeletionCleanup(id, this.now());
    }
    catch { return this.repository.findById(id); }
    let staged: void | { rollback(): void; purge(): void } = undefined;
    let finalized = false;
    try {
      staged = await this.options.managedFiles?.(id);
      try { await this.options.lanceRows?.(id); }
      catch (error) { await this.options.invalidateEmbeddingSpaces?.(id); throw error; }
      if (deletionTask && this.options.taskService) {
        this.options.taskService.advance(deletionTask.id, "finalizing", 1000);
      }
      this.repository.finishDeletion(id);
      finalized = true;
      try { if (deletionTask && this.options.taskService) this.options.taskService.publishCompleted(deletionTask.id); } catch { /* DB is authoritative; completion notification is best-effort */ }
      try { staged?.purge(); } catch { /* DB is authoritative; orphaned trash can be purged on maintenance */ }
      this.clearDeletionTimer(id);
      return null;
    } catch (error) {
      if (finalized) return null;
      try { staged?.rollback(); } catch { /* preserve original cleanup failure */ }
      if (deletionTask && this.options.taskService) {
        const current = this.options.taskService;
        try { current.fail(deletionTask.id, { code: "INTERNAL", messageKey: "errors.internal", recoverable: false }, false); } catch { /* preserve original cleanup failure */ }
      }
      this.repository.failDeletion(id, this.now());
      throw error;
    }
  }

  async recoverStaleDeletions(graceMs = 30_000): Promise<void> {
    const now = Date.parse(this.now());
    for (const project of this.repository.listDeleting()) {
      const deletedAt = project.deletedAt ? Date.parse(project.deletedAt) : NaN;
      const remaining = Number.isFinite(deletedAt) ? Math.max(0, deletedAt + graceMs - now) : 0;
      this.repository.requeueDeletion(project.id, this.now());
      if (remaining === 0) {
        try { await this.runDeletion(project.id, true); } catch { /* failure is persisted; startup continues */ }
      } else this.scheduleDeletion(project.id, remaining);
    }
  }

  configureCleanup(options: ProjectServiceOptions): void { Object.assign(this.options, options); }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  private scheduleDeletion(id: string, delay: number): void {
    this.clearDeletionTimer(id);
    const timer = setTimeout(() => {
      this.deletionTimers.delete(id);
      void this.runDeletion(id).catch(() => undefined);
    }, Math.max(0, delay));
    this.deletionTimers.set(id, timer);
  }

  private clearDeletionTimer(id: string): void {
    const timer = this.deletionTimers.get(id);
    if (timer) clearTimeout(timer);
    this.deletionTimers.delete(id);
  }
}
