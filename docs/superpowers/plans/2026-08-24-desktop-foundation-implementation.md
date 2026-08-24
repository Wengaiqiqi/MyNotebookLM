# MyNotebookLM Desktop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an installable Windows x64 Electron application with a secure process boundary, migrated local SQLite database, project CRUD, Chinese/English switching, light/dark themes, and an approved production UI shell.

**Architecture:** Electron's main process owns local paths, SQLite, project services, and IPC handlers; the sandboxed React renderer can access them only through a narrow typed preload bridge. This plan deliberately stops before model providers, document ingestion, LanceDB, and RAG; those are separate plans that build on the interfaces defined here.

**Tech Stack:** Electron 43.4.1, electron-vite 5.0.0, React 19.2.8, TypeScript 7.0.2, Vite 8.2.2, Vitest 4.1.11, better-sqlite3 13.0.3, Zod 4.4.3, i18next 26.4.0, react-i18next 17.0.12, Playwright 1.62.1, electron-builder 26.15.3, NSIS.

**Spec:** `docs/superpowers/specs/2026-08-24-mynotebooklm-desktop-design.md`

## Global Constraints

- Target only Windows x64 in this phase.
- The application must start as an installed desktop window; it must not open a browser, require Docker, or require a manually started HTTP service.
- Keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false` for every renderer window.
- Store local state beneath Electron's `app.getPath("userData")`; do not write application data into the installation directory.
- SQLite is the authoritative business database and must run numbered migrations before services become available.
- Runtime-validate every IPC input and output with Zod.
- UI copy must exist in Simplified Chinese and English with identical translation keys.
- Do not implement a frontend page or important visual state until its high-fidelity design image has been shown to and approved by the user.
- Use plain CSS variables and React state for this phase; do not add Tailwind, a component framework, Redux, Zustand, or TanStack Query.
- Use Node's built-in `fetch`, `crypto`, `path`, and `fs` APIs instead of wrapper dependencies.
- Every task ends with its focused checks and a commit; do not batch unrelated tasks into one commit.

## Spec Coverage Boundary

This plan implements the approved spec's desktop shell, secure process boundary, application paths, SQLite migration foundation, project management, bilingual/theme foundation, UI approval workflow, Windows packaging, and foundation tests.

The remaining approved requirements are intentionally assigned to four subsequent independently testable plans, written only after this foundation passes its completion gate:

1. **Model Connectivity:** DPAPI credentials, OpenAI, Anthropic, Gemini, Ollama, local/cloud Embedding profiles, connection tests, and model settings UI.
2. **Document Ingestion:** durable task state machine, managed files, URL/TXT/MD/PDF/DOCX/PPTX/XLSX/CSV parsing, locators, format-aware chunking, cancellation, retry, and progress UI.
3. **Vector Retrieval:** embedded LanceDB, Embedding Spaces, local model download, cloud/local batch embeddings, ANN/FTS indexes, RRF hybrid search, migrations, rebuild, and index health UI.
4. **RAG Conversations:** conversation persistence, streaming provider calls, context budgets, citations, cancel/retry, end-to-end retrieval QA, and final product hardening.

No task in this plan may implement a partial placeholder for those later subsystems.

## Planned File Map

```text
package.json                         pinned scripts and dependencies
package-lock.json                    reproducible npm resolution
electron.vite.config.ts              main/preload/renderer build entrypoints
electron-builder.yml                 NSIS Windows x64 packaging
tsconfig.json                        shared strict TypeScript options
tsconfig.node.json                   main/preload TypeScript options
tsconfig.web.json                    renderer TypeScript options
vitest.config.ts                     unit/integration test configuration
playwright.config.ts                 packaged Electron smoke configuration
src/main/index.ts                    Electron lifecycle and composition root
src/main/window.ts                   secure BrowserWindow creation
src/main/platform/paths.ts           user data and database paths
src/main/db/database.ts              SQLite open, pragmas, migrations, close
src/main/db/migrations/001_initial.sql initial business schema
src/main/projects/project-repository.ts SQL-only project persistence
src/main/projects/project-service.ts validation and project operations
src/main/ipc/register-project-handlers.ts project IPC registration
src/preload/index.ts                 typed, minimal renderer bridge
src/shared/projects.ts               project DTOs and Zod schemas
src/shared/ipc.ts                    channel constants and desktop API contract
src/renderer/index.html              renderer HTML entrypoint
src/renderer/src/main.tsx            React bootstrap
src/renderer/src/App.tsx             application shell and project states
src/renderer/src/global.d.ts         typed window.myNotebook API
src/renderer/src/i18n.ts             locale initialization and persistence
src/renderer/src/locales/en.ts       English copy
src/renderer/src/locales/zh-CN.ts    Simplified Chinese copy
src/renderer/src/styles.css          approved theme and shell styling
e2e/desktop.spec.ts                  packaged Electron user-path smoke test
docs/ui/foundation/                  user-approved foundation mockups
```

---

### Task 1: Reproducible Electron Bootstrap

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `src/main/index.ts`
- Create: `src/main/window.ts`
- Create: `src/main/platform/paths.ts`
- Create: `src/main/platform/paths.test.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`

**Interfaces:**
- Produces: `getAppPaths(userDataDir: string): AppPaths`
- Produces: Electron build outputs at `out/main/index.js`, `out/preload/index.js`, and `out/renderer/index.html`
- Consumes: none

- [ ] **Step 1: Create the pinned toolchain manifest**

Create `package.json` with the following scripts and exact dependency versions:

```json
{
  "name": "mynotebooklm",
  "version": "0.1.0",
  "private": true,
  "description": "Local-first AI research assistant for Windows",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "package:win": "npm run build && electron-builder --win nsis --x64",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "better-sqlite3": "13.0.3",
    "i18next": "26.4.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-i18next": "17.0.12",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "1.62.1",
    "@types/better-sqlite3": "9.6.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.0",
    "electron": "43.4.1",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "playwright": "1.62.1",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11"
  }
}
```

Run:

```powershell
npm install
```

Expected: `package-lock.json` is created and native dependencies are rebuilt for Electron without errors.

- [ ] **Step 2: Add strict build and test configuration**

Create the three TypeScript configs with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and `verbatimModuleSyntax: true`. Configure `electron.vite.config.ts` with `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer` as the three entrypoints. Configure Vitest to include `src/**/*.test.ts`, run in Node, and clear mocks between tests.

The central compiler options in `tsconfig.json` must be:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Write the failing application-path test**

```ts
import { describe, expect, it } from "vitest";
import { getAppPaths } from "./paths";

describe("getAppPaths", () => {
  it("keeps mutable data beneath Electron userData", () => {
    expect(getAppPaths("C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM")).toEqual({
      root: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM",
      database: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\data\\app.db",
      files: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\files",
      logs: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\logs"
    });
  });
});
```

- [ ] **Step 4: Run the focused test and verify failure**

Run:

```powershell
npx vitest run src/main/platform/paths.test.ts
```

Expected: FAIL because `./paths` does not exist.

- [ ] **Step 5: Implement paths and the minimal secure window**

Implement `getAppPaths` as a pure function:

```ts
import path from "node:path";

export type AppPaths = Readonly<{
  root: string;
  database: string;
  files: string;
  logs: string;
}>;

export function getAppPaths(userDataDir: string): AppPaths {
  return {
    root: userDataDir,
    database: path.join(userDataDir, "data", "app.db"),
    files: path.join(userDataDir, "files"),
    logs: path.join(userDataDir, "logs")
  };
}
```

`createMainWindow()` in `src/main/window.ts` must use these security flags:

```ts
new BrowserWindow({
  width: 1440,
  height: 900,
  minWidth: 1100,
  minHeight: 700,
  show: false,
  webPreferences: {
    preload: path.join(__dirname, "../preload/index.js"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false
  }
});
```

Show the window on `ready-to-show`. Deny every `window.open` request and navigate only to the packaged renderer or the electron-vite development URL. `src/main/index.ts` must handle `app.whenReady()`, `activate`, and `window-all-closed` without starting any HTTP server.

- [ ] **Step 6: Verify bootstrap**

Run:

```powershell
npm run test -- src/main/platform/paths.test.ts
npm run typecheck
npm run build
```

Expected: the focused test passes; both TypeScript projects pass; Electron emits all three build outputs.

- [ ] **Step 7: Commit the bootstrap**

```powershell
git add package.json package-lock.json electron.vite.config.ts tsconfig*.json vitest.config.ts src
git commit -m "chore: scaffold secure Electron desktop app"
```

### Task 2: Typed and Runtime-Validated Preload Bridge

**Files:**
- Create: `src/shared/projects.ts`
- Create: `src/shared/ipc.ts`
- Create: `src/preload/create-desktop-api.ts`
- Create: `src/preload/create-desktop-api.test.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: `ProjectDto`, `CreateProjectInput`, `RenameProjectInput`, `ProjectIdInput`
- Produces: `DesktopApi.projects.list/create/rename/archive/remove`
- Produces: channel constants under `PROJECT_CHANNELS`
- Consumes: Electron `ipcRenderer.invoke`

- [ ] **Step 1: Define shared schemas and exact API types**

```ts
import { z } from "zod";

export const projectDtoSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(80)
});
export const renameProjectInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80)
});
export const projectIdInputSchema = z.object({ id: z.uuid() });

export type ProjectDto = z.infer<typeof projectDtoSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type RenameProjectInput = z.infer<typeof renameProjectInputSchema>;
export type ProjectIdInput = z.infer<typeof projectIdInputSchema>;
```

Define `DesktopApi` in `src/shared/ipc.ts`:

```ts
export const PROJECT_CHANNELS = {
  list: "projects:list",
  create: "projects:create",
  rename: "projects:rename",
  archive: "projects:archive",
  remove: "projects:remove"
} as const;

export interface DesktopApi {
  projects: {
    list(): Promise<ProjectDto[]>;
    create(input: CreateProjectInput): Promise<ProjectDto>;
    rename(input: RenameProjectInput): Promise<ProjectDto>;
    archive(input: ProjectIdInput): Promise<ProjectDto>;
    remove(input: ProjectIdInput): Promise<void>;
  };
}
```

- [ ] **Step 2: Write the failing bridge test**

Use a minimal invoker stub so the unit test does not import Electron:

```ts
it("exposes only named project commands", async () => {
  const invoke = vi.fn().mockResolvedValue([]);
  const api = createDesktopApi({ invoke });

  await api.projects.list();
  expect(invoke).toHaveBeenCalledWith(PROJECT_CHANNELS.list);
  expect(Object.keys(api)).toEqual(["projects"]);
  expect(Object.keys(api.projects)).toEqual(["list", "create", "rename", "archive", "remove"]);
});
```

- [ ] **Step 3: Verify the bridge test fails**

Run:

```powershell
npx vitest run src/preload/create-desktop-api.test.ts
```

Expected: FAIL because `createDesktopApi` is missing.

- [ ] **Step 4: Implement the narrow bridge**

```ts
type IpcInvoker = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
};

export function createDesktopApi(ipc: IpcInvoker): DesktopApi {
  return {
    projects: {
      list: async () => projectDtoSchema.array().parse(await ipc.invoke(PROJECT_CHANNELS.list)),
      create: async (input) => projectDtoSchema.parse(
        await ipc.invoke(PROJECT_CHANNELS.create, createProjectInputSchema.parse(input))
      ),
      rename: async (input) => projectDtoSchema.parse(
        await ipc.invoke(PROJECT_CHANNELS.rename, renameProjectInputSchema.parse(input))
      ),
      archive: async (input) => projectDtoSchema.parse(
        await ipc.invoke(PROJECT_CHANNELS.archive, projectIdInputSchema.parse(input))
      ),
      remove: async (input) => {
        await ipc.invoke(PROJECT_CHANNELS.remove, projectIdInputSchema.parse(input));
      }
    }
  };
}
```

Expose exactly one frozen object in `src/preload/index.ts`:

```ts
contextBridge.exposeInMainWorld("myNotebook", Object.freeze(createDesktopApi(ipcRenderer)));
```

- [ ] **Step 5: Verify contract and build**

Run:

```powershell
npm run test -- src/preload/create-desktop-api.test.ts
npm run typecheck
npm run build
```

Expected: PASS; renderer bundle contains no direct `electron`, `fs`, or `better-sqlite3` import.

- [ ] **Step 6: Commit the bridge**

```powershell
git add src/shared src/preload
git commit -m "feat: add validated desktop IPC contract"
```

### Task 3: SQLite Migration Runner

**Files:**
- Create: `src/main/db/database.ts`
- Create: `src/main/db/database.test.ts`
- Create: `src/main/db/migrations/001_initial.sql`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `openAppDatabase(databasePath: string, migrationsDir: string): AppDatabase`
- Produces: `AppDatabase.connection: Database.Database`
- Produces: `AppDatabase.close(): void`
- Consumes: `AppPaths.database`

- [ ] **Step 1: Write the numbered initial migration**

`001_initial.sql` must create both migration metadata and the project table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_projects_archived_updated
ON projects (archived, updated_at DESC);
```

- [ ] **Step 2: Write failing migration tests**

```ts
it("migrates an empty database exactly once", () => {
  const appDb = openAppDatabase(databaseFile, migrationsDir);
  expect(appDb.connection.prepare("SELECT version FROM schema_migrations").all()).toEqual([
    { version: 1 }
  ]);
  appDb.close();

  const reopened = openAppDatabase(databaseFile, migrationsDir);
  expect(reopened.connection.prepare("SELECT version FROM schema_migrations").all()).toHaveLength(1);
  reopened.close();
});
```

Add a second test with a malformed `002_broken.sql` and assert `openAppDatabase` throws while version 2 is not recorded.

- [ ] **Step 3: Verify migration tests fail**

Run:

```powershell
npx vitest run src/main/db/database.test.ts
```

Expected: FAIL because `openAppDatabase` is missing.

- [ ] **Step 4: Implement fail-fast migrations**

`openAppDatabase` must create the parent directory, open SQLite, apply `journal_mode = WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`, then run each `NNN_name.sql` file in numeric order inside a transaction. It must reject duplicate versions and a gap such as versions 1 then 3.

Core transaction shape:

```ts
const apply = connection.transaction((version: number, sql: string) => {
  connection.exec(sql);
  connection.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
});
```

Do not catch and continue after a migration failure. Close the database and rethrow so application startup fails before IPC handlers are registered.

- [ ] **Step 5: Compose database startup and shutdown**

In `src/main/index.ts`, create the app directories with `mkdir(..., { recursive: true })`, resolve the packaged migrations directory, open the database before creating the window, and close it in `before-quit`.

- [ ] **Step 6: Verify database behavior**

Run:

```powershell
npm run test -- src/main/db/database.test.ts
npm run typecheck
```

Expected: empty and reopened databases pass; malformed migration fails atomically.

- [ ] **Step 7: Commit database startup**

```powershell
git add src/main/db src/main/index.ts
git commit -m "feat: add fail-fast SQLite migrations"
```

### Task 4: Project Repository and Service

**Files:**
- Create: `src/main/projects/project-repository.ts`
- Create: `src/main/projects/project-repository.test.ts`
- Create: `src/main/projects/project-service.ts`
- Create: `src/main/projects/project-service.test.ts`

**Interfaces:**
- Produces: `ProjectRepository.list/create/rename/archive/remove`
- Produces: `ProjectService.list/create/rename/archive/remove`
- Consumes: `AppDatabase.connection`
- Consumes: shared project schemas from Task 2

- [ ] **Step 1: Write failing repository tests**

Cover this exact behavior:

```ts
it("creates, renames, archives, and removes a project", () => {
  const created = repository.create({ id: PROJECT_ID, name: "AI 研究" });
  expect(repository.list()).toEqual([created]);

  const renamed = repository.rename(PROJECT_ID, "RAG 研究");
  expect(renamed.name).toBe("RAG 研究");

  expect(repository.archive(PROJECT_ID).archived).toBe(true);
  expect(repository.list()).toEqual([]);
  expect(repository.list({ includeArchived: true })).toHaveLength(1);

  repository.remove(PROJECT_ID);
  expect(repository.list({ includeArchived: true })).toEqual([]);
});
```

Add tests that `rename`, `archive`, and `remove` throw `ProjectNotFoundError` for an unknown UUID.

- [ ] **Step 2: Verify repository tests fail**

Run:

```powershell
npx vitest run src/main/projects/project-repository.test.ts
```

Expected: FAIL because `ProjectRepository` does not exist.

- [ ] **Step 3: Implement the SQL-only repository**

Map SQLite rows through one private `toProjectDto` function. Every write must use a prepared parameterized statement. `rename` and `archive` must update `updated_at` with `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` and then return the updated row. Never interpolate names, IDs, or sort fields into SQL.

Use these concrete row mappings and methods:

```ts
type ProjectRow = {
  id: string;
  name: string;
  archived: 0 | 1;
  created_at: string;
  updated_at: string;
};

function toProjectDto(row: ProjectRow): ProjectDto {
  return projectDtoSchema.parse({
    id: row.id,
    name: row.name,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  list(options: { includeArchived?: boolean } = {}): ProjectDto[] {
    const sql = options.includeArchived
      ? "SELECT * FROM projects ORDER BY updated_at DESC"
      : "SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all() as ProjectRow[]).map(toProjectDto);
  }

  create(input: { id: string; name: string }): ProjectDto {
    this.db.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(input.id, input.name);
    return this.read(input.id);
  }

  rename(id: string, name: string): ProjectDto {
    const result = this.db.prepare(`
      UPDATE projects
      SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(name, id);
    if (result.changes === 0) throw new ProjectNotFoundError(id);
    return this.read(id);
  }

  archive(id: string): ProjectDto {
    const result = this.db.prepare(`
      UPDATE projects
      SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(id);
    if (result.changes === 0) throw new ProjectNotFoundError(id);
    return this.read(id);
  }

  remove(id: string): void {
    if (this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes === 0) {
      throw new ProjectNotFoundError(id);
    }
  }

  private read(id: string): ProjectDto {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!row) throw new ProjectNotFoundError(id);
    return toProjectDto(row);
  }
}
```

- [ ] **Step 4: Write failing service tests**

Inject an ID factory and test trimming plus schema validation:

```ts
const service = new ProjectService(repository, () => PROJECT_ID);

expect(service.create({ name: "  AI 研究  " }).name).toBe("AI 研究");
expect(() => service.create({ name: "   " })).toThrow();
expect(() => service.create({ name: "x".repeat(81) })).toThrow();
```

- [ ] **Step 5: Implement the minimal service**

```ts
export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly createId: () => string = randomUUID
  ) {}

  list(): ProjectDto[] {
    return projectDtoSchema.array().parse(this.repository.list());
  }

  create(input: CreateProjectInput): ProjectDto {
    const parsed = createProjectInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.create({ id: this.createId(), name: parsed.name }));
  }

  rename(input: RenameProjectInput): ProjectDto {
    const parsed = renameProjectInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.rename(parsed.id, parsed.name));
  }

  archive(input: ProjectIdInput): ProjectDto {
    const parsed = projectIdInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.archive(parsed.id));
  }

  remove(input: ProjectIdInput): void {
    const parsed = projectIdInputSchema.parse(input);
    this.repository.remove(parsed.id);
  }
}
```

Do not add a speculative generic CRUD base class.

- [ ] **Step 6: Verify repository and service**

Run:

```powershell
npm run test -- src/main/projects
npm run typecheck
```

Expected: all project tests pass and no SQL accepts unvalidated renderer input.

- [ ] **Step 7: Commit project behavior**

```powershell
git add src/main/projects
git commit -m "feat: add local project management"
```

### Task 5: Main-Process Project IPC Handlers

**Files:**
- Create: `src/main/ipc/register-project-handlers.ts`
- Create: `src/main/ipc/register-project-handlers.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `registerProjectHandlers(ipcMain, projectService): () => void`
- Consumes: `PROJECT_CHANNELS`, shared Zod schemas, `ProjectService`

- [ ] **Step 1: Write a failing handler contract test**

Use a fake `IpcMainLike` that records handlers. Invoke each registered function with invalid input and assert Zod rejects it before the service is called. Invoke `create` with `{ name: "研究" }` and assert the service result is returned.

```ts
expect([...handlers.keys()].sort()).toEqual(Object.values(PROJECT_CHANNELS).sort());
await expect(handlers.get(PROJECT_CHANNELS.create)?.({}, { name: "" })).rejects.toThrow();
expect(service.create).not.toHaveBeenCalled();
```

- [ ] **Step 2: Verify the handler test fails**

Run:

```powershell
npx vitest run src/main/ipc/register-project-handlers.test.ts
```

Expected: FAIL because registration is missing.

- [ ] **Step 3: Implement explicit handlers and cleanup**

Register one handler per constant. Parse input at the handler boundary and parse output before returning. Return a cleanup function that calls `removeHandler` for every registered channel so tests and future window reloads cannot retain duplicate handlers.

```ts
import type { IpcMain } from "electron";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

export function registerProjectHandlers(ipc: IpcMainLike, service: ProjectService): () => void {
  ipc.handle(PROJECT_CHANNELS.list, () => projectDtoSchema.array().parse(service.list()));
  ipc.handle(PROJECT_CHANNELS.create, (_event, input) =>
    projectDtoSchema.parse(service.create(createProjectInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.rename, (_event, input) =>
    projectDtoSchema.parse(service.rename(renameProjectInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.archive, (_event, input) =>
    projectDtoSchema.parse(service.archive(projectIdInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.remove, (_event, input) => {
    service.remove(projectIdInputSchema.parse(input));
  });

  return () => {
    for (const channel of Object.values(PROJECT_CHANNELS)) ipc.removeHandler(channel);
  };
}
```

- [ ] **Step 4: Compose project services in the application root**

After migrations succeed in `src/main/index.ts`, instantiate exactly one `ProjectRepository`, one `ProjectService`, and register the handlers before showing the window. Call the returned cleanup function during shutdown.

- [ ] **Step 5: Verify the full non-UI project path**

Run:

```powershell
npm run test -- src/main/ipc src/main/projects src/preload
npm run typecheck
npm run build
```

Expected: validated calls travel from preload contract to service and SQLite; invalid calls stop at the boundary.

- [ ] **Step 6: Commit IPC composition**

```powershell
git add src/main/ipc src/main/index.ts
git commit -m "feat: connect project IPC to SQLite"
```

### Task 6: Foundation UI Design Approval Gate

**Files:**
- Create: `docs/ui/foundation/first-launch.png`
- Create: `docs/ui/foundation/empty-project.png`
- Create: `docs/ui/foundation/project-list.png`
- Create: `docs/ui/foundation/README.md`

**Interfaces:**
- Produces: approved visual contract for Task 7
- Consumes: the Electron concept selected during design and section 7 of the approved spec

- [ ] **Step 1: Generate three high-fidelity mockups before renderer implementation**

Use the image-generation workflow with the selected warm off-white/indigo Electron concept. Generate separate 16:10 Windows desktop images for:

1. First launch with language, theme, and “configure models later” action.
2. Empty project with left navigation, a clear empty state, and disabled ask composer.
3. Populated project list with create, rename, archive, delete confirmation, language toggle, and theme toggle.

Every prompt must require the exact text `MyNotebookLM`, `新建项目`, `研究项目`, `设置`, and `中文 | EN`, a complete application window without a browser bar, and no podcast or unsupported feature UI.

- [ ] **Step 2: Present the mockups and stop for explicit user approval**

Do not create or modify `App.tsx`, locale files, or product CSS while approval is pending. If the user requests a change, regenerate only the affected mockup and present it again.

- [ ] **Step 3: Save approved images and record the visual contract**

Copy the approved generated images into `docs/ui/foundation/`. In `README.md`, record:

```markdown
# Foundation UI Visual Contract

Approved screens: first launch, empty project, project list.
Layout: left project navigation, central workspace, settings in navigation footer.
Palette: warm off-white surfaces, charcoal text, restrained indigo accent.
Themes: light and dark use identical information hierarchy.
Implementation must be compared with these images using a real Windows screenshot.
```

- [ ] **Step 4: Commit approved mockups**

```powershell
git add docs/ui/foundation
git commit -m "docs: approve desktop foundation mockups"
```

### Task 7: Approved React Project Shell, i18n, and Themes

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/global.d.ts`
- Create: `src/renderer/src/i18n.ts`
- Create: `src/renderer/src/i18n.test.ts`
- Create: `src/renderer/src/locales/en.ts`
- Create: `src/renderer/src/locales/zh-CN.ts`
- Create: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/main.tsx`

**Interfaces:**
- Produces: usable project shell matching approved Task 6 images
- Consumes: `window.myNotebook: DesktopApi`
- Consumes: Task 5 project IPC behavior

- [ ] **Step 1: Write the failing locale-parity test**

Flatten nested locale keys and require exact parity:

```ts
it("keeps English and Chinese locale keys identical", () => {
  expect(flattenKeys(en)).toEqual(flattenKeys(zhCN));
});
```

The required keys are:

```ts
{
  app: { name, settings },
  project: { title, create, rename, archive, remove, emptyTitle, emptyBody, nameLabel },
  common: { cancel, confirm, language, theme, light, dark },
  error: { loadProjects, createProject, renameProject, archiveProject, removeProject }
}
```

- [ ] **Step 2: Verify locale test failure**

Run:

```powershell
npx vitest run src/renderer/src/i18n.test.ts
```

Expected: FAIL because locale modules are absent.

- [ ] **Step 3: Implement locale resources and persistence**

Initialize i18next with `zh-CN` and `en`, defaulting to persisted `localStorage["mynotebooklm.language"]` or `zh-CN`. Persist changes immediately. Theme selection uses `localStorage["mynotebooklm.theme"]` and sets `document.documentElement.dataset.theme` to `light` or `dark`.

```ts
const language = localStorage.getItem("mynotebooklm.language") === "en" ? "en" : "zh-CN";
await i18n.use(initReactI18next).init({
  lng: language,
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN }
  }
});

export async function changeLanguage(next: "zh-CN" | "en"): Promise<void> {
  localStorage.setItem("mynotebooklm.language", next);
  await i18n.changeLanguage(next);
}
```

- [ ] **Step 4: Declare the renderer API and implement the approved shell**

`global.d.ts` must declare:

```ts
declare global {
  interface Window {
    myNotebook: DesktopApi;
  }
}
export {};
```

`App.tsx` must:

- load projects once on mount;
- select the first project when none is selected;
- expose create, rename, archive, and delete confirmation flows;
- keep loading and mutation errors visible beside the affected control;
- show the approved empty-project state when no active projects exist;
- disable research actions that belong to later plans instead of presenting fake functionality;
- match the approved navigation width, type scale, spacing, colors, and window density.

Keep state local to `App` and focused child components extracted only when a component exceeds one clear responsibility. Do not add a global state library.

Use this state and refresh pattern so every mutation is followed by authoritative data from SQLite:

```tsx
const [projects, setProjects] = useState<ProjectDto[]>([]);
const [selectedId, setSelectedId] = useState<string>();
const [error, setError] = useState<string>();

const refreshProjects = useCallback(async () => {
  try {
    const next = await window.myNotebook.projects.list();
    setProjects(next);
    setSelectedId((current) =>
      current && next.some((project) => project.id === current) ? current : next[0]?.id
    );
    setError(undefined);
  } catch {
    setError(t("error.loadProjects"));
  }
}, [t]);

useEffect(() => {
  void refreshProjects();
}, [refreshProjects]);
```

Create, rename, archive, and remove handlers must await the typed bridge, call `refreshProjects()`, and translate the operation-specific error key on rejection.

- [ ] **Step 5: Verify renderer behavior and security**

Run:

```powershell
npm run test -- src/renderer/src/i18n.test.ts
npm run typecheck
npm run build
```

Expected: locale parity passes; build succeeds; renderer imports only shared types and calls `window.myNotebook`.

- [ ] **Step 6: Launch and compare against approved images**

Run:

```powershell
npm run dev
```

Capture real Windows screenshots of first launch, empty project, and populated project list. Present them beside the approved Task 6 images. Apply only the layout, spacing, typography, copy, color, and interaction corrections required to match the approved contract, then repeat the screenshot comparison.

- [ ] **Step 7: Commit the approved shell**

```powershell
git add src/renderer
git commit -m "feat: add bilingual project desktop shell"
```

### Task 8: NSIS Package and Installed-App Smoke Test

**Files:**
- Create: `electron-builder.yml`
- Create: `playwright.config.ts`
- Create: `e2e/desktop.spec.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `dist/MyNotebookLM-Setup-0.1.0.exe`
- Produces: installed-app smoke coverage
- Consumes: built main, preload, renderer, native SQLite module, and migration SQL

- [ ] **Step 1: Configure Windows x64 packaging**

Create `electron-builder.yml`:

```yaml
appId: com.wengaiqiqi.mynotebooklm
productName: MyNotebookLM
asar: true
asarUnpack:
  - "**/*.node"
files:
  - out/**
  - package.json
extraResources:
  - from: src/main/db/migrations
    to: migrations
win:
  target:
    - target: nsis
      arch: [x64]
  artifactName: "MyNotebookLM-Setup-${version}.${ext}"
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  deleteAppDataOnUninstall: false
```

Add `out/`, `dist/`, `test-results/`, `playwright-report/`, and local database files to `.gitignore`.

- [ ] **Step 2: Write the failing Electron smoke test**

Use Playwright's Electron launcher against `out/main/index.js` and a temporary `userData` path passed through `MYNOTEBOOKLM_USER_DATA_DIR` in test mode. The test must create a project through the visible UI, close Electron, relaunch with the same data directory, and assert the project remains visible.

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

async function launchWithUserData(userDataDir: string): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    args: [path.resolve("out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      MYNOTEBOOKLM_USER_DATA_DIR: userDataDir
    }
  });
  return { app, page: await app.firstWindow() };
}

test("persists a project across desktop restarts", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const first = await launchWithUserData(userDataDir);
  await first.page.getByRole("button", { name: "新建项目" }).click();
  await first.page.getByLabel("项目名称").fill("持久化测试");
  await first.page.getByRole("button", { name: "确认" }).click();
  await first.app.close();

  const second = await launchWithUserData(userDataDir);
  await expect(second.page.getByText("持久化测试")).toBeVisible();
  await second.app.close();
});
```

- [ ] **Step 3: Verify the smoke test fails before test-mode path injection**

Run:

```powershell
npm run build
npm run test:e2e
```

Expected: FAIL because the application does not yet honor the isolated E2E user-data directory or expose stable accessible labels.

- [ ] **Step 4: Implement deterministic E2E startup without weakening production**

Before `ready`, set Electron's user data path from `MYNOTEBOOKLM_USER_DATA_DIR` only when `NODE_ENV === "test"`. Add the accessible labels required by the approved UI. Do not add hidden production-only test endpoints or bypass IPC validation.

- [ ] **Step 5: Build and verify the installer**

Run:

```powershell
npm run test
npm run typecheck
npm run build
npm run test:e2e
npm run package:win
```

Expected:

- all unit and integration tests pass;
- Electron E2E persists the project across restart;
- `dist/MyNotebookLM-Setup-0.1.0.exe` exists;
- installer launches without a development runtime;
- Start menu and optional desktop shortcuts work;
- uninstall leaves the Electron user-data directory intact.

- [ ] **Step 6: Perform the clean-machine checklist**

On a Windows x64 environment without Node.js installed:

1. Install with the generated NSIS executable.
2. Start from the Start menu.
3. Switch Chinese to English and light to dark.
4. Create, rename, archive, and delete a project.
5. Close and reopen the application and verify remaining projects persist.
6. Install the same version over the existing installation and verify data remains.
7. Uninstall and verify application binaries and shortcuts are removed while user data remains.

Record the result in the task handoff; do not claim installer completion without this evidence.

- [ ] **Step 7: Commit packaging and smoke coverage**

```powershell
git add electron-builder.yml playwright.config.ts e2e package.json package-lock.json .gitignore src/main/index.ts src/renderer
git commit -m "build: package MyNotebookLM for Windows x64"
```

## Phase Completion Gate

Before writing the Model Connectivity implementation plan, verify all of the following:

```powershell
npm run test
npm run typecheck
npm run build
npm run test:e2e
npm run package:win
git status --short
```

Expected: every command succeeds, the installer exists, the working tree is clean, and the running UI has been visually approved against the saved foundation mockups.

The next plan may consume only these stable outputs:

- secure `DesktopApi` preload pattern;
- migrated `AppDatabase` composition;
- project IDs and project service;
- approved renderer shell, locale resources, and theme variables;
- repeatable Windows x64 packaging pipeline.
