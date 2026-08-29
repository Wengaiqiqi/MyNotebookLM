import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SourceDto } from "../../shared/sources";
import type { TaskDto } from "../../shared/tasks";
import type { TaskErrorSummaryDto } from "../../shared/tasks";
import type { IngestionService } from "./ingestion-service";
import type { TaskService } from "../tasks/task-service";
import { isRetryableCode } from "../tasks/retry-policy";
import { removeProjectFiles, stageFile } from "./managed-files";
import { parseSafeUrl } from "./url-policy";
import { UnsupportedContentTypeError, type UrlSource, UrlFetchError } from "./url-source";
import { validateFile } from "./file-preflight";

type Row = Record<string, unknown>;
const ERROR_CODES = new Set<TaskErrorSummaryDto["code"]>([
  "VALIDATION", "NOT_FOUND", "CONFLICT", "CANCELLED", "AUTH",
  "RATE_LIMITED", "TIMEOUT", "NETWORK", "PROVIDER",
  "UNSUPPORTED_FORMAT", "UNSAFE_INPUT", "INDEX_UNAVAILABLE", "INTERNAL"
]);
const MESSAGE_KEYS = new Set(["errors.interrupted", "errors.internal", "errors.validation", "errors.notFound", "errors.conflict", "errors.cancelled", "errors.auth", "errors.rateLimited", "errors.timeout", "errors.network", "errors.provider", "errors.unsupportedFormat", "errors.unsafeInput", "errors.indexUnavailable", "errors.modelCapability", "errors.embeddingProfileUnavailable", "errors.taskConflict"]);
function taskError(error: unknown): TaskErrorSummaryDto {
  const candidate = error as { code?: unknown; message?: unknown };
  const recoverableHint = (candidate as { recoverable?: unknown }).recoverable === true;
  const code = typeof candidate.code === "string" && ERROR_CODES.has(candidate.code as TaskErrorSummaryDto["code"])
    ? candidate.code as TaskErrorSummaryDto["code"]
    : "INTERNAL";
  const supplied = typeof candidate.message === "string" ? candidate.message : "";
  const messageKey = MESSAGE_KEYS.has(supplied) ? supplied : ({ UNSAFE_INPUT: "errors.unsafeInput", UNSUPPORTED_FORMAT: "errors.unsupportedFormat", RATE_LIMITED: "errors.rateLimited", INDEX_UNAVAILABLE: "errors.indexUnavailable", INTERNAL: "errors.internal" } as Record<string, string>)[code] ?? `errors.${code.toLowerCase()}`;
  return { code, messageKey, recoverable: recoverableHint || isRetryableCode(code) };
}
export class MainSourceService {
  constructor(private readonly db: Database.Database, private readonly tasks: TaskService, private readonly ingestion: IngestionService, private readonly storageRoot?: string, private readonly bindRevision?: (taskId: string, revisionId: string) => void, private readonly urlSource?: UrlSource) {}
  listSources(projectId: string): SourceDto[] { return this.db.prepare("SELECT s.*, sr.original_path AS current_locator, sr.stored_path AS current_stored_path, sr.state AS current_revision_state FROM sources s LEFT JOIN source_revisions sr ON sr.id = s.current_revision_id WHERE s.project_id = ? AND s.status <> 'deleted' ORDER BY s.updated_at DESC").all(projectId).map((row) => this.source(row as Row)); }
  listTasks(projectId: string): TaskDto[] { return this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId).map((row) => this.task(row as Row)); }
  ownsSource(projectId: string, sourceId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sources WHERE id = ? AND project_id = ? AND status <> 'deleted'").get(sourceId, projectId)); }
  ownsTask(projectId: string, taskId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId)); }
  async importFile(input: { projectId: string; path: string }): Promise<SourceDto> { const stat = await lstat(input.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024) throw Object.assign(new Error("file preflight failed"), { code: "UNSUPPORTED_FORMAT" }); const bytes = await readFile(input.path); let preflight; try { preflight = validateFile(path.basename(input.path), bytes); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error("file preflight failed"), { code: "UNSUPPORTED_FORMAT" }); } return this.createImport(input.projectId, input.path, bytes, this.kind(preflight.extension)); }
  async importUrl(input: { projectId: string; url: string }): Promise<SourceDto> { let safeUrl; try { safeUrl = parseSafeUrl(input.url); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error("unsafe URL"), { code: "UNSAFE_INPUT" }); } if (!this.urlSource) throw Object.assign(new Error("safe URL adapter unavailable"), { code: "UNSAFE_INPUT" }); try { const article = await this.urlSource.fetch(safeUrl.href); return this.createImport(input.projectId, article.finalUrl, Buffer.from(article.text), "url"); } catch (error) { if (error instanceof UrlFetchError) throw error; if (error instanceof UnsupportedContentTypeError) throw Object.assign(error, { code: "UNSUPPORTED_FORMAT" }); throw error; } }
  removeSource(input: { projectId: string; sourceId: string }): void { if (!this.ownsSource(input.projectId, input.sourceId)) throw new Error("source not owned by project"); const activeTasks = this.db.prepare("SELECT id FROM tasks WHERE project_id = ? AND source_id = ? AND state IN ('queued','running')").all(input.projectId, input.sourceId) as Array<{ id: string }>; this.db.prepare("UPDATE sources SET status = 'deleting', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND project_id = ?").run(input.sourceId, input.projectId); for (const task of activeTasks) { this.ingestion.cancel(task.id); try { this.tasks.cancel(task.id); } catch { /* task already transitioned */ } } this.db.transaction(() => { this.db.prepare("DELETE FROM source_chunks WHERE revision_id IN (SELECT id FROM source_revisions WHERE source_id = ?)").run(input.sourceId); this.db.prepare("DELETE FROM source_revisions WHERE source_id = ?").run(input.sourceId); })(); if (this.storageRoot) removeProjectFiles(this.storageRoot, [input.sourceId]); this.db.prepare("UPDATE sources SET status = 'deleted', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND project_id = ? AND status = 'deleting'").run(input.sourceId, input.projectId); }
  async retryTask(input: { projectId: string; sourceId: string }): Promise<TaskDto> { if (!this.ownsSource(input.projectId, input.sourceId)) throw new Error("source not owned by project"); const row = this.db.prepare("SELECT id, state FROM tasks WHERE project_id = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1").get(input.projectId, input.sourceId) as { id: string; state: TaskDto["state"] } | undefined; if (!row) throw new Error("task not found"); const current = this.tasks.getById(row.id); if (!current || current.projectId !== input.projectId || current.sourceId !== input.sourceId) throw new Error("task not owned by project"); const revision = this.db.prepare("SELECT sr.id, sr.stored_path, s.kind FROM sources s JOIN source_revisions sr ON sr.source_id = s.id WHERE s.id = ? AND (sr.id = s.current_revision_id OR (s.current_revision_id IS NULL AND sr.state IN ('awaiting_embedding','failed','parsing'))) ORDER BY CASE WHEN sr.id = s.current_revision_id THEN 0 ELSE 1 END, sr.created_at DESC LIMIT 1").get(input.sourceId) as { id: string; stored_path: string; kind: SourceDto["kind"] } | undefined; if (!revision) throw new Error("revision not found"); const bytes = await readFile(revision.stored_path); const queued = current.state === "cancelled" ? this.tasks.retryCancelled(row.id, "staging") : current.state === "failed" ? this.tasks.retry(row.id, "staging") : (() => { throw new Error("task is not retryable"); })(); this.db.prepare("UPDATE source_revisions SET state = 'parsing' WHERE id = ?").run(revision.id); const started = this.tasks.start(queued.id, "parsing"); this.bindRevision?.(started.id, revision.id); void this.ingestion.run({ taskId: started.id, revisionId: revision.id, kind: revision.kind, data: bytes, updatedAt: new Date().toISOString() }).catch((error) => { try { if (this.tasks.getById(started.id)?.state === "running") this.tasks.fail(started.id, taskError(error), false); } catch { /* cancellation won the race */ } try { this.db.prepare("UPDATE source_revisions SET state = 'failed' WHERE id = ?").run(revision.id); } catch { /* preserve task evidence */ } }); return started; }
  cancelTask(input: { projectId: string; taskId: string }): TaskDto { if (!this.ownsTask(input.projectId, input.taskId)) throw new Error("task not owned by project"); this.ingestion.cancel(input.taskId); return this.tasks.cancel(input.taskId); }
  private async createImport(projectId: string, originalPath: string, bytes: Buffer, kind: SourceDto["kind"]): Promise<SourceDto> {
    const sourceId = randomUUID(), revisionId = randomUUID(), now = new Date().toISOString();
    const name = kind === "url" ? originalPath : originalPath.split(/[\\/]/).pop() || originalPath;
    const staged = this.storageRoot ? stageFile({ root: this.storageRoot, sourceId, revisionId, bytes }) : undefined;
    const storedPath = staged?.path ?? originalPath, hash = staged?.hash ?? createHash("sha256").update(bytes).digest("hex");
    const created = this.db.transaction(() => {
      this.db.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, ?, ?, 'active')").run(sourceId, projectId, kind, name);
      this.db.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, ?, ?, ?, 'offset', 'v1', 'parsing')").run(revisionId, sourceId, originalPath, storedPath, hash);
      const task = this.tasks.createTask({ projectId, sourceId, kind: "ingest", idempotencyKey: hash + ":" + sourceId });
      this.db.prepare("UPDATE tasks SET state = 'running', stage = 'parsing', updated_at = ? WHERE id = ?").run(now, task.id);
      return task;
    })();
    this.bindRevision?.(created.id, revisionId);
    void this.ingestion.run({ taskId: created.id, revisionId, kind, data: bytes, updatedAt: now }).catch((error) => {
    try { if (!this.tasks.getById || this.tasks.getById(created.id)?.state === "running") this.tasks.fail(created.id, taskError(error), false); } catch { /* cancellation or deletion won the race */ }
      this.db.prepare("UPDATE source_revisions SET state = 'failed' WHERE id = ?").run(revisionId);
    });
    return this.source(this.db.prepare("SELECT s.*, sr.original_path AS current_locator, sr.stored_path AS current_stored_path, sr.state AS current_revision_state FROM sources s LEFT JOIN source_revisions sr ON sr.id = s.current_revision_id WHERE s.id = ?").get(sourceId) as Row);
  }
  private kind(file: string): SourceDto["kind"] { const ext = file.toLowerCase().split(".").pop(); return ({ md: "markdown", markdown: "markdown", pdf: "pdf", docx: "docx", pptx: "pptx", xlsx: "xlsx", csv: "csv", txt: "text" } as Record<string, SourceDto["kind"]>)[ext ?? ""] ?? "text"; }
  private source(row: Row): SourceDto { const kind = row.kind as SourceDto["kind"]; const locator = row.current_locator ? String(row.current_locator) : undefined; const storedPath = row.current_stored_path ? String(row.current_stored_path) : undefined; let sizeBytes: number | undefined; if (kind !== "url" && this.storageRoot && storedPath) { try { const root = path.resolve(this.storageRoot); const resolved = path.resolve(storedPath); const relative = path.relative(root, resolved); if (lstatSync(root).isDirectory() && relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { const stat = lstatSync(resolved); const canonical = path.resolve(realpathSync(resolved)); if (stat.isFile() && !stat.isSymbolicLink() && canonical === resolved) sizeBytes = stat.size; } } catch { /* source may be between staging and persistence */ } } return { id: String(row.id), projectId: String(row.project_id), kind, displayName: String(row.display_name), status: row.status as SourceDto["status"], currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at ? String(row.deleted_at) : null, ...(locator ? { locator: kind === "url" ? locator : locator.split(/[\\/]/).pop()! } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(row.current_revision_state ? { currentRevisionState: row.current_revision_state as SourceDto["currentRevisionState"] } : {}) }; }
  private task(row: Row): TaskDto {
    const errorCode = typeof row.error_code === "string" && ERROR_CODES.has(row.error_code as TaskErrorSummaryDto["code"])
      ? row.error_code as TaskErrorSummaryDto["code"]
      : null;
    return {
      id: String(row.id), projectId: String(row.project_id), sourceId: row.source_id ? String(row.source_id) : null,
      kind: row.kind as TaskDto["kind"], state: row.state as TaskDto["state"], stage: row.stage as TaskDto["stage"],
      progress: Number(row.progress_1000), attempt: Number(row.attempt),
      error: errorCode ? { code: errorCode, messageKey: MESSAGE_KEYS.has(String(row.error_message)) ? String(row.error_message) : ({ UNSAFE_INPUT: "errors.unsafeInput", UNSUPPORTED_FORMAT: "errors.unsupportedFormat", RATE_LIMITED: "errors.rateLimited", INTERNAL: "errors.internal" } as Record<string, string>)[errorCode] ?? `errors.${errorCode.toLowerCase()}`, recoverable: isRetryableCode(errorCode) } : null,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }
}
