import React, { useState } from "react";
import type { ProjectDto } from "../../../shared/projects";
import type { DefaultModelRoutesDto } from "../../../shared/models";
import SourcePanel from "../sources/SourcePanel";

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
  const [importOpen, setImportOpen] = useState(false); const importTriggerRef = React.useRef<HTMLButtonElement>(null);
  const sourcesApi = typeof window !== "undefined" ? window.myNotebook?.sources : undefined;
  const tasksApi = typeof window !== "undefined" ? window.myNotebook?.tasks : undefined;
  const canImport = Boolean(project && sourcesApi && tasksApi);
  const sourceLabels = {
    title: props.sourcesLabel, add: props.importSources, empty: props.noSourcesTitle, remove: "Remove", selected: "Selected", file: "Choose files", url: "Import URL", webAddress: "Web address", formats: "PDF, DOCX, PPTX, XLSX, TXT, Markdown, URL, CSV", importing: "Importing…", error: "Import failed", indexed: "Indexed", pending: "Pending", importCancel: "Cancel", openSettings: props.openSettingsLabel,
    cancel: "Cancel", retry: "Retry", completed: "Completed", failed: "Failed", queued: "Queued", running: "Running", cancelled: "Cancelled", validating: "Validating", staging: "Staging", parsing: "Parsing", chunking: "Chunking", embedding: "Embedding", indexing: "Indexing", verifying: "Verifying", cleanup: "Cleaning up", finalizing: "Finalizing", preparing: "Preparing", generating: "Generating", saving: "Saving", ...props.sourceActionLabels
  };
  return <main className="workspace project-view" aria-label="Project workspace">
    <header className="workspace-header title-drag-region"><div><span className="eyebrow">{props.appName}</span><h2>{project?.name ?? props.emptyTitle}</h2></div></header>
    <div className="workspace-grid">
      <section className="research-canvas" aria-labelledby="workspace-title">
        {project ? <>
          <div className="workspace-empty"><h3 id="workspace-title">{props.workspaceTitle}</h3>
            <div className="import-region" aria-label={props.importSources}><span className="document-icon" aria-hidden="true">◇</span><p>{props.sourceImportUnavailable}</p>
              <button ref={importTriggerRef} type="button" disabled={!canImport} title={!canImport ? props.sourceImportUnavailable : undefined} onClick={() => canImport ? setImportOpen(true) : props.onOpenSettings}>{props.importSources}</button>
              <div className="format-grid">{["PDF", "DOCX", "PPTX", "XLSX", "TXT", "Markdown", "URL", "CSV"].map((format) => canImport ? <span className="format-choice" key={format}>{format}</span> : <button className="format-choice" type="button" disabled key={format}>{format}</button>)}</div>
            </div>
            <div className="guidance-card"><span aria-hidden="true">◎</span><p>{props.chatUnavailable}</p>{!routes.generationProfileId && <button type="button" onClick={props.onOpenSettings}>{props.openSettingsLabel}</button>}</div>
          </div>
          <div className="composer" aria-label={props.askLabel}><button className="model-pill" type="button" disabled={Boolean(routes.generationProfileId)} onClick={props.onOpenSettings}>{routes.generationProfileId ? "NotebookLM⌄" : props.openSettingsLabel}</button><button className="ask-button" type="button" disabled={Boolean(routes.generationProfileId)} onClick={props.onOpenSettings}>{routes.generationProfileId ? props.askLabel : props.openSettingsLabel}</button><span>{props.chatUnavailable}</span></div>
        </> : <div className="no-project"><span className="empty-book" aria-hidden="true">M</span><h3 id="workspace-title">{props.emptyTitle}</h3><p>{props.emptyBody}</p><button className="primary-button" type="button" disabled={props.busy} onClick={(event) => props.onCreate(event.currentTarget)}>{props.createLabel}</button></div>}
      </section>
      {canImport ? <SourcePanel projectId={project!.id} sourcesApi={sourcesApi!} tasksApi={tasksApi!} labels={sourceLabels} importOpen={importOpen} onImportOpen={() => setImportOpen(true)} onImportClose={() => setImportOpen(false)} onOpenSettings={props.onOpenSettings} importTriggerRef={importTriggerRef} /> : <aside className="sources-panel" aria-label={props.sourcesLabel}><header><h3>{props.sourcesLabel}</h3><button type="button" disabled aria-label={props.importSources} title={props.sourceImportUnavailable} onClick={props.onOpenSettings}>＋</button></header><div className="sources-empty"><span aria-hidden="true">□＋</span><strong>{props.noSourcesTitle}</strong><p>{props.noSourcesBody}</p></div></aside>}
    </div>
  </main>;
}
