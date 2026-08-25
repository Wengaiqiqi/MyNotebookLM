import type { DocumentBlock } from "../types";

export function parseMarkdown(input: string | Uint8Array): DocumentBlock[] {
  const source = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const originalOffset = (normalizedOffset: number) => {
    let sourceOffset = source.startsWith("\uFEFF") ? 1 : 0;
    let remaining = normalizedOffset;
    while (remaining > 0 && sourceOffset < source.length) {
      if (source[sourceOffset] === "\r" && source[sourceOffset + 1] === "\n") sourceOffset++;
      sourceOffset++; remaining--;
    }
    return sourceOffset;
  };
  const lines = normalized.split("\n");
  const blocks: DocumentBlock[] = []; let headingPath: string[] = []; let paragraph = 0; let offset = 0;
  const add = (kind: DocumentBlock["kind"], text: string, locator: DocumentBlock["locator"]) => { if (text.trim()) blocks.push({ kind, text: text.trim(), locator }); };
  for (let i = 0; i < lines.length;) { const line = lines[i]!; const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) { const depth = match[1]!.length; headingPath = headingPath.slice(0, depth - 1); headingPath.push(match[2]!.trim()); add("heading", match[2]!, { kind: "heading", depth, headingPath: headingPath.join(" > ") }); i++; offset += line.length + 1; continue; }
    if (line.startsWith("```")) { const start = offset; const code: string[] = []; i++; offset += line.length + 1; while (i < lines.length && !lines[i]!.startsWith("```")) { code.push(lines[i]!); offset += lines[i]!.length + 1; i++; } if (i < lines.length) { offset += lines[i]!.length + 1; i++; } add("paragraph", code.join("\n"), { kind: "offset", start: originalOffset(start), end: originalOffset(Math.min(offset, normalized.length)) }); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { const start = offset; const items: string[] = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^\s*[-*+]\s+/, "")); offset += lines[i]!.length + 1; i++; } add("list", items.join("\n"), { kind: "offset", start: originalOffset(start), end: originalOffset(offset) }); continue; }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+(?:\s*\|\s*:?-+)+\s*\|?\s*$/.test(lines[i + 1]!)) { const start = offset; const rows = [line]; offset += line.length + 1; i++; rows.push(lines[i]!); offset += lines[i]!.length + 1; i++; while (i < lines.length && lines[i]!.includes("|")) { rows.push(lines[i]!); offset += lines[i]!.length + 1; i++; } add("table", rows.join("\n"), { kind: "offset", start: originalOffset(start), end: originalOffset(Math.min(offset, normalized.length)) }); continue; }
    if (line.trim()) { const paragraphLines = [line.trim()]; const startParagraph = ++paragraph; i++; offset += line.length + 1; while (i < lines.length && lines[i]!.trim() && !/^(#{1,6})\s+/.test(lines[i]!) && !lines[i]!.startsWith("```") && !/^\s*[-*+]\s+/.test(lines[i]!)) { paragraphLines.push(lines[i]!.trim()); offset += lines[i]!.length + 1; i++; } add("paragraph", (headingPath.length ? headingPath.join(" > ") + "\n" : "") + paragraphLines.join("\n"), { kind: "paragraph", paragraph: startParagraph }); continue; } i++; offset += line.length + 1;
  } return blocks;
}
