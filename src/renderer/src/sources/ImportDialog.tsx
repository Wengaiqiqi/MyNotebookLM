import React, { useEffect, useRef, useState } from "react";
import type { Result } from "../../../shared/app-errors";
import type { SourceDto } from "../../../shared/sources";
import ModalRoot from "../app/ModalRoot";

type ImportResult = Result<SourceDto>;
type Props = {
  projectId: string; open: boolean;
  chooseFiles: (input: { projectId: string }) => Promise<string[] | null>;
  importFile: (input: { projectId: string; dialogToken: string }) => Promise<ImportResult>;
  importUrl: (input: { projectId: string; url: string }) => Promise<ImportResult>;
  onClose: () => void; onImported?: () => void;
  labels?: Partial<{ title: string; file: string; url: string; urlLabel: string; cancel: string; importing: string; import: string; formats: string; error: string }>;
};

export default function ImportDialog({ projectId, open, chooseFiles, importFile, importUrl, onClose, onImported, labels: supplied }: Props) {
  const labels = { title: "Import sources", file: "Choose files", url: "Import URL", urlLabel: "Web address", cancel: "Cancel", importing: "Importing…", import: "Import", formats: "PDF, DOCX, PPTX, XLSX, TXT, Markdown, URL, CSV", error: "Import failed", ...supplied };
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    cardRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(cardRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [])];
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) cardRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", containFocus);
    return () => { document.removeEventListener("keydown", handleKey); document.removeEventListener("focusin", containFocus); };
  }, [open, busy, onClose]);
  if (!open) return null;
  async function importFiles(): Promise<void> {
    setBusy(true); setError("");
    try {
      const tokens = await chooseFiles({ projectId });
      if (!tokens) return;
      for (const dialogToken of tokens) {
        const result = await importFile({ projectId, dialogToken });
        if (!result.ok) { setError(result.error.messageKey); return; }
      }
      onImported?.(); onClose();
    } catch { setError(labels.error); } finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await importUrl({ projectId, url: url.trim() });
      if (!result.ok) { setError(result.error.messageKey); return; }
      onImported?.(); onClose();
    } catch { setError(labels.error); } finally { setBusy(false); }
  }
  return <ModalRoot><div className="dialog-layer" role="presentation"><section ref={cardRef} className="dialog-card import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
    <h2 id="import-dialog-title">{labels.title}</h2>
    <button type="button" className="outline-button" disabled={busy} onClick={() => void importFiles()}>{busy ? labels.importing : labels.file}</button>
    <p className="format-help">{labels.formats}</p>
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="source-url">{labels.urlLabel}</label>
      <input id="source-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" required disabled={busy} />
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{labels.cancel}</button><button className="primary-button" type="submit" disabled={busy || !url.trim()}>{labels.url}</button></div>
    </form>
  </section></div></ModalRoot>;
}
