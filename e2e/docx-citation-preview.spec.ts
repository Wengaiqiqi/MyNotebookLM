import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.resolve("out/main/index.js")],
    env: { ...process.env, NODE_ENV: "test", MYNOTEBOOKLM_USER_DATA_DIR: userDataDir }
  });
  return { app, page: await app.firstWindow() };
}

async function skipOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: /稍后配置模型|Configure later/ });
  await expect(skip).toBeVisible();
  await skip.click();
}

test("legacy DOCX paragraph citation renders the matching source table", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const userDataDir = testInfo.outputPath("user-data");
  const externalDocument = process.env["DOCX_PREVIEW_TEST_FILE"];
  const documentFile = externalDocument ?? path.resolve("src/test/fixtures/documents/sample.docx");
  const sourceId = "21111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";
  const chunkId = "23333333-3333-4333-8333-333333333333";
  const messageId = "24444444-4444-4444-8444-444444444444";
  const generationProfileId = "25555555-5555-4555-8555-555555555555";
  const storedPath = path.join(userDataDir, "files", sourceId, revisionId, "content");
  const citedText = externalDocument
    ? "具体加分细则见表1。\n\n表1学科竞赛获奖加分细则\n\n参加创新大赛按表2加分。\n\n表2中国国际大学生创新大赛加分细则"
    : "A | B";
  await fs.mkdir(userDataDir, { recursive: true });

  let first: ElectronApplication | undefined;
  let second: ElectronApplication | undefined;
  try {
    const started = await launch(userDataDir);
    first = started.app;
    await skipOnboarding(started.page);
    await started.page.getByRole("button", { name: /新建项目|New project/ }).first().click();
    await started.page.getByLabel(/项目名称|Project name/).fill("DOCX citation preview");
    await started.page.getByRole("button", { name: /确认|Confirm/ }).click();
    const setup = await started.page.evaluate(async () => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const projects = await api.projects.list();
      const project = projects.find((item: { name: string }) => item.name === "DOCX citation preview");
      if (!project) throw new Error("project missing");
      const conversation = await api.conversations.create({ projectId: project.id, title: "DOCX table citation" });
      if (!conversation.ok) throw new Error(`conversation: ${conversation.error.code}`);
      return { projectId: project.id, conversationId: conversation.value.id };
    });
    await first.close();
    first = undefined;

    await fs.mkdir(path.dirname(storedPath), { recursive: true });
    await fs.copyFile(documentFile, storedPath);
    const now = new Date().toISOString();
    const database = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      database.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled) VALUES (?, 'DOCX E2E Generation', 'openai-compatible', 'generation', 'http://127.0.0.1:65535/v1', 'docx-e2e', 1)")
        .run(generationProfileId);
      database.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled) VALUES ('00000000-0000-4000-8000-000000000001', 'Local Embedding', 'local', 'embedding', 'local://huggingface', 'Xenova/all-MiniLM-L6-v2', 1)").run();
      const insertRoute = database.prepare("INSERT INTO model_routes(task_kind, position, profile_id) VALUES (?, 0, ?)");
      for (const task of ["chat", "note-title", "summary", "key-points", "qa", "custom-transformation"]) insertRoute.run(task, generationProfileId);
      insertRoute.run("embedding", "00000000-0000-4000-8000-000000000001");
      database.prepare("INSERT INTO sources(id, project_id, kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'docx', ?, 'active', ?, ?)")
        .run(sourceId, setup.projectId, path.basename(documentFile), now, now);
      database.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state, created_at, activated_at) VALUES (?, ?, ?, ?, 'e2e-docx', 'offset', 'v1', 'ready', ?, ?)")
        .run(revisionId, sourceId, documentFile, storedPath, now, now);
      database.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
      database.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, 0, ?, ?, 'e2e-docx-chunk')")
        .run(chunkId, revisionId, citedText, JSON.stringify({ kind: "paragraph", paragraph: 33, endParagraph: 43 }));
      database.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, 0, 'assistant', '表格证据 [S1]', 'completed', ?, ?)")
        .run(messageId, setup.conversationId, now, now);
      database.prepare("INSERT INTO message_citations(id, message_id, label, source_id, source_chunk_id, source_display_name, source_kind, locator_json, quote, created_at, start) VALUES (?, ?, 'S1', ?, ?, ?, 'docx', ?, ?, ?, 5)")
        .run(`${messageId}:S1:5`, messageId, sourceId, chunkId, path.basename(documentFile), JSON.stringify({ kind: "paragraph", paragraph: 33, endParagraph: 43 }), citedText, now);
      database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, setup.conversationId);
    } finally {
      database.close();
    }

    const restarted = await launch(userDataDir);
    second = restarted.app;
    await expect(restarted.page.getByRole("button", { name: "DOCX table citation" })).toBeVisible();
    await restarted.page.getByRole("button", { name: /查看原文|查看详细|View source|View details/ }).click();
    const table = restarted.page.locator(".citation-document-table");
    await expect(table).toBeVisible();
    if (externalDocument) {
      await expect(table.getByText("竞赛级别", { exact: true })).toBeVisible();
      await expect(table.getByText("一等奖及以上", { exact: true })).toBeVisible();
    } else {
      await expect(table.getByText("A", { exact: true })).toBeVisible();
      await expect(table.getByText("B", { exact: true })).toBeVisible();
    }
  } finally {
    await Promise.allSettled([
      first?.close() ?? Promise.resolve(),
      second?.close() ?? Promise.resolve()
    ]);
  }
});
