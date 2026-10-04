import type { GenerationLimits } from "../../shared/models";

/** Official documentation fallback for endpoints whose /models omits capacity.
 * https://mimo.mi.com/models/zh-CN/mimo-v2.6-flash (verified 2026-10-04).
 * The documented 1M window is represented conservatively as 1,000,000 tokens.
 */
export function verifiedGenerationLimits(profile: { provider: string; baseUrl: string; modelId: string }): GenerationLimits | undefined {
  if (profile.provider !== "openai" && profile.provider !== "openai-compatible") return undefined;
  if (profile.modelId !== "mimo-v2.6-flash") return undefined;
  let address: URL;
  try { address = new URL(profile.baseUrl); } catch { return undefined; }
  if (address.protocol !== "https:" || address.hostname !== "api.xiaomimimo.com" || address.port
    || address.username || address.password || address.search || address.hash
    || !["", "/v1"].includes(address.pathname.replace(/\/+$/, ""))) return undefined;
  return {
    contextWindowTokens: 1_000_000,
    windowKind: "shared",
    source: "verified",
    observedAt: "2026-10-04T00:00:00.000Z",
    identity: { provider: profile.provider, baseUrl: profile.baseUrl, modelId: profile.modelId }
  };
}
