// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import StudioPane from "./StudioPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";
import type { BuiltinTransformationDto, InsightDto, TransformationDto } from "../../../../shared/transformations";
import type { TaskDto } from "../../../../shared/tasks";

const builtin: BuiltinTransformationDto = {
  key: "summary", language: "zh-CN", name: "总结", appliesTo: "source", prompt: "总结 {{content}}"
};

const keyPointsBuiltin: BuiltinTransformationDto = {
  key: "key-points", language: "zh-CN", name: "要点", appliesTo: "source", prompt: "提取要点 {{content}}"
};

const rule: TransformationDto = {
  id: "9a1a1111-1111-4111-8111-111111111111",
  projectId: "1a1a1111-1111-4111-8111-111111111111",
  name: "我的规则", appliesTo: "source",
  prompt: "提取要点 {{content}}", version: 1, enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

const insight: InsightDto = {
  id: "8a1a1111-1111-4111-8111-111111111111",
  projectId: "1a1a1111-1111-4111-8111-111111111111",
  transformationId: rule.id, taskId: null, inputKind: "source", inputHash: "h",
  ruleVersion: 1, content: "洞察内容", provider: "openai", model: "gpt-test", profileId: null,
  usage: null, idempotencyKey: "k",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

const refreshedInsight: InsightDto = { ...insight, id: "6a1a1111-1111-4111-8111-111111111111", content: "更新后的洞察" };

const projectId = "1a1a1111-1111-4111-8111-111111111111";
const revisionId = "5a1a1111-1111-4111-8111-111111111111";

function mockApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  const api = {
    transformations: {
      listBuiltins: vi.fn(async () => ({ ok: true as const, value: [builtin, keyPointsBuiltin] })),
      listRules: vi.fn(async () => ({ ok: true as const, value: [rule] })),
      listInsights: vi.fn(async () => ({ ok: true as const, value: [insight] })),
      run: vi.fn(async () => ({ ok: true as const, value: taskDto() })),
      cancel: vi.fn(), retry: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(), convertToNote: vi.fn()
    },
    sources: {
      list: vi.fn(async () => [
        {
          id: "2a2a2222-2222-4222-8222-222222222222", projectId, kind: "pdf" as const,
          displayName: "论文.pdf", status: "active" as const, currentRevisionId: revisionId,
          createdAt: "", updatedAt: "", deletedAt: null, currentRevisionState: "ready" as const
        }
      ]),
      chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), open: vi.fn(), remove: vi.fn(), retry: vi.fn()
    },
    notes: {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      create: vi.fn(), get: vi.fn(), update: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      delete: vi.fn(), createLink: vi.fn(), listLinks: vi.fn(), deleteLink: vi.fn(), generateTitle: vi.fn()
    },
    conversations: {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn()
    },
    tasks: {
      list: vi.fn(async () => []),
      cancel: vi.fn(), subscribe: vi.fn(() => () => undefined)
    },
    ...overrides
  } as unknown as DesktopApi;
  const desktopApi = api as unknown as DesktopApi;
  (window as unknown as { myNotebook: DesktopApi }).myNotebook = desktopApi;
  return desktopApi;
}

function taskDto() {
  return {
    id: "7a1a1111-1111-4111-8111-111111111111", projectId, sourceId: null,
    kind: "transformation" as const, state: "queued" as const, stage: "preparing" as const,
    progress: 0, attempt: 0, error: null, idempotencyKey: "k",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("StudioPane", () => {
  it("lists built-in and custom rules plus insights", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    expect(await screen.findByText("洞察内容")).toBeTruthy();
    // The rule select uses the themed rounded listbox.
    const ruleSelect = screen.getByRole("button", { name: "规则" });
    expect(ruleSelect.className).toContain("rounded-select-trigger");
    fireEvent.click(ruleSelect);
    expect(screen.getByRole("option", { name: "总结" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "要点" })).toBeNull();
    expect(screen.getByRole("option", { name: "我的规则" })).toBeTruthy();
  });

  it("runs a builtin transformation against the selected ready source revision", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("总结");
    const runButton = screen.getByRole("button", { name: /运行转换/ });
    expect((runButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("来源"));
    fireEvent.click(await screen.findByRole("option", { name: "论文.pdf" }));
    expect((runButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(runButton);

    const api = (window as unknown as { myNotebook: DesktopApi }).myNotebook;
    expect(api.transformations!.run).toHaveBeenCalledWith({
      projectId,
      builtinKey: "summary",
      language: "zh-CN",
      sourceRevisionIds: [revisionId]
    });
  });

  it("runs a custom rule and keeps the run button disabled without a target", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("洞察内容");
    fireEvent.click(screen.getByRole("button", { name: "规则" }));
    fireEvent.click(await screen.findByRole("option", { name: "我的规则" }));
    const runButton = screen.getByRole("button", { name: /运行转换/ });
    expect((runButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("来源"));
    fireEvent.click(await screen.findByRole("option", { name: "论文.pdf" }));
    fireEvent.click(runButton);

    const api = (window as unknown as { myNotebook: DesktopApi }).myNotebook;
    expect(api.transformations!.run).toHaveBeenCalledWith({
      projectId,
      transformationId: rule.id,
      sourceRevisionIds: [revisionId]
    });
  });

  it("shows only ready sources as pickable targets", async () => {
    mockApi({
      sources: {
        chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), open: vi.fn(), remove: vi.fn(), retry: vi.fn(),
        list: vi.fn(async () => [
          {
            id: "2a2a2222-2222-4222-8222-222222222222", projectId, kind: "pdf" as const,
            displayName: "就绪.pdf", status: "active" as const, currentRevisionId: revisionId,
            createdAt: "", updatedAt: "", deletedAt: null, currentRevisionState: "ready" as const
          },
          {
            id: "3a3a3333-3333-4333-8333-333333333333", projectId, kind: "pdf" as const,
            displayName: "处理中.pdf", status: "active" as const, currentRevisionId: "6a1a1111-1111-4111-8111-111111111111",
            createdAt: "", updatedAt: "", deletedAt: null, currentRevisionState: "parsing" as const
          }
        ])
      }
    });
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("总结");
    fireEvent.click(screen.getByLabelText("来源"));
    const options = await screen.findAllByRole("option", { name: "就绪.pdf" });
    expect(options).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "处理中.pdf" })).toBeNull();
  });

  it("opens the full insight in a detail dialog", async () => {
    const api = mockApi();
    vi.mocked(api.transformations!.listInsights).mockResolvedValue({
      ok: true,
      value: [{
        ...insight,
        content: "## 洞察标题\n\n1. **问：** 问题  \n   **答：**考试日期为 6 月 13 日。"
      }]
    });
    render(<StudioPane projectId={projectId} />);

    await screen.findByText(/考试日期为/);
    fireEvent.click(screen.getByRole("button", { name: "查看详细" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("heading", { name: "洞察详情" })).toBeTruthy();
    expect(dialog.querySelector(".insight-detail-content h2")?.textContent).toBe("洞察标题");
    expect(dialog.querySelectorAll(".insight-detail-content strong").length).toBe(2);
    expect(dialog.textContent).not.toContain("**答：**");
  });

  it("uses the themed dropdown for a custom rule target", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    fireEvent.click(screen.getByRole("button", { name: "新建自定义规则" }));
    const target = await screen.findByRole("button", { name: "适用目标" });
    expect(target.className).toContain("rounded-select-trigger");
    fireEvent.click(target);
    expect(screen.getByRole("option", { name: "模型回答" })).toBeTruthy();
  });

  it("reloads insights when a transformation task completes", async () => {
    const api = mockApi();
    const listInsights = vi.mocked(api.transformations!.listInsights);
    listInsights.mockResolvedValueOnce({ ok: true, value: [insight] });
    listInsights.mockResolvedValueOnce({ ok: true, value: [insight, refreshedInsight] });
    let emit: ((task: TaskDto) => void) | undefined;
    api.tasks!.subscribe = vi.fn((_id, listener) => {
      emit = listener;
      return () => undefined;
    });
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("洞察内容");
    await act(async () => {
      emit?.({ ...taskDto(), state: "completed", stage: "saving", progress: 1000, updatedAt: "2026-01-01T00:01:00.000Z" });
    });
    await waitFor(() => expect(screen.getByText("更新后的洞察")).toBeTruthy());
    expect(listInsights).toHaveBeenCalledTimes(2);
  });
});
