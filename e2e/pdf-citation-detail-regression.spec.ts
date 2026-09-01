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

test("view source returns the PDF detail and renders its cited page", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const userDataDir = testInfo.outputPath("user-data");
  const sourceId = "31111111-1111-4111-8111-111111111111";
  const revisionId = "32222222-2222-4222-8222-222222222222";
  const chunkId = "33333333-3333-4333-8333-333333333334";
  const messageId = "34444444-4444-4444-8444-444444444444";
  const generationProfileId = "35555555-5555-4555-8555-555555555555";
  const storedPath = path.join(userDataDir, "files", sourceId, revisionId, "content");
  let first: ElectronApplication | undefined;
  let second: ElectronApplication | undefined;

  try {
    const started = await launch(userDataDir);
    first = started.app;
    await started.page.getByRole("button", { name: /稍后配置模型|Configure later/ }).click();
    await started.page.getByRole("button", { name: /新建项目|New project/ }).first().click();
    await started.page.getByLabel(/项目名称|Project name/).fill("PDF citation detail");
    await started.page.getByRole("button", { name: /确认|Confirm/ }).click();
    const setup = await started.page.evaluate(async () => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const project = (await api.projects.list()).find((item: { name: string }) => item.name === "PDF citation detail");
      if (!project) throw new Error("project missing");
      const conversation = await api.conversations.create({ projectId: project.id, title: "PDF evidence" });
      if (!conversation.ok) throw new Error("conversation missing");
      return { projectId: project.id, conversationId: conversation.value.id };
    });
    await first.close();
    first = undefined;

    await fs.mkdir(path.dirname(storedPath), { recursive: true });
    await fs.copyFile(path.resolve("src/test/fixtures/documents/sample.pdf"), storedPath);
    const now = new Date().toISOString();
    const answer = "The authoritative result is on page three [S1]";
    const database = new Database(path.join(userDataDir, "data", "app.db"));
    try {
      database.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled) VALUES (?, 'PDF E2E Generation', 'openai-compatible', 'generation', 'http://127.0.0.1:65535/v1', 'pdf-e2e', 1)").run(generationProfileId);
      database.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled) VALUES ('00000000-0000-4000-8000-000000000001', 'Local Embedding', 'local', 'embedding', 'local://huggingface', 'Xenova/all-MiniLM-L6-v2', 1)").run();
      const insertRoute = database.prepare("INSERT INTO model_routes(task_kind, position, profile_id) VALUES (?, 0, ?)");
      for (const task of ["chat", "note-title", "summary", "key-points", "qa", "custom-transformation"]) insertRoute.run(task, generationProfileId);
      insertRoute.run("embedding", "00000000-0000-4000-8000-000000000001");
      database.prepare("INSERT INTO sources(id, project_id, kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'pdf', 'sample.pdf', 'active', ?, ?)").run(sourceId, setup.projectId, now, now);
      database.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state, created_at, activated_at) VALUES (?, ?, 'sample.pdf', ?, 'e2e-pdf', 'page', 'v1', 'ready', ?, ?)").run(revisionId, sourceId, storedPath, now, now);
      database.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(revisionId, sourceId);
      database.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, 0, 'Page three has the authoritative result.', ?, 'e2e-pdf-chunk')").run(chunkId, revisionId, JSON.stringify({ kind: "page", page: 3 }));
      database.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, 0, 'assistant', ?, 'completed', ?, ?)").run(messageId, setup.conversationId, answer, now, now);
      database.prepare("INSERT INTO message_citations(id, message_id, label, source_id, source_chunk_id, source_display_name, source_kind, locator_json, quote, created_at, start) VALUES (?, ?, 'S1', ?, ?, 'sample.pdf', 'pdf', ?, 'Page three has the authoritative result.', ?, ?)").run(`${messageId}:S1:42`, messageId, sourceId, chunkId, JSON.stringify({ kind: "page", page: 3 }), now, answer.indexOf("[S1]"));
      database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, setup.conversationId);
    } finally {
      database.close();
    }

    const restarted = await launch(userDataDir);
    second = restarted.app;
    await restarted.page.locator(".project-item", { hasText: "PDF citation detail" }).locator(".project-item-btn").click();
    await restarted.page.getByRole("button", { name: /查看原文|View source/ }).click();
    await expect(restarted.page.getByText(/操作未能完成|The operation could not be completed/)).toHaveCount(0);
    await expect(restarted.page.getByText(/原文暂不可用|source excerpt is unavailable/)).toHaveCount(0);
    const canvas = restarted.page.locator(".citation-pdf-page canvas");
    await expect(canvas).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => canvas.evaluate((item) => {
      const target = item as HTMLCanvasElement;
      return target.width > 0 && target.height > 0;
    })).toBe(true);
  } finally {
    await Promise.allSettled([first?.close() ?? Promise.resolve(), second?.close() ?? Promise.resolve()]);
  }
});
