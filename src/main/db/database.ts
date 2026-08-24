import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type AppDatabase = Readonly<{
  connection: Database.Database;
  close: () => void;
}>;

type Migration = Readonly<{
  version: number;
  filePath: string;
}>;

function readMigrations(migrationsDir: string): Migration[] {
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const match = /^(\d{3})_.+\.sql$/.exec(entry.name);
      return match
        ? [{ version: Number(match[1]), filePath: path.join(migrationsDir, entry.name) }]
        : [];
    })
    .sort((left, right) => left.version - right.version);

  let previousVersion = 0;
  for (const migration of migrations) {
    if (previousVersion === migration.version) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }

    if (migration.version !== previousVersion + 1) {
      throw new Error(`Migration gap: expected version ${previousVersion + 1}`);
    }

    previousVersion = migration.version;
  }

  return migrations;
}

export function openAppDatabase(
  databasePath: string,
  migrationsDir: string
): AppDatabase {
  const migrations = readMigrations(migrationsDir);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const connection = new Database(databasePath);

  try {
    connection.pragma("journal_mode = WAL");
    connection.pragma("foreign_keys = ON");
    connection.pragma("busy_timeout = 5000");
    connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    const appliedVersions = new Set(
      (
        connection.prepare("SELECT version FROM schema_migrations").all() as Array<{
          version: number;
        }>
      ).map(({ version }) => version)
    );
    const apply = connection.transaction((version: number, sql: string) => {
      connection.exec(sql);
      connection
        .prepare("INSERT INTO schema_migrations(version) VALUES (?)")
        .run(version);
    });

    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        apply(migration.version, readFileSync(migration.filePath, "utf8"));
      }
    }
  } catch (error) {
    connection.close();
    throw error;
  }

  return {
    connection,
    close: () => connection.close()
  };
}
