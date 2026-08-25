import type Database from "better-sqlite3";
import type { PreparedChunk } from "../../workers/ingestion/types";
import type { DurableWorkerPayload, WorkerPool } from "../tasks/worker-pool";

export type IngestionRun = { taskId: string; revisionId: string; kind: string; data: Uint8Array; updatedAt: string };

export class IngestionService {
  constructor(private readonly pool: Pick<WorkerPool, "start" | "cancel"> & Partial<Pick<WorkerPool, "setDurablePayloadLoader">>, private readonly db: Database.Database, durablePayload?: (taskId: string) => DurableWorkerPayload | undefined) { if (durablePayload) this.pool.setDurablePayloadLoader?.(durablePayload); }
  async run(input: IngestionRun): Promise<void> {
    const result = await this.pool.start(input.taskId, input.kind, input.data);
    persistParsedResult(this.db, { revisionId: input.revisionId, taskId: input.taskId, chunks: result.chunks, updatedAt: input.updatedAt });
  }
  cancel(taskId: string): void { this.pool.cancel(taskId); }
}
export function throttleProgress(_taskId: string, emit: (value: number) => void, now = Date.now): (value: number) => void {
  let window = -1, count = 0;
  return (value) => { const current = Math.floor(now() / 1000); if (current !== window) { window = current; count = 0; } if (count++ < 10) emit(value); };
}
export function persistParsedResult(db: Database.Database, input: { revisionId: string; taskId: string; chunks: PreparedChunk[]; updatedAt: string }): void {
  db.transaction(() => { const insert = db.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, ?, ?, ?, ?)"); for (const chunk of input.chunks) insert.run(input.taskId + "-" + chunk.ordinal, input.revisionId, chunk.ordinal, chunk.contentHash, chunk.text, JSON.stringify(chunk.locator)); db.prepare("UPDATE source_revisions SET state = 'awaiting_embedding' WHERE id = ?").run(input.revisionId); db.prepare("UPDATE tasks SET stage = 'embedding', state = 'running', progress_1000 = 1000, updated_at = ? WHERE id = ? AND state = 'running'").run(input.updatedAt, input.taskId); })();
}
