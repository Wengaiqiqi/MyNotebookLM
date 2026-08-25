import type Database from "better-sqlite3";

export interface SecretProtector {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

export interface CredentialStore {
  set(profileId: string, apiKey: string): Promise<void>;
  remove(profileId: string): void;
  status(profileId: string): { hasCredential: boolean; mask?: string };
  withSecret<T>(profileId: string, use: (apiKey?: string) => Promise<T>): Promise<T>;
}

const CREDENTIAL_MASK = "••••••••";

export class CredentialStore implements CredentialStore {
  constructor(
    private readonly db: Database.Database,
    private readonly protector: SecretProtector
  ) {}

  async set(profileId: string, apiKey: string): Promise<void> {
    if (apiKey.trim().length === 0) throw new Error("Credential must not be empty");
    await this.assertStorageAvailable();

    let encryptedSecret: Buffer;
    try {
      encryptedSecret = await this.protector.encrypt(apiKey);
    } catch {
      throw new Error("Credential could not be protected");
    }

    try {
      this.db.prepare(`
        INSERT INTO credentials(profile_id, encrypted_secret, updated_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(profile_id) DO UPDATE SET
          encrypted_secret = excluded.encrypted_secret,
          updated_at = excluded.updated_at
      `).run(profileId, encryptedSecret);
    } catch {
      throw new Error("Credential could not be stored");
    }
  }

  remove(profileId: string): void {
    this.db.prepare("DELETE FROM credentials WHERE profile_id = ?").run(profileId);
  }

  status(profileId: string): { hasCredential: boolean; mask?: string } {
    const credential = this.db.prepare(
      "SELECT 1 FROM credentials WHERE profile_id = ?"
    ).get(profileId);
    return credential ? { hasCredential: true, mask: CREDENTIAL_MASK } : { hasCredential: false };
  }

  async withSecret<T>(profileId: string, use: (apiKey?: string) => Promise<T>): Promise<T> {
    const row = this.db.prepare(
      "SELECT encrypted_secret FROM credentials WHERE profile_id = ?"
    ).get(profileId) as { encrypted_secret: Buffer } | undefined;
    if (!row) return use();

    await this.assertStorageAvailable();

    let apiKey: string;
    try {
      apiKey = await this.protector.decrypt(row.encrypted_secret);
    } catch {
      throw new Error("Credential could not be read");
    }

    try {
      return await use(apiKey);
    } catch {
      throw new Error("Credential could not be used");
    }
  }

  private async assertStorageAvailable(): Promise<void> {
    try {
      if (await this.protector.isAvailable()) return;
    } catch {
      // Fall through to the generic fail-closed error.
    }
    throw new Error("Secure credential storage is unavailable");
  }
}
