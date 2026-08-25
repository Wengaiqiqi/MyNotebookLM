import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { DocumentBlock } from "../types";

const textOf = (node: any): string => (Array.isArray(node) ? node : [node]).filter(Boolean).map((n) => {
  if (typeof n === "string") return n;
  if (typeof n !== "object") return "";
  if (typeof n["#text"] === "string") return n["#text"];
  return textOf(Object.entries(n).filter(([key]) => !key.startsWith("@_")).map(([, value]) => value));
}).join("");
const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

export async function parseDocx(data: Uint8Array): Promise<DocumentBlock[]> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("DOCX document.xml is missing");
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: false }).parse(await entry.async("string"));
  const body = root["w:document"]["w:body"]; const blocks: DocumentBlock[] = []; const headings: string[] = []; let paragraph = 0;
  const paragraphs = Array.isArray(body["w:p"]) ? body["w:p"] : body["w:p"] ? [body["w:p"]] : [];
  const tables = Array.isArray(body["w:tbl"]) ? body["w:tbl"] : body["w:tbl"] ? [body["w:tbl"]] : [];
  const items = [...paragraphs, ...tables];
  for (const item of items) {
    const p = item["w:r"] || item["w:pPr"] ? item : undefined;
    if (p) {
      const props = p["w:pPr"] ?? {}; const style = props["w:pStyle"]?.["@_w:val"] ?? ""; const value = normalize(textOf(p["w:r"])); if (!value) continue;
      if (style.startsWith("Heading")) { const depth = Number(style.replace(/\D/g, "")) || 1; headings.splice(depth - 1); headings.push(value); blocks.push({ kind: "heading", text: value, locator: { kind: "heading", depth, headingPath: headings.join(" > ") } }); }
      else { paragraph += 1; blocks.push({ kind: props["w:numPr"] !== undefined ? "list" : "paragraph", text: value, locator: { kind: "paragraph", paragraph } }); }
    }
    const table = item["w:tr"] ? item : undefined;
    if (table) { const rows = Array.isArray(table["w:tr"]) ? table["w:tr"] : [table["w:tr"]]; const cells = rows.flatMap((row: any) => (Array.isArray(row["w:tc"]) ? row["w:tc"] : [row["w:tc"]]).map((cell: any) => normalize(textOf(cell["w:p"] ?? cell)))); if (cells.length) blocks.push({ kind: "table", text: cells.join(" | "), locator: { kind: "cell", sheet: headings.join(" > ") || "document", cellRef: "A1:B1" } }); }
  }
  return blocks;
}
