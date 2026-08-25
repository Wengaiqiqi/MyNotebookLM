import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parsePptx } from "./pptx-parser";

describe("parsePptx", () => {
  it("preserves slide order, extracts titles/text/notes, and ignores external links", async () => {
    const zip = new JSZip();
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="x"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>`);
    for (const [n, title] of [[1, "First"], [2, "Second"]] as const) {
      zip.file(`ppt/slides/slide${n}.xml`, `<p:sld xmlns:p="p"><p:sp><p:txBody><a:p xmlns:a="a"><a:r><a:t>${title}</a:t></a:r></a:p><a:p xmlns:a="a"><a:r><a:t>Body ${n}</a:t></a:r></a:p><a:hlinkClick xmlns:a="a" r:id="x"/></p:txBody></p:sp></p:sld>`);
      zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, `<Relationships xmlns="x"><Relationship Id="noteRel" Type="notesSlide" Target="../notesSlides/notesSlide${n === 1 ? 2 : 1}.xml"/></Relationships>`);
      zip.file(`ppt/notesSlides/notesSlide${n === 1 ? 2 : 1}.xml`, `<p:notes xmlns:p="p" xmlns:a="a"><a:t>Note ${n}</a:t></p:notes>`);
    }
    const blocks = await parsePptx(await zip.generateAsync({ type: "uint8array" }));
    expect(blocks.map((b) => [b.kind, b.text, b.locator])).toEqual([
      ["heading", "First", { kind: "slide", slide: 1 }], ["paragraph", "Body 1\nNote 1", { kind: "slide", slide: 1 }],
      ["heading", "Second", { kind: "slide", slide: 2 }], ["paragraph", "Body 2\nNote 2", { kind: "slide", slide: 2 }]
    ]);
  });
});
