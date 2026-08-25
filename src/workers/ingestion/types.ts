import type { SourceLocator } from "../../shared/sources";

export type DocumentBlockKind =
  | "heading"
  | "paragraph"
  | "table"
  | "list"
  | "sheet-row";

export interface DocumentBlock {
  kind: DocumentBlockKind;
  text: string;
  locator: SourceLocator;
}

export interface PreparedChunk {
  ordinal: number;
  text: string;
  locator: SourceLocator;
  contentHash: string;
  tokenEstimate: number;
}
