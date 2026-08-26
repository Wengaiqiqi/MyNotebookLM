import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "./embedding-provider";
import type { LanceRow, LanceSpace, LanceStore } from "./lance-store";

type Chunk = { id: string; ordinal: number; content_hash: string; text: string; locator_json: string };
type Input = { taskId: string; revisionId: string; space: LanceSpace; batchSize?: number; signal?: AbortSignal; now?: string };
export class IndexingService {
  constructor(private readonly db: Database.Database, private readonly provider: Pick<EmbeddingProvider, "embedBatch">, private readonly lance: Pick<LanceStore, "upsert" | "count" | "rows" | "vectorSearch" | "deleteRevision">) {}
  async index(input: Input): Promise<void> {
    const chunks = this.db.prepare("SELECT id, ordinal, content_hash, text, locator_json FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(input.revisionId) as Chunk[];
    try {
      const size = Math.max(1, input.batchSize ?? 32);
      for (let i = 0; i < chunks.length; i += size) {
        const part = chunks.slice(i, i + size);
        const vectors = await this.provider.embedBatch(part.map(c => c.text), input.signal ?? new AbortController().signal, size);
        if (vectors.length !== part.length) throw new Error("Embedding response count mismatch");
        const source = this.db.prepare("SELECT s.project_id, sr.source_id FROM source_revisions sr JOIN sources s ON s.id = sr.source_id WHERE sr.id = ?").get(input.revisionId) as { project_id: string; source_id: string };
        const rows: LanceRow[] = part.map((c, n) => ({ chunkId: c.id, projectId: source.project_id, sourceId: source.source_id, revisionId: input.revisionId, spaceId: input.space.id, ordinal: c.ordinal, contentHash: c.content_hash, text: c.text, vector: vectors[n]!, locator: JSON.parse(c.locator_json), createdAt: Date.now() }));
        await this.lance.upsert(input.space, rows);
      }
      const actual = (await this.lance.rows(input.space)).filter(r => r.revisionId === input.revisionId);
      const source = this.db.prepare("SELECT s.project_id, sr.source_id FROM source_revisions sr JOIN sources s ON s.id = sr.source_id WHERE sr.id = ?").get(input.revisionId) as { project_id: string; source_id: string };
      const expectedIds = new Set(chunks.map(c => c.id));
      const actualIds = new Set(actual.map(r => r.chunkId));
      if (actual.length !== chunks.length || actualIds.size !== expectedIds.size || [...expectedIds].some(id => !actualIds.has(id)) || actual.some(r => { const c = chunks.find(x => x.id === r.chunkId); return !c || c.content_hash !== r.contentHash || r.projectId !== source.project_id || r.spaceId !== input.space.id || r.revisionId !== input.revisionId; })) throw new Error("Lance metadata or content hash mismatch");
      if (chunks.length) { const vectors = await this.provider.embedBatch([chunks[0]!.text], input.signal ?? new AbortController().signal, 1); const probe = await this.lance.vectorSearch(input.space, vectors[0]!, 1, { revisionId: input.revisionId }); if (probe.length !== 1 || probe[0]!.chunkId !== chunks[0]!.id || probe[0]!.contentHash !== chunks[0]!.content_hash || probe[0]!.revisionId !== input.revisionId || probe[0]!.spaceId !== input.space.id || probe[0]!.projectId !== source.project_id) throw new Error("Lance probe mismatch"); }
      const now = input.now ?? new Date().toISOString();
      this.db.transaction(() => {
        if (this.db.prepare("UPDATE source_revisions SET state = 'ready', activated_at = ? WHERE id = ? AND state = 'awaiting_embedding'").run(now, input.revisionId).changes !== 1) throw new Error("Revision activation precondition failed");
        if (this.db.prepare("UPDATE sources SET current_revision_id = ?, updated_at = ? WHERE id = (SELECT source_id FROM source_revisions WHERE id = ?)").run(input.revisionId, now, input.revisionId).changes !== 1) throw new Error("Source activation failed");
        if (this.db.prepare("UPDATE tasks SET stage = 'finalizing', state = 'completed', progress_1000 = 1000, updated_at = ? WHERE id = ? AND state = 'running'").run(now, input.taskId).changes !== 1) throw new Error("Task completion precondition failed");
      })();
    } catch (error) { await this.lance.deleteRevision(input.space, input.revisionId); throw error; }
  }
}
