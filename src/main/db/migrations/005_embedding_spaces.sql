CREATE TABLE embedding_spaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  distance TEXT NOT NULL CHECK (distance IN ('cosine')),
  pooling TEXT NOT NULL CHECK (pooling IN ('mean')),
  preprocess_version TEXT NOT NULL,
  chunking_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing','building','validating','active','failed','retired')),
  progress_1000 INTEGER NOT NULL DEFAULT 0 CHECK (progress_1000 BETWEEN 0 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_embedding_spaces_project_fingerprint ON embedding_spaces(project_id, fingerprint);
CREATE UNIQUE INDEX idx_embedding_spaces_project_active ON embedding_spaces(project_id) WHERE state = 'active';
CREATE TABLE project_embedding_spaces (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);
CREATE TABLE model_artifacts (
  id TEXT PRIMARY KEY,
  artifact_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('missing','downloading','verifying','ready','failed')),
  progress_1000 INTEGER NOT NULL DEFAULT 0 CHECK (progress_1000 BETWEEN 0 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER embedding_spaces_immutable_fingerprint
BEFORE UPDATE OF project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint
ON embedding_spaces
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.provider IS NOT NEW.provider OR OLD.model_id IS NOT NEW.model_id OR OLD.model_revision IS NOT NEW.model_revision OR OLD.dimension IS NOT NEW.dimension OR OLD.distance IS NOT NEW.distance OR OLD.pooling IS NOT NEW.pooling OR OLD.preprocess_version IS NOT NEW.preprocess_version OR OLD.chunking_version IS NOT NEW.chunking_version OR OLD.fingerprint IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT, 'embedding space fingerprint fields are immutable'); END;
