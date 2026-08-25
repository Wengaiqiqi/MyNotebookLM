import { describe, expect, it, vi } from "vitest";
import type {
  AppSettingsDto,
  UpdateAppSettingsInput
} from "../../shared/settings";
import type {
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
  readonly events: string[] = [];

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
}

class FakeCredentialStore {
  readonly secrets = new Map<string, string>();
  readonly events: string[];
  readonly set = vi.fn(async (profileId: string, apiKey: string) => {
    this.events.push("set-credential");
    this.secrets.set(profileId, apiKey);
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
    use: (apiKey?: string) => Promise<T>
  ): Promise<T> {
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
      capabilities: ["generation" as const]
    }];
    const { service, credentials, factory } = setup(provider(discovered));
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
      capabilities: ["generation"]
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
    expect(repository.events).toEqual(["probe", "save-profile", "set-credential"]);
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
      id: profile.modelId,
      displayName: profile.modelId,
      capabilities: ["generation"]
    }]);
    const { service, repository, credentials, factory } = setup(modelProvider);
    repository.profiles.set(PROFILE_ID, dto(profile));
    credentials.secrets.set(PROFILE_ID, "existing-secret");

    const result = await service.saveProfile({
      profile: { ...profile, name: "Renamed" }
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
