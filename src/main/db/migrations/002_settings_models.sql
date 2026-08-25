CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  onboarding_completed INTEGER NOT NULL DEFAULT 0
    CHECK (onboarding_completed IN (0, 1)),
  locale TEXT NOT NULL DEFAULT 'zh-CN'
    CHECK (locale IN ('zh-CN', 'en')),
  theme TEXT NOT NULL DEFAULT 'light'
    CHECK (theme IN ('light', 'dark')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO app_settings(id) VALUES (1);

CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  provider TEXT NOT NULL CHECK (
    provider IN ('openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama', 'local')
  ),
  capability TEXT NOT NULL CHECK (capability IN ('generation', 'embedding')),
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (length(trim(model_id)) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE model_routes (
  task_kind TEXT NOT NULL CHECK (
    task_kind IN (
      'chat',
      'note-title',
      'summary',
      'key-points',
      'qa',
      'custom-transformation',
      'embedding'
    )
  ),
  position INTEGER NOT NULL CHECK (position >= 0),
  profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (task_kind, position),
  UNIQUE (task_kind, profile_id)
);

CREATE TABLE credentials (
  profile_id TEXT PRIMARY KEY REFERENCES model_profiles(id) ON DELETE CASCADE,
  encrypted_secret BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_model_profiles_capability_enabled
ON model_profiles (capability, enabled, updated_at DESC);

CREATE INDEX idx_model_routes_profile
ON model_routes (profile_id);
