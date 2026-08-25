import { parse } from "csv-parse/sync";
import type { DocumentBlock } from "../types";

export function parseCsv(input: string | Uint8Array): DocumentBlock[] {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  const clean = text.replace(/^\uFEFF/, "");
  const delimiter = [",", "\t", ";", "|"] .sort((a, b) => (clean.split(a).length > clean.split(b).length ? -1 : 1))[0]!;
  const rows = parse(clean, { delimiter, skip_empty_lines: true, relax_column_count: true }) as string[][];
  const headers = rows.shift() ?? [];
  return rows.map((row, index) => ({ kind: "sheet-row", text: headers.map((h, i) => `${h}: ${row[i] ?? ""}`).join("\n"), locator: { kind: "row", sheet: "CSV", startRow: index + 2, endRow: index + 2 } }));
}
