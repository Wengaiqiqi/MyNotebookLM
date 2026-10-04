// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppSettingsDto, UpdateAppSettingsInput } from "../../../../shared/settings";
import { changeLanguage } from "../../i18n";
import NetworkSettings from "./NetworkSettings";

function mount(initial: Partial<AppSettingsDto> = {}) {
  let settings: AppSettingsDto = { onboardingCompleted: true, locale: "zh-CN", theme: "light", proxyMode: "system", proxyUrl: "", proxyBypass: "", ...initial };
  const update = vi.fn(async (input: UpdateAppSettingsInput) => {
    settings = { ...settings, ...input } as AppSettingsDto;
    return { ok: true as const, value: settings };
  });
  Object.defineProperty(window, "myNotebook", {
    configurable: true,
    value: { settings: { get: vi.fn(async () => ({ ok: true as const, value: settings })), update } }
  });
  render(<NetworkSettings />);
  return { update };
}

describe("NetworkSettings", () => {
  afterEach(() => cleanup());

  it("defaults to the system proxy and saves direct mode and the bypass list", async () => {
    await changeLanguage("zh-CN");
    const { update } = mount();
    expect(await screen.findByRole("button", { name: "跟随系统" })).toHaveProperty("ariaPressed", "true");
    fireEvent.change(screen.getByLabelText(/^不走代理的地址/), { target: { value: "api.deepseek.com" } });
    fireEvent.blur(screen.getByLabelText(/^不走代理的地址/));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ proxyBypass: "api.deepseek.com" }));
    fireEvent.click(screen.getByRole("button", { name: "直连" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ proxyMode: "direct" }));
    expect(screen.queryByLabelText(/^不走代理的地址/)).toBeNull();
  });

  it("saves manual mode only once a valid proxy address is entered", async () => {
    await changeLanguage("zh-CN");
    const { update } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "手动" }));
    const input = screen.getByLabelText(/^代理地址/);
    fireEvent.change(input, { target: { value: "127.0.0.1:7890" } });
    fireEvent.blur(input);
    expect(screen.getByText(/请填写 http:\/\//)).toBeTruthy();
    fireEvent.change(input, { target: { value: "http://127.0.0.1:7890" } });
    fireEvent.blur(input);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ proxyMode: "manual", proxyUrl: "http://127.0.0.1:7890" }));
    expect(update).toHaveBeenCalledTimes(1);
  });
});
