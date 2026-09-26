// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import StudioPane from "./StudioPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";
import type { BuiltinTransformationDto, InsightDto, TransformationDto } from "../../../../shared/transformations";
import type { TaskDto } from "../../../../shared/tasks";
import { toast } from "../../ui/Toast";

const builtin: BuiltinTransformationDto = {
  key: "summary", language: "zh-CN", name: "摘要", appliesTo: "source", prompt: "摘要 {{content}}"
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
      cancel: vi.fn(), retry: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(), deleteInsight: vi.fn(), convertToNote: vi.fn()
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
  it("removes cancelled work immediately and keeps it absent after remount", async () => {
    const api = mockApi();
    const active: TaskDto = { ...taskDto(), state: "running", progress: 200 };
    const cancelled: TaskDto = { ...active, state: "cancelled", updatedAt: "2026-01-02T00:00:00.000Z" };
    vi.mocked(api.tasks!.list).mockResolvedValue([active]);
    vi.mocked(api.transformations!.cancel).mockResolvedValue({ ok: true, value: cancelled });
    const first = render(<StudioPane projectId={projectId} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    first.unmount();
    vi.mocked(api.tasks!.list).mockResolvedValue([cancelled]);
    render(<StudioPane projectId={projectId} />);
    await screen.findByText("洞察内容");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("restores the running percentage and elapsed time after leaving the pane", async () => {
    vi.useFakeTimers();
    try {
      const api = mockApi();
      const active: TaskDto = { ...taskDto(), id: "restored-progress", state: "running", progress: 400 };
      vi.mocked(api.tasks!.list).mockResolvedValue([active]);
      const first = render(<StudioPane projectId={projectId} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { vi.advanceTimersByTime(3_000); });
      const percent = (): number => Number(screen.getByRole("status").querySelector(".task-card-percent")!.textContent!.replace("%", ""));
      const before = percent();
      first.unmount();
      await act(async () => { vi.advanceTimersByTime(2_000); });
      render(<StudioPane projectId={projectId} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(percent()).toBe(before);
      expect(screen.getByText("已用 5 秒")).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(percent()).toBeGreaterThanOrEqual(before);
    } finally { vi.useRealTimers(); }
  });

  it("shows actual speech progress without advancing into saving while TTS is waiting", async () => {
    vi.useFakeTimers();
    try {
      const api = mockApi();
      let emit!: (task: TaskDto) => void;
      api.tasks!.subscribe = vi.fn((_id, listener) => { emit = listener; return () => undefined; });
      const active: TaskDto = { ...taskDto(), id: "podcast-progress", state: "running", stage: "generating", progress: 450, transformationKind: "podcast" };
      vi.mocked(api.tasks!.list).mockResolvedValue([active]);
      render(<StudioPane projectId={projectId} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.getByText("合成双人语音")).toBeTruthy();
      expect(screen.getByText("45%")).toBeTruthy();
      await act(async () => { emit({ ...active, progress: 700, updatedAt: "2026-01-02T00:00:00.000Z" }); });
      expect(screen.getByText("70%")).toBeTruthy();
      expect(screen.queryByText("正在整理结果")).toBeNull();
      await act(async () => { emit({ ...active, progress: 980, stage: "saving", updatedAt: "2026-01-03T00:00:00.000Z" }); });
      expect(screen.getByText("保存播客音频")).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("does not announce a retry as started when preflight already failed", async () => {
    const api = mockApi();
    const failed: TaskDto = { ...taskDto(), state: "failed", error: { code: "VALIDATION", messageKey: "errors.validation", recoverable: false } };
    vi.mocked(api.tasks!.list).mockResolvedValue([failed]);
    vi.mocked(api.transformations!.retry).mockResolvedValue({ ok: true, value: failed });
    const info = vi.spyOn(toast, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(toast, "error").mockImplementation(() => undefined);
    render(<StudioPane projectId={projectId} />);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it("unlocks retry after a rejected request and prevents repeated clicks while pending", async () => {
    const api = mockApi();
    const failed: TaskDto = { ...taskDto(), state: "failed" };
    vi.mocked(api.tasks!.list).mockResolvedValue([failed]);
    let reject!: (reason: Error) => void;
    vi.mocked(api.transformations!.retry).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => undefined);
    render(<StudioPane projectId={projectId} />);
    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(api.transformations!.retry).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("IPC disconnected")); });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(errorToast).toHaveBeenCalled();
    errorToast.mockRestore();
  });

  it("prioritizes active work and does not resurrect an older failure after retry completion", async () => {
    const api = mockApi();
    let emit!: (task: TaskDto) => void;
    api.tasks!.subscribe = vi.fn((_id, listener) => { emit = listener; return () => undefined; });
    const active: TaskDto = { ...taskDto(), state: "running" };
    vi.mocked(api.tasks!.list).mockResolvedValue([
      { ...taskDto(), id: "old-failure", state: "failed", updatedAt: "2026-01-02T00:00:00.000Z" }, active
    ]);
    render(<StudioPane projectId={projectId} />);
    await screen.findByRole("button", { name: "取消" });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    await act(async () => { emit({ ...active, state: "completed", progress: 1000, updatedAt: "2026-01-03T00:00:00.000Z" }); });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("keeps a live retry completion when an older initial task list arrives late", async () => {
    const api = mockApi();
    let emit!: (task: TaskDto) => void;
    let resolve!: (items: TaskDto[]) => void;
    api.tasks!.subscribe = vi.fn((_id, listener) => { emit = listener; return () => undefined; });
    vi.mocked(api.tasks!.list).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<StudioPane projectId={projectId} />);
    await act(async () => { emit({ ...taskDto(), state: "completed", progress: 1000 }); });
    await act(async () => { resolve([{ ...taskDto(), state: "failed" }]); });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("lists built-in and custom rules plus insights", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    expect(await screen.findByText("洞察内容")).toBeTruthy();
    // The rule select uses the themed rounded listbox.
    const ruleSelect = screen.getByRole("button", { name: "规则" });
    expect(ruleSelect.className).toContain("rounded-select-trigger");
    fireEvent.click(ruleSelect);
    expect(screen.getByRole("option", { name: "摘要" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "要点" })).toBeNull();
    expect(screen.getByRole("option", { name: "我的规则" })).toBeTruthy();
    const insightsRegion = screen.getByRole("region", { name: "洞察" });
    const practiceRegion = screen.getByRole("region", { name: "互动答题" });
    expect(insightsRegion.compareDocumentPosition(practiceRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("runs a builtin transformation against the selected ready source revision", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("摘要");
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
      force: true,
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
      force: true,
      sourceRevisionIds: [revisionId]
    });
  });

  it("resets a completed progress card immediately when starting the same transformation again", async () => {
    const api = mockApi();
    vi.mocked(api.tasks!.list).mockResolvedValue([{ ...taskDto(), state: "completed", progress: 1000 }]);
    let resolveRun!: (value: Awaited<ReturnType<NonNullable<DesktopApi["transformations"]>["run"]>>) => void;
    vi.mocked(api.transformations!.run).mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
    const info = vi.spyOn(toast, "info").mockImplementation(() => undefined);
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("已完成");
    expect(screen.getByText("100%")).toBeTruthy();
    const progressFill = screen.getByRole("status").querySelector(".progress i") as HTMLElement;
    expect(progressFill.style.width).toBe("100%");
    fireEvent.click(screen.getByLabelText("来源"));
    fireEvent.click(await screen.findByRole("option", { name: "论文.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: /运行转换/ }));
    expect(await screen.findByText("排队中")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();

    await act(async () => { resolveRun({ ok: true, value: { ...taskDto(), id: "7a1a1111-1111-4111-8111-111111111112" } }); });
    expect(screen.getByText("排队中")).toBeTruthy();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("forces 100% progress when task is marked completed even if reported progress is incomplete", async () => {
    const api = mockApi();
    vi.mocked(api.tasks!.list).mockResolvedValue([{ ...taskDto(), state: "completed", progress: 900 }]);
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("已完成");
    expect(screen.getByText("100%")).toBeTruthy();
    const progressFill = screen.getByRole("status").querySelector(".progress i") as HTMLElement;
    expect(progressFill.style.width).toBe("100%");
  });

  it("climbs the percentage continuously and replaces the milestone label", async () => {
    vi.useFakeTimers();
    try {
      const api = mockApi();
      let emit!: (task: TaskDto) => void;
      api.tasks!.subscribe = vi.fn((_id, listener) => { emit = listener; return () => undefined; });
      vi.mocked(api.tasks!.list).mockResolvedValue([{ ...taskDto(), state: "running", stage: "preparing", progress: 0 }]);
      render(<StudioPane projectId={projectId} />);
      // Flush the initial task list before touching the card.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const fill = (): HTMLElement => screen.getByRole("status").querySelector(".progress i") as HTMLElement;
      const percent = (): number => Number((screen.getByRole("status").querySelector(".task-card-percent") as HTMLElement).textContent!.replace("%", ""));

      expect(screen.getByText("准备资料")).toBeTruthy();
      // Preparing takes 4s of visible climb toward 20%, even before the main
      // process reports the first milestone.
      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(percent()).toBe(20);
      expect(fill().style.width).toBe("20%");
      // The copy replaces in place once the number reaches the milestone.
      expect(screen.queryByText("准备资料")).toBeNull();
      expect(screen.getByText("模型响应中")).toBeTruthy();

      // Model response in progress advances at 4% per second.
      await act(async () => { emit({ ...taskDto(), state: "running", stage: "generating", progress: 200, updatedAt: "2026-01-01T00:00:01.500Z" }); });
      expect(percent()).toBe(20);
      expect(screen.getByText("模型响应中")).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(2_500); });
      expect(percent()).toBe(30);

      // A real response changes the label immediately and catches up to 50%.
      await act(async () => { emit({ ...taskDto(), state: "running", stage: "generating", progress: 400, updatedAt: "2026-01-01T00:00:02.000Z" }); });
      expect(screen.getByText("正在生成内容")).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(percent()).toBe(48);
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(percent()).toBe(50);

      // At the visible 80%, the label and rate change without a backend update.
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(percent()).toBe(80);
      expect(screen.getByText("正在整理结果")).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(percent()).toBe(81);
      await act(async () => { vi.advanceTimersByTime(18_000); });
      expect(percent()).toBe(99);
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(percent()).toBe(99);
      await act(async () => { emit({ ...taskDto(), state: "running", stage: "saving", progress: 800, updatedAt: "2026-01-01T00:00:03.000Z" }); });
      expect(percent()).toBe(99);
      expect(screen.getByText("正在整理结果")).toBeTruthy();
      expect(fill().parentElement?.className).toContain("running");

      await act(async () => { emit({ ...taskDto(), state: "completed", progress: 1000, updatedAt: "2026-01-01T00:00:04.000Z" }); });
      expect(percent()).toBe(100);
    } finally {
      vi.useRealTimers();
    }
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

    await screen.findByText("摘要");
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

  it("deletes an insight card and removes it from the list", async () => {
    const api = mockApi();
    vi.mocked(api.transformations!.deleteInsight).mockResolvedValue({ ok: true, value: undefined });
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("洞察内容");
    fireEvent.click(screen.getByRole("button", { name: "删除: 洞察内容" }));
    await waitFor(() => expect(screen.queryByText("洞察内容")).toBeNull());
    expect(api.transformations!.deleteInsight).toHaveBeenCalledWith({ projectId, insightId: insight.id });
  });

  it("uses the themed dropdown for a custom rule target", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    fireEvent.click(screen.getByRole("button", { name: "规则" }));
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
