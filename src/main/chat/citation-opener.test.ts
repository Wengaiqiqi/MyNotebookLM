import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { CitationOpener } from "./citation-opener";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const PDF_SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const URL_SOURCE_ID = "77777777-7777-4777-8777-777777777777";
const URL_REVISION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("CitationOpener", () => {
  let world: AppDatabase;
  let openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
  let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<unknown>>>;

  beforeEach(() => {
    world = openAppDatabase(":memory:", "src/main/db/migrations");
    openPath = vi.fn(async () => "");
    openExternal = vi.fn(async () => undefined);
    world.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Project");
    world.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, ?, ?)")
      .run(PDF_SOURCE_ID, PROJECT_ID, "pdf", "Research PDF");
    world.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PDF_SOURCE_ID, "original.pdf", String.raw`C:\managed\content`, "sha256:test", "page", "v1");
    world.connection.prepare("UPDATE source_revisions SET state = 'ready' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").run();
    world.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, ?, ?)")
      .run(URL_SOURCE_ID, PROJECT_ID, "url", "Article");
    world.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(URL_REVISION_ID, URL_SOURCE_ID, "https://example.com/article", "https://example.com/article", "sha256:url", "section", "v1");
    world.connection.prepare("UPDATE sources SET current_revision_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' WHERE id = ?").run(PDF_SOURCE_ID);
    world.connection.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(CONVERSATION_ID, PROJECT_ID, "Research", "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
    world.connection.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, 0, 'assistant', '', 'completed', ?, ?)")
      .run(MESSAGE_ID, CONVERSATION_ID, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
  });

  function addCitation(input: { id: string; sourceId: string; locator: Record<string, unknown> }): void {
    world.connection.prepare(
      "INSERT INTO message_citations(id, message_id, label, source_id, source_chunk_id, source_display_name, source_kind, locator_json, created_at) VALUES (?, ?, 'S1', ?, NULL, 'Name', 'kind', ?, ?)"
    ).run(input.id, MESSAGE_ID, input.sourceId, JSON.stringify(input.locator), "2026-08-27T00:00:00.000Z");
  }

  function makeOpener(): CitationOpener {
    return new CitationOpener(world.connection, { openPath, openExternal });
  }

  it("opens a local document through shell after repository lookup of the managed original", async () => {
    addCitation({ id: "c-pdf", sourceId: PDF_SOURCE_ID, locator: { kind: "page", page: 2 } });
    const result = await makeOpener().openCitation({ projectId: PROJECT_ID, citationId: "c-pdf" });
    expect(result).toMatchObject({ ok: true });
    expect(openPath).toHaveBeenCalledWith(String.raw`C:\managed\content`);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens a stored source target only after project ownership validation", async () => {
    const result = await makeOpener().openSource({ projectId: PROJECT_ID, sourceId: PDF_SOURCE_ID });
    expect(result).toMatchObject({ ok: true, value: { opened: "document" } });
    expect(openPath).toHaveBeenCalledWith(String.raw`C:\managed\content`);
    expect(await makeOpener().openSource({ projectId: "99999999-9999-4999-8999-999999999999", sourceId: PDF_SOURCE_ID })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("revalidates and opens the stored authoritative URL, never model text", async () => {
    addCitation({ id: "c-url", sourceId: URL_SOURCE_ID, locator: { kind: "section", sectionPath: "root", url: "https://example.com/article" } });
    const result = await makeOpener().openCitation({ projectId: PROJECT_ID, citationId: "c-url" });
    expect(result).toMatchObject({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/article");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("rejects an unsafe stored URL citation with UNSAFE_INPUT", async () => {
    addCitation({ id: "c-bad-url", sourceId: URL_SOURCE_ID, locator: { kind: "section", sectionPath: "root", url: "http://127.0.0.1/x" } });
    const result = await makeOpener().openCitation({ projectId: PROJECT_ID, citationId: "c-bad-url" });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_INPUT" } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("fails with NOT_FOUND when the citation does not belong to the caller's project", async () => {
    const result = await makeOpener().openCitation({ projectId: "99999999-9999-4999-8999-999999999999", citationId: "c-pdf" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("maps shell launch failures to INTERNAL without leaking raw error details", async () => {
    addCitation({ id: "c-pdf2", sourceId: PDF_SOURCE_ID, locator: { kind: "page", page: 3 } });
    openPath.mockResolvedValue("access denied");
    const result = await makeOpener().openCitation({ projectId: PROJECT_ID, citationId: "c-pdf2" });
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(result)).not.toContain("classified");
  });

  afterEach(() => {
    world.close();
  });
});
