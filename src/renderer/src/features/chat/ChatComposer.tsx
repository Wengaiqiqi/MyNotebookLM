import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelProfileDto } from "../../../../shared/models";
import Icon from "../../ui/Icon";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** Shared by research chat and node chat: controls, icons and states stay identical. */
export default function ChatComposer({ question, onQuestionChange, profiles, selectedProfileId, onProfileChange, thinking, onThinkingChange, streaming, canSend, onSend, onStop, disabled = false, placeholder, ariaLabel }: {
  question: string; onQuestionChange: (question: string) => void;
  profiles: ModelProfileDto[]; selectedProfileId: string; onProfileChange: (id: string) => void;
  thinking: ThinkingLevel; onThinkingChange: (level: ThinkingLevel) => void;
  streaming: boolean; canSend: boolean; onSend: () => void; onStop: () => void; disabled?: boolean;
  placeholder?: string; ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<"model" | "thinking" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!area.current) return;
    area.current.style.height = "auto";
    area.current.style.height = `${Math.min(area.current.scrollHeight, 132)}px`;
  }, [question]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent): void => { if (event.target instanceof Node && !toolbar.current?.contains(event.target)) setMenu(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const toggle = (value: "model" | "thinking"): void => setMenu((current) => current === value ? null : value);
  return <div className="composer-wrap"><div className="composer">
    <textarea ref={area} value={question} rows={1} disabled={disabled} onChange={(event) => onQuestionChange(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (question.trim() && canSend && !disabled) onSend(); } }}
      placeholder={placeholder ?? t("chat.ui.askPlaceholder")} aria-label={ariaLabel ?? t("research.ask")} />
    <div className="composer-bar" ref={toolbar}>
      <div className="model-picker thinking-picker">
        <button type="button" className="model-pill" aria-haspopup="menu" aria-expanded={menu === "thinking"} title={t("chat.thinkingHint")} onClick={() => toggle("thinking")}>
          <Icon name="brain" /><span className="model-pill-name">{t(`chat.thinkingLevel.${thinking}`)}</span><Icon name={menu === "thinking" ? "chevron-up" : "chevron-down"} className="conv-caret" />
        </button>
        {menu === "thinking" && <div className="model-menu" role="menu" aria-label={t("chat.thinking")}>
          {(["off", "low", "medium", "high"] as const).map((level) => <button type="button" role="menuitem" key={level} className={`model-option${thinking === level ? " selected" : ""}`} onClick={() => { onThinkingChange(level); setMenu(null); }}>
            <span className="model-option-copy"><strong>{t(`chat.thinkingLevel.${level}`)}</strong></span>{thinking === level && <Icon name="check" />}
          </button>)}
        </div>}
      </div>
      {profiles.length > 0 && <div className="model-picker">
        <button type="button" className="model-pill" aria-haspopup="menu" aria-expanded={menu === "model"} aria-label={t("chat.ui.model")} onClick={() => toggle("model")}>
          <span className="model-pill-name">{profiles.find((profile) => profile.id === selectedProfileId)?.modelId ?? t("chat.ui.noModel")}</span><Icon name={menu === "model" ? "chevron-up" : "chevron-down"} className="conv-caret" />
        </button>
        {menu === "model" && <div className="model-menu" role="menu" aria-label={t("chat.ui.model")}>
          {profiles.map((profile) => <button type="button" role="menuitem" className={`model-option${profile.id === selectedProfileId ? " selected" : ""}`} key={profile.id} onClick={() => { onProfileChange(profile.id); setMenu(null); }}>
            <span className="model-option-copy"><strong>{profile.modelId}</strong><small>{profile.name.replace(/\s+\/\s+\d+$/, "").trim() || profile.name}</small></span>{profile.id === selectedProfileId && <Icon name="check" />}
          </button>)}
        </div>}
      </div>}
      <span className="spacer" /><span className="kbd" aria-hidden="true">Enter</span>
      {streaming ? <button type="button" className="send-btn stop" aria-label={t("chat.ui.stop")} onClick={onStop}><Icon name="stop" /></button>
        : <button type="button" className="send-btn" aria-label={t("chat.ui.send")} disabled={disabled || !question.trim() || !canSend} onClick={onSend}><Icon name="send" /></button>}
    </div>
  </div></div>;
}
