import { randomUUID } from "node:crypto";
import {
  createProjectInputSchema,
  projectDtoSchema,
  projectIdInputSchema,
  renameProjectInputSchema,
  type CreateProjectInput,
  type ProjectDto,
  type ProjectIdInput,
  type RenameProjectInput
} from "../../shared/projects";
import type { ProjectRepository } from "./project-repository";

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly createId: () => string = randomUUID
  ) {}

  list(): ProjectDto[] {
    return projectDtoSchema.array().parse(this.repository.list());
  }

  create(input: CreateProjectInput): ProjectDto {
    const parsed = createProjectInputSchema.parse(input);
    return projectDtoSchema.parse(
      this.repository.create({ id: this.createId(), name: parsed.name })
    );
  }

  rename(input: RenameProjectInput): ProjectDto {
    const parsed = renameProjectInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.rename(parsed.id, parsed.name));
  }

  archive(input: ProjectIdInput): ProjectDto {
    const parsed = projectIdInputSchema.parse(input);
    return projectDtoSchema.parse(this.repository.archive(parsed.id));
  }

  remove(input: ProjectIdInput): void {
    const parsed = projectIdInputSchema.parse(input);
    this.repository.remove(parsed.id);
  }
}
