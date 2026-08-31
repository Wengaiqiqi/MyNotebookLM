// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPane, { CitationsPanel } from "./ChatPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";
import type { MessageDto } from "../../../../shared/chat";

const projectId = "1a1a1111-1111-4111-8111-111111111111";
const existingId = "3a3a3333-3333-4333-8333-333333333333";
const createdId = "4a4a4444-4444-4444-8444-444444444444";

function conversation(id: string, title: string) {
  return {
    id, projectId, title,
    createdAt: "2026-08-30T07:00:00.000Z",
    updatedAt: "2026-08-30T07:00:00.000Z",
    deletedAt: null, archivedAt: null
  };
}

const readySources = [
  {
    id: "2a2a2222-2222-4222-8222-222222222222", projectId, kind: "pdf" as const,
    displayName: "论文.pdf", status: "active" as const,
    currentRevisionId: "5a5a5555-5555-4555-8555-555555555555",
    createdAt: "", updatedAt: "", deletedAt: null, currentRevisionState: "ready" as const
  }
];

function mockApi(messages: MessageDto[] = []) {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const api = {
    conversations: {
      list: vi.fn(async () => ok([conversation(existingId, "旧对话")])),
      create: vi.fn(async () => ok(conversation(createdId, "新对话"))),
      rename: vi.fn(async () => ok(conversation(createdId, "改名"))),
      archive: vi.fn(), delete: vi.fn(async () => ok(undefined)),
      listMessages: vi.fn(async () => ok(messages))
    },
    chat: {
      send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(),
      subscribe: vi.fn(() => () => undefined), unsubscribe: vi.fn()
    },
    citations: {
      open: vi.fn(),
      detail: vi.fn(async () => ok({ text: "第一段完整原文。\n\n第二段仍需保留换行。", kind: "pdf" as const, data: null, sheet: null }))
    },
    models: { listProfiles: vi.fn(async () => ok({ profiles: [], builtInProfiles: [], credentials: [] })) },
    sources: {
      chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), open: vi.fn(), remove: vi.fn(), retry: vi.fn(),
      list: vi.fn(async () => [
        {
          id: "2a2a2222-2222-4222-8222-222222222222", projectId, kind: "pdf" as const,
          displayName: "论文.pdf", status: "active" as const,
          currentRevisionId: "5a5a5555-5555-4555-8555-555555555555",
          createdAt: "", updatedAt: "", deletedAt: null, currentRevisionState: "ready" as const
        }
      ])
    },
    tasks: { list: vi.fn(async () => []), cancel: vi.fn(), subscribe: vi.fn(() => () => undefined) }
  } as unknown as DesktopApi;
  (window as unknown as { myNotebook: DesktopApi }).myNotebook = api;
  return api;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.resetModules(); });

describe("ChatPane conversation creation", () => {
  it("sends the first question with the conversation id returned by creation", async () => {
    const api = mockApi();
    vi.mocked(api.conversations.list).mockResolvedValueOnce({ ok: true, value: [] });
    vi.mocked(api.chat.send).mockResolvedValueOnce({
      ok: true,
      value: { requestId: "8a8a8888-8888-4888-8888-888888888888", assistantMessageId: "assistant-1" }
    });
    render(
      <ChatPane
        projectId={projectId}
        generationProfileId="9a9a9999-9999-4999-8999-999999999999"
        sources={readySources}
        onOpenSettings={() => undefined}
        onImport={() => undefined}
      />
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "针对这个项目提问" }), { target: { value: "第一问" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.chat.send).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      conversationId: createdId,
      question: "第一问"
    })));
  });

  it("switches to the blank new conversation immediately after creating it", async () => {
    const api = mockApi();
    render(
      <ChatPane
        projectId={projectId}
        generationProfileId="9a9a9999-9999-4999-8999-999999999999"
        sources={readySources}
        onOpenSettings={() => undefined}
        onImport={() => undefined}
      />
    );

    // open the conversation menu
    fireEvent.click(await screen.findByRole("button", { name: /旧对话/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "新对话" }));

    // the toolbar must switch to the new conversation at once
    expect(await screen.findByRole("button", { name: /新对话/ })).toBeTruthy();
    expect(api.conversations.create).toHaveBeenCalledTimes(1);
    expect(api.conversations.list).toHaveBeenCalledTimes(1); // no refetch storm
    await waitFor(() => expect(api.conversations.listMessages).toHaveBeenCalledWith({
      projectId, conversationId: createdId
    }));

    // reopening the menu lists both conversations with the new one selected
    fireEvent.click(screen.getByRole("button", { name: /新对话/ }));
    expect(screen.getByText("旧对话")).toBeTruthy();
    const selected = document.querySelector(".conv-item.selected strong");
    expect(selected?.textContent).toBe("新对话");
  });
});

describe("ChatPane citation source dialog", () => {
  it("loads and renders the complete authoritative chunk in the shared modal", async () => {
    const message: MessageDto = {
      id: "6a6a6666-6666-4666-8666-666666666666",
      conversationId: existingId,
      sequence: 0,
      role: "assistant",
      content: "答案 [S1]",
      state: "completed",
      replyToMessageId: null,
      supersedesMessageId: null,
      superseded: false,
      provider: "openai",
      profileId: null,
      model: "test-model",
      usage: null,
      errorCode: null,
      completionReason: "stop",
      createdAt: "2026-08-30T07:00:00.000Z",
      updatedAt: "2026-08-30T07:00:00.000Z",
      citations: [{
        id: "6a6a6666-6666-4666-8666-666666666666:S1:3",
        label: "S1",
        sourceId: readySources[0]!.id,
        sourceChunkId: "7a7a7777-7777-4777-8777-777777777777",
        sourceDisplayName: "论文.pdf",
        sourceKind: "pdf",
        locator: { kind: "page", page: 2 },
        quote: "截断摘录"
      }]
    };
    mockApi([message]);

    render(
      <ChatPane
        projectId={projectId}
        generationProfileId="9a9a9999-9999-4999-8999-999999999999"
        sources={readySources}
        onOpenSettings={() => undefined}
        onImport={() => undefined}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "查看原文" }));

    const dialog = await screen.findByRole("dialog", { name: "引用原文" });
    expect(dialog.textContent).toContain("论文.pdf");
    expect(dialog.textContent).not.toContain("第 2");
    expect([...dialog.querySelectorAll(".citation-source-text p")].map((node) => node.textContent)).toEqual([
      "第一段完整原文。",
      "第二段仍需保留换行。"
    ]);
  });

  it("stops loading when an older preload cannot serve citation details", async () => {
    const api = mockApi();
    vi.mocked(api.citations.detail).mockRejectedValueOnce(new Error("missing IPC channel"));
    const citation = {
      id: "6a6a6666-6666-4666-8666-666666666666:S1:3",
      label: "S1" as const,
      sourceId: readySources[0]!.id,
      sourceChunkId: "7a7a7777-7777-4777-8777-777777777777",
      sourceDisplayName: "论文.pdf",
      sourceKind: "pdf",
      locator: { kind: "page" as const, page: 2 },
      quote: "截断摘录"
    };

    render(<CitationsPanel projectId={projectId} citations={[citation]} active={null} onSelect={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));

    expect(await screen.findByText("原文暂不可用。")).toBeTruthy();
    expect(screen.queryByText("正在加载…")).toBeNull();
  });
});
