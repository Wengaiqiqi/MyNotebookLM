import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { NoteLinkConflictError, NoteLinkTargetNotFoundError, NoteLinkTargetProjectMismatchError, NoteLinkTargetUnavailableError, NoteNotFoundError, NoteVersionConflictError, NoteRepository } from "./note-repository";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTE = "11111111-1111-4111-8111-111111111111";
const NOTE_B = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const SOURCE_B = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const CONVERSATION_B = "66666666-6666-4666-8666-666666666666";
const MESSAGE = "77777777-7777-4777-8777-777777777777";
const MESSAGE_B = "88888888-8888-4888-8888-888888888888";
const CANCELLED_MESSAGE = "88888888-8888-4888-8888-888888888889";
const CITATION = "99999999-9999-4999-8999-999999999999";

describe("NoteRepository", () => {
  let root: string;
  let db: AppDatabase;
  let repo: NoteRepository;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-notes-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    repo = new NoteRepository(db.connection);
    db.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?), (?, ?)").run(A, "A", B, "B");
    db.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, 'text', 'A source'), (?, ?, 'text', 'B source')").run(SOURCE, A, SOURCE_B, B);
    db.connection.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, 'A chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), (?, ?, 'B chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(CONVERSATION, A, CONVERSATION_B, B);
    db.connection.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, 0, 'user', 'A message', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), (?, ?, 0, 'user', 'B message', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(MESSAGE, CONVERSATION, MESSAGE_B, CONVERSATION_B);
    db.connection.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, 1, 'assistant', 'partial answer', 'cancelled', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(CANCELLED_MESSAGE, CONVERSATION);
    db.connection.prepare("INSERT INTO message_citations(id, message_id, label, source_id, source_display_name, source_kind, locator_json, created_at) VALUES (?, ?, 'S1', ?, 'A source', 'text', '{}', '2026-01-01T00:00:00.000Z')").run(CITATION, MESSAGE, SOURCE);
  });

  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("creates, reads, updates with a version, archives, restores, lists and soft-deletes", () => {
    const created = repo.create({ id: NOTE, projectId: A, title: "First", body: "# Note" });
    expect(created).toMatchObject({ id: NOTE, projectId: A, title: "First", body: "# Note", version: 1, archivedAt: null, deletedAt: null });
    expect(repo.get(A, NOTE)).toEqual(created);
    const edited = repo.update({ projectId: A, id: NOTE, title: "Edited", body: "body", version: 1 });
    expect(edited).toMatchObject({ title: "Edited", body: "body", version: 2 });
    const archived = repo.archive(A, NOTE, 2);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(3);
    expect(repo.list(A)).toEqual([]);
    expect(repo.list(A, { includeArchived: true })).toHaveLength(1);
    expect(repo.restore(A, NOTE, 3).archivedAt).toBeNull();
    repo.remove(A, NOTE, 4);
    expect(repo.get(A, NOTE)?.deletedAt).not.toBeNull();
    expect(repo.list(A, { includeArchived: true })).toEqual([]);
  });

  it("rejects stale state changes and increments version for each successful change", () => {
    repo.create({ id: NOTE, projectId: A, title: "A", body: "A" });
    expect(() => repo.archive(A, NOTE, 2)).toThrow(NoteVersionConflictError);
    expect(repo.archive(A, NOTE, 1).version).toBe(2);
    expect(() => repo.archive(A, NOTE, 2)).toThrow(NoteVersionConflictError);
    expect(() => repo.restore(A, NOTE, 1)).toThrow(NoteVersionConflictError);
    expect(repo.restore(A, NOTE, 2).version).toBe(3);
    expect(() => repo.restore(A, NOTE, 3)).toThrow(NoteVersionConflictError);
    expect(() => repo.remove(A, NOTE, 2)).toThrow(NoteVersionConflictError);
    repo.remove(A, NOTE, 3);
  });

  it("rejects stale edits and keeps project ownership isolated", () => {
    repo.create({ id: NOTE, projectId: A, title: "A", body: "A" });
    repo.create({ id: NOTE_B, projectId: B, title: "B", body: "B" });
    expect(() => repo.update({ projectId: A, id: NOTE, title: "new", body: "new", version: 2 })).toThrow(NoteVersionConflictError);
    expect(() => repo.get(B, NOTE)).not.toThrow();
    expect(repo.get(B, NOTE)).toBeUndefined();
    expect(() => repo.archive(B, NOTE, 1)).toThrow(NoteNotFoundError);
    expect(() => repo.remove(B, NOTE, 1)).toThrow(NoteNotFoundError);
  });

  it("creates links in a constrained transaction and exposes all target kinds", () => {
    repo.create({ id: NOTE, projectId: A, title: "A", body: "A" });
    const projectLink = repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000009", projectId: A, noteId: NOTE, targetProjectId: B });
    const sourceLink = repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000001", projectId: A, noteId: NOTE, sourceId: SOURCE });
    const crossProjectSourceLink = repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000004", projectId: A, noteId: NOTE, sourceId: SOURCE_B });
    const messageLink = repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000002", projectId: A, noteId: NOTE, messageId: MESSAGE });
    const citationLink = repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000003", projectId: A, noteId: NOTE, citationId: CITATION });
    expect(repo.listLinks(A, NOTE)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: projectLink.id, targetProjectId: B, targetAvailable: true }),
      expect.objectContaining({ id: sourceLink.id, sourceId: SOURCE, targetAvailable: true }),
      expect.objectContaining({ id: crossProjectSourceLink.id, sourceId: SOURCE_B, targetAvailable: true }),
      expect.objectContaining({ id: messageLink.id, messageId: MESSAGE, targetAvailable: true }),
      expect.objectContaining({ id: citationLink.id, citationId: CITATION, targetAvailable: true })
    ]));
    expect(() => repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000010", projectId: A, noteId: NOTE, messageId: MESSAGE_B })).toThrow(NoteLinkTargetProjectMismatchError);
    expect(() => repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000011", projectId: A, noteId: NOTE, messageId: CANCELLED_MESSAGE })).toThrow(NoteLinkTargetUnavailableError);
    expect(() => repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000007", projectId: A, noteId: NOTE, sourceId: "aaaaaaaa-0000-4000-8000-000000000007" })).toThrow(NoteLinkTargetNotFoundError);
    expect(() => repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000005", projectId: B, noteId: NOTE, sourceId: SOURCE })).toThrow(NoteNotFoundError);
    expect(() => repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000006", projectId: A, noteId: NOTE, sourceId: SOURCE })).toThrow(NoteLinkConflictError);
    db.connection.prepare("UPDATE sources SET status = 'deleted', deleted_at = '2027-01-01T00:00:00.000Z' WHERE id = ?").run(SOURCE);
    expect(() => repo.createLink({ id: "aaaaaaaa-0000-4000-8000-000000000008", projectId: A, noteId: NOTE, sourceId: SOURCE })).toThrow(NoteLinkTargetUnavailableError);
  });

  it("reports links unavailable after their source or conversation is archived/deleted", () => {
    repo.create({ id: NOTE, projectId: A, title: "A", body: "A" });
    repo.createLink({ id: "bbbbbbbb-0000-4000-8000-000000000004", projectId: A, noteId: NOTE, targetProjectId: B });
    repo.createLink({ id: "bbbbbbbb-0000-4000-8000-000000000001", projectId: A, noteId: NOTE, sourceId: SOURCE });
    repo.createLink({ id: "bbbbbbbb-0000-4000-8000-000000000002", projectId: A, noteId: NOTE, messageId: MESSAGE });
    repo.createLink({ id: "bbbbbbbb-0000-4000-8000-000000000003", projectId: A, noteId: NOTE, citationId: CITATION });
    db.connection.prepare("UPDATE sources SET status = 'deleted', deleted_at = '2027-01-02T00:00:00.000Z' WHERE id = ?").run(SOURCE);
    db.connection.prepare("UPDATE conversations SET archived_at = '2027-01-02T00:00:00.000Z' WHERE id = ?").run(CONVERSATION);
    db.connection.prepare("UPDATE projects SET archived = 1 WHERE id = ?").run(B);
    expect(repo.listLinks(A, NOTE)).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetProjectId: B, targetAvailable: false }),
      expect.objectContaining({ sourceId: SOURCE, targetAvailable: false }),
      expect.objectContaining({ messageId: MESSAGE, targetAvailable: false }),
      expect.objectContaining({ citationId: CITATION, targetAvailable: false })
    ]));
    expect(repo.get(A, NOTE)).toBeDefined();
    repo.remove(A, NOTE, repo.get(A, NOTE)!.version);
    expect(repo.listLinks(A, NOTE)).toEqual([]);
  });
});
