// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../i18n";
import ModelAdvancedForm from "./ModelAdvancedForm";
import type { ModelProfileDto } from "../../../../shared/models";

const profile: ModelProfileDto = { id: "11111111-1111-4111-8111-111111111111", name: "Test", provider: "openai", capability: "generation", baseUrl: "https://example.test", modelId: "m", enabled: true, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", contextTokensOverride: 1000000, maxOutputTokensOverride: 8192 };
afterEach(cleanup);
describe("ModelAdvancedForm", () => {
  it("only saves the two advanced fields without discovery or credentials", async () => {
    const updateGenerationSettings = vi.fn(async () => ({ ok:true as const,value:profile }));
    window.myNotebook = { models:{ updateGenerationSettings } } as unknown as typeof window.myNotebook;
    const onSaved = vi.fn();
    render(<ModelAdvancedForm profile={profile} onSaved={onSaved} onCancel={() => {}} />);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.queryByDisplayValue(profile.baseUrl)).toBeNull();
    fireEvent.change(screen.getAllByRole("spinbutton")[1]!,{target:{value:"16384"}});
    fireEvent.click(screen.getByRole("button",{name:"保存"}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
    expect(updateGenerationSettings).toHaveBeenCalledWith({profileId:profile.id,contextTokensOverride:1000000,maxOutputTokensOverride:16384});
  });
  it("restores empty fields to null and preserves input when saving fails", async () => {
    const updateGenerationSettings = vi.fn(async () => ({ok:false as const,error:{code:"VALIDATION" as const,messageKey:"errors.generationOutputLimit",recoverable:true,details:{limitTokens:4096}}}));
    window.myNotebook = {models:{updateGenerationSettings}} as unknown as typeof window.myNotebook;
    render(<ModelAdvancedForm profile={profile} onSaved={()=>{}} onCancel={()=>{}} />);
    fireEvent.change(screen.getAllByRole("spinbutton")[0]!,{target:{value:""}});
    fireEvent.click(screen.getByRole("button",{name:"保存"}));
    await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("4096"));
    expect(updateGenerationSettings).toHaveBeenCalledWith({profileId:profile.id,contextTokensOverride:null,maxOutputTokensOverride:8192});
    expect((screen.getAllByRole("spinbutton")[1] as HTMLInputElement).value).toBe("8192");
  });
});
