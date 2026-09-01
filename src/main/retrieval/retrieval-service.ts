import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../vector/embedding-provider";
import type { LanceStore, LanceSpace } from "../vector/lance-store";
import type { Result, AppErrorDto } from "../../shared/app-errors";
import { diversifyHits, reciprocalRankFusion, type RetrievalCandidate } from "./rrf";

type Row = RetrievalCandidate & { revisionId: string; text: string; locatorJson: string; vector?: number[] };
type SearchInput = { projectId: string; query: string; limit: number; signal?: AbortSignal };
export class RetrievalService {
  private readonly store: Pick<LanceStore, "vectorSearch" | "textSearch">; private readonly provider: Pick<EmbeddingProvider, "embedBatch">; private readonly db: Database.Database; private readonly resolveSpace?: (projectId: string, space: { id:string; dimension:number; fingerprint:string }) => Promise<{provider: Pick<EmbeddingProvider, "embedBatch" | "describe">}|null>;
  constructor(a: any, b?: any, c?: any) { if (a?.lance) { this.db=a.db; this.store=a.lance; this.provider=a.provider; this.resolveSpace=a.resolveSpace; } else { this.store=a; this.provider=b; this.db=c; } }
  async search(input: SearchInput | string, query?: string): Promise<any> {
    if (typeof input === "string") { const result = await this.search({ projectId: input, query: query ?? "", limit: 20 }); if (!result.ok) throw { code: result.error.code, repair: result.error.code === "INDEX_UNAVAILABLE" }; return result.value; }
    try {
      const space = this.db.prepare("SELECT pes.space_id, es.provider, es.model_id, es.model_revision, es.dimension, es.distance, es.pooling, es.preprocess_version, es.chunking_version, es.fingerprint FROM project_embedding_spaces pes JOIN embedding_spaces es ON es.id = pes.space_id WHERE pes.project_id = ? AND es.state = 'active'").get(input.projectId) as { space_id: string; provider: string; model_id: string; model_revision: string; dimension: number; distance: string; pooling: string; preprocess_version: string; chunking_version: string; fingerprint: string } | undefined;
      if (!space) return this.failure("NOT_FOUND", false);
      const resolved = this.resolveSpace ? await this.resolveSpace(input.projectId, { id: space.space_id, dimension: space.dimension, fingerprint: space.fingerprint }) : null;
      if (this.resolveSpace && !resolved?.provider) return this.failure("INDEX_UNAVAILABLE", true);
      const queryProvider = resolved?.provider ?? this.provider;
      if (typeof (queryProvider as Partial<EmbeddingProvider>).describe === "function") {
        const description = (queryProvider as EmbeddingProvider).describe();
        if (description.provider !== space.provider || description.modelId !== space.model_id || description.modelRevision !== space.model_revision || description.dimension !== space.dimension || description.distance !== space.distance || description.pooling !== space.pooling || description.preprocessVersion !== space.preprocess_version || description.chunkingVersion !== space.chunking_version) throw new Error("Embedding provider capability mismatch");
      }
      const spec: LanceSpace = { id: space.space_id, dimension: space.dimension };
      const candidateLimit = Math.min(200, Math.max(48, input.limit * 8));
      const filter = { projectId: input.projectId };
      const textPromise = this.store.textSearch(spec, input.query, candidateLimit, filter);
      const [vector] = await queryProvider.embedBatch([input.query], input.signal ?? new AbortController().signal);
      if (!vector) throw new Error("embedding unavailable");
      const [ann, bm25] = await Promise.all([this.store.vectorSearch(spec, vector, candidateLimit, filter), textPromise]);
      const fused = reciprocalRankFusion([ann as Row[], bm25 as Row[]], candidateLimit);
      const value = fused.flatMap(row => { const r = this.db.prepare("SELECT sc.id chunk_id, sc.ordinal, sc.text, sc.locator_json, sc.content_hash, sr.id revision_id, s.id source_id FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sc.id = ? AND s.project_id = ? AND s.status = 'active' AND s.current_revision_id = sr.id AND sr.state = 'ready'").get(row.chunkId, input.projectId) as any; return r ? [{ ...row, chunkId: r.chunk_id, contentHash: r.content_hash, ordinal: r.ordinal, sourceId: r.source_id, revisionId: r.revision_id, text: r.text, locatorJson: r.locator_json, locator: JSON.parse(r.locator_json) }] : []; });
      return { ok: true, value: this.withStructuralContext(diversifyHits(value, input.limit, 4), input.projectId, input.limit) };
    } catch { return this.failure("INDEX_UNAVAILABLE", true); }
  }
  private withStructuralContext(hits: Row[], projectId: string, limit: number): Row[] {
    const statement = this.db.prepare("SELECT sc.id chunk_id, sc.ordinal, sc.text, sc.locator_json, sc.content_hash, sr.id revision_id, s.id source_id FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sr.id = ? AND s.project_id = ? AND s.status = 'active' AND s.current_revision_id = sr.id AND sr.state = 'ready' ORDER BY sc.ordinal") as any;
    if (typeof statement.all !== "function") return hits;
    const out: Row[] = [];
    const seen = new Set<string>();
    const revisions = new Map<string, any[]>();
    const add = (row: Row): void => { if (!seen.has(row.chunkId) && out.length < limit) { seen.add(row.chunkId); out.push(row); } };
    const authoritative = (hit: Row, row: any): Row => ({ ...hit, chunkId: row.chunk_id, contentHash: row.content_hash, ordinal: row.ordinal, sourceId: row.source_id, revisionId: row.revision_id, text: row.text, locatorJson: row.locator_json, locator: JSON.parse(row.locator_json) });
    for (const hit of hits) {
      const ordinal = hit.ordinal;
      if (typeof ordinal !== "number") { add(hit); continue; }
      let rows = revisions.get(hit.revisionId);
      if (!rows) { rows = statement.all(hit.revisionId, projectId) as any[]; revisions.set(hit.revisionId, rows); }
      const parent = structuralPrefix(hit.text);
      const siblings = parent ? rows.filter((row) => structuralPrefix(row.text) === parent) : [];
      if (siblings.length > 1) {
        const hitIndex = siblings.findIndex((row) => row.chunk_id === hit.chunkId);
        const start = siblings.length <= limit ? 0 : Math.max(0, Math.min(hitIndex - Math.floor(limit / 2), siblings.length - limit));
        for (const row of siblings.slice(start, start + limit)) add(authoritative(hit, row));
        continue;
      }
      add(hit);
      for (const neighbor of [ordinal + 1, Math.max(0, ordinal - 1)]) {
        const row = rows.find((candidate) => candidate.ordinal === neighbor);
        if (row) add(authoritative(hit, row));
      }
    }
    return out;
  }
  private failure(code: AppErrorDto["code"], recoverable: boolean): Result<Row[]> { return { ok: false, error: { code, messageKey: code === "INDEX_UNAVAILABLE" ? "errors.indexUnavailable" : "errors.notFound", recoverable } }; }
}

function structuralPrefix(text: string): string | undefined {
  const separator = /\r?\n[ \t]*\r?\n/.exec(text);
  if (!separator?.index) return undefined;
  const prefix = text.slice(0, separator.index).trim();
  return prefix.length <= 240 ? prefix : undefined;
}
