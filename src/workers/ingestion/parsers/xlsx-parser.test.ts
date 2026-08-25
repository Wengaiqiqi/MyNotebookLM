import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseXlsx } from "./xlsx-parser";

describe("parseXlsx", () => {
  it("emits visible sheet row blocks, cached formula values, dates and ranges", async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Data");
    ws.addRow(["Name", "Value", "When"]); ws.addRow(["A", 3, new Date("2025-01-02T00:00:00.000Z")]);
    ws.getCell("B3").value = { formula: "1+1", result: 2 };
    const hidden = wb.addWorksheet("Hidden"); hidden.state = "hidden"; hidden.addRow(["no"]);
    const blocks = await parseXlsx(await wb.xlsx.writeBuffer(), 2);
    expect(blocks).toEqual([{ kind: "sheet-row", text: "Name | Value | When\nA | 3 | 2025-01-02T00:00:00.000Z", locator: { kind: "row", sheet: "Data", startRow: 1, endRow: 2 } }, { kind: "sheet-row", text: " | 2", locator: { kind: "row", sheet: "Data", startRow: 3, endRow: 3 } }]);
  });
});
