import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { projectDtoSchema, type ProjectDto } from "../../shared/projects";
import type { TaskDto } from "../../shared/tasks";

type ProjectRow = {
  id: string;
  name: string;
  archived: 0 | 1;
  created_at: string;
  updated_at: string;
  status?: "active" | "deleting" | "delete_failed";
  deleted_at?: string | null;
};

function toProjectDto(row: ProjectRow): ProjectDto {
  return projectDtoSchema.parse({
    id: row.id,
    name: row.name,
    archived: row.archived === 1,
    status: row.status ?? "active",
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project not found: ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  list(options: { includeArchived?: boolean } = {}): ProjectDto[] {
    const sql = options.includeArchived
      ? "SELECT * FROM projects WHERE archived = 1 AND status = 'active' ORDER BY updated_at DESC"
      : "SELECT * FROM projects WHERE archived = 0 AND status = 'active' ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all() as ProjectRow[]).map(toProjectDto);
  }

  create(input: { id: string; name: string }): ProjectDto {
    this.db.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(input.id, input.name);
    return this.read(input.id);
  }

  rename(id: string, name: string): ProjectDto {
    const result = this.db.prepare(`
      UPDATE projects
      SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(name, id);
    if (result.changes === 0) throw new ProjectNotFoundError(id);
    return this.read(id);
  }

  archive(id: string): ProjectDto {
    const result = this.db.prepare(`
      UPDATE projects
      SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status = 'active'
    `).run(id);
    if (result.changes === 0) throw new ProjectNotFoundError(id);
    return this.read(id);
  }

  requestDeletion(id: string, now = new Date().toISOString()): ProjectDto {
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE projects SET status = 'deleting', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`).run(now, now, id);
      if (result.changes === 0) {
        const current = this.readMaybe(id);
        if (!current) throw new ProjectNotFoundError(id);
        if (current.status === "deleting") return current;
        throw new Error(`Project cannot be deleted: ${id}`);
      }
      this.db.prepare(`INSERT INTO tasks(id, project_id, source_id, kind, state, stage, progress_1000, attempt, error_code, error_message, idempotency_key, created_at, updated_at)
        VALUES (?, ?, NULL, 'delete', 'queued', 'cleanup', 0, 0, NULL, NULL, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET state = 'queued', stage = 'cleanup', error_code = NULL, error_message = NULL, updated_at = excluded.updated_at`).run(randomUUID(), id, `project-delete:${id}`, now, now);
      return this.read(id);
    })();
  }

  remove(id: string): ProjectDto { return this.requestDeletion(id); }

  undoDeletion(id: string, now = new Date().toISOString()): ProjectDto { return this.restore(id, now); }

  restore(id: string, now = new Date().toISOString()): ProjectDto {
    return this.db.transaction(() => {
      const task = this.db.prepare("SELECT state FROM tasks WHERE project_id = ? AND kind = 'delete' ORDER BY created_at DESC LIMIT 1").get(id) as { state?: string } | undefined;
      if (task?.state === "running") throw new Error(`Project deletion already started: ${id}`);
      const result = this.db.prepare(`UPDATE projects SET status = 'active', archived = 0, deleted_at = NULL, updated_at = ? WHERE id = ? AND status IN ('deleting', 'delete_failed')`).run(now, id);
      if (result.changes === 0) {
        const current = this.readMaybe(id);
        if (!current) throw new ProjectNotFoundError(id);
        const archived = this.db.prepare("UPDATE projects SET archived = 0, updated_at = ? WHERE id = ? AND status = 'active'").run(now, id);
        if (!archived.changes) throw new Error(`Project cannot be restored: ${id}`);
      }
      this.db.prepare("UPDATE tasks SET state = 'cancelled', updated_at = ? WHERE project_id = ? AND kind = 'delete' AND state IN ('queued', 'failed')").run(now, id);
      return this.read(id);
    })();
  }

  retryDeletion(id: string, now = new Date().toISOString()): ProjectDto {
    return this.db.transaction(() => {
      const result = this.db.prepare("UPDATE projects SET status = 'deleting', deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ? AND status = 'delete_failed'").run(now, now, id);
      if (!result.changes) {
        const current = this.readMaybe(id);
        if (!current) throw new ProjectNotFoundError(id);
        throw new Error(`Project is not retryable: ${id}`);
      }
      this.db.prepare("UPDATE tasks SET state = 'queued', stage = 'cleanup', error_code = NULL, error_message = NULL, updated_at = ? WHERE project_id = ? AND kind = 'delete' AND state = 'failed'").run(now, id);
      return this.read(id);
    })();
  }

  beginDeletionCleanup(id: string, now = new Date().toISOString()): void {
    const result = this.db.prepare("UPDATE tasks SET state = 'running', stage = 'cleanup', updated_at = ? WHERE project_id = ? AND kind = 'delete' AND state = 'queued'").run(now, id);
    if (!result.changes) throw new Error(`Project deletion is not queued: ${id}`);
  }

  findDeletionTask(id: string): Pick<TaskDto, "id" | "state" | "stage"> | null {
    const row = this.db.prepare("SELECT id, state, stage FROM tasks WHERE project_id = ? AND kind = 'delete' ORDER BY created_at DESC LIMIT 1").get(id) as Pick<TaskDto, "id" | "state" | "stage"> | undefined;
    return row ?? null;
  }

  requeueDeletion(id: string, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE tasks SET state = 'queued', stage = 'cleanup', updated_at = ? WHERE project_id = ? AND kind = 'delete' AND state = 'running'").run(now, id);
  }

  finishDeletion(id: string): void {
    this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM projects WHERE id = ? AND status = 'deleting'").run(id);
      if (!result.changes) throw new ProjectNotFoundError(id);
    })();
  }

  failDeletion(id: string, now = new Date().toISOString()): ProjectDto {
    this.db.transaction(() => {
      this.db.prepare("UPDATE projects SET status = 'delete_failed', updated_at = ? WHERE id = ? AND status IN ('deleting', 'delete_failed')").run(now, id);
      this.db.prepare("UPDATE tasks SET state = 'failed', stage = 'cleanup', error_code = 'INTERNAL', error_message = 'errors.internal', updated_at = ? WHERE project_id = ? AND kind = 'delete' AND state IN ('queued', 'running')").run(now, id);
    })();
    return this.read(id);
  }

  listStaleDeletions(before: string): ProjectDto[] {
    return (this.db.prepare("SELECT * FROM projects WHERE status = 'deleting' AND deleted_at IS NOT NULL AND deleted_at < ?").all(before) as ProjectRow[]).map(toProjectDto);
  }

  listDeleting(): ProjectDto[] {
    return (this.db.prepare("SELECT * FROM projects WHERE status = 'deleting' ORDER BY updated_at DESC").all() as ProjectRow[]).map(toProjectDto);
  }

  listDeleteFailed(): ProjectDto[] {
    return (this.db.prepare("SELECT * FROM projects WHERE status = 'delete_failed' ORDER BY updated_at DESC").all() as ProjectRow[]).map(toProjectDto);
  }

  findById(id: string): ProjectDto | null { return this.readMaybe(id); }

  private read(id: string): ProjectDto {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!row) throw new ProjectNotFoundError(id);
    return toProjectDto(row);
  }

  private readMaybe(id: string): ProjectDto | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? toProjectDto(row) : null;
  }
}
