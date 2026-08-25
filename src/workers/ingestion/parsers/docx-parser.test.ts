import { describe, expect, it } from "vitest";
import { parseDocx } from "./docx-parser";
import { readFileSync } from "node:fs";
import JSZip from "jszip";

describe("parseDocx", () => {
  it("preserves document order and emits the real table cell range", async () => {
    const blocks = await parseDocx(new Uint8Array(readFileSync("src/test/fixtures/documents/sample.docx")));
    expect(blocks).toEqual([
      { kind: "heading", text: "Chapter", locator: { kind: "heading", depth: 1, headingPath: "Chapter" } },
      { kind: "paragraph", text: "Body", locator: { kind: "paragraph", paragraph: 1 } },
      { kind: "list", text: "Item", locator: { kind: "paragraph", paragraph: 2 } },
      { kind: "table", text: "A | B", locator: { kind: "cell", sheet: "Chapter", cellRef: "A1:A2" } }
    ]);
  });

  it("keeps nested tables out of the outer table and expands gridSpan/vMerge", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Outer A</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Outer B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>Ignored duplicate</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const zip = new JSZip(); zip.file("word/document.xml", xml);
    const blocks = await parseDocx(await zip.generateAsync({ type: "uint8array" }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "table", text: "Outer A | Outer B", locator: { cellRef: "A1:D2" } });
  });
});
