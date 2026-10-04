ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'mindmap-node'));

CREATE TABLE mind_map_views (
  insight_id TEXT PRIMARY KEY REFERENCES insights(id) ON DELETE CASCADE,
  view_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE mind_map_conversations (
  insight_id TEXT NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  PRIMARY KEY (insight_id, node_id)
);

CREATE TRIGGER mind_map_conversations_ownership
BEFORE INSERT ON mind_map_conversations
BEGIN
  SELECT RAISE(ABORT, 'mind map conversation project mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM insights i JOIN conversations c ON c.id = NEW.conversation_id
    WHERE i.id = NEW.insight_id AND i.project_id = c.project_id AND c.kind = 'mindmap-node'
  );
END;

CREATE TRIGGER mind_map_conversations_delete
BEFORE DELETE ON insights
BEGIN
  UPDATE conversations SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id IN (SELECT conversation_id FROM mind_map_conversations WHERE insight_id = OLD.id);
END;
