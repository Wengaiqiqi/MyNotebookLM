import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "../db/database";
import { LanceStore } from "./lance-store";
import { SpaceRepository } from "./space-repository";
import { IndexingService } from "./indexing-service";

const spec = (projectId: string, fingerprint: string) => ({ projectId, provider: "local", modelId: "m", modelRevision: "r", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1", fingerprint });
const row = (spaceId: string, id: string) => ({ chunkId: id, projectId: "p", sourceId: "src", revisionId: "rev", spaceId, ordinal: 0, contentHash: id, text: id, vector: [1, 0], locator: { id }, createdAt: 1 });

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
    const root = await mkdtemp(path.join(os.tmpdir(), "space-recovery-error-")); roots.push(root); const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); db.connection.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); const base = new SpaceRepository(db.connection); const s = base.createOrReuse(spec("p", "bad")); const repo = new SpaceRepository(db.connection, undefined, undefined, { deleteSpace: async () => { throw new Error("cleanup failed"); } }); await expect(repo.recoverInterrupted()).rejects.toThrow("cleanup failed"); expect(repo.get(s.id)?.state).toBe("preparing"); db.close();
  });
  it("rebuilds from SQLite chunks and cancels across batches without activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "space-rebuild-real-")); roots.push(root); const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations")); const c = db.connection; c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P"); c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x"); c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", "none", "none", "h", "offset", "v1", "awaiting_embedding");
    const chunks = [{ id: "c1", ordinal: 0, content_hash: "h1", text: "one", locator_json: "{}" }, { id: "c2", ordinal: 1, content_hash: "h2", text: "two", locator_json: "{}" }]; const insert = c.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,content_hash,text,locator_json) VALUES(?,?,?,?,?,?)"); for (const x of chunks) insert.run(x.id, "rev", x.ordinal, x.content_hash, x.text, x.locator_json);
    const lance = await LanceStore.open(path.join(root, "vectors")); const repo = new SpaceRepository(c, undefined, undefined, lance); const active = repo.createOrReuse(spec("p", "a")); c.prepare("UPDATE embedding_spaces SET state='active' WHERE id=?").run(active.id); c.prepare("INSERT INTO project_embedding_spaces VALUES(?,?,?)").run("p", active.id, "now"); await lance.createSpace(active); await lance.upsert(active, [row(active.id, "old")]); const shadow = repo.createOrReuse(spec("p", "b")); await lance.createSpace(shadow);
    const controller = new AbortController(); let calls = 0; const indexing = new IndexingService(c, { embedBatch: async (texts: string[], signal: AbortSignal) => { calls++; if (calls === 2) { controller.abort(); throw Object.assign(new Error("cancel"), { code: "SPACE_BUILD_CANCELLED" }); } return texts.map(() => [1, 0]); } }, lance); const service = new (await import("./space-service")).SpaceService(repo, { rebuild: async (input: unknown) => indexing.rebuild(input as never), optimize: async () => {} });
    try { await expect(service.rebuild({ spec: spec("p", "b"), signal: controller.signal, revisionId: "rev" })).rejects.toMatchObject({ code: "SPACE_BUILD_CANCELLED" }); expect(repo.active("p")?.id).toBe(active.id); await expect(lance.count(shadow)).rejects.toThrow(); expect(calls).toBe(2); await expect(new IndexingService(c, { embedBatch: async () => [[1, 0]] }, lance).rebuild({ revisionId: "rev", space: shadow })).rejects.toThrow(); } finally { await lance.close(); db.close(); }
  });
});
