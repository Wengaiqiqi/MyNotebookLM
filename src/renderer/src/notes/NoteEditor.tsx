import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "../../../shared/notes";
import type { DesktopApi } from "../../../shared/ipc";
import SafeMarkdown from "../chat/SafeMarkdown";

export default function NoteEditor({ note, api, onChanged, onDeleted }: Readonly<{ note: NoteDto; api: NonNullable<DesktopApi["notes"]>; onChanged(note: NoteDto): void; onDeleted(): void }>) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setTitle(note.title); setBody(note.body); setError(""); setConflict(false); }, [note.id, note.version, note.title, note.body]);

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true); setError(""); setConflict(false);
    const result = await api.update({ projectId: note.projectId, id: note.id, title, body, version: note.version }).catch(() => undefined);
    if (result?.ok) onChanged(result.value);
    else if (result?.error.code === "CONFLICT") { setConflict(true); setError(t("notes.conflict", "This note changed elsewhere. Reload the server version or keep this draft.")); }
    else setError(result?.error.messageKey ? t(result.error.messageKey, result.error.messageKey) : t("errors.internal", "Unable to save the note."));
    setSaving(false);
  }
  async function reload(): Promise<void> {
    const result = await api.get({ projectId: note.projectId, id: note.id }).catch(() => undefined);
    if (result?.ok && result.value) onChanged(result.value);
    else setError(t("errors.notFound", "The note could not be reloaded."));
  }
  async function setState(action: "archive" | "restore"): Promise<void> {
    const result = await api[action]({ projectId: note.projectId, id: note.id, version: note.version }).catch(() => undefined);
    if (result?.ok) onChanged(result.value); else setError(t(result?.error.messageKey ?? "errors.internal", "Unable to update the note."));
  }
  async function remove(): Promise<void> {
    const result = await api.delete({ projectId: note.projectId, id: note.id, version: note.version }).catch(() => undefined);
    if (result?.ok) onDeleted(); else setError(t(result?.error.messageKey ?? "errors.internal", "Unable to delete the note."));
  }
  async function generateTitle(): Promise<void> {
    setError("");
    const result = await api.generateTitle({ projectId: note.projectId, noteId: note.id, locale: (document.documentElement.lang === "zh-CN" ? "zh-CN" : "en") }).catch(() => undefined);
    if (result?.ok) onChanged(result.value); else setError(t("notes.titleFailure", "AI title generation failed; your title and body were kept."));
  }
  return <section className="notes-editor" aria-labelledby="note-editor-title">
    <div className="notes-editor-heading"><div><span className="eyebrow">{t("notes.editorEyebrow", "Note editor")}</span><h3 id="note-editor-title">{t("notes.edit", "Edit note")}</h3></div><span className="note-version">v{note.version}</span></div>
    <label>{t("notes.title", "Title")}<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label={t("notes.title", "Title")} /></label>
    <div className="note-editor-columns"><label>{t("notes.body", "Markdown body")}<textarea aria-label="Note body" value={body} onChange={(e) => setBody(e.target.value)} /></label><div className="note-preview"><span>{t("notes.preview", "Safe preview")}</span><SafeMarkdown text={body} /></div></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {conflict && <div className="note-conflict"><button type="button" onClick={() => void reload()}>{t("notes.reloadServer", "Reload server version")}</button><button type="button" onClick={() => setConflict(false)}>{t("notes.keepDraft", "Keep local draft")}</button></div>}
    <div className="notes-editor-actions"><button className="primary-button" type="button" disabled={saving || !title.trim()} onClick={() => void save()}>{saving ? t("common.saving", "Saving…") : t("notes.save", "Save note")}</button><button type="button" onClick={() => void generateTitle()}>{t("notes.aiTitle", "Generate AI title")}</button>{note.archivedAt ? <button type="button" onClick={() => void setState("restore")}>{t("notes.restore", "Restore")}</button> : <button type="button" onClick={() => void setState("archive")}>{t("notes.archive", "Archive")}</button>}<button type="button" className="danger-button" onClick={() => setConfirmDelete(true)}>{t("notes.delete", "Delete")}</button></div>
    {confirmDelete && <div className="inline-confirm" role="dialog" aria-label={t("notes.delete", "Delete note")}><span>{t("notes.deleteConfirm", "Delete this note permanently?")}</span><button type="button" onClick={() => setConfirmDelete(false)}>{t("common.cancel", "Cancel")}</button><button className="danger-button" type="button" onClick={() => void remove()}>{t("common.confirm", "Confirm")}</button></div>}
  </section>;
}
