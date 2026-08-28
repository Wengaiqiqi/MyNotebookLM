// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IndexStatus, { type IndexHealthState } from "./IndexStatus";
import { changeLanguage } from "../i18n";

const base = { indexedCount: 12, spaceId: "00000000-0000-4000-8000-000000000001" };

function renderStatus(status: IndexHealthState, overrides: Partial<React.ComponentProps<typeof IndexStatus>> = {}) {
  return render(
    <IndexStatus
      health={{ ...base, status }}
      onOptimize={vi.fn()}
      onRebuild={vi.fn()}
      onMigrate={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(async () => { await changeLanguage("en"); });

describe("IndexStatus", () => {
  it.each<[IndexHealthState, string]>([
    ["healthy", "Healthy"],
    ["unavailable", "Index unavailable"],
    ["corrupt", "Index needs repair"],
    ["building", "Building index"],
    ["failed", "Index build failed"]
  ])("renders the %s state with actionable copy", (status, text) => {
    renderStatus(status);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("does not offer a fake model download action", () => {
    renderStatus("unavailable");
    expect(screen.queryByRole("button", { name: /Download embedding model/ })).toBeNull();
  });

  it("runs optimize, rebuild, and migration actions only when idle", () => {
    const onOptimize = vi.fn();
    const onRebuild = vi.fn();
    const onMigrate = vi.fn();
    renderStatus("healthy", { onOptimize, onRebuild, onMigrate });
    fireEvent.click(screen.getByRole("button", { name: "Optimize index" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild index" }));
    fireEvent.click(screen.getByRole("button", { name: "Migrate embedding Space" }));
    expect(onOptimize).toHaveBeenCalledOnce();
    expect(onRebuild).toHaveBeenCalledOnce();
    expect(onMigrate).toHaveBeenCalledOnce();
  });

  it("keeps cancellation available while disabling only conflicting mutations", () => {
    const onCancel = vi.fn();
    renderStatus("building", { onCancel, task: { progress: 420, label: "Embedding" } });
    expect((screen.getByRole("button", { name: "Cancel index task" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Optimize index" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Rebuild index" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Migrate embedding Space" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel index task" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
