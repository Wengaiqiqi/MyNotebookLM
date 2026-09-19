import type { GenerationLimits, ModelProfileDto } from "../../shared/models";
import type { AppErrorDto } from "../../shared/app-errors";

export const DEFAULT_CONTEXT_TOKENS = 32_768;
export const DEFAULT_OUTPUT_TOKENS = 8_192;
export const MAX_SAFE_TOKEN_INPUT = 2_147_483_647;
export const MIN_OUTPUT_TOKENS = 1;
export const MIN_INPUT_RESERVE = 1_024;
export const MIN_SAFETY_MARGIN = 512;
export const SAFETY_MARGIN_RATIO = 0.1;

export function safetyMarginTokens(contextTokens: number): number {
  return Math.max(MIN_SAFETY_MARGIN, Math.ceil(contextTokens * SAFETY_MARGIN_RATIO));
}

/** Largest default output reserve that still leaves room for input. */
export function maxDefaultOutputTokens(contextTokens: number): number {
  const safety = safetyMarginTokens(contextTokens);
  const reserved = Math.min(MIN_INPUT_RESERVE, Math.max(0, contextTokens - safety - MIN_OUTPUT_TOKENS));
  return Math.max(MIN_OUTPUT_TOKENS, contextTokens - safety - reserved);
}

/** Largest output reserve that still fits a minimum input inside the window. */
export function maxOutputForContext(contextTokens: number): number {
  const safety = safetyMarginTokens(contextTokens);
  return Math.max(MIN_OUTPUT_TOKENS, contextTokens - safety - MIN_INPUT_RESERVE);
}

export type EffectiveGenerationLimits = {
  windowKind: GenerationLimits["windowKind"];
  contextTokens: number;
  inputTokenLimit?: number;
  knownContextTokens?: number;
  knownInputTokenLimit?: number;
  knownOutputTokens?: number;
  outputTokens: number;
  outputWasOverridden: boolean;
  source: "provider" | "verified" | "default";
};

function positive(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return Math.min(value, MAX_SAFE_TOKEN_INPUT);
}

/** Validate the effective configuration at both save time and each generation attempt. */
export function generationSettingsError(profile: Pick<ModelProfileDto, "generationLimits" | "contextTokensOverride" | "maxOutputTokensOverride">): AppErrorDto | null {
  const limits = resolveGenerationLimits(profile);
  const contextCeiling = limits.windowKind === "input-only" ? limits.knownInputTokenLimit : limits.knownContextTokens;
  const error = (messageKey: string, limitTokens: number): AppErrorDto => ({ code: "VALIDATION", messageKey, recoverable: true, details: { limitTokens } });
  if (profile.contextTokensOverride != null && contextCeiling !== undefined && profile.contextTokensOverride > contextCeiling) {
    return error("errors.generationContextLimit", contextCeiling);
  }
  if (profile.maxOutputTokensOverride != null) {
    if (limits.knownOutputTokens !== undefined && profile.maxOutputTokensOverride > limits.knownOutputTokens) {
      return error("errors.generationOutputLimit", limits.knownOutputTokens);
    }
    if (limits.windowKind !== "input-only" && profile.maxOutputTokensOverride > maxOutputForContext(limits.contextTokens)) {
      return error("errors.generationLimitsConflict", maxOutputForContext(limits.contextTokens));
    }
    if (limits.windowKind === "input-only" && limits.knownContextTokens !== undefined && profile.maxOutputTokensOverride > maxOutputForContext(limits.knownContextTokens)) {
      return error("errors.generationLimitsConflict", maxOutputForContext(limits.knownContextTokens));
    }
  }
  return null;
}

export function resolveGenerationLimits(profile: Pick<ModelProfileDto, "generationLimits" | "contextTokensOverride" | "maxOutputTokensOverride">): EffectiveGenerationLimits {
  const known = profile.generationLimits;
  const knownContextTokens = positive(known?.contextWindowTokens);
  const knownInputTokenLimit = positive(known?.inputTokenLimit);
  const knownOutputTokens = positive(known?.maxOutputTokens);
  const windowKind = known?.windowKind ?? "unknown";
  const contextTokens = positive(profile.contextTokensOverride)
    ?? (windowKind === "input-only" ? knownInputTokenLimit : knownContextTokens)
    ?? knownContextTokens
    ?? knownInputTokenLimit
    ?? DEFAULT_CONTEXT_TOKENS;
  const effectiveInputTokenLimit = positive(profile.contextTokensOverride) ?? knownInputTokenLimit;
  const outputWasOverridden = profile.maxOutputTokensOverride !== null && profile.maxOutputTokensOverride !== undefined;
  const outputTokens = positive(profile.maxOutputTokensOverride)
    ?? (knownOutputTokens === undefined ? DEFAULT_OUTPUT_TOKENS : Math.min(DEFAULT_OUTPUT_TOKENS, knownOutputTokens));
  const source = known?.source ?? "default";
  return {
    windowKind,
    contextTokens,
    ...(effectiveInputTokenLimit === undefined ? {} : { inputTokenLimit: effectiveInputTokenLimit }),
    ...(knownContextTokens === undefined ? {} : { knownContextTokens }),
    ...(knownInputTokenLimit === undefined ? {} : { knownInputTokenLimit }),
    ...(knownOutputTokens === undefined ? {} : { knownOutputTokens }),
    outputTokens,
    outputWasOverridden,
    source
  };
}
