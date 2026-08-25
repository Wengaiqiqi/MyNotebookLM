import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfileInput, ProviderKind } from "../../shared/models";
import { CredentialStore, type SecretProtector } from "../credentials/credential-store";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { SettingsRepository } from "../settings/settings-repository";
import { ModelService, type ModelProviderFactory } from "./model-service";
import type { ModelProvider } from "./provider";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OLD_URL = "https://old.example.test/v1";
const NEW_URL = "https://attacker.example.test/v1";

const oldProfile: ModelProfileInput = {
  id: PROFILE_ID,
  name: "Old profile",
  provider: "openai-compatible",
  capability: "generation",
  baseUrl: OLD_URL,
  modelId: "old-model",
  enabled: true
};

class InjectableProtector implements SecretProtector {
  failEncryption = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async encrypt(value: string): Promise<Buffer> {
    if (this.failEncryption) throw new Error(`failed to encrypt ${value}`);
    return Buffer.from(value, "utf8");
  }

  async decrypt(value: Buffer): Promise<string> {
    return value.toString("utf8");
  }
}

function successfulProvider(): ModelProvider {
  return {
    discover: vi.fn(async () => [{
      id: "new-model",
      displayName: "New model",
      capabilities: ["generation" as const],
      capabilityEvidence: "authoritative" as const
    }]),
    generate: vi.fn(async function* () { yield { type: "done" as const }; }),
    embed: vi.fn(async () => [[1]])
  };
}

describe("ModelService atomic profile credential replacement", () => {
  let temporaryRoot: string;
  let databasePath: string;
  let appDatabase: AppDatabase;
  let protector: InjectableProtector;

  beforeEach(async () => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-atomic-profile-"));
    databasePath = path.join(temporaryRoot, "app.db");
    appDatabase = openAppDatabase(databasePath, path.resolve("src/main/db/migrations"));
    protector = new InjectableProtector();
    const settings = new SettingsRepository(appDatabase.connection);
    settings.saveProfile(oldProfile);
    await new CredentialStore(appDatabase.connection, protector).set(PROFILE_ID, "old-secret");
  });

  afterEach(() => {
    if (appDatabase.connection.open) appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function service(factory: ModelProviderFactory = vi.fn(() => successfulProvider())): ModelService {
    return new ModelService(
      new SettingsRepository(appDatabase.connection),
      new CredentialStore(appDatabase.connection, protector),
      factory
    );
  }

  async function expectOldPair(): Promise<void> {
    const settings = new SettingsRepository(appDatabase.connection);
    const credentials = new CredentialStore(appDatabase.connection, protector);
    expect(settings.getProfile(PROFILE_ID)).toMatchObject(oldProfile);
    await expect(credentials.withSecret(
      PROFILE_ID,
      { provider: oldProfile.provider, baseUrl: OLD_URL },
      async (secret) => secret
    )).resolves.toBe("old-secret");
  }

  it("leaves the old endpoint and secret unchanged when replacement encryption fails", async () => {
    protector.failEncryption = true;

    const result = await service().saveProfile({
      profile: { ...oldProfile, baseUrl: NEW_URL, modelId: "new-model" },
      apiKey: "replacement-secret"
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    protector.failEncryption = false;
    await expectOldPair();
  });

  it("rolls back a credential insert failure and rejects the attacker endpoint after restart", async () => {
    appDatabase.connection.exec(`
      CREATE TRIGGER fail_replacement_credential
      BEFORE INSERT ON credentials
      BEGIN
        SELECT RAISE(ABORT, 'forced credential insert failure');
      END
    `);

    const result = await service().saveProfile({
      profile: { ...oldProfile, baseUrl: NEW_URL, modelId: "new-model" },
      apiKey: "replacement-secret"
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await expectOldPair();
    appDatabase.close();
    appDatabase = openAppDatabase(databasePath, path.resolve("src/main/db/migrations"));
    await expectOldPair();

    const factory = vi.fn((_provider: ProviderKind, _baseUrl: string) => successfulProvider());
    const discovery = await service(factory).discover({
      profileId: PROFILE_ID,
      provider: "openai-compatible",
      capability: "generation",
      baseUrl: NEW_URL
    });
    expect(discovery).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", messageKey: "errors.credentialBinding" }
    });
    expect(factory).not.toHaveBeenCalled();
  });
});
