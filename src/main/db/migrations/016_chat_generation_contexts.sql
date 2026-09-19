CREATE TABLE chat_generation_contexts (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  runtime_json TEXT NOT NULL CHECK(json_valid(runtime_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  active_request_id TEXT UNIQUE
);
