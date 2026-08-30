import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { transformationPromptSchema } from "../../../../shared/transformations";
import type { BuiltinTransformationDto, InsightDto, TransformationAppliesTo, TransformationDto } from "../../../../shared/transformations";
import type { TaskDto } from "../../../../shared/tasks";
import type { ConversationDto, MessageDto } from "../../../../shared/chat";
import type { SourceDto } from "../../../../shared/sources";
import type { NoteDto } from "../../../../shared/notes";
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
  const [notes, setNotes] = useState<NoteDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");

  const [ruleKey, setRuleKey] = useState("summary");
  const [targetType, setTargetType] = useState<"source" | "note" | "message" | "answer">("source");
  const [targetId, setTargetId] = useState("");
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
    void getApi().notes.list({ projectId }).then((result) => { if (alive && result.ok) setNotes(result.value.filter((note) => !note.archivedAt)); }).catch(() => undefined);
    void window.myNotebook.conversations.list({ projectId }).then((result) => { if (alive && result.ok) setConversations(result.value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, language, loadInsights]);

  useEffect(() => {
    if (transformTask?.state === "completed") void loadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformTask?.state]);

  useEffect(() => {
    setMessages([]);
    setSelectedConversationId("");
  }, [targetType]);

  useEffect(() => {
    if (!selectedConversationId) { setMessages([]); return; }
    void window.myNotebook.conversations.listMessages({ projectId, conversationId: selectedConversationId })
      .then((result) => { if (result.ok) setMessages(result.value); })
      .catch(() => undefined);
  }, [projectId, selectedConversationId]);

  const chosenBuiltin = builtins.find((item) => item.key === ruleKey);
  const chosenRule = rules.find((item) => item.id === ruleKey);

  const readySources = useMemo(() => sources.filter(sourceReady), [sources]);

  async function run(): Promise<void> {
    const api: TransformApi = getApi().transformations;
    if (!targetId || transformTask?.state === "running" || transformTask?.state === "queued") return;
    setRunning(true);
    const target = (() => {
      if (targetType === "note") return { noteId: targetId };
      if (targetType === "message") return { messageId: targetId };
      if (targetType === "answer") return { answerMessageId: targetId };
      return chosenRule?.appliesTo === "sources"
        ? { sourceRevisionIds: [targetId] }
        : { sourceRevisionId: targetId };
    })();
    const input = chosenRule
      ? { projectId, transformationId: chosenRule.id, ...target }
      : { projectId, builtinKey: ruleKey as "summary" | "key-points" | "qa", language, ...target };
    const result = await api.run(input).catch(() => undefined);
    setRunning(false);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
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
    void getApi().notes.list({ projectId }).then((notesResult) => {
      if (notesResult.ok) setNotes(notesResult.value.filter((note) => !note.archivedAt));
    }).catch(() => undefined);
  }

  const taskPercent = transformTask ? Math.round(transformTask.progress / 10) : 0;

  return (
    <div className="pane studio">
      <section className="panel studio-run" aria-label={t("transformations.runTitle")}>
        <header className="panel-head"><h2>{t("transformations.runTitle")}</h2></header>
        <form onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <label className="field">
            {t("transformations.rule")}
            <select className="select" aria-label={t("transformations.rule")} value={ruleKey} onChange={(event) => setRuleKey(event.target.value)}>
              <optgroup label={t("transformations.builtins")}>
                {builtins.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
              </optgroup>
              {rules.length > 0 && (
                <optgroup label={t("transformations.custom")}>
                  {rules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>

          <label className="field">
            {t("transformations.target")}
            <select
              className="select"
              aria-label={t("transformations.target")}
              value={targetType}
              onChange={(event) => { setTargetType(event.target.value as typeof targetType); setTargetId(""); }}
            >
              <option value="source">{t("transformations.targetSource")}</option>
              <option value="note">{t("transformations.targetNote")}</option>
              <option value="message">{t("transformations.targetMessage")}</option>
              <option value="answer">{t("transformations.targetAnswer")}</option>
            </select>
          </label>

          {targetType === "source" && (
            <label className="field">
              {t("research.sources")}
              <select className="select" aria-label={t("transformations.pickSource")} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                <option value="">{t("transformations.pickSource")}</option>
                {readySources.map((source) => (
                  <option key={source.currentRevisionId ?? source.id} value={source.currentRevisionId ?? source.id}>
                    {source.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {targetType === "note" && (
            <label className="field">
              {t("notes.titlePage")}
              <select className="select" aria-label={t("transformations.pickNote")} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                <option value="">{t("transformations.pickNote")}</option>
                {notes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
              </select>
            </label>
          )}
          {(targetType === "message" || targetType === "answer") && (
            <>
              <label className="field">
                {t("chat.ui.conversations")}
                <select className="select" aria-label={t("transformations.pickConversation")} value={selectedConversationId} onChange={(event) => setSelectedConversationId(event.target.value)}>
                  <option value="">{t("transformations.pickConversation")}</option>
                  {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
                </select>
              </label>
              <label className="field">
                {t("transformations.pickMessage")}
                <select className="select" aria-label={t("transformations.pickMessage")} value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={!selectedConversationId}>
                  <option value="">{t("transformations.pickMessagePlaceholder")}</option>
                  {messages
                    .filter((message) => targetType === "message" ? message.role === "user" : message.role === "assistant")
                    .map((message) => (
                      <option key={message.id} value={message.id}>
                        [{message.role === "user" ? t("chat.roleUser") : t("chat.roleAssistant")}] {message.content.slice(0, 48)}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}

          <div className="run-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={!targetId || running || transformTask?.state === "running" || transformTask?.state === "queued" || (!chosenBuiltin && !chosenRule)}
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
                <span className="pct">{taskPercent}%</span>
              </div>
              <div className={`progress${transformTask.state === "failed" ? " danger" : transformTask.state === "completed" ? " ok" : ""}`}>
                <i style={{ width: `${taskPercent}%` }} />
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
                <span className="badge neutral">{rule.appliesTo}</span>
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

  const targetOptions: TransformationAppliesTo[] = ["source", "sources", "message", "answer", "note"];

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
            {targetOptions.map((option) => <option key={option} value={option}>{option}</option>)}
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
