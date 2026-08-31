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
      const value = fused.flatMap(row => { const r = this.db.prepare("SELECT sc.id chunk_id, sc.text, sc.locator_json, sr.id revision_id, s.id source_id FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sc.id = ? AND s.project_id = ? AND s.status = 'active' AND s.current_revision_id = sr.id AND sr.state = 'ready'").get(row.chunkId, input.projectId) as any; return r ? [{ ...row, chunkId: r.chunk_id, sourceId: r.source_id, revisionId: r.revision_id, text: r.text, locatorJson: r.locator_json, locator: JSON.parse(r.locator_json) }] : []; });
      return { ok: true, value: diversifyHits(value, input.limit, 4) };
    } catch { return this.failure("INDEX_UNAVAILABLE", true); }
  }
  private failure(code: AppErrorDto["code"], recoverable: boolean): Result<Row[]> { return { ok: false, error: { code, messageKey: code === "INDEX_UNAVAILABLE" ? "errors.indexUnavailable" : "errors.notFound", recoverable } }; }
}
