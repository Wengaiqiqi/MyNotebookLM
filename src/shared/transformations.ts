import { z } from "zod";
import { modelTaskKindSchema, providerKindSchema } from "./models";

export const transformationAppliesToSchema = z.enum(["source", "sources", "message", "answer", "note"]);
export const transformationNameSchema = z.string().trim().min(1).max(100);
const allowedPlaceholder = /\{\{(?:content|source_title|project_name|language)\}\}/g;
const invalidTemplateSyntax = /\{\{|\}\}|\$\{|<%|%>|\{%|%\}|<\/?[a-z][^>]*>|javascript\s*:/i;
export const transformationPromptSchema = z.string().trim().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 20 * 1024,
  "Transformation prompt must be at most 20 KiB"
).refine(
  (value) => !invalidTemplateSyntax.test(value.replace(allowedPlaceholder, "")),
  "Transformation prompt contains an unsupported template expression"
);

const transformationFieldsSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: transformationNameSchema,
  appliesTo: transformationAppliesToSchema,
  prompt: transformationPromptSchema,
  version: z.number().int().positive(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

export const transformationDtoSchema = transformationFieldsSchema;
export const createTransformationInputSchema = z.object({
  projectId: z.uuid(),
  name: transformationNameSchema,
  appliesTo: transformationAppliesToSchema,
  prompt: transformationPromptSchema
}).strict();
export const updateTransformationInputSchema = createTransformationInputSchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  enabled: z.boolean()
}).strict();
export const transformationIdInputSchema = z.object({ projectId: z.uuid(), id: z.uuid() }).strict();

export const insightUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();
export const insightDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  transformationId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  inputKind: transformationAppliesToSchema.nullable(),
  inputHash: z.string().trim().min(1).nullable(),
  ruleVersion: z.number().int().positive().nullable(),
  content: z.string(),
  provider: providerKindSchema.nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
  profileId: z.uuid().nullable(),
  usage: insightUsageSchema.nullable(),
  idempotencyKey: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();

export const transformationRunInputSchema = z.object({
  projectId: z.uuid(),
  transformationId: z.uuid(),
  sourceRevisionIds: z.array(z.uuid()).max(100).optional(),
  messageId: z.uuid().optional(),
  noteId: z.uuid().optional(),
  profileId: z.uuid().optional()
}).strict();

export type TransformationAppliesTo = z.infer<typeof transformationAppliesToSchema>;
export type TransformationDto = z.infer<typeof transformationDtoSchema>;
export type CreateTransformationInput = z.infer<typeof createTransformationInputSchema>;
export type UpdateTransformationInput = z.infer<typeof updateTransformationInputSchema>;
export type TransformationIdInput = z.infer<typeof transformationIdInputSchema>;
export type InsightUsage = z.infer<typeof insightUsageSchema>;
export type InsightDto = z.infer<typeof insightDtoSchema>;
export type TransformationRunInput = z.infer<typeof transformationRunInputSchema>;
