import type { CitationImagePreview, CitationSheetPreview } from "../../shared/ipc";
import type { SourceLocator } from "../../shared/sources";
import { previewDocxSource } from "../ingestion/parsers/docx-parser";
import { workbookPreview } from "./workbook-preview";

export type CitationPreviewRequest = { kind: "xlsx" | "docx"; data: Uint8Array; locator: SourceLocator; citedText: string; tableName?: string };
export type CitationPreviewResult = { sheet: CitationSheetPreview | null; images: CitationImagePreview[] };

/** Office previews parse whole archives, so production runs this in a worker thread. */
export async function runCitationPreview(request: CitationPreviewRequest): Promise<CitationPreviewResult> {
  if (request.kind === "xlsx") return { sheet: await workbookPreview(request.data, request.locator), images: [] };
  return previewDocxSource(request.data, request.citedText, request.locator, request.tableName);
}
