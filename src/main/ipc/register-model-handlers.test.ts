import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  SETTINGS_CHANNELS
} from "../../shared/ipc";
import type { ModelService } from "../models/model-service";
import { registerModelHandlers } from "./register-model-handlers";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-08-25T00:00:00.000Z";
const profile = {
  id: PROFILE_ID,
  name: "Primary",
  provider: "openai" as const,
  capability: "generation" as const,
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-test",
  enabled: true
};
const profileDto = { ...profile, createdAt: timestamp, updatedAt: timestamp };
const settings = { onboardingCompleted: false, locale: "zh-CN" as const, theme: "light" as const };
const credentialStatus = { profileId: PROFILE_ID, hasCredential: true, mask: "••••••••" };
const discoveryInput = {
  profileId: PROFILE_ID,
  provider: "openai" as const,
  capability: "generation" as const,
  baseUrl: profile.baseUrl
};
const descriptors = [{
  id: "gpt-test",
  displayName: "GPT Test",
  capabilities: ["generation" as const],
  capabilityEvidence: "authoritative" as const
}];
const routes = { generationProfileId: PROFILE_ID };
const validationFailure = {
  ok: false,
  error: { code: "VALIDATION", messageKey: "errors.validation", recoverable: false }
};
const internalFailure = {
  ok: false,
  error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: false }
};

type Handler = Parameters<IpcMain["handle"]>[1];

class FakeIpcMain implements Pick<IpcMain, "handle" | "removeHandler"> {
  readonly handlers = new Map<string, Handler>();
  readonly handled: string[] = [];
  readonly removed: string[] = [];

  handle(channel: string, listener: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
    this.handled.push(channel);
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.removed.push(channel);
    this.handlers.delete(channel);
  }
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function createService() {
  return {
    getSettings: vi.fn(async () => ok(settings)),
    updateSettings: vi.fn(async () => ok({ ...settings, theme: "dark" as const })),
    listProfiles: vi.fn(async () => ok({
      profiles: [profileDto],
      builtInProfiles: [],
      credentials: [credentialStatus]
    })),
    getDefaultRoutes: vi.fn(async () => ok(routes)),
    setDefaultRoute: vi.fn(async () => ok(routes)),
    saveProfile: vi.fn(async () => ok(profileDto)),
    deleteProfile: vi.fn(async () => ok(undefined)),
    discover: vi.fn(async () => ok(descriptors)),
    test: vi.fn(async () => ok({
      modelId: profile.modelId,
      capability: profile.capability,
      verifiedBy: "discovery" as const
    })),
    setCredential: vi.fn(async () => ok(credentialStatus)),
    removeCredential: vi.fn(async () => ok({
      profileId: PROFILE_ID,
      hasCredential: false
    }))
  };
}

async function invoke(ipc: FakeIpcMain, channel: string, input?: unknown): Promise<unknown> {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({} as never, input);
}

const channels = [
  ...Object.values(SETTINGS_CHANNELS),
  ...Object.values(MODEL_CHANNELS),
  ...Object.values(CREDENTIAL_CHANNELS)
];

describe("registerModelHandlers", () => {
  it("registers each versioned channel exactly once", () => {
    const ipc = new FakeIpcMain();

    registerModelHandlers(ipc, createService() as unknown as ModelService);

    expect(ipc.handled.sort()).toEqual([...channels].sort());
    expect(new Set(ipc.handled).size).toBe(channels.length);
    expect(channels.every((channel) => channel.includes(":v1:"))).toBe(true);
  });

  it("routes every valid call to the selected service method", async () => {
    const ipc = new FakeIpcMain();
    const service = createService();
    registerModelHandlers(ipc, service as unknown as ModelService);

    await invoke(ipc, SETTINGS_CHANNELS.get);
    await invoke(ipc, SETTINGS_CHANNELS.update, { theme: "dark" });
    await invoke(ipc, MODEL_CHANNELS.listProfiles);
    await invoke(ipc, MODEL_CHANNELS.getDefaultRoutes);
    await invoke(ipc, MODEL_CHANNELS.setDefaultRoute, {
      capability: "generation",
      profileId: PROFILE_ID
    });
    await invoke(ipc, MODEL_CHANNELS.saveProfile, { profile, apiKey: "secret" });
    await invoke(ipc, MODEL_CHANNELS.deleteProfile, { id: PROFILE_ID });
    await invoke(ipc, MODEL_CHANNELS.discover, discoveryInput);
    await invoke(ipc, MODEL_CHANNELS.test, { profile });
    await invoke(ipc, CREDENTIAL_CHANNELS.set, { profileId: PROFILE_ID, apiKey: "secret" });
    await invoke(ipc, CREDENTIAL_CHANNELS.remove, { profileId: PROFILE_ID });

    expect(service.getSettings).toHaveBeenCalledWith();
    expect(service.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
    expect(service.listProfiles).toHaveBeenCalledWith();
    expect(service.getDefaultRoutes).toHaveBeenCalledWith();
    expect(service.setDefaultRoute).toHaveBeenCalledWith({
      capability: "generation",
      profileId: PROFILE_ID
    });
    expect(service.saveProfile).toHaveBeenCalledWith({ profile, apiKey: "secret" });
    expect(service.deleteProfile).toHaveBeenCalledWith({ id: PROFILE_ID });
    expect(service.discover).toHaveBeenCalledWith(discoveryInput);
    expect(service.test).toHaveBeenCalledWith({ profile });
    expect(service.setCredential).toHaveBeenCalledWith({ profileId: PROFILE_ID, apiKey: "secret" });
    expect(service.removeCredential).toHaveBeenCalledWith({ profileId: PROFILE_ID });
  });

  it.each([
    [SETTINGS_CHANNELS.get, {}, "getSettings"],
    [SETTINGS_CHANNELS.update, {}, "updateSettings"],
    [MODEL_CHANNELS.listProfiles, {}, "listProfiles"],
    [MODEL_CHANNELS.getDefaultRoutes, {}, "getDefaultRoutes"],
    [MODEL_CHANNELS.setDefaultRoute, { capability: "generation", profileId: "bad" }, "setDefaultRoute"],
    [MODEL_CHANNELS.saveProfile, { profile: { ...profile, name: "" } }, "saveProfile"],
    [MODEL_CHANNELS.deleteProfile, { id: "not-a-uuid" }, "deleteProfile"],
    [MODEL_CHANNELS.discover, { ...discoveryInput, baseUrl: "http://localhost:1234" }, "discover"],
    [MODEL_CHANNELS.test, { profile: { ...profile, modelId: "" } }, "test"],
    [CREDENTIAL_CHANNELS.set, { profileId: PROFILE_ID, apiKey: " " }, "setCredential"],
    [CREDENTIAL_CHANNELS.remove, { profileId: "not-a-uuid" }, "removeCredential"]
  ] as const)("returns sanitized validation on invalid %s input before service dispatch", async (channel, input, method) => {
    const ipc = new FakeIpcMain();
    const service = createService();
    registerModelHandlers(ipc, service as unknown as ModelService);

    await expect(invoke(ipc, channel, input)).resolves.toEqual(validationFailure);
    expect(service[method]).not.toHaveBeenCalled();
  });

  it.each([
    [SETTINGS_CHANNELS.get, undefined, "getSettings"],
    [SETTINGS_CHANNELS.update, { theme: "dark" }, "updateSettings"],
    [MODEL_CHANNELS.listProfiles, undefined, "listProfiles"],
    [MODEL_CHANNELS.getDefaultRoutes, undefined, "getDefaultRoutes"],
    [MODEL_CHANNELS.setDefaultRoute, { capability: "generation", profileId: PROFILE_ID }, "setDefaultRoute"],
    [MODEL_CHANNELS.saveProfile, { profile }, "saveProfile"],
    [MODEL_CHANNELS.deleteProfile, { id: PROFILE_ID }, "deleteProfile"],
    [MODEL_CHANNELS.discover, discoveryInput, "discover"],
    [MODEL_CHANNELS.test, { profile }, "test"],
    [CREDENTIAL_CHANNELS.set, { profileId: PROFILE_ID, apiKey: "secret" }, "setCredential"],
    [CREDENTIAL_CHANNELS.remove, { profileId: PROFILE_ID }, "removeCredential"]
  ] as const)("returns sanitized internal failure for malformed %s service output", async (channel, input, method) => {
    const ipc = new FakeIpcMain();
    const service = createService();
    service[method].mockResolvedValueOnce({ ok: true, value: { unexpected: true } } as never);
    registerModelHandlers(ipc, service as unknown as ModelService);

    await expect(invoke(ipc, channel, input)).resolves.toEqual(internalFailure);
  });

  it("sanitizes an unexpected service rejection", async () => {
    const ipc = new FakeIpcMain();
    const service = createService();
    service.discover.mockRejectedValueOnce(new Error("raw secret-bearing failure"));
    registerModelHandlers(ipc, service as unknown as ModelService);

    const result = await invoke(ipc, MODEL_CHANNELS.discover, discoveryInput);

    expect(result).toEqual(internalFailure);
    expect(JSON.stringify(result)).not.toContain("raw secret-bearing failure");
  });

  it("removes only its registered channels during teardown", () => {
    const ipc = new FakeIpcMain();
    const unrelated: Handler = vi.fn();
    ipc.handle("projects:list", unrelated);
    const cleanup = registerModelHandlers(ipc, createService() as unknown as ModelService);

    cleanup();

    expect(ipc.handlers.get("projects:list")).toBe(unrelated);
    expect(ipc.removed.sort()).toEqual([...channels].sort());
  });
});
