ALTER TABLE message_citations RENAME TO message_citations_old;
CREATE TABLE message_citations (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, label TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, source_chunk_id TEXT REFERENCES source_chunks(id) ON DELETE SET NULL, source_display_name TEXT NOT NULL, source_kind TEXT NOT NULL, locator_json TEXT NOT NULL, quote TEXT, created_at TEXT NOT NULL, start INTEGER NOT NULL DEFAULT 0);
INSERT INTO message_citations (id, message_id, label, source_id, source_chunk_id, source_display_name, source_kind, locator_json, quote, created_at, start) SELECT id, message_id, label, source_id, source_chunk_id, source_display_name, source_kind, locator_json, quote, created_at, 0 FROM message_citations_old;
DROP TABLE message_citations_old;
CREATE UNIQUE INDEX idx_message_citations_position ON message_citations(message_id, label, start);
