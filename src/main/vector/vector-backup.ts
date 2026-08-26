import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
export type VectorBackup = { verified: boolean; createdAt: number; path?: string };
export function keepNewestBackups(backups: VectorBackup[]): VectorBackup[] { return backups.filter((b) => b.verified).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3); }
type BackupMeta = VectorBackup & { path: string; sha256: string };
async function isVerifiedBackup(filePath: string, sha256?: string): Promise<boolean> {
  let copy: Database.Database | undefined;
  try {
    copy = new Database(filePath);
    if (copy.pragma("integrity_check", { simple: true }) !== "ok") return false;
  } catch { return false; }
  finally { copy?.close(); }
  return sha256 === undefined || createHash("sha256").update(await readFile(filePath)).digest("hex") === sha256;
}
async function verifiedMetadata(directory: string): Promise<BackupMeta[]> {
  const metas: BackupMeta[] = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".json"))) {
    try {
      const meta = JSON.parse(await readFile(resolve(directory, file), "utf8")) as Partial<BackupMeta>;
      if (meta.verified === true && typeof meta.createdAt === "number" && typeof meta.path === "string" && typeof meta.sha256 === "string" && !meta.path.endsWith(".tmp") && !meta.path.endsWith(".verify") && await isVerifiedBackup(meta.path, meta.sha256)) metas.push(meta as BackupMeta);
    } catch {}
  }
  return metas;
}
export async function backupDatabase(db: Database.Database, targetPath: string): Promise<VectorBackup & { sha256: string }> {
  const temp = targetPath + ".tmp", check = targetPath + ".verify", createdAt = Date.now();
  await unlink(temp).catch(() => {}); await unlink(check).catch(() => {});
  try {
    await db.backup(temp);
    if (!await isVerifiedBackup(temp, createHash("sha256").update(await readFile(temp)).digest("hex"))) throw new Error("backup verification failed");
    const sha256 = createHash("sha256").update(await readFile(temp)).digest("hex");
    await rename(temp, targetPath);
    await writeFile(targetPath + ".json", JSON.stringify({ verified: true, createdAt, path: targetPath, sha256 }));
    for (const old of (await verifiedMetadata(dirname(targetPath))).sort((a, b) => b.createdAt - a.createdAt).slice(3)) { await unlink(old.path).catch(() => {}); await unlink(old.path + ".json").catch(() => {}); }
    return { verified: true, createdAt, path: targetPath, sha256 };
  } finally { await unlink(temp).catch(() => {}); await unlink(check).catch(() => {}); }
}
