import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { transformationPromptSchema } from "../../../../shared/transformations";
import type { BuiltinTransformationDto, InsightDto, TransformationAppliesTo, TransformationDto } from "../../../../shared/transformations";
import type { ConversationDto, MessageDto } from "../../../../shared/chat";
import type { SourceDto } from "../../../../shared/sources";
import type { TaskDto } from "../../../../shared/tasks";
import Icon from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import SafeMarkdown from "../../chat/SafeMarkdown";
import QuizPanel from "./QuizPanel";
import { advancePercent, progressCeiling, progressPhase } from "./progress-motion";
import { useTaskFeed } from "../../hooks/useTaskFeed";
import { errorText, formatDateTime, sourceReady } from "../../lib/format";
import { api as getApi } from "../../lib/api";
import type { AppLanguage } from "../../i18n";

type TransformApi = ReturnType<typeof getApi>["transformations"];

function normalizeInsightMarkdown(text: string): string {
  // Marked treats **label** immediately followed by CJK text as literal
  // punctuation; an entity boundary keeps the emphasis without visible space.
  return text.replace(/\*\*([^*\n]+?)\*\*(?=[\u3400-\u9fff])/gu, "**$1**&#8203;");
}

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
  const [detailInsight, setDetailInsight] = useState<InsightDto | null>(null);
  const [submittedTasks, setSubmittedTasks] = useState<TaskDto[]>([]);

  const feedTasks = useTaskFeed(projectId, window.myNotebook.tasks?.subscribe, window.myNotebook.tasks?.list);
  const tasks = useMemo(() => [...feedTasks, ...submittedTasks.filter((submitted) => !feedTasks.some((task) => task.id === submitted.id))]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [feedTasks, submittedTasks]);
  const transformTask = tasks.find((task) => task.kind === "transformation" && (task.state === "queued" || task.state === "running"))
    ?? tasks.find((task) => task.kind === "transformation");
  const completedTransformations = tasks.filter((task) => task.kind === "transformation" && task.state === "completed")
    .map((task) => `${task.id}:${task.updatedAt}`).sort().join("|");
  const insightRequest = useRef(0);

  const loadInsights = useCallback(async () => {
    const request = ++insightRequest.current;
    const api = getApi().transformations;
    const items: InsightDto[] = [];
    for (let offset = 0; ; offset += 100) {
      const result = await api.listInsights({ projectId, limit: 100, offset }).catch(() => undefined);
      if (request !== insightRequest.current || !result?.ok) return;
      items.push(...result.value);
      if (result.value.length < 100) break;
    }
    const unique = new Map(items.map((item) => [item.id, item]));
    setInsights([...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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
    return () => { alive = false; insightRequest.current += 1; };
  }, [projectId, language, loadInsights]);

  useEffect(() => {
    if (completedTransformations) void loadInsights();
  }, [completedTransformations, loadInsights]);

  useEffect(() => {
    setSubmittedTasks((current) => current.filter((submitted) => !feedTasks.some((task) => task.id === submitted.id)));
  }, [feedTasks]);

  useEffect(() => { setSubmittedTasks([]); }, [projectId]);

  const chosenBuiltin = builtins.find((item) => item.key === ruleKey);
  const chosenRule = rules.find((item) => item.id === ruleKey);
  const ruleOptions = [
    ...builtins
      .filter((item) => item.key !== "key-points")
      .map((item) => ({ value: item.key, label: item.key === "summary" ? t("transformations.summary") : item.name })),
    ...rules
      .filter((item) => item.appliesTo !== "note" && item.appliesTo !== "sources")
      .map((item) => ({ value: item.id, label: item.name }))
  ];

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
    if (!hasSelection || running || retrying || transformTask?.state === "running" || transformTask?.state === "queued") return;
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
        ? { projectId, transformationId: chosenRule.id, force: true, ...payload }
        : { projectId, builtinKey: ruleKey as "summary" | "key-points" | "qa", language, force: true, ...payload };
      return api.run(input).catch(() => undefined);
    }));
    const started = results.flatMap((result) => result?.ok ? [result.value] : []);
    if (started.length > 0) setSubmittedTasks((current) => [...started, ...current.filter((task) => !started.some((item) => item.id === task.id))]);
    setRunning(false);
    if (results.some((result) => !result?.ok)) {
      const failure = results.find((result) => result && !result.ok);
      toast.error(failure && !failure.ok ? errorText(failure, t) : t("errors.internal"));
      return;
    }
    void loadInsights();
  }

  async function cancelTask(): Promise<void> {
    if (!transformTask) return;
    const result = await getApi().transformations.cancel({ projectId, taskId: transformTask.id });
    if (!result.ok) toast.error(errorText(result, t));
  }

  const [retrying, setRetrying] = useState(false);
  async function retryTask(): Promise<void> {
    if (transformTask?.state !== "failed" || retrying || running) return;
    setRetrying(true);
    try {
      const result = await getApi().transformations.retry({ projectId, taskId: transformTask.id });
      if (!result.ok) { toast.error(errorText(result, t)); return; }
      if (result.value.state === "failed") {
        toast.error(t(result.value.error?.messageKey ?? "errors.internal"));
        return;
      }
      setSubmittedTasks((current) => [result.value, ...current.filter((task) => task.id !== result.value.id)]);
      void loadInsights();
    } catch {
      toast.error(t("errors.internal"));
    } finally {
      setRetrying(false);
    }
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

  async function deleteInsight(insightId: string): Promise<boolean> {
    const result = await getApi().transformations.deleteInsight({ projectId, insightId });
    if (!result.ok) { toast.error(errorText(result, t)); return false; }
    setInsights((current) => current.filter((item) => item.id !== insightId));
    return true;
  }

  const starting = running && transformTask?.state !== "queued" && transformTask?.state !== "running";
  const taskState = starting ? "queued" : transformTask?.state;
  const reportedPercent = starting ? 0 : transformTask ? (transformTask.state === "completed" ? 100 : Math.round(transformTask.progress / 10)) : 0;
  const ceiling = progressCeiling(reportedPercent);
  const taskKey = `${transformTask?.id ?? ""}:${transformTask?.attempt ?? 0}`;
  const [displayedPercent, setDisplayedPercent] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const displayedRef = useRef(0);
  // Wall-clock start of the current run; a ref so milestone updates do not
  // restart the clock (and the 4s "preparing" dwell) mid-run.
  const runStartedAt = useRef(Date.now());
  const previousState = useRef<TaskDto["state"] | undefined>(undefined);
  const runKey = useRef<string>("");

  // A completed card must paint 100% on its first frame, so the value shown is
  // clamped up rather than waiting for the reset effect below.
  const shownPercent = taskState === "completed" ? 100 : displayedPercent;

  // One effect owns the whole animation:
  //   completed -> snap to 100 (the result is persisted)
  //   a fresh or retried run -> start over at 0
  //   queued / failed / cancelled -> freeze the last shown value
  //   running -> climb toward the reported ceiling, so the bar moves
  //              continuously instead of stepping at milestone boundaries
  useEffect(() => {
    const previous = previousState.current;
    previousState.current = taskState;
    if (taskState === "completed") {
      displayedRef.current = 100;
      setDisplayedPercent(100);
      return;
    }
    if (taskState !== "running") return; // failed/cancelled freeze
    if (previous !== "running" || runKey.current !== taskKey) {
      runKey.current = taskKey;
      runStartedAt.current = Date.now();
      displayedRef.current = 0;
      setDisplayedPercent(0);
      setElapsedSeconds(0);
    }
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      const elapsed = now - runStartedAt.current;
      const next = advancePercent(displayedRef.current, ceiling, delta);
      if (next !== displayedRef.current) {
        displayedRef.current = next;
        setDisplayedPercent(next);
      }
      setElapsedSeconds(Math.floor(elapsed / 1000));
    }, 100);
    return () => clearInterval(timer);
  }, [taskState, taskKey, ceiling]);

  const taskPercent = Math.round(shownPercent);
  // The label is driven by the animated number, so "preparing" stays readable
  // for the full 4s climb to 20% instead of flipping the instant inputs are ready.
  const taskLabel = taskState === "running"
    ? t(`transformations.phases.${progressPhase(shownPercent, reportedPercent)}`)
    : t(`transformations.states.${taskState}`, taskState ?? "");
  // A sliver keeps the bar visible while the first milestone is still pending.
  const taskBarPercent = taskState === "running" || taskState === "queued" ? Math.max(taskPercent, 3) : taskPercent;

  return (
    <div className="pane studio">
      <section className="panel studio-run" aria-label={t("transformations.runTitle")}>
        <header className="panel-head"><h2>{t("transformations.runTitle")}</h2></header>
        <form onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <label className="field">
            {t("transformations.rule")}
            <RuleSelect
              value={ruleKey}
              options={ruleOptions}
              ariaLabel={t("transformations.rule")}
              onChange={setRuleKey}
              footer={<button type="button" className="rounded-select-option rule-create" onClick={() => setEditorRule(null)}><Icon name="plus" />{t("transformations.newRule")}</button>}
            />
          </label>
          {chosenRule && <div className="run-actions">
            <button type="button" className="btn ghost sm" onClick={() => setEditorRule(chosenRule)}><Icon name="edit" />{t("transformations.editRule")}</button>
            <button type="button" className="btn ghost sm danger" onClick={() => void deleteRule(chosenRule)}><Icon name="trash" />{t("common.delete")}</button>
          </div>}

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
              disabled={Object.values(targetSelections).every((ids) => ids.length === 0) || running || retrying || transformTask?.state === "running" || transformTask?.state === "queued" || (!chosenBuiltin && !chosenRule)}
            >
              {running ? <span className="spinner light" aria-hidden="true" /> : <Icon name="sparkle" />}
              {t("transformations.run")}
            </button>
            {transformTask?.state === "failed" && (
              <button type="button" className="btn" disabled={retrying || running} onClick={() => void retryTask()}>
                {retrying ? <span className="spinner light" aria-hidden="true" /> : <Icon name="retry" />}
                {t("transformations.retry")}
              </button>
            )}
            {(transformTask?.state === "running" || transformTask?.state === "queued") && (
              <button type="button" className="btn" onClick={() => void cancelTask()}>{t("common.cancel")}</button>
            )}
          </div>

          {taskState && (
            <div className={`task-card is-${taskState}`} role="status">
              <div className="task-card-header">
                <div className="task-card-status">
                  <span className={`task-status-icon ${taskState}`}>
                    {taskState === "completed" ? (
                      <Icon name="check" />
                    ) : taskState === "failed" ? (
                      <Icon name="close" />
                    ) : (
                      <span className="spinner sm" />
                    )}
                  </span>
                  <strong>{taskLabel}</strong>
                </div>
                <span className="task-card-meta">
                  {elapsedSeconds > 0 && <span className="task-card-elapsed">{t("transformations.elapsed", { seconds: elapsedSeconds })}</span>}
                  <span className="task-card-percent">{taskPercent}%</span>
                </span>
              </div>
              <div
                className={`progress${
                  taskState === "failed"
                    ? " danger"
                    : taskState === "completed"
                    ? " ok"
                    : taskState === "running" || taskState === "queued"
                    ? " running"
                    : ""
                }`}
              >
                <i style={{ width: `${taskBarPercent}%` }} />
              </div>
              {!starting && transformTask?.error && (
                <p className="err" role="alert">
                  {t(transformTask.error.messageKey, transformTask.error.messageKey)}
                </p>
              )}
            </div>
          )}
        </form>
      </section>

      <section className="panel studio-insights" aria-label={t("transformations.insights")}>
        <header className="panel-head">
          <h2>{t("transformations.insights")}</h2>
          <span className="count">{insights.filter((item) => item.builtinKey !== "qa").length}</span>
        </header>
        <div className="panel-body">
          {insights.filter((item) => item.builtinKey !== "qa").length === 0 ? (
            <div className="empty" style={{ padding: "26px 12px" }}>
              <span className="glyph" aria-hidden="true"><Icon name="sparkle" /></span>
              <p>{t("transformations.noInsights")}</p>
            </div>
          ) : insights.filter((item) => item.builtinKey !== "qa").map((insight) => (
            <div className="insight-item" key={insight.id}>
              <div className="insight-item-head">
                {insight.model && <span className="badge neutral">{insight.model}</span>}
                <small style={{ color: "var(--ink-3)" }}>{formatDateTime(insight.createdAt, language)}</small>
                <span className="spacer" />
              </div>
              <p>{insight.content}</p>
              <div className="foot">
                <button type="button" className="btn ghost sm" onClick={() => setDetailInsight(insight)}>
                  <Icon name="open" />{t("transformations.viewDetails")}
                </button>
                <button type="button" className="btn ghost sm" onClick={() => void convertToNote(insight)}>
                  <Icon name="notes" />{t("transformations.convert")}
                </button>
                <button type="button" className="btn danger-soft sm" aria-label={`${t("common.delete")}: ${insight.content.split("\n")[0]?.slice(0, 32) ?? t("transformations.insights")}`} onClick={() => void deleteInsight(insight.id)}>
                  <Icon name="trash" />{t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <QuizPanel key={projectId} projectId={projectId} insights={insights.filter((item) => item.projectId === projectId)} onDelete={deleteInsight} />

      <Modal open={detailInsight !== null} wide onClose={() => setDetailInsight(null)} labelledBy="insight-detail-title">
        {detailInsight && (
          <>
            <button type="button" className="dialog-close" aria-label={t("common.close")} onClick={() => setDetailInsight(null)}>
              <Icon name="close" />
            </button>
            <DialogHead
              id="insight-detail-title"
              icon="sparkle"
              accent
              title={t("transformations.insightDetail")}
              body={[detailInsight.model, formatDateTime(detailInsight.createdAt, language)].filter(Boolean).join(" · ")}
            />
            <div className="insight-detail-content assistant-body">
              <SafeMarkdown text={normalizeInsightMarkdown(detailInsight.content)} />
            </div>
          </>
        )}
      </Modal>

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

function RuleSelect({ value, options, ariaLabel, onChange, footer }: {
  footer?: React.ReactNode;
  value: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root) {
      const rect = root.getBoundingClientRect();
      setPlacement(window.innerHeight - rect.bottom < 260 && rect.top > 260 ? "up" : "down");
    }
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="rounded-select" ref={rootRef}>
      <button
        type="button"
        className="select rounded-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-value">{selected?.label}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div className="rounded-select-menu" data-placement={placement}>
        <div role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="rounded-select-option"
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {footer && <div className="rule-select-footer" onClick={() => setOpen(false)}>{footer}</div>}
        </div>
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
        <label className="field">
          {t("transformations.appliesTo")}
          <RuleSelect
            value={appliesTo}
            options={targetOptions.map((option) => ({ value: option, label: t(`transformations.targetKinds.${option}`, option) }))}
            ariaLabel={t("transformations.appliesTo")}
            onChange={(value) => setAppliesTo(value as TransformationAppliesTo)}
          />
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
