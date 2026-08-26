import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
export type VectorBackup={verified:boolean;createdAt:number;path?:string};
export function keepNewestBackups(backups:VectorBackup[]):VectorBackup[]{return backups.filter(b=>b.verified).sort((a,b)=>b.createdAt-a.createdAt).slice(0,3);}
export async function backupDatabase(db:Database.Database,path:string):Promise<VectorBackup & {sha256:string}>{const temp=path+".tmp"; await db.backup(temp); const bytes=await readFile(temp); const sha256=createHash("sha256").update(bytes).digest("hex"); const check=path+".verify"; await copyFile(temp,check); const verified=createHash("sha256").update(await readFile(check)).digest("hex")===sha256; if(!verified) throw new Error("backup verification failed"); await rename(temp,path); await writeFile(path+".json",JSON.stringify({verified,createdAt:Date.now(),path,sha256})); return {verified,createdAt:Date.now(),path,sha256};}
