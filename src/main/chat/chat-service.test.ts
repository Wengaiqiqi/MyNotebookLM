import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfileDto } from "../../shared/models";
import type Database from "better-sqlite3";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ConversationRepository } from "./conversation-repository";
import { ChatService, recoverInterruptedStreams, sendChatMessage, type ChatSendDeps } from "./chat-service";
import type { Result } from "../../shared/app-errors";
import type { GenerationEvent } from "../models/provider";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-08-27T00:00:00.000Z";

type World = {
  database: AppDatabase;
  repository: ConversationRepository;
  conversationId: string;
  chunkId: string;
};

function makeProfile(enabled = true): ModelProfileDto {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    name: "Test GPT",
    provider: "openai",
    capability: "generation",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-test",
    enabled,
    createdAt: AT,
    updatedAt: AT
  };
}

function fakeProvider(chunks?: string[]): {
  calls: number;
  discover(signal: AbortSignal): Promise<never[]>;
  generate(request: unknown, signal: AbortSignal): AsyncGenerator<GenerationEvent>;
  embed(): Promise<number[][]>;
} {
  return {
    calls: 0,
    async discover() { return []; },
    async *generate(request, signal) {
      for (const chunk of chunks ?? ["Grounded answer ", "[S1]"]) {
        if (signal.aborted) return;
        yield { type: "text-delta", text: chunk };
      }
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "done", finishReason: "stop" };
    },
    async embed() { return [[]]; }
  };
}

async function collectEvents(deps: ChatSendDeps, input: Parameters<ChatService["send"]>[0]) {
  const events: Array<Record<string, unknown>> = [];
  const result = await sendChatMessage(deps, { ...input }, (event) => events.push(event as Record<string, unknown>));
  return { result, events };
}

describe("ChatService streaming orchestration", () => {
  let world: World;

  function baseDeps(overrides?: Partial<ChatSendDeps>): ChatSendDeps {
    const provider = fakeProvider();
    return {
      db: world.database.connection,
      generationProfile: makeProfile(),
      providerFactory: () => provider,
      retrieval: async () => [
        {
          label: "S1",
          chunkId: world.chunkId,
          sourceId: "88888888-8888-4888-8888-888888888888",
          sourceKind: "pdf",
          text: "Authoritative evidence",
          sourceDisplayName: "Research PDF",
          locator: { kind: "page", page: 2 },
          locatorSummary: "page 2"
        }
      ],
      now: () => new Date(AT),
      randomId: (n) => `id-${Math.random().toString(36).slice(2, 8)}-${n}`,
      ...overrides
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world = setupWorld();
  });


  // Sanity: unmask the real failure if the send result is not ok.
function expectOk(result: Result<{ requestId: string; assistantMessageId: string }>): { requestId: string; assistantMessageId: string } {
    if (!result.ok) throw new Error("send failed: " + JSON.stringify(result.error));
    return result.value;
  }

  function expectErrorCode<T>(result: Result<T>, code: string): void {
    if (result.ok) throw new Error("expected failure with " + code + " but succeeded");
    if (result.error.code !== code) throw new Error("expected " + code + ", got " + JSON.stringify(result.error));
  }

  afterEach(() => {
    vi.useRealTimers();
    world.database.close();
  });

  it("streams a normal turn with citations, usage and provider/model persisted", async () => {
    const deps = baseDeps({
      providerFactory: () => fakeProvider(["Answer part one ", "[S1] end"])
    });
    const { result, events } = await collectEvents(deps, { projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" });
    expect(expectOk(result)).toMatchObject({ assistantMessageId: expect.any(String) });
    const deltas = events.filter((e) => e.type === "delta") as Array<{ messageId: string; text: string }>;
    expect(deltas.map((d) => d.text).join("")).toBe("Answer part one [S1] end");
    const completed = events.at(-1)! as { type: string; message: { state: string; usage: { totalTokens: number }; provider: string; profileId: string; model: string; citations: unknown[]; completionReason: string } };
    expect(completed.type).toBe("completed");
    expect(completed.message.state).toBe("completed");
    expect(completed.message.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(completed.message.provider).toBe("openai");
    expect(completed.message.profileId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab");
    expect(completed.message.model).toBe("gpt-test");
    expect(completed.message.citations).toHaveLength(1);
    expect(completed.message.completionReason).toBe("stop");
    // persisted user + assistant pair in order
    const messages = world.repository.listMessages(PROJECT_ID, world.conversationId);
    expect(messages.map((m) => ({ role: m.role, state: m.state }))).toEqual([
      { role: "user", state: "completed" },
      { role: "assistant", state: "completed" }
    ]);
  });

  it("handles empty retrieval without changing the success path", async () => {
    const deps = baseDeps({ retrieval: async () => [] });
    const { result, events } = await collectEvents(deps, { projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
    expect(result.ok).toBe(true);
    const last = events.at(-1)! as { type: string };
    expect(last.type).toBe("completed");
  });

  it("fails before user persistence when no enabled generation profile exists", async () => {
    const deps = baseDeps({ generationProfile: undefined });
    const { result, events } = await collectEvents(deps, { projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(events).toHaveLength(0);
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId)).toHaveLength(0);
  });

  it("persists a failed assistant draft on provider failure", async () => {
    const deps = baseDeps({
      providerFactory: () => ({
        calls: 0,
        async discover() { return []; },
        // eslint-disable-next-line require-yield -- fails before yielding
        async *generate() { throw new Error("provider exploded"); },
        async embed() { return [[]]; }
      })
    });
    const { result, events } = await collectEvents(deps, { projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
    expect(result).toMatchObject({ ok: false, error: { code: "PROVIDER" } });
    expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "PROVIDER" } });
    const last = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(last).toMatchObject({ role: "assistant", state: "failed", errorCode: "PROVIDER" });
  });

  it("preserves partial text as cancelled on user abort with a final checkpoint", async () => {
    const chunks = ["first ", "second ", "third ", "fourth"];
    let index = 0;
    let stopNow = false;
    const deps = baseDeps({
      providerFactory: () => ({
        calls: 0,
        async discover() { return []; },
        async *generate(_request, signal): AsyncGenerator<GenerationEvent> {
          while (index < chunks.length) {
            yield { type: "text-delta", text: chunks[index++]! };
            await new Promise<void>((resolve) => {
              const tick = () => {
                if (stopNow || index >= chunks.length) resolve();
                else setTimeout(tick, 2);
              };
              setTimeout(tick, 2);
            });
          }
          yield { type: "done", finishReason: "stop" };
        },
        async embed() { return [[]]; }
      }),
    });
    const service = new ChatService(deps);
    const events: Array<Record<string, unknown>> = [];
    const sendPromise = service.send({ projectId: PROJECT_ID, conversationId: world.conversationId, question: "stop me" }, (event) => events.push(event as Record<string, unknown>));
    // Stop while deltas are still streaming.
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "delta")).toBe(true);
    }, { timeout: 5000 });
    const startedEvent = events.find((e) => e.type === "started") as { requestId?: string } | undefined;
    expect(startedEvent?.requestId).toBeTruthy();
    expect(service.stopRequest(startedEvent!.requestId!, { projectId: PROJECT_ID, userId: "owner" })).toBe(true);
    stopNow = true;
    const result = await sendPromise;
    expect(result.ok).toBe(true);
    const last = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(last.state).toBe("cancelled");
    expect(last.content).toContain("first");
    const types = events.map((e) => e.type);
    expect(types.at(-1)).toBe("cancelled");
    expect(types).not.toContain("failed");
    expect(types).not.toContain("completed");
  });

  it("rejects concurrent sends into the same conversation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = baseDeps({
      providerFactory: () => ({
        calls: 0,
        async discover() { return []; },
        async *generate(): AsyncGenerator<GenerationEvent> {
          await gate;
          yield { type: "text-delta", text: "late" };
          yield { type: "done" };
        },
        async embed() { return [[]]; }
      })
    });
    const service = new ChatService(deps);
    const firstStarted = service.send({ projectId: PROJECT_ID, conversationId: world.conversationId, question: "one" }, () => {});
    // One macrotask tick guarantees all pre-registration microtasks (retrieval await) have flushed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.activeRequests()).not.toHaveLength(0);
    const secondEvents: Array<Record<string, unknown>> = [];
    const second = await service.send({ projectId: PROJECT_ID, conversationId: world.conversationId, question: "two" }, (event) => secondEvents.push(event as Record<string, unknown>));
    expectErrorCode(second, "CONFLICT");
    expect(secondEvents).toHaveLength(0);
    release();
    await firstStarted;
  });

  it("aborts the active generation when the renderer disconnects via stopRequest", async () => {
    const deps = baseDeps({
      providerFactory: () => ({
        calls: 0,
        async discover() { return []; },
        async *generate(_request, signal): AsyncGenerator<GenerationEvent> {
          for (let i = 0; i < 500; i++) {
            if (signal.aborted) return;
            yield { type: "text-delta", text: "word " };
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          yield { type: "done", finishReason: "stop" };
        },
        async embed() { return [[]]; }
      })
    });
    const service = new ChatService(deps);
    const events: Array<Record<string, unknown>> = [];
    let resolveStarted!: (value: Result<{ requestId: string; assistantMessageId: string }>) => void;
    const startedPromise = new Promise<Result<{ requestId: string; assistantMessageId: string }>>((resolve) => { resolveStarted = resolve; });
    void (async () => {
      resolveStarted(await service.send({ projectId: PROJECT_ID, conversationId: world.conversationId, question: "long question" }, (event) => events.push(event as Record<string, unknown>)));
    })();
    await vi.waitFor(() => {
      const started = events.find((e) => e.type === "started");
      expect(started).toBeDefined();
    });
    const startedEvent = events.find((e) => e.type === "started") as { requestId?: string } | undefined;
    const requestId = startedEvent?.requestId as string;
    expect(requestId).toBeTruthy();
    expect(service.stopRequest(requestId!, { projectId: PROJECT_ID, userId: "owner" })).toBe(true);
    expect(service.stopRequest(requestId!, { projectId: "other-project", userId: "attacker" })).toBe(false);
    expectOk(await startedPromise);
    const last = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(last.state).toBe("cancelled");
    expect(last.content.length).toBeGreaterThan(0);
  });

  it("checkpoint recovery resumes nothing but persists clean interrupted state on startup", () => {
    prepareOrphanStreamingRow(world.database.connection);
    recoverInterruptedStreams(world.database.connection, new Date(AT));
    const row = world.database.connection.prepare("SELECT state, error_code, completion_reason AS reason FROM messages WHERE id = ?").get("orphan-streaming") as { state: string; error_code: string | null; reason: string | null };
    expect(row.state).toBe("cancelled");
    expect(row.error_code).toBe("INTERRUPTED");
    expect(row.reason).toBe("interruption");
  });
});

function setupWorld(): World {
  const database = openAppDatabase(":memory:", "src/main/db/migrations");
  database.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Project");
  database.connection.prepare("INSERT INTO sources(id, project_id, kind, display_name) VALUES (?, ?, ?, ?)")
    .run("88888888-8888-4888-8888-888888888888", PROJECT_ID, "pdf", "Research PDF");
  database.connection.prepare("INSERT INTO source_revisions(id, source_id, original_path, stored_path, source_hash, locator_kind, chunking_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "88888888-8888-4888-8888-888888888888", "original.pdf", "stored.pdf", "sha256:test", "page", "v1");
  database.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .run("99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0, "Evidence", JSON.stringify({ kind: "page", page: 2 }), "sha256:chunk");
  const repository = new ConversationRepository(database.connection);
  const conversationId = "33333333-3333-4333-8333-333333333333";
  repository.createConversation({ id: conversationId, projectId: PROJECT_ID, title: "Research", createdAt: AT });
  return { database, repository, conversationId, chunkId: "99999999-9999-4999-8999-999999999999" };
}

function prepareOrphanStreamingRow(db: Database.Database): void {
  const repo = new ConversationRepository(db);
  repo.appendUserMessage({ projectId: PROJECT_ID, conversationId: "33333333-3333-4333-8333-333333333333", id: USER_ID, content: "crashed", createdAt: AT });
  db.prepare("INSERT INTO messages(id,conversation_id,sequence,role,content,state,reply_to_message_id,provider,profile_id,model,created_at,updated_at) VALUES ('orphan-streaming','33333333-3333-4333-8333-333333333333',1,'assistant','','streaming',?, 'openai','prof','m', ?, ?)")
    .run(USER_ID, AT, AT);
}
