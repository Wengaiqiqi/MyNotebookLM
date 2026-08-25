import { parse } from "csv-parse/sync";
import type { DocumentBlock } from "../types";

export function parseCsv(input: string | Uint8Array): DocumentBlock[] {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  const clean = text.replace(/^\uFEFF/, "");
  const delimiter = [",", "\t", ";", "|"] .map((candidate) => {
    try {
      const rows = parse(clean, { delimiter: candidate, skip_empty_lines: false, relax_column_count: true }) as string[][];
      const width = rows.find((row) => row.length > 1)?.length ?? 0;
      return { candidate, score: rows.filter((row) => row.length === width).length * width };
    } catch { return { candidate, score: -1 }; }
  }).sort((a, b) => b.score - a.score)[0]!.candidate;
  const rows = parse(clean, { delimiter, skip_empty_lines: false, relax_column_count: true }) as string[][];
  const headers = rows[0] ?? [];
  return rows.slice(1).flatMap((row, index) => row.some(Boolean) ? [{ kind: "sheet-row", text: headers.map((h, i) => `${h}: ${row[i] ?? ""}`).join("\n"), locator: { kind: "row", sheet: "CSV", startRow: index + 2, endRow: index + 2 } }] : []);
}
