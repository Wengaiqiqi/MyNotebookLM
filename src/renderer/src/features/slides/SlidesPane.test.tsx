// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SlidesPane from "./SlidesPane";
import "../../i18n";
import type { DesktopApi } from "../../../../shared/ipc";
import type { InsightDto } from "../../../../shared/transformations";
import type { SlideDeck } from "../../../../shared/slides";
import type { SourceDto } from "../../../../shared/sources";

const projectId = "1a1a1111-1111-4111-8111-111111111111";
const revisionId = "5a1a1111-1111-4111-8111-111111111111";
const deck: SlideDeck = { version: 1, title: "研究汇报", theme: "light", slides: [
  { id: "a", layout: "title", title: "研究汇报", bullets: ["副标题"], right: [], notes: "" },
  { id: "b", layout: "bullets", title: "背景", bullets: ["第一点"], right: [], notes: "备注" }
] };
const insight: InsightDto = {
  builtinKey: "slides", id: "8a1a1111-1111-4111-8111-111111111111", projectId, transformationId: null, taskId: null,
  inputKind: "source", inputHash: "h", ruleVersion: 1, content: JSON.stringify(deck), provider: "openai", model: "m",
  profileId: null, usage: null, idempotencyKey: "k", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};
const sources = [{ id: "2a2a2222-2222-4222-8222-222222222222", projectId, kind: "pdf", displayName: "论文.pdf", status: "active",
  currentRevisionId: revisionId, currentRevisionState: "ready", createdAt: "", updatedAt: "", deletedAt: null }] as unknown as SourceDto[];

function mockApi() {
  const transformations = {
    listInsights: vi.fn(async () => ({ ok: true as const, value: [insight] })),
    saveSlides: vi.fn(async () => ({ ok: true as const, value: undefined })),
    run: vi.fn(async () => ({ ok: false as const, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: false } })),
    deleteInsight: vi.fn(), cancel: vi.fn(), retry: vi.fn()
  };
  (window as unknown as { myNotebook: unknown }).myNotebook = {
    transformations,
    tasks: { list: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined) }
  } as unknown as DesktopApi;
  return transformations;
}

afterEach(cleanup);

describe("SlidesPane", () => {
  it("edits the selected slide inline and autosaves the whole deck", async () => {
    const api = mockApi();
    render(<SlidesPane projectId={projectId} sources={sources} />);
    fireEvent.click(await screen.findByRole("button", { name: "第 2 页" }));
    fireEvent.change(screen.getByRole("textbox", { name: "幻灯片标题" }), { target: { value: "新背景" } });
    const bullet = screen.getByDisplayValue("第一点");
    fireEvent.keyDown(bullet, { key: "Enter" });
    await waitFor(() => expect(api.saveSlides).toHaveBeenCalledTimes(1));
    expect(api.saveSlides).toHaveBeenCalledWith({ projectId, insightId: insight.id, deck: expect.objectContaining({
      slides: [deck.slides[0], { ...deck.slides[1], title: "新背景", bullets: ["第一点", ""] }]
    }) });
  });

  it("generates from the checked sources with the slides rule", async () => {
    const api = mockApi();
    render(<SlidesPane projectId={projectId} sources={sources} />);
    expect(await screen.findByText("论文.pdf")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "生成 PPT" })[0]!);
    await waitFor(() => expect(api.run).toHaveBeenCalledWith({ projectId, builtinKey: "slides", language: "zh-CN", force: true, sourceRevisionIds: [revisionId] }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getAllByRole("button", { name: "生成 PPT" })[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
