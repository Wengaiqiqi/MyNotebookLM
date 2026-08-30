// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatPane from "./ChatPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";

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

function mockApi() {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const api = {
    conversations: {
      list: vi.fn(async () => ok([conversation(existingId, "旧对话")])),
      create: vi.fn(async () => ok(conversation(createdId, "新对话"))),
      rename: vi.fn(async () => ok(conversation(createdId, "改名"))),
      archive: vi.fn(), delete: vi.fn(async () => ok(undefined)),
      listMessages: vi.fn(async () => ok([]))
    },
    chat: {
      send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(),
      subscribe: vi.fn(() => () => undefined), unsubscribe: vi.fn()
    },
    citations: { open: vi.fn() },
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
    expect(api.conversations.listMessages).toHaveBeenCalledWith({
      projectId, conversationId: createdId
    });

    // reopening the menu lists both conversations with the new one selected
    fireEvent.click(screen.getByRole("button", { name: /新对话/ }));
    expect(screen.getByText("旧对话")).toBeTruthy();
    const selected = document.querySelector(".conv-item.selected strong");
    expect(selected?.textContent).toBe("新对话");
  });
});
