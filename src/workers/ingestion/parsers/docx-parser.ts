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
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const columnName = (column: number): string => { let name = ""; for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
const descendants = (node: any, key: string): any[] => { if (!node) return []; if (Array.isArray(node)) return node.flatMap((child) => descendants(child, key)); if (typeof node !== "object") return []; return node[key] ? asArray(node[key]) : Object.values(node).flatMap((child) => descendants(child, key)); };

export async function parseDocx(data: Uint8Array): Promise<DocumentBlock[]> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("DOCX document.xml is missing");
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: false, preserveOrder: true }).parse(await entry.async("string"));
  const body = root[0]?.["w:document"]?.[0]?.["w:body"] ?? []; const blocks: DocumentBlock[] = []; const headings: string[] = []; let paragraph = 0;
  for (const wrapper of body) {
    const item = wrapper["w:p"] ?? wrapper["w:tbl"]; if (!item) continue;
    const p = wrapper["w:p"] ? item : undefined;
    if (p) {
      const props = p.find((node: any) => node["w:pPr"])?.["w:pPr"]?.[0] ?? {}; const style = props[":@"]?.["@_w:val"] ?? ""; const value = normalize(textOf(p.filter((node: any) => node["w:r"]).flatMap((node: any) => node["w:r"]))); if (!value) continue;
      if (style.startsWith("Heading")) { const depth = Number(style.replace(/\D/g, "")) || 1; headings.splice(depth - 1); headings.push(value); blocks.push({ kind: "heading", text: value, locator: { kind: "heading", depth, headingPath: headings.join(" > ") } }); }
      else { paragraph += 1; blocks.push({ kind: props["w:numPr"] !== undefined ? "list" : "paragraph", text: value, locator: { kind: "paragraph", paragraph } }); }
    }
    const table = wrapper["w:tbl"] ? item : undefined;
    if (table) { const rows = descendants(table, "w:tr"); const rowCells = rows.map((row: any) => descendants(row, "w:tc")); const cells = rowCells.flatMap((row) => row.map((cell: any) => normalize(textOf(cell)))); if (cells.length) blocks.push({ kind: "table", text: cells.join(" | "), locator: { kind: "cell", sheet: headings.join(" > ") || "document", cellRef: `A1:${columnName(Math.max(...rowCells.map((row) => row.length)))}${rows.length}` } }); }
  }
  return blocks;
}
