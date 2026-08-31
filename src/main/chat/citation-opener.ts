import type Database from "better-sqlite3";
import ExcelJS, { type Cell, type Color, type Worksheet } from "exceljs";
import { shell } from "electron";
import { readFile } from "node:fs/promises";
import { parseSafeUrl } from "../sources/url-policy";
import type { Result } from "../../shared/app-errors";
import type { CitationDetailResultValue, CitationSheetPreview } from "../../shared/ipc";
import { sourceLocatorSchema, type SourceKind, type SourceLocator } from "../../shared/sources";
import { previewDocxTable } from "../../workers/ingestion/parsers/docx-parser";

type ShellLike = {
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<unknown>;
};

const realShell: ShellLike = {
  openPath: (path) => shell.openPath(path),
  openExternal: (url) => shell.openExternal(url)
};

type CitationRow = {
  source_id: string;
  locator_json: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Opens citations only through authoritative SQLite rows; model text is never a destination. */
export class CitationOpener {
  constructor(
    private readonly db: Database.Database,
    shell?: ShellLike,
    private readonly readManagedFile: (path: string) => Promise<Uint8Array> = async (path) => new Uint8Array(await readFile(path))
  ) {
    this.shell = shell ?? realShell;
  }

  private readonly shell: ShellLike;

  async openCitation(input: { projectId: string; citationId: string }): Promise<Result<{ opened: "document" | "url" }>> {
    try {
      const row = this.rowFor(input.citationId, input.projectId);
      if (!row) return this.failure("NOT_FOUND", "errors.notFound");
      return await this.openRow(row, input.projectId);
    } catch {
      return this.failure("INTERNAL", "errors.citationOpenFailed");
    }
  }

  async getCitationDetail(input: { projectId: string; citationId: string }): Promise<Result<CitationDetailResultValue>> {
    try {
      const row = this.db.prepare(
        "SELECT CASE WHEN sr.id IS NULL THEN NULL ELSE sc.text END AS text, m.content AS message_content, mc.start, s.kind, mc.locator_json, CASE WHEN sr.id IS NULL THEN NULL ELSE sr.stored_path END AS stored_path FROM message_citations mc JOIN messages m ON m.id = mc.message_id JOIN conversations c ON c.id = m.conversation_id JOIN sources s ON s.id = mc.source_id AND s.project_id = c.project_id LEFT JOIN source_chunks sc ON sc.id = mc.source_chunk_id LEFT JOIN source_revisions sr ON sr.id = sc.revision_id AND sr.source_id = s.id WHERE mc.id = ? AND c.project_id = ?"
      ).get(input.citationId, input.projectId) as { text: string | null; message_content: string; start: number; kind: SourceKind; locator_json: string; stored_path: string | null } | undefined;
      if (!row) return this.failure("NOT_FOUND", "errors.notFound");
      let data: CitationDetailResultValue["data"] = null;
      let sheet: CitationSheetPreview | null = null;
      if (row.stored_path && row.kind === "pdf") {
        const bytes = await this.readManagedFile(row.stored_path).catch(() => null);
        if (bytes) {
          data = new Uint8Array(bytes.byteLength);
          data.set(bytes);
        }
      }
      if (row.stored_path && row.kind === "xlsx") {
        const bytes = await this.readManagedFile(row.stored_path).catch(() => null);
        const locator = sourceLocatorSchema.safeParse(JSON.parse(row.locator_json));
        if (bytes && locator.success) sheet = await workbookPreview(bytes, locator.data).catch(() => null);
      }
      if (row.stored_path && row.kind === "docx") {
        const bytes = await this.readManagedFile(row.stored_path).catch(() => null);
        const locator = sourceLocatorSchema.safeParse(JSON.parse(row.locator_json));
        const tableName = locator.success && locator.data.kind === "cell" && /^Table \d+$/.test(locator.data.sheet) ? locator.data.sheet : undefined;
        const claim = citationClaim(row.message_content, row.start);
        if (bytes && locator.success) sheet = await previewDocxTable(bytes, claim || row.text || "", tableName).catch(() => null);
      }
      return { ok: true, value: { text: row.text, kind: row.kind, data, sheet } };
    } catch {
      return this.failure("INTERNAL", "errors.citationDetailFailed");
    }
  }

  async openSource(input: { projectId: string; sourceId: string }): Promise<Result<{ opened: "document" | "url" }>> {
    try {
      const row = this.db.prepare("SELECT s.kind, sr.original_path, sr.stored_path FROM sources s JOIN source_revisions sr ON sr.source_id = s.id WHERE s.id = ? AND s.project_id = ? AND s.status <> 'deleted' AND sr.state = 'ready' ORDER BY CASE WHEN sr.id = s.current_revision_id THEN 0 ELSE 1 END, sr.created_at DESC LIMIT 1").get(input.sourceId, input.projectId) as { kind?: string; original_path?: string; stored_path?: string } | undefined;
      if (!row) return this.failure("NOT_FOUND", "errors.notFound");
      if (row.kind === "url") {
        if (!row.original_path) return this.failure("NOT_FOUND", "errors.sourceUnavailable");
        let parsed: URL;
        try { parsed = parseSafeUrl(row.original_path); } catch { return this.failure("UNSAFE_INPUT", "errors.unsafeInput"); }
        if (parsed.href !== row.original_path) return this.failure("UNSAFE_INPUT", "errors.unsafeInput");
        await this.shell.openExternal(parsed.href);
        return { ok: true, value: { opened: "url" } };
      }
      if (!row.stored_path) return this.failure("NOT_FOUND", "errors.sourceUnavailable");
      const outcome = await this.shell.openPath(row.stored_path);
      if (typeof outcome === "string" && outcome !== "") return this.failure("INTERNAL", "errors.citationOpenFailed");
      return { ok: true, value: { opened: "document" } };
    } catch { return this.failure("INTERNAL", "errors.citationOpenFailed"); }
  }

  private rowFor(citationId: string, projectId: string): CitationRow | undefined {
    const byId = this.db.prepare(
      "SELECT mc.source_id, mc.locator_json FROM message_citations mc JOIN messages m ON m.id = mc.message_id JOIN conversations c ON c.id = m.conversation_id WHERE mc.id = ? AND c.project_id = ?"
    ).get(citationId, projectId) as CitationRow | undefined;
    if (byId) return byId;
    // Citation ids are message-scoped ("messageId:label:start"); accept a plain message UUID too.
    if (!UUID_RE.test(citationId)) return undefined;
    return this.db.prepare(
      "SELECT mc.source_id, mc.locator_json FROM message_citations mc JOIN messages m ON m.id = mc.message_id JOIN conversations c ON c.id = m.conversation_id WHERE mc.message_id = ? AND c.project_id = ? ORDER BY mc.created_at ASC, mc.start ASC LIMIT 1"
    ).get(citationId, projectId) as CitationRow | undefined;
  }

  private async openRow(row: CitationRow, projectId: string): Promise<Result<{ opened: "document" | "url" }>> {
    const locator = JSON.parse(row.locator_json) as Record<string, unknown>;
    const url = typeof locator.url === "string" ? locator.url : undefined;
    if (url) {
      let parsed: URL;
      try {
        parsed = parseSafeUrl(url);
      } catch {
        return this.failure("UNSAFE_INPUT", "errors.unsafeInput");
      }
      if (parsed.href !== url) return this.failure("UNSAFE_INPUT", "errors.unsafeInput");
      await this.shell.openExternal(parsed.href);
      return { ok: true, value: { opened: "url" } };
    }
    const stored = this.db.prepare(
      "SELECT sr.stored_path FROM sources s JOIN source_revisions sr ON sr.source_id = s.id WHERE s.id = ? AND s.project_id = ? AND s.status <> 'deleted' AND sr.state = 'ready' ORDER BY sr.created_at DESC LIMIT 1"
    ).get(row.source_id, projectId) as { stored_path?: string } | undefined;
    if (!stored?.stored_path) return this.failure("NOT_FOUND", "errors.sourceUnavailable");
    const outcome = await this.shell.openPath(stored.stored_path);
    // Windows openPath resolves with a non-empty error string instead of throwing.
    if (typeof outcome === "string" && outcome !== "") return this.failure("INTERNAL", "errors.citationOpenFailed");
    return { ok: true, value: { opened: "document" } };
  }

  private failure(code: "NOT_FOUND" | "UNSAFE_INPUT" | "INTERNAL", messageKey: string): Result<never> {
    return { ok: false, error: { code, messageKey, recoverable: code === "INTERNAL" } };
  }
}

function citationClaim(content: string, start: number): string {
  const before = content.slice(0, Math.max(0, start));
  const boundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"));
  return before.slice(boundary + 1).trim();
}

async function workbookPreview(data: Uint8Array, locator: SourceLocator): Promise<CitationSheetPreview | null> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const requestedName = locator.kind === "sheet" || locator.kind === "cell" || locator.kind === "row" ? locator.sheet : "";
  const sheet = workbook.getWorksheet(requestedName) ?? workbook.worksheets.find((item) => item.state === "visible") ?? workbook.worksheets[0];
  if (!sheet) return null;

  const citedRows = rowsFor(sheet, locator);
  const rows = [...new Set([...(citedRows[0] && citedRows[0] > 5 ? [1, 2, 3, 4, 5] : []), ...citedRows])]
    .filter((row) => row <= sheet.rowCount);
  // ponytail: bound the IPC and DOM payload; add column virtualization only if cited sheets exceed 256 used columns.
  const columnCount = Math.min(sheet.actualColumnCount || sheet.columnCount, 256);
  const merges = mergeMap(sheet, new Set(rows), columnCount);

  return {
    name: sheet.name,
    columns: Array.from({ length: columnCount }, (_, index) => {
      const number = index + 1;
      return { number, width: Math.max(48, (sheet.getColumn(number).width ?? 10) * 7) };
    }),
    rows: rows.map((number) => {
      const row = sheet.getRow(number);
      return {
        number,
        ...(row.height ? { height: row.height * 96 / 72 } : {}),
        cells: Array.from({ length: columnCount }, (_, index) => {
          const column = index + 1;
          const cell = row.getCell(column);
          return {
            column,
            text: cell.text,
            ...merges.get(cell.address),
            ...(cell.formula ? { formula: cell.formula } : {}),
            ...(cellPreviewStyle(cell) ?? {})
          };
        })
      };
    })
  };
}

function rowsFor(sheet: Worksheet, locator: SourceLocator): number[] {
  if (locator.kind === "row" && locator.sheet === sheet.name) {
    return Array.from({ length: Math.min(locator.endRow - locator.startRow + 1, 100) }, (_, index) => locator.startRow + index);
  }
  if (locator.kind === "cell" && locator.sheet === sheet.name) return [sheet.getCell(locator.cellRef).fullAddress.row];
  return Array.from({ length: Math.min(sheet.rowCount, 100) }, (_, index) => index + 1);
}

function mergeMap(sheet: Worksheet, selectedRows: Set<number>, columnCount: number): Map<string, { covered?: boolean; colSpan?: number; rowSpan?: number }> {
  const result = new Map<string, { covered?: boolean; colSpan?: number; rowSpan?: number }>();
  for (const range of sheet.model.merges) {
    const [startAddress, endAddress = startAddress] = range.split(":");
    if (!startAddress || !endAddress) continue;
    const start = sheet.getCell(startAddress).fullAddress;
    const end = sheet.getCell(endAddress).fullAddress;
    if (end.col > columnCount || !Array.from({ length: end.row - start.row + 1 }, (_, index) => start.row + index).every((row) => selectedRows.has(row))) continue;
    result.set(startAddress, { colSpan: end.col - start.col + 1, rowSpan: end.row - start.row + 1 });
    for (let row = start.row; row <= end.row; row += 1) {
      for (let column = start.col; column <= end.col; column += 1) {
        const address = sheet.getCell(row, column).address;
        if (address !== startAddress) result.set(address, { covered: true });
      }
    }
  }
  return result;
}

function cellPreviewStyle(cell: Cell): { style: CitationSheetPreview["rows"][number]["cells"][number]["style"] } | null {
  const font = cell.font;
  const alignment = cell.alignment;
  const style: NonNullable<CitationSheetPreview["rows"][number]["cells"][number]["style"]> = {};
  if (font) {
    style.color = excelColor(font.color);
    style.fontFamily = font.name;
    style.fontSize = font.size;
    style.fontWeight = font.bold ? 700 : undefined;
    style.fontStyle = font.italic ? "italic" : undefined;
    style.textDecoration = font.underline ? "underline" : undefined;
  }
  if (cell.fill?.type === "pattern" && cell.fill.pattern !== "none") style.backgroundColor = excelColor(cell.fill.fgColor);
  if (alignment) {
    style.textAlign = alignment.horizontal === "centerContinuous" ? "center"
      : alignment.horizontal === "left" || alignment.horizontal === "center" || alignment.horizontal === "right" || alignment.horizontal === "justify"
        ? alignment.horizontal
        : undefined;
    style.verticalAlign = alignment.vertical === "top" || alignment.vertical === "middle" || alignment.vertical === "bottom" ? alignment.vertical : undefined;
    style.whiteSpace = alignment.wrapText ? "pre-wrap" : "nowrap";
  }
  return Object.values(style).some((value) => value !== undefined) ? { style } : null;
}

function excelColor(value: Partial<Color> | undefined): string | undefined {
  const argb = value?.argb;
  return argb ? `#${argb.length === 8 ? argb.slice(2) : argb}` : undefined;
}
