import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SpaceRepository } from "./space-repository";
import { SpaceService } from "./space-service";
import { IndexingService, canonicalEmbeddingFingerprint } from "./indexing-service";
import { MainSourceService } from "../sources/main-source-service";
import type { LanceRow } from "./lance-store";

describe("first-import recovery", () => {
  it.each(["success", "verification failure", "cancel during backup", "source cancelled during backup"])("publishes recovered sources only after a successful build: %s", async (outcome) => {
    const db = new Database(":memory:");
    const directory = path.resolve("src/main/db/migrations");
    for (const file of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(path.join(directory, file), "utf8"));
    try {
      db.prepare("INSERT INTO projects(id,name) VALUES ('p','Recovery')").run();
      for (const [id, state, taskState] of [["failed", "failed", "failed"], ["active", "awaiting_embedding", "running"], ["cancelled", "failed", "cancelled"]]) {
        db.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES (?,'p','text',?)").run(id, id);
        db.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES (?,?, 'original','stored','hash','paragraph','persisted',?)").run(id, id, state);
        db.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,text,locator_json,content_hash) VALUES (?,?,0,'Recoverable text','{}','hash')").run(id, id);
        db.prepare("INSERT INTO tasks(id,project_id,source_id,kind,state,stage) VALUES (?,'p',?,'ingest',?,'embedding')").run(id, id, taskState);
      }
      const capability = { provider: "local", modelId: "test", modelRevision: "r1", dimension: 2, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: "v1", chunkingVersion: "persisted" };
      const spec = { ...capability, projectId: "p", fingerprint: canonicalEmbeddingFingerprint(capability) };
      let rows: LanceRow[] = [];
      const lance = {
        createSpace: async () => {}, deleteRevision: async () => {}, deleteSpace: async () => { rows = []; },
        upsert: async (_space: unknown, values: LanceRow[]) => { rows.push(...values); },
        count: async () => rows.length, rows: async () => rows.map(row => ({ ...row, locatorJson: JSON.stringify(row.locator) })),
        vectorSearch: async () => rows.slice(0, 1).map(row => ({ ...row, locatorJson: JSON.stringify(row.locator) }))
      };
      const repository = new SpaceRepository(db, () => "2026-09-26T08:00:00.000Z", () => "11111111-1111-4111-8111-111111111111", lance);
      const sources = new MainSourceService(db, {} as never, {} as never);
      expect(sources.listSources("p").find(source => source.id === "failed")?.currentRevisionState).toBe("failed");
      expect(repository.rebuildRevisions("p")).toEqual([]);
      expect(repository.rebuildRevisions("p", true)).toEqual([{ id: "failed" }]);
      // A failed first auto-build leaves a reusable space row behind.
      await repository.fail(repository.createOrReuse(spec).id);
      const indexing = new IndexingService(db, { describe: () => capability, embedBatch: async (texts) => texts.map(() => [1, 0]) }, lance);
      const controller = new AbortController();
      const service = new SpaceService(repository, {
        rebuild: async (raw) => {
          const input = raw as { space: { id: string; dimension: number }; signal: AbortSignal };
          const revisions = repository.rebuildRevisions("p", true);
          for (const revision of revisions) await indexing.rebuild({ revisionId: revision.id, space: input.space, signal: input.signal });
          return revisions.map(revision => revision.id);
        }, optimize: async () => {}
      }, async () => {
        if (outcome === "cancel during backup") controller.abort();
        if (outcome === "source cancelled during backup") db.prepare("UPDATE tasks SET state='cancelled' WHERE id='failed'").run();
      });
      const work = service.rebuild({ spec, signal: controller.signal, verify: async () => {
        if (outcome === "verification failure") throw new Error("Verification failed");
      } });
      if (outcome === "verification failure") await expect(work).rejects.toThrow("Verification failed");
      else if (outcome === "cancel during backup") await expect(work).rejects.toMatchObject({ code: "SPACE_BUILD_CANCELLED" });
      else await work;
      const recovered = sources.listSources("p").find(source => source.id === "failed")!;
      expect(recovered.currentRevisionId).toBe(outcome === "success" ? "failed" : null);
      expect(recovered.currentRevisionState).toBe(outcome === "success" ? "ready" : "failed");
      expect(sources.listSources("p").filter(source => source.id !== "failed").every(source => source.currentRevisionId === null)).toBe(true);
      if (outcome === "success") expect(rows.map(row => row.revisionId)).toEqual(["failed"]);
    } finally { db.close(); }
  });
});
