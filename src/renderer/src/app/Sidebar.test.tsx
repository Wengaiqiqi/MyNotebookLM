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
});
