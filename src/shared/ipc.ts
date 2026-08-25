import type { CreateProjectInput, ProjectDto, ProjectIdInput, RenameProjectInput } from "./projects";
import type { Result } from "./app-errors";
import type {
  CredentialInput,
  CredentialProfileInput,
  CredentialStatusDto,
  DefaultModelRoutesDto,
  DeleteModelProfileInput,
  DiscoverModelsInput,
  ModelDescriptorDto,
  ModelProfileDto,
  ModelProfileListDto,
  ModelTestResultDto,
  SaveModelProfileInput,
  SetDefaultModelRoutesInput,
  TestModelInput
} from "./models";
import type { AppSettingsDto, UpdateAppSettingsInput } from "./settings";
import type { AppTheme } from "./settings";

export const PROJECT_CHANNELS = {
  list: "projects:list",
  create: "projects:create",
  rename: "projects:rename",
  archive: "projects:archive",
  remove: "projects:remove"
} as const;

export const SETTINGS_CHANNELS = {
  get: "settings:v1:get",
  update: "settings:v1:update"
} as const;

export const MODEL_CHANNELS = {
  listProfiles: "models:v1:list-profiles",
  getDefaultRoutes: "models:v1:get-default-routes",
  setDefaultRoutes: "models:v1:set-default-routes",
  saveProfile: "models:v1:save-profile",
  deleteProfile: "models:v1:delete-profile",
  discover: "models:v1:discover",
  test: "models:v1:test"
} as const;

export const CREDENTIAL_CHANNELS = {
  set: "credentials:v1:set",
  remove: "credentials:v1:remove"
} as const;

export const TITLE_OVERLAY_CHANNELS = {
  setTheme: "window:v1:set-title-overlay"
} as const;

export interface DesktopApi {
  projects: {
    list(): Promise<ProjectDto[]>;
    create(input: CreateProjectInput): Promise<ProjectDto>;
    rename(input: RenameProjectInput): Promise<ProjectDto>;
    archive(input: ProjectIdInput): Promise<ProjectDto>;
    remove(input: ProjectIdInput): Promise<void>;
  };
  settings: {
    get(): Promise<Result<AppSettingsDto>>;
    update(input: UpdateAppSettingsInput): Promise<Result<AppSettingsDto>>;
  };
  models: {
    listProfiles(): Promise<Result<ModelProfileListDto>>;
    getDefaultRoutes(): Promise<Result<DefaultModelRoutesDto>>;
    setDefaultRoutes(input: SetDefaultModelRoutesInput): Promise<Result<DefaultModelRoutesDto>>;
    saveProfile(input: SaveModelProfileInput): Promise<Result<ModelProfileDto>>;
    deleteProfile(input: DeleteModelProfileInput): Promise<Result<void>>;
    discover(input: DiscoverModelsInput): Promise<Result<ModelDescriptorDto[]>>;
    test(input: TestModelInput): Promise<Result<ModelTestResultDto>>;
  };
  credentials: {
    set(input: CredentialInput): Promise<Result<CredentialStatusDto>>;
    remove(input: CredentialProfileInput): Promise<Result<CredentialStatusDto>>;
  };
  titleOverlay: {
    setTheme(input: { theme: AppTheme }): Promise<Result<void>>;
  };
}
