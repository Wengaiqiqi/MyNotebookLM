// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatView, { formatBytes } from "./ChatView";
import { changeLanguage } from "../i18n";
import type { TaskDto } from "../../../shared/tasks";

const source = { id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", kind: "pdf" as const, displayName: "Research PDF", status: "active" as const, currentRevisionId: "33333333-3333-4333-8333-333333333333", currentRevisionState: "ready" as const, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", deletedAt: null };
const conversation = { id: "44444444-4444-4444-8444-444444444444", projectId: source.projectId, title: "Research", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", deletedAt: null, archivedAt: null };
const citation = (id: string, sourceDisplayName: string) => ({ id, label: "S1" as const, sourceId: id, sourceChunkId: id, sourceDisplayName, sourceKind: "pdf", locator: { kind: "page" as const, page: 1 } });
const assistant = (id: string, sequence: number, sourceDisplayName: string) => ({ id, conversationId: conversation.id, sequence, role: "assistant" as const, content: `Answer [S1]`, state: "completed" as const, replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: "openai", profileId: "profile", model: "model", usage: null, errorCode: null, completionReason: "stop", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", citations: [citation(id, sourceDisplayName)] });

afterEach(cleanup);
beforeEach(async () => { await changeLanguage("en"); });

describe("ChatView", () => {
  it("formats byte boundaries predictably", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
  });
  it("shows the cited chat only when an indexed source and generation route exist", async () => {
    const api = {
      conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
      chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() },
      citations: { open: vi.fn() }
    } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[source]} api={api} />);
    expect(await screen.findByRole("heading", { name: "Research" })).toBeTruthy();
    expect(screen.getByText("Research PDF")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Ask about this project|针对这个项目提问/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send|发送/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Research PDF/ })).toBeTruthy();
    expect(document.querySelector(".chat-layout > .conversation-list")).toBeNull();
  });

  it("shows repair actions when the source or route is not ready", () => {
    const onOpenSettings = vi.fn();
    render(<ChatView projectId={source.projectId} routes={{}} sources={[{ ...source, currentRevisionState: "pending" }]} onOpenSettings={onOpenSettings} />);
    expect(screen.getByRole("heading", { name: /Research chat is unavailable|至少建立一个来源索引/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open settings|打开设置/ }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("keeps unavailable chat source strip and repair card in the required structure", () => {
    const view = render(<ChatView projectId={source.projectId} routes={{}} sources={[{ ...source, currentRevisionState: "pending" }]} onImportSources={vi.fn()} />);
    const unavailable = view.container.querySelector(".chat-unavailable")!;
    const strip = unavailable.querySelector(":scope > .chat-source-strip");
    expect(strip).toBeTruthy();
    expect(strip?.classList.contains("chat-source-strip")).toBe(true);
    expect(unavailable.querySelector(":scope > .chat-repair-card")).toBeTruthy();
    expect(unavailable.querySelector(":scope > .chat-repair-card .chat-repair-actions")).toBeTruthy();
  });

  it("places import action with source cards before terminal status rows", async () => {
    const onImportSources = vi.fn();
    const view = render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[source]} onImportSources={onImportSources} api={{ conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never} />);
    await screen.findByRole("heading", { name: "Research" });
    const strip = view.container.querySelector(".chat-source-strip")!;
    const importAction = strip.querySelector(".source-import-action")!;
    const complete = strip.querySelector(".chat-source-complete")!;
    expect(importAction.compareDocumentPosition(complete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sends a question, renders streamed text, and exposes fallback status", async () => {
    let listener: ((event: never) => void) | undefined;
    const send = vi.fn(async ({ requestId }: { requestId: string }) => ({ ok: true as const, value: { requestId, assistantMessageId: "assistant-1" } }));
    const api = {
      conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) },
      chat: { send, stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn((_id, next) => { listener = next; return vi.fn(); }), unsubscribe: vi.fn() },
      citations: { open: vi.fn() }
    } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[source]} api={api} />);
    await screen.findByRole("heading", { name: "Research" });
    fireEvent.change(screen.getAllByRole("textbox", { name: /Ask about this project|针对这个项目提问/ }).at(-1)!, { target: { value: "What is the finding?" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Send|发送/ }).at(-1)!);
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ question: "What is the finding?" })));
    listener?.({ type: "fallback", requestId: (send.mock.calls[0]?.[0] as { requestId: string }).requestId, attempted: { provider: "openai", model: "primary", profileId: null }, next: { provider: "ollama", model: "fallback", profileId: null }, errorCode: "NETWORK" } as never);
    const fallback = await screen.findByText(/fallback model|回退模型/);
    expect(fallback.textContent).toMatch(/fallback model|回退模型/);
    expect(fallback.closest(".assistant-message")).not.toBeNull();
    expect(document.querySelector(".chat-transcript-header .fallback-banner")).toBeNull();
  });

  it("switches citation context when clicking same label in different assistant answers", async () => {
    const first = { ...assistant("assistant-1", 1, "First source"), citations: [citation("first-s1", "First source"), { ...citation("first-s3", "First extra"), label: "S3" as const }] };
    const second = { ...assistant("assistant-2", 2, "Second source"), citations: [citation("second-s1", "Second source"), { ...citation("second-s2", "Second extra"), label: "S2" as const }] };
    const api = {
      conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [first, second] }) },
      chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() },
      citations: { open: vi.fn() }
    } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[source]} api={api} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "[S1]" })).toHaveLength(2));
    const citationButtons = screen.getAllByRole("button", { name: "[S1]" });
    fireEvent.click(citationButtons[1]!);
    expect(screen.getByText("Second source")).toBeTruthy();
    expect(screen.getByText("Second extra")).toBeTruthy();
    expect(screen.queryByText("First source")).toBeNull();
    expect(screen.queryByText("First extra")).toBeNull();
    fireEvent.click(citationButtons[0]!);
    expect(screen.getByText("First source")).toBeTruthy();
    expect(screen.getByText("First extra")).toBeTruthy();
    expect(screen.queryByText("Second source")).toBeNull();
    expect(screen.queryByText("Second extra")).toBeNull();
  });

  it("shows source kind metadata, indexed completion, and opens the selected source", async () => {
    const url = { ...source, id: "66666666-6666-4666-8666-666666666666", kind: "url" as const, displayName: "Public article", locator: "https://example.com/public" };
    const text = { ...source, id: "77777777-7777-4777-8777-777777777777", kind: "text" as const, displayName: "Notes.txt", sizeBytes: 4096 };
    const open = vi.fn().mockResolvedValue({ ok: true, value: { opened: "url" } });
    const api = { conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never;
    window.myNotebook = { sources: { open }, tasks: { list: vi.fn().mockResolvedValue([]) } } as never;
    const view = render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[{ ...source, sizeBytes: 4096 }, url, text] as never} api={api} />);
    await screen.findByRole("heading", { name: "Research" });
    expect(view.container.querySelector(".chat-source-kind-icon-pdf")).toBeTruthy();
    expect(view.container.querySelector(".chat-source-kind-icon-url")).toBeTruthy();
    expect(view.container.querySelector(".source-chip small")?.textContent).toMatch(/PDF/);
    expect(screen.getAllByText(/4 KB/)).toHaveLength(2);
    expect(screen.getByText("https://example.com/public")).toBeTruthy();
    expect(screen.getAllByText("Indexed")).toHaveLength(3);
    expect(screen.getByText("Processing complete")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Public article/ }));
    expect(open).toHaveBeenCalledWith({ projectId: source.projectId, sourceId: url.id });
  });

  it("keeps source task progress in the top source strip", async () => {
    const pending = { ...source, id: "88888888-8888-4888-8888-888888888888", displayName: "Pending.txt", currentRevisionState: "pending" as const };
    const task: TaskDto = { id: "99999999-9999-4999-8999-999999999999", projectId: source.projectId, sourceId: pending.id, kind: "ingest", state: "running", stage: "parsing", progress: 420, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
    const api = { conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never;
    let listener: ((next: typeof task) => void) | undefined;
    const unsubscribe = vi.fn();
    window.myNotebook = { tasks: { list: vi.fn().mockResolvedValue([task]), subscribe: vi.fn((_projectId, next) => { listener = next; return unsubscribe; }) } } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[source, pending]} api={api} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/parsing · 42%/i);
    listener?.({ ...task, state: "completed", progress: 1000, stage: "finalizing" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(unsubscribe).not.toHaveBeenCalled();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps pending-only source progress visible while chat is unavailable", async () => {
    const pending = { ...source, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Pending only", currentRevisionState: "pending" as const };
    const task: TaskDto = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId: source.projectId, sourceId: pending.id, kind: "ingest", state: "running", stage: "parsing", progress: 420, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
    const api = { conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never;
    window.myNotebook = { tasks: { list: vi.fn().mockResolvedValue([task]), subscribe: vi.fn(() => vi.fn()) } } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[pending]} api={api} />);
    expect(await screen.findByRole("button", { name: /Pending only/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/parsing · 42%/i);
  });

  it("shows a failed source as failed with a retry action instead of calling it pending", async () => {
    const failed = { ...source, currentRevisionId: null, currentRevisionState: "failed" as const };
    const task: TaskDto = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId: source.projectId, sourceId: source.id, kind: "ingest", state: "failed", stage: "embedding", progress: 600, attempt: 0, error: { code: "INDEX_UNAVAILABLE", messageKey: "errors.indexUnavailable", recoverable: true }, idempotencyKey: null, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
    const retry = vi.fn().mockResolvedValue({ ok: true, value: { ...task, state: "running" } });
    window.myNotebook = { sources: { retry }, tasks: { list: vi.fn().mockResolvedValue([task]), subscribe: vi.fn(() => vi.fn()) } } as never;
    const api = { conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never;

    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[failed]} api={api} />);
    expect(await screen.findByText(/Failed|失败/)).toBeTruthy();
    expect(screen.queryByText(/^pending$/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry|重试/ }));
    expect(retry).toHaveBeenCalledWith({ projectId: source.projectId, sourceId: source.id });
  });

  it("does not replace supplied sources after a terminal task event", async () => {
    const supplied = { ...source, displayName: "Supplied source" };
    const refreshed = { ...source, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", displayName: "Global source" };
    const task: TaskDto = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", projectId: source.projectId, sourceId: supplied.id, kind: "ingest", state: "running", stage: "parsing", progress: 420, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
    let listener: ((next: typeof task) => void) | undefined;
    const list = vi.fn().mockResolvedValue([refreshed]);
    const api = { conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send: vi.fn(), stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never;
    window.myNotebook = { sources: { list }, tasks: { list: vi.fn().mockResolvedValue([task]), subscribe: vi.fn((_projectId, next) => { listener = next; return vi.fn(); }) } } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[supplied]} api={api} />);
    await screen.findByRole("button", { name: /Supplied source/ });
    listener?.({ ...task, state: "completed", progress: 1000, stage: "finalizing" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Supplied source/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Global source/ })).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("uses a square stop glyph while streaming", async () => {
    const send = vi.fn(async ({ requestId }: { requestId: string }) => ({ ok: true as const, value: { requestId, assistantMessageId: "assistant-1" } }));
    const api = { conversations: { list: vi.fn().mockResolvedValue({ ok: true, value: [conversation] }), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn(), listMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }) }, chat: { send, stop: vi.fn(), regenerate: vi.fn(), subscribe: vi.fn().mockReturnValue(vi.fn()), unsubscribe: vi.fn() }, citations: { open: vi.fn() } } as never;
    render(<ChatView projectId={source.projectId} routes={{ generationProfileId: "55555555-5555-4555-8555-555555555555" }} sources={[source]} api={api} />);
    await screen.findByRole("heading", { name: "Research" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "question" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(stop.querySelector("span")?.textContent).toBe("■");
  });
});
