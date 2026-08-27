import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { SettingsRepository } from "../settings/settings-repository";
import { RouteRepository } from "./route-repository";

const GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const EMBEDDING_ID = "33333333-3333-4333-8333-333333333333";

function profile(id: string, capability: "generation" | "embedding") {
  return {
    id,
    name: id,
    provider: "openai" as const,
    capability,
    baseUrl: "https://api.openai.com/v1",
    modelId: id,
    enabled: true
  };
}

describe("RouteRepository", () => {
  let root: string;
  let db: AppDatabase;
  let repository: RouteRepository;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-route-"));
    db = openAppDatabase(path.join(root, "app.db"), path.resolve("src/main/db/migrations"));
    repository = new RouteRepository(new SettingsRepository(db.connection));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses settings route persistence and keeps configured order", () => {
    repository.saveProfile(profile(GENERATION_ID, "generation"));
    repository.saveProfile(profile(FALLBACK_ID, "generation"));

    expect(repository.replaceRoute("chat", [FALLBACK_ID, GENERATION_ID])).toEqual([
      { taskKind: "chat", position: 0, profileId: FALLBACK_ID },
      { taskKind: "chat", position: 1, profileId: GENERATION_ID }
    ]);
    expect(repository.getRoute("chat")).toEqual([
      { taskKind: "chat", position: 0, profileId: FALLBACK_ID },
      { taskKind: "chat", position: 1, profileId: GENERATION_ID }
    ]);
  });

  it("rejects duplicate IDs and invalid empty or embedding routes", () => {
    repository.saveProfile(profile(GENERATION_ID, "generation"));
    repository.saveProfile(profile(EMBEDDING_ID, "embedding"));

    expect(() => repository.replaceRoute("chat", [])).toThrow(/at least one/i);
    expect(() => repository.replaceRoute("chat", [GENERATION_ID, GENERATION_ID])).toThrow(/duplicate/i);
    expect(() => repository.replaceRoute("embedding", [])).toThrow(/exactly one/i);
    expect(() => repository.replaceRoute("embedding", [EMBEDDING_ID, GENERATION_ID])).toThrow(/exactly one/i);
  });
});
