// @vitest-environment jsdom
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../shared/ipc";
import TransformationView from "./TransformationView";
import { changeLanguage } from "../i18n";

const projectId = "00000000-0000-4000-8000-000000000001";
const task = { id: "00000000-0000-4000-8000-000000000002", projectId, sourceId: null, kind: "transformation" as const, state: "queued" as const, stage: "preparing" as const, progress: 0, attempt: 0, error: null, idempotencyKey: "run-1", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
const rule = { id: "00000000-0000-4000-8000-000000000003", projectId, name: "Extract", appliesTo: "note" as const, prompt: "Extract {{content}}", version: 1, enabled: true, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
const insight = { id: "00000000-0000-4000-8000-000000000004", projectId, transformationId: null, taskId: task.id, inputKind: "note" as const, inputHash: "hash", ruleVersion: 1, content: "same insight", provider: null, model: null, profileId: null, usage: null, idempotencyKey: "same", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };

beforeEach(async () => {
  await changeLanguage("en");
  window.myNotebook = { transformations: {
    listRules: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    listBuiltins: vi.fn().mockResolvedValue({ ok: true, value: [{ key: "summary", language: "en", name: "Summary", appliesTo: "source", prompt: "Summarize {{content}}" }] }),
    listInsights: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    run: vi.fn().mockResolvedValue({ ok: true, value: task }), cancel: vi.fn(), retry: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(), convertToNote: vi.fn()
  }, tasks: { list: vi.fn().mockResolvedValue([]), subscribe: vi.fn(() => () => undefined), cancel: vi.fn() } } as unknown as DesktopApi;
});
afterEach(() => cleanup());

describe("TransformationView", () => {
  it("shows built-ins and starts a supported source transformation", async () => {
    render(<TransformationView projectId={projectId} />);
    expect(await screen.findByText("Summary")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Target id" }), { target: { value: "00000000-0000-4000-8000-000000000003" } });
    fireEvent.click(screen.getByRole("button", { name: "Run transformation" }));
    await waitFor(() => expect(window.myNotebook.transformations?.run).toHaveBeenCalledWith(expect.objectContaining({ projectId, builtinKey: "summary", sourceRevisionId: "00000000-0000-4000-8000-000000000003" })));
  });

  it("creates, updates, and deletes a custom rule through the dialog", async () => {
    const createRule = vi.fn().mockResolvedValue({ ok: true, value: rule }); const updateRule = vi.fn().mockResolvedValue({ ok: true, value: { ...rule, name: "Updated" } }); const deleteRule = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const listRules = window.myNotebook.transformations!.listRules as ReturnType<typeof vi.fn>;
    window.myNotebook.transformations!.createRule = createRule; window.myNotebook.transformations!.updateRule = updateRule; window.myNotebook.transformations!.deleteRule = deleteRule;
    render(<TransformationView projectId={projectId} />);
    await screen.findByText("Summary"); listRules.mockResolvedValue({ ok: true, value: [rule] });
    fireEvent.click(screen.getByRole("button", { name: "New custom rule" }));
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Extract" } }); fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Extract {{content}}" } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(createRule).toHaveBeenCalledWith({ projectId, name: "Extract", appliesTo: "source", prompt: "Extract {{content}}" }));
    expect(await screen.findAllByText("Extract")).toHaveLength(2); fireEvent.click(screen.getByRole("button", { name: "Edit" })); fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Updated" } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRule).toHaveBeenCalledWith(expect.objectContaining({ projectId, id: rule.id, version: 1, name: "Updated" })));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteRule).toHaveBeenCalledWith({ projectId, id: rule.id, version: 1 }));
  });

  it("rejects unknown, malformed, HTML, and dollar template syntax inline", async () => {
    render(<TransformationView projectId={projectId} />); await screen.findByText("Summary"); fireEvent.click(screen.getByRole("button", { name: "New custom rule" }));
    const prompt = screen.getByLabelText("Prompt");
    for (const value of ["Use {{unknown}}", "Use {{content}", "<script>alert(1)</script>", "${content}"]) { fireEvent.change(prompt, { target: { value } }); expect(screen.getByRole("alert").textContent).toMatch(/unsupported|template|placeholder|syntax/i); }
    fireEvent.change(prompt, { target: { value: "Use {{content}}, {{source_title}}, {{project_name}}, {{language}}" } }); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("maps all five supported target kinds to their real run inputs", async () => {
    const run = window.myNotebook.transformations!.run as ReturnType<typeof vi.fn>;
    for (const [target, key] of [["source", "sourceRevisionId"], ["sources", "sourceRevisionIds"], ["message", "messageId"], ["answer", "answerMessageId"], ["note", "noteId"]] as const) {
      cleanup(); run.mockClear(); run.mockResolvedValue({ ok: true, value: task }); render(<TransformationView projectId={projectId} />); await screen.findByText("Summary"); fireEvent.change(screen.getByRole("combobox", { name: "Target type" }), { target: { value: target } }); fireEvent.change(screen.getByRole("textbox", { name: "Target id" }), { target: { value: "00000000-0000-4000-8000-000000000010" } }); fireEvent.click(screen.getByRole("button", { name: "Run transformation" })); await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ [key]: target === "sources" ? ["00000000-0000-4000-8000-000000000010"] : "00000000-0000-4000-8000-000000000010" })));
    }
  });

  it("shows task progress, cancels a task, and retries a failed task", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, value: task }); const failed = { ...task, state: "failed" as const, progress: 400, error: { code: "PROVIDER" as const, messageKey: "errors.provider", recoverable: true } }; const cancel = vi.fn().mockResolvedValue({ ok: true, value: failed }); const retry = vi.fn().mockResolvedValue({ ok: true, value: { ...task, state: "running" as const, progress: 420 } });
    window.myNotebook.transformations!.run = run; window.myNotebook.transformations!.cancel = cancel; window.myNotebook.transformations!.retry = retry;
    render(<TransformationView projectId={projectId} />); await screen.findByText("Summary"); fireEvent.change(screen.getByRole("textbox", { name: "Target id" }), { target: { value: "00000000-0000-4000-8000-000000000010" } }); fireEvent.click(screen.getByRole("button", { name: "Run transformation" })); await screen.findByRole("status"); expect(screen.getByText(/0%/)).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(cancel).toHaveBeenCalledWith({ projectId, taskId: task.id })); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(retry).toHaveBeenCalledWith({ projectId, taskId: task.id }));
  });

  it("deduplicates insights by id and converts an insight to a note", async () => {
    const convertToNote = vi.fn().mockResolvedValue({ ok: true, value: {} }); window.myNotebook.transformations!.listInsights = vi.fn().mockResolvedValue({ ok: true, value: [insight, { ...insight, content: "duplicate" }] }); window.myNotebook.transformations!.convertToNote = convertToNote;
    render(<TransformationView projectId={projectId} />); await screen.findByRole("listitem"); expect(screen.getAllByRole("listitem")).toHaveLength(1); fireEvent.click(screen.getByRole("button", { name: "Convert to note" })); await waitFor(() => expect(convertToNote).toHaveBeenCalledWith({ projectId, insightId: insight.id }));
  });
});
