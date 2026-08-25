import { z } from "zod";
import { appErrorCodeSchema } from "./app-errors";

export const taskKindSchema = z.enum([
  "validation",
  "ingest",
  "delete"
]);

export const taskStateSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const taskStageSchema = z.enum([
  "validating",
  "staging",
  "parsing",
  "chunking",
  "embedding",
  "indexing",
  "verifying",
  "cleanup",
  "finalizing"
]);

export const taskProgressSchema = z.number().int().min(0).max(1000);

export const taskErrorSummaryDtoSchema = z.object({
  code: appErrorCodeSchema,
  messageKey: z.string().trim().min(1),
  recoverable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional()
}).strict();

export const taskDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceId: z.uuid().nullable(),
  kind: taskKindSchema,
  state: taskStateSchema,
  stage: taskStageSchema,
  progress: taskProgressSchema,
  attempt: z.number().int().nonnegative(),
  error: taskErrorSummaryDtoSchema.nullable(),
  idempotencyKey: z.string().trim().min(1).max(200).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

export type TaskKind = z.infer<typeof taskKindSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskStage = z.infer<typeof taskStageSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type TaskErrorSummaryDto = z.infer<typeof taskErrorSummaryDtoSchema>;
export type TaskDto = z.infer<typeof taskDtoSchema>;
