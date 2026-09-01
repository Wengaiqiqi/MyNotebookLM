import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopApi } from "../../../../shared/ipc";
import type { ConversationDto, MessageDto } from "../../../../shared/chat";
import type { NoteDto, NoteLinkDto } from "../../../../shared/notes";
import type { ProjectDto } from "../../../../shared/projects";
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
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpenFor, setMenuOpenFor] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; draft: string }>();
  const [deleteTarget, setDeleteTarget] = useState<NoteDto>();

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
    let active = true;
    void window.myNotebook.projects.list().then(async (nextProjects) => {
      const grouped = await Promise.all(nextProjects.map((project) =>
        window.myNotebook.sources?.list({ projectId: project.id }).catch(() => []) ?? []
      ));
      if (!active) return;
      setProjects(nextProjects);
      setSources(grouped.flat().filter((source) => source.status === "active"));
    }).catch(() => { if (active) { setProjects([]); setSources([]); } });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setConversations([]);
    setMessages([]);
    void window.myNotebook.conversations.list({ projectId }).then(async (result) => {
      if (!result.ok) return;
      const messageResults = await Promise.all(result.value.map((conversation) =>
        window.myNotebook.conversations.listMessages({ projectId, conversationId: conversation.id }).catch(() => undefined)
      ));
      if (!active) return;
      setConversations(result.value);
      setMessages(messageResults.flatMap((item) => item?.ok ? item.value : []));
    }).catch(() => { if (active) { setConversations([]); setMessages([]); } });
    return () => { active = false; };
  }, [projectId]);

  const selected = useMemo(() => notes.find((note) => note.id === selectedId), [notes, selectedId]);

  useEffect(() => {
    if (!menuOpenFor) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest(".notes-menu-anchor")) setMenuOpenFor(undefined);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpenFor]);

  async function setNoteState(note: NoteDto, action: "archive" | "restore"): Promise<void> {
    const result = await api()[action]({ projectId, id: note.id, version: note.version }).catch(() => undefined);
    setMenuOpenFor(undefined);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    onChanged(result.value);
  }

  async function deleteNote(note: NoteDto): Promise<void> {
    const result = await api().delete({ projectId, id: note.id, version: note.version }).catch(() => undefined);
    setDeleteTarget(undefined);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    setNotes((current) => current.filter((item) => item.id !== note.id));
    setSelectedId((current) => (current === note.id ? undefined : current));
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
            <div className={`note-item${note.id === selectedId ? " selected" : ""}`} key={note.id}>
              {renaming?.id === note.id ? (
                <input
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
                  className="note-list-item"
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
              )}
              <div className="notes-menu-anchor">
                <button
                  type="button"
                  className="note-menu-trigger"
                  aria-label={`${t("notes.actions")}: ${note.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpenFor === note.id}
                  onClick={() => setMenuOpenFor((current) => (current === note.id ? undefined : note.id))}
                >
                  <Icon name="dots" />
                </button>
                {menuOpenFor === note.id && (
                  <div className="notes-menu" role="menu">
                    {note.archivedAt ? (
                      <button type="button" role="menuitem" onClick={() => void setNoteState(note, "restore")}>
                        <Icon name="restore" />{t("notes.restore")}
                      </button>
                    ) : (
                      <button type="button" role="menuitem" onClick={() => void setNoteState(note, "archive")}>
                        <Icon name="archive" />{t("notes.archive")}
                      </button>
                    )}
                    <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpenFor(undefined); setDeleteTarget(note); }}>
                      <Icon name="trash" />{t("notes.delete")}
                    </button>
                  </div>
                )}
              </div>
            </div>
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
      {deleteTarget && (
        <Modal open alert onClose={() => setDeleteTarget(undefined)} labelledBy="note-delete-title">
          <DialogHead id="note-delete-title" icon="trash" title={t("notes.delete")} body={t("notes.deleteConfirm")} />
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => setDeleteTarget(undefined)}>{t("common.cancel")}</button>
            <button type="button" className="btn danger" onClick={() => void deleteNote(deleteTarget)}>
              <Icon name="trash" />{t("common.confirm")}
            </button>
          </div>
        </Modal>
      )}
      {selected
        ? <NoteEditor key={selected.id} note={selected} language={language} onChanged={onChanged} onDeleted={deleted} projects={projects} sources={sources} conversations={conversations} messages={messages} />
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

function NoteEditor({ note, language, onChanged, onDeleted, projects, sources, conversations, messages }: {
  note: NoteDto;
  language: AppLanguage;
  onChanged: (note: NoteDto) => void;
  onDeleted: () => void;
  projects: ProjectDto[];
  sources: SourceDto[];
  conversations: ConversationDto[];
  messages: MessageDto[];
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [links, setLinks] = useState<NoteLinkDto[]>([]);
  const [linksOpen, setLinksOpen] = useState(false);
  const [linkSelections, setLinkSelections] = useState<Record<"source" | "message" | "answer", string[]>>({ source: [], message: [], answer: [] });
  const [openMenu, setOpenMenu] = useState<"source" | "message" | "answer" | null>(null);
  const linkMenuRef = useRef<HTMLDivElement>(null);
  const [linking, setLinking] = useState(false);
  const linkedTargetIds = new Set(links.flatMap((link) => [link.sourceId, link.messageId].filter((id): id is string => Boolean(id))));
  const linkTargets = (linkType: "source" | "message" | "answer") => linkType === "source"
    ? sources.filter((source) => source.projectId === note.projectId && !linkedTargetIds.has(source.id)).map((source) => ({ id: source.id, label: source.displayName }))
    : messages
      .filter((message) => message.state === "completed" && !message.superseded && message.content.trim() && !linkedTargetIds.has(message.id) && (linkType === "message" ? message.role === "user" : message.role === "assistant"))
      .map((message) => ({ id: message.id, label: `[${conversations.find((conversation) => conversation.id === message.conversationId)?.title ?? t("chat.ui.conversations")}] ${message.content.slice(0, 100)}` }));

  useEffect(() => { setTitle(note.title); setBody(note.body); setDirty(false); setError(""); setConflict(false); }, [note]);

  useEffect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent): void => {
      if (!linkMenuRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

  async function loadLinks(): Promise<void> {
    const result = await api().listLinks({ projectId: note.projectId, id: note.id }).catch(() => undefined);
    if (result?.ok) setLinks(result.value);
  }

  async function persistDraft(): Promise<NoteDto | undefined> {
    setError(""); setConflict(false);
    const result = await api().update({ projectId: note.projectId, id: note.id, title: title.trim(), body, version: note.version }).catch(() => undefined);
    if (!result?.ok) {
      if (result?.error.code === "CONFLICT") setConflict(true);
      else setError(result ? errorText(result, t) : t("errors.internal"));
      return undefined;
    }
    onChanged(result.value);
    return result.value;
  }

  async function save(): Promise<void> {
    if (saving || generatingTitle || !title.trim()) return;
    setSaving(true);
    const saved = await persistDraft();
    setSaving(false);
    if (!saved) return;
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
    if (generatingTitle || saving || !title.trim()) return;
    setGeneratingTitle(true);
    const saved = dirty ? await persistDraft() : note;
    if (!saved) { setGeneratingTitle(false); return; }
    const result = await api().generateTitle({ projectId: saved.projectId, noteId: saved.id, locale: language }).catch(() => undefined);
    setGeneratingTitle(false);
    if (result?.ok) {
      onChanged(result.value);
    } else toast.error(t("notes.titleFailure"));
  }

  async function linkTarget(linkType: "source" | "message" | "answer"): Promise<void> {
    const targetIds = linkSelections[linkType];
    if (linking || targetIds.length === 0) return;
    setLinking(true);
    const results = await Promise.all(targetIds.map((targetId) => api().createLink({
      projectId: note.projectId,
      noteId: note.id,
      ...(linkType === "source" ? { sourceId: targetId } : { messageId: targetId })
    }).catch(() => undefined)));
    const created = results.flatMap((result) => result?.ok ? [result.value] : []);
    setLinks((current) => [...current, ...created]);
    setLinkSelections((current) => ({ ...current, [linkType]: [] }));
    setLinking(false);
    const failed = results.filter((result) => !result?.ok).length;
    if (failed > 0) toast.error(t("errors.internal"));
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
        <button type="button" className={`btn ghost sm${generatingTitle ? " loading" : ""}`} disabled={generatingTitle || saving || !title.trim()} aria-busy={generatingTitle} onClick={() => void generateTitle()}>
          {generatingTitle ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkle" />}
          {generatingTitle ? t("notes.aiTitleGenerating") : t("notes.aiTitle")}
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
          disabled={generatingTitle}
          aria-label={t("notes.title")}
          placeholder={t("notes.title")}
        />
        <div className="editor-grid">
          <textarea
            className="textarea"
            value={body}
            disabled={generatingTitle}
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
            <div className="note-link-picker" style={{ marginBottom: 8 }}>
              {(["source", "message", "answer"] as const).map((kind) => {
                const targets = linkTargets(kind);
                const label = kind === "source" ? t("notes.source") : kind === "message" ? t("notes.questionMessage") : t("notes.modelAnswer");
                const selection = linkSelections[kind];
                return <div className="note-link-row" key={kind}>
                  <span className="kind-tag">{label}</span>
                  <div className="target-select" ref={openMenu === kind ? linkMenuRef : undefined}>
                    <button type="button" className="select target-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={openMenu === kind} onClick={() => setOpenMenu(openMenu === kind ? null : kind)}>
                      <span className="target-select-value">{selection.length === 0
                        ? (targets.length ? `${label}…` : t("notes.noMessages"))
                        : t("notes.selectedCount").replace("{count}", String(selection.length))}</span>
                      <Icon name={openMenu === kind ? "chevron-up" : "chevron-down"} className="conv-caret" />
                    </button>
                    {openMenu === kind && (
                      <div className="target-select-menu" role="listbox" aria-label={label} aria-multiselectable="true">
                        {targets.map((target) => {
                          const checked = selection.includes(target.id);
                          return <button type="button" role="option" aria-selected={checked} className={`target-select-option${checked ? " selected" : ""}`} key={target.id} onClick={() => setLinkSelections((current) => ({ ...current, [kind]: checked ? current[kind].filter((id) => id !== target.id) : [...current[kind], target.id] }))}>
                            <input type="checkbox" readOnly checked={checked} tabIndex={-1} />
                            <span>{target.label}</span>
                          </button>;
                        })}
                      </div>
                    )}
                  </div>
                  <button type="button" className="btn sm" disabled={linking || selection.length === 0} onClick={() => void linkTarget(kind)}>{linking ? t("notes.linking") : t("notes.link")}</button>
                </div>;
              })}
            </div>
            {links.length === 0
              ? <p style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{t("notes.noLinks")}</p>
              : links.map((link) => {
                const linkedMessage = messages.find((message) => message.id === link.messageId);
                const kind = link.targetProjectId ? t("notes.project") : link.sourceId ? t("notes.source") : linkedMessage?.role === "user" ? t("notes.questionMessage") : linkedMessage?.role === "assistant" ? t("notes.modelAnswer") : link.messageId ? t("notes.message") : t("notes.citation");
                const value = link.targetProjectId ?? link.sourceId ?? link.messageId ?? link.citationId ?? "";
                const linkedSource = sources.find((source) => source.id === link.sourceId);
                const targetName = link.targetProjectId
                  ? projects.find((project) => project.id === link.targetProjectId)?.name
                  : linkedSource
                    ? `${projects.find((project) => project.id === linkedSource.projectId)?.name ?? ""} / ${linkedSource.displayName}`
                    : linkedMessage
                      ? `[${conversations.find((conversation) => conversation.id === linkedMessage.conversationId)?.title ?? t("chat.ui.conversations")}] ${linkedMessage.content}`
                      : undefined;
                return (
                  <div className="link-row" key={link.id}>
                    <span className="kind-tag">{kind}</span>
                    <span className="target">{targetName ?? value}</span>
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
        <button type="button" className="btn primary" disabled={saving || generatingTitle || !title.trim()} onClick={() => void save()}>
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
