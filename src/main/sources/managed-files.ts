import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, unlinkSync, writeSync, linkSync } from "node:fs";
import path from "node:path";
function safe(root: string, target: string): string { const r = path.resolve(root), t = path.resolve(target); if (t !== r && !t.startsWith(r + path.sep)) throw new Error("path escapes storage root"); return t; }
function mkdirSafe(root: string, dir: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  let current = path.resolve(root);
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink()) throw new Error("reparse point or symbolic link in storage path");
  if (path.resolve(realpathSync(current)) !== current) throw new Error("reparse point or symbolic link in storage path");
  if (!rootStat.isDirectory()) throw new Error("storage root is not a directory");
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("reparse point or symbolic link in storage path");
      if (path.resolve(realpathSync(current)) !== current) throw new Error("reparse point or symbolic link in storage path");
      if (stat.isDirectory()) continue;
      throw new Error("non-directory in storage path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        mkdirSync(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const created = lstatSync(current);
        if (created.isSymbolicLink()) throw new Error("reparse point or symbolic link in storage path");
        if (path.resolve(realpathSync(current)) !== current) throw new Error("reparse point or symbolic link in storage path");
        if (!created.isDirectory()) throw new Error("non-directory in storage path");
      }
    }
  }
}
export function stageFile(input: { root: string; sourceId: string; revisionId: string; bytes: Buffer }): { path: string; hash: string } {
  try { mkdirSync(path.resolve(input.root), { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const dir = safe(input.root, path.join(input.root, input.sourceId, input.revisionId)); mkdirSafe(input.root, dir);
  const finalPath = safe(dir, path.join(dir, "content"));
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const tempPath = safe(dir, path.join(dir, `.content-${randomUUID()}.tmp`));
  let tempCreated = false;
  try {
    const fd = openSync(tempPath, "wx");
    tempCreated = true;
    let operationError: unknown;
    try { writeSync(fd, input.bytes); fsyncSync(fd); } catch (error) { operationError = error; }
    try {
      closeSync(fd);
    } catch (error) {
      if (operationError === undefined) operationError = error;
      // A failed close is not proof that the descriptor is still open. Retry once
      // so cleanup never relies on an unverified Windows handle state.
      try { closeSync(fd); } catch { /* preserve the first operation error */ }
    }
    if (operationError !== undefined) throw operationError;
    linkSync(tempPath, finalPath);
    tempCreated = false;
    try { unlinkSync(tempPath); } catch { /* linkSync committed; cleanup failure is not a commit failure */ }
    return { path: finalPath, hash };
  } catch (error) {
    if (tempCreated) { try { rmSync(tempPath, { force: true }); } catch { /* preserve the operation error */ } }
    throw error;
  }
}
