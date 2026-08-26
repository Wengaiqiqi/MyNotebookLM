import Database from "better-sqlite3";
import { access, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
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
  it("cleans interrupted temporary files and ignores corrupt metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mynotebooklm-backup-"));
    try {
      const target = path.join(dir, "backup.db");
      await writeFile(target + ".tmp", "stale"); await writeFile(target + ".verify", "stale"); await writeFile(target + ".json", "{broken");
      const db = new Database(":memory:"); db.exec("CREATE TABLE x (v TEXT); INSERT INTO x VALUES ('ok')");
      await backupDatabase(db, target);
      expect((await readdir(dir)).filter(f => f.endsWith(".tmp") || f.endsWith(".verify"))).toEqual([]);
      expect(JSON.parse(await readFile(target + ".json", "utf8")).verified).toBe(true);
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not replace a verified backup when backup fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mynotebooklm-backup-"));
    try { const target = path.join(dir, "backup.db"); const db = new Database(":memory:"); db.exec("CREATE TABLE x (v TEXT); INSERT INTO x VALUES ('good')"); await backupDatabase(db, target); db.exec("DROP TABLE x"); db.close(); await expect(backupDatabase(db, target)).rejects.toThrow(); const copy = new Database(target); expect(copy.prepare("SELECT name FROM sqlite_master WHERE name='x'").get()).toBeDefined(); copy.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not count a corrupt verified-looking file or temporary file toward three backups", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mynotebooklm-backup-"));
    try {
      const db = new Database(":memory:"); db.exec("CREATE TABLE x (v TEXT); INSERT INTO x VALUES ('ok')");
      const paths = ["one", "two", "three"].map((name) => path.join(dir, `backup-${name}.db`));
      for (const target of paths) await backupDatabase(db, target);
      const corrupt = path.join(dir, "backup-corrupt.db");
      await writeFile(corrupt, "corrupt");
      await writeFile(corrupt + ".json", JSON.stringify({ verified: true, createdAt: Date.now() + 1, path: corrupt, sha256: "bad" }));
      await writeFile(path.join(dir, "backup-temp.db.tmp"), "temporary");
      const latest = path.join(dir, "backup-four.db");
      await backupDatabase(db, latest);
      const valid = [] as string[];
      for (const target of [...paths, latest]) {
        try {
          await access(target);
          const copy = new Database(target);
          if (copy.pragma("integrity_check", { simple: true }) === "ok") valid.push(target);
          copy.close();
        } catch {}
      }
      expect(valid).toHaveLength(3);
      expect(valid).not.toContain(corrupt);
      expect((await readdir(dir)).filter((file) => file.endsWith(".tmp") || file.endsWith(".verify"))).toEqual(["backup-temp.db.tmp"]);
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
