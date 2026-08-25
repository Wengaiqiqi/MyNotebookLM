import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageFile } from "./managed-files";

describe("managed files", () => {
  it("stores under the revision directory using an id-derived name and hashes bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "managed-"));
    const result = stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes: Buffer.from("hello") });
    expect(result.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(path.dirname(result.path)).toBe(path.join(root, "source-1", "revision-1"));
    expect(readFileSync(result.path, "utf8")).toBe("hello");
    expect(readdirSync(path.join(root, "source-1", "revision-1"))).toHaveLength(1);
  });

  it("rejects a symlinked revision path before writing outside the root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "managed-"));
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    symlinkSync(outside, path.join(root, "source-1"), "junction");

    expect(() => stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes: Buffer.from("nope") }))
      .toThrow(/reparse|symbolic link|symlink/i);
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it("rejects a symlinked storage root before writing through it", () => {
    const realRoot = mkdtempSync(path.join(tmpdir(), "managed-real-"));
    const parent = mkdtempSync(path.join(tmpdir(), "managed-parent-"));
    const root = path.join(parent, "root");
    symlinkSync(realRoot, root, "junction");

    expect(() => stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes: Buffer.from("nope") }))
      .toThrow(/reparse|symbolic link|symlink/i);
    expect(readdirSync(realRoot)).toHaveLength(0);
  });

  it("removes the temporary file when the final destination cannot be replaced", () => {
    const root = mkdtempSync(path.join(tmpdir(), "managed-"));
    const dir = path.join(root, "source-1", "revision-1");
    const finalPath = path.join(dir, "content");
    mkdirSync(dir, { recursive: true });
    mkdirSync(finalPath);

    expect(() => stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes: Buffer.from("new") }))
      .toThrow();
    expect(readdirSync(dir)).toEqual(["content"]);
  });

  it("never opens a pre-existing linked staging file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "managed-"));
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    const dir = path.join(root, "source-1", "revision-1");
    const target = path.join(outside, "target");
    mkdirSync(dir, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, path.join(dir, "content"), "junction");

    expect(() => stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes: Buffer.from("nope") }))
      .toThrow();
    expect(readdirSync(target)).toHaveLength(0);
  });
});
