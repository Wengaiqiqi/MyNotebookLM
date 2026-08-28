import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ProjectDto } from "../../shared/projects";
import type { DefaultModelRoutesDto } from "../../shared/models";
import { changeLanguage, changeTheme, readTheme, type AppLanguage, type AppTheme } from "./i18n";
import FirstLaunch, { type ModelSettingsData } from "./model-settings/FirstLaunch";
import SettingsView from "./model-settings/SettingsView";
import AppShell from "./app/AppShell";
import AppRouter from "./app/AppRouter";
import Sidebar from "./app/Sidebar";
import ModalRoot from "./app/ModalRoot";
import ProjectView from "./projects/ProjectView";

type DialogState =
  | { kind: "create" }
  | { kind: "rename"; project: ProjectDto }
  | { kind: "remove"; project: ProjectDto };

type ErrorKey =
  | "error.loadProjects"
  | "error.createProject"
  | "error.renameProject"
  | "error.archiveProject"
  | "error.removeProject"
  | "error.restoreProject"
  | "error.retryDeleteProject";

type OpenMenu = {
  instanceId: number;
  projectId: string;
  top: number;
  left: number;
  trigger: HTMLButtonElement;
};

const menuWidth = 154;
const menuHeight = 132;
const menuMargin = 8;
const menuGap = 6;

function placeProjectMenu(
  anchor: DOMRect,
  width = menuWidth,
  height = menuHeight
): Pick<OpenMenu, "top" | "left"> {
  const left = Math.min(
    Math.max(anchor.right - width, menuMargin),
    Math.max(menuMargin, window.innerWidth - width - menuMargin)
  );
  const top = anchor.bottom + menuGap + height <= window.innerHeight - menuMargin
    ? anchor.bottom + menuGap
    : Math.max(menuMargin, anchor.top - menuGap - height);
  return { top, left };
}

function formatDate(value: string, language: AppLanguage): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function focusIfAvailable(target: HTMLElement | null | undefined): void {
  if (target?.isConnected && !target.matches(":disabled")) target.focus();
}

export default function App() {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [view, setView] = useState<"loading" | "onboarding" | "projects" | "settings">("loading");
  const [modelData, setModelData] = useState<ModelSettingsData>();
  const [routes, setRoutes] = useState<DefaultModelRoutesDto>({});
  const [startupError, setStartupError] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectDto[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [deletingProject, setDeletingProject] = useState<ProjectDto>();
  const [selectedId, setSelectedId] = useState<string>();
  const [errorKey, setErrorKey] = useState<ErrorKey>();
  const [errorTarget, setErrorTarget] = useState<string>();
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const [dialog, setDialog] = useState<DialogState>();
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dialogRef = useRef<DialogState | undefined>(undefined);
  const dialogOpener = useRef<HTMLElement | undefined>(undefined);
  const pendingFocus = useRef<HTMLElement | undefined>(undefined);
  const openMenuRef = useRef<OpenMenu | undefined>(undefined);
  const menuMutation = useRef<number | undefined>(undefined);
  const menuSequence = useRef(0);
  const listRequestEpoch = useRef(0);
  const loaded = useRef(false);
  const settingsReturnView = useRef<"onboarding" | "projects">("projects");
  const settingsLoadErrorRef = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const dialogCard = useRef<HTMLElement>(null);
  const projectMenu = useRef<HTMLDivElement>(null);
  const syncedTitleOverlayTheme = useRef<AppTheme | undefined>(undefined);
  dialogRef.current = dialog;
  openMenuRef.current = openMenu;
  const error = errorKey ? t(errorKey) : undefined;

  function restoreFocusAfterClose(target: HTMLElement | undefined): void {
    pendingFocus.current = target;
  }

  function dismissDialog(): void {
    const activeDialog = dialogRef.current;
    if (!activeDialog || busyRef.current) return;
    restoreFocusAfterClose(dialogOpener.current);
    dialogOpener.current = undefined;
    setDialog((current) => current === activeDialog ? undefined : current);
  }

  function dismissMenu(activeMenu: OpenMenu): void {
    if (
      menuMutation.current === activeMenu.instanceId
      || openMenuRef.current?.instanceId !== activeMenu.instanceId
    ) return;
    restoreFocusAfterClose(activeMenu.trigger);
    setOpenMenu((current) => current?.instanceId === activeMenu.instanceId ? undefined : current);
  }

  const refreshProjects = useCallback(async () => {
    const requestEpoch = ++listRequestEpoch.current;
    try {
      const next = await window.myNotebook.projects.list();
      if (requestEpoch !== listRequestEpoch.current) return;
      setProjects(next);
      setSelectedId((current) =>
        current && next.some((project) => project.id === current) ? current : next[0]?.id
      );
      setErrorKey(undefined);
      setErrorTarget(undefined);
    } catch {
      if (requestEpoch !== listRequestEpoch.current) return;
      setErrorKey("error.loadProjects");
      setErrorTarget("load");
    }
  }, []);

  const refreshArchivedProjects = useCallback(async () => {
    try {
      const [archived, failed] = await Promise.all([window.myNotebook.projects.listArchived(), window.myNotebook.projects.listDeleteFailed()]);
      setArchivedProjects([...archived, ...failed.filter((project) => !archived.some((item) => item.id === project.id))]);
    } catch { setErrorKey("error.loadProjects"); setErrorTarget("load"); }
  }, []);

  const loadModelData = useCallback(async (): Promise<ModelSettingsData | undefined> => {
    const [profileResult, routeResult] = await Promise.all([
      window.myNotebook.models.listProfiles(),
      window.myNotebook.models.getDefaultRoutes()
    ]);
    if (!profileResult.ok || !routeResult.ok) return undefined;
    const data = { profiles: profileResult.value, routes: routeResult.value };
    setModelData(data);
    setRoutes(routeResult.value);
    return data;
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      const result = await window.myNotebook.settings.get();
      if (!result.ok) {
        setStartupError(true);
        return;
      }
      setTheme(result.value.theme);
      changeTheme(result.value.theme);
      await changeLanguage(result.value.locale);
      if (!result.value.onboardingCompleted) {
        const data = await loadModelData();
        if (!data) setStartupError(true);
        else setView("onboarding");
        return;
      }
      const routeResult = await window.myNotebook.models.getDefaultRoutes();
      if (routeResult.ok) setRoutes(routeResult.value);
      setView("projects");
      await refreshProjects();
    })();
  }, [loadModelData, refreshProjects]);

  useEffect(() => {
    if (syncedTitleOverlayTheme.current === theme) return;
    syncedTitleOverlayTheme.current = theme;
    void window.myNotebook.titleOverlay.setTheme({ theme }).catch(() => undefined);
  }, [theme]);

  useEffect(() => {
    if (settingsLoadError) settingsLoadErrorRef.current?.focus();
  }, [settingsLoadError]);

  useEffect(() => {
    if (dialog || openMenu || !pendingFocus.current) return;
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    focusIfAvailable(target);
  }, [dialog, openMenu]);

  useEffect(() => {
    if (!dialog) return;
    const card = dialogCard.current;
    const initialFocus = dialog.kind === "remove" ? confirmButton.current : nameInput.current;
    initialFocus?.focus();

    const focusableElements = (): HTMLElement[] => card
      ? [...card.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")]
      : [];
    const containFocus = (event: FocusEvent): void => {
      if (card && event.target instanceof Node && !card.contains(event.target)) {
        initialFocus?.focus();
      }
    };
    const handleDialogKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        card?.focus();
      } else if (!card?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("focusin", containFocus);
    document.addEventListener("keydown", handleDialogKey);
    return () => {
      document.removeEventListener("focusin", containFocus);
      document.removeEventListener("keydown", handleDialogKey);
    };
  }, [dialog]);

  useLayoutEffect(() => {
    if (!openMenu || !projectMenu.current) return;
    const measured = projectMenu.current.getBoundingClientRect();
    const next = placeProjectMenu(
      openMenu.trigger.getBoundingClientRect(),
      measured.width || menuWidth,
      measured.height || menuHeight
    );
    if (next.top !== openMenu.top || next.left !== openMenu.left) {
      setOpenMenu((current) => current ? { ...current, ...next } : current);
    }
  }, [openMenu?.projectId, errorKey, errorTarget]);

  useEffect(() => {
    if (!openMenu) return;
    projectMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const repositionOrDismiss = (): void => {
      if (menuMutation.current !== openMenu.instanceId) {
        dismissMenu(openMenu);
        return;
      }
      const measured = projectMenu.current?.getBoundingClientRect();
      const next = placeProjectMenu(
        openMenu.trigger.getBoundingClientRect(),
        measured?.width || menuWidth,
        measured?.height || menuHeight
      );
      setOpenMenu((current) => current?.instanceId === openMenu.instanceId
        ? { ...current, ...next }
        : current);
    };
    const handleOutsideMouseDown = (event: MouseEvent): void => {
      if (
        event.target instanceof Node
        && !projectMenu.current?.contains(event.target)
        && !openMenu.trigger.contains(event.target)
      ) dismissMenu(openMenu);
    };
    const handleMenuKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissMenu(openMenu);
    };

    window.addEventListener("resize", repositionOrDismiss);
    document.addEventListener("scroll", repositionOrDismiss, true);
    document.addEventListener("mousedown", handleOutsideMouseDown);
    document.addEventListener("keydown", handleMenuKey);
    return () => {
      window.removeEventListener("resize", repositionOrDismiss);
      document.removeEventListener("scroll", repositionOrDismiss, true);
      document.removeEventListener("mousedown", handleOutsideMouseDown);
      document.removeEventListener("keydown", handleMenuKey);
    };
  }, [openMenu?.instanceId]);

  const displayedProjects = showArchived ? archivedProjects : projects;
  const selectedProject = [...projects, ...archivedProjects].find((project) => project.id === selectedId);
  const openMenuProject = [...projects, ...archivedProjects].find((project) => project.id === openMenu?.projectId);

  function openCreateDialog(opener: HTMLElement): void {
    if (busyRef.current || dialogRef.current) return;
    dialogOpener.current = opener;
    setDraftName("");
    setErrorKey(undefined);
    setErrorTarget(undefined);
    setOpenMenu(undefined);
    setDialog({ kind: "create" });
  }

  function openRenameDialog(project: ProjectDto, opener: HTMLElement): void {
    if (busyRef.current || dialogRef.current) return;
    dialogOpener.current = opener;
    setDraftName(project.name);
    setErrorKey(undefined);
    setErrorTarget(undefined);
    setOpenMenu(undefined);
    setDialog({ kind: "rename", project });
  }

  async function submitName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dialog || dialog.kind === "remove" || busyRef.current) return;

    const activeDialog = dialog;
    listRequestEpoch.current += 1;
    busyRef.current = true;
    setBusy(true);
    setErrorKey(undefined);
    setErrorTarget(undefined);
    try {
      if (activeDialog.kind === "create") {
        await window.myNotebook.projects.create({ name: draftName });
      } else {
        await window.myNotebook.projects.rename({ id: activeDialog.project.id, name: draftName });
      }
      await refreshProjects();
      if (dialogRef.current === activeDialog) dialogOpener.current = undefined;
      setDialog((current) => current === activeDialog ? undefined : current);
    } catch {
      if (dialogRef.current === activeDialog) {
        setErrorKey(activeDialog.kind === "create" ? "error.createProject" : "error.renameProject");
        setErrorTarget("dialog");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function archiveProject(project: ProjectDto): Promise<void> {
    if (busyRef.current) return;
    const activeMenu = openMenuRef.current;
    if (!activeMenu || activeMenu.projectId !== project.id) return;
    menuMutation.current = activeMenu.instanceId;
    listRequestEpoch.current += 1;
    busyRef.current = true;
    setBusy(true);
    setErrorKey(undefined);
    setErrorTarget(undefined);
    try {
      await window.myNotebook.projects.archive({ id: project.id });
      await refreshProjects();
      setOpenMenu((current) => current?.instanceId === activeMenu.instanceId ? undefined : current);
    } catch {
      if (openMenuRef.current?.instanceId === activeMenu.instanceId) {
        setErrorKey("error.archiveProject");
        setErrorTarget(`project:${project.id}`);
      }
    } finally {
      if (menuMutation.current === activeMenu.instanceId) menuMutation.current = undefined;
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function removeProject(project: ProjectDto): Promise<void> {
    if (busyRef.current) return;
    const activeDialog = dialog;
    if (activeDialog?.kind !== "remove" || activeDialog.project.id !== project.id) return;
    listRequestEpoch.current += 1;
    busyRef.current = true;
    setBusy(true);
    setErrorKey(undefined);
    setErrorTarget(undefined);
    try {
      const result = await window.myNotebook.projects.remove({ id: project.id });
      if (result && result.status === "deleting") setDeletingProject(result);
      await refreshProjects();
      if (dialogRef.current === activeDialog) dialogOpener.current = undefined;
      setDialog((current) => current === activeDialog ? undefined : current);
      setOpenMenu(undefined);
    } catch {
      if (dialogRef.current === activeDialog) {
        setErrorKey("error.removeProject");
        setErrorTarget("dialog");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function undoProjectDeletion(): Promise<void> {
    if (!deletingProject || !window.myNotebook.projects.undo) return;
    try { await window.myNotebook.projects.undo({ id: deletingProject.id }); setDeletingProject(undefined); await refreshProjects(); }
    catch { setErrorKey("error.restoreProject"); setErrorTarget("load"); }
  }

  async function restoreProject(project: ProjectDto): Promise<void> {
    if (!window.myNotebook.projects.restore) return;
    try { await window.myNotebook.projects.restore({ id: project.id }); await refreshProjects(); await refreshArchivedProjects(); }
    catch { setErrorKey("error.restoreProject"); setErrorTarget(`project:${project.id}`); }
  }

  async function retryProjectDeletion(project: ProjectDto): Promise<void> {
    if (!window.myNotebook.projects.retryDelete) return;
    try { const result = await window.myNotebook.projects.retryDelete({ id: project.id }); setDeletingProject(result); await refreshArchivedProjects(); }
    catch { setErrorKey("error.retryDeleteProject"); setErrorTarget(`project:${project.id}`); }
  }

  function selectTheme(next: AppTheme): void {
    setTheme(next);
    changeTheme(next);
    if (view !== "loading") void window.myNotebook.settings.update({ theme: next });
  }

  function selectLanguage(next: AppLanguage): void {
    void changeLanguage(next);
    if (view !== "loading") void window.myNotebook.settings.update({ locale: next });
  }

  async function openSettings(): Promise<void> {
    if (view === "loading") return;
    setSettingsLoadError(false);
    settingsReturnView.current = view === "onboarding" ? "onboarding" : "projects";
    const data = await loadModelData();
    if (data) setView("settings");
    else setSettingsLoadError(true);
  }

  async function finishOnboarding(): Promise<string | undefined> {
    const result = await window.myNotebook.settings.update({ onboardingCompleted: true });
    if (!result.ok) return result.error.messageKey;
    const routeResult = await window.myNotebook.models.getDefaultRoutes();
    if (!routeResult.ok) return routeResult.error.messageKey;
    setRoutes(routeResult.value);
    setView("projects");
    await refreshProjects();
    return undefined;
  }

  async function finishSettings(): Promise<string | undefined> {
    const data = await loadModelData();
    if (!data) return "model.errors.request";
    setView(settingsReturnView.current);
    if (settingsReturnView.current === "projects" && projects.length === 0) await refreshProjects();
    return undefined;
  }

  function toggleProjectMenu(projectId: string, trigger: HTMLButtonElement): void {
    if (busyRef.current || dialogRef.current) return;
    setOpenMenu((current) => {
      if (current?.projectId === projectId) return undefined;
      return {
        instanceId: ++menuSequence.current,
        projectId,
        trigger,
        ...placeProjectMenu(trigger.getBoundingClientRect())
      };
    });
  }

  return (
    <>
    <AppShell dialogOpen={Boolean(dialog)}>
      <Sidebar
        brand={t("app.name")} projectTitle={t("project.title")} createLabel={t("project.create")} archivedLabel={t("project.archived")} settingsLabel={t("app.settings")} deletionPendingLabel={t("project.deletionPending")} undoLabel={t("project.undo")} settingsErrorLabel={t("settings.loadError")} retryLabel={t("common.retry")}
        language={language} theme={theme} view={view} busy={busy} projects={projects} archivedProjects={archivedProjects} showArchived={showArchived} selectedId={selectedId} openMenuId={openMenu?.projectId} deletingProject={deletingProject} error={error} errorTarget={errorTarget} settingsLoadErrorRef={settingsLoadErrorRef}
        onCreate={openCreateDialog} onRetryLoad={() => { if (!busyRef.current) void refreshProjects(); }} onToggleArchived={() => { const next = !showArchived; setShowArchived(next); if (next) void refreshArchivedProjects(); }} onUndo={() => void undoProjectDeletion()}
        onSelect={(id) => { if (!busyRef.current) { setSelectedId(id); setOpenMenu(undefined); } }} onMenu={toggleProjectMenu} onSettings={() => void openSettings()} settingsLoadError={settingsLoadError} onRetrySettings={() => void openSettings()} onLanguage={selectLanguage} onTheme={selectTheme} formatDate={(value) => formatDate(value, language)} menuLabel={t("project.menu")}
      />
      <AppRouter view={view}
        loading={<main className="workspace loading-workspace title-drag-region">{startupError && <p role="alert">{t("model.errors.request")}</p>}</main>}
        onboarding={modelData ? <FirstLaunch data={modelData} theme={theme} onThemeChange={selectTheme} onComplete={finishOnboarding} onSkip={finishOnboarding} /> : null}
        settings={modelData ? <SettingsView data={modelData} onCancel={() => setView(settingsReturnView.current)} onSaved={finishSettings} /> : null}
        projects={<ProjectView appName={t("app.name")} project={selectedProject} routes={routes} busy={busy} workspaceTitle={t("research.workspaceTitle")} emptyTitle={t("project.emptyTitle")} emptyBody={t("project.emptyBody")} createLabel={t("project.create")} sourceImportUnavailable={t("research.sourceImportUnavailable")} importSources={t("research.importSources")} chatUnavailable={t("research.researchChatUnavailable")} sourcesLabel={t("research.sources")} noSourcesTitle={t("research.noSourcesTitle")} noSourcesBody={t("research.noSourcesBody")} askLabel={t("research.ask")} openSettingsLabel={t("common.openSettings")} onOpenSettings={() => void openSettings()} onCreate={openCreateDialog} />}
      />
    </AppShell>

      <ModalRoot>
      {openMenu && openMenuProject && !dialog && createPortal(
        <div
          ref={projectMenu}
          id={`project-actions-${openMenuProject.id}`}
          className="project-popover"
          role="group"
          aria-label={t("project.menu")}
          style={{ top: openMenu.top, left: openMenu.left }}
        >
          <button type="button" disabled={busy} onClick={() => openRenameDialog(openMenuProject, openMenu.trigger)}>
            <span aria-hidden="true">✎</span>{t("project.rename")}
          </button>
          {openMenuProject.status === "active" && !openMenuProject.archived && <button type="button" disabled={busy} onClick={() => void archiveProject(openMenuProject)}>
            <span aria-hidden="true">▣</span>{t("project.archive")}
          </button>}
          {openMenuProject.status === "active" && !openMenuProject.archived && <button
            className="danger-action"
            type="button"
            disabled={busy}
            onClick={() => {
              if (busyRef.current) return;
              dialogOpener.current = openMenu.trigger;
              setErrorKey(undefined);
              setErrorTarget(undefined);
              setOpenMenu(undefined);
              setDialog({ kind: "remove", project: openMenuProject });
            }}
          >
            <span aria-hidden="true">⌫</span>{t("project.remove")}
          </button>}
          {openMenuProject.status === "delete_failed" ? (
            <>
              <button type="button" onClick={() => void retryProjectDeletion(openMenuProject)}>{t("project.retryDelete")}</button>
              <button type="button" onClick={() => void restoreProject(openMenuProject)}>{t("project.restore")}</button>
            </>
          ) : openMenuProject.archived ? (
            <button type="button" onClick={() => void restoreProject(openMenuProject)}>{t("project.restore")}</button>
          ) : null}
          {errorTarget === `project:${openMenuProject.id}` && <p className="inline-error" role="alert">{error}</p>}
        </div>,
        document.body
      )}

      {dialog && createPortal(
        <div
          className="dialog-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismissDialog();
          }}
        >
          <section
            ref={dialogCard}
            className="dialog-card"
            role={dialog.kind === "remove" ? "alertdialog" : "dialog"}
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="dialog-title"
            aria-describedby={dialog.kind === "remove" ? "dialog-description" : undefined}
          >
            {dialog.kind === "remove" ? (
              <>
                <div className="dialog-heading">
                  <span className="warning-icon" aria-hidden="true">!</span>
                  <div>
                    <h2 id="dialog-title">{t("project.remove")}</h2>
                    <p id="dialog-description">{t("project.removeConfirm")}</p>
                    <strong>{dialog.project.name}</strong>
                  </div>
                </div>
                {errorTarget === "dialog" && <p className="inline-error dialog-error" role="alert">{error}</p>}
                <div className="dialog-actions">
                  <button type="button" disabled={busy} onClick={dismissDialog}>{t("common.cancel")}</button>
                  <button ref={confirmButton} className="danger-button" type="button" disabled={busy} onClick={() => void removeProject(dialog.project)}>{t("common.confirm")}</button>
                </div>
              </>
            ) : (
              <form onSubmit={(event) => void submitName(event)}>
                <h2 id="dialog-title">{t(dialog.kind === "create" ? "project.create" : "project.rename")}</h2>
                <label htmlFor="project-name">{t("project.nameLabel")}</label>
                <input
                  ref={nameInput}
                  id="project-name"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  maxLength={80}
                  required
                  autoComplete="off"
                />
                {errorTarget === "dialog" && <p className="inline-error dialog-error" role="alert">{error}</p>}
                <div className="dialog-actions">
                  <button type="button" disabled={busy} onClick={dismissDialog}>{t("common.cancel")}</button>
                  <button className="primary-button" type="submit" disabled={busy || !draftName.trim()}>{t("common.confirm")}</button>
                </div>
              </form>
            )}
          </section>
        </div>
      , document.body)}
      </ModalRoot>
    </>
  );
}
