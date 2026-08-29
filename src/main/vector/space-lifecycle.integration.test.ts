import { mkdtemp, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "../db/database";
import { LanceStore } from "./lance-store";
import { SpaceRepository } from "./space-repository";
import { IndexingService, canonicalEmbeddingFingerprint } from "./indexing-service";
import { IngestionService } from "../sources/ingestion-service";
import { SpaceService } from "./space-service";
import { backupDatabase } from "./vector-backup";

const spec = (projectId: string, fingerprint: string) => ({ projectId, provider: "local", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1", fingerprint });
const validSpec = (projectId: string) => spec(projectId, canonicalEmbeddingFingerprint({ provider: "local", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine", pooling: "mean", preprocessVersion: "1", chunkingVersion: "1" }));
const row = (spaceId: string, id: string) => ({ chunkId: id, projectId: "p", sourceId: "src", revisionId: "rev", spaceId, ordinal: 0, contentHash: id, text: id, vector: [1, 0], locator: { id }, createdAt: 1 });
const provider = (embedBatch: (texts: string[], signal: AbortSignal, batchSize?: number) => Promise<number[][]>) => ({ describe: () => ({ provider: "local", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1" }), embedBatch });

describe("Space lifecycle real restart recovery", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  it("deletes preparing/building/validating shadow tables after reopen and preserves active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-recovery-real-")); roots.push(root);
    const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection; c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P");
    const lance = await LanceStore.open(path.join(root, "vectors")); const activeRepo = new SpaceRepository(c); const active = activeRepo.createOrReuse(spec("p", "active")); c.prepare("UPDATE embedding_spaces SET state='active' WHERE id=?").run(active.id); c.prepare("INSERT INTO project_embedding_spaces VALUES(?,?,?)").run("p", active.id, "now"); await lance.createSpace(active); await lance.upsert(active, [row(active.id, "active-row")]);
    const shadows = []; for (const [i, state] of ["preparing", "building", "validating"].entries()) { const s = activeRepo.createOrReuse(spec("p", `shadow-${i}`)); c.prepare("UPDATE embedding_spaces SET state=? WHERE id=?").run(state, s.id); await lance.createSpace(s); await lance.upsert(s, [row(s.id, `shadow-row-${i}`)]); shadows.push(s); }
    db.close(); await lance.close();
    const reopened = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const reopenedLance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(reopened.connection, undefined, undefined, reopenedLance); await repo.recoverInterrupted();
    for (const s of shadows) { expect(repo.get(s.id)?.state).toBe("failed"); await expect(reopenedLance.count(s)).rejects.toThrow(); } expect(repo.active("p")?.id).toBe(active.id); expect(await reopenedLance.count(active)).toBe(1); await repo.recoverInterrupted(); expect(repo.active("p")?.id).toBe(active.id);
    reopened.close(); await reopenedLance.close();
  }, 30000);
  it("does not mark a shadow recovered when Lance cleanup fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-recovery-error-")); roots.push(root); const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); db.connection.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); const base = new SpaceRepository(db.connection); const s = base.createOrReuse(spec("p", "bad")); const repo = new SpaceRepository(db.connection, undefined, undefined, { deleteSpace: async () => { throw new Error("cleanup failed"); } }); await expect(repo.recoverInterrupted()).rejects.toMatchObject({ name: "AggregateError" }); expect(repo.get(s.id)?.state).toBe("preparing"); db.close();
  });
  it("rebuilds from SQLite chunks and cancels across batches without activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-rebuild-real-")); roots.push(root); const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection; c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x"); c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", "none", "none", "h", "offset", "v1", "awaiting_embedding");
    const chunks = [{ id: "c1", ordinal: 0, content_hash: "h1", text: "one", locator_json: "{}" }, { id: "c2", ordinal: 1, content_hash: "h2", text: "two", locator_json: "{}" }]; const insert = c.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,content_hash,text,locator_json) VALUES(?,?,?,?,?,?)"); for (const x of chunks) insert.run(x.id, "rev", x.ordinal, x.content_hash, x.text, x.locator_json);
    const lance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(c, undefined, undefined, lance); const active = repo.createOrReuse(spec("p", "a")); c.prepare("UPDATE embedding_spaces SET state='active' WHERE id=?").run(active.id); c.prepare("INSERT INTO project_embedding_spaces VALUES(?,?,?)").run("p", active.id, "now"); await lance.createSpace(active); await lance.upsert(active, [row(active.id, "old")]); const shadow = repo.createOrReuse(validSpec("p")); await lance.createSpace(shadow);
    const controller = new AbortController(); let calls = 0; const indexing = new IndexingService(c, provider(async (texts: string[], signal: AbortSignal) => { calls++; if (calls === 2) { controller.abort(); throw Object.assign(new Error("cancel"), { code: "SPACE_BUILD_CANCELLED" }); } return texts.map(() => [1, 0]); }), lance); const service = new (await import("./space-service")).SpaceService(repo, { rebuild: async (input: unknown) => indexing.rebuild(input as never), optimize: async () => {} });
    try { await expect(service.rebuild({ spec: validSpec("p"), signal: controller.signal, revisionId: "rev" })).rejects.toMatchObject({ code: "SPACE_BUILD_CANCELLED" }); expect(repo.active("p")?.id).toBe(active.id); await expect(lance.count(shadow)).rejects.toThrow(); expect(calls).toBe(2); await expect(new IndexingService(c, provider(async () => [[1, 0]]), lance).rebuild({ revisionId: "rev", space: shadow })).rejects.toThrow(); } finally { await lance.close(); db.close(); }
  });
  it("recovers source_chunks from a managed original through the real file read path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-managed-original-")); roots.push(root);
    const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection;
    c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P");
    c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x");
    const managedPath = path.join(root, "managed.txt"); const content = "managed original bytes"; await writeFile(managedPath, content);
    c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", managedPath, managedPath, "h", "offset", "v1", "awaiting_embedding");
    let seen: Uint8Array | undefined; const pool = { start: async (_task: string, _rev: string, _kind: string, bytes: Uint8Array) => { seen = bytes; return { version: 1 as const, type: "result" as const, taskId: "parse", chunks: [{ ordinal: 0, text: content, locator: { end: content.length, kind: "offset" as const, start: 0 }, contentHash: "hash", tokenEstimate: 3 }] }; }, cancel: () => {} };
    const ingestion = new IngestionService(pool, c); const lance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(c, undefined, undefined, lance); const shadow = repo.createOrReuse(validSpec("p")); await lance.createSpace(shadow);
    const indexing = new IndexingService(c, provider(async () => [[1, 0]]), lance); indexing.setChunkRecovery((revisionId) => ingestion.reparseRevision(revisionId));
    await indexing.rebuild({ revisionId: "rev", space: shadow, batchSize: 1 });
    expect(new TextDecoder().decode(seen)).toBe(content); expect(c.prepare("SELECT count(*) AS n FROM source_chunks WHERE revision_id=?").get("rev")).toEqual({ n: 1 }); expect(await lance.count(shadow)).toBe(1); const stored = (await lance.rows(shadow))[0]!; expect(stored.text).toBe(content); expect(Array.from(stored.vector)).toEqual([1, 0]);
    await lance.close(); db.close();
  });
  it("returns structured unrecoverable error when the managed original is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-managed-missing-")); roots.push(root); const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection; c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x"); const missing = path.join(root, "gone.txt"); c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", missing, missing, "h", "offset", "v1", "awaiting_embedding"); const lance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(c, undefined, undefined, lance); const shadow = repo.createOrReuse(validSpec("p")); await lance.createSpace(shadow); const ingestion = new IngestionService({ start: async () => { throw new Error("should not parse"); }, cancel: () => {} }, c); const indexing = new IndexingService(c, provider(async () => [[1, 0]]), lance); indexing.setChunkRecovery((id) => ingestion.reparseRevision(id)); await expect(indexing.rebuild({ revisionId: "rev", space: shadow })).rejects.toMatchObject({ code: "SPACE_REBUILD_SOURCE_UNRECOVERABLE" }); expect(await lance.count(shadow)).toBe(0); await lance.close(); db.close();
  });
  it("rebuilds a corrupt active space in place and reactivates it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-shadow-corrupt-")); roots.push(root);
    const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection; c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x"); c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", "none", "none", "h", "offset", "v1", "ready");
    c.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,content_hash,text,locator_json) VALUES(?,?,?,?,?,?)").run("c1", "rev", 0, "h1", "one", "{}");
    const lance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(c, undefined, undefined, lance);
    const active = repo.createOrReuse(validSpec("p")); c.prepare("UPDATE embedding_spaces SET state='active' WHERE id=?").run(active.id); c.prepare("INSERT INTO project_embedding_spaces VALUES(?,?,?)").run("p", active.id, "now");
    await lance.createSpace(active); await lance.upsert(active, [row(active.id, "old")]);
    const { rm } = await import("node:fs/promises");
    await rm(path.join(root, "vectors", `space_${active.id.replace(/[^a-zA-Z0-9_]/g, "_")}.lance`, "_versions"), { recursive: true, force: true });
    const indexing = new IndexingService(c, provider(async () => [[1, 0]]), lance);
    const service = new (await import("./space-service")).SpaceService(repo, { rebuild: async (input: unknown) => indexing.rebuild(input as never), optimize: async () => {} });
    await service.rebuild({ spec: validSpec("p"), revisionId: "rev" });
    expect(repo.active("p")?.id).toBe(active.id);
    expect(repo.active("p")?.state).toBe("active");
    expect(await lance.count(active)).toBe(1);
    await lance.close(); db.close();
  });
  it("does not activate a space when production validation rejects vector dimension", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-validation-real-")); roots.push(root); const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection; c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x"); c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", "none", "none", "h", "offset", "v1", "awaiting_embedding"); c.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,content_hash,text,locator_json) VALUES(?,?,?,?,?,?)").run("c1", "rev", 0, "h1", "one", "{}"); const lance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(c, undefined, undefined, lance); const active = repo.createOrReuse(spec("p", "active")); c.prepare("UPDATE embedding_spaces SET state='active' WHERE id=?").run(active.id); c.prepare("INSERT INTO project_embedding_spaces VALUES(?,?,?)").run("p", active.id, "now"); await lance.createSpace(active); await lance.upsert(active, [row(active.id, "old")]); const indexing = new IndexingService(c, provider(async () => [[1, 2, 3]]), lance); const shadow = repo.createOrReuse(validSpec("p")); await lance.createSpace(shadow); const service = new (await import("./space-service")).SpaceService(repo, { rebuild: async (input: unknown) => indexing.rebuild(input as never), optimize: async () => {} }); await expect(service.rebuild({ spec: validSpec("p"), revisionId: "rev" })).rejects.toThrow(); expect(repo.active("p")?.id).toBe(active.id); await expect(lance.count(shadow)).rejects.toThrow(); await lance.close(); db.close();
  });

  it("activates only after a real verified SQLite backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-backup-real-")); roots.push(root);
    const databasePath = path.join(root, "app.db"); const db = openAppDatabase(databasePath, path.resolve("src/main/db/migrations")); const c = db.connection;
    c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P");
    const repo = new SpaceRepository(c); const backupPath = path.join(root, "space.db");
    const service = new SpaceService(repo, undefined, async () => backupDatabase(c, backupPath));
    const space = repo.createOrReuse(spec("p", "verified"));
    await service.build(spec("p", "verified"), async () => repo.setState(space.id, "validating", 1000));
    expect(repo.active("p")?.fingerprint).toBe("verified");
    const backup = new Database(backupPath);
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(backup.prepare("SELECT state FROM embedding_spaces WHERE fingerprint='verified'").get()).toEqual({ state: "validating" });
    backup.close(); db.close();
  });

  it("does not activate when the real SQLite backup fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-backup-failure-")); roots.push(root);
    const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection;
    c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P");
    const repo = new SpaceRepository(c); const service = new SpaceService(repo, undefined, async () => { throw new Error("backup failed"); });
    const space = repo.createOrReuse(spec("p", "failed"));
    await expect(service.build(spec("p", "failed"), async () => repo.setState(space.id, "validating", 1000))).rejects.toThrow("backup failed");
    expect(repo.active("p")).toBeUndefined();
    expect(repo.createOrReuse(spec("p", "failed")).state).toBe("failed");
    db.close();
  });
});
