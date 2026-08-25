import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type AppDatabase = Readonly<{
  connection: Database.Database;
  close: () => void;
}>;

type Migration = Readonly<{
  version: number;
  name: string;
  filePath: string;
}>;

function readMigrations(migrationsDir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.sql$/i.test(entry.name)) continue;
    const match = /^(\d{3})_(.+)\.sql$/.exec(entry.name);
    if (!match) throw new Error(`Malformed migration filename: ${entry.name}`);
    migrations.push({
      version: Number(match[1]),
      name: match[2]!,
      filePath: path.join(migrationsDir, entry.name)
    });
  }
  migrations.sort((left, right) => left.version - right.version);

  if (migrations.length === 0) throw new Error("Bundled migration chain is empty");

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

type AppliedMigration = Readonly<{ version: number; name: string }>;

function validateAppliedHistory(
  applied: ReadonlyArray<Readonly<{ version: number; name?: string }>>,
  bundled: readonly Migration[]
): void {
  for (const [index, migration] of applied.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Applied migration history is non-contiguous: expected version ${expectedVersion}`
      );
    }
    const bundledMigration = bundled[index];
    if (!bundledMigration) {
      throw new Error(`Applied migration version ${migration.version} is ahead of the bundle`);
    }
    if (migration.name !== undefined && migration.name !== bundledMigration.name) {
      throw new Error(`Applied migration ${migration.version} name does not match the bundle`);
    }
  }
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
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    const columns = connection.pragma("table_info(schema_migrations)") as Array<{
      name: string;
    }>;
    const legacyHistory = connection
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    validateAppliedHistory(legacyHistory, migrations);

    if (!columns.some((column) => column.name === "name")) {
      connection.transaction(() => {
        connection.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
        const update = connection.prepare(
          "UPDATE schema_migrations SET name = ? WHERE version = ?"
        );
        for (const applied of legacyHistory) {
          update.run(migrations[applied.version - 1]!.name, applied.version);
        }
      })();
    }

    const applied = connection
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as AppliedMigration[];
    validateAppliedHistory(applied, migrations);
    const appliedVersions = new Set(applied.map(({ version }) => version));
    const apply = connection.transaction((migration: Migration, sql: string) => {
      connection.exec(sql);
      connection
        .prepare("INSERT INTO schema_migrations(version, name) VALUES (?, ?)")
        .run(migration.version, migration.name);
    });

    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        apply(migration, readFileSync(migration.filePath, "utf8"));
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
