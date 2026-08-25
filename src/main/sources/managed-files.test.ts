import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
});
