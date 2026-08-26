ALTER TABLE tasks RENAME TO tasks_before_space_tasks;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('validation','ingest','delete','optimize')), state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','failed','cancelled')),
  stage TEXT NOT NULL CHECK (stage IN ('validating','staging','parsing','chunking','embedding','indexing','verifying','cleanup','finalizing')), progress_1000 INTEGER NOT NULL DEFAULT 0 CHECK (progress_1000 BETWEEN 0 AND 1000),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0), error_code TEXT, error_message TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO tasks (id, project_id, source_id, kind, state, stage, progress_1000, attempt, error_code, error_message, idempotency_key, created_at, updated_at)
SELECT id, project_id, source_id, kind, state, stage, progress_1000, attempt, error_code, error_message, idempotency_key, created_at, updated_at FROM tasks_before_space_tasks;
DROP TABLE tasks_before_space_tasks;
CREATE INDEX idx_tasks_project_state_created ON tasks(project_id, state, created_at DESC);
CREATE INDEX idx_tasks_source_created ON tasks(source_id, created_at DESC);
