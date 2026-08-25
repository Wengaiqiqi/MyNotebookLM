import path from "node:path";
const extensions = new Set(["txt", "md", "markdown", "csv", "pdf", "docx", "pptx", "xlsx"]);
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
  if (textExtensions.has(extension)) { if (bytes.includes(0) || bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("invalid text signature"); new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  return { extension: extension === "markdown" ? "md" : extension };
}
