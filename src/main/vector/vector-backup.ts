import type Database from "better-sqlite3";
export type VectorBackup={verified:boolean;createdAt:number;path?:string};
export function keepNewestBackups(backups:VectorBackup[]):VectorBackup[]{return backups.filter(b=>b.verified).sort((a,b)=>b.createdAt-a.createdAt).slice(0,3);}
export async function backupDatabase(db:Database.Database,path:string):Promise<void>{await db.backup(path);}
