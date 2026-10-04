import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "../db/database";
import { replaceRevisionChunks } from "./ingestion-service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const chunk = (ordinal: number, text: string) => ({ ordinal, text, contentHash: "hash-" + text, tokenEstimate: 1, locator: { kind: "paragraph" as const, paragraph: ordinal + 1 } });

describe("replaceRevisionChunks", () => {
  it("keeps deterministic chunk ids and re-links citations to chunks with the same content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "revision-chunks-")); roots.push(root);
    const db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    const c = db.connection;
    const now = new Date().toISOString();
    c.prepare("INSERT INTO projects(id,name) VALUES(?,?)").run("p", "P");
    c.prepare("INSERT INTO sources(id,project_id,kind,display_name) VALUES(?,?,?,?)").run("src", "p", "text", "x");
    c.prepare("INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES(?,?,?,?,?,?,?,?)").run("rev", "src", "a.txt", "a.txt", "h", "offset", "v1", "ready");
    c.transaction(() => replaceRevisionChunks(c, "rev", [chunk(0, "alpha"), chunk(1, "beta")]))();
    c.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)").run("conv", "p", "t", now, now);
    c.prepare("INSERT INTO messages(id,conversation_id,sequence,role,content,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("m", "conv", 1, "assistant", "beta [S1] gone [S2]", "completed", now, now);
    const cite = c.prepare("INSERT INTO message_citations(id,message_id,label,source_id,source_chunk_id,source_display_name,source_kind,locator_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
    cite.run("c1", "m", "S1", "src", "rev-1", "x", "text", "{}", now);
    cite.run("c2", "m", "S2", "src", "rev-0", "x", "text", "{}", now);

    // Re-chunking moves "beta" to ordinal 0 and drops "alpha".
    c.transaction(() => replaceRevisionChunks(c, "rev", [chunk(0, "beta"), chunk(1, "gamma")]))();

    expect(c.prepare("SELECT id FROM source_chunks WHERE revision_id = ? ORDER BY ordinal").all("rev")).toEqual([{ id: "rev-0" }, { id: "rev-1" }]);
    expect(c.prepare("SELECT id, source_chunk_id FROM message_citations ORDER BY id").all()).toEqual([
      { id: "c1", source_chunk_id: "rev-0" },
      { id: "c2", source_chunk_id: null }
    ]);
    db.close();
  });
});
