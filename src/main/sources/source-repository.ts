import path from "node:path";
export class SourceRepository { storageName(sourceId: string, revisionId: string): string { for (const id of [sourceId, revisionId]) if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("unsafe id"); return path.posix.join(sourceId, revisionId, sourceId + "-" + revisionId); } }
