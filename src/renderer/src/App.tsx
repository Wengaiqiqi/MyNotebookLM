import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectDto } from "../../shared/projects";
import { changeLanguage, changeTheme, readTheme, type AppLanguage, type AppTheme } from "./i18n";

type DialogState =
  | { kind: "create" }
  | { kind: "rename"; project: ProjectDto }
  | { kind: "remove"; project: ProjectDto };

function formatDate(value: string, language: AppLanguage): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

export default function App() {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const [errorTarget, setErrorTarget] = useState<string>();
  const [openMenuId, setOpenMenuId] = useState<string>();
  const [dialog, setDialog] = useState<DialogState>();
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const next = await window.myNotebook.projects.list();
      setProjects(next);
      setSelectedId((current) =>
        current && next.some((project) => project.id === current) ? current : next[0]?.id
      );
      setError(undefined);
      setErrorTarget(undefined);
    } catch {
      setError(t("error.loadProjects"));
      setErrorTarget("load");
    }
  }, [t]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!dialog) return;
    if (dialog.kind === "remove") confirmButton.current?.focus();
    else nameInput.current?.focus();
  }, [dialog]);

  const selectedProject = projects.find((project) => project.id === selectedId);

  function openCreateDialog(): void {
    setDraftName("");
    setError(undefined);
    setErrorTarget(undefined);
    setDialog({ kind: "create" });
  }

  function openRenameDialog(project: ProjectDto): void {
    setDraftName(project.name);
    setError(undefined);
    setErrorTarget(undefined);
    setOpenMenuId(undefined);
    setDialog({ kind: "rename", project });
  }

  async function submitName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dialog || dialog.kind === "remove") return;

    setBusy(true);
    setError(undefined);
    setErrorTarget(undefined);
    try {
      if (dialog.kind === "create") {
        await window.myNotebook.projects.create({ name: draftName });
      } else {
        await window.myNotebook.projects.rename({ id: dialog.project.id, name: draftName });
      }
      await refreshProjects();
      setDialog(undefined);
    } catch {
      setError(t(dialog.kind === "create" ? "error.createProject" : "error.renameProject"));
      setErrorTarget("dialog");
    } finally {
      setBusy(false);
    }
  }

  async function archiveProject(project: ProjectDto): Promise<void> {
    setBusy(true);
    setError(undefined);
    setErrorTarget(undefined);
    try {
      await window.myNotebook.projects.archive({ id: project.id });
      await refreshProjects();
      setOpenMenuId(undefined);
    } catch {
      setError(t("error.archiveProject"));
      setErrorTarget(`project:${project.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeProject(project: ProjectDto): Promise<void> {
    setBusy(true);
    setError(undefined);
    setErrorTarget(undefined);
    try {
      await window.myNotebook.projects.remove({ id: project.id });
      await refreshProjects();
      setDialog(undefined);
      setOpenMenuId(undefined);
    } catch {
      setError(t("error.removeProject"));
      setErrorTarget("dialog");
    } finally {
      setBusy(false);
    }
  }

  function selectTheme(next: AppTheme): void {
    setTheme(next);
    changeTheme(next);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>{t("app.name")}</span>
        </div>

        <nav className="project-nav" aria-label={t("project.title")}>
          <h1>{t("project.title")}</h1>
          <button className="primary-button create-button" type="button" onClick={openCreateDialog}>
            <span aria-hidden="true">＋</span>{t("project.create")}
          </button>

          {errorTarget === "load" && (
            <div className="inline-error load-error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label={t("error.loadProjects")} onClick={() => void refreshProjects()}>↻</button>
            </div>
          )}

          <div className="project-list">
            {projects.map((project) => (
              <div className={`project-row${project.id === selectedId ? " selected" : ""}`} key={project.id}>
                <button
                  className="project-select"
                  type="button"
                  aria-current={project.id === selectedId ? "page" : undefined}
                  onClick={() => {
                    setSelectedId(project.id);
                    setOpenMenuId(undefined);
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
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === project.id}
                  onClick={() => setOpenMenuId((current) => current === project.id ? undefined : project.id)}
                >
                  •••
                </button>
                {openMenuId === project.id && (
                  <div className="project-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => openRenameDialog(project)}>
                      <span aria-hidden="true">✎</span>{t("project.rename")}
                    </button>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => void archiveProject(project)}>
                      <span aria-hidden="true">▣</span>{t("project.archive")}
                    </button>
                    <button
                      className="danger-action"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setError(undefined);
                        setErrorTarget(undefined);
                        setDialog({ kind: "remove", project });
                      }}
                    >
                      <span aria-hidden="true">⌫</span>{t("project.remove")}
                    </button>
                    {errorTarget === `project:${project.id}` && <p className="inline-error" role="alert">{error}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </nav>

        <footer className="sidebar-footer">
          <button className="settings-button" type="button" disabled title={t("research.unavailable")}>
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
                <div className="research-empty">
                  <span className="document-icon" aria-hidden="true">◇</span>
                  <h3 id="workspace-title">{t("research.workspaceTitle")}</h3>
                  <p>{t("research.workspaceBody")}</p>
                  <button type="button" disabled title={t("research.unavailable")}>{t("research.importSources")}</button>
                </div>
                <div className="composer" aria-label={t("research.ask")}>
                  <button className="model-pill" type="button" disabled>NotebookLM⌄</button>
                  <button className="ask-button" type="button" disabled>{t("research.ask")}</button>
                  <span>{t("research.unavailable")}</span>
                </div>
              </>
            ) : (
              <div className="no-project">
                <span className="empty-book" aria-hidden="true">M</span>
                <h3 id="workspace-title">{t("project.emptyTitle")}</h3>
                <p>{t("project.emptyBody")}</p>
                <button className="primary-button" type="button" onClick={openCreateDialog}>{t("project.create")}</button>
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

      {dialog && (
        <div
          className="dialog-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDialog(undefined);
          }}
        >
          <section
            className="dialog-card"
            role={dialog.kind === "remove" ? "alertdialog" : "dialog"}
            aria-modal="true"
            aria-labelledby="dialog-title"
            aria-describedby={dialog.kind === "remove" ? "dialog-description" : undefined}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setDialog(undefined);
            }}
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
                  <button type="button" disabled={busy} onClick={() => setDialog(undefined)}>{t("common.cancel")}</button>
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
                  <button type="button" disabled={busy} onClick={() => setDialog(undefined)}>{t("common.cancel")}</button>
                  <button className="primary-button" type="submit" disabled={busy || !draftName.trim()}>{t("common.confirm")}</button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
