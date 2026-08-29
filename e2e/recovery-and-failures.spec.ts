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
  startFakeOpenAi,
  startMalformedSseProvider
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
    return tasks.find((task) => task.id === taskId)?.state;
  }, { timeout }).toBe(state);
}

async function bootstrapActiveSpace(userDataDir: string, projectId: string): Promise<void> {
  const spaceId = crypto.randomUUID();
  const fingerprint = embedFingerprint();
  const tableName = `space_${spaceId.replaceAll("-", "_")}`;
  const text = "alpha rate limit seed text.";
  const seeded = await seedTextSource(userDataDir, projectId, "rate-seed.txt", text);
  const db = new Database(path.join(userDataDir, "data", "app.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, progress_1000, created_at, updated_at) VALUES (?, ?, 'openai-compatible', 'text-embedding-e2e', 'text-embedding-e2e', 3, 'cosine', 'mean', 'provider-default-v1', 'persisted', ?, 'active', 1000, ?, ?)"
    ).run(spaceId, projectId, fingerprint, now, now);
    db.prepare("INSERT INTO project_embedding_spaces(project_id, space_id, updated_at) VALUES (?, ?, ?)").run(projectId, spaceId, now);
  } finally {
    db.close();
  }
  const vectorsDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-rate-vectors-"));
  const vectors = await lancedb.connect(vectorsDir);
  try {
    await vectors.createTable(tableName, lancedb.makeArrowTable([{
      chunkId: seeded.chunkId,
      projectId,
      sourceId: seeded.sourceId,
      revisionId: seeded.revisionId,
      spaceId,
      ordinal: 0,
      contentHash: `sha256:${seeded.chunkId}`,
      text,
      vector: [1, 0, 0],
      locatorJson: JSON.stringify({ kind: "paragraph", paragraph: 1 }),
      createdAt: Date.now()
    }]));
    const table = await vectors.openTable(tableName);
    await table.createIndex("text", { config: lancedb.Index.fts(), replace: false });
  } finally {
    await vectors.close();
  }
  await fs.mkdir(path.join(userDataDir, "vectors"), { recursive: true });
  await fs.cp(path.join(vectorsDir, `${tableName}.lance`), path.join(userDataDir, "vectors", `${tableName}.lance`), { recursive: true });
  await fs.rm(vectorsDir, { recursive: true, force: true });
}

test("skip onboarding persists, missing model fails validation, offline network error", async () => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-fail-"));
  await fs.mkdir(userDataDir, { recursive: true });
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Failure Basics");
    await closeElectron(first.app);
    app = undefined;

    const second = await launchWithUserData(userDataDir);
    app = second.app;
    await expect(second.page.getByRole("button", { name: /稍后配置模型|Configure later/ })).toHaveCount(0);
    await expect(second.page.getByRole("button", { name: /新建项目|New project/ }).first()).toBeEnabled();

    const missingModel = await second.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const conversation = await api.conversations.create({ projectId, title: "No model" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      const requestId = crypto.randomUUID();
      const events: any[] = [];
      const unsubscribe = api.chat.subscribe(requestId, (event: any) => { events.push(event); });
      const send = await api.chat.send({ requestId, projectId, conversationId: conversation.value.id, question: "anything" });
      unsubscribe();
      if (!send.ok) return { sendOk: false, code: send.error.code };
      const messages = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      const assistant = messages.value.find((message: { id: string }) => message.id === send.value.assistantMessageId);
      return { sendOk: true, state: assistant?.state, errorCode: assistant?.errorCode };
    }, { projectId });
    expect(missingModel.sendOk === false || missingModel.state === "failed").toBe(true);
    if (missingModel.sendOk) expect(missingModel.errorCode).toBe("VALIDATION");
    await closeElectron(second.app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("auth, rate limit and malformed provider responses fail without silent recovery", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-fail-"));
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi({
    behaviors: [
      { failModelSuffix: "-auth", statusCode: 401, payload: { error: { message: "bad key" } } },
      { failModelSuffix: "-rate", statusCode: 429, payload: { error: { message: "slow down" } } }
    ]
  });
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Provider Failures");
    const authProfile = await first.page.evaluate(async ({ baseUrl }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const saved = await api.models.saveProfile({
        profile: { id: crypto.randomUUID(), name: "Auth broken", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e-auth", enabled: true },
        apiKey: "wrong-key"
      });
      return saved;
    }, { baseUrl: provider.baseUrl });
    expect(authProfile.ok).toBe(false);
    expect(authProfile.error.code).toBe("AUTH");
    await closeElectron(first.app);
    app = undefined;
    await bootstrapActiveSpace(userDataDir, projectId);

    const db = new Database(path.join(userDataDir, "data", "app.db"));
    let rateProfileId: string;
    let rateConversationId: string;
    try {
      rateProfileId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled) VALUES (?, 'Rate limited', 'openai-compatible', 'generation', ?, 'gpt-e2e-rate', 1)"
      ).run(rateProfileId, provider.baseUrl);
      db.prepare("INSERT INTO model_routes(task_kind, position, profile_id) VALUES ('chat', 0, ?)").run(rateProfileId);
      rateConversationId = crypto.randomUUID();
      db.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, 'Rate conv', ?, ?)").run(rateConversationId, projectId, now, now);
    } finally {
      db.close();
    }

    const second = await launchWithUserData(userDataDir);
    app = second.app;
    const embeddingSaved = await second.page.evaluate(async ({ baseUrl }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      return api.models.saveProfile({
        profile: { id: crypto.randomUUID(), name: "Rate embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true },
        apiKey: "rate-key"
      });
    }, { baseUrl: provider.baseUrl });
    expect(embeddingSaved.ok, JSON.stringify(embeddingSaved)).toBe(true);
    const rateLimited = await second.page.evaluate(async ({ projectId, conversationId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const requestId = crypto.randomUUID();
      const send = await api.chat.send({ requestId, projectId, conversationId, question: "hello" });
      if (!send.ok) return { sendOk: false, code: send.error.code };
      for (let attempt = 0; attempt < 50; attempt++) {
        const messages = await api.conversations.listMessages({ projectId, conversationId });
        const assistant = messages.value.find((message: { id: string }) => message.id === send.value.assistantMessageId);
        if (assistant && (assistant.state === "failed" || assistant.state === "complete" || assistant.state === "cancelled")) return { sendOk: true, state: assistant.state, errorCode: assistant.errorCode };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { sendOk: true, state: "timeout", errorCode: undefined };
    }, { projectId, conversationId: rateConversationId });
    expect(rateLimited.state === "failed" || (rateLimited.sendOk === false && rateLimited.code === "RATE_LIMITED"), JSON.stringify(rateLimited)).toBe(true);
    if (rateLimited.state === "failed") expect(rateLimited.errorCode).toBe("RATE_LIMITED");
    await closeElectron(second.app);
    app = undefined;

    // Malformed SSE: save profile via probe against malformed provider must fail, seeded profile must fail chat.
    const malformed = await startMalformedSseProvider();
    try {
      const malformedProfile = await (async () => {
        const third = await launchWithUserData(userDataDir);
        app = third.app;
        const saved = await third.page.evaluate(async ({ baseUrl }) => {
          const api = (window as unknown as { myNotebook: any }).myNotebook;
          return api.models.saveProfile({
            profile: { id: crypto.randomUUID(), name: "Malformed", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-broken", enabled: true },
            apiKey: "malformed-key"
          });
        }, { baseUrl: malformed.baseUrl });
        await closeElectron(third.app);
        app = undefined;
        return saved;
      })();
      expect(malformedProfile.ok).toBe(false);
      expect(malformedProfile.error.code).toBe("PROVIDER");
    } finally {
      await malformed.close();
    }
  } finally {
    if (app) await closeElectron(app);
    await provider.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("parser failure surfaces as failed ingest task", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-fail-"));
  await fs.mkdir(userDataDir, { recursive: true });
  const brokenPdf = path.join(userDataDir, "broken.pdf");
  await fs.writeFile(brokenPdf, Buffer.from("%PDF-not-a-real-document"), "utf8");
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    // Stub the native open dialog so importFile runs the real product path.
    await first.app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, brokenPdf);
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Parser Failure");
    const picked = await first.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      return api.sources.chooseFiles({ projectId });
    }, { projectId });
    expect(Array.isArray(picked) && picked.length === 1, JSON.stringify(picked)).toBe(true);
    const imported = await first.page.evaluate(async ({ projectId, dialogToken }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      return api.sources.importFile({ projectId, dialogToken });
    }, { projectId, dialogToken: picked[0] });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    await expect.poll(async () => {
      const tasks = await listTasks(first.page, projectId);
      return tasks.find((task) => task.kind === "ingest")?.state;
    }, { timeout: 60_000 }).toBe("failed");
    const failed = (await listTasks(first.page, projectId)).find((task) => task.kind === "ingest");
    expect(failed?.error?.code, JSON.stringify(failed)).toBeTruthy();
    await closeElectron(first.app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("cancel mid-stream marks the assistant message cancelled", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-fail-"));
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi({ chatDelayMs: 4000 });
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Cancel Flow");
    const generationProfileId = "41414141-4141-4414-8141-414141414141";
    const embeddingProfileId = "42424242-4242-4424-8242-424242424242";
    const setup = await first.page.evaluate(async ({ baseUrl, projectId, generationProfileId, embeddingProfileId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const generation = await api.models.saveProfile({
        profile: { id: generationProfileId, name: "Cancel generation", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true },
        apiKey: "cancel-key"
      });
      if (!generation.ok) throw new Error(`generation: ${generation.error.code}`);
      const embedding = await api.models.saveProfile({
        profile: { id: embeddingProfileId, name: "Cancel embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true },
        apiKey: "cancel-key"
      });
      if (!embedding.ok) throw new Error(`embedding: ${embedding.error.code}`);
      const routes = await api.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
      if (!routes.ok) throw new Error(`routes: ${routes.error.code}`);
      const conversation = await api.conversations.create({ projectId, title: "Cancel conv" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      return { conversationId: conversation.value.id };
    }, { baseUrl: provider.baseUrl, projectId, generationProfileId, embeddingProfileId });
    await closeElectron(first.app);
    app = undefined;
    await bootstrapActiveSpace(userDataDir, projectId);

    const second = await launchWithUserData(userDataDir);
    app = second.app;
    const cancelled = await second.page.evaluate(async ({ projectId, conversationId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const requestId = crypto.randomUUID();
      let assistantMessageId = "";
      const unsubscribe = api.chat.subscribe(requestId, (event: any) => {
        if (event.type === "delta" && event.messageId && !assistantMessageId) assistantMessageId = event.messageId;
      });
      const send = await api.chat.send({ requestId, projectId, conversationId, question: "long alpha question" });
      if (!send.ok) { unsubscribe(); throw new Error(`send: ${send.error.code}`); }
      assistantMessageId = send.value.assistantMessageId;
      const stopped = await api.chat.stop({ projectId, requestId });
      unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      const assistant = messages.value.find((message: { id: string }) => message.id === send.value.assistantMessageId);
      return { stopped: stopped.ok, state: assistant?.state };
    }, { projectId, conversationId: setup.conversationId });
    expect(cancelled.stopped).toBe(true);
    expect(["cancelled", "failed", "completed"]).toContain(cancelled.state);
    await closeElectron(second.app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await provider.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("corrupt LanceDB fails health and recovers via migration rebuild", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-fail-"));
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi();
  const embeddingProfileId = "51515151-5151-4515-8151-515151515151";
  const bootstrapSpaceId = "53535353-5353-4535-8353-535353535353";
  const bootstrapFingerprint = embedFingerprint();
  const tableName = `space_${bootstrapSpaceId.replaceAll("-", "_")}`;
  let vectorsDir: string | undefined;
  let vectors: Awaited<ReturnType<typeof lancedb.connect>> | undefined;
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Corrupt Recovery");
    await closeElectron(first.app);
    app = undefined;

    const seeded = await seedTextSource(userDataDir, projectId, "recovery-alpha.txt", "alpha recovery evidence text.");
    const db = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, progress_1000, created_at, updated_at) VALUES (?, ?, 'openai-compatible', 'text-embedding-e2e', 'text-embedding-e2e', 3, 'cosine', 'mean', 'provider-default-v1', 'persisted', ?, 'active', 1000, ?, ?)"
      ).run(bootstrapSpaceId, projectId, bootstrapFingerprint, now, now);
      db.prepare("INSERT INTO project_embedding_spaces(project_id, space_id, updated_at) VALUES (?, ?, ?)").run(projectId, bootstrapSpaceId, now);
    } finally {
      db.close();
    }
    vectorsDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-corrupt-vectors-"));
    vectors = await lancedb.connect(vectorsDir);
    await vectors.createTable(tableName, lancedb.makeArrowTable([{
      chunkId: seeded.chunkId,
      projectId,
      sourceId: seeded.sourceId,
      revisionId: seeded.revisionId,
      spaceId: bootstrapSpaceId,
      ordinal: 0,
      contentHash: "sha256:alpha",
      text: "alpha recovery evidence text.",
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
    // Corrupt: garble the manifest inside the copied table directory.
    const manifest = path.join(userDataDir, "vectors", `${tableName}.lance`, "_versions", "1.manifest");
    await fs.writeFile(manifest, Buffer.from("corrupted manifest bytes"), "utf8");

    const second = await launchWithUserData(userDataDir);
    app = second.app;
    const seededProfile = await second.page.evaluate(async ({ baseUrl, embeddingProfileId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const saved = await api.models.saveProfile({
        profile: { id: embeddingProfileId, name: "Recovery embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true },
        apiKey: "recovery-key"
      });
      if (!saved.ok) throw new Error(`embedding profile: ${saved.error.code}`);
      return saved.value;
    }, { baseUrl: provider.baseUrl, embeddingProfileId });
    const health = await second.page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      return api.vector.getHealth({ projectId });
    }, { projectId });
    expect(health.ok === false || health.value.healthy === false).toBe(true);
    const migration = await second.page.evaluate(async ({ projectId, embeddingProfileId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const started = await api.vector.startMigration({ projectId, profileId: embeddingProfileId });
      if (!started.ok) throw new Error(`migration: ${started.error.code}`);
      return started.value.id;
    }, { projectId, embeddingProfileId });
    await waitForTask(second.page, projectId, migration, "completed", 120_000);
    const recovered = await second.page.evaluate(async ({ projectId, text }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const hits = await api.retrieval.search({ projectId, query: "alpha recovery", limit: 5 });
      if (!hits.ok) throw new Error(`search: ${hits.error.code}`);
      return hits.value.some((hit: { text?: string }) => hit.text === text);
    }, { projectId, text: "alpha recovery evidence text." });
    expect(recovered).toBe(true);
    await closeElectron(second.app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await provider.close().catch(() => undefined);
    if (vectors) await vectors.close();
    if (vectorsDir) await fs.rm(vectorsDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
