import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  PROJECT_CHANNELS,
  SETTINGS_CHANNELS,
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

function ok<T>(value: T) {
  return { ok: true as const, value };
}

describe("createDesktopApi", () => {
  it("preserves project commands while exposing only the named model settings groups", () => {
    const api = createDesktopApi({ invoke: vi.fn() });

    expect(Object.keys(api)).toEqual(["projects", "settings", "models", "credentials"]);
    expect(Object.keys(api.projects)).toEqual(["list", "create", "rename", "archive", "remove"]);
    expect(Object.keys(api.settings)).toEqual(["get", "update"]);
    expect(Object.keys(api.models)).toEqual([
      "listProfiles",
      "saveProfile",
      "deleteProfile",
      "discover",
      "test"
    ]);
    expect(Object.keys(api.credentials)).toEqual(["set", "remove"]);
  });

  it("routes all model settings commands through versioned channels", async () => {
    const settings = { onboardingCompleted: false, locale: "zh-CN" as const, theme: "light" as const };
    const profileList = {
      profiles: [profileDto],
      builtInProfiles: [],
      credentials: [credentialStatus]
    };
    const descriptors = [{ id: "gpt-test", displayName: "GPT Test", capabilities: ["generation" as const] }];
    const invoke = vi.fn()
      .mockResolvedValueOnce(ok(settings))
      .mockResolvedValueOnce(ok({ ...settings, theme: "dark" as const }))
      .mockResolvedValueOnce(ok(profileList))
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
    await api.models.saveProfile({ profile, apiKey: "secret" });
    await api.models.deleteProfile({ id: profile.id });
    await api.models.discover(discoveryInput);
    await api.models.test({ profile });
    await api.credentials.set({ profileId: profile.id, apiKey: "secret" });
    await api.credentials.remove({ profileId: profile.id });

    expect(invoke).toHaveBeenNthCalledWith(1, SETTINGS_CHANNELS.get);
    expect(invoke).toHaveBeenNthCalledWith(2, SETTINGS_CHANNELS.update, { theme: "dark" });
    expect(invoke).toHaveBeenNthCalledWith(3, MODEL_CHANNELS.listProfiles);
    expect(invoke).toHaveBeenNthCalledWith(4, MODEL_CHANNELS.saveProfile, { profile, apiKey: "secret" });
    expect(invoke).toHaveBeenNthCalledWith(5, MODEL_CHANNELS.deleteProfile, { id: profile.id });
    expect(invoke).toHaveBeenNthCalledWith(6, MODEL_CHANNELS.discover, discoveryInput);
    expect(invoke).toHaveBeenNthCalledWith(7, MODEL_CHANNELS.test, { profile });
    expect(invoke).toHaveBeenNthCalledWith(8, CREDENTIAL_CHANNELS.set, {
      profileId: profile.id,
      apiKey: "secret"
    });
    expect(invoke).toHaveBeenNthCalledWith(9, CREDENTIAL_CHANNELS.remove, {
      profileId: profile.id
    });
  });

  it.each([
    ["settings update", (api: DesktopApi) => api.settings.update({} as never)],
    ["profile save", (api: DesktopApi) => api.models.saveProfile({ profile: { ...profile, name: "" } })],
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
  ])("rejects invalid %s input before IPC", async (_command, call) => {
    const invoke = vi.fn();

    await expect(call(createDesktopApi({ invoke }))).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["settings get", (api: DesktopApi) => api.settings.get()],
    ["settings update", (api: DesktopApi) => api.settings.update({ theme: "dark" })],
    ["profile list", (api: DesktopApi) => api.models.listProfiles()],
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
  ])("rejects malformed %s IPC results", async (_command, call) => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { unexpected: true } });

    await expect(call(createDesktopApi({ invoke }))).rejects.toThrow();
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
});
