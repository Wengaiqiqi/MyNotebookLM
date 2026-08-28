import React from "react";
import type { ProjectDto } from "../../../shared/projects";
import type { DefaultModelRoutesDto } from "../../../shared/models";

export type ProjectViewProps = {
  appName: string; project?: ProjectDto | undefined; routes: DefaultModelRoutesDto; busy: boolean;
  workspaceTitle: string; emptyTitle: string; emptyBody: string; createLabel: string;
  sourceImportUnavailable: string; importSources: string; chatUnavailable: string;
  sourcesLabel: string; noSourcesTitle: string; noSourcesBody: string; askLabel: string;
  openSettingsLabel: string; onOpenSettings: () => void; onCreate: (target: HTMLButtonElement) => void;
};

export default function ProjectView(props: ProjectViewProps) {
  const { project, routes } = props;
  return <main className="workspace project-view" aria-label="Project workspace">
    <header className="workspace-header title-drag-region"><div><span className="eyebrow">{props.appName}</span><h2>{project?.name ?? props.emptyTitle}</h2></div></header>
    <div className="workspace-grid">
      <section className="research-canvas" aria-labelledby="workspace-title">
        {project ? <>
          <div className="workspace-empty"><h3 id="workspace-title">{props.workspaceTitle}</h3>
            <div className="import-region" aria-label={props.importSources}><span className="document-icon" aria-hidden="true">◇</span><p>{props.sourceImportUnavailable}</p>
              {routes.embeddingProfileId ? <button type="button" disabled title={props.sourceImportUnavailable}>{props.importSources}</button> : <button type="button" onClick={props.onOpenSettings}>{props.openSettingsLabel}</button>}
              <div className="format-grid">{["PDF", "DOCX", "PPTX", "XLSX", "TXT", "Markdown", "URL", "CSV"].map((format) => <button className="format-choice" type="button" disabled key={format}>{format}</button>)}</div>
            </div>
            <div className="guidance-card"><span aria-hidden="true">◎</span><p>{props.chatUnavailable}</p>{!routes.generationProfileId && <button type="button" onClick={props.onOpenSettings}>{props.openSettingsLabel}</button>}</div>
          </div>
          <div className="composer" aria-label={props.askLabel}><button className="model-pill" type="button" disabled={Boolean(routes.generationProfileId)} onClick={props.onOpenSettings}>{routes.generationProfileId ? "NotebookLM⌄" : props.openSettingsLabel}</button><button className="ask-button" type="button" disabled={Boolean(routes.generationProfileId)} onClick={props.onOpenSettings}>{routes.generationProfileId ? props.askLabel : props.openSettingsLabel}</button><span>{props.chatUnavailable}</span></div>
        </> : <div className="no-project"><span className="empty-book" aria-hidden="true">M</span><h3 id="workspace-title">{props.emptyTitle}</h3><p>{props.emptyBody}</p><button className="primary-button" type="button" disabled={props.busy} onClick={(event) => props.onCreate(event.currentTarget)}>{props.createLabel}</button></div>}
      </section>
      <aside className="sources-panel" aria-label={props.sourcesLabel}><header><h3>{props.sourcesLabel}</h3><button type="button" disabled={Boolean(routes.embeddingProfileId)} aria-label={routes.embeddingProfileId ? props.importSources : props.openSettingsLabel} onClick={props.onOpenSettings}>＋</button></header><div className="sources-empty"><span aria-hidden="true">□＋</span><strong>{props.noSourcesTitle}</strong><p>{props.noSourcesBody}</p></div></aside>
    </div>
  </main>;
}
