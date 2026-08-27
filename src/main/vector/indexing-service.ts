import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./embedding-provider";
import type { LanceRow, LanceSpace, LanceStore } from "./lance-store";

type Chunk = { id: string; ordinal: number; content_hash: string; text: string; locator_json: string };
type Input = { taskId: string; revisionId: string; space: LanceSpace; batchSize?: number; signal?: AbortSignal; now?: string };
type ResolvedProvider = EmbeddingProvider;
type ProviderResolver = ResolvedProvider | ((revisionId: string, space: LanceSpace) => Promise<ResolvedProvider>);
type StoredLike = Omit<LanceRow, "locator"> & { locatorJson?: string; locator?: unknown };
type SpaceBoundary = { project_id: string; source_id: string; space_id?: string; space_project_id?: string; space_dimension?: number; space_state?: string; active_space_id?: string; provider?: string; model_id?: string; model_revision?: string; distance?: string; pooling?: string; preprocess_version?: string; chunking_version?: string; fingerprint?: string };
export function canonicalEmbeddingFingerprint(value: { provider: string; modelId: string; modelRevision: string; dimension: number; distance: string; pooling: string; preprocessVersion: string; chunkingVersion: string }): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function canonicalLocatorJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonicalLocatorJson).join(",") + "]"; return "{" + Object.keys(value as Record<string, unknown>).sort().map(k => JSON.stringify(k) + ":" + canonicalLocatorJson((value as Record<string, unknown>)[k])).join(",") + "}"; }
export class IndexingService {
  private recoverChunks?: (revisionId: string) => Promise<void>;
  constructor(private readonly db: Database.Database, private readonly provider: ProviderResolver, private readonly lance: Pick<LanceStore, "createSpace" | "upsert" | "count" | "rows" | "vectorSearch" | "deleteRevision">) {}
  private async resolveProvider(revisionId: string, space: LanceSpace) { return typeof this.provider === "function" ? this.provider(revisionId, space) : this.provider; }
  private validateSpace(revisionId: string, space: LanceSpace, operation: "index" | "rebuild"): SpaceBoundary {
    const row = this.db.prepare("SELECT sr.source_id, s.project_id, es.id AS space_id, es.project_id AS space_project_id, es.dimension AS space_dimension, es.state AS space_state, es.provider, es.model_id, es.model_revision, es.distance, es.pooling, es.preprocess_version, es.chunking_version, es.fingerprint, pes.space_id AS active_space_id FROM source_revisions sr JOIN sources s ON s.id = sr.source_id LEFT JOIN embedding_spaces es ON es.id = ? LEFT JOIN project_embedding_spaces pes ON pes.project_id = s.project_id WHERE sr.id = ?").get(space.id, revisionId) as SpaceBoundary | undefined;
    if (!row) throw new Error("revision not found");
    const stateValid = operation === "index" ? row.space_state === "active" && row.active_space_id === space.id : ["preparing", "building", "validating"].includes(row.space_state ?? "");
    const expectedFingerprint = row.provider && row.model_id && row.model_revision && row.space_dimension && row.distance && row.pooling && row.preprocess_version && row.chunking_version ? canonicalEmbeddingFingerprint({ provider: row.provider, modelId: row.model_id, modelRevision: row.model_revision, dimension: row.space_dimension, distance: row.distance, pooling: row.pooling, preprocessVersion: row.preprocess_version, chunkingVersion: row.chunking_version }) : undefined;
    if (row.space_id !== space.id || row.space_project_id !== row.project_id || row.space_dimension !== space.dimension || !stateValid || !expectedFingerprint || row.fingerprint !== expectedFingerprint) throw Object.assign(new Error("Indexing space metadata mismatch"), { code: "INDEXING_SPACE_MISMATCH" });
    return row;
  }
  private validateProvider(provider: ResolvedProvider, persisted: SpaceBoundary): void {
    const description = typeof provider.describe === "function" ? provider.describe() : undefined;
    if (!description || !persisted.provider || description.provider !== persisted.provider || description.modelId !== persisted.model_id || description.modelRevision !== persisted.model_revision || description.dimension !== persisted.space_dimension || description.distance !== persisted.distance || description.pooling !== persisted.pooling || description.preprocessVersion !== persisted.preprocess_version || description.chunkingVersion !== persisted.chunking_version || canonicalEmbeddingFingerprint(description) !== persisted.fingerprint) {
      throw Object.assign(new Error("Embedding provider capability mismatch"), { code: "EMBEDDING_CAPABILITY_MISMATCH", recoverable: false });
    }
  }
  private async resolveAndValidateProvider(revisionId: string, space: LanceSpace, persisted: SpaceBoundary): Promise<ResolvedProvider> {
    const provider = await this.resolveProvider(revisionId, space);
    this.validateProvider(provider, persisted);
    return provider;
  }
  private validateRow(row: StoredLike | undefined, chunk: Chunk | undefined, source: { project_id: string; source_id: string }, revisionId: string, space: LanceSpace): boolean {
    if (!row || !chunk) return false;
    const locator = "locator" in row ? row.locator : (() => { try { return JSON.parse(row.locatorJson ?? ""); } catch { return undefined; } })();
    const vector = Array.from(row.vector as ArrayLike<number>);
    return row.chunkId === chunk.id && row.contentHash === chunk.content_hash && row.projectId === source.project_id && row.sourceId === source.source_id && row.spaceId === space.id && row.revisionId === revisionId && row.ordinal === chunk.ordinal && row.text === chunk.text && canonicalLocatorJson(locator) === canonicalLocatorJson(JSON.parse(chunk.locator_json)) && vector.length === space.dimension && vector.every(Number.isFinite);
  }
  private validateRows(rows: StoredLike[], chunks: Chunk[], source: { project_id: string; source_id: string }, revisionId: string, space: LanceSpace): void {
    const expected = new Set(chunks.map(c => c.id));
    if (rows.length !== chunks.length || new Set(rows.map(r => r.chunkId)).size !== expected.size || [...expected].some(id => !rows.some(r => r.chunkId === id)) || rows.some(r => !this.validateRow(r, chunks.find(c => c.id === r.chunkId), source, revisionId, space))) throw new Error("Lance metadata or vector mismatch");
  }
  setChunkRecovery(recover: (revisionId: string) => Promise<void>): void { this.recoverChunks = recover; }
  async index(input: Input): Promise<void> {
    const persisted = this.validateSpace(input.revisionId, input.space, "index");
    const source = persisted;
    try {
      const provider = await this.resolveAndValidateProvider(input.revisionId, input.space, persisted);
      await this.lance.createSpace?.(input.space);
      const chunks = this.db.prepare("SELECT id, ordinal, content_hash, text, locator_json FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(input.revisionId) as Chunk[];
      const size = Math.max(1, input.batchSize ?? 32);
      for (let i = 0; i < chunks.length; i += size) {
        const part = chunks.slice(i, i + size);
        const vectors = await provider.embedBatch(part.map(c => c.text), input.signal ?? new AbortController().signal, size);
        if (vectors.length !== part.length) throw new Error("Embedding response count mismatch");
        const rows: LanceRow[] = part.map((c, n) => ({ chunkId: c.id, projectId: source.project_id, sourceId: source.source_id, revisionId: input.revisionId, spaceId: input.space.id, ordinal: c.ordinal, contentHash: c.content_hash, text: c.text, vector: vectors[n]!, locator: JSON.parse(c.locator_json), createdAt: Date.now() }));
        await this.lance.upsert(input.space, rows);
      }
      const actual = (await this.lance.rows(input.space)).filter(r => r.revisionId === input.revisionId);
      if (await this.lance.count(input.space, { revisionId: input.revisionId }) !== chunks.length) throw new Error("Lance row count mismatch");
      this.validateRows(actual, chunks, source, input.revisionId, input.space);
      if (chunks.length) { const vectors = await provider.embedBatch([chunks[0]!.text], input.signal ?? new AbortController().signal, 1); const probe = await this.lance.vectorSearch(input.space, vectors[0]!, 1, { revisionId: input.revisionId }); if (probe.length !== 1 || !this.validateRow(probe[0], chunks[0], source, input.revisionId, input.space)) throw new Error("Lance probe mismatch"); }
      const now = input.now ?? new Date().toISOString();
      this.db.transaction(() => {
        if (this.db.prepare("UPDATE source_revisions SET state = 'ready', activated_at = ? WHERE id = ? AND state = 'awaiting_embedding'").run(now, input.revisionId).changes !== 1) throw new Error("Revision activation precondition failed");
        if (this.db.prepare("UPDATE sources SET current_revision_id = ?, updated_at = ? WHERE id = (SELECT source_id FROM source_revisions WHERE id = ?)").run(input.revisionId, now, input.revisionId).changes !== 1) throw new Error("Source activation failed");
        if (this.db.prepare("UPDATE tasks SET stage = 'finalizing', state = 'completed', progress_1000 = 1000, updated_at = ? WHERE id = ? AND state = 'running'").run(now, input.taskId).changes !== 1) throw new Error("Task completion precondition failed");
      })();
    } catch (error) { await this.lance.deleteRevision(input.space, input.revisionId); throw error; }
  }
  async rebuild(input: { revisionId: string; space: LanceSpace; signal?: AbortSignal; batchSize?: number }): Promise<void> {
    const persisted = this.validateSpace(input.revisionId, input.space, "rebuild");
    const source = persisted;
    const provider = await this.resolveAndValidateProvider(input.revisionId, input.space, persisted);
    let chunks = this.db.prepare("SELECT id, ordinal, content_hash, text, locator_json FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(input.revisionId) as Chunk[];
    if (chunks.length === 0 && this.recoverChunks) { await this.recoverChunks(input.revisionId); }
    chunks = this.db.prepare("SELECT id, ordinal, content_hash, text, locator_json FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(input.revisionId) as Chunk[];
    if (chunks.length === 0) throw Object.assign(new Error("No SQLite source_chunks available for rebuild and no recoverable managed original was supplied"), { code: "SPACE_REBUILD_SOURCE_UNRECOVERABLE", recoverable: false });
    await this.lance.createSpace?.(input.space);
    for (let i = 0; i < chunks.length; i += Math.max(1, input.batchSize ?? 32)) {
      if (input.signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code: "SPACE_BUILD_CANCELLED" });
      const part = chunks.slice(i, i + Math.max(1, input.batchSize ?? 32));
      if (input.signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code: "SPACE_BUILD_CANCELLED" });
      const vectors = await provider.embedBatch(part.map(c => c.text), input.signal ?? new AbortController().signal, part.length);
      await this.lance.upsert(input.space, part.map((c,n) => ({ chunkId:c.id, projectId:source.project_id, sourceId:source.source_id, revisionId:input.revisionId, spaceId:input.space.id, ordinal:c.ordinal, contentHash:c.content_hash, text:c.text, vector:vectors[n]!, locator:JSON.parse(c.locator_json), createdAt:Date.now() })));
      if (input.signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code: "SPACE_BUILD_CANCELLED" });
    }
    if (await this.lance.count(input.space, { revisionId: input.revisionId }) !== chunks.length) throw new Error("Lance row count mismatch");
    const rows = (await this.lance.rows(input.space)).filter(r => r.revisionId === input.revisionId);
    this.validateRows(rows, chunks, source, input.revisionId, input.space);
    if (chunks.length) { const probeVector=(await provider.embedBatch([chunks[0]!.text], input.signal ?? new AbortController().signal, 1))[0]!; const probe=await this.lance.vectorSearch(input.space, probeVector, 1, {revisionId:input.revisionId}); if (probe.length !== 1 || !this.validateRow(probe[0], chunks[0], source, input.revisionId, input.space)) throw new Error("Lance probe mismatch"); }
  }
}
