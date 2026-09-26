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
test(`selects ${speechModel} voices in the scrollable conversion card, generates and plays a podcast after restart`, async () => {
  test.setTimeout(120_000);
  const root = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-podcast-ui-"));
  const voices: string[] = [];
  const generationKeys: string[] = [];
  const availableVoices = speechModel === "mimo-v2.5-tts" ? ["冰糖", "苏打", "茉莉"] : ["service-first", "service-second", "service-third"];
  let providerUnavailable = false, blockedRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (providerUnavailable) { blockedRequests++; response.writeHead(503); response.end(JSON.stringify({ error: { message: "Unavailable" } })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (body.model) generationKeys.push(String(request.headers.authorization));
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "writer" }, { id: speechModel }] })); return; }
    if (request.url?.startsWith("/v1/audio/voices")) { response.end(JSON.stringify({ voices: availableVoices })); return; }
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
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型服务", exact: true }).click();
    await page.getByRole("button", { name: "新建生成模型", exact: true }).click();
    const form = page.getByRole("dialog");
    await form.getByRole("button", { name: "OpenAI Compatible", exact: true }).click();
    await form.getByLabel("配置名称", { exact: true }).fill("Podcast");
    await form.getByLabel("API 地址", { exact: true }).fill(baseUrl);
    await form.getByLabel("API Key", { exact: true }).fill("test-key");
    const textRow = form.getByRole("group", { name: "文字生成", exact: true });
    const speechRow = form.getByRole("group", { name: "语音合成（TTS）", exact: true });
    await expect(textRow.getByRole("combobox")).toHaveAttribute("placeholder", "请选择文字生成模型");
    await expect(speechRow.getByRole("combobox")).toHaveAttribute("placeholder", "请选择语音生成模型，可留空");
    await textRow.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(textRow.getByText("获取成功", { exact: true })).toBeVisible();
    await textRow.getByRole("combobox").click();
    await textRow.getByRole("option", { name: "writer", exact: true }).click();
    await textRow.getByRole("button", { name: "确认", exact: true }).click();
    await expect(speechRow.getByRole("combobox")).toHaveValue("");
    await speechRow.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(speechRow.getByText("获取成功", { exact: true })).toBeVisible();
    await speechRow.getByRole("combobox").click();
    await speechRow.getByRole("option", { name: speechModel, exact: true }).click();
    await speechRow.getByRole("button", { name: "确认", exact: true }).click();
    if (speechModel === "mimo-v2.5-tts") await page.screenshot({ path: path.join(tmpdir(), "podcast-model-picker-rows.png") });
    await expect(form.getByRole("button", { name: `主持人 A 音色 · ${speechModel}`, exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: "保存", exact: true }).click();
    await expect(form).not.toBeVisible();
    providerUnavailable = true;
    await page.getByRole("button", { name: "编辑: Podcast", exact: true }).click();
    await expect(textRow.getByRole("combobox")).toHaveValue("writer");
    await expect(speechRow.getByRole("combobox")).toHaveValue(speechModel);
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
    const runCard = page.getByRole("region", { name: "运行转换", exact: true });
    await runCard.getByRole("button", { name: `主持人 A 音色 · ${speechModel}`, exact: true }).click();
    await runCard.getByRole("option", { name: availableVoices[2]!, exact: true }).click();
    await expect(runCard.getByRole("button", { name: "填写音色 ID · 主持人 A 音色", exact: true })).toBeVisible();
    await expect(runCard.getByRole("button", { name: "填写音色 ID · 主持人 B 音色", exact: true })).toBeVisible();
    await runCard.getByRole("button", { name: "填写音色 ID · 主持人 A 音色", exact: true }).click();
    await expect(runCard.getByRole("textbox", { name: `主持人 A 音色 · ${speechModel}`, exact: true })).toHaveValue(availableVoices[2]!);
    await expect(runCard.getByRole("button", { name: `主持人 B 音色 · ${speechModel}`, exact: true })).toBeVisible();
    await runCard.getByRole("button", { name: "从列表选择 · 主持人 A 音色", exact: true }).click();
    await expect.poll(() => runCard.locator("form").evaluate((form) => form.scrollHeight > form.clientHeight)).toBe(true);
    await runCard.locator("form").evaluate((form) => { form.scrollTop = 0; });
    await runCard.getByRole("button", { name: "规则", exact: true }).hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => runCard.locator("form").evaluate((form) => form.scrollTop)).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await page.getByRole("button", { name: "规则", exact: true }).click();
    await page.getByRole("option", { name: "双人播客", exact: true }).click();
    await expect(runCard.getByRole("button", { name: `主持人 A 音色 · ${speechModel}`, exact: true })).toHaveText(availableVoices[2]!);
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("option", { name: "podcast-source.txt", exact: true }).click();
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "运行转换", exact: true }).click();
    const progress = page.locator(".task-card-percent");
    await expect(page.getByText("准备播客资料", { exact: true })).toBeVisible();
    expect(Number((await progress.textContent())!.replace("%", ""))).toBeLessThan(20);
    await expect.poll(async () => Number((await progress.textContent())!.replace("%", ""))).toBeGreaterThan(0);
    await expect(page.getByText("合成双人语音", { exact: true })).toBeVisible();
    const before = Number((await progress.textContent())!.replace("%", ""));
    expect(before).toBeGreaterThanOrEqual(45);
    await page.getByRole("tab", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.getByText("合成双人语音", { exact: true })).toBeVisible();
    expect(Number((await progress.textContent())!.replace("%", ""))).toBeGreaterThanOrEqual(before);
    await expect(page.getByText(/# 测试播客/)).toBeVisible({ timeout: 30_000 });
    expect(voices).toEqual([availableVoices[2], availableVoices[1]]);
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
    await expect(page.getByRole("heading", { name: "播客详情", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const bounds = await page.getByRole("dialog").boundingBox();
      return bounds!.width / bounds!.height;
    }).toBeCloseTo(16 / 9, 2);
    await expect(page.getByRole("dialog").getByText(`writer · ${speechModel} ·`, { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "下载音频", exact: true })).toHaveCount(0);
    await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(2);
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.play());
    await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
    await closeElectron(app); app = undefined;
    desktop = await launchWithUserData(root); app = desktop.app;
    await desktop.page.getByRole("tab", { name: "转换", exact: true }).click();
    await desktop.page.getByRole("button", { name: "规则", exact: true }).click();
    await desktop.page.getByRole("option", { name: "双人播客", exact: true }).click();
    await expect(desktop.page.getByRole("button", { name: `主持人 A 音色 · ${speechModel}`, exact: true })).toHaveText(availableVoices[2]!);
    await desktop.page.getByRole("button", { name: "查看详细", exact: true }).click();
    await expect(desktop.page.getByRole("dialog").getByText(`writer · ${speechModel} ·`, { exact: false })).toBeVisible();
    await expect.poll(() => desktop.page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(2);
    await expect(desktop.page.getByRole("link", { name: "下载音频", exact: true })).toHaveCount(0);
  } finally {
    if (app) await closeElectron(app);
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    await fs.rm(root, { recursive: true, force: true });
  }
});
}
