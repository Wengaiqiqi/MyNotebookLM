// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Sidebar from "./Sidebar";
import "../../i18n";

function renderSidebar() {
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
      onOpenSettings={vi.fn()}
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
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /collapse project list|收起项目栏/i }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(localStorage.getItem("mynotebooklm.sidebarCollapsed")).toBe("1");

    cleanup();
    renderSidebar();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /expand project list|展开项目栏/i }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(localStorage.getItem("mynotebooklm.sidebarCollapsed")).toBeNull();
  });
});
