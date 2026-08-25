import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failFsync = false;
let observeRename: ((from: string, to: string) => void) | undefined;
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    fsyncSync: (fd: number) => { if (failFsync) throw new Error("fsync failed"); return actual.fsyncSync(fd); },
    renameSync: (from: string, to: string) => { observeRename?.(from, to); return actual.renameSync(from, to); },
  };
});
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

  it("cleans up after fsync failure and can retry without a final file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "managed-"));
    const bytes = Buffer.from("retry me");
    failFsync = true;
    try {
      expect(() => stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes })).toThrow("fsync failed");
    } finally { failFsync = false; }
    const dir = path.join(root, "source-1", "revision-1");
    expect(readdirSync(dir)).toEqual([]);
    expect(stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes }).path)
      .toBe(path.join(dir, "content"));
    expect(readFileSync(path.join(dir, "content"))).toEqual(bytes);
  });

  it("does not expose content until the staged file is renamed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "managed-"));
    const dir = path.join(root, "source-1", "revision-1");
    observeRename = (from, to) => {
      expect(readdirSync(dir)).not.toContain("content");
    };

    stageFile({ root, sourceId: "source-1", revisionId: "revision-1", bytes: Buffer.from("atomic") });
    expect(readFileSync(path.join(dir, "content"), "utf8")).toBe("atomic");
    observeRename = undefined;
  });
});
