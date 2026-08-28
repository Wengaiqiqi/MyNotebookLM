// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskProgress from "./TaskProgress";

const task = { id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", sourceId: "33333333-3333-4333-8333-333333333333", kind: "ingest" as const, state: "running" as const, stage: "parsing" as const, progress: 600, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

describe("TaskProgress", () => {
  afterEach(cleanup);
  it("shows stage progress and exposes cancel", () => {
    render(<TaskProgress task={task} labels={{ parsing: "Parsing", cancel: "Cancel", retry: "Retry", remove: "Remove", completed: "Completed", failed: "Failed", queued: "Queued", running: "Running", cancelled: "Cancelled" }} onCancel={vi.fn()} onRetry={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("Parsing")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("60");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("offers retry and remove for a recoverable failed task", () => {
    const onRetry = vi.fn(); const onDelete = vi.fn();
    render(<TaskProgress task={{ ...task, state: "failed", error: { code: "NETWORK", messageKey: "errors.network", recoverable: true } }} labels={{ parsing: "Parsing", cancel: "Cancel", retry: "Retry", remove: "Remove", completed: "Completed", failed: "Failed", queued: "Queued", running: "Running", cancelled: "Cancelled" }} onCancel={vi.fn()} onRetry={onRetry} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRetry).toHaveBeenCalledOnce(); expect(onDelete).toHaveBeenCalledOnce();
  });
});
