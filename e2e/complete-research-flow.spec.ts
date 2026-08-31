import { expect, test } from "@playwright/test";
import * as lancedb from "@lancedb/lancedb";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  closeElectron,
  createProject,
  embedFingerprint,
  launchWithUserData,
  seedTextSource,
  skipOnboarding,
  startFakeOpenAi
} from "./helpers/task9";

type TaskRow = { id: string; kind: string; state: string; error?: { code?: string } | null };

async function listTasks(page: import("playwright").Page, projectId: string): Promise<TaskRow[]> {
  return page.evaluate(async (projectId: string) => {
    const api = (window as unknown as { myNotebook: any }).myNotebook;
    return api.tasks.list({ projectId });
  }, projectId);
}

async function waitForTask(page: import("playwright").Page, projectId: string, taskId: string, state: string, timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    const tasks = await listTasks(page, projectId);
    const task = tasks.find((item) => item.id === taskId);
    if (task?.state === "failed") throw new Error(`task ${taskId} (${task.kind}) failed: ${task.error?.code ?? "unknown"}`);
    return task?.state;
  }, { timeout }).toBe(state);
}

test("complete research flow with fake providers", async () => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-flow-"));
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi({
    behaviors: [{ failModelSuffix: "primary", statusCode: 500 }]
  });
  const generationProfileId = "11111111-1111-4111-8111-111111111111";
  const fallbackProfileId = "12121212-1212-4212-8212-121212121212";
  const embeddingProfileId = "22222222-2222-4222-8222-222222222222";
  const secondEmbeddingProfileId = "23232323-2323-4323-8323-232323232323";
  const bootstrapSpaceId = "33333333-3333-4333-8333-333333333333";
  const bootstrapFingerprint = embedFingerprint();
  const tableName = `space_${bootstrapSpaceId.replaceAll("-", "_")}`;
  let vectorsDir: string | undefined;
  let vectors: Awaited<ReturnType<typeof lancedb.connect>> | undefined;
  let app: import("playwright").ElectronApplication | undefined;
  let bootstrapped = false;
  try {
    // -- onboarding: skip, project --
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Complete Flow");
    await closeElectron(first.app);
    app = undefined;

    // -- all imports: seed text + csv revisions directly (SSRF policy forbids loopback URLs) --
    const mainLaunch = await launchWithUserData(userDataDir);
    app = mainLaunch.app;
    const main = await seedTextSource(userDataDir, projectId, "authoritative-alpha.txt", "alpha evidence from the authoritative source.");
    const csvSource = await seedTextSource(userDataDir, projectId, "beta-table.csv", "beta evidence from the csv table.");
    await closeElectron(mainLaunch.app);
    app = undefined;

    // -- index: bootstrap Lance space with one chunk for the text source --
    const database = new Database(path.join(userDataDir, "data", "app.db"));
    let csvChunkId = "";
    try {
      const csvChunk = database.prepare(
        "SELECT id, text FROM source_chunks WHERE revision_id = ? ORDER BY ordinal LIMIT 1"
      ).get(csvSource.revisionId) as { id: string; text: string };
      csvChunkId = csvChunk.id;
      const now = new Date().toISOString();
      database.prepare(
        "INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, progress_1000, created_at, updated_at) VALUES (?, ?, 'openai-compatible', 'text-embedding-e2e', 'text-embedding-e2e', 3, 'cosine', 'mean', 'provider-default-v1', 'persisted', ?, 'active', 1000, ?, ?)"
      ).run(bootstrapSpaceId, projectId, bootstrapFingerprint, now, now);
      database.prepare(
        "INSERT INTO project_embedding_spaces(project_id, space_id, updated_at) VALUES (?, ?, ?)"
      ).run(projectId, bootstrapSpaceId, now);
    } finally {
      database.close();
    }
    vectorsDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-flow-vectors-"));
    vectors = await lancedb.connect(vectorsDir);
    await vectors.createTable(tableName, lancedb.makeArrowTable([{
      chunkId: main.chunkId,
      projectId,
      sourceId: main.sourceId,
      revisionId: main.revisionId,
      spaceId: bootstrapSpaceId,
      ordinal: 0,
      contentHash: "sha256:alpha",
      text: "alpha evidence from the authoritative source.",
      vector: [1, 0, 0],
      locatorJson: JSON.stringify({ kind: "paragraph", paragraph: 1 }),
      createdAt: Date.now()
    }]));
    const table = await vectors.openTable(tableName);
    await table.createIndex("text", { config: lancedb.Index.fts(), replace: false });
    await vectors.close();
    vectors = undefined;
    await fs.mkdir(path.join(userDataDir, "vectors"), { recursive: true });
    await fs.cp(path.join(vectorsDir, `${tableName}.lance`), path.join(userDataDir, "vectors", `${tableName}.lance`), { recursive: true });

    // -- relaunch: profiles, routes (chat with fallback), retrieval, chat, citations --
    const launched = await launchWithUserData(userDataDir);
    app = launched.app;
    const setup = await launched.page.evaluate(async ({ baseUrl, projectId, generationProfileId, fallbackProfileId, embeddingProfileId, chunkId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const generation = await api.models.saveProfile({
        profile: { id: generationProfileId, name: "Flow Generation", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true },
        apiKey: "flow-generation-key"
      });
      if (!generation.ok) throw new Error(`generation profile: ${generation.error.code}`);
      const fallback = await api.models.saveProfile({
        profile: { id: fallbackProfileId, name: "Flow Fallback", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e-backup", enabled: true },
        apiKey: "flow-fallback-key"
      });
      if (!fallback.ok) throw new Error(`fallback profile: ${fallback.error.code}`);
      const embedding = await api.models.saveProfile({
        profile: { id: embeddingProfileId, name: "Flow Embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true },
        apiKey: "flow-embedding-key"
      });
      if (!embedding.ok) throw new Error(`embedding profile: ${embedding.error.code}`);
      const routes = await api.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
      if (!routes.ok) throw new Error(`default routes: ${routes.error.code}`);
      const chatRoute = await api.models.saveRoutes({ taskKind: "chat", profileIds: [fallbackProfileId, generationProfileId] });
      if (!chatRoute.ok) throw new Error(`chat routes: ${chatRoute.error.code}`);
      const summaryRoute = await api.models.saveRoutes({ taskKind: "summary", profileIds: [generationProfileId] });
      if (!summaryRoute.ok) throw new Error(`summary route: ${summaryRoute.error.code}`);
      const customRoute = await api.models.saveRoutes({ taskKind: "custom-transformation", profileIds: [generationProfileId] });
      if (!customRoute.ok) throw new Error(`custom route: ${customRoute.error.code}`);
      const noteTitleRoute = await api.models.saveRoutes({ taskKind: "note-title", profileIds: [generationProfileId] });
      if (!noteTitleRoute.ok) throw new Error(`note-title route: ${noteTitleRoute.error.code}`);
      const hits = await api.retrieval.search({ projectId, query: "alpha", limit: 5 });
      if (!hits.ok) throw new Error(`retrieval: ${hits.error.code}`);
      if (!hits.value.some((hit: { chunkId: string }) => hit.chunkId === chunkId)) throw new Error("retrieval hit missing");
      return { chatRouteOk: chatRoute.ok, hits: hits.value };
    }, { baseUrl: provider.baseUrl, projectId, generationProfileId, fallbackProfileId, embeddingProfileId, chunkId: main.chunkId });
    expect(setup.chatRouteOk).toBe(true);

    const chat = await launched.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const conversation = await api.conversations.create({ projectId, title: "Cited Flow" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      const requestId = crypto.randomUUID();
      const events: any[] = [];
      const unsubscribe = api.chat.subscribe(requestId, (event: any) => { events.push(event.type); });
      const send = await api.chat.send({ requestId, projectId, conversationId: conversation.value.id, question: "What is the alpha evidence?" });
      unsubscribe();
      if (!send.ok) throw new Error(`chat: ${send.error.code}`);
      const messages = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      if (!messages.ok) throw new Error(`messages: ${messages.error.code}`);
      const assistant = messages.value.find((message: { id: string }) => message.id === send.value.assistantMessageId);
      if (!assistant || assistant.state !== "completed") throw new Error("assistant not completed");
      return { conversationId: conversation.value.id, assistantMessageId: assistant.id, content: assistant.content, events };
    }, { projectId });
    expect(chat.content).toContain("Grounded alpha answer [S1]");
    const chatRequests = provider.requests.filter((request) => request.path === "/v1/chat/completions");
    expect(chatRequests.length).toBeGreaterThan(0);
    expect(chatRequests.map((request) => request.body?.model)).toEqual(expect.arrayContaining(["gpt-e2e-backup"]));

    const citation = await launched.page.evaluate(async ({ projectId, conversationId, assistantMessageId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      const assistant = messages.value.find((message: { id: string }) => message.id === assistantMessageId);
      const first = assistant.citations[0];
      if (!first) throw new Error("citation missing");
      const detail = await api.citations.detail({ projectId, citationId: first.id });
      if (!detail.ok) throw new Error(`detail: ${detail.error.code}`);
      return { label: first.label, source: first.sourceDisplayName, locator: first.locator, text: detail.value.text };
    }, { projectId, conversationId: chat.conversationId, assistantMessageId: chat.assistantMessageId });
    expect(citation).toMatchObject({ label: "S1", source: "authoritative-alpha.txt" });
    expect(citation.locator).toMatchObject({ kind: "paragraph", paragraph: 1 });
    expect(citation.text).toBe("alpha evidence from the authoritative source.");

    // -- note + generated title --
    const note = await launched.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const created = await api.notes.create({ projectId, title: "Flow note", body: "# Flow evidence\n\nalpha body text" });
      if (!created.ok) throw new Error(`note: ${created.error.code}`);
      const titled = await api.notes.generateTitle({ projectId, noteId: created.value.id, locale: "en" });
      if (!titled.ok) throw new Error(`title: ${titled.error.code}`);
      return titled.value;
    }, { projectId });
    expect(note.title).not.toBe("Flow note");

    // -- built-in + custom transformations --
    const transformation = await launched.page.evaluate(async ({ projectId, noteId, revisionId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const builtins = await api.transformations.listBuiltins({ language: "en" });
      if (!builtins.ok || builtins.value.length === 0) throw new Error("builtins missing");
      const builtinRun = await api.transformations.run({ projectId, builtinKey: "summary", language: "en", sourceRevisionId: revisionId });
      if (!builtinRun.ok) throw new Error(`builtin run: ${builtinRun.error.code}`);
      const rule = await api.transformations.createRule({ projectId, name: "Flow rule", appliesTo: "note", prompt: "Rewrite this note:\n\n{{content}}" });
      if (!rule.ok) throw new Error(`rule: ${rule.error.code}`);
      const customRun = await api.transformations.run({ projectId, transformationId: rule.value.id, noteId });
      if (!customRun.ok) throw new Error(`custom run: ${customRun.error.code}`);
      return { builtinTaskId: builtinRun.value.id, customTaskId: customRun.value.id };
    }, { projectId, noteId: note.id, revisionId: main.revisionId });
    await waitForTask(launched.page, projectId, transformation.builtinTaskId, "completed");
    await waitForTask(launched.page, projectId, transformation.customTaskId, "completed");
    const insight = await launched.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const list = await api.transformations.listInsights({ projectId, limit: 10 });
      if (!list.ok) throw new Error(`insights: ${list.error.code}`);
      return list.value;
    }, { projectId });
    expect(insight.length).toBeGreaterThanOrEqual(1);
    await closeElectron(launched.app);
    app = undefined;

    // -- fallback: point primary generation profile at a 500-injecting model id, keep fallback on fake provider --
    const fallbackDb = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      fallbackDb.prepare("UPDATE model_profiles SET model_id = ? WHERE id = ?").run("gpt-e2e-primary", generationProfileId);
      fallbackDb.prepare("DELETE FROM model_routes WHERE task_kind = 'chat'").run();
      fallbackDb.prepare("INSERT INTO model_routes(task_kind, position, profile_id) VALUES ('chat', 0, ?), ('chat', 1, ?)").run(generationProfileId, fallbackProfileId);
    } finally {
      fallbackDb.close();
    }
    const relaunched = await launchWithUserData(userDataDir);
    app = relaunched.app;
    const fallbackChat = await relaunched.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const conversation = await api.conversations.create({ projectId, title: "Fallback Flow" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      const requestId = crypto.randomUUID();
      const send = await api.chat.send({ requestId, projectId, conversationId: conversation.value.id, question: "alpha again" });
      if (!send.ok) throw new Error(`chat: ${send.error.code}`);
      const messages = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      const assistant = messages.value.find((message: { id: string }) => message.id === send.value.assistantMessageId);
      if (!assistant || assistant.state !== "completed") throw new Error(`fallback assistant state: ${assistant?.state}`);
      return { profileId: assistant.profileId, model: assistant.model };
    }, { projectId });
    expect(fallbackChat.profileId).toBe(fallbackProfileId);
    expect(fallbackChat.model).toBe("gpt-e2e-backup");
    const fallbackRequests = provider.requests.filter((request) => request.path === "/v1/chat/completions").map((request) => request.body?.model);
    expect(fallbackRequests).toEqual(expect.arrayContaining(["gpt-e2e-primary", "gpt-e2e-backup"]));
    const attempts = await relaunched.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const list = await api.models.listRouteAttempts({ projectId, taskKind: "chat", limit: 20 });
      if (!list.ok) throw new Error(`attempts: ${list.error.code}`);
      return list.value;
    }, { projectId });
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: generationProfileId, state: "failed" }),
      expect.objectContaining({ profileId: fallbackProfileId, state: "completed" })
    ]));
    await closeElectron(relaunched.app);
    app = undefined;

    // -- Space migration: second embedding profile (new model id on same fake), migration, rebuild, restart --
    const migrationDb = new Database(path.join(userDataDir, "data", "app.db"));
    let csvChunkText = "";
    try {
      csvChunkText = (migrationDb.prepare("SELECT text FROM source_chunks WHERE id = ?").get(csvChunkId) as { text: string }).text;
    } finally {
      migrationDb.close();
    }
    const secondLaunch = await launchWithUserData(userDataDir);
    app = secondLaunch.app;
    const migration = await secondLaunch.page.evaluate(async ({ projectId, embeddingProfileId, baseUrl, secondEmbeddingProfileId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const secondEmbedding = await api.models.saveProfile({
        profile: { id: secondEmbeddingProfileId, name: "Flow Embedding v2", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e-v2", enabled: true },
        apiKey: "flow-embedding-key"
      });
      if (!secondEmbedding.ok) throw new Error(`second embedding profile: ${secondEmbedding.error.code}`);
      const started = await api.vector.startMigration({ projectId, profileId: embeddingProfileId });
      if (!started.ok) throw new Error(`migration: ${started.error.code}`);
      return started.value.id;
    }, { projectId, embeddingProfileId: secondEmbeddingProfileId, baseUrl: provider.baseUrl, secondEmbeddingProfileId });
    await waitForTask(secondLaunch.page, projectId, migration, "completed");
    const migratedTasks = await listTasks(secondLaunch.page, projectId);
    expect(migratedTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "validation", state: "completed" })
    ]));
    const migratedHit = await secondLaunch.page.evaluate(async ({ projectId, csvChunkText }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const hits = await api.retrieval.search({ projectId, query: "beta", limit: 5 });
      if (!hits.ok) throw new Error(`search: ${hits.error.code}`);
      return hits.value.some((hit: { text?: string }) => hit.text === csvChunkText);
    }, { projectId, csvChunkText });
    expect(migratedHit).toBe(true);
    const spaceId = await secondLaunch.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const health = await api.vector.getHealth({ projectId });
      if (!health.ok) throw new Error(`health: ${health.error.code}`);
      return health.value.spaceId;
    }, { projectId });
    const rebuild = await secondLaunch.page.evaluate(async ({ projectId, spaceId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const started = await api.vector.rebuild({ projectId, spaceId });
      if (!started.ok) throw new Error(`rebuild: ${started.error.code}`);
      return started.value.id;
    }, { projectId, spaceId });
    await waitForTask(secondLaunch.page, projectId, rebuild, "completed");
    await closeElectron(secondLaunch.app);
    app = undefined;
    bootstrapped = true;

    const restart = await launchWithUserData(userDataDir);
    app = restart.app;
    const persisted = await restart.page.evaluate(async ({ projectId, conversationId, assistantMessageId, noteId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      const notes = await api.notes.list({ projectId });
      return {
        assistant: messages.value.find((message: { id: string }) => message.id === assistantMessageId),
        notes: notes.value
      };
    }, { projectId, conversationId: chat.conversationId, assistantMessageId: chat.assistantMessageId, noteId: note.id });
    expect(persisted.assistant.state).toBe("completed");
    expect(persisted.assistant.content).toContain("Grounded alpha answer [S1]");
    expect(persisted.notes).toEqual(expect.arrayContaining([expect.objectContaining({ id: note.id })]));
    await closeElectron(restart.app);
    app = undefined;
    bootstrapped = true;
    expect(bootstrapped).toBe(true);
  } finally {
    if (app) await closeElectron(app);
    await provider.close().catch(() => undefined);
    if (vectors) await vectors.close();
    if (vectorsDir) await fs.rm(vectorsDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
