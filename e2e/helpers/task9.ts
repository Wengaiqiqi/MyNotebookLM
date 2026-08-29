import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";

export type FakeRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | undefined;
};

export async function launchWithUserData(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const { _electron: electron } = await import("playwright");
  const app = await electron.launch({
    args: [path.resolve("out/main/index.js")],
    env: { ...process.env, NODE_ENV: "test", MYNOTEBOOKLM_USER_DATA_DIR: userDataDir }
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    if (/error|Error|ERROR|failed|Failed|throw|exception/i.test(line)) {
      console.error("[main-stderr] " + line.trim());
    }
  });
  return { app, page: await app.firstWindow() };
}

export async function closeElectron(app: ElectronApplication): Promise<void> {
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

export async function skipOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: /稍后配置模型|Configure later/ });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((candidate) => {
    const text = candidate.textContent?.trim() ?? "";
    return /稍后配置模型|Configure later/.test(text)
      || (/新建项目|New project/.test(text) && !candidate.disabled);
  }));
  if (await skip.isVisible()) await skip.click();
  await page.getByRole("button", { name: /新建项目|New project/ }).first().waitFor({ state: "visible" });
}

export async function createProject(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: /新建项目|New project/ }).first().click();
  await page.getByLabel(/项目名称|Project name/).fill(name);
  await page.getByRole("button", { name: /确认|Confirm/ }).click();
  await page.getByText(name).first().waitFor({ state: "visible" });
  const created = await page.evaluate(async (name: string) => {
    const api = (window as unknown as { myNotebook: { projects: { list(): Promise<Array<{ id: string; name: string }>> } } }).myNotebook;
    const list = await api.projects.list();
    const project = list.find((item) => item.name === name);
    if (!project) throw new Error("project missing after create");
    return project.id;
  }, name);
  return created;
}

export type FakeBehavior = {
  failModelSuffix?: string;
  statusCode?: number;
  payload?: unknown;
  sse?: string;
};

export async function startFakeOpenAi(options: {
  chatDelayMs?: number;
  behaviors?: FakeBehavior[];
} = {}): Promise<{ baseUrl: string; requests: FakeRequest[]; close(): Promise<void> }> {
  const requests: FakeRequest[] = [];
  const behaviors = options.behaviors ?? [];
  const server = http.createServer(async (request, response) => {
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    }
    requests.push({ method: request.method ?? "?", path: request.url ?? "", headers: request.headers, body });
    const model = typeof body?.model === "string" ? body.model : "";
    const behavior = behaviors.find((item) => model.endsWith(item.failModelSuffix ?? "\u0000"));
    if (behavior) {
      response.writeHead(behavior.statusCode ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify(behavior.payload ?? { error: { message: "injected failure" } }));
      return;
    }
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

export async function startMalformedSseProvider(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-broken", object: "model", owned_by: "e2e" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      return;
    }
    if (request.method === "POST" && request.url === "/v1/embeddings") {
      const input = body?.input;
      const inputs = Array.isArray(input) ? input : [input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: inputs.map((value, index) => ({ index, embedding: [0, 1, 0] })) }));
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

export type SeedIds = { sourceId: string; revisionId: string; chunkId: string };

export async function seedTextSource(
  userDataDir: string,
  projectId: string,
  displayName: string,
  text: string,
  ids?: Partial<SeedIds>
): Promise<SeedIds> {
  const { default: Database } = await import("better-sqlite3");
  const resolved = ids ?? {};
  const sourceId = resolved.sourceId ?? crypto.randomUUID();
  const revisionId = resolved.revisionId ?? crypto.randomUUID();
  const chunkId = resolved.chunkId ?? crypto.randomUUID();
  const filesDir = path.join(userDataDir, "data", "files");
  await fs.mkdir(filesDir, { recursive: true });
  const storedPath = path.join(filesDir, `${sourceId}.txt`);
  await fs.writeFile(storedPath, text, "utf8");
  const database = new Database(path.join(userDataDir, "data", "app.db"));
  try {
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'text', ?, 'active')"
    ).run(sourceId, projectId, displayName);
    database.prepare(
      "INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state, activated_at) VALUES (?, ?, ?, ?, ?, 'paragraph', 'persisted', 'ready', ?)"
    ).run(revisionId, sourceId, storedPath, storedPath, `sha256:${sourceId}`, now);
    database.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
    database.prepare(
      "INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, 0, ?, ?, ?)"
    ).run(chunkId, revisionId, `sha256:${chunkId}`, text, JSON.stringify({ kind: "paragraph", paragraph: 1 }));
  } finally {
    database.close();
  }
  return { sourceId, revisionId, chunkId };
}

export async function seedMalformedIngestTask(
  userDataDir: string,
  projectId: string
): Promise<{ sourceId: string; taskId: string }> {
  const { default: Database } = await import("better-sqlite3");
  const sourceId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const database = new Database(path.join(userDataDir, "data", "app.db"));
  try {
    database.prepare(
      "INSERT INTO sources(id, project_id, kind, display_name, status) VALUES (?, ?, 'pdf', ?, 'active')"
    ).run(sourceId, projectId, "broken.pdf");
    database.prepare(
      "INSERT INTO tasks(id, project_id, source_id, kind, state, stage, progress_1000, attempt) VALUES (?, ?, ?, 'ingest', 'queued', 'staging', 0, 0)"
    ).run(taskId, projectId, sourceId);
  } finally {
    database.close();
  }
  return { sourceId, taskId };
}

export function embedFingerprint(modelId = "text-embedding-e2e"): string {
  return createHash("sha256").update(JSON.stringify({
    provider: "openai-compatible",
    modelId,
    modelRevision: modelId,
    dimension: 3,
    distance: "cosine",
    pooling: "mean",
    preprocessVersion: "provider-default-v1",
    chunkingVersion: "persisted"
  })).digest("hex");
}

export function api(page: Page): any {
  return (page as unknown as { evaluate: Page["evaluate"] }) && (window0(), undefined as never);
}

function window0(): never {
  throw new Error("use apiOf(page) inside page.evaluate");
}
