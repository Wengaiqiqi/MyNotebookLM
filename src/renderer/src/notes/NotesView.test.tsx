// @vitest-environment jsdom
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../shared/ipc";
import NotesView from "./NotesView";
import { changeLanguage } from "../i18n";
type NotesApi = NonNullable<DesktopApi["notes"]>;

const projectId = "00000000-0000-4000-8000-000000000001";
const note = { id: "00000000-0000-4000-8000-000000000002", projectId, title: "Research", body: "# Hello", version: 1, archivedAt: null, deletedAt: null, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
const archivedNote = { ...note, archivedAt: "2026-08-29T01:00:00.000Z", version: 2 };
const serverNote = { ...note, title: "Server title", body: "# Server version", version: 2 };
const makeLink = (id: string, target: "sourceId" | "messageId" | "citationId") => ({ id, noteId: note.id, sourceId: target === "sourceId" ? "00000000-0000-4000-8000-000000000010" : null, messageId: target === "messageId" ? "00000000-0000-4000-8000-000000000011" : null, citationId: target === "citationId" ? "00000000-0000-4000-8000-000000000012" : null, targetAvailable: target !== "citationId", createdAt: "2026-08-29T00:00:00.000Z" });

beforeEach(async () => {
  await changeLanguage("en");
  window.myNotebook = { notes: {
    list: vi.fn<NotesApi["list"]>().mockResolvedValue({ ok: true, value: [note] }),
    get: vi.fn<NotesApi["get"]>().mockResolvedValue({ ok: true, value: note }),
    update: vi.fn<NotesApi["update"]>().mockResolvedValue({ ok: true, value: { ...note, version: 2 } }),
    create: vi.fn(), archive: vi.fn(), restore: vi.fn(), delete: vi.fn(), createLink: vi.fn(), listLinks: vi.fn().mockResolvedValue({ ok: true, value: [] }), deleteLink: vi.fn(), generateTitle: vi.fn()
  } } as unknown as DesktopApi;
});
afterEach(() => cleanup());

describe("NotesView", () => {
  it("lists a note, previews markdown, and saves edits with its version", async () => {
    render(<NotesView projectId={projectId} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /Research/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Research/ }));
    const editor = await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.change(editor, { target: { value: "## Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(window.myNotebook.notes?.update).toHaveBeenCalledWith({ projectId, id: note.id, title: "Research", body: "## Updated", version: 1 }));
    expect(screen.getByRole("heading", { name: "Updated" })).toBeTruthy();
  });

  it("keeps a local draft visible when the optimistic save conflicts", async () => {
    window.myNotebook.notes!.update = vi.fn().mockResolvedValue({ ok: false, error: { code: "CONFLICT", messageKey: "errors.conflict", recoverable: true } });
    render(<NotesView projectId={projectId} />);
    await screen.findByRole("option", { name: /Research/ });
    fireEvent.click(screen.getByRole("option", { name: /Research/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Note body" }), { target: { value: "local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed|draft/i);
    expect(screen.getByDisplayValue("local draft")).toBeTruthy();
  });

  it("creates, archives, restores, and deletes notes through versioned APIs", async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, value: { ...note, id: "00000000-0000-4000-8000-000000000003", title: "Untitled note" } });
    let archived = false;
    const list = window.myNotebook.notes!.list as ReturnType<typeof vi.fn>;
    list.mockImplementation(async ({ includeArchived }: { includeArchived?: boolean }) => ({ ok: true, value: includeArchived ? (archived ? [{ ...note, id: "00000000-0000-4000-8000-000000000004", title: "Active copy" }, { ...archivedNote, title: "Archived copy" }] : [note]) : (archived ? [] : [note]) }));
    const archive = vi.fn().mockImplementation(async () => { archived = true; return { ok: true, value: archivedNote }; });
    const restore = vi.fn().mockImplementation(async () => { archived = false; return { ok: true, value: note }; });
    const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    window.myNotebook.notes!.create = create; window.myNotebook.notes!.archive = archive; window.myNotebook.notes!.restore = restore; window.myNotebook.notes!.delete = remove;
    render(<NotesView projectId={projectId} />);
    await screen.findByRole("option", { name: /Research/ });
    fireEvent.click(screen.getByRole("button", { name: /New note/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ projectId, title: "Untitled note", body: "" }));
    fireEvent.click(screen.getByRole("option", { name: /Research/ }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith({ projectId, id: note.id, version: 1 }));
    expect(screen.queryByRole("option", { name: /Research/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived notes" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ projectId, includeArchived: true }));
    expect(screen.getByRole("option", { name: /Archived copy/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Active copy/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Archived copy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ projectId, id: note.id, version: 2 }));
    expect(screen.queryByRole("option", { name: /Archived copy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Active notes" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ projectId, includeArchived: false }));
    fireEvent.click(screen.getByRole("option", { name: /Research/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ projectId, id: note.id, version: 1 }));
  });

  it("reloads the server version after a conflict without replacing the local draft", async () => {
    const update = vi.fn().mockResolvedValue({ ok: false, error: { code: "CONFLICT", messageKey: "errors.conflict", recoverable: true } });
    const get = vi.fn().mockResolvedValue({ ok: true, value: serverNote });
    window.myNotebook.notes!.update = update; window.myNotebook.notes!.get = get;
    render(<NotesView projectId={projectId} />);
    await screen.findByRole("option", { name: /Research/ });
    fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await screen.findByRole("button", { name: "Reload server version" });
    expect(screen.getByDisplayValue("local draft")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload server version" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith({ projectId, id: note.id }));
    await waitFor(() => expect(screen.getByDisplayValue("# Server version")).toBeTruthy());
    expect(screen.getByDisplayValue("Server title")).toBeTruthy();
  });

  it("creates and removes source, message, and citation links and shows unavailable targets", async () => {
    const links = [makeLink("00000000-0000-4000-8000-000000000020", "sourceId"), makeLink("00000000-0000-4000-8000-000000000021", "messageId"), makeLink("00000000-0000-4000-8000-000000000022", "citationId")];
    const createLink = vi.fn().mockImplementation(async (input) => ({ ok: true, value: links.find((item) => item.sourceId === input.sourceId || item.messageId === input.messageId || item.citationId === input.citationId) ?? links[0] }));
    const deleteLink = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    window.myNotebook.notes!.createLink = createLink; window.myNotebook.notes!.deleteLink = deleteLink;
    render(<NotesView projectId={projectId} />);
    await screen.findByRole("option", { name: /Research/ });
    const kind = screen.getByRole("combobox", { name: "Link type" }); const target = screen.getByRole("textbox", { name: "Target id" });
    for (const [value, id] of [["source", "00000000-0000-4000-8000-000000000010"], ["message", "00000000-0000-4000-8000-000000000011"], ["citation", "00000000-0000-4000-8000-000000000012"]] as const) { fireEvent.change(kind, { target: { value } }); fireEvent.change(target, { target: { value: id } }); fireEvent.click(screen.getByRole("button", { name: "Link" })); }
    await waitFor(() => expect(createLink).toHaveBeenCalledTimes(3));
    expect(createLink).toHaveBeenNthCalledWith(1, { projectId, noteId: note.id, sourceId: "00000000-0000-4000-8000-000000000010" });
    expect(createLink).toHaveBeenNthCalledWith(2, { projectId, noteId: note.id, messageId: "00000000-0000-4000-8000-000000000011" });
    expect(createLink).toHaveBeenNthCalledWith(3, { projectId, noteId: note.id, citationId: "00000000-0000-4000-8000-000000000012" });
    expect(screen.getByText(/target unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Remove link 00000000-0000-4000-8000-000000000010/ }));
    await waitFor(() => expect(deleteLink).toHaveBeenCalledWith({ projectId, noteId: note.id, linkId: links[0]!.id }));
  });

  it("keeps title and body when AI title generation fails and sanitizes preview HTML", async () => {
    window.myNotebook.notes!.generateTitle = vi.fn().mockResolvedValue({ ok: false, error: { code: "PROVIDER", messageKey: "errors.provider", recoverable: true } });
    render(<NotesView projectId={projectId} />);
    await screen.findByRole("option", { name: /Research/ });
    const dangerousBody = "[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>\n\n# Safe heading";
    const bodyEditor = screen.getByRole("textbox", { name: "Note body" });
    fireEvent.change(bodyEditor, { target: { value: dangerousBody } });
    fireEvent.click(screen.getByRole("button", { name: "Generate AI title" }));
    await screen.findByRole("alert");
    expect(screen.getByDisplayValue("Research")).toBeTruthy();
    expect((bodyEditor as HTMLTextAreaElement).value).toBe(dangerousBody);
    expect(document.querySelector(".note-preview script")).toBeNull();
    expect(document.querySelector('.note-preview a[href^="javascript:"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "Safe heading" })).toBeTruthy();
  });
});
