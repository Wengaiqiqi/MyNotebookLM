import type Database from "better-sqlite3";
import { noteDtoSchema, noteLinkDtoSchema, type NoteDto, type NoteLinkDto } from "../../shared/notes";

type NoteRow = {
  id: string;
  project_id: string;
  title: string;
  body: string;
  version: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type NoteLinkRow = {
  id: string;
  note_id: string;
  target_project_id: string | null;
  source_id: string | null;
  message_id: string | null;
  citation_id: string | null;
  target_available: number;
  created_at: string;
};

export class NoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Note not found: ${id}`);
    this.name = "NoteNotFoundError";
  }
}

export class NoteVersionConflictError extends Error {
  constructor(id: string) {
    super(`Note version changed concurrently: ${id}`);
    this.name = "NoteVersionConflictError";
  }
}

export class NoteLinkConflictError extends Error {
  constructor(id: string) {
    super(`Note link already exists: ${id}`);
    this.name = "NoteLinkConflictError";
  }
}

export class NoteLinkTargetNotFoundError extends Error {
  constructor() {
    super("Note link target not found, unavailable, or project mismatch");
    this.name = "NoteLinkTargetNotFoundError";
  }
}
export class NoteLinkTargetUnavailableError extends Error {
  constructor() { super("Note link target unavailable"); this.name = "NoteLinkTargetUnavailableError"; }
}
export class NoteLinkTargetProjectMismatchError extends Error {
  constructor() { super("Note link target belongs to another project"); this.name = "NoteLinkTargetProjectMismatchError"; }
}

function toNote(row: NoteRow): NoteDto {
  return noteDtoSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    version: row.version,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toLink(row: NoteLinkRow): NoteLinkDto {
  return noteLinkDtoSchema.parse({
    id: row.id,
    noteId: row.note_id,
    targetProjectId: row.target_project_id,
    sourceId: row.source_id,
    messageId: row.message_id,
    citationId: row.citation_id,
    targetAvailable: row.target_available === 1,
    createdAt: row.created_at
  });
}

const LINK_SELECT = `
  SELECT l.*,
    CASE
      WHEN l.target_project_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = l.target_project_id AND p.archived = 0 AND p.status = 'active'
      )
      WHEN l.source_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM sources s JOIN projects p ON p.id = s.project_id
        WHERE s.id = l.source_id AND s.status = 'active'
          AND p.archived = 0 AND p.status = 'active'
      )
      WHEN l.message_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = l.message_id AND c.project_id = n.project_id
          AND c.deleted_at IS NULL AND c.archived_at IS NULL
          AND m.state = 'completed' AND m.superseded = 0 AND trim(m.content) <> ''
      )
      WHEN l.citation_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM message_citations mc
        JOIN messages m ON m.id = mc.message_id
        JOIN conversations c ON c.id = m.conversation_id
        JOIN sources s ON s.id = mc.source_id
        WHERE mc.id = l.citation_id AND c.project_id = n.project_id
          AND c.deleted_at IS NULL AND c.archived_at IS NULL
          AND s.project_id = n.project_id AND s.status = 'active'
      )
      ELSE 0
    END AS target_available
  FROM note_links l JOIN notes n ON n.id = l.note_id
`;

export class NoteRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: { id: string; projectId: string; title: string; body: string }): NoteDto {
    this.db.prepare("INSERT INTO notes(id, project_id, title, body) VALUES (?, ?, ?, ?)")
      .run(input.id, input.projectId, input.title, input.body);
    return this.read(input.projectId, input.id);
  }

  get(projectId: string, id: string): NoteDto | undefined {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ? AND project_id = ?")
      .get(id, projectId) as NoteRow | undefined;
    return row ? toNote(row) : undefined;
  }

  list(projectId: string, options: { includeArchived?: boolean } = {}): NoteDto[] {
    const archived = options.includeArchived ? "" : " AND archived_at IS NULL";
    return (this.db.prepare(`
      SELECT * FROM notes
      WHERE project_id = ? AND deleted_at IS NULL${archived}
      ORDER BY updated_at DESC, id ASC
    `).all(projectId) as NoteRow[]).map(toNote);
  }

  update(input: { projectId: string; id: string; title: string; body: string; version: number }): NoteDto {
    const result = this.db.prepare(`
      UPDATE notes
      SET title = ?, body = ?, version = version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL AND version = ?
    `).run(input.title, input.body, input.id, input.projectId, input.version);
    if (result.changes === 0) {
      if (!this.get(input.projectId, input.id)) throw new NoteNotFoundError(input.id);
      throw new NoteVersionConflictError(input.id);
    }
    return this.read(input.projectId, input.id);
  }

  archive(projectId: string, id: string, version: number): NoteDto {
    this.updateState(projectId, id, version, "archived_at IS NULL", "archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    return this.read(projectId, id);
  }

  restore(projectId: string, id: string, version: number): NoteDto {
    this.updateState(projectId, id, version, "archived_at IS NOT NULL", "archived_at = NULL");
    return this.read(projectId, id);
  }

  remove(projectId: string, id: string, version: number): void {
    this.updateState(projectId, id, version, "archived_at IS NULL", "deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  }

  createLink(input: {
    id: string;
    projectId: string;
    noteId: string;
    targetProjectId?: string | null;
    sourceId?: string | null;
    messageId?: string | null;
    citationId?: string | null;
  }): NoteLinkDto {
    return this.db.transaction(() => {
      const note = this.get(input.projectId, input.noteId);
      if (!note || note.deletedAt) throw new NoteNotFoundError(input.noteId);
      const targets = [input.targetProjectId, input.sourceId, input.messageId, input.citationId].filter((id) => id != null);
      if (targets.length !== 1) throw new NoteLinkTargetNotFoundError();
      this.assertTarget(input.projectId, input.targetProjectId, input.sourceId, input.messageId, input.citationId);
      try {
        this.db.prepare(`
          INSERT INTO note_links(id, note_id, target_project_id, source_id, message_id, citation_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(input.id, input.noteId, input.targetProjectId ?? null, input.sourceId ?? null, input.messageId ?? null, input.citationId ?? null);
      } catch (error) {
        if (String(error).match(/unique/i)) throw new NoteLinkConflictError(input.id);
        if (String(error).match(/constraint/i)) throw new NoteLinkTargetProjectMismatchError();
        throw error;
      }
      return this.link(input.projectId, input.noteId, input.id)!;
    })();
  }

  listLinks(projectId: string, noteId: string): NoteLinkDto[] {
    const note = this.get(projectId, noteId);
    if (!note) throw new NoteNotFoundError(noteId);
    if (note.deletedAt) return [];
    return (this.db.prepare(`${LINK_SELECT} WHERE n.id = ? AND n.project_id = ? AND n.deleted_at IS NULL ORDER BY l.created_at ASC, l.id ASC`)
      .all(noteId, projectId) as NoteLinkRow[]).map(toLink);
  }

  removeLink(projectId: string, noteId: string, linkId: string): void {
    this.db.transaction(() => {
      if (!this.get(projectId, noteId)) throw new NoteNotFoundError(noteId);
      const result = this.db.prepare("DELETE FROM note_links WHERE id = ? AND note_id = ?")
        .run(linkId, noteId);
      if (result.changes === 0) throw new NoteNotFoundError(linkId);
    })();
  }

  private read(projectId: string, id: string): NoteDto {
    const note = this.get(projectId, id);
    if (!note) throw new NoteNotFoundError(id);
    return note;
  }

  private updateState(projectId: string, id: string, version: number, stateCondition: string, assignment: string): void {
    const result = this.db.prepare(`
      UPDATE notes SET ${assignment}, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL AND version = ? AND ${stateCondition}
    `).run(id, projectId, version);
    if (result.changes === 0) {
      if (!this.get(projectId, id)) throw new NoteNotFoundError(id);
      throw new NoteVersionConflictError(id);
    }
  }

  private link(projectId: string, noteId: string, linkId: string): NoteLinkDto | undefined {
    const row = this.db.prepare(`${LINK_SELECT} WHERE l.id = ? AND n.id = ? AND n.project_id = ?`)
      .get(linkId, noteId, projectId) as NoteLinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  private assertTarget(projectId: string, targetProjectId?: string | null, sourceId?: string | null, messageId?: string | null, citationId?: string | null): void {
    if (targetProjectId != null) {
      const row = this.db.prepare("SELECT archived, status FROM projects WHERE id = ?").get(targetProjectId) as { archived: number; status: string } | undefined;
      if (!row) throw new NoteLinkTargetNotFoundError();
      if (row.archived || row.status !== "active") throw new NoteLinkTargetUnavailableError();
      return;
    }
    if (sourceId != null) {
      const row = this.db.prepare("SELECT s.status, p.archived, p.status AS project_status FROM sources s JOIN projects p ON p.id = s.project_id WHERE s.id = ?").get(sourceId) as { status: string; archived: number; project_status: string } | undefined;
      if (!row) throw new NoteLinkTargetNotFoundError();
      if (row.status !== "active" || row.archived || row.project_status !== "active") throw new NoteLinkTargetUnavailableError();
      return;
    }
    if (messageId != null) {
      const row = this.db.prepare("SELECT c.project_id, c.deleted_at, c.archived_at, m.state, m.superseded, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?").get(messageId) as { project_id: string; deleted_at: string | null; archived_at: string | null; state: string; superseded: number; content: string } | undefined;
      if (!row) throw new NoteLinkTargetNotFoundError();
      if (row.project_id !== projectId) throw new NoteLinkTargetProjectMismatchError();
      if (row.deleted_at || row.archived_at || row.state !== "completed" || row.superseded || !row.content.trim()) throw new NoteLinkTargetUnavailableError();
      return;
    }
    if (citationId != null) {
      const row = this.db.prepare("SELECT c.project_id, c.deleted_at, c.archived_at, s.project_id AS source_project_id, s.status FROM message_citations mc JOIN messages m ON m.id = mc.message_id JOIN conversations c ON c.id = m.conversation_id JOIN sources s ON s.id = mc.source_id WHERE mc.id = ?").get(citationId) as { project_id: string; deleted_at: string | null; archived_at: string | null; source_project_id: string; status: string } | undefined;
      if (!row) throw new NoteLinkTargetNotFoundError();
      if (row.project_id !== projectId || row.source_project_id !== projectId) throw new NoteLinkTargetProjectMismatchError();
      if (row.deleted_at || row.archived_at || row.status !== "active") throw new NoteLinkTargetUnavailableError();
    }
  }
}
