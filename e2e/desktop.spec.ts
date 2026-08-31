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

type FakeOpenAiRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
};

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

async function closeElectron(app: ElectronApplication): Promise<void> {
  const pid = await app.evaluate(() => process.pid);
  await app.close();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Electron ${pid}: shutdown timeout`);
}

async function captureRoutingScreenshot(page: Page, filePath: string): Promise<void> {
  await page.evaluate(() => { document.documentElement.style.zoom = "0.85"; });
  const scroll = await page.locator(".settings-model-content").evaluate((element) => {
    const route = element.querySelector<HTMLElement>(".route-settings");
    if (route) {
      element.scrollTop += route.getBoundingClientRect().top - element.getBoundingClientRect().top;
    }
    return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight, routeTop: route?.getBoundingClientRect().top ?? 0, contentTop: element.getBoundingClientRect().top };
  });
  console.log(`Task7 screenshot scroll=${scroll.top} max=${scroll.max} routeTop=${scroll.routeTop} contentTop=${scroll.contentTop}`);
  await page.screenshot({ path: filePath });
  const image = await fs.readFile(filePath);
  expect(image.readUInt32BE(16)).toBe(1803);
  expect(image.readUInt32BE(20)).toBe(1128);
}

async function expectReachableAtCurrentZoom(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  // Window restore/zoom relayout can settle after scrollIntoView; retry the
  // measurement loop instead of failing on a mid-layout snapshot.
  await expect(async () => {
    await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (!box) throw new Error("missing control bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }).toPass({ timeout: 5_000 });
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

async function startFakeOpenAi(options: { chatDelayMs?: number } = {}): Promise<{ baseUrl: string; requests: FakeOpenAiRequest[]; close(): Promise<void> }> {
  const requests: FakeOpenAiRequest[] = [];
  const server = http.createServer(async (request, response) => {
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    }
    requests.push({ method: request.method ?? "?", path: request.url ?? "", headers: request.headers, body });
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
      if (options.chatDelayMs) await new Promise((resolve) => setTimeout(resolve, options.chatDelayMs));
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
      const input = body?.input;
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

test("Task 7 model routing saves ordered fallbacks and a single embedding profile", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(path.resolve("docs/verification/screenshots"), { recursive: true });
  const provider = await startFakeOpenAi();
  const generationProfileId = "77777777-7777-4777-8777-777777777771";
  const fallbackProfileId = "77777777-7777-4777-8777-777777777772";
  const embeddingPrimaryId = "77777777-7777-4777-8777-777777777773";
  const embeddingSecondaryId = "77777777-7777-4777-8777-777777777774";
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchWithUserData(userDataDir);
    app = launched.app;
    const page = launched.page;
    await page.setViewportSize({ width: 1803, height: 1128 });
    await skipOnboarding(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await page.getByLabel("项目名称").fill("Task 7 routing");
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("Task 7 routing").first()).toBeVisible();
    const fixture = await page.evaluate(async ({ baseUrl, generationProfileId, fallbackProfileId, embeddingPrimaryId, embeddingSecondaryId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const profiles = [
        { id: generationProfileId, name: "Task7 Primary", capability: "generation", modelId: "gpt-e2e" },
        { id: fallbackProfileId, name: "Task7 Fallback", capability: "generation", modelId: "gpt-e2e-fallback" },
        { id: embeddingPrimaryId, name: "Task7 Embedding A", capability: "embedding", modelId: "text-embedding-e2e" },
        { id: embeddingSecondaryId, name: "Task7 Embedding B", capability: "embedding", modelId: "text-embedding-e2e-secondary" }
      ];
      for (const profile of profiles) {
        const saved = await api.models.saveProfile({
          profile: { ...profile, provider: "openai-compatible", baseUrl, enabled: true },
          apiKey: "task7-fixture-key"
        });
        if (!saved.ok) throw new Error(`profile save failed: ${saved.error.code}`);
      }
      const defaults = await api.models.setDefaultRoutes({ generationProfileId, embeddingProfileId: embeddingPrimaryId });
      if (!defaults.ok) throw new Error(`default routes failed: ${defaults.error.code}`);
      return { generationProfileId, fallbackProfileId, embeddingPrimaryId, embeddingSecondaryId };
    }, { baseUrl: provider.baseUrl, generationProfileId, fallbackProfileId, embeddingPrimaryId, embeddingSecondaryId });

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "Task routing" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Add fallback" })).toBeEnabled();
    await page.getByRole("button", { name: "Add fallback" }).click();
    await expect(page.locator(".route-list li")).toHaveCount(2);
    await page.getByRole("button", { name: "Save route" }).click();
    const savedChat = await page.evaluate(async () => (window as unknown as { myNotebook: any }).myNotebook.models.getRoutes({ taskKind: "chat" }));
    expect(savedChat).toMatchObject({ ok: true, value: [
      { taskKind: "chat", position: 0, profileId: fixture.generationProfileId },
      { taskKind: "chat", position: 1, profileId: fixture.fallbackProfileId }
    ] });
    await captureRoutingScreenshot(page, path.resolve("docs/verification/screenshots/model-routing-en-dark.png"));

    await page.locator("#route-task").selectOption("embedding");
    const embeddingSelector = page.getByLabel("Embedding profile");
    await expect(embeddingSelector).toBeVisible();
    await embeddingSelector.selectOption(fixture.embeddingSecondaryId);
    await page.getByRole("button", { name: "Save route" }).click();
    const savedEmbedding = await page.evaluate(async () => (window as unknown as { myNotebook: any }).myNotebook.models.getRoutes({ taskKind: "embedding" }));
    expect(savedEmbedding).toMatchObject({ ok: true, value: [{ taskKind: "embedding", position: 0, profileId: fixture.embeddingSecondaryId }] });
    await captureRoutingScreenshot(page, path.resolve("docs/verification/screenshots/model-routing-embedding-en-dark.png"));
    await closeElectron(app);
    app = undefined;

    const restarted = await launchWithUserData(userDataDir);
    app = restarted.app;
    await restarted.page.getByRole("button", { name: /设置|Settings/, exact: true }).click();
    await expect(restarted.page.getByRole("heading", { name: /任务路由|Task routing/ })).toBeVisible({ timeout: 15_000 });
    await restarted.page.getByRole("button", { name: "EN", exact: true }).click();
    await restarted.page.getByRole("button", { name: "Dark", exact: true }).click();
    const persistedChat = await restarted.page.evaluate(async () => (window as unknown as { myNotebook: any }).myNotebook.models.getRoutes({ taskKind: "chat" }));
    expect(persistedChat).toMatchObject({ ok: true, value: [
      { taskKind: "chat", position: 0, profileId: fixture.generationProfileId },
      { taskKind: "chat", position: 1, profileId: fixture.fallbackProfileId }
    ] });
    await restarted.page.locator("#route-task").selectOption("embedding");
    await expect(restarted.page.getByLabel("Embedding profile")).toHaveValue(fixture.embeddingSecondaryId);
    const persistedEmbedding = await restarted.page.evaluate(async () => (window as unknown as { myNotebook: any }).myNotebook.models.getRoutes({ taskKind: "embedding" }));
    expect(persistedEmbedding).toMatchObject({ ok: true, value: [{ taskKind: "embedding", position: 0, profileId: fixture.embeddingSecondaryId }] });
  } finally {
    if (app) await closeElectron(app);
    await provider.close();
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

test("persists language and theme selected in the UI across restart", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const first = await launchWithUserData(userDataDir);
  await skipOnboarding(first.page);
  await first.page.getByRole("button", { name: "深色", exact: true }).click();
  await first.page.getByRole("button", { name: "English", exact: true }).click();
  await closeElectron(first.app);

  const second = await launchWithUserData(userDataDir);
  try {
    await expect(second.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(second.page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    await closeElectron(second.app);
  }
});

test("Task 8 restart recovery retains selected project, appearance, and notes", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi({ chatDelayMs: 5000 });
  let first = await launchWithUserData(userDataDir);
  let selectedProjectId = "";
  let conversationId = "";
  let assistantMessageId = "";
  let assistantContent = "";
  let noteId = "";
  let migrationTaskId = "";
  let inProgressTaskId = "";
  try {
    await skipOnboarding(first.page);
    await first.page.getByRole("button", { name: "新建项目" }).first().click();
    await first.page.getByLabel("项目名称").fill("恢复项目 A");
    await first.page.getByRole("button", { name: "确认" }).click();
    await first.page.getByRole("button", { name: "新建项目" }).first().click();
    await first.page.getByLabel("项目名称").fill("恢复项目 B");
    await first.page.getByRole("button", { name: "确认" }).click();
    await first.page.getByText("恢复项目 B").first().click();
    const seedProject = await first.page.evaluate(async () => (await (window as unknown as { myNotebook: any }).myNotebook.projects.list()).find((item: { name: string }) => item.name === "恢复项目 B"));
    if (!seedProject) throw new Error("seed project missing");
    await first.app.close();
    const seedDatabase = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
      const revisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
      const chunkId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
      const now = new Date().toISOString();
      seedDatabase.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', ?, 'active')").run(sourceId, seedProject.id, "Recovery source");
      seedDatabase.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state, activated_at) VALUES (?, ?, ?, ?, ?, 'paragraph', 'persisted', 'ready', ?)").run(revisionId, sourceId, "recovery-source.txt", "recovery-source.txt", "sha256:recovery-source", now);
      seedDatabase.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
      seedDatabase.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, 0, ?, ?, ?)").run(chunkId, revisionId, "sha256:recovery-chunk", "Persisted recovery source evidence.", JSON.stringify({ kind: "paragraph", paragraph: 1 }));
    } finally {
      seedDatabase.close();
    }
    first = await launchWithUserData(userDataDir);
    const recovery = await first.page.evaluate(async ({ baseUrl }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const project = (await api.projects.list()).find((item: { name: string }) => item.name === "恢复项目 B");
      if (!project) throw new Error("selected project missing");
      const settings = await api.settings.update({ locale: "en", theme: "dark" });
      if (!settings.ok) throw new Error(`settings: ${settings.error.code}`);
      const note = await api.notes?.create({ projectId: project.id, title: "Recovered note", body: "# Persisted evidence" });
      if (!note?.ok) throw new Error(`note: ${note?.error?.code ?? "unavailable"}`);
      const conversation = await api.conversations.create({ projectId: project.id, title: "Recovered conversation" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      const embedding = await api.models.saveProfile({ profile: { id: "99999999-9999-4999-8999-999999999991", name: "Recovery embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true }, apiKey: "recovery-key" });
      if (!embedding.ok) throw new Error(`embedding: ${embedding.error.code}`);
      const generation = await api.models.saveProfile({ profile: { id: "99999999-9999-4999-8999-999999999992", name: "Recovery generation", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true }, apiKey: "recovery-key" });
      if (!generation.ok) throw new Error(`generation: ${generation.error.code}`);
      const route = await api.models.setDefaultRoutes({ generationProfileId: generation.value.id, embeddingProfileId: embedding.value.id });
      if (!route.ok) throw new Error(`route: ${route.error.code}`);
      const migration = await api.vector.startMigration({ projectId: project.id, profileId: embedding.value.id });
      if (!migration.ok) throw new Error(`migration: ${migration.error.code}`);
      return { projectId: project.id, conversationId: conversation.value.id, noteId: note.value.id, migrationTaskId: migration.value.id };
    }, { baseUrl: provider.baseUrl });
    selectedProjectId = recovery.projectId;
    conversationId = recovery.conversationId;
    noteId = recovery.noteId;
    migrationTaskId = recovery.migrationTaskId;
    await expect.poll(async () => first.page.evaluate(async ({ projectId }) => {
      const tasks = await (window as unknown as { myNotebook: any }).myNotebook.tasks.list({ projectId });
      return tasks.find((task: { kind: string }) => task.kind === "validation")?.state;
    }, { projectId: selectedProjectId }), { timeout: 60_000 }).toBe("completed");
    await expect.poll(async () => first.page.evaluate(async ({ projectId, taskId }) => {
      const tasks = await (window as unknown as { myNotebook: any }).myNotebook.tasks.list({ projectId });
      return tasks.find((task: { id: string }) => task.id === taskId)?.state;
    }, { projectId: selectedProjectId, taskId: migrationTaskId }), { timeout: 60_000 }).toBe("completed");
    const chat = await first.page.evaluate(async ({ projectId, conversationId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const requestId = crypto.randomUUID();
      const unsubscribe = api.chat.subscribe(requestId, () => undefined);
      const sent = await api.chat.send({ requestId, projectId, conversationId, question: "Persisted recovery chat" });
      unsubscribe();
      if (!sent.ok) throw new Error(`chat: ${sent.error.code}`);
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      if (!messages.ok) throw new Error(`messages: ${messages.error.code}`);
      const assistant = messages.value.find((message: { id: string }) => message.id === sent.value.assistantMessageId);
      if (!assistant || assistant.role !== "assistant" || assistant.state !== "completed" || !assistant.content) throw new Error("completed recovery chat missing");
      return { assistantMessageId: assistant.id, assistantContent: assistant.content };
    }, { projectId: selectedProjectId, conversationId });
    assistantMessageId = chat.assistantMessageId;
    assistantContent = chat.assistantContent;
    const transformation = await first.page.evaluate(async ({ projectId, noteId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const rule = await api.transformations.createRule({ projectId, name: "Recovery note summary", appliesTo: "note", prompt: "Summarize this note:\n\n{{content}}" });
      if (!rule.ok) throw new Error(`rule: ${rule.error.code}`);
      const started = await api.transformations.run({ projectId, transformationId: rule.value.id, noteId });
      if (!started.ok) throw new Error(`transformation: ${started.error.code}`);
      return started.value.id;
    }, { projectId: selectedProjectId, noteId });
    inProgressTaskId = transformation;
    await expect.poll(async () => first.page.evaluate(async ({ projectId, taskId }) => {
      const tasks = await (window as unknown as { myNotebook: any }).myNotebook.tasks.list({ projectId });
      return tasks.find((task: { id: string }) => task.id === taskId)?.state;
    }, { projectId: selectedProjectId, taskId: inProgressTaskId }), { timeout: 10_000 }).toBe("running");
  } finally {
    await first.app.close();
  }
  const database = new Database(path.join(userDataDir, "data", "app.db"));
  try {
    expect(database.prepare("SELECT state FROM embedding_spaces es JOIN project_embedding_spaces pes ON pes.space_id = es.id WHERE pes.project_id = ?").get(selectedProjectId)).toMatchObject({ state: "active" });
  } finally {
    database.close();
  }

  const second = await launchWithUserData(userDataDir);
  try {
    await expect(second.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(second.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(second.page.locator(`.project-select[aria-current="page"]`)).toContainText("恢复项目 B");
    await expect(second.page.getByRole("button", { name: "Configure later", exact: true })).toHaveCount(0);
    await expect(second.page.getByRole("tab", { name: "Research", exact: true })).toBeVisible();
    const recovered = await second.page.evaluate(async ({ projectId, conversationId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const notes = await api.notes.list({ projectId });
      const conversations = await api.conversations.list({ projectId });
      const tasks = await api.tasks?.list({ projectId });
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      return { notes, conversations, tasks, messages };
    }, { projectId: selectedProjectId, conversationId });
    expect(recovered.notes).toMatchObject({ ok: true, value: [expect.objectContaining({ title: "Recovered note" })] });
    expect(recovered.conversations).toMatchObject({ ok: true, value: [expect.objectContaining({ title: "Recovered conversation" })] });
    expect(recovered.tasks).toBeInstanceOf(Array);
    expect(recovered.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "validation", state: "completed" })]));
    expect(recovered.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: inProgressTaskId, kind: "transformation", state: "running" })]));
    expect(recovered.messages).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ id: assistantMessageId, role: "assistant", state: "completed", content: assistantContent })]) });
    const restartedDatabase = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      expect(restartedDatabase.prepare("SELECT state FROM embedding_spaces es JOIN project_embedding_spaces pes ON pes.space_id = es.id WHERE pes.project_id = ?").get(selectedProjectId)).toMatchObject({ state: "active" });
    } finally {
      restartedDatabase.close();
    }
    await second.page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    const settingsButton = second.page.getByRole("button", { name: "Settings", exact: true });
    await expectReachableAtCurrentZoom(second.page, settingsButton);
    await settingsButton.click();
    const settingsSave = second.page.getByRole("button", { name: "Save changes", exact: true });
    await expectReachableAtCurrentZoom(second.page, settingsSave);
    await second.page.getByRole("button", { name: "Cancel", exact: true }).click();

    const notesTab = second.page.getByRole("tab", { name: "Notes", exact: true });
    await expectReachableAtCurrentZoom(second.page, notesTab);
    await notesTab.click();
    await expect(second.page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
    await expectReachableAtCurrentZoom(second.page, second.page.getByRole("button", { name: "Save note", exact: true }));

    const transformationsTab = second.page.getByRole("tab", { name: "Transformations", exact: true });
    await expectReachableAtCurrentZoom(second.page, transformationsTab);
    await transformationsTab.click();
    await expect(second.page.getByRole("heading", { name: "Transformations", exact: true })).toBeVisible();
    await second.page.getByRole("button", { name: "New custom rule", exact: true }).click();
    const ruleDialog = second.page.locator(".rule-dialog");
    await expect(ruleDialog).toHaveAttribute("role", "dialog");
    await expect(ruleDialog.getByRole("heading", { name: "New custom rule", exact: true })).toBeVisible();
    await expectReachableAtCurrentZoom(second.page, ruleDialog.getByRole("button", { name: "Save changes", exact: true }));
    await ruleDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await second.page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  } finally {
    await second.app.close();
    await provider.close();
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

test("Task 8 real Electron RAG with fake provider and 200% chat zoom evidence", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataDir = testInfo.outputPath(`user-data-${Date.now()}`);
  await fs.mkdir(userDataDir, { recursive: true });
  const screenshotDir = testInfo.outputPath("screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
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
  let temporaryVectors: Awaited<ReturnType<typeof lancedb.connect>> | undefined;
  let app: ElectronApplication | undefined;
  try {
    const bootstrap = await launchWithUserData(userDataDir);
    const project = await bootstrap.page.evaluate(() => (
      (window as unknown as { myNotebook: any }).myNotebook.projects.create({ name: "Preload RAG" })
    ));
    await bootstrap.page.getByRole("button", { name: "稍后配置模型" }).click();
    await closeElectron(bootstrap.app);

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
      ).run(chunkId, revisionId, "sha256:alpha", "alpha evidence from the authoritative source.", JSON.stringify({ kind: "paragraph", paragraph: 1 }));
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
    temporaryVectors = await lancedb.connect(temporaryVectorsDir);
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
      locatorJson: JSON.stringify({ kind: "paragraph", paragraph: 1 }),
      createdAt: Date.now()
    }]));
    const temporaryTable = await temporaryVectors.openTable(tableName);
    await temporaryTable.createIndex("text", { config: lancedb.Index.fts(), replace: false });
    await temporaryVectors.close();
    temporaryVectors = undefined;
    await fs.mkdir(path.join(userDataDir, "vectors"), { recursive: true });
    await fs.cp(
      path.join(temporaryVectorsDir, `${tableName}.lance`),
      path.join(userDataDir, "vectors", `${tableName}.lance`),
      { recursive: true }
    );
    const launched = await launchWithUserData(userDataDir);
    app = launched.app;
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
      const requestId = crypto.randomUUID();
      const events: any[] = [];
      const unsubscribe = api.chat.subscribe(requestId, (event: any) => { events.push(event); });
      const send = await api.chat.send({ requestId, projectId, conversationId: conversation.value.id, question: "What is the alpha evidence?" });
      unsubscribe();
      if (!send.ok) throw new Error(`chat: ${send.error.code}`);
      const messages = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      if (!messages.ok) throw new Error(`messages: ${messages.error.code}`);
      const assistant = messages.value.find((message: { id: string }) => message.id === send.value.assistantMessageId);
      if (!assistant || assistant.state !== "completed") throw new Error("completed assistant message missing");
      return {
        projectId,
        conversationId: conversation.value.id,
        assistantMessageId: send.value.assistantMessageId,
        hits: hits.value,
        requestId,
        events
      };
    }, { baseUrl: provider.baseUrl, projectId: project.id, generationProfileId, embeddingProfileId, chunkId });

    const embeddingRequests = provider.requests.filter((request) => request.path === "/v1/embeddings");
    expect(embeddingRequests.length).toBeGreaterThan(0);
    expect(embeddingRequests.every((request) => request.body?.model === "text-embedding-e2e")).toBe(true);
    const embeddingRequest = embeddingRequests.find((request) => (
      Array.isArray(request.body?.input) && request.body.input.includes("alpha")
    ));
    expect(embeddingRequest).toBeDefined();
    expect(embeddingRequest!.headers["content-type"]).toContain("application/json");
    expect(embeddingRequest!.headers.authorization).toMatch(/^Bearer \S+$/);
    expect(embeddingRequest!.body).toMatchObject({ model: "text-embedding-e2e" });
    expect(embeddingRequest!.body?.input).toEqual(expect.arrayContaining(["alpha"]));
    const chatRequests = provider.requests.filter((request) => request.path === "/v1/chat/completions");
    expect(chatRequests.length).toBeGreaterThan(0);
    expect(chatRequests.every((request) => request.body?.model === "gpt-e2e")).toBe(true);
    const chatRequest = chatRequests.find((request) => (
      Array.isArray(request.body?.messages)
      && request.body.messages.some((message) => (
        typeof message === "object" && message !== null
        && "content" in message && typeof message.content === "string"
        && message.content.includes('<evidence id="S1">')
      ))
    ));
    expect(chatRequest).toBeDefined();
    expect(chatRequest!.headers["content-type"]).toContain("application/json");
    expect(chatRequest!.headers.authorization).toMatch(/^Bearer \S+$/);
    expect(chatRequest!.body).toMatchObject({ model: "gpt-e2e" });
    const chatMessages = chatRequest!.body?.messages as Array<{ role: string; content: string }>;
    expect(chatMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "system", content: expect.stringContaining("only cite markers S1..S12") }),
      expect.objectContaining({ role: "user", content: expect.stringContaining('<evidence id="S1">') }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("alpha evidence") })
    ]));
    expect(setup.hits).toEqual(expect.arrayContaining([expect.objectContaining({ chunkId })]));
    await closeElectron(app);
    app = undefined;

    const restarted = await launchWithUserData(userDataDir);
    app = restarted.app;
    const persisted = await restarted.page.evaluate(async ({ projectId, conversationId, assistantMessageId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      if (!messages.ok) throw new Error(`messages: ${messages.error.code}`);
      const assistant = messages.value.find((message: { id: string; citations: unknown[] }) => message.id === assistantMessageId);
      if (!assistant) throw new Error("assistant message missing after restart");
      if (assistant.state !== "completed") throw new Error(`assistant state: ${assistant.state}`);
      const citation = assistant.citations[0];
      if (!citation) throw new Error("citation missing after restart");
      const opened = await api.citations.open({ projectId, citationId: citation.id });
      if (!opened.ok) throw new Error(`citation open: ${opened.error.code}`);
      return { assistant, citation, opened };
    }, setup);
    expect(persisted.assistant.content).toContain("Grounded alpha answer [S1]");
    expect(persisted.citation).toMatchObject({ label: "S1", sourceDisplayName: "authoritative-alpha.txt" });
    expect(persisted.citation.locator).toMatchObject({ kind: "paragraph", paragraph: 1 });
    expect(persisted.opened).toMatchObject({ ok: true, value: { opened: "document" } });
    await restarted.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1802, 1128));
    await restarted.page.waitForFunction(() => window.innerWidth >= 1700 && window.innerHeight >= 1000);
    await expect(restarted.page.getByRole("heading", { name: "Cited RAG" })).toBeVisible();
    await expect(restarted.page.getByRole("complementary", { name: "来源引用" })).toBeVisible();
    const geometry = await restarted.page.evaluate(() => {
      const citation = document.querySelector<HTMLElement>(".citation-panel");
      const composer = document.querySelector<HTMLElement>(".chat-composer");
      const cards = document.querySelector<HTMLElement>(".citation-cards");
      return {
        citationBottom: citation?.getBoundingClientRect().bottom ?? 0,
        composerBottom: composer?.getBoundingClientRect().bottom ?? 0,
        cardsOverflowY: cards ? getComputedStyle(cards).overflowY : ""
      };
    });
    expect(Math.abs(geometry.citationBottom - geometry.composerBottom)).toBeLessThanOrEqual(1);
    expect(geometry.cardsOverflowY).toBe("auto");
    await restarted.page.getByRole("button", { name: /Cited RAG|对话/ }).click();
    await expect(restarted.page.locator(".conversation-items.open")).toBeVisible();
    await restarted.page.screenshot({ path: path.join(screenshotDir, "research-chat-zh-light.png"), scale: "css", clip: { x: 0, y: 0, width: 1803, height: 1128 } });
    await restarted.page.keyboard.press("Escape");
    await expect(restarted.page.locator(".conversation-items.open")).toBeHidden();
    await restarted.page.getByRole("button", { name: "EN", exact: true }).click();
    await restarted.page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(restarted.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(restarted.page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(restarted.page.getByRole("complementary", { name: "Source citations" })).toBeVisible();
    await restarted.page.screenshot({ path: path.join(screenshotDir, "research-chat-en-dark.png"), scale: "css", clip: { x: 0, y: 0, width: 1803, height: 1128 } });

    await restarted.page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    await expectReachableAtCurrentZoom(restarted.page, restarted.page.locator(".chat-composer textarea"));
    await expectReachableAtCurrentZoom(restarted.page, restarted.page.getByRole("button", { name: "Send" }));
    await restarted.page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  } finally {
    await Promise.allSettled([
      app ? closeElectron(app) : Promise.resolve(),
      provider.close(),
      temporaryVectors?.close(),
      temporaryVectorsDir ? fs.rm(temporaryVectorsDir, { recursive: true, force: true }) : Promise.resolve(),
      fs.rm(userDataDir, { recursive: true, force: true })
    ]);
  }
});

test("source import UI is reachable and exposes approved formats", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const { app, page } = await launchWithUserData(userDataDir);
  try {
    await skipOnboarding(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await page.getByLabel("项目名称").fill("来源导入截图");
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("来源导入截图").first()).toBeVisible();
    await page.getByRole("button", { name: "导入资料" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/支持 PDF.*DOCX.*PPTX.*XLSX.*TXT.*Markdown.*URL.*CSV/)).toBeVisible();
    await expect(dialog.getByLabel("网页地址")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "选择文件" })).toBeEnabled();
    await page.screenshot({ path: path.resolve("docs/verification/screenshots/source-import-zh-light.png") });
  } finally {
    await closeElectron(app);
  }
});

test("failed source task hydrates with English dark error and retry action", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const first = await launchWithUserData(userDataDir);
  let projectId = "";
  try {
    await skipOnboarding(first.page);
    await first.page.getByRole("button", { name: "新建项目" }).first().click();
    await first.page.getByLabel("项目名称").fill("Failed task screenshot");
    await first.page.getByRole("button", { name: "确认" }).click();
    projectId = await first.page.evaluate(async () => {
      const projects = await (window as unknown as { myNotebook: { projects: { list(): Promise<Array<{ id: string }>> } } }).myNotebook.projects.list();
      if (!projects[0]) throw new Error("project not created");
      return projects[0].id;
    });
  } finally {
    await closeElectron(first.app);
  }

  const sourceId = "77777777-7777-4777-8777-777777777777";
  const taskId = "88888888-8888-4888-8888-888888888888";
  const now = new Date().toISOString();
  const database = new Database(path.join(userDataDir, "data", "app.db"));
  try {
    database.prepare("INSERT INTO sources(id, project_id, kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'text', ?, 'active', ?, ?)").run(sourceId, projectId, "Failed import.txt", now, now);
    database.prepare("INSERT INTO tasks(id, project_id, source_id, kind, state, stage, progress_1000, attempt, error_code, error_message, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'ingest', 'failed', 'parsing', 400, 1, 'NETWORK', 'errors.network', ?, ?, ?)").run(taskId, projectId, sourceId, `e2e-failed-${taskId}`, now, now);
  } finally {
    database.close();
  }

  const { app, page } = await launchWithUserData(userDataDir);
  try {
    await expect(page.getByText("Failed import.txt").first()).toBeVisible();
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await page.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("alert").filter({ hasText: /network|connection/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.screenshot({ path: path.resolve("docs/verification/screenshots/source-task-error-en-dark.png") });
  } finally {
    await closeElectron(app);
  }
});

test("vector health settings use the Foundation layout in zh light and en dark", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(path.resolve("docs/verification/screenshots"), { recursive: true });
  const provider = await startFakeOpenAi();
  const { app, page } = await launchWithUserData(userDataDir);
  try {
    await skipOnboarding(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await page.getByLabel("项目名称").fill("索引健康截图");
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("索引健康截图").first()).toBeVisible();
    await page.evaluate(async ({ baseUrl }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const projects = await api.projects.list();
      const profiles = await api.models.listProfiles();
      if (!profiles.ok) throw new Error("profiles unavailable");
      const embeddingProfileId = "44444444-4444-4444-8444-444444444444";
      const embedding = await api.models.saveProfile({ profile: { id: embeddingProfileId, name: "E2E Embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true }, apiKey: "e2e-key" });
      const generationProfileId = "33333333-3333-4333-8333-333333333333";
      const generation = await api.models.saveProfile({ profile: { id: generationProfileId, name: "E2E Generation", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true }, apiKey: "e2e-key" });
      if (!embedding.ok || !generation.ok) throw new Error(`model profiles unavailable: ${embedding.ok ? "generation" : embedding.error.code}`);
      const current = projects.find((item: any) => item.name === "索引健康截图");
      if (!current) throw new Error("project unavailable");
      const routes = await api.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
      if (!routes.ok) throw new Error("embedding route unavailable");
    }, { baseUrl: provider.baseUrl });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await page.getByRole("tab", { name: "数据与索引" }).click();
    await expect(page.getByRole("heading", { name: "索引不可用" })).toBeVisible();
    await page.locator(".index-status").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve("docs/verification/screenshots/index-space-zh-light.png") });

    await page.getByRole("button", { name: "EN", exact: true }).click();
    await page.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("tab", { name: "Data & indexing" })).toBeVisible();
    await page.getByRole("tab", { name: "Data & indexing" }).click();
    await expect(page.getByRole("heading", { name: "Index unavailable" })).toBeVisible();
    await page.getByRole("button", { name: "Migrate embedding Space" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: path.resolve("docs/verification/screenshots/index-space-en-dark.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Migrate embedding Space" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const tasks = await (window as unknown as { myNotebook: any }).myNotebook.tasks.list({ projectId: (await (window as unknown as { myNotebook: any }).myNotebook.projects.list()).find((item: any) => item.name === "索引健康截图")?.id });
      return tasks.find((task: any) => task.kind === "validation")?.state;
    })).toBe("completed");
  } finally {
    await closeElectron(app);
    await provider.close();
  }
});
