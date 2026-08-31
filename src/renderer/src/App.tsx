import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DefaultModelRoutesDto } from "../../shared/models";
import type { ProjectDto } from "../../shared/projects";
import { changeLanguage, changeTheme, type AppLanguage, type AppTheme } from "./i18n";
import Sidebar from "./features/sidebar/Sidebar";
import Workspace, { type Section } from "./features/workspace/Workspace";
import Onboarding from "./features/onboarding/Onboarding";
import Settings from "./features/settings/Settings";
import { ProjectNameDialog, ProjectRemoveDialog, type ProjectDialogState } from "./features/projects/ProjectDialogs";
import { useProjects } from "./features/projects/useProjects";
import { ToastHost, toast } from "./ui/Toast";
import Icon from "./ui/Icon";

type View = "boot" | "onboarding" | "app";

export default function App() {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [view, setView] = useState<View>("boot");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() =>
    (document.documentElement.dataset.theme as AppTheme | undefined) ?? "light");
  const [routes, setRoutes] = useState<DefaultModelRoutesDto>({});
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialogState>();
  const [section, setSection] = useState<Section>("research");
  const projects = useProjects(t);

  const refreshRoutes = useCallback(async () => {
    const result = await window.myNotebook.models.getDefaultRoutes().catch(() => undefined);
    if (result?.ok) setRoutes(result.value);
  }, []);

  // Boot: load settings, apply theme/language, decide onboarding vs app.
  useEffect(() => {
    if (view !== "boot") return;
    void (async () => {
      const result = await window.myNotebook.settings.get();
      if (!result.ok) {
        toast.error(t("model.errors.request"), { actionLabel: t("common.retry"), onAction: () => setView("boot") });
        return;
      }
      changeTheme(result.value.theme);
      setTheme(result.value.theme);
      await changeLanguage(result.value.locale);
      await refreshRoutes();
      setView(result.value.onboardingCompleted ? "app" : "onboarding");
    })();
  }, [view, refreshRoutes, t]);

  // Keep the native title bar overlay in sync with the theme.
  useEffect(() => {
    if (view === "boot") return;
    void window.myNotebook.titleOverlay.setTheme({ theme }).catch(() => undefined);
  }, [theme, view]);

  function selectTheme(next: AppTheme): void {
    setTheme(next);
    changeTheme(next);
    if (view !== "boot") void window.myNotebook.settings.update({ theme: next });
  }

  function selectLanguage(next: AppLanguage): void {
    void changeLanguage(next);
    if (view !== "boot") void window.myNotebook.settings.update({ locale: next });
  }

  async function handleMenuAction(action: "rename" | "archive" | "remove" | "restore" | "retryDelete", project: ProjectDto): Promise<void> {
    if (action === "rename") { setDialog({ kind: "rename", project }); return; }
    if (action === "remove") { setDialog({ kind: "remove", project }); return; }
    setBusy(true);
    if (action === "archive") await projects.archive(project.id);
    if (action === "restore") await projects.restore(project.id);
    if (action === "retryDelete") await projects.retryDelete(project.id);
    setBusy(false);
  }

  async function submitProjectDialog(name: string): Promise<void> {
    if (!dialog || dialog.kind === "remove") return;
    setBusy(true);
    const ok = dialog.kind === "create"
      ? await projects.create(name)
      : await projects.rename(dialog.project.id, name);
    setBusy(false);
    if (ok) setDialog(undefined);
  }

  async function confirmRemove(): Promise<void> {
    if (dialog?.kind !== "remove") return;
    setBusy(true);
    await projects.remove(dialog.project.id);
    setBusy(false);
    setDialog(undefined);
  }

  async function finishOnboarding(): Promise<void> {
    const result = await window.myNotebook.settings.update({ onboardingCompleted: true });
    if (!result.ok) { toast.error(t(result.error.messageKey)); return; }
    await refreshRoutes();
    setView("app");
  }

  const selectedProject = projects.selected;
  const crumb = settingsOpen ? t("app.settings") : selectedProject?.name ?? t("project.title");

  return (
    <>
      <div className="app" data-view={view}>
        {view === "boot" ? (
          <main className="main"><div className="boot"><span className="spinner" aria-hidden="true" /><span>{t("common.loading")}</span></div></main>
        ) : (
          <>
            <Sidebar
              projects={projects.projects}
              archived={projects.archived}
              selectedId={projects.selectedId}
              busy={busy}
              onboarding={view === "onboarding"}
              language={language}
              theme={theme}
              onSelect={(id) => { projects.select(id); setSettingsOpen(false); }}
              onCreate={() => setDialog({ kind: "create" })}
              onMenuAction={(action, project) => void handleMenuAction(action, project)}
              onOpenSettings={() => setSettingsOpen(true)}
              settingsActive={settingsOpen}
              onLanguage={selectLanguage}
              onTheme={selectTheme}
            />
            <header className="topbar drag">
              {view === "app" && !settingsOpen && selectedProject && !selectedProject.archived && selectedProject.status === "active" ? (
                <nav className="tabs" role="tablist" aria-label={t("project.sections")}>
                  {([
                    ["research", "chat", t("workspace.research")],
                    ["notes", "notes", t("notes.titlePage")],
                    ["studio", "sparkle", t("workspace.studio")]
                  ] as const).map(([id, icon, label]) => (
                    <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
                      <Icon name={icon} />
                      {label}
                    </button>
                  ))}
                </nav>
              ) : (
                <span className="crumb"><b>{t("app.name")}</b>{crumb ? ` / ${crumb}` : ""}</span>
              )}
              <span className="spacer" />
            </header>
            <main className="main">
              {view === "onboarding" ? (
                <Onboarding
                  language={language}
                  theme={theme}
                  onLanguage={selectLanguage}
                  onTheme={selectTheme}
                  onFinish={finishOnboarding}
                />
              ) : settingsOpen ? (
                <Settings
                  projectId={selectedProject?.id}
                  language={language}
                  theme={theme}
                  onLanguage={selectLanguage}
                  onTheme={selectTheme}
                  onRoutesChanged={() => void refreshRoutes()}
                  onClose={() => setSettingsOpen(false)}
                />
              ) : selectedProject && !selectedProject.archived && selectedProject.status === "active" ? (
                <Workspace
                  key={selectedProject.id}
                  projectId={selectedProject.id}
                  section={section}
                  onSectionChange={setSection}
                  routes={routes}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              ) : (
                <div className="workspace">
                  <div className="empty" style={{ height: "100%" }}>
                    <span className="glyph" aria-hidden="true"><Icon name="book" /></span>
                    <h3>{t("project.emptyTitle")}</h3>
                    <p>{t("project.emptyBody")}</p>
                    <div className="actions">
                      <button type="button" className="btn primary" onClick={() => setDialog({ kind: "create" })}>
                        <Icon name="plus" />{t("project.create")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>

      {dialog && dialog.kind !== "remove" && (
        <ProjectNameDialog state={dialog} busy={busy} onSubmit={(name) => void submitProjectDialog(name)} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "remove" && (
        <ProjectRemoveDialog project={dialog.project} busy={busy} onConfirm={() => void confirmRemove()} onClose={() => setDialog(undefined)} />
      )}

      <ToastHost />
    </>
  );
}
