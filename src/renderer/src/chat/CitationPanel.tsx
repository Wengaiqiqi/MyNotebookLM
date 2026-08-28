import React, { useEffect, useState } from "react";
import type { CitationDto } from "../../../shared/chat";
import type { DesktopApi } from "../../../shared/ipc";
import { useTranslation } from "react-i18next";
import "../i18n";

type CitationApi = DesktopApi["citations"];
export interface CitationPanelProps {
  citations: CitationDto[];
  selected?: CitationDto | null;
  projectId: string;
  openCitation?: CitationApi["open"];
}

function locatorText(citation: CitationDto, translate: (key: string) => string): string {
  const locator = citation.locator;
  if (locator.kind === "page") return `${translate("chat.ui.page")} ${locator.page}`;
  if (locator.kind === "slide") return `${translate("chat.ui.slide")} ${locator.slide}`;
  if (locator.kind === "sheet") return `${translate("chat.ui.sheet")} ${locator.sheet}`;
  if (locator.kind === "cell") return `${translate("chat.ui.cell")} ${locator.cellRef}`;
  return locator.kind;
}

export default function CitationPanel({ citations, selected, projectId, openCitation = typeof window === "undefined" ? undefined : window.myNotebook?.citations.open }: CitationPanelProps) {
  const { t: translate } = useTranslation();
  const t = (key: string, fallback: string, options?: Record<string, string>) => { const value = options ? translate(key, options) : translate(key); return value === key ? fallback : value; };
  const locatorLabel = (key: string, fallback: string) => { const value = translate(key); return value === key ? fallback : value; };
  const [active, setActive] = useState<CitationDto | null>(selected ?? citations[0] ?? null);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { if (selected) setActive(selected); else if (!active || !citations.some((citation) => citation.id === active.id)) setActive(citations[0] ?? null); setStatus(null); }, [selected, citations, active]);
  async function open(citation: CitationDto): Promise<void> {
    if (!openCitation) return;
    const result = await openCitation({ projectId, citationId: citation.id });
    setStatus(result.ok ? t("chat.ui.opened", "Opened {{kind}}", { kind: result.value.opened }) : t(result.error.messageKey, result.error.messageKey));
  }
  return <aside className="citation-panel" aria-label={t("chat.ui.citationTitle", "Source citations")}>
    <header><h3>{t("chat.ui.citationTitle", "Source citations")}</h3></header>
    {citations.length === 0 ? <p className="citation-empty">{t("chat.ui.citationEmpty", "Citations from answers will appear here.")}</p> : <>
      <div className="citation-index" role="list" aria-label={t("chat.ui.citationTitle", "Source citations")}>{citations.map((citation) => <button key={citation.id} type="button" className={active?.id === citation.id ? "selected" : ""} onClick={() => setActive(citation)}>{citation.label}</button>)}</div>
      <div className="citation-cards">{citations.map((citation) => <article className={`citation-detail${active?.id === citation.id ? " selected" : ""}`} key={citation.id} onClick={() => setActive(citation)}><strong>{citation.label}</strong><span>{citation.sourceDisplayName}</span><small>{citation.sourceKind} · {locatorText(citation, (key) => locatorLabel(key, key.split(".").pop() ?? key))}</small>{citation.quote ? <blockquote>{citation.quote}</blockquote> : null}<button type="button" onClick={() => void open(citation)}>{t("chat.ui.openOriginal", "Open original source")}</button>{status && active?.id === citation.id ? <p role="status">{status}</p> : null}</article>)}</div>
    </>}
  </aside>;
}
