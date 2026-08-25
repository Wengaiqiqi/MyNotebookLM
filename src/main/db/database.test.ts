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

  it("drops unbound credentials saved before migration 003", () => {
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
      expect(migrated.connection.prepare(
        "SELECT profile_id FROM credentials ORDER BY profile_id"
      ).all()).toEqual([]);
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

  it("creates the ingestion sources, revisions, chunks and tasks tables", () => {
    const bundledDatabase = openAppDatabase(
      path.join(temporaryRoot, "bundled-ingestion-1.db"),
      path.resolve("src/main/db/migrations")
    );
    try {
      expect(
        bundledDatabase.connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
      ).toEqual(expect.arrayContaining([
        { name: "sources" },
        { name: "source_revisions" },
        { name: "source_chunks" },
        { name: "tasks" }
      ]));
    } finally {
      bundledDatabase.close();
    }
  });

  it("enforces source foreign keys, kind/status checks and soft-delete fields", () => {
    const bundledDatabase = openAppDatabase(
      path.join(temporaryRoot, "bundled-ingestion-2.db"),
      path.resolve("src/main/db/migrations")
    );
    try {
      bundledDatabase.connection.prepare(`
        INSERT INTO projects(id, name, archived) VALUES (?, ?, 0)
      `).run("11111111-1111-4111-8111-111111111111", "Project");
      const insert = bundledDatabase.connection.prepare(`
        INSERT INTO sources(
          id, project_id, kind, display_name, status, current_revision_id,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      expect(() => insert.run(
        "99999999-9999-4999-8999-999999999991",
        "missing-project",
        "pdf",
        "Doc",
        "active",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null
      )).toThrow(/foreign key/i);

      expect(() => insert.run(
        "99999999-9999-4999-8999-999999999992",
        "11111111-1111-4111-8111-111111111111",
        "unsupported-kind",
        "Doc",
        "active",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null
      )).toThrow(/check/i);

      const ok = insert.run(
        "99999999-9999-4999-8999-999999999993",
        "11111111-1111-4111-8111-111111111111",
        "pdf",
        "Doc",
        "active",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        null
      );
      expect(ok.changes).toBe(1);

      const updated = bundledDatabase.connection.prepare(`
        UPDATE sources SET deleted_at = ? WHERE id = ?
      `).run("2026-01-02T00:00:00.000Z", "99999999-9999-4999-8999-999999999993");
      expect(updated.changes).toBe(1);
    } finally {
      bundledDatabase.close();
    }
  });

  it("enforces revision foreign keys and a single ready revision", () => {
    const bundledDatabase = openAppDatabase(
      path.join(temporaryRoot, "bundled-ingestion-3.db"),
      path.resolve("src/main/db/migrations")
    );
    try {
      bundledDatabase.connection.prepare(`
        INSERT INTO projects(id, name, archived) VALUES (?, ?, 0)
      `).run("11111111-1111-4111-8111-111111111111", "Project");
      bundledDatabase.connection.prepare(`
        INSERT INTO sources(
          id, project_id, kind, display_name, status, current_revision_id,
          created_at, updated_at, deleted_at
        ) VALUES (
          '99999999-9999-4999-8999-999999999993',
          '11111111-1111-4111-8111-111111111111',
          'pdf', 'Doc', 'active', NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `).run();

      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO source_revisions(
          id, source_id, original_path, stored_path, source_hash, locator_kind,
          chunking_version, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "88888888-8888-4888-8888-888888888881",
        "missing-source",
        "orig.pdf",
        "stored.pdf",
        "sha256:abc",
        "page",
        "blocks-900-150-v1",
        "failed",
        "2026-01-01T00:00:00.000Z"
      )).toThrow(/foreign key/i);

      bundledDatabase.connection.prepare(`
        INSERT INTO source_revisions(
          id, source_id, original_path, stored_path, source_hash, locator_kind,
          chunking_version, state, created_at
        ) VALUES (
          '88888888-8888-4888-8888-888888888882',
          '99999999-9999-4999-8999-999999999993',
          'orig.pdf', 'stored.pdf', 'sha256:abc', 'page',
          'blocks-900-150-v1', 'failed',
          '2026-01-01T00:00:00.000Z'
        )
      `).run();

      bundledDatabase.connection.prepare(`
        INSERT INTO source_revisions(
          id, source_id, original_path, stored_path, source_hash, locator_kind,
          chunking_version, state, created_at
        ) VALUES (
          '88888888-8888-4888-8888-888888888883',
          '99999999-9999-4999-8999-999999999993',
          'orig.pdf', 'stored.pdf', 'sha256:abc', 'page',
          'blocks-900-150-v1', 'ready',
          '2026-01-01T00:00:00.000Z'
        )
      `).run();
      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO source_revisions(
          id, source_id, original_path, stored_path, source_hash, locator_kind,
          chunking_version, state, created_at
        ) VALUES (
          '88888888-8888-4888-8888-888888888884',
          '99999999-9999-4999-8999-999999999993',
          'orig.pdf', 'stored.pdf', 'sha256:abc', 'page',
          'blocks-900-150-v1', 'ready',
          '2026-01-01T00:00:00.000Z'
        )
      `).run()).toThrow(/unique/i);
    } finally {
      bundledDatabase.close();
    }
  });

  it("enforces revision state and task state plus task progress range", () => {
    const bundledDatabase = openAppDatabase(
      path.join(temporaryRoot, "bundled-ingestion-4.db"),
      path.resolve("src/main/db/migrations")
    );
    try {
      bundledDatabase.connection.prepare(`
        INSERT INTO projects(id, name, archived) VALUES (?, ?, 0)
      `).run("22222222-2222-4222-8222-222222222222", "Project");
      bundledDatabase.connection.prepare(`
        INSERT INTO sources(
          id, project_id, kind, display_name, status, current_revision_id,
          created_at, updated_at, deleted_at
        ) VALUES (
          '99999999-9999-4999-8999-999999999994',
          '22222222-2222-4222-8222-222222222222',
          'url', 'Web', 'active', NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `);

      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO tasks(
          id, project_id, source_id, kind, state, stage, progress_1000,
          attempt, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "77777777-7777-4777-8777-777777777771",
        "22222222-2222-4222-8222-222222222222",
        null,
        "validation",
        "invalid-state",
        "validating",
        0,
        0,
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      )).toThrow(/check/i);

      expect(() => bundledDatabase.connection.prepare(`
        INSERT INTO tasks(
          id, project_id, source_id, kind, state, stage, progress_1000,
          attempt, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "77777777-7777-4777-8777-777777777772",
        "22222222-2222-4222-8222-222222222222",
        null,
        "ingest",
        "queued",
        "validating",
        1001,
        0,
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      )).toThrow(/check/i);

      const valid = bundledDatabase.connection.prepare(`
        INSERT INTO tasks(
          id, project_id, source_id, kind, state, stage, progress_1000,
          attempt, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
       "77777777-7777-4777-8777-777777777773",
        "22222222-2222-4222-8222-222222222222",
        null,
        "ingest",
        "queued",
        "validating",
        350,
        0,
        null,
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      );
      expect(valid.changes).toBe(1);
    } finally {
      bundledDatabase.close();
    }
  });
});
