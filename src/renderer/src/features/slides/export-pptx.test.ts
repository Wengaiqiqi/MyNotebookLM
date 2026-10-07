import JSZip from "jszip";
import { expect, it } from "vitest";
import { exportPptx } from "./export-pptx";

it("exports editable slides with bullets and speaker notes", async () => {
  const blob = await exportPptx({ version: 1, title: "研究汇报", theme: "ocean", slides: [
    { id: "a", layout: "title", title: "研究汇报", bullets: ["副标题"], right: [], notes: "" },
    { id: "b", layout: "two-column", title: "对比", bullets: ["左栏", ""], right: ["右栏"], notes: "讲解备注" },
    { id: "c", layout: "section", title: "第二部分", bullets: [], right: [], notes: "" }
  ] });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  expect(slides).toHaveLength(3);
  const second = await zip.file("ppt/slides/slide2.xml")!.async("string");
  expect(second).toContain("左栏");
  expect(second).toContain("右栏");
  expect(second).toContain("<a:buChar");
  expect(second).toContain("0F3D56");
  const notes = await Promise.all(Object.keys(zip.files).filter((name) => /^ppt\/notesSlides\/.*\.xml$/.test(name)).map((name) => zip.file(name)!.async("string")));
  expect(notes.join("")).toContain("讲解备注");
});
