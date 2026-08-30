import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectDto } from "../../../../shared/projects";
import type { AppLanguage, AppTheme } from "../../i18n";
import Icon from "../../ui/Icon";
import { BrandMark } from "../../ui/Icon";
import { formatDate } from "../../lib/format";

export interface SidebarProps {
  projects: ProjectDto[];
  archived: ProjectDto[];
  selectedId?: string | undefined;
  busy: boolean;
  onboarding: boolean;
  language: AppLanguage;
  theme: AppTheme;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMenuAction: (action: "rename" | "archive" | "remove" | "restore" | "retryDelete", project: ProjectDto, trigger: HTMLElement) => void;
  onOpenSettings: () => void;
  settingsActive: boolean;
  onLanguage: (language: AppLanguage) => void;
  onTheme: (theme: AppTheme) => void;
}

interface MenuState {
  project: ProjectDto;
  top: number;
  left: number;
  trigger: HTMLElement;
}

const MENU_WIDTH = 176;
const MENU_GAP = 6;

export default function Sidebar(props: SidebarProps) {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState>();

  const listed = useMemo(() => {
    const source = showArchived ? props.archived : props.projects;
    const needle = filter.trim().toLowerCase();
    return needle ? source.filter((project) => project.name.toLowerCase().includes(needle)) : source;
  }, [props.projects, props.archived, showArchived, filter]);

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); setMenu(undefined); menu.trigger.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menu]);

  function openMenu(project: ProjectDto, trigger: HTMLElement): void {
    if (menu?.project.id === project.id) { setMenu(undefined); return; }
    const rect = trigger.getBoundingClientRect();
    const height = project.archived || project.status !== "active" ? 150 : 114;
    const left = Math.min(Math.max(rect.right - MENU_WIDTH, 8), Math.max(8, window.innerWidth - MENU_WIDTH - 8));
    const top = rect.bottom + MENU_GAP + height <= window.innerHeight - 8
      ? rect.bottom + MENU_GAP
      : Math.max(8, rect.top - MENU_GAP - height);
    setMenu({ project, top, left, trigger });
  }

  function menuAction(action: "rename" | "archive" | "remove" | "restore" | "retryDelete"): void {
    if (!menu) return;
    props.onMenuAction(action, menu.project, menu.trigger);
    setMenu(undefined);
  }

  return (
    <aside className="sidebar" aria-label={t("project.title")}>
      <div className="sidebar-head drag">
        <BrandMark />
        <span className="brand-name">{t("app.name")}</span>
      </div>

      <div className="sidebar-body">
        <button type="button" className="btn-new-project" disabled={props.busy || props.onboarding} onClick={props.onCreate}>
          <Icon name="plus" />
          {t("project.create")}
        </button>

        <div className="project-filter">
          <Icon name="search" />
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("project.search")}
            aria-label={t("project.search")}
          />
        </div>

        <div className="project-list" role="list">
          {listed.map((project) => (
            <div className={`project-item${project.id === props.selectedId ? " selected" : ""}`} role="listitem" key={project.id}>
              <button
                type="button"
                className="project-item-btn"
                aria-current={project.id === props.selectedId ? "page" : undefined}
                disabled={props.busy || props.onboarding}
                onClick={() => props.onSelect(project.id)}
                onDoubleClick={(event) => {
                  if (!project.archived && project.status === "active") {
                    props.onMenuAction("rename", project, event.currentTarget);
                  }
                }}
              >
                <span className="project-icon" aria-hidden="true"><Icon name="book" /></span>
                <span className="project-item-copy">
                  <strong>{project.name}</strong>
                  <small>{formatDate(project.updatedAt, language)}</small>
                </span>
              </button>
              <button
                type="button"
                className="project-menu-trigger"
                aria-label={`${project.name}: ${t("project.menu")}`}
                aria-expanded={menu?.project.id === project.id}
                disabled={props.busy || props.onboarding}
                onClick={(event) => openMenu(project, event.currentTarget)}
              >
                <Icon name="dots" />
              </button>
            </div>
          ))}
          {listed.length === 0 && (
            <p className="empty" style={{ padding: "24px 8px" }}>
              {filter ? t("project.searchEmpty") : showArchived ? t("project.noArchived") : t("project.listEmpty")}
            </p>
          )}
        </div>

        <button type="button" className="sidebar-section-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
          <Icon name="archive" />
          {t("project.archived")}
          <span className="count">{props.archived.length}</span>
        </button>
      </div>

      <footer className="sidebar-foot">
        <button type="button" className="settings-entry" aria-current={props.settingsActive ? "page" : undefined} onClick={props.onOpenSettings}>
          <Icon name="settings" />
          {t("app.settings")}
        </button>
        <div className="sidebar-foot-row" role="group" aria-label={t("common.language")}>
          <button type="button" className="pref-toggle" aria-pressed={language === "zh-CN"} onClick={() => props.onLanguage("zh-CN")}>中文</button>
          <button type="button" className="pref-toggle" aria-pressed={language === "en"} onClick={() => props.onLanguage("en")}>English</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="pref-toggle" aria-pressed={props.theme === "light"} aria-label={t("common.light")} onClick={() => props.onTheme("light")}>
            <Icon name="sun" />
          </button>
          <button type="button" className="pref-toggle" aria-pressed={props.theme === "dark"} aria-label={t("common.dark")} onClick={() => props.onTheme("dark")}>
            <Icon name="moon" />
          </button>
        </div>
      </footer>

      {menu && (
        <>
          <div className="menu-pop-veil" onMouseDown={() => setMenu(undefined)} />
          <div className="menu-pop" role="menu" style={{ top: menu.top, left: menu.left }}>
            {!menu.project.archived && menu.project.status === "active" && (
              <button type="button" role="menuitem" onClick={() => menuAction("archive")}>
                <Icon name="archive" />{t("project.archive")}
              </button>
            )}
            {!menu.project.archived && menu.project.status === "active" && (
              <button type="button" role="menuitem" className="danger" onClick={() => menuAction("remove")}>
                <Icon name="trash" />{t("project.remove")}
              </button>
            )}
            {menu.project.archived && (
              <button type="button" role="menuitem" onClick={() => menuAction("restore")}>
                <Icon name="restore" />{t("project.restore")}
              </button>
            )}
            {menu.project.status === "delete_failed" && (
              <>
                <button type="button" role="menuitem" onClick={() => menuAction("retryDelete")}>
                  <Icon name="retry" />{t("project.retryDelete")}
                </button>
                <button type="button" role="menuitem" onClick={() => menuAction("restore")}>
                  <Icon name="restore" />{t("project.restore")}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
