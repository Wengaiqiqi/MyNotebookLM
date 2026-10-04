import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import MindElixir, { type NodeObj, type Topic } from "mind-elixir";
import "mind-elixir/style";
import { flattenMindMap, mindMapPath, type MindMapDocument, type MindMapNode, type MindMapView } from "../../../../shared/mindmaps";

export interface MindMapCanvasHandle {
  fit(): void;
  zoom(delta: number): void;
  collapse(all: boolean): void;
  focus(id: string, focused: boolean): void;
  capture(): Partial<MindMapView>;
  exportSvg(): Blob | undefined;
  exportPng(): Promise<Blob | null>;
}

function pan(me: MindElixir): { panX: number; panY: number } {
  const match = me.map.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
  return { panX: Number(match?.[1] ?? 0), panY: Number(match?.[2] ?? 0) };
}

const MindMapCanvas = forwardRef<MindMapCanvasHandle, {
  document: MindMapDocument; initialView: MindMapView;
  onSelect: (id: string) => void; onViewChange: (view: Partial<MindMapView>) => void; label: string;
}>(function MindMapCanvas({ document, initialView, onSelect, onViewChange, label }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<MindElixir | null>(null);
  const callbacks = useRef({ onSelect, onViewChange });
  callbacks.current = { onSelect, onViewChange };
  const focusState = useRef({ id: initialView.selectedNodeId ?? document.root.id, focused: initialView.focused });
  const quiet = useRef(false);
  const applyFocus = (): void => {
    const me = instance.current;
    if (!me) return;
    const state = focusState.current;
    const path = mindMapPath(document.root, state.id);
    const ids = new Set(path.map((node) => node.id));
    const selected = path.at(-1);
    if (selected) flattenMindMap(selected).forEach((node) => ids.add(node.id));
    for (const topic of me.el.querySelectorAll<Topic>("me-tpc")) {
      const id = topic.nodeObj.id;
      topic.classList.toggle("mm-dim", state.focused && !ids.has(id));
      topic.classList.toggle("mm-active", id === state.id);
      topic.setAttribute("role", "button");
      topic.setAttribute("tabindex", "0");
      topic.setAttribute("aria-label", topic.nodeObj.topic);
      topic.setAttribute("aria-pressed", String(id === state.id));
    }
    const color = getComputedStyle(me.el).getPropertyValue("--accent").trim() || "#166a5c";
    const visit = (node: NodeObj): void => {
      node.branchColor = !state.focused || ids.has(node.id) ? color : `${color}35`;
      node.children?.forEach(visit);
    };
    visit(me.nodeData);
    me.linkDiv();
  };
  const capture = (): Partial<MindMapView> => {
    const me = instance.current;
    if (!me) return {};
    const collapsedIds: string[] = [];
    const visit = (node: NodeObj): void => { if (node.children?.length && node.expanded === false) collapsedIds.push(node.id); node.children?.forEach(visit); };
    visit(me.nodeData);
    return { scale: me.scaleVal, ...pan(me), collapsedIds };
  };
  const notify = (): void => { if (!quiet.current) callbacks.current.onViewChange(capture()); };

  useImperativeHandle(ref, () => ({
    fit: () => { instance.current?.scaleFit(); notify(); },
    zoom: (delta) => { const me = instance.current; if (me) me.scale(Math.min(3, Math.max(0.001, me.scaleVal + delta))); notify(); },
    collapse: (all) => {
      const me = instance.current;
      if (!me) return;
      const visit = (node: NodeObj): void => { node.expanded = node.id === document.root.id || !all; node.children?.forEach(visit); };
      visit(me.nodeData); me.refresh(me.getData()); applyFocus(); me.scaleFit(); notify();
    },
    focus: (id, focused) => {
      const me = instance.current;
      focusState.current = { id, focused };
      if (me) {
        quiet.current = true;
        if (focused) {
          const path = mindMapPath(document.root, id);
          const ancestors = new Set(path.slice(0, -1).map((node) => node.id));
          let changed = false;
          const expand = (node: NodeObj): void => { if (ancestors.has(node.id) && node.expanded === false) { node.expanded = true; changed = true; } node.children?.forEach(expand); };
          expand(me.nodeData);
          if (changed) me.refresh(me.getData());
        }
        const topic = [...me.el.querySelectorAll<Topic>("me-tpc")].find((item) => item.nodeObj.id === id);
        if (topic) me.selectNode(topic);
        quiet.current = false;
      }
      applyFocus(); notify();
    },
    capture,
    exportSvg: () => instance.current?.exportSvg(),
    exportPng: async () => await instance.current?.exportPng() ?? null
  }));

  useEffect(() => {
    if (!host.current) return;
    quiet.current = true;
    const collapsed = new Set(initialView.collapsedIds);
    const nodeData = (node: MindMapNode, depth: number): NodeObj => ({
      id: node.id, topic: node.title, expanded: node.id === document.root.id || !collapsed.has(node.id),
      style: { fontSize: depth === 0 ? "20px" : depth === 1 ? "17px" : "16px", fontWeight: depth < 2 ? "600" : "400" },
      children: node.children.map((child) => nodeData(child, depth + 1))
    });
    const theme = getComputedStyle(host.current);
    const me = new MindElixir({ el: host.current, direction: MindElixir.RIGHT, editable: false,
      contextMenu: false, toolBar: false, keypress: false, allowUndo: false, alignment: "nodes", scaleMin: 0.001, scaleMax: 3,
      handleWheel: (event) => {
        event.preventDefault();
        const current = instance.current;
        if (!current || !event.deltaY) return;
        const pixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? current.container.clientHeight : 1);
        const factor = Math.exp(Math.max(-0.2, Math.min(0.2, -pixels * 0.001)));
        current.scale(Math.min(current.scaleMax, Math.max(current.scaleMin, current.scaleVal * factor)),
          { x: event.clientX, y: event.clientY });
      },
      theme: { name: "MyNotebookLM", palette: [theme.getPropertyValue("--accent").trim()], cssVar: {
        "--bgcolor": "transparent", "--color": theme.getPropertyValue("--ink").trim(),
        "--main-color": theme.getPropertyValue("--accent").trim(), "--main-bgcolor": theme.getPropertyValue("--accent-soft").trim(),
        "--root-bgcolor": theme.getPropertyValue("--accent").trim(), "--root-color": "#ffffff",
        "--root-radius": "16px", "--main-radius": "12px", "--selected": theme.getPropertyValue("--accent").trim(),
        "--node-gap-x": "32px", "--node-gap-y": "6px", "--main-gap-x": "65px", "--main-gap-y": "18px", "--map-padding": "36px 48px"
      } }
    });
    instance.current = me;
    const failure = me.init({ nodeData: nodeData(document.root, 0) });
    if (failure) throw failure;
    me.bus.addListener("selectNodes", (nodes) => {
      if (quiet.current || !nodes[0]) return;
      focusState.current = { id: nodes[0].id, focused: true };
      applyFocus(); callbacks.current.onSelect(nodes[0].id);
    });
    me.bus.addListener("scale", notify);
    me.bus.addListener("move", notify);
    me.bus.addListener("expandNode", () => { applyFocus(); notify(); });
    const key = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target.closest("me-tpc") as Topic | null : null;
      if (target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); me.selectNode(target); }
    };
    me.el.addEventListener("keydown", key);
    applyFocus();
    const frame = requestAnimationFrame(() => {
      if (initialView.panX || initialView.panY || initialView.selectedNodeId) {
        me.scale(initialView.scale);
        const current = pan(me);
        me.move(initialView.panX - current.panX, initialView.panY - current.panY);
      } else me.scaleFit();
      applyFocus(); quiet.current = false; notify();
    });
    const observer = new ResizeObserver(() => { me.layout(); applyFocus(); });
    observer.observe(host.current);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      me.el.removeEventListener("keydown", key); me.destroy(); instance.current = null;
    };
  }, [document]);
  return <div className="mindmap-canvas" ref={host} role="region" aria-label={label} />;
});
export default MindMapCanvas;
