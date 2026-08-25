import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
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
const settingsModelsMigration = readFileSync(
  new URL("./migrations/002_settings_models.sql", import.meta.url),
  "utf8"
);
const credentialBindingMigration = readFileSync(
  new URL("./migrations/003_credential_binding.sql", import.meta.url),
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

  function seedAppliedHistory(
    history: ReadonlyArray<Readonly<{ version: number; name: string }>>
  ): void {
    mkdirSync(path.dirname(databaseFile), { recursive: true });
    const connection = new Database(databaseFile);
    connection.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    const insert = connection.prepare(
      "INSERT INTO schema_migrations(version, name) VALUES (?, ?)"
    );
    for (const migration of history) insert.run(migration.version, migration.name);
    connection.close();
  }

  function seedLegacyAppliedHistory(versions: readonly number[]): void {
    mkdirSync(path.dirname(databaseFile), { recursive: true });
    const connection = new Database(databaseFile);
    connection.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    const insert = connection.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
    for (const version of versions) insert.run(version);
    connection.close();
  }

  function expectOpenToFail(message: RegExp): void {
    expect(() => {
      const appDb = openAppDatabase(databaseFile, migrationsDir);
      appDb.close();
    }).toThrow(message);
  }

  afterEach(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  it("migrates an empty database exactly once", () => {
    const appDb = openAppDatabase(databaseFile, migrationsDir);
    expect(
      appDb.connection.prepare("SELECT version, name FROM schema_migrations").all()
    ).toEqual([{ version: 1, name: "initial" }]);
    appDb.close();

    const reopened = openAppDatabase(databaseFile, migrationsDir);
    expect(
      reopened.connection.prepare("SELECT version FROM schema_migrations").all()
    ).toHaveLength(1);
    reopened.close();
  });

  it("upgrades a legacy applied history without changing its recorded version", () => {
    seedLegacyAppliedHistory([1]);

    const appDb = openAppDatabase(databaseFile, migrationsDir);

    expect(
      appDb.connection.prepare("SELECT version, name FROM schema_migrations").all()
    ).toEqual([{ version: 1, name: "initial" }]);
    appDb.close();
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

  it("backfills durable bindings for credentials saved before migration 003", () => {
    writeFileSync(path.join(migrationsDir, "002_settings_models.sql"), settingsModelsMigration);
    const beforeBinding = openAppDatabase(databaseFile, migrationsDir);
    beforeBinding.connection.prepare(`
      INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "11111111-1111-4111-8111-111111111111",
      "Existing profile",
      "openai-compatible",
      "generation",
      "https://models.example.test/v1/",
      "existing-model"
    );
    beforeBinding.connection.prepare(`
      INSERT INTO credentials(profile_id, encrypted_secret) VALUES (?, ?)
    `).run("11111111-1111-4111-8111-111111111111", Buffer.from("encrypted"));
    beforeBinding.connection.prepare(`
      INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "22222222-2222-4222-8222-222222222222",
      "Root endpoint",
      "gemini",
      "generation",
      "https://generativelanguage.googleapis.com/",
      "gemini-test"
    );
    beforeBinding.connection.prepare(`
      INSERT INTO credentials(profile_id, encrypted_secret) VALUES (?, ?)
    `).run("22222222-2222-4222-8222-222222222222", Buffer.from("encrypted-root"));
    beforeBinding.close();
    writeFileSync(
      path.join(migrationsDir, "003_credential_binding.sql"),
      credentialBindingMigration
    );

    const migrated = openAppDatabase(databaseFile, migrationsDir);
    try {
      expect(migrated.connection.prepare(`
        SELECT provider, base_url FROM credentials WHERE profile_id = ?
      `).get("11111111-1111-4111-8111-111111111111")).toEqual({
        provider: "openai-compatible",
        base_url: "https://models.example.test/v1"
      });
      expect(migrated.connection.prepare(`
        SELECT provider, base_url FROM credentials WHERE profile_id = ?
      `).get("22222222-2222-4222-8222-222222222222")).toEqual({
        provider: "gemini",
        base_url: "https://generativelanguage.googleapis.com/"
      });
    } finally {
      migrated.close();
    }
  });

  it("rejects duplicate migration versions", () => {
    writeFileSync(path.join(migrationsDir, "001_duplicate.sql"), initialMigration);

    expect(() => openAppDatabase(databaseFile, migrationsDir)).toThrow(/duplicate/i);
  });

  it("rejects a gap in migration versions", () => {
    writeFileSync(path.join(migrationsDir, "003_later.sql"), "SELECT 1;");

    expect(() => openAppDatabase(databaseFile, migrationsDir)).toThrow(/gap/i);
  });

  it("rejects an empty bundled migration chain", () => {
    unlinkSync(path.join(migrationsDir, "001_initial.sql"));

    expectOpenToFail(/empty|version 1/i);
  });

  it("rejects malformed SQL migration filenames", () => {
    writeFileSync(path.join(migrationsDir, "not_numbered.sql"), "SELECT 1;");

    expectOpenToFail(/filename/i);
  });

  it("rejects a non-contiguous applied migration history", () => {
    writeFileSync(path.join(migrationsDir, "002_second.sql"), "SELECT 2;");
    writeFileSync(path.join(migrationsDir, "003_third.sql"), "SELECT 3;");
    seedAppliedHistory([
      { version: 1, name: "initial" },
      { version: 3, name: "third" }
    ]);

    expectOpenToFail(/applied.*version 2/i);
  });

  it("rejects an applied migration ahead of the bundle", () => {
    seedAppliedHistory([
      { version: 1, name: "initial" },
      { version: 2, name: "future" }
    ]);

    expectOpenToFail(/ahead/i);
  });

  it("rejects an applied migration name that differs from the bundle", () => {
    seedAppliedHistory([{ version: 1, name: "renamed" }]);

    expectOpenToFail(/name/i);
  });

  it("creates the approved settings and model tables with safe defaults", () => {
    const bundledDatabase = openAppDatabase(
      path.join(temporaryRoot, "bundled.db"),
      path.resolve("src/main/db/migrations")
    );

    try {
      expect(
        bundledDatabase.connection
          .prepare("SELECT onboarding_completed, locale, theme FROM app_settings WHERE id = 1")
          .get()
      ).toEqual({ onboarding_completed: 0, locale: "zh-CN", theme: "light" });
      expect(
        bundledDatabase.connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
      ).toEqual(expect.arrayContaining([
        { name: "credentials" },
        { name: "model_profiles" },
        { name: "model_routes" }
      ]));
      expect(
        bundledDatabase.connection
          .prepare(`SELECT name, type, "notnull" AS required
            FROM pragma_table_info('credentials') ORDER BY cid`)
          .all()
      ).toEqual(expect.arrayContaining([
        { name: "provider", type: "TEXT", required: 1 },
        { name: "base_url", type: "TEXT", required: 1 }
      ]));
      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id)
        VALUES ('11111111-1111-4111-8111-111111111111', 'Broken', 'invalid', 'generation', '', 'x')
      `).run()).toThrow(/check/i);
      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id)
        VALUES ('22222222-2222-4222-8222-222222222222', 'Broken', 'anthropic', 'embedding', '', 'x')
      `).run()).toThrow(/check/i);
      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id)
        VALUES ('33333333-3333-4333-8333-333333333333', 'Broken', 'local', 'generation', '', 'x')
      `).run()).toThrow(/check/i);
    } finally {
      bundledDatabase.close();
    }
  });
});
