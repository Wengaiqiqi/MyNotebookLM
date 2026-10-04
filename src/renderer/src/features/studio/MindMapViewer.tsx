import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { flattenMindMap, mindMapViewSchema, type MindMapDto, type MindMapView } from "../../../../shared/mindmaps";
import Modal from "../../ui/Modal";
import Icon from "../../ui/Icon";
import { toast } from "../../ui/Toast";
import { api } from "../../lib/api";
import { errorText } from "../../lib/format";
import MindMapCanvas, { type MindMapCanvasHandle } from "./MindMapCanvas";
import MindMapNodeChat from "./MindMapNodeChat";

const cachedViews = new Map<string, MindMapView>();

export function downloadMindMap(blob: Blob, title: string, extension: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "mind-map"}.${extension}`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 600_000);
}

export default function MindMapViewer({ projectId, insightId, onClose }: { projectId: string; insightId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [map, setMap] = useState<MindMapDto | null>(null);
  const [view, setView] = useState<MindMapView>(() => cachedViews.get(insightId) ?? mindMapViewSchema.parse({}));
  const viewRef = useRef(view);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const canvas = useRef<MindMapCanvasHandle>(null);
  const exportMenu = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef(Promise.resolve());
  const loaded = useRef(false);

  const flush = useCallback((): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!loaded.current) return;
    const saved = viewRef.current;
    cachedViews.set(insightId, saved);
    saveChain.current = saveChain.current.then(async () => {
      const result = await api().mindmaps.saveView({ projectId, insightId, view: saved });
      if (!result.ok && result.error.code !== "NOT_FOUND") toast.error(errorText(result, t));
    }).catch(() => toast.error(t("errors.internal")));
  }, [projectId, insightId, t]);
  const changeView = useCallback((patch: Partial<MindMapView>): void => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next; setView(next); cachedViews.set(insightId, next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 450);
  }, [insightId, flush]);

  useEffect(() => {
    let alive = true;
    loaded.current = false; setLoadError("");
    void api().mindmaps.get({ projectId, insightId }).then((result) => {
      if (!alive) return;
      if (!result.ok) { setLoadError(errorText(result, t)); return; }
      const saved = cachedViews.get(insightId) ?? result.value.view;
      viewRef.current = saved; setView(saved); setMap({ ...result.value, view: saved }); loaded.current = true;
    }).catch(() => { if (alive) setLoadError(t("errors.internal")); });
    return () => { alive = false; flush(); };
  }, [projectId, insightId, reload, flush, t]);
  useEffect(() => {
    if (!exportOpen) return;
    const outside = (event: MouseEvent): void => { if (event.target instanceof Node && !exportMenu.current?.contains(event.target)) setExportOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [exportOpen]);
  const close = useCallback((): void => {
    if (canvas.current) viewRef.current = { ...viewRef.current, ...canvas.current.capture() };
    flush(); onClose();
  }, [flush, onClose]);
  const nodes = map ? flattenMindMap(map.document.root) : [];
  const selected = nodes.find((node) => node.id === view.selectedNodeId) ?? map?.document.root;
  const references = selected ? map?.references.filter((ref) => selected.refs.includes(ref.chunkId)) ?? [] : [];
  const collapsible = nodes.filter((node) => node !== map?.document.root && node.children.length);
  const allCollapsed = collapsible.length > 0 && collapsible.every((node) => view.collapsedIds.includes(node.id));

  async function exportMap(format: "json" | "svg" | "png"): Promise<void> {
    if (!map || exporting) return;
    setExportOpen(false); setExporting(true);
    try {
      const blob = format === "json" ? new Blob([JSON.stringify(map.document, null, 2)], { type: "application/json" })
        : format === "svg" ? canvas.current?.exportSvg() : await canvas.current?.exportPng();
      if (!blob) throw new Error("Export failed");
      downloadMindMap(blob, map.document.root.title, format);
    } catch { toast.error(t("mindmap.exportFailed")); }
    finally { setExporting(false); }
  }

  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = viewRef.current.panelWidth;
    const element = event.currentTarget;
    const move = (next: PointerEvent): void => {
      changeView({ panelWidth: Math.max(300, Math.min(Math.min(800, window.innerWidth * 0.55), startWidth + startX - next.clientX)) });
    };
    const up = (): void => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", up); element.removeEventListener("pointercancel", up); flush(); };
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", up); element.addEventListener("pointercancel", up);
  };

  return <Modal open wide className="mindmap-dialog" labelledBy="mindmap-title" onClose={close}>
    <header className="mindmap-head">
      <span className="badge mindmap-badge"><Icon name="mindmap" />{t("mindmap.title")}</span>
      <div className="mindmap-title"><h2 id="mindmap-title">{map?.document.root.title ?? t("mindmap.title")}</h2>
        {map && <span className="hint">{t("mindmap.metadata", { sources: map.sourceCount, nodes: map.nodeCount })}</span>}
      </div>
      <div className="mindmap-tools">
        <button type="button" className="btn sm" disabled={!map} onClick={() => canvas.current?.fit()}><Icon name="expand" />{t("mindmap.fit")}</button>
        <button type="button" className="btn sm" disabled={!map} onClick={() => canvas.current?.collapse(!allCollapsed)}><Icon name="layers" />{t(allCollapsed ? "mindmap.expandAll" : "mindmap.collapseAll")}</button>
        <div className="mindmap-export" ref={exportMenu}>
          <button type="button" className="btn sm" disabled={!map || exporting} aria-expanded={exportOpen} onClick={() => setExportOpen((current) => !current)}><Icon name="download" />{t("mindmap.export")}<Icon name="chevron-down" /></button>
          {exportOpen && <div className="mindmap-export-menu" role="menu">{(["png", "svg", "json"] as const).map((format) => <button type="button" role="menuitem" key={format} onClick={() => void exportMap(format)}>{format.toUpperCase()}</button>)}</div>}
        </div>
        <button type="button" className="mindmap-close" aria-label={t("common.close")} onClick={close}><Icon name="close" /><small>Esc</small></button>
      </div>
    </header>
    {!map ? <div className="empty mindmap-loading">{loadError ? <><p role="alert">{loadError}</p><button type="button" className="btn" onClick={() => setReload((current) => current + 1)}>{t("transformations.retry")}</button></> : <span className="spinner" />}</div>
      : <div className="mindmap-layout">
        <div className="mindmap-map">
          <MindMapCanvas ref={canvas} document={map.document} initialView={map.view} label={t("mindmap.title")}
            onSelect={(id) => changeView({ selectedNodeId: id, focused: true })} onViewChange={changeView} />
          {view.focused && selected && <div className="mindmap-focus"><Icon name="target" /><span>{t("mindmap.focused", { name: selected.title })}</span>
            <button type="button" onClick={() => { changeView({ focused: false }); canvas.current?.focus(selected.id, false); canvas.current?.fit(); }}>{t("mindmap.exitFocus")}</button>
          </div>}
          <div className="mindmap-zoom">
            <button type="button" aria-label={t("mindmap.zoomOut")} onClick={() => canvas.current?.zoom(-0.1)}><Icon name="minus" /></button>
            <span>{Math.round(view.scale * 100)}%</span>
            <button type="button" aria-label={t("mindmap.zoomIn")} onClick={() => canvas.current?.zoom(0.1)}><Icon name="plus" /></button>
            <button type="button" aria-label={t("mindmap.fit")} onClick={() => canvas.current?.fit()}><Icon name="target" /></button>
          </div>
        </div>
        <div className="mindmap-divider" role="separator" aria-orientation="vertical" aria-label={t("mindmap.resizePanel")} tabIndex={0} onPointerDown={resize}
          onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); changeView({ panelWidth: Math.max(300, Math.min(800, view.panelWidth + (event.key === "ArrowLeft" ? 20 : -20))) }); } }} />
        <aside className="mindmap-panel" style={{ width: view.panelWidth }}>
          <div className="mindmap-tabs" role="tablist">
            <button type="button" role="tab" id="mindmap-details-tab" aria-controls="mindmap-details" aria-selected={view.tab === "details"} className={view.tab === "details" ? "active" : ""} onClick={() => changeView({ tab: "details" })}>{t("mindmap.nodeDetails")}</button>
            <button type="button" role="tab" id="mindmap-chat-tab" aria-controls="mindmap-chat" aria-selected={view.tab === "chat"} className={view.tab === "chat" ? "active" : ""} onClick={() => { if (selected) { canvas.current?.focus(selected.id, true); changeView({ tab: "chat", selectedNodeId: selected.id, focused: true }); } }}>{t("mindmap.nodeChat")}</button>
          </div>
          {selected && view.tab === "details" && <div className="mindmap-details-panel" role="tabpanel" id="mindmap-details" aria-labelledby="mindmap-details-tab">
            <div className="mindmap-details-scroll">
              <section><h3>{t("mindmap.description")}</h3><p>{selected.summary || t("mindmap.noDescription")}</p></section>
              {selected.keyPoints.length > 0 && <section><h3>{t("mindmap.keyPoints")}</h3><ul>{selected.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul></section>}
              <section><h3>{t("mindmap.evidence")}<small>{t("mindmap.referenceCount", { sources: new Set(references.map((ref) => ref.sourceId)).size, count: references.length })}</small></h3>
                {references.length === 0 && <p className="hint">{t("mindmap.noReferences")}</p>}
                {references.map((reference, index) => <article className="mindmap-reference" key={reference.chunkId}>
                  <div className="mindmap-reference-head"><span className="citation-num">{index + 1}</span><Icon name="file" /><strong title={reference.sourceTitle}>{reference.sourceTitle}</strong>
                    <button type="button" onClick={() => void api().mindmaps.openReference({ projectId, insightId, nodeId: selected.id, chunkId: reference.chunkId }).then((result) => { if (!result.ok) toast.error(errorText(result, t)); }).catch(() => toast.error(t("errors.internal")))}>{t("mindmap.viewOriginal")}<Icon name="open" /></button>
                  </div>
                  {reference.locatorSummary && <small className="hint">{reference.locatorSummary}</small>}
                  <blockquote>{reference.text}</blockquote>
                </article>)}
              </section>
            </div>
            <div className="mindmap-details-foot"><button type="button" className="btn primary" onClick={() => { canvas.current?.focus(selected.id, true); changeView({ tab: "chat", selectedNodeId: selected.id, focused: true }); }}><Icon name="chat" />{t("mindmap.askNode")}</button></div>
          </div>}
          {selected && view.tab === "chat" && <div className="mindmap-chat-panel" role="tabpanel" id="mindmap-chat" aria-labelledby="mindmap-chat-tab">
            <MindMapNodeChat key={`${insightId}:${selected.id}`} projectId={projectId} insightId={insightId} node={selected} />
          </div>}
        </aside>
      </div>}
  </Modal>;
}
