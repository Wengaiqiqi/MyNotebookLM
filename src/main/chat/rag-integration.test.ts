import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { LanceStore } from "../vector/lance-store";
import { canonicalEmbeddingFingerprint } from "../vector/indexing-service";
import type { EmbeddingFingerprint } from "../../shared/vector";
import { RetrievalService } from "../retrieval/retrieval-service";
import type { RetrievableChunk } from "./chat-service";
import { ChatService } from "./chat-service";
import { CitationOpener } from "./citation-opener";
import type { ModelProfileDto } from "../../shared/models";
import type { GenerationEvent, ModelDescriptor } from "../models/provider";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_A = "99999999-9999-4999-8999-99999999999a";
const CHUNK_B = "99999999-9999-4999-8999-99999999999b";
const SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const REVISION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_ID = "55555555-5555-4555-8555-555555555555";
const AT = "2026-08-27T00:00:00.000Z";
const DIMENSION = 2;

type StoredRow = { chunkId: string; projectId: string; sourceId: string; revisionId: string; spaceId: string; ordinal: number; contentHash: string; text: string; vector: number[]; locator: Record<string, unknown>; createdAt: number };

type FakeGeneration = {
  describe(): never;
  discover(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  generate(request: unknown, signal: AbortSignal): AsyncGenerator<GenerationEvent>;
  embed(): Promise<number[][]>;
};

/** Deterministic bag-of-words query embedding; identical queries embed identically. */
function deterministicEmbedding(texts: string[]): number[][] {
  return texts.map((text) => {
    let alphaCount = 0;
    let betaCount = 0;
    for (const word of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
      if (word === "alpha") alphaCount += 1;
      if (word === "beta") betaCount += 1;
    }
    const vector = [alphaCount, betaCount];
    return vector.some((value) => value > 0) ? vector : [0.5, 0.5];
  });
}

function capability(): EmbeddingFingerprint {
  return {
    provider: "local",
    modelId: "integration-model",
    modelRevision: "r1",
    dimension: DIMENSION,
    distance: "cosine",
    pooling: "mean",
    preprocessVersion: "v1",
    chunkingVersion: "v1"
  };
}

function fakeEmbeddingProvider() {
  const described = capability();
  return {
    describe: () => ({ ...described }),
    embedBatch: async (texts: string[]) => deterministicEmbedding(texts)
  };
}

function providerStreaming(...chunks: string[]): FakeGeneration {
  return {
    describe: () => { throw new Error("describe is not used for generation"); },
    async discover() { return []; },
    async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<GenerationEvent> {
      for (const chunk of chunks) {
        if (signal.aborted) return;
        yield { type: "text-delta", text: chunk };
      }
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "done", finishReason: "stop" };
    },
    async embed() { return [[]]; }
  };
}

function slowProvider(): FakeGeneration {
  let index = 0;
  const chunks = ["one ", "two ", "three ", "four"];
  return {
    describe: () => { throw new Error("describe is not used for generation"); },
    async discover() { return []; },
    async *generate(_request: unknown, signal: AbortSignal): AsyncGenerator<GenerationEvent> {
      while (index < chunks.length && !signal.aborted) {
        yield { type: "text-delta", text: chunks[index++]! };
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      yield { type: "done", finishReason: "stop" };
    },
    async embed() { return [[]]; }
  };
}

function profile(): ModelProfileDto {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    name: "Test GPT",
    provider: "openai",
    capability: "generation",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-test",
    enabled: true,
    createdAt: AT,
    updatedAt: AT
  };
}

describe("RAG integration with real LanceDB and streaming chat", () => {
  let database: AppDatabase | undefined;
  let lance: LanceStore | undefined;
  let root: string | undefined;

  async function setupWorld(): Promise<Database.Database> {
    root = await mkdtemp(path.join(os.tmpdir(), "rag-integration-"));
    database = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    lance = await LanceStore.open(path.join(root, "vectors"));
    const connection = database.connection;
    connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Integration");
    connection.prepare(
      "INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, 'pdf', 'Research PDF')"
    ).run(SOURCE_ID, PROJECT_ID);
    connection.prepare(
      "INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version, state) VALUES (?, ?, ?, ?, ?, 'page', 'v1', 'ready')"
    ).run(REVISION_ID, SOURCE_ID, "original.pdf", "stored.pdf", "sha256:test");
    connection.prepare("UPDATE sources SET current_revision_id = ? WHERE id = ?").run(REVISION_ID, SOURCE_ID);
    const insertChunk = connection.prepare(
      "INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insertChunk.run(CHUNK_A, REVISION_ID, 0, "alpha evidence", JSON.stringify({ kind: "page", page: 2 }), "hash-a");
    insertChunk.run(CHUNK_B, REVISION_ID, 1, "beta evidence", JSON.stringify({ kind: "page", page: 3 }), "hash-b");

    // Activate an embedding space whose capabilities match the fake embedding provider.
    const fingerprint = canonicalEmbeddingFingerprint(capability());
    connection.prepare(
      "INSERT INTO embedding_spaces(id, project_id, provider, model_id, model_revision, dimension, distance, pooling, preprocess_version, chunking_version, fingerprint, state, created_at, updated_at) VALUES (?, ?, 'local', 'integration-model', 'r1', 2, 'cosine', 'mean', 'v1', 'v1', ?, 'active', ?, ?)"
    ).run(SPACE_ID, PROJECT_ID, fingerprint, AT, AT);
    connection.prepare("INSERT INTO project_embedding_spaces(project_id, space_id, updated_at) VALUES (?, ?, ?)").run(PROJECT_ID, SPACE_ID, AT);

    await lance.createSpace({ id: SPACE_ID, dimension: DIMENSION });
    await lance.upsert({ id: SPACE_ID, dimension: DIMENSION }, [
      storedRow(0, "alpha evidence", [1, 0], "hash-a"),
      storedRow(1, "beta evidence", [0, 1], "hash-b")
    ]);
    return connection;
  }

  function storedRow(ordinal: number, text: string, vector: number[], hash: string): StoredRow {
    return { chunkId: ordinal === 0 ? CHUNK_A : CHUNK_B, projectId: PROJECT_ID, sourceId: SOURCE_ID, revisionId: REVISION_ID, spaceId: SPACE_ID, ordinal, contentHash: hash, text, vector, locator: { kind: "page", page: ordinal + 2 }, createdAt: Date.parse(AT) };
  }

  afterEach(async () => {
    database?.close();
    await lance?.close();
    if (root) await rm(root, { recursive: true, force: true });
    database = undefined;
    lance = undefined;
    root = undefined;
  });

  it("streams a cited answer end to end through retrieval and persists the completed message", async () => {
    const connection = await setupWorld();
    const retrieval = new RetrievalService({ db: connection, lance, provider: fakeEmbeddingProvider() });
    const search = await retrieval.search({ projectId: PROJECT_ID, query: "alpha", limit: 12 });
    if (!search.ok) throw new Error(JSON.stringify(search.error));
    expect(search.value.map((hit: { chunkId: string }) => hit.chunkId)).toEqual([CHUNK_A, CHUNK_B]);

    const service = new ChatService(chatDeps(connection, retrieval));
    const conversation = service.createConversation({ projectId: PROJECT_ID, title: "Cited" });
    const events: Array<Record<string, unknown>> = [];
    const result = await service.send({ projectId: PROJECT_ID, conversationId: conversation.id, question: "alpha" }, (event) =>
      events.push(event as Record<string, unknown>)
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    const completed = events.at(-1)! as { message: { citations: Array<{ label: string; sourceChunkId: string }> } };
    expect(completed.message.citations[0]).toMatchObject({ label: "S1", sourceChunkId: CHUNK_A });

    const persisted = service.listMessages({ projectId: PROJECT_ID, conversationId: conversation.id }).at(-1)!;
    expect(persisted.state).toBe("completed");
    expect(persisted.citations).toHaveLength(1);
    const citation = persisted.citations[0]!;

    const openPath = vi.fn(async () => "");
    const opener = new CitationOpener(connection, { openPath, openExternal: vi.fn(async () => undefined) });
    await expect(opener.openCitation({ projectId: PROJECT_ID, citationId: citation.id })).resolves.toMatchObject({
      ok: true,
      value: { opened: "document" }
    });
  });

  it("stops a streaming turn mid-flight and keeps partial text as cancelled", async () => {
    const connection = await setupWorld();
    const retrieval = new RetrievalService({ db: connection, lance, provider: fakeEmbeddingProvider() });
    const service = new ChatService(chatDeps(connection, retrieval, slowProvider()));
    const conversation = service.createConversation({ projectId: PROJECT_ID, title: "Stop" });
    const events: Array<Record<string, unknown>> = [];
    const pending = service.send({ projectId: PROJECT_ID, conversationId: conversation.id, question: "alpha" }, (event) =>
      events.push(event as Record<string, unknown>)
    );
    const requestId = await vi.waitFor(() => {
      const started = events.find((candidate) => candidate.type === "started") as { requestId?: string } | undefined;
      if (!started?.requestId) throw new Error("not started yet");
      return started.requestId;
    });
    expect(service.stopRequest(requestId, { projectId: PROJECT_ID, userId: "owner" })).toBe(true);
    await pending;
    const last = service.listMessages({ projectId: PROJECT_ID, conversationId: conversation.id }).at(-1)!;
    expect(last.state).toBe("cancelled");
    expect(last.content.length).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).not.toContain("completed");
  });

  it("answers without citations when no evidence is retrieved", async () => {
    const connection = await setupWorld();
    const retrieval = new RetrievalService({ db: connection, lance, provider: fakeEmbeddingProvider() });
    const service = new ChatService({ ...chatDeps(connection, retrieval), retrieval: async () => [] });
    const conversation = service.createConversation({ projectId: PROJECT_ID, title: "No evidence" });
    const events: Array<Record<string, unknown>> = [];
    const result = await service.send({ projectId: PROJECT_ID, conversationId: conversation.id, question: "omega gamma unrelated topic" }, (event) =>
      events.push(event as Record<string, unknown>)
    );
    expect(result.ok).toBe(true);
    const completed = events.at(-1)! as { type: string; message: { citations: unknown[] } };
    expect(completed.type).toBe("completed");
    expect(completed.message.citations).toHaveLength(0);
  });

  it("keeps invalid citation markers visible in text but persists no citation rows for them", async () => {
    const connection = await setupWorld();
    const retrieval = new RetrievalService({ db: connection, lance, provider: fakeEmbeddingProvider() });
    const service = new ChatService({
      ...chatDeps(connection, retrieval, providerStreaming("[S2] plus ", "[S13]")),
      retrieval: async () => []
    });
    const conversation = service.createConversation({ projectId: PROJECT_ID, title: "Invalid" });
    const events: Array<Record<string, unknown>> = [];
    const result = await service.send({ projectId: PROJECT_ID, conversationId: conversation.id, question: "alpha" }, (event) =>
      events.push(event as Record<string, unknown>)
    );
    expect(result.ok).toBe(true);
    const completed = events.at(-1)! as { type: string; message: { citations: unknown[]; content: string } };
    expect(completed.type).toBe("completed");
    expect(completed.message.citations).toHaveLength(0);
    expect(completed.message.content).toContain("[S2]");
    expect(completed.message.content).toContain("[S13]");
  });

  it("regenerates a reply without duplicating the user row or its citations", async () => {
    const connection = await setupWorld();
    const retrieval = new RetrievalService({ db: connection, lance, provider: fakeEmbeddingProvider() });
    const service = new ChatService(chatDeps(connection, retrieval));
    const conversation = service.createConversation({ projectId: PROJECT_ID, title: "Regenerate" });
    const firstEvents: Array<Record<string, unknown>> = [];
    const first = await service.send({ projectId: PROJECT_ID, conversationId: conversation.id, question: "alpha" }, (event) =>
      firstEvents.push(event as Record<string, unknown>)
    );
    expect(first.ok).toBe(true);
    const assistantId = first.ok ? first.value.assistantMessageId : "";
    const secondEvents: Array<Record<string, unknown>> = [];
    const regenerated = await service.regenerate(
      { projectId: PROJECT_ID, conversationId: conversation.id, messageId: assistantId },
      (event) => secondEvents.push(event as Record<string, unknown>)
    );
    expect(regenerated.ok).toBe(true);
    const messages = service.listMessages({ projectId: PROJECT_ID, conversationId: conversation.id });
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.find((message) => message.id === assistantId)?.superseded).toBe(true);
    const active = messages.filter((message) => message.role === "assistant" && !message.superseded);
    expect(active).toHaveLength(1);
    expect(active[0]!.citations.map((citation) => citation.sourceChunkId)).toEqual([CHUNK_A]);
    expect(secondEvents.at(-1)).toMatchObject({ type: "completed" });
  });
});

function chatDeps(
  connection: Database.Database,
  retrieval: RetrievalService,
  generation?: FakeGeneration
): ConstructorParameters<typeof ChatService>[0] {
  return {
    db: connection,
    generationProfile: profile(),
    providerFactory: () => generation ?? providerStreaming("Grounded answer ", "[S1]"),
    retrieval: async ({ projectId, question }): Promise<RetrievableChunk[]> => {
      const result = await retrieval.search({ projectId, query: question, limit: 12 });
      if (!result.ok) throw new Error(result.error.code);
      return result.value.map((hit: { chunkId: string; sourceId: string; locator: Record<string, unknown>; text: string }, index: number): RetrievableChunk => ({
        label: "S" + (index + 1),
        chunkId: hit.chunkId,
        sourceId: hit.sourceId,
        sourceDisplayName: "Research PDF",
        sourceKind: "pdf",
        locator: hit.locator,
        locatorSummary: JSON.stringify(hit.locator),
        text: hit.text
      }));
    }
  };
}
