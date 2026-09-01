import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentBlock } from "../types";

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }

const QUESTION_HEADING = /(?:第\s*\d+\s*题|Question\s+\d+)(?:\s*[（(][^）)]{1,24}[）)])?/giu;

export function splitPdfQuestions(text: string, page: number): DocumentBlock[] {
  const matches = [...text.matchAll(QUESTION_HEADING)];
  if (matches.length === 0) return [{ kind: "paragraph", text, locator: { kind: "page", page } }];
  const blocks: DocumentBlock[] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index;
    const before = text.slice(cursor, start).trim();
    if (before) blocks.push({ kind: "paragraph", text: before, locator: { kind: "page", page } });
    const heading = normalize(match[0]);
    blocks.push({ kind: "heading", text: heading, locator: { kind: "heading", depth: 1, headingPath: heading } });
    cursor = start + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) blocks.push({ kind: "paragraph", text: rest, locator: { kind: "page", page } });
  return blocks;
}

export async function parsePdf(data: Uint8Array): Promise<DocumentBlock[]> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const blocks: DocumentBlock[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalize(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    blocks.push(...splitPdfQuestions(text, pageNumber));
  }
  return blocks;
}
