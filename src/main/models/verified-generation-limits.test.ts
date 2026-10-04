import { expect, it } from "vitest";
import { verifiedGenerationLimits } from "./verified-generation-limits";

const official = { provider: "openai", baseUrl: "https://api.xiaomimimo.com/v1", modelId: "mimo-v2.6-flash" };

it("recognizes the exact official model and endpoint without guessing capacities for gateways or aliases", () => {
  expect(verifiedGenerationLimits(official)?.contextWindowTokens).toBe(1_000_000);
  expect(verifiedGenerationLimits({ ...official, provider: "openai-compatible", baseUrl: official.baseUrl + "/" })?.contextWindowTokens).toBe(1_000_000);
  for (const patch of [
    { baseUrl: "https://gateway.test/v1" },
    { baseUrl: "https://api.xiaomimimo.com.gateway.test/v1" },
    { baseUrl: "https://api.xiaomimimo.com:8443/v1" },
    { modelId: "mimo-v2-flash" },
    { provider: "local" }
  ]) expect(verifiedGenerationLimits({ ...official, ...patch })).toBeUndefined();
});
