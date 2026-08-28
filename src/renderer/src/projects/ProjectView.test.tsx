// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import ProjectView from "./ProjectView";

describe("ProjectView", () => {
  it("owns the workspace header and source/chat unavailable states", () => {
    render(<ProjectView appName="MyNotebookLM" project={{ id: "p1", name: "Research", archived: false, status: "active", deletedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" }} routes={{}} busy={false} workspaceTitle="Workspace" emptyTitle="Empty" emptyBody="None" createLabel="Create" sourceImportUnavailable="No sources" importSources="Import sources" chatUnavailable="Chat unavailable" sourcesLabel="Sources" noSourcesTitle="No sources" noSourcesBody="None" askLabel="Ask" openSettingsLabel="Open settings" onOpenSettings={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Research" })).toBeTruthy();
    expect(screen.getAllByText("No sources")).toHaveLength(2);
    expect(screen.getAllByText("Chat unavailable")).toHaveLength(2);
  });
});
