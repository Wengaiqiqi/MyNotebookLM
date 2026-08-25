import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../db/database";
import { modelProfileInputSchema } from "../../shared/models";
import { SettingsRepository } from "./settings-repository";
import {
  BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
} from "../models/local-embedding-profile";

const GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const EMBEDDING_ID = "33333333-3333-4333-8333-333333333333";

describe("SettingsRepository", () => {
  let temporaryRoot: string;
  let appDatabase: AppDatabase;
  let repository: SettingsRepository;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "mynotebooklm-settings-"));
    appDatabase = openAppDatabase(
      path.join(temporaryRoot, "app.db"),
      path.resolve("src/main/db/migrations")
    );
    repository = new SettingsRepository(appDatabase.connection);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("reads safe defaults and persists onboarding preferences", () => {
    expect(repository.getSettings()).toEqual({
      onboardingCompleted: false,
      locale: "zh-CN",
      theme: "light"
    });

    expect(repository.updateSettings({
      onboardingCompleted: true,
      locale: "en",
      theme: "dark"
    })).toMatchObject({ onboardingCompleted: true, locale: "en", theme: "dark" });
  });

  it("creates, updates, lists, and deletes model profiles without duplicate IDs", () => {
    repository.saveProfile({
      id: GENERATION_ID,
      name: "Primary",
      provider: "openai",
      capability: "generation",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
      enabled: true
    });
    repository.saveProfile({
      id: GENERATION_ID,
      name: "Primary renamed",
      provider: "openai-compatible",
      capability: "generation",
      baseUrl: "https://example.test/v1",
      modelId: "custom-test",
      enabled: false
    });

    expect(repository.listProfiles()).toHaveLength(1);
    expect(repository.listProfiles()[0]).toMatchObject({
      id: GENERATION_ID,
      name: "Primary renamed",
      provider: "openai-compatible",
      enabled: false
    });

    repository.deleteProfile(GENERATION_ID);
    expect(repository.listProfiles()).toEqual([]);
  });

  it("replaces routes transactionally and preserves requested order", () => {
    for (const profile of [
      { id: GENERATION_ID, name: "Primary" },
      { id: FALLBACK_ID, name: "Fallback" }
    ]) {
      repository.saveProfile({
        ...profile,
        provider: "openai",
        capability: "generation",
        baseUrl: "https://api.openai.com/v1",
        modelId: profile.name.toLowerCase(),
        enabled: true
      });
    }

    repository.replaceRoute("chat", [FALLBACK_ID, GENERATION_ID]);

    expect(repository.getRoute("chat")).toEqual([
      { taskKind: "chat", position: 0, profileId: FALLBACK_ID },
      { taskKind: "chat", position: 1, profileId: GENERATION_ID }
    ]);
  });

  it("rejects a profile whose capability cannot serve the route", () => {
    repository.saveProfile({
      id: EMBEDDING_ID,
      name: "Embedding",
      provider: "openai",
      capability: "embedding",
      baseUrl: "https://api.openai.com/v1",
      modelId: "embedding-test",
      enabled: true
    });

    expect(() => repository.replaceRoute("chat", [EMBEDDING_ID])).toThrow(/capability/i);
    expect(repository.getRoute("chat")).toEqual([]);
  });

  it("rejects generation profiles from the embedding route", () => {
    repository.saveProfile({
      id: GENERATION_ID,
      name: "Generation",
      provider: "openai",
      capability: "generation",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
      enabled: true
    });

    expect(() => repository.replaceRoute("embedding", [GENERATION_ID])).toThrow(/capability/i);
    expect(repository.getRoute("embedding")).toEqual([]);
  });

  it("allows the built-in local model to be selected as the embedding route", () => {
    expect(repository.replaceRoute("embedding", [
      BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
    ])).toEqual([{
      taskKind: "embedding",
      position: 0,
      profileId: BUILT_IN_LOCAL_EMBEDDING_PROFILE_ID
    }]);
  });

  it.each([
    ["anthropic", "embedding"],
    ["local", "generation"]
  ] as const)("rejects the invalid %s/%s provider capability pair in Zod", (provider, capability) => {
    expect(() => modelProfileInputSchema.parse({
      id: GENERATION_ID,
      name: "Invalid",
      provider,
      capability,
      baseUrl: "",
      modelId: "model-test",
      enabled: true
    })).toThrow(/capability|provider/i);
  });

  it.each([
    ["anthropic", "embedding"],
    ["local", "generation"]
  ] as const)("rejects the invalid %s/%s provider capability pair in SQLite", (provider, capability) => {
    expect(() => appDatabase.connection.prepare(`
      INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      GENERATION_ID,
      "Invalid",
      provider,
      capability,
      "",
      "model-test"
    )).toThrow(/check/i);
  });

  it("does not let a profile update invalidate an existing route", () => {
    const profile = {
      id: GENERATION_ID,
      name: "Primary",
      provider: "openai" as const,
      capability: "generation" as const,
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
      enabled: true
    };
    repository.saveProfile(profile);
    repository.replaceRoute("chat", [GENERATION_ID]);

    expect(() => repository.saveProfile({
      ...profile,
      capability: "embedding"
    })).toThrow(/route|capability/i);
    expect(repository.getProfile(GENERATION_ID)?.capability).toBe("generation");
  });
});
