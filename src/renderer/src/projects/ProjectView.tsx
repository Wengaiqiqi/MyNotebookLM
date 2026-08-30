import React, { useState } from "react";
import type { ProjectDto } from "../../../shared/projects";
import type { DefaultModelRoutesDto } from "../../../shared/models";
import SourcePanel from "../sources/SourcePanel";
import ChatView from "../chat/ChatView";
import NotesView from "../notes/NotesView";
import TransformationView from "../transformations/TransformationView";
import { useTranslation } from "react-i18next";

export type ProjectViewProps = {
  appName: string; project?: ProjectDto | undefined; routes: DefaultModelRoutesDto; busy: boolean;
  workspaceTitle: string; emptyTitle: string; emptyBody: string; createLabel: string;
  sourceImportUnavailable: string; importSources: string; chatUnavailable: string;
  sourcesLabel: string; noSourcesTitle: string; noSourcesBody: string; askLabel: string;
  sourceActionLabels?: Partial<{ remove: string; selected: string; file: string; url: string; webAddress: string; formats: string; importing: string; error: string; errorMessages: Record<string, string>; indexed: string; pending: string; importCancel: string; cancel: string; retry: string; completed: string; failed: string; queued: string; running: string; cancelled: string; validating: string; staging: string; parsing: string; chunking: string; embedding: string; indexing: string; verifying: string; cleanup: string; finalizing: string; preparing: string; generating: string; saving: string }>;
  openSettingsLabel: string; onOpenSettings: () => void; onCreate: (target: HTMLButtonElement) => void;
};

export default function ProjectView(props: ProjectViewProps) {
  const { project, routes } = props;
  const { t } = useTranslation();
  const [section, setSection] = useState<"research" | "notes" | "transformations">("research");
  const [importOpen, setImportOpen] = useState(false); const [sourceRefreshKey, setSourceRefreshKey] = useState(0); const importTriggerRef = React.useRef<HTMLButtonElement>(null);
  const sourcesApi = typeof window !== "undefined" ? window.myNotebook?.sources : undefined;
  const tasksApi = typeof window !== "undefined" ? window.myNotebook?.tasks : undefined;
  const canImport = Boolean(project && sourcesApi && tasksApi);
  const canRenderChat = Boolean(project && canImport && routes.generationProfileId);
  const sourceLabels = {
    title: props.sourcesLabel, add: props.importSources, empty: props.noSourcesTitle, remove: "Remove", selected: "Selected", file: "Choose files", url: "Import URL", webAddress: "Web address", formats: "PDF, DOCX, PPTX, XLSX, TXT, Markdown, URL, CSV", importing: "Importing…", error: "Import failed", indexed: "Indexed", pending: "Pending", complete: "Processing complete", importCancel: "Cancel", openSettings: props.openSettingsLabel,
    cancel: "Cancel", retry: "Retry", completed: "Completed", failed: "Failed", queued: "Queued", running: "Running", cancelled: "Cancelled", validating: "Validating", staging: "Staging", parsing: "Parsing", chunking: "Chunking", embedding: "Embedding", indexing: "Indexing", verifying: "Verifying", cleanup: "Cleaning up", finalizing: "Finalizing", preparing: "Preparing", generating: "Generating", saving: "Saving", ...props.sourceActionLabels
  };
  return <main className={`workspace project-view section-${section}`} aria-label="Project workspace">
    <header className="workspace-header title-drag-region"><div><h2>{project?.name ?? props.emptyTitle}</h2>{project && <p className="workspace-subtitle">{t("chat.ui.projectSubtitle", "Research and answers grounded in your sources")}</p>}</div>{project && <nav className="project-section-tabs title-no-drag" aria-label={t("project.sections", "Project sections")} role="tablist"><button type="button" role="tab" aria-selected={section === "research"} aria-current={section === "research" ? "page" : undefined} onClick={() => setSection("research")}>{t("chat.ui.research", "Research")}</button><button type="button" role="tab" aria-selected={section === "notes"} aria-current={section === "notes" ? "page" : undefined} onClick={() => setSection("notes")}>{t("notes.titlePage", "Notes")}</button><button type="button" role="tab" aria-selected={section === "transformations"} aria-current={section === "transformations" ? "page" : undefined} onClick={() => setSection("transformations")}>{t("transformations.title", "Transformations")}</button></nav>}</header>
    {project && section === "notes" ? <NotesView projectId={project.id} /> : project && section === "transformations" ? <TransformationView projectId={project.id} /> : <div className={`workspace-grid${canRenderChat ? " chat-enabled" : ""}`}>
      <section className={`research-canvas${canRenderChat ? " chat-enabled" : ""}`} aria-labelledby="workspace-title">
        {project ? <>
          {canRenderChat ? <ChatView projectId={project!.id} routes={routes} sourceRefreshKey={sourceRefreshKey} onOpenSettings={props.onOpenSettings} onImportSources={() => setImportOpen(true)} onRebuildIndex={props.onOpenSettings} /> : <>
          <div className="workspace-empty"><h3 id="workspace-title">{props.workspaceTitle}</h3>
            <div className="import-region" aria-label={props.importSources}><span className="document-icon" aria-hidden="true">◇</span><p>{props.sourceImportUnavailable}</p>
              <button ref={importTriggerRef} type="button" onClick={() => canImport ? setImportOpen(true) : props.onOpenSettings}>{props.importSources}</button>
              <div className="format-grid">{["PDF", "DOCX", "PPTX", "XLSX", "TXT", "Markdown", "URL", "CSV"].map((format) => <span className="format-choice" key={format}>{format}</span>)}</div>
            </div>
            <div className="guidance-card"><span aria-hidden="true">◎</span><p>{props.chatUnavailable}</p>{!routes.generationProfileId && <button type="button" onClick={props.onOpenSettings}>{props.openSettingsLabel}</button>}</div>
          </div>
          <div className="composer" aria-label={props.askLabel}><button className="model-pill" type="button" onClick={props.onOpenSettings}>{routes.generationProfileId ? "NotebookLM⌄" : props.openSettingsLabel}</button><button className="ask-button" type="button" onClick={props.onOpenSettings}>{routes.generationProfileId ? props.askLabel : props.openSettingsLabel}</button><span>{props.chatUnavailable}</span></div>
          </>}
        </> : <div className="no-project"><span className="empty-book" aria-hidden="true">M</span><h3 id="workspace-title">{props.emptyTitle}</h3><p>{props.emptyBody}</p><button className="primary-button" type="button" disabled={props.busy} onClick={(event) => props.onCreate(event.currentTarget)}>{props.createLabel}</button></div>}
      </section>
      {canImport ? <SourcePanel projectId={project!.id} sourcesApi={sourcesApi!} tasksApi={tasksApi!} labels={sourceLabels} importOpen={importOpen} onImportOpen={() => setImportOpen(true)} onImportClose={() => setImportOpen(false)} onImported={() => setSourceRefreshKey((value) => value + 1)} onOpenSettings={props.onOpenSettings} importTriggerRef={importTriggerRef} /> : <aside className="sources-panel" aria-label={props.sourcesLabel}><header><h3>{props.sourcesLabel}</h3><button type="button" aria-label={props.importSources} onClick={props.onOpenSettings}>＋</button></header><div className="sources-empty"><span aria-hidden="true">□＋</span><strong>{props.noSourcesTitle}</strong><p>{props.noSourcesBody}</p></div></aside>}
    </div>}
  </main>;
}
