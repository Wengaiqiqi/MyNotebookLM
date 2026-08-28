import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import type { ConversationDto, MessageDto, CitationDto } from "../../../shared/chat";
import type { DesktopApi } from "../../../shared/ipc";
import type { DefaultModelRoutesDto, ModelProfileDto } from "../../../shared/models";
import type { SourceDto } from "../../../shared/sources";
import type { TaskDto } from "../../../shared/tasks";
import ConversationList from "./ConversationList";
import CitationPanel from "./CitationPanel";
import SafeMarkdown from "./SafeMarkdown";
import { useChatStream } from "./useChatStream";

type ConversationsApi = DesktopApi["conversations"];
type ChatApi = DesktopApi["chat"];
type ChatViewApi = { conversations: ConversationsApi; chat: ChatApi; citations: DesktopApi["citations"] };

export interface ChatViewProps {
  projectId: string;
  routes: DefaultModelRoutesDto;
  sources?: SourceDto[];
  api?: ChatViewApi;
  onOpenSettings?: () => void;
  onImportSources?: () => void;
  onRebuildIndex?: () => void;
  sourceRefreshKey?: number;
}

const fallbackApi = (): ChatViewApi => ({
  conversations: { list: async () => ({ ok: true, value: [] }), create: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), rename: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), archive: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), delete: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), listMessages: async () => ({ ok: true, value: [] }) },
  chat: { send: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), stop: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), regenerate: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }), subscribe: () => () => undefined, unsubscribe: () => undefined },
  citations: { open: async () => ({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: true } }) }
} as ChatViewApi);

function globalApi(): ChatViewApi | undefined {
  if (typeof window === "undefined" || !window.myNotebook?.conversations || !window.myNotebook.chat || !window.myNotebook.citations) return undefined;
  return { conversations: window.myNotebook.conversations, chat: window.myNotebook.chat, citations: window.myNotebook.citations };
}

function sourceReady(source: SourceDto): boolean { return source.status === "active" && source.currentRevisionState === "ready" && Boolean(source.currentRevisionId); }

function copyText(text: string): void { void navigator.clipboard?.writeText(text); }

export default function ChatView({ projectId, routes, sources: suppliedSources, api: suppliedApi, onOpenSettings, onImportSources, onRebuildIndex, sourceRefreshKey }: ChatViewProps) {
  const { t: translate } = useTranslation();
  const t = (key: string, fallback: string, options?: Record<string, string | number>) => { const value = options ? translate(key, options) : translate(key); return value === key ? fallback : value; };
  const api = useMemo(() => suppliedApi ?? globalApi(), [suppliedApi]);
  const safeApi = useMemo(() => api ?? fallbackApi(), [api]);
  const [sources, setSources] = useState<SourceDto[]>(suppliedSources ?? []);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [conversationId, setConversationId] = useState<string>("");
  const [restoredMessages, setRestoredMessages] = useState<MessageDto[]>([]);
  const [selectedCitation, setSelectedCitation] = useState<CitationDto | null>(null);
  const [question, setQuestion] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelName, setModelName] = useState(routes.generationProfileId ?? "");
  const [modelProfiles, setModelProfiles] = useState<ModelProfileDto[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState(routes.generationProfileId ?? "");
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const followMessages = useRef(true);
  const generationReady = Boolean(routes.generationProfileId);
  const indexed = sources.some(sourceReady);
  const available = generationReady && indexed;
  const stream = useChatStream(safeApi.chat, projectId, conversationId || "00000000-0000-4000-8000-000000000000", restoredMessages, selectedProfileId);

  useEffect(() => { if (suppliedSources) { setSources(suppliedSources); return; } const sourceApi = typeof window === "undefined" ? undefined : window.myNotebook?.sources; if (!sourceApi) return; void sourceApi.list({ projectId }).then(setSources).catch(() => undefined); }, [projectId, suppliedSources, sourceRefreshKey]);
  useEffect(() => { const taskApi = typeof window === "undefined" ? undefined : window.myNotebook?.tasks; if (!taskApi) return; void taskApi.list({ projectId }).then(setTasks).catch(() => undefined); }, [projectId]);
  useEffect(() => {
    if (!api) return;
    void api.conversations.list({ projectId }).then((result) => {
      if (!result.ok) { setLoadError(result.error.messageKey); return; }
      setConversations(result.value);
      if (!conversationId && result.value[0]) setConversationId(result.value[0].id);
    }).catch(() => setLoadError("errors.internal"));
  }, [projectId, api]);
  useEffect(() => {
    const routeId = routes.generationProfileId ?? "";
    setModelName(routeId); setSelectedProfileId(routeId);
    const modelsApi = typeof window === "undefined" ? undefined : window.myNotebook?.models;
    if (!routeId || !modelsApi) return;
    void modelsApi.listProfiles().then((result) => {
      if (!result.ok) return;
      const profile = [...result.value.profiles, ...result.value.builtInProfiles].find((item) => item.id === routeId);
      if (profile) setModelName(profile.modelId);
      setModelProfiles(result.value.profiles.filter((item) => item.enabled && item.capability === "generation"));
    }).catch(() => undefined);
  }, [routes.generationProfileId]);
  useEffect(() => {
    if (!api || !conversationId) { setRestoredMessages([]); return; }
    void api.conversations.listMessages({ projectId, conversationId }).then((result) => { if (result.ok) setRestoredMessages(result.value); else setLoadError(result.error.messageKey); }).catch(() => setLoadError("errors.internal"));
  }, [projectId, conversationId, api]);

  const citations = useMemo(() => stream.messages.filter((message) => message.role === "assistant").flatMap((message) => message.citations), [stream.messages]);
  const activeConversation = conversations.find((item) => item.id === conversationId);
  const displayError = stream.error?.messageKey ? t(stream.error.messageKey, stream.error.messageKey) : loadError ? t(loadError, loadError) : null;
  async function send(): Promise<void> { const text = question.trim(); if (!text || !stream.canSend || !conversationId) return; setQuestion(""); await stream.send(text); }
  function selectConversation(id: string): void { setConversationId(id); setSelectedCitation(null); }
  function onConversationsChange(next: ConversationDto[]): void { setConversations(next); if (!conversationId && next[0]) setConversationId(next[0].id); }
  useEffect(() => { const list = messageListRef.current; if (list && followMessages.current) list.scrollTop = list.scrollHeight; }, [stream.messages]);

  if (!available) return <section className="chat-unavailable" aria-label={t("chat.ui.researchChat", "Research chat")}>
    <div className="chat-repair-card"><span className="document-icon" aria-hidden="true">◎</span><h3>{t("chat.ui.unavailableTitle", "Research chat is unavailable until a source is indexed and a generation model is configured.")}</h3><p>{!indexed ? t("chat.ui.unavailableImport", "Import a source and rebuild the index after processing completes.") : t("chat.ui.unavailableModel", "Configure a generation model in settings to ask questions.")}</p><div className="chat-repair-actions">{onImportSources ? <button type="button" onClick={onImportSources}>{t("chat.ui.importSources", "Import sources")}</button> : null}{!generationReady && onOpenSettings ? <button type="button" onClick={onOpenSettings}>{t("chat.ui.openSettings", "Open settings")}</button> : null}{sources.length > 0 && onRebuildIndex ? <button type="button" onClick={onRebuildIndex}>{t("chat.ui.rebuildIndex", "Rebuild index")}</button> : null}</div></div>
  </section>;

  return <section className="chat-view" aria-label="Research chat">
    <div className="chat-source-strip" aria-label={t("chat.ui.sourceLabel", "Sources")}><div><span className="eyebrow">{t("chat.ui.sourceLabel", "Sources")}</span><strong>{sources.filter(sourceReady).length} {t("chat.ui.indexed", "indexed")}</strong></div>{sources.map((source) => <button type="button" className={`source-chip${sourceReady(source) ? " ready" : ""}`} key={source.id} onClick={() => void window.myNotebook?.sources?.open?.({ projectId, sourceId: source.id })}>{source.displayName}<small>{source.currentRevisionState === "ready" ? t("chat.ui.ready", "ready") : t("chat.ui.pending", "pending")}</small></button>)}{tasks.filter((task) => task.state === "queued" || task.state === "running").map((task) => <span className="chat-source-progress" role="status" key={task.id}>{t("chat.ui.sourceProgress", "{{stage}} · {{progress}}%", { stage: task.stage, progress: Math.round(task.progress / 10) })}</span>)}{onImportSources ? <button type="button" className="source-import-action" onClick={onImportSources}>{t("chat.ui.importSources", "Import sources")}</button> : null}</div>
    <div className="chat-session-bar"><ConversationList projectId={projectId} api={safeApi.conversations} conversations={conversations} selectedId={conversationId} onSelect={selectConversation} onConversationsChange={onConversationsChange} /></div>
    <div className="chat-layout">
      <div className="chat-transcript" aria-live="polite">
        <header className="chat-transcript-header"><div><span className="eyebrow">{t("chat.ui.research", "Research")}</span><h3>{activeConversation?.title ?? t("chat.ui.researchChat", "Research chat")}</h3></div>{displayError ? <p role="alert">{displayError}</p> : null}</header>
        {stream.fallback ? <div className="fallback-banner" role="status">{t("chat.ui.fallbackBanner", "The primary model was unavailable. The answer continued with a fallback model.")}</div> : null}
        <div className="message-list" ref={messageListRef} onScroll={(event) => { const list = event.currentTarget; followMessages.current = list.scrollHeight - list.scrollTop - list.clientHeight < 72; }}>{stream.messages.map((message) => message.role === "user" ? <article className="user-message" key={message.id}><p>{message.content}</p></article> : <article className={`assistant-message is-${message.state}`} key={message.id}><SafeMarkdown text={message.content} citations={message.citations} onCitationOpen={setSelectedCitation} />{message.state === "failed" ? <div className="assistant-message-error" role="alert"><span>{t("chat.ui.answerFailed", "Answer failed.")}</span><button type="button" onClick={() => void stream.regenerate(message.id)}>{t("chat.ui.retryAnswer", "Retry answer")}</button></div> : null}{message.state === "cancelled" ? <div className="assistant-message-error"><span>{t("chat.message.cancelled", "Stopped.")}</span><button type="button" onClick={() => void stream.regenerate(message.id)}>{t("chat.ui.regenerate", "Regenerate")}</button></div> : null}<div className="message-actions">{message.state === "completed" ? <><button type="button" onClick={() => copyText(message.content)}>{t("chat.ui.copy", "Copy")}</button><button type="button" onClick={() => void stream.regenerate(message.id)}>{t("chat.ui.regenerate", "Regenerate")}</button></> : null}</div></article>)}</div>
        <div className="chat-composer"><textarea aria-label={t("research.ask", "Ask about this project")} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={t("chat.ui.askPlaceholder", "Ask about your sources…")} disabled={!conversationId} /><div className="composer-controls">{modelProfiles.length > 0 ? <select aria-label={t("chat.ui.model", "Model")} value={selectedProfileId} onChange={(event) => { setSelectedProfileId(event.target.value); setModelName(modelProfiles.find((profile) => profile.id === event.target.value)?.modelId ?? event.target.value); }}><option value="" disabled>{t("chat.ui.noModel", "No model")}</option>{modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.modelId}</option>)}</select> : <span className="model-pill" aria-label={t("chat.ui.model", "Model")}>{modelName || t("chat.ui.noModel", "No model")}</span>}{stream.state === "streaming" ? <button type="button" onClick={() => void stream.stop()}>{t("chat.ui.stop", "Stop")}</button> : <button type="button" onClick={() => void send()} disabled={!stream.canSend || !question.trim() || !conversationId}>{t("chat.ui.send", "Send")}</button>}</div></div>
      </div>
      <CitationPanel citations={citations} selected={selectedCitation} projectId={projectId} openCitation={safeApi.citations.open} />
    </div>
  </section>;
}
