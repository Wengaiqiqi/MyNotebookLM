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

export type Section = "research" | "notes" | "studio";

export default function Workspace({ projectId, section, onSectionChange, routes, onOpenSettings, onSourcesChanged }: {
  projectId: string;
  section: Section;
  onSectionChange: (section: Section) => void;
  routes: DefaultModelRoutesDto;
  onOpenSettings: () => void;
  onSourcesChanged?: () => void;
}) {
  const { t } = useTranslation();
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

  return (
    <div className="workspace fade-in">
      {section === "research" && (
        <div className="pane research">
          <SourcesPanel
            projectId={projectId}
            embeddingProfileId={routes.embeddingProfileId}
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
