import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskDto } from "../../../../shared/tasks";
import type { VectorHealthDto } from "../../../../shared/vector";
import Icon, { type IconName } from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";

type IndexState = "loading" | "healthy" | "unavailable" | "building" | "failed";

/**
 * Per-project vector index management: health, rebuild/optimize, and embedding
 * Space migration. Mirrors the main-process vector task lifecycle.
 */
export default function IndexPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<IndexState>("loading");
  const [health, setHealth] = useState<VectorHealthDto>();
  const [task, setTask] = useState<TaskDto>();
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  async function loadHealth(): Promise<void> {
    const result = await window.myNotebook.vector.getHealth({ projectId }).catch(() => undefined);
    if (!result?.ok) { setState("unavailable"); return; }
    setHealth(result.value);
    setState(result.value.healthy ? "healthy" : "unavailable");
  }

  useEffect(() => {
    setState("loading");
    void loadHealth();
    void window.myNotebook.models.listProfiles().then((result) => {
      if (result.ok) {
        setProfiles(result.value.profiles
          .filter((profile) => profile.enabled && profile.capability === "embedding")
          .map((profile) => ({ id: profile.id, name: profile.name })));
      }
    }).catch(() => undefined);
    const unsubscribe = window.myNotebook.vector.subscribe?.(projectId, (next) => {
      setTask(next);
      if (next.state === "completed") {
        void loadHealth();
        toast.success(t("vector.rebuilt"));
      } else if (next.state === "failed") {
        setState("failed");
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Health polling while a task runs.
  useEffect(() => {
    if (task?.state !== "running" && task?.state !== "queued") {
      window.clearInterval(pollRef.current);
      return;
    }
    pollRef.current = window.setInterval(() => void loadHealth(), 3000);
    return () => window.clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.state]);

  async function run(kind: "rebuild" | "optimize"): Promise<void> {
    if (!health?.spaceId) return;
    setBusy(true);
    const result = kind === "rebuild"
      ? await window.myNotebook.vector.rebuild({ projectId, spaceId: health.spaceId }).catch(() => undefined)
      : await window.myNotebook.vector.optimize({ projectId, spaceId: health.spaceId }).catch(() => undefined);
    setBusy(false);
    if (!result?.ok) { toast.error(t(result?.error.messageKey ?? "errors.internal")); return; }
    setTask(result.value);
    setState("building");
  }

  async function cancel(): Promise<void> {
    if (!task) return;
    const result = await window.myNotebook.vector.cancelTask({ projectId, taskId: task.id }).catch(() => undefined);
    if (!result?.ok) { toast.error(t(result?.error.messageKey ?? "errors.internal")); return; }
    setTask(result.value);
  }

  async function migrate(profileId: string): Promise<void> {
    setMigrateOpen(false);
    setBusy(true);
    const result = await window.myNotebook.vector.startMigration({ projectId, profileId }).catch(() => undefined);
    setBusy(false);
    if (!result?.ok) { toast.error(t(result?.error.messageKey ?? "errors.internal")); return; }
    setTask(result.value);
    setState("building");
  }

  const running = task?.state === "running" || task?.state === "queued";
  const effectiveState: IndexState = running ? "building" : state;
  const percent = task ? Math.round(task.progress / 10) : 0;

  const statusIcon: IconName = effectiveState === "healthy" ? "check" : effectiveState === "building" ? "database" : effectiveState === "failed" ? "alert" : "info";
  const statusLabel = effectiveState === "loading" ? t("common.loading")
    : effectiveState === "healthy" ? t("vector.states.healthy")
    : effectiveState === "building" ? t("vector.states.building")
    : effectiveState === "failed" ? t("vector.states.failed")
    : t("vector.states.unavailable");

  return (
    <div className="pref-card card">
      <div className="pref-row">
        <span className="model-card-glyph" aria-hidden="true"><Icon name={statusIcon} /></span>
        <span className="copy">
          <strong>{statusLabel}</strong>
          <small>{effectiveState === "healthy" ? t("vector.healthyBody", { count: health?.indexedCount ?? 0 }) : effectiveState === "building" ? t("vector.buildingBody") : effectiveState === "failed" ? t("vector.failedBody") : t("vector.unavailableBody")}</small>
        </span>
      </div>

      {running && (
        <div>
          <div className="row" style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
            <strong>{t(`research.task.${task?.stage ?? "indexing"}`, task?.stage ?? "")}</strong>
          </div>
          <div className="progress indeterminate"><i /></div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn outline sm" disabled={busy || running || effectiveState === "unavailable" || !health?.spaceId} onClick={() => void run("rebuild")}>
          <Icon name="retry" />{t("vector.rebuild")}
        </button>
        <button type="button" className="btn outline sm" disabled={busy || running || effectiveState === "unavailable" || !health?.spaceId} onClick={() => void run("optimize")}>
          <Icon name="sliders" />{t("vector.optimize")}
        </button>
        <button type="button" className="btn outline sm" disabled={busy || running || profiles.length === 0} onClick={() => setMigrateOpen(true)}>
          <Icon name="layers" />{t("vector.migrate")}
        </button>
        {running && <button type="button" className="btn danger-soft sm" onClick={() => void cancel()}>{t("vector.cancelTask")}</button>}
      </div>

      {migrateOpen && (
        <MigrationDialog
          open
          profiles={profiles}
          onClose={() => setMigrateOpen(false)}
          onConfirm={(profileId) => void migrate(profileId)}
        />
      )}
    </div>
  );
}

export function MigrationDialog({ open, profiles, onClose, onConfirm }: {
  open: boolean;
  profiles: Array<{ id: string; name: string }>;
  onClose: () => void;
  onConfirm: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  return (
    <Modal open onClose={onClose} labelledBy="migration-title">
      <DialogHead id="migration-title" icon="layers" accent title={t("vector.migrationTitle")} body={t("vector.migrationBody", { profile: profiles.find((profile) => profile.id === profileId)?.name ?? "" })} />
      <label className="field" htmlFor="migration-profile">
        {t("routing.chooseEmbeddingProfile")}
        <select id="migration-profile" className="select" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      <div className="dialog-foot">
        <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="btn primary" disabled={!profileId} onClick={() => onConfirm(profileId)}>
          <Icon name="layers" />{t("vector.migrate")}
        </button>
      </div>
    </Modal>
  );
}
