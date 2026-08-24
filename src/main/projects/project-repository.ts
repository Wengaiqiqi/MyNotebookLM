import type Database from "better-sqlite3";
import { projectDtoSchema, type ProjectDto } from "../../shared/projects";

type ProjectRow = {
  id: string;
  name: string;
  archived: 0 | 1;
  created_at: string;
  updated_at: string;
};

function toProjectDto(row: ProjectRow): ProjectDto {
  return projectDtoSchema.parse({
    id: row.id,
    name: row.name,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project not found: ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  list(options: { includeArchived?: boolean } = {}): ProjectDto[] {
    const sql = options.includeArchived
      ? "SELECT * FROM projects ORDER BY updated_at DESC"
      : "SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all() as ProjectRow[]).map(toProjectDto);
  }

  create(input: { id: string; name: string }): ProjectDto {
    this.db.prepare("INSERT INTO projects(id, name) VALUES (?, ?)").run(input.id, input.name);
    return this.read(input.id);
  }

  rename(id: string, name: string): ProjectDto {
    const result = this.db.prepare(`
      UPDATE projects
      SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(name, id);
    if (result.changes === 0) throw new ProjectNotFoundError(id);
    return this.read(id);
  }

  archive(id: string): ProjectDto {
    const result = this.db.prepare(`
      UPDATE projects
      SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(id);
    if (result.changes === 0) throw new ProjectNotFoundError(id);
    return this.read(id);
  }

  remove(id: string): void {
    if (this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes === 0) {
      throw new ProjectNotFoundError(id);
    }
  }

  private read(id: string): ProjectDto {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!row) throw new ProjectNotFoundError(id);
    return toProjectDto(row);
  }
}
