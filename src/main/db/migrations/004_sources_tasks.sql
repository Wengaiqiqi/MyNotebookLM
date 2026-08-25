CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('text', 'markdown', 'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'url')
  ),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'deleting', 'deleted')
  ),
  current_revision_id TEXT REFERENCES source_revisions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT CHECK (deleted_at IS NULL OR (deleted_at <> '' AND deleted_at >= created_at))
);

CREATE UNIQUE INDEX idx_sources_project_status_id
ON sources (project_id, status, id);

CREATE INDEX idx_sources_project_status
ON sources (project_id, status, updated_at DESC);

CREATE INDEX idx_sources_current_revision
ON sources (current_revision_id);

CREATE TABLE source_revisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  original_path TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  locator_kind TEXT NOT NULL CHECK (
    locator_kind IN ('page', 'slide', 'sheet', 'cell', 'row', 'heading', 'paragraph', 'section', 'offset')
  ),
  chunking_version TEXT NOT NULL CHECK (length(trim(chunking_version)) BETWEEN 1 AND 100),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'parsing', 'awaiting_embedding', 'ready', 'failed')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  activated_at TEXT
);

CREATE INDEX idx_source_revisions_source_state
ON source_revisions (source_id, state, created_at DESC);

CREATE INDEX idx_source_revisions_source_active
ON source_revisions (source_id, state)
WHERE state = 'ready';

CREATE TABLE source_chunks (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  text TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (revision_id, ordinal)
);

CREATE INDEX idx_source_chunks_revision_ordinal
ON source_chunks (revision_id, ordinal);

CREATE INDEX idx_source_chunks_revision_hash
ON source_chunks (content_hash);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('validation', 'ingest', 'delete')
  ),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  stage TEXT NOT NULL CHECK (
    stage IN (
      'validating', 'staging', 'parsing', 'chunking', 'embedding',
      'indexing', 'verifying', 'cleanup', 'finalizing'
    )
  ),
  progress_1000 INTEGER NOT NULL DEFAULT 0 CHECK (progress_1000 BETWEEN 0 AND 1000),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tasks_project_state_created
ON tasks (project_id, state, created_at DESC);

CREATE INDEX idx_tasks_source_created
ON tasks (source_id, created_at DESC);
