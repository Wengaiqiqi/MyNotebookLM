// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import ChatView from "./ChatView";

const source = { id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", kind: "pdf" as const, displayName: "Research PDF", status: "active" as const, currentRevisionId: "33333333-3333-4333-8333-333333333333", currentRevisionState: "ready" as const, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", deletedAt: null };
const conversation = { id: "44444444-4444-4444-8444-444444444444", projectId: source.projectId, title: "Research", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", deletedAt: null, archivedAt: null };
const citation = (id: string, sourceDisplayName: string) => ({ id, label: "S1" as const, sourceId: id, sourceChunkId: id, sourceDisplayName, sourceKind: "pdf", locator: { kind: "page" as const, page: 1 } });
const assistant = (id: string, sequence: number, sourceDisplayName: string) => ({ id, conversationId: conversation.id, sequence, role: "assistant" as const, content: `Answer [S1]`, state: "completed" as const, replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: "openai", profileId: "profile", model: "model", usage: null, errorCode: null, completionReason: "stop", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", citations: [citation(id, sourceDisplayName)] });

describe("ChatView", () => {
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
    const fallback = await screen.findByRole("status");
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
});
