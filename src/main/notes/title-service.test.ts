import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import type { ModelProfileDto, ModelTaskKind } from "../../shared/models";
import type { GenerationEvent, ModelProvider } from "../models/provider";
import { ModelRouter } from "../models/model-router";
import { ProviderRequestError } from "../models/http-client";
import { classifyProviderError } from "../models/provider-errors";
import { RoutedGeneration } from "../models/routed-generation";
import { NoteNotFoundError, NoteRepository, NoteVersionConflictError } from "./note-repository";
import { TitleService } from "./title-service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const PRIMARY_ID = "33333333-3333-4333-8333-333333333333";
const FALLBACK_ID = "44444444-4444-4444-8444-444444444444";

function note(overrides: Partial<{ title: string; body: string; version: number }> = {}) {
  return {
    id: NOTE_ID,
    projectId: PROJECT_ID,
    title: overrides.title ?? "Original title",
    body: overrides.body ?? "Original body",
    version: overrides.version ?? 3,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z"
  };
}

function generation(events: Array<{ type: "text-delta"; text: string } | { type: "done" }>, onCall?: (request: any, profileId: string | undefined) => void) {
  return {
    generateRouted: async function* (_task: string, request: any, profileId?: string) {
      onCall?.(request, profileId);
      for (const event of events) yield event;
    }
  };
}

function profile(id: string, model: string): ModelProfileDto {
  return { id, name: model, provider: "openai", capability: "generation", baseUrl: "https://example.test", modelId: model, enabled: true, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" };
}

function provider(action: () => AsyncGenerator<GenerationEvent>): ModelProvider {
  return { discover: async () => [], generate: () => action(), embed: async () => [[]] };
}

describe("TitleService", () => {
  let root: string | undefined;
  let database: AppDatabase | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-title-"));
    database = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    database.connection.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(PROJECT_ID, "Test");
  });

  afterEach(() => {
    database?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    database = undefined;
    root = undefined;
  });

  it("uses bilingual prompts and aggregates text deltas", async () => {
    const calls: Array<{ request: any; profileId: string | undefined }> = [];
    const repository = { get: () => note(), update: vi.fn((input) => ({ ...note(), ...input, version: 4 })) } as any;
    const service = new TitleService(repository, generation([
      { type: "text-delta", text: "  A  " },
      { type: "text-delta", text: "useful title " },
      { type: "done" }
    ], (request, profileId) => calls.push({ request, profileId })), () => "operation-1");

    await service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "zh-CN", profileId: "profile-override" });
    const zh = calls[0]!.request.messages;
    expect(calls[0]!.profileId).toBe("profile-override");
    expect(zh[0].content).toMatch(/标题|title/i);
    expect(zh[1].content).toContain("Original body");
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ title: "A useful title", body: "Original body", version: 3 }));

    const englishCalls: any[] = [];
    const english = new TitleService({ get: () => note(), update: vi.fn((input) => ({ ...note(), ...input })) } as any, generation([
      { type: "text-delta", text: "English title" }, { type: "done" }
    ], (request) => englishCalls.push(request)), () => "operation-2");
    await english.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" });
    expect(englishCalls[0].messages[0].content).toMatch(/title/i);
    expect(englishCalls[0].messages[0].content).not.toContain("标题");
  });

  it("caps the note snapshot at 12,000 Unicode code points with a visible marker", async () => {
    let request: any;
    const body = "😀".repeat(12_100);
    const repository = { get: () => note({ body }), update: vi.fn((input) => ({ ...note(), ...input })) } as any;
    const service = new TitleService(repository, generation([
      { type: "text-delta", text: "short title" }, { type: "done" }
    ], (value) => { request = value; }), () => "operation-truncate");

    await service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "zh-CN" });
    const content = (request.messages[1].content as string).split("\n\n").at(-1)!;
    expect(Array.from(content).length).toBeLessThanOrEqual(12_000);
    expect(content).toContain("截断");
    expect(content).toContain("😀");
  });

  it("collapses whitespace, strips matching outer quotes and caps at 80 code points", async () => {
    const repository = { get: () => note(), update: vi.fn((input) => ({ ...note(), ...input })) } as any;
    const value = ` “  ${"长".repeat(100)}  ” `;
    const service = new TitleService(repository, generation([
      { type: "text-delta", text: value }, { type: "done" }
    ]), () => "operation-clean");

    await service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" });
    const title = repository.update.mock.calls[0][0].title as string;
    expect(Array.from(title).length).toBe(80);
    expect(title).not.toMatch(/^\s|\s$/);
    expect(title).not.toMatch(/^[“”"']/);
    expect(title).not.toMatch(/[“”"']$/);
  });

  it("keeps the original note for empty output", async () => {
    const repository = { get: () => note(), update: vi.fn() } as any;
    const service = new TitleService(repository, generation([
      { type: "text-delta", text: "  ‘  ’  " }, { type: "done" }
    ]), () => "operation-empty");

    await expect(service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" })).resolves.toEqual(note());
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("keeps the original title and body when generation fails", async () => {
    const repository = { get: () => note(), update: vi.fn() } as any;
    const failing = { generateRouted: async function* () { throw new Error("provider failed"); } };
    const service = new TitleService(repository, failing, () => "operation-failure");

    await expect(service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" })).rejects.toThrow("provider failed");
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.get(PROJECT_ID, NOTE_ID)).toEqual(note());
  });

  it("uses the snapshot body and returns a version conflict instead of overwriting an edit", async () => {
    const repository = new NoteRepository(database!.connection);
    repository.create({ id: NOTE_ID, projectId: PROJECT_ID, title: "Original title", body: "Original body" });
    const service = new TitleService(repository, generation([
      { type: "text-delta", text: "New title" }, { type: "done" }
    ], () => {
      repository.update({ projectId: PROJECT_ID, id: NOTE_ID, title: "Concurrent title", body: "Concurrent body", version: 1 });
    }), () => "operation-conflict");

    await expect(service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" })).rejects.toBeInstanceOf(NoteVersionConflictError);
    expect(repository.get(PROJECT_ID, NOTE_ID)).toMatchObject({ title: "Concurrent title", body: "Concurrent body", version: 2 });
  });

  it("rejects deleted notes before calling routed generation", async () => {
    const repository = new NoteRepository(database!.connection);
    repository.create({ id: NOTE_ID, projectId: PROJECT_ID, title: "Deleted", body: "Secret body" });
    repository.remove(PROJECT_ID, NOTE_ID, 1);
    let calls = 0;
    const service = new TitleService(repository, {
      generateRouted: async function* () {
        calls += 1;
        yield { type: "text-delta", text: "must not run" };
      }
    }, () => "operation-deleted");

    await expect(service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" })).rejects.toBeInstanceOf(NoteNotFoundError);
    expect(calls).toBe(0);
  });

  it("uses real routed generation fallback and records actual provider models", async () => {
    const db = database!.connection;
    const profiles = new Map([[PRIMARY_ID, profile(PRIMARY_ID, "title-primary")], [FALLBACK_ID, profile(FALLBACK_ID, "title-fallback")] ]);
    for (const item of profiles.values()) db.prepare("INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)").run(item.id, item.name, item.provider, item.capability, item.baseUrl, item.modelId, item.createdAt, item.updatedAt);
    db.prepare("INSERT INTO model_routes(task_kind, position, profile_id) VALUES ('note-title', 0, ?), ('note-title', 1, ?)").run(PRIMARY_ID, FALLBACK_ID);
    const router = new ModelRouter({
      getProfile: (id: string) => profiles.get(id),
      getRoute: (task: ModelTaskKind) => task === "note-title" ? [
        { taskKind: "note-title" as const, position: 0, profileId: PRIMARY_ID },
        { taskKind: "note-title" as const, position: 1, profileId: FALLBACK_ID }
      ] : []
    });
    const routed = new RoutedGeneration({
      db,
      router,
      providerFactory: (item) => item.id === PRIMARY_ID
        ? provider(async function* () { throw new ProviderRequestError(classifyProviderError({ status: 503 })); })
        : provider(async function* () { yield { type: "text-delta", text: " Routed title " }; yield { type: "done" }; }),
      clock: () => new Date("2026-08-28T00:00:00.000Z"),
      id: (() => { let count = 0; return () => `55555555-5555-4555-8555-55555555555${++count}`; })()
    });
    const repository = { get: () => note(), update: vi.fn((input) => ({ ...note(), ...input })) } as any;
    const service = new TitleService(repository, routed, () => "title-operation");

    await expect(service.generateTitle({ projectId: PROJECT_ID, noteId: NOTE_ID, locale: "en" })).resolves.toMatchObject({ title: "Routed title" });
    expect(db.prepare("SELECT provider, model, state, error_code FROM model_route_attempts WHERE operation_id = ? ORDER BY attempt_order").all("title-operation")).toEqual([
      { provider: "openai", model: "title-primary", state: "failed", error_code: "PROVIDER" },
      { provider: "openai", model: "title-fallback", state: "completed", error_code: null }
    ]);
  });
});
