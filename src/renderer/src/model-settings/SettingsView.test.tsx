// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../shared/ipc";
import SettingsView from "./SettingsView";
import { changeLanguage } from "../i18n";

const projectId = "00000000-0000-4000-8000-000000000001";
const data = { profiles: { profiles: [], builtInProfiles: [], credentials: [] }, routes: {} };

beforeEach(async () => {
  await changeLanguage("en");
  window.myNotebook = {
    vector: {
      getHealth: vi.fn<DesktopApi["vector"]["getHealth"]>().mockResolvedValue({ ok: true, value: { spaceId: projectId, healthy: true, indexedCount: 3 } }),
      startMigration: vi.fn(), rebuild: vi.fn(), optimize: vi.fn(), cancelTask: vi.fn(), subscribe: vi.fn(() => vi.fn())
    }
  } as unknown as DesktopApi;
});

afterEach(() => cleanup());

describe("SettingsView vector management", () => {
  it("loads and renders the selected project's index status", async () => {
    render(<SettingsView data={data} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(window.myNotebook.vector.getHealth).toHaveBeenCalledWith({ projectId }));
    fireEvent.click(screen.getByRole("tab", { name: "Data & indexing" }));
    expect(screen.getByText("Healthy index")).toBeTruthy();
    expect(screen.getAllByText("Data & indexing").length).toBeGreaterThan(0);
  });

  it("hydrates an already-running vector task when settings opens", async () => {
    const task = {
      id: "00000000-0000-4000-8000-000000000002", projectId, sourceId: null, kind: "validation" as const,
      state: "running" as const, stage: "embedding" as const, progress: 420, attempt: 0, error: null,
      idempotencyKey: null, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z"
    };
    Object.assign(window.myNotebook, { tasks: { list: vi.fn().mockResolvedValue([task]) } as unknown as DesktopApi["tasks"] });
    render(<SettingsView data={data} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Data & indexing" }));
    await waitFor(() => expect(screen.getByText("Building index")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Cancel index task" })).toBeTruthy();
  });

  it("switches to a keyboard-operable data page without losing index state", async () => {
    render(<SettingsView data={data} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(window.myNotebook.vector.getHealth).toHaveBeenCalledWith({ projectId }));
    const dataTab = screen.getByRole("tab", { name: "Data & indexing" });
    expect(dataTab.getAttribute("aria-current")).toBeNull();
    dataTab.focus();
    expect(document.activeElement).toBe(dataTab);
    fireEvent.click(dataTab);
    expect(dataTab.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Healthy index" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Model services" })).toBeNull();
    expect(screen.getByRole("button", { name: "Optimize index" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Model services" }));
    expect(screen.getByRole("heading", { name: "Model services" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Data & indexing" }));
    expect(screen.getByRole("heading", { name: "Healthy index" })).toBeTruthy();
  });

  it("moves between settings tabs with arrow and edge keys", () => {
    render(<SettingsView data={data} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const models = screen.getByRole("tab", { name: "Model services" });
    const index = screen.getByRole("tab", { name: "Data & indexing" });
    models.focus();
    fireEvent.keyDown(models, { key: "ArrowRight" });
    expect(document.activeElement).toBe(index);
    fireEvent.keyDown(index, { key: "Home" });
    expect(document.activeElement).toBe(models);
  });

  it("retries a failed migration through the vector API", async () => {
    const task = {
      id: "00000000-0000-4000-8000-000000000003", projectId, sourceId: null, kind: "validation" as const,
      state: "failed" as const, stage: "embedding" as const, progress: 280, attempt: 1, error: null,
      idempotencyKey: null, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z"
    };
    const startMigration = vi.fn().mockResolvedValue({ ok: true, value: { id: "task-retry", state: "running", progress: 0, label: "embedding" } });
    window.myNotebook.vector.startMigration = startMigration;
    Object.assign(window.myNotebook, { tasks: { list: vi.fn().mockResolvedValue([task]) } as unknown as DesktopApi["tasks"] });
    const retryData = { ...data, routes: { embeddingProfileId: "profile-1" }, profiles: { ...data.profiles, profiles: [{ id: "profile-1", name: "Embedding" }] } } as unknown as typeof data;
    render(<SettingsView data={retryData} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Data & indexing" }));
    await waitFor(() => expect(screen.getByText("Index build failed")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Migrate embedding Space" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry migration" }));
    await waitFor(() => expect(startMigration).toHaveBeenCalledWith({ projectId, profileId: "profile-1" }));
  });

  it("routes migration without an embedding profile to model services", async () => {
    const startMigration = vi.fn();
    window.myNotebook.vector.startMigration = startMigration;
    render(<SettingsView data={data} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Data & indexing" }));
    await waitFor(() => expect(screen.getByText("Index unavailable")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Migrate embedding Space" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Model services" })).toBeTruthy();
    expect(startMigration).not.toHaveBeenCalled();
  });

  it("does not suggest model configuration when an embedding route already exists", async () => {
    const configured = { ...data, routes: { embeddingProfileId: "00000000-0000-4000-8000-000000000002" } } as typeof data;
    render(<SettingsView data={configured} projectId={projectId} onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Data & indexing" }));
    await waitFor(() => expect(screen.getByText("Index unavailable")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Go to model services" })).toBeNull();
    expect(screen.getByRole("button", { name: "Migrate embedding Space" })).toBeTruthy();
  });
});
