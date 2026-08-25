import type { DocumentBlock } from "../types";

export function parseText(input: string | Uint8Array): DocumentBlock[] {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((part, index) => ({ kind: "paragraph", text: part, locator: { kind: "paragraph", paragraph: index + 1 } }));
}
