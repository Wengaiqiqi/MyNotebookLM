import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type AppDatabase, openAppDatabaseAsync } from "./db/database";
import { CredentialStore } from "./credentials/credential-store";
import { SafeStorageAdapter } from "./credentials/safe-storage-adapter";
import { registerProjectHandlers } from "./ipc/register-project-handlers";
import { registerModelHandlers } from "./ipc/register-model-handlers";
import { registerSourceHandlers } from "./ipc/register-source-handlers";
import { registerVectorHandlers } from "./ipc/register-vector-handlers";
import { registerChatHandlers } from "./ipc/register-chat-handlers";
import { ChatService, recoverInterruptedStreams, type RetrievableChunk } from "./chat/chat-service";
import { CitationOpener } from "./chat/citation-opener";
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
import { IndexingService, canonicalEmbeddingFingerprint } from "./vector/indexing-service";
import { SpaceRepository } from "./vector/space-repository";
import { SpaceService } from "./vector/space-service";
import { backupDatabase } from "./vector/vector-backup";
import { createLocalModelManager, managedActiveDirectory, managedStagingDirectory } from "./vector/local-model-manager";
import { LocalEmbeddingProvider, createTransformersEmbeddingRuntime, isAuthoritativeLocalCapability } from "./vector/local-embedding-provider";
import { LOCAL_MODEL_MANIFEST } from "./vector/local-model-manifest";
import { createModelProvider } from "./models/model-service";
import { BUILT_IN_LOCAL_EMBEDDING_PROFILE, isBuiltInLocalEmbeddingProfile } from "./models/local-embedding-profile";
import { createEmbeddingProvider } from "./vector/embedding-provider";
import { RetrievalService } from "./retrieval/retrieval-service";
import { ModelRouter } from "./models/model-router";
import { RouteRepository } from "./models/route-repository";
import type { Result } from "../shared/app-errors";
import type { TaskDto } from "../shared/tasks";
import type { SearchHitDto, VectorHealthDto } from "../shared/vector";

let appDatabase: AppDatabase | undefined;
let cleanupProjectHandlers: (() => void) | undefined;
let cleanupModelHandlers: (() => void) | undefined;
let cleanupTitleOverlayHandler: (() => void) | undefined;
let cleanupSourceHandlers: (() => void) | undefined;
let cleanupVectorHandlers: (() => void) | undefined;
let cleanupChatHandlers: (() => void) | undefined;
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
  appDatabase = await openAppDatabaseAsync(appPaths.database, migrationsDir);
  // Task 4/5 startup recovery: abandoned streaming drafts become cancelled.
  // A recovery hiccup must never block the whole app from starting.
  try {
    recoverInterruptedStreams(appDatabase.connection);
  } catch {
    // Streaming drafts stay recoverable on the next successful pass.
  }
  const projectRepository = new ProjectRepository(appDatabase.connection);
  const projectService = new ProjectService(projectRepository);
  const settingsRepository = new SettingsRepository(appDatabase.connection);
  const credentialStore = new CredentialStore(appDatabase.connection, new SafeStorageAdapter());
  const modelService = new ModelService(settingsRepository, credentialStore);
  taskFanout = createTaskUpdateFanout(() => BrowserWindow.getAllWindows() as any);
  const taskService = new TaskService(new TaskRepository(appDatabase.connection, { onTransition: taskFanout }), { now: () => new Date().toISOString(), random: Math.random, id: randomUUID });
  const pool = new WorkerPool();
  workerPool = pool;
  let ingestionService!: IngestionService;
  const lance = await LanceStore.open(path.join(appPaths.root, "vectors"));
  const spaces = new SpaceRepository(appDatabase.connection, undefined, undefined, lance);
  const spaceService = new SpaceService(spaces, { rebuild: async (raw: unknown) => { const input = raw as { space: { id: string; dimension: number }; spec: { projectId: string }; signal?: AbortSignal; revisionId?: string }; const revisions = input.revisionId ? [{ id: input.revisionId }] : appDatabase!.connection.prepare("SELECT current_revision_id AS id FROM sources WHERE project_id = ? AND status = 'active' AND current_revision_id IS NOT NULL").all(input.spec.projectId) as Array<{ id: string }>; for (const revision of revisions) await indexing.rebuild(input.signal ? { revisionId: revision.id, space: input.space, signal: input.signal } : { revisionId: revision.id, space: input.space }); }, optimize: async (raw: unknown) => { const value = raw as { taskId?: string; projectId?: string; space: { id: string; dimension: number }; signal?: AbortSignal }; const taskId = value.taskId ?? (value.projectId ? taskService.createTask({ projectId: value.projectId, sourceId: null, kind: "optimize" }).id : undefined); if (!taskId) throw new Error("optimize requires taskId or projectId"); taskService.start(taskId, "indexing"); try { taskService.advance(taskId, "indexing", 500); await lance.optimize(value.space, value.signal); taskService.complete(taskId); } catch (error) { if ((error as { code?: string }).code === "TASK_CANCELLED") { const current = taskService.getById(taskId); if (current?.state === "queued" || current?.state === "running") taskService.cancel(taskId); } else taskService.fail(taskId, { code: "INTERNAL", messageKey: "errors.internal", recoverable: false }); throw error; } } }, async () => backupDatabase(appDatabase!.connection, appPaths.database + ".space-backup-" + Date.now() + ".db"));
  await spaceService.recoverInterrupted();
  const localRuntime = createTransformersEmbeddingRuntime(appPaths.models, managedActiveDirectory(appPaths.models, LOCAL_MODEL_MANIFEST));
  const stagingRuntime = createTransformersEmbeddingRuntime(appPaths.models, managedStagingDirectory(appPaths.models, LOCAL_MODEL_MANIFEST));
  const localManager = createLocalModelManager(appPaths.models, async (directory, signal) => localRuntime(directory, [], signal), fetch, async (directory, signal) => stagingRuntime(directory, [], signal));
  const localEmbeddingProvider = new LocalEmbeddingProvider(localManager, localRuntime);
  const createProviderForSpace = async (row: { provider: string; model_id: string; model_revision: string; dimension?: number; distance?: string; pooling?: string; preprocess_version?: string; chunking_version?: string; fingerprint?: string }, space: { id: string; dimension: number }) => {
    const profile = row.provider === "local"
      ? BUILT_IN_LOCAL_EMBEDDING_PROFILE
      : settingsRepository.listProfiles().find(p => p.capability === "embedding" && p.enabled && p.provider === row.provider && p.modelId === row.model_id);
    if (!profile || (row.provider === "local" && !isBuiltInLocalEmbeddingProfile(profile))) throw Object.assign(new Error("Embedding profile is missing or mismatched"), { code: "EMBEDDING_PROFILE_MISMATCH", recoverable: false });
    if (profile.provider === "local") {
      const actual = localEmbeddingProvider.describe();
      if (!row.dimension || row.distance !== "cosine" || row.pooling !== "mean" || !row.preprocess_version || !row.chunking_version || !row.fingerprint) throw Object.assign(new Error("Local embedding capability is incomplete"), { code: "EMBEDDING_PROFILE_MISMATCH", recoverable: false });
      const persisted = { provider: row.provider, modelId: row.model_id, modelRevision: row.model_revision, dimension: row.dimension, distance: row.distance, pooling: row.pooling, preprocessVersion: row.preprocess_version, chunkingVersion: row.chunking_version } as const;
      if (!isAuthoritativeLocalCapability(persisted, actual) || row.fingerprint !== canonicalEmbeddingFingerprint(actual)) throw Object.assign(new Error("Local embedding capability is not authoritative"), { code: "EMBEDDING_PROFILE_MISMATCH", recoverable: false });
      return localEmbeddingProvider;
    }
    if (!row.dimension || row.distance !== "cosine" || row.pooling !== "mean" || !row.preprocess_version || !row.chunking_version) throw Object.assign(new Error("Embedding capability is incomplete"), { code: "EMBEDDING_PROFILE_MISMATCH", recoverable: false });
    let fingerprint: import("../shared/vector").EmbeddingFingerprint = { provider: row.provider, modelId: row.model_id, modelRevision: row.model_revision, dimension: row.dimension, distance: row.distance, pooling: row.pooling, preprocessVersion: row.preprocess_version, chunkingVersion: row.chunking_version };
    return {
      describe: () => fingerprint,
      embedBatch: async (texts: string[], signal: AbortSignal, batchSize?: number) => credentialStore.withSecret(profile.id, { provider: profile.provider, baseUrl: profile.baseUrl }, async (apiKey) => {
        const model = createModelProvider(profile.provider, profile.baseUrl, apiKey);
        const provider = createEmbeddingProvider({ provider: profile.provider, model: profile.modelId, adapter: { embed: model.embed.bind(model), describe: () => fingerprint } });
        const vectors = await provider.embedBatch(texts, signal, batchSize);
        fingerprint = { ...fingerprint, dimension: provider.describe().dimension };
        return vectors;
      })
    };
  };
  const resolveEmbeddingProvider = async (revisionId: string, space: { id: string; dimension: number }) => {
    const row = appDatabase!.connection.prepare(`SELECT es.provider, es.model_id, es.model_revision, es.dimension, es.distance, es.pooling, es.preprocess_version, es.chunking_version, es.fingerprint, es.project_id
      FROM source_revisions sr JOIN sources s ON s.id = sr.source_id
      JOIN embedding_spaces es ON es.id = ? AND es.project_id = s.project_id AND es.state IN ('active','preparing','building','validating') WHERE sr.id = ?`).get(space.id, revisionId) as { provider: string; model_id: string; model_revision: string; dimension: number; distance: string; pooling: string; preprocess_version: string; chunking_version: string; fingerprint: string; project_id: string } | undefined;
    if (!row) throw Object.assign(new Error("Active embedding space does not match revision project"), { code: "EMBEDDING_SPACE_PROFILE_MISMATCH", recoverable: false });
    return createProviderForSpace(row, space);
  };
  const indexing = new IndexingService(appDatabase.connection, resolveEmbeddingProvider, lance);
  const retrieval = new RetrievalService({ db: appDatabase.connection, lance, provider: localEmbeddingProvider, resolveSpace: async (projectId: string, space: { id: string; dimension: number }) => {
    const row = appDatabase!.connection.prepare("SELECT provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint FROM embedding_spaces WHERE id = ? AND project_id = ? AND state = 'active'").get(space.id, projectId) as { provider: string; model_id: string; model_revision: string; dimension: number; distance: string; pooling: string; preprocess_version: string; chunking_version: string; fingerprint: string } | undefined;
    return row ? { provider: await createProviderForSpace(row, space) } : null;
  }});
  (indexing as IndexingService & { setChunkRecovery?: (revisionId: string) => void }).setChunkRecovery?.((revisionId) => ingestionService.reparseRevision(revisionId));
  ingestionService = new IngestionService(pool, appDatabase.connection, (taskId) => {
    const revisionId = taskRevisions.get(taskId);
    const row = revisionId ? appDatabase?.connection.prepare("SELECT sr.stored_path, s.kind FROM tasks t JOIN source_revisions sr ON sr.id = ? JOIN sources s ON s.id = t.source_id WHERE t.id = ?").get(revisionId, taskId) as { stored_path?: string; kind?: string } | undefined : undefined;
    if (!row?.stored_path || !row.kind) return undefined;
    try { return { kind: row.kind, data: readFileSync(row.stored_path) }; } catch { return undefined; }
  }, (taskId, value) => { const task = taskService.getById(taskId); if (task?.state === "running") taskService.advance(taskId, "parsing", Math.min(600, Math.floor(value * 600))); }, indexing);
  const continueEmbedding = async (task: { id: string; sourceId: string | null }) => {
    const revisionId = taskRevisions.get(task.id) ?? (appDatabase?.connection.prepare("SELECT sr.id FROM tasks t JOIN sources s ON s.id = t.source_id JOIN source_revisions sr ON sr.source_id = s.id AND (sr.id = s.current_revision_id OR (s.current_revision_id IS NULL AND sr.state = 'awaiting_embedding')) WHERE t.id = ? AND t.project_id = s.project_id AND t.source_id = ? ORDER BY CASE WHEN sr.id = s.current_revision_id THEN 0 ELSE 1 END, sr.created_at DESC LIMIT 1").get(task.id, task.sourceId) as { id?: string } | undefined)?.id;
    if (!revisionId) throw new Error("Embedding task has no revision");
    const space = (appDatabase?.connection.prepare("SELECT es.id, es.dimension FROM source_revisions sr JOIN sources s ON s.id=sr.source_id JOIN project_embedding_spaces pes ON pes.project_id=s.project_id JOIN embedding_spaces es ON es.id=pes.space_id AND es.state='active' WHERE sr.id=?").get(revisionId) as { id: string; dimension: number } | undefined);
    if (!space) throw new Error("No active embedding space for queued task");
    await indexing.index({ taskId: task.id, revisionId, space });
  };
  if (typeof (appDatabase.connection as { prepare?: unknown }).prepare === "function") {
    await taskService.recoverAndContinueEmbedding(continueEmbedding, 60 * 60 * 1000);
  }
  const sourceService = new MainSourceService(appDatabase.connection, taskService, ingestionService, appPaths.files, (taskId, revisionId) => taskRevisions.set(taskId, revisionId));
  const failure = <T>(code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "CANCELLED" | "INDEX_UNAVAILABLE" | "INTERNAL", messageKey: string, recoverable = false): Result<T> => ({ ok: false, error: { code, messageKey, recoverable } });
  const activeTask = (projectId: string): TaskDto | undefined => {
    const row = appDatabase!.connection.prepare("SELECT * FROM tasks WHERE project_id = ? AND state IN ('queued','running') AND kind IN ('validation','optimize') ORDER BY created_at DESC LIMIT 1").get(projectId) as { id?: string } | undefined;
    return row?.id ? (taskService.getById?.(row.id) ?? undefined) : undefined;
  };
  const runTask = (task: TaskDto, work: () => Promise<void>): TaskDto => {
    if (task.kind !== "optimize") taskService.start(task.id, "validating");
    void work().then(() => { if (task.kind !== "optimize") taskService.complete(task.id); }).catch((error) => {
      if ((error as { code?: string }).code === "TASK_CANCELLED" || (error as { code?: string }).code === "SPACE_BUILD_CANCELLED") {
        const current = taskService.getById?.(task.id);
        if (current?.state === "queued" || current?.state === "running") taskService.cancel(task.id);
      }
      else taskService.fail(task.id, { code: "INTERNAL", messageKey: "errors.internal", recoverable: false });
    });
    return task;
  };
  const vectorService = {
    getHealth: async ({ projectId }: { projectId: string }): Promise<Result<VectorHealthDto>> => {
      const space = spaces.active(projectId);
      if (!space) return failure("NOT_FOUND", "errors.notFound");
      try { return { ok: true, value: { spaceId: space.id, healthy: (await lance.count(space)) >= 0, indexedCount: await lance.count(space) } }; } catch { return failure("INDEX_UNAVAILABLE", "errors.indexUnavailable", true); }
    },
    startMigration: async ({ projectId, profileId }: { projectId: string; profileId: string }): Promise<Result<TaskDto>> => {
      const profile = settingsRepository.getProfile(profileId);
      if (!profile || !profile.enabled || profile.capability !== "embedding") return failure("VALIDATION", "errors.modelCapability");
      const existing = activeTask(projectId);
      if (existing) return failure("CONFLICT", "errors.taskConflict", true);
      const current = spaces.active(projectId);
      const modelId = profile.modelId.trim();
      if (!modelId) return failure("VALIDATION", "errors.embeddingProfileUnavailable");
      const trustedRevision = profile.provider === "local" ? LOCAL_MODEL_MANIFEST.revision : modelId;
      const seedDimension = current?.dimension ?? (profile.provider === "local" ? LOCAL_MODEL_MANIFEST.dimension : 1);
      const capabilitySeed = { provider: profile.provider, modelId, modelRevision: trustedRevision, dimension: profile.provider === "local" ? LOCAL_MODEL_MANIFEST.dimension : seedDimension, distance: "cosine" as const, pooling: "mean" as const, preprocessVersion: profile.provider === "local" ? "e5-query-passage-v1" : "provider-default-v1", chunkingVersion: "persisted" };
      const provider = await createProviderForSpace({ provider: capabilitySeed.provider, model_id: capabilitySeed.modelId, model_revision: capabilitySeed.modelRevision, dimension: capabilitySeed.dimension, distance: capabilitySeed.distance, pooling: capabilitySeed.pooling, preprocess_version: capabilitySeed.preprocessVersion, chunking_version: capabilitySeed.chunkingVersion, ...(profile.provider === "local" ? { fingerprint: canonicalEmbeddingFingerprint(capabilitySeed) } : {}) }, { id: current?.id ?? "", dimension: capabilitySeed.dimension });
      const probe = await provider?.embedBatch?.(["embedding profile probe"], new AbortController().signal, 1);
      const dimension = probe[0]?.length;
      if (!dimension) return failure("VALIDATION", "errors.embeddingProfileUnavailable");
      const capability = provider.describe();
      const modelRevision = capability.modelRevision;
      const fingerprint = canonicalEmbeddingFingerprint({ provider: capability.provider, modelId: capability.modelId, modelRevision, dimension, distance: capability.distance, pooling: capability.pooling, preprocessVersion: capability.preprocessVersion, chunkingVersion: capability.chunkingVersion });
      const task = taskService.createTask({ projectId, sourceId: null, kind: "validation" });
      return { ok: true, value: runTask(task, () => spaceService.rebuild({ taskId: task.id, spec: { projectId, provider: capability.provider, modelId: capability.modelId, modelRevision, dimension, distance: capability.distance, pooling: capability.pooling, preprocessVersion: capability.preprocessVersion, chunkingVersion: capability.chunkingVersion, fingerprint } })) };
    },
    rebuild: async ({ projectId, spaceId }: { projectId: string; spaceId: string }): Promise<Result<TaskDto>> => {
      const space = spaces.get(spaceId);
      if (!space || space.projectId !== projectId) return failure("NOT_FOUND", "errors.notFound");
      const existing = activeTask(projectId);
      if (existing) return failure("CONFLICT", "errors.taskConflict", true);
      const task = taskService.createTask({ projectId, sourceId: null, kind: "validation" });
      return { ok: true, value: runTask(task, () => spaceService.rebuild({ taskId: task.id, spec: space })) };
    },
    optimize: async ({ projectId, spaceId }: { projectId: string; spaceId: string }): Promise<Result<TaskDto>> => {
      const space = spaces.get(spaceId);
      if (!space || space.projectId !== projectId) return failure("NOT_FOUND", "errors.notFound");
      const existing = activeTask(projectId);
      if (existing) return failure("CONFLICT", "errors.taskConflict", true);
      const task = taskService.createTask({ projectId, sourceId: null, kind: "optimize" });
      return { ok: true, value: runTask(task, () => spaceService.optimize({ taskId: task.id, projectId, space })) };
    },
    cancelTask: async ({ projectId, taskId }: { projectId: string; taskId: string }): Promise<Result<TaskDto>> => {
      const task = taskService.getById?.(taskId);
      if (!task || task.projectId !== projectId) return failure("NOT_FOUND", "errors.notFound");
      spaceService.cancel(taskId);
      try { return { ok: true, value: taskService.cancel(taskId) }; } catch { return failure("CONFLICT", "errors.taskConflict", true); }
    },
    search: async ({ projectId, query, limit }: { projectId: string; query: string; limit: number }): Promise<Result<SearchHitDto[]>> => {
      const result = await retrieval.search({ projectId, query, limit });
      if (!result.ok) return result as Result<SearchHitDto[]>;
      const hits = result.value.map((hit: { chunkId: string; score?: number; text: string; locator: unknown }) => ({ chunkId: hit.chunkId, score: hit.score ?? 0, text: hit.text, locator: hit.locator }));
      return { ok: true, value: hits };
    }
  };
  cleanupProjectHandlers = registerProjectHandlers(ipcMain, projectService);
  cleanupModelHandlers = registerModelHandlers(ipcMain, modelService);
  if (typeof (ipcMain as { handle?: unknown }).handle === "function") {
    cleanupSourceHandlers = registerSourceHandlers(ipcMain, {
      listSources: sourceService.listSources.bind(sourceService), listTasks: sourceService.listTasks.bind(sourceService),
      importFile: sourceService.importFile.bind(sourceService), importUrl: sourceService.importUrl.bind(sourceService),
      removeSource: sourceService.removeSource.bind(sourceService), retryTask: sourceService.retryTask.bind(sourceService),
      cancelTask: sourceService.cancelTask.bind(sourceService), ownsSource: sourceService.ownsSource.bind(sourceService), ownsTask: sourceService.ownsTask.bind(sourceService)
    });
    cleanupVectorHandlers = registerVectorHandlers(ipcMain, vectorService);
  }
  const chatService = new ChatService({
    db: appDatabase.connection,
    // Resolve the immutable route snapshot per turn so route changes apply live.
    router: new ModelRouter(new RouteRepository(settingsRepository)),
    providerFactory: (profile) => ({
      describe: () => {
        throw new Error("provider describe is not used for generation");
      },
      discover: (signal) =>
        credentialStore.withSecret(profile.id, { provider: profile.provider, baseUrl: profile.baseUrl }, (apiKey) =>
          createModelProvider(profile.provider, profile.baseUrl, apiKey).discover(signal)),
      async *generate(request, signal) {
        const provider = await credentialStore.withSecret(
          profile.id,
          { provider: profile.provider, baseUrl: profile.baseUrl },
          (apiKey) => Promise.resolve(createModelProvider(profile.provider, profile.baseUrl, apiKey))
        );
        yield* provider.generate(request, signal);
      },
      embed: (request, signal) =>
        credentialStore.withSecret(profile.id, { provider: profile.provider, baseUrl: profile.baseUrl }, (apiKey) =>
          createModelProvider(profile.provider, profile.baseUrl, apiKey).embed(request, signal))
    }),
    retrieval: async ({ projectId, question }) => {
      const result = await retrieval.search({ projectId, query: question, limit: 12 });
      if (!result.ok) throw new Error(result.error.code);
      const rows = result.value as Array<{ chunkId: string; text: string; locator: Record<string, unknown> }>;
      const lookups = rows.map((hit) => {
        const row = appDatabase?.connection.prepare(
          "SELECT s.id AS source_id, s.display_name, s.kind FROM source_chunks sc JOIN source_revisions sr ON sr.id = sc.revision_id JOIN sources s ON s.id = sr.source_id WHERE sc.id = ?"
        ).get(hit.chunkId) as { source_id?: string; display_name?: string; kind?: string } | undefined;
        return { hit, row };
      });
      return lookups.map(({ hit, row }, index): RetrievableChunk => ({
        label: "S" + (index + 1),
        chunkId: hit.chunkId,
        sourceId: row?.source_id ?? "",
        sourceDisplayName: row?.display_name ?? "",
        sourceKind: row?.kind ?? "",
        locator: hit.locator,
        locatorSummary: JSON.stringify(hit.locator),
        text: hit.text
      }));
    }
  });
  cleanupChatHandlers = registerChatHandlers({
    resolveWindowFromSender: (sender) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents === sender),
    ipc: ipcMain,
    service: chatService,
    requestHub: new Map(),
    openCitation: (input) => new CitationOpener(appDatabase!.connection).openCitation(input),
    onWindowClosed: () => void 0
  });

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
  cleanupVectorHandlers?.();
  cleanupVectorHandlers = undefined;
  cleanupChatHandlers?.();
  cleanupChatHandlers = undefined;
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
