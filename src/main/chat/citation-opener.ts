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

/** Opens citations only through authoritative SQLite rows; model text is never a destination. */
export class CitationOpener {
  constructor(private readonly db: Database.Database, shell?: ShellLike) {
    this.shell = shell ?? realShell;
  }

  private readonly shell: ShellLike;

  async openCitation(input: { projectId: string; citationId: string }): Promise<Result<{ opened: "document" | "url" }>> {
    try {
      const row = this.db.prepare(
        "SELECT mc.source_id, mc.locator_json FROM message_citations mc JOIN messages m ON m.id = mc.message_id JOIN conversations c ON c.id = m.conversation_id WHERE mc.id = ? AND c.project_id = ?"
      ).get(input.citationId, input.projectId) as CitationRow | undefined;
      if (!row) return this.failure("NOT_FOUND", "errors.notFound");
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
      ).get(row.source_id, input.projectId) as { stored_path?: string } | undefined;
      if (!stored?.stored_path) return this.failure("NOT_FOUND", "errors.sourceUnavailable");
      const outcome = await this.shell.openPath(stored.stored_path);
      // Windows openPath resolves with a non-empty error string instead of throwing.
      if (typeof outcome === "string" && outcome !== "") return this.failure("INTERNAL", "errors.citationOpenFailed");
      return { ok: true, value: { opened: "document" } };
    } catch {
      return this.failure("INTERNAL", "errors.citationOpenFailed");
    }
  }

  private failure(code: "NOT_FOUND" | "UNSAFE_INPUT" | "INTERNAL", messageKey: string): Result<never> {
    return { ok: false, error: { code, messageKey, recoverable: code === "INTERNAL" } };
  }
}
