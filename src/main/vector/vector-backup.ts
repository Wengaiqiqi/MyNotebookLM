import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFile, readFile, rename, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
export type VectorBackup = { verified: boolean; createdAt: number; path?: string };
export function keepNewestBackups(backups: VectorBackup[]): VectorBackup[] { return backups.filter((b) => b.verified).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3); }
export async function backupDatabase(db: Database.Database, path: string): Promise<VectorBackup & { sha256: string }> {
  const temp = path + ".tmp", check = path + ".verify", createdAt = Date.now();
  await unlink(temp).catch(() => {}); await unlink(check).catch(() => {});
  try {
    await db.backup(temp);
    const sha256 = createHash("sha256").update(await readFile(temp)).digest("hex");
    await copyFile(temp, check);
    const copy = new Database(check);
    const verified = copy.pragma("integrity_check", { simple: true }) === "ok" && copy.prepare("SELECT name FROM sqlite_master LIMIT 1").get() !== undefined && createHash("sha256").update(await readFile(check)).digest("hex") === sha256;
    copy.close(); if (!verified) throw new Error("backup verification failed");
    await rename(temp, path); await writeFile(path + ".json", JSON.stringify({ verified, createdAt, path, sha256 }));
    const metas: Array<{ verified: boolean; createdAt: number; path: string }> = [];
    for (const file of (await readdir(dirname(path))).filter((name) => name.endsWith(".json"))) { try { const meta = JSON.parse(await readFile(dirname(path) + "/" + file, "utf8")); if (meta.verified === true && typeof meta.path === "string" && typeof meta.createdAt === "number") metas.push(meta); } catch {} }
    for (const old of metas.sort((a, b) => b.createdAt - a.createdAt).slice(3)) { await unlink(old.path).catch(() => {}); await unlink(old.path + ".json").catch(() => {}); }
    return { verified, createdAt, path, sha256 };
  } finally { await unlink(temp).catch(() => {}); await unlink(check).catch(() => {}); }
}
