import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";

export type LanceSpace = { id: string; dimension: number };
export type LanceRow = { chunkId: string; projectId: string; sourceId: string; revisionId: string; spaceId: string; ordinal: number; contentHash: string; text: string; vector: number[]; locator: unknown; createdAt: number };
type StoredRow = Omit<LanceRow, "locator"> & { locatorJson: string };
const locks = new Map<string, Promise<void>>();
const openStores = new Set<LanceStore>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANN_THRESHOLD = 4096;
const FILTER_FIELDS = new Set(["projectId", "sourceId", "revisionId", "spaceId"]);
function validateSpace(space: LanceSpace): void { if (!UUID.test(space.id)) throw new Error("Space id must be a UUID"); if (!Number.isInteger(space.dimension) || space.dimension <= 0) throw new Error("Space dimension must be positive"); }
function validateRow(space: LanceSpace, row: LanceRow): void { if (row.spaceId !== space.id) throw new Error("row spaceId mismatch"); if (typeof row.text !== "string") throw new Error("text column is invalid"); if (!row.chunkId || !row.projectId || !row.sourceId || !row.revisionId || !row.contentHash || !row.locator || !Number.isInteger(row.ordinal) || !Number.isFinite(row.createdAt)) throw new Error("row columns are invalid"); if (row.vector.length !== space.dimension) throw new Error("vector dimension mismatch"); if (row.vector.some(value => !Number.isFinite(value))) throw new Error("vector values must be finite"); }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"; const obj = value as Record<string, unknown>; return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}"; }
function tableName(space: LanceSpace): string { return "space_" + space.id.replace(/[^a-zA-Z0-9_]/g, "_"); }
function ignoreExistingIndex(error: unknown): void { if (!/already exists|duplicate|exists/i.test(error instanceof Error ? error.message : String(error))) throw error; }
function filterSql(filter?: Record<string, string>): string | undefined { if (!filter) return undefined; if (Object.keys(filter).some(key => !FILTER_FIELDS.has(key))) throw new Error("unknown filter field"); return Object.entries(filter).map(([key, value]) => key + " = '" + value.replaceAll("'", "''") + "'").join(" AND "); }
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> { const prior = locks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(r => { release = r; }); const queued = prior.then(() => current); locks.set(key, queued); await prior; try { return await fn(); } finally { release(); if (locks.get(key) === queued) locks.delete(key); } }

export class LanceStore {
  private constructor(private readonly db: lancedb.Connection) {}
  static async open(root: string): Promise<LanceStore> { await mkdir(root, { recursive: true }); const store = new LanceStore(await lancedb.connect(path.resolve(root))); openStores.add(store); return store; }
  static async closeAll(): Promise<void> { await Promise.all([...openStores].map(store => store.close())); }
  async close(): Promise<void> { this.db.close(); openStores.delete(this); }
  private async table(space: LanceSpace) { return this.db.openTable(tableName(space)); }
  async createSpace(space: LanceSpace): Promise<void> { validateSpace(space); await locked(tableName(space), async () => { if ((await this.db.tableNames()).includes(tableName(space))) return; const t = await this.db.createTable(tableName(space), [{ chunkId: "__schema__", projectId: "", sourceId: "", revisionId: "", spaceId: space.id, ordinal: -1, contentHash: "", text: "", vector: Array.from({ length: space.dimension }, () => 0), locatorJson: "{}", createdAt: 0 }]); await t.delete('chunkId = "__schema__"'); }); }
  async upsert(space: LanceSpace, rows: LanceRow[]): Promise<void> { validateSpace(space); rows.forEach(row => validateRow(space, row)); await locked(tableName(space), async () => { const t = await this.table(space); const data: StoredRow[] = rows.map(({ locator, ...r }) => ({ ...r, locatorJson: canonical(locator) })); if (data.length) await t.mergeInsert("chunkId").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(data); for (const column of ["projectId", "sourceId", "revisionId", "spaceId"]) { try { await t.createIndex(column, { config: lancedb.Index.btree(), replace: false, name: `${column}_idx` }); } catch (error) { ignoreExistingIndex(error); } } if (await t.countRows() >= ANN_THRESHOLD) { try { await t.createIndex("vector", { config: lancedb.Index.ivfFlat({ numPartitions: 16 }), replace: false, name: "vector_ann_idx" }); } catch (error) { ignoreExistingIndex(error); } } }); }
  async count(space: LanceSpace, filter?: Record<string, string>): Promise<number> { validateSpace(space); const table = await this.table(space); const where = filterSql(filter); if (!where) return table.countRows(); return (await table.query().where(where).toArray()).length; }
  async rows(space: LanceSpace): Promise<StoredRow[]> { return await (await this.table(space)).query().toArray() as unknown as StoredRow[]; }
  async vectorSearch(space: LanceSpace, vector: number[], limit: number, filter?: Record<string, string>): Promise<StoredRow[]> { validateSpace(space); if (vector.length !== space.dimension || vector.some(value => !Number.isFinite(value))) throw new Error("vector must have the space dimension and finite values"); if (filter && Object.keys(filter).some(key => !FILTER_FIELDS.has(key))) throw new Error("unknown filter field"); let q = (await this.table(space)).vectorSearch(vector).limit(limit); if (filter) q = q.where(Object.entries(filter).map(([k, v]) => k + " = '" + v.replaceAll("'", "''") + "'").join(" AND ")); return await q.toArray() as unknown as StoredRow[]; }
  async textSearch(space: LanceSpace, query: string, limit: number): Promise<StoredRow[]> { const t = await this.table(space); try { await t.createIndex("text", { config: lancedb.Index.fts(), replace: false }); } catch {} return await t.query().fullTextSearch(query).limit(limit).toArray() as unknown as StoredRow[]; }
  async deleteRevision(space: LanceSpace, revisionId: string): Promise<void> { await locked(tableName(space), async () => { await (await this.table(space)).delete("revisionId = '" + revisionId.replaceAll("'", "''") + "'"); }); }
  async deleteProject(space: LanceSpace, projectId: string): Promise<void> { await locked(tableName(space), async () => { await (await this.table(space)).delete("projectId = '" + projectId.replaceAll("'", "''") + "'"); }); }
  async deleteSpace(space: LanceSpace): Promise<void> { await locked(tableName(space), async () => { if ((await this.db.tableNames()).includes(tableName(space))) await this.db.dropTable(tableName(space)); }); }
  async optimize(space: LanceSpace): Promise<void> { validateSpace(space); const table = await this.table(space); const optimize = (table as unknown as { optimize?: () => Promise<unknown> }).optimize; if (!optimize) throw new Error("Lance optimize is unavailable"); await optimize.call(table); }
}
