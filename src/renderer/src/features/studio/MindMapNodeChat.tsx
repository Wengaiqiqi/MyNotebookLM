import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MindMapNode } from "../../../../shared/mindmaps";
import type { MessageDto } from "../../../../shared/chat";
import { modelOutputKind, type ModelProfileDto } from "../../../../shared/models";
import { useChatStream } from "../../chat/useChatStream";
import SafeMarkdown from "../../chat/SafeMarkdown";
import ChatComposer, { type ThinkingLevel } from "../chat/ChatComposer";
import { api } from "../../lib/api";
import { errorText } from "../../lib/format";
import Icon from "../../ui/Icon";

const MODEL_KEY = "mynotebooklm.selectedGenerationProfileId";
export default function MindMapNodeChat({ projectId, insightId, node }: { projectId: string; insightId: string; node: MindMapNode }) {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState("");
  const [restored, setRestored] = useState<MessageDto[]>([]);
  const [profiles, setProfiles] = useState<ModelProfileDto[]>([]);
  const [profileId, setProfileId] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const draftKey = `mynotebooklm.nodeDraft:${insightId}:${node.id}`;
  const [question, setQuestion] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [thinking, setThinking] = useState<ThinkingLevel>(() => {
    const stored = localStorage.getItem("mynotebooklm.thinking");
    return stored === "low" || stored === "medium" || stored === "high" ? stored : "off";
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const stream = useChatStream(window.myNotebook.chat, projectId, conversationId, restored, profileId || undefined);
  useEffect(() => { if (question) localStorage.setItem(draftKey, question); else localStorage.removeItem(draftKey); }, [draftKey, question]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setLoadError("");
    void (async () => {
      const result = await api().mindmaps.conversation({ projectId, insightId, nodeId: node.id });
      if (!alive) return;
      if (!result.ok) { setLoadError(errorText(result, t)); setLoading(false); return; }
      const transcript = await window.myNotebook.conversations.listMessages({ projectId, conversationId: result.value.id });
      if (!alive) return;
      if (!transcript.ok) { setLoadError(errorText(transcript, t)); setLoading(false); return; }
      setRestored(transcript.value); setConversationId(result.value.id); setLoading(false);
    })().catch(() => { if (alive) { setLoadError(t("errors.internal")); setLoading(false); } });
    void window.myNotebook.models.listProfiles().then((result) => {
      if (!alive || !result.ok) return;
      const available = result.value.profiles.filter((profile) => profile.enabled && profile.capability === "generation" && modelOutputKind(profile) === "text");
      setProfiles(available);
      setProfileId((current) => available.some((profile) => profile.id === current) ? current : available[0]?.id ?? "");
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, insightId, node.id, reload, t]);
  useEffect(() => { if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [stream.messages]);
  const send = async (): Promise<void> => {
    if (!question.trim() || !conversationId || !stream.canSend) return;
    const draft = question.trim(); setQuestion("");
    if (!await stream.send(draft, { thinking })) setQuestion((current) => current || draft);
  };
  return <div className="mindmap-node-chat">
    <div className="mindmap-messages" ref={list} role="log" aria-label={t("mindmap.nodeChat")} onScroll={(event) => {
      const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      {loading && <div className="empty"><span className="spinner" /></div>}
      {loadError && <div className="mindmap-error" role="alert"><p>{loadError}</p><button type="button" className="btn sm" onClick={() => setReload((current) => current + 1)}>{t("common.retry")}</button></div>}
      {!loading && !loadError && stream.messages.length === 0 && <div className="empty"><Icon name="chat" /><p>{t("mindmap.chatEmpty")}</p></div>}
      {stream.messages.filter((message) => !message.superseded).map((message) => <article className={`mindmap-message ${message.role}`} key={message.id}>
        <div className={message.role === "assistant" ? "assistant-body" : ""}>
          {message.role === "assistant" ? <SafeMarkdown text={message.content.replace(/\[S\d+\]/g, "")} /> : <p>{message.content}</p>}
          {message.state === "streaming" && !message.content && <span className="typing"><i /><i /><i /></span>}
          {message.role === "assistant" && message.generation?.canContinue && message.id === stream.messages.filter((item) => item.role === "assistant" && !item.superseded).at(-1)?.id &&
            <button type="button" className="btn ghost sm" disabled={!stream.canSend} onClick={() => void stream.continueGeneration(message.id, message.generation!.revision)}><Icon name="plus" />{t("chat.ui.continueGeneration")}</button>}
        </div>
      </article>)}
      {stream.error && <div className="mindmap-error" role="alert"><p>{t(stream.error.messageKey)}</p>
        {stream.repairableMessageId && <button type="button" className="btn sm" onClick={() => void stream.repair({ thinking })}><Icon name="retry" />{t("chat.ui.regenerate")}</button>}
      </div>}
      {!loading && !profiles.length && <p className="hint">{t("errors.generationProfileMissing")}</p>}
    </div>
    <ChatComposer question={question} onQuestionChange={setQuestion} profiles={profiles} selectedProfileId={profileId}
      placeholder={t("mindmap.chatPlaceholder")} ariaLabel={t("mindmap.askNode")}
      onProfileChange={(id) => { setProfileId(id); localStorage.setItem(MODEL_KEY, id); }}
      thinking={thinking} onThinkingChange={(level) => { setThinking(level); localStorage.setItem("mynotebooklm.thinking", level); }}
      streaming={stream.state === "streaming"} canSend={stream.canSend && Boolean(conversationId && profileId)} disabled={loading || Boolean(loadError)}
      onSend={() => void send()} onStop={() => void stream.stop()} />
  </div>;
}
