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
import type { SourceDto } from "./sources";
import type { TaskDto } from "./tasks";
import type { RetrievalSearchInput, SearchHitDto, VectorHealthDto, VectorProfileInput, VectorSpaceInput, VectorTaskIdInput, VectorTaskInput } from "./vector";

export const SOURCE_CHANNELS = { chooseFiles: "sources:v1:choose-files", importFile: "sources:v1:import-file", importUrl: "sources:v1:import-url", list: "sources:v1:list", remove: "sources:v1:remove", retry: "sources:v1:retry", cancel: "tasks:v1:cancel", listTasks: "tasks:v1:list", subscribe: "tasks:v1:subscribe", update: "tasks:v1:update" } as const;

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
export const VECTOR_CHANNELS = { getHealth: "vector:v1:get-health", startMigration: "vector:v1:start-migration", rebuild: "vector:v1:rebuild", optimize: "vector:v1:optimize", cancelTask: "vector:v1:cancel-task", taskUpdate: "vector:v1:task-update" } as const;
export const RETRIEVAL_CHANNELS = { search: "retrieval:v1:search" } as const;

export interface DesktopApi {
  vector: { getHealth(input: VectorTaskInput): Promise<Result<VectorHealthDto>>; startMigration(input: VectorProfileInput): Promise<Result<TaskDto>>; rebuild(input: VectorSpaceInput): Promise<Result<TaskDto>>; optimize(input: VectorSpaceInput): Promise<Result<TaskDto>>; cancelTask(input: VectorTaskIdInput): Promise<Result<TaskDto>>; subscribe(projectId: string, listener: (task: TaskDto) => void): () => void; };
  retrieval: { search(input: RetrievalSearchInput): Promise<Result<SearchHitDto[]>> };
  sources?: { chooseFiles(input: { projectId: string }): Promise<string[] | null>; importFile(input: { projectId: string; dialogToken: string }): Promise<Result<SourceDto>>; importUrl(input: { projectId: string; url: string }): Promise<Result<SourceDto>>; list(input: { projectId: string }): Promise<SourceDto[]>; remove(input: { projectId: string; sourceId: string }): Promise<Result<void>>; retry(input: { projectId: string; sourceId: string }): Promise<Result<TaskDto>>; };
  tasks?: { list(input: { projectId: string }): Promise<TaskDto[]>; cancel(input: { projectId: string; taskId: string }): Promise<Result<TaskDto>>; subscribe(projectId: string, listener: (task: TaskDto) => void): () => void; };
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
