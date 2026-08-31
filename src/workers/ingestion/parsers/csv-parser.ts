import { parse } from "csv-parse/sync";
import type { DocumentBlock } from "../types";

export function parseCsv(input: string | Uint8Array): DocumentBlock[] {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const delimiter = [",", "\t", ";", "|"] .map((candidate, order) => {
    try {
      const rows = parse(clean, { delimiter: candidate, skip_empty_lines: false, relax_column_count: true }) as string[][];
      const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
      const widths = nonEmpty.map((row) => row.length);
      const width = widths[0] ?? 1;
      const consistent = width > 1 && widths.every((rowWidth) => rowWidth === width);
      return { candidate, score: consistent ? nonEmpty.length * width : 0, order };
    } catch { return { candidate, score: -1, order }; }
  }).sort((a, b) => b.score - a.score || a.order - b.order)[0]!.candidate;
  const rows = parse(clean, { delimiter, skip_empty_lines: false, relax_column_count: true }) as string[][];
  const headers = rows[0] ?? [];
  return rows.slice(1).flatMap((row, index) => row.some(Boolean) ? [{ kind: "sheet-row", text: headers.map((h, i) => `${h}: ${row[i] ?? ""}`).join("\n"), locator: { kind: "row", sheet: "CSV", startRow: index + 2, endRow: index + 2 } }] : []);
}
