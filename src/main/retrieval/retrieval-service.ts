import { Buffer } from "node:buffer";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../vector/embedding-provider";
import type { LanceStore, LanceSpace } from "../vector/lance-store";
import type { Result, AppErrorDto } from "../../shared/app-errors";
import { diversifyHits, fuseRrf, type RetrievalCandidate } from "./rrf";

type Row = RetrievalCandidate & {
  revisionId: string;
  text: string;
  locatorJson: string;
  vector?: number[];
  ordinal?: number;
  locator?: Record<string, unknown>;
  sourceDisplayName?: string;
  sourceKind?: string;
  structural?: boolean;
};
type SpaceRow = {
  space_id: string;
  provider: string;
  model_id: string;
  model_revision: string;
  dimension: number;
  distance: string;
  pooling: string;
  preprocess_version: string;
  chunking_version: string;
  fingerprint: string;
};
type SearchInput = { projectId: string; query: string; limit: number; signal?: AbortSignal };
type ChatSearchInput = { projectId: string; query: string; evidenceTokenBudget: number; signal?: AbortSignal | undefined };
type QueryProvider = Pick<EmbeddingProvider, "embedBatch"> & Partial<Pick<EmbeddingProvider, "describe">>;
type PreparedSearch = { spec: LanceSpace; filter: { projectId: string }; query: string; queryProvider: QueryProvider; vector: number[]; signal: AbortSignal; passSignal: boolean };
type SearchRound = { rows: Row[]; vectorCount: number; textCount: number; candidateBytes: number; leadingScore?: number };

export type ChatSearchStopReason = "budget" | "exhausted" | "relevance-tail" | "candidate-limit" | "resource-limit" | "cancelled";
export type ChatSearchDiagnostics = {
  stopReason: ChatSearchStopReason;
  rounds: number;
  vectorCandidateLimit: number;
  textCandidateLimit: number;
  candidateBodyBytes: number;
  queryEmbeddingCount: number;
};

const CHAT_FIRST_CANDIDATES = 96;
const CHAT_EXPANSION = 2;
const CHAT_CANDIDATE_LIMIT = 4_096;
const CHAT_MIN_EVIDENCE_TOKENS = 96;
const CHAT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const CHAT_RELEVANCE_FLOOR = 0.2;

export class RetrievalService {
  // A chat's abort signal owns the cache; another turn never reuses its vector.
  private readonly chatQueries = new WeakMap<AbortSignal, { projectId: string; query: string; prepared: Promise<PreparedSearch> }>();
  private readonly store: Pick<LanceStore, "vectorSearch" | "textSearch">;
  private readonly provider: Pick<EmbeddingProvider, "embedBatch">;
  private readonly db: Database.Database;
  private readonly resolveSpace?: (projectId: string, space: { id: string; dimension: number; fingerprint: string }) => Promise<{ provider: QueryProvider } | null>;

  constructor(a: any, b?: any, c?: any) {
    if (a?.lance) {
      this.db = a.db;
      this.store = a.lance;
      this.provider = a.provider;
      this.resolveSpace = a.resolveSpace;
    } else {
      this.store = a;
      this.provider = b;
      this.db = c;
    }
  }

  async search(input: SearchInput | string, query?: string): Promise<any> {
    if (typeof input === "string") {
      const result = await this.search({ projectId: input, query: query ?? "", limit: 20 });
      if (!result.ok) throw { code: result.error.code, repair: result.error.code === "INDEX_UNAVAILABLE" };
      return result.value;
    }
    try {
      const prepared = await this.prepare({ projectId: input.projectId, query: input.query, ...(input.signal ? { signal: input.signal } : {}) });
      const candidateLimit = Math.min(CHAT_CANDIDATE_LIMIT, Math.max(48, input.limit * 8));
      const round = await this.searchRound(prepared, candidateLimit, candidateLimit, Math.max(0, input.limit), false);
      return { ok: true, value: round.rows };
    } catch {
      return this.failure("INDEX_UNAVAILABLE", true);
    }
  }

  async searchForChat(input: ChatSearchInput): Promise<any> {
    if (input.evidenceTokenBudget < CHAT_MIN_EVIDENCE_TOKENS) {
      return {
        ok: true,
        value: [],
        diagnostics: {
          stopReason: "budget",
          rounds: 0,
          vectorCandidateLimit: 0,
          textCandidateLimit: 0,
          candidateBodyBytes: 0,
          queryEmbeddingCount: 0
        } satisfies ChatSearchDiagnostics
      };
    }

    let diagnostics: ChatSearchDiagnostics = {
      stopReason: "exhausted",
      rounds: 0,
      vectorCandidateLimit: CHAT_FIRST_CANDIDATES,
      textCandidateLimit: CHAT_FIRST_CANDIDATES,
      candidateBodyBytes: 0,
      queryEmbeddingCount: 0
    };
    try {
      const cached = input.signal ? this.chatQueries.get(input.signal) : undefined;
      const reusable = cached?.projectId === input.projectId && cached.query === input.query;
      const pending = reusable ? cached.prepared : this.prepare({ projectId: input.projectId, query: input.query, ...(input.signal ? { signal: input.signal } : {}) });
      if (input.signal && !reusable) this.chatQueries.set(input.signal, { projectId: input.projectId, query: input.query, prepared: pending });
      const prepared = await pending;
      diagnostics.queryEmbeddingCount = reusable ? 0 : 1;
      let vectorLimit = CHAT_FIRST_CANDIDATES;
      let textLimit = CHAT_FIRST_CANDIDATES;
      let mergedRows: Row[] = [];
      const bodyCosts: number[] = [];
      let structuralTokens = 0;
      let leadingScore: number | undefined;
      let noNewRounds = 0;

      while (true) {
        throwIfAborted(input.signal);
        const round = await this.searchRound(prepared, vectorLimit, textLimit, CHAT_CANDIDATE_LIMIT, true);
        diagnostics.rounds += 1;
        diagnostics.vectorCandidateLimit = vectorLimit;
        diagnostics.textCandidateLimit = textLimit;
        diagnostics.candidateBodyBytes += round.candidateBytes;
        if (leadingScore === undefined && round.leadingScore !== undefined) leadingScore = round.leadingScore;

        const scoreFloor = leadingScore === undefined ? undefined : leadingScore * CHAT_RELEVANCE_FLOOR;
        // Expansion re-ranks the whole authoritative set: a chunk found by a
        // second channel now scores higher than it did in the first round, so
        // refreshing its entry beats appending a stale, lower score.
        const byChunk = new Map(mergedRows.map((row) => [row.chunkId, row]));
        let newRows = 0;
        for (const row of round.rows) {
          const existing = byChunk.get(row.chunkId);
          if (existing) {
            if (!existing.structural && typeof row.score === "number" && (typeof existing.score !== "number" || row.score > existing.score)) {
              byChunk.set(row.chunkId, { ...existing, score: row.score });
            }
            continue;
          }
          if (scoreFloor !== undefined && typeof row.score === "number" && row.score < scoreFloor) continue;
          const cost = estimateCandidateCost(row);
          if (row.structural && structuralTokens + cost > Math.floor(input.evidenceTokenBudget * 0.25)) continue;
          mergedRows.push(row);
          byChunk.set(row.chunkId, row);
          newRows += 1;
          bodyCosts.push(cost);
          if (row.structural) structuralTokens += cost;
        }
        // Re-sort so a refreshed score moves the chunk to its true rank instead
        // of keeping the position it held when only one channel had found it.
        mergedRows = mergedRows
          .map((row) => byChunk.get(row.chunkId) ?? row)
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.chunkId.localeCompare(right.chunkId));

        mergedRows = diversifyHits(mergedRows, CHAT_CANDIDATE_LIMIT, 4);
        if (newRows === 0 && diagnostics.rounds > 1) noNewRounds += 1;
        else noNewRounds = 0;

        const medianCost = median(bodyCosts);
        const targetCount = Math.min(CHAT_CANDIDATE_LIMIT, Math.max(CHAT_FIRST_CANDIDATES, Math.ceil(input.evidenceTokenBudget / Math.max(64, medianCost)) * 4));
        const evidenceTokens = mergedRows.reduce((sum, row) => sum + estimateCandidateCost(row), 0);
        if (evidenceTokens >= input.evidenceTokenBudget || mergedRows.length >= targetCount) {
          diagnostics.stopReason = "budget";
          break;
        }
        if (round.vectorCount < vectorLimit && round.textCount < textLimit) {
          diagnostics.stopReason = "exhausted";
          break;
        }
        if (diagnostics.candidateBodyBytes >= CHAT_BODY_LIMIT_BYTES) {
          diagnostics.stopReason = "resource-limit";
          break;
        }
        if (noNewRounds >= 2) {
          diagnostics.stopReason = "relevance-tail";
          break;
        }
        if (vectorLimit >= CHAT_CANDIDATE_LIMIT && textLimit >= CHAT_CANDIDATE_LIMIT) {
          diagnostics.stopReason = "candidate-limit";
          break;
        }

        vectorLimit = round.vectorCount < vectorLimit ? vectorLimit : Math.min(CHAT_CANDIDATE_LIMIT, vectorLimit * CHAT_EXPANSION);
        textLimit = round.textCount < textLimit ? textLimit : Math.min(CHAT_CANDIDATE_LIMIT, textLimit * CHAT_EXPANSION);
      }

      return { ok: true, value: mergedRows, diagnostics };
    } catch (reason) {
      if (input.signal?.aborted || isCancelled(reason)) {
        diagnostics.stopReason = "cancelled";
        return { ok: true, value: [], diagnostics };
      }
      return this.failure("INDEX_UNAVAILABLE", true);
    }
  }

  private async prepare(input: { projectId: string; query: string; signal?: AbortSignal }): Promise<PreparedSearch> {
    const space = this.db.prepare("SELECT pes.space_id, es.provider, es.model_id, es.model_revision, es.dimension, es.distance, es.pooling, es.preprocess_version, es.chunking_version, es.fingerprint FROM project_embedding_spaces pes JOIN embedding_spaces es ON es.id = pes.space_id WHERE pes.project_id = ? AND es.state = 'active'").get(input.projectId) as SpaceRow | undefined;
    if (!space) throw new Error("embedding space not found");
    const resolved = this.resolveSpace ? await this.resolveSpace(input.projectId, { id: space.space_id, dimension: space.dimension, fingerprint: space.fingerprint ?? "" }) : null;
    if (this.resolveSpace && !resolved?.provider) throw new Error("embedding space unavailable");
    const queryProvider: QueryProvider = resolved?.provider ?? this.provider;
    if (typeof (queryProvider as Partial<EmbeddingProvider>).describe === "function") {
      const description = (queryProvider as EmbeddingProvider).describe();
      if (description.provider !== space.provider || description.modelId !== space.model_id || description.modelRevision !== space.model_revision || description.dimension !== space.dimension || description.distance !== space.distance || description.pooling !== space.pooling || description.preprocessVersion !== space.preprocess_version || description.chunkingVersion !== space.chunking_version) throw new Error("Embedding provider capability mismatch");
    }
    const signal = input.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const [vector] = await queryProvider.embedBatch([input.query], signal);
    if (!vector) throw new Error("embedding unavailable");
    return { spec: { id: space.space_id, dimension: space.dimension }, filter: { projectId: input.projectId }, query: input.query, queryProvider, vector, signal, passSignal: Boolean(input.signal) };
  }

  private async searchRound(prepared: PreparedSearch, vectorLimit: number, textLimit: number, finalLimit: number, directFirst: boolean): Promise<SearchRound> {
    throwIfAborted(prepared.signal);
    const [ann, bm25] = await Promise.all(prepared.passSignal
      ? [
        this.store.vectorSearch(prepared.spec, prepared.vector, vectorLimit, prepared.filter, prepared.signal),
        this.store.textSearch(prepared.spec, prepared.query, textLimit, prepared.filter, prepared.signal)
      ]
      : [
        this.store.vectorSearch(prepared.spec, prepared.vector, vectorLimit, prepared.filter),
        this.store.textSearch(prepared.spec, prepared.query, textLimit, prepared.filter)
      ]);
    throwIfAborted(prepared.signal);
    // Validate each channel against the current source revision before fusion.
    // Fusing content hashes first could let a stale row hide the current row.
    const rowByteLimit = directFirst ? Math.floor(CHAT_BODY_LIMIT_BYTES / 2) : Number.POSITIVE_INFINITY;
    const annRows = this.authoritativeRows(ann as RetrievalCandidate[], prepared.filter.projectId, rowByteLimit);
    const bm25Rows = this.authoritativeRows(bm25 as RetrievalCandidate[], prepared.filter.projectId, rowByteLimit);
    const fused = fuseRrf([annRows, bm25Rows]);
    const leadingScore = typeof fused[0]?.score === "number" ? fused[0].score : undefined;
    const rows = this.withStructuralContext(diversifyHits(fused as Row[], finalLimit, 4), prepared.filter.projectId, finalLimit, prepared.signal, directFirst);
    const candidateBytes = [...annRows, ...bm25Rows].reduce((sum, row) => sum + Buffer.byteLength(row.text, "utf8") + Buffer.byteLength(row.locatorJson, "utf8"), 0);
    return { rows, vectorCount: ann.length, textCount: bm25.length, candidateBytes, ...(leadingScore === undefined ? {} : { leadingScore }) };
  }

  private authoritativeRows(candidates: RetrievalCandidate[], projectId: string, maxBytes = Number.POSITIVE_INFINITY): Row[] {
    const output: Row[] = [];
    let bodyBytes = 0;
    for (let offset = 0; offset < candidates.length; offset += 400) {
      const batch = candidates.slice(offset, offset + 400);
      if (!batch.length) continue;
      const ids = batch.map((candidate) => candidate.chunkId);
      const statement = this.db.prepare(`SELECT sc.id chunk_id, sc.ordinal, sc.text, sc.locator_json, sc.content_hash, sr.id revision_id, s.id source_id, s.display_name source_display_name, s.kind source_kind FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sc.id IN (${ids.map(() => "?").join(",")}) AND s.project_id = ? AND s.status = 'active' AND s.current_revision_id = sr.id AND sr.state = 'ready'`);
      const rows = typeof (statement as any).all === "function"
        ? (statement as any).all(...ids, projectId) as Array<Record<string, unknown>>
        : ids.flatMap((id) => {
          const row = this.db.prepare("SELECT sc.id chunk_id, sc.ordinal, sc.text, sc.locator_json, sc.content_hash, sr.id revision_id, s.id source_id, s.display_name source_display_name, s.kind source_kind FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sc.id = ? AND s.project_id = ? AND s.status = 'active' AND s.current_revision_id = sr.id AND sr.state = 'ready'").get(id, projectId) as Record<string, unknown> | undefined;
          return row ? [row] : [];
        });
      const byId = new Map(rows.map((row) => [String(row.chunk_id), row]));
      for (const candidate of batch) {
        const row = byId.get(candidate.chunkId);
        if (!row) continue;
        const mapped: Row = {
          ...candidate,
          chunkId: String(row.chunk_id),
          contentHash: String(row.content_hash),
          ordinal: Number(row.ordinal),
          sourceId: String(row.source_id),
          revisionId: String(row.revision_id),
          text: String(row.text),
          locatorJson: String(row.locator_json),
          locator: JSON.parse(String(row.locator_json)) as Record<string, unknown>,
          ...(row.source_display_name === undefined ? {} : { sourceDisplayName: String(row.source_display_name) }),
          ...(row.source_kind === undefined ? {} : { sourceKind: String(row.source_kind) })
        };
        const rowBytes = Buffer.byteLength(mapped.text, "utf8") + Buffer.byteLength(mapped.locatorJson, "utf8");
        if (bodyBytes + rowBytes > maxBytes) return output;
        bodyBytes += rowBytes;
        output.push(mapped);
      }
    }
    return output;
  }

  private withStructuralContext(hits: Row[], projectId: string, limit: number, signal?: AbortSignal, directFirst = false): Row[] {
    const structuralWindow = 32;
    const statement = this.db.prepare("SELECT sc.id chunk_id, sc.ordinal, sc.text, sc.locator_json, sc.content_hash, sr.id revision_id, s.id source_id, s.display_name source_display_name, s.kind source_kind FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sr.id = ? AND s.project_id = ? AND s.status = 'active' AND s.current_revision_id = sr.id AND sr.state = 'ready' AND sc.ordinal BETWEEN ? AND ? ORDER BY sc.ordinal") as any;
    if (typeof statement.all !== "function") return hits;
    const windows = new Map<string, any[]>();
    const out: Row[] = [];
    const seen = new Set<string>();
    const add = (row: Row): void => { if (!seen.has(row.chunkId) && out.length < limit) { seen.add(row.chunkId); out.push(row); } };
    const authoritative = (hit: Row, row: any): Row => ({
      ...hit,
      chunkId: row.chunk_id,
      contentHash: row.content_hash,
      ordinal: row.ordinal,
      sourceId: row.source_id,
      revisionId: row.revision_id,
      text: row.text,
      locatorJson: row.locator_json,
      locator: JSON.parse(row.locator_json),
      ...(row.chunk_id === hit.chunkId ? {} : { structural: true }),
      ...(row.source_display_name === undefined ? {} : { sourceDisplayName: row.source_display_name }),
      ...(row.source_kind === undefined ? {} : { sourceKind: row.source_kind })
    });
    // Chat retrieval keeps every independent direct hit before spending the
    // remaining slots on structural neighbors. The generic search path keeps
    // its established structural ordering.
    if (directFirst) for (const hit of hits) add(hit);
    for (const hit of hits) {
      throwIfAborted(signal);
      const ordinal = hit.ordinal;
      if (typeof ordinal !== "number") { if (!directFirst) add(hit); continue; }
      const block = Math.floor(ordinal / structuralWindow) * structuralWindow;
      const key = `${hit.revisionId}:${block}`;
      let window = windows.get(key);
      if (!window) {
        window = statement.all(hit.revisionId, projectId, Math.max(0, block - structuralWindow), block + structuralWindow * 2 - 1) as any[];
        windows.set(key, window);
      }
      const rows = window.filter((row) => row.ordinal >= Math.max(0, ordinal - structuralWindow) && row.ordinal <= ordinal + structuralWindow);
      const parent = structuralPrefix(hit.text);
      const siblings = parent ? rows.filter((row) => structuralPrefix(row.text) === parent) : [];
      if (siblings.length > 1) {
        const hitIndex = siblings.findIndex((row) => row.chunk_id === hit.chunkId);
        const start = Math.max(0, Math.min(hitIndex - Math.floor(structuralWindow / 2), siblings.length - structuralWindow));
        for (const row of siblings.slice(start, start + structuralWindow)) add(authoritative(hit, row));
        continue;
      }
      if (!directFirst) add(hit);
      for (const neighbor of [ordinal + 1, Math.max(0, ordinal - 1)]) {
        const row = rows.find((candidate) => candidate.ordinal === neighbor);
        if (row) add(authoritative(hit, row));
      }
    }
    return out;
  }

  private failure(code: AppErrorDto["code"], recoverable: boolean): Result<Row[]> { return { ok: false, error: { code, messageKey: code === "INDEX_UNAVAILABLE" ? "errors.indexUnavailable" : "errors.notFound", recoverable } }; }
}

function estimateCandidateCost(row: Row): number { return Math.max(64, Math.ceil(Buffer.byteLength(row.text, "utf8") / 2) + Math.ceil(Buffer.byteLength(row.locatorJson, "utf8") / 2) + 64); }
function median(values: number[]): number { if (!values.length) return 64; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 64; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw Object.assign(new Error("Search cancelled"), { code: "CANCELLED" }); }
function isCancelled(reason: unknown): boolean { return typeof reason === "object" && reason !== null && "code" in reason && (reason as { code?: unknown }).code === "CANCELLED"; }
function structuralPrefix(text: string): string | undefined { const separator = /\r?\n[ \t]*\r?\n/.exec(text); if (!separator?.index) return undefined; const prefix = text.slice(0, separator.index).trim(); return prefix.length <= 240 ? prefix : undefined; }
