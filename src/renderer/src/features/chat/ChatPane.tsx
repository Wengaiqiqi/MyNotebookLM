import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CitationDto, ConversationDto, MessageDto } from "../../../../shared/chat";
import type { ModelProfileDto } from "../../../../shared/models";
import type { SourceDto } from "../../../../shared/sources";
import SafeMarkdown from "../../chat/SafeMarkdown";
import { useChatStream } from "../../chat/useChatStream";
import Icon from "../../ui/Icon";
import { toast } from "../../ui/Toast";
import { errorText, formatDateTime, sourceReady } from "../../lib/format";

type ConversationsApi = typeof window.myNotebook.conversations;
type ChatApi = typeof window.myNotebook.chat;
type CitationsApi = typeof window.myNotebook.citations;

export default function ChatPane({ projectId, generationProfileId, sources, onOpenSettings, onImport }: {
  projectId: string;
  generationProfileId?: string | undefined;
  sources: SourceDto[];
  onOpenSettings: () => void;
  onImport: () => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [restored, setRestored] = useState<MessageDto[]>([]);
  const [profiles, setProfiles] = useState<ModelProfileDto[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState(generationProfileId ?? "");
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [activeCitation, setActiveCitation] = useState<CitationDto | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(true);

  const indexedCount = useMemo(() => sources.filter(sourceReady).length, [sources]);
  const chatAvailable = Boolean(generationProfileId) && indexedCount > 0;

  // Conversations
  useEffect(() => {
    let alive = true;
    setConversationId("");
    setRestored([]);
    void window.myNotebook.conversations.list({ projectId }).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setConversations(result.value);
        setConversationId(result.value[0]?.id ?? "");
      } else {
        toast.error(errorText(result, t));
      }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, t]);

  // Restore transcript when switching conversations.
  useEffect(() => {
    let alive = true;
    if (!conversationId) { setRestored([]); return; }
    void window.myNotebook.conversations.listMessages({ projectId, conversationId }).then((result) => {
      if (!alive) return;
      if (result.ok) setRestored(result.value);
      else toast.error(errorText(result, t));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, conversationId, t]);

  // Generation profile options.
  useEffect(() => {
    let alive = true;
    setSelectedProfileId(generationProfileId ?? "");
    if (!generationProfileId) { setProfiles([]); return; }
    void window.myNotebook.models.listProfiles().then((result) => {
      if (!alive || !result.ok) return;
      setProfiles(result.value.profiles.filter((profile) => profile.enabled && profile.capability === "generation"));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [generationProfileId]);

  const stream = useChatStream(window.myNotebook.chat, projectId, conversationId, restored, selectedProfileId || undefined);
  const messages = stream.messages;

  // Auto-follow scroll while streaming.
  useEffect(() => {
    const list = scrollRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  // Auto-grow composer up to a sane ceiling; starts as a single line.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [question]);

  // Close the model menu on any outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest(".model-picker")) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [modelMenuOpen]);
  useEffect(() => { followRef.current = true; }, [conversationId]);

  async function send(): Promise<void> {
    const text = question.trim();
    if (!text || !stream.canSend) return;
    setQuestion("");
    if (!conversationId) {
      const created = await window.myNotebook.conversations.create({ projectId, title: text.slice(0, 60) || t("chat.newConversation") });
      if (!created.ok) { toast.error(errorText(created, t)); return; }
      setConversations((current) => [created.value, ...current]);
      setConversationId(created.value.id);
    } else {
      // A fresh "新对话" takes its title from the first question sent.
      const current = conversations.find((item) => item.id === conversationId);
      if (current && current.title === t("chat.newConversation")) {
        void window.myNotebook.conversations.rename({ projectId, conversationId, title: text.slice(0, 60) })
          .then((result) => {
            if (result.ok) setConversations((items) => items.map((item) => (item.id === conversationId ? result.value : item)));
          })
          .catch(() => undefined);
      }
    }
    await stream.send(text);
  }

  function onScroll(event: React.UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const citations = useMemo(() => {
    const owner = activeCitation
      ? messages.find((message) => message.role === "assistant" && message.citations.some((citation) => citation.id === activeCitation.id))
      : undefined;
    return (owner ?? latestAssistant)?.citations ?? [];
  }, [messages, activeCitation, latestAssistant]);

  const activeConversation = conversations.find((item) => item.id === conversationId);

  async function commitTitle(): Promise<void> {
    const target = activeConversation;
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!target || !title || title === target.title) return;
    const result = await window.myNotebook.conversations.rename({ projectId, conversationId: target.id, title });
    if (!result.ok) { toast.error(errorText(result, t)); return; }
    setConversations((current) => current.map((item) => (item.id === target.id ? result.value : item)));
  }

  if (!chatAvailable) {
    return <ChatUnavailable indexedCount={indexedCount} hasModel={Boolean(generationProfileId)} onOpenSettings={onOpenSettings} onImport={onImport} />;
  }

  return (
    <>
    <section className="panel chat" aria-label={t("chat.ui.researchChat")}>
      <header className="chat-toolbar">
        <div className="conv-picker">
          {editingTitle ? (
            <input
              className="input conv-rename"
              autoFocus
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitTitle();
                if (event.key === "Escape") setEditingTitle(false);
              }}
              onBlur={() => void commitTitle()}
              maxLength={200}
              aria-label={t("chat.ui.rename")}
            />
          ) : (
            <button
              type="button"
              className="conv-trigger"
              aria-expanded={convMenuOpen}
              aria-haspopup="menu"
              title={t("chat.renameHint")}
              onClick={() => setConvMenuOpen((value) => !value)}
              onDoubleClick={() => {
                if (!activeConversation) return;
                setTitleDraft(activeConversation.title);
                setEditingTitle(true);
              }}
            >
              <Icon name="chat" />
              <span className="conv-trigger-title">{activeConversation?.title ?? t("chat.ui.conversations")}</span>
              <Icon name={convMenuOpen ? "chevron-up" : "chevron-down"} className="conv-caret" />
            </button>
          )}
          {convMenuOpen && (
            <div className="conv-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="conv-new"
                onClick={async () => {
                  setConvMenuOpen(false);
                  const created = await window.myNotebook.conversations.create({ projectId, title: t("chat.newConversation") });
                  if (created.ok) { setConversations((current) => [created.value, ...current]); setConversationId(created.value.id); }
                  else toast.error(errorText(created, t));
                }}
              >
                <Icon name="plus" />{t("chat.newConversation")}
              </button>
              {conversations.length === 0 && <p className="empty-note">{t("chat.ui.noConversations")}</p>}
              {conversations.map((item) => (
                <div className={`conv-item${item.id === conversationId ? " selected" : ""}`} key={item.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="conv-open"
                    title={t("chat.renameHint")}
                    onClick={() => { setConversationId(item.id); setActiveCitation(null); setConvMenuOpen(false); }}
                    onDoubleClick={() => {
                      setConversationId(item.id);
                      setTitleDraft(item.title);
                      setEditingTitle(true);
                      setConvMenuOpen(false);
                    }}
                  >
                    <strong>{item.title}</strong>
                    <small>{formatDateTime(item.updatedAt, language)}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label={`${t("chat.ui.remove")}: ${item.title}`}
                    onClick={async () => {
                      const result = await window.myNotebook.conversations.delete({ projectId, conversationId: item.id });
                      if (!result.ok) { toast.error(errorText(result, t)); return; }
                      const next = conversations.filter((current) => current.id !== item.id);
                      setConversations(next);
                      if (item.id === conversationId) setConversationId(next[0]?.id ?? "");
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="spacer" />
        <span className="badge accent">{indexedCount} {t("chat.ui.indexedLabel")}</span>
      </header>

      {stream.fallback && (
        <p className="chat-note" role="status">{t("chat.ui.fallbackBanner")}</p>
      )}
      {stream.error && (
        <p className="chat-note error" role="alert">
          {t(stream.error.messageKey, stream.error.messageKey)}
          {stream.repairableMessageId && (
            <button type="button" onClick={() => void stream.repair()}>{t("chat.ui.retryAnswer")}</button>
          )}
        </p>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} aria-live="polite">
        {messages.length === 0 && (
          <div className="empty" style={{ height: "100%" }}>
            <span className="glyph" aria-hidden="true"><Icon name="sparkle" /></span>
            <h3>{t("chat.emptyTitle")}</h3>
            <p>{t("chat.emptyBody")}</p>
          </div>
        )}
        {messages.map((message) => (
          message.role === "user"
            ? (
              <article className="msg user" key={message.id}>
                <div className="bubble">{message.content}</div>
              </article>
            )
            : (
              <article className={`msg assistant is-${message.state}`} key={message.id}>
                <div className="bubble assistant-body">
                  {message.state === "streaming" && !message.content
                    ? <span className="typing" aria-label={t("chat.message.streaming")}><i /><i /><i /></span>
                    : (
                      <SafeMarkdown
                        text={message.content}
                        citations={message.citations}
                        onCitationOpen={(citation: CitationDto) => setActiveCitation(citation)}
                      />
                    )}
                </div>
                {message.state !== "streaming" && (
                  <div className="meta">
                    {message.model ? <span>{message.model}</span> : null}
                    <span className="spacer" />
                    {message.state === "completed" && (
                      <>
                        <button type="button" onClick={() => { void navigator.clipboard?.writeText(message.content); toast.success(t("chat.copied")); }}>
                          <Icon name="copy" />{t("chat.ui.copy")}
                        </button>
                        <button type="button" disabled={stream.state === "streaming"} title={t("chat.retryBusyHint")} onClick={() => void stream.regenerate(message.id)}>
                          <Icon name="retry" />{t("chat.ui.regenerate")}
                        </button>
                      </>
                    )}
                    {message.state === "cancelled" && (
                      <button type="button" disabled={stream.state === "streaming"} title={t("chat.retryBusyHint")} onClick={() => void stream.regenerate(message.id)}>
                        <Icon name="retry" />{t("chat.ui.regenerate")}
                      </button>
                    )}
                    {message.state === "failed" && (
                      <button type="button" disabled={stream.state === "streaming"} title={t("chat.retryBusyHint")} onClick={() => void stream.regenerate(message.id)}>
                        <Icon name="retry" />{t("chat.ui.retryAnswer")}
                      </button>
                    )}
                  </div>
                )}
              </article>
            )
        ))}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={composerRef}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            placeholder={t("chat.ui.askPlaceholder")}
            aria-label={t("research.ask")}
            rows={1}
          />
          <div className="composer-bar">
            {profiles.length > 0 && (
              <div className="model-picker">
                <button
                  type="button"
                  className="model-pill"
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  aria-label={t("chat.ui.model")}
                  onClick={() => setModelMenuOpen((value) => !value)}
                >
                  <span className="model-pill-name">
                    {profiles.find((profile) => profile.id === selectedProfileId)?.modelId ?? t("chat.ui.noModel")}
                  </span>
                  <Icon name={modelMenuOpen ? "chevron-up" : "chevron-down"} className="conv-caret" />
                </button>
                {modelMenuOpen && (
                  <div className="model-menu" role="menu" aria-label={t("chat.ui.model")}>
                    {profiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        role="menuitem"
                        className={`model-option${profile.id === selectedProfileId ? " selected" : ""}`}
                        onClick={() => { setSelectedProfileId(profile.id); setModelMenuOpen(false); }}
                      >
                        <span className="model-option-copy">
                          <strong>{profile.modelId}</strong>
                          <small>{t(`model.providers.${profile.provider}`)}</small>
                        </span>
                        {profile.id === selectedProfileId && <Icon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <span className="spacer" />
            <span className="kbd" aria-hidden="true">Enter</span>
            {stream.state === "streaming"
              ? (
                <button type="button" className="send-btn stop" aria-label={t("chat.ui.stop")} onClick={() => void stream.stop()}>
                  <Icon name="stop" />
                </button>
              )
              : (
                <button type="button" className="send-btn" aria-label={t("chat.ui.send")} disabled={!question.trim() || !stream.canSend} onClick={() => void send()}>
                  <Icon name="send" />
                </button>
              )}
          </div>
        </div>
      </div>
    </section>
    <CitationsPanel
      projectId={projectId}
      citations={citations}
      active={activeCitation}
      onSelect={setActiveCitation}
    />
    </>
  );
}

function ChatUnavailable({ indexedCount, hasModel, onOpenSettings, onImport }: {
  indexedCount: number;
  hasModel: boolean;
  onOpenSettings: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="panel" aria-label={t("chat.ui.researchChat")}>
      <div className="empty" style={{ height: "100%" }}>
        <span className="glyph" aria-hidden="true"><Icon name="sparkle" /></span>
        <h3>{t("chat.ui.unavailableTitle")}</h3>
        <p>{!hasModel ? t("chat.ui.unavailableModel") : t("chat.ui.unavailableImport")}</p>
        <div className="actions">
          {!hasModel && <button type="button" className="btn primary" onClick={onOpenSettings}>{t("chat.ui.openSettings")}</button>}
          <button type="button" className="btn outline" onClick={onImport}>{t("chat.ui.importSources")}</button>
        </div>
        <p style={{ marginTop: 14, fontSize: 12 }}>
          {indexedCount > 0
            ? t("research.sourcesReadyCount", { count: indexedCount })
            : t("research.noSourcesShort")}
        </p>
      </div>
    </section>
  );
}

export function CitationsPanel({ projectId, citations, active, onSelect }: {
  projectId: string;
  citations: CitationDto[];
  active: CitationDto | null;
  onSelect: (citation: CitationDto) => void;
}) {
  const { t } = useTranslation();
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return citations.filter((citation) => {
      if (seen.has(citation.label)) return false;
      seen.add(citation.label);
      return true;
    });
  }, [citations]);

  async function open(citation: CitationDto): Promise<void> {
    const result = await (window.myNotebook.citations as CitationsApi).open({ projectId, citationId: citation.id });
    if (!result.ok) toast.error(errorText(result, t));
    else toast.success(t("chat.ui.opened", { kind: result.value.opened }));
  }

  const [collapsed, setCollapsed] = useState(false);

  // Clicking a citation chip in the transcript scrolls its card into view
  // (and expands the panel first if it was collapsed).
  useEffect(() => {
    if (active && collapsed) setCollapsed(false);
  }, [active, collapsed]);
  useEffect(() => {
    if (!active || collapsed) return;
    cardRefs.current.get(active.label)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [active, collapsed]);

  if (collapsed) {
    return (
      <aside className="panel rail rail-right" aria-label={t("chat.ui.citationTitle")}>
        <button type="button" className="icon-btn" aria-label={t("chat.citeExpand")} onClick={() => setCollapsed(false)}>
          <Icon name="chevrons-left" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="panel cite-panel" aria-label={t("chat.ui.citationTitle")}>
      <header className="panel-head">
        <h2>{t("chat.ui.citationTitle")}</h2>
        <span className="count">{unique.length}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label={t("chat.citeCollapse")} onClick={() => setCollapsed(true)}>
          <Icon name="chevrons-right" />
        </button>
      </header>
      <div className="panel-body">
        {unique.length === 0 ? (
          <div className="empty" style={{ padding: "32px 12px" }}>
            <span className="glyph" aria-hidden="true"><Icon name="link" /></span>
            <p>{t("chat.ui.citationEmpty")}</p>
          </div>
        ) : unique.map((citation) => (
          <article
            className={`cite-item${active?.id === citation.id ? " active" : ""}`}
            key={citation.label}
            ref={(node) => {
              if (node) cardRefs.current.set(citation.label, node);
              else cardRefs.current.delete(citation.label);
            }}
            onClick={() => onSelect(citation)}
          >
            <div className="cite-item-head">
              <span className="cite-num" aria-hidden="true">{citation.label.replace("S", "")}</span>
              <span className="copy">
                <strong title={citation.sourceDisplayName}>{citation.sourceDisplayName}</strong>
                <small>{locatorText(citation, t)}</small>
              </span>
            </div>
            {citation.quote && <blockquote className="cite-quote">{citation.quote}</blockquote>}
            <div className="foot">
              <button type="button" onClick={(event) => { event.stopPropagation(); void open(citation); }}>
                <Icon name="open" />{t("chat.ui.viewDetails")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

function locatorText(citation: CitationDto, t: (key: string) => string): string {
  const locator = citation.locator;
  switch (locator.kind) {
    case "page": return `${t("chat.ui.page")} ${locator.page}${locator.endPage && locator.endPage !== locator.page ? "–" + locator.endPage : ""}`;
    case "slide": return `${t("chat.ui.slide")} ${locator.slide}`;
    case "sheet": return `${t("chat.ui.sheet")} ${locator.sheet}`;
    case "cell": return `${t("chat.ui.cell")} ${locator.cellRef}`;
    case "heading": return locator.headingPath;
    case "paragraph": return `${t("chat.ui.page")} ¶${locator.paragraph}`;
    case "section": return locator.sectionPath;
    case "row": return `${t("chat.ui.sheet")} R${locator.startRow}`;
    case "offset": return `#0${locator.start}`;
    default: return "";
  }
}

