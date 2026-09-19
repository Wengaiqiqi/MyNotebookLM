// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../../../../shared/ipc";
import type { BuiltInModelProfileDto, ModelProfileDto, ModelRouteDto } from "../../../../shared/models";
import "../../i18n";
import Settings from "./Settings";

describe("Settings Component", () => {
  afterEach(() => cleanup());

  const mockProfiles: ModelProfileDto[] = [
    {
      id: "p-1",
      name: "闲卡",
      provider: "openai-compatible",
      capability: "generation",
      baseUrl: "https://api.xianka.com/v1",
      modelId: "glm-5.3-flash",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "p-2",
      name: "闲卡 / 2",
      provider: "openai-compatible",
      capability: "generation",
      baseUrl: "https://api.xianka.com/v1",
      modelId: "qwen3.8-flash",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  const mockBuiltIns: BuiltInModelProfileDto[] = [
    {
      id: "b-1",
      name: "本地内置嵌入",
      provider: "local",
      capability: "embedding",
      baseUrl: "",
      modelId: "bge-small-zh-v1.5",
      enabled: true,
      dimension: 384,
      distance: "cosine",
      pooling: "mean",
      normalized: true,
      preprocessingVersion: "1",
      metadata: {
        dimension: 384,
        distance: "cosine",
        pooling: "mean",
        normalized: true,
        preprocessingVersion: "1"
      },
      editable: false,
      requiresCredential: false
    }
  ];

  function setupApi(overrides: Partial<DesktopApi["models"]> = {}) {
    const listProfiles = vi.fn(async () => ({
      ok: true as const,
      value: {
        profiles: mockProfiles,
        builtInProfiles: mockBuiltIns
      }
    }));
    const deleteProfile = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const getRoutes = vi.fn(async () => ({
      ok: true as const,
      value: [] as ModelRouteDto[]
    }));
    const saveRoutes = vi.fn(async ({ profileIds }: { profileIds: string[] }) => ({
      ok: true as const,
      value: profileIds.map((id, index) => ({
        taskKind: "chat" as const,
        position: index,
        profileId: id
      }))
    }));

    const api = {
      models: {
        listProfiles,
        deleteProfile,
        getRoutes,
        saveRoutes,
        ...overrides
      }
    } as unknown as DesktopApi;
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
    return { listProfiles, deleteProfile, getRoutes, saveRoutes };
  }

  it("opens a model deep link only once after saving and refreshing profiles", async () => {
    const listProfiles = vi.fn(async () => ({ ok: true as const, value: { profiles: mockProfiles.map((profile) => ({ ...profile })), builtInProfiles: mockBuiltIns, credentials: [] } }));
    const updateGenerationSettings = vi.fn(async () => ({ ok: true as const, value: mockProfiles[0]! }));
    setupApi({ listProfiles, updateGenerationSettings });
    render(<Settings initialModelProfileId="p-1" language="zh-CN" theme="light" onLanguage={() => {}} onTheme={() => {}} onRoutesChanged={() => {}} onClose={() => {}} />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateGenerationSettings).toHaveBeenCalledTimes(1);
  });

  it("groups models under provider card and toggles details drawer", async () => {
    setupApi();
    render(
      <Settings
        projectId="proj-1"
        language="zh-CN"
        theme="light"
        onLanguage={() => {}}
        onTheme={() => {}}
        onRoutesChanged={() => {}}
        onClose={() => {}}
      />
    );

    // Wait for profiles to load
    await screen.findByText("闲卡");

    // Check provider card details
    expect(screen.getByText("共 2 个模型")).toBeTruthy();
    expect(screen.getByText("https://api.xianka.com/v1")).toBeTruthy();

    // Models should not be visible initially before clicking details
    expect(screen.queryByText("glm-5.3-flash")).toBeNull();

    // Click "详细" button
    const detailBtn = screen.getByRole("button", { name: /详细/i });
    fireEvent.click(detailBtn);

    // Now drawer opens, showing the individual models
    expect(await screen.findByText("glm-5.3-flash")).toBeTruthy();
    expect(screen.getByText("qwen3.8-flash")).toBeTruthy();

    // Button should now read "收起"
    expect(screen.getByRole("button", { name: /收起/i })).toBeTruthy();

    // Click "收起" to collapse again
    fireEvent.click(screen.getByRole("button", { name: /收起/i }));
    expect(screen.queryByText("glm-5.3-flash")).toBeNull();
  });

  it("cascades provider and model selection in RoutesPanel", async () => {
    const { saveRoutes } = setupApi();
    render(
      <Settings
        projectId="proj-1"
        language="zh-CN"
        theme="light"
        onLanguage={() => {}}
        onTheme={() => {}}
        onRoutesChanged={() => {}}
        onClose={() => {}}
      />
    );

    // Switch to Routes panel
    const routesTab = screen.getByRole("button", { name: /任务路由/i });
    fireEvent.click(routesTab);

    // Find the cascading select triggers
    const providerTrigger = await screen.findByRole("button", { name: "选择提供商…" });
    expect(providerTrigger).toBeTruthy();

    // Level 2 model selector should be disabled initially
    const modelTrigger = screen.getByRole("button", { name: "请先选择提供商…" }) as HTMLButtonElement;
    expect(modelTrigger.disabled).toBe(true);

    // Click provider selector to open menu
    fireEvent.click(providerTrigger);

    // Select "闲卡" provider
    const providerOption = await screen.findByRole("option", { name: /闲卡/ });
    fireEvent.click(providerOption);

    // Level 2 model selector should now be enabled
    expect(modelTrigger.disabled).toBe(false);

    // Open model selector
    fireEvent.click(modelTrigger);

    // Select glm-5.3-flash
    const modelOption = await screen.findByRole("option", { name: "glm-5.3-flash" });
    fireEvent.click(modelOption);

    // Route step should now be added: "闲卡 / glm-5.3-flash"
    expect(await screen.findByText("闲卡 / glm-5.3-flash")).toBeTruthy();

    // Save button should be enabled
    const saveBtn = screen.getByRole("button", { name: /保存路由/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await waitFor(() => expect(saveRoutes).toHaveBeenCalledTimes(1));
    expect(saveRoutes).toHaveBeenCalledWith(expect.objectContaining({
      profileIds: ["p-1"]
    }));
  });

  it("shows only the current route task options", async () => {
    setupApi();
    render(
      <Settings
        projectId="proj-1"
        language="zh-CN"
        theme="light"
        onLanguage={() => {}}
        onTheme={() => {}}
        onRoutesChanged={() => {}}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /任务路由/i }));
    const taskSelect = await screen.findByRole("button", { name: "任务" });
    fireEvent.click(taskSelect);

    expect(screen.getByRole("option", { name: "摘要" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "总结" })).toBeNull();
    expect(screen.queryByRole("option", { name: "要点" })).toBeNull();
  });

  it("deletes a single model from expanded drawer", async () => {
    const { deleteProfile } = setupApi();
    render(
      <Settings
        projectId="proj-1"
        language="zh-CN"
        theme="light"
        onLanguage={() => {}}
        onTheme={() => {}}
        onRoutesChanged={() => {}}
        onClose={() => {}}
      />
    );

    await screen.findByText("闲卡");
    // Open drawer
    fireEvent.click(screen.getByRole("button", { name: /详细/i }));
    await screen.findByText("glm-5.3-flash");

    // Click delete for individual model glm-5.3-flash
    const delModelBtn = screen.getByRole("button", { name: /删除: glm-5.3-flash/i });
    fireEvent.click(delModelBtn);

    // Confirm dialog appears
    const confirmBtn = await screen.findByRole("button", { name: "确认" });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledTimes(1));
    expect(deleteProfile).toHaveBeenCalledWith({ id: "p-1" });
  });

  it("deletes all models under a provider when deleting the provider card", async () => {
    const { deleteProfile } = setupApi();
    render(
      <Settings
        projectId="proj-1"
        language="zh-CN"
        theme="light"
        onLanguage={() => {}}
        onTheme={() => {}}
        onRoutesChanged={() => {}}
        onClose={() => {}}
      />
    );

    await screen.findByText("闲卡");

    // Click delete for provider "闲卡"
    const delProviderBtn = screen.getByRole("button", { name: /删除: 闲卡/i });
    fireEvent.click(delProviderBtn);

    // Confirm dialog appears
    const confirmBtn = await screen.findByRole("button", { name: "确认" });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledTimes(2));
    expect(deleteProfile).toHaveBeenCalledWith({ id: "p-1" });
    expect(deleteProfile).toHaveBeenCalledWith({ id: "p-2" });
  });

  it("opens provider editor from provider card with models preselected and saves changes", async () => {
    const saveProfile = vi.fn(async ({ profile }: { profile: ModelProfileDto }) => ({ ok: true as const, value: profile }));
    setupApi({ saveProfile });
    render(
      <Settings
        projectId="proj-1"
        language="zh-CN"
        theme="light"
        onLanguage={() => {}}
        onTheme={() => {}}
        onRoutesChanged={() => {}}
        onClose={() => {}}
      />
    );

    await screen.findByText("闲卡");

    // Click Edit button on the "闲卡" provider card
    const editBtn = screen.getByRole("button", { name: "编辑: 闲卡" });
    fireEvent.click(editBtn);

    // Modal opens with edit title and pre-selected models
    expect(await screen.findByRole("heading", { name: "编辑提供商配置", level: 2 })).toBeTruthy();
    expect(screen.getByDisplayValue("https://api.xianka.com/v1")).toBeTruthy();
    expect(screen.getByDisplayValue("已选择 2 个模型")).toBeTruthy();

    // Change the global URL for this provider
    const urlInput = screen.getByLabelText("API 地址");
    fireEvent.change(urlInput, { target: { value: "https://new-api.xianka.com/v1" } });

    // Click Save
    const saveModalBtn = screen.getByRole("button", { name: "保存" });
    fireEvent.click(saveModalBtn);

    // Both models should be saved with the updated URL
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2));
    expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({
        id: "p-1",
        baseUrl: "https://new-api.xianka.com/v1"
      })
    }));
    expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({
        id: "p-2",
        baseUrl: "https://new-api.xianka.com/v1"
      })
    }));
  });
});
