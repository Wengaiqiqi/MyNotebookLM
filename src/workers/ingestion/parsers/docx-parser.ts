import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { CitationSheetPreview } from "../../../shared/ipc";
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
const directElements = (node: any, key: string): any[] => asArray(node).filter((child) => child && typeof child === "object" && child[key] !== undefined);
const prop = (cell: any, key: string): any => direct(direct(cell, "w:tcPr")[0], key)[0]?.[":@"] ?? {};
const value = (cell: any, key: string): string | undefined => { if (!cell || typeof cell !== "object") return undefined; if (cell[key] !== undefined) return cell[":@"]?.["@_w:val"]; for (const child of Object.values(cell)) { const found = value(child, key); if (found !== undefined) return found; } return undefined; };

async function documentRoot(data: Uint8Array): Promise<any> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("DOCX document.xml is missing");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: false, preserveOrder: true }).parse(await entry.async("string"));
}

export async function parseDocx(data: Uint8Array): Promise<DocumentBlock[]> {
  const root = await documentRoot(data);
  const body = descendants(root, "w:body"); const blocks: DocumentBlock[] = []; const headings: string[] = []; let paragraph = 0; let tableNumber = 0; let previousParagraph = "";
  for (const wrapper of Array.isArray(body) ? body : [body]) {
    const item = wrapper["w:p"] ?? wrapper["w:tbl"] ?? wrapper; if (!item) continue;
    const p = wrapper["w:p"] ? item : undefined;
    if (p) {
      const props = p.find((node: any) => node["w:pPr"])?.["w:pPr"]?.[0] ?? {}; const style = props[":@"]?.["@_w:val"] ?? ""; const value = normalize(textOf(p.filter((node: any) => node["w:r"]).flatMap((node: any) => node["w:r"]))); if (!value) continue;
      previousParagraph = value;
      if (style.startsWith("Heading")) { const depth = Number(style.replace(/\D/g, "")) || 1; headings.splice(depth - 1); headings.push(value); blocks.push({ kind: "heading", text: value, locator: { kind: "heading", depth, headingPath: headings.join(" > ") } }); }
      else { paragraph += 1; blocks.push({ kind: props["w:numPr"] !== undefined ? "list" : "paragraph", text: value, locator: { kind: "paragraph", paragraph } }); }
    }
    if (wrapper["w:tbl"]) {
      tableNumber += 1;
      const table = tablePreview(wrapper["w:tbl"], tableNumber);
      if (!table) continue;
      const cells = table.rows.flatMap((row) => row.cells.map((cell) => cell.text)).filter(Boolean);
      if (cells.length === 0) continue;
      const caption = /(?:表|table)\s*\d+/i.test(previousParagraph) ? previousParagraph : "";
      blocks.push({
        kind: "table",
        text: [caption, cells.join(" | ")].filter(Boolean).join("\n"),
        locator: { kind: "cell", sheet: table.name, cellRef: `A1:${columnName(Math.max(1, table.columns.length))}${table.rows.length}` }
      });
    }
  }
  return blocks;
}

export async function previewDocxTable(data: Uint8Array, citedText: string, tableName?: string): Promise<CitationSheetPreview | null> {
  const root = await documentRoot(data);
  const body = descendants(root, "w:body");
  const tables: Array<{ table: CitationSheetPreview; caption: string }> = [];
  let caption = "";
  for (const wrapper of Array.isArray(body) ? body : [body]) {
    if (wrapper?.["w:p"]) {
      const text = normalize(textOf(wrapper["w:p"]));
      if (text) caption = text;
      continue;
    }
    if (!wrapper?.["w:tbl"]) continue;
    const table = tablePreview(wrapper["w:tbl"], tables.length + 1);
    if (table) tables.push({ table, caption });
  }
  if (tables.length === 0) return null;
  const exact = tableName ? tables.find((candidate) => candidate.table.name === tableName) : undefined;
  if (exact) return exact.table;
  const needle = matchText(citedText);
  const ranked = tables.map((candidate) => ({
    ...candidate,
    score: tableScore(candidate.table, needle) + captionScore(candidate.caption, needle)
  })).sort((a, b) => b.score - a.score);
  return ranked[0]!.score > 0 ? ranked[0]!.table : null;
}

function tablePreview(node: any, tableNumber: number): CitationSheetPreview | null {
  const rootTable = directElements(node, "w:tbl")[0]?.["w:tbl"] ?? node;
  const rows = directElements(rootTable, "w:tr").filter((row) => directElements(row["w:tr"], "w:tc").length).slice(0, 100);
  if (rows.length === 0) return null;
  const grid = directElements(rootTable, "w:tblGrid")[0]?.["w:tblGrid"];
  const gridWidths = directElements(grid, "w:gridCol").map((column) => Number(column[":@"]?.["@_w:w"]) || 1);
  const activeMerges = new Map<number, { cell: CitationSheetPreview["rows"][number]["cells"][number]; span: number }>();
  let columnCount = gridWidths.length;
  const previewRows: CitationSheetPreview["rows"] = rows.map((row, rowIndex) => {
    let column = 1;
    const cells: CitationSheetPreview["rows"][number]["cells"] = [];
    for (const rawCell of directElements(row["w:tr"], "w:tc")) {
      const cell = rawCell["w:tc"];
      const properties = directElements(cell, "w:tcPr")[0]?.["w:tcPr"];
      const mergeNode = directElements(properties, "w:vMerge")[0];
      const merge = mergeNode?.[":@"]?.["@_w:val"] as string | undefined;
      const spanNode = directElements(properties, "w:gridSpan")[0];
      const span = Number(spanNode?.[":@"]?.["@_w:val"]) || activeMerges.get(column)?.span || 1;
      if (mergeNode && merge === undefined) {
        const active = activeMerges.get(column);
        if (active) active.cell.rowSpan = (active.cell.rowSpan ?? 1) + 1;
        column += span;
        continue;
      }
      const paragraphs = directElements(cell, "w:p").map((paragraph) => normalize(textOf(paragraph["w:p"]))).filter(Boolean);
      const previewCell: CitationSheetPreview["rows"][number]["cells"][number] = {
        column,
        text: paragraphs.join("\n"),
        ...(span > 1 ? { colSpan: span } : {}),
        ...(docxCellStyle(cell) ?? {})
      };
      cells.push(previewCell);
      if (merge === "restart") activeMerges.set(column, { cell: previewCell, span });
      else activeMerges.delete(column);
      column += span;
    }
    columnCount = Math.max(columnCount, column - 1);
    return { number: rowIndex + 1, cells };
  });
  const widths = gridWidths.length === columnCount ? gridWidths : Array.from({ length: columnCount }, () => 1);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) || 1;
  return {
    name: `Table ${tableNumber}`,
    columns: widths.map((width, index) => ({ number: index + 1, width: Math.max(56, width / totalWidth * 720) })),
    rows: previewRows
  };
}

function docxCellStyle(cell: any): { style: CitationSheetPreview["rows"][number]["cells"][number]["style"] } | null {
  const align = value(cell, "w:jc");
  const vertical = value(cell, "w:vAlign");
  const style: NonNullable<CitationSheetPreview["rows"][number]["cells"][number]["style"]> = {};
  if (align === "left" || align === "center" || align === "right" || align === "both") style.textAlign = align === "both" ? "justify" : align;
  if (vertical === "top" || vertical === "center" || vertical === "bottom") style.verticalAlign = vertical === "center" ? "middle" : vertical;
  style.whiteSpace = "pre-wrap";
  return Object.values(style).some((item) => item !== undefined) ? { style } : null;
}

function matchText(text: string): string {
  return text.replace(/[\s|]+/g, "").toLowerCase();
}

function tableScore(table: CitationSheetPreview, needle: string): number {
  if (!needle) return 0;
  const haystack = matchText(table.rows.flatMap((row) => row.cells.map((cell) => cell.text)).join(""));
  return overlapScore(haystack, needle);
}

function captionScore(caption: string, needle: string): number {
  const haystack = matchText(caption);
  if (!haystack || !needle) return 0;
  const index = needle.indexOf(haystack);
  return index >= 0 ? 1000 - Math.min(index, 999) : overlapScore(haystack, needle);
}

function overlapScore(haystack: string, needle: string): number {
  let score = 0;
  for (let index = 0; index + 8 <= needle.length; index += 4) if (haystack.includes(needle.slice(index, index + 8))) score += 1;
  return score;
}
