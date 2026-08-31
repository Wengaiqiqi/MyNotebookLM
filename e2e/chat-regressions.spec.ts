import { expect, test } from "@playwright/test";
import * as lancedb from "@lancedb/lancedb";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeElectron, createProject, embedFingerprint, launchWithUserData, skipOnboarding } from "./helpers/task9";

async function fakeProvider(): Promise<{ baseUrl: string; requests: Record<string, unknown>[]; close(): Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [
        { id: "gpt-e2e", object: "model", owned_by: "e2e" },
        { id: "text-embedding-e2e", object: "model", owned_by: "e2e" }
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/embeddings") {
      const values = Array.isArray(body.input) ? body.input : [body.input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: values.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"已确认：文件有两张表 [S1] [S2]"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: {"usage":{"prompt_tokens":20,"completion_tokens":8}}\n\n'
        + "data: [DONE]\n\n"
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("edited resend keeps context, deduplicates table citations, and one-click new chat is blank", async () => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-chat-regressions-"));
  const provider = await fakeProvider();
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Chat regressions");
    const generationProfileId = crypto.randomUUID();
    const embeddingProfileId = crypto.randomUUID();
    const configured = await first.page.evaluate(async ({ baseUrl, generationProfileId, embeddingProfileId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const generation = await api.models.saveProfile({ profile: { id: generationProfileId, name: "E2E generation", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true }, apiKey: "e2e-key" });
      const embedding = await api.models.saveProfile({ profile: { id: embeddingProfileId, name: "E2E embedding", provider: "openai-compatible", capability: "embedding", baseUrl, modelId: "text-embedding-e2e", enabled: true }, apiKey: "e2e-key" });
      const routes = await api.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
      return { generation, embedding, routes };
    }, { baseUrl: provider.baseUrl, generationProfileId, embeddingProfileId });
    expect(configured.generation.ok && configured.embedding.ok && configured.routes.ok, JSON.stringify(configured)).toBe(true);
    await closeElectron(first.app);
    app = undefined;

    const sourceId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const rows = [
      { id: crypto.randomUUID(), text: "说明文字\n表1 学科竞赛获奖加分细则", locator: { kind: "paragraph", paragraph: 10 } },
      { id: crypto.randomUUID(), text: "表1 学科竞赛获奖加分细则\n竞赛级别 | 一等奖 | 二等奖", locator: { kind: "cell", sheet: "Table 1", cellRef: "A1:C3" } },
      { id: crypto.randomUUID(), text: "说明文字\n表2 中国国际大学生创新大赛加分细则", locator: { kind: "paragraph", paragraph: 20 } },
      { id: crypto.randomUUID(), text: "表2 中国国际大学生创新大赛加分细则\n竞赛级别 | 金奖 | 银奖", locator: { kind: "cell", sheet: "Table 2", cellRef: "A1:C3" } }
    ];
    const now = new Date().toISOString();
    const database = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      database.prepare("INSERT INTO sources(id,project_id,kind,display_name,status,created_at,updated_at) VALUES (?,?,'docx','rules.docx','active',?,?)").run(sourceId, projectId, now, now);
      database.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state,created_at,activated_at) VALUES (?,?,'.','.','hash','cell','persisted','ready',?,?)").run(revisionId, sourceId, now, now);
      database.prepare("UPDATE sources SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
      const insertChunk = database.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,text,locator_json,content_hash) VALUES (?,?,?,?,?,?)");
      rows.forEach((row, ordinal) => insertChunk.run(row.id, revisionId, ordinal, row.text, JSON.stringify(row.locator), `hash-${ordinal}`));
      database.prepare("INSERT INTO embedding_spaces(id,project_id,provider,model_id,model_revision,dimension,distance,pooling,preprocess_version,chunking_version,fingerprint,state,progress_1000,created_at,updated_at) VALUES (?,?,'openai-compatible','text-embedding-e2e','text-embedding-e2e',3,'cosine','mean','provider-default-v1','persisted',?,'active',1000,?,?)").run(spaceId, projectId, embedFingerprint(), now, now);
      database.prepare("INSERT INTO project_embedding_spaces(project_id,space_id,updated_at) VALUES (?,?,?)").run(projectId, spaceId, now);
      database.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES (?,?,'文件里有多少表格',?,?)").run(conversationId, projectId, now, now);
      const insertMessage = database.prepare("INSERT INTO messages(id,conversation_id,sequence,role,content,state,reply_to_message_id,provider,profile_id,model,completion_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const firstUser = crypto.randomUUID();
      const firstAssistant = crypto.randomUUID();
      const cancelledUser = crypto.randomUUID();
      const cancelledAssistant = crypto.randomUUID();
      insertMessage.run(firstUser, conversationId, 0, "user", "文件里有多少表格", "completed", null, null, null, null, null, now, now);
      insertMessage.run(firstAssistant, conversationId, 1, "assistant", "有两张表。", "completed", firstUser, "openai-compatible", generationProfileId, "gpt-e2e", "stop", now, now);
      insertMessage.run(cancelledUser, conversationId, 2, "user", "确定吗", "completed", null, null, null, null, null, now, now);
      insertMessage.run(cancelledAssistant, conversationId, 3, "assistant", "", "cancelled", cancelledUser, "openai-compatible", generationProfileId, "gpt-e2e", "user_abort", now, now);
    } finally {
      database.close();
    }
    const vectors = await lancedb.connect(path.join(userDataDir, "vectors"));
    try {
      const tableName = `space_${spaceId.replaceAll("-", "_")}`;
      await vectors.createTable(tableName, lancedb.makeArrowTable(rows.map((row, ordinal) => ({
        chunkId: row.id, projectId, sourceId, revisionId, spaceId, ordinal, contentHash: `hash-${ordinal}`,
        text: row.text, vector: [1, 0, 0], locatorJson: JSON.stringify(row.locator), createdAt: Date.now()
      }))));
      const table = await vectors.openTable(tableName);
      await table.createIndex("text", { config: lancedb.Index.fts(), replace: false });
    } finally {
      await vectors.close();
    }

    const second = await launchWithUserData(userDataDir);
    app = second.app;
    const editorButton = second.page.getByRole("button", { name: /编辑并重新发送|Edit and resend/ });
    await expect(editorButton).toBeVisible();
    await editorButton.click();
    const editor = second.page.getByRole("textbox", { name: /编辑并重新发送|Edit and resend/ });
    await expect(editor).toHaveValue("确定吗");
    await expect(second.page.getByRole("textbox", { name: /针对这个项目提问|Ask about your sources/ })).toHaveValue("");
    await expect(editor.locator("xpath=ancestor::div[contains(@class,'bubble')]")).toBeVisible();
    await editor.fill("真的确定吗");
    await editor.locator("xpath=ancestor::article").getByRole("button", { name: /发送|Send/ }).click();
    await expect(second.page.getByText(/已确认：文件有两张表/)).toBeVisible();

    await expect(second.page.locator(".msg.user")).toHaveCount(2);
    await expect(second.page.locator(".msg.user").last()).toContainText("真的确定吗");
    await expect(second.page.locator(".cite-item")).toHaveCount(2);
    const chatRequest = provider.requests.findLast((request) => Array.isArray(request.messages) && JSON.stringify(request.messages).includes("真的确定吗"));
    expect(chatRequest).toBeTruthy();
    const messages = chatRequest!.messages as Array<{ role: string; content: string }>;
    expect(messages.some((message) => message.role === "user" && message.content === "文件里有多少表格")).toBe(true);
    expect(messages.some((message) => message.role === "assistant" && message.content === "有两张表。")).toBe(true);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "真的确定吗" });
    expect(messages.find((message) => message.content.includes("<retrieved-evidence>"))?.content.match(/<evidence id=/g)).toHaveLength(2);

    await second.page.locator(".conv-trigger").click();
    await second.page.locator(".conv-new").click();
    await expect(second.page.locator(".conv-trigger-title")).toHaveText(/新对话|New chat/);
    await expect(second.page.locator(".msg")).toHaveCount(0);
    await closeElectron(second.app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await provider.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
