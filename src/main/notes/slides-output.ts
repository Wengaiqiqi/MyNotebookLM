import { randomUUID } from "node:crypto";
import { SLIDE_LAYOUTS, slideDeckSchema, type Slide, type SlideDeck, type SlideLayout } from "../../shared/slides";
import { modelJson } from "./mindmap-service";

export class SlidesOutputError extends Error {
  readonly messageKey = "errors.slidesInvalid";
  constructor(message: string) { super(message); this.name = "SlidesOutputError"; }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : "";
}

/** Accept a string array or one multi-line string; drop list markers models add. */
function lines(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  return items.map((item) => text(item, 1000).replace(/^(?:[-*•·]|\d+[.、)])\s*/, ""))
    .filter(Boolean).slice(0, 20);
}

/**
 * Turn model output into a deck. The prompt asks for a flat slide list of
 * plain strings, and parsing is lenient (fences, think blocks, stray quotes,
 * alias fields) because small models get long nested JSON wrong.
 */
export function normalizeSlidesOutput(raw: string, id: () => string = randomUUID): SlideDeck {
  let parsed: unknown;
  try { parsed = modelJson(raw); } catch { throw new SlidesOutputError("Slides output is not valid JSON"); }
  const object = (Array.isArray(parsed) ? { slides: parsed } : parsed ?? {}) as Record<string, unknown>;
  const items = Array.isArray(object.slides) ? object.slides : [];
  const slides = items.slice(0, 100).flatMap((item, index): Slide[] => {
    if (!item || typeof item !== "object") return [];
    const fields = item as Record<string, unknown>;
    const title = text(fields.title, 300);
    let bullets = lines(fields.bullets ?? fields.points ?? fields.content ?? fields.body ?? fields.subtitle);
    let right = lines(fields.right);
    if (!title && !bullets.length && !right.length) return [];
    const requested = SLIDE_LAYOUTS.find((layout) => layout === fields.layout);
    const layout: SlideLayout = requested === "two-column" && !right.length ? "bullets"
      : requested ?? (index === 0 ? "title" : right.length ? "two-column" : "bullets");
    if (layout !== "two-column" && right.length) { bullets = [...bullets, ...right].slice(0, 20); right = []; }
    return [{ id: id(), layout, title, bullets, right, notes: text(fields.notes, 8000) }];
  });
  if (!slides.length) throw new SlidesOutputError("Slides output has no slides");
  return slideDeckSchema.parse({ version: 1, title: text(object.title, 300) || slides[0]!.title, theme: "light", slides });
}
