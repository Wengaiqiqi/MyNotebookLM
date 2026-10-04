import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { loadBoundedZip } from "./zip-limits";

describe("loadBoundedZip", () => {
  it("rejects archives whose declared expansion exceeds the limit", async () => {
    const zip = new JSZip();
    zip.file("a.xml", "x".repeat(4096));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await expect(loadBoundedZip(bytes, 1024)).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
    await expect(loadBoundedZip(bytes, 8192)).resolves.toBeInstanceOf(JSZip);
  });
});
