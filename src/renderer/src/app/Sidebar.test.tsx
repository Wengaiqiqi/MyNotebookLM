// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

describe("Sidebar", () => {
  it("owns the brand, project navigation, and preferences", () => {
    render(<Sidebar brand="MyNotebookLM" projectTitle="Projects" settingsLabel="Settings" onSettings={vi.fn()} />);
    expect(screen.getByText("MyNotebookLM")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("renders the archived chevron/list controls and centered navigation structure", () => {
    const view = render(<Sidebar brand="MyNotebookLM" projectTitle="Projects" archivedLabel="Archived" settingsLabel="Settings" projects={[{ id: "p1", name: "Research", archived: false, status: "active", deletedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]} menuLabel="Project actions" />);
    expect(view.container.querySelector(".archived-chevron")).toBeTruthy();
    expect(view.container.querySelector(".archived-list-icon")).toBeTruthy();
    expect(view.container.querySelector(".project-icon.document-icon-small")).toBeTruthy();
    expect(view.container.querySelector(".settings-button.is-centered")).toBeTruthy();
    expect(view.container.querySelectorAll(".preference-row.is-centered")).toHaveLength(2);
  });
});
