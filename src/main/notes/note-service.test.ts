import { describe, expect, it } from "vitest";
import { createNoteLinkInputSchema, listNotesInputSchema, noteLinkDtoSchema } from "../../shared/notes";
import { NoteService } from "./note-service";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE = "11111111-1111-4111-8111-111111111111";
const SOURCE = "33333333-3333-4333-8333-333333333333";

describe("NoteService", () => {
  it("normalizes CRLF without changing Markdown content and validates link DTOs strictly", () => {
    const calls: unknown[] = [];
    const repository = {
      create: (value: unknown) => { calls.push(value); return { id: NOTE, projectId: PROJECT, title: "Title", body: "# A\n\nB", version: 1, archivedAt: null, deletedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }; }
    } as any;
    const service = new NoteService(repository, () => NOTE);
    service.createNote({ projectId: PROJECT, title: " Title ", body: "# A\r\n\r\nB" });
    expect(calls[0]).toEqual({ id: NOTE, projectId: PROJECT, title: "Title", body: "# A\n\nB" });
    expect(noteLinkDtoSchema.safeParse({ id: NOTE, noteId: NOTE, sourceId: SOURCE, messageId: null, citationId: null, targetAvailable: true, createdAt: "2026-01-01T00:00:00.000Z" }).success).toBe(true);
    expect(() => noteLinkDtoSchema.parse({ id: NOTE, noteId: NOTE, sourceId: SOURCE, messageId: null, citationId: null, targetAvailable: true, createdAt: "2026-01-01T00:00:00.000Z", unexpected: true })).toThrow();
    expect(() => createNoteLinkInputSchema.parse({ projectId: PROJECT, noteId: NOTE, sourceId: SOURCE, messageId: SOURCE })).toThrow();
  });

  it("strictly validates the complete listNotes input", () => {
    expect(listNotesInputSchema.parse({ projectId: PROJECT, includeArchived: true })).toEqual({ projectId: PROJECT, includeArchived: true });
    expect(() => listNotesInputSchema.parse({ projectId: PROJECT, unexpected: true })).toThrow();
  });
});
