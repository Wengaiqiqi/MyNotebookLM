import ExcelJS from "exceljs";
import type { DocumentBlock } from "../types";

export async function parseXlsx(input: Uint8Array | ArrayBuffer, rowsPerBlock = 100): Promise<DocumentBlock[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input);
  const blocks: DocumentBlock[] = [];
  workbook.worksheets.filter((sheet) => sheet.state === "visible").forEach((sheet) => {
    const rows: { number: number; text: string }[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[];
      rows.push({ number: row.number, text: values.slice(1).map(formatValue).join(" | ") });
    });
    const runs: typeof rows[] = [];
    for (const row of rows) {
      const run = runs.at(-1);
      if (!run || row.number !== run.at(-1)!.number + 1) runs.push([row]); else run.push(row);
    }
    for (const run of runs) for (let i = 0; i < run.length; i += rowsPerBlock) {
      const slice = run.slice(i, i + rowsPerBlock);
      if (slice.length) blocks.push({ kind: "sheet-row", text: slice.map((row) => row.text).join("\n"), locator: { kind: "row", sheet: sheet.name, startRow: slice[0]!.number, endRow: slice.at(-1)!.number } });
    }
  });
  return blocks;
}

function formatValue(value: unknown): string {
  if (value && typeof value === "object" && "result" in value) return formatValue((value as { result: unknown }).result);
  if (value && typeof value === "object" && "formula" in value) return "";
  if (value instanceof Date) return value.toISOString();
  return value == null ? "" : String(value);
}
