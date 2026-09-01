DROP TRIGGER note_links_project_ownership_insert;
DROP TRIGGER note_links_project_ownership_update;
DROP TRIGGER notes_project_ownership_update;
DROP TRIGGER sources_project_ownership_update;
DROP TRIGGER conversations_project_ownership_update;

ALTER TABLE note_links RENAME TO note_links_legacy;

CREATE TABLE note_links (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  citation_id TEXT REFERENCES message_citations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (target_project_id IS NOT NULL) + (source_id IS NOT NULL) +
    (message_id IS NOT NULL) + (citation_id IS NOT NULL) = 1
  )
);

INSERT INTO note_links(id, note_id, source_id, message_id, citation_id, created_at)
SELECT id, note_id, source_id, message_id, citation_id, created_at
FROM note_links_legacy;

DROP TABLE note_links_legacy;

CREATE UNIQUE INDEX idx_note_links_project
ON note_links (note_id, target_project_id) WHERE target_project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_note_links_source
ON note_links (note_id, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX idx_note_links_message
ON note_links (note_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_note_links_citation
ON note_links (note_id, citation_id) WHERE citation_id IS NOT NULL;

CREATE TRIGGER notes_project_ownership_update
BEFORE UPDATE OF project_id ON notes
BEGIN
  SELECT RAISE(ABORT, 'note link project ownership')
  WHERE EXISTS (SELECT 1 FROM note_links WHERE note_id = OLD.id);
END;

CREATE TRIGGER sources_project_ownership_update
BEFORE UPDATE OF project_id ON sources
BEGIN
  SELECT RAISE(ABORT, 'note link project ownership')
  WHERE EXISTS (SELECT 1 FROM note_links WHERE source_id = OLD.id)
     OR EXISTS (SELECT 1 FROM message_citations WHERE source_id = OLD.id AND EXISTS (
       SELECT 1 FROM note_links WHERE citation_id = message_citations.id
     ));
END;

CREATE TRIGGER conversations_project_ownership_update
BEFORE UPDATE OF project_id ON conversations
BEGIN
  SELECT RAISE(ABORT, 'note link project ownership')
  WHERE EXISTS (
    SELECT 1 FROM messages m JOIN note_links l ON l.message_id = m.id
    WHERE m.conversation_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM messages m JOIN message_citations c ON c.message_id = m.id
    JOIN note_links l ON l.citation_id = c.id WHERE m.conversation_id = OLD.id
  );
END;
