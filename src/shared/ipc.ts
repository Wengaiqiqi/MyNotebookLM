import type { CreateProjectInput, ProjectDto, ProjectIdInput, RenameProjectInput } from "./projects";

export const PROJECT_CHANNELS = {
  list: "projects:list",
  create: "projects:create",
  rename: "projects:rename",
  archive: "projects:archive",
  remove: "projects:remove"
} as const;

export interface DesktopApi {
  projects: {
    list(): Promise<ProjectDto[]>;
    create(input: CreateProjectInput): Promise<ProjectDto>;
    rename(input: RenameProjectInput): Promise<ProjectDto>;
    archive(input: ProjectIdInput): Promise<ProjectDto>;
    remove(input: ProjectIdInput): Promise<void>;
  };
}
