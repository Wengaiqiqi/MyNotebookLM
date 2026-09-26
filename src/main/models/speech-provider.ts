import { Buffer } from "node:buffer";
import { z } from "zod";
import type { ModelProfileInput } from "../../shared/models";
import { ProviderHttpClient, ProviderRequestError } from "./http-client";
import { classifyProviderError } from "./provider-errors";
import { RoutedGenerationError } from "./routed-generation";
import { discoverSpeechVoices } from "./speech-voices";

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const podcastScriptSchema = z.object({
  title: z.string().trim().min(1).max(200),
  turns: z.array(z.object({ speaker: z.enum(["A", "B"]), text: z.string().trim().min(1).max(2_000) }).strict()).min(2).max(64)
}).strict().refine((script) => new Set(script.turns.map((turn) => turn.speaker)).size === 2)
  .refine((script) => script.turns.reduce((size, turn) => size + turn.text.length, 0) <= 16_000);
export type SpeechTurn = z.infer<typeof podcastScriptSchema>["turns"][number];

export function parsePodcastScript(content: string): z.infer<typeof podcastScriptSchema> {
  try { return podcastScriptSchema.parse(JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))); }
  catch { throw new RoutedGenerationError({ code: "PROVIDER", messageKey: "errors.podcastScriptInvalid", recoverable: true }); }
}

function invalidAudio(): never { throw new ProviderRequestError(classifyProviderError({ malformedResponse: true })); }

function decodeAudio(data: unknown): Buffer {
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return invalidAudio();
  return Buffer.from(data, "base64");
}

export function pcmWave(pcm: Buffer, sampleRate = 24_000, channels = 1): Buffer {
  if (pcm.length === 0 || pcm.length % (channels * 2) || pcm.length + 44 > MAX_AUDIO_BYTES) return invalidAudio();
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function readWave(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (wav.length < 44 || wav.length > MAX_AUDIO_BYTES || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return invalidAudio();
  let format: { sampleRate: number; channels: number } | undefined;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const declaredSize = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Streaming WAV encoders may leave the final data chunk length unknown.
    const size = kind === "data" && declaredSize === 0xffffffff ? wav.length - start : declaredSize;
    if (size > wav.length - start) return invalidAudio();
    if (kind === "fmt ") {
      if (size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16) return invalidAudio();
      const channels = wav.readUInt16LE(start + 2), sampleRate = wav.readUInt32LE(start + 4);
      if (![1, 2].includes(channels) || sampleRate < 8_000 || sampleRate > 96_000 || wav.readUInt16LE(start + 12) !== channels * 2 || wav.readUInt32LE(start + 8) !== sampleRate * channels * 2) return invalidAudio();
      format = { sampleRate, channels };
    }
    if (kind === "data") pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !pcm?.length || pcm.length % (format.channels * 2)) return invalidAudio();
  return { ...format, pcm };
}

/** Keep speaker selections consistent across the whole conversation. */
export async function synthesizeSpeech(profile: Pick<ModelProfileInput, "provider" | "baseUrl" | "modelId" | "speechVoices">, apiKey: string | undefined, turns: readonly SpeechTurn[], signal: AbortSignal, progress = (_fraction: number): void => {}): Promise<Buffer> {
  if (signal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
  if (!["openai", "openai-compatible", "gemini"].includes(profile.provider)) throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.podcastSpeechUnsupported", recoverable: true });
  let selectedVoices = profile.speechVoices;
  if (!selectedVoices) {
    const catalog = await discoverSpeechVoices(profile, apiKey, signal);
    const chinese = turns.some((turn) => /[\u3400-\u9fff]/.test(turn.text));
    const matching = catalog.filter((voice) => voice.language && (chinese ? /zh|中文|Chinese/i : /en|英文|English/i).test(voice.language));
    const choices = matching.length >= 2 ? matching : catalog;
    if (choices.length < 2) throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.podcastVoicesRequired", recoverable: true });
    selectedVoices = { A: choices[0]!.id, B: choices[1]!.id };
  }
  const client = new ProviderHttpClient(fetch, { timeoutMs: 120_000, idleTimeoutMs: 180_000, maxResponseBytes: MAX_AUDIO_BYTES });
  const headers = new Headers({ "content-type": "application/json" });
  if (profile.provider === "gemini") {
    if (apiKey) headers.set("x-goog-api-key", apiKey);
    const base = profile.baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "");
    const model = profile.modelId.replace(/^models\//, "");
    const speakers = [{ speaker: "A", voice: selectedVoices.A }, { speaker: "B", voice: selectedVoices.B }];
    // The 3.8 API returns WAV; legacy generateContent returns headerless PCM.
    const interactions = /^gemini-3\.8-/.test(model);
    const body = interactions ? {
      model, input: [{ type: "user_input", content: turns.map((turn) => ({ type: "text", text: turn.text, annotations: [{ type: "speech_metadata", speaker: turn.speaker }] })) }],
      response_format: { type: "audio" }, generation_config: { speech_config: { mode: "conversational", speakers } }
    } : {
      contents: [{ parts: [{ text: turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n") }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.map(({ speaker, voice }) => ({ speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } })) } } }
    };
    const response: any = await client.json(base, interactions ? "/v1beta/interactions" : `/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers, body: JSON.stringify(body), signal });
    const audio = interactions
      ? response?.steps?.filter((step: any) => step.type === "model_output").flatMap((step: any) => step.content ?? []).filter((part: any) => part.type === "audio").at(-1)
      : response?.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData)?.inlineData;
    const bytes = decodeAudio(audio?.data);
    const mime = audio.mimeType ?? audio.mime_type;
    let wav: Buffer;
    if (mime === "audio/wav" || mime === "audio/x-wav") { readWave(bytes); wav = bytes; }
    else if (/^audio\/(?:L16|pcm)(?:;|$)/i.test(mime ?? "")) {
      const rate = /(?:rate|samplerate)=(\d+)/i.exec(mime)?.[1];
      if (rate && Number(rate) !== 24_000) return invalidAudio();
      wav = pcmWave(bytes);
    } else return invalidAudio();
    if (signal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
    progress(1);
    return wav;
  }
  if (profile.provider !== "openai" && profile.provider !== "openai-compatible") throw new RoutedGenerationError({ code: "VALIDATION", messageKey: "errors.podcastSpeechUnsupported", recoverable: true });
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const mimo = /^mimo-v2\.5-tts$/i.test(profile.modelId);
  const chinese = turns.some((turn) => /[\u3400-\u9fff]/.test(turn.text));
  const parts: Buffer[] = [];
  let format: { sampleRate: number; channels: number } | undefined;
  let size = 44;
  for (const [index, turn] of turns.entries()) {
    let wav: Buffer;
    if (mimo) {
      const response = await client.json<{ choices?: { message?: { audio?: { data?: unknown } } }[] }>(profile.baseUrl, "/chat/completions", {
        method: "POST", headers, signal,
        body: JSON.stringify({ model: profile.modelId, stream: false,
          messages: [{ role: "user", content: chinese ? "自然、清晰的双人播客对谈语气，只朗读给定台词。" : "Natural, clear conversational podcast delivery. Read only the supplied words." }, { role: "assistant", content: turn.text }],
          audio: { format: "wav", voice: selectedVoices[turn.speaker] }
        })
      });
      wav = decodeAudio(response?.choices?.[0]?.message?.audio?.data);
    } else {
      wav = await client.binary(profile.baseUrl, "/audio/speech", {
        method: "POST", headers, signal,
        body: JSON.stringify({ model: profile.modelId, input: turn.text, voice: selectedVoices[turn.speaker], response_format: "wav" })
      });
    }
    const clip = readWave(wav);
    if (format && (clip.sampleRate !== format.sampleRate || clip.channels !== format.channels)) return invalidAudio();
    format = clip;
    const silence = Buffer.alloc(Math.round(clip.sampleRate * 0.18) * clip.channels * 2);
    size += clip.pcm.length + silence.length;
    if (size > MAX_AUDIO_BYTES) throw new ProviderRequestError(classifyProviderError({ responseTooLarge: true }));
    parts.push(clip.pcm, silence);
    progress((index + 1) / turns.length);
  }
  if (!format) return invalidAudio();
  if (signal.aborted) throw new ProviderRequestError(classifyProviderError({ cancelled: true }));
  return pcmWave(Buffer.concat(parts), format.sampleRate, format.channels);
}
