import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PreparedChunk } from "../../workers/ingestion/types";
import type { DurableWorkerPayload, WorkerPool } from "../tasks/worker-pool";
import type { IndexingService } from "../vector/indexing-service";

export type IngestionRun = { taskId: string; revisionId: string; kind: string; data: Uint8Array; updatedAt: string };

export class IngestionService {
  constructor(private readonly pool: Pick<WorkerPool, "start" | "cancel"> & Partial<Pick<WorkerPool, "setDurablePayloadLoader" | "setProgressCallback">>, private readonly db: Database.Database, durablePayload?: (taskId: string, revisionId: string) => DurableWorkerPayload | undefined, onProgress?: (taskId: string, value: number) => void, private readonly indexing?: IndexingService) { if (durablePayload) this.pool.setDurablePayloadLoader?.(durablePayload); if (onProgress) this.pool.setProgressCallback?.((taskId, value) => throttleProgress(taskId, (v) => onProgress(taskId, v))(value)); }
  async run(input: IngestionRun): Promise<void> {
    let result;
    try { result = await this.pool.start(input.taskId, input.revisionId, input.kind, input.data); } catch (error) { if ((error as { state?: string }).state === "cancelled") return; throw error; }
    persistParsedResult(this.db, { revisionId: input.revisionId, taskId: input.taskId, chunks: result.chunks, updatedAt: input.updatedAt });
    if (this.indexing) {
      const space = this.db.prepare("SELECT es.id, es.dimension FROM source_revisions sr JOIN sources s ON s.id = sr.source_id JOIN project_embedding_spaces pes ON pes.project_id = s.project_id JOIN embedding_spaces es ON es.id = pes.space_id AND es.state = 'active' WHERE sr.id = ?").get(input.revisionId) as { id: string; dimension: number } | undefined;
      if (!space) {
        // First ingest for a project without a built embedding Space: surface
        // a clear, recoverable error the renderer can act on instead of INTERNAL.
        throw Object.assign(new Error("errors.indexUnavailable"), { code: "INDEX_UNAVAILABLE" });
      }
      await this.indexing.index({ taskId: input.taskId, revisionId: input.revisionId, space });
    }
  }
  cancel(taskId: string): void { this.pool.cancel(taskId); }
  async reparseRevision(revisionId: string): Promise<void> {
    const row = this.db.prepare("SELECT stored_path, s.kind FROM source_revisions sr JOIN sources s ON s.id = sr.source_id WHERE sr.id = ?").get(revisionId) as { stored_path?: string; kind?: string } | undefined;
    if (!row?.stored_path || !row.kind) throw Object.assign(new Error("Managed original is unavailable"), { code: "SPACE_REBUILD_SOURCE_UNRECOVERABLE" });
    let result;
    try { result = await this.pool.start(randomUUID(), revisionId, row.kind, await readFile(row.stored_path)); }
    catch (error) { throw Object.assign(new Error("Managed original could not be parsed", { cause: error }), { code: "SPACE_REBUILD_SOURCE_UNRECOVERABLE" }); }
    const revision = this.db.prepare("SELECT source_id FROM source_revisions WHERE id = ?").get(revisionId) as { source_id: string } | undefined;
    if (!revision) throw new Error("revision not found");
    const insert = this.db.prepare("INSERT OR REPLACE INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, ?, ?, ?, ?)");
    this.db.transaction(() => { for (const chunk of result.chunks) insert.run(revisionId + "-" + chunk.ordinal, revisionId, chunk.ordinal, chunk.contentHash, chunk.text, JSON.stringify(chunk.locator)); })();
  }
}
export function throttleProgress(_taskId: string, emit: (value: number) => void, now = Date.now): (value: number) => void {
  let window = -1, count = 0;
  return (value) => { const current = Math.floor(now() / 1000); if (current !== window) { window = current; count = 0; } if (count++ < 10) emit(value); };
}
export function persistParsedResult(db: Database.Database, input: { revisionId: string; taskId: string; chunks: PreparedChunk[]; updatedAt: string }): void {
  db.transaction(() => { const owner = db.prepare("SELECT 1 FROM tasks t JOIN sources s ON s.id = t.source_id JOIN source_revisions sr ON sr.source_id = s.id WHERE t.id = ? AND t.source_id = s.id AND t.project_id = s.project_id AND t.state = 'running' AND s.status = 'active' AND sr.id = ?").get(input.taskId, input.revisionId); if (!owner) throw new Error("Ingestion result is stale"); const existing = db.prepare("SELECT ordinal, content_hash, text, locator_json FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(input.revisionId) as Array<{ ordinal: number; content_hash: string; text: string; locator_json: string }>; const same = existing.length === input.chunks.length && existing.every((row, i) => row.ordinal === input.chunks[i]!.ordinal && row.content_hash === input.chunks[i]!.contentHash && row.text === input.chunks[i]!.text && row.locator_json === JSON.stringify(input.chunks[i]!.locator)); if (!same) { const insert = db.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, ?, ?, ?, ?)"); for (const chunk of input.chunks) insert.run(input.taskId + "-" + chunk.ordinal, input.revisionId, chunk.ordinal, chunk.contentHash, chunk.text, JSON.stringify(chunk.locator)); } const revision = db.prepare("UPDATE source_revisions SET state = 'awaiting_embedding' WHERE id = ? AND state IN ('pending', 'parsing', 'awaiting_embedding')").run(input.revisionId); if (revision.changes !== 1) throw new Error("Revision is not resumable"); const task = db.prepare("UPDATE tasks SET stage = 'embedding', state = 'running', progress_1000 = 600, updated_at = ? WHERE id = ? AND state = 'running'").run(input.updatedAt, input.taskId); if (task.changes !== 1) throw new Error("Task is not running"); })();
}
