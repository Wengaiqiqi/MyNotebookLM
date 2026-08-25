import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import path from "node:path";
function safe(root: string, target: string): string { const r = path.resolve(root), t = path.resolve(target); if (t !== r && !t.startsWith(r + path.sep)) throw new Error("path escapes storage root"); return t; }
function mkdirSafe(root: string, dir: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  let current = path.resolve(root);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("reparse point or symbolic link in storage path");
      if (stat.isDirectory()) continue;
      throw new Error("non-directory in storage path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current);
    }
  }
}
export function stageFile(input: { root: string; sourceId: string; revisionId: string; bytes: Buffer }): { path: string; hash: string } {
  const dir = safe(input.root, path.join(input.root, input.sourceId, input.revisionId)); mkdirSafe(input.root, dir);
  const finalPath = safe(dir, path.join(dir, "content")); const temporary = safe(dir, path.join(dir, ".tmp-" + process.pid + "-" + Date.now()));
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  try { const fd = openSync(temporary, "wx"); try { writeSync(fd, input.bytes); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, finalPath); return { path: finalPath, hash }; }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}
