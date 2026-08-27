import type Database from "better-sqlite3";
import {
  modelProfileDtoSchema,
  modelProfileInputSchema,
  modelRouteDtoSchema,
  modelTaskKindSchema,
  type ModelCapability,
  type ModelProfileDto,
  type ModelProfileInput,
  type ModelRouteDto,
  type ModelTaskKind
} from "../../shared/models";
import {
  appSettingsDtoSchema,
  updateAppSettingsInputSchema,
  type AppSettingsDto,
  type UpdateAppSettingsInput
} from "../../shared/settings";
import {
  BUILT_IN_LOCAL_EMBEDDING_PROFILE,
  isBuiltInLocalEmbeddingProfile
} from "../models/local-embedding-profile";

type SettingsRow = {
  onboarding_completed: 0 | 1;
  locale: string;
  theme: string;
};

type ProfileRow = {
  id: string;
  name: string;
  provider: string;
  capability: string;
  base_url: string;
  model_id: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

type RouteRow = {
  task_kind: string;
  position: number;
  profile_id: string;
};

const defaultGenerationTasks = [
  "chat",
  "note-title",
  "summary",
  "key-points",
  "qa",
  "custom-transformation"
] as const;

function toSettings(row: SettingsRow): AppSettingsDto {
  return appSettingsDtoSchema.parse({
    onboardingCompleted: row.onboarding_completed === 1,
    locale: row.locale,
    theme: row.theme
  });
}

function toProfile(row: ProfileRow): ModelProfileDto {
  return modelProfileDtoSchema.parse({
    id: row.id,
    name: row.name,
    provider: row.provider,
    capability: row.capability,
    baseUrl: row.base_url,
    modelId: row.model_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toRoute(row: RouteRow): ModelRouteDto {
  return modelRouteDtoSchema.parse({
    taskKind: row.task_kind,
    position: row.position,
    profileId: row.profile_id
  });
}

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  getSettings(): AppSettingsDto {
    const row = this.db.prepare(`
      SELECT onboarding_completed, locale, theme
      FROM app_settings
      WHERE id = 1
    `).get() as SettingsRow;
    return toSettings(row);
  }

  updateSettings(input: UpdateAppSettingsInput): AppSettingsDto {
    const parsed = updateAppSettingsInputSchema.parse(input);
    const current = this.getSettings();
    this.db.prepare(`
      UPDATE app_settings
      SET onboarding_completed = ?, locale = ?, theme = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1
    `).run(
      (parsed.onboardingCompleted ?? current.onboardingCompleted) ? 1 : 0,
      parsed.locale ?? current.locale,
      parsed.theme ?? current.theme
    );
    return this.getSettings();
  }

  listProfiles(): ModelProfileDto[] {
    return (this.db.prepare(`
      SELECT * FROM model_profiles ORDER BY updated_at DESC, id ASC
    `).all() as ProfileRow[]).map(toProfile);
  }

  getProfile(id: string): ModelProfileDto | undefined {
    const row = this.db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as
      | ProfileRow
      | undefined;
    return row ? toProfile(row) : undefined;
  }

  saveProfile(input: ModelProfileInput): ModelProfileDto {
    const profile = modelProfileInputSchema.parse(input);
    const existing = this.getProfile(profile.id);
    if (existing && existing.capability !== profile.capability) {
      const routeCount = this.db.prepare(
        "SELECT count(*) AS count FROM model_routes WHERE profile_id = ?"
      ).get(profile.id) as { count: number };
      if (routeCount.count > 0) {
        throw new Error("Profile capability cannot change while the profile is used by a route");
      }
    }
    this.db.prepare(`
      INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled)
      VALUES (@id, @name, @provider, @capability, @baseUrl, @modelId, @enabled)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        capability = excluded.capability,
        base_url = excluded.base_url,
        model_id = excluded.model_id,
        enabled = excluded.enabled,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run({ ...profile, enabled: profile.enabled ? 1 : 0 });
    return this.getProfile(profile.id)!;
  }

  deleteProfile(id: string): void {
    this.db.prepare("DELETE FROM model_profiles WHERE id = ?").run(id);
  }

  getRoute(taskKind: ModelTaskKind): ModelRouteDto[] {
    const parsedTask = modelTaskKindSchema.parse(taskKind);
    return (this.db.prepare(`
      SELECT task_kind, position, profile_id
      FROM model_routes
      WHERE task_kind = ?
      ORDER BY position
    `).all(parsedTask) as RouteRow[]).map(toRoute);
  }

  replaceRoute(taskKind: ModelTaskKind, profileIds: readonly string[]): ModelRouteDto[] {
    const parsedTask = modelTaskKindSchema.parse(taskKind);
    if (profileIds.length === 0) {
      throw new Error(parsedTask === "embedding"
        ? "Embedding route requires exactly one profile"
        : "Route requires at least one profile");
    }
    if (parsedTask === "embedding" && profileIds.length !== 1) {
      throw new Error("Embedding route requires exactly one profile");
    }
    if (new Set(profileIds).size !== profileIds.length) {
      throw new Error("Route cannot contain duplicate profile IDs");
    }
    const requiredCapability: ModelCapability = parsedTask === "embedding"
      ? "embedding"
      : "generation";

    this.db.transaction(() => {
      if (profileIds.some(isBuiltInLocalEmbeddingProfile)
        && !this.getProfile(BUILT_IN_LOCAL_EMBEDDING_PROFILE.id)) {
        const { id, name, provider, capability, baseUrl, modelId, enabled } =
          BUILT_IN_LOCAL_EMBEDDING_PROFILE;
        this.saveProfile({ id, name, provider, capability, baseUrl, modelId, enabled });
      }
      const profiles = profileIds.map((id) => this.getProfile(id));
      if (profiles.some((profile) => !profile)) throw new Error("Route profile not found");
      if (profiles.some((profile) => profile!.capability !== requiredCapability)) {
        throw new Error(`Route requires ${requiredCapability} capability`);
      }

      this.db.prepare("DELETE FROM model_routes WHERE task_kind = ?").run(parsedTask);
      const insert = this.db.prepare(`
        INSERT INTO model_routes(task_kind, position, profile_id) VALUES (?, ?, ?)
      `);
      profileIds.forEach((profileId, position) => insert.run(parsedTask, position, profileId));
    })();

    return this.getRoute(parsedTask);
  }

  replaceDefaultRoutes(generationProfileId: string, embeddingProfileId: string): void {
    this.db.transaction(() => {
      if (isBuiltInLocalEmbeddingProfile(embeddingProfileId)
        && !this.getProfile(BUILT_IN_LOCAL_EMBEDDING_PROFILE.id)) {
        const { id, name, provider, capability, baseUrl, modelId, enabled } =
          BUILT_IN_LOCAL_EMBEDDING_PROFILE;
        this.saveProfile({ id, name, provider, capability, baseUrl, modelId, enabled });
      }

      const generationProfile = this.getProfile(generationProfileId);
      const embeddingProfile = this.getProfile(embeddingProfileId);
      if (!generationProfile || !embeddingProfile) throw new Error("Default route profile not found");
      if (generationProfile.capability !== "generation") {
        throw new Error("Generation default route requires generation capability");
      }
      if (embeddingProfile.capability !== "embedding") {
        throw new Error("Embedding default route requires embedding capability");
      }

      this.db.prepare(`
        DELETE FROM model_routes
        WHERE task_kind IN ('chat', 'note-title', 'summary', 'key-points', 'qa',
          'custom-transformation', 'embedding')
      `).run();
      const insert = this.db.prepare(`
        INSERT INTO model_routes(task_kind, position, profile_id) VALUES (?, 0, ?)
      `);
      for (const task of defaultGenerationTasks) insert.run(task, generationProfileId);
      insert.run("embedding", embeddingProfileId);
    })();
  }
}
