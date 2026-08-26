import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backupDatabase } from "./vector-backup";
describe("vector backups", () => it("returns a verified backup with a digest", async () => {
  const db = new Database(":memory:"); db.exec("CREATE TABLE x (v TEXT); INSERT INTO x VALUES ('ok')");
  const result = await backupDatabase(db, "memory-backup.db");
  expect(result.verified).toBe(true); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/); db.close();
}));
