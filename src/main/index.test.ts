import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

type Callback = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const callbacks = new Map<string, Callback>();
  const connection = {};
  const ipcMain = {};
  const close = vi.fn(() => events.push("close"));
  const cleanup = vi.fn(() => events.push("cleanup"));

  return {
    events,
    callbacks,
    connection,
    ipcMain,
    close,
    cleanup,
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
      logs: "C:\\data\\MyNotebookLM\\logs"
    })),
    openAppDatabase: vi.fn(() => {
      events.push("database");
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
    SafeStorageAdapter: vi.fn(function (this: Record<string, unknown>) {
      events.push("protector");
    }),
    CredentialStore: vi.fn(function (this: Record<string, unknown>, db: unknown, protector: unknown) {
      events.push("credentials");
      this.db = db;
      this.protector = protector;
    }),
    registerProjectHandlers: vi.fn(() => {
      events.push("handlers");
      return cleanup;
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
vi.mock("./db/database", () => ({ openAppDatabase: mocks.openAppDatabase }));
vi.mock("./projects/project-repository", () => ({
  ProjectRepository: mocks.ProjectRepository
}));
vi.mock("./projects/project-service", () => ({ ProjectService: mocks.ProjectService }));
vi.mock("./credentials/safe-storage-adapter", () => ({
  SafeStorageAdapter: mocks.SafeStorageAdapter
}));
vi.mock("./credentials/credential-store", () => ({ CredentialStore: mocks.CredentialStore }));
vi.mock("./ipc/register-project-handlers", () => ({
  registerProjectHandlers: mocks.registerProjectHandlers
}));
vi.mock("./window", () => ({ createMainWindow: mocks.createMainWindow }));

describe("main application composition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.callbacks.clear();
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
      "repository",
      "service",
      "protector",
      "credentials",
      "handlers",
      "menu",
      "window"
    ]);
    expect(mocks.setApplicationMenu).toHaveBeenCalledOnce();
    expect(mocks.setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it("connects one project service after migration and cleans it up on shutdown", async () => {
    await import("./index");
    await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());

    expect(mocks.openAppDatabase).toHaveBeenCalledWith(
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
    expect(mocks.registerProjectHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerProjectHandlers).toHaveBeenCalledWith(
      mocks.ipcMain,
      mocks.ProjectService.mock.instances[0]
    );

    mocks.callbacks.get("activate")?.();
    expect(mocks.createMainWindow).toHaveBeenCalledTimes(2);
    expect(mocks.ProjectRepository).toHaveBeenCalledOnce();
    expect(mocks.ProjectService).toHaveBeenCalledOnce();

    mocks.callbacks.get("before-quit")?.();
    expect(mocks.events.slice(-2)).toEqual(["cleanup", "close"]);

    mocks.callbacks.get("window-all-closed")?.();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });
});
