import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ConversationRepository } from "./conversation-repository";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ASSISTANT_ID = "55555555-5555-4555-8555-555555555555";
const REGENERATED_ID = "66666666-6666-4666-8666-666666666666";
const CITATION_ID = "77777777-7777-4777-8777-777777777777";
const SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const CHUNK_ID = "99999999-9999-4999-8999-999999999999";
const AT = "2026-08-27T00:00:00.000Z";

describe("ConversationRepository", () => {
  let database: AppDatabase;
  let repository: ConversationRepository;

  beforeEach(() => {
    database = openAppDatabase(":memory:", "src/main/db/migrations");
    database.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Project");
    database.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(OTHER_PROJECT_ID, "Other");
    database.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, ?, ?)")
      .run(SOURCE_ID, PROJECT_ID, "pdf", "Research PDF");
    database.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOURCE_ID, "original.pdf", "stored.pdf", "sha256:test", "page", "v1");
    database.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run(CHUNK_ID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0, "Evidence", JSON.stringify({ kind: "page", page: 2 }), "sha256:chunk");
    repository = new ConversationRepository(database.connection);
  });

  afterEach(() => database.close());

  function createConversation(): void {
    repository.createConversation({ id: CONVERSATION_ID, projectId: PROJECT_ID, title: "Research", createdAt: AT });
  }

  it("enforces project ownership and returns ordered messages", () => {
    createConversation();
    expect(() => repository.getConversation(OTHER_PROJECT_ID, CONVERSATION_ID)).toThrow();

    const user = repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT });
    const assistant = repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, replyToMessageId: USER_ID, provider: "openai", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "gpt-test", createdAt: AT });

    expect(user.sequence).toBe(0);
    expect(assistant.sequence).toBe(1);
    expect(repository.listMessages(PROJECT_ID, CONVERSATION_ID).map((message) => message.id)).toEqual([USER_ID, ASSISTANT_ID]);
    expect(() => repository.appendUserMessage({ projectId: OTHER_PROJECT_ID, conversationId: CONVERSATION_ID, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac", content: "No access", createdAt: AT })).toThrow();
  });

  it("allows one active assistant reply and atomically supersedes it on regenerate", () => {
    createConversation();
    repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT });
    repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, replyToMessageId: USER_ID, provider: "openai", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "gpt-test", createdAt: AT });
    expect(() => repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: REGENERATED_ID, replyToMessageId: USER_ID, provider: "openai", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "gpt-test", createdAt: AT })).toThrow();

    const regenerated = repository.regenerateAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: REGENERATED_ID, supersedesMessageId: ASSISTANT_ID, provider: "anthropic", profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", model: "claude-test", createdAt: AT });
    expect(regenerated.supersedesMessageId).toBe(ASSISTANT_ID);
    expect(regenerated.replyToMessageId).toBe(USER_ID);
    expect(repository.getMessage(PROJECT_ID, ASSISTANT_ID)?.superseded).toBe(true);
    expect(repository.listMessages(PROJECT_ID, CONVERSATION_ID).map((message) => message.id)).toEqual([USER_ID, ASSISTANT_ID, REGENERATED_ID]);
  });

  it("persists normalized completion metadata and unique citations", () => {
    createConversation();
    repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT });
    repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, replyToMessageId: USER_ID, provider: "ollama", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "llama", createdAt: AT });
    const completed = repository.completeAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, content: "Answer", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, completionReason: "stop", updatedAt: AT });
    expect(completed).toMatchObject({ state: "completed", content: "Answer", provider: "ollama", model: "llama", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, completionReason: "stop" });

    const citation = repository.addCitation({ projectId: PROJECT_ID, messageId: ASSISTANT_ID, id: CITATION_ID, label: "S1", sourceId: SOURCE_ID, sourceChunkId: CHUNK_ID, sourceDisplayName: "Research PDF", sourceKind: "pdf", locator: { kind: "page", page: 2 }, quote: "Evidence", createdAt: AT });
    expect(citation.label).toBe("S1");
    expect(repository.getMessage(PROJECT_ID, ASSISTANT_ID)?.citations).toHaveLength(1);
    expect(() => repository.addCitation({ projectId: PROJECT_ID, messageId: ASSISTANT_ID, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "S1", sourceId: SOURCE_ID, sourceChunkId: CHUNK_ID, sourceDisplayName: "Research PDF", sourceKind: "pdf", locator: { kind: "page", page: 2 }, createdAt: AT })).toThrow();
  });

  it("soft-deletes conversations and cascades all data with project deletion", () => {
    createConversation();
    repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT });
    repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, replyToMessageId: USER_ID, provider: "openai", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "gpt-test", createdAt: AT });
    repository.removeConversation(PROJECT_ID, CONVERSATION_ID, AT);
    expect(repository.listConversations(PROJECT_ID)).toEqual([]);
    expect(repository.getConversation(PROJECT_ID, CONVERSATION_ID)?.deletedAt).toBe(AT);

    database.connection.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT_ID);
    expect(database.connection.prepare("SELECT count(*) AS count FROM conversations WHERE id = ?").get(CONVERSATION_ID)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT count(*) AS count FROM messages WHERE id = ?").get(USER_ID)).toEqual({ count: 0 });
  });

  it("rejects citations for messages of another project without writing rows", () => {
    createConversation();
    repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT });
    expect(() => repository.addCitation({ projectId: OTHER_PROJECT_ID, messageId: USER_ID, id: CITATION_ID, label: "S1", sourceId: SOURCE_ID, sourceChunkId: CHUNK_ID, sourceDisplayName: "Research PDF", sourceKind: "pdf", locator: { kind: "page", page: 2 }, createdAt: AT })).toThrow();
    expect(database.connection.prepare("SELECT count(*) AS count FROM message_citations WHERE id = ?").get(CITATION_ID)).toEqual({ count: 0 });
  });

  it("rejects writes into soft-deleted conversations", () => {
    createConversation();
    repository.removeConversation(PROJECT_ID, CONVERSATION_ID, AT);
    expect(() => repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT })).toThrow();
    expect(() => repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, replyToMessageId: USER_ID, provider: "openai", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "gpt-test", createdAt: AT })).toThrow();
  });

  it("only completes streaming assistant messages once", () => {
    createConversation();
    const completion = { projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, content: "Answer", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, updatedAt: AT };
    expect(() => repository.completeAssistantMessage(completion)).toThrow();

    repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: USER_ID, content: "Question", createdAt: AT });
    expect(() => repository.completeAssistantMessage(completion)).toThrow();

    repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID, id: ASSISTANT_ID, replyToMessageId: USER_ID, provider: "openai", profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", model: "gpt-test", createdAt: AT });
    expect(repository.completeAssistantMessage(completion)?.state).toBe("completed");
    expect(() => repository.completeAssistantMessage(completion)).toThrow();
  });
});
