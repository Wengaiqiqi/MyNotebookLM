import { describe, expect, it } from "vitest";
import type { ModelProfileDto } from "../../shared/models";
import { generationSettingsError, resolveGenerationLimits } from "./generation-limits";

const base: ModelProfileDto = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
  name: "Model",
  provider: "gemini",
  capability: "generation",
  baseUrl: "https://example.test",
  modelId: "model",
  enabled: true,
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z"
};

describe("resolveGenerationLimits", () => {
  it("rejects stale manual limits after capability refresh", () => {
    const profile = { ...base, generationLimits: { windowKind: "shared" as const, contextWindowTokens: 4096, maxOutputTokens: 2048, source: "provider" as const, observedAt: base.updatedAt, identity: { provider: base.provider, baseUrl: base.baseUrl, modelId: base.modelId } } };
    expect(generationSettingsError({ ...profile, contextTokensOverride: 65536 })?.messageKey).toBe("errors.generationContextLimit");
    expect(generationSettingsError({ ...profile, maxOutputTokensOverride: 8192 })?.messageKey).toBe("errors.generationOutputLimit");
    expect(generationSettingsError({ ...profile, maxOutputTokensOverride: null })).toBeNull();
  });

  it("checks the default window but keeps independent input and output limits separate", () => {
    expect(generationSettingsError({ ...base, maxOutputTokensOverride: 65536 })?.messageKey).toBe("errors.generationLimitsConflict");
    expect(generationSettingsError({ ...base, contextTokensOverride: 131072, maxOutputTokensOverride: 65536 })).toBeNull();
    expect(generationSettingsError({ ...base, maxOutputTokensOverride: 8192, generationLimits: { windowKind: "input-only", inputTokenLimit: 4096, maxOutputTokens: 8192, source: "provider", observedAt: base.updatedAt, identity: { provider: base.provider, baseUrl: base.baseUrl, modelId: base.modelId } } })).toBeNull();
  });
  it("keeps provider input and output limits independent", () => {
    const limits = resolveGenerationLimits({
      ...base,
      generationLimits: {
        inputTokenLimit: 1_000_000,
        maxOutputTokens: 16_384,
        windowKind: "input-only",
        source: "provider",
        observedAt: "2026-09-19T00:00:00.000Z",
        identity: { provider: "gemini", baseUrl: base.baseUrl, modelId: base.modelId }
      }
    });
    expect(limits.windowKind).toBe("input-only");
    expect(limits.inputTokenLimit).toBe(1_000_000);
    expect(limits.contextTokens).toBe(1_000_000);
    expect(limits.outputTokens).toBe(8_192);
  });

  it("never raises the default output just because the window is large", () => {
    expect(resolveGenerationLimits({
      ...base,
      generationLimits: {
        contextWindowTokens: 1_000_000,
        windowKind: "shared",
        source: "verified",
        observedAt: "2026-09-19T00:00:00.000Z",
        identity: { provider: "gemini", baseUrl: base.baseUrl, modelId: base.modelId }
      }
    }).outputTokens).toBe(8_192);
  });

  it("uses a manual input-only context override as the input budget", () => {
    const limits = resolveGenerationLimits({
      ...base,
      contextTokensOverride: 16_000,
      generationLimits: {
        inputTokenLimit: 1_000_000,
        windowKind: "input-only",
        source: "provider",
        observedAt: "2026-09-19T00:00:00.000Z",
        identity: { provider: "gemini", baseUrl: base.baseUrl, modelId: base.modelId }
      }
    });
    expect(limits.contextTokens).toBe(16_000);
    expect(limits.inputTokenLimit).toBe(16_000);
  });
});
