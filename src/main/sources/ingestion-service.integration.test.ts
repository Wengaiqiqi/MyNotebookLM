import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "../db/database";
import { IngestionService } from "./ingestion-service";
import { WorkerPool } from "../tasks/worker-pool";

describe("real ingestion worker integration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("parses a real source and persists chunks, revision, and task", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-ingestion-e2e-"));
    roots.push(root);
    const dbPath = path.join(root, "app.db");
    const migrations = path.resolve("src/main/db/migrations");
    const appDb = openAppDatabase(dbPath, migrations);
    const db = appDb.connection;
    const projectId = "project-e2e";
    const sourceId = "source-e2e";
    const revisionId = "revision-e2e";
    const taskId = "task-e2e";
    db.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(projectId, "E2E");
    db.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, 'text', ?)").run(sourceId, projectId, "fixture.txt");
    db.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, ?, ?, ?, 'offset', 'v1', 'parsing')").run(revisionId, sourceId, "fixture.txt", "fixture.txt", "hash-e2e");
    db.prepare("INSERT INTO tasks(id, project_id, source_id, kind, state, stage) VALUES (?, ?, ?, 'ingest', 'running', 'parsing')").run(taskId, projectId, sourceId);

    const workerUrl = new URL("../../../out/main/ingestionWorker.js", import.meta.url);
    const pool = new WorkerPool(1, workerUrl);
    try {
      const ingestion = new IngestionService(pool, db);
      await ingestion.run({ taskId, revisionId, kind: "text", data: new TextEncoder().encode("真实 worker fixture"), updatedAt: "2026-08-26T00:00:00.000Z" });
      expect(db.prepare("SELECT text FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all(revisionId)).toEqual([{ text: "真实 worker fixture" }]);
      expect(db.prepare("SELECT state, chunking_version FROM source_revisions WHERE id = ?").get(revisionId)).toEqual({ state: "awaiting_embedding", chunking_version: "blocks-480-80-v5" });
      expect(db.prepare("SELECT stage, state, progress_1000 FROM tasks WHERE id = ?").get(taskId)).toEqual({ stage: "embedding", state: "running", progress_1000: 600 });
    } finally {
      await pool.close();
      appDb.close();
    }
  }, 30000);
});
