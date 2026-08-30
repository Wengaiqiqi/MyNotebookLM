import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createTaskUpdateFanout, subscribeWindowToTaskUpdates } from "./task-updates";

type Callback = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const callbacks = new Map<string, Callback>();
  // Default prepare chain keeps startup recovery from exploding in composition tests;
  // individual tests override implementations for their specific SQL shapes.
  const connection = { prepare: vi.fn((_sql: string): { run?: (...args: unknown[]) => unknown; get?: (...args: unknown[]) => unknown; all?: (...args: unknown[]) => unknown } => ({ run: vi.fn(() => ({ changes: 0 })), get: vi.fn(() => undefined), all: vi.fn(() => []) })), transaction: vi.fn((fn: () => unknown) => () => fn()) };
  const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
  let vectorService: Record<string, (...args: any[]) => any> | undefined;
  let databasePending: Promise<void> = Promise.resolve();
  let databaseError: Error | undefined;
  let recoveryTask: { id: string; projectId: string; sourceId: string } | undefined;
  const close = vi.fn(() => events.push("close"));
  const cleanupProject = vi.fn(() => events.push("project-cleanup"));
  const cleanupModel = vi.fn(() => events.push("model-cleanup"));
  const cleanupTitleOverlay = vi.fn(() => events.push("title-overlay-cleanup"));
  const createModelProvider = vi.fn(() => ({ embed: vi.fn(async () => [[1, 2, 3, 4]]) }));

  return {
    events,
    callbacks,
    getVectorService: () => vectorService,
    connection,
    setDatabasePending: (pending: Promise<void>) => { databasePending = pending; },
    setDatabaseError: (error?: Error) => { databaseError = error; },
    setRecoveryTask: (task?: { id: string; projectId: string; sourceId: string }) => { recoveryTask = task; },
    ipcMain,
    close,
    cleanupProject,
    cleanupModel,
    cleanupTitleOverlay,
    createModelProvider,
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
    SpaceRepository: vi.fn(function (this: Record<string, unknown>, db: unknown) { events.push("space-repository"); this.db = db; this.active = vi.fn(() => ({ id: "old", projectId: "project-1", dimension: 2 })); this.get = vi.fn(() => ({ id: "old", projectId: "project-1", dimension: 2 })); this.recoverInterrupted = vi.fn(() => events.push("space-recovery")); }),
    SpaceService: vi.fn(function (this: Record<string, any>, repository: unknown, options: any, backup: unknown) { events.push("space-service"); this.repository = repository; this.options = { ...options, rebuild: vi.fn(options.rebuild) }; this.backup = backup; this.rebuild = vi.fn((input: unknown) => this.options.rebuild(input)); this.optimize = vi.fn((input: unknown) => this.options.optimize(input)); this.cancel = vi.fn(() => false); this.recoverInterrupted = vi.fn(() => events.push("space-recovery")); }),
    registerVectorHandlers: vi.fn((_ipc: unknown, service: Record<string, (...args: any[]) => any>) => { vectorService = service; return vi.fn(); }),
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
  shell: { openPath: vi.fn(async () => ""), openExternal: vi.fn(async () => undefined) },
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
vi.mock("./models/model-service", () => ({ ModelService: mocks.ModelService, createModelProvider: mocks.createModelProvider }));
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
vi.mock("./ipc/register-vector-handlers", () => ({ registerVectorHandlers: mocks.registerVectorHandlers }));
vi.mock("./vector/lance-store", () => ({ LanceStore: { open: vi.fn(async () => ({ upsert: vi.fn(), count: vi.fn(), rows: vi.fn(async () => []), vectorSearch: vi.fn(), deleteRevision: vi.fn() })), closeAll: vi.fn(async () => undefined) } }));
vi.mock("./vector/indexing-service", () => ({ IndexingService: mocks.IndexingService, canonicalEmbeddingFingerprint: vi.fn(() => "canonical") }));
vi.mock("./vector/space-repository", () => ({ SpaceRepository: mocks.SpaceRepository }));
vi.mock("./vector/space-service", () => ({ SpaceService: mocks.SpaceService }));
vi.mock("./vector/local-model-manager", () => ({
  createLocalModelManager: vi.fn(() => ({ ensureReady: vi.fn() })),
  managedActiveDirectory: vi.fn((root: string, manifest: { modelId: string; revision: string }) => root + "/" + manifest.modelId.replaceAll("/", "__") + "-" + manifest.revision),
  managedStagingDirectory: vi.fn((root: string, manifest: { modelId: string; revision: string }) => root + "/" + manifest.modelId.replaceAll("/", "__") + "-" + manifest.revision + ".partial")
}));
vi.mock("./vector/local-embedding-provider", () => ({
  createTransformersEmbeddingRuntime: vi.fn(() => vi.fn()),
  isAuthoritativeLocalCapability: vi.fn((value: unknown, expected: unknown) => JSON.stringify(value) === JSON.stringify(expected)),
  LocalEmbeddingProvider: vi.fn(function (this: Record<string, unknown>, manager: unknown, runtime: unknown) {
    this.manager = manager; this.runtime = runtime;
    this.describe = vi.fn(() => ({ provider: "local", modelId: "Xenova/multilingual-e5-small", modelRevision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", dimension: 384, distance: "cosine", pooling: "mean", preprocessVersion: "e5-query-passage-v1", chunkingVersion: "persisted" }));
    this.embedBatch = vi.fn(async () => [Array(384).fill(1)]);
  })
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

  it("cancels a production optimize task exactly once and leaves it cancelled", async () => {
    const optimize = vi.fn((_space: unknown, signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "TASK_CANCELLED" })), { once: true })));
    const lance = (await import("./vector/lance-store")).LanceStore as any;
    lance.open.mockResolvedValueOnce({ optimize });
    await import("./index");
    await vi.waitFor(() => expect(mocks.SpaceService).toHaveBeenCalled());
    const spaceService = mocks.SpaceService.mock.instances[0] as any;
    let controller: AbortController | undefined;
    spaceService.optimize = vi.fn(async (input: Record<string, unknown>) => { controller = new AbortController(); return spaceService.options.optimize({ ...input, signal: controller.signal }); });
    spaceService.cancel = vi.fn(() => { controller?.abort(); return Boolean(controller); });
    const tasks = mocks.TaskService.mock.instances[0] as any;
    let state = "queued";
    const dto = () => ({ id: "task-1", projectId: "project-1", sourceId: null, kind: "optimize", state, stage: "indexing", progress: 0, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" });
    tasks.createTask.mockImplementation(() => dto());
    tasks.getById = vi.fn(() => dto());
    tasks.start.mockImplementation(() => { state = "running"; return dto(); });
    tasks.cancel.mockImplementation(() => { if (state === "cancelled") throw new Error("stale state"); state = "cancelled"; return dto(); });
    const service = mocks.getVectorService() as { optimize(input: unknown): Promise<any>; cancelTask(input: unknown): Promise<any> };
    await expect(service.optimize({ projectId: "project-1", spaceId: "old" })).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(optimize).toHaveBeenCalledOnce());
    await expect(service.cancelTask({ projectId: "project-1", taskId: "task-1" })).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(state).toBe("cancelled"));
    expect(tasks.cancel).toHaveBeenCalledOnce();
    expect(tasks.fail).not.toHaveBeenCalled();
  });

  it("persists only the stable internal error key for optimize failures", async () => {
    const secret = "provider-secret-should-not-persist";
    const optimize = vi.fn(async () => { throw new Error(secret); });
    const lance = (await import("./vector/lance-store")).LanceStore as any;
    lance.open.mockResolvedValueOnce({ optimize });
    await import("./index");
    await vi.waitFor(() => expect(mocks.SpaceService).toHaveBeenCalled());
    const options = mocks.SpaceService.mock.calls[0]?.[1] as { optimize: (input: unknown) => Promise<void> };
    await expect(options.optimize({ taskId: "task-1", space: { id: "s", dimension: 2 } })).rejects.toThrow(secret);
    expect((mocks.TaskService.mock.instances[0] as any).fail).toHaveBeenCalledWith("task-1", { code: "INTERNAL", messageKey: "errors.internal", recoverable: false });
    expect(JSON.stringify((mocks.TaskService.mock.instances[0] as any).fail.mock.calls)).not.toContain(secret);
  });

  it.each(["openai", "openai-compatible", "gemini", "ollama"])("starts %s migration using modelId as the frozen revision and probed dimension", async (provider) => {
    const profile = { id: "profile-1", provider, capability: "embedding", enabled: true, modelId: "embedding-model", baseUrl: "https://api.example.test" };
    mocks.connection.prepare.mockImplementation((sql: string) => ({
      get: vi.fn(() => sql.includes("model_profiles") ? profile : sql.includes("embedding_spaces") ? { id: "old", projectId: "project-1", dimension: 2 } : undefined),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 1 }))
    }));
    mocks.SettingsRepository.mockImplementation(function (this: Record<string, unknown>, db: unknown) {
      this.db = db;
      this.getProfile = vi.fn(() => profile);
      this.listProfiles = vi.fn(() => [profile]);
    });
    mocks.CredentialStore.mockImplementation(function (this: Record<string, unknown>, db: unknown, protector: unknown) {
      this.db = db;
      this.protector = protector;
      this.withSecret = vi.fn(async (_id: string, _binding: unknown, invoke: (key: string) => Promise<unknown>) => invoke("secret"));
    });
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    const service = mocks.getVectorService() as { startMigration: (input: unknown) => Promise<any> };
    await expect(service.startMigration({ projectId: "project-1", profileId: "profile-1" })).resolves.toMatchObject({ ok: true });
    const rebuild = (mocks.SpaceService.mock.instances[0] as any).rebuild;
    expect(rebuild).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({ provider, modelId: profile.modelId, modelRevision: profile.modelId, dimension: 4 }) }));
  });

  it("rebuilds and activates the latest parsed revision when an import failed before the first Space existed", async () => {
    const profile = { id: "profile-1", provider: "openai", capability: "embedding", enabled: true, modelId: "embedding-model", baseUrl: "https://api.example.test" };
    const revision = { id: "pending-revision" };
    const runs: Array<[string, unknown[]]> = [];
    mocks.connection.prepare.mockImplementation((sql: string) => ({
      get: vi.fn(() => sql.includes("model_profiles") ? profile : sql.includes("embedding_spaces") ? undefined : undefined),
      all: vi.fn(() => sql.includes("source_revisions") ? [revision] : []),
      run: vi.fn((...args: unknown[]) => { runs.push([sql, args]); return { changes: 1 }; })
    }));
    mocks.SettingsRepository.mockImplementation(function (this: Record<string, unknown>) { this.getProfile = vi.fn(() => profile); this.listProfiles = vi.fn(() => [profile]); });
    mocks.CredentialStore.mockImplementation(function (this: Record<string, unknown>) { this.withSecret = vi.fn(async (_id: string, _binding: unknown, invoke: (key: string) => Promise<unknown>) => invoke("secret")); });
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

    const service = mocks.getVectorService() as { startMigration: (input: unknown) => Promise<any> };
    await expect(service.startMigration({ projectId: "project-1", profileId: "profile-1" })).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect((mocks.IndexingService.mock.instances[0] as any).rebuild).toHaveBeenCalledWith(expect.objectContaining({ revisionId: revision.id })));
    await vi.waitFor(() => expect(runs.some(([sql, args]) => sql.includes("UPDATE source_revisions") && args.includes(revision.id))).toBe(true));
  });

  it("fails closed when a cloud migration profile has an invalid modelId", async () => {
    const profile = { id: "profile-1", provider: "openai", capability: "embedding", enabled: true, modelId: " ", baseUrl: "https://api.example.test" };
    mocks.connection.prepare.mockImplementation((sql: string) => ({
      get: vi.fn(() => sql.includes("model_profiles") ? profile : sql.includes("embedding_spaces") ? { id: "old", projectId: "project-1", dimension: 2 } : undefined),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 1 }))
    }));
    mocks.SettingsRepository.mockImplementation(function (this: Record<string, unknown>) { this.getProfile = vi.fn(() => profile); this.listProfiles = vi.fn(() => [profile]); });
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    const service = mocks.getVectorService() as { startMigration: (input: unknown) => Promise<any> };
    await expect(service.startMigration({ projectId: "project-1", profileId: "profile-1" })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect((mocks.SpaceService.mock.instances[0] as any).options.rebuild).not.toHaveBeenCalled();
  });

  it("rejects a local resolver row with missing persisted fingerprint before returning the provider", async () => {
    mocks.connection.prepare.mockImplementation(() => ({
      get: vi.fn(() => ({ provider: "local", model_id: "Xenova/multilingual-e5-small", model_revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", dimension: 384, distance: "cosine", pooling: "mean", preprocess_version: "e5-query-passage-v1", chunking_version: "persisted", project_id: "project-1" })),
      all: vi.fn(() => []), run: vi.fn(() => ({ changes: 1 }))
    }));
    await import("./index");
    await vi.waitFor(() => expect(mocks.IndexingService).toHaveBeenCalled());
    const resolve = mocks.IndexingService.mock.calls[0]?.[1] as (revisionId: string, space: { id: string; dimension: number }) => Promise<unknown>;
    await expect(resolve("revision-1", { id: "space-1", dimension: 384 })).rejects.toMatchObject({ code: "EMBEDDING_PROFILE_MISMATCH" });
  });

  it("rejects retrieval before embedding when the persisted cloud capability mismatches", async () => {
    const profile = { id: "profile-1", provider: "openai", capability: "embedding", enabled: true, modelId: "text-embedding-3-small", baseUrl: "https://api.example.test" };
    const embed = vi.fn(async () => [[1, 0, 0, 0]]);
    mocks.createModelProvider.mockImplementation(() => ({ embed }));
    mocks.connection.prepare.mockImplementation((sql: string) => ({
      get: vi.fn(() => sql.includes("model_profiles") ? profile : sql.includes("embedding_spaces") ? { id: "space-1", project_id: "project-1", provider: "openai", model_id: profile.modelId, model_revision: "wrong-revision", dimension: 4 } : undefined),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 1 }))
    }));
    mocks.SettingsRepository.mockImplementation(function (this: Record<string, unknown>) {
      this.getProfile = vi.fn(() => profile);
      this.listProfiles = vi.fn(() => [profile]);
    });
    mocks.CredentialStore.mockImplementation(function (this: Record<string, unknown>) {
      this.withSecret = vi.fn(async (_id: string, _binding: unknown, invoke: (key: string) => Promise<unknown>) => invoke("secret"));
    });
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
    const service = mocks.getVectorService() as { search: (input: unknown) => Promise<any> };
    await expect(service.search({ projectId: "project-1", query: "hello", limit: 1 })).resolves.toMatchObject({ ok: false });
    expect(embed).not.toHaveBeenCalled();
  });
});
