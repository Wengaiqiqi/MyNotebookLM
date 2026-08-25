import ExcelJS from "exceljs";
import type { DocumentBlock } from "../types";

export async function parseXlsx(input: Uint8Array | ArrayBuffer, rowsPerBlock = 100): Promise<DocumentBlock[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input);
  const blocks: DocumentBlock[] = [];
  workbook.worksheets.filter((sheet) => sheet.state === "visible").forEach((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[];
      rows.push(values.slice(1).map(formatValue).join(" | "));
    });
    for (let i = 0; i < rows.length; i += rowsPerBlock) {
      const slice = rows.slice(i, i + rowsPerBlock);
      if (slice.length) blocks.push({ kind: "sheet-row", text: slice.join("\n"), locator: { kind: "row", sheet: sheet.name, startRow: i + 1, endRow: i + slice.length } });
    }
  });
  return blocks;
}

function formatValue(value: unknown): string {
  if (value && typeof value === "object" && "result" in value) return formatValue((value as { result: unknown }).result);
  if (value instanceof Date) return value.toISOString();
  return value == null ? "" : String(value);
}
