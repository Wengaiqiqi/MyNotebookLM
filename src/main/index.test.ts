import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createTaskUpdateFanout, subscribeWindowToTaskUpdates } from "./task-updates";

type Callback = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const callbacks = new Map<string, Callback>();
  const connection = { prepare: vi.fn() };
  const ipcMain = {};
  let databasePending: Promise<void> = Promise.resolve();
  let databaseError: Error | undefined;
  let recoveryTask: { id: string; projectId: string; sourceId: string } | undefined;
  const close = vi.fn(() => events.push("close"));
  const cleanupProject = vi.fn(() => events.push("project-cleanup"));
  const cleanupModel = vi.fn(() => events.push("model-cleanup"));
  const cleanupTitleOverlay = vi.fn(() => events.push("title-overlay-cleanup"));

  return {
    events,
    callbacks,
    connection,
    setDatabasePending: (pending: Promise<void>) => { databasePending = pending; },
    setDatabaseError: (error?: Error) => { databaseError = error; },
    setRecoveryTask: (task?: { id: string; projectId: string; sourceId: string }) => { recoveryTask = task; },
    ipcMain,
    close,
    cleanupProject,
    cleanupModel,
    cleanupTitleOverlay,
    IndexingService: vi.fn(function (this: Record<string, unknown>, _db: unknown, provider: unknown) { this.provider = provider; this.index = vi.fn(async () => undefined); this.rebuild = vi.fn(async () => undefined); }),
    TaskService: vi.fn(function (this: Record<string, unknown>) {
      this.createTask = vi.fn(() => ({ id: "task-1" }));
      this.start = vi.fn(() => ({ id: "task-1" }));
      this.advance = vi.fn(() => ({ id: "task-1" }));
      this.complete = vi.fn(() => ({ id: "task-1" }));
      this.fail = vi.fn(() => ({ id: "task-1" }));
      this.cancel = vi.fn(() => ({ id: "task-1" }));
      this.recoverAndContinueEmbedding = vi.fn(async (continueTask: (task: { id: string; projectId: string; sourceId: string }) => Promise<void>) => {
        if (recoveryTask) {
          try { await continueTask(recoveryTask); } catch { /* startup recovery reports the task failure */ }
        }
        return recoveryTask ? [recoveryTask] : [];
      });
    }),
    SpaceRepository: vi.fn(function (this: Record<string, unknown>, db: unknown) { events.push("space-repository"); this.db = db; this.recoverInterrupted = vi.fn(() => events.push("space-recovery")); }),
    SpaceService: vi.fn(function (this: Record<string, unknown>, repository: unknown, options: unknown, backup: unknown) { events.push("space-service"); this.repository = repository; this.options = options; this.backup = backup; this.recoverInterrupted = vi.fn(() => events.push("space-recovery")); }),
    app: {
      isPackaged: false,
      whenReady: vi.fn(() => Promise.resolve()),
      getPath: vi.fn(() => "C:\\data"),
      setPath: vi.fn(),
      getAppPath: vi.fn(() => "C:\\app"),
      on: vi.fn((event: string, callback: Callback) => {
        callbacks.set(event, callback);
      }),
      quit: vi.fn()
    },
    getAllWindows: vi.fn(() => []),
    setApplicationMenu: vi.fn(() => events.push("menu")),
    mkdir: vi.fn(() => Promise.resolve()),
    getAppPaths: vi.fn(() => ({
      root: "C:\\data\\MyNotebookLM",
      database: "C:\\data\\MyNotebookLM\\db\\app.sqlite",
      files: "C:\\data\\MyNotebookLM\\files",
      models: "C:\\data\\MyNotebookLM\\models\\huggingface",
      logs: "C:\\data\\MyNotebookLM\\logs"
    })),
    openAppDatabaseAsync: vi.fn(async () => {
      events.push("database");
      await databasePending;
      if (databaseError) throw databaseError;
      events.push("database-ready");
      return { connection, close };
    }),
    ProjectRepository: vi.fn(function (this: Record<string, unknown>, db: unknown) {
      events.push("repository");
      this.db = db;
    }),
    ProjectService: vi.fn(function (this: Record<string, unknown>, repository: unknown) {
      events.push("service");
      this.repository = repository;
    }),
    SettingsRepository: vi.fn(function (this: Record<string, unknown>, db: unknown) {
      events.push("settings-repository");
      this.db = db;
    }),
    SafeStorageAdapter: vi.fn(function (this: Record<string, unknown>) {
      events.push("protector");
    }),
    CredentialStore: vi.fn(function (this: Record<string, unknown>, db: unknown, protector: unknown) {
      events.push("credentials");
      this.db = db;
      this.protector = protector;
    }),
    ModelService: vi.fn(function (
      this: Record<string, unknown>,
      settings: unknown,
      credentials: unknown
    ) {
      events.push("model-service");
      this.settings = settings;
      this.credentials = credentials;
    }),
    registerProjectHandlers: vi.fn(() => {
      events.push("project-handlers");
      return cleanupProject;
    }),
    registerModelHandlers: vi.fn(() => {
      events.push("model-handlers");
      return cleanupModel;
    }),
    registerTitleOverlayHandler: vi.fn(() => {
      events.push("title-overlay-handlers");
      return cleanupTitleOverlay;
    }),
    createMainWindow: vi.fn(() => {
      events.push("window");
    })
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  Menu: { setApplicationMenu: mocks.setApplicationMenu },
  ipcMain: mocks.ipcMain
}));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir }));
vi.mock("./platform/paths", () => ({ getAppPaths: mocks.getAppPaths }));
vi.mock("./db/database", () => ({ openAppDatabaseAsync: mocks.openAppDatabaseAsync }));
vi.mock("./tasks/task-service", () => ({ TaskService: mocks.TaskService }));
vi.mock("./projects/project-repository", () => ({
  ProjectRepository: mocks.ProjectRepository
}));
vi.mock("./projects/project-service", () => ({ ProjectService: mocks.ProjectService }));
vi.mock("./settings/settings-repository", () => ({
  SettingsRepository: mocks.SettingsRepository
}));
vi.mock("./credentials/safe-storage-adapter", () => ({
  SafeStorageAdapter: mocks.SafeStorageAdapter
}));
vi.mock("./credentials/credential-store", () => ({ CredentialStore: mocks.CredentialStore }));
vi.mock("./models/model-service", () => ({ ModelService: mocks.ModelService }));
vi.mock("./ipc/register-project-handlers", () => ({
  registerProjectHandlers: mocks.registerProjectHandlers
}));
vi.mock("./ipc/register-model-handlers", () => ({
  registerModelHandlers: mocks.registerModelHandlers
}));
vi.mock("./window", () => ({
  createMainWindow: mocks.createMainWindow,
  registerTitleOverlayHandler: mocks.registerTitleOverlayHandler
}));
vi.mock("./vector/lance-store", () => ({ LanceStore: { open: vi.fn(async () => ({ upsert: vi.fn(), count: vi.fn(), rows: vi.fn(async () => []), vectorSearch: vi.fn(), deleteRevision: vi.fn() })), closeAll: vi.fn(async () => undefined) } }));
vi.mock("./vector/indexing-service", () => ({ IndexingService: mocks.IndexingService }));
vi.mock("./vector/space-repository", () => ({ SpaceRepository: mocks.SpaceRepository }));
vi.mock("./vector/space-service", () => ({ SpaceService: mocks.SpaceService }));
vi.mock("./vector/local-model-manager", () => ({
  createLocalModelManager: vi.fn(() => ({ ensureReady: vi.fn() })),
  managedActiveDirectory: vi.fn((root: string, manifest: { modelId: string; revision: string }) => root + "/" + manifest.modelId.replaceAll("/", "__") + "-" + manifest.revision),
  managedStagingDirectory: vi.fn((root: string, manifest: { modelId: string; revision: string }) => root + "/" + manifest.modelId.replaceAll("/", "__") + "-" + manifest.revision + ".partial")
}));
vi.mock("./vector/local-embedding-provider", () => ({
  createTransformersEmbeddingRuntime: vi.fn(() => vi.fn()),
  LocalEmbeddingProvider: vi.fn(function (this: Record<string, unknown>, manager: unknown, runtime: unknown) { this.manager = manager; this.runtime = runtime; this.embedBatch = vi.fn(); })
}));

describe("main application composition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.callbacks.clear();
    mocks.setDatabasePending(Promise.resolve());
    mocks.setDatabaseError();
    mocks.setRecoveryTask();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the requested isolated user data directory only in test mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MYNOTEBOOKLM_USER_DATA_DIR", "C:\\e2e-user-data");

    await import("./index");

    expect(mocks.app.setPath).toHaveBeenCalledWith("userData", "C:\\e2e-user-data");
    expect(mocks.app.setPath.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.app.whenReady.mock.invocationCallOrder[0]!
    );
  });

  it("ignores the test user data override in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MYNOTEBOOKLM_USER_DATA_DIR", "C:\\must-not-use");

    await import("./index");

    expect(mocks.app.setPath).not.toHaveBeenCalled();
  });

  it("removes the application menu before creating any window", async () => {
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

    expect(mocks.events).toEqual([
      "database",
      "database-ready",
      "repository",
      "service",
      "settings-repository",
      "protector",
      "credentials",
      "model-service",
      "space-repository",
      "space-service",
      "space-recovery",
      "project-handlers",
      "model-handlers",
      "title-overlay-handlers",
      "menu",
      "window"
    ]);
    expect(mocks.setApplicationMenu).toHaveBeenCalledOnce();
    expect(mocks.setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it("connects one project service after migration and cleans it up on shutdown", async () => {
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

    expect(mocks.openAppDatabaseAsync).toHaveBeenCalledWith(
      "C:\\data\\MyNotebookLM\\db\\app.sqlite",
      path.resolve(__dirname, "../../src/main/db/migrations")
    );
    expect(mocks.ProjectRepository).toHaveBeenCalledOnce();
    expect(mocks.ProjectRepository).toHaveBeenCalledWith(mocks.connection);
    expect(mocks.ProjectService).toHaveBeenCalledOnce();
    expect(mocks.ProjectService).toHaveBeenCalledWith(mocks.ProjectRepository.mock.instances[0]);
    expect(mocks.SafeStorageAdapter).toHaveBeenCalledOnce();
    expect(mocks.CredentialStore).toHaveBeenCalledOnce();
    expect(mocks.CredentialStore).toHaveBeenCalledWith(
      mocks.connection,
      mocks.SafeStorageAdapter.mock.instances[0]
    );
    expect(mocks.SettingsRepository).toHaveBeenCalledOnce();
    expect(mocks.SettingsRepository).toHaveBeenCalledWith(mocks.connection);
    expect(mocks.ModelService).toHaveBeenCalledOnce();
    expect(mocks.ModelService).toHaveBeenCalledWith(
      mocks.SettingsRepository.mock.instances[0],
      mocks.CredentialStore.mock.instances[0]
    );
    expect(mocks.registerProjectHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerProjectHandlers).toHaveBeenCalledWith(
      mocks.ipcMain,
      mocks.ProjectService.mock.instances[0]
    );
    expect(mocks.registerModelHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerModelHandlers).toHaveBeenCalledWith(
      mocks.ipcMain,
      mocks.ModelService.mock.instances[0]
    );
    expect(mocks.registerTitleOverlayHandler).toHaveBeenCalledExactlyOnceWith(mocks.ipcMain);

    mocks.callbacks.get("activate")?.();
    expect(mocks.createMainWindow).toHaveBeenCalledTimes(2);
    expect(mocks.ProjectRepository).toHaveBeenCalledOnce();
    expect(mocks.ProjectService).toHaveBeenCalledOnce();

    await mocks.callbacks.get("before-quit")?.();
    expect(mocks.events.slice(-4)).toEqual([
      "project-cleanup",
      "model-cleanup",
      "title-overlay-cleanup",
      "close"
    ]);

    mocks.callbacks.get("window-all-closed")?.();
    expect(mocks.app.quit).toHaveBeenCalledTimes(2);
  });

  it("constructs the production local embedding chain under the app model path", async () => {
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    const { createLocalModelManager } = await import("./vector/local-model-manager");
    const { createTransformersEmbeddingRuntime, LocalEmbeddingProvider } = await import("./vector/local-embedding-provider");
    expect(createTransformersEmbeddingRuntime).toHaveBeenNthCalledWith(
      1,
      "C:\\data\\MyNotebookLM\\models\\huggingface",
      "C:\\data\\MyNotebookLM\\models\\huggingface/Xenova__multilingual-e5-small-761b726dd34fb83930e26aab4e9ac3899aa1fa78"
    );
    expect(createTransformersEmbeddingRuntime).toHaveBeenNthCalledWith(
      2,
      "C:\\data\\MyNotebookLM\\models\\huggingface",
      "C:\\data\\MyNotebookLM\\models\\huggingface/Xenova__multilingual-e5-small-761b726dd34fb83930e26aab4e9ac3899aa1fa78.partial"
    );
    expect(createLocalModelManager).toHaveBeenCalledWith("C:\\data\\MyNotebookLM\\models\\huggingface", expect.any(Function), expect.any(Function), expect.any(Function));
    expect(LocalEmbeddingProvider).toHaveBeenCalledOnce();
    expect(mocks.IndexingService).toHaveBeenCalledWith(mocks.connection, expect.any(Function), expect.anything());
  });

  it("fans out task updates only to live windows subscribed to the project", async () => {
    const send = vi.fn();
    const on = vi.fn();
    const removeListener = vi.fn();
    const task = { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", sourceId: null, kind: "ingest", state: "running", stage: "parsing", progress: 10, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as const;
    const live = { webContents: { isDestroyed: () => false, send, on, removeListener } };
    const dead = { webContents: { isDestroyed: () => true, send, on, removeListener } };
    createTaskUpdateFanout([live, dead])(task);
    expect(send).toHaveBeenCalledWith("tasks:v1:update:" + task.projectId, task);
    const cleanup = subscribeWindowToTaskUpdates(live, vi.fn());
    expect(on).toHaveBeenCalledWith("destroyed", expect.any(Function));
    cleanup();
    expect(removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
  });

  it("recovers interrupted Spaces during startup and constructs the lifecycle service", async () => {
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    expect(mocks.SpaceRepository).toHaveBeenCalledWith(mocks.connection, undefined, undefined, expect.any(Object));
    expect(mocks.SpaceService).toHaveBeenCalledWith(mocks.SpaceRepository.mock.instances[0], expect.any(Object), expect.any(Function));
    expect((mocks.SpaceService.mock.instances[0] as { recoverInterrupted: ReturnType<typeof vi.fn> }).recoverInterrupted).toHaveBeenCalledOnce();
    expect(mocks.events).toContain("space-recovery");
  });

  it("resumes awaiting-embedding revisions when the source has no current revision", async () => {
    mocks.setRecoveryTask({ id: "task-1", projectId: "project-1", sourceId: "source-1" });
    mocks.connection.prepare.mockImplementation((sql: string) => ({
      get: vi.fn(() => sql.includes("embedding_spaces") ? { id: "space-1", dimension: 2 } : sql.includes("source_revisions") ? { id: "revision-awaiting" } : undefined),
      all: vi.fn(() => [{ id: "revision-awaiting" }])
    }));

    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

    const indexing = mocks.IndexingService.mock.instances[0] as { index: ReturnType<typeof vi.fn> };
    expect(indexing.index).toHaveBeenCalledWith({
      taskId: "task-1",
      revisionId: "revision-awaiting",
      space: { id: "space-1", dimension: 2 }
    });
  });

  it("waits for async database migration before constructing startup dependencies", async () => {
    let release!: () => void;
    mocks.setDatabasePending(new Promise<void>((resolve) => { release = resolve; }));
    await import("./index");
    await vi.waitFor(() => expect(mocks.openAppDatabaseAsync).toHaveBeenCalledOnce());
    expect(mocks.events).toEqual(["database"]);
    expect(mocks.ProjectRepository).not.toHaveBeenCalled();
    expect(mocks.SpaceService).not.toHaveBeenCalled();
    expect(mocks.createMainWindow).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    expect(mocks.events.indexOf("database-ready")).toBeLessThan(mocks.events.indexOf("repository"));
  });

  it("stops startup when database backup or migration fails", async () => {
    mocks.setDatabaseError(new Error("migration failed"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await import("./index");
      await vi.waitFor(() => expect(mocks.openAppDatabaseAsync).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.ProjectRepository).not.toHaveBeenCalled();
      expect(mocks.SpaceRepository).not.toHaveBeenCalled();
      expect(mocks.SpaceService).not.toHaveBeenCalled();
      expect(mocks.createMainWindow).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
  it("passes optimize cancellation through the production operation", async () => {
    await import("./index");
    await vi.waitFor(() => expect(mocks.SpaceService).toHaveBeenCalled());
    const options = mocks.SpaceService.mock.calls[0]?.[1] as { optimize: (input: unknown) => Promise<void> };
    const controller = new AbortController();
    await expect(options.optimize({ taskId: "task-1", space: { id: "s", dimension: 2 }, signal: controller.signal })).rejects.toBeDefined();
  });
});
