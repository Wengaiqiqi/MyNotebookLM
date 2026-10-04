import { expect, test } from "@playwright/test";
import { _electron, type ElectronApplication } from "playwright";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { closeElectron, createProject, skipOnboarding } from "./helpers/task9";

test("generates a mind map, focuses nodes and preserves independent streaming chats and view after restart", async () => {
  test.setTimeout(180_000);
  const runtime = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-mindmap-"));
  const artifactDir = process.env.MYNOTEBOOKLM_TEST_ARTIFACTS ?? runtime;
  await fs.mkdir(artifactDir, { recursive: true });
  const chunks = [randomUUID(), randomUUID(), randomUUID()];
  const revisions = [randomUUID(), randomUUID()];
  const requests: any[] = [];
  let mapAttempts = 0;
  let releaseMap!: () => void;
  let releaseRepair!: () => void;
  const mapReady = new Promise<void>((resolve) => { releaseMap = resolve; });
  const repairReady = new Promise<void>((resolve) => { releaseRepair = resolve; });
  const node = (title: string, children: any[] = [], refs = [chunks[0]]) => ({ title, summary: `围绕${title}组织概念、证据与关联。`, keyPoints: ["上下文按用途分层组织", "只使用与当前任务相关的信息"], refs, children });
  const generated = { root: node("多智能体任务编排与安全执行系统", [
    node("研究背景", [node("问题与目标"), node("需求分析")]),
    node("系统设计", [node("总体架构"), node("分层记忆", [], chunks), node("信任边界")]),
    node("多智能体协作", [node("任务编排与状态机"), node("MCP 工具接入"), node("A2A 远程协作")]),
    node("安全执行", [node("三级权限控制"), node("Web 安全沙盒")]),
    node("测试与总结", [node("测试结果分析"), node("总结与展望")])
  ]) };
  const server = http.createServer(async (req, res) => {
    const bytes = []; for await (const chunk of req) bytes.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(bytes).toString("utf8") || "{}"); requests.push(body);
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const isMap = JSON.stringify(body.messages).includes("[CHUNK:");
    if (isMap) {
      mapAttempts++;
      if (mapAttempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"root":{"title":"unfinished' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      if (mapAttempts === 2) await mapReady;
      if (mapAttempts === 3) await repairReady;
    }
    const memory = JSON.stringify(body.messages).includes('Selected node (reference data');
    const text = isMap ? mapAttempts === 2 ? '{"root":{"title":"需修复的导图","refs":["S1"]}}' : JSON.stringify(generated) : memory ? "分层记忆将任务上下文按用途组织。工作记忆保留本轮任务的信息，长期记忆保留可复用知识。这样可以减少重复检索，并保持当前任务的上下文一致。" : "回答";
    const parts = isMap ? [text] : [text.slice(0, 10), text.slice(10, 30), text.slice(30)];
    for (const part of parts) {
      if (!isMap) await new Promise((resolve) => setTimeout(resolve, 700));
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 200 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    const entry = path.join(process.env.MYNOTEBOOKLM_TEST_BUILD_DIR ?? path.resolve("out"), "main/index.js");
    const executablePath = process.env.MYNOTEBOOKLM_TEST_EXECUTABLE;
    app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [entry], timeout: 30_000, env: { ...process.env, NODE_ENV: "test", MYNOTEBOOKLM_USER_DATA_DIR: runtime, NODE_PATH: path.resolve("node_modules"), APPDATA: path.join(runtime, "AppData/Roaming"), LOCALAPPDATA: path.join(runtime, "AppData/Local"), TEMP: runtime, TMP: runtime } });
    app.process().stderr?.on("data", (data: Buffer) => { console.log("Electron: " + data.toString()); });
    const page = await app.firstWindow({ timeout: 20_000 });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach((window) => { window.webContents.setBackgroundThrottling(false); window.setSize(1456, 908); window.hide(); }); });
    page.on("pageerror", (error) => { errors.push(error.message); console.log("Renderer: " + error.message); });
    return page;
  };
  try {
    let page = await launch();
    await skipOnboarding(page);
    const projectId = await createProject(page, "导图功能验证");
    await page.evaluate(async (baseUrl) => {
      const api = (window as any).myNotebook;
      const id = crypto.randomUUID();
      const profile = await api.models.saveProfile({ profile: { id, name: "导图测试模型", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-mindmap", enabled: true }, apiKey: "test-local-key" });
      if (!profile.ok) throw new Error(JSON.stringify(profile.error));
      const route = await api.models.saveRoutes({ taskKind: "chat", profileIds: [id] });
      if (!route.ok) throw new Error(JSON.stringify(route.error));
      const mapProfile = await api.models.saveProfile({ profile: { id: crypto.randomUUID(), name: "导图专用模型", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-map-only", enabled: true }, apiKey: "test-local-key" });
      if (!mapProfile.ok) throw new Error(JSON.stringify(mapProfile.error));
    }, `http://127.0.0.1:${port}/v1`);
    await closeElectron(app!); app = undefined;
    const db = new Database(path.join(runtime, "data/app.db"));
    for (let i = 0; i < 2; i++) {
      const sourceId = randomUUID();
      const stored = path.join(runtime, `source-${i}`);
      if (i) await fs.writeFile(stored, "原文资料");
      else await fs.copyFile("src/test/fixtures/documents/sample.docx", stored);
      db.prepare("INSERT INTO sources(id,project_id,kind,display_name,status) VALUES(?,?,?,?,'active')").run(sourceId, projectId, i ? "text" : "docx", i ? "系统设计补充说明.txt" : "毕业论文最终成品.docx");
      db.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,'paragraph','v1','ready')").run(revisions[i], sourceId, stored, stored, `hash${i}`);
      db.prepare("UPDATE sources SET current_revision_id=? WHERE id=?").run(revisions[i], sourceId);
      const sourceChunks = i ? [chunks[2]] : [chunks[0], chunks[1]];
      sourceChunks.forEach((chunkId, index) => db.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,text,locator_json,content_hash) VALUES(?,?,?,?,?,?)")
        .run(chunkId, revisions[i], index, `分层记忆原文片段${i + index + 1}：` + "工作记忆保存当前任务状态，长期记忆支持知识复用。".repeat(35), JSON.stringify({ kind: "paragraph", paragraph: index + 1 }), chunkId));
    }
    db.close();
    page = await launch();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "任务路由", exact: true }).click();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByRole("option", { name: "思维导图", exact: true })).toBeVisible();
    await page.getByRole("listbox").evaluate(async (el) => { await Promise.all(el.getAnimations().map((animation) => animation.finished)); });
    await page.screenshot({ path: path.join(artifactDir, "routing-options.png") });
    await page.getByRole("option", { name: "思维导图", exact: true }).click();
    await page.getByRole("button", { name: /移除.*导图测试模型/ }).click();
    await page.getByRole("button", { name: "选择提供商…", exact: true }).click();
    await page.getByRole("option", { name: /导图专用模型/ }).click();
    await page.getByRole("button", { name: "请添加模型路由", exact: true }).click();
    await page.getByRole("option", { name: "gpt-map-only", exact: true }).click();
    await page.getByRole("button", { name: "保存路由", exact: true }).click();
    await expect(page.getByText("路由已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    const mapRoute = await page.evaluate(async () => (window as any).myNotebook.models.getRoutes({ taskKind: "mind-map" }));
    expect(mapRoute).toMatchObject({ ok: true, value: [{ taskKind: "mind-map", position: 0 }] });
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await page.getByRole("button", { name: "规则", exact: true }).click();
    await page.getByRole("option", { name: "思维导图", exact: true }).click();
    await page.getByRole("button", { name: "来源", exact: true }).click();
    await page.getByRole("option", { name: "毕业论文最终成品.docx", exact: true }).click();
    await page.getByRole("option", { name: "系统设计补充说明.txt", exact: true }).click();
    await page.getByRole("heading", { name: "运行转换", exact: true }).click();
    await page.getByRole("button", { name: "生成思维导图", exact: true }).click();
    await expect(page.getByRole("list", { name: "思维导图生成进度" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("模型达到输出上限，转换尚未完成", { timeout: 15_000 });
    await expect(page.getByRole("alert")).toBeInViewport();
    await expect(page.locator(".task-card-percent")).not.toHaveText("99%");
    await page.screenshot({ path: path.join(artifactDir, "map-output-limit.png") });
    await page.getByRole("tab", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("模型达到输出上限");
    await expect(page.getByRole("button", { name: "规则", exact: true })).toContainText("思维导图");
    await expect(page.getByRole("button", { name: "来源", exact: true })).toContainText("已选 2 项");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.locator(".task-card-status strong")).toHaveText("生成节点与层级");
    await expect(page.locator(".task-card-percent")).toHaveText("50%", { timeout: 15_000 });
    await page.locator(".task-card").evaluate(async (el) => { await Promise.all(el.getAnimations().map((animation) => animation.finished)); });
    await page.screenshot({ path: path.join(artifactDir, "map-progress.png") });
    await page.getByRole("tab", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.locator(".task-card-percent")).toHaveText("50%");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("button", { name: "规则", exact: true })).toContainText("思维导图");
    await expect(page.getByRole("button", { name: "来源", exact: true })).toContainText("已选 2 项");
    await expect(page.locator(".task-card-percent")).toHaveText("50%");
    await createProject(page, "其他项目");
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.getByRole("button", { name: "规则", exact: true })).toContainText("摘要");
    await expect(page.getByRole("button", { name: "来源", exact: true })).toContainText("选择一个来源");
    await page.locator(".project-item-btn").filter({ hasText: "导图功能验证" }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.getByRole("button", { name: "来源", exact: true })).toContainText("已选 2 项");
    await expect(page.locator(".task-card-percent")).toHaveText("50%");
    // A conversion started elsewhere must not take over this form's progress.
    const unrelated = await page.evaluate(async ({ projectId, revision }) =>
      (await (window as any).myNotebook.transformations.run({ projectId, sourceRevisionIds: [revision], builtinKey: "summary", language: "zh-CN", force: true })).value.id,
    { projectId, revision: revisions[0]! });
    await expect.poll(() => page.evaluate(async ({ projectId, id }) =>
      (await (window as any).myNotebook.tasks.list({ projectId })).find((task: any) => task.id === id)?.state, { projectId, id: unrelated })).toBe("completed");
    await expect(page.locator(".task-card-percent")).toHaveText("50%");
    releaseMap();
    await expect(page.locator(".task-card-status strong")).toHaveText("校验结构与引用", { timeout: 10_000 });
    await expect(page.locator(".task-card-percent")).toHaveText("95%", { timeout: 20_000 });
    await page.getByRole("tab", { name: "研究", exact: true }).click();
    await page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(page.locator(".task-card-percent")).toHaveText("95%");
    await page.screenshot({ path: path.join(artifactDir, "map-validation-repair.png") });
    releaseRepair();
    const open = page.getByRole("button", { name: "打开导图", exact: true });
    await expect(open).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(artifactDir, "conversion.png") });
    await open.click();
    await expect(page.locator("me-tpc")).toHaveCount(18);
    await page.locator(".mindmap-dialog").evaluate(async (el) => { await Promise.all(el.getAnimations().map((animation) => animation.finished)); });
    await expect(page.getByRole("button", { name: "适应画布", exact: true })).toHaveCount(0);
    const zoom = page.locator(".mindmap-zoom span");
    const zoomPercent = async () => Number((await zoom.innerText()).replace("%", ""));
    const initialZoom = await zoomPercent();
    await page.locator(".mindmap-canvas").hover({ position: { x: 250, y: 250 } });
    await page.mouse.wheel(0, -120);
    await expect.poll(zoomPercent).toBeGreaterThan(initialZoom);
    await page.mouse.wheel(0, 120);
    await expect.poll(zoomPercent).toBe(initialZoom);
    await page.screenshot({ path: path.join(artifactDir, "map-overview.png") });
    await expect(page.getByText("概念预览", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "分层记忆", exact: true }).click();
    await expect(page.locator('me-tpc[data-nodeid="menode-0-1-1"]')).toHaveClass(/mm-active/);
    await expect(page.locator("me-root me-tpc")).not.toHaveClass(/mm-dim/);
    await expect(page.locator(".mindmap-reference")).toHaveCount(3);
    await app!.evaluate(({ shell }) => {
      (globalThis as any).sourceOpenings = [];
      shell.openPath = async (file) => { (globalThis as any).sourceOpenings.push(file); return ""; };
    });
    await page.locator(".mindmap-reference").first().getByRole("button", { name: "查看原文" }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as any).sourceOpenings)).toHaveLength(1);
    const openedDocument = await app!.evaluate(() => (globalThis as any).sourceOpenings[0] as string);
    expect(path.extname(openedDocument)).toBe(".docx");
    expect(await fs.readFile(openedDocument)).toEqual(await fs.readFile("src/test/fixtures/documents/sample.docx"));
    expect(await fs.readFile(path.join(runtime, "source-0"))).toEqual(await fs.readFile(openedDocument));
    await expect(page.locator(".mindmap-dialog")).toBeVisible();
    await expect(page.locator(".mindmap-panel")).not.toContainText("提问节点：");
    expect(await page.locator(".mindmap-details-scroll").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.locator(".mindmap-details-scroll").hover({ position: { x: 150, y: 150 } });
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.locator(".mindmap-details-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await zoomPercent()).toBe(initialZoom);
    await expect(page.getByRole("button", { name: "围绕此节点提问" })).toBeInViewport();
    await page.screenshot({ path: path.join(artifactDir, "node-details.png") });
    await page.getByRole("button", { name: "全部折叠", exact: true }).click();
    await expect(page.locator("me-tpc")).toHaveCount(6);
    await page.getByRole("button", { name: "全部展开", exact: true }).click();
    await expect(page.locator("me-tpc")).toHaveCount(18);
    await page.getByRole("button", { name: "分层记忆", exact: true }).click();
    await page.getByRole("button", { name: "围绕此节点提问" }).click();
    await expect(page.locator(".mindmap-chat-panel .composer")).toBeVisible();
    await expect(page.locator(".mindmap-chat-panel")).not.toContainText("查看原文");
    await page.getByLabel("模型", { exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /gpt-mindmap/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /gpt-mindmap/ }).click();
    await page.getByRole("textbox", { name: "围绕此节点提问", exact: true }).fill("分层记忆是如何组织上下文的？");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".mindmap-message.assistant")).toContainText("分层记忆将任务");
    await page.getByRole("button", { name: "信任边界", exact: true }).click();
    await expect(page.locator(".mindmap-message")).toHaveCount(0);
    await page.getByRole("textbox", { name: "围绕此节点提问", exact: true }).fill("这里的信任边界如何划分？");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".mindmap-message.assistant")).toContainText("分层记忆将任务");
    await page.locator(".mindmap-close").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("tab", { name: "笔记", exact: true }).click();
    const insightId = await page.evaluate(async (projectId) => {
      const result = await (window as any).myNotebook.transformations.listInsights({ projectId });
      return result.value.find((item: any) => item.builtinKey === "mind-map").id;
    }, projectId);
    await expect.poll(() => page.evaluate(async ({ projectId, insightId }) => {
      const api = (window as any).myNotebook;
      const conversation = await api.mindmaps.conversation({ projectId, insightId, nodeId: "node-0-1-1" });
      const result = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      return result.value.at(-1)?.state;
    }, { projectId, insightId })).toBe("completed");
    await page.getByRole("tab", { name: "转换", exact: true }).click(); await open.click();
    await expect(page.locator(".mindmap-message.user")).toContainText("信任边界如何划分");
    await page.getByRole("button", { name: "分层记忆", exact: true }).click();
    await expect(page.locator(".mindmap-message.user")).toContainText("分层记忆是如何组织");
    await expect(page.locator('me-tpc[data-nodeid="menode-0-1-1"]')).toHaveClass(/mm-active/);
    await expect(page.locator('me-tpc[data-nodeid="menode-0-1-1"]')).not.toHaveClass(/mm-dim/);
    await expect(page.locator(".mindmap-message.assistant")).toContainText("保持当前任务的上下文一致");
    await expect(page.locator(".mindmap-chat-panel")).not.toContainText("信任边界如何划分");
    await expect(page.locator(".mindmap-chat-panel")).not.toContainText("查看原文");
    await page.screenshot({ path: path.join(artifactDir, "node-chat.png") });
    await app!.evaluate(({ BrowserWindow }, dir) => {
      (globalThis as any).mindMapDownloads = [];
      BrowserWindow.getAllWindows()[0]!.webContents.session.on("will-download", (_event, item) => {
        const file = dir + "/" + item.getFilename();
        item.setSavePath(file);
        item.once("done", (_event, state) => (globalThis as any).mindMapDownloads.push({ file, state }));
      });
    }, runtime);
    for (const format of ["SVG", "PNG", "JSON"]) {
      console.log("Export " + format);
      await page.getByRole("dialog").getByRole("button", { name: "导出", exact: true }).click();
      await page.getByRole("menuitem", { name: format, exact: true }).click();
      await expect.poll(() => app!.evaluate(() => (globalThis as any).mindMapDownloads)).toContainEqual({ file: runtime + "/" + generated.root.title + "." + format.toLowerCase(), state: "completed" });
      const target = path.join(artifactDir, `export.${format.toLowerCase()}`);
      await fs.copyFile(path.join(runtime, generated.root.title + "." + format.toLowerCase()), target);
      const data = await fs.readFile(target);
      expect(data.length).toBeGreaterThan(100);
      if (format === "JSON") expect(JSON.parse(data.toString()).root.title).toBe(generated.root.title);
    }
    const view = await page.evaluate(async ({ projectId, insightId }) => (await (window as any).myNotebook.mindmaps.get({ projectId, insightId })).value.view, { projectId, insightId });
    await page.getByRole("button", { name: "退出聚焦", exact: true }).click();
    await expect(page.locator("me-tpc.mm-dim")).toHaveCount(0);
    await page.getByRole("button", { name: "放大", exact: true }).click();
    const buttonZoom = await zoomPercent();
    await page.locator(".mindmap-canvas").hover({ position: { x: 250, y: 250 } });
    await page.mouse.wheel(0, -120);
    await expect.poll(zoomPercent).toBeGreaterThan(buttonZoom);
    await page.keyboard.press("Escape");
    const saved = await page.evaluate(async ({ projectId, insightId }) => (await (window as any).myNotebook.mindmaps.get({ projectId, insightId })).value.view, { projectId, insightId });
    expect(saved.focused).toBe(false); expect(saved.selectedNodeId).toBe("node-0-1-1");
    await closeElectron(app!); app = undefined;
    page = await launch(); await page.getByRole("tab", { name: "转换", exact: true }).click();
    await page.getByRole("button", { name: "打开导图", exact: true }).click();
    await expect(page.locator(".mindmap-message.user")).toContainText("分层记忆是如何组织");
    const restored = await page.evaluate(async ({ projectId, insightId }) => {
      const api = (window as any).myNotebook;
      return { map: await api.mindmaps.get({ projectId, insightId }), chats: await api.conversations.list({ projectId }) };
    }, { projectId, insightId });
    expect(restored.map.value.view).toEqual(saved); expect(restored.chats.value).toEqual([]);
    const nodeRequests = requests.filter((req) => JSON.stringify(req.messages ?? []).includes("Selected node (reference data"));
    expect(nodeRequests).toHaveLength(2);
    const mapRequests = requests.filter((req) => JSON.stringify(req.messages ?? []).includes("[CHUNK:"));
    expect(mapRequests).toHaveLength(3);
    expect(mapRequests.every((request) => request.model === "gpt-map-only")).toBe(true);
    expect(JSON.stringify(mapRequests[2].messages)).toContain("Repair the rejected mind map");
    expect(JSON.stringify(nodeRequests[0].messages)).not.toContain("围绕信任边界组织");
    expect(errors).toEqual([]); void view;
  } finally {
    releaseMap(); releaseRepair();
    if (app) await closeElectron(app);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(runtime, { recursive: true, force: true });
  }
});
