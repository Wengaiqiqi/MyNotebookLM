import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSpeechVoices } from "./speech-voices";
import { pcmWave, synthesizeSpeech } from "./speech-provider";

const profile = { provider: "openai-compatible" as const, baseUrl: "https://different.example/v1", modelId: "different-tts" };
afterEach(() => vi.unstubAllGlobals());

describe("speech voice catalogs", () => {
  it("reads service-specific IDs, falls back to /voices, and uses them for both speakers", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-key");
      if (String(url).includes("/audio/voices")) return Response.json({}, { status: 404 });
      if (String(url).includes("/voices")) return Response.json({ voices: [{ voice_id: "new-a", name: "New A" }, { voice_id: "new-b", name: "New B" }] });
      return new Response(new Uint8Array(pcmWave(Buffer.from([1, 0, 2, 0]))));
    });
    vi.stubGlobal("fetch", fetch);
    const turns = [{ speaker: "A" as const, text: "Hello." }, { speaker: "B" as const, text: "Hello again." }];
    await synthesizeSpeech(profile, "private-key", turns, new AbortController().signal);
    expect(fetch.mock.calls.slice(2).map(([, init]) => JSON.parse(String(init?.body)).voice)).toEqual(["new-a", "new-b"]);
    expect(String(fetch.mock.calls[0]![0])).toContain("model=different-tts");
  });

  it("paginates Gemini's live catalog without repeating the version prefix", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-key");
      return String(url).includes("page_token=") ? Response.json({ voices: [{ id: "voice-b", display_name: "B" }] })
        : Response.json({ voices: [{ id: "voice-a", display_name: "A", language_code: "zh-CN" }], next_page_token: "next token" });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await discoverSpeechVoices({ ...profile, provider: "gemini", baseUrl: "https://google.example/v1beta" }, "google-key", new AbortController().signal))
      .toEqual([{ id: "voice-a", name: "A", language: "zh-CN" }, { id: "voice-b", name: "B" }]);
    expect(String(fetch.mock.calls[1]![0])).toBe("https://google.example/v1beta/voices?page_size=1000&page_token=next%20token");
  });

  it("loads MiMo's current documentation table without sending its API key", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.xiaomimimo.com")) return Response.json({}, { status: 404 });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response('<table><tr><th>Voice ID</th></tr><tr><td>新增音色</td><td>server-added</td><td>中文</td><td>女性</td></tr></table>');
    });
    vi.stubGlobal("fetch", fetch);
    expect(await discoverSpeechVoices({ ...profile, baseUrl: "https://api.xiaomimimo.com/v1", modelId: "mimo-v2.5-tts" }, "mimo-key", new AbortController().signal))
      .toEqual([{ id: "server-added", name: "新增音色", language: "中文" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not hide authentication failures or replace a malformed response with presets", async () => {
    for (const response of [Response.json({}, { status: 401 }), Response.json({ voices: [{ name: "Bad", id: "" }] })]) {
      const fetch = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetch);
      await expect(discoverSpeechVoices(profile, "bad-key", new AbortController().signal)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("asks for configured voices when listing is unsupported, without synthesizing", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(synthesizeSpeech(profile, undefined, [{ speaker: "A", text: "Hello" }, { speaker: "B", text: "Hi" }], new AbortController().signal)).rejects.toThrow("errors.podcastVoicesRequired");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await discoverSpeechVoices({ ...profile, provider: "gemini" }, undefined, new AbortController().signal)).toEqual([]);
  });
});
