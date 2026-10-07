import { z } from "zod";

export const SLIDE_LAYOUTS = ["title", "section", "bullets", "two-column"] as const;
export const SLIDE_THEMES = ["light", "dark", "ocean", "warm"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];
export type SlideTheme = (typeof SLIDE_THEMES)[number];

const lines = z.array(z.string().max(1000)).max(20);
export const slideSchema = z.object({
  id: z.string().min(1).max(64),
  layout: z.enum(SLIDE_LAYOUTS),
  title: z.string().max(300),
  bullets: lines,
  right: lines,
  notes: z.string().max(8000)
}).strict();
export type Slide = z.infer<typeof slideSchema>;

export const slideDeckSchema = z.object({
  version: z.literal(1),
  title: z.string().max(300),
  theme: z.enum(SLIDE_THEMES),
  slides: z.array(slideSchema).min(1).max(100)
}).strict();
export type SlideDeck = z.infer<typeof slideDeckSchema>;

export const saveSlidesInputSchema = z.object({ projectId: z.uuid(), insightId: z.uuid(), deck: slideDeckSchema }).strict();

/** Colors are hex without "#", the form pptxgenjs expects; the preview adds it. */
export const SLIDE_THEME_COLORS: Record<SlideTheme, { background: string; title: string; text: string; accent: string; muted: string }> = {
  light: { background: "FFFFFF", title: "1F2937", text: "374151", accent: "2563EB", muted: "6B7280" },
  dark: { background: "111827", title: "F9FAFB", text: "E5E7EB", accent: "60A5FA", muted: "9CA3AF" },
  ocean: { background: "0F3D56", title: "FFFFFF", text: "E0F2FE", accent: "38BDF8", muted: "BAE6FD" },
  warm: { background: "FFF7ED", title: "7C2D12", text: "431407", accent: "EA580C", muted: "9A3412" }
};
