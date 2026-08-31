import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { CitationOpener } from "./citation-opener";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const PDF_SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const URL_SOURCE_ID = "77777777-7777-4777-8777-777777777777";
const URL_REVISION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PDF_REVISION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PDF_CHUNK_ID = "99999999-9999-4999-8999-999999999999";
const XLSX_SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const XLSX_REVISION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const XLSX_CHUNK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("CitationOpener", () => {
  let world: AppDatabase;
  let openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
  let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<unknown>>>;
  let readManagedFile: ReturnType<typeof vi.fn<(path: string) => Promise<Uint8Array>>>;

  beforeEach(() => {
    world = openAppDatabase(":memory:", "src/main/db/migrations");
    openPath = vi.fn(async () => "");
    openExternal = vi.fn(async () => undefined);
    readManagedFile = vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    world.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Project");
    world.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, ?, ?)")
      .run(PDF_SOURCE_ID, PROJECT_ID, "pdf", "Research PDF");
    world.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(PDF_REVISION_ID, PDF_SOURCE_ID, "original.pdf", String.raw`C:\managed\content`, "sha256:test", "page", "v1");
    world.connection.prepare("UPDATE source_revisions SET state = 'ready' WHERE id = ?").run(PDF_REVISION_ID);
    world.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, 0, ?, ?, ?)")
      .run(PDF_CHUNK_ID, PDF_REVISION_ID, "sha256:chunk", "完整的权威原文。\n\n第二段。", JSON.stringify({ kind: "page", page: 2 }));
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

  function addCitation(input: { id: string; sourceId: string; locator: Record<string, unknown>; sourceChunkId?: string }): void {
    world.connection.prepare(
      "INSERT INTO message_citations(id, message_id, label, source_id, source_chunk_id, source_display_name, source_kind, locator_json, created_at) VALUES (?, ?, 'S1', ?, ?, 'Name', 'kind', ?, ?)"
    ).run(input.id, MESSAGE_ID, input.sourceId, input.sourceChunkId ?? null, JSON.stringify(input.locator), "2026-08-27T00:00:00.000Z");
  }

  function makeOpener(): CitationOpener {
    return new CitationOpener(world.connection, { openPath, openExternal }, readManagedFile);
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

  it("returns the complete authoritative chunk only to its owning project", async () => {
    addCitation({ id: "c-detail", sourceId: PDF_SOURCE_ID, sourceChunkId: PDF_CHUNK_ID, locator: { kind: "page", page: 2 } });

    await expect(makeOpener().getCitationDetail({ projectId: PROJECT_ID, citationId: "c-detail" })).resolves.toEqual({
      ok: true,
      value: {
        text: "完整的权威原文。\n\n第二段。",
        kind: "pdf",
        data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sheet: null
      }
    });
    expect(readManagedFile).toHaveBeenCalledWith(String.raw`C:\managed\content`);
    await expect(makeOpener().getCitationDetail({
      projectId: "99999999-9999-4999-8999-999999999999",
      citationId: "c-detail"
    })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("parses only the cited worksheet rows in the main process", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("数据");
    sheet.mergeCells("A1:B1");
    sheet.getCell("A1").value = "指标";
    sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    sheet.getCell("B6").value = 42;
    readManagedFile.mockResolvedValueOnce(new Uint8Array(await workbook.xlsx.writeBuffer()));

    world.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, 'xlsx', '表格.xlsx')")
      .run(XLSX_SOURCE_ID, PROJECT_ID);
    world.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, 'original.xlsx', ?, 'sha256:xlsx', 'row', 'v1', 'ready')")
      .run(XLSX_REVISION_ID, XLSX_SOURCE_ID, String.raw`C:\managed\sheet`);
    world.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, content_hash, text, locator_json) VALUES (?, ?, 0, 'sha256:xlsx-chunk', '指标 | 42', ?)")
      .run(XLSX_CHUNK_ID, XLSX_REVISION_ID, JSON.stringify({ kind: "row", sheet: "数据", startRow: 6, endRow: 6 }));
    addCitation({ id: "c-xlsx", sourceId: XLSX_SOURCE_ID, sourceChunkId: XLSX_CHUNK_ID, locator: { kind: "row", sheet: "数据", startRow: 6, endRow: 6 } });

    const result = await makeOpener().getCitationDetail({ projectId: PROJECT_ID, citationId: "c-xlsx" });
    expect(result).toMatchObject({ ok: true, value: { kind: "xlsx", data: null, sheet: { name: "数据" } } });
    if (!result.ok || !result.value.sheet) throw new Error("missing sheet preview");
    expect(result.value.sheet.columns.map((column) => column.number)).toEqual([1, 2]);
    expect(result.value.sheet.rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.value.sheet.rows[0]?.cells[0]).toMatchObject({
      column: 1, text: "指标", colSpan: 2, style: { fontWeight: 700, backgroundColor: "#2563EB" }
    });
    expect(result.value.sheet.rows.at(-1)?.cells[1]).toMatchObject({ column: 2, text: "42" });
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
