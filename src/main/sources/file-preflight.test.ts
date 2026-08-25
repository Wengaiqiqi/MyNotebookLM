import { describe, expect, it } from "vitest";
import { validateFile } from "./file-preflight";

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
});
