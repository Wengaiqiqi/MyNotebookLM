import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ProjectDto } from "../../shared/projects";
import { changeLanguage, changeTheme, readTheme, type AppLanguage, type AppTheme } from "./i18n";

type DialogState =
  | { kind: "create" }
  | { kind: "rename"; project: ProjectDto }
  | { kind: "remove"; project: ProjectDto };

type ErrorKey =
  | "error.loadProjects"
  | "error.createProject"
  | "error.renameProject"
  | "error.archiveProject"
  | "error.removeProject";

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
  const [projects, setProjects] = useState<ProjectDto[]>([]);
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
  const nameInput = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const dialogCard = useRef<HTMLElement>(null);
  const projectMenu = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void refreshProjects();
  }, [refreshProjects]);

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

  const selectedProject = projects.find((project) => project.id === selectedId);
  const openMenuProject = projects.find((project) => project.id === openMenu?.projectId);

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
      await window.myNotebook.projects.remove({ id: project.id });
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

  function selectTheme(next: AppTheme): void {
    setTheme(next);
    changeTheme(next);
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
    <div className="app-shell" inert={dialog ? true : undefined} aria-hidden={dialog ? true : undefined}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>{t("app.name")}</span>
        </div>

        <nav className="project-nav" aria-label={t("project.title")}>
          <h1>{t("project.title")}</h1>
          <button className="primary-button create-button" type="button" disabled={busy} onClick={(event) => openCreateDialog(event.currentTarget)}>
            <span aria-hidden="true">＋</span>{t("project.create")}
          </button>

          {errorTarget === "load" && (
            <div className="inline-error load-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                disabled={busy}
                aria-label={t("error.loadProjects")}
                onClick={() => { if (!busyRef.current) void refreshProjects(); }}
              >↻</button>
            </div>
          )}

          <div className="project-list">
            {projects.map((project) => (
              <div className={`project-row${project.id === selectedId ? " selected" : ""}`} key={project.id}>
                <button
                  className="project-select"
                  type="button"
                  aria-current={project.id === selectedId ? "page" : undefined}
                  disabled={busy}
                  onClick={() => {
                    if (busyRef.current) return;
                    setSelectedId(project.id);
                    setOpenMenu(undefined);
                  }}
                >
                  <span className="project-icon" aria-hidden="true">□</span>
                  <span className="project-copy">
                    <strong>{project.name}</strong>
                    <small>{formatDate(project.updatedAt, language)}</small>
                  </span>
                </button>
                <button
                  className="menu-trigger"
                  type="button"
                  aria-label={`${project.name}: ${t("project.menu")}`}
                  aria-expanded={openMenu?.projectId === project.id}
                  aria-controls={openMenu?.projectId === project.id ? `project-actions-${project.id}` : undefined}
                  disabled={busy}
                  onClick={(event) => toggleProjectMenu(project.id, event.currentTarget)}
                >
                  •••
                </button>
              </div>
            ))}
          </div>
        </nav>

        <footer className="sidebar-footer">
          <button className="settings-button" type="button" disabled title={t("research.settingsUnavailable")}>
            <span aria-hidden="true">⚙</span>{t("app.settings")}
          </button>
          <div className="preference-row" role="group" aria-label={t("common.language")}>
            <button type="button" aria-pressed={language === "zh-CN"} onClick={() => void changeLanguage("zh-CN")}>中文</button>
            <span aria-hidden="true">|</span>
            <button type="button" aria-pressed={language === "en"} onClick={() => void changeLanguage("en")}>EN</button>
          </div>
          <div className="preference-row" role="group" aria-label={t("common.theme")}>
            <button type="button" aria-pressed={theme === "light"} onClick={() => selectTheme("light")}>{t("common.light")}</button>
            <span aria-hidden="true">|</span>
            <button type="button" aria-pressed={theme === "dark"} onClick={() => selectTheme("dark")}>{t("common.dark")}</button>
          </div>
        </footer>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">{t("app.name")}</span>
            <h2>{selectedProject?.name ?? t("project.emptyTitle")}</h2>
          </div>
        </header>

        <div className="workspace-grid">
          <section className="research-canvas" aria-labelledby="workspace-title">
            {selectedProject ? (
              <>
                <div className="workspace-empty">
                  <h3 id="workspace-title">{t("research.workspaceTitle")}</h3>
                  <div className="import-region" aria-label={t("research.importSources")}>
                    <span className="document-icon" aria-hidden="true">◇</span>
                    <p>{t("research.sourceImportUnavailable")}</p>
                    <button type="button" disabled title={t("research.sourceImportUnavailable")}>{t("research.importSources")}</button>
                    <div className="format-grid">
                      {["PDF", "DOCX", "PPTX", "XLSX", "TXT", "Markdown", "URL", "CSV"].map((format) => (
                        <button className="format-choice" type="button" disabled key={format}>{format}</button>
                      ))}
                    </div>
                  </div>
                  <div className="guidance-card">
                    <span aria-hidden="true">◎</span>
                    <p>{t("research.researchChatUnavailable")}</p>
                  </div>
                </div>
                <div className="composer" aria-label={t("research.ask")}>
                  <button className="model-pill" type="button" disabled>NotebookLM⌄</button>
                  <button className="ask-button" type="button" disabled>{t("research.ask")}</button>
                  <span>{t("research.researchChatUnavailable")}</span>
                </div>
              </>
            ) : (
              <div className="no-project">
                <span className="empty-book" aria-hidden="true">M</span>
                <h3 id="workspace-title">{t("project.emptyTitle")}</h3>
                <p>{t("project.emptyBody")}</p>
                <button className="primary-button" type="button" disabled={busy} onClick={(event) => openCreateDialog(event.currentTarget)}>{t("project.create")}</button>
              </div>
            )}
          </section>

          <aside className="sources-panel" aria-label={t("research.sources")}>
            <header>
              <h3>{t("research.sources")}</h3>
              <button type="button" disabled aria-label={t("research.importSources")}>＋</button>
            </header>
            <div className="sources-empty">
              <span aria-hidden="true">□＋</span>
              <strong>{t("research.noSourcesTitle")}</strong>
              <p>{t("research.noSourcesBody")}</p>
            </div>
          </aside>
        </div>
      </main>
    </div>

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
          <button type="button" disabled={busy} onClick={() => void archiveProject(openMenuProject)}>
            <span aria-hidden="true">▣</span>{t("project.archive")}
          </button>
          <button
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
          </button>
          {errorTarget === `project:${openMenuProject.id}` && <p className="inline-error" role="alert">{error}</p>}
        </div>,
        document.body
      )}

      {dialog && (
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
      )}
    </>
  );
}
