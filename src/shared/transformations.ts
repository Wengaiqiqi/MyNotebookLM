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
export const builtinTransformationDtoSchema = z.object({
  key: z.enum(["summary", "key-points", "qa"]), language: z.enum(["zh-CN", "en"]), name: z.string().trim().min(1).max(100),
  appliesTo: transformationAppliesToSchema, prompt: z.string().trim().min(1)
}).strict();

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
  transformationId: z.uuid().optional(),
  builtinKey: z.enum(["summary", "key-points", "qa"]).optional(),
  language: z.enum(["zh-CN", "en"]).optional(),
  projectTarget: z.literal(true).optional(),
  sourceRevisionId: z.uuid().optional(),
  sourceRevisionIds: z.array(z.uuid()).max(100).optional(),
  messageId: z.uuid().optional(),
  answerMessageId: z.uuid().optional(),
  noteId: z.uuid().optional(),
  profileId: z.uuid().optional(),
  force: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if ((value.transformationId === undefined) === (value.builtinKey === undefined)) {
    context.addIssue({ code: "custom", path: ["transformationId"], message: "Exactly one transformation rule is required" });
  }
  if (value.builtinKey !== undefined && value.language === undefined) {
    context.addIssue({ code: "custom", path: ["language"], message: "Builtin transformation language is required" });
  }
  const targets = [
    value.projectTarget === true,
    value.sourceRevisionId !== undefined || (value.sourceRevisionIds?.length ?? 0) > 0,
    value.messageId !== undefined,
    value.answerMessageId !== undefined,
    value.noteId !== undefined
  ].filter(Boolean).length;
  if (targets !== 1) context.addIssue({ code: "custom", path: ["projectId"], message: "Exactly one transformation target is required" });
  if (value.sourceRevisionId !== undefined && value.sourceRevisionIds !== undefined) context.addIssue({ code: "custom", path: ["sourceRevisionIds"], message: "Use one source target form" });
})

export type TransformationAppliesTo = z.infer<typeof transformationAppliesToSchema>;
export type TransformationDto = z.infer<typeof transformationDtoSchema>;
export type CreateTransformationInput = z.infer<typeof createTransformationInputSchema>;
export type UpdateTransformationInput = z.infer<typeof updateTransformationInputSchema>;
export type TransformationIdInput = z.infer<typeof transformationIdInputSchema>;
export type InsightUsage = z.infer<typeof insightUsageSchema>;
export type InsightDto = z.infer<typeof insightDtoSchema>;
export type TransformationRunInput = z.infer<typeof transformationRunInputSchema>;
export type BuiltinTransformationDto = z.infer<typeof builtinTransformationDtoSchema>;
