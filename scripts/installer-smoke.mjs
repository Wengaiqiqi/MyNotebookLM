// Task 10 installer smoke: install the packaged NSIS exe, run the
// representative research chain against the installed app with an isolated
// user-data dir and a local fake provider, then verify persistence,
// reinstall-over and uninstall/reinstall data retention.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import * as lancedb from "@lancedb/lancedb";
import Database from "better-sqlite3";

const REPO = process.cwd();
const INSTALLER = path.join(REPO, "dist", "MyNotebookLM-Setup-1.0.0.exe");
const WORK = path.join(REPO, "dist", "smoke-work");
const INSTALL_DIR = path.join(WORK, "app");
const USER_DATA = path.join(WORK, "user-data");
const results = [];
function check(name, ok, detail = "") {
  results.push((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : ""));
  if (!ok) throw new Error("smoke check failed: " + name + " " + detail);
}
const log = (line) => console.log("[smoke] " + line);

async function sha256(file) {
  const data = await fs.readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

async function extractInstaller() {
  await fs.mkdir(INSTALL_DIR, { recursive: true });
  log("extracting installer (silent, isolated install dir)");
  execFileSync(INSTALLER, ["/S", "/D=" + INSTALL_DIR], { stdio: "ignore", timeout: 300000 });
  const exe = path.join(INSTALL_DIR, "MyNotebookLM.exe");
  const stat = await fs.stat(exe);
  check("installer-extracted", stat.isFile(), exe);
}

function fakeProvider() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path: request.url, model: body ? body.model : undefined });
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [
          { id: "gpt-smoke", object: "model", owned_by: "smoke" },
          { id: "text-embedding-smoke", object: "model", owned_by: "smoke" }
        ]}));
      } else if (request.method === "POST" && request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"Grounded alpha "}}]}\n\n'
          + 'data: {"choices":[{"delta":{"content":"answer [S1]"}}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
          + "data: [DONE]\n\n");
      } else if (request.method === "POST" && request.url === "/v1/embeddings") {
        const input = body ? body.input : undefined;
        const inputs = Array.isArray(input) ? input : [input];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: inputs.map((value, index) => ({
          index,
          embedding: typeof value === "string" && /\balpha\b/i.test(value) ? [1, 0, 0] : [0, 1, 0]
        })) }));
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({ baseUrl: "http://127.0.0.1:" + port + "/v1", requests, close: () => new Promise((r) => server.close(r)) });
  }));
}

async function launch() {
  const exe = path.join(INSTALL_DIR, "MyNotebookLM.exe");
  const child = spawn(exe, ["--remote-debugging-port=9333"], {
    env: Object.assign({}, process.env, { NODE_ENV: "test", MYNOTEBOOKLM_USER_DATA_DIR: USER_DATA }),
    stdio: "ignore"
  });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9333", { timeout: 2000 });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw new Error("CDP connect failed for installed app");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages.length > 0) page = pages[0];
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error("no page target from installed app");
  return { app: { browser, child }, page };
}

async function closeApp(app) {
  const pid = app.child.pid;
  await app.browser.close().catch(() => undefined);
  try { app.child.kill(); } catch { return; }
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("app shutdown timeout");
}

function embedFingerprint() {
  return createHash("sha256").update(JSON.stringify({
    provider: "openai-compatible", modelId: "text-embedding-smoke", modelRevision: "text-embedding-smoke",
    dimension: 3, distance: "cosine", pooling: "mean", preprocessVersion: "provider-default-v1", chunkingVersion: "persisted"
  })).digest("hex");
}

async function seedData(projectName) {
  const database = new Database(path.join(USER_DATA, "data", "app.db"));
  const projectId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  try {
    const sourceId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(projectId, projectName, now, now);
    const filesDir = path.join(USER_DATA, "data", "files");
    await fs.mkdir(filesDir, { recursive: true });
    const storedPath = path.join(filesDir, sourceId + ".txt");
    const text = "alpha evidence from the authoritative source.";
    await fs.writeFile(storedPath, text, "utf8");
    database.prepare("INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', ?, 'active')")
      .run(sourceId, projectId, "smoke-alpha.txt");
    database.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state, activated_at) VALUES (?, ?, ?, ?, ?, 'paragraph', 'persisted', 'ready', ?)")
      .run(revisionId, sourceId, storedPath, storedPath, "sha256:" + sourceId, now);
    database.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
    database.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, 0, ?, ?, ?)")
      .run(chunkId, revisionId, "sha256:" + chunkId, text, JSON.stringify({ kind: "paragraph", paragraph: 1 }));
  } finally {
    database.close();
  }
  return { projectId, chunkId };
}

async function bootstrapSpace(projectId, chunkId, spaceId) {
  const database = new Database(path.join(USER_DATA, "data", "app.db"));
  try {
    const now = new Date().toISOString();
    database.prepare("INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, progress_1000, created_at, updated_at) VALUES (?, ?, 'openai-compatible', 'text-embedding-smoke', 'text-embedding-smoke', 3, 'cosine', 'mean', 'provider-default-v1', 'persisted', ?, 'active', 1000, ?, ?)")
      .run(spaceId, projectId, embedFingerprint(), now, now);
    database.prepare("INSERT INTO project_embedding_spaces(project_id, space_id, updated_at) VALUES (?, ?, ?)")
      .run(projectId, spaceId, now);
  } finally {
    database.close();
  }
  const vectorsDir = path.join(USER_DATA, "vectors");
  await fs.mkdir(vectorsDir, { recursive: true });
  const tableName = "space_" + spaceId.replaceAll("-", "_");
  const vectors = await lancedb.connect(vectorsDir);
  await vectors.createTable(tableName, lancedb.makeArrowTable([{
    chunkId, projectId, sourceId: crypto.randomUUID(), revisionId: crypto.randomUUID(), spaceId,
    ordinal: 0, contentHash: "sha256:alpha", text: "alpha evidence from the authoritative source.",
    vector: [1, 0, 0], locatorJson: JSON.stringify({ kind: "paragraph", paragraph: 1 }), createdAt: Date.now()
  }]));
  await vectors.close();
}

async function main() {
  const hashBefore = await sha256(INSTALLER);
  const size = (await fs.stat(INSTALLER)).size;
  log("installer bytes=" + size + " sha256=" + hashBefore);

  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  await extractInstaller();

  const provider = await fakeProvider();
  let app;
  try {
    await fs.mkdir(USER_DATA, { recursive: true });
    const first = await launch();
    app = first.app;
    const skip = first.page.getByRole("button", { name: /稍后配置模型|Configure later/ });
    await first.page.waitForFunction(() => [...document.querySelectorAll("button")].some((candidate) =>
      /稍后配置模型|Configure later/.test(candidate.textContent.trim() || "")));
    check("onboarding-visible", await skip.isVisible());
    await skip.click();
    await first.page.getByRole("button", { name: /新建项目|New project/ }).first().waitFor({ state: "visible" });
    check("onboarding-skip-lands-home", true);
    await closeApp(app);
    app = undefined;

    const seeded = await seedData("Smoke Project");
    const spaceId = "33333333-3333-4333-8333-333333333333";
    await bootstrapSpace(seeded.projectId, seeded.chunkId, spaceId);

    const launched = await launch();
    app = launched.app;
    const setup = await launched.page.evaluate(async ({ baseUrl, projectId, chunkId, spaceId }) => {
      const api = window.myNotebook;
      const generation = await api.models.saveProfile({
        profile: { id: "11111111-1111-4111-8111-111111111111", name: "Smoke Generation", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-smoke", enabled: true },
        apiKey: "smoke-key"
      });
      if (!generation.ok) throw new Error("generation profile: " + generation.error.code);
      const embedding = await api.models.saveProfile({
        profile: { id: "22222222-2222-4222-8222-222222222222", name: "Smoke Embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-smoke", enabled: true },
        apiKey: "smoke-key"
      });
      if (!embedding.ok) throw new Error("embedding profile: " + embedding.error.code);
      const routes = await api.models.setDefaultRoutes({ generationProfileId: "11111111-1111-4111-8111-111111111111", embeddingProfileId: "22222222-2222-4222-8222-222222222222" });
      if (!routes.ok) throw new Error("routes: " + routes.error.code);
      const hits = await api.retrieval.search({ projectId, query: "alpha", limit: 5 });
      if (!hits.ok) throw new Error("retrieval: " + hits.error.code);
      if (!hits.value.some((hit) => hit.chunkId === chunkId)) throw new Error("retrieval hit missing");
      const health = await api.vector.getHealth({ projectId });
      if (!health.ok) throw new Error("health: " + health.error.code);
      return { spaceId: health.value.spaceId };
    }, { baseUrl: provider.baseUrl, projectId: seeded.projectId, chunkId: seeded.chunkId, spaceId });
    check("lancedb-health", setup.spaceId === spaceId, setup.spaceId);

    const chat = await launched.page.evaluate(async ({ projectId }) => {
      const api = window.myNotebook;
      const conversation = await api.conversations.create({ projectId, title: "Smoke Chat" });
      if (!conversation.ok) throw new Error("conversation: " + conversation.error.code);
      const requestId = crypto.randomUUID();
      const send = await api.chat.send({ requestId, projectId, conversationId: conversation.value.id, question: "What is the alpha evidence?" });
      if (!send.ok) throw new Error("chat: " + send.error.code);
      const messages = await api.conversations.listMessages({ projectId, conversationId: conversation.value.id });
      if (!messages.ok) throw new Error("messages: " + messages.error.code);
      const assistant = messages.value.find((message) => message.id === send.value.assistantMessageId);
      if (!assistant || assistant.state !== "completed") throw new Error("assistant not completed");
      return { conversationId: conversation.value.id, assistantMessageId: assistant.id, content: assistant.content, citation: assistant.citations[0] };
    }, { projectId: seeded.projectId });
    check("chat-completed", chat.content.includes("Grounded alpha answer [S1]"), chat.content);
    check("citation-resolves", Boolean(chat.citation), chat.citation ? chat.citation.label : "none");
    if (chat.citation) {
      const opened = await launched.page.evaluate(async ({ projectId, citationId }) => {
        const api = window.myNotebook;
        return api.citations.open({ projectId, citationId });
      }, { projectId: seeded.projectId, citationId: chat.citation.id });
      check("citation-open", opened.ok === true);
    }

    const note = await launched.page.evaluate(async ({ projectId }) => {
      const api = window.myNotebook;
      const created = await api.notes.create({ projectId, title: "Smoke note", body: "# Smoke\n\nalpha body text" });
      if (!created.ok) throw new Error("note: " + created.error.code);
      return created.value.id;
    }, { projectId: seeded.projectId });
    check("note-created", Boolean(note));
    await closeApp(app);
    app = undefined;

    const restart = await launch();
    app = restart.app;
    const persisted = await restart.page.evaluate(async ({ projectId, conversationId, assistantMessageId, noteId, spaceId }) => {
      const api = window.myNotebook;
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      if (!messages.ok) throw new Error("messages: " + messages.error.code);
      const notes = await api.notes.list({ projectId });
      if (!notes.ok) throw new Error("notes: " + notes.error.code);
      const health = await api.vector.getHealth({ projectId });
      if (!health.ok) throw new Error("health: " + health.error.code);
      const settings = await api.settings.get();
      if (!settings.ok) throw new Error("settings: " + settings.error.code);
      const assistant = messages.value.find((message) => message.id === assistantMessageId);
      return {
        assistantState: assistant ? assistant.state : undefined,
        assistantContent: assistant ? assistant.content : undefined,
        hasNote: notes.value.some((item) => item.id === noteId),
        spaceId: health.value.spaceId,
        spaceState: health.value.state,
        settingsOk: Boolean(settings.value)
      };
    }, { projectId: seeded.projectId, conversationId: chat.conversationId, assistantMessageId: chat.assistantMessageId, noteId: note, spaceId });
    check("restart-assistant", persisted.assistantState === "completed" && String(persisted.assistantContent).includes("Grounded alpha answer [S1]"));
    check("restart-note", persisted.hasNote);
    check("restart-active-space", persisted.spaceId === spaceId && persisted.spaceState === "active", JSON.stringify(persisted));
    check("restart-settings", persisted.settingsOk);
    await closeApp(app);
    app = undefined;

    log("re-running installer over existing install");
    execFileSync(INSTALLER, ["/S", "/D=" + INSTALL_DIR], { stdio: "ignore", timeout: 300000 });
    check("overwrite-install-ok", (await fs.stat(path.join(INSTALL_DIR, "MyNotebookLM.exe"))).isFile());
    const afterOverwrite = await launch();
    app = afterOverwrite.app;
    const retained = await afterOverwrite.page.evaluate(async ({ projectId, noteId, conversationId }) => {
      const api = window.myNotebook;
      const notes = await api.notes.list({ projectId });
      const messages = await api.conversations.listMessages({ projectId, conversationId });
      const health = await api.vector.getHealth({ projectId });
      return {
        noteKept: notes.ok && notes.value.some((item) => item.id === noteId),
        chatOk: messages.ok && messages.value.some((message) => message.role === "assistant"),
        spaceOk: health.ok && health.value.state === "active"
      };
    }, { projectId: seeded.projectId, noteId: note, conversationId: chat.conversationId });
    check("overwrite-data-retained", retained.noteKept && retained.chatOk && retained.spaceOk, JSON.stringify(retained));
    await closeApp(app);
    app = undefined;

    const uninstaller = path.join(INSTALL_DIR, "Uninstall MyNotebookLM.exe");
    const hasUninstaller = await fs.stat(uninstaller).then(() => true, () => false);
    if (hasUninstaller) {
      log("running uninstaller");
      execFileSync(uninstaller, ["/S"], { stdio: "ignore", timeout: 300000 });
      let removed = false;
      for (let i = 0; i < 60; i++) {
        const stillThere = await fs.stat(path.join(INSTALL_DIR, "MyNotebookLM.exe")).then(() => true, () => false);
        if (!stillThere) { removed = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
      }
      check("uninstall-removed-binaries", removed);
      check("uninstall-user-data-kept", (await fs.stat(path.join(USER_DATA, "data", "app.db"))).isFile());
      log("reinstalling after uninstall");
      execFileSync(INSTALLER, ["/S", "/D=" + INSTALL_DIR], { stdio: "ignore", timeout: 300000 });
      const reinstalled = await launch();
      app = reinstalled.app;
      const retainedAfterReinstall = await reinstalled.page.evaluate(async ({ projectId, noteId }) => {
        const api = window.myNotebook;
        const notes = await api.notes.list({ projectId });
        return notes.ok && notes.value.some((item) => item.id === noteId);
      }, { projectId: seeded.projectId, noteId: note });
      check("reinstall-data-openable", retainedAfterReinstall === true);
      await closeApp(app);
      app = undefined;
    } else {
      results.push("SKIP uninstall/reinstall :: uninstaller missing at " + uninstaller);
    }
  } finally {
    if (app) await closeApp(app).catch(() => undefined);
    await provider.close().catch(() => undefined);
  }

  const hashAfter = await sha256(INSTALLER);
  check("installer-hash-unchanged", hashAfter === hashBefore, hashAfter);
  console.log("=== SMOKE RESULTS ===");
  for (const line of results) console.log(line);
  console.log("SMOKE_OK");
}

main().catch((error) => {
  console.log("=== SMOKE RESULTS ===");
  for (const line of results) console.log(line);
  console.error("[smoke] FAILED: " + error.message);
  process.exit(1);
});
