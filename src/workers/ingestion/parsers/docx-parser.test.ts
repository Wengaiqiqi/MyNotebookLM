import { describe, expect, it } from "vitest";
import { parseDocx, previewDocxTable } from "./docx-parser";
import { readFileSync } from "node:fs";
import JSZip from "jszip";

describe("parseDocx", () => {
  it("preserves document order and emits the real table cell range", async () => {
    const blocks = await parseDocx(new Uint8Array(readFileSync("src/test/fixtures/documents/sample.docx")));
    expect(blocks).toEqual([
      { kind: "heading", text: "Chapter", locator: { kind: "heading", depth: 1, headingPath: "Chapter" } },
      { kind: "paragraph", text: "Body", locator: { kind: "paragraph", paragraph: 1 } },
      { kind: "list", text: "Item", locator: { kind: "paragraph", paragraph: 2 } },
      { kind: "table", text: "A | B", locator: { kind: "cell", sheet: "Table 1", cellRef: "A1:B1" } }
    ]);
  });

  it("keeps nested tables out of the outer table and expands gridSpan/vMerge", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Outer A</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Outer B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>Ignored duplicate</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const zip = new JSZip(); zip.file("word/document.xml", xml);
    const blocks = await parseDocx(await zip.generateAsync({ type: "uint8array" }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "table", text: "Outer A | Outer B", locator: { cellRef: "A1:D2" } });
  });

  it("returns structured table rows and merged cells for citation rendering", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="1800"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:tbl><w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="1800"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>等级</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>分数</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并说明</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const zip = new JSZip(); zip.file("word/document.xml", xml);
    const preview = await previewDocxTable(await zip.generateAsync({ type: "uint8array" }), "等级 分数 合并说明");
    expect(preview?.columns).toHaveLength(2);
    expect(preview?.rows[0]?.cells.map((cell) => cell.text)).toEqual(["等级", "分数"]);
    expect(preview?.rows[1]?.cells[0]).toMatchObject({ text: "合并说明", colSpan: 2 });
  });

  it("indexes adjacent DOCX tables as distinct captioned chunks with stable locators", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>表1 学科竞赛获奖加分细则</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="1200"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>一等奖</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>表2 中国国际大学生创新大赛加分细则</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="1200"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>金奖</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const zip = new JSZip(); zip.file("word/document.xml", xml);
    const data = await zip.generateAsync({ type: "uint8array" });
    const tables = (await parseDocx(data)).filter((block) => block.kind === "table");
    expect(tables).toEqual([
      { kind: "table", text: "表1 学科竞赛获奖加分细则\n一等奖", locator: { kind: "cell", sheet: "Table 1", cellRef: "A1:A1" } },
      { kind: "table", text: "表2 中国国际大学生创新大赛加分细则\n金奖", locator: { kind: "cell", sheet: "Table 2", cellRef: "A1:A1" } }
    ]);
    await expect(previewDocxTable(data, "两个标题都在旧分片中", "Table 2")).resolves.toMatchObject({ name: "Table 2", rows: [{ cells: [{ text: "金奖" }] }] });
  });

  it("matches a table from its preceding caption for legacy paragraph citations", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>表1 学科竞赛获奖加分细则</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="1800"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>竞赛级别</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>一等奖</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>普通正文</w:t></w:r></w:p></w:body></w:document>`;
    const zip = new JSZip(); zip.file("word/document.xml", xml);
    const data = await zip.generateAsync({ type: "uint8array" });
    const preview = await previewDocxTable(data, "具体加分细则见表1。\n\n表1学科竞赛获奖加分细则");
    expect(preview?.rows[0]?.cells.map((cell) => cell.text)).toEqual(["竞赛级别", "一等奖"]);
    await expect(previewDocxTable(data, "这是一段与表格无关的普通正文")).resolves.toBeNull();
  });

  it.runIf(Boolean(process.env["DOCX_PREVIEW_TEST_FILE"]))("parses the provided real DOCX table", async () => {
    const data = new Uint8Array(readFileSync(process.env["DOCX_PREVIEW_TEST_FILE"]!));
    const preview = await previewDocxTable(data, "表1 学科竞赛获奖加分细则 竞赛级别 一等奖及以上 二等奖 三等奖 国家级 30 25 20");
    expect(preview?.columns).toHaveLength(4);
    expect(preview?.rows[0]?.cells.map((cell) => cell.text)).toEqual(["竞赛级别", "一等奖及以上", "二等奖", "三等奖"]);
    expect(preview?.rows.some((row) => row.cells.some((cell) => cell.colSpan === 4))).toBe(true);
    const second = await previewDocxTable(data, "表2 中国国际大学生创新大赛加分细则 竞赛级别 金奖 银奖 铜奖 国家级 60 50 40");
    expect(second?.rows[0]?.cells.map((cell) => cell.text)).toEqual(["竞赛级别", "金奖", "银奖", "铜奖"]);
    expect(second?.name).not.toBe(preview?.name);
    const legacy = await previewDocxTable(data, "具体加分细则见表1。\n\n表1学科竞赛获奖加分细则\n\n参加创新大赛按表2加分。\n\n表2中国国际大学生创新大赛加分细则");
    expect(legacy?.rows[0]?.cells.map((cell) => cell.text)).toEqual(["竞赛级别", "一等奖及以上", "二等奖", "三等奖"]);
  });
});
