import { describe, expect, it } from "vitest";
import { decodeTextFile, normalizeTextBytes, validateFile } from "./file-preflight";

describe("file preflight", () => {
  it.each([
    ["PDF", "pdf", Buffer.from("%PDF-1.7")],
    ["DOCX", "docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml word/document.xml")])],
    ["CSV", "csv", Buffer.from("a,b\\n1,2", "utf8")]
  ])("accepts %s", (_, extension, bytes) => {
    expect(validateFile("report." + extension, bytes)).toEqual({ extension });
  });
  it("handles uppercase names and rejects traversal, signatures, legacy and macros", () => {
    expect(validateFile("REPORT.PDF", Buffer.from("%PDF-"))).toEqual({ extension: "pdf" });
    expect(() => validateFile("../report.pdf", Buffer.from("%PDF-"))).toThrow();
    expect(() => validateFile("report.pdf", Buffer.from("not pdf"))).toThrow();
    expect(() => validateFile("report.doc", Buffer.from("D0CF11E0"))).toThrow();
    expect(() => validateFile("report.docm", Buffer.from("PK"))).toThrow();
    expect(() => validateFile("report.txt", Buffer.from([0]))).toThrow();
  });
  it("enforces size and parser extension", () => {
    expect(() => validateFile("a.pdf", Buffer.from("%PDF-"), { maxBytes: 4 })).toThrow();
    expect(() => validateFile("a.csv", Buffer.from("%PDF-"))).toThrow();
  });
  it("accepts GB18030 and BOM-marked UTF-16 text and normalizes it to UTF-8", () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x31]); // "你好,1" saved by Chinese Windows Excel/Notepad
    expect(validateFile("table.csv", gbk)).toEqual({ extension: "csv" });
    expect(normalizeTextBytes(gbk).toString("utf8")).toBe("你好,1");
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文 text", "utf16le")]);
    expect(validateFile("notes.txt", utf16le)).toEqual({ extension: "txt" });
    expect(decodeTextFile(utf16le)).toBe("中文 text");
    const utf16be = Buffer.from([0xfe, 0xff, 0x4e, 0x2d]);
    expect(decodeTextFile(utf16be)).toBe("中");
    expect(decodeTextFile(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });
});
