// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../../../../shared/ipc";
import type { ModelProfileDto } from "../../../../shared/models";
import "../../i18n";
import ModelForm from "./ModelForm";

describe("ModelForm", () => {
  afterEach(() => cleanup());

  it("selects several discovered models in a scrollable checklist and saves each profile", async () => {
    const saveProfile = vi.fn(async ({ profile }: { profile: ModelProfileDto }) => ({ ok: true as const, value: profile }));
    const api = {
      models: {
        discover: vi.fn(async () => ({ ok: true as const, value: [
          { id: "model-a", displayName: "Model A", capabilities: [], capabilityEvidence: "probe-required" as const },
          { id: "model-b", displayName: "Model B", capabilities: [], capabilityEvidence: "probe-required" as const }
        ] })),
        saveProfile
      }
    } as unknown as DesktopApi;
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
    const onSaved = vi.fn();
    render(<ModelForm capability="generation" onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "远程模型" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByText("获取成功");

    fireEvent.focus(screen.getByRole("combobox", { name: "模型名称" }));
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    expect(screen.getByDisplayValue("已选择 2 个模型")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    fireEvent.click(screen.getByRole("button", { name: "模型用途 · model-b" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "模型用途 · model-b" }), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "模型用途 · model-b" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "模型用途 · model-b" }));
    fireEvent.click(screen.getByRole("option", { name: "语音合成（TTS）" }));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2));
    expect(saveProfile.mock.calls.map(([input]) => input.profile.modelId)).toEqual(["model-a", "model-b"]);
    expect(saveProfile.mock.calls.map(([input]) => input.profile.name)).toEqual(["远程模型", "远程模型"]);
    expect(saveProfile.mock.calls[1]![0].profile.outputKind).toBe("speech");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ modelId: "model-b" }));
  });
});
