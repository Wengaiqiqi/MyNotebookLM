-- Task 7 extends the durable task state machine without changing prior migrations.
-- insights.task_id is rebuilt first so SQLite can safely rebuild its parent table.
CREATE TABLE insights_backup AS SELECT * FROM insights;
DROP TABLE insights;

CREATE TABLE tasks_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('validation', 'ingest', 'delete', 'optimize', 'transformation')
  ),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  stage TEXT NOT NULL CHECK (
    stage IN (
      'validating', 'staging', 'parsing', 'chunking', 'embedding',
      'indexing', 'verifying', 'cleanup', 'finalizing',
      'preparing', 'generating', 'saving'
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

INSERT INTO tasks_v2(
  id, project_id, source_id, kind, state, stage, progress_1000, attempt,
  error_code, error_message, idempotency_key, created_at, updated_at
)
SELECT id, project_id, source_id, kind, state, stage, progress_1000, attempt,
  error_code, error_message, idempotency_key, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;

CREATE INDEX idx_tasks_project_state_created
ON tasks (project_id, state, created_at DESC);

CREATE INDEX idx_tasks_source_created
ON tasks (source_id, created_at DESC);

CREATE TABLE transformation_task_snapshots (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('source', 'sources', 'message', 'answer', 'note')),
  input_snapshot_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  transformation_id TEXT REFERENCES transformations(id) ON DELETE SET NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
  rendered_prompt_version TEXT NOT NULL,
  rendered_prompt TEXT NOT NULL,
  route_snapshot_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_transformation_snapshots_project
ON transformation_task_snapshots (project_id, updated_at DESC);

CREATE TRIGGER transformation_snapshots_project_ownership_insert
BEFORE INSERT ON transformation_task_snapshots
BEGIN
  SELECT RAISE(ABORT, 'transformation snapshot project mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id);
END;

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

CREATE INDEX idx_insights_project_created ON insights (project_id, created_at DESC);

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

INSERT INTO insights(
  id, project_id, transformation_id, task_id, input_kind, input_hash,
  rule_version, content, provider, model, profile_id, usage_json,
  idempotency_key, created_at, updated_at
)
SELECT id, project_id, transformation_id, task_id, input_kind, input_hash,
  rule_version, content, provider, model, profile_id, usage_json,
  idempotency_key, created_at, updated_at
FROM insights_backup;
DROP TABLE insights_backup;

CREATE TRIGGER transformation_snapshots_project_ownership_update
BEFORE UPDATE OF task_id, project_id ON transformation_task_snapshots
BEGIN
  SELECT RAISE(ABORT, 'transformation snapshot project mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id);
END;
