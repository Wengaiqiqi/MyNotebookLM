import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppErrorDto } from "../../../../shared/app-errors";
import type { CitationDto, ConversationDto, MessageDto } from "../../../../shared/chat";
import type { CitationDetailResultValue } from "../../../../shared/ipc";
import type { ModelProfileDto } from "../../../../shared/models";
import type { SourceDto } from "../../../../shared/sources";
import SafeMarkdown, { canonicalizeCitationTargets } from "../../chat/SafeMarkdown";
import { useChatStream } from "../../chat/useChatStream";
import SourcePreview from "./SourcePreview";
import Icon from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import { errorText, formatDateTime, sourceReady } from "../../lib/format";

type ConversationsApi = typeof window.myNotebook.conversations;
type ChatApi = typeof window.myNotebook.chat;
const SELECTED_MODEL_STORAGE_KEY = "mynotebooklm.selectedGenerationProfileId";

function profileDisplayName(name: string): string {
  return name.replace(/\s+\/\s+\d+$/, "").trim() || name;
}

const assistantErrorMessageKeys: Record<string, string> = {
  VALIDATION: "errors.validation",
  NOT_FOUND: "errors.notFound",
  CONFLICT: "errors.conflict",
  CANCELLED: "errors.chatCancelled",
  AUTH: "errors.authentication",
  RATE_LIMITED: "errors.rateLimited",
  TIMEOUT: "errors.timeout",
  NETWORK: "errors.network",
  PROVIDER: "errors.provider",
  UNSUPPORTED_FORMAT: "errors.unsupportedFormat",
  UNSAFE_INPUT: "errors.unsafeInput",
  INDEX_UNAVAILABLE: "errors.indexUnavailable",
  INTERNAL: "errors.internal",
  INTERRUPTED: "errors.interrupted"
};

export default function ChatPane({ projectId, generationProfileId, sources, onOpenSettings, onOpenModelSettings, onImport }: {
  projectId: string;
  generationProfileId?: string | undefined;
  sources: SourceDto[];
  onOpenSettings: () => void;
  /** Opens the advanced editor for the profile that produced an answer. */
  onOpenModelSettings: (profileId: string | null) => void;
  onImport: () => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [restored, setRestored] = useState<MessageDto[]>([]);
  const [profiles, setProfiles] = useState<ModelProfileDto[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState(() =>
    localStorage.getItem(SELECTED_MODEL_STORAGE_KEY) ?? generationProfileId ?? ""
  );
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinking, setThinking] = useState<"off" | "low" | "medium" | "high">(() => {
    const stored = localStorage.getItem("mynotebooklm.thinking");
    return stored === "low" || stored === "medium" || stored === "high" ? stored : "off";
  });
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [dismissedErrorIds, setDismissedErrorIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!thinkingMenuOpen) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest(".thinking-picker")) setThinkingMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [thinkingMenuOpen]);
  const [question, setQuestion] = useState("");
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [activeCitation, setActiveCitation] = useState<CitationDto | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(true);
  const conversationIdRef = useRef("");

  const indexedCount = useMemo(() => sources.filter(sourceReady).length, [sources]);
  const chatAvailable = Boolean(generationProfileId) && indexedCount > 0;

  // Conversations. Runs only when the project changes: rerunning on every
  // render would wipe the optimistic new-conversation state.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
    if (!generationProfileId) { setProfiles([]); return; }
    void window.myNotebook.models.listProfiles().then((result) => {
      if (!alive || !result.ok) return;
      const nextProfiles = result.value.profiles.filter((profile) => profile.enabled && profile.capability === "generation");
      setProfiles(nextProfiles);
      if (nextProfiles.length === 0) return;
      setSelectedProfileId((current) => {
        const stored = localStorage.getItem(SELECTED_MODEL_STORAGE_KEY);
        const preferred = stored || current || generationProfileId;
        const selected = nextProfiles.some((profile) => profile.id === preferred)
          ? preferred
          : nextProfiles.find((profile) => profile.id === generationProfileId)?.id ?? nextProfiles[0]!.id;
        localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, selected);
        return selected;
      });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [generationProfileId]);

  const stream = useChatStream(window.myNotebook.chat, projectId, conversationId, restored, selectedProfileId || undefined);
  const messages = stream.messages;
  const activeGenerationProfile = profiles.find((profile) => profile.id === selectedProfileId);

  function assistantErrorInfo(message: Pick<MessageDto, "errorCode" | "provider" | "model" | "profileId" | "generation"> | null, liveError: AppErrorDto | null): { text: string; details: string | null } {
    const code = liveError?.code ?? message?.errorCode ?? null;
    const key = liveError?.messageKey ?? message?.generation?.lastError ?? (code ? assistantErrorMessageKeys[code] : undefined) ?? "errors.providerFailure";
    const fallback = t("errors.providerFailure");
    const text = t(key, { defaultValue: fallback, limitTokens: liveError?.details?.limitTokens ?? "?", ...liveError?.details });
    const profile = message?.profileId
      ? profiles.find((candidate) => candidate.id === message.profileId) ?? activeGenerationProfile
      : activeGenerationProfile;
    const target = [profile?.name ?? message?.provider, message?.model ?? profile?.modelId]
      .filter((value): value is string => Boolean(value)).join(" / ");
    const details = [
      code ? t("chat.ui.errorCode", { code }) : null,
      target ? t("chat.ui.errorTarget", { target }) : null
    ].filter((value): value is string => Boolean(value)).join(" · ") || null;
    return { text, details };
  }

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
  useEffect(() => {
    conversationIdRef.current = conversationId;
    followRef.current = true;
    setEditingMessageId("");
  }, [conversationId]);

  function chooseThinking(level: "off" | "low" | "medium" | "high"): void {
    setThinking(level);
    localStorage.setItem("mynotebooklm.thinking", level);
    setThinkingMenuOpen(false);
  }

  function retryFailedMessage(messageId: string, retry: () => Promise<boolean>): void {
    setDismissedErrorIds((current) => new Set(current).add(messageId));
    void retry().then((accepted) => {
      if (!accepted) {
        setDismissedErrorIds((current) => {
          const next = new Set(current);
          next.delete(messageId);
          return next;
        });
      }
    }).catch(() => {
      setDismissedErrorIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    });
  }

  async function send(): Promise<void> {
    const text = question.trim();
    if (!text || !stream.canSend) return;
    let targetConversationId = conversationId;
    if (!targetConversationId) {
      const created = await window.myNotebook.conversations.create({ projectId, title: text.slice(0, 60) || t("chat.newConversation") });
      if (!created.ok) { toast.error(errorText(created, t)); return; }
      setConversations((current) => [created.value, ...current]);
      setConversationId(created.value.id);
      targetConversationId = created.value.id;
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
    // Clear once the turn has been accepted by the UI. If IPC rejects it,
    // restore the draft while the user is still viewing that conversation.
    setQuestion("");
    const sent = await stream.send(text, { thinking, conversationId: targetConversationId });
    if (!sent && conversationIdRef.current === targetConversationId) {
      setQuestion((current) => current || text);
    }
  }

  function onScroll(event: React.UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const failedAssistant = stream.repairableMessageId
    ? messages.find((message) => message.id === stream.repairableMessageId && message.state === "failed")
    : undefined;
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
                    disabled={!stream.canSend}
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

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} aria-live="polite">
        {messages.length === 0 && (
          <div className="empty" style={{ height: "100%" }}>
            <span className="glyph" aria-hidden="true"><Icon name="sparkle" /></span>
            <h3>{t("chat.emptyTitle")}</h3>
            <p>{t("chat.emptyBody")}</p>
          </div>
        )}
        {messages.map((message, index) => {
          if (message.role === "assistant" && message.state === "failed" && dismissedErrorIds.has(message.id)) return null;
          const reply = messages[index + 1];
          const canEditAndResend = message.role === "user" && reply?.role === "assistant" && reply.state === "cancelled";
          const editing = editingMessageId === message.id;
          const errorInfo = message.state === "failed"
            ? assistantErrorInfo(message, stream.repairableMessageId === message.id ? stream.error : null)
            : null;
          return message.role === "user"
            ? (
              <article className={`msg user${editing ? " editing" : ""}`} key={message.id}>
                <div className={`bubble${editing ? " editing" : ""}`}>
                  {editing
                    ? <textarea autoFocus aria-label={t("chat.ui.editAndResend")} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} />
                    : message.content}
                </div>
                {canEditAndResend && (
                  <div className="meta">
                    {editing ? (
                      <>
                        <button type="button" onClick={() => setEditingMessageId("")}>{t("common.cancel")}</button>
                        <button type="button" disabled={!stream.canSend || !editDraft.trim()} onClick={() => {
                          const text = editDraft.trim();
                          if (!text) return;
                          setEditingMessageId("");
                          void stream.regenerate(reply.id, { thinking, question: text });
                        }}><Icon name="send" />{t("chat.ui.send")}</button>
                      </>
                    ) : (
                      <button type="button" disabled={!stream.canSend} title={t("chat.retryBusyHint")} onClick={() => {
                        setEditDraft(message.content);
                        setEditingMessageId(message.id);
                      }}>
                        <Icon name="edit" />{t("chat.ui.editAndResend")}
                      </button>
                    )}
                  </div>
                )}
              </article>
            )
            : (
              <article className={`msg assistant is-${message.state}`} key={message.id}>
                <div className="bubble assistant-body">
                  {message.state === "failed" ? (
                    <>
                      {message.content && <SafeMarkdown text={message.content} citations={message.citations} onCitationOpen={(citation: CitationDto) => setActiveCitation(citation)} />}
                      {errorInfo && <AssistantError
                        message={errorInfo.text}
                        details={errorInfo.details}
                        disabled={!stream.canSend}
                        onRetry={() => retryFailedMessage(message.id, () => stream.repairableMessageId === message.id ? stream.repair({ thinking }) : stream.regenerate(message.id, { thinking }))}
                      />}
                    </>
                  ) : message.state === "streaming" && !message.content
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
                    {message.state === "failed" && (message.generation?.finishKind === "length" || message.errorCode === "VALIDATION") && (
                      <button type="button" className="btn ghost sm" onClick={() => onOpenModelSettings(message.profileId)}>
                        <Icon name="settings" />{t("chat.ui.openModelSettings", { defaultValue: "模型设置" })}
                      </button>
                    )}
                    {message.state === "completed" && (
                      <>
                        {message.generation?.finishKind === "length" && (
                          <span className="chat-note" role="status">
                            {message.generation.outputTokenLimit === null
                              ? t("chat.ui.outputLimitUnknown")
                              : t("chat.ui.outputLimitReached", { limitTokens: message.generation.outputTokenLimit })}
                          </span>
                        )}
                        {message.generation?.status === "interrupted" && (
                          <span className="chat-note" role="status">{t("chat.ui.continuationInterrupted")}</span>
                        )}
                        {message.generation?.status === "interrupted" && message.generation.lastError && (
                          <span className="chat-note" role="status">{t(message.generation.lastError, { limitTokens: stream.error?.details?.limitTokens ?? "?" })}</span>
                        )}
                        {message.generation?.canContinue && latestAssistant?.id === message.id && (
                          <button type="button" disabled={!stream.canSend} title={t("chat.retryBusyHint")} onClick={() => void stream.continueGeneration(message.id, message.generation!.revision)}>
                            <Icon name="send" />{t("chat.ui.continueGeneration")}
                          </button>
                        )}
                        {(message.generation?.finishKind === "length" || message.generation?.finishKind === "context-limit" || message.generation?.status === "interrupted") && (
                          <button type="button" className="btn ghost sm" onClick={() => onOpenModelSettings(message.profileId)}>
                            <Icon name="settings" />{t("chat.ui.openModelSettings", { defaultValue: "模型设置" })}
                          </button>
                        )}
                        {message.generation?.finishKind === "context-limit" && (
                          <span className="chat-note" role="status">{t("errors.contextBudgetExceeded")}</span>
                        )}
                        <button type="button" onClick={() => { void navigator.clipboard?.writeText(message.content); toast.success(t("chat.copied")); }}>
                          <Icon name="copy" />{t("chat.ui.copy")}
                        </button>
                        <button type="button" disabled={!stream.canSend} title={t("chat.retryBusyHint")} onClick={() => void stream.regenerate(message.id, { thinking })}>
                          <Icon name="retry" />{t("chat.ui.regenerate")}
                        </button>
                      </>
                    )}
                    {message.state === "cancelled" && (
                      <button type="button" disabled={!stream.canSend} title={t("chat.retryBusyHint")} onClick={() => void stream.regenerate(message.id, { thinking })}>
                        <Icon name="retry" />{t("chat.ui.regenerate")}
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
        })}
        {stream.error && !failedAssistant && (
          <article className="msg assistant is-failed" key={`error-${stream.error.code}-${stream.error.messageKey}`}>
            <div className="bubble assistant-body">
              {(() => {
                const errorInfo = assistantErrorInfo(null, stream.error);
                return <AssistantError
                  message={errorInfo.text}
                  details={errorInfo.details}
                  disabled={!stream.canSend}
                  {...(stream.repairableMessageId ? { onRetry: () => retryFailedMessage(stream.repairableMessageId!, () => stream.repair({ thinking })) } : {})}
                />;
              })()}
            </div>
          </article>
        )}
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
            <div className="model-picker thinking-picker">
              <button
                type="button"
                className="model-pill"
                aria-haspopup="menu"
                aria-expanded={thinkingMenuOpen}
                title={t("chat.thinkingHint")}
                onClick={() => setThinkingMenuOpen((value) => !value)}
              >
                <Icon name="brain" />
                <span className="model-pill-name">{t(`chat.thinkingLevel.${thinking}`)}</span>
                <Icon name={thinkingMenuOpen ? "chevron-up" : "chevron-down"} className="conv-caret" />
              </button>
              {thinkingMenuOpen && (
                <div className="model-menu" role="menu" aria-label={t("chat.thinking")}>
                  {([["off", "chat.thinkingLevel.off"], ["low", "chat.thinkingLevel.low"], ["medium", "chat.thinkingLevel.medium"], ["high", "chat.thinkingLevel.high"]] as const).map(([level, labelKey]) => (
                    <button
                      key={level}
                      type="button"
                      role="menuitem"
                      className={`model-option${thinking === level ? " selected" : ""}`}
                      onClick={() => chooseThinking(level)}
                    >
                      <span className="model-option-copy"><strong>{t(labelKey)}</strong></span>
                      {thinking === level && <Icon name="check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                        onClick={() => {
                          setSelectedProfileId(profile.id);
                          localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, profile.id);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="model-option-copy">
                          <strong>{profile.modelId}</strong>
                          <small>{profileDisplayName(profile.name)}</small>
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

function AssistantError({ message, details, disabled, onRetry }: {
  message: string;
  details?: string | null;
  disabled: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="assistant-error" role="alert">
      <p>{message}</p>
      {details && <small className="assistant-error-details">{details}</small>}
      {onRetry && (
        <button type="button" className="assistant-retry" disabled={disabled} onClick={onRetry}>
          <Icon name="retry" />{t("chat.ui.retryAnswer")}
        </button>
      )}
    </div>
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
  const [detail, setDetail] = useState<{
    citation: CitationDto;
    value: CitationDetailResultValue | null | undefined;
  } | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const unique = useMemo(() => canonicalizeCitationTargets(citations).unique, [citations]);

  async function showDetail(citation: CitationDto): Promise<void> {
    setDetail({ citation, value: undefined });
    try {
      const result = await window.myNotebook.citations.detail({ projectId, citationId: citation.id });
      if (!result.ok) toast.error(errorText(result, t));
      setDetail((current) => current?.citation.id === citation.id
        ? { citation, value: result.ok ? result.value : null }
        : current);
    } catch {
      toast.error(t("errors.citationDetailFailed"));
      setDetail((current) => current?.citation.id === citation.id ? { citation, value: null } : current);
    }
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
    <>
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
              </span>
            </div>
            {citation.quote && <blockquote className="cite-quote">{citation.quote}</blockquote>}
            <div className="foot">
              <button type="button" onClick={(event) => { event.stopPropagation(); void showDetail(citation); }}>
                <Icon name="open" />{t("chat.ui.viewDetails")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </aside>
    <Modal open={detail !== null} wide onClose={() => setDetail(null)} labelledBy="citation-detail-title">
      {detail && (
        <>
          <button type="button" className="dialog-close" aria-label={t("common.close")} onClick={() => setDetail(null)}>
            <Icon name="close" />
          </button>
          <DialogHead
            id="citation-detail-title"
            icon="file"
            accent
            title={t("chat.ui.sourceExcerptTitle")}
            body={detail.citation.sourceDisplayName}
          />
          <div className="citation-source">
            {detail.value === undefined
              ? <p className="citation-source-empty">{t("common.loading")}</p>
              : detail.value
                ? <SourcePreview kind={detail.value.kind} data={detail.value.data} text={detail.value.text} sheet={detail.value.sheet} images={detail.value.images} locator={detail.citation.locator} />
                : <p className="citation-source-empty">{t("chat.ui.sourceExcerptUnavailable")}</p>}
          </div>
        </>
      )}
    </Modal>
    </>
  );
}
