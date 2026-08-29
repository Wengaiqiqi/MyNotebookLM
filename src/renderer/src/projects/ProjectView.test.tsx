// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectView from "./ProjectView";

afterEach(() => cleanup());

describe("ProjectView", () => {
  it("owns the workspace header and source/chat unavailable states", () => {
    render(<ProjectView appName="MyNotebookLM" project={{ id: "p1", name: "Research", archived: false, status: "active", deletedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" }} routes={{}} busy={false} workspaceTitle="Workspace" emptyTitle="Empty" emptyBody="None" createLabel="Create" sourceImportUnavailable="No sources" importSources="Import sources" chatUnavailable="Chat unavailable" sourcesLabel="Sources" noSourcesTitle="No sources" noSourcesBody="None" askLabel="Ask" openSettingsLabel="Open settings" onOpenSettings={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Research" })).toBeTruthy();
    expect(screen.getAllByText("No sources")).toHaveLength(2);
    expect(screen.getAllByText("Chat unavailable")).toHaveLength(2);
  });

  it("opens the research chat when a generation route is configured and source revision is ready", async () => {
    window.myNotebook = {
      sources: { list: vi.fn().mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111", projectId: "p1", kind: "pdf", displayName: "Research PDF", status: "active", currentRevisionId: "22222222-2222-4222-8222-222222222222", currentRevisionState: "ready", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }]), chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), remove: vi.fn(), retry: vi.fn() },
      tasks: { list: vi.fn().mockResolvedValue([]), cancel: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()) },
      conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [{ id: "33333333-3333-4333-8333-333333333333", projectId: "p1", title: "Research", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null, archivedAt: null }] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
      chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() },
      citations: { open: vi.fn() },
      notes: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), listLinks: vi.fn().mockResolvedValue({ ok: true, value: [] }), create: vi.fn(), update: vi.fn(), archive: vi.fn(), restore: vi.fn(), delete: vi.fn(), createLink: vi.fn(), deleteLink: vi.fn(), generateTitle: vi.fn() },
      transformations: { listBuiltins: vi.fn().mockResolvedValue({ ok: true, value: [{ key: "summary", language: "en", name: "Summary", appliesTo: "source", prompt: "Summarize {{content}}" }] }), listRules: vi.fn().mockResolvedValue({ ok: true, value: [] }), listInsights: vi.fn().mockResolvedValue({ ok: true, value: [] }), run: vi.fn(), cancel: vi.fn(), retry: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(), convertToNote: vi.fn() }
    } as never;
    render(<ProjectView appName="MyNotebookLM" project={{ id: "p1", name: "Research", archived: false, status: "active", deletedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" }} routes={{ generationProfileId: "44444444-4444-4444-8444-444444444444" }} busy={false} workspaceTitle="Workspace" emptyTitle="Empty" emptyBody="None" createLabel="Create" sourceImportUnavailable="No sources" importSources="Import sources" chatUnavailable="Chat unavailable" sourcesLabel="Sources" noSourcesTitle="No sources" noSourcesBody="None" askLabel="Ask" openSettingsLabel="Open settings" onOpenSettings={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByRole("region", { name: "Research chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Notes|笔记/ }));
    expect(await screen.findByRole("heading", { name: /Notes|笔记/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Transformations|转换/ }));
    expect(await screen.findByRole("heading", { name: /Transformations|转换/, level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Research|研究/ }));
    expect(await screen.findByRole("region", { name: "Research chat" })).toBeTruthy();
  });
});
