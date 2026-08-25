import { safeStorage } from "electron";
import type { SecretProtector } from "./credential-store";

export class SafeStorageAdapter implements SecretProtector {
  async isAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable();
  }

  async encrypt(value: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(value);
  }

  async decrypt(value: Buffer): Promise<string> {
    return (await safeStorage.decryptStringAsync(value)).result;
  }
}
