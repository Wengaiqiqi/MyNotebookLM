import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SourceDto } from "../../../../shared/sources";
import type { TaskDto } from "../../../../shared/tasks";
import Icon from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import { useTaskFeed } from "../../hooks/useTaskFeed";
import { cssKindClass, errorText, kindLabel, sourceReady } from "../../lib/format";
import { api } from "../../lib/api";

export default function SourcesPanel({ projectId, embeddingProfileId, onImported, onOpenSettings }: {
  projectId: string;
  embeddingProfileId?: string | undefined;
  onImported?: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [batch, setBatch] = useState<{ total: number; done: number } | undefined>();
  const [spaceBuilding, setSpaceBuilding] = useState(false);

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

  // First build of the project's embedding Space: once the migration task
  // completes, retry the imports that failed for lack of a Space.
  useEffect(() => {
    if (!spaceBuilding) return;
    const migration = tasks.find((task) => task.kind === "validation");
    if (!migration) return;
    if (migration.state === "completed") {
      setSpaceBuilding(false);
      for (const [sourceId, task] of failedTaskBySource) {
        if (task.error?.code === "INDEX_UNAVAILABLE") void retry(sourceId);
      }
      toast.success(t("vector.rebuilt"));
    } else if (migration.state === "failed" || migration.state === "cancelled") {
      setSpaceBuilding(false);
      toast.error(t("vector.failedBody"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceBuilding, tasks]);

  // Refresh when any task affecting this project settles.
  useEffect(() => {
    const settled = tasks.some((task) => task.state === "completed" || task.state === "failed" || task.state === "cancelled");
    if (settled) void refresh();
  }, [tasks, refresh]);

  // Latest task per source, for rendering progress and failures inside the
  // source's own row. Tasks whose source no longer exists are dropped.
  const taskBySource = useMemo(() => {
    const next = new Map<string, TaskDto>();
    for (const task of tasks) {
      if (!task.sourceId || !sources.some((item) => item.id === task.sourceId)) continue;
      if (!next.has(task.sourceId) || task.updatedAt >= next.get(task.sourceId)!.updatedAt) {
        next.set(task.sourceId, task);
      }
    }
    return next;
  }, [tasks, sources]);
  const activeTaskBySource = useMemo(() => {
    const next = new Map<string, TaskDto>();
    for (const [sourceId, task] of taskBySource) {
      if (task.state === "queued" || task.state === "running") next.set(sourceId, task);
    }
    return next;
  }, [taskBySource]);
  const failedTaskBySource = useMemo(() => {
    const next = new Map<string, TaskDto>();
    for (const [sourceId, task] of taskBySource) {
      if (task.state === "failed") next.set(sourceId, task);
    }
    return next;
  }, [taskBySource]);

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

  if (collapsed) {
    return (
      <aside className="panel rail rail-left" aria-label={t("research.sources")}>
        <button type="button" className="icon-btn" aria-label={t("research.expandPanel")} onClick={() => setCollapsed(false)}>
          <Icon name="chevrons-right" />
        </button>
      </aside>
    );
  }

  return (
    <section className="panel" aria-label={t("research.sources")}>
      <header className="panel-head">
        <h2>{t("research.sources")}</h2>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label={t("research.collapsePanel")} onClick={() => setCollapsed(true)}>
          <Icon name="chevrons-left" />
        </button>
        <button type="button" className="btn primary sm" onClick={() => setImportOpen(true)}>
          <Icon name="plus" />{t("research.importSources")}
        </button>
      </header>

      <div className="panel-body">
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
            const activeTask = activeTaskBySource.get(source.id);
            const failedTask = failedTaskBySource.get(source.id);
            return (
              <div className="source-item" key={source.id}>
                <div className="source-item-main">
                  <span className={`kind-badge ${cssKindClass(source.kind)}`} aria-hidden="true">
                    {source.kind === "url" ? <Icon name="globe" /> : kindLabel(source.kind)}
                  </span>
                  <span className="source-item-copy">
                    <strong title={source.displayName}>{source.displayName}</strong>
                    <small className="source-status">
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
                {activeTask && (
                  <div className="source-task" role="status">
                    <div className="source-task-row">
                      <span>{t(`research.task.${activeTask.stage}`, activeTask.stage)}</span>
                    </div>
                    <div className="progress indeterminate" aria-hidden="true"><i /></div>
                    <button type="button" className="btn ghost sm source-task-action" onClick={() => void cancel(activeTask)}>
                      {t("research.task.cancel")}
                    </button>
                  </div>
                )}
                {!activeTask && failedTask && (
                  <div className="source-task failed" role="alert">
                    <p className="source-task-error">{t(failedTask.error?.messageKey ?? "errors.internal", failedTask.error?.messageKey ?? "")}</p>
                    {failedTask.error?.recoverable && (
                      <button type="button" className="btn ghost sm source-task-action" onClick={() => void retry(source.id)}>
                        {t("research.task.retry")}
                      </button>
                    )}
                    {failedTask.error?.code === "INDEX_UNAVAILABLE" && embeddingProfileId && (
                      <button
                        type="button"
                        className="btn ghost sm source-task-action"
                        disabled={spaceBuilding}
                        onClick={async () => {
                          setSpaceBuilding(true);
                          const result = await window.myNotebook.vector.startMigration({ projectId, profileId: embeddingProfileId }).catch(() => undefined);
                          if (!result?.ok) {
                            setSpaceBuilding(false);
                            toast.error(result ? errorText(result, t) : t("errors.internal"));
                          }
                        }}
                      >
                        {spaceBuilding ? t("vector.building") : t("research.buildIndex")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {sources.length > 0 && readyCount < sources.length && activeTaskBySource.size === 0 && onOpenSettings && (
          <p style={{ margin: "10px 6px 2px", fontSize: 12, color: "var(--ink-3)" }}>
            {t("research.indexStuckHint")}
            <button type="button" className="btn ghost sm" onClick={onOpenSettings}>{t("common.openSettings")}</button>
          </p>
        )}
      </div>

      {importOpen && (
        <ImportDialog
          projectId={projectId}
          batch={batch}
          onClose={() => { setBatch(undefined); setImportOpen(false); }}
          onBatchStart={(total) => setBatch({ total, done: 0 })}
          onFileDone={() => {
            setBatch((current) => current ? { ...current, done: current.done + 1 } : current);
            void refresh();
            onImported?.();
          }}
          onBatchEnd={() => { setBatch(undefined); void refresh(); onImported?.(); }}
        />
      )}
    </section>
  );
}

function ImportDialog({ projectId, batch, onClose, onBatchStart, onFileDone, onBatchEnd }: {
  projectId: string;
  batch?: { total: number; done: number } | undefined;
  onClose: () => void;
  onBatchStart: (total: number) => void;
  onFileDone: () => void;
  onBatchEnd: () => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [urlBusy, setUrlBusy] = useState(false);
  const [error, setError] = useState("");
  const busy = fileBusy || urlBusy;

  async function importFiles(): Promise<void> {
    setFileBusy(true); setError("");
    try {
      const tokens = await api().sources.chooseFiles({ projectId });
      if (!tokens) { setFileBusy(false); return; }
      if (tokens.length > 0) onBatchStart(tokens.length);
      for (const dialogToken of tokens) {
        const result = await api().sources.importFile({ projectId, dialogToken });
        if (!result.ok) { setError(errorText(result, t)); setFileBusy(false); onBatchEnd(); return; }
        // Each finished file updates the shared counter and refreshes the
        // list, so earlier sources show their own status as soon as ready.
        onFileDone();
      }
      onBatchEnd();
      onClose();
    } catch {
      setError(t("research.importError"));
    } finally {
      setFileBusy(false);
    }
  }

  async function submitUrl(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setUrlBusy(true); setError("");
    const result = await api().sources.importUrl({ projectId, url: url.trim() }).catch(() => undefined);
    setUrlBusy(false);
    if (!result?.ok) { setError(result ? errorText(result, t) : t("research.importError")); return; }
    onBatchEnd();
    onClose();
  }

  const formats = ["PDF", "DOCX", "PPTX", "XLSX", "TXT", "MD", "CSV"];
  const batchPercent = batch ? Math.round((batch.done / batch.total) * 100) : 0;

  return (
    <Modal open onClose={onClose} labelledBy="import-dialog-title">
      <button type="button" className="dialog-close" aria-label={t("common.close")} disabled={busy} onClick={onClose}>
        <Icon name="x" />
      </button>
      <DialogHead id="import-dialog-title" icon="upload" accent title={t("research.importSources")} body={t("research.importSubtitle")} />

      <button type="button" className="dropzone" disabled={busy} onClick={() => void importFiles()}>
        <span className="dropzone-icon" aria-hidden="true"><Icon name="upload" /></span>
        <strong>{fileBusy && batch ? t("research.importProgress", { done: batch.done, total: batch.total }) : t("research.chooseFiles")}</strong>
        <span className="format-chips" aria-hidden="true">
          {formats.map((format) => <span key={format}>{format}</span>)}
        </span>
        {fileBusy && batch && (
          <span className="progress" style={{ width: "100%" }}>
            <i style={{ width: `${batchPercent}%` }} />
          </span>
        )}
      </button>

      <div className="or-divider" role="separator">
        <span /><em>{t("research.orDivider")}</em><span />
      </div>

      <form onSubmit={(event) => void submitUrl(event)}>
        <div className="input-row">
          <input
            className="input"
            type="url"
            placeholder="https://example.com/article"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label={t("research.webAddress")}
            required
            disabled={busy}
          />
          <button type="submit" className="btn primary" disabled={busy || !url.trim()}>
            {urlBusy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="globe" />}
            {t("research.importUrl")}
          </button>
        </div>
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      </form>
    </Modal>
  );
}
