import type Database from "better-sqlite3";
import {
  modelProfileDtoSchema,
  modelProfileInputSchema,
  generationLimitsSchema,
  modelRouteDtoSchema,
  modelTaskKindSchema,
  modelOutputKind,
  type ModelCapability,
  type ModelProfileDto,
  type ModelProfileInput,
  type GenerationLimits,
  type ModelRouteDto,
  type ModelRouteAttemptDto,
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
  context_tokens_override?: number | null;
  max_output_tokens_override?: number | null;
  generation_limits_json?: string | null;
  output_kind?: string | null;
  speech_voices_json?: string | null;
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

function parseGenerationLimits(value: string | null | undefined): GenerationLimits | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = generationLimitsSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function toProfile(row: ProfileRow): ModelProfileDto {
  const cachedLimits = parseGenerationLimits(row.generation_limits_json);
  const generationLimits = cachedLimits?.identity.provider === row.provider
    && cachedLimits.identity.modelId === row.model_id
    && cachedLimits.identity.baseUrl.replace(/\/+$/, "") === row.base_url.replace(/\/+$/, "") ? cachedLimits : undefined;
  return modelProfileDtoSchema.parse({
    id: row.id,
    name: row.name,
    provider: row.provider,
    capability: row.capability,
    baseUrl: row.base_url,
    modelId: row.model_id,
    ...(row.output_kind ? { outputKind: row.output_kind } : {}),
    ...(row.speech_voices_json ? { speechVoices: JSON.parse(row.speech_voices_json) } : {}),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contextTokensOverride: row.context_tokens_override,
    maxOutputTokensOverride: row.max_output_tokens_override,
    ...(generationLimits ? { generationLimits } : {})
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
  private readonly supportsGenerationColumns: boolean;
  private readonly supportsOutputKind: boolean;
  private readonly supportsSpeechVoices: boolean;

  constructor(private readonly db: Database.Database) {
    const columns = db.pragma("table_info(model_profiles)") as Array<{ name: string }>;
    this.supportsOutputKind = columns.some((column) => column.name === "output_kind");
    this.supportsSpeechVoices = columns.some((column) => column.name === "speech_voices_json");
    this.supportsGenerationColumns = ["context_tokens_override", "max_output_tokens_override", "generation_limits_json"].every((name) => columns.some((column) => column.name === name));
  }

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
    if (existing && (existing.capability !== profile.capability || modelOutputKind(existing) !== modelOutputKind(profile))) {
      const routeCount = this.db.prepare(
        "SELECT count(*) AS count FROM model_routes WHERE profile_id = ?"
      ).get(profile.id) as { count: number };
      if (routeCount.count > 0) {
        throw new Error("Profile capability cannot change while the profile is used by a route");
      }
    }
    const sql = this.supportsGenerationColumns ? `
      INSERT INTO model_profiles(id, name, provider, capability, base_url, model_id, enabled)
      VALUES (@id, @name, @provider, @capability, @baseUrl, @modelId, @enabled)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        capability = excluded.capability,
        base_url = excluded.base_url,
        model_id = excluded.model_id,
        enabled = excluded.enabled,
        generation_limits_json = CASE
          WHEN model_profiles.provider <> excluded.provider
            OR model_profiles.base_url <> excluded.base_url
            OR model_profiles.model_id <> excluded.model_id
          THEN NULL
          ELSE model_profiles.generation_limits_json
        END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ` : `
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
    `;
    this.db.prepare(sql).run({ ...profile, enabled: profile.enabled ? 1 : 0 });
    if (this.supportsOutputKind) this.db.prepare("UPDATE model_profiles SET output_kind = ? WHERE id = ?").run(profile.outputKind ?? null, profile.id);
    if (this.supportsSpeechVoices) this.db.prepare("UPDATE model_profiles SET speech_voices_json = ? WHERE id = ?").run(profile.speechVoices ? JSON.stringify(profile.speechVoices) : null, profile.id);
    return this.getProfile(profile.id)!;
  }

  updateGenerationSettings(input: {
    profileId: string;
    contextTokensOverride?: number | null;
    maxOutputTokensOverride?: number | null;
  }): ModelProfileDto {
    if (!this.supportsGenerationColumns) throw new Error("Generation settings are unavailable in this database schema");
    const current = this.getProfile(input.profileId);
    if (!current) throw new Error("Profile not found");
    const contextTokensOverride = input.contextTokensOverride === undefined
      ? current.contextTokensOverride ?? null
      : input.contextTokensOverride;
    const maxOutputTokensOverride = input.maxOutputTokensOverride === undefined
      ? current.maxOutputTokensOverride ?? null
      : input.maxOutputTokensOverride;
    this.db.prepare(`
      UPDATE model_profiles
      SET context_tokens_override = ?,
          max_output_tokens_override = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(contextTokensOverride, maxOutputTokensOverride, input.profileId);
    return this.getProfile(input.profileId)!;
  }

  updateGenerationLimits(profileId: string, limits: GenerationLimits | null): ModelProfileDto {
    if (!this.supportsGenerationColumns) throw new Error("Generation settings are unavailable in this database schema");
    if (!this.getProfile(profileId)) throw new Error("Profile not found");
    const parsed = limits === null ? null : generationLimitsSchema.parse(limits);
    this.db.prepare(`
      UPDATE model_profiles
      SET generation_limits_json = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(parsed === null ? null : JSON.stringify(parsed), profileId);
    return this.getProfile(profileId)!;
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

  listRouteAttempts(input: { projectId: string; operationId?: string; taskKind?: ModelTaskKind; limit?: number; offset?: number }): ModelRouteAttemptDto[] {
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    // This endpoint feeds the routing panel's fallback history. Keep manual
    // retries out: they are attempts, not automatic fallback transitions.
    const clauses = ["project_id = ?", "is_fallback = 1"];
    const params: Array<string | number> = [input.projectId];
    if (input.operationId !== undefined) { clauses.push("operation_id = ?"); params.push(input.operationId); }
    if (input.taskKind !== undefined) { clauses.push("task_kind = ?"); params.push(modelTaskKindSchema.parse(input.taskKind)); }
    params.push(limit, offset);
    const rows = this.db.prepare(`SELECT id, project_id, operation_id, task_kind, attempt_order, profile_id, provider, model, state, error_code, latency_ms, started_at, completed_at, finished_at, created_at FROM model_route_attempts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, attempt_order ASC, id ASC LIMIT ? OFFSET ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: row.id as string, projectId: row.project_id as string, operationId: row.operation_id as string, taskKind: row.task_kind as ModelTaskKind, attemptOrder: row.attempt_order as number, profileId: row.profile_id as string | null, provider: row.provider as ModelRouteAttemptDto["provider"], model: row.model as string, state: row.state as ModelRouteAttemptDto["state"], errorCode: row.error_code as string | null, latencyMs: row.latency_ms as number | null, startedAt: row.started_at as string, completedAt: row.completed_at as string | null, finishedAt: row.finished_at as string | null, createdAt: row.created_at as string }));
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
      if (profiles.some((profile) => !profile!.enabled)) {
        throw new Error("Route requires enabled profile");
      }
      if (parsedTask === "podcast") {
        if (!["text", "speech"].every((kind) => profiles.some((profile) => modelOutputKind(profile!) === kind))) throw new Error("Podcast route requires text and speech models");
      } else if (profiles.some((profile) => profile!.capability === "generation" && modelOutputKind(profile!) === "speech")) {
        throw new Error("Text tasks cannot use speech models");
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
      if (generationProfile.capability !== "generation" || modelOutputKind(generationProfile) !== "text") {
        throw new Error("Generation default route requires generation capability");
      }
      if (embeddingProfile.capability !== "embedding") {
        throw new Error("Embedding default route requires embedding capability");
      }
      if (!generationProfile.enabled || !embeddingProfile.enabled) {
        throw new Error("Default route requires enabled profiles");
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
