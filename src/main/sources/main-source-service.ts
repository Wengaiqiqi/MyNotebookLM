import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { SourceDto } from "../../shared/sources";
import type { TaskDto } from "../../shared/tasks";
import type { IngestionService } from "./ingestion-service";
import type { TaskService } from "../tasks/task-service";

type Row = Record<string, unknown>;
export class MainSourceService {
  constructor(private readonly db: Database.Database, private readonly tasks: TaskService, private readonly ingestion: IngestionService) {}
  listSources(projectId: string): SourceDto[] { return this.db.prepare("SELECT * FROM sources WHERE project_id = ? AND status <> 'deleted' ORDER BY updated_at DESC").all(projectId).map((row) => this.source(row as Row)); }
  listTasks(projectId: string): TaskDto[] { return this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId).map((row) => this.task(row as Row)); }
  ownsSource(projectId: string, sourceId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sources WHERE id = ? AND project_id = ? AND status <> 'deleted'").get(sourceId, projectId)); }
  ownsTask(projectId: string, taskId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId)); }
  async importFile(input: { projectId: string; path: string }): Promise<SourceDto> { return this.createImport(input.projectId, input.path, await readFile(input.path), this.kind(input.path)); }
  async importUrl(input: { projectId: string; url: string }): Promise<SourceDto> { const response = await fetch(input.url); if (!response.ok) throw new Error("URL fetch failed"); return this.createImport(input.projectId, input.url, Buffer.from(await response.arrayBuffer()), "url"); }
  removeSource(input: { projectId: string; sourceId: string }): void { if (!this.ownsSource(input.projectId, input.sourceId)) throw new Error("source not owned by project"); this.db.prepare("UPDATE sources SET status = 'deleted', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND project_id = ?").run(input.sourceId, input.projectId); }
  retryTask(input: { projectId: string; sourceId: string }): TaskDto { const row = this.db.prepare("SELECT id FROM tasks WHERE project_id = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1").get(input.projectId, input.sourceId) as { id: string } | undefined; if (!row) throw new Error("task not found"); return this.tasks.start(row.id, "staging"); }
  cancelTask(input: { projectId: string; taskId: string }): TaskDto { if (!this.ownsTask(input.projectId, input.taskId)) throw new Error("task not owned by project"); this.ingestion.cancel(input.taskId); return this.tasks.cancel(input.taskId); }
  private async createImport(projectId: string, originalPath: string, bytes: Buffer, kind: SourceDto["kind"]): Promise<SourceDto> {
    const sourceId = randomUUID(), revisionId = randomUUID(), now = new Date().toISOString();
    const name = originalPath.split(/[\\/]/).pop() || originalPath;
    const storedPath = originalPath, hash = createHash("sha256").update(bytes).digest("hex");
    this.db.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, ?, ?, 'active')").run(sourceId, projectId, kind, name);
    this.db.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, ?, ?, ?, 'offset', 'v1', 'parsing')").run(revisionId, sourceId, originalPath, storedPath, hash);
    const created = this.tasks.createTask({ projectId, sourceId, kind: "ingest", idempotencyKey: hash + ":" + sourceId });
    this.db.prepare("UPDATE tasks SET state = 'running', stage = 'parsing', updated_at = ? WHERE id = ?").run(now, created.id);
    this.db.prepare("UPDATE source_revisions SET state = 'parsing' WHERE id = ?").run(revisionId);
    void this.ingestion.run({ taskId: created.id, revisionId, kind, data: bytes, updatedAt: now }).catch(() => { this.db.prepare("UPDATE tasks SET state = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), created.id); this.db.prepare("UPDATE source_revisions SET state = 'failed' WHERE id = ?").run(revisionId); });
    return this.source(this.db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId) as Row);
  }
  private kind(file: string): SourceDto["kind"] { const ext = file.toLowerCase().split(".").pop(); return ({ md: "markdown", markdown: "markdown", pdf: "pdf", docx: "docx", pptx: "pptx", xlsx: "xlsx", csv: "csv", txt: "text" } as Record<string, SourceDto["kind"]>)[ext ?? ""] ?? "text"; }
  private source(row: Row): SourceDto { return { id: String(row.id), projectId: String(row.project_id), kind: row.kind as SourceDto["kind"], displayName: String(row.display_name), status: row.status as SourceDto["status"], currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null }; }
  private task(row: Row): TaskDto { return { id: String(row.id), projectId: String(row.project_id), sourceId: row.source_id ? String(row.source_id) : null, kind: row.kind as TaskDto["kind"], state: row.state as TaskDto["state"], stage: row.stage as TaskDto["stage"], progress: Number(row.progress_1000), attempt: Number(row.attempt), error: null, idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
}
