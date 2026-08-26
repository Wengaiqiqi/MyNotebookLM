import Database from "better-sqlite3";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupDatabase } from "./vector-backup";
describe("vector backups", () => {
  it("reopens and reads the verified backup in an OS temporary directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mynotebooklm-backup-"));
    try { const db = new Database(":memory:"); db.exec("CREATE TABLE x (v TEXT); INSERT INTO x VALUES ('ok')"); const result = await backupDatabase(db, path.join(dir, "backup.db")); const copy = new Database(result.path!); expect(copy.pragma("integrity_check", { simple: true })).toBe("ok"); expect(copy.prepare("SELECT v FROM x").pluck().get()).toBe("ok"); copy.close(); db.close(); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps exactly three newest verified files and metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mynotebooklm-backup-"));
    try { const db = new Database(":memory:"); db.exec("CREATE TABLE x (v TEXT)"); for (let i=0;i<4;i++) await backupDatabase(db, path.join(dir, "backup-" + i + ".db")); const files = await readdir(dir); expect(files.filter(f => f.endsWith(".db")).length).toBe(3); expect(files.filter(f => f.endsWith(".json")).length).toBe(3); db.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
