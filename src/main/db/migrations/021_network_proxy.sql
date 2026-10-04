ALTER TABLE app_settings ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'system'
  CHECK (proxy_mode IN ('system', 'direct', 'manual'));
ALTER TABLE app_settings ADD COLUMN proxy_url TEXT NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN proxy_bypass TEXT NOT NULL DEFAULT '';
