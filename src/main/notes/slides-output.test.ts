import { describe, expect, it } from "vitest";
import { normalizeSlidesOutput, SlidesOutputError } from "./slides-output";

const ids = () => { let next = 0; return () => `s${++next}`; };

describe("normalizeSlidesOutput", () => {
  it("keeps a well-formed deck and assigns application ids", () => {
    const deck = normalizeSlidesOutput(JSON.stringify({ title: "Deck", slides: [
      { layout: "title", title: "Deck", bullets: ["Subtitle"] },
      { layout: "two-column", title: "Compare", bullets: ["Left"], right: ["Right"], notes: "Say this" }
    ] }), ids());
    expect(deck).toEqual({ version: 1, title: "Deck", theme: "light", slides: [
      { id: "s1", layout: "title", title: "Deck", bullets: ["Subtitle"], right: [], notes: "" },
      { id: "s2", layout: "two-column", title: "Compare", bullets: ["Left"], right: ["Right"], notes: "Say this" }
    ] });
  });

  it("repairs the shapes small models produce", () => {
    const raw = '好的：\n{"slides":[{"title":"封面"},{"layout":"timeline","title":"要点","points":"- 第一\\n2. 第二\\n\\n"},'
      + '{"layout":"two-column","title":"缺右栏","bullets":["只有左栏"]},{"layout":"bullets","title":"多余右栏","bullets":["a"],"right":["b"]},{"bullets":[]},"junk"]}';
    const deck = normalizeSlidesOutput(raw, ids());
    expect(deck.title).toBe("封面");
    expect(deck.slides.map((slide) => [slide.layout, slide.title, slide.bullets, slide.right])).toEqual([
      ["title", "封面", [], []],
      ["bullets", "要点", ["第一", "第二"], []],
      ["bullets", "缺右栏", ["只有左栏"], []],
      ["bullets", "多余右栏", ["a", "b"], []]
    ]);
  });

  it("rejects output without slides", () => {
    expect(() => normalizeSlidesOutput("no json here")).toThrow(SlidesOutputError);
    expect(() => normalizeSlidesOutput('{"title":"Empty","slides":[]}')).toThrow(SlidesOutputError);
  });
});
