import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { transformationPromptSchema } from "../../../../shared/transformations";
import type { BuiltinTransformationDto, InsightDto, TransformationAppliesTo, TransformationDto } from "../../../../shared/transformations";
import type { ConversationDto, MessageDto } from "../../../../shared/chat";
import type { SourceDto } from "../../../../shared/sources";
import Icon from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import { useTaskFeed } from "../../hooks/useTaskFeed";
import { errorText, formatDateTime, sourceReady } from "../../lib/format";
import { api as getApi } from "../../lib/api";
import type { AppLanguage } from "../../i18n";

type TransformApi = ReturnType<typeof getApi>["transformations"];

export default function StudioPane({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [builtins, setBuiltins] = useState<BuiltinTransformationDto[]>([]);
  const [rules, setRules] = useState<TransformationDto[]>([]);
  const [insights, setInsights] = useState<InsightDto[]>([]);
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);

  const [ruleKey, setRuleKey] = useState("summary");
  const [targetSelections, setTargetSelections] = useState<Record<"source" | "message" | "answer", string[]>>({ source: [], message: [], answer: [] });
  const [openMenu, setOpenMenu] = useState<"source" | "message" | "answer" | null>(null);
  const targetMenuRef = useRef<HTMLDivElement>(null);
  const [editorRule, setEditorRule] = useState<TransformationDto | null | undefined>(undefined); // undefined = closed
  const [running, setRunning] = useState(false);

  const tasks = useTaskFeed(projectId, window.myNotebook.tasks?.subscribe, window.myNotebook.tasks?.list);
  const transformTask = tasks.find((task) => task.kind === "transformation" && (task.state === "queued" || task.state === "running" || task.state === "failed"));

  const loadInsights = useCallback(async () => {
    const api = getApi().transformations;
    const result = await api.listInsights({ projectId }).catch(() => undefined);
    if (result?.ok) {
      const unique = new Map(result.value.map((item) => [item.id, item]));
      setInsights([...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    const api = getApi().transformations;
    void api.listBuiltins({ language }).then((result) => { if (alive && result.ok) setBuiltins(result.value); }).catch(() => undefined);
    void api.listRules({ projectId }).then((result) => { if (alive && result.ok) setRules(result.value); }).catch(() => undefined);
    void loadInsights();
    void getApi().sources.list({ projectId }).then((items) => { if (alive) setSources(items); }).catch(() => undefined);
    void window.myNotebook.conversations.list({ projectId }).then(async (result) => {
      if (!result.ok) return;
      const messageResults = await Promise.all(result.value.map((conversation) =>
        window.myNotebook.conversations.listMessages({ projectId, conversationId: conversation.id }).catch(() => undefined)
      ));
      if (!alive) return;
      setConversations(result.value);
      setMessages(messageResults.flatMap((item) => item?.ok ? item.value : []));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, language, loadInsights]);

  useEffect(() => {
    if (transformTask?.state === "completed") void loadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformTask?.state]);

  const chosenBuiltin = builtins.find((item) => item.key === ruleKey);
  const chosenRule = rules.find((item) => item.id === ruleKey);

  useEffect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent): void => {
      if (!targetMenuRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

  const readySources = useMemo(() => sources.filter(sourceReady), [sources]);

  async function run(): Promise<void> {
    const api: TransformApi = getApi().transformations;
    const hasSelection = Object.values(targetSelections).some((ids) => ids.length > 0);
    if (!hasSelection || transformTask?.state === "running" || transformTask?.state === "queued") return;
    setRunning(true);
    const targets: Array<Record<string, string>> = [];
    if (targetSelections.source.length > 0) targets.push({ sourceRevisionIds: targetSelections.source.join(",") });
    for (const id of targetSelections.message) targets.push({ messageId: id });
    for (const id of targetSelections.answer) targets.push({ answerMessageId: id });
    const results = await Promise.all(targets.map((target) => {
      const payload = target.sourceRevisionIds !== undefined
        ? { sourceRevisionIds: (target.sourceRevisionIds as string).split(",") }
        : target;
      const input = chosenRule
        ? { projectId, transformationId: chosenRule.id, ...payload }
        : { projectId, builtinKey: ruleKey as "summary" | "key-points" | "qa", language, ...payload };
      return api.run(input).catch(() => undefined);
    }));
    setRunning(false);
    const failed = results.filter((result) => !result?.ok).length;
    if (failed > 0) { toast.error(t("errors.internal")); return; }
    toast.info(t("transformations.started"));
  }

  async function cancelTask(): Promise<void> {
    if (!transformTask) return;
    const result = await getApi().transformations.cancel({ projectId, taskId: transformTask.id });
    if (!result.ok) toast.error(errorText(result, t));
  }

  async function retryTask(): Promise<void> {
    if (!transformTask) return;
    const result = await getApi().transformations.retry({ projectId, taskId: transformTask.id });
    if (!result.ok) toast.error(errorText(result, t));
  }

  async function deleteRule(rule: TransformationDto): Promise<void> {
    const result = await getApi().transformations.deleteRule({ projectId, id: rule.id, version: rule.version });
    if (!result.ok) { toast.error(errorText(result, t)); return; }
    setRules((current) => current.filter((item) => item.id !== rule.id));
    if (ruleKey === rule.id) setRuleKey("summary");
  }

  async function convertToNote(insight: InsightDto): Promise<void> {
    const result = await getApi().transformations.convertToNote({ projectId, insightId: insight.id });
    if (!result.ok) { toast.error(errorText(result, t)); return; }
    toast.success(t("transformations.converted"));
  }

  const taskPercent = transformTask ? Math.round(transformTask.progress / 10) : 0;

  return (
    <div className="pane studio">
      <section className="panel studio-run" aria-label={t("transformations.runTitle")}>
        <header className="panel-head"><h2>{t("transformations.runTitle")}</h2></header>
        <form onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <label className="field">
            {t("transformations.rule")}
            <select className="select" aria-label={t("transformations.rule")} value={ruleKey} onChange={(event) => {
              const nextKey = event.target.value;
              setRuleKey(nextKey);
            }}>
              {builtins.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
              {rules.some((item) => item.appliesTo !== "note" && item.appliesTo !== "sources") && (
                <optgroup label={t("transformations.custom")}>
                  {rules.filter((item) => item.appliesTo !== "note" && item.appliesTo !== "sources").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>

          <div className="studio-target-picker">
            {(["source", "message", "answer"] as const).map((kind) => {
              const label = kind === "source" ? t("transformations.targetSource") : kind === "message" ? t("transformations.targetMessage") : t("transformations.targetAnswer");
              const disabled = false;
              const selection = targetSelections[kind];
              return <div className="studio-target-row" key={kind}>
                <span className="kind-tag">{label}</span>
                <div className="target-select" ref={openMenu === kind ? targetMenuRef : undefined}>
                  <button type="button" className="select target-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={openMenu === kind} disabled={disabled} onClick={() => setOpenMenu(openMenu === kind ? null : kind)}>
                    <span className="target-select-value">{selection.length === 0
                      ? (kind === "source" ? t("transformations.pickSource") : t("transformations.pickMessagePlaceholder"))
                      : t("notes.selectedCount").replace("{count}", String(selection.length))}</span>
                    <Icon name={openMenu === kind ? "chevron-up" : "chevron-down"} className="conv-caret" />
                  </button>
                  {openMenu === kind && (
                    <div className="target-select-menu" role="listbox" aria-label={label} aria-multiselectable="true">
                      {(kind === "source" ? readySources.map((source) => ({ value: source.currentRevisionId ?? source.id, text: source.displayName })) : messages.filter((message) => message.state === "completed" && !message.superseded && message.content.trim() && (kind === "message" ? message.role === "user" : message.role === "assistant")).map((message) => ({ value: message.id, text: "[" + (conversations.find((conversation) => conversation.id === message.conversationId)?.title ?? t("chat.ui.conversations")) + "] " + message.content.slice(0, 40) }))).map((item) => {
                        const checked = selection.includes(item.value);
                        return <button type="button" role="option" aria-selected={checked} className={`target-select-option${checked ? " selected" : ""}`} key={item.value} onClick={() => setTargetSelections((current) => ({ ...current, [kind]: checked ? current[kind].filter((id) => id !== item.value) : [...current[kind], item.value] }))}>
                          <input type="checkbox" readOnly checked={checked} tabIndex={-1} />
                          <span>{item.text}</span>
                        </button>;
                      })}
                    </div>
                  )}
                </div>
              </div>;
            })}
          </div>

          <div className="run-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={Object.values(targetSelections).every((ids) => ids.length === 0) || running || transformTask?.state === "running" || transformTask?.state === "queued" || (!chosenBuiltin && !chosenRule)}
            >
              {running ? <span className="spinner light" aria-hidden="true" /> : <Icon name="sparkle" />}
              {t("transformations.run")}
            </button>
            {transformTask?.state === "failed" && (
              <button type="button" className="btn" onClick={() => void retryTask()}><Icon name="retry" />{t("transformations.retry")}</button>
            )}
            {(transformTask?.state === "running" || transformTask?.state === "queued") && (
              <button type="button" className="btn" onClick={() => void cancelTask()}>{t("common.cancel")}</button>
            )}
          </div>

          {transformTask && (
            <div className="task-card" role="status">
              <div className="row">
                <strong>{t(`transformations.states.${transformTask.state}`, transformTask.state)}</strong>
              </div>
              <div className={`progress${transformTask.state === "failed" ? " danger" : transformTask.state === "completed" ? " ok" : transformTask.state === "running" || transformTask.state === "queued" ? " indeterminate" : ""}`}>
                <i style={transformTask.state === "failed" || transformTask.state === "completed" ? { width: `${taskPercent}%` } : undefined} />
              </div>
              {transformTask.error && <p className="err" role="alert">{t(transformTask.error.messageKey, transformTask.error.messageKey)}</p>}
            </div>
          )}
        </form>
      </section>

      <section className="panel studio-rules" aria-label={t("transformations.customRules")}>
        <header className="panel-head">
          <h2>{t("transformations.customRules")}</h2>
          <span className="count">{rules.length}</span>
          <span className="spacer" />
          <button type="button" className="btn primary sm" onClick={() => setEditorRule(null)}>
            <Icon name="plus" />{t("transformations.newRule")}
          </button>
        </header>
        <div className="panel-body">
          {rules.length === 0 ? (
            <div className="empty" style={{ padding: "26px 12px" }}>
              <span className="glyph" aria-hidden="true"><Icon name="sliders" /></span>
              <p>{t("transformations.noRules")}</p>
            </div>
          ) : rules.map((rule) => (
            <div className="rule-item" key={rule.id}>
              <div className="rule-item-head">
                <strong>{rule.name}</strong>
                <span className="badge neutral">{t(`transformations.targetKinds.${rule.appliesTo}`, rule.appliesTo)}</span>
                <span className="spacer" />
                <button type="button" className="icon-btn" aria-label={`${t("common.edit")}: ${rule.name}`} onClick={() => setEditorRule(rule)}>
                  <Icon name="edit" />
                </button>
                <button type="button" className="icon-btn danger" aria-label={`${t("common.delete")}: ${rule.name}`} onClick={() => void deleteRule(rule)}>
                  <Icon name="trash" />
                </button>
              </div>
              <p>{rule.prompt}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel studio-insights" aria-label={t("transformations.insights")}>
        <header className="panel-head">
          <h2>{t("transformations.insights")}</h2>
          <span className="count">{insights.length}</span>
        </header>
        <div className="panel-body">
          {insights.length === 0 ? (
            <div className="empty" style={{ padding: "26px 12px" }}>
              <span className="glyph" aria-hidden="true"><Icon name="sparkle" /></span>
              <p>{t("transformations.noInsights")}</p>
            </div>
          ) : insights.map((insight) => (
            <div className="insight-item" key={insight.id}>
              <div className="insight-item-head">
                {insight.model && <span className="badge neutral">{insight.model}</span>}
                <small style={{ color: "var(--ink-3)" }}>{formatDateTime(insight.createdAt, language)}</small>
                <span className="spacer" />
              </div>
              <p>{insight.content}</p>
              <div className="foot">
                <button type="button" className="btn ghost sm" onClick={() => void convertToNote(insight)}>
                  <Icon name="notes" />{t("transformations.convert")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {editorRule !== undefined && (
        <RuleEditor
          projectId={projectId}
          rule={editorRule ?? undefined}
          onClose={() => setEditorRule(undefined)}
          onSaved={(saved) => {
            setEditorRule(undefined);
            setRules((current) => {
              const exists = current.some((item) => item.id === saved.id);
              return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
            });
            setRuleKey(saved.id);
          }}
        />
      )}
    </div>
  );
}

function RuleEditor({ projectId, rule, onClose, onSaved }: {
  projectId: string;
  rule?: TransformationDto | undefined;
  onClose: () => void;
  onSaved: (rule: TransformationDto) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(rule?.name ?? "");
  const [appliesTo, setAppliesTo] = useState<TransformationAppliesTo>(rule?.appliesTo ?? "source");
  const [prompt, setPrompt] = useState(rule?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const promptIssue = prompt ? (() => {
    const result = transformationPromptSchema.safeParse(prompt);
    return result.success ? "" : t("transformations.invalidPrompt");
  })() : "";

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim() || promptIssue || busy) return;
    setBusy(true); setError("");
    const api: TransformApi = getApi().transformations;
    const result = rule
      ? await api.updateRule({ projectId, id: rule.id, version: rule.version, enabled: rule.enabled, name: name.trim(), appliesTo, prompt })
      : await api.createRule({ projectId, name: name.trim(), appliesTo, prompt });
    setBusy(false);
    if (!result.ok) { setError(errorText(result, t)); return; }
    onSaved(result.value);
  }

  const targetOptions: TransformationAppliesTo[] = ["source", "message", "answer"];

  return (
    <Modal open wide onClose={onClose} labelledBy="rule-editor-title">
      <DialogHead id="rule-editor-title" icon="sliders" accent title={rule ? t("transformations.editRule") : t("transformations.newRule")} />
      <form onSubmit={(event) => void submit(event)}>
        <label className="field" htmlFor="rule-name-input">
          {t("transformations.ruleName")}
          <input id="rule-name-input" className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
        </label>
        <label className="field" htmlFor="rule-target-input">
          {t("transformations.appliesTo")}
          <select id="rule-target-input" className="select" value={appliesTo} onChange={(event) => setAppliesTo(event.target.value as TransformationAppliesTo)}>
            {targetOptions.map((option) => <option key={option} value={option}>{t(`transformations.targetKinds.${option}`, option)}</option>)}
          </select>
        </label>
        <label className="field" htmlFor="rule-prompt-input">
          {t("transformations.prompt")}
          <textarea
            id="rule-prompt-input"
            className="textarea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            style={{ minHeight: 130 }}
            aria-describedby="rule-prompt-help"
          />
          <span className="hint">{t("transformations.placeholders")}: {"{{content}}"}, {"{{source_title}}"}, {"{{project_name}}"}, {"{{language}}"}</span>
        </label>
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
        {promptIssue && <p className="form-error" role="alert"><Icon name="alert" />{promptIssue}</p>}
        <div className="dialog-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || Boolean(promptIssue) || !name.trim()}>
            {busy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
