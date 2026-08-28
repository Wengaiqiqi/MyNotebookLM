import React, { useEffect, useRef, useState } from "react";
import type { TaskDto, TaskStage } from "../../../shared/tasks";

export type TaskProgressLabels = {
  cancel: string; retry: string; remove: string; completed: string; failed: string; queued: string; running: string; cancelled: string;
  openSettings?: string;
} & Partial<Record<TaskStage, string>>;

export default function TaskProgress({ task, labels, errorMessages, onCancel, onRetry, onDelete, onOpenSettings }: { task: TaskDto; labels: TaskProgressLabels; errorMessages?: Record<string, string>; onCancel: () => void; onRetry: () => void; onDelete: () => void; onOpenSettings?: (() => void) | undefined }) {
  const percent = Math.max(0, Math.min(100, Math.round(task.progress / 10)));
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncement = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const update = () => { lastAnnouncement.current = Date.now(); setAnnouncement(`${labels[task.stage] ?? task.stage} ${percent}%`); };
    if (now - lastAnnouncement.current >= 1000) update();
    else { const timer = window.setTimeout(update, 1000 - (now - lastAnnouncement.current)); return () => window.clearTimeout(timer); }
  }, [labels, percent, task.stage]);
  const stateLabel = labels[task.state] ?? task.state;
  return <article className="task-progress" aria-label={`${stateLabel}: ${labels[task.stage] ?? task.stage}`}>
    <div className="task-progress-heading"><strong>{labels[task.stage] ?? task.stage}</strong><span>{percent}%</span></div>
    <progress max={100} value={percent} aria-label={labels[task.stage] ?? task.stage} />
    <div className="task-progress-status" role="status">{stateLabel}</div>
    {task.error && <p className="task-error" role="alert">{errorMessages?.[task.error.messageKey] ?? task.error.messageKey}</p>}
    <div className="task-actions">
      {task.state === "running" || task.state === "queued" ? <button type="button" onClick={onCancel}>{labels.cancel}</button> : null}
      {task.state === "failed" && task.error?.recoverable ? <button type="button" onClick={onRetry}>{labels.retry}</button> : null}
      {task.state === "failed" && onOpenSettings ? <button type="button" onClick={onOpenSettings}>{labels.openSettings ?? "Open settings"}</button> : null}
      {task.state === "failed" || task.state === "cancelled" || task.state === "completed" ? <button type="button" onClick={onDelete}>{labels.remove}</button> : null}
    </div>
    <span className="sr-only" aria-live="polite">{announcement}</span>
  </article>;
}
