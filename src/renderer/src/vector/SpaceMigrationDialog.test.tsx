// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SpaceMigrationDialog from "./SpaceMigrationDialog";
import { changeLanguage } from "../i18n";

beforeEach(async () => { await changeLanguage("en"); });
afterEach(() => cleanup());

describe("SpaceMigrationDialog", () => {
  it("restores focus to the opener after closing", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<SpaceMigrationDialog open opener={opener} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    view.rerender(<SpaceMigrationDialog open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    return waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
  it("confirms a migration in a centered modal and allows cancellation", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<SpaceMigrationDialog open profileName="E5" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Migrate/ }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows progress and keeps cancellation available during migration", () => {
    const onCancel = vi.fn();
    render(<SpaceMigrationDialog open task={{ progress: 650, label: "Rebuilding" }} onConfirm={vi.fn()} onCancel={onCancel} />);
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(650);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Migrate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("states that the previous Space remains when migration fails", () => {
    render(<SpaceMigrationDialog open failed hasPreviousSpace error="The embedding model could not be reached." onConfirm={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText("The previous embedding Space remains active when migration fails.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry migration" })).toBeTruthy();
  });

  it("does not claim an old Space was kept on first build failure", () => {
    render(<SpaceMigrationDialog open failed onConfirm={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.queryByText(/previous embedding Space remains active/)).toBeNull();
  });
});
