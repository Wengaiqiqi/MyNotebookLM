import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopApi } from "../../../../shared/ipc";
import type { NoteDto, NoteLinkDto } from "../../../../shared/notes";
import type { SourceDto } from "../../../../shared/sources";
import SafeMarkdown from "../../chat/SafeMarkdown";
import Icon from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import { errorText, formatDate } from "../../lib/format";
import { api as getApi } from "../../lib/api";
import type { AppLanguage } from "../../i18n";

type NotesApi = NonNullable<DesktopApi["notes"]>;
const api = (): NotesApi => getApi().notes;

export default function NotesPane({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [notes, setNotes] = useState<NoteDto[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; draft: string }>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async (includeArchived: boolean) => {
    const result = await api().list({ projectId, includeArchived }).catch(() => undefined);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    const visible = result.value.filter((note) => includeArchived ? Boolean(note.archivedAt) : !note.archivedAt);
    setNotes(visible);
    setSelectedId((current) => current && visible.some((note) => note.id === current) ? current : visible[0]?.id);
    setLoaded(true);
  }, [projectId, t]);

  useEffect(() => { setLoaded(false); void load(showArchived); }, [load, showArchived]);

  useEffect(() => {
    void window.myNotebook.sources?.list({ projectId }).then(setSources).catch(() => undefined);
  }, [projectId]);

  const selected = useMemo(() => notes.find((note) => note.id === selectedId), [notes, selectedId]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest(".notes-menu-anchor")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  async function setNoteState(action: "archive" | "restore"): Promise<void> {
    if (!selected) return;
    const result = await api()[action]({ projectId, id: selected.id, version: selected.version }).catch(() => undefined);
    setMenuOpen(false);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    onChanged(result.value);
  }

  async function deleteSelected(): Promise<void> {
    if (!selected) return;
    const result = await api().delete({ projectId, id: selected.id, version: selected.version }).catch(() => undefined);
    setMenuOpen(false);
    setConfirmingDelete(false);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    setNotes((current) => current.filter((note) => note.id !== selected.id));
    setSelectedId(undefined);
  }

  async function commitRename(): Promise<void> {
    const target = renaming;
    setRenaming(undefined);
    if (!target) return;
    const note = notes.find((item) => item.id === target.id);
    const title = target.draft.trim();
    if (!note || !title || title === note.title) return;
    const result = await api().update({ projectId, id: note.id, title, body: note.body, version: note.version }).catch(() => undefined);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    setNotes((current) => current.map((item) => (item.id === result.value.id ? result.value : item)));
  }

  async function createNote(): Promise<void> {
    const result = await api().create({ projectId, title: t("notes.untitled"), body: "" }).catch(() => undefined);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    if (showArchived) setShowArchived(false);
    setNotes((current) => [result.value, ...current]);
    setSelectedId(result.value.id);
  }

  function onChanged(next: NoteDto): void {
    const visible = showArchived ? Boolean(next.archivedAt) : !next.archivedAt;
    setNotes((current) => visible
      ? current.map((note) => (note.id === next.id ? next : note))
      : current.filter((note) => note.id !== next.id));
    setSelectedId((current) => (visible ? next.id : current === next.id ? undefined : current));
  }

  async function deleted(): Promise<void> {
    setNotes((current) => current.filter((note) => note.id !== selectedId));
    setSelectedId(undefined);
  }

  const listPanel = (
    <section className="panel" aria-label={t("notes.titlePage")}>
        <header className="panel-head">
          <h2>{showArchived ? t("notes.archived") : t("notes.titlePage")}</h2>
          <span className="count">{notes.length}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label={t("notes.collapsePanel")} onClick={() => setCollapsed(true)}>
            <Icon name="chevrons-left" />
          </button>
          <div className="notes-menu-anchor">
            <button
              type="button"
              className="icon-btn"
              aria-label={t("notes.actions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={!selected}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <Icon name="dots" />
            </button>
            {menuOpen && selected && (
              <div className="notes-menu" role="menu">
                {selected.archivedAt ? (
                  <button type="button" role="menuitem" onClick={() => void setNoteState("restore")}>
                    <Icon name="restore" />{t("notes.restore")}
                  </button>
                ) : (
                  <button type="button" role="menuitem" onClick={() => void setNoteState("archive")}>
                    <Icon name="archive" />{t("notes.archive")}
                  </button>
                )}
                <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setConfirmingDelete(true); }}>
                  <Icon name="trash" />{t("notes.delete")}
                </button>
              </div>
            )}
          </div>
          <button type="button" className="btn primary sm" onClick={() => void createNote()}>
            <Icon name="plus" />{t("notes.new")}
          </button>
        </header>
        <div className="panel-head" style={{ minHeight: 42, borderBottom: "none" }}>
          <button type="button" className="btn ghost sm" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>
            <Icon name={showArchived ? "restore" : "archive"} />
            {showArchived ? t("notes.active") : t("notes.archived")}
          </button>
        </div>
        <div className="panel-body">
          {!loaded ? (
            <div className="empty"><span className="spinner" aria-hidden="true" /></div>
          ) : notes.length === 0 ? (
            <div className="empty">
              <span className="glyph" aria-hidden="true"><Icon name="notes" /></span>
              <h3>{t("notes.empty")}</h3>
              <p>{t("notes.emptyBody")}</p>
              <div className="actions">
                <button type="button" className="btn outline sm" onClick={() => void createNote()}>{t("notes.new")}</button>
              </div>
            </div>
          ) : notes.map((note) => (
            renaming?.id === note.id ? (
              <input
                key={note.id}
                className="input note-rename"
                autoFocus
                value={renaming.draft}
                onChange={(event) => setRenaming({ id: note.id, draft: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitRename();
                  if (event.key === "Escape") setRenaming(undefined);
                }}
                onBlur={() => void commitRename()}
                maxLength={200}
                aria-label={t("notes.title")}
              />
            ) : (
              <button
                type="button"
                key={note.id}
                className={`note-list-item${note.id === selectedId ? " selected" : ""}`}
                aria-current={note.id === selectedId ? "page" : undefined}
                title={t("notes.renameHint")}
                onClick={() => setSelectedId(note.id)}
                onDoubleClick={() => setRenaming({ id: note.id, draft: note.title })}
              >
                <strong>{note.title}</strong>
                <small>
                  {formatDate(note.updatedAt, language)}
                  {note.archivedAt && <span className="archived-tag"> · {t("notes.archivedTag")}</span>}
                </small>
              </button>
            )
          ))}
        </div>
      </section>);

  return (
    <div className="pane notes">
      {collapsed ? (
        <aside className="panel rail rail-left" aria-label={t("notes.titlePage")}>
          <button type="button" className="icon-btn" aria-label={t("notes.expandPanel")} onClick={() => setCollapsed(false)}>
            <Icon name="chevrons-right" />
          </button>
        </aside>
      ) : listPanel}
      {confirmingDelete && (
        <Modal open alert onClose={() => setConfirmingDelete(false)} labelledBy="note-delete-title">
          <DialogHead id="note-delete-title" icon="trash" title={t("notes.delete")} body={t("notes.deleteConfirm")} />
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => setConfirmingDelete(false)}>{t("common.cancel")}</button>
            <button type="button" className="btn danger" onClick={() => void deleteSelected()}>
              <Icon name="trash" />{t("common.confirm")}
            </button>
          </div>
        </Modal>
      )}
      {selected
        ? <NoteEditor key={selected.id} note={selected} language={language} onChanged={onChanged} onDeleted={deleted} sources={sources} />
        : (
          <section className="panel">
            <div className="empty" style={{ height: "100%" }}>
              <span className="glyph" aria-hidden="true"><Icon name="notes" /></span>
              <p>{t("notes.select")}</p>
            </div>
          </section>
        )}
    </div>
  );
}

function NoteEditor({ note, language, onChanged, onDeleted, sources }: {
  note: NoteDto;
  language: AppLanguage;
  onChanged: (note: NoteDto) => void;
  onDeleted: () => void;
  sources: SourceDto[];
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [links, setLinks] = useState<NoteLinkDto[]>([]);
  const [linksOpen, setLinksOpen] = useState(false);
  const [linkSourceId, setLinkSourceId] = useState("");

  useEffect(() => { setTitle(note.title); setBody(note.body); setDirty(false); setError(""); setConflict(false); }, [note]);

  async function loadLinks(): Promise<void> {
    const result = await api().listLinks({ projectId: note.projectId, id: note.id }).catch(() => undefined);
    if (result?.ok) setLinks(result.value);
  }

  async function save(): Promise<void> {
    if (saving || !title.trim()) return;
    setSaving(true); setError(""); setConflict(false);
    const result = await api().update({ projectId: note.projectId, id: note.id, title: title.trim(), body, version: note.version }).catch(() => undefined);
    setSaving(false);
    if (!result?.ok) {
      if (result?.error.code === "CONFLICT") setConflict(true);
      else setError(result ? errorText(result, t) : t("errors.internal"));
      return;
    }
    onChanged(result.value);
    toast.success(t("notes.savedToast"));
  }

  async function reload(): Promise<void> {
    const result = await api().get({ projectId: note.projectId, id: note.id }).catch(() => undefined);
    if (result?.ok && result.value) onChanged(result.value);
    else setError(t("errors.notFound"));
  }

  async function setState(action: "archive" | "restore"): Promise<void> {
    const result = await api()[action]({ projectId: note.projectId, id: note.id, version: note.version }).catch(() => undefined);
    if (result?.ok) onChanged(result.value);
    else setError(result ? errorText(result, t) : t("errors.internal"));
  }

  async function remove(): Promise<void> {
    const result = await api().delete({ projectId: note.projectId, id: note.id, version: note.version }).catch(() => undefined);
    if (result?.ok) onDeleted();
    else setError(result ? errorText(result, t) : t("errors.internal"));
  }

  async function generateTitle(): Promise<void> {
    setError("");
    const result = await api().generateTitle({ projectId: note.projectId, noteId: note.id, locale: language }).catch(() => undefined);
    if (result?.ok) onChanged(result.value);
    else toast.error(t("notes.titleFailure"));
  }

  async function linkSource(): Promise<void> {
    if (!linkSourceId) return;
    const result = await api().createLink({ projectId: note.projectId, noteId: note.id, sourceId: linkSourceId }).catch(() => undefined);
    if (result?.ok) {
      setLinks((current) => [...current, result.value]);
      setLinkSourceId("");
    } else {
      toast.error(result ? errorText(result, t) : t("errors.internal"));
    }
  }

  async function unlink(link: NoteLinkDto): Promise<void> {
    const result = await api().deleteLink({ projectId: note.projectId, noteId: note.id, linkId: link.id }).catch(() => undefined);
    if (result?.ok) setLinks((current) => current.filter((item) => item.id !== link.id));
  }

  useEffect(() => { void loadLinks(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [note.id]);

  return (
    <section className="panel note-editor" aria-label={t("notes.edit")}>
      <header className="panel-head">
        <h2 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title || t("notes.untitled")}</h2>
        <span className="count">v{note.version}{dirty ? " ·" : ""}{dirty && <span className="badge warn">{t("notes.unsaved")}</span>}</span>
        <span className="spacer" />
        <button type="button" className="btn ghost sm" aria-expanded={linksOpen} onClick={() => setLinksOpen((value) => !value)}>
          <Icon name="link" />{t("notes.links")}<span className="count">{links.length}</span>
        </button>
        <button type="button" className="btn ghost sm" onClick={() => void generateTitle()}>
          <Icon name="sparkle" />{t("notes.aiTitle")}
        </button>
      </header>

      {conflict && (
        <div className="note-conflict" role="alert">
          <span>{t("notes.conflict")}</span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => void reload()}>{t("notes.reloadServer")}</button>
          <button type="button" className="btn sm" onClick={() => setConflict(false)}>{t("notes.keepDraft")}</button>
        </div>
      )}
      {error && <p className="form-error" style={{ margin: "10px 18px 0" }} role="alert"><Icon name="alert" />{error}</p>}

      <div className="note-editor-body">
        <input
          className="title-input"
          value={title}
          onChange={(event) => { setTitle(event.target.value); setDirty(true); }}
          maxLength={200}
          aria-label={t("notes.title")}
          placeholder={t("notes.title")}
        />
        <div className="editor-grid">
          <textarea
            className="textarea"
            value={body}
            onChange={(event) => { setBody(event.target.value); setDirty(true); }}
            aria-label={t("notes.body")}
            placeholder={t("notes.bodyPlaceholder")}
          />
          <div className="preview-box">
            <div className="label">{t("notes.preview")}</div>
            <SafeMarkdown text={body} />
          </div>
        </div>

        {linksOpen && (
          <div>
            <div className="input-row" style={{ marginBottom: 8 }}>
              <select className="select" aria-label={t("notes.linkSource")} value={linkSourceId} onChange={(event) => setLinkSourceId(event.target.value)}>
                <option value="">{t("notes.linkSourcePlaceholder")}</option>
                {sources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
              </select>
              <button type="button" className="btn sm" disabled={!linkSourceId} onClick={() => void linkSource()}>{t("notes.link")}</button>
            </div>
            {links.length === 0
              ? <p style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{t("notes.noLinks")}</p>
              : links.map((link) => {
                const kind = link.sourceId ? t("notes.source") : link.messageId ? t("notes.message") : t("notes.citation");
                const value = link.sourceId ?? link.messageId ?? link.citationId ?? "";
                const sourceName = sources.find((source) => source.id === value)?.displayName;
                return (
                  <div className="link-row" key={link.id}>
                    <span className="kind-tag">{kind}</span>
                    <span className="target">{sourceName ?? value}</span>
                    {!link.targetAvailable && <span className="unavailable">{t("notes.targetUnavailable")}</span>}
                    <button type="button" className="icon-btn danger" aria-label={t("notes.unlink")} onClick={() => void unlink(link)}>
                      <Icon name="unlink" />
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <footer className="note-editor-foot">
        {note.archivedAt
          ? <button type="button" className="btn sm" onClick={() => void setState("restore")}><Icon name="restore" />{t("notes.restore")}</button>
          : <button type="button" className="btn sm" onClick={() => void setState("archive")}><Icon name="archive" />{t("notes.archive")}</button>}
        <button type="button" className="btn sm danger-soft" onClick={() => setConfirmDelete(true)}><Icon name="trash" />{t("notes.delete")}</button>
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={saving || !title.trim() || !dirty} onClick={() => void save()}>
          {saving ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
          {saving ? t("common.saving") : t("notes.save")}
        </button>
      </footer>

      {confirmDelete && (
        <Modal open alert onClose={() => setConfirmDelete(false)} labelledBy="note-delete-title">
          <DialogHead id="note-delete-title" icon="trash" title={t("notes.delete")} body={t("notes.deleteConfirm")} />
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>
            <button type="button" className="btn danger" onClick={() => { setConfirmDelete(false); void remove(); }}>
              <Icon name="trash" />{t("common.confirm")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
