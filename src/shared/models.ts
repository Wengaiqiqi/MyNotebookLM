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
export const capabilityEvidenceSchema = z.enum(["authoritative", "probe-required"]);

export const modelTaskKindSchema = z.enum([
  "chat",
  "note-title",
  "summary",
  "key-points",
  "qa",
  "custom-transformation",
  "embedding"
]);

export const embeddingDistanceSchema = z.literal("cosine");
export const embeddingPoolingSchema = z.literal("mean");

export const embeddingMetadataSchema = z.object({
  dimension: z.number().int().positive(),
  distance: embeddingDistanceSchema,
  pooling: embeddingPoolingSchema,
  normalized: z.boolean(),
  preprocessingVersion: z.string().trim().min(1).max(100)
}).strict();

const modelProfileFieldsSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  provider: providerKindSchema,
  capability: modelCapabilitySchema,
  baseUrl: z.string().trim().max(2_048),
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

export const defaultModelRoutesDtoSchema = z.object({
  generationProfileId: z.uuid().optional(),
  embeddingProfileId: z.uuid().optional()
}).strict();

export const setDefaultModelRoutesInputSchema = z.object({
  generationProfileId: z.uuid(),
  embeddingProfileId: z.uuid()
}).strict();

export const modelDescriptorSchema = z.object({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  capabilities: modelCapabilitySchema.array(),
  capabilityEvidence: capabilityEvidenceSchema
}).strict();

const apiKeySchema = z.string().max(16_384).refine(
  (value) => value.trim().length > 0,
  "Credential must not be empty"
);

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || /^(?:::ffff|0:0:0:0:0:ffff):7f[0-9a-f]{2}:/.test(host)
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateProviderAddress(
  input: { provider: ProviderKind; baseUrl: string },
  context: z.RefinementCtx,
  path: PropertyKey[] = []
): void {
  if (input.provider === "local" && input.baseUrl === "") return;
  let address: URL;
  try {
    address = new URL(input.baseUrl);
  } catch {
    context.addIssue({ code: "custom", path: [...path, "baseUrl"], message: "Invalid provider address" });
    return;
  }
  if (address.protocol !== "http:" && address.protocol !== "https:") {
    context.addIssue({ code: "custom", path: [...path, "baseUrl"], message: "Provider address must use HTTP or HTTPS" });
  }
  if (address.username || address.password) {
    context.addIssue({ code: "custom", path: [...path, "baseUrl"], message: "Provider address must not contain credentials" });
  }
  if (isLoopbackHostname(address.hostname)
    && input.provider !== "ollama"
    && input.provider !== "openai-compatible") {
    context.addIssue({ code: "custom", path: [...path, "baseUrl"], message: "Provider does not allow loopback addresses" });
  }
}

export const builtInModelProfileDtoSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  provider: z.literal("local"),
  capability: z.literal("embedding"),
  baseUrl: z.literal(""),
  modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  dimension: z.number().int().positive(),
  distance: embeddingDistanceSchema,
  pooling: embeddingPoolingSchema,
  normalized: z.boolean(),
  preprocessingVersion: z.string().trim().min(1).max(100),
  metadata: embeddingMetadataSchema,
  editable: z.literal(false),
  requiresCredential: z.literal(false)
}).strict();

const providerConnectionFields = {
  profileId: z.uuid().optional(),
  provider: providerKindSchema,
  capability: modelCapabilitySchema,
  baseUrl: z.string().trim().max(2_048),
  apiKey: apiKeySchema.optional()
};

export const discoverModelsInputSchema = z.object(providerConnectionFields).strict().superRefine(
  (input, context) => {
    validateProviderCapability(input, context);
    validateProviderAddress(input, context);
  }
);

export const testModelInputSchema = z.object({
  profile: z.union([modelProfileInputSchema, builtInModelProfileDtoSchema]),
  apiKey: apiKeySchema.optional()
}).strict().superRefine((input, context) => validateProviderAddress(input.profile, context, ["profile"]));

export const saveModelProfileInputSchema = testModelInputSchema;

export const deleteModelProfileInputSchema = z.object({ id: z.uuid() }).strict();

export const credentialInputSchema = z.object({
  profileId: z.uuid(),
  apiKey: apiKeySchema
}).strict();

export const credentialProfileInputSchema = z.object({ profileId: z.uuid() }).strict();

export const credentialStatusDtoSchema = z.object({
  profileId: z.uuid(),
  hasCredential: z.boolean(),
  mask: z.string().min(1).max(100).optional()
}).strict();

export const modelProfileListDtoSchema = z.object({
  profiles: modelProfileDtoSchema.array(),
  builtInProfiles: builtInModelProfileDtoSchema.array(),
  credentials: credentialStatusDtoSchema.array()
}).strict();

export const modelTestResultDtoSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  capability: modelCapabilitySchema,
  verifiedBy: z.enum(["discovery", "probe"])
}).strict();

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type CapabilityEvidence = z.infer<typeof capabilityEvidenceSchema>;
export type ModelTaskKind = z.infer<typeof modelTaskKindSchema>;
export type EmbeddingMetadata = Readonly<z.infer<typeof embeddingMetadataSchema>>;
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>;
export type ModelProfileDto = z.infer<typeof modelProfileDtoSchema>;
export type ModelRouteDto = z.infer<typeof modelRouteDtoSchema>;
export type DefaultModelRoutesDto = z.infer<typeof defaultModelRoutesDtoSchema>;
export type SetDefaultModelRoutesInput = z.infer<typeof setDefaultModelRoutesInputSchema>;
export type ModelDescriptorDto = z.infer<typeof modelDescriptorSchema>;
export type DiscoverModelsInput = z.infer<typeof discoverModelsInputSchema>;
export type TestModelInput = z.infer<typeof testModelInputSchema>;
export type SaveModelProfileInput = z.infer<typeof saveModelProfileInputSchema>;
export type DeleteModelProfileInput = z.infer<typeof deleteModelProfileInputSchema>;
export type CredentialInput = z.infer<typeof credentialInputSchema>;
export type CredentialProfileInput = z.infer<typeof credentialProfileInputSchema>;
export type CredentialStatusDto = z.infer<typeof credentialStatusDtoSchema>;
export type BuiltInModelProfileDto = z.infer<typeof builtInModelProfileDtoSchema>;
export type ModelProfileListDto = z.infer<typeof modelProfileListDtoSchema>;
export type ModelTestResultDto = z.infer<typeof modelTestResultDtoSchema>;
