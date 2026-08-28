import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import { NOTE_CHANNELS } from "../../shared/ipc";
import { registerNoteHandlers } from "./register-note-handlers";

type Handler = Parameters<IpcMain["handle"]>[1];
class FakeIpc implements Pick<IpcMain, "handle" | "removeHandler"> {
  handlers = new Map<string, Handler>();
  removed: string[] = [];
  handle(channel: string, handler: Handler) { this.handlers.set(channel, handler); }
  removeHandler(channel: string) { this.removed.push(channel); this.handlers.delete(channel); }
}
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-28T00:00:00.000Z";
const note = { id: NOTE, projectId: PROJECT, title: "N", body: "B", version: 1, archivedAt: null, deletedAt: null, createdAt: VERSION, updatedAt: VERSION };
const ok = <T>(value: T) => ({ ok: true as const, value });
const failure = { ok: false as const, error: { code: "VALIDATION" as const, messageKey: "errors.validation", recoverable: false } };
const invoke = (ipc: FakeIpc, channel: string, input?: unknown) => ipc.handlers.get(channel)!({} as never, input);

function service() {
  return {
    createNote: vi.fn(() => note), getNote: vi.fn(() => note), listNotes: vi.fn(() => [note]), updateNote: vi.fn(() => note),
    archiveNote: vi.fn(() => note), restoreNote: vi.fn(() => note), deleteNote: vi.fn(() => undefined),
    createLink: vi.fn(() => ({ id: NOTE, noteId: NOTE, sourceId: NOTE, messageId: null, citationId: null, targetAvailable: true, createdAt: VERSION })),
    listLinks: vi.fn(() => []), deleteLink: vi.fn(() => undefined), generateTitle: vi.fn(async () => note)
  };
}

describe("registerNoteHandlers", () => {
  it("registers and dispatches every note command with strict validation", async () => {
    const ipc = new FakeIpc(); const svc = service(); registerNoteHandlers(ipc, svc as never);
    await invoke(ipc, NOTE_CHANNELS.create, { projectId: PROJECT, title: "N", body: "B" });
    await invoke(ipc, NOTE_CHANNELS.get, { projectId: PROJECT, id: NOTE });
    await invoke(ipc, NOTE_CHANNELS.list, { projectId: PROJECT });
    await invoke(ipc, NOTE_CHANNELS.update, { projectId: PROJECT, id: NOTE, title: "N", body: "B", version: 1 });
    await invoke(ipc, NOTE_CHANNELS.archive, { projectId: PROJECT, id: NOTE, version: 1 });
    await invoke(ipc, NOTE_CHANNELS.restore, { projectId: PROJECT, id: NOTE, version: 1 });
    await invoke(ipc, NOTE_CHANNELS.delete, { projectId: PROJECT, id: NOTE, version: 1 });
    await invoke(ipc, NOTE_CHANNELS.listLinks, { projectId: PROJECT, noteId: NOTE });
    await invoke(ipc, NOTE_CHANNELS.generateTitle, { projectId: PROJECT, noteId: NOTE, locale: "en" });
    expect(svc.createNote).toHaveBeenCalledWith({ projectId: PROJECT, title: "N", body: "B" });
    expect(svc.generateTitle).toHaveBeenCalledWith({ projectId: PROJECT, noteId: NOTE, locale: "en" });
  });

  it("maps invalid input and service errors to safe results, and cleanup removes only its handlers", async () => {
    const ipc = new FakeIpc(); const svc = service(); svc.getNote.mockImplementation(() => { throw new Error("secret"); }); registerNoteHandlers(ipc, svc as never);
    await expect(invoke(ipc, NOTE_CHANNELS.create, { projectId: PROJECT, title: "N", body: "B", rawSql: "DROP" })).resolves.toEqual(failure);
    await expect(invoke(ipc, NOTE_CHANNELS.get, { projectId: PROJECT, id: NOTE })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    const cleanup = registerNoteHandlers(new FakeIpc(), svc as never); cleanup();
    expect(JSON.stringify(await invoke(ipc, NOTE_CHANNELS.get, { projectId: PROJECT, id: NOTE }))).not.toContain("secret");
  });
});
