// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import type { ChatRequestEvent, DesktopApi } from "../../shared/ipc";
import type { MessageDto } from "../../shared/chat";
import type { ProjectDto } from "../../shared/projects";

const projectId = "1a1a1111-1111-4111-8111-111111111111";

const project: ProjectDto = {
  id: projectId,
  name: "毕业论文调研",
  archived: false,
  status: "active",
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z"
};

function mockApi(overrides: {
  onboardingCompleted?: boolean;
  readySource?: boolean;
} = {}): DesktopApi {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  return {
    settings: {
      get: vi.fn(async () => ok({ onboardingCompleted: overrides.onboardingCompleted ?? true, locale: "zh-CN", theme: "light", proxyMode: "system", proxyUrl: "", proxyBypass: "" })),
      update: vi.fn(async () => ok({ onboardingCompleted: true, locale: "zh-CN", theme: "light", proxyMode: "system", proxyUrl: "", proxyBypass: "" }))
    },
    projects: {
      list: vi.fn(async () => [project]),
      listArchived: vi.fn(async () => []),
      listDeleteFailed: vi.fn(async () => []),
      create: vi.fn(), rename: vi.fn(), archive: vi.fn(), remove: vi.fn(), restore: vi.fn(), undo: vi.fn(), retryDelete: vi.fn()
    },
    models: {
      listProfiles: vi.fn(async () => ok({ profiles: [], builtInProfiles: [], credentials: [] })),
      getDefaultRoutes: vi.fn(async () => ok({ generationProfileId: "4a4a4444-4444-4444-8444-444444444444" })),
      setDefaultRoutes: vi.fn(), saveProfile: vi.fn(), deleteProfile: vi.fn(), discover: vi.fn(), test: vi.fn(),
      getRoutes: vi.fn(async () => ok([])),
      saveRoutes: vi.fn(),
      listRouteAttempts: vi.fn(async () => ok([]))
    },
    credentials: { set: vi.fn(), remove: vi.fn() },
    titleOverlay: { setTheme: vi.fn(async () => ok(undefined)) },
    sources: {
      chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), open: vi.fn(), remove: vi.fn(), retry: vi.fn(),
      list: vi.fn(async () => overrides.readySource === false ? [] : [
        {
          id: "2a2a2222-2222-4222-8222-222222222222", projectId, kind: "pdf" as const,
          displayName: "论文.pdf", status: "active" as const, currentRevisionId: "5a5a5555-5555-4555-8555-555555555555",
          createdAt: "", updatedAt: "", deletedAt: null, currentRevisionState: "ready" as const
        }
      ])
    },
    tasks: {
      list: vi.fn(async () => []),
      cancel: vi.fn(),
      subscribe: vi.fn(() => () => undefined)
    },
    vector: {
      getHealth: vi.fn(async () => ok({ spaceId: "6a6a6666-6666-4666-8666-666666666666", healthy: true, indexedCount: 3 })),
      startMigration: vi.fn(), rebuild: vi.fn(), optimize: vi.fn(), cancelTask: vi.fn(),
      subscribe: vi.fn(() => () => undefined)
    },
    retrieval: { search: vi.fn() },
    conversations: {
      list: vi.fn(async () => ok([])),
      create: vi.fn(async () => ok({
        id: "3a3a3333-3333-4333-8333-333333333333", projectId, title: "对话",
        createdAt: "", updatedAt: "", deletedAt: null, archivedAt: null
      })),
      rename: vi.fn(), archive: vi.fn(), delete: vi.fn(),
      listMessages: vi.fn(async () => ok([]))
    },
    chat: {
      send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(),
      subscribe: vi.fn(() => () => undefined), unsubscribe: vi.fn()
    },
    citations: { open: vi.fn() },
    notes: {
      create: vi.fn(), get: vi.fn(), list: vi.fn(async () => ok([])), update: vi.fn(), archive: vi.fn(),
      restore: vi.fn(), delete: vi.fn(), createLink: vi.fn(), listLinks: vi.fn(async () => ok([])),
      deleteLink: vi.fn(), generateTitle: vi.fn()
    },
    transformations: {
      listRules: vi.fn(async () => ok([])),
      createRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(),
      listBuiltins: vi.fn(async () => ok([])),
      run: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
      listInsights: vi.fn(async () => ok([])), convertToNote: vi.fn()
    }
  } as unknown as DesktopApi;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("App shell", () => {
  it("boots into the workspace with the selected project and section tabs", async () => {
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = mockApi();
    render(<App />);

    expect((await screen.findAllByText("毕业论文调研")).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "研究" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "笔记" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "转换" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "新建项目" }).length).toBeGreaterThan(0);
  });

  it("shows the onboarding screen for first launch", async () => {
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = mockApi({ onboardingCompleted: false });
    render(<App />);

    expect(await screen.findByText("欢迎使用 MyNotebookLM")).toBeTruthy();
    expect(screen.getByRole("button", { name: "完成并开始使用" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "稍后配置模型" })).toBeTruthy();
  });

  it("renders the chat composer when a generation route and an indexed source exist", async () => {
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = mockApi();
    render(<App />);

    expect(await screen.findByLabelText("针对这个项目提问")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });

  it("switches to the notes pane and back via the section tabs", async () => {
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = mockApi();
    render(<App />);

    await screen.findAllByText("毕业论文调研");
    fireEvent.click(screen.getByRole("tab", { name: "笔记" }));
    expect((await screen.findAllByRole("button", { name: "新建笔记" })).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "研究" }));
    expect(await screen.findByLabelText("针对这个项目提问")).toBeTruthy();
  });

  it.each(["笔记", "转换", "设置", "其他项目"])("keeps the answer streaming when navigating to %s", async (destination) => {
    const api = mockApi();
    const otherProject = { ...project, id: "7a7a7777-7777-4777-8777-777777777777", name: "其他项目" };
    vi.mocked(api.projects.list).mockResolvedValue([project, otherProject]);
    const conversationId = "3a3a3333-3333-4333-8333-333333333333";
    vi.mocked(api.conversations.list).mockImplementation(async (input) => ({ ok: true, value: input.projectId === projectId ? [{
      id: conversationId, projectId, title: "流式对话", createdAt: "", updatedAt: "", deletedAt: null, archivedAt: null
    }] : [] }));
    let sink!: (event: ChatRequestEvent) => void;
    let requestId = "";
    const unsubscribe = vi.fn();
    vi.mocked(api.chat.subscribe).mockImplementation((id, listener) => { requestId = id; sink = listener; return unsubscribe; });
    vi.mocked(api.chat.send).mockImplementation(async (input) => ({ ok: true, value: { requestId: input.requestId, assistantMessageId: "live-answer" } }));
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
    render(<App />);
    await screen.findByRole("button", { name: /流式对话/ });
    fireEvent.change(screen.getByLabelText("针对这个项目提问"), { target: { value: "持续回答" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(1));
    await act(async () => { sink({ type: "text-delta", requestId, messageId: "live-answer", text: "切换前，" }); });

    if (destination === "设置") fireEvent.click(screen.getByRole("button", { name: "设置" }));
    else if (destination === "其他项目") fireEvent.click(document.querySelectorAll<HTMLButtonElement>(".project-item-btn")[1]!);
    else fireEvent.click(screen.getByRole("tab", { name: destination }));
    expect(screen.queryByText("切换前，")).toBeNull();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(api.chat.stop).not.toHaveBeenCalled();
    await act(async () => { sink({ type: "text-delta", requestId, messageId: "live-answer", text: "后台继续。" }); });

    if (destination === "设置") fireEvent.click(screen.getByRole("button", { name: "返回" }));
    else if (destination === "其他项目") fireEvent.click(document.querySelectorAll<HTMLButtonElement>(".project-item-btn")[0]!);
    else fireEvent.click(screen.getByRole("tab", { name: "研究" }));
    expect(await screen.findByText("切换前，后台继续。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    expect(api.chat.subscribe).toHaveBeenCalledTimes(1);

    const completed: MessageDto = {
      id: "live-answer", conversationId, sequence: 2, role: "assistant", content: "切换前，后台继续。已完成。",
      state: "completed", replyToMessageId: "saved-question", supersedesMessageId: null, superseded: false,
      provider: "openai", profileId: null, model: "test", usage: null, errorCode: null, completionReason: "stop",
      createdAt: "", updatedAt: "", citations: []
    };
    await act(async () => { sink({ type: "completed", requestId, messageId: completed.id, message: completed }); });
    expect(screen.getByText(completed.content)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("persists the selected language and theme", async () => {
    const api = mockApi();
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
    render(<App />);

    await screen.findAllByText("毕业论文调研");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    fireEvent.click(screen.getByRole("button", { name: "English" }));

    await waitFor(() => {
      expect(api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
      expect(api.settings.update).toHaveBeenCalledWith({ locale: "en" });
    });
  });

  it("shows the empty workspace state when no project exists", async () => {
    const api = mockApi();
    (api.projects.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
    render(<App />);

    expect(await screen.findByText("开始新的研究项目")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "新建项目" }).length).toBeGreaterThan(0);
  });
});
