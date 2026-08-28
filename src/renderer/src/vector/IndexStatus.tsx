import * as React from "react";
import { useTranslation } from "react-i18next";

export type IndexHealthState = "healthy" | "unavailable" | "corrupt" | "building" | "failed";
export type IndexHealth = Readonly<{
  status: IndexHealthState;
  spaceId?: string | undefined;
  indexedCount?: number | undefined;
  message?: string | undefined;
}>;
export type IndexTask = Readonly<{ progress: number; label?: string | undefined }>;

export default function IndexStatus({
  health,
  task,
  onConfigureModel,
  onOptimize,
  onRebuild,
  onMigrate,
  onCancel
}: Readonly<{
  health: IndexHealth;
  task?: IndexTask | undefined;
  onConfigureModel?: (() => void) | undefined;
  onOptimize?: (() => void) | undefined;
  onRebuild?: (() => void) | undefined;
  onMigrate?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}>) {
  const { t } = useTranslation();
  const running = health.status === "building";
  const hasSpace = Boolean(health.spaceId);
  const actionDisabled = running || !hasSpace;

  return (
    <section className={`index-status index-status-${health.status}`} aria-labelledby="index-status-title">
      <div className="index-status-heading">
        <div>
          <p className="eyebrow">{t("vector.eyebrow")}</p>
          <h4 id="index-status-title">{t(`vector.states.${health.status}`)}</h4>
        </div>
        {health.status === "healthy" && <span className="index-status-badge">{t("vector.healthy")}</span>}
      </div>
      <p className="index-status-copy">
        {health.status === "healthy" && t("vector.healthyBody", { count: health.indexedCount ?? 0 })}
        {health.status === "unavailable" && t("vector.unavailableBody")}
        {health.status === "corrupt" && t("vector.corruptBody")}
        {health.status === "building" && t("vector.buildingBody")}
        {health.status === "failed" && (health.message || t("vector.failedBody"))}
      </p>
      {health.status === "unavailable" && onConfigureModel && (
        <button className="outline-button" type="button" onClick={onConfigureModel}>{t("vector.configureModel")}</button>
      )}
      {running && (
        <div className="index-task-progress">
          <div className="task-progress-heading"><span>{task?.label || t("vector.building")}</span><span>{task?.progress ?? 0}‰</span></div>
          <progress max={1000} value={task?.progress ?? 0} aria-label={t("vector.progress")} />
        </div>
      )}
      {health.status === "failed" && health.spaceId && <p className="index-status-preservation">{t("vector.previousSpaceKept")}</p>}
      <div className="index-status-actions">
        {onOptimize && <button type="button" disabled={actionDisabled} onClick={onOptimize}>{t("vector.optimize")}</button>}
        {onRebuild && <button type="button" disabled={actionDisabled} onClick={onRebuild}>{t("vector.rebuild")}</button>}
        {onMigrate && <button type="button" disabled={running} onClick={onMigrate}>{t("vector.migrate")}</button>}
        {running && onCancel && <button type="button" className="danger-button" onClick={onCancel}>{t("vector.cancelTask")}</button>}
      </div>
    </section>
  );
}
