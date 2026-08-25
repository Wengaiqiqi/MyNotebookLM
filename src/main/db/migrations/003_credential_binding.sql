CREATE TABLE credentials_bound (
  profile_id TEXT PRIMARY KEY REFERENCES model_profiles(id) ON DELETE CASCADE,
  encrypted_secret BLOB NOT NULL,
  provider TEXT NOT NULL CHECK (
    provider IN ('openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama', 'local')
  ),
  base_url TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

DROP TABLE credentials;
ALTER TABLE credentials_bound RENAME TO credentials;
