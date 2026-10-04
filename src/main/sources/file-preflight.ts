import path from "node:path";
export const IMPORT_EXTENSIONS = ["txt", "md", "markdown", "csv", "pdf", "docx", "pptx", "xlsx"] as const;
const extensions = new Set<string>(IMPORT_EXTENSIONS);
const textExtensions = new Set(["txt", "md", "markdown", "csv"]);
function zipHas(bytes: Buffer, value: string): boolean { return bytes.includes(Buffer.from(value)); }
export function validateFile(name: string, bytes: Buffer, options: { maxBytes?: number } = {}): { extension: string } {
  if (bytes.length > (options.maxBytes ?? 100 * 1024 * 1024)) throw new Error("file too large");
  const base = path.basename(name);
  if (base !== name || base === "." || base === "..") throw new Error("unsafe filename");
  const extension = path.extname(base).slice(1).toLowerCase();
  if (!extensions.has(extension)) throw new Error("unsupported extension");
  if (extension === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("invalid PDF signature");
  if (["docx", "pptx", "xlsx"].includes(extension)) {
    const part = extension === "docx" ? "word/" : extension === "pptx" ? "ppt/" : "xl/";
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || !zipHas(bytes, "[Content_Types].xml") || !zipHas(bytes, part)) throw new Error("invalid Office signature");
  }
  if (textExtensions.has(extension)) decodeTextFile(bytes);
  return { extension: extension === "markdown" ? "md" : extension };
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/** Decode a text import: BOM-marked UTF-8/UTF-16, strict UTF-8, then GB18030 (Windows Chinese "ANSI"). */
export function decodeTextFile(bytes: Buffer): string {
  if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("invalid text signature");
  let text: string;
  if (bytes.subarray(0, 3).equals(UTF8_BOM)) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  else if (bytes.subarray(0, 2).equals(UTF16LE_BOM)) text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  else if (bytes.subarray(0, 2).equals(UTF16BE_BOM)) text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  else if (bytes.includes(0)) throw new Error("invalid text signature");
  else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
  }
  if (text.includes("\u0000")) throw new Error("invalid text signature");
  return text;
}

/** Re-encode a validated text import as UTF-8 so parsers and stored copies share one encoding. */
export function normalizeTextBytes(bytes: Buffer): Buffer {
  return Buffer.from(decodeTextFile(bytes), "utf8");
}
