// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import StudioPane from "./StudioPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";
import type { BuiltinTransformationDto, InsightDto, TransformationDto } from "../../../../shared/transformations";

const builtin: BuiltinTransformationDto = {
  key: "summary", language: "zh-CN", name: "总结", appliesTo: "source", prompt: "总结 {{content}}"
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

const projectId = "1a1a1111-1111-4111-8111-111111111111";
const revisionId = "5a1a1111-1111-4111-8111-111111111111";

function mockApi(overrides: Partial<DesktopApi> = {}): void {
  const api = {
    transformations: {
      listBuiltins: vi.fn(async () => ({ ok: true as const, value: [builtin] })),
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
  (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
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
    // The rule select carries builtin and custom options.
    const ruleSelect = screen.getByLabelText("规则") as HTMLSelectElement;
    const optionTexts = [...ruleSelect.options].map((option) => option.textContent);
    expect(optionTexts).toContain("总结");
    expect(optionTexts).toContain("我的规则");
  });

  it("runs a builtin transformation against the selected ready source revision", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("总结");
    const runButton = screen.getByRole("button", { name: /运行转换/ });
    expect((runButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("选择一个来源…"), { target: { value: revisionId } });
    expect((runButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(runButton);

    const api = (window as unknown as { myNotebook: DesktopApi }).myNotebook;
    expect(api.transformations!.run).toHaveBeenCalledWith({
      projectId,
      builtinKey: "summary",
      language: "zh-CN",
      sourceRevisionId: revisionId
    });
  });

  it("runs a custom rule and keeps the run button disabled without a target", async () => {
    mockApi();
    render(<StudioPane projectId={projectId} />);

    await screen.findByText("洞察内容");
    fireEvent.change(screen.getByLabelText("规则"), { target: { value: rule.id } });
    const runButton = screen.getByRole("button", { name: /运行转换/ });
    expect((runButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("选择一个来源…"), { target: { value: revisionId } });
    fireEvent.click(runButton);

    const api = (window as unknown as { myNotebook: DesktopApi }).myNotebook;
    expect(api.transformations!.run).toHaveBeenCalledWith({
      projectId,
      transformationId: rule.id,
      sourceRevisionId: revisionId
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
    const picker = screen.getByLabelText("选择一个来源…") as HTMLSelectElement;
    await vi.waitFor(() => {
      const options = [...picker.options].filter((option) => option.value !== "");
      expect(options.map((option) => option.textContent)).toEqual(["就绪.pdf"]);
    });
  });
});
