import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopApi } from "../../../shared/ipc";
import type { NoteDto, NoteLinkDto } from "../../../shared/notes";
import NoteEditor from "./NoteEditor";

const emptyId = "00000000-0000-4000-8000-000000000000";
type NotesApi = NonNullable<DesktopApi["notes"]>;

export default function NotesView({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useTranslation();
  const api = typeof window !== "undefined" ? window.myNotebook.notes : undefined;
  const [notes, setNotes] = useState<NoteDto[]>([]); const [selectedId, setSelectedId] = useState<string>(); const [links, setLinks] = useState<NoteLinkDto[]>([]); const [showArchived, setShowArchived] = useState(false); const [error, setError] = useState("");
  const selected = useMemo(() => notes.find((item) => item.id === selectedId), [notes, selectedId]);
  async function load(includeArchived = showArchived): Promise<void> { if (!api) return; const result = await api.list({ projectId, includeArchived }).catch(() => undefined); if (result?.ok) { const visible = result.value.filter((item) => includeArchived ? Boolean(item.archivedAt) : !item.archivedAt); setNotes(visible); setSelectedId((current) => current && visible.some((item) => item.id === current) ? current : visible[0]?.id); setError(""); } else setError(t(result?.error.messageKey ?? "errors.internal", "Unable to load notes.")); }
  async function loadLinks(noteId: string): Promise<void> { if (!api) return; const result = await api.listLinks({ projectId, id: noteId }).catch(() => undefined); if (result?.ok) setLinks(result.value); }
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => { if (selectedId) void loadLinks(selectedId); else setLinks([]); }, [selectedId]);
  async function createNote(): Promise<void> { if (!api) return; const result = await api.create({ projectId, title: t("notes.untitled", "Untitled note"), body: "" }).catch(() => undefined); if (result?.ok) { setNotes((items) => [result.value, ...items]); setSelectedId(result.value.id); } else setError(t(result?.error.messageKey ?? "errors.internal", "Unable to create note.")); }
  async function changed(next: NoteDto): Promise<void> {
    const visible = showArchived ? Boolean(next.archivedAt) : !next.archivedAt;
    await load(showArchived);
    setNotes((items) => visible ? items.map((item) => item.id === next.id ? next : item) : items.filter((item) => item.id !== next.id));
    setSelectedId((current) => visible ? next.id : current === next.id ? undefined : current);
    if (visible) await loadLinks(next.id); else setLinks([]);
  }
  async function deleted(): Promise<void> { const oldId = selectedId; setNotes((items) => items.filter((item) => item.id !== oldId)); setSelectedId(undefined); setLinks([]); await load(); }
  async function createLink(): Promise<void> { if (!api || !selected) return; const input = document.getElementById("note-link-target") as HTMLInputElement | null; const target = input?.value.trim(); const kind = (document.getElementById("note-link-kind") as HTMLSelectElement | null)?.value; if (!target || !kind) return; const result = await api.createLink({ projectId, noteId: selected.id, ...(kind === "source" ? { sourceId: target } : kind === "message" ? { messageId: target } : { citationId: target }) }).catch(() => undefined); if (result?.ok) { setLinks((items) => [...items, result.value]); if (input) input.value = ""; } else setError(t(result?.error.messageKey ?? "errors.internal", "Unable to create link.")); }
  async function deleteLink(link: NoteLinkDto): Promise<void> { if (!api || !selected) return; const result = await api.deleteLink({ projectId, noteId: selected.id, linkId: link.id }).catch(() => undefined); if (result?.ok) setLinks((items) => items.filter((item) => item.id !== link.id)); }
  if (!api) return <main className="notes-page"><p className="model-page-error">{t("notes.unavailable", "Notes are unavailable until the desktop service is ready.")}</p></main>;
  return <main className="notes-page">
    <header className="notes-page-header"><div><span className="eyebrow">{t("notes.eyebrow", "Workspace notes")}</span><h2>{t("notes.titlePage", "Notes")}</h2><p>{t("notes.subtitle", "Capture and refine cited research in Markdown.")}</p></div><div className="notes-page-actions"><button type="button" onClick={() => void createNote()}>＋ {t("notes.new", "New note")}</button><button type="button" aria-pressed={showArchived} onClick={() => { const next = !showArchived; setShowArchived(next); void load(next); }}>{showArchived ? t("notes.active", "Active notes") : t("notes.archived", "Archived notes")}</button></div></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="notes-layout"><aside className="notes-list" aria-label={t("notes.titlePage", "Notes")}><div className="notes-list-heading"><strong>{notes.length}</strong><span>{t("notes.count", "notes")}</span></div>{notes.length ? <div role="listbox" aria-label={t("notes.titlePage", "Notes")}>{notes.map((note) => <button role="option" aria-selected={note.id === selectedId} className={note.id === selectedId ? "selected" : ""} type="button" key={note.id} onClick={() => setSelectedId(note.id)}><strong>{note.title}</strong><small>{new Date(note.updatedAt).toLocaleDateString()}</small></button>)}</div> : <p className="notes-empty">{t("notes.empty", "No notes yet.")}</p>}</aside>{selected ? <div className="notes-main"><NoteEditor note={selected} api={api as NotesApi} onChanged={(next) => void changed(next)} onDeleted={() => void deleted()} /><section className="note-links" aria-labelledby="note-links-title"><div className="notes-section-heading"><h3 id="note-links-title">{t("notes.links", "Linked evidence")}</h3><span>{links.length}</span></div><div className="note-link-create"><select id="note-link-kind" aria-label={t("notes.linkType", "Link type")} defaultValue="source"><option value="source">{t("notes.source", "Source")}</option><option value="message">{t("notes.message", "Message")}</option><option value="citation">{t("notes.citation", "Citation")}</option></select><input id="note-link-target" aria-label={t("notes.target", "Target id")} placeholder={t("notes.targetPlaceholder", "Paste target id")} /><button type="button" onClick={() => void createLink()}>{t("notes.link", "Link")}</button></div>{links.length ? <ul>{links.map((link) => { const kind = link.sourceId ? "source" : link.messageId ? "message" : "citation"; const value = link.sourceId ?? link.messageId ?? link.citationId ?? emptyId; return <li key={link.id}><span>{kind}: {value} {link.targetAvailable ? "" : `— ${t("notes.targetUnavailable", "target unavailable")}`}</span><button type="button" aria-label={`${t("notes.unlink", "Remove link")} ${value}`} onClick={() => void deleteLink(link)}>×</button></li>; })}</ul> : <p>{t("notes.noLinks", "No linked evidence yet.")}</p>}</section></div> : <div className="notes-empty-main"><p>{t("notes.select", "Select a note to edit it.")}</p></div>}</div>
  </main>;
}
