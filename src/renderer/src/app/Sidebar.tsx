import React, { type RefObject } from "react";
import type { ProjectDto } from "../../../shared/projects";
import type { AppLanguage, AppTheme } from "../i18n";
import SourceKindIcon from "../sources/SourceKindIcon";

export type SidebarProps = {
  brand?: string; projectTitle?: string; createLabel?: string; archivedLabel?: string; settingsLabel?: string; deletionPendingLabel?: string; undoLabel?: string; settingsErrorLabel?: string; retryLabel?: string;
  language?: AppLanguage; theme?: AppTheme; view?: string; busy?: boolean; projects?: ProjectDto[]; archivedProjects?: ProjectDto[];
  showArchived?: boolean; selectedId?: string | undefined; openMenuId?: string | undefined; deletingProject?: ProjectDto | undefined; error?: string | undefined; errorTarget?: string | undefined;
  onCreate?: (target: HTMLButtonElement) => void; onRetryLoad?: () => void; onToggleArchived?: () => void;
  onUndo?: () => void; onSelect?: (id: string) => void; onMenu?: (id: string, target: HTMLButtonElement) => void;
  onSettings?: () => void; settingsLoadError?: boolean; settingsLoadErrorRef?: RefObject<HTMLDivElement | null>; onRetrySettings?: () => void;
  onLanguage?: (language: AppLanguage) => void; onTheme?: (theme: AppTheme) => void; formatDate?: (value: string) => string;
  menuLabel?: string;
};

export default function Sidebar(props: SidebarProps) {
  const displayed = props.showArchived ? (props.archivedProjects ?? []) : (props.projects ?? []);
  return <aside className="sidebar" aria-label="Projects and navigation">
    <div className="brand title-drag-region"><span className="brand-mark" aria-hidden="true">M</span><span>{props.brand}</span></div>
    <nav className="project-nav" aria-label={props.projectTitle}>
      <h1>{props.projectTitle}</h1>
      <button className="primary-button create-button title-no-drag" type="button" disabled={props.busy || props.view !== "projects"} onClick={(e) => props.onCreate?.(e.currentTarget)}><span aria-hidden="true">＋</span>{props.createLabel}</button>
      {props.errorTarget === "load" && <div className="inline-error load-error" role="alert"><span>{props.error}</span><button type="button" disabled={props.busy} aria-label={props.error} onClick={props.onRetryLoad}>↻</button></div>}
      <button type="button" className="secondary-button" onClick={props.onToggleArchived}><span className="archived-chevron" aria-hidden="true">{props.showArchived ? "⌃" : "⌄"}</span><span className="archived-label">{props.archivedLabel}</span><span className="archived-list-icon" aria-hidden="true">☷</span></button>
      {props.deletingProject && <div className="inline-error" role="status"><span>{props.deletionPendingLabel}</span><button type="button" onClick={props.onUndo}>{props.undoLabel}</button></div>}
      <div className="project-list">{displayed.map((project) => <div className={`project-row${project.id === props.selectedId ? " selected" : ""}`} key={project.id}>
        <button className="project-select" type="button" aria-current={project.id === props.selectedId ? "page" : undefined} disabled={props.busy} onClick={() => props.onSelect?.(project.id)}><SourceKindIcon kind="text" className="project-icon document-icon-small" /><span className="project-copy"><strong>{project.name}</strong><small>{props.formatDate?.(project.updatedAt)}</small></span></button>
        <button className="menu-trigger" type="button" aria-label={`${project.name}: ${props.menuLabel}`} aria-expanded={props.openMenuId === project.id} aria-controls={props.openMenuId === project.id ? `project-actions-${project.id}` : undefined} disabled={props.busy} onClick={(e) => props.onMenu?.(project.id, e.currentTarget)}>•••</button>
      </div>)}</div>
    </nav>
    <footer className="sidebar-footer">
      <button className="settings-button is-centered" type="button" aria-current={props.view === "settings" ? "page" : undefined} disabled={props.view === "loading"} onClick={props.onSettings}><span aria-hidden="true">⚙</span>{props.settingsLabel}</button>
      {props.settingsLoadError && <div ref={props.settingsLoadErrorRef} className="settings-load-error inline-error" role="alert" tabIndex={-1}><span>{props.settingsErrorLabel}</span><button type="button" onClick={props.onRetrySettings}>{props.retryLabel}</button></div>}
      <div className="preference-row is-centered" role="group" aria-label="Language"><button type="button" aria-pressed={props.language === "zh-CN"} onClick={() => props.onLanguage?.("zh-CN")}>中文</button><span aria-hidden="true">|</span><button type="button" aria-pressed={props.language === "en"} onClick={() => props.onLanguage?.("en")}>EN</button></div>
      <div className="preference-row is-centered" role="group" aria-label="Theme"><button type="button" aria-pressed={props.theme === "light"} onClick={() => props.onTheme?.("light")}>Light</button><span aria-hidden="true">|</span><button type="button" aria-pressed={props.theme === "dark"} onClick={() => props.onTheme?.("dark")}>Dark</button></div>
    </footer>
  </aside>;
}
