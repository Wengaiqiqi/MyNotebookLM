// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DesktopApi } from "../../../../shared/ipc";
import type { ModelProfileDto } from "../../../../shared/models";
import "../../i18n";
import ModelForm from "./ModelForm";

describe("ModelForm", () => {
  afterEach(() => cleanup());

  it("fetches and saves text and arbitrary speech models in separate multi-select rows", async () => {
    const saveProfile = vi.fn(async ({ profile }: { profile: ModelProfileDto }) => ({ ok: true as const, value: profile }));
    const api = {
      models: {
        discover: vi.fn(async () => ({ ok: true as const, value: [
          { id: "model-a", displayName: "Model A", capabilities: [], capabilityEvidence: "probe-required" as const },
          { id: "model-b", displayName: "Model B", capabilities: [], capabilityEvidence: "probe-required" as const },
          { id: "custom-voice", displayName: "Custom Voice", capabilities: [], capabilityEvidence: "probe-required" as const }
        ] })),
        discoverVoices: vi.fn(async () => ({ ok: true as const, value: [
          { id: "service-a", name: "服务端音色 A" }, { id: "service-b", name: "服务端音色 B" }, { id: "service-c", name: "服务端音色 C" }
        ] })),
        saveProfile
      }
    } as unknown as DesktopApi;
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
    const onSaved = vi.fn();
    render(<ModelForm capability="generation" onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "远程模型" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    const text = within(screen.getByRole("group", { name: "文字生成" }));
    const speech = within(screen.getByRole("group", { name: "语音合成（TTS）" }));
    expect(screen.getAllByRole("button", { name: "获取模型" })).toHaveLength(2);
    fireEvent.click(text.getByRole("button", { name: "获取模型" }));
    await text.findByText("获取成功");

    fireEvent.focus(text.getByRole("combobox"));
    const checkboxes = await text.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    expect(screen.getByDisplayValue("已选择 2 个模型")).toBeTruthy();
    fireEvent.click(text.getByRole("button", { name: "确认" }));
    expect(speech.getByRole("combobox")).toHaveProperty("value", "");
    fireEvent.click(speech.getByRole("button", { name: "获取模型" }));
    await speech.findByText("获取成功");
    fireEvent.focus(speech.getByRole("combobox"));
    fireEvent.click(speech.getByRole("option", { name: /custom-voice/ }));
    fireEvent.click(speech.getByRole("button", { name: "确认" }));

    expect(screen.queryByText(/主持人 A 音色/)).toBeNull();
    expect(api.models.discoverVoices).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(3));
    expect(saveProfile.mock.calls.map(([input]) => input.profile.modelId)).toEqual(["model-a", "model-b", "custom-voice"]);
    expect(saveProfile.mock.calls.map(([input]) => input.profile.outputKind)).toEqual(["text", "text", "speech"]);
    expect(saveProfile.mock.calls[2]![0].profile.speechVoices).toBeUndefined();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ modelId: "model-b", outputKind: "text" }));
  });

  it("preserves voices selected in the conversion pane when editing credentials", async () => {
    const existing: ModelProfileDto = { id: "11111111-1111-4111-8111-111111111111", name: "TTS", provider: "openai-compatible", capability: "generation", baseUrl: "https://other.example/v1", modelId: "other-model", outputKind: "speech", speechVoices: { A: "saved-a", B: "saved-b" }, enabled: true, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" };
    const discoverVoices = vi.fn(async () => ({ ok: true as const, value: [] }));
    const saveProfile = vi.fn(async ({ profile }: { profile: ModelProfileDto }) => ({ ok: true as const, value: profile }));
    window.myNotebook = { models: { discoverVoices, saveProfile } } as unknown as DesktopApi;
    render(<ModelForm capability="generation" existing={existing} onSaved={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "请选择文字生成模型" })).toHaveProperty("value", "");
    expect(screen.getByRole("combobox", { name: "请选择语音生成模型，可留空" })).toHaveProperty("value", existing.modelId);
    expect(discoverVoices).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("主持人 A 音色 · other-model")).toBeNull();
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "rotated-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "rotated-key", profile: expect.objectContaining({ speechVoices: existing.speechVoices }) })));
  });

  it("saves text models with an empty speech row", async () => {
    const saveProfile = vi.fn(async ({ profile }: { profile: ModelProfileDto }) => ({ ok: true as const, value: profile }));
    window.myNotebook = { models: { saveProfile } } as unknown as DesktopApi;
    render(<ModelForm capability="generation" onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "文字服务" } });
    fireEvent.change(screen.getByRole("combobox", { name: "请选择文字生成模型" }), { target: { value: "writer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
    expect(saveProfile.mock.calls[0]![0].profile).toMatchObject({ modelId: "writer", outputKind: "text" });
  });
});
