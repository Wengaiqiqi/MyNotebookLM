ALTER TABLE model_profiles ADD COLUMN output_kind TEXT CHECK (output_kind IN ('text', 'speech'));

CREATE TABLE model_routes_v2 (
  task_kind TEXT NOT NULL CHECK (task_kind IN ('chat', 'note-title', 'summary', 'key-points', 'qa', 'custom-transformation', 'podcast', 'embedding')),
  position INTEGER NOT NULL CHECK (position >= 0),
  profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_kind, position), UNIQUE (task_kind, profile_id)
);
INSERT INTO model_routes_v2 SELECT * FROM model_routes;
DROP TABLE model_routes;
ALTER TABLE model_routes_v2 RENAME TO model_routes;
CREATE INDEX idx_model_routes_profile ON model_routes (profile_id);

CREATE TABLE model_route_attempts_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  task_kind TEXT NOT NULL CHECK (task_kind IN ('chat', 'note-title', 'summary', 'key-points', 'qa', 'custom-transformation', 'podcast', 'embedding')),
  attempt_order INTEGER NOT NULL CHECK (attempt_order >= 0),
  profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama', 'local')),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'completed', 'failed', 'cancelled')),
  error_code TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT, finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  is_fallback INTEGER NOT NULL DEFAULT 0 CHECK (is_fallback IN (0, 1))
);
INSERT INTO model_route_attempts_v2 SELECT * FROM model_route_attempts;
DROP TABLE model_route_attempts;
ALTER TABLE model_route_attempts_v2 RENAME TO model_route_attempts;
CREATE UNIQUE INDEX idx_model_route_attempts_operation_order ON model_route_attempts (operation_id, attempt_order);
CREATE INDEX idx_model_route_attempts_project_order ON model_route_attempts (project_id, created_at, attempt_order);
CREATE INDEX idx_model_route_attempts_fallback_history ON model_route_attempts (project_id, task_kind, is_fallback, created_at DESC);

-- ponytail: bounded audio blobs keep result commits and deletion atomic; use managed files for large libraries.
CREATE TABLE podcast_audio (
  insight_id TEXT PRIMARY KEY REFERENCES insights(id) ON DELETE CASCADE,
  wav BLOB NOT NULL CHECK (length(wav) BETWEEN 44 AND 67108864)
);
