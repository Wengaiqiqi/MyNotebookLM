import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CitationDto } from "../../../shared/chat";
import type { DesktopApi } from "../../../shared/ipc";
import { useTranslation } from "react-i18next";
import "../i18n";
import SourceKindIcon from "../sources/SourceKindIcon";

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

function citationIcon(kind: string): React.ReactNode { return <SourceKindIcon kind={kind as Parameters<typeof SourceKindIcon>[0]["kind"]} />; }

export default function CitationPanel({ citations, selected, projectId, openCitation = typeof window === "undefined" ? undefined : window.myNotebook?.citations.open }: CitationPanelProps) {
  const { t: translate } = useTranslation();
  const t = (key: string, fallback: string, options?: Record<string, string>) => { const value = options ? translate(key, options) : translate(key); return value === key ? fallback : value; };
  const locatorLabel = (key: string, fallback: string) => { const value = translate(key); return value === key ? fallback : value; };
  const uniqueCitations = useMemo(() => {
    const seen = new Set<string>();
    return [selected, ...citations].filter((citation): citation is CitationDto => {
      if (!citation || seen.has(citation.label)) return false;
      seen.add(citation.label);
      return true;
    });
  }, [citations, selected]);
  const [activeLabel, setActiveLabel] = useState<string | null>(selected?.label ?? uniqueCitations[0]?.label ?? null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const mountedRef = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { setActiveLabel(selected?.label ?? uniqueCitations[0]?.label ?? null); setStatus(null); }, [selected, uniqueCitations]);
  useEffect(() => { if (!mountedRef.current) { mountedRef.current = true; return; } if (activeLabel) cardRefs.current[activeLabel]?.scrollIntoView?.({ block: "nearest" }); }, [activeLabel]);
  const active = uniqueCitations.find((citation) => citation.label === activeLabel) ?? null;
  async function open(citation: CitationDto): Promise<void> {
    if (!openCitation) return;
    const result = await openCitation({ projectId, citationId: citation.id });
    setStatus(result.ok ? t("chat.ui.opened", "Opened {{kind}}", { kind: result.value.opened }) : t(result.error.messageKey, result.error.messageKey));
  }
  return <aside className="citation-panel" aria-label={t("chat.ui.citationTitle", "Source citations")}>
    <header><h3>{t("chat.ui.citationTitle", "Source citations")}</h3></header>
    {citations.length === 0 ? <p className="citation-empty">{t("chat.ui.citationEmpty", "Citations from answers will appear here.")}</p> : <>
      <div className="citation-cards">{uniqueCitations.map((citation) => <article ref={(node) => { cardRefs.current[citation.label] = node; }} className={`citation-detail${active?.label === citation.label ? " selected" : ""}`} key={citation.label} onClick={() => setActiveLabel(citation.label)}><div className="citation-source-heading"><strong className="citation-badge">{citation.label}</strong><span className={`citation-kind-icon source-kind-icon-${citation.sourceKind}`} aria-hidden="true">{citationIcon(citation.sourceKind)}</span><div><span>{citation.sourceDisplayName}</span><small>{citation.sourceKind} · {locatorText(citation, (key) => locatorLabel(key, key.split(".").pop() ?? key))}</small></div></div>{citation.quote ? <blockquote>{citation.quote}</blockquote> : null}<button type="button" onClick={(event) => { event.stopPropagation(); void open(citation); }}>{t("chat.ui.viewDetails", "View details")}</button>{status && active?.label === citation.label ? <p role="status">{status}</p> : null}</article>)}</div>
    </>}
  </aside>;
}
