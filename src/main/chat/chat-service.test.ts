import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfileDto } from "../../shared/models";
import type Database from "better-sqlite3";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ConversationRepository } from "./conversation-repository";
import { ChatService, recoverInterruptedStreams, sendChatMessage, type ChatSendDeps, type RetrievableChunk } from "./chat-service";
import { CitationOpener } from "./citation-opener";
import type { CitationDto } from "../../shared/chat";
import type { Result } from "../../shared/app-errors";
import type { GenerateRequest, GenerationEvent } from "../models/provider";
import { ProviderRequestError } from "../models/http-client";
import { classifyProviderError } from "../models/provider-errors";
import { SettingsRepository } from "../settings/settings-repository";
import { RouteRepository } from "../models/route-repository";
import { ModelRouter } from "../models/model-router";
import { ModelService } from "../models/model-service";
import type { CredentialStore } from "../credentials/credential-store";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
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
    const { result, events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" });
    expect(expectOk(result)).toMatchObject({ requestId: REQUEST_ID, assistantMessageId: expect.any(String) });
    expect(events.every((event) => event.requestId === REQUEST_ID)).toBe(true);
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

  it("pins an unfinished citation across continuation and refuses insufficient space", async () => {
    const profile = { ...makeProfile(), contextTokensOverride: 8192, maxOutputTokensOverride: 2048 };
    let calls = 0;
    const svc = new ChatService(baseDeps({ generationProfile: profile, retrieval: async (input) => (await baseDeps().retrieval(input)).map((row) => ({ ...row, text: "Fact ".repeat(800) })), providerFactory: () => ({ ...fakeProvider(), async *generate() {
      calls++; yield { type: "text-delta", text: calls === 1 ? "x".repeat(2000) + " [S1" : "]" };
      yield { type: "done", finishReason: calls === 1 ? "length" : "stop" };
    } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "q" }, () => {}));
    const message = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
    profile.maxOutputTokensOverride = 4096;
    const input = { requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: message.id, expectedRevision: message.generation!.revision };
    expect(await svc.continue(input, () => {})).toMatchObject({ ok: false, error: { messageKey: "errors.contextBudgetExceeded" } });
    expect(calls).toBe(1);
    expect(world.repository.getMessage(PROJECT_ID, message.id)).toEqual(message);
    profile.maxOutputTokensOverride = 2048;
    expectOk(await svc.continue({ ...input, requestId: crypto.randomUUID() }, () => {}));
    expect(world.repository.getMessage(PROJECT_ID, message.id)!.citations[0]?.label).toBe("S1");
  });

  it.each(["partial", "split", "interrupted"])("tracks usage field completeness: %s", async (mode) => {
    const svc = new ChatService(baseDeps({ retrieval: async () => [], providerFactory: () => ({ ...fakeProvider(), async *generate() {
      yield { type: "usage", inputTokens: 10 };
      yield { type: "text-delta", text: "answer" };
      if (mode !== "partial") yield { type: "usage", outputTokens: 5 };
      if (mode === "interrupted") throw new Error("disconnect");
      yield { type: "done", finishReason: "stop" };
    } }) }));
    await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "q" }, () => {});
    const message = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(message.generation?.usageComplete).toBe(mode === "split");
    expect(message.usage).toEqual({ inputTokens: 10, outputTokens: mode === "partial" ? 0 : 5, totalTokens: mode === "partial" ? 10 : 15 });
  });

  it.each(["failure", "cancel", "terminal-write-failure"])("keeps initial partial citations and incomplete usage: %s", async (mode) => {
    let svc: ChatService;
    svc = new ChatService(baseDeps({ providerFactory: () => ({ ...fakeProvider(), async *generate() {
      yield { type: "usage", inputTokens: 10 };
      yield { type: "text-delta", text: "Grounded claim [S1]." };
      if (mode === "cancel") { svc.stopRequest(REQUEST_ID, { projectId: PROJECT_ID }); return; }
      throw new Error("disconnect");
    } }) }));
    if (mode === "terminal-write-failure") world.database.connection.exec("CREATE TRIGGER fail_initial_terminal BEFORE UPDATE OF runtime_json ON chat_generation_contexts WHEN NEW.active_request_id IS NULL BEGIN SELECT RAISE(ABORT,'terminal failed'); END");
    const events: any[] = [];
    await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "q" }, (event) => events.push(event));
    if (mode === "terminal-write-failure") {
      expect(world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!.state).toBe("streaming");
      expect(events.some((event) => event.type === "failed")).toBe(false);
      world.database.connection.exec("DROP TRIGGER fail_initial_terminal");
      expect(recoverInterruptedStreams(world.database.connection)).toBe(1);
      expect(recoverInterruptedStreams(world.database.connection)).toBe(0);
    }
    const message = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(message.content).toBe("Grounded claim [S1].");
    expect(message.citations[0]).toMatchObject({ label: "S1", sourceChunkId: world.chunkId });
    expect(message.generation).toMatchObject({ usageComplete: false, canContinue: false });
    expect(message.usage?.inputTokens).toBe(10);
  });

  it("keeps cumulative usage incomplete after a partial interrupted continuation", async () => {
    let calls = 0;
    const svc = new ChatService(baseDeps({ retrieval: async () => [], providerFactory: () => ({ ...fakeProvider(), async *generate() {
      calls++;
      yield { type: "usage", inputTokens: 10 };
      yield { type: "text-delta", text: "part" };
      if (calls === 2) throw new Error("disconnect");
      yield { type: "usage", outputTokens: 5 };
      yield { type: "done", finishReason: "length" };
    } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "q" }, () => {}));
    for (let i = 0; i < 2; i++) {
      const message = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
      await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: message.id, expectedRevision: message.generation!.revision }, () => {});
      expect(world.repository.getMessage(PROJECT_ID, message.id)!.generation?.usageComplete).toBe(false);
    }
    expect(world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!.usage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
  });

  it("keeps S100 through repeated length stops, changed settings and normal completion", async () => {
    const rows: RetrievableChunk[] = [];
    for (let i = 1; i <= 120; i++) {
      const chunkId = "many-" + i;
      world.database.connection.prepare("INSERT INTO source_chunks(id,revision_id,ordinal,text,locator_json,content_hash) VALUES (?,?,?,?,?,?)").run(chunkId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i, "Fact " + i, JSON.stringify({ kind: "page", page: i }), "h" + i);
      rows.push({ label: "S" + i, chunkId, sourceId: "88888888-8888-4888-8888-888888888888", revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", contentHash: "h" + i, sourceDisplayName: "Doc", sourceKind: "pdf", locator: { kind: "page", page: i }, locatorSummary: "page " + i, text: "Fact " + i });
    }
    const profile = { ...makeProfile(), contextTokensOverride: 131072 };
    const requests: GenerateRequest[] = [];
    const svc = new ChatService(baseDeps({ generationProfile: profile, retrieval: async () => rows, providerFactory: () => ({ ...fakeProvider(), async *generate(request: GenerateRequest) {
      requests.push(request);
      yield { type: "text-delta", text: requests.length === 1 ? "Fact [S100]" : " more" };
      yield { type: "usage", inputTokens: 10 };
      yield { type: "usage", outputTokens: 5 };
      yield { type: "usage", outputTokens: 5 };
      yield { type: "done", finishReason: requests.length < 3 ? "length" : "stop" };
    } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "facts" }, () => {}));
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
      expect(current.generation?.canContinue).toBe(true);
      if (attempt === 1) profile.maxOutputTokensOverride = 16384;
      expectOk(await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: current.id, expectedRevision: current.generation!.revision }, () => {}));
    }
    const final = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
    expect(final.content).toBe("Fact [S100] more more");
    expect(final.citations[0]).toMatchObject({ label: "S100", sourceChunkId: "many-100" });
    expect(final.generation).toMatchObject({ canContinue: false, finishKind: "stop", outputTokenLimit: 16384 });
    expect(final.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
    expect(requests.map((request) => request.maxTokens)).toEqual([8192,8192,16384]);
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId)).toHaveLength(2);
  });

  it("refuses deleted legacy evidence even when its snapshot has no version metadata", async () => {
    const svc = new ChatService(baseDeps({ providerFactory: () => ({ ...fakeProvider(), async *generate() { yield { type: "text-delta", text: "Fact [S1]" }; yield { type: "done", finishReason: "length" }; } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "facts" }, () => {}));
    const current = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
    world.database.connection.prepare("UPDATE sources SET status='deleting'").run();
    expect(await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: current.id, expectedRevision: current.generation!.revision }, () => {})).toMatchObject({ ok: false, error: { messageKey: "errors.continueSourceUnavailable" } });
    expect(world.repository.getMessage(PROJECT_ID, current.id)!.content).toBe(current.content);
  });

  it("excludes a later regenerated answer from an earlier question's history", async () => {
    const svc = new ChatService(baseDeps({ retrieval: async () => [] }));
    const send = (question: string) => svc.send({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, question }, () => {});
    const first = expectOk(await send("Q1"));
    const second = expectOk(await send("Q2"));
    expectOk(await svc.regenerate({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: first.assistantMessageId }, () => {}));
    const question = world.repository.getMessage(PROJECT_ID, world.repository.getMessage(PROJECT_ID, second.assistantMessageId)!.replyToMessageId!)!;
    expect(world.repository.listHistoryPairs({ projectId: PROJECT_ID, conversationId: world.conversationId, beforeSequence: question.sequence, cursor: 999 })).toEqual([]);
  });

  it.each(["deleting", "revision", "hash"])("rejects evidence invalidated after retrieval: %s", async (change) => {
    const db = world.database.connection;
    const sourceId = "88888888-8888-4888-8888-888888888888";
    const revisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.prepare("UPDATE sources SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
    db.prepare("UPDATE source_revisions SET state='ready' WHERE id=?").run(revisionId);
    const factory = vi.fn(() => fakeProvider());
    const original = baseDeps().retrieval;
    const svc = new ChatService(baseDeps({ providerFactory: factory, retrieval: async (input) => {
      const rows = await original(input);
      if (change === "deleting") db.prepare("UPDATE sources SET status='deleting' WHERE id=?").run(sourceId);
      if (change === "revision") db.prepare("UPDATE sources SET current_revision_id=NULL WHERE id=?").run(sourceId);
      if (change === "hash") db.prepare("UPDATE source_chunks SET content_hash='changed' WHERE id=?").run(world.chunkId);
      return rows.map((row) => ({ ...row, revisionId, contentHash: "sha256:chunk" }));
    } }));
    expect(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Q" }, () => {})).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(factory).not.toHaveBeenCalled();
  });

  it("expands evidence and history for a larger fallback without resolving the route twice", async () => {
    const primary = { ...makeProfile(), contextTokensOverride: 8192 };
    const larger = { ...primary, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", contextTokensOverride: 1_000_000 };
    const requests: GenerateRequest[] = [];
    const original = baseDeps().retrieval;
    const retrieval = vi.fn(async (input: Parameters<typeof original>[0]) => {
      const [row] = await original(input);
      return Array.from({ length: input.evidenceTokenBudget! < 1000 ? 1 : 40 }, (_, index) => ({ ...row!, chunkId: "candidate-" + index, text: "Fact " + index }));
    });
    const resolve = vi.fn(() => [primary, larger]);
    const svc = new ChatService(baseDeps({ router: { resolve }, retrieval, providerFactory: (profile) => ({ ...fakeProvider(), async *generate(request: GenerateRequest) {
      requests.push(request);
      if (profile.id === primary.id) throw new ProviderRequestError({ error: { code: "TIMEOUT", messageKey: "errors.timeout", recoverable: true }, fallbackEligible: true });
      yield { type: "text-delta", text: "Answer without markers" };
      yield { type: "done", finishReason: "stop" };
    } }) }));
    expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Q" }, () => {}));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(retrieval).toHaveBeenCalledTimes(2);
    expect(retrieval.mock.calls[0]![0].signal).toBe(retrieval.mock.calls[1]![0].signal);
    expect(requests[1]!.messages.map((item) => item.content).join(" ")).toContain('<evidence id="S40">');
  });

  it("keeps safe error details in initial and continuation terminal events", async () => {
    let calls = 0;
    const error = { code: "VALIDATION" as const, messageKey: "errors.generationOutputLimit", recoverable: true, details: { limitTokens: 4096 } };
    const svc = new ChatService(baseDeps({ retrieval: async () => [], providerFactory: () => ({ ...fakeProvider(), async *generate() {
      calls++;
      if (calls !== 1) throw new ProviderRequestError({ error, fallbackEligible: false });
      yield { type: "text-delta", text: "Partial" };
      yield { type: "done", finishReason: "length" };
    } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Q" }, () => {}));
    const message = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
    const events: any[] = [];
    await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: message.id, expectedRevision: message.generation!.revision }, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "failed", operation: "continue", error, message: { state: "completed", content: "Partial" } });
    await svc.send({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, question: "next" }, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "failed", error });
  });

  it("records the updated continuation allowance before streaming and rejects a changed question", async () => {
    const profile = makeProfile();
    const svc = new ChatService(baseDeps({ generationProfile: profile, retrieval: async () => [], providerFactory: () => ({ ...fakeProvider(), async *generate() { yield { type: "text-delta", text: "Partial" }; yield { type: "done", finishReason: "length" }; } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Q" }, () => {}));
    const message = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
    profile.maxOutputTokensOverride = 4096;
    const events: any[] = [];
    expectOk(await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: message.id, expectedRevision: message.generation!.revision }, (event) => events.push(event)));
    expect(events[0]).toMatchObject({ type: "started", message: { generation: { outputTokenLimit: 4096 } } });
    world.repository.updateUserMessage({ projectId: PROJECT_ID, id: message.replyToMessageId!, content: "changed", updatedAt: AT });
    expect(await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: message.id, expectedRevision: world.repository.getMessage(PROJECT_ID, message.id)!.generation!.revision }, () => {})).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("passes the context output reserve to the provider", async () => {
    let request: GenerateRequest | undefined;
    const deps = baseDeps({
      providerFactory: () => ({
        ...fakeProvider(["Answer"]),
        generate: (input: GenerateRequest, signal: AbortSignal) => {
          request = input;
          return fakeProvider(["Answer"]).generate(input, signal);
        }
      })
    });

    await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" });

    expect(request?.maxTokens).toBe(8_192);
  });

  it("keeps a length-limited answer resumable and appends a manual continuation", async () => {
    let calls = 0;
    const provider = {
      ...fakeProvider(),
      async *generate(_request: GenerateRequest, _signal: AbortSignal) {
        calls += 1;
        yield { type: "text-delta" as const, text: calls === 1 ? "first half" : "second half" };
        yield { type: "done" as const, finishReason: calls === 1 ? "length" : "stop" };
      }
    };
    const svc = new ChatService(baseDeps({ providerFactory: () => provider }));
    const first = await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "long answer" }, () => undefined);
    expect(first.ok).toBe(true);
    const assistantId = first.ok ? first.value.assistantMessageId : "";
    const limited = world.repository.getMessage(PROJECT_ID, assistantId)!;
    expect(limited.generation).toMatchObject({ finishKind: "length", canContinue: true, status: "idle" });

    const continued = await svc.continue({ requestId: "55555555-5555-4555-8555-555555555555", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId, expectedRevision: limited.generation!.revision }, () => undefined);
    expect(continued.ok).toBe(true);
    expect(world.repository.getMessage(PROJECT_ID, assistantId)).toMatchObject({ content: "first halfsecond half", state: "completed", generation: { finishKind: "stop", canContinue: false } });
  });

  it("pins continuation to the original model, reparses the merged answer, and accumulates usage", async () => {
    const primary = makeProfile();
    const fallback = { ...makeProfile(), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Fallback", modelId: "fallback" };
    const routes = new RouteRepository(new SettingsRepository(world.database.connection));
    for (const item of [primary, fallback]) routes.saveProfile({ id: item.id, name: item.name, provider: item.provider, capability: item.capability, baseUrl: item.baseUrl, modelId: item.modelId, enabled: item.enabled });
    routes.replaceRoute("chat", [primary.id, fallback.id]);
    let primaryCalls = 0;
    const calls: string[] = [];
    const deps = baseDeps({
      generationProfile: undefined,
      router: new ModelRouter(routes),
      providerFactory: (item) => item.id === primary.id
        ? {
          ...fakeProvider(),
          async *generate() {
            primaryCalls += 1;
            calls.push(`primary-${primaryCalls}`);
            yield { type: "text-delta" as const, text: primaryCalls === 1 ? "Claim [S1]" : " continued" };
            yield { type: "usage" as const, inputTokens: primaryCalls === 1 ? 10 : 11, outputTokens: primaryCalls === 1 ? 5 : 7 };
            yield { type: "done" as const, finishReason: primaryCalls === 1 ? "length" : "stop" };
          }
        }
        : {
          ...fakeProvider(["wrong fallback"]),
          async *generate() {
            calls.push("fallback");
            yield { type: "text-delta" as const, text: "wrong fallback" };
            yield { type: "done" as const, finishReason: "stop" };
          }
        }
    });
    const service = new ChatService(deps);
    const first = await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "continue" }, () => undefined);
    expect(first.ok).toBe(true);
    const assistantId = first.ok ? first.value.assistantMessageId : "";
    const limited = world.repository.getMessage(PROJECT_ID, assistantId)!;
    const continued = await service.continue({ requestId: "55555555-5555-4555-8555-555555555555", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId, expectedRevision: limited.generation!.revision }, () => undefined);
    const message = world.repository.getMessage(PROJECT_ID, assistantId)!;
    expect(continued.ok).toBe(true);
    expect(calls).toEqual(["primary-1", "primary-2"]);
    expect(message.content).toBe("Claim [S1] continued");
    expect(message.citations).toHaveLength(1);
    expect(message.usage).toEqual({ inputTokens: 21, outputTokens: 12, totalTokens: 33 });
  });

  it("fails a completed provider response that contains no visible answer", async () => {
    const { result, events } = await collectEvents(baseDeps({
      providerFactory: () => fakeProvider([])
    }), { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" });

    expect(result).toMatchObject({ ok: false, error: { code: "PROVIDER", messageKey: "errors.providerIncomplete" } });
    expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "PROVIDER", messageKey: "errors.providerIncomplete" } });
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)).toMatchObject({
      role: "assistant",
      state: "failed",
      content: "",
      errorCode: "PROVIDER"
    });
  });

  it("settles citations, usage and runtime when a continuation is interrupted", async () => {
    let calls = 0;
    // The second citation needs a real chunk row: message_citations keeps a
    // foreign key to source_chunks.
    world.database.connection.prepare("INSERT INTO source_chunks(id, revision_id, ordinal, text, locator_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run("99999999-9999-4999-8999-999999999998", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, "Second evidence", JSON.stringify({ kind: "page", page: 3 }), "sha256:chunk2");
    const secondChunk: RetrievableChunk = {
      label: "S2",
      chunkId: "99999999-9999-4999-8999-999999999998",
      sourceId: "88888888-8888-4888-8888-888888888888",
      sourceKind: "pdf",
      text: "Second evidence",
      sourceDisplayName: "Research PDF",
      locator: { kind: "page", page: 3 },
      locatorSummary: "page 3"
    };
    const provider = {
      ...fakeProvider(),
      async *generate(_request: GenerateRequest, _signal: AbortSignal) {
        calls += 1;
        yield { type: "text-delta" as const, text: calls === 1 ? "Original [S1]" : " New [S2]" };
        yield { type: "usage" as const, inputTokens: calls === 1 ? 10 : 11, outputTokens: calls === 1 ? 5 : 7 };
        if (calls === 2) throw new Error("offline disconnect");
        yield { type: "done" as const, finishReason: "length" };
      }
    };
    const svc = new ChatService(baseDeps({
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
        },
        secondChunk
      ]
    }));
    const first = await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "long" }, () => undefined);
    const assistantId = first.ok ? first.value.assistantMessageId : "";
    const limited = world.repository.getMessage(PROJECT_ID, assistantId)!;
    const continued = await svc.continue({ requestId: "55555555-5555-4555-8555-555555555555", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId, expectedRevision: limited.generation!.revision }, () => undefined);
    const message = world.repository.getMessage(PROJECT_ID, assistantId)!;

    expect(continued.ok).toBe(false);
    // Appended text, its new citation, the accumulated usage and the
    // interrupted runtime must all be settled together.
    expect(message.content).toBe("Original [S1] New [S2]");
    expect(message.citations.map((citation) => citation.label)).toEqual(["S1", "S2"]);
    expect(message.usage).toEqual({ inputTokens: 21, outputTokens: 12, totalTokens: 33 });
    expect(message.generation).toMatchObject({ status: "interrupted", canContinue: true });
  });

  it("keeps a continuation recoverable when the terminal write fails", async () => {
    let calls = 0;
    const svc = new ChatService(baseDeps({
      providerFactory: () => ({
        ...fakeProvider(),
        async *generate() {
          calls += 1;
          yield { type: "text-delta" as const, text: calls === 1 ? "first half" : " second half" };
          yield { type: "done" as const, finishReason: calls === 1 ? "length" : "stop" };
        }
      })
    }));
    const first = await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "long" }, () => undefined);
    const assistantId = first.ok ? first.value.assistantMessageId : "";
    const limited = world.repository.getMessage(PROJECT_ID, assistantId)!;
    const requestId = "55555555-5555-4555-8555-555555555555";
    world.database.connection.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF runtime_json ON chat_generation_contexts WHEN NEW.active_request_id IS NULL BEGIN SELECT RAISE(ABORT,'terminal write failed'); END");
    const failed = await svc.continue({ requestId, projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId, expectedRevision: limited.generation!.revision }, () => undefined);
    world.database.connection.exec("DROP TRIGGER fail_terminal");

    expect(failed).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(recoverInterruptedStreams(world.database.connection, new Date(AT))).toBe(1);
    const message = world.repository.getMessage(PROJECT_ID, assistantId)!;
    const context = world.repository.getGenerationContext(PROJECT_ID, assistantId)!;
    expect(context.activeRequestId).toBeNull();
    expect(message.generation).toMatchObject({ status: "interrupted", canContinue: true });
  });

  it("rolls back the continuation claim if saving the prepared snapshot fails", async () => {
    const svc = new ChatService(baseDeps({ retrieval: async () => [], providerFactory: () => ({ ...fakeProvider(), async *generate() { yield { type: "text-delta", text: "partial" }; yield { type: "done", finishReason: "length" }; } }) }));
    const first = expectOk(await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Q" }, () => {}));
    const original = world.repository.getMessage(PROJECT_ID, first.assistantMessageId)!;
    world.database.connection.exec("CREATE TRIGGER fail_snapshot BEFORE UPDATE OF snapshot_json ON chat_generation_contexts BEGIN SELECT RAISE(ABORT,'snapshot failed'); END");
    const result = await svc.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: original.id, expectedRevision: original.generation!.revision }, () => {});
    expect(result).toMatchObject({ ok:false, error:{code:"INTERNAL"} });
    expect(world.repository.getMessage(PROJECT_ID, original.id)).toEqual(original);
    expect(world.repository.getGenerationContext(PROJECT_ID, original.id)?.activeRequestId).toBeNull();
  });

  it("replays a finished continuation request instead of generating twice", async () => {
    let calls = 0;
    const provider = {
      ...fakeProvider(),
      async *generate(_request: GenerateRequest, _signal: AbortSignal) {
        calls += 1;
        yield { type: "text-delta" as const, text: calls === 1 ? "first" : " second" };
        yield { type: "done" as const, finishReason: calls === 1 ? "length" : "stop" };
      }
    };
    const svc = new ChatService(baseDeps({ providerFactory: () => provider }));
    const first = await svc.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "long" }, () => undefined);
    const assistantId = first.ok ? first.value.assistantMessageId : "";
    const limited = world.repository.getMessage(PROJECT_ID, assistantId)!;
    const input = { requestId: "55555555-5555-4555-8555-555555555555", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId, expectedRevision: limited.generation!.revision };
    const firstContinue = await svc.continue(input, () => undefined);
    const replay = await svc.continue(input, () => undefined);

    expect(firstContinue.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(calls).toBe(2);
    expect(world.repository.getMessage(PROJECT_ID, assistantId)!.content).toBe("first second");
  });
  it("uses the real multi-profile route and writes the completing profile", async () => {
    const primary = makeProfile();
    const fallback = { ...makeProfile(), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Fallback", modelId: "fallback" };
    const routes = new RouteRepository(new SettingsRepository(world.database.connection));
    for (const item of [primary, fallback]) routes.saveProfile({ id: item.id, name: item.name, provider: item.provider, capability: item.capability, baseUrl: item.baseUrl, modelId: item.modelId, enabled: item.enabled });
    routes.replaceRoute("chat", [primary.id, fallback.id]);
    const deps = baseDeps({
      generationProfile: undefined,
      router: new ModelRouter(routes),
      providerFactory: (item) => item.id === primary.id
        ? { ...fakeProvider(), async *generate() { throw new ProviderRequestError(classifyProviderError({ status: 503 })); } }
        : fakeProvider(["Routed ", "[S1]"])
    });
    const { result, events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "route" });
    expect(result.ok).toBe(true);
    const fallbackEvent = events.find((event) => event.type === "fallback")!;
    expect(Object.keys(fallbackEvent).sort()).toEqual(["attempted", "errorCode", "next", "requestId", "type"]);
    expect(fallbackEvent).toMatchObject({ attempted: { profileId: primary.id }, next: { profileId: fallback.id } });
    expect(events.at(-1)).toMatchObject({ type: "completed", message: { profileId: fallback.id, provider: fallback.provider, model: fallback.modelId, citations: [expect.objectContaining({ label: "S1" })] } });
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)?.citations).toHaveLength(1);
  });

  it("cancels a real routed attempt and chat draft on stop", async () => {
    const primary = makeProfile();
    const fallback = { ...makeProfile(), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", modelId: "fallback" };
    const routes = new RouteRepository(new SettingsRepository(world.database.connection));
    for (const item of [primary, fallback]) routes.saveProfile({ id: item.id, name: item.name, provider: item.provider, capability: item.capability, baseUrl: item.baseUrl, modelId: item.modelId, enabled: item.enabled });
    routes.replaceRoute("chat", [primary.id, fallback.id]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = baseDeps({ generationProfile: undefined, router: new ModelRouter(routes), providerFactory: () => ({ ...fakeProvider(), async *generate() { yield { type: "text-delta", text: "partial" }; await gate; } }) });
    const service = new ChatService(deps);
    const events: Array<Record<string, unknown>> = [];
    const pending = service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "cancel" }, (event) => events.push(event as Record<string, unknown>));
    await vi.waitFor(() => expect(events.some((event) => event.type === "delta")).toBe(true));
    expect(service.stopRequest(REQUEST_ID, { projectId: PROJECT_ID })).toBe(true);
    release();
    expect((await pending).ok).toBe(true);
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)?.state).toBe("cancelled");
    expect(world.database.connection.prepare("SELECT attempt_order, profile_id, provider, model, state, error_code, started_at, completed_at, finished_at, latency_ms FROM model_route_attempts WHERE operation_id = ?").get(REQUEST_ID)).toEqual({
      attempt_order: 0,
      profile_id: primary.id,
      provider: primary.provider,
      model: primary.modelId,
      state: "cancelled",
      error_code: "CANCELLED",
      started_at: AT,
      completed_at: expect.any(String),
      finished_at: expect.any(String),
      latency_ms: expect.any(Number)
    });
  });

  it("registers cancellation before retrieval finishes and never starts the provider", async () => {
    const original = await baseDeps().retrieval({ projectId: PROJECT_ID, question: "cancel during retrieval" });
    let releaseRetrieval!: () => void;
    const retrievalGate = new Promise<RetrievableChunk[]>((resolve) => { releaseRetrieval = () => resolve(original); });
    const generate = vi.fn(fakeProvider().generate);
    const service = new ChatService(baseDeps({
      retrieval: async () => retrievalGate,
      providerFactory: () => ({ ...fakeProvider(), generate })
    }));
    const events: Array<Record<string, unknown>> = [];
    const pending = service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "cancel during retrieval" }, (event) => events.push(event as Record<string, unknown>));

    expect(service.activeRequests()).toContain(REQUEST_ID);
    expect(events).toEqual([expect.objectContaining({ type: "started", requestId: REQUEST_ID })]);
    expect(service.stopRequest(REQUEST_ID, { projectId: PROJECT_ID })).toBe(true);
    releaseRetrieval();

    expect((await pending).ok).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "cancelled", requestId: REQUEST_ID, message: { state: "cancelled" } });
  });

  it("handles empty retrieval without changing the success path", async () => {
    const deps = baseDeps({ retrieval: async () => [] });
    const { result, events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
    expect(result.ok).toBe(true);
    const last = events.at(-1)! as { type: string };
    expect(last.type).toBe("completed");
  });

  it("rejects citations to candidates that did not fit the context budget", async () => {
    const base = (await baseDeps().retrieval({ projectId: PROJECT_ID, question: "?" }))[0]!;
    const deps = baseDeps({
      providerFactory: () => fakeProvider(["Unsupported candidate [S2]"]),
      retrieval: async () => [
        { ...base, label: "S1", text: "evidence ".repeat(40_000) },
        { ...base, label: "S2", text: "candidate excluded by the budget" },
      ],
    });
    const { events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
    expect(events.at(-1)).toMatchObject({ type: "completed", message: { citations: [] } });
  });

  it("fails before user persistence when no enabled generation profile exists", async () => {
    const deps = baseDeps({ generationProfile: undefined });
    const { result, events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
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
    const { result, events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
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
    const sendPromise = service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "stop me" }, (event) => events.push(event as Record<string, unknown>));
    // Stop while deltas are still streaming.
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "delta")).toBe(true);
    }, { timeout: 5000 });
    const startedEvent = events.find((e) => e.type === "started") as { requestId?: string } | undefined;
    expect(startedEvent?.requestId).toBeTruthy();
    expect(service.stopRequest(startedEvent!.requestId!, { projectId: PROJECT_ID })).toBe(true);
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
    const firstStarted = service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "one" }, () => {});
    // One macrotask tick guarantees all pre-registration microtasks (retrieval await) have flushed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.activeRequests()).not.toHaveLength(0);
    const secondEvents: Array<Record<string, unknown>> = [];
    const second = await service.send({ requestId: "55555555-5555-4555-8555-555555555555", projectId: PROJECT_ID, conversationId: world.conversationId, question: "two" }, (event) => secondEvents.push(event as Record<string, unknown>));
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
      resolveStarted(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "long question" }, (event) => events.push(event as Record<string, unknown>)));
    })();
    await vi.waitFor(() => {
      const started = events.find((e) => e.type === "started");
      expect(started).toBeDefined();
    });
    const startedEvent = events.find((e) => e.type === "started") as { requestId?: string } | undefined;
    const requestId = startedEvent?.requestId as string;
    expect(requestId).toBeTruthy();
    expect(service.stopRequest(requestId!, { projectId: PROJECT_ID })).toBe(true);
    expect(service.stopRequest(requestId!, { projectId: "other-project" })).toBe(false);
    expectOk(await startedPromise);
    const last = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(last.state).toBe("cancelled");
    expect(last.content).toBe("");
  });

  it("rejects invalid configuration without changing an edited question or appending another turn", async () => {
    const profile: ModelProfileDto = makeProfile();
    const service = new ChatService(baseDeps({ generationProfile: profile }));
    const first = expectOk(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Original question" }, () => {}));
    const before = world.repository.listMessages(PROJECT_ID, world.conversationId);
    profile.maxOutputTokensOverride = 65536;
    expect(await service.regenerate({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: first.assistantMessageId, question: "Replacement question" }, () => {})).toMatchObject({ ok: false, error: { messageKey: "errors.generationLimitsConflict" } });
    expect(await service.send({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, question: "New question" }, () => {})).toMatchObject({ ok: false });
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId)).toEqual(before);
  });

  it("retrieves evidence using the adjusted default output reserve in a small window", async () => {
    const deps = baseDeps();
    const evidence = await deps.retrieval({ projectId: PROJECT_ID, question: "What?" });
    let budget = -1;
    let request: GenerateRequest | undefined;
    const service = new ChatService({ ...deps, generationProfile: { ...makeProfile(), contextTokensOverride: 8192 },
      retrieval: async (input) => { budget = input.evidenceTokenBudget!; return budget >= 96 ? evidence : []; },
      providerFactory: () => ({ ...fakeProvider(), async *generate(input): AsyncGenerator<GenerationEvent> { request = input; yield { type: "text-delta", text: "Answer [S1]" }; yield { type: "done", finishReason: "stop" }; } }) });
    const result = expectOk(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" }, () => {}));
    expect(budget).toBeGreaterThanOrEqual(96);
    expect(request!.maxTokens).toBeLessThan(8192);
    expect(request!.messages.some((message) => message.content.includes("Authoritative evidence"))).toBe(true);
    expect(world.repository.getMessage(PROJECT_ID, result.assistantMessageId)!.citations).toHaveLength(1);
  });

  it("rejects impossible default-window settings before saving", async () => {
    const settings = new SettingsRepository(world.database.connection);
    const { createdAt: _created, updatedAt: _updated, ...profile } = makeProfile();
    settings.saveProfile(profile);
    const service = new ModelService(settings, {} as CredentialStore);
    const rejected = await service.updateGenerationSettings({ profileId: profile.id, contextTokensOverride: null, maxOutputTokensOverride: 65536 });
    expect(rejected).toMatchObject({ ok: false, error: { messageKey: "errors.generationLimitsConflict" } });
    expect(settings.getProfile(profile.id)!.maxOutputTokensOverride).toBeNull();
    expect((await service.updateGenerationSettings({ profileId: profile.id, contextTokensOverride: 131072, maxOutputTokensOverride: 65536 })).ok).toBe(true);
  });

  it("blocks stale capacity overrides on send and continuation before calling a provider", async () => {
    const profile: ModelProfileDto = { ...makeProfile(), contextTokensOverride: 65536, maxOutputTokensOverride: 8192 };
    const factory = vi.fn(() => ({ ...fakeProvider(), async *generate(): AsyncGenerator<GenerationEvent> { yield { type: "text-delta", text: "Answer" }; yield { type: "done", finishReason: "length" }; } }));
    const service = new ChatService(baseDeps({ generationProfile: profile, providerFactory: factory }));
    const first = expectOk(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Hi" }, () => {}));
    profile.generationLimits = { windowKind: "shared", contextWindowTokens: 4096, maxOutputTokens: 2048, source: "provider", observedAt: AT, identity: { provider: profile.provider, baseUrl: profile.baseUrl, modelId: profile.modelId } };
    const revision = world.repository.getGenerationContext(PROJECT_ID, first.assistantMessageId)!.revision;
    expect(await service.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: first.assistantMessageId, expectedRevision: revision }, () => {})).toMatchObject({ ok: false, error: { messageKey: "errors.generationContextLimit" } });
    expect(await service.send({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, question: "Hi again" }, () => {})).toMatchObject({ ok: false, error: { messageKey: "errors.generationContextLimit" } });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId).some((message) => message.state === "streaming")).toBe(false);
  });

  it("rejects an invalid fallback configuration before the fallback provider is called", async () => {
    const primary = makeProfile();
    const fallback = { ...primary, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", maxOutputTokensOverride: 65536 };
    const factory = vi.fn(() => ({ ...fakeProvider(), async *generate(): AsyncGenerator<GenerationEvent> { throw new ProviderRequestError({ error: { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: true }, fallbackEligible: true }); } }));
    const service = new ChatService(baseDeps({ router: { resolve: () => [primary, fallback] }, providerFactory: factory }));
    expect(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Hi" }, () => {})).toMatchObject({ ok: false, error: { messageKey: "errors.generationLimitsConflict" } });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!.state).toBe("failed");
  });

  it("sends the persisted empty-limit explanation and model in the failed terminal event", async () => {
    const service = new ChatService(baseDeps({ providerFactory: () => ({ ...fakeProvider(), async *generate(): AsyncGenerator<GenerationEvent> {
      yield { type: "usage", inputTokens: 10, outputTokens: 8192 };
      yield { type: "done", finishReason: "length" };
    } }) }));
    const events: Array<Record<string, unknown>> = [];
    await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Hi" }, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "failed", message: { state: "failed", profileId: makeProfile().id, generation: { finishKind: "length", lastError: "errors.outputLimitEmpty", canContinue: false } } });
  });

  it.each([false, true])("isolates fallback usage and identity when fallback fails=%s", async (fails) => {
    const primary = makeProfile();
    const fallback = { ...primary, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", modelId: "fallback" };
    const service = new ChatService(baseDeps({ router: { resolve: () => [primary, fallback] }, providerFactory: (profile) => ({ ...fakeProvider(), async *generate(): AsyncGenerator<GenerationEvent> {
      if (profile.id === primary.id) {
        yield { type: "usage", inputTokens: 123, outputTokens: 456 };
        throw new ProviderRequestError({ error: { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: true }, fallbackEligible: true });
      }
      yield { type: "text-delta", text: "Fallback answer" };
      if (fails) throw new ProviderRequestError({ error: { code: "PROVIDER", messageKey: "errors.providerIncomplete", recoverable: true }, fallbackEligible: false });
      yield { type: "done", finishReason: "stop" };
    } }) }));
    const events: Array<Record<string, unknown>> = [];
    await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Hi" }, (event) => events.push(event));
    const message = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
    expect(message).toMatchObject({ model: "fallback", profileId: fallback.id, state: fails ? "failed" : "completed", generation: { usageComplete: false } });
    expect(message.usage?.totalTokens ?? 0).toBe(0);
    if (fails) expect(events.at(-1)).toMatchObject({ type: "failed", message: { model: "fallback" } });
  });

  it("saves the evidence actually sent to a smaller fallback model", async () => {
    const primary = { ...makeProfile(), contextTokensOverride: 32768, maxOutputTokensOverride: 2048 };
    const fallback = { ...primary, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", modelId: "fallback", contextTokensOverride: 8192 };
    let sent: GenerateRequest | undefined;
    const deps = baseDeps();
    const evidence = await deps.retrieval({ projectId: PROJECT_ID, question: "What?" });
    const service = new ChatService({ ...deps,
      router: { resolve: () => [primary, fallback] },
      retrieval: async () => evidence.map((item) => ({ ...item, text: "Evidence ".repeat(4500) })),
      providerFactory: (profile) => ({ ...fakeProvider(), async *generate(request): AsyncGenerator<GenerationEvent> {
        if (profile.id === primary.id) throw new ProviderRequestError({ error: { code: "PROVIDER", messageKey: "errors.providerFailure", recoverable: true }, fallbackEligible: true });
        sent = request;
        yield { type: "text-delta", text: "Answer [S1]" };
        yield { type: "done", finishReason: "length" };
      } })
    });
    const result = expectOk(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" }, () => {}));
    const snapshot = world.repository.getGenerationContext(PROJECT_ID, result.assistantMessageId)!.snapshot as { evidence: Array<{ sentText: string }>; contextMessages: GenerateRequest["messages"] };
    expect(snapshot.contextMessages).toEqual(sent!.messages);
    expect(sent!.messages.some((message) => message.content.includes(snapshot.evidence[0]!.sentText))).toBe(true);
    expect(snapshot.evidence[0]!.sentText.length).toBeLessThan(10000);
  });

  it("continues a long answer by dropping uncited evidence", async () => {
    const deps = baseDeps();
    const evidence = await deps.retrieval({ projectId: PROJECT_ID, question: "What?" });
    let calls = 0;
    const service = new ChatService({ ...deps,
      generationProfile: { ...makeProfile(), contextTokensOverride: 8192, maxOutputTokensOverride: 2048 },
      retrieval: async () => evidence.map((item) => ({ ...item, text: "Evidence ".repeat(4500) })),
      providerFactory: () => ({ ...fakeProvider(), async *generate(): AsyncGenerator<GenerationEvent> {
        calls++;
        yield { type: "text-delta", text: calls === 1 ? "Answer ".repeat(350) : "continued" };
        yield { type: "done", finishReason: calls === 1 ? "length" : "stop" };
      } })
    });
    const { assistantMessageId } = expectOk(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" }, () => {}));
    const revision = world.repository.getGenerationContext(PROJECT_ID, assistantMessageId)!.revision;
    expectOk(await service.continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantMessageId, expectedRevision: revision }, () => {}));
    expect(calls).toBe(2);
    expect(world.repository.getMessage(PROJECT_ID, assistantMessageId)!.content).toBe("Answer ".repeat(350) + "continued");
  });

  it("rebuilds checkpoint citations and incomplete usage on restart exactly once", async () => {
    const result = expectOk(await new ChatService(baseDeps({ providerFactory: () => fakeProvider(["Original"]) })).send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" }, () => {}));
    const messageId = result.assistantMessageId;
    const saved = world.repository.getGenerationContext(PROJECT_ID, messageId)!;
    const claim = world.repository.claimContinuation({ projectId: PROJECT_ID, messageId, requestId: crypto.randomUUID(), expectedRevision: saved.revision, updatedAt: AT });
    expect(claim.kind).toBe("claimed");
    world.repository.checkpointAssistantContent({ projectId: PROJECT_ID, messageId, content: "Original. New citation [S1]", updatedAt: AT });
    const running = world.repository.getGenerationContext(PROJECT_ID, messageId)!;
    world.repository.updateGenerationRuntime({ projectId: PROJECT_ID, messageId, runtime: { ...running.runtime, attemptUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } });
    expect(recoverInterruptedStreams(world.database.connection)).toBe(1);
    const recovered = world.repository.getMessage(PROJECT_ID, messageId)!;
    expect(recovered.citations.map((item) => item.label)).toEqual(["S1"]);
    expect(recovered.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(recovered.generation).toMatchObject({ status: "interrupted", canContinue: true, usageComplete: false });
    expect(recoverInterruptedStreams(world.database.connection)).toBe(0);
    expect(world.repository.getMessage(PROJECT_ID, messageId)!.usage).toEqual(recovered.usage);
    expectOk(await new ChatService(baseDeps()).continue({ requestId: crypto.randomUUID(), projectId: PROJECT_ID, conversationId: world.conversationId, messageId, expectedRevision: recovered.generation!.revision }, () => {}));
    const continued = world.repository.getMessage(PROJECT_ID, messageId)!;
    expect(continued.usage).toEqual({ inputTokens: 22, outputTokens: 13, totalTokens: 35 });
    expect(continued.generation?.usageComplete).toBe(false);
  });

  it("checkpoints the latest usage together with streaming content", async () => {
    let checkpointSeen = false;
    const service = new ChatService(baseDeps({ providerFactory: () => ({ ...fakeProvider(), async *generate(): AsyncGenerator<GenerationEvent> {
      yield { type: "usage", inputTokens: 7, outputTokens: 8 };
      yield { type: "text-delta", text: "x".repeat(2100) };
      const message = world.repository.listMessages(PROJECT_ID, world.conversationId).at(-1)!;
      expect(message.content).toHaveLength(2100);
      expect(world.repository.getGenerationContext(PROJECT_ID, message.id)!.runtime.attemptUsage).toEqual({ inputTokens: 7, outputTokens: 8, totalTokens: 15 });
      checkpointSeen = true;
      yield { type: "done", finishReason: "stop" };
    } }) }));
    expectOk(await service.send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" }, () => {}));
    expect(checkpointSeen).toBe(true);
  });

  it("restores a boolean continuation flag for a stranded completed answer", async () => {
    const result = expectOk(await new ChatService(baseDeps()).send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "What?" }, () => {}));
    const saved = world.repository.getGenerationContext(PROJECT_ID, result.assistantMessageId)!;
    world.repository.updateGenerationRuntime({ projectId: PROJECT_ID, messageId: result.assistantMessageId, activeRequestId: crypto.randomUUID(), runtime: { ...saved.runtime, operation: "continue", status: "running", canContinue: false } });
    expect(recoverInterruptedStreams(world.database.connection)).toBe(1);
    expect(world.repository.getMessage(PROJECT_ID, result.assistantMessageId)!.generation?.canContinue).toBe(true);
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

describe("ChatService conversation operations and retrieval failure", () => {
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

  afterEach(() => {
    vi.useRealTimers();
    world.database.close();
  });

  function service(deps?: Partial<ChatSendDeps>): ChatService {
    const provider = fakeProvider();
    return new ChatService({
      db: world.database.connection,
      generationProfile: makeProfile(),
      providerFactory: () => provider,
      retrieval: async () => [],
      now: () => new Date(AT),
      randomId: (n) => `id-${Math.random().toString(36).slice(2, 8)}-${n}`,
      ...deps
    });
  }

  it("lists, creates, renames, archives and deletes conversations with ownership", () => {
    const svc = service();
    const created = svc.createConversation({ projectId: PROJECT_ID, title: "New chat" });
    expect(created.title).toBe("New chat");
    expect(svc.listConversations(PROJECT_ID)).toHaveLength(2);
    expect(svc.renameConversation({ projectId: PROJECT_ID, conversationId: created.id, title: "Renamed" }).title).toBe("Renamed");
    expect(svc.archiveConversation({ projectId: PROJECT_ID, conversationId: created.id }).archivedAt).toBe(AT);
    expect(() => svc.renameConversation({ projectId: PROJECT_ID, conversationId: created.id, title: "Nope" })).toThrow(/archived/);
    expect(svc.listConversations(PROJECT_ID)).toHaveLength(1);
    svc.deleteConversation({ projectId: PROJECT_ID, conversationId: created.id });
  });

  it("regenerates a reply without duplicating the user message and keeps lineage", async () => {
    const sendDeps = baseDeps();
    const first = await collectEvents(sendDeps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Only once" });
    expect(first.result.ok).toBe(true);
    const assistantId = (first.result as { ok: true; value: { assistantMessageId: string } }).value.assistantMessageId;

    const regenEvents: Array<Record<string, unknown>> = [];
    const regen = await service().regenerate(
      { requestId: "55555555-5555-4555-8555-555555555555", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId },
      (event) => regenEvents.push(event)
    );
    expect(regen.ok).toBe(true);
    const messages = world.repository.listMessages(PROJECT_ID, world.conversationId);
    const userCount = messages.filter((m) => m.role === "user").length;
    expect(userCount).toBe(1);
    const oldAssistant = messages.find((m) => m.id === assistantId)!;
    expect(oldAssistant.superseded).toBe(true);
    const newAssistant = messages.at(-1)!;
    expect(newAssistant.supersedesMessageId).toBe(assistantId);
    expect(newAssistant.replyToMessageId).toBe(oldAssistant.replyToMessageId);
    expect(messages.filter((m) => m.role === "assistant" && !m.superseded)).toHaveLength(1);
  });

  it("does not regenerate an assistant message from another conversation", async () => {
    const first = await collectEvents(baseDeps(), { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "first" });
    const assistantId = (first.result as { ok: true; value: { assistantMessageId: string } }).value.assistantMessageId;
    const otherConversationId = "55555555-5555-4555-8555-555555555555";
    world.repository.createConversation({ id: otherConversationId, projectId: PROJECT_ID, title: "Other", createdAt: AT });
    const otherUser = world.repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: otherConversationId, id: "other-user", content: "other", createdAt: AT });
    world.repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: otherConversationId, id: "other-assistant", replyToMessageId: otherUser.id, provider: "openai", profileId: makeProfile().id, model: "gpt-test", createdAt: AT });

    const result = await service().regenerate({ requestId: "66666666-6666-4666-8666-666666666666", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: "other-assistant" }, () => undefined);
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(world.repository.getMessage(PROJECT_ID, assistantId)?.superseded).toBe(false);
    expect(world.repository.getMessage(PROJECT_ID, "other-assistant")?.superseded).toBe(false);
  });

  it("does not edit a question when regeneration races an active turn", async () => {
    const first = await collectEvents(baseDeps(), { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "keep this" });
    const assistantId = (first.result as { ok: true; value: { assistantMessageId: string } }).value.assistantMessageId;
    const originalUserId = world.repository.getMessage(PROJECT_ID, assistantId)!.replyToMessageId!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = service({ providerFactory: () => ({ ...fakeProvider(), async *generate(_request, signal) { await gate; if (signal.aborted) return; yield { type: "text-delta", text: "second" }; yield { type: "done" }; } }) });
    const pending = svc.send({ requestId: "77777777-7777-4777-8777-777777777777", projectId: PROJECT_ID, conversationId: world.conversationId, question: "second turn" }, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    const result = await svc.regenerate({ requestId: "88888888-8888-4888-8888-888888888888", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId, question: "must not mutate" }, () => undefined);
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(world.repository.getMessage(PROJECT_ID, originalUserId)?.content).toBe("keep this");
    release();
    await pending;
  });

  it("does not expose internal exception details to callers", async () => {
    const result = await service().send({ requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: "99999999-9999-4999-8999-999999999999", question: "private" }, () => undefined);
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: false } });
  });

  it("edits a cancelled question in place and includes earlier completed turns", async () => {
    await collectEvents(baseDeps({ retrieval: async () => [] }), { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "Original context" });
    const cancelledUser = world.repository.appendUserMessage({ projectId: PROJECT_ID, conversationId: world.conversationId, id: "cancelled-user", content: "Old follow-up", createdAt: AT });
    world.repository.startAssistantMessage({ projectId: PROJECT_ID, conversationId: world.conversationId, id: "cancelled-assistant", replyToMessageId: cancelledUser.id, provider: "openai", profileId: makeProfile().id, model: "gpt-test", createdAt: AT });
    world.repository.cancelAssistantMessage({ projectId: PROJECT_ID, messageId: "cancelled-assistant", updatedAt: AT });
    const requests: GenerateRequest[] = [];
    const provider = fakeProvider();
    const generate = provider.generate.bind(provider);
    provider.generate = async function* (request, signal) {
      requests.push(request as GenerateRequest);
      yield* generate(request, signal);
    };

    const result = await service({ providerFactory: () => provider, retrieval: async () => [] }).regenerate({
      requestId: "55555555-5555-4555-8555-555555555555",
      projectId: PROJECT_ID,
      conversationId: world.conversationId,
      messageId: "cancelled-assistant",
      question: "Edited follow-up"
    }, () => undefined);

    expect(result.ok).toBe(true);
    expect(world.repository.getMessage(PROJECT_ID, cancelledUser.id)?.content).toBe("Edited follow-up");
    expect(world.repository.listMessages(PROJECT_ID, world.conversationId).filter((message) => message.role === "user")).toHaveLength(2);
    expect(requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Original context" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Grounded answer") }),
      expect.objectContaining({ role: "user", content: "Edited follow-up" })
    ]));
  });

  it("refuses regeneration for an archived conversation", async () => {
    const sendDeps = baseDeps();
    const first = await collectEvents(sendDeps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "hello" });
    const assistantId = (first.result as { ok: true; value: { assistantMessageId: string } }).value.assistantMessageId;
    const svc = service();
    svc.archiveConversation({ projectId: PROJECT_ID, conversationId: world.conversationId });
    const result = await svc.regenerate({ requestId: "88888888-8888-4888-8888-888888888888", projectId: PROJECT_ID, conversationId: world.conversationId, messageId: assistantId }, () => {});
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("surfaces retrieval failure as failed message + INDEX_UNAVAILABLE instead of empty evidence", async () => {
    const deps = baseDeps({ retrieval: async () => { throw new Error("lance down"); } });
    const { result, events } = await collectEvents(deps, { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "?" });
    expect(result).toMatchObject({ ok: false, error: { code: "INDEX_UNAVAILABLE", recoverable: true } });
    expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "INDEX_UNAVAILABLE", recoverable: true } });
    const messages = world.repository.listMessages(PROJECT_ID, world.conversationId);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", state: "failed", errorCode: "INDEX_UNAVAILABLE" });
  });

  it("opens citations from completed answers through the citation opener", async () => {
    world.database.connection.prepare("UPDATE source_revisions SET state = 'ready' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'").run();
    const openPath = vi.fn(async () => "");
    const opener = new CitationOpener(world.database.connection, { openPath, openExternal: vi.fn() });
    const svc = service({ retrieval: async () => [] });
    const sent = await collectEvents(baseDeps(), { requestId: REQUEST_ID, projectId: PROJECT_ID, conversationId: world.conversationId, question: "cite it" });
    const completed = sent.events.at(-1)! as { message: { citations: CitationDto[] } };
    const citation = completed.message.citations[0]!;
    expect(svc.listMessages({ projectId: PROJECT_ID, conversationId: world.conversationId }).at(-1)!.citations.map((c) => c.sourceDisplayName)).toContain("Research PDF");
    openPath.mockResolvedValue("");
    const opened = await opener.openCitation({ projectId: PROJECT_ID, citationId: citation.id });
    expect(opened.ok).toBe(true);
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
  database.connection.prepare("UPDATE sources SET current_revision_id=? WHERE id=?").run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "88888888-8888-4888-8888-888888888888");
  database.connection.prepare("UPDATE source_revisions SET state='ready'").run();
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
