import * as React from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { IndexTask } from "./IndexStatus";

export default function SpaceMigrationDialog({
  open,
  opener,
  hasPreviousSpace = false,
  profileName,
  task,
  failed = false,
  error,
  onConfirm,
  onCancel,
  onRetry
}: Readonly<{
  open: boolean;
  opener?: HTMLElement | null;
  hasPreviousSpace?: boolean;
  profileName?: string | undefined;
  task?: IndexTask | undefined;
  failed?: boolean;
  error?: string | undefined;
  onConfirm(): void;
  onCancel(): void;
  onRetry?(): void;
}>) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const lastOpen = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && opener) openerRef.current = opener;
    if (!open && lastOpen.current) { openerRef.current?.focus(); openerRef.current = null; }
    lastOpen.current = open;
  }, [open, opener]);

  useEffect(() => {
    if (!open) return;
    (task || failed ? cancelRef.current : confirmRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
      if (event.key !== "Tab") return;
      const first = confirmRef.current || cancelRef.current;
      const last = cancelRef.current || confirmRef.current;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [failed, onCancel, open, task]);

  if (!open) return null;
  const running = Boolean(task) && !failed;
  return (
    <div className="dialog-layer" role="presentation">
      <section className="dialog-card vector-migration-dialog" role="dialog" aria-modal="true" aria-labelledby="vector-migration-title" aria-describedby="vector-migration-description">
        <div className="dialog-heading">
          <span className="warning-icon" aria-hidden="true">↻</span>
          <div>
            <h2 id="vector-migration-title">{failed ? t("vector.migrationFailed") : running ? t("vector.migrationRunning") : t("vector.migrationTitle")}</h2>
            <p id="vector-migration-description">
              {failed ? t("vector.migrationFailedBody") : running ? t("vector.migrationRunningBody") : t("vector.migrationBody", { profile: profileName ?? "" })}
            </p>
          </div>
        </div>
        {running && task && <div className="index-task-progress"><div className="task-progress-heading"><span>{t("vector.building")}</span><span>{task.progress}‰</span></div><progress max={1000} value={task.progress} aria-label={t("vector.progress")} /></div>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        {failed && hasPreviousSpace && <p className="index-status-preservation">{t("vector.previousSpaceKept")}</p>}
        <div className="dialog-actions">
          {!running && !failed && <button ref={confirmRef} className="primary-button" type="button" onClick={onConfirm}>{t("vector.migrate")}</button>}
          {failed && onRetry && <button ref={confirmRef} className="primary-button" type="button" onClick={onRetry}>{t("vector.retryMigration")}</button>}
          <button ref={cancelRef} type="button" onClick={onCancel}>{t("common.cancel")}</button>
        </div>
      </section>
    </div>
  );
}
