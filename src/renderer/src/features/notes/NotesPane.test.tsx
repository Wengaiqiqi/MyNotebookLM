// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NotesPane from "./NotesPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";
import type { CreateNoteLinkInput, NoteLinkDto } from "../../../../shared/notes";

const projectA = "1a1a1111-1111-4111-8111-111111111111";
const projectB = "2a2a2222-2222-4222-8222-222222222222";
const noteId = "3a3a3333-3333-4333-8333-333333333333";
const sourceA = "4a4a4444-4444-4444-8444-444444444444";
const sourceB = "5a5a5555-5555-4555-8555-555555555555";
const sourceC = "6a6a6666-6666-4666-8666-666666666666";
const conversationId = "7a7a7777-7777-4777-8777-777777777777";
const questionA = "8a8a8888-8888-4888-8888-888888888881";
const questionB = "8a8a8888-8888-4888-8888-888888888882";
const answerA = "9a9a9999-9999-4999-8999-999999999991";
const now = "2026-09-01T00:00:00.000Z";

afterEach(() => cleanup());

describe("NotesPane", () => {
  it("saves a dirty body before title generation and keeps it when generation fails", async () => {
    let finishGeneration!: (result: { ok: false; error: { code: "INTERNAL"; messageKey: "errors.internal"; recoverable: false } }) => void;
    const update = vi.fn(async (input) => ({
      ok: true as const,
      value: { id: noteId, projectId: projectA, title: input.title, body: input.body, version: 2, archivedAt: null, deletedAt: null, createdAt: now, updatedAt: now }
    }));
    const generateTitle = vi.fn(() => new Promise((resolve) => { finishGeneration = resolve; }));
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = {
      projects: { list: vi.fn(async () => []) },
      sources: { list: vi.fn(async () => []) },
      conversations: { list: vi.fn(async () => ({ ok: true as const, value: [] })), listMessages: vi.fn(), create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn() },
      notes: {
        list: vi.fn(async () => ({ ok: true as const, value: [{ id: noteId, projectId: projectA, title: "原始标题", body: "旧正文", version: 1, archivedAt: null, deletedAt: null, createdAt: now, updatedAt: now }] })),
        listLinks: vi.fn(async () => ({ ok: true as const, value: [] })),
        update,
        generateTitle,
        create: vi.fn(), get: vi.fn(), archive: vi.fn(), restore: vi.fn(), delete: vi.fn(), createLink: vi.fn(), deleteLink: vi.fn()
      }
    } as unknown as DesktopApi;

    render(<NotesPane projectId={projectA} />);
    const body = await screen.findByLabelText("Markdown 正文") as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toBe("旧正文"));
    fireEvent.change(body, { target: { value: "尚未保存的新正文" } });
    await screen.findByText("未保存");
    fireEvent.click(screen.getByRole("button", { name: "生成 AI 标题" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: projectA, id: noteId, title: "原始标题", body: "尚未保存的新正文", version: 1 }));
    expect((await screen.findByRole("button", { name: "正在生成标题…" }) as HTMLButtonElement).disabled).toBe(true);
    finishGeneration({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: false } });

    await waitFor(() => expect((screen.getByRole("button", { name: "生成 AI 标题" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("Markdown 正文") as HTMLTextAreaElement).value).toBe("尚未保存的新正文");
  });

  it("associates multiple sources, questions and model answers without a project target", async () => {
    const createLink = vi.fn(async (input: CreateNoteLinkInput) => ({
      ok: true as const,
      value: {
        id: crypto.randomUUID(),
        noteId,
        targetProjectId: input.targetProjectId ?? null,
        sourceId: input.sourceId ?? null,
        messageId: input.messageId ?? null,
        citationId: input.citationId ?? null,
        targetAvailable: true,
        createdAt: now
      } satisfies NoteLinkDto
    }));
    (window as unknown as { myNotebook: DesktopApi }).myNotebook = {
      projects: {
        list: vi.fn(async () => [
          { id: projectA, name: "项目甲", archived: false, status: "active", deletedAt: null, createdAt: now, updatedAt: now },
          { id: projectB, name: "项目乙", archived: false, status: "active", deletedAt: null, createdAt: now, updatedAt: now }
        ])
      },
      sources: {
        list: vi.fn(async ({ projectId }) => projectId === projectA
          ? [{ id: sourceA, projectId, kind: "markdown", displayName: "甲资料.md", status: "active", currentRevisionId: null, deletedAt: null, createdAt: now, updatedAt: now }]
          : [
            { id: sourceB, projectId, kind: "pdf", displayName: "乙资料一.pdf", status: "active", currentRevisionId: null, deletedAt: null, createdAt: now, updatedAt: now },
            { id: sourceC, projectId, kind: "markdown", displayName: "乙资料二.md", status: "active", currentRevisionId: null, deletedAt: null, createdAt: now, updatedAt: now }
          ])
      },
      conversations: {
        list: vi.fn(async () => ({ ok: true as const, value: [{ id: conversationId, projectId: projectA, title: "研究对话", createdAt: now, updatedAt: now, deletedAt: null, archivedAt: null }] })),
        listMessages: vi.fn(async () => ({ ok: true as const, value: [
          { id: questionA, conversationId, sequence: 1, role: "user" as const, content: "问题一", state: "completed" as const, replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: null, profileId: null, model: null, usage: null, errorCode: null, completionReason: null, createdAt: now, updatedAt: now, citations: [] },
          { id: answerA, conversationId, sequence: 2, role: "assistant" as const, content: "模型回答", state: "completed" as const, replyToMessageId: questionA, supersedesMessageId: null, superseded: false, provider: "openai", profileId: null, model: "test", usage: null, errorCode: null, completionReason: null, createdAt: now, updatedAt: now, citations: [] },
          { id: questionB, conversationId, sequence: 3, role: "user" as const, content: "问题二", state: "completed" as const, replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: null, profileId: null, model: null, usage: null, errorCode: null, completionReason: null, createdAt: now, updatedAt: now, citations: [] }
        ] })),
        create: vi.fn(), rename: vi.fn(), archive: vi.fn(), delete: vi.fn()
      },
      notes: {
        list: vi.fn(async () => ({ ok: true as const, value: [{ id: noteId, projectId: projectA, title: "测试笔记", body: "正文", version: 1, archivedAt: null, deletedAt: null, createdAt: now, updatedAt: now }] })),
        listLinks: vi.fn(async () => ({ ok: true as const, value: [] })),
        createLink,
        create: vi.fn(), get: vi.fn(), update: vi.fn(), archive: vi.fn(), restore: vi.fn(), delete: vi.fn(), deleteLink: vi.fn(), generateTitle: vi.fn()
      }
    } as unknown as DesktopApi;

    render(<NotesPane projectId={projectA} />);
    await screen.findByDisplayValue("测试笔记");
    fireEvent.click(screen.getByRole("button", { name: /关联证据/ }));

    fireEvent.click(screen.getByLabelText("来源"));
    fireEvent.click(await screen.findByRole("option", { name: "甲资料.md" }));
    fireEvent.click(screen.getAllByRole("button", { name: "关联" })[0]!);
    await waitFor(() => expect(createLink).toHaveBeenCalledWith({ projectId: projectA, noteId, sourceId: sourceA }));
    fireEvent.click(screen.getByLabelText("提问消息"));
    fireEvent.click(await screen.findByRole("option", { name: /\[研究对话\] 问题一/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "关联" })[1]!);
    await waitFor(() => expect(createLink).toHaveBeenCalledWith({ projectId: projectA, noteId, messageId: questionA }));
    fireEvent.click(screen.getByLabelText("模型回答"));
    expect(screen.getByRole("option", { name: /\[研究对话\] 模型回答/ })).toBeTruthy();
  });
});
