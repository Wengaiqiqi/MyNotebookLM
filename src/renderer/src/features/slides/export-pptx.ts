import PptxGenJS from "pptxgenjs";
import { SLIDE_THEME_COLORS, type SlideDeck } from "../../../../shared/slides";

// LAYOUT_WIDE is 13.33 x 7.5 in. SlideView mirrors these boxes in CSS, so the
// in-app preview and the exported file share one geometry.
const FONT = "Microsoft YaHei";

/** Build an editable .pptx: real text boxes, bullets and speaker notes. */
export async function exportPptx(deck: SlideDeck): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  const color = SLIDE_THEME_COLORS[deck.theme];
  const list = (items: string[], fontSize: number): PptxGenJS.TextProps[] => items.filter((item) => item.trim())
    .map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true, paraSpaceAfter: 8, fontSize } }));
  const body = { fontFace: FONT, color: color.text, valign: "top" as const, fit: "shrink" as const };

  for (const slide of deck.slides) {
    const page = pptx.addSlide();
    page.background = { color: color.background };
    if (slide.notes.trim()) page.addNotes(slide.notes);
    const lines = slide.bullets.filter((item) => item.trim()).join("\n");
    if (slide.layout === "title" || slide.layout === "section") {
      const cover = slide.layout === "title";
      page.addShape(pptx.ShapeType.rect, cover ? { x: 0.8, y: 2.2, w: 1.2, h: 0.1, fill: { color: color.accent } } : { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: color.accent } });
      page.addText(slide.title, { x: 0.8, y: cover ? 2.45 : 2.5, w: 11.7, h: 1.5, fontFace: FONT, fontSize: cover ? 40 : 36, bold: true, color: color.title, valign: "bottom", fit: "shrink" });
      if (lines) page.addText(lines, { ...body, x: 0.8, y: 4.15, w: 11.7, h: 1.6, fontSize: 20, color: color.muted });
      continue;
    }
    page.addText(slide.title, { x: 0.7, y: 0.3, w: 11.9, h: 0.95, fontFace: FONT, fontSize: 28, bold: true, color: color.title, valign: "bottom", fit: "shrink" });
    page.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.4, w: 0.9, h: 0.06, fill: { color: color.accent } });
    if (slide.layout === "two-column") {
      page.addText(list(slide.bullets, 18), { ...body, x: 0.7, y: 1.7, w: 5.8, h: 5.3 });
      page.addShape(pptx.ShapeType.line, { x: 6.67, y: 1.8, w: 0, h: 5, line: { color: color.muted, width: 0.75 } });
      page.addText(list(slide.right, 18), { ...body, x: 6.85, y: 1.7, w: 5.8, h: 5.3 });
    } else {
      page.addText(list(slide.bullets, 20), { ...body, x: 0.7, y: 1.7, w: 11.9, h: 5.3 });
    }
  }
  return await pptx.write({ outputType: "blob" }) as Blob;
}
