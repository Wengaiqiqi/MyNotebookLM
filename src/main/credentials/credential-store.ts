import type Database from "better-sqlite3";
import type { ProviderKind } from "../../shared/models";

export interface SecretProtector {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

export interface CredentialStore {
  set(profileId: string, apiKey: string): Promise<void>;
  prepare(connection: CredentialConnection, apiKey: string): Promise<PreparedCredential>;
  storePrepared(profileId: string, credential: PreparedCredential): void;
  updateConnection(profileId: string, connection: CredentialConnection): void;
  findPrepared(connection: CredentialConnection): PreparedCredential | undefined;
  remove(profileId: string): void;
  status(profileId: string): { hasCredential: boolean; mask?: string };
  withSecret<T>(
    profileId: string,
    connection: CredentialConnection,
    use: (apiKey?: string) => Promise<T>
  ): Promise<T>;
}

const CREDENTIAL_MASK = "••••••••";

export type CredentialConnection = Readonly<{
  provider: ProviderKind;
  baseUrl: string;
}>;

export type PreparedCredential = Readonly<{
  encryptedSecret: Buffer;
  provider: ProviderKind;
  baseUrl: string;
}>;

type ProfileBindingRow = Readonly<{
  provider: ProviderKind;
  base_url: string;
}>;

type StoredCredentialRow = Readonly<{
  encrypted_secret: Buffer;
  credential_provider: ProviderKind;
  credential_base_url: string;
  profile_provider: ProviderKind;
  profile_base_url: string;
}>;

const STANDARD_ERROR_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

function containsSecret(value: unknown, secret: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return value.includes(secret);
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;

  try {
    const object = value as object;
    if (seen.has(object)) return false;
    seen.add(object);
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) return true;
      if (!("value" in descriptor)) {
        if (key === "stack" && value instanceof Error
          && descriptor.get === STANDARD_ERROR_STACK_GETTER) continue;
        return true;
      }
      if (containsSecret(descriptor.value, secret, seen)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function canonicalCredentialBaseUrl(baseUrl: string): string {
  const address = new URL(baseUrl);
  address.pathname = address.pathname.replace(/\/+$/, "");
  return address.toString();
}

export class CredentialStore implements CredentialStore {
  constructor(
    private readonly db: Database.Database,
    private readonly protector: SecretProtector
  ) {}

  async set(profileId: string, apiKey: string): Promise<void> {
    const profile = this.db.prepare(`
      SELECT provider, base_url FROM model_profiles WHERE id = ?
    `).get(profileId) as ProfileBindingRow | undefined;
    if (!profile) throw new Error("Credential profile was not found");
    const prepared = await this.prepare({
      provider: profile.provider,
      baseUrl: profile.base_url
    }, apiKey);
    this.storePrepared(profileId, prepared);
  }

  async prepare(
    connection: CredentialConnection,
    apiKey: string
  ): Promise<PreparedCredential> {
    if (apiKey.trim().length === 0) throw new Error("Credential must not be empty");
    await this.assertStorageAvailable();

    let encryptedSecret: Buffer;
    try {
      encryptedSecret = await this.protector.encrypt(apiKey);
    } catch {
      throw new Error("Credential could not be protected");
    }

    return {
      encryptedSecret,
      provider: connection.provider,
      baseUrl: canonicalCredentialBaseUrl(connection.baseUrl)
    };
  }

  storePrepared(profileId: string, credential: PreparedCredential): void {
    try {
      this.db.prepare(`
        INSERT INTO credentials(profile_id, encrypted_secret, provider, base_url, updated_at)
        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(profile_id) DO UPDATE SET
          encrypted_secret = excluded.encrypted_secret,
          provider = excluded.provider,
          base_url = excluded.base_url,
          updated_at = excluded.updated_at
      `).run(
        profileId,
        credential.encryptedSecret,
        credential.provider,
        credential.baseUrl
      );
    } catch {
      throw new Error("Credential could not be stored");
    }
  }

  updateConnection(profileId: string, connection: CredentialConnection): void {
    try {
      this.db.prepare(`
        UPDATE credentials
        SET provider = ?, base_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE profile_id = ?
      `).run(connection.provider, canonicalCredentialBaseUrl(connection.baseUrl), profileId);
    } catch {
      throw new Error("Credential binding could not be updated");
    }
  }

  findPrepared(connection: CredentialConnection): PreparedCredential | undefined {
    let targetCanonical: string;
    try {
      targetCanonical = canonicalCredentialBaseUrl(connection.baseUrl);
    } catch {
      targetCanonical = connection.baseUrl;
    }
    const rows = this.db.prepare(`
      SELECT encrypted_secret, provider, base_url
      FROM credentials
      WHERE provider = ?
    `).all(connection.provider) as Array<{
      encrypted_secret: Buffer;
      provider: ProviderKind;
      base_url: string;
    }>;
    const match = rows.find((item) => {
      try {
        return canonicalCredentialBaseUrl(item.base_url) === targetCanonical;
      } catch {
        return item.base_url === connection.baseUrl;
      }
    });
    if (!match) return undefined;
    return {
      encryptedSecret: match.encrypted_secret,
      provider: match.provider,
      baseUrl: match.base_url
    };
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

  async withSecret<T>(
    profileId: string,
    connection: CredentialConnection,
    use: (apiKey?: string) => Promise<T>
  ): Promise<T> {
    const row = this.db.prepare(`
      SELECT credentials.encrypted_secret,
             credentials.provider AS credential_provider,
             credentials.base_url AS credential_base_url,
             model_profiles.provider AS profile_provider,
             model_profiles.base_url AS profile_base_url
      FROM credentials
      JOIN model_profiles ON model_profiles.id = credentials.profile_id
      WHERE credentials.profile_id = ?
    `).get(profileId) as StoredCredentialRow | undefined;
    let encryptedSecret = row?.encrypted_secret;
    if (!row) {
      const fallback = this.findPrepared(connection);
      if (!fallback) return use();
      encryptedSecret = fallback.encryptedSecret;
    } else {
      if (row.credential_provider !== row.profile_provider
        || canonicalCredentialBaseUrl(row.credential_base_url)
          !== canonicalCredentialBaseUrl(row.profile_base_url)
        || row.credential_provider !== connection.provider
        || canonicalCredentialBaseUrl(row.credential_base_url)
          !== canonicalCredentialBaseUrl(connection.baseUrl)) {
        throw new Error("Credential binding does not match profile");
      }
    }

    await this.assertStorageAvailable();

    let apiKey: string;
    try {
      if (!encryptedSecret) throw new Error("Credential could not be read");
      apiKey = await this.protector.decrypt(encryptedSecret);
    } catch {
      throw new Error("Credential could not be read");
    }

    try {
      return await use(apiKey);
    } catch (reason) {
      if (containsSecret(reason, apiKey)) throw new Error("Credential could not be used");
      throw reason;
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
