import React, { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useTranslation } from "react-i18next";
import type { CitationImagePreview, CitationSheetPreview } from "../../../../shared/ipc";
import type { SourceKind, SourceLocator } from "../../../../shared/sources";

export default function SourcePreview({ kind, data, text, locator, sheet, images = [] }: {
  kind: SourceKind;
  data: Uint8Array | null;
  text: string | null;
  locator: SourceLocator;
  sheet: CitationSheetPreview | null;
  images?: CitationImagePreview[];
}) {
  if (kind === "pdf" && data) return <PdfPreview data={data} page={locator.kind === "page" ? locator.page : 1} />;
  if (kind === "xlsx" && sheet) return <WorkbookPreview sheet={sheet} locator={locator} />;
  if (kind === "docx" && (sheet || images.length)) return <DocumentPreview table={sheet} images={images} text={text} />;
  return <TextPreview text={text} />;
}

function PdfPreview({ data, page }: { data: Uint8Array; page: number }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(page);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let destroyLoading: (() => Promise<void>) | undefined;
    setDocument(null);
    setRendered(false);
    setFailed(false);
    setPageNumber(page);
    void Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")
    ]).then(([pdf, worker]) => {
      if (!alive) return;
      pdf.GlobalWorkerOptions.workerSrc = worker.default;
      const loading = pdf.getDocument({ data: data.slice() });
      destroyLoading = () => loading.destroy();
      return loading.promise;
    }).then((next) => {
      if (!alive || !next) return;
      setDocument(next);
      setPageNumber(Math.min(Math.max(1, page), next.numPages));
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; void destroyLoading?.(); };
  }, [data, page]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let renderTask: RenderTask | undefined;
    let cancelled = false;
    setRendered(false);
    void document.getPage(pageNumber).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const viewport = pdfPage.getViewport({ scale: 1.5 });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0]
      });
      return renderTask.promise;
    }).then(() => { if (!cancelled) setRendered(true); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, pageNumber]);

  if (failed) return <p className="citation-source-empty">{t("chat.ui.sourceExcerptUnavailable")}</p>;
  return (
    <div className="citation-pdf">
      <div className="citation-pdf-page">
        <canvas ref={canvasRef} role="img" aria-label={t("chat.ui.sourceExcerptTitle")} aria-busy={!rendered} />
      </div>
    </div>
  );
}

function WorkbookPreview({ sheet, locator }: { sheet: CitationSheetPreview; locator: SourceLocator }) {
  return <div className="citation-workbook"><SheetTable sheet={sheet} locator={locator} /></div>;
}

function DocumentPreview({ table, images, text }: { table: CitationSheetPreview | null; images: CitationImagePreview[]; text: string | null }) {
  const looseImages = images.filter((image) => !image.cellRef);
  return (
    <div className="citation-document">
      {table ? (
        <table className="citation-document-table">
          <colgroup>{table.columns.map((column) => <col key={column.number} style={{ width: column.width }} />)}</colgroup>
          <tbody>{table.rows.map((row) => (
            <tr key={row.number}>{row.cells.map((cell) => {
              const cellImages = images.filter((image) => image.cellRef === `${columnName(cell.column)}${row.number}`);
              return <td key={cell.column} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={cell.style}>
                {cell.text}{cellImages.map((image, index) => <DocumentImage key={index} image={image} />)}
              </td>;
            })}</tr>
          ))}</tbody>
        </table>
      ) : <TextPreview text={text} />}
      {looseImages.length > 0 && <div className="citation-document-images">{looseImages.map((image, index) => <DocumentImage key={index} image={image} />)}</div>}
    </div>
  );
}

function DocumentImage({ image }: { image: CitationImagePreview }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([image.data.slice()], { type: image.mimeType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image]);
  return url ? <img className="citation-document-image" src={url} alt={image.altText || t("chat.ui.sourceExcerptTitle")} /> : null;
}

function SheetTable({ sheet, locator }: { sheet: CitationSheetPreview; locator: SourceLocator }) {
  const targetRef = useRef<HTMLTableCellElement>(null);
  const sameSheet = !(locator.kind === "sheet" || locator.kind === "cell" || locator.kind === "row") || locator.sheet === sheet.name;
  useEffect(() => {
    targetRef.current?.scrollIntoView?.({ block: "center", inline: "center" });
  }, [locator, sheet.name]);

  return (
    <div className="citation-sheet-scroll" data-rows={sheet.rows.length} data-columns={sheet.columns.length}>
      <table className="citation-sheet">
        <colgroup><col className="citation-row-number" />{sheet.columns.map((column) => <col key={column.number} style={{ width: column.width }} />)}</colgroup>
        <thead><tr><th aria-hidden="true" />{sheet.columns.map((column) => <th key={column.number}>{columnName(column.number)}</th>)}</tr></thead>
        <tbody>
          {sheet.rows.map((row) => (
              <tr key={row.number} style={row.height ? { height: row.height } : undefined}>
                <th scope="row">{row.number}</th>
                {row.cells.map((cell) => {
                  if (cell.covered) return null;
                  const address = `${columnName(cell.column)}${row.number}`;
                  const target = sameSheet && (
                    (locator.kind === "cell" && locator.cellRef.toUpperCase() === address) ||
                    (locator.kind === "row" && row.number >= locator.startRow && row.number <= locator.endRow)
                  );
                  return (
                    <td
                      key={cell.column}
                      ref={target && (locator.kind !== "row" || cell.column === 1) ? targetRef : undefined}
                      colSpan={cell.colSpan}
                      rowSpan={cell.rowSpan}
                      className={target ? "citation-sheet-target" : undefined}
                      style={cell.style}
                      title={cell.formula ? `=${cell.formula}` : undefined}
                    >{cell.text}</td>
                  );
                })}
              </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function columnName(column: number): string {
  let name = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function TextPreview({ text }: { text: string | null }) {
  const { t } = useTranslation();
  return text
    ? <div className="citation-source-text">{text.split(/\r?\n\s*\r?\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    : <p className="citation-source-empty">{t("chat.ui.sourceExcerptUnavailable")}</p>;
}
