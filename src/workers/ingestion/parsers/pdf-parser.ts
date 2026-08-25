import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentBlock } from "../types";

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }

export async function parsePdf(data: Uint8Array): Promise<DocumentBlock[]> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const blocks: DocumentBlock[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalize(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    blocks.push({ kind: "paragraph", text, locator: { kind: "page", page: pageNumber } });
  }
  return blocks;
}
