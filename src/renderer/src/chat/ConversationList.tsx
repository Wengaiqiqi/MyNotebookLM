import React, { useEffect, useState } from "react";
import type { ConversationDto } from "../../../shared/chat";
import type { DesktopApi } from "../../../shared/ipc";
import { useTranslation } from "react-i18next";
import "../i18n";

type ConversationApi = Pick<DesktopApi["conversations"], "list" | "create" | "rename" | "archive" | "delete">;

export interface ConversationListProps {
  projectId: string;
  api?: ConversationApi;
  conversations?: ConversationDto[];
  selectedId?: string;
  onSelect: (conversationId: string) => void;
  onConversationsChange?: (conversations: ConversationDto[]) => void;
}

function defaultApi(): ConversationApi | undefined {
  return typeof window === "undefined" ? undefined : window.myNotebook?.conversations;
}

export default function ConversationList({ projectId, api = defaultApi(), conversations, selectedId, onSelect, onConversationsChange }: ConversationListProps) {
  const { t: translate } = useTranslation();
  const t = (key: string, fallback: string) => { const value = translate(key); return value === key ? fallback : value; };
  const copy = { title: t("chat.ui.conversations", "Conversations"), newConversation: t("chat.ui.newConversation", "New conversation"), remove: t("chat.ui.remove", "Delete") };
  const [items, setItems] = useState<ConversationDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = (next: ConversationDto[]) => { setItems(next); onConversationsChange?.(next); };
  const refresh = async () => {
    if (!api) return;
    const result = await api.list({ projectId });
    if (result.ok) publish(result.value);
    else setError(t(result.error.messageKey, result.error.messageKey));
  };
  useEffect(() => {
    if (conversations) {
      setItems(conversations);
      return;
    }
    void refresh();
  }, [projectId, conversations]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest(".conversation-list")) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  async function create(): Promise<void> {
    if (!api) return;
    const result = await api.create({ projectId, title: copy.newConversation });
    if (!result.ok) { setError(t(result.error.messageKey, result.error.messageKey)); return; }
    publish([result.value, ...items]);
    onSelect(result.value.id);
  }
  async function remove(item: ConversationDto): Promise<void> {
    if (!api) return;
    const result = await api.delete({ projectId, conversationId: item.id });
    if (!result.ok) { setError(t(result.error.messageKey, result.error.messageKey)); return; }
    const next = items.filter((current) => current.id !== item.id);
    publish(next);
    if (selectedId === item.id) onSelect(next[0]?.id ?? "");
  }

  return <aside className="conversation-list" aria-label={copy.title}>
    <header className="conversation-list-header"><button type="button" className="conversation-dropdown-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{items.find((item) => item.id === selectedId)?.title ?? copy.title}⌄</button></header>
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    <div className={`conversation-items${open ? " open" : ""}`}>
      {items.length === 0 ? <p className="conversation-empty">{t("chat.ui.noConversations", "No conversations yet.")}</p> : items.map((item) => <div className={`conversation-item${selectedId === item.id ? " selected" : ""}`} key={item.id}>
        <button type="button" className="conversation-select" aria-current={selectedId === item.id ? "page" : undefined} onClick={() => { onSelect(item.id); setOpen(false); }}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString()}</small></button>
        <button type="button" className="conversation-delete" aria-label={`${copy.remove} ${item.title}`} onClick={() => void remove(item)}>{copy.remove}</button>
      </div>)}
      {open ? <button type="button" className="conversation-new" onClick={() => void create()}>＋ {copy.newConversation}</button> : null}
    </div>
  </aside>;
}
