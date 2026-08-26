import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";

export type LanceSpace = { id: string; dimension: number };
export type LanceRow = { chunkId: string; projectId: string; sourceId: string; revisionId: string; spaceId: string; ordinal: number; contentHash: string; text: string; vector: number[]; locator: unknown; createdAt: number };
type StoredRow = Omit<LanceRow, "locator"> & { locatorJson: string };
const locks = new Map<string, Promise<void>>();
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"; const obj = value as Record<string, unknown>; return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}"; }
function tableName(space: LanceSpace): string { return "space_" + space.id.replace(/[^a-zA-Z0-9_]/g, "_"); }
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> { const prior = locks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>(r => { release = r; }); locks.set(key, prior.then(() => current)); await prior; try { return await fn(); } finally { release(); if (locks.get(key) === current) locks.delete(key); } }

export class LanceStore {
  private constructor(private readonly db: lancedb.Connection) {}
  static async open(root: string): Promise<LanceStore> { await mkdir(root, { recursive: true }); return new LanceStore(await lancedb.connect(path.resolve(root))); }
  async close(): Promise<void> { this.db.close(); }
  private async table(space: LanceSpace) { return this.db.openTable(tableName(space)); }
  async createSpace(space: LanceSpace): Promise<void> { await locked(tableName(space), async () => { if ((await this.db.tableNames()).includes(tableName(space))) return; const t = await this.db.createTable(tableName(space), [{ chunkId: "__schema__", projectId: "", sourceId: "", revisionId: "", spaceId: space.id, ordinal: -1, contentHash: "", text: "", vector: Array.from({ length: space.dimension }, () => 0), locatorJson: "{}", createdAt: 0 }]); await t.delete('chunkId = "__schema__"'); }); }
  async upsert(space: LanceSpace, rows: LanceRow[]): Promise<void> { for (const row of rows) if (row.vector.length !== space.dimension) throw new Error("vector dimension mismatch"); await locked(tableName(space), async () => { const t = await this.table(space); const data: StoredRow[] = rows.map(({ locator, ...r }) => ({ ...r, locatorJson: canonical(locator) })); if (data.length) await t.mergeInsert("chunkId").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(data); for (const column of ["projectId", "sourceId", "revisionId", "spaceId"]) { try { await t.createIndex(column, { config: lancedb.Index.btree(), replace: false, name: `${column}_idx` }); } catch {} } }); }
  async count(space: LanceSpace): Promise<number> { return (await this.table(space)).countRows(); }
  async rows(space: LanceSpace): Promise<StoredRow[]> { return await (await this.table(space)).query().toArray() as unknown as StoredRow[]; }
  async vectorSearch(space: LanceSpace, vector: number[], limit: number, filter?: Record<string, string>): Promise<StoredRow[]> { if (vector.length !== space.dimension) throw new Error("vector dimension mismatch"); let q = (await this.table(space)).vectorSearch(vector).limit(limit); if (filter) q = q.where(Object.entries(filter).map(([k, v]) => k + " = '" + v.replaceAll("'", "''") + "'").join(" AND ")); return await q.toArray() as unknown as StoredRow[]; }
  async textSearch(space: LanceSpace, query: string, limit: number): Promise<StoredRow[]> { const t = await this.table(space); try { await t.createIndex("text", { config: lancedb.Index.fts(), replace: false }); } catch {} return await t.query().fullTextSearch(query).limit(limit).toArray() as unknown as StoredRow[]; }
  async deleteRevision(space: LanceSpace, revisionId: string): Promise<void> { await locked(tableName(space), async () => { await (await this.table(space)).delete("revisionId = '" + revisionId.replaceAll("'", "''") + "'"); }); }
  async deleteProject(space: LanceSpace, projectId: string): Promise<void> { await locked(tableName(space), async () => { await (await this.table(space)).delete("projectId = '" + projectId.replaceAll("'", "''") + "'"); }); }
  async deleteSpace(space: LanceSpace): Promise<void> { await locked(tableName(space), async () => { if ((await this.db.tableNames()).includes(tableName(space))) await this.db.dropTable(tableName(space)); }); }
}
