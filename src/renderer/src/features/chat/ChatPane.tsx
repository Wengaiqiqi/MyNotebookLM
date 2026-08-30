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
  const [question, setQuestion] = useState("");
  const [activeCitation, setActiveCitation] = useState<CitationDto | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  if (!chatAvailable) {
    return <ChatUnavailable indexedCount={indexedCount} hasModel={Boolean(generationProfileId)} onOpenSettings={onOpenSettings} onImport={onImport} />;
  }

  return (
    <>
    <section className="panel chat" aria-label={t("chat.ui.researchChat")}>
      <header className="chat-toolbar">
        <div className="conv-picker">
          <button
            type="button"
            className="btn ghost sm"
            aria-expanded={convMenuOpen}
            aria-haspopup="menu"
            onClick={() => setConvMenuOpen((value) => !value)}
          >
            <Icon name="chat" />
            <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activeConversation?.title ?? t("chat.ui.conversations")}
            </span>
            <Icon name={convMenuOpen ? "chevron-up" : "chevron-down"} />
          </button>
          {convMenuOpen && (
            <div className="conv-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="btn ghost sm"
                style={{ width: "100%", justifyContent: "flex-start", color: "var(--accent)" }}
                onClick={async () => {
                  setConvMenuOpen(false);
                  const created = await window.myNotebook.conversations.create({ projectId, title: t("chat.newConversation") });
                  if (created.ok) { setConversations((current) => [created.value, ...current]); setConversationId(created.value.id); }
                  else toast.error(errorText(created, t));
                }}
              >
                <Icon name="plus" />{t("chat.newConversation")}
              </button>
              <div className="menu-sep" aria-hidden="true" />
              {conversations.length === 0 && <p className="empty-note">{t("chat.ui.noConversations")}</p>}
              {conversations.map((item) => (
                <div className={`conv-item${item.id === conversationId ? " selected" : ""}`} key={item.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="conv-open"
                    onClick={() => { setConversationId(item.id); setActiveCitation(null); setConvMenuOpen(false); }}
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
        <h2>{activeConversation?.title ?? t("chat.ui.researchChat")}</h2>
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
                        <button type="button" onClick={() => void stream.regenerate(message.id)}>
                          <Icon name="retry" />{t("chat.ui.regenerate")}
                        </button>
                      </>
                    )}
                    {message.state === "cancelled" && (
                      <button type="button" onClick={() => void stream.regenerate(message.id)}>
                        <Icon name="retry" />{t("chat.ui.regenerate")}
                      </button>
                    )}
                    {message.state === "failed" && (
                      <button type="button" onClick={() => void stream.regenerate(message.id)}>
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
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            placeholder={t("chat.ui.askPlaceholder")}
            aria-label={t("research.ask")}
            rows={2}
          />
          <div className="composer-bar">
            {profiles.length > 1 ? (
              <select
                className="select model-select"
                aria-label={t("chat.ui.model")}
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
              >
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.modelId}</option>)}
              </select>
            ) : null}
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

  return (
    <aside className="panel cite-panel" aria-label={t("chat.ui.citationTitle")}>
      <header className="panel-head">
        <h2>{t("chat.ui.citationTitle")}</h2>
        <span className="count">{unique.length}</span>
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

