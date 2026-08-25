import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { ModelService } from "../models/model-service";
import type { ModelProvider } from "../models/provider";
import { SettingsRepository } from "../settings/settings-repository";
import { CredentialStore, type SecretProtector } from "./credential-store";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ATTACKER_URL = "https://attacker.example.test/v1";

class CountingProtector implements SecretProtector {
  decryptCalls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async encrypt(value: string): Promise<Buffer> {
    return Buffer.from(`protected:${value}`);
  }

  async decrypt(value: Buffer): Promise<string> {
    this.decryptCalls += 1;
    return value.toString("utf8").replace(/^protected:/, "");
  }
}

function provider(): ModelProvider {
  return {
    discover: vi.fn(async () => []),
    generate: vi.fn(async function* () { yield { type: "done" as const }; }),
    embed: vi.fn(async () => [[1]])
  };
}

describe("credential binding migration", () => {
  const roots: string[] = [];
  const databases: AppDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      if (database.connection.open) database.close();
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("fails closed for an interrupted v2 endpoint change until the key is explicitly replaced", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-credential-upgrade-"));
    roots.push(root);
    const migrations = path.join(root, "migrations");
    mkdirSync(migrations);
    for (const name of ["001_initial.sql", "002_settings_models.sql"]) {
      copyFileSync(path.resolve("src/main/db/migrations", name), path.join(migrations, name));
    }
    const databasePath = path.join(root, "app.db");
    const v2 = openAppDatabase(databasePath, migrations);
    new SettingsRepository(v2.connection).saveProfile({
      id: PROFILE_ID,
      name: "Interrupted profile",
      provider: "openai",
      capability: "generation",
      baseUrl: ATTACKER_URL,
      modelId: "gpt-test",
      enabled: true
    });
    v2.connection.prepare(`
      INSERT INTO credentials(profile_id, encrypted_secret) VALUES (?, ?)
    `).run(PROFILE_ID, Buffer.from("protected:old-secret"));
    v2.close();
    copyFileSync(
      path.resolve("src/main/db/migrations/003_credential_binding.sql"),
      path.join(migrations, "003_credential_binding.sql")
    );

    const upgraded = openAppDatabase(databasePath, migrations);
    databases.push(upgraded);
    const protector = new CountingProtector();
    const credentials = new CredentialStore(upgraded.connection, protector);
    const settings = new SettingsRepository(upgraded.connection);
    const factory = vi.fn(() => provider());
    const service = new ModelService(settings, credentials, factory);

    expect(credentials.status(PROFILE_ID)).toEqual({ hasCredential: false });
    await expect(service.listProfiles()).resolves.toMatchObject({
      ok: true,
      value: {
        credentials: [{ profileId: PROFILE_ID, hasCredential: false }]
      }
    });
    expect(protector.decryptCalls).toBe(0);
    expect(factory).not.toHaveBeenCalled();

    await expect(service.setCredential({
      profileId: PROFILE_ID,
      apiKey: "replacement-secret"
    })).resolves.toMatchObject({
      ok: true,
      value: { profileId: PROFILE_ID, hasCredential: true }
    });
    await expect(service.discover({
      profileId: PROFILE_ID,
      provider: "openai",
      capability: "generation",
      baseUrl: ATTACKER_URL
    })).resolves.toEqual({ ok: true, value: [] });
    expect(factory).toHaveBeenCalledWith("openai", ATTACKER_URL, "replacement-secret");
    expect(protector.decryptCalls).toBe(1);
  });
});
