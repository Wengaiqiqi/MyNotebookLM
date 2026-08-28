import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync, linkSync, readdirSync } from "node:fs";
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

/** Remove only source-owned directories beneath the managed files root. */
export function removeProjectFiles(root: string, sourceIds: readonly string[]): void {
  const resolvedRoot = path.resolve(root);
  assertSafeDirectory(resolvedRoot);
  for (const sourceId of sourceIds) {
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new Error("invalid managed source id");
    const directory = safe(resolvedRoot, path.join(resolvedRoot, sourceId));
    assertSafePath(resolvedRoot, directory);
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertSafePath(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) throw new Error("path escapes storage root");
  let current = resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && current === resolvedTarget) return; throw error; }
    if (stat.isSymbolicLink() || path.resolve(realpathSync(current)) !== current) throw new Error("reparse point or symbolic link in storage path");
  }
}

function assertSafeDirectory(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(realpathSync(root)) !== root) throw new Error("reparse point or symbolic link in storage path");
}

export type StagedProjectFiles = { rollback(): void; purge(): void };

/** Purge deterministic trash only after the database no longer contains the project. */
export function purgeOrphanProjectTrash(root: string, liveProjectIds: ReadonlySet<string>): void {
  const resolvedRoot = path.resolve(root);
  assertSafeDirectory(resolvedRoot);
  const trashRoot = safe(resolvedRoot, path.join(resolvedRoot, ".project-trash"));
  if (!lstatSafe(trashRoot)) return;
  assertSafeDirectory(trashRoot);
  for (const projectId of readdirSync(trashRoot)) {
    if (!/^[0-9a-f-]{36}$/i.test(projectId) || liveProjectIds.has(projectId)) continue;
    const target = safe(trashRoot, path.join(trashRoot, projectId));
    assertSafePath(trashRoot, target);
    rmSync(target, { recursive: true, force: true });
  }
}

function projectTrash(root: string, projectId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error("invalid project id");
  const trashRoot = safe(root, path.join(root, ".project-trash"));
  mkdirSafe(root, trashRoot);
  const trash = safe(trashRoot, path.join(trashRoot, projectId));
  try { mkdirSafe(trashRoot, trash); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(trash);
    mkdirSafe(trashRoot, trash);
  }
  return trash;
}

/** Stage source directories into same-volume trash; rollback remains possible until DB finalization. */
export function stageProjectFiles(root: string, projectId: string, sourceIds: readonly string[]): StagedProjectFiles {
  const resolvedRoot = path.resolve(root);
  assertSafeDirectory(resolvedRoot);
  const trash = projectTrash(resolvedRoot, projectId);
  const moved: Array<{ source: string; staged: string }> = [];
  try {
    for (const sourceId of sourceIds) {
      if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new Error("invalid managed source id");
      const source = safe(resolvedRoot, path.join(resolvedRoot, sourceId));
      assertSafePath(resolvedRoot, source);
      if (!lstatSafe(source)) continue;
      const staged = safe(trash, path.join(trash, sourceId));
      if (lstatSafe(staged)) throw new Error(`managed source already staged: ${sourceId}`);
      renameSync(source, staged);
      moved.push({ source, staged });
    }
  } catch (error) {
    for (const item of moved.reverse()) { try { if (lstatSafe(item.staged) && !lstatSafe(item.source)) renameSync(item.staged, item.source); } catch { /* preserve original error and trash for recovery */ } }
    throw error;
  }
  return {
    rollback: () => { restoreProjectFiles(resolvedRoot, projectId, sourceIds); },
    purge: () => rmSync(trash, { recursive: true, force: true })
  };
}

/** Restore deterministic staged files; safe to repeat after a crash. */
export function restoreProjectFiles(root: string, projectId: string, sourceIds: readonly string[]): void {
  const resolvedRoot = path.resolve(root);
  assertSafeDirectory(resolvedRoot);
  const trash = projectTrash(resolvedRoot, projectId);
  for (const sourceId of sourceIds) {
    if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new Error("invalid managed source id");
    const source = safe(resolvedRoot, path.join(resolvedRoot, sourceId));
    const staged = safe(trash, path.join(trash, sourceId));
    assertSafePath(resolvedRoot, source);
    if (lstatSafe(source) && lstatSafe(staged)) throw new Error(`managed source exists in source and trash: ${sourceId}`);
    if (!lstatSafe(source) && lstatSafe(staged)) renameSync(staged, source);
  }
}

function lstatSafe(target: string): boolean {
  try { const stat = lstatSync(target); if (stat.isSymbolicLink() || path.resolve(realpathSync(target)) !== path.resolve(target)) throw new Error("reparse point or symbolic link in storage path"); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
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
