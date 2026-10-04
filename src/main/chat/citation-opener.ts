import type Database from "better-sqlite3";
import { shell } from "electron";
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSafeUrl } from "../sources/url-policy";
import type { Result } from "../../shared/app-errors";
import type { CitationDetailResultValue } from "../../shared/ipc";
import { sourceLocatorSchema, type SourceKind, type SourceLocator } from "../../shared/sources";
import { runCitationPreview, type CitationPreviewRequest, type CitationPreviewResult } from "../../workers/preview/citation-preview";
import { citationClaim } from "./citation-relevance";

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

const ORIGINAL_COPY_PREFIX = "mynotebooklm-original-";

/** Typed copies stay behind while an external app reads them; reclaim them once they are old. */
export async function purgeStaleOriginalCopies(maxAgeMs = 24 * 60 * 60 * 1000, root = tmpdir(), now = Date.now()): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(ORIGINAL_COPY_PREFIX)) continue;
    const directory = path.join(root, name);
    try {
      const info = await stat(directory);
      // Still-open files (Windows locks) fail here and are retried on the next start.
      if (info.isDirectory() && now - info.mtimeMs > maxAgeMs) await rm(directory, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_EXTENSIONS: Partial<Record<SourceKind, string>> = {
  text: ".txt", markdown: ".md", pdf: ".pdf", docx: ".docx", pptx: ".pptx", xlsx: ".xlsx", csv: ".csv"
};

/** Opens citations only through authoritative SQLite rows; model text is never a destination. */
export class CitationOpener {
  constructor(
    private readonly db: Database.Database,
    shell?: ShellLike,
    private readonly readManagedFile: (path: string) => Promise<Uint8Array> = async (path) => new Uint8Array(await readFile(path)),
    private readonly preview: (request: CitationPreviewRequest) => Promise<CitationPreviewResult> = runCitationPreview
  ) {
    this.shell = shell ?? realShell;
  }

  private readonly shell: ShellLike;

  async openChunk(input: { projectId: string; chunkId: string }): Promise<Result<{ opened: "document" | "url" }>> {
    try {
      const row = this.db.prepare(`SELECT sr.source_id,sc.locator_json FROM source_chunks sc
        JOIN source_revisions sr ON sr.id=sc.revision_id JOIN sources s ON s.id=sr.source_id
        WHERE sc.id=? AND s.project_id=? AND s.status='active'`).get(input.chunkId, input.projectId) as CitationRow | undefined;
      if (!row) return this.failure("NOT_FOUND", "errors.notFound");
      return await this.openRow(row, input.projectId);
    } catch { return this.failure("INTERNAL", "errors.citationOpenFailed"); }
  }

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
      let sheet: CitationDetailResultValue["sheet"] = null;
      let images: CitationDetailResultValue["images"] = [];
      const claim = citationClaim(row.message_content, row.start);
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
        if (bytes && locator.success) sheet = (await this.preview({ kind: "xlsx", data: bytes, locator: locator.data, citedText: "" }).catch(() => null))?.sheet ?? null;
      }
      if (row.stored_path && row.kind === "docx") {
        const bytes = await this.readManagedFile(row.stored_path).catch(() => null);
        const locator = sourceLocatorSchema.safeParse(JSON.parse(row.locator_json));
        const tableName = locator.success && locator.data.kind === "cell" && /^Table \d+$/.test(locator.data.sheet) ? locator.data.sheet : undefined;
        if (bytes && locator.success) {
          const preview = await this.preview({ kind: "docx", data: bytes, locator: locator.data, citedText: claim || row.text || "", ...(tableName ? { tableName } : {}) }).catch(() => null);
          sheet = preview?.sheet ?? null;
          images = preview?.images ?? [];
        }
      }
      return { ok: true, value: { text: row.text, kind: row.kind, data, sheet, images } };
    } catch {
      return this.failure("INTERNAL", "errors.citationDetailFailed");
    }
  }

  async openSource(input: { projectId: string; sourceId: string }): Promise<Result<{ opened: "document" | "url" }>> {
    try {
      const row = this.db.prepare("SELECT s.kind, sr.original_path, sr.stored_path FROM sources s JOIN source_revisions sr ON sr.source_id = s.id WHERE s.id = ? AND s.project_id = ? AND s.status <> 'deleted' AND sr.state = 'ready' ORDER BY CASE WHEN sr.id = s.current_revision_id THEN 0 ELSE 1 END, sr.created_at DESC LIMIT 1").get(input.sourceId, input.projectId) as { kind: SourceKind; original_path?: string; stored_path?: string } | undefined;
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
      return await this.openDocument(row.stored_path, row.kind);
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
      "SELECT sr.stored_path, s.kind FROM sources s JOIN source_revisions sr ON sr.source_id = s.id WHERE s.id = ? AND s.project_id = ? AND s.status <> 'deleted' AND sr.state = 'ready' ORDER BY CASE WHEN sr.id = s.current_revision_id THEN 0 ELSE 1 END, sr.created_at DESC LIMIT 1"
    ).get(row.source_id, projectId) as { stored_path?: string; kind: SourceKind } | undefined;
    if (!stored?.stored_path) return this.failure("NOT_FOUND", "errors.sourceUnavailable");
    return await this.openDocument(stored.stored_path, stored.kind);
  }

  private async openDocument(storedPath: string, kind: SourceKind): Promise<Result<{ opened: "document" }>> {
    const extension = DOCUMENT_EXTENSIONS[kind];
    if (!extension) return this.failure("NOT_FOUND", "errors.sourceUnavailable");
    let temporaryDirectory: string | undefined;
    let opened = false;
    try {
      let target = storedPath;
      if (path.extname(storedPath).toLowerCase() !== extension) {
        // Managed imports use "content" without an extension. Windows needs a
        // typed copy to choose an application; keep the indexed original intact.
        temporaryDirectory = await mkdtemp(path.join(tmpdir(), ORIGINAL_COPY_PREFIX));
        target = path.join(temporaryDirectory, `original${extension}`);
        await copyFile(storedPath, target);
      }
      const outcome = await this.shell.openPath(target);
      // Windows openPath resolves with a non-empty error string instead of throwing.
      if (typeof outcome === "string" && outcome !== "") return this.failure("INTERNAL", "errors.citationOpenFailed");
      opened = true;
      return { ok: true, value: { opened: "document" } };
    } finally {
      // Successful copies must remain available while the external app reads them.
      if (temporaryDirectory && !opened) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private failure(code: "NOT_FOUND" | "UNSAFE_INPUT" | "INTERNAL", messageKey: string): Result<never> {
    return { ok: false, error: { code, messageKey, recoverable: code === "INTERNAL" } };
  }
}
