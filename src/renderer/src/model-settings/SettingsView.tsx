import * as React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelConfigurationForms, persistModelConfiguration, type ModelSettingsData } from "./FirstLaunch";
import type { ModelProfileDraft } from "./ModelProfileForm";
import { modelErrorText } from "./model-error-text";
import IndexStatus, { type IndexHealth, type IndexTask } from "../vector/IndexStatus";
import SpaceMigrationDialog from "../vector/SpaceMigrationDialog";
import type { TaskDto } from "../../../shared/tasks";
import RouteSettings from "./RouteSettings";

export default function SettingsView({
  data,
  projectId,
  onCancel,
  onSaved
}: Readonly<{
  data: ModelSettingsData;
  projectId?: string | undefined;
  onCancel(): void;
  onSaved(): Promise<string | undefined> | string | undefined;
}>) {
  const { t } = useTranslation();
  const [generation, setGeneration] = useState<ModelProfileDraft>();
  const [embedding, setEmbedding] = useState<ModelProfileDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState<"models" | "index">("models");
  const [indexHealth, setIndexHealth] = useState<IndexHealth>({ status: "unavailable" });
  const [indexTask, setIndexTask] = useState<(IndexTask & { id: string; state: TaskDto["state"] }) | undefined>();
  const [migrationOpen, setMigrationOpen] = useState(false);
  const migrationOpener = React.useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    if (!projectId) return () => { alive = false; };
    const api = window.myNotebook.vector;
    const loadHealth = async () => {
      const result = await Promise.resolve(api.getHealth({ projectId })).catch(() => undefined);
      if (!alive) return;
      if (!result) { setIndexHealth({ status: "unavailable", message: t("errors.indexUnavailable") }); return; }
      if (result.ok) setIndexHealth({ status: result.value.healthy ? "healthy" : "corrupt", spaceId: result.value.spaceId, indexedCount: result.value.indexedCount });
      else setIndexHealth({ status: result.error.code === "INDEX_UNAVAILABLE" || result.error.code === "NOT_FOUND" ? "unavailable" : "failed", message: t(result.error.messageKey) });
    };
    const hydrate = async () => {
      await loadHealth();
      const tasks = await Promise.resolve(window.myNotebook.tasks?.list({ projectId })).catch(() => undefined);
      if (!alive || !tasks) return;
      const active = tasks.find((task) => task.sourceId === null && (task.kind === "validation" || task.kind === "optimize") && (task.state === "queued" || task.state === "running" || task.state === "failed"));
      if (!active) return;
      setIndexTask({ id: active.id, state: active.state, progress: active.progress, label: active.stage });
      setIndexHealth((current) => ({ ...current, status: active.state === "failed" ? "failed" : "building", message: active.error ? t(active.error.messageKey) : current.message }));
    };
    void hydrate();
    const unsubscribe = api.subscribe(projectId, (task) => {
      if (!alive || task.kind !== "validation" && task.kind !== "optimize") return;
      const running = task.state === "queued" || task.state === "running";
      if (running) {
        setIndexTask({ id: task.id, state: task.state, progress: task.progress, label: task.stage });
        setIndexHealth((current) => ({ ...current, status: "building" }));
      } else if (task.state === "failed") {
        setIndexTask({ id: task.id, state: task.state, progress: task.progress, label: task.stage });
        setIndexHealth((current) => ({ ...current, status: "failed", message: task.error ? t(task.error.messageKey) : undefined }));
      } else {
        setIndexTask(undefined);
        void loadHealth();
        setMigrationOpen(false);
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, [projectId, t]);

  function setTask(task: TaskDto): void {
    setIndexTask({ id: task.id, state: task.state, progress: task.progress, label: task.stage });
    setIndexHealth((current) => ({ ...current, status: "building" }));
  }

  async function startIndexTask(action: "rebuild" | "optimize"): Promise<void> {
    if (!projectId || !indexHealth.spaceId || indexTask) return;
    const result = await Promise.resolve(window.myNotebook.vector[action]({ projectId, spaceId: indexHealth.spaceId })).catch(() => undefined);
    if (!result) { setIndexHealth((current) => ({ ...current, status: "failed", message: t("errors.indexUnavailable") })); return; }
    if (result.ok) setTask(result.value);
    else setIndexHealth((current) => ({ ...current, status: "failed", message: t(result.error.messageKey) }));
  }

  async function confirmMigration(force = false): Promise<void> {
    if (!projectId || (indexTask && !force)) return;
    const profileId = data.routes.embeddingProfileId;
    if (!profileId) {
      setMigrationOpen(false);
      setSection("models");
      return;
    }
    const result = await Promise.resolve(window.myNotebook.vector.startMigration({ projectId, profileId })).catch(() => undefined);
    if (!result) { setIndexHealth((current) => ({ ...current, status: "failed", message: t("errors.indexUnavailable") })); return; }
    if (result.ok) setTask(result.value);
    else setIndexHealth((current) => ({ ...current, status: "failed", message: t(result.error.messageKey) }));
  }

  async function cancelIndexTask(): Promise<void> {
    if (!projectId || !indexTask) return;
    const result = await Promise.resolve(window.myNotebook.vector.cancelTask({ projectId, taskId: indexTask.id })).catch(() => undefined);
    if (!result) { setIndexHealth((current) => ({ ...current, status: "failed", message: t("errors.indexUnavailable") })); return; }
    if (!result.ok) {
      setIndexHealth((current) => ({ ...current, status: "failed", message: t(result.error.messageKey) }));
      return;
    }
    setIndexTask(undefined);
    setMigrationOpen(false);
    setIndexHealth((current) => ({ ...current, status: current.spaceId ? "healthy" : "unavailable" }));
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await persistModelConfiguration({ generation, embedding });
    if (!result.ok) {
      setError(modelErrorText(t, result.messageKey));
      setBusy(false);
      return;
    }
    const completionError = await onSaved();
    if (completionError) {
      setError(modelErrorText(t, completionError));
    }
    setBusy(false);
  }

  const openMigration = (opener?: HTMLElement) => { migrationOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); setMigrationOpen(true); };
  const selectSettingsTab = (next: "models" | "index") => setSection(next);
  return (
    <main className="model-page settings-page">
      <header className="model-page-header title-drag-region">
        <div>
          <h2>{t("settings.title")}</h2>
          <p>{t("settings.subtitle")}</p>
        </div>
      </header>
      <div className="settings-center">
        <nav role="tablist" aria-label={t("settings.title")}>
          <span>{t("settings.general")}</span>
          <span>{t("settings.languageAppearance")}</span>
          <button id="settings-models-tab" type="button" role="tab" aria-controls="settings-models-panel" aria-selected={section === "models"} aria-current={section === "models" ? "page" : undefined} onClick={() => selectSettingsTab("models")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "End") { event.preventDefault(); document.getElementById("settings-index-tab")?.focus(); selectSettingsTab("index"); } }}>{t("settings.modelServices")}</button>
          <button id="settings-index-tab" type="button" role="tab" aria-controls="settings-index-panel" aria-selected={section === "index"} aria-current={section === "index" ? "page" : undefined} onClick={() => selectSettingsTab("index")} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "Home") { event.preventDefault(); document.getElementById("settings-models-tab")?.focus(); selectSettingsTab("models"); } }}>{t("settings.dataIndex")}</button>
        </nav>
        {section === "models" ? (
          <section id="settings-models-panel" className="settings-model-content" role="tabpanel" tabIndex={0} aria-labelledby="settings-models-tab">
            <h3 id="model-services-title">{t("settings.modelServices")}</h3>
            <ModelConfigurationForms
              data={data}
              disabled={busy}
              onGenerationChange={setGeneration}
              onEmbeddingChange={setEmbedding}
            />
            <RouteSettings
              profiles={data.profiles.profiles}
              builtInProfiles={data.profiles.builtInProfiles}
              {...(projectId ? { projectId } : {})}
            />
          </section>
        ) : (
          <section id="settings-index-panel" className="settings-model-content settings-index-content" role="tabpanel" tabIndex={0} aria-labelledby="settings-index-tab">
            <h3 id="index-settings-title">{t("settings.dataIndex")}</h3>
            {projectId ? <IndexStatus
              health={indexHealth}
              task={indexTask}
              onConfigureModel={data.routes.embeddingProfileId ? undefined : () => setSection("models")}
              onOptimize={() => void startIndexTask("optimize")}
              onRebuild={() => void startIndexTask("rebuild")}
              onMigrate={() => { if (data.routes.embeddingProfileId) openMigration(); else setSection("models"); }}
              onCancel={() => void cancelIndexTask()}
            /> : <p className="index-status-copy">{t("vector.noProject")}</p>}
          </section>
        )}
      </div>
      {section === "models" && <>
        {error && <p className="model-page-error" role="alert">{error}</p>}
        <footer className="settings-actions">
          <span>{t("onboarding.localCredential")}</span>
          <button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
          <button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </footer>
      </>}
      {section === "index" && <footer className="settings-actions">
        <span>{t("settings.dataIndex")}</span>
        <button type="button" onClick={onCancel}>{t("common.cancel")}</button>
      </footer>}
      <SpaceMigrationDialog
        open={migrationOpen}
        opener={migrationOpener.current}
        hasPreviousSpace={Boolean(indexHealth.spaceId)}
        profileName={data.profiles.profiles.find((profile) => profile.id === data.routes.embeddingProfileId)?.name || data.profiles.builtInProfiles.find((profile) => profile.id === data.routes.embeddingProfileId)?.name}
        task={indexTask}
        failed={indexTask?.state === "failed"}
        error={indexTask?.state === "failed" ? indexHealth.message : undefined}
        onConfirm={() => void confirmMigration()}
        onCancel={() => { if (indexTask?.state === "queued" || indexTask?.state === "running") void cancelIndexTask(); else setMigrationOpen(false); }}
        onRetry={() => { setIndexTask(undefined); setIndexHealth((current) => ({ ...current, status: current.spaceId ? "healthy" : "unavailable", message: undefined })); void confirmMigration(true); }}
      />
    </main>
  );
}
