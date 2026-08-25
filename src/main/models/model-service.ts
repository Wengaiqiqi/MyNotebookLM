import { ZodError } from "zod";
import type { AppErrorDto, Result } from "../../shared/app-errors";
import {
  credentialInputSchema,
  credentialProfileInputSchema,
  deleteModelProfileInputSchema,
  discoverModelsInputSchema,
  modelDescriptorSchema,
  builtInModelProfileDtoSchema,
  modelProfileInputSchema,
  saveModelProfileInputSchema,
  testModelInputSchema,
  type CredentialInput,
  type CredentialProfileInput,
  type CredentialStatusDto,
  type DeleteModelProfileInput,
  type DiscoverModelsInput,
  type ModelCapability,
  type ModelDescriptorDto,
  type ModelProfileDto,
  type ModelProfileListDto,
  type ModelTestResultDto,
  type ProviderKind,
  type SaveModelProfileInput,
  type TestModelInput
} from "../../shared/models";
import {
  updateAppSettingsInputSchema,
  type AppSettingsDto,
  type UpdateAppSettingsInput
} from "../../shared/settings";
import type { CredentialStore } from "../credentials/credential-store";
import type { SettingsRepository } from "../settings/settings-repository";
import { AnthropicProvider } from "./anthropic-provider";
import { GeminiProvider } from "./gemini-provider";
import {
  BUILT_IN_LOCAL_EMBEDDING_PROFILE,
  isBuiltInLocalEmbeddingProfile
} from "./local-embedding-profile";
import { OllamaProvider } from "./ollama-provider";
import { OpenAiCompatibleProvider, OpenAiProvider } from "./openai-provider";
import { ProviderRequestError } from "./http-client";
import type { ModelProvider } from "./provider";

export type ModelProviderFactory = (
  provider: ProviderKind,
  baseUrl: string,
  apiKey?: string
) => ModelProvider;

export const createModelProvider: ModelProviderFactory = (provider, baseUrl, apiKey) => {
  const options = { baseUrl, ...(apiKey === undefined ? {} : { apiKey }) };
  switch (provider) {
    case "openai":
      return new OpenAiProvider(options);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(options);
    case "anthropic":
      return new AnthropicProvider(options);
    case "gemini":
      return new GeminiProvider(options);
    case "ollama":
      return new OllamaProvider({ baseUrl });
    case "local":
      throw new Error("Built-in local model inference is not available yet");
  }
};

function appError(
  code: AppErrorDto["code"],
  messageKey: string,
  recoverable = false
): AppErrorDto {
  return { code, messageKey, recoverable };
}

function errorResult<T>(error: AppErrorDto): Result<T> {
  return { ok: false, error };
}

function resultFromError<T>(reason: unknown): Result<T> {
  if (reason instanceof ZodError) {
    return errorResult(appError("VALIDATION", "errors.validation"));
  }
  if (reason instanceof ProviderRequestError) return errorResult(reason.failure.error);
  return errorResult(appError("INTERNAL", "errors.internal"));
}

function builtInError<T>(): Result<T> {
  return errorResult(appError("VALIDATION", "errors.builtInModelImmutable"));
}

function notFound<T>(): Result<T> {
  return errorResult(appError("NOT_FOUND", "errors.modelProfileNotFound"));
}

type ProviderConnection = Readonly<{
  profileId?: string | undefined;
  provider: ProviderKind;
  capability: ModelCapability;
  baseUrl: string;
  apiKey?: string | undefined;
}>;

export class ModelService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly credentials: CredentialStore,
    private readonly providerFactory: ModelProviderFactory = createModelProvider
  ) {}

  async getSettings(): Promise<Result<AppSettingsDto>> {
    try {
      return { ok: true, value: this.settings.getSettings() };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  async updateSettings(input: UpdateAppSettingsInput): Promise<Result<AppSettingsDto>> {
    try {
      return {
        ok: true,
        value: this.settings.updateSettings(updateAppSettingsInputSchema.parse(input))
      };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  async listProfiles(): Promise<Result<ModelProfileListDto>> {
    try {
      const profiles = this.settings.listProfiles().filter(
        (profile) => !isBuiltInLocalEmbeddingProfile(profile)
      );
      return {
        ok: true,
        value: {
          profiles,
          builtInProfiles: [
            builtInModelProfileDtoSchema.parse(BUILT_IN_LOCAL_EMBEDDING_PROFILE)
          ],
          credentials: profiles.map((profile) => ({
            profileId: profile.id,
            ...this.credentials.status(profile.id)
          }))
        }
      };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  async discover(input: DiscoverModelsInput): Promise<Result<ModelDescriptorDto[]>> {
    let parsed: DiscoverModelsInput;
    try {
      parsed = discoverModelsInputSchema.parse(input);
    } catch (reason) {
      return resultFromError(reason);
    }
    if (parsed.provider === "local"
      || (parsed.profileId && isBuiltInLocalEmbeddingProfile(parsed.profileId))) {
      return builtInError();
    }
    return this.withProvider(parsed, async (provider) => {
      const discovered = modelDescriptorSchema.array().parse(
        await provider.discover(new AbortController().signal)
      );
      return discovered.filter((model) => model.capabilities.includes(parsed.capability));
    });
  }

  async test(input: TestModelInput): Promise<Result<ModelTestResultDto>> {
    let parsed: TestModelInput;
    try {
      parsed = testModelInputSchema.parse(input);
    } catch (reason) {
      return resultFromError(reason);
    }
    if (isBuiltInLocalEmbeddingProfile(parsed.profile)) return builtInError();
    return this.testProfile(parsed);
  }

  async saveProfile(input: SaveModelProfileInput): Promise<Result<ModelProfileDto>> {
    let parsed: SaveModelProfileInput;
    try {
      parsed = saveModelProfileInputSchema.parse(input);
    } catch (reason) {
      return resultFromError(reason);
    }
    if (isBuiltInLocalEmbeddingProfile(parsed.profile)) return builtInError();

    const tested = await this.testProfile(parsed);
    if (!tested.ok) return tested;

    try {
      const saved = this.settings.saveProfile(modelProfileInputSchema.parse(parsed.profile));
      if (parsed.apiKey !== undefined) {
        await this.credentials.set(parsed.profile.id, parsed.apiKey);
      }
      return { ok: true, value: saved };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  async deleteProfile(input: DeleteModelProfileInput): Promise<Result<void>> {
    let parsed: DeleteModelProfileInput;
    try {
      parsed = deleteModelProfileInputSchema.parse(input);
    } catch (reason) {
      return resultFromError(reason);
    }
    if (isBuiltInLocalEmbeddingProfile(parsed.id)) return builtInError();
    if (!this.settings.getProfile(parsed.id)) return notFound();
    try {
      this.settings.deleteProfile(parsed.id);
      return { ok: true, value: undefined };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  async setCredential(input: CredentialInput): Promise<Result<CredentialStatusDto>> {
    let parsed: CredentialInput;
    try {
      parsed = credentialInputSchema.parse(input);
    } catch (reason) {
      return resultFromError(reason);
    }
    if (isBuiltInLocalEmbeddingProfile(parsed.profileId)) return builtInError();
    if (!this.settings.getProfile(parsed.profileId)) return notFound();
    try {
      await this.credentials.set(parsed.profileId, parsed.apiKey);
      return {
        ok: true,
        value: { profileId: parsed.profileId, ...this.credentials.status(parsed.profileId) }
      };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  async removeCredential(
    input: CredentialProfileInput
  ): Promise<Result<CredentialStatusDto>> {
    let parsed: CredentialProfileInput;
    try {
      parsed = credentialProfileInputSchema.parse(input);
    } catch (reason) {
      return resultFromError(reason);
    }
    if (isBuiltInLocalEmbeddingProfile(parsed.profileId)) return builtInError();
    if (!this.settings.getProfile(parsed.profileId)) return notFound();
    try {
      this.credentials.remove(parsed.profileId);
      return {
        ok: true,
        value: { profileId: parsed.profileId, ...this.credentials.status(parsed.profileId) }
      };
    } catch (reason) {
      return resultFromError(reason);
    }
  }

  private async testProfile(input: TestModelInput): Promise<Result<ModelTestResultDto>> {
    const { profile } = input;
    if (profile.provider === "local") return builtInError();
    return this.withProvider({
      profileId: profile.id,
      provider: profile.provider,
      capability: profile.capability,
      baseUrl: profile.baseUrl,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey })
    }, async (provider) => {
      const signal = new AbortController().signal;
      try {
        const discovered = modelDescriptorSchema.array().parse(await provider.discover(signal));
        const match = discovered.find((model) =>
          model.id === profile.modelId && model.capabilities.includes(profile.capability)
        );
        if (match) {
          return {
            modelId: profile.modelId,
            capability: profile.capability,
            verifiedBy: "discovery" as const
          };
        }
      } catch {
        // Some compatible endpoints cannot list models; the capability probe is authoritative.
      }

      if (profile.capability === "embedding") {
        await provider.embed({ model: profile.modelId, inputs: ["test"] }, signal);
      } else {
        for await (const _event of provider.generate({
          model: profile.modelId,
          messages: [{ role: "user", content: "ping" }],
          temperature: 0,
          maxTokens: 1
        }, signal)) {
          // Consume the complete response so late stream errors fail the test.
        }
      }
      return {
        modelId: profile.modelId,
        capability: profile.capability,
        verifiedBy: "probe" as const
      };
    });
  }

  private async withProvider<T>(
    connection: ProviderConnection,
    use: (provider: ModelProvider) => Promise<T>
  ): Promise<Result<T>> {
    const invoke = async (storedApiKey?: string): Promise<Result<T>> => {
      try {
        const provider = this.providerFactory(
          connection.provider,
          connection.baseUrl,
          connection.apiKey ?? storedApiKey
        );
        return { ok: true, value: await use(provider) };
      } catch (reason) {
        return resultFromError(reason);
      }
    };

    if (connection.apiKey !== undefined || connection.profileId === undefined) {
      return invoke();
    }
    try {
      return await this.credentials.withSecret(connection.profileId, invoke);
    } catch (reason) {
      return resultFromError(reason);
    }
  }
}
