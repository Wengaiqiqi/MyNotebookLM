-- Forward-only project deletion lifecycle. Internal rows are removed by the
-- existing project foreign-key cascades after external cleanup succeeds.
ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'delete_failed'));
ALTER TABLE projects ADD COLUMN deleted_at TEXT CHECK (deleted_at IS NULL OR length(trim(deleted_at)) > 0);
CREATE INDEX idx_projects_status_updated ON projects (status, updated_at DESC);
