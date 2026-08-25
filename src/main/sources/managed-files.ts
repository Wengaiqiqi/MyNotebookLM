import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import path from "node:path";
function safe(root: string, target: string): string { const r = path.resolve(root), t = path.resolve(target); if (t !== r && !t.startsWith(r + path.sep)) throw new Error("path escapes storage root"); return t; }
export function stageFile(input: { root: string; sourceId: string; revisionId: string; bytes: Buffer }): { path: string; hash: string } {
  const dir = safe(input.root, path.join(input.root, input.sourceId, input.revisionId)); mkdirSync(dir, { recursive: true });
  const finalPath = safe(dir, path.join(dir, "content")); const temporary = safe(dir, path.join(dir, ".tmp-" + process.pid + "-" + Date.now()));
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  try { const fd = openSync(temporary, "wx"); try { writeSync(fd, input.bytes); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, finalPath); return { path: finalPath, hash }; }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}
