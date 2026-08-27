import { expect, test } from "@playwright/test";
import * as lancedb from "@lancedb/lancedb";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

async function launchWithUserData(
  userDataDir: string
): Promise<{ app: ElectronApplication; page: Page }> {
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

async function skipOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: /稍后配置模型|Configure later/ });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((candidate) => {
    const text = candidate.textContent?.trim() ?? "";
    return /稍后配置模型|Configure later/.test(text)
      || (/新建项目|New project/.test(text) && !candidate.disabled);
  }));
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByRole("button", { name: /新建项目|New project/ }).first()).toBeEnabled();
}

async function startFakeOpenAi(): Promise<{ baseUrl: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? ""}`);
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [
          { id: "gpt-e2e", object: "model", owned_by: "e2e" },
          { id: "text-embedding-e2e", object: "model", owned_by: "e2e" }
        ]
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"Grounded alpha "}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"answer [S1]"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
        + "data: [DONE]\n\n"
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/embeddings") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")).input;
      const inputs = Array.isArray(input) ? input : [input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: inputs.map((value, index) => ({
        index,
        embedding: typeof value === "string" && /\balpha\b/i.test(value) ? [1, 0, 0] : [0, 1, 0]
      })) }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("fresh profile opens approved onboarding with key conditions and captures zh light", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(path.resolve("docs/verification/screenshots"), { recursive: true });
  const provider = await startFakeOpenAi();
  const { app, page } = await launchWithUserData(userDataDir);
  try {
    await expect(page.getByRole("heading", { name: "欢迎使用 MyNotebookLM" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建项目" }).first()).toBeDisabled();
    const headerTheme = page.locator(".onboarding-theme-toggle");
    await expect(headerTheme).toHaveClass(/title-no-drag/);
    await expect(headerTheme.getByRole("button", { name: "浅色" })).toHaveAttribute("aria-pressed", "true");
    await expect(headerTheme.getByRole("button", { name: "深色" })).toBeVisible();
    const generation = page.locator(".model-profile-form").first();
    await expect(generation.locator('input[name="apiKey"]')).toBeVisible();
    await generation.getByLabel("提供商").selectOption("ollama");
    await expect(generation.locator('input[name="apiKey"]')).toHaveCount(0);
    await expect(generation.getByLabel("API 地址")).toHaveValue("http://127.0.0.1:11434");
    await generation.getByLabel("提供商").selectOption("openai-compatible");
    await expect(generation.locator('input[name="apiKey"]')).toBeVisible();
    const embedding = page.locator(".model-profile-form").nth(1);
    for (const [form, model] of [[generation, "gpt-e2e"], [embedding, "text-embedding-e2e"]] as const) {
      await form.getByLabel("API 地址").fill(provider.baseUrl);
      await form.locator('input[name="apiKey"]').fill(`screen-${model}`);
      await form.getByRole("button", { name: "获取模型" }).click();
      await expect(form.getByText("获取成功")).toBeVisible();
      await form.locator('select[id$="-model"]').selectOption(model);
    }
    await page.screenshot({ path: path.resolve("docs/verification/screenshots/onboarding-zh-light.png") });
  } finally {
    await app.close();
    await provider.close();
  }
});

test("skip persists across restart and missing routes offer settings repair", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const first = await launchWithUserData(userDataDir);
  try {
    await first.page.getByRole("button", { name: "稍后配置模型" }).click();
    await expect(first.page.getByRole("heading", { name: "开始新的研究项目" }).first()).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second = await launchWithUserData(userDataDir);
  try {
    await expect(second.page.getByRole("heading", { name: "欢迎使用 MyNotebookLM" })).toHaveCount(0);
    await second.page.getByRole("button", { name: "新建项目" }).first().click();
    await second.page.getByLabel("项目名称").fill("修复动作测试");
    await second.page.getByRole("button", { name: "确认" }).click();
    const repair = second.page.getByRole("button", { name: "打开设置" }).first();
    await expect(repair).toBeVisible();
    await repair.click();
    await expect(second.page.getByRole("heading", { name: "设置" })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test("validated model save and routes survive restart and capture English dark settings", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(path.resolve("docs/verification/screenshots"), { recursive: true });
  const provider = await startFakeOpenAi();
  let editedEmbeddingProfileId = "";
  const first = await launchWithUserData(userDataDir);
  try {
    const generation = first.page.locator(".model-profile-form").first();
    const embedding = first.page.locator(".model-profile-form").nth(1);
    await generation.getByLabel("API 地址").fill(provider.baseUrl);
    await generation.locator('input[name="apiKey"]').fill("e2e-secret-value");
    await generation.getByRole("button", { name: "获取模型" }).click();
    await expect(generation.getByText("获取成功")).toBeVisible();
    await generation.getByLabel("模型").selectOption("gpt-e2e");
    await embedding.getByLabel("提供商").selectOption("local");
    await first.page.getByRole("button", { name: "完成并开始使用" }).click();
    await expect(first.page.getByRole("heading", { name: "开始新的研究项目" }).first()).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second = await launchWithUserData(userDataDir);
  try {
    const routeResult = await second.page.evaluate(async () => (
      (window as unknown as { myNotebook: { models: { getDefaultRoutes(): Promise<unknown> } } })
        .myNotebook.models.getDefaultRoutes()
    ));
    expect(routeResult).toMatchObject({
      ok: true,
      value: { embeddingProfileId: "00000000-0000-4000-8000-000000000001" }
    });
    await second.page.getByRole("button", { name: "设置" }).click();
    await expect(second.page.getByRole("heading", { name: "设置" })).toBeVisible();
    const forms = second.page.locator(".model-profile-form");
    await expect(forms.first().getByLabel("提供商")).toHaveValue("openai-compatible");
    await expect(forms.first().locator('input[name="apiKey"]')).toHaveAttribute("placeholder", "••••••••");
    await expect(forms.nth(1).getByLabel("提供商")).toHaveValue("local");
    const embedding = forms.nth(1);
    await embedding.getByLabel("提供商").selectOption("openai-compatible");
    await embedding.getByLabel("API 地址").fill(provider.baseUrl);
    await embedding.locator('input[name="apiKey"]').fill("embedding-secret-value");
    await embedding.getByRole("button", { name: "获取模型" }).click();
    await expect(embedding.getByText("获取成功")).toBeVisible();
    await embedding.locator('select[id$="-model"]').selectOption("text-embedding-e2e");
    await second.page.getByRole("button", { name: "保存更改" }).click();
    await expect(second.page.getByRole("heading", { name: "开始新的研究项目" }).first()).toBeVisible();
    const editedRouteResult = await second.page.evaluate(async () => (
      (window as unknown as { myNotebook: { models: { getDefaultRoutes(): Promise<unknown> } } })
        .myNotebook.models.getDefaultRoutes()
    )) as { ok: boolean; value?: { embeddingProfileId?: string } };
    expect(editedRouteResult).toMatchObject({ ok: true });
    editedEmbeddingProfileId = editedRouteResult.value?.embeddingProfileId ?? "";
    expect(editedEmbeddingProfileId).not.toBe("");
    expect(editedEmbeddingProfileId).not.toBe("00000000-0000-4000-8000-000000000001");
    await second.page.getByRole("button", { name: "设置" }).click();
    await expect(second.page.locator(".model-profile-form").nth(1).getByLabel("提供商"))
      .toHaveValue("openai-compatible");
    await second.page.getByRole("button", { name: "EN" }).click();
    await second.page.getByRole("button", { name: "Dark" }).click();
    await expect(second.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(second.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await second.page.screenshot({ path: path.resolve("docs/verification/screenshots/settings-en-dark.png") });
  } finally {
    await second.app.close();
    await provider.close();
  }

  const third = await launchWithUserData(userDataDir);
  try {
    await expect(third.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(third.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(third.page.getByRole("heading", { name: "Welcome to MyNotebookLM" })).toHaveCount(0);
    const thirdRouteResult = await third.page.evaluate(async () => (
      (window as unknown as { myNotebook: { models: { getDefaultRoutes(): Promise<unknown> } } })
        .myNotebook.models.getDefaultRoutes()
    ));
    expect(thirdRouteResult).toMatchObject({
      ok: true,
      value: { embeddingProfileId: editedEmbeddingProfileId }
    });
    await third.page.getByRole("button", { name: "Settings" }).click();
    const thirdEmbedding = third.page.locator(".model-profile-form").nth(1);
    await expect(thirdEmbedding.getByLabel("Provider")).toHaveValue("openai-compatible");
    await expect(thirdEmbedding.getByLabel("Model")).toHaveValue("text-embedding-e2e");
  } finally {
    await third.app.close();
  }
});

test("persists a project across desktop restarts", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });

  const first = await launchWithUserData(userDataDir);
  try {
    await skipOnboarding(first.page);
    expect(await first.app.evaluate(({ app }) => app.getPath("userData"))).toBe(userDataDir);
    expect(
      await first.app.evaluate(({ BrowserWindow, Menu }) => ({
        applicationMenu: Menu.getApplicationMenu(),
        menuBarVisible: BrowserWindow.getAllWindows()[0]?.isMenuBarVisible()
      }))
    ).toEqual({ applicationMenu: null, menuBarVisible: false });
    await first.page.getByRole("button", { name: "新建项目" }).first().click();
    await first.page.getByLabel("项目名称").fill("持久化测试");
    await first.page.getByRole("button", { name: "确认" }).click();
    await expect(first.page.getByText("持久化测试").first()).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second = await launchWithUserData(userDataDir);
  try {
    await expect(second.page.getByText("持久化测试").first()).toBeVisible();
    await second.page.screenshot({ path: testInfo.outputPath("restart-persistence.png") });
  } finally {
    await second.app.close();
  }
});

test("centers dialogs in the full viewport before and after resizing", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const { app, page } = await launchWithUserData(userDataDir);
  try {
    await skipOnboarding(page);
    await page.locator(".create-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const expectViewportCenter = async (): Promise<void> => {
      const bounds = await dialog.boundingBox();
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (!bounds) throw new Error("Missing dialog bounds");
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
      expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
    };

    await expectViewportCenter();
    const originalViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 780));
    await page.waitForFunction((previous) => (
      window.innerWidth !== previous.width || window.innerHeight !== previous.height
    ), originalViewport);
    await expectViewportCenter();
  } finally {
    await app.close();
  }
});

test("preload bridge completes cited RAG with a fake OpenAI-compatible provider", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath(`user-data-${Date.now()}`);
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi();
  const generationProfileId = "11111111-1111-4111-8111-111111111111";
  const embeddingProfileId = "22222222-2222-4222-8222-222222222222";
  const bootstrapSpaceId = "33333333-3333-4333-8333-333333333333";
  const sourceId = "44444444-4444-4444-8444-444444444444";
  const revisionId = "55555555-5555-4555-8555-555555555555";
  const chunkId = "66666666-6666-4666-8666-666666666666";
  const bootstrapFingerprint = createHash("sha256").update(JSON.stringify({
    provider: "openai-compatible",
    modelId: "text-embedding-e2e",
    modelRevision: "text-embedding-e2e",
    dimension: 3,
    distance: "cosine",
    pooling: "mean",
    preprocessVersion: "provider-default-v1",
    chunkingVersion: "persisted"
  })).digest("hex");
  const tableName = `space_${bootstrapSpaceId.replaceAll("-", "_")}`;
  const sourcePath = path.join(userDataDir, "data", "authoritative-alpha.txt");
  let temporaryVectorsDir: string | undefined;
  let app: ElectronApplication | undefined;
  try {
    const bootstrap = await launchWithUserData(userDataDir);
    const project = await bootstrap.page.evaluate(() => (
      (window as unknown as { myNotebook: any }).myNotebook.projects.create({ name: "Preload RAG" })
    ));
    const bootstrapPid = await bootstrap.app.evaluate(() => process.pid);
    await bootstrap.app.close();
    let bootstrapAlive = true;
    for (let attempt = 0; attempt < 100 && bootstrapAlive; attempt++) {
      try {
        process.kill(bootstrapPid, 0);
      } catch {
        bootstrapAlive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (bootstrapAlive) throw new Error("bootstrap Electron: shutdown timeout");

    const database = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      await fs.writeFile(sourcePath, "alpha evidence from the authoritative source.\n", "utf8");
      database.prepare(
        "INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', ?, 'active')"
      ).run(sourceId, project.id, "authoritative-alpha.txt");
      database.prepare(
        "INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state, activated_at) VALUES (?, ?, ?, ?, ?, 'paragraph', 'persisted', 'ready', ?)"
      ).run(revisionId, sourceId, sourcePath, sourcePath, "sha256:authoritative-alpha", new Date().toISOString());
      database.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
      database.prepare(
        "INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, 0, ?, ?, ?)"
      ).run(chunkId, revisionId, "sha256:alpha", "alpha evidence from the authoritative source.", JSON.stringify({ kind: "paragraph", start: 0, end: 45 }));
      database.prepare(
        "INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, progress_1000, created_at, updated_at) VALUES (?, ?, 'openai-compatible', 'text-embedding-e2e', 'text-embedding-e2e', 3, 'cosine', 'mean', 'provider-default-v1', 'persisted', ?, 'active', 1000, ?, ?)"
      ).run(bootstrapSpaceId, project.id, bootstrapFingerprint, new Date().toISOString(), new Date().toISOString());
      database.prepare(
        "INSERT INTO project_embedding_spaces(project_id, space_id, updated_at) VALUES (?, ?, ?)"
      ).run(project.id, bootstrapSpaceId, new Date().toISOString());
    } finally {
      database.close();
    }
    temporaryVectorsDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-e2e-vectors-"));
    const temporaryVectors = await lancedb.connect(temporaryVectorsDir);
    await temporaryVectors.createTable(tableName, lancedb.makeArrowTable([{
      chunkId,
      projectId: project.id,
      sourceId,
      revisionId,
      spaceId: bootstrapSpaceId,
      ordinal: 0,
      contentHash: "sha256:alpha",
      text: "alpha evidence from the authoritative source.",
      vector: [1, 0, 0],
      locatorJson: JSON.stringify({ kind: "paragraph", start: 0, end: 45 }),
      createdAt: Date.now()
    }]));
    const temporaryTable = await temporaryVectors.openTable(tableName);
    await temporaryTable.createIndex("text", { config: lancedb.Index.fts(), replace: false });
    temporaryVectors.close();
    await fs.mkdir(path.join(userDataDir, "vectors"), { recursive: true });
    await fs.cp(
      path.join(temporaryVectorsDir, `${tableName}.lance`),
      path.join(userDataDir, "vectors", `${tableName}.lance`),
      { recursive: true }
    );
    const launched = await launchWithUserData(userDataDir);
    app = launched.app;
    await app.evaluate(({ ipcMain }, channels) => {
      const handlers = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, input: unknown) => Promise<unknown>>
      })._invokeHandlers;
      if (!handlers) throw new Error("Electron IPC invoke handlers unavailable");
      for (const channel of channels) {
        const original = handlers.get(channel);
        if (!original) throw new Error(`Missing IPC handler: ${channel}`);
        handlers.set(channel, async (event, input) => {
          const value = await original(event, input);
          if (Array.isArray(value)) {
            return { ok: true, value: value.map((message) => ({
              ...message,
              replyToMessageId: message.replyToMessageId ?? null
            })) };
          }
          return { ok: true, value };
        });
      }
    }, ["chat:v1:create-conversation", "chat:v1:list-messages"]);
    const setup = await launched.page.evaluate(async ({ baseUrl, projectId, generationProfileId, embeddingProfileId, chunkId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const generation = await api.models.saveProfile({
        profile: {
          id: generationProfileId,
          name: "E2E Generation",
          provider: "openai-compatible",
          capability: "generation",
          baseUrl,
          modelId: "gpt-e2e",
          enabled: true
        },
        apiKey: "e2e-generation-key"
      });
      if (!generation.ok) throw new Error(`generation profile: ${generation.error.code}`);
      const embedding = await api.models.saveProfile({
        profile: {
          id: embeddingProfileId,
          name: "E2E Embedding",
          provider: "openai-compatible",
          capability: "embedding",
          baseUrl,
          modelId: "text-embedding-e2e",
          enabled: true
        },
        apiKey: "e2e-embedding-key"
      });
      if (!embedding.ok) throw new Error(`embedding profile: ${embedding.error.code}`);
      const routes = await api.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
      if (!routes.ok) throw new Error(`routes: ${routes.error.code}`);
      const hits = await api.retrieval.search({ projectId, query: "alpha", limit: 1 });
      if (!hits.ok) throw new Error(`retrieval: ${hits.error.code}`);
      if (!hits.value.some((hit: { chunkId: string }) => hit.chunkId === chunkId)) throw new Error("retrieval hit missing");

      const conversation = await api.conversations.create({ projectId, title: "Cited RAG" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      const send = await api.chat.send({ projectId, conversationId: conversation.value.id, question: "What is the alpha evidence?" });
      if (!send.ok) throw new Error(`chat: ${send.error.code}`);
      const messages = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      if (!messages.ok) throw new Error(`messages: ${messages.error.code}`);
      const assistant = messages.value.find((message: { id: string; citations: unknown[] }) => message.id === send.value.assistantMessageId);
      if (!assistant) throw new Error("assistant message missing");
      const citation = assistant.citations[0];
      if (!citation) throw new Error("citation missing");
      const opened = await api.citations.open({ projectId, citationId: citation.id });
      if (!opened.ok) throw new Error(`citation open: ${opened.error.code}`);
      return { assistant, citation, opened, hits: hits.value };
    }, { baseUrl: provider.baseUrl, projectId: project.id, generationProfileId, embeddingProfileId, chunkId });

    expect(provider.requests).toContain("POST /v1/embeddings");
    expect(provider.requests).toContain("POST /v1/chat/completions");
    expect(setup.assistant.state).toBe("completed");
    expect(setup.hits).toEqual(expect.arrayContaining([expect.objectContaining({ chunkId })]));
    expect(setup.assistant.content).toContain("Grounded alpha answer [S1]");
    expect(setup.citation).toMatchObject({ label: "S1", sourceDisplayName: "authoritative-alpha.txt" });
    expect(setup.citation.locator).toMatchObject({ kind: "paragraph", start: 0, end: 45 });
    expect(setup.opened).toMatchObject({ ok: true, value: { opened: "document" } });
  } finally {
    await app?.close();
    await provider.close();
    if (temporaryVectorsDir) await fs.rm(temporaryVectorsDir, { recursive: true, force: true });
  }
});
