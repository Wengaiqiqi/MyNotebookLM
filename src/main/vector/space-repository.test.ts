import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SpaceRepository } from "./space-repository";

function db() { const d = new Database(":memory:"); d.exec("CREATE TABLE embedding_spaces (id TEXT PRIMARY KEY, project_id TEXT, provider TEXT, model_id TEXT, model_revision TEXT, dimension INTEGER, distance TEXT, pooling TEXT, preprocess_version TEXT, chunking_version TEXT, fingerprint TEXT, state TEXT, progress_1000 INTEGER, created_at TEXT, updated_at TEXT); CREATE TABLE project_embedding_spaces (project_id TEXT PRIMARY KEY, space_id TEXT, updated_at TEXT);"); return d; }
describe("SpaceRepository", () => {
  it("reuses a fingerprint and atomically activates a shadow space", () => {
    const d = db(); const repo = new SpaceRepository(d as never, () => "now");
    const spec = { projectId: "p", provider: "openai", modelId: "m", modelRevision: "r", dimension: 3, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1", fingerprint: "fp" };
    const first = repo.createOrReuse(spec); d.prepare("UPDATE embedding_spaces SET state='validating' WHERE id=?").run(first.id); repo.activate("p", first.id); expect(repo.createOrReuse(spec).id).toBe(first.id);
    const shadow = repo.createOrReuse({ ...spec, fingerprint: "fp2" }); d.prepare("UPDATE embedding_spaces SET state='validating' WHERE id=?").run(shadow.id); repo.activate("p", shadow.id);
    expect(repo.active("p")?.id).toBe(shadow.id); expect(repo.get(first.id)?.state).toBe("retired");
  });
  it("rejects activation for another project and for non-validating spaces", () => {
    const d = db(); const repo = new SpaceRepository(d as never, () => "now");
    const spec = { projectId: "p", provider: "openai", modelId: "m", modelRevision: "r", dimension: 3, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1", fingerprint: "fp" };
    const space = repo.createOrReuse(spec);
    expect(() => repo.activate("other", space.id)).toThrow(/project/);
    expect(() => repo.activate("p", space.id)).toThrow(/validating/);
  });
  it("recovers interrupted states by deleting each shadow before marking failed", async () => {
    const d = db(); const repo = new SpaceRepository(d as never, () => "now");
    const spec = { projectId: "p", provider: "openai", modelId: "m", modelRevision: "r", dimension: 3, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1", fingerprint: "fp" };
    const active = repo.createOrReuse(spec); d.prepare("UPDATE embedding_spaces SET state='active' WHERE id=?").run(active.id); d.prepare("INSERT INTO project_embedding_spaces VALUES(?,?,?)").run("p", active.id, "now");
    const interrupted = repo.createOrReuse({ ...spec, fingerprint: "fp2" }); d.prepare("UPDATE embedding_spaces SET state='building' WHERE id=?").run(interrupted.id);
    const deleted: string[] = []; const recovering = new SpaceRepository(d as never, () => "now", undefined, { deleteSpace: async ({ id }: { id: string }) => { deleted.push(id); } });
    await recovering.recoverInterrupted(); expect(recovering.get(interrupted.id)?.state).toBe("failed"); expect(recovering.active("p")?.id).toBe(active.id); expect(deleted).toEqual([interrupted.id]);
    await recovering.recoverInterrupted(); expect(deleted).toEqual([interrupted.id]);
  });
  it("cleans Lance rows when cancelling a shadow space", async () => {
    const d = db(); const deleted: string[] = []; const repo = new SpaceRepository(d as never, () => "now", undefined, { deleteSpace: async (space: { id: string }) => { deleted.push(space.id); } } as never);
    const space = repo.createOrReuse({ projectId: "p", provider: "o", modelId: "m", modelRevision: "r", dimension: 3, distance: "cosine", pooling: "mean", preprocessVersion: "1", chunkingVersion: "1", fingerprint: "x" }); await repo.cancel(space.id); expect(repo.get(space.id)?.state).toBe("failed"); expect(deleted).toEqual([space.id]);
  });
});
