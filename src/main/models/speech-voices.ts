import { speechVoiceDescriptorSchema, type ModelProfileInput, type SpeechVoiceDescriptor } from "../../shared/models";
import { ProviderHttpClient, ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";

type VoicePage = { voices?: unknown; next_page_token?: string; nextPageToken?: string };

function invalidCatalog(): never {
  throw new ProviderRequestError(classifyProviderError({ malformedResponse: true }));
}

function readVoices(response: unknown): SpeechVoiceDescriptor[] {
  const body = response as { voices?: unknown; data?: unknown } | null;
  const entries = Array.isArray(response) ? response : body?.voices ?? (Array.isArray(body?.data) ? body.data : (body?.data as { voices?: unknown } | null)?.voices);
  if (!Array.isArray(entries) || entries.length > 10_000) return invalidCatalog();
  const voices = new Map<string, SpeechVoiceDescriptor>();
  for (const entry of entries) {
    const item = typeof entry === "string" ? { id: entry } : entry;
    if (!item || typeof item !== "object") return invalidCatalog();
    const id = item.id ?? item.voice_id ?? item.voice ?? item.name;
    const parsed = speechVoiceDescriptorSchema.safeParse({
      id, name: item.display_name ?? item.displayName ?? item.name ?? id,
      ...(item.language_code ?? item.language ? { language: item.language_code ?? item.language } : {})
    });
    if (!parsed.success) return invalidCatalog();
    voices.set(parsed.data.id, parsed.data);
  }
  return [...voices.values()];
}

/** Fetch catalogs using the configured connection; never send credentials to documentation sites. */
export async function discoverSpeechVoices(profile: Pick<ModelProfileInput, "provider" | "baseUrl" | "modelId">, apiKey: string | undefined, signal: AbortSignal): Promise<SpeechVoiceDescriptor[]> {
  const client = new ProviderHttpClient(fetch, { timeoutMs: 10_000, idleTimeoutMs: 10_000, maxResponseBytes: 2 * 1024 * 1024 });
  const headers = new Headers();
  if (apiKey) headers.set(profile.provider === "gemini" ? "x-goog-api-key" : "authorization", profile.provider === "gemini" ? apiKey : `Bearer ${apiKey}`);
  if (profile.provider === "gemini") {
    const voices = new Map<string, SpeechVoiceDescriptor>();
    let token = "";
    const base = profile.baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "");
    for (let page = 0; page < 10; page++) {
      const response: VoicePage = await client.json<VoicePage>(base, `/v1beta/voices?page_size=1000${token ? `&page_token=${encodeURIComponent(token)}` : ""}`, { headers, signal }).catch((error: unknown) => {
        if (error instanceof ProviderRequestError && [404, 405, 501].includes(error.status ?? 0)) return { voices: [] };
        throw error;
      });
      for (const voice of readVoices({ voices: response.voices ?? [] })) voices.set(voice.id, voice);
      const next = response.next_page_token ?? response.nextPageToken;
      if (!next) return [...voices.values()];
      if (typeof next !== "string" || next === token || next.length > 4096) return invalidCatalog();
      token = next;
    }
    return invalidCatalog();
  }
  for (const endpoint of ["/audio/voices", "/voices"]) {
    try {
      const response = await client.json(profile.baseUrl, `${endpoint}?model=${encodeURIComponent(profile.modelId)}`, { headers, signal });
      const voices = readVoices(response);
      if (voices.length) return voices;
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || ![404, 405, 501].includes(error.status ?? 0)) throw error;
    }
  }
  // MiMo publishes its catalog in a table rather than a documented listing API.
  if (/^mimo-v2\.5-tts$/i.test(profile.modelId) && new URL(profile.baseUrl).hostname === "api.xiaomimimo.com") {
    const html = await client.binary("https://mimo.mi.com", "/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5", { signal });
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(html.toString("utf8"));
    const table = [...document.querySelectorAll("table")].find((candidate) => candidate.querySelector("tr")?.textContent.includes("Voice ID"));
    if (!table) return invalidCatalog();
    const voices = [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()))
      .filter((cells) => cells.length === 4).map(([name, id, language]) => ({ id, name, language }));
    return readVoices(voices);
  }
  return [];
}
