import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type AppDatabase, openAppDatabase } from "./db/database";
import { CredentialStore } from "./credentials/credential-store";
import { SafeStorageAdapter } from "./credentials/safe-storage-adapter";
import { registerProjectHandlers } from "./ipc/register-project-handlers";
import { registerModelHandlers } from "./ipc/register-model-handlers";
import { registerSourceHandlers } from "./ipc/register-source-handlers";
import { ModelService } from "./models/model-service";
import { getAppPaths } from "./platform/paths";
import { ProjectRepository } from "./projects/project-repository";
import { ProjectService } from "./projects/project-service";
import { SettingsRepository } from "./settings/settings-repository";
import { TaskRepository } from "./tasks/task-repository";
import { TaskService } from "./tasks/task-service";
import { WorkerPool } from "./tasks/worker-pool";
import { IngestionService } from "./sources/ingestion-service";
import { MainSourceService } from "./sources/main-source-service";
import { createTaskUpdateFanout } from "./task-updates";
import { readFileSync } from "node:fs";
import { createMainWindow, registerTitleOverlayHandler } from "./window";
import { LanceStore } from "./vector/lance-store";
import { IndexingService } from "./vector/indexing-service";
import { SpaceRepository } from "./vector/space-repository";
import { SpaceService } from "./vector/space-service";
import { backupDatabase } from "./vector/vector-backup";
import { createLocalModelManager } from "./vector/local-model-manager";
import { LocalEmbeddingProvider, createTransformersEmbeddingRuntime } from "./vector/local-embedding-provider";

let appDatabase: AppDatabase | undefined;
let cleanupProjectHandlers: (() => void) | undefined;
let cleanupModelHandlers: (() => void) | undefined;
let cleanupTitleOverlayHandler: (() => void) | undefined;
let cleanupSourceHandlers: (() => void) | undefined;
let workerPool: WorkerPool | undefined;
let taskFanout: ReturnType<typeof createTaskUpdateFanout> | undefined;
const taskRevisions = new Map<string, string>();

const testUserDataDir = process.env["MYNOTEBOOKLM_USER_DATA_DIR"];
if (process.env["NODE_ENV"] === "test" && testUserDataDir) {
  app.setPath("userData", testUserDataDir);
}

app.whenReady().then(async () => {
  const appPaths = getAppPaths(app.getPath("userData"));
  await Promise.all([
    mkdir(appPaths.root, { recursive: true }),
    mkdir(path.dirname(appPaths.database), { recursive: true }),
    mkdir(appPaths.files, { recursive: true }),
    mkdir(appPaths.models, { recursive: true }),
    mkdir(appPaths.logs, { recursive: true })
  ]);
  const migrationsDir = app.isPackaged
    ? path.join(process.resourcesPath, "migrations")
    : path.resolve(__dirname, "../../src/main/db/migrations");
  appDatabase = openAppDatabase(appPaths.database, migrationsDir);
  const projectRepository = new ProjectRepository(appDatabase.connection);
  const projectService = new ProjectService(projectRepository);
  const settingsRepository = new SettingsRepository(appDatabase.connection);
  const credentialStore = new CredentialStore(appDatabase.connection, new SafeStorageAdapter());
  const modelService = new ModelService(settingsRepository, credentialStore);
  taskFanout = createTaskUpdateFanout(() => BrowserWindow.getAllWindows() as any);
  const taskService = new TaskService(new TaskRepository(appDatabase.connection, { onTransition: taskFanout }), { now: () => new Date().toISOString(), random: Math.random, id: randomUUID });
  const pool = new WorkerPool();
  workerPool = pool;
  const lance = await LanceStore.open(path.join(appPaths.root, "vectors"));
  const spaces = new SpaceRepository(appDatabase.connection);
  const spaceService = new SpaceService(spaces, { rebuild: async () => { throw new Error("Space rebuild is not wired"); }, optimize: async () => { throw new Error("Space optimize is not wired"); } }, async () => backupDatabase(appDatabase!.connection, appPaths.database + ".space-backup-" + Date.now() + ".db"));
  spaceService.recoverInterrupted();
  const localRuntime = createTransformersEmbeddingRuntime(appPaths.models);
  const localManager = createLocalModelManager(appPaths.models, async (directory, signal) => localRuntime(directory, [], signal));
  const localEmbeddingProvider = new LocalEmbeddingProvider(localManager, localRuntime);
  const indexing = new IndexingService(appDatabase.connection, localEmbeddingProvider, lance);
  const ingestionService = new IngestionService(pool, appDatabase.connection, (taskId) => {
    const revisionId = taskRevisions.get(taskId);
    const row = revisionId ? appDatabase?.connection.prepare("SELECT sr.stored_path, s.kind FROM tasks t JOIN source_revisions sr ON sr.id = ? JOIN sources s ON s.id = t.source_id WHERE t.id = ?").get(revisionId, taskId) as { stored_path?: string; kind?: string } | undefined : undefined;
    if (!row?.stored_path || !row.kind) return undefined;
    try { return { kind: row.kind, data: readFileSync(row.stored_path) }; } catch { return undefined; }
  }, undefined, indexing);
  const continueEmbedding = async (task: { id: string; sourceId: string | null }) => {
    const revisionId = taskRevisions.get(task.id) ?? (appDatabase?.connection.prepare("SELECT current_revision_id FROM sources WHERE id = ?").get(task.sourceId) as { current_revision_id?: string } | undefined)?.current_revision_id;
    if (!revisionId) throw new Error("Embedding task has no revision");
    const space = (appDatabase?.connection.prepare("SELECT es.id, es.dimension FROM source_revisions sr JOIN sources s ON s.id=sr.source_id JOIN project_embedding_spaces pes ON pes.project_id=s.project_id JOIN embedding_spaces es ON es.id=pes.space_id AND es.state='active' WHERE sr.id=?").get(revisionId) as { id: string; dimension: number } | undefined);
    if (!space) throw new Error("No active embedding space for queued task");
    await indexing.index({ taskId: task.id, revisionId, space });
  };
  if (typeof (appDatabase.connection as { prepare?: unknown }).prepare === "function") {
    await taskService.recoverAndContinueEmbedding(continueEmbedding, 60 * 60 * 1000);
  }
  const sourceService = new MainSourceService(appDatabase.connection, taskService, ingestionService, appPaths.files, (taskId, revisionId) => taskRevisions.set(taskId, revisionId));
  cleanupProjectHandlers = registerProjectHandlers(ipcMain, projectService);
  cleanupModelHandlers = registerModelHandlers(ipcMain, modelService);
  if (typeof (ipcMain as { handle?: unknown }).handle === "function") {
    cleanupSourceHandlers = registerSourceHandlers(ipcMain, {
      listSources: sourceService.listSources.bind(sourceService), listTasks: sourceService.listTasks.bind(sourceService),
      importFile: sourceService.importFile.bind(sourceService), importUrl: sourceService.importUrl.bind(sourceService),
      removeSource: sourceService.removeSource.bind(sourceService), retryTask: sourceService.retryTask.bind(sourceService),
      cancelTask: sourceService.cancelTask.bind(sourceService), ownsSource: sourceService.ownsSource.bind(sourceService), ownsTask: sourceService.ownsTask.bind(sourceService)
    });
  }
  cleanupTitleOverlayHandler = registerTitleOverlayHandler(ipcMain);

  Menu.setApplicationMenu(null);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event?.preventDefault();
  quitting = true;
  return Promise.resolve(workerPool?.close()).finally(() => {
  return Promise.resolve(LanceStore.closeAll()).finally(() => {
  workerPool = undefined;
  taskRevisions.clear();
  taskFanout?.close();
  taskFanout = undefined;
  cleanupProjectHandlers?.();
  cleanupProjectHandlers = undefined;
  cleanupModelHandlers?.();
  cleanupModelHandlers = undefined;
  cleanupTitleOverlayHandler?.();
  cleanupSourceHandlers?.();
  cleanupSourceHandlers = undefined;
  cleanupTitleOverlayHandler = undefined;
  appDatabase?.close();
  appDatabase = undefined;
    app.quit();
  });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
