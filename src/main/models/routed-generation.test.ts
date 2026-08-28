import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openAppDatabase, type AppDatabase } from "../db/database";
import type { ModelProfileDto, ModelTaskKind } from "../../shared/models";
import type { GenerationEvent, ModelProvider } from "./provider";
import { ModelRouter } from "./model-router";
import { ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";
import { generateRouted, type RoutedGenerationDeps, type RoutedGenerationEvent } from "./routed-generation";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PRIMARY_ID = "22222222-2222-4222-8222-222222222222";
const FALLBACK_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const AT = new Date("2026-08-28T00:00:00.000Z");

function profile(id: string, model = id): ModelProfileDto {
  return { id, name: model, provider: "openai", capability: "generation", baseUrl: "https://example.test", modelId: model, enabled: true, createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
}

function failure(status: number): ProviderRequestError {
  return new ProviderRequestError(classifyProviderError({ status }));
}

function providerWith(action: () => AsyncGenerator<GenerationEvent>): ModelProvider {
  return { discover: async () => [], generate: (_request, _signal) => action(), embed: async () => [[]] };
}

async function collect(stream: AsyncIterable<RoutedGenerationEvent>): Promise<RoutedGenerationEvent[]> {
  const events: RoutedGenerationEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("transparent generation fallback", () => {
  let root: string;
  let database: AppDatabase;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-routed-"));
    database = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    database.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Test");
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function deps(providers: Record<string, ModelProvider>): RoutedGenerationDeps {
    const profiles = new Map([[PRIMARY_ID, profile(PRIMARY_ID, "primary")], [FALLBACK_ID, profile(FALLBACK_ID, "fallback")]]);
    for (const item of profiles.values()) database.connection.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)").run(item.id, item.name, item.provider, item.capability, item.baseUrl, item.modelId, item.createdAt, item.updatedAt);
    const routes = { getProfile: (id: string) => profiles.get(id), getRoute: (task: ModelTaskKind) => task === "chat" ? [
      { taskKind: "chat" as const, position: 0, profileId: PRIMARY_ID },
      { taskKind: "chat" as const, position: 1, profileId: FALLBACK_ID }
    ] : [] };
    return { db: database.connection, router: new ModelRouter(routes), providerFactory: (p) => providers[p.id]!, clock: () => AT, id: (() => { let i = 0; return () => `55555555-5555-4555-8555-55555555555${++i}`; })() };
  }

  it.each(["TIMEOUT", "NETWORK", "RATE_LIMITED", "PROVIDER"] as const)("falls back for %s", async (code) => {
    const primary = providerWith(async function* () { throw new ProviderRequestError({ error: { code, messageKey: "errors.provider", recoverable: true }, fallbackEligible: true }); });
    const fallback = providerWith(async function* () { yield { type: "text-delta", text: "ok" }; yield { type: "done" }; });
    const events = await collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }));
    expect(events.find((event) => event.type === "fallback")).toMatchObject({ errorCode: code, attempted: { model: "primary" }, next: { model: "fallback" } });
    expect(events.find((event) => event.type === "routed-complete")).toMatchObject({ profile: { profileId: FALLBACK_ID, model: "fallback" } });
  });

  it("classifies an eligible 503 through the shared classifier", async () => {
    const primary = providerWith(async function* () { throw new ProviderRequestError(classifyProviderError({ status: 503 })); });
    const fallback = providerWith(async function* () { yield { type: "done" }; });
    const events = await collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }));
    expect(events.find((event) => event.type === "fallback")).toMatchObject({ errorCode: "PROVIDER" });
  });

  it("does not fallback for a safe context validation error", async () => {
    const calls: string[] = [];
    const primary = providerWith(async function* () {
      calls.push(PRIMARY_ID);
      throw new ProviderRequestError(classifyProviderError({ configuration: true }));
    });
    const fallback = providerWith(async function* () { calls.push(FALLBACK_ID); yield { type: "done" }; });
    await expect(collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }))).rejects.toMatchObject({ error: classifyProviderError({ configuration: true }).error });
    expect(calls).toEqual([PRIMARY_ID]);
  });

  it("exhausts eligible profiles in order and emits only adjacent fallbacks", async () => {
    const calls: string[] = [];
    const fail = (id: string) => providerWith(async function* () { calls.push(id); throw new ProviderRequestError(classifyProviderError({ status: 503 })); });
    const events: RoutedGenerationEvent[] = [];
    await expect((async () => { for await (const event of generateRouted(deps({ [PRIMARY_ID]: fail(PRIMARY_ID), [FALLBACK_ID]: fail(FALLBACK_ID) }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] })) events.push(event); })()).rejects.toMatchObject({ error: { code: "PROVIDER" } });
    expect(calls).toEqual([PRIMARY_ID, FALLBACK_ID]);
    expect(events.filter((event) => event.type === "fallback")).toHaveLength(1);
    expect(database.connection.prepare("SELECT attempt_order, profile_id, provider, model, state, error_code, started_at, completed_at, finished_at, latency_ms FROM model_route_attempts WHERE operation_id = ? ORDER BY attempt_order").all(OPERATION_ID)).toEqual([
      { attempt_order: 0, profile_id: PRIMARY_ID, provider: "openai", model: "primary", state: "failed", error_code: "PROVIDER", started_at: AT.toISOString(), completed_at: AT.toISOString(), finished_at: AT.toISOString(), latency_ms: 0 },
      { attempt_order: 1, profile_id: FALLBACK_ID, provider: "openai", model: "fallback", state: "failed", error_code: "PROVIDER", started_at: AT.toISOString(), completed_at: AT.toISOString(), finished_at: AT.toISOString(), latency_ms: 0 }
    ]);
    expect(events.filter((event) => event.type === "attempt-started").map((event) => event.type === "attempt-started" ? [event.attemptOrder, event.attempt.profileId] : [])).toEqual([[0, PRIMARY_ID], [1, FALLBACK_ID]]);
  });

  it.each([401, 404, 400])("does not fallback for forbidden HTTP %i", async (status) => {
    const calls: string[] = [];
    const primary = providerWith(async function* () { calls.push(PRIMARY_ID); throw failure(status); });
    const fallback = providerWith(async function* () { calls.push(FALLBACK_ID); yield { type: "done" }; });
    await expect(collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }))).rejects.toMatchObject({ error: { code: status === 401 ? "AUTH" : status === 404 ? "NOT_FOUND" : "PROVIDER" } });
    expect(calls).toEqual([PRIMARY_ID]);
  });

  it.each([
    ["VALIDATION", { configuration: true }],
    ["UNSAFE_INPUT", { malformedResponse: true }],
    ["TOO_LARGE", { responseTooLarge: true }],
    ["CANCELLED", { cancelled: true }]
  ] as const)("does not fallback for forbidden classified %s failures", async (_label, input) => {
    const calls: string[] = [];
    const primary = providerWith(async function* () { calls.push(PRIMARY_ID); throw new ProviderRequestError(classifyProviderError(input)); });
    const fallback = providerWith(async function* () { calls.push(FALLBACK_ID); yield { type: "done" }; });
    await expect(collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }))).rejects.toMatchObject({ error: { code: expect.any(String) } });
    expect(calls).toEqual([PRIMARY_ID]);
  });

  it("does not fallback after partial output and strips routing context", async () => {
    let received: unknown;
    const primary = { ...providerWith(async function* () { yield { type: "text-delta", text: "partial" }; throw failure(503); }), generate: (request: unknown) => { received = request; return (async function* () { yield { type: "text-delta", text: "partial" }; throw failure(503); })(); } } as ModelProvider;
    const fallback = providerWith(async function* () { yield { type: "done" }; });
    await expect(collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "primary", messages: [] }))).rejects.toMatchObject({ error: { code: "PROVIDER" } });
    expect(received).toEqual({ model: "primary", messages: [] });
    expect(database.connection.prepare("SELECT count(*) AS n FROM model_route_attempts WHERE operation_id = ? AND state = 'failed'").get(OPERATION_ID)).toEqual({ n: 1 });
  });

  it("persists attempt lifecycle and exposes only safe fallback fields", async () => {
    const primary = providerWith(async function* () { throw new ProviderRequestError({ error: { code: "TIMEOUT", messageKey: "errors.timeout", recoverable: true, details: { secret: "do-not-send" } }, fallbackEligible: true }); });
    const fallback = providerWith(async function* () { yield { type: "done" }; });
    const events = await collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "primary", messages: [] }));
    const fallbackEvent = events.find((event) => event.type === "fallback")!;
    expect(Object.keys(fallbackEvent).sort()).toEqual(["attempted", "errorCode", "next", "type"]);
    expect(database.connection.prepare("SELECT attempt_order, state, provider, model, latency_ms FROM model_route_attempts WHERE operation_id = ? ORDER BY attempt_order").all(OPERATION_ID)).toEqual([
      { attempt_order: 0, state: "failed", provider: "openai", model: "primary", latency_ms: 0 },
      { attempt_order: 1, state: "completed", provider: "openai", model: "fallback", latency_ms: 0 }
    ]);
  });

  it("rejects embedding and cancellation without fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = providerWith(async function* () { yield { type: "done" }; });
    await expect(collect(generateRouted(deps({ [PRIMARY_ID]: provider, [FALLBACK_ID]: provider }), "embedding", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }, undefined, controller.signal))).rejects.toThrow(/embedding/i);
  });

  it("marks an attempt cancelled when the consumer closes after a streamed delta", async () => {
    const primary = providerWith(async function* () {
      yield { type: "text-delta", text: "partial" };
      await new Promise<void>(() => {});
    });
    const stream = generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: primary }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "primary", messages: [] });
    await stream.next();
    await stream.next();
    await stream.return(undefined);
    expect(database.connection.prepare("SELECT state FROM model_route_attempts WHERE operation_id = ?").get(OPERATION_ID)).toEqual({ state: "cancelled" });
  });

  it.each([
    async function* () { yield { type: "done" as const }; yield { type: "done" as const }; },
    async function* () { yield { type: "done" as const }; yield { type: "text-delta" as const, text: "late" }; },
    async function* () { yield { type: "done" as const }; throw failure(503); }
  ])("rejects duplicate or trailing provider input after done", async (action) => {
    const primary = providerWith(action);
    const calls: string[] = [];
    const fallback = providerWith(async function* () { calls.push(FALLBACK_ID); yield { type: "done" }; });
    await expect(collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: fallback }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "primary", messages: [] }))).rejects.toMatchObject({ error: { code: expect.any(String) } });
    expect(calls).toEqual([]);
  });

  it("uses an explicit override before configured routes", async () => {
    const primary = providerWith(async function* () { yield { type: "done" }; });
    const events = await collect(generateRouted(deps({ [PRIMARY_ID]: primary, [FALLBACK_ID]: primary }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }, FALLBACK_ID));
    expect(events.find((event) => event.type === "attempt-started")).toMatchObject({ attempt: { profileId: FALLBACK_ID } });
  });

  it("tries an explicit override first, then completes on configured fallback", async () => {
    const override = providerWith(async function* () { throw new ProviderRequestError(classifyProviderError({ status: 503 })); });
    const configured = providerWith(async function* () { yield { type: "text-delta", text: "ok" }; yield { type: "done" }; });
    const events = await collect(generateRouted(deps({ [PRIMARY_ID]: configured, [FALLBACK_ID]: override }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "ignored", messages: [] }, FALLBACK_ID));
    expect(events.map((event) => event.type)).toEqual(["attempt-started", "fallback", "attempt-started", "text-delta", "done", "routed-complete"]);
    expect(events.filter((event) => event.type === "attempt-started").map((event) => event.type === "attempt-started" ? [event.attemptOrder, event.attempt.profileId] : [])).toEqual([[0, FALLBACK_ID], [1, PRIMARY_ID]]);
    expect(events.find((event) => event.type === "routed-complete")).toMatchObject({ profile: { profileId: PRIMARY_ID } });
    expect(database.connection.prepare("SELECT attempt_order, profile_id, provider, model, state, error_code, started_at, completed_at, finished_at, latency_ms FROM model_route_attempts WHERE operation_id = ? ORDER BY attempt_order").all(OPERATION_ID)).toEqual([
      { attempt_order: 0, profile_id: FALLBACK_ID, provider: "openai", model: "fallback", state: "failed", error_code: "PROVIDER", started_at: AT.toISOString(), completed_at: AT.toISOString(), finished_at: AT.toISOString(), latency_ms: 0 },
      { attempt_order: 1, profile_id: PRIMARY_ID, provider: "openai", model: "primary", state: "completed", error_code: null, started_at: AT.toISOString(), completed_at: AT.toISOString(), finished_at: AT.toISOString(), latency_ms: 0 }
    ]);
  });

  it("passes each attempt's profile model to the provider", async () => {
    const received: Array<[string, string]> = [];
    const transient = (id: string) => ({
      ...providerWith(async function* () {
        throw new ProviderRequestError(classifyProviderError({ status: 503 }));
      }),
      generate: (request: { model: string }) => {
        received.push([id, request.model]);
        return (async function* () {
          throw new ProviderRequestError(classifyProviderError({ status: 503 }));
        })();
      }
    }) as ModelProvider;
    const succeeds = (id: string) => ({
      ...providerWith(async function* () { yield { type: "done" }; }),
      generate: (request: { model: string }) => {
        received.push([id, request.model]);
        return (async function* () { yield { type: "done" }; })();
      }
    }) as ModelProvider;

    await collect(generateRouted(deps({ [PRIMARY_ID]: transient(PRIMARY_ID), [FALLBACK_ID]: succeeds(FALLBACK_ID) }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "original", messages: [] }));
    expect(received).toEqual([[PRIMARY_ID, "primary"], [FALLBACK_ID, "fallback"]]);
  });

  it("uses the override model before configured route models", async () => {
    const received: Array<[string, string]> = [];
    const transient = (id: string) => ({
      ...providerWith(async function* () {
        throw new ProviderRequestError(classifyProviderError({ status: 503 }));
      }),
      generate: (request: { model: string }) => {
        received.push([id, request.model]);
        return (async function* () {
          throw new ProviderRequestError(classifyProviderError({ status: 503 }));
        })();
      }
    }) as ModelProvider;
    const succeeds = (id: string) => ({
      ...providerWith(async function* () { yield { type: "done" }; }),
      generate: (request: { model: string }) => {
        received.push([id, request.model]);
        return (async function* () { yield { type: "done" }; })();
      }
    }) as ModelProvider;

    await collect(generateRouted(deps({ [PRIMARY_ID]: succeeds(PRIMARY_ID), [FALLBACK_ID]: transient(FALLBACK_ID) }), "chat", { projectId: PROJECT_ID, operationId: OPERATION_ID, model: "original", messages: [] }, FALLBACK_ID));
    expect(received).toEqual([[FALLBACK_ID, "fallback"], [PRIMARY_ID, "primary"]]);
  });
});
