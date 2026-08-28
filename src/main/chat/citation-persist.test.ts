import Database from "better-sqlite3";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { finalizeCitations, type RetrievedCitation } from "./citation-parser";
import { persistParsedCitations } from "./citation-persist";

const retrievals: Record<string, RetrievedCitation> = {
  S1: { label: "S1", chunkId: "chunk-1", sourceId: "source-1", sourceDisplayName: "Doc", sourceKind: "pdf", locator: { kind: "page", page: 1 }, text: "A reliable source excerpt." },
};

describe("persistParsedCitations", () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = openAppDatabase(":memory:", resolve("src/main/db/migrations"));
    database.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run("p1", "Project");
    database.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, ?, ?)").run("source-1", "p1", "pdf", "Doc");
    database.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version) VALUES (?, ?, ?, ?, ?, ?, ?)").run("rev-1", "source-1", "o.pdf", "s.pdf", "h", "page", "v1");
    database.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)").run("chunk-1", "rev-1", 0, "text", "{}", "hc");
    database.connection.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("c1", "p1", "Chat", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.connection.prepare("INSERT INTO messages(id, conversation_id, sequence, role, content, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("m1", "c1", 0, "assistant", "", "streaming", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  });

  afterEach(() => database.close());

  it("persists repeated markers as separate rows per character position", () => {
    const parsed = finalizeCitations("See [S1] and again [S1].", retrievals);
    const stored = persistParsedCitations(database.connection, { projectId: "p1", messageId: "m1", parsed, retrievals });
    expect(stored.map((c) => c.id)).toEqual(["m1:S1:4", "m1:S1:19"]);
    expect(stored[0]?.quote).toBe("A reliable source excerpt.");
  });

  it("caps persisted source excerpts", () => {
    const longText = "x".repeat(400);
    const parsed = finalizeCitations("See [S1].", { S1: { ...retrievals.S1!, text: longText } });
    const stored = persistParsedCitations(database.connection, { projectId: "p1", messageId: "m1", parsed, retrievals: { S1: { ...retrievals.S1!, text: longText } } });
    expect(stored[0]?.quote).toHaveLength(240);
  });
});
