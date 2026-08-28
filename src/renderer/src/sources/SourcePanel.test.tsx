// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SourcePanel from "./SourcePanel";

const projectId = "11111111-1111-4111-8111-111111111111";
const source = { id: "22222222-2222-4222-8222-222222222222", projectId, kind: "pdf" as const, displayName: "Report.pdf", status: "active" as const, currentRevisionId: "33333333-3333-4333-8333-333333333333", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null };

describe("SourcePanel", () => {
  afterEach(cleanup);
  it("opens a controlled import dialog from the right-side add button", async () => {
    const onImportOpen = vi.fn();
    render(<SourcePanel projectId={projectId} sourcesApi={{ chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([]), remove: vi.fn(), retry: vi.fn() }} tasksApi={{ list: vi.fn().mockResolvedValue([]), cancel: vi.fn(), subscribe: vi.fn(() => vi.fn()) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "File", url: "URL" }} importOpen={false} onImportOpen={onImportOpen} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onImportOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores focus to the right-side add trigger when the dialog closes", async () => {
    const view = render(<SourcePanel projectId={projectId} sourcesApi={{ chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([]), remove: vi.fn(), retry: vi.fn() }} tasksApi={{ list: vi.fn().mockResolvedValue([]), cancel: vi.fn(), subscribe: vi.fn(() => vi.fn()) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "File", url: "URL" }} />);
    const trigger = screen.getByRole("button", { name: "Add source" }); fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger)); view.unmount();
  });

  it("hydrates sources and tasks after restart and allows selection/removal", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    render(<SourcePanel projectId={projectId} sourcesApi={{ chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([source]), remove, retry: vi.fn() }} tasksApi={{ list: vi.fn().mockResolvedValue([]), cancel: vi.fn(), subscribe: vi.fn(() => vi.fn()) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "File", url: "URL" }} />);
    await waitFor(() => expect(screen.getByText("Report.pdf")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Report.pdf" }));
    expect(screen.getByRole("button", { name: /Selected/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ projectId, sourceId: source.id }));
  });

  it("keeps the newest task for each source when tasks are listed newest first", async () => {
    const older = { id: "44444444-4444-4444-8444-444444444444", projectId, sourceId: source.id, kind: "ingest" as const, state: "failed" as const, stage: "parsing" as const, progress: 400, attempt: 0, error: { code: "NETWORK" as const, messageKey: "errors.network", recoverable: true }, idempotencyKey: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...older, id: "55555555-5555-4555-8555-555555555555", state: "running" as const, error: null, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
    render(<SourcePanel projectId={projectId} sourcesApi={{ chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([source]), remove: vi.fn(), retry: vi.fn() }} tasksApi={{ list: vi.fn().mockResolvedValue([newer, older]), cancel: vi.fn(), subscribe: vi.fn(() => vi.fn()) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "File", url: "URL", parsing: "Parsing", running: "Running", failed: "Failed", cancel: "Cancel", retry: "Retry", completed: "Completed", queued: "Queued", cancelled: "Cancelled" }} />);
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("does not let an older task update replace the newest task", async () => {
    const subscribe = vi.fn();
    const newer = { id: "55555555-5555-4555-8555-555555555555", projectId, sourceId: source.id, kind: "ingest" as const, state: "running" as const, stage: "parsing" as const, progress: 800, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
    const older = { ...newer, id: "44444444-4444-4444-8444-444444444444", state: "failed" as const, error: { code: "NETWORK" as const, messageKey: "errors.network", recoverable: true }, createdAt: "2026-01-01T00:00:00.000Z" };
    render(<SourcePanel projectId={projectId} sourcesApi={{ chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([source]), remove: vi.fn(), retry: vi.fn() }} tasksApi={{ list: vi.fn().mockResolvedValue([newer]), cancel: vi.fn(), subscribe: vi.fn((_, listener) => { subscribe.mockImplementation(listener); return vi.fn(); }) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "File", url: "URL", parsing: "Parsing", running: "Running", failed: "Failed", cancel: "Cancel", retry: "Retry", completed: "Completed", queued: "Queued", cancelled: "Cancelled" }} />);
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    subscribe(older);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("restores focus to alternating controlled external and internal triggers", async () => {
    function Harness() { const [open, setOpen] = React.useState(false); const mainRef = React.useRef<HTMLButtonElement>(null); return <><button ref={mainRef} onClick={() => setOpen(true)}>Main import</button><SourcePanel projectId={projectId} sourcesApi={{ chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([]), remove: vi.fn(), retry: vi.fn() }} tasksApi={{ list: vi.fn().mockResolvedValue([]), cancel: vi.fn(), subscribe: vi.fn(() => vi.fn()) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "File", url: "URL" }} importOpen={open} onImportOpen={() => setOpen(true)} onImportClose={() => setOpen(false)} importTriggerRef={mainRef} /></>; }
    render(<Harness />); const main = screen.getByRole("button", { name: "Main import" }); fireEvent.click(main); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(document.activeElement).toBe(main));
    const side = screen.getByRole("button", { name: "Add source" }); fireEvent.click(side); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(document.activeElement).toBe(side));
    fireEvent.click(main); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(document.activeElement).toBe(main));
  });
});
