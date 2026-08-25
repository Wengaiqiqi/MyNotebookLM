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
const direct = (node: any, key: string): any[] => asArray(node).flatMap((child) => asArray(child?.[key])).flat();
const prop = (cell: any, key: string): any => direct(direct(cell, "w:tcPr")[0], key)[0]?.[":@"] ?? {};
const value = (cell: any, key: string): string | undefined => { if (!cell || typeof cell !== "object") return undefined; if (cell[key] !== undefined) return cell[":@"]?.["@_w:val"]; for (const child of Object.values(cell)) { const found = value(child, key); if (found !== undefined) return found; } return undefined; };

export async function parseDocx(data: Uint8Array): Promise<DocumentBlock[]> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("DOCX document.xml is missing");
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: false, preserveOrder: true }).parse(await entry.async("string"));
  const body = descendants(root, "w:body"); const blocks: DocumentBlock[] = []; const headings: string[] = []; let paragraph = 0;
  for (const wrapper of Array.isArray(body) ? body : [body]) {
    const item = wrapper["w:p"] ?? wrapper["w:tbl"] ?? wrapper; if (!item) continue;
    const p = wrapper["w:p"] ? item : undefined;
    if (p) {
      const props = p.find((node: any) => node["w:pPr"])?.["w:pPr"]?.[0] ?? {}; const style = props[":@"]?.["@_w:val"] ?? ""; const value = normalize(textOf(p.filter((node: any) => node["w:r"]).flatMap((node: any) => node["w:r"]))); if (!value) continue;
      if (style.startsWith("Heading")) { const depth = Number(style.replace(/\D/g, "")) || 1; headings.splice(depth - 1); headings.push(value); blocks.push({ kind: "heading", text: value, locator: { kind: "heading", depth, headingPath: headings.join(" > ") } }); }
      else { paragraph += 1; blocks.push({ kind: props["w:numPr"] !== undefined ? "list" : "paragraph", text: value, locator: { kind: "paragraph", paragraph } }); }
    }
    const table = wrapper["w:tbl"] ? item : wrapper["w:tr"] ? [wrapper] : undefined;
    if (table) { const tableNode = Array.isArray(item) ? item[0] : item; const rootTable = direct(tableNode, "w:tbl")[0] ?? tableNode; const rows = direct(rootTable, "w:tr").filter((row) => direct(row, "w:tc").length); const activeMerges = new Map<number, number>(); let width = 0; const logicalRows = rows.map((row: any) => { let column = 0; const values: string[] = []; for (const rawCell of direct(row, "w:tc")) { const cell = rawCell["w:tc"]?.[0] ?? rawCell; const mergeNodes = direct(direct(cell, "w:tcPr")[0], "w:vMerge"); const merge = value(cell, "w:vMerge"); const span = Number(value(cell, "w:gridSpan")) || activeMerges.get(column) || 1; if (mergeNodes.length && merge === undefined) { column += span; continue; } if (merge === "restart") activeMerges.set(column, span); else if (!mergeNodes.length) activeMerges.delete(column); values.push(normalize(textOf(direct(cell, "w:p")))); column += span; } width = Math.max(width, column); return values; }); const cells = logicalRows.flat().filter(Boolean); if (cells.length) blocks.push({ kind: "table", text: cells.join(" | "), locator: { kind: "cell", sheet: headings.join(" > ") || "document", cellRef: "A1:" + columnName(Math.max(1, width)) + rows.length } }); }
  }
  return blocks;
}
