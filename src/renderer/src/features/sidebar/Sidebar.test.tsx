// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Sidebar from "./Sidebar";
import "../../i18n";

function renderSidebar(onOpenSettings = vi.fn()) {
  return render(
    <Sidebar
      projects={[]}
      archived={[]}
      busy={false}
      onboarding={false}
      language="en"
      theme="light"
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onMenuAction={vi.fn()}
      onOpenSettings={onOpenSettings}
      settingsActive={false}
      onLanguage={vi.fn()}
      onTheme={vi.fn()}
    />
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("Sidebar", () => {
  it("collapses to a rail, remembers it, and expands again", () => {
    const onOpenSettings = vi.fn();
    renderSidebar(onOpenSettings);

    fireEvent.click(screen.getByRole("button", { name: /collapse project list|收起项目栏/i }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(localStorage.getItem("mynotebooklm.sidebarCollapsed")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /^(settings|设置)$/i }));
    expect(onOpenSettings).toHaveBeenCalled();

    cleanup();
    renderSidebar();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /expand project list|展开项目栏/i }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(localStorage.getItem("mynotebooklm.sidebarCollapsed")).toBeNull();
  });
});
