import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DefaultModelRoutesDto } from "../../../../shared/models";
import type { SourceDto } from "../../../../shared/sources";
import Icon from "../../ui/Icon";
import ChatPane from "../chat/ChatPane";
import SourcesPanel from "../sources/SourcesPanel";
import NotesPane from "../notes/NotesPane";
import StudioPane from "../studio/StudioPane";
import { useTaskFeed } from "../../hooks/useTaskFeed";

type Section = "research" | "notes" | "studio";

export default function Workspace({ projectId, projectName, routes, onOpenSettings, onSourcesChanged }: {
  projectId: string;
  projectName: string;
  routes: DefaultModelRoutesDto;
  onOpenSettings: () => void;
  onSourcesChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("research");
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [sourcesVersion, setSourcesVersion] = useState(0);

  const tasks = useTaskFeed(projectId, window.myNotebook.tasks?.subscribe, window.myNotebook.tasks?.list);

  const refreshSources = useCallback(async () => {
    try {
      setSources((await window.myNotebook.sources?.list({ projectId })) ?? []);
    } catch { /* transient; panel shows its own state */ }
  }, [projectId]);

  useEffect(() => { void refreshSources(); }, [refreshSources, sourcesVersion]);

  const settled = tasks.some((task) => task.state === "completed" || task.state === "failed" || task.state === "cancelled");
  useEffect(() => {
    if (settled) {
      void refreshSources();
      onSourcesChanged?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const sections: Array<{ id: Section; icon: React.ComponentProps<typeof Icon>["name"]; label: string }> = [
    { id: "research", icon: "chat", label: t("workspace.research") },
    { id: "notes", icon: "notes", label: t("notes.titlePage") },
    { id: "studio", icon: "sparkle", label: t("workspace.studio") }
  ];

  return (
    <div className="workspace fade-in">
      <header className="workspace-head">
        <div style={{ minWidth: 0 }}>
          <h1>{projectName}</h1>
          <p className="sub">{t("workspace.subtitle")}</p>
        </div>
        <span className="spacer" />
        <nav className="tabs" role="tablist" aria-label={t("project.sections")}>
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              onClick={() => setSection(item.id)}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {section === "research" && (
        <div className="pane research">
          <SourcesPanel
            projectId={projectId}
            onImported={() => { setSourcesVersion((value) => value + 1); onSourcesChanged?.(); }}
            onOpenSettings={onOpenSettings}
          />
          <ChatPane
            projectId={projectId}
            generationProfileId={routes.generationProfileId}
            sources={sources}
            onOpenSettings={onOpenSettings}
            onImport={() => setSourcesVersion((value) => value + 1)}
          />
        </div>
      )}
      {section === "notes" && <NotesPane projectId={projectId} />}
      {section === "studio" && <StudioPane projectId={projectId} />}
    </div>
  );
}
