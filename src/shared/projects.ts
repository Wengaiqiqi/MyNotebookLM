import { z } from "zod";

export const projectDtoSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(80)
});

export const renameProjectInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80)
});

export const projectIdInputSchema = z.object({ id: z.uuid() });

export type ProjectDto = z.infer<typeof projectDtoSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type RenameProjectInput = z.infer<typeof renameProjectInputSchema>;
export type ProjectIdInput = z.infer<typeof projectIdInputSchema>;
