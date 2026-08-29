import { describe, expect, it, vi } from "vitest";
import type {
  AppSettingsDto,
  UpdateAppSettingsInput
} from "../../shared/settings";
import type {
  ModelRouteDto,
  ModelTaskKind,
  ModelProfileDto,
  ModelProfileInput,
  ProviderKind
} from "../../shared/models";
import type { CredentialStore } from "../credentials/credential-store";
import type { SettingsRepository } from "../settings/settings-repository";
import {
  BUILT_IN_LOCAL_EMBEDDING_PROFILE,
  BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
} from "./local-embedding-profile";
import {
  ModelService,
  createModelProvider,
  type ModelProviderFactory
} from "./model-service";
import { AnthropicProvider } from "./anthropic-provider";
import { GeminiProvider } from "./gemini-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenAiCompatibleProvider, OpenAiProvider } from "./openai-provider";
import { ProviderRequestError } from "./http-client";
import type { ModelDescriptor, ModelProvider } from "./provider";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE_ID = "22222222-2222-4222-8222-222222222222";

const profile: ModelProfileInput = {
  id: PROFILE_ID,
  name: "Primary",
  provider: "openai",
  capability: "generation",
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-test",
  enabled: true
};

function dto(input: ModelProfileInput): ModelProfileDto {
  return {
    ...input,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  };
}

class FakeSettingsRepository {
  settings: AppSettingsDto = {
    onboardingCompleted: false,
    locale: "zh-CN",
    theme: "light"
  };
  readonly profiles = new Map<string, ModelProfileDto>();
  readonly routes = new Map<ModelTaskKind, ModelRouteDto[]>();
  readonly events: string[] = [];

  transaction<T>(work: () => T): T {
    return work();
  }

  getSettings(): AppSettingsDto {
    return this.settings;
  }

  updateSettings(input: UpdateAppSettingsInput): AppSettingsDto {
    this.settings = {
      onboardingCompleted: input.onboardingCompleted ?? this.settings.onboardingCompleted,
      locale: input.locale ?? this.settings.locale,
      theme: input.theme ?? this.settings.theme
    };
    return this.settings;
  }

  listProfiles(): ModelProfileDto[] {
    return [...this.profiles.values()];
  }

  getProfile(id: string): ModelProfileDto | undefined {
    return this.profiles.get(id);
  }

  saveProfile(input: ModelProfileInput): ModelProfileDto {
    this.events.push("save-profile");
    const saved = dto(input);
    this.profiles.set(input.id, saved);
    return saved;
  }

  deleteProfile(id: string): void {
    this.events.push("delete-profile");
    this.profiles.delete(id);
  }

  getRoute(taskKind: ModelTaskKind): ModelRouteDto[] {
    return this.routes.get(taskKind) ?? [];
  }

  replaceRoute(taskKind: ModelTaskKind, profileIds: readonly string[]): ModelRouteDto[] {
    const routes = profileIds.map((profileId, position) => ({ taskKind, profileId, position }));
    this.routes.set(taskKind, routes);
    return routes;
  }

  replaceDefaultRoutes(generationProfileId: string, embeddingProfileId: string): void {
    for (const taskKind of [
      "chat",
      "note-title",
      "summary",
      "key-points",
      "qa",
      "custom-transformation"
    ] as const) {
      this.routes.set(taskKind, [{ taskKind, profileId: generationProfileId, position: 0 }]);
    }
    this.routes.set("embedding", [{
      taskKind: "embedding",
      profileId: embeddingProfileId,
      position: 0
    }]);
  }
}

class FakeCredentialStore {
  readonly secrets = new Map<string, string>();
  readonly secretUses: string[] = [];
  readonly events: string[];
  readonly set = vi.fn(async (profileId: string, apiKey: string) => {
    this.events.push("set-credential");
    this.secrets.set(profileId, apiKey);
  });
  readonly prepare = vi.fn(async (
    connection: { provider: ProviderKind; baseUrl: string },
    apiKey: string
  ) => {
    this.events.push("prepare-credential");
    return {
      encryptedSecret: Buffer.from(apiKey),
      provider: connection.provider,
      baseUrl: connection.baseUrl
    };
  });
  readonly storePrepared = vi.fn((profileId: string, prepared: {
    encryptedSecret: Buffer;
  }) => {
    this.events.push("store-credential");
    this.secrets.set(profileId, prepared.encryptedSecret.toString("utf8"));
  });
  readonly remove = vi.fn((profileId: string) => {
    this.events.push("remove-credential");
    this.secrets.delete(profileId);
  });

  constructor(events: string[]) {
    this.events = events;
  }

  status(profileId: string): { hasCredential: boolean; mask?: string } {
    return this.secrets.has(profileId)
      ? { hasCredential: true, mask: "••••••••" }
      : { hasCredential: false };
  }

  async withSecret<T>(
    profileId: string,
    _connection: { provider: ProviderKind; baseUrl: string },
    use: (apiKey?: string) => Promise<T>
  ): Promise<T> {
    this.secretUses.push(profileId);
    return use(this.secrets.get(profileId));
  }
}

function provider(models: ModelDescriptor[] = []): ModelProvider {
  return {
    discover: vi.fn(async () => models),
    generate: vi.fn(async function* () {
      yield { type: "done" as const };
    }),
    embed: vi.fn(async () => [[1]])
  };
}

function setup(modelProvider = provider()) {
  const repository = new FakeSettingsRepository();
  const credentials = new FakeCredentialStore(repository.events);
  const factory = vi.fn(() => modelProvider);
  const service = new ModelService(
    repository as unknown as SettingsRepository,
    credentials as unknown as CredentialStore,
    factory
  );
  return { service, repository, credentials, factory, modelProvider };
}

describe("createModelProvider", () => {
  it.each([
    ["openai", OpenAiProvider],
    ["openai-compatible", OpenAiCompatibleProvider],
    ["anthropic", AnthropicProvider],
    ["gemini", GeminiProvider],
    ["ollama", OllamaProvider]
  ] as const)("constructs the %s adapter", (kind, Provider) => {
    expect(createModelProvider(kind, "https://models.example.test", "secret"))
      .toBeInstanceOf(Provider);
  });
});

describe("ModelService", () => {
  it.each([
    ["AUTH", "errors.authentication", false, undefined],
    ["RATE_LIMITED", "errors.rateLimited", true, 1500],
    ["TIMEOUT", "errors.timeout", true, undefined],
    ["NETWORK", "errors.network", true, undefined],
    ["PROVIDER", "errors.provider", true, undefined]
  ] as const)("preserves provider %s errors from stored credentials", async (code, messageKey, recoverable, retryAfterMs) => {
    const modelProvider = provider();
    const { service, repository, credentials } = setup(modelProvider);
    repository.profiles.set(PROFILE_ID, dto(profile));
    credentials.secrets.set(PROFILE_ID, "stored-secret");
    const failure = {
      error: {
        code,
        messageKey,
        recoverable,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      },
      fallbackEligible: recoverable
    } as const;
    vi.mocked(modelProvider.generate).mockImplementation(async function* () {
      throw new ProviderRequestError(failure);
    });

    await expect(service.test({ profile })).resolves.toEqual({
      ok: false,
      error: failure.error
    });
  });

  it("atomically sets generation and built-in embedding default routes", async () => {
    const { service, repository, factory } = setup();
    repository.profiles.set(PROFILE_ID, dto(profile));

    await expect(service.getDefaultRoutes()).resolves.toEqual({
      ok: true,
      value: {}
    });
    await expect(service.setDefaultRoutes({
      generationProfileId: PROFILE_ID,
      embeddingProfileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
    })).resolves.toEqual({
      ok: true,
      value: {
        generationProfileId: PROFILE_ID,
        embeddingProfileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
      }
    });
    expect([...repository.routes.entries()]).toEqual([
      ["chat", [{ taskKind: "chat", profileId: PROFILE_ID, position: 0 }]],
      ["note-title", [{ taskKind: "note-title", profileId: PROFILE_ID, position: 0 }]],
      ["summary", [{ taskKind: "summary", profileId: PROFILE_ID, position: 0 }]],
      ["key-points", [{ taskKind: "key-points", profileId: PROFILE_ID, position: 0 }]],
      ["qa", [{ taskKind: "qa", profileId: PROFILE_ID, position: 0 }]],
      ["custom-transformation", [{ taskKind: "custom-transformation", profileId: PROFILE_ID, position: 0 }]]
      , ["embedding", [{
        taskKind: "embedding",
        profileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
        position: 0
      }]]
    ]);

    expect(repository.routes.get("embedding")).toEqual([{
      taskKind: "embedding",
      profileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
      position: 0
    }]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps default generation routes valid when chat has an ordered fallback", async () => {
    const { service, repository } = setup();
    repository.profiles.set(PROFILE_ID, dto(profile));
    repository.profiles.set(OTHER_PROFILE_ID, dto({ ...profile, id: OTHER_PROFILE_ID, name: "Fallback" }));
    await expect(service.setDefaultRoutes({
      generationProfileId: PROFILE_ID,
      embeddingProfileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
    })).resolves.toMatchObject({ ok: true });
    repository.replaceRoute("chat", [PROFILE_ID, OTHER_PROFILE_ID]);

    await expect(service.getDefaultRoutes()).resolves.toEqual({
      ok: true,
      value: { generationProfileId: PROFILE_ID, embeddingProfileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID }
    });
  });

  it("rejects missing and wrong-capability default route profiles", async () => {
    const { service, repository } = setup();
    repository.profiles.set(PROFILE_ID, dto(profile));

    await expect(service.setDefaultRoutes({
      generationProfileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
      embeddingProfileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
    })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    await expect(service.setDefaultRoutes({
      generationProfileId: PROFILE_ID,
      embeddingProfileId: OTHER_PROFILE_ID
    })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("rejects partially present or inconsistent generation default routes", async () => {
    const { service, repository } = setup();
    repository.routes.set("chat", [{ taskKind: "chat", position: 0, profileId: PROFILE_ID }]);

    await expect(service.getDefaultRoutes()).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION", messageKey: "errors.modelRouteInconsistent" }
    });

    repository.replaceDefaultRoutes(PROFILE_ID, BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID);
    repository.routes.set("summary", [{
      taskKind: "summary",
      position: 0,
      profileId: OTHER_PROFILE_ID
    }]);
    await expect(service.getDefaultRoutes()).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION", messageKey: "errors.modelRouteInconsistent" }
    });
  });

  it("returns settings updates as safe results", async () => {
    const { service } = setup();

    await expect(service.getSettings()).resolves.toEqual({
      ok: true,
      value: { onboardingCompleted: false, locale: "zh-CN", theme: "light" }
    });
    await expect(service.updateSettings({ locale: "en", theme: "dark" })).resolves.toEqual({
      ok: true,
      value: { onboardingCompleted: false, locale: "en", theme: "dark" }
    });
  });

  it("lists persisted profiles, built-ins, and masked credential status separately", async () => {
    const { service, repository, credentials } = setup();
    repository.profiles.set(PROFILE_ID, dto(profile));
    repository.profiles.set(
      BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
      dto(BUILT_IN_LOCAL_EMBEDDING_PROFILE)
    );
    credentials.secrets.set(PROFILE_ID, "must-not-leak");

    const result = await service.listProfiles();

    expect(result).toEqual({
      ok: true,
      value: {
        profiles: [dto(profile)],
        builtInProfiles: [BUILT_IN_LOCAL_EMBEDDING_PROFILE],
        credentials: [{ profileId: PROFILE_ID, hasCredential: true, mask: "••••••••" }]
      }
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("uses a configured secret for discovery without returning it", async () => {
    const discovered = [{
      id: "gpt-test",
      displayName: "GPT Test",
      capabilities: ["generation" as const],
      capabilityEvidence: "authoritative" as const
    }];
    const { service, repository, credentials, factory } = setup(provider(discovered));
    repository.profiles.set(PROFILE_ID, dto(profile));
    credentials.secrets.set(PROFILE_ID, "stored-secret");

    const result = await service.discover({
      profileId: PROFILE_ID,
      provider: "openai",
      capability: "generation",
      baseUrl: "https://api.openai.com/v1"
    });

    expect(result).toEqual({ ok: true, value: discovered });
    expect(factory).toHaveBeenCalledWith(
      "openai",
      "https://api.openai.com/v1",
      "stored-secret"
    );
    expect(JSON.stringify(result)).not.toContain("stored-secret");
  });

  it("never decrypts a stored credential for caller-supplied provider or endpoint changes", async () => {
    const { service, repository, credentials, factory } = setup(provider([{
      id: profile.modelId,
      displayName: profile.modelId,
      capabilities: ["generation"],
      capabilityEvidence: "authoritative"
    }]));
    repository.profiles.set(PROFILE_ID, dto(profile));
    credentials.secrets.set(PROFILE_ID, "stored-secret");
    const attackerUrl = "https://attacker.example.test/v1";

    const results = await Promise.all([
      service.discover({
        profileId: PROFILE_ID,
        provider: "openai",
        capability: "generation",
        baseUrl: attackerUrl
      }),
      service.test({ profile: { ...profile, baseUrl: attackerUrl } }),
      service.saveProfile({ profile: { ...profile, provider: "openai-compatible" } })
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "VALIDATION", messageKey: "errors.credentialBinding" }
      });
      expect(JSON.stringify(result)).not.toContain("stored-secret");
    }
    expect(credentials.secretUses).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(repository.events).toEqual([]);
  });

  it("edits a credential-free Ollama profile to another permitted loopback endpoint", async () => {
    const modelProvider = provider([{
      id: "llama-new",
      displayName: "Llama new",
      capabilities: ["generation"],
      capabilityEvidence: "authoritative"
    }]);
    const { service, repository, credentials, factory } = setup(modelProvider);
    const ollamaProfile = {
      ...profile,
      provider: "ollama" as const,
      baseUrl: "http://127.0.0.1:11434",
      modelId: "llama-old"
    };
    repository.profiles.set(PROFILE_ID, dto(ollamaProfile));

    const result = await service.saveProfile({
      profile: {
        ...ollamaProfile,
        baseUrl: "http://localhost:11435",
        modelId: "llama-new"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      value: { baseUrl: "http://localhost:11435", modelId: "llama-new" }
    });
    expect(credentials.secretUses).toEqual([]);
    expect(factory).toHaveBeenCalledWith("ollama", "http://localhost:11435", undefined);
  });

  it("saves a keyless OpenAI-compatible profile on a permitted loopback endpoint", async () => {
    const modelProvider = provider([{
      id: "self-hosted-model",
      displayName: "Self hosted model",
      capabilities: ["generation"],
      capabilityEvidence: "authoritative"
    }]);
    const { service, repository, credentials, factory } = setup(modelProvider);
    const compatible = {
      ...profile,
      provider: "openai-compatible" as const,
      baseUrl: "http://localhost:1234/v1",
      modelId: "self-hosted-model"
    };

    const result = await service.saveProfile({ profile: compatible });

    expect(result).toMatchObject({ ok: true, value: compatible });
    expect(repository.profiles.get(PROFILE_ID)).toMatchObject(compatible);
    expect(credentials.secrets.has(PROFILE_ID)).toBe(false);
    expect(factory).toHaveBeenCalledWith(
      "openai-compatible",
      "http://localhost:1234/v1",
      undefined
    );
  });

  it.each([
    ["openai", "file:///tmp/models"],
    ["openai", "https://user:password@example.test/v1"],
    ["openai", "http://127.0.0.1:8080/v1"],
    ["openai", "http://localhost.:8080/v1"],
    ["openai", "http://[::ffff:127.0.0.1]:8080/v1"],
    ["anthropic", "http://localhost:8080"],
    ["gemini", "http://[::1]:8080"]
  ] as Array<[ProviderKind, string]>)(
    "rejects unsafe %s provider address %s",
    async (kind, baseUrl) => {
      const { service, factory } = setup();

      const result = await service.discover({
        provider: kind,
        capability: "generation",
        baseUrl
      });

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(factory).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["ollama", "http://127.0.0.1:11434"],
    ["openai-compatible", "http://localhost:1234/v1"]
  ] as Array<[ProviderKind, string]>)(
    "allows explicitly local %s endpoints",
    async (kind, baseUrl) => {
      const { service, factory } = setup();

      const result = await service.discover({
        provider: kind,
        capability: "generation",
        baseUrl
      });

      expect(result).toEqual({ ok: true, value: [] });
      expect(factory).toHaveBeenCalledWith(kind, baseUrl, undefined);
    }
  );

  it("accepts a discovered model without making a capability probe", async () => {
    const modelProvider = provider([{
      id: profile.modelId,
      displayName: "Discovered",
      capabilities: ["generation"],
      capabilityEvidence: "authoritative"
    }]);
    const { service } = setup(modelProvider);

    await expect(service.test({ profile })).resolves.toEqual({
      ok: true,
      value: {
        modelId: profile.modelId,
        capability: "generation",
        verifiedBy: "discovery"
      }
    });
    expect(modelProvider.generate).not.toHaveBeenCalled();
    expect(modelProvider.embed).not.toHaveBeenCalled();
  });

  it("rejects a capability disproved by authoritative discovery without probing", async () => {
    const modelProvider = provider([{
      id: profile.modelId,
      displayName: "Generation only",
      capabilities: ["generation"],
      capabilityEvidence: "authoritative"
    }]);
    const { service } = setup(modelProvider);

    await expect(service.test({
      profile: { ...profile, provider: "gemini", capability: "embedding" }
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION", messageKey: "errors.modelCapability" }
    });
    expect(modelProvider.generate).not.toHaveBeenCalled();
    expect(modelProvider.embed).not.toHaveBeenCalled();
  });

  it("probes a listed OpenAI-compatible model whose capability is not authoritative", async () => {
    const modelProvider = provider([{
      id: profile.modelId,
      displayName: "Listed",
      capabilities: [],
      capabilityEvidence: "probe-required"
    }]);
    const { service } = setup(modelProvider);

    await expect(service.test({
      profile: { ...profile, provider: "openai-compatible" }
    })).resolves.toEqual({
      ok: true,
      value: {
        modelId: profile.modelId,
        capability: "generation",
        verifiedBy: "probe"
      }
    });
    expect(modelProvider.generate).toHaveBeenCalledWith({
      model: profile.modelId,
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      maxTokens: 1
    }, expect.any(AbortSignal));
  });

  it("rejects an embedding selection when a listed chat-only model fails its probe", async () => {
    const modelProvider = provider([{
      id: profile.modelId,
      displayName: "Listed chat model",
      capabilities: [],
      capabilityEvidence: "probe-required"
    }]);
    vi.mocked(modelProvider.embed).mockRejectedValue(new Error("chat-only"));
    const { service, repository } = setup(modelProvider);
    const embeddingProfile = { ...profile, capability: "embedding" as const };

    const result = await service.saveProfile({ profile: embeddingProfile });

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(modelProvider.embed).toHaveBeenCalledWith({
      model: profile.modelId,
      inputs: ["test"]
    }, expect.any(AbortSignal));
    expect(repository.profiles.has(PROFILE_ID)).toBe(false);
  });

  it("uses the smallest generation probe for a manual model and saves only afterward", async () => {
    const modelProvider = provider([]);
    const { service, repository, credentials } = setup(modelProvider);
    vi.mocked(modelProvider.generate).mockImplementation(async function* () {
      repository.events.push("probe");
      yield { type: "done" };
    });

    const result = await service.saveProfile({ profile, apiKey: "new-secret" });

    expect(result).toEqual({ ok: true, value: dto(profile) });
    expect(modelProvider.generate).toHaveBeenCalledWith({
      model: profile.modelId,
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      maxTokens: 1
    }, expect.any(AbortSignal));
    expect(repository.events).toEqual([
      "probe",
      "prepare-credential",
      "save-profile",
      "store-credential"
    ]);
    expect(credentials.secrets.get(PROFILE_ID)).toBe("new-secret");
  });

  it("uses one input for the smallest embedding probe", async () => {
    const modelProvider = provider([]);
    const { service } = setup(modelProvider);
    const embeddingProfile = {
      ...profile,
      capability: "embedding" as const,
      modelId: "embedding-test"
    };

    await expect(service.test({ profile: embeddingProfile })).resolves.toMatchObject({
      ok: true,
      value: { modelId: "embedding-test", verifiedBy: "probe" }
    });
    expect(modelProvider.embed).toHaveBeenCalledWith({
      model: "embedding-test",
      inputs: ["test"]
    }, expect.any(AbortSignal));
    expect(modelProvider.generate).not.toHaveBeenCalled();
  });

  it("does not persist a profile when its model test fails", async () => {
    const modelProvider = provider([]);
    vi.mocked(modelProvider.generate).mockImplementation(async function* () {
      throw new Error("failed");
    });
    const { service, repository, credentials } = setup(modelProvider);

    const result = await service.saveProfile({ profile, apiKey: "new-secret" });

    expect(result).toMatchObject({ ok: false });
    expect(repository.profiles.has(PROFILE_ID)).toBe(false);
    expect(credentials.secrets.has(PROFILE_ID)).toBe(false);
  });

  it("preserves the existing credential when editing non-secret fields", async () => {
    const modelProvider = provider([{
      id: "gpt-renamed",
      displayName: "gpt-renamed",
      capabilities: ["generation"],
      capabilityEvidence: "authoritative"
    }]);
    const { service, repository, credentials, factory } = setup(modelProvider);
    repository.profiles.set(PROFILE_ID, dto(profile));
    credentials.secrets.set(PROFILE_ID, "existing-secret");

    const result = await service.saveProfile({
      profile: {
        ...profile,
        name: "Renamed",
        modelId: "gpt-renamed",
        baseUrl: `${profile.baseUrl}/`
      }
    });

    expect(result).toMatchObject({ ok: true, value: { name: "Renamed" } });
    expect(factory).toHaveBeenCalledWith(
      "openai",
      profile.baseUrl,
      "existing-secret"
    );
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.remove).not.toHaveBeenCalled();
    expect(credentials.secrets.get(PROFILE_ID)).toBe("existing-secret");
  });

  it("rejects every mutating or inference operation for the built-in profile", async () => {
    const { service, repository, credentials, factory } = setup();
    const builtInProfile = { ...BUILT_IN_LOCAL_EMBEDDING_PROFILE };

    const results = await Promise.all([
      service.saveProfile({ profile: builtInProfile }),
      service.deleteProfile({ id: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID }),
      service.test({ profile: builtInProfile }),
      service.setCredential({
        profileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID,
        apiKey: "secret"
      }),
      service.removeCredential({ profileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID })
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "VALIDATION",
          messageKey: "errors.builtInModelImmutable"
        }
      });
    }
    expect(repository.events).toEqual([]);
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.remove).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns not found instead of mutating unknown persisted profiles", async () => {
    const { service, repository, credentials } = setup();

    await expect(service.deleteProfile({ id: OTHER_PROFILE_ID })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" }
    });
    await expect(service.setCredential({
      profileId: OTHER_PROFILE_ID,
      apiKey: "secret"
    })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(repository.events).toEqual([]);
    expect(credentials.set).not.toHaveBeenCalled();
  });
});
