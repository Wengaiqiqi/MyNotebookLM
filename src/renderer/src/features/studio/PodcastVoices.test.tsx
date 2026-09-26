// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../../../../shared/ipc";
import type { ModelProfileDto } from "../../../../shared/models";
import "../../i18n";
import PodcastVoices from "./PodcastVoices";

afterEach(cleanup);
const speech: ModelProfileDto = { id: "11111111-1111-4111-8111-111111111111", name: "TTS", provider: "openai-compatible", capability: "generation", baseUrl: "https://voice.example/v1", modelId: "custom-speech", outputKind: "speech", enabled: true, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", contextTokensOverride: null, maxOutputTokensOverride: null };
const text: ModelProfileDto = { ...speech, id: "22222222-2222-4222-8222-222222222222", modelId: "writer", outputKind: "text" };
function setup(voices: Array<{ id: string; name: string }>, initial = speech) {
  let saved = initial;
  const saveProfile = vi.fn(async ({ profile }: { profile: ModelProfileDto }) => {
    saved = { ...saved, ...profile };
    return { ok: true as const, value: saved };
  });
  const discoverVoices = vi.fn(async () => ({ ok: true as const, value: voices }));
  window.myNotebook = { models: {
    listProfiles: vi.fn(async () => ({ ok: true as const, value: { profiles: [text, saved] } })),
    getRoutes: vi.fn(async () => ({ ok: true as const, value: [{ taskKind: "podcast", position: 0, profileId: text.id }, { taskKind: "podcast", position: 1, profileId: speech.id }] })),
    discoverVoices, saveProfile
  } } as unknown as DesktopApi;
  return { discoverVoices, saveProfile };
}

it("fetches routed TTS voices, saves the service IDs without keys and restores selections after remount", async () => {
  const { discoverVoices, saveProfile } = setup([{ id: "vendor-a", name: "音色一" }, { id: "vendor-b", name: "音色二" }, { id: "custom-c", name: "音色三" }]);
  const ready = vi.fn();
  const first = render(<PodcastVoices disabled={false} onReadyChange={ready} />);
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  expect(discoverVoices).toHaveBeenCalledTimes(1);
  expect(discoverVoices).toHaveBeenCalledWith({ profileId: speech.id, provider: speech.provider, capability: "generation", baseUrl: speech.baseUrl, modelId: speech.modelId });
  fireEvent.click(screen.getByRole("button", { name: "主持人 A 音色 · custom-speech" }));
  fireEvent.click(screen.getByRole("option", { name: "音色三" }));
  await waitFor(() => expect(saveProfile).toHaveBeenLastCalledWith({ profile: { id: speech.id, name: speech.name, provider: speech.provider, capability: speech.capability, baseUrl: speech.baseUrl, modelId: speech.modelId, outputKind: "speech", enabled: true, speechVoices: { A: "custom-c", B: "vendor-b" } } }));
  first.unmount();
  render(<PodcastVoices disabled={false} onReadyChange={ready} />);
  await screen.findByRole("button", { name: "主持人 A 音色 · custom-speech" });
  expect(screen.getByRole("button", { name: "主持人 A 音色 · custom-speech" }).textContent).toBe("音色三");
});

it("supports manual service IDs without a catalog and blocks generation until both hosts are saved", async () => {
  const { saveProfile } = setup([]);
  const ready = vi.fn();
  render(<PodcastVoices disabled={false} onReadyChange={ready} />);
  await screen.findByText("服务未返回音色列表，请填写供应商提供的音色 ID。");
  fireEvent.change(screen.getByLabelText("主持人 A 音色 · custom-speech"), { target: { value: "manual-a" } });
  expect(saveProfile).not.toHaveBeenCalled();
  expect(ready).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByLabelText("主持人 B 音色 · custom-speech"), { target: { value: "manual-b" } });
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ profile: expect.objectContaining({ speechVoices: { A: "manual-a", B: "manual-b" } }) }));
});

it("places a manual ID button beside each host and switches their input modes independently", async () => {
  const { saveProfile } = setup([{ id: "vendor-a", name: "音色一" }, { id: "vendor-b", name: "音色二" }], { ...speech, speechVoices: { A: "vendor-a", B: "vendor-b" } });
  const ready = vi.fn();
  render(<PodcastVoices disabled={false} onReadyChange={ready} />);
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  const buttonA = screen.getByRole("button", { name: "填写音色 ID · 主持人 A 音色" });
  const buttonB = screen.getByRole("button", { name: "填写音色 ID · 主持人 B 音色" });
  expect(buttonA.parentElement).toBe(screen.getByRole("button", { name: "主持人 A 音色 · custom-speech" }).closest(".input-row"));
  expect(buttonB.parentElement).toBe(screen.getByRole("button", { name: "主持人 B 音色 · custom-speech" }).closest(".input-row"));
  fireEvent.click(buttonA);
  expect(screen.getByRole("button", { name: "主持人 B 音色 · custom-speech" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("主持人 A 音色 · custom-speech", { selector: "input" }), { target: { value: "custom-host-a" } });
  await waitFor(() => expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ profile: expect.objectContaining({ speechVoices: { A: "custom-host-a", B: "vendor-b" } }) })));
  fireEvent.click(screen.getByRole("button", { name: "从列表选择 · 主持人 A 音色" }));
  expect(screen.getByRole("button", { name: "主持人 A 音色 · custom-speech" }).textContent).toBe("custom-host-a");
  fireEvent.click(buttonB);
  expect(screen.getByRole("button", { name: "主持人 A 音色 · custom-speech" })).toBeTruthy();
  expect(screen.getByLabelText("主持人 B 音色 · custom-speech", { selector: "input" })).toHaveProperty("value", "vendor-b");
});
