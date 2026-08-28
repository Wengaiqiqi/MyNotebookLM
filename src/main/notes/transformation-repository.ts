import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createTransformationInputSchema,
  transformationDtoSchema,
  transformationPromptSchema,
  updateTransformationInputSchema,
  type CreateTransformationInput,
  type TransformationDto,
  type UpdateTransformationInput
} from "../../shared/transformations";

type TransformationRow = {
  id: string;
  project_id: string;
  name: string;
  applies_to: string;
  prompt: string;
  version: number;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

export class TransformationNotFoundError extends Error {
  constructor(id: string) {
    super(`Transformation not found: ${id}`);
    this.name = "TransformationNotFoundError";
  }
}

export class TransformationVersionConflictError extends Error {
  constructor(id: string) {
    super(`Transformation version changed concurrently: ${id}`);
    this.name = "TransformationVersionConflictError";
  }
}

export class TransformationProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Transformation project not found: ${projectId}`);
    this.name = "TransformationProjectNotFoundError";
  }
}

function toTransformation(row: TransformationRow): TransformationDto {
  return transformationDtoSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    appliesTo: row.applies_to,
    prompt: row.prompt,
    version: row.version,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export class TransformationRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateTransformationInput & { id: string }): TransformationDto {
    const parsed = createTransformationInputSchema.extend({ id: z.uuid() }).parse(input);
    if (!this.projectExists(parsed.projectId)) throw new TransformationProjectNotFoundError(parsed.projectId);
    transformationPromptSchema.parse(parsed.prompt);
    try {
      this.db.prepare(`
        INSERT INTO transformations(id, project_id, name, applies_to, prompt, version, enabled)
        VALUES (@id, @projectId, @name, @appliesTo, @prompt, 1, 1)
      `).run({ ...parsed, id: input.id });
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) throw new Error("Transformation ID already exists");
      throw error;
    }
    return this.read(parsed.projectId, input.id);
  }

  get(projectId: string, id: string): TransformationDto | undefined {
    const row = this.db.prepare("SELECT * FROM transformations WHERE id = ? AND project_id = ?")
      .get(id, projectId) as TransformationRow | undefined;
    return row ? toTransformation(row) : undefined;
  }

  list(projectId: string, options: { enabledOnly?: boolean } = {}): TransformationDto[] {
    const enabled = options.enabledOnly ? " AND enabled = 1" : "";
    return (this.db.prepare(`
      SELECT * FROM transformations
      WHERE project_id = ?${enabled}
      ORDER BY updated_at DESC, id ASC
    `).all(projectId) as TransformationRow[]).map(toTransformation);
  }

  update(input: UpdateTransformationInput): TransformationDto {
    const parsed = updateTransformationInputSchema.parse(input);
    const current = this.get(parsed.projectId, parsed.id);
    if (!current) throw new TransformationNotFoundError(parsed.id);
    if (current.version !== parsed.version) throw new TransformationVersionConflictError(parsed.id);
    if (current.name === parsed.name && current.appliesTo === parsed.appliesTo
      && current.prompt === parsed.prompt && current.enabled === parsed.enabled) return current;

    const result = this.db.prepare(`
      UPDATE transformations
      SET name = @name, applies_to = @appliesTo, prompt = @prompt, enabled = @enabled,
          version = version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id AND project_id = @projectId AND version = @version
    `).run({ ...parsed, enabled: parsed.enabled ? 1 : 0 });
    if (result.changes === 0) {
      if (!this.get(parsed.projectId, parsed.id)) throw new TransformationNotFoundError(parsed.id);
      throw new TransformationVersionConflictError(parsed.id);
    }
    return this.read(parsed.projectId, parsed.id);
  }

  remove(projectId: string, id: string, version: number): void {
    const current = this.get(projectId, id);
    if (!current) throw new TransformationNotFoundError(id);
    if (current.version !== version) throw new TransformationVersionConflictError(id);
    const result = this.db.prepare("DELETE FROM transformations WHERE id = ? AND project_id = ? AND version = ?")
      .run(id, projectId, version);
    if (result.changes === 0) {
      if (!this.get(projectId, id)) throw new TransformationNotFoundError(id);
      throw new TransformationVersionConflictError(id);
    }
  }

  delete(projectId: string, id: string, version: number): void {
    this.remove(projectId, id, version);
  }

  private projectExists(projectId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId));
  }

  private read(projectId: string, id: string): TransformationDto {
    const result = this.get(projectId, id);
    if (!result) throw new TransformationNotFoundError(id);
    return result;
  }
}
