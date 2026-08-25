import { z } from "zod";

export const providerKindSchema = z.enum([
  "openai",
  "openai-compatible",
  "anthropic",
  "gemini",
  "ollama",
  "local"
]);

export const modelCapabilitySchema = z.enum(["generation", "embedding"]);

export const modelTaskKindSchema = z.enum([
  "chat",
  "note-title",
  "summary",
  "key-points",
  "qa",
  "custom-transformation",
  "embedding"
]);

const modelProfileFieldsSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  provider: providerKindSchema,
  capability: modelCapabilitySchema,
  baseUrl: z.string(),
  modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean()
}).strict();

function validateProviderCapability(
  profile: { provider: ProviderKind; capability: ModelCapability },
  context: z.RefinementCtx
): void {
  if (profile.provider === "anthropic" && profile.capability !== "generation") {
    context.addIssue({
      code: "custom",
      path: ["capability"],
      message: "Anthropic profiles only support generation"
    });
  }
  if (profile.provider === "local" && profile.capability !== "embedding") {
    context.addIssue({
      code: "custom",
      path: ["capability"],
      message: "Local profiles only support embedding"
    });
  }
}

export const modelProfileInputSchema = modelProfileFieldsSchema.superRefine(
  validateProviderCapability
);

export const modelProfileDtoSchema = modelProfileFieldsSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).superRefine(validateProviderCapability);

export const modelRouteDtoSchema = z.object({
  taskKind: modelTaskKindSchema,
  position: z.number().int().nonnegative(),
  profileId: z.uuid()
}).strict();

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type ModelTaskKind = z.infer<typeof modelTaskKindSchema>;
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>;
export type ModelProfileDto = z.infer<typeof modelProfileDtoSchema>;
export type ModelRouteDto = z.infer<typeof modelRouteDtoSchema>;
