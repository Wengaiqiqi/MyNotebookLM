CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 2097152),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at TEXT CHECK (archived_at IS NULL OR length(trim(archived_at)) > 0),
  deleted_at TEXT CHECK (deleted_at IS NULL OR length(trim(deleted_at)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_notes_project_state_updated
ON notes (project_id, deleted_at, archived_at, updated_at DESC);

CREATE TABLE note_links (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  citation_id TEXT REFERENCES message_citations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (source_id IS NOT NULL) + (message_id IS NOT NULL) + (citation_id IS NOT NULL) = 1
  )
);

CREATE UNIQUE INDEX idx_note_links_source
ON note_links (note_id, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX idx_note_links_message
ON note_links (note_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_note_links_citation
ON note_links (note_id, citation_id) WHERE citation_id IS NOT NULL;

CREATE TRIGGER note_links_project_ownership_insert
BEFORE INSERT ON note_links
BEGIN
  SELECT RAISE(ABORT, 'note link project mismatch')
  WHERE
    (NEW.source_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notes n JOIN sources s ON s.id = NEW.source_id
      WHERE n.id = NEW.note_id AND n.project_id = s.project_id
    ))
    OR (NEW.message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notes n JOIN messages m ON m.id = NEW.message_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE n.id = NEW.note_id AND n.project_id = c.project_id
    ))
    OR (NEW.citation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notes n JOIN message_citations mc ON mc.id = NEW.citation_id
      JOIN sources s ON s.id = mc.source_id
      WHERE n.id = NEW.note_id AND n.project_id = s.project_id
    ));
END;

CREATE TRIGGER note_links_project_ownership_update
BEFORE UPDATE OF note_id, source_id, message_id, citation_id ON note_links
BEGIN
  SELECT RAISE(ABORT, 'note link project mismatch')
  WHERE
    (NEW.source_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notes n JOIN sources s ON s.id = NEW.source_id
      WHERE n.id = NEW.note_id AND n.project_id = s.project_id
    ))
    OR (NEW.message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notes n JOIN messages m ON m.id = NEW.message_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE n.id = NEW.note_id AND n.project_id = c.project_id
    ))
    OR (NEW.citation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notes n JOIN message_citations mc ON mc.id = NEW.citation_id
      JOIN sources s ON s.id = mc.source_id
      WHERE n.id = NEW.note_id AND n.project_id = s.project_id
    ));
END;

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

CREATE TABLE transformations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  applies_to TEXT NOT NULL CHECK (applies_to IN ('source', 'sources', 'message', 'answer', 'note')),
  prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0 AND length(CAST(prompt AS BLOB)) <= 20480),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_transformations_project_enabled
ON transformations (project_id, enabled, updated_at DESC);

CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transformation_id TEXT REFERENCES transformations(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  input_kind TEXT,
  input_hash TEXT,
  rule_version INTEGER CHECK (rule_version IS NULL OR rule_version >= 1),
  content TEXT NOT NULL,
  provider TEXT CHECK (provider IS NULL OR provider IN ('openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama', 'local')),
  model TEXT CHECK (model IS NULL OR length(trim(model)) BETWEEN 1 AND 200),
  profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  usage_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_insights_project_created
ON insights (project_id, created_at DESC);

CREATE TRIGGER insights_project_ownership_insert
BEFORE INSERT ON insights
BEGIN
  SELECT RAISE(ABORT, 'insight project mismatch')
  WHERE (NEW.transformation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transformations t
    WHERE t.id = NEW.transformation_id AND t.project_id = NEW.project_id
  ))
  OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id
  ));
END;

CREATE TRIGGER insights_project_ownership_update
BEFORE UPDATE OF project_id, transformation_id, task_id ON insights
BEGIN
  SELECT RAISE(ABORT, 'insight project mismatch')
  WHERE (NEW.transformation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transformations t
    WHERE t.id = NEW.transformation_id AND t.project_id = NEW.project_id
  ))
  OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id
  ));
END;

CREATE TABLE model_route_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  task_kind TEXT NOT NULL CHECK (task_kind IN ('chat', 'note-title', 'summary', 'key-points', 'qa', 'custom-transformation', 'embedding')),
  attempt_order INTEGER NOT NULL CHECK (attempt_order >= 0),
  profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama', 'local')),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'completed', 'failed', 'cancelled')),
  error_code TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_model_route_attempts_operation_order
ON model_route_attempts (operation_id, attempt_order);
CREATE INDEX idx_model_route_attempts_project_order
ON model_route_attempts (project_id, created_at, attempt_order);
