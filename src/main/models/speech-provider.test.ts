import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePodcastScript, pcmWave, readWave, synthesizeSpeech } from "./speech-provider";
import { ProviderHttpClient } from "./http-client";

const turns = [{ speaker: "A" as const, text: "What does the source say?" }, { speaker: "B" as const, text: "资料给出了证据。" }];
const script = { title: "Evidence", turns };
const profile = { provider: "openai-compatible" as const, baseUrl: "https://speech.example/v1", modelId: "custom-speech" };
const wave = () => pcmWave(Buffer.from([1, 0, 2, 0]));
afterEach(() => vi.unstubAllGlobals());

describe("podcast speech", () => {
  it("accepts a complete two-speaker script, rejecting incomplete or oversized output", () => {
    expect(parsePodcastScript("```json\n" + JSON.stringify(script) + "\n```")).toEqual(script);
    for (const content of ["not JSON", JSON.stringify({ ...script, turns: [turns[0], turns[0]] }), JSON.stringify({ ...script, turns: [{ speaker: "C", text: "hello" }, turns[1]] }), JSON.stringify({ ...script, turns: [{ speaker: "A", text: "x".repeat(2_001) }, turns[1]] })]) {
      expect(() => parsePodcastScript(content)).toThrow("errors.podcastScriptInvalid");
    }
  });

  it("preserves binary bytes and rejects incompatible or truncated WAV data", async () => {
    const wav = wave();
    const client = new ProviderHttpClient(async () => new Response(new Uint8Array(wav)));
    expect(await client.binary("https://speech.example", "/audio/speech", { signal: new AbortController().signal })).toEqual(wav);
    expect(readWave(wav)).toEqual({ pcm: Buffer.from([1, 0, 2, 0]), sampleRate: 24_000, channels: 1 });
    const streamed = Buffer.from(wav); streamed.writeUInt32LE(0xffffffff, 4); streamed.writeUInt32LE(0xffffffff, 40);
    expect(readWave(streamed)).toEqual(readWave(wav));
    expect(() => readWave(wav.subarray(0, 45))).toThrow();
    const invalid = Buffer.from(wav); invalid.writeUInt16LE(3, 20);
    expect(() => readWave(invalid)).toThrow();
  });

  it("synthesizes turns with distinct voices and assembles playable PCM with pauses", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(wave())));
    vi.stubGlobal("fetch", fetch);
    const progress: number[] = [];
    const result = await synthesizeSpeech(profile, "key", turns, new AbortController().signal, (value) => progress.push(value));
    expect(fetch.mock.calls).toHaveLength(2);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([, init]) => JSON.parse(String(init.body)).voice)).toEqual(["alloy", "echo"]);
    expect(calls[0]![0]).toBe("https://speech.example/v1/audio/speech");
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer key");
    const pcm = readWave(result).pcm;
    expect(pcm.subarray(0, 4)).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(pcm.subarray(4 + 8_640, 8 + 8_640)).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(progress).toEqual([0.5, 1]);
  });

  it("cancels before a second turn and never returns partial audio", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response(new Uint8Array(wave())));
    vi.stubGlobal("fetch", fetch);
    await expect(synthesizeSpeech(profile, undefined, turns, controller.signal, () => controller.abort())).rejects.toThrow("errors.cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses MiMo Chat Completions audio with separate preset voices", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "mimo-v2.5-tts", stream: false, audio: { format: "wav" } });
      expect(body.messages[1]).toMatchObject({ role: "assistant" });
      expect(body.input).toBeUndefined();
      return Response.json({ choices: [{ message: { audio: { data: wave().toString("base64") } } }] });
    });
    vi.stubGlobal("fetch", fetch);
    for (const provider of ["openai", "openai-compatible"] as const) {
      const result = await synthesizeSpeech({ ...profile, provider, modelId: "mimo-v2.5-tts" }, "key", turns, new AbortController().signal);
      expect(readWave(result).pcm.length).toBe(2 * (4 + 8_640));
    }
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(Array(4).fill("https://speech.example/v1/chat/completions"));
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).audio.voice)).toEqual(["冰糖", "苏打", "冰糖", "苏打"]);
    expect(fetch.mock.calls.slice(0, 2).map(([, init]) => JSON.parse(String(init?.body)).messages[1].content)).toEqual(turns.map((turn) => turn.text));
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer key");
    await synthesizeSpeech({ ...profile, modelId: "mimo-v2.5-tts" }, undefined, turns.map((turn) => ({ ...turn, text: "English dialogue." })), new AbortController().signal);
    expect(fetch.mock.calls.slice(-2).map(([, init]) => JSON.parse(String(init?.body)).audio.voice)).toEqual(["Mia", "Milo"]);
  });

  it("rejects missing or invalid MiMo audio rather than saving a partial podcast", async () => {
    for (const data of [undefined, "not base64!", Buffer.from("not WAV").toString("base64")]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { audio: { data } } }] })));
      await expect(synthesizeSpeech({ ...profile, modelId: "mimo-v2.5-tts" }, undefined, turns, new AbortController().signal)).rejects.toThrow();
    }
  });

  it("supports Gemini legacy PCM and interactions WAV without double headers", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.model) {
        expect(body.generation_config.speech_config.speakers.map((speaker: any) => speaker.voice)).toEqual(["Puck", "Kore"]);
        expect(body.input[0].content.map((turn: any) => turn.annotations[0].speaker)).toEqual(["A", "B"]);
        return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wave().toString("base64") }] }] });
      }
      expect(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toHaveLength(2);
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.from([1, 0, 2, 0]).toString("base64") } }] } }] });
    });
    vi.stubGlobal("fetch", fetch);
    for (const modelId of ["gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts"]) {
      const result = await synthesizeSpeech({ ...profile, provider: "gemini", baseUrl: "https://gemini.example/v1beta", modelId }, "key", turns, new AbortController().signal);
      expect(result).toEqual(wave());
    }
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("/v1beta/v1beta/");
  });
});
