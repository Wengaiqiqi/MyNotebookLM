import type {
  ModelProfileDto,
  ModelProfileInput,
  ModelRouteDto,
  ModelTaskKind
} from "../../shared/models";
import type { SettingsRepository } from "../settings/settings-repository";

/** Route persistence facade; SettingsRepository remains the single SQLite route authority. */
export class RouteRepository {
  constructor(
    private readonly settings: Pick<SettingsRepository,
      "getProfile" | "listProfiles" | "saveProfile" | "getRoute" | "replaceRoute" | "replaceDefaultRoutes">
  ) {}

  listProfiles(): ModelProfileDto[] {
    return this.settings.listProfiles();
  }

  getProfile(id: string): ModelProfileDto | undefined {
    return this.settings.getProfile(id);
  }

  saveProfile(input: ModelProfileInput): ModelProfileDto {
    return this.settings.saveProfile(input);
  }

  getRoute(taskKind: ModelTaskKind): ModelRouteDto[] {
    return this.settings.getRoute(taskKind);
  }

  replaceRoute(taskKind: ModelTaskKind, profileIds: readonly string[]): ModelRouteDto[] {
    return this.settings.replaceRoute(taskKind, profileIds);
  }

  replaceDefaultRoutes(generationProfileId: string, embeddingProfileId: string): void {
    this.settings.replaceDefaultRoutes(generationProfileId, embeddingProfileId);
  }
}
