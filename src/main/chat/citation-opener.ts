import type Database from "better-sqlite3";
import { shell } from "electron";
import { parseSafeUrl } from "../sources/url-policy";
import type { Result } from "../../shared/app-errors";

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
  constructor(private readonly db: Database.Database, shell?: ShellLike) {
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
