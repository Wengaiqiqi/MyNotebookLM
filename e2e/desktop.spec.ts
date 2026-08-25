import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

async function startFakeOpenAi(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
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
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + "data: [DONE]\n\n"
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/embeddings") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
