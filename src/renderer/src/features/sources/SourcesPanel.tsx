import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SourceDto } from "../../../../shared/sources";
import type { TaskDto } from "../../../../shared/tasks";
import Icon from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import { useTaskFeed } from "../../hooks/useTaskFeed";
import { cssKindClass, errorText, formatBytes, kindLabel, sourceReady } from "../../lib/format";
import { api } from "../../lib/api";

export default function SourcesPanel({ projectId, onImported, onOpenSettings }: {
  projectId: string;
  onImported?: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const tasks = useTaskFeed(
    projectId,
    api().tasks.subscribe,
    api().tasks.list
  );

  const refresh = useCallback(async () => {
    try {
      setSources(await api().sources.list({ projectId }));
      setLoaded(true);
    } catch {
      setLoaded(true);
      toast.error(t("errors.internal"));
    }
  }, [projectId, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh when any task affecting this project settles.
  useEffect(() => {
    const settled = tasks.some((task) => task.state === "completed" || task.state === "failed" || task.state === "cancelled");
    if (settled) void refresh();
  }, [tasks, refresh]);

  const activeTasks = useMemo(() => tasks.filter((task) => task.state === "queued" || task.state === "running"), [tasks]);
  const recentFailed = useMemo(() =>
    tasks.filter((task) => task.state === "failed" && !activeTasks.some((active) => active.sourceId === task.sourceId))
      .filter((task, index, all) => all.findIndex((candidate) => candidate.sourceId === task.sourceId) === index)
      .slice(0, 3),
  [tasks, activeTasks]);

  async function remove(source: SourceDto): Promise<void> {
    const result = await api().sources.remove({ projectId, sourceId: source.id });
    if (!result.ok) { toast.error(errorText(result, t)); return; }
    setSources((current) => current.filter((item) => item.id !== source.id));
    onImported?.();
  }

  async function retry(sourceId: string): Promise<void> {
    const result = await api().sources.retry({ projectId, sourceId });
    if (!result.ok) toast.error(errorText(result, t));
  }

  async function cancel(task: TaskDto): Promise<void> {
    const result = await api().tasks.cancel({ projectId, taskId: task.id });
    if (!result.ok) toast.error(errorText(result, t));
  }

  async function open(source: SourceDto): Promise<void> {
    const result = await api().sources.open({ projectId, sourceId: source.id });
    if (!result.ok) toast.error(errorText(result, t));
  }

  const readyCount = sources.filter(sourceReady).length;

  return (
    <section className="panel" aria-label={t("research.sources")}>
      <header className="panel-head">
        <h2>{t("research.sources")}</h2>
        <span className="count">{readyCount}/{sources.length} {t("chat.ui.indexedLabel")}</span>
        <span className="spacer" />
        <button type="button" className="btn primary sm" onClick={() => setImportOpen(true)}>
          <Icon name="plus" />{t("research.importSources")}
        </button>
      </header>

      <div className="panel-body">
        {activeTasks.map((task) => (
          <TaskCard key={task.id} task={task} onCancel={() => void cancel(task)} />
        ))}
        {recentFailed.map((task) => (
          <TaskCard key={task.id} task={task}
            {...(task.error?.recoverable && task.sourceId ? { onRetry: () => void retry(task.sourceId!) } : {})}
          />
        ))}

        {!loaded ? (
          <div className="empty"><span className="spinner" aria-hidden="true" /></div>
        ) : sources.length === 0 ? (
          <div className="empty" style={{ padding: "28px 12px" }}>
            <span className="glyph" aria-hidden="true"><Icon name="upload" /></span>
            <h3>{t("research.noSourcesTitle")}</h3>
            <p>{t("research.noSourcesBody")}</p>
            <div className="actions">
              <button type="button" className="btn outline sm" onClick={() => setImportOpen(true)}>{t("research.importSources")}</button>
            </div>
          </div>
        ) : (
          sources.map((source) => {
            const ready = sourceReady(source);
            return (
              <div className="source-item" key={source.id}>
                <span className={`kind-badge ${cssKindClass(source.kind)}`} aria-hidden="true">
                  {source.kind === "url" ? <Icon name="globe" /> : kindLabel(source.kind)}
                </span>
                <span className="source-item-copy">
                  <strong title={source.displayName}>{source.displayName}</strong>
                  <small>
                    {source.sizeBytes !== undefined ? `${formatBytes(source.sizeBytes)} · ` : ""}
                    {ready
                      ? <><span className="state-dot ready" aria-hidden="true" />{t("research.indexed")}</>
                      : source.currentRevisionState === "failed"
                        ? <><span className="state-dot failed" aria-hidden="true" />{t("research.task.failed")}</>
                        : <><span className="state-dot pending" aria-hidden="true" />{t("research.pending")}</>}
                  </small>
                </span>
                <span className="row-actions">
                  <button type="button" className="icon-btn" aria-label={t("research.openSource")} onClick={() => void open(source)}>
                    <Icon name="open" />
                  </button>
                  {source.currentRevisionState === "failed" && (
                    <button type="button" className="icon-btn" aria-label={t("research.task.retry")} onClick={() => void retry(source.id)}>
                      <Icon name="retry" />
                    </button>
                  )}
                  <button type="button" className="icon-btn danger" aria-label={`${t("research.removeSource")}: ${source.displayName}`} onClick={() => void remove(source)}>
                    <Icon name="trash" />
                  </button>
                </span>
              </div>
            );
          })
        )}

        {sources.length > 0 && readyCount < sources.length && activeTasks.length === 0 && onOpenSettings && (
          <p style={{ margin: "10px 6px 2px", fontSize: 12, color: "var(--ink-3)" }}>
            {t("research.indexStuckHint")}
            <button type="button" className="btn ghost sm" onClick={onOpenSettings}>{t("common.openSettings")}</button>
          </p>
        )}
      </div>

      {importOpen && (
        <ImportDialog
          projectId={projectId}
          onClose={() => setImportOpen(false)}
          onImported={() => { void refresh(); onImported?.(); }}
        />
      )}
    </section>
  );
}

function TaskCard({ task, onCancel, onRetry }: { task: TaskDto; onCancel?: () => void; onRetry?: () => void }) {
  const { t } = useTranslation();
  const percent = Math.round(task.progress / 10);
  const running = task.state === "running" || task.state === "queued";
  return (
    <div className="task-card" role="status">
      <div className="row">
        <strong>{t(`research.task.${task.stage}`, task.stage)}</strong>
        <span className="pct">{percent}%</span>
      </div>
      <div className={`progress${task.state === "failed" ? " danger" : task.state === "completed" ? " ok" : ""}`} aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </div>
      {task.error && <p className="err" role="alert">{t(task.error.messageKey, task.error.messageKey)}</p>}
      <div className="actions">
        {running && onCancel && <button type="button" className="btn ghost sm" onClick={onCancel}>{t("research.task.cancel")}</button>}
        {task.state === "failed" && task.error?.recoverable && onRetry && <button type="button" className="btn ghost sm" onClick={onRetry}>{t("research.task.retry")}</button>}
      </div>
    </div>
  );
}

function ImportDialog({ projectId, onClose, onImported }: {
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function importFiles(): Promise<void> {
    setBusy(true); setError("");
    try {
      const tokens = await api().sources.chooseFiles({ projectId });
      if (!tokens) { setBusy(false); return; }
      for (const dialogToken of tokens) {
        const result = await api().sources.importFile({ projectId, dialogToken });
        if (!result.ok) { setError(errorText(result, t)); setBusy(false); return; }
      }
      onImported();
      onClose();
    } catch {
      setError(t("research.importError"));
    } finally {
      setBusy(false);
    }
  }

  async function submitUrl(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError("");
    const result = await api().sources.importUrl({ projectId, url: url.trim() }).catch(() => undefined);
    setBusy(false);
    if (!result?.ok) { setError(result ? errorText(result, t) : t("research.importError")); return; }
    onImported();
    onClose();
  }

  const formats = ["PDF", "DOCX", "PPTX", "XLSX", "TXT", "MD", "CSV", "URL"];

  return (
    <Modal open wide onClose={onClose} labelledBy="import-dialog-title">
      <DialogHead id="import-dialog-title" icon="upload" accent title={t("research.importSources")} body={t("research.formats")} />
      <button type="button" className="btn outline" disabled={busy} onClick={() => void importFiles()}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="file" />}
        {busy ? t("research.importing") : t("research.chooseFiles")}
      </button>
      <div className="format-chips" aria-hidden="true">
        {formats.map((format) => <span key={format}>{format}</span>)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }} aria-hidden="true" />
        <span style={{ color: "var(--ink-3)", fontSize: 12 }}>{t("research.orDivider")}</span>
        <span style={{ flex: 1, height: 1, background: "var(--line)" }} aria-hidden="true" />
      </div>
      <form onSubmit={(event) => void submitUrl(event)} style={{ display: "grid", gap: 12 }}>
        <label className="field" htmlFor="import-url-input">
          {t("research.webAddress")}
          <input
            id="import-url-input"
            className="input"
            type="url"
            placeholder="https://example.com/article"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
            disabled={busy}
          />
        </label>
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || !url.trim()}>
            {busy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="globe" />}
            {t("research.importUrl")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
