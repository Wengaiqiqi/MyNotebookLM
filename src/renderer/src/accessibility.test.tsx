// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppShell from "./app/AppShell";
import "./i18n";
import { changeLanguage } from "./i18n";
import ImportDialog from "./sources/ImportDialog";
import SourcePanel from "./sources/SourcePanel";
import SpaceMigrationDialog from "./vector/SpaceMigrationDialog";
import { AssistantMessageView } from "./chat/SafeMarkdown";
import type { MessageDto } from "../../shared/chat";

const styles = readFileSync("src/renderer/src/styles.css", "utf8");

afterEach(cleanup);
beforeEach(async () => { await changeLanguage("en"); });

describe("desktop accessibility contract", () => {
  it("keeps the application inert while a modal owns focus", () => {
    const { container } = render(<AppShell dialogOpen><main>Workspace</main></AppShell>);
    expect(container.querySelector(".app-shell")?.getAttribute("inert")).toBe("");
    expect(container.querySelector(".app-shell")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("traps keyboard focus and dismisses the import dialog with Escape", () => {
    const onClose = vi.fn();
    render(<ImportDialog projectId="p" open chooseFiles={vi.fn()} importFile={vi.fn()} importUrl={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("import-dialog-title");
    controls.at(-1)?.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses the ModalRoot import dialog with initial focus, bidirectional trap, and opener restoration", async () => {
    const api = {
      chooseFiles: vi.fn(), importFile: vi.fn(), importUrl: vi.fn(), list: vi.fn().mockResolvedValue([]),
      remove: vi.fn(), retry: vi.fn()
    };
    render(<><button type="button" onClick={() => undefined}>Outside</button><SourcePanel projectId="p" sourcesApi={api} tasksApi={{ list: vi.fn().mockResolvedValue([]), cancel: vi.fn(), subscribe: vi.fn(() => vi.fn()) }} labels={{ title: "Sources", add: "Add source", empty: "No sources", remove: "Remove", selected: "Selected", file: "Choose files", url: "Import URL", webAddress: "Web address" }} /></>);
    const trigger = screen.getByRole("button", { name: "Add source" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(document.querySelector("#modal-root")?.contains(dialog)).toBe(true);
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(controls.at(-1));
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores focus after closing a migration dialog and exposes live status", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<SpaceMigrationDialog open opener={opener} task={{ progress: 25, label: "Building" }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("Index task progress");
    view.rerender(<SpaceMigrationDialog open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("announces streaming and failed answer states with actionable repair", () => {
    const base: MessageDto = { id: "m", conversationId: "c", sequence: 1, role: "assistant", content: "partial", state: "streaming", replyToMessageId: null, supersedesMessageId: null, superseded: false, provider: "test", profileId: "p", model: "test", usage: null, errorCode: null, completionReason: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", citations: [] };
    const { rerender } = render(<AssistantMessageView message={base} />);
    expect(screen.getByText("Answering…").getAttribute("aria-live")).toBe("polite");
    rerender(<AssistantMessageView message={{ ...base, state: "failed", errorCode: "NETWORK" }} onRepair={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Repair|Retry/ })).toBeTruthy();
  });

  it("defines paired contrast variables, visible focus, and a 200% zoom layout escape hatch", () => {
    for (const name of ["--bg", "--surface", "--text", "--muted", "--border", "--accent", "--danger"]) {
      expect(styles).toMatch(new RegExp(`${name}:`));
      expect(styles).toMatch(new RegExp(`:root\\[data-theme=\\"dark\\"\\][\\s\\S]*${name}:`));
    }
    expect(styles).toMatch(/button:focus-visible, input:focus-visible, select:focus-visible/);
    expect(styles).toContain("--focus-ring:");
    expect(styles).toMatch(/@media \(max-width: 900px\)/);
    expect(styles).toMatch(/body\s*\{[^}]*min-width:\s*0/);
  });
});
