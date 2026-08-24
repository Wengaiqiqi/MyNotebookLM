import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "./database";

const initialMigration = readFileSync(
  new URL("./migrations/001_initial.sql", import.meta.url),
  "utf8"
);

describe("openAppDatabase", () => {
  let temporaryRoot: string;
  let databaseFile: string;
  let migrationsDir: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-db-"));
    databaseFile = path.join(temporaryRoot, "nested", "app.db");
    migrationsDir = path.join(temporaryRoot, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(path.join(migrationsDir, "001_initial.sql"), initialMigration);
  });

  afterEach(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  it("migrates an empty database exactly once", () => {
    const appDb = openAppDatabase(databaseFile, migrationsDir);
    expect(
      appDb.connection.prepare("SELECT version FROM schema_migrations").all()
    ).toEqual([{ version: 1 }]);
    appDb.close();

    const reopened = openAppDatabase(databaseFile, migrationsDir);
    expect(
      reopened.connection.prepare("SELECT version FROM schema_migrations").all()
    ).toHaveLength(1);
    reopened.close();
  });

  it("rolls back a malformed migration without recording its version", () => {
    writeFileSync(
      path.join(migrationsDir, "002_broken.sql"),
      "CREATE TABLE incomplete ("
    );

    expect(() => openAppDatabase(databaseFile, migrationsDir)).toThrow();

    const connection = new Database(databaseFile);
    expect(
      connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
    ).toEqual([{ version: 1 }]);
    connection.close();
  });

  it("rejects duplicate migration versions", () => {
    writeFileSync(path.join(migrationsDir, "001_duplicate.sql"), initialMigration);

    expect(() => openAppDatabase(databaseFile, migrationsDir)).toThrow(/duplicate/i);
  });

  it("rejects a gap in migration versions", () => {
    writeFileSync(path.join(migrationsDir, "003_later.sql"), "SELECT 1;");

    expect(() => openAppDatabase(databaseFile, migrationsDir)).toThrow(/gap/i);
  });
});
