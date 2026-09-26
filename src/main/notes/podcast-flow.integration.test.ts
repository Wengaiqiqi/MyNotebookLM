import { mkdtempSync, readdirSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { CredentialStore } from "../credentials/credential-store";
import { SettingsRepository } from "../settings/settings-repository";
import { ModelService } from "../models/model-service";
import { ModelRouter } from "../models/model-router";
import { RoutedGeneration } from "../models/routed-generation";
import { OpenAiCompatibleProvider } from "../models/openai-provider";
import { pcmWave } from "../models/speech-provider";
import { TaskRepository } from "../tasks/task-repository";
import { TaskService } from "../tasks/task-service";
import { NoteRepository } from "./note-repository";
import { TransformationRepository } from "./transformation-repository";
import { TransformationService } from "./transformation-service";
import { PodcastService } from "./podcast-service";

const projectId = "11111111-1111-4111-8111-111111111111", noteId = "22222222-2222-4222-8222-222222222222";
const textId = "33333333-3333-4333-8333-333333333333", speechId = "44444444-4444-4444-8444-444444444444";
const base = { name: "Podcast", provider: "openai-compatible" as const, capability: "generation" as const, baseUrl: "https://podcast.example/v1", enabled: true };
const script = JSON.stringify({ title: "Research discussion", turns: [{ speaker: "A", text: "What is the finding?" }, { speaker: "B", text: "The source reports a finding." }, { speaker: "A", text: "Thanks for the explanation." }] });

describe("podcast integration", () => {
  let root: string, db: AppDatabase, settings: SettingsRepository, models: ModelService, service: TransformationService;
  let tasks: TaskService, failSpeech: boolean, controller: AbortController | undefined;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-podcast-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    settings = new SettingsRepository(db.connection);
    const credentials = new CredentialStore(db.connection, { isAvailable: async () => true, encrypt: async (text) => Buffer.from(text), decrypt: async (bytes) => bytes.toString() });
    models = new ModelService(settings, credentials);
    const router = new ModelRouter(settings);
    const repository = new TaskRepository(db.connection);
    tasks = new TaskService(repository, { now: () => new Date().toISOString(), random: Math.random, id: randomUUID });
    service = new TransformationService({ db: db.connection, tasks, taskRepository: repository, transformations: new TransformationRepository(db.connection), notes: new NoteRepository(db.connection), router, podcasts: new PodcastService(db.connection, credentials), generation: new RoutedGeneration({ db: db.connection, router, providerFactory: (profile) => new OpenAiCompatibleProvider({ baseUrl: profile.baseUrl, apiKey: "test-key" }) }) });
    db.connection.prepare("INSERT INTO projects(id,name) VALUES (?, 'Podcast test')").run(projectId);
    new NoteRepository(db.connection).create({ id: noteId, projectId, title: "Research", body: "The source reports a finding." });
    failSpeech = false; controller = undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/audio/speech")) {
        if (failSpeech) return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
        controller?.abort();
        return new Response(new Uint8Array(pcmWave(Buffer.from([1, 0, 2, 0]))));
      }
      expect(body.model).toBe("writer");
      const content = body.messages[0].content === "ping" ? "pong" : script;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }));
    expect((await models.saveProfile({ profile: { ...base, id: textId, modelId: "writer" }, apiKey: "test-key" })).ok).toBe(true);
    expect((await models.saveProfile({ profile: { ...base, id: speechId, modelId: "arbitrary-name", outputKind: "speech" }, apiKey: "test-key" })).ok).toBe(true);
    expect((await models.saveRoutes({ taskKind: "podcast", profileIds: [speechId, textId] })).ok).toBe(true);
  });
  afterEach(() => { db.close(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

  it("routes both model kinds, saves playable audio, restores it and deletes it with the insight", async () => {
    const progress = vi.spyOn(tasks, "advance");
    const result = await service.run({ projectId, noteId, builtinKey: "podcast", language: "en" });
    expect(result.content).toContain("**B**: The source reports a finding.");
    expect(service.listInsights({ projectId })[0]).toMatchObject({ id: result.id, hasAudio: true, builtinKey: "podcast" });
    const audio = service.getAudio({ projectId, insightId: result.id });
    expect(Buffer.from(audio.data, "base64").toString("ascii", 0, 4)).toBe("RIFF");
    expect(() => service.getAudio({ projectId: noteId, insightId: result.id })).toThrow("Transformation insight not found");
    expect(db.connection.prepare("SELECT state FROM model_route_attempts WHERE operation_id=? ORDER BY attempt_order").all(result.taskId)).toEqual([{ state: "completed" }, { state: "completed" }]);
    expect(tasks.getById(result.taskId!)?.state).toBe("completed");
    expect(tasks.getById(result.taskId!)?.transformationKind).toBe("podcast");
    expect(progress.mock.calls.filter(([, , value]) => value >= 450).map(([, stage, value]) => [stage, value])).toEqual([
      ["generating", 450], ["generating", 616], ["generating", 783], ["generating", 950], ["saving", 980]
    ]);
    db.close();
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    expect((db.connection.prepare("SELECT wav FROM podcast_audio WHERE insight_id=?").get(result.id) as { wav: Buffer }).wav.toString("base64")).toBe(audio.data);
    db.connection.prepare("DELETE FROM insights WHERE id=?").run(result.id);
    expect(db.connection.prepare("SELECT count(*) AS count FROM podcast_audio").get()).toEqual({ count: 0 });
  });

  it("rejects an incomplete podcast route and a speech model in a text route", async () => {
    expect(await models.saveRoutes({ taskKind: "podcast", profileIds: [textId] })).toMatchObject({ ok: false, error: { messageKey: "errors.podcastRouteMissing" } });
    expect((await models.saveRoutes({ taskKind: "chat", profileIds: [speechId] })).ok).toBe(false);
    expect(settings.getRoute("podcast").map((route) => route.profileId)).toEqual([speechId, textId]);
  });

  it("rotates text and speech credentials without network probes or losing model limits", async () => {
    const limits = { contextWindowTokens: 65_536, maxOutputTokens: 8_192, windowKind: "shared" as const, source: "provider" as const, observedAt: new Date().toISOString(), identity: { provider: base.provider, baseUrl: base.baseUrl, modelId: "writer" } };
    settings.updateGenerationLimits(textId, limits);
    const fetch = vi.fn(() => { throw new Error("Credential rotation must not contact a provider"); });
    vi.stubGlobal("fetch", fetch);
    for (const profile of [{ ...base, id: textId, modelId: "writer" }, { ...base, id: speechId, modelId: "arbitrary-name", outputKind: "speech" as const }]) {
      expect((await models.saveProfile({ profile, apiKey: "rotated-test-key" })).ok).toBe(true);
      expect((db.connection.prepare("SELECT encrypted_secret FROM credentials WHERE profile_id=?").get(profile.id) as { encrypted_secret: Buffer }).encrypted_secret.toString()).toBe("rotated-test-key");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(settings.getProfile(textId)?.generationLimits).toEqual(limits);
    expect(settings.getRoute("podcast").map((route) => route.profileId)).toEqual([speechId, textId]);
  });

  it("fails without saving a text-only result, then retries the same durable task", async () => {
    failSpeech = true;
    await expect(service.run({ projectId, noteId, builtinKey: "podcast", language: "en" })).rejects.toThrow();
    expect(service.listInsights({ projectId })).toEqual([]);
    const task = db.connection.prepare("SELECT id,state FROM tasks").get() as { id: string; state: string };
    expect(task.state).toBe("failed");
    failSpeech = false;
    const result = await service.resume(task.id);
    expect(result.taskId).toBe(task.id);
    expect(service.getAudio({ projectId, insightId: result.id }).data).not.toBe("");
  });

  it("cancels during synthesis without saving partial audio or a completed insight", async () => {
    controller = new AbortController();
    await expect(service.run({ projectId, noteId, builtinKey: "podcast", language: "en", signal: controller.signal })).rejects.toThrow("errors.cancelled");
    expect(service.listInsights({ projectId })).toEqual([]);
    expect(db.connection.prepare("SELECT state FROM tasks").get()).toEqual({ state: "cancelled" });
    expect(db.connection.prepare("SELECT count(*) AS count FROM podcast_audio").get()).toEqual({ count: 0 });
  });

  it("falls back after partially synthesizing without regressing task progress", async () => {
    const backupId = "55555555-5555-4555-8555-555555555555";
    expect((await models.saveProfile({ profile: { ...base, id: backupId, modelId: "backup-tts", outputKind: "speech" }, apiKey: "test-key" })).ok).toBe(true);
    expect((await models.saveRoutes({ taskKind: "podcast", profileIds: [speechId, textId, backupId] })).ok).toBe(true);
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(url).endsWith("/audio/speech") && body.model === "arbitrary-name" && body.input.startsWith("Thanks")) return new Response("Unavailable", { status: 503 });
      return original(url, init);
    }));
    const result = await service.run({ projectId, noteId, builtinKey: "podcast", language: "en" });
    expect(tasks.getById(result.taskId!)?.state).toBe("completed");
    expect(settings.listRouteAttempts({ projectId, taskKind: "podcast" })).toMatchObject([{ model: "backup-tts", state: "completed" }]);
    expect(db.connection.prepare("SELECT state FROM model_route_attempts WHERE operation_id=? ORDER BY attempt_order").all(result.taskId)).toEqual([{ state: "completed" }, { state: "failed" }, { state: "completed" }]);
  });

  it("upgrades version 16 while preserving profiles, routes and attempt history", () => {
    const migrationDir = path.join(root, "old-migrations"), oldPath = path.join(root, "old.db");
    mkdirSync(migrationDir);
    for (const file of readdirSync(path.resolve("src/main/db/migrations")).filter((file) => Number(file.slice(0, 3)) <= 16)) copyFileSync(path.resolve("src/main/db/migrations", file), path.join(migrationDir, file));
    const old = openAppDatabase(oldPath, migrationDir);
    old.connection.prepare("INSERT INTO projects(id,name) VALUES (?, 'Existing')").run(projectId);
    const oldSettings = new SettingsRepository(old.connection);
    oldSettings.saveProfile({ ...base, id: textId, modelId: "writer" });
    oldSettings.replaceRoute("chat", [textId]);
    old.connection.prepare("INSERT INTO model_route_attempts(id,project_id,operation_id,task_kind,attempt_order,profile_id,provider,model,state,is_fallback) VALUES (?,?,'old','chat',0,?,'openai-compatible','writer','completed',1)").run(speechId, projectId, textId);
    old.close();
    const upgraded = openAppDatabase(oldPath, path.resolve("src/main/db/migrations"));
    try {
      expect(new SettingsRepository(upgraded.connection).getRoute("chat")[0]?.profileId).toBe(textId);
      expect(upgraded.connection.prepare("SELECT state,is_fallback FROM model_route_attempts").get()).toEqual({ state: "completed", is_fallback: 1 });
      expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
    } finally { upgraded.close(); }
  });
});
