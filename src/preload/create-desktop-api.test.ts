import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  PROJECT_CHANNELS,
  SETTINGS_CHANNELS,
  RETRIEVAL_CHANNELS,
  CHAT_CHANNELS,
  CITATION_CHANNELS,
  VECTOR_CHANNELS,
  type DesktopApi
} from "../shared/ipc";
import { createDesktopApi } from "./create-desktop-api";

const project = {
  id: "6db5e7a1-6f22-4a0d-afdf-6a6e4b8df44d",
  name: "Research",
  archived: false,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
};

const projectId = { id: project.id };
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Primary",
  provider: "openai" as const,
  capability: "generation" as const,
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-test",
  enabled: true
};
const profileDto = {
  ...profile,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z"
};
const credentialStatus = { profileId: profile.id, hasCredential: true, mask: "••••••••" };
const routeInput = {
  generationProfileId: profile.id,
  embeddingProfileId: "00000000-0000-4000-8000-000000000001"
};

function ok<T>(value: T) {
  return { ok: true as const, value };
}

const validationFailure = {
  ok: false as const,
  error: { code: "VALIDATION" as const, messageKey: "errors.validation", recoverable: false }
};
const internalFailure = {
  ok: false as const,
  error: { code: "INTERNAL" as const, messageKey: "errors.internal", recoverable: false }
};

describe("createDesktopApi", () => {
  it("preserves project commands while exposing only the named model settings groups", () => {
    const api = createDesktopApi({ invoke: vi.fn() });

    expect(Object.keys(api)).toEqual(["vector", "retrieval", "sources", "tasks", "projects", "settings", "models", "credentials", "titleOverlay", "conversations", "chat", "citations", "notes", "transformations"]);
    expect(Object.keys(api.vector)).toEqual(["getHealth", "startMigration", "rebuild", "optimize", "cancelTask", "subscribe"]);
    expect(Object.keys(api.retrieval)).toEqual(["search"]);
    expect(Object.keys(api.projects)).toEqual(["list", "create", "rename", "archive", "remove"]);
    expect(Object.keys(api.settings)).toEqual(["get", "update"]);
    expect(Object.keys(api.models)).toEqual([
      "listProfiles",
      "getDefaultRoutes",
      "setDefaultRoutes",
      "saveProfile",
      "deleteProfile",
      "discover",
      "test",
      "getRoutes",
      "saveRoutes",
      "listRouteAttempts"
    ]);
    expect(Object.keys(api.credentials)).toEqual(["set", "remove"]);
    expect(Object.keys((api as unknown as { titleOverlay: object }).titleOverlay)).toEqual(["setTheme"]);
  });

  it("routes vector lifecycle and retrieval calls through validated channels", async () => {
    const health = { spaceId: "11111111-1111-4111-8111-111111111111", healthy: true, indexedCount: 2 };
    const task = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, sourceId: null, kind: "optimize" as const, state: "completed" as const, stage: "finalizing" as const, progress: 1000, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" };
    const invoke = vi.fn()
      .mockResolvedValueOnce(ok(health)).mockResolvedValueOnce(ok(task)).mockResolvedValueOnce(ok(task))
      .mockResolvedValueOnce(ok(task)).mockResolvedValueOnce(ok(task)).mockResolvedValueOnce(ok([{ chunkId: task.id, score: 1, text: "hit", locator: {} }]));
    const api = createDesktopApi({ invoke });
    await api.vector.getHealth({ projectId: project.id });
    await api.vector.startMigration({ projectId: project.id, profileId: profile.id });
    await api.vector.rebuild({ projectId: project.id, spaceId: health.spaceId });
    await api.vector.optimize({ projectId: project.id, spaceId: health.spaceId });
    await api.vector.cancelTask({ projectId: project.id, taskId: task.id });
    await api.retrieval.search({ projectId: project.id, query: "hello", limit: 12 });
    expect(invoke).toHaveBeenNthCalledWith(1, VECTOR_CHANNELS.getHealth, { projectId: project.id });
    expect(invoke).toHaveBeenNthCalledWith(2, VECTOR_CHANNELS.startMigration, { projectId: project.id, profileId: profile.id });
    expect(invoke).toHaveBeenNthCalledWith(6, RETRIEVAL_CHANNELS.search, { projectId: project.id, query: "hello", limit: 12 });
  });

  it("rejects vector raw inputs and malformed results before/after IPC", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { nope: true } });
    const api = createDesktopApi({ invoke });
    await expect(api.vector.rebuild({ projectId: project.id, spaceId: "not-a-uuid" } as never)).resolves.toEqual(validationFailure);
    await expect(api.retrieval.search({ projectId: project.id, query: "x", limit: 1, filter: "x" } as never)).resolves.toEqual(validationFailure);
    await expect(api.vector.getHealth({ projectId: project.id })).resolves.toEqual(internalFailure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("validates and cleans up vector task progress subscriptions", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const api = createDesktopApi({ invoke: vi.fn(), on, removeListener });
    const listener = vi.fn();
    const cleanup = api.vector.subscribe(project.id, listener);
    const registered = on.mock.calls[0]?.[1] as (_event: unknown, value: unknown) => void;
    const task = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, sourceId: null, kind: "optimize" as const, state: "running" as const, stage: "indexing" as const, progress: 10, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" };
    registered({}, task);
    registered({}, { ...task, progress: -1 });
    expect(listener).toHaveBeenCalledExactlyOnceWith(task);
    cleanup();
    expect(on).toHaveBeenCalledWith("tasks:v1:update:" + project.id, expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("tasks:v1:update:" + project.id, registered);
  });

  it("does not deliver a valid task from another project", () => {
    const on = vi.fn();
    const listener = vi.fn();
    const api = createDesktopApi({ invoke: vi.fn(), on });
    api.vector.subscribe(project.id, listener);
    const registered = on.mock.calls[0]?.[1] as (_event: unknown, value: unknown) => void;
    const task = { id: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333", sourceId: null, kind: "optimize" as const, state: "running" as const, stage: "indexing" as const, progress: 10, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" };
    registered({}, task);
    expect(listener).not.toHaveBeenCalled();
  });

  it("validates and routes title-overlay theme updates through a versioned result boundary", async () => {
    const invoke = vi.fn().mockResolvedValue(ok(undefined));
    const api = createDesktopApi({ invoke });
    const titleOverlay = (api as unknown as {
      titleOverlay?: { setTheme(input: unknown): Promise<unknown> };
    }).titleOverlay;

    await expect(titleOverlay?.setTheme({ theme: "dark" }) ?? Promise.resolve(undefined)).resolves.toEqual(ok(undefined));
    await expect(titleOverlay?.setTheme({ theme: "neon" }) ?? Promise.resolve(undefined)).resolves.toEqual(validationFailure);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("window:v1:set-title-overlay", { theme: "dark" });
  });

  it("routes all model settings commands through versioned channels", async () => {
    const settings = { onboardingCompleted: false, locale: "zh-CN" as const, theme: "light" as const };
    const profileList = {
      profiles: [profileDto],
      builtInProfiles: [],
      credentials: [credentialStatus]
    };
    const descriptors = [{
      id: "gpt-test",
      displayName: "GPT Test",
      capabilities: ["generation" as const],
      capabilityEvidence: "authoritative" as const
    }];
    const invoke = vi.fn()
      .mockResolvedValueOnce(ok(settings))
      .mockResolvedValueOnce(ok({ ...settings, theme: "dark" as const }))
      .mockResolvedValueOnce(ok(profileList))
      .mockResolvedValueOnce(ok({ generationProfileId: profile.id }))
      .mockResolvedValueOnce(ok({ generationProfileId: profile.id }))
      .mockResolvedValueOnce(ok(profileDto))
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(ok(descriptors))
      .mockResolvedValueOnce(ok({
        modelId: profile.modelId,
        capability: profile.capability,
        verifiedBy: "discovery" as const
      }))
      .mockResolvedValueOnce(ok(credentialStatus))
      .mockResolvedValueOnce(ok({ profileId: profile.id, hasCredential: false }));
    const api = createDesktopApi({ invoke });
    const discoveryInput = {
      profileId: profile.id,
      provider: profile.provider,
      capability: profile.capability,
      baseUrl: profile.baseUrl
    };

    await api.settings.get();
    await api.settings.update({ theme: "dark" });
    await api.models.listProfiles();
    await api.models.getDefaultRoutes();
    await api.models.setDefaultRoutes(routeInput);
    await api.models.saveProfile({ profile, apiKey: "secret" });
    await api.models.deleteProfile({ id: profile.id });
    await api.models.discover(discoveryInput);
    await api.models.test({ profile });
    await api.credentials.set({ profileId: profile.id, apiKey: "secret" });
    await api.credentials.remove({ profileId: profile.id });

    expect(invoke).toHaveBeenNthCalledWith(1, SETTINGS_CHANNELS.get);
    expect(invoke).toHaveBeenNthCalledWith(2, SETTINGS_CHANNELS.update, { theme: "dark" });
    expect(invoke).toHaveBeenNthCalledWith(3, MODEL_CHANNELS.listProfiles);
    expect(invoke).toHaveBeenNthCalledWith(4, MODEL_CHANNELS.getDefaultRoutes);
    expect(invoke).toHaveBeenNthCalledWith(5, MODEL_CHANNELS.setDefaultRoutes, routeInput);
    expect(invoke).toHaveBeenNthCalledWith(6, MODEL_CHANNELS.saveProfile, { profile, apiKey: "secret" });
    expect(invoke).toHaveBeenNthCalledWith(7, MODEL_CHANNELS.deleteProfile, { id: profile.id });
    expect(invoke).toHaveBeenNthCalledWith(8, MODEL_CHANNELS.discover, discoveryInput);
    expect(invoke).toHaveBeenNthCalledWith(9, MODEL_CHANNELS.test, { profile });
    expect(invoke).toHaveBeenNthCalledWith(10, CREDENTIAL_CHANNELS.set, {
      profileId: profile.id,
      apiKey: "secret"
    });
    expect(invoke).toHaveBeenNthCalledWith(11, CREDENTIAL_CHANNELS.remove, {
      profileId: profile.id
    });
  });

  it.each([
    ["settings update", (api: DesktopApi) => api.settings.update({} as never)],
    ["profile save", (api: DesktopApi) => api.models.saveProfile({ profile: { ...profile, name: "" } })],
    ["default route", (api: DesktopApi) => api.models.setDefaultRoutes({
      ...routeInput,
      generationProfileId: "not-a-uuid"
    })],
    ["oversized profile address", (api: DesktopApi) => api.models.saveProfile({
      profile: { ...profile, baseUrl: `https://${"a".repeat(2_049)}.test` }
    })],
    ["profile delete", (api: DesktopApi) => api.models.deleteProfile({ id: "not-a-uuid" })],
    ["discovery", (api: DesktopApi) => api.models.discover({
      provider: "openai",
      capability: "generation",
      baseUrl: "http://localhost:1234"
    })],
    ["model test", (api: DesktopApi) => api.models.test({ profile: { ...profile, modelId: "" } })],
    ["credential set", (api: DesktopApi) => api.credentials.set({ profileId: profile.id, apiKey: " " })],
    ["credential remove", (api: DesktopApi) => api.credentials.remove({ profileId: "not-a-uuid" })]
  ])("returns sanitized validation for invalid %s input before IPC", async (_command, call) => {
    const invoke = vi.fn();

    await expect(call(createDesktopApi({ invoke }))).resolves.toEqual(validationFailure);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["settings get", (api: DesktopApi) => api.settings.get()],
    ["settings update", (api: DesktopApi) => api.settings.update({ theme: "dark" })],
    ["profile list", (api: DesktopApi) => api.models.listProfiles()],
    ["default routes", (api: DesktopApi) => api.models.getDefaultRoutes()],
    ["default route update", (api: DesktopApi) => api.models.setDefaultRoutes(routeInput)],
    ["profile save", (api: DesktopApi) => api.models.saveProfile({ profile })],
    ["profile delete", (api: DesktopApi) => api.models.deleteProfile({ id: profile.id })],
    ["discovery", (api: DesktopApi) => api.models.discover({
      provider: profile.provider,
      capability: profile.capability,
      baseUrl: profile.baseUrl
    })],
    ["model test", (api: DesktopApi) => api.models.test({ profile })],
    ["credential set", (api: DesktopApi) => api.credentials.set({ profileId: profile.id, apiKey: "secret" })],
    ["credential remove", (api: DesktopApi) => api.credentials.remove({ profileId: profile.id })]
  ])("returns sanitized internal failure for malformed %s IPC results", async (_command, call) => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { unexpected: true } });

    await expect(call(createDesktopApi({ invoke }))).resolves.toEqual(internalFailure);
  });

  it("sanitizes an unexpected model IPC rejection", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("raw secret-bearing failure"));
    const api = createDesktopApi({ invoke });

    const result = await api.models.discover({
      provider: profile.provider,
      capability: profile.capability,
      baseUrl: profile.baseUrl
    });

    expect(result).toEqual(internalFailure);
    expect(JSON.stringify(result)).not.toContain("raw secret-bearing failure");
  });

  it("accepts a strictly validated application error result", async () => {
    const failure = {
      ok: false as const,
      error: { code: "AUTH" as const, messageKey: "errors.authentication", recoverable: false }
    };
    const api = createDesktopApi({ invoke: vi.fn().mockResolvedValue(failure) });

    await expect(api.models.discover({
      provider: profile.provider,
      capability: profile.capability,
      baseUrl: profile.baseUrl
    })).resolves.toEqual(failure);
  });

  it("routes every project command through its selected channel", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(undefined);
    const api = createDesktopApi({ invoke });

    await api.projects.list();
    await api.projects.create({ name: "Notebook" });
    await api.projects.rename({ ...projectId, name: "Renamed" });
    await api.projects.archive(projectId);
    await expect(api.projects.remove(projectId)).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, PROJECT_CHANNELS.list);
    expect(invoke).toHaveBeenNthCalledWith(2, PROJECT_CHANNELS.create, { name: "Notebook" });
    expect(invoke).toHaveBeenNthCalledWith(3, PROJECT_CHANNELS.rename, { ...projectId, name: "Renamed" });
    expect(invoke).toHaveBeenNthCalledWith(4, PROJECT_CHANNELS.archive, projectId);
    expect(invoke).toHaveBeenNthCalledWith(5, PROJECT_CHANNELS.remove, projectId);
  });

  it.each([
    ["create", (api: DesktopApi) => api.projects.create({ name: " " })],
    ["rename", (api: DesktopApi) => api.projects.rename({ ...projectId, name: " " })],
    ["archive", (api: DesktopApi) => api.projects.archive({ id: "not-a-uuid" })],
    ["remove", (api: DesktopApi) => api.projects.remove({ id: "not-a-uuid" })]
  ])("rejects invalid %s input before invoking IPC", async (_command, call) => {
    const invoke = vi.fn();

    await expect(call(createDesktopApi({ invoke }))).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["list", (api: DesktopApi) => api.projects.list()],
    ["create", (api: DesktopApi) => api.projects.create({ name: "Notebook" })],
    ["rename", (api: DesktopApi) => api.projects.rename({ ...projectId, name: "Renamed" })],
    ["archive", (api: DesktopApi) => api.projects.archive(projectId)],
    ["remove", (api: DesktopApi) => api.projects.remove(projectId)]
  ])("rejects malformed %s IPC output", async (_command, call) => {
    const invoke = vi.fn().mockResolvedValue({});

    await expect(call(createDesktopApi({ invoke }))).rejects.toThrow();
  });

  const chatProjectId = "11111111-1111-4111-8111-111111111111";
  const chatConversationId = "33333333-3333-4333-8333-333333333333";
  const chatRequestId = "22222222-2222-4222-8222-222222222222";

  it("routes conversation/chat/citation commands through versioned channels", async () => {
    const conversation = { id: chatConversationId, projectId: chatProjectId, title: "Chat", createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", deletedAt: null, archivedAt: null };
    const streamValue = { requestId: chatRequestId, assistantMessageId: "assistant-1" };
    const invoke = vi.fn()
      .mockResolvedValueOnce(ok([conversation]))
      .mockResolvedValueOnce(ok(conversation))
      .mockResolvedValueOnce(ok(conversation))
      .mockResolvedValueOnce(ok(conversation))
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok(streamValue))
      .mockResolvedValueOnce(ok(true))
      .mockResolvedValueOnce(ok(streamValue))
      .mockResolvedValueOnce(ok({ opened: "document" }));
    const api = createDesktopApi({ invoke });

    await api.conversations.list({ projectId: chatProjectId });
    await api.conversations.create({ projectId: chatProjectId, title: "Chat" });
    await api.conversations.rename({ projectId: chatProjectId, conversationId: chatConversationId, title: "Renamed" });
    await api.conversations.archive({ projectId: chatProjectId, conversationId: chatConversationId });
    await api.conversations.delete({ projectId: chatProjectId, conversationId: chatConversationId });
    await api.conversations.listMessages({ projectId: chatProjectId, conversationId: chatConversationId });
    await api.chat.send({ requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, question: "Hi" });
    await api.chat.stop({ projectId: chatProjectId, requestId: chatRequestId });
    await api.chat.regenerate({ requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, messageId: "assistant-1" });
    await api.citations.open({ projectId: chatProjectId, citationId: "assistant-1:S1:0" });

    expect(invoke).toHaveBeenNthCalledWith(1, CHAT_CHANNELS.listConversations, { projectId: chatProjectId });
    expect(invoke).toHaveBeenNthCalledWith(7, CHAT_CHANNELS.send, { requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, question: "Hi" });
    expect(invoke).toHaveBeenNthCalledWith(8, CHAT_CHANNELS.stop, { projectId: chatProjectId, requestId: chatRequestId });
    expect(invoke).toHaveBeenNthCalledWith(9, CHAT_CHANNELS.regenerate, { requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, messageId: "assistant-1" });
    expect(invoke).toHaveBeenNthCalledWith(10, CITATION_CHANNELS.open, { projectId: chatProjectId, citationId: "assistant-1:S1:0" });
  });

  it.each([
    ["conversation create", (api: DesktopApi) => api.conversations.create({ projectId: chatProjectId, title: " " })],
    ["chat send", (api: DesktopApi) => api.chat.send({ requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, question: "" })],
    ["chat stop", (api: DesktopApi) => api.chat.stop({ projectId: chatProjectId, requestId: "garbage" })],
    ["citation open", (api: DesktopApi) => api.citations.open({ projectId: chatProjectId, citationId: " " })]
  ])("returns sanitized validation for invalid %s input before IPC", async (_command, call) => {
    const invoke = vi.fn();

    await expect(call(createDesktopApi({ invoke }))).resolves.toEqual(validationFailure);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns sanitized internal failure for malformed chat IPC results", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { unexpected: true } });

    await expect(createDesktopApi({ invoke }).chat.send({
      projectId: chatProjectId,
      conversationId: chatConversationId,
      requestId: chatRequestId,
      question: "Hi"
    })).resolves.toEqual(internalFailure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("validates and cleans up per-request chat subscriptions", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const listener = vi.fn();
    const api = createDesktopApi({ invoke: vi.fn(), on, removeListener });

    // Invalid request IDs never register a channel listener.
    api.chat.subscribe("not-a-uuid", listener);
    expect(on).not.toHaveBeenCalled();

    const cleanup = api.chat.subscribe(chatRequestId, listener);
    const channel = CHAT_CHANNELS.update + ":" + chatRequestId;
    const registered = on.mock.calls[0]?.[0] === channel ? on.mock.calls[0]?.[1] as (_e: unknown, raw: unknown) => void : undefined;
    registered?.({}, { type: "started", requestId: chatRequestId, messageId: "assistant-1" });
    // A forged requestId or malformed payload is dropped in the renderer too.
    registered?.({}, { type: "started", requestId: "44444444-4444-4444-8444-444444444444", messageId: "x" });
    registered?.({}, { type: "nonsense", requestId: chatRequestId });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "started", requestId: chatRequestId, messageId: "assistant-1" });

    cleanup();
    expect(removeListener).toHaveBeenCalledWith(channel, registered);
  });

  it("registers the renderer with the main process on subscribe and deregisters on cleanup", () => {
    const invoke = vi.fn().mockResolvedValue(ok(undefined));
    const on = vi.fn();
    const removeListener = vi.fn();
    const api = createDesktopApi({ invoke, on, removeListener });

    // Invalid request IDs never reach the main process either.
    api.chat.subscribe("not-a-uuid", vi.fn());
    expect(invoke).not.toHaveBeenCalled();

    api.chat.subscribe(chatRequestId, vi.fn());
    expect(invoke).toHaveBeenNthCalledWith(1, CHAT_CHANNELS.subscribeRequest, { requestId: chatRequestId });

    const cleanup = api.chat.subscribe(chatRequestId, vi.fn());
    invoke.mockClear();
    cleanup();
    expect(invoke).toHaveBeenNthCalledWith(1, CHAT_CHANNELS.unsubscribeRequest, { requestId: chatRequestId });
  });

  it("waits for subscribe registration before invoking send", async () => {
    let release!: (value: unknown) => void;
    const registration = new Promise<unknown>((resolve) => { release = resolve; });
    const invoke = vi.fn((channel: string) => channel === CHAT_CHANNELS.subscribeRequest
      ? registration
      : Promise.resolve(ok({ requestId: chatRequestId, assistantMessageId: "assistant-1" })));
    const api = createDesktopApi({ invoke, on: vi.fn(), removeListener: vi.fn() });
    api.chat.subscribe(chatRequestId, vi.fn());
    const send = api.chat.send({ requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, question: "Hi" });
    expect(invoke).toHaveBeenNthCalledWith(1, CHAT_CHANNELS.subscribeRequest, { requestId: chatRequestId });
    expect(invoke).toHaveBeenCalledTimes(1);
    release(ok(undefined));
    await send;
    expect(invoke).toHaveBeenNthCalledWith(2, CHAT_CHANNELS.send, { requestId: chatRequestId, projectId: chatProjectId, conversationId: chatConversationId, question: "Hi" });
  });

  it("routes notes, transformation tasks and ordered model routes through validated IPC", async () => {
    const note = { id: "44444444-4444-4444-8444-444444444444", projectId: project.id, title: "N", body: "B", version: 1, archivedAt: null, deletedAt: null, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" };
    const task = { id: "55555555-5555-4555-8555-555555555555", projectId: project.id, sourceId: null, kind: "transformation" as const, state: "queued" as const, stage: "preparing" as const, progress: 0, attempt: 0, error: null, idempotencyKey: null, createdAt: note.createdAt, updatedAt: note.updatedAt };
    const route = { taskKind: "summary" as const, position: 0, profileId: profile.id };
    const invoke = vi.fn().mockResolvedValue(ok(note));
    const api = createDesktopApi({ invoke });
    await api.notes?.create({ projectId: project.id, title: "N", body: "B" });
    invoke.mockResolvedValueOnce(ok(task));
    await api.transformations?.run({ projectId: project.id, builtinKey: "summary", language: "en", sourceRevisionId: note.id });
    invoke.mockResolvedValueOnce(ok([route]));
    await api.models.getRoutes?.({ taskKind: "summary" });
    expect(invoke).toHaveBeenNthCalledWith(1, "notes:v1:create", { projectId: project.id, title: "N", body: "B" });
    expect(invoke).toHaveBeenNthCalledWith(2, "transformations:v1:run", { projectId: project.id, builtinKey: "summary", language: "en", sourceRevisionId: note.id });
    expect(invoke).toHaveBeenNthCalledWith(3, "models:v1:get-routes", { taskKind: "summary" });
  });

  it("returns safe validation/internal failures for new API boundaries", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { leaked: true } });
    const api = createDesktopApi({ invoke });
    await expect(api.notes?.update({ projectId: project.id, id: "not-uuid", title: "N", body: "B", version: 1 } as never)).resolves.toEqual(validationFailure);
    await expect(api.transformations?.run({ projectId: project.id, builtinKey: "summary", language: "en", sourceRevisionId: project.id, state: "completed" } as never)).resolves.toEqual(validationFailure);
    await expect(api.models.listRouteAttempts?.({ projectId: project.id })).resolves.toEqual(internalFailure);
  });

  it("filters task subscriptions by the requested project and unregisters listeners", () => {
    const on = vi.fn(); const removeListener = vi.fn(); const listener = vi.fn();
    const api = createDesktopApi({ invoke: vi.fn(), on, removeListener });
    const cleanup = api.tasks?.subscribe(project.id, listener);
    const handler = on.mock.calls[0]?.[1] as (_e: unknown, raw: unknown) => void;
    const task = { id: "55555555-5555-4555-8555-555555555555", projectId: project.id, sourceId: null, kind: "transformation" as const, state: "queued" as const, stage: "preparing" as const, progress: 0, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" };
    handler({}, task); handler({}, { ...task, projectId: chatProjectId }); cleanup?.();
    expect(listener).toHaveBeenCalledExactlyOnceWith(task);
    expect(removeListener).toHaveBeenCalledWith("tasks:v1:update:" + project.id, handler);
  });
});
