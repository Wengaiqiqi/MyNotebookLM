import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { SettingsRepository } from "../settings/settings-repository";
import { CredentialStore, type SecretProtector } from "./credential-store";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

class DeterministicProtector implements SecretProtector {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async encrypt(value: string): Promise<Buffer> {
    return Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa));
  }

  async decrypt(value: Buffer): Promise<string> {
    return Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa)).toString("utf8");
  }
}

class UnavailableProtector implements SecretProtector {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async encrypt(): Promise<Buffer> {
    throw new Error("encrypt must not run when storage is unavailable");
  }

  async decrypt(): Promise<string> {
    throw new Error("decrypt must not run when storage is unavailable");
  }
}

class LeakyProtector extends DeterministicProtector {
  override async encrypt(value: string): Promise<Buffer> {
    throw new Error(`unable to encrypt ${value}`);
  }
}

class CountingProtector extends DeterministicProtector {
  decryptCalls = 0;

  override async decrypt(value: Buffer): Promise<string> {
    this.decryptCalls += 1;
    return super.decrypt(value);
  }
}

describe("CredentialStore", () => {
  let temporaryRoot: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-credentials-"));
    appDatabase = openAppDatabase(
      path.join(temporaryRoot, "app.db"),
      path.resolve("src/main/db/migrations")
    );
    new SettingsRepository(appDatabase.connection).saveProfile({
      id: PROFILE_ID,
      name: "Primary",
      provider: "openai",
      capability: "generation",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
      enabled: true
    });
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("stores encrypted bytes and exposes only a fixed opaque credential mask", async () => {
    const store = new CredentialStore(appDatabase.connection, new DeterministicProtector());
    const apiKey = "ApiKey-42";

    await store.set(PROFILE_ID, apiKey);

    const row = appDatabase.connection.prepare(
      "SELECT encrypted_secret, provider, base_url FROM credentials WHERE profile_id = ?"
    ).get(PROFILE_ID) as { encrypted_secret: Buffer; provider: string; base_url: string };
    expect(row.encrypted_secret.equals(Buffer.from(apiKey))).toBe(false);
    expect(row).toMatchObject({
      provider: "openai",
      base_url: "https://api.openai.com/v1"
    });
    expect(store.status(PROFILE_ID)).toEqual({ hasCredential: true, mask: "••••••••" });
    await expect(store.withSecret(
      PROFILE_ID,
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      async (value) => value
    )).resolves.toBe(apiKey);
  });

  it("refuses to decrypt when durable credential binding no longer matches the profile", async () => {
    const protector = new CountingProtector();
    const store = new CredentialStore(appDatabase.connection, protector);
    await store.set(PROFILE_ID, "bound-secret");
    appDatabase.connection.prepare(`
      UPDATE model_profiles SET base_url = 'https://attacker.example.test/v1' WHERE id = ?
    `).run(PROFILE_ID);

    await expect(store.withSecret(
      PROFILE_ID,
      { provider: "openai", baseUrl: "https://attacker.example.test/v1" },
      async (value) => value
    ))
      .rejects.toThrow(/binding/i);
    expect(protector.decryptCalls).toBe(0);
  });

  it("refuses to decrypt for a requested endpoint outside the durable binding", async () => {
    const protector = new CountingProtector();
    const store = new CredentialStore(appDatabase.connection, protector);
    await store.set(PROFILE_ID, "bound-secret");

    await expect(store.withSecret(
      PROFILE_ID,
      { provider: "openai-compatible", baseUrl: "https://attacker.example.test/v1" },
      async (value) => value
    )).rejects.toThrow(/binding/i);
    expect(protector.decryptCalls).toBe(0);
  });

  it("replaces a stored credential and removes it on request", async () => {
    const store = new CredentialStore(appDatabase.connection, new DeterministicProtector());

    await store.set(PROFILE_ID, "first-key");
    await store.set(PROFILE_ID, "replacement-key");
    await expect(store.withSecret(
      PROFILE_ID,
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      async (value) => value
    )).resolves.toBe("replacement-key");

    store.remove(PROFILE_ID);
    expect(store.status(PROFILE_ID)).toEqual({ hasCredential: false });
    await expect(store.withSecret(
      PROFILE_ID,
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      async (value) => value
    )).resolves.toBeUndefined();
  });

  it("rejects blank credentials before encrypting them", async () => {
    const store = new CredentialStore(appDatabase.connection, new DeterministicProtector());

    await expect(store.set(PROFILE_ID, "  ")).rejects.toThrow(/empty/i);
    expect(store.status(PROFILE_ID)).toEqual({ hasCredential: false });
  });

  it("fails closed when the operating system encryption service is unavailable", async () => {
    const store = new CredentialStore(appDatabase.connection, new UnavailableProtector());

    await expect(store.set(PROFILE_ID, "ApiKey-42")).rejects.toThrow(/unavailable/i);
    expect(store.status(PROFILE_ID)).toEqual({ hasCredential: false });
  });

  it("does not include credential text in encryption errors", async () => {
    const store = new CredentialStore(appDatabase.connection, new LeakyProtector());
    const apiKey = "ApiKey-42";

    const error = await store.set(PROFILE_ID, apiKey).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
  });
});
