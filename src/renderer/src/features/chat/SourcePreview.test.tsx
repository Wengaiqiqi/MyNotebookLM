// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SourcePreview from "./SourcePreview";
import "../../i18n";

const getPage = vi.fn(async () => ({
  getViewport: () => ({ width: 600, height: 800 }),
  render: () => ({ promise: Promise.resolve(), cancel: vi.fn() })
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 5, getPage, destroy: vi.fn(async () => undefined) }),
    destroy: vi.fn(async () => undefined)
  })
}));

describe("SourcePreview", () => {
  beforeEach(() => {
    getPage.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:docx-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(cleanup);

  it("renders the cited PDF page with PDF.js instead of the blank native viewer", async () => {
    render(
      <SourcePreview kind="pdf" data={new Uint8Array([0x25, 0x50, 0x44, 0x46])} text="fallback" sheet={null} locator={{ kind: "page", page: 3 }} />
    );

    const canvas = await screen.findByRole("img", { name: "引用原文" });
    expect(canvas.tagName).toBe("CANVAS");
    await waitFor(() => expect(canvas.getAttribute("aria-busy")).toBe("false"));
    expect(getPage).toHaveBeenCalledWith(3);
    expect((canvas as HTMLCanvasElement).style.height).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders workbook cells, merges, styles and the cited cell", async () => {
    render(<SourcePreview kind="xlsx" data={null} text={null} locator={{ kind: "cell", sheet: "数据", cellRef: "B2" }} sheet={{
      name: "数据",
      columns: [{ number: 1, width: 70 }, { number: 2, width: 70 }],
      rows: [
        { number: 1, cells: [
          { column: 1, text: "指标", colSpan: 2, style: { fontWeight: 700, color: "#FFFFFF", backgroundColor: "#2563EB" } },
          { column: 2, text: "指标", covered: true }
        ] },
        { number: 2, cells: [{ column: 1, text: "" }, { column: 2, text: "42" }] }
      ]
    }} />);

    const merged = (await screen.findByText("指标")).closest("td");
    expect(merged?.getAttribute("colspan")).toBe("2");
    expect(merged?.getAttribute("style")).toContain("background-color");
    expect((await screen.findByText("42")).closest("td")?.className).toContain("citation-sheet-target");
  });

  it("clamps an invalid PDF locator to the last real page", async () => {
    render(<SourcePreview kind="pdf" data={new Uint8Array([0x25, 0x50, 0x44, 0x46])} text={null} sheet={null} locator={{ kind: "page", page: 99 }} />);
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(5));
  });

  it("renders a DOCX table without spreadsheet row and column furniture", async () => {
    render(<SourcePreview kind="docx" data={null} text="flattened fallback" locator={{ kind: "cell", sheet: "document", cellRef: "A1:D3" }} sheet={{
      name: "Table 1",
      columns: [{ number: 1, width: 120 }, { number: 2, width: 160 }],
      rows: [
        { number: 1, cells: [{ column: 1, text: "竞赛级别" }, { column: 2, text: "一等奖" }] },
        { number: 2, cells: [{ column: 1, text: "注：合并说明", colSpan: 2 }] }
      ]
    }} />);

    expect((await screen.findByText("注：合并说明")).closest("td")?.getAttribute("colspan")).toBe("2");
    expect(document.querySelector(".citation-document-table")).not.toBeNull();
    expect(screen.queryByText("A")).toBeNull();
  });

  it("renders an embedded DOCX image in its original table cell", async () => {
    render(<SourcePreview kind="docx" data={null} text={null} locator={{ kind: "cell", sheet: "Table 1", cellRef: "A1" }} images={[{
      data: new Uint8Array([1, 2, 3]), mimeType: "image/png", altText: "架构图", cellRef: "A1"
    }]} sheet={{ name: "Table 1", columns: [{ number: 1, width: 200 }], rows: [{ number: 1, cells: [{ column: 1, text: "说明" }] }] }} />);

    const image = await screen.findByRole("img", { name: "架构图" });
    expect(image.closest("td")?.textContent).toContain("说明");
    expect(image.getAttribute("src")).toBe("blob:docx-image");
  });

  it("renders Markdown source excerpts without relevance highlighting", () => {
    render(<SourcePreview kind="markdown" data={null} sheet={null} locator={{ kind: "paragraph", paragraph: 1 }} text={"General introduction.\n\nStart services with Docker Compose."} />);
    expect(screen.getByText("Start services with Docker Compose.").tagName).toBe("P");
    expect(document.querySelector("mark")).toBeNull();
  });
});
