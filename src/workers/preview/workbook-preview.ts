import ExcelJS, { type Cell, type Color, type Worksheet } from "exceljs";
import type { CitationSheetPreview } from "../../shared/ipc";
import type { SourceLocator } from "../../shared/sources";
import { loadBoundedZip } from "../ingestion/parsers/zip-limits";

export async function workbookPreview(data: Uint8Array, locator: SourceLocator): Promise<CitationSheetPreview | null> {
  await loadBoundedZip(data);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const requestedName = locator.kind === "sheet" || locator.kind === "cell" || locator.kind === "row" ? locator.sheet : "";
  const sheet = workbook.getWorksheet(requestedName) ?? workbook.worksheets.find((item) => item.state === "visible") ?? workbook.worksheets[0];
  if (!sheet) return null;

  const citedRows = rowsFor(sheet, locator);
  const rows = [...new Set([...(citedRows[0] && citedRows[0] > 5 ? [1, 2, 3, 4, 5] : []), ...citedRows])]
    .filter((row) => row <= sheet.rowCount);
  // ponytail: bound the IPC and DOM payload; add column virtualization only if cited sheets exceed 256 used columns.
  const columnCount = Math.min(sheet.actualColumnCount || sheet.columnCount, 256);
  const merges = mergeMap(sheet, new Set(rows), columnCount);

  return {
    name: sheet.name,
    columns: Array.from({ length: columnCount }, (_, index) => {
      const number = index + 1;
      return { number, width: Math.max(48, (sheet.getColumn(number).width ?? 10) * 7) };
    }),
    rows: rows.map((number) => {
      const row = sheet.getRow(number);
      return {
        number,
        ...(row.height ? { height: row.height * 96 / 72 } : {}),
        cells: Array.from({ length: columnCount }, (_, index) => {
          const column = index + 1;
          const cell = row.getCell(column);
          return {
            column,
            text: cell.text,
            ...merges.get(cell.address),
            ...(cell.formula ? { formula: cell.formula } : {}),
            ...(cellPreviewStyle(cell) ?? {})
          };
        })
      };
    })
  };
}

function rowsFor(sheet: Worksheet, locator: SourceLocator): number[] {
  if (locator.kind === "row" && locator.sheet === sheet.name) {
    return Array.from({ length: Math.min(locator.endRow - locator.startRow + 1, 100) }, (_, index) => locator.startRow + index);
  }
  if (locator.kind === "cell" && locator.sheet === sheet.name) return [sheet.getCell(locator.cellRef).fullAddress.row];
  return Array.from({ length: Math.min(sheet.rowCount, 100) }, (_, index) => index + 1);
}

function mergeMap(sheet: Worksheet, selectedRows: Set<number>, columnCount: number): Map<string, { covered?: boolean; colSpan?: number; rowSpan?: number }> {
  const result = new Map<string, { covered?: boolean; colSpan?: number; rowSpan?: number }>();
  for (const range of sheet.model.merges) {
    const [startAddress, endAddress = startAddress] = range.split(":");
    if (!startAddress || !endAddress) continue;
    const start = sheet.getCell(startAddress).fullAddress;
    const end = sheet.getCell(endAddress).fullAddress;
    if (end.col > columnCount || !Array.from({ length: end.row - start.row + 1 }, (_, index) => start.row + index).every((row) => selectedRows.has(row))) continue;
    result.set(startAddress, { colSpan: end.col - start.col + 1, rowSpan: end.row - start.row + 1 });
    for (let row = start.row; row <= end.row; row += 1) {
      for (let column = start.col; column <= end.col; column += 1) {
        const address = sheet.getCell(row, column).address;
        if (address !== startAddress) result.set(address, { covered: true });
      }
    }
  }
  return result;
}

function cellPreviewStyle(cell: Cell): { style: CitationSheetPreview["rows"][number]["cells"][number]["style"] } | null {
  const font = cell.font;
  const alignment = cell.alignment;
  const style: NonNullable<CitationSheetPreview["rows"][number]["cells"][number]["style"]> = {};
  if (font) {
    style.color = excelColor(font.color);
    style.fontFamily = font.name;
    style.fontSize = font.size;
    style.fontWeight = font.bold ? 700 : undefined;
    style.fontStyle = font.italic ? "italic" : undefined;
    style.textDecoration = font.underline ? "underline" : undefined;
  }
  if (cell.fill?.type === "pattern" && cell.fill.pattern !== "none") style.backgroundColor = excelColor(cell.fill.fgColor);
  if (alignment) {
    style.textAlign = alignment.horizontal === "centerContinuous" ? "center"
      : alignment.horizontal === "left" || alignment.horizontal === "center" || alignment.horizontal === "right" || alignment.horizontal === "justify"
        ? alignment.horizontal
        : undefined;
    style.verticalAlign = alignment.vertical === "top" || alignment.vertical === "middle" || alignment.vertical === "bottom" ? alignment.vertical : undefined;
    style.whiteSpace = alignment.wrapText ? "pre-wrap" : "nowrap";
  }
  return Object.values(style).some((value) => value !== undefined) ? { style } : null;
}

function excelColor(value: Partial<Color> | undefined): string | undefined {
  const argb = value?.argb;
  return argb ? `#${argb.length === 8 ? argb.slice(2) : argb}` : undefined;
}
