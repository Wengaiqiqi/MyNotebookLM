CREATE TABLE credentials_bound (
  profile_id TEXT PRIMARY KEY REFERENCES model_profiles(id) ON DELETE CASCADE,
  encrypted_secret BLOB NOT NULL,
  provider TEXT NOT NULL CHECK (
    provider IN ('openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama', 'local')
  ),
  base_url TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO credentials_bound(profile_id, encrypted_secret, provider, base_url, updated_at)
SELECT credentials.profile_id,
       credentials.encrypted_secret,
       model_profiles.provider,
       CASE
         WHEN instr(
           substr(
             rtrim(model_profiles.base_url, '/'),
             instr(rtrim(model_profiles.base_url, '/'), '://') + 3
           ),
           '/'
         ) = 0
         THEN rtrim(model_profiles.base_url, '/') || '/'
         ELSE rtrim(model_profiles.base_url, '/')
       END,
       credentials.updated_at
FROM credentials
JOIN model_profiles ON model_profiles.id = credentials.profile_id;

DROP TABLE credentials;
ALTER TABLE credentials_bound RENAME TO credentials;
