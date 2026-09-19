ALTER TABLE model_route_attempts
ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0 CHECK (is_fallback IN (0, 1));

CREATE INDEX idx_model_route_attempts_fallback_history
ON model_route_attempts (project_id, task_kind, is_fallback, created_at DESC);
