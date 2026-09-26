import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { ElectronApplication } from "playwright";
import { pcmWave } from "../src/main/models/speech-provider";
import { closeElectron, createProject, launchWithUserData, seedTextSource, skipOnboarding } from "./helpers/task9";

for (const speechModel of ["voice", "mimo-v2.5-tts"]) {
test(`saves ${speechModel} in the model form, generates a podcast and plays it after restart`, async () => {
  test.setTimeout(120_000);
  const root = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-podcast-ui-"));
  const voices: string[] = [];
  const generationKeys: string[] = [];
  let providerUnavailable = false, blockedRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (providerUnavailable) { blockedRequests++; response.writeHead(503); response.end(JSON.stringify({ error: { message: "Unavailable" } })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (body.model) generationKeys.push(String(request.headers.authorization));
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "writer" }, { id: speechModel }] })); return; }
    const mimo = body.model === "mimo-v2.5-tts";
    if (request.url === "/v1/audio/speech" && mimo) { response.writeHead(404); response.end(); return; }
    if (request.url === "/v1/audio/speech" || mimo && request.url === "/v1/chat/completions") {
      const voice = mimo ? body.audio.voice : body.voice;
      voices.push(voice);
      if (mimo) {
        expect(body.messages[1].role).toBe("assistant");
        expect(body.audio.format).toBe("wav");
        expect(body.stream).toBe(false);
      }
      const pcm = Buffer.alloc(24_000 * 2);
      for (let i = 0; i < 24_000; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin(i * 2 * Math.PI * (["alloy", "冰糖"].includes(voice) ? 440 : 660) / 24_000)), i * 2);
      const wav = pcmWave(pcm);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      if (mimo) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { audio: { data: wav.toString("base64") } } }] })); }
      else { response.writeHead(200, { "content-type": "audio/wav" }); response.end(wav); }
      return;
    }
    const content = body.messages?.[0]?.content === "ping" ? "pong" : JSON.stringify({ title: "测试播客", turns: [{ speaker: "A", text: "这份资料有什么结论？" }, { speaker: "B", text: "资料介绍了 alpha 的研究结果。" }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  let app: ElectronApplication | undefined;
  try {
    let desktop = await launchWithUserData(root); app = desktop.app;
    await skipOnboarding(desktop.page);
    const projectId = await createProject(desktop.page, "Podcast UI");
    await closeElectron(app); app = undefined;
    await seedTextSource(root, projectId, "podcast-source.txt", "alpha 研究结果：有证据支持，但仍有局限。");
    desktop = await launchWithUserData(root); app = desktop.app;
    const page = desktop.page;
    await page.evaluate(async (baseUrl) => {
      const api = (window as any).myNotebook;
      for (const [modelId, outputKind] of [["writer", "text"]]) {
        const saved = await api.models.saveProfile({ profile: { id: crypto.randomUUID(), name: "Podcast", provider: "openai-compatible", capability: "generation", baseUrl, modelId, outputKind, enabled: true }, apiKey: "test-key" });
        if (!saved.ok) throw new Error(JSON.stringify(saved.error));
      }
    }, baseUrl);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型服务", exact: true }).click();
    await page.getByRole("button", { name: "新建生成模型", exact: true }).click();
    const form = page.getByRole("dialog");
    await form.getByRole("button", { name: "OpenAI Compatible", exact: true }).click();
    await form.getByLabel("配置名称", { exact: true }).fill("Podcast");
    await form.getByLabel("API 地址", { exact: true }).fill(baseUrl);
    await form.getByLabel("API Key", { exact: true }).fill("test-key");
    await form.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(form.getByText("获取成功", { exact: true })).toBeVisible();
    await form.getByRole("combobox", { name: "模型名称", exact: true }).fill(speechModel);
    await form.getByRole("button", { name: "模型名称", exact: true }).click();
    const purpose = form.getByRole("button", { name: `模型用途 · ${speechModel}`, exact: true });
    await expect(purpose).toHaveClass(/rounded-select-trigger/);
    await purpose.click();
    await expect(form.getByRole("listbox", { name: `模型用途 · ${speechModel}` })).toHaveCSS("border-radius", "12px");
    await expect(form.getByRole("listbox", { name: `模型用途 · ${speechModel}` })).toHaveCSS("opacity", "1");
    if (speechModel === "mimo-v2.5-tts") await page.screenshot({ path: path.join(tmpdir(), "podcast-model-purpose.png") });
    await purpose.press("Escape");
    await expect(form).toBeVisible();
    await expect(form.getByRole("listbox", { name: `模型用途 · ${speechModel}` })).not.toBeVisible();
    await purpose.click();
    await form.getByRole("option", { name: "语音合成（TTS）", exact: true }).click();
    await form.getByRole("button", { name: "保存", exact: true }).click();
    await expect(form).not.toBeVisible();
    providerUnavailable = true;
    await page.getByRole("button", { name: "编辑: Podcast", exact: true }).click();
    await expect(form.getByRole("combobox", { name: "模型名称", exact: true })).toHaveValue("已选择 2 个模型");
    await form.getByLabel("API Key", { exact: true }).fill("rotated-test-key");
    await form.getByRole("button", { name: "保存", exact: true }).click();
    await expect(form).not.toBeVisible({ timeout: 5_000 });
    expect(blockedRequests).toBe(0);
    providerUnavailable = false;
    generationKeys.length = 0;
    voices.length = 0;
    await page.getByRole("button", { name: "任务路由", exact: true }).click();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await page.getByRole("option", { name: "播客", exact: true }).click();
    await page.getByRole("button", { name: "选择提供商…", exact: true }).click();
    await page.getByRole("option", { name: /Podcast/ }).click();
    await page.getByRole("button", { name: "请添加模型路由", exact: true }).click();
    await expect(page.getByRole("option", { name: /writer.*文字生成/ })).toBeVisible();
    await page.getByRole("option", { name: new RegExp(`${speechModel}.*TTS`) }).click();
    await page.getByRole("button", { name: "添加回退配置", exact: true }).click();
    await page.getByRole("option", { name: /writer.*文字生成/ }).click();
    await page.getByRole("button", { name: "保存路由", exact: true }).click();
    await expect(page.getByText("路由已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await page.getByRole("button", { name: "规则", exact: true }).click();
    await page.getByRole("option", { name: "双人播客", exact: true }).click();
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("option", { name: "podcast-source.txt", exact: true }).click();
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "运行转换", exact: true }).click();
    await expect(page.getByText("合成双人语音", { exact: true })).toBeVisible();
    const progress = page.locator(".task-card-percent");
    const before = Number((await progress.textContent())!.replace("%", ""));
    expect(before).toBeGreaterThanOrEqual(45);
    await page.getByRole("tab", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.getByText("合成双人语音", { exact: true })).toBeVisible();
    expect(Number((await progress.textContent())!.replace("%", ""))).toBeGreaterThanOrEqual(before);
    await expect(page.getByText(/# 测试播客/)).toBeVisible({ timeout: 30_000 });
    expect(voices).toEqual(speechModel === "mimo-v2.5-tts" ? ["冰糖", "苏打"] : ["alloy", "echo"]);
    expect(generationKeys).toEqual(Array(3).fill("Bearer rotated-test-key"));
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("option", { name: "podcast-source.txt", exact: true }).click();
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "规则", exact: true }).click();
    await page.getByRole("option", { name: "双人播客", exact: true }).click();
    await page.getByRole("button", { name: "运行转换", exact: true }).click();
    await expect(page.getByText("合成双人语音", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".task-card")).toHaveCount(0);
    await page.getByRole("tab", { name: "研究", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.locator(".task-card")).toHaveCount(0);
    await page.getByRole("button", { name: "查看详细", exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(2);
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.play());
    await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    await closeElectron(app); app = undefined;
    desktop = await launchWithUserData(root); app = desktop.app;
    await desktop.page.getByRole("tab", { name: "转换", exact: true }).click();
    await desktop.page.getByRole("button", { name: "查看详细", exact: true }).click();
    await expect.poll(() => desktop.page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(2);
    await expect(desktop.page.getByRole("link", { name: "下载音频", exact: true })).toBeVisible();
  } finally {
    if (app) await closeElectron(app);
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    await fs.rm(root, { recursive: true, force: true });
  }
});
}
