import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SpaceRepository } from "./space-repository";

function db() { const d = new Database(":memory:"); d.exec("CREATE TABLE embedding_spaces (id TEXT PRIMARY KEY, project_id TEXT, provider TEXT, model_id TEXT, model_revision TEXT, dimension INTEGER, distance TEXT, pooling TEXT, preprocess_version TEXT, chunking_version TEXT, fingerprint TEXT, state TEXT, progress_1000 INTEGER, created_at TEXT, updated_at TEXT); CREATE TABLE project_embedding_spaces (project_id TEXT PRIMARY KEY, space_id TEXT, updated_at TEXT);"); return d; }
describe("SpaceRepository", () => {
  it("reuses a fingerprint and atomically activates a shadow space", () => {
    const d = db(); const repo = new SpaceRepository(d as never, () => "now");
    const spec = { projectId: "p", provider: "openai", modelId: "m", modelRevision: "r", dimension: 3, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "1", chunkingVersion: "1", fingerprint: "fp" };
    const first = repo.createOrReuse(spec); repo.activate("p", first.id); expect(repo.createOrReuse(spec).id).toBe(first.id);
    const shadow = repo.createOrReuse({ ...spec, fingerprint: "fp2" }); repo.activate("p", shadow.id);
    expect(repo.active("p")?.id).toBe(shadow.id); expect(repo.get(first.id)?.state).toBe("retired");
  });
});
