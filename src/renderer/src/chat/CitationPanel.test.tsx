// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import CitationPanel from "./CitationPanel";
import type { CitationDto } from "../../../shared/chat";

const citation: CitationDto = { id: "citation-1", label: "S1", sourceId: "source-1", sourceChunkId: "chunk-1", sourceDisplayName: "Research PDF", sourceKind: "pdf", locator: { kind: "page", page: 4 }, quote: "A useful finding." };
const citationTwo: CitationDto = { ...citation, id: "citation-1-duplicate", quote: "Duplicate row." };
const citationThree: CitationDto = { ...citation, id: "citation-2", label: "S2", quote: "Second finding." };

describe("CitationPanel", () => {
  it("maps numbered citations to one detail card and only then opens the original", async () => {
    const open = vi.fn().mockResolvedValue({ ok: true, value: { opened: "document" } });
    const view = render(<CitationPanel citations={[citation]} selected={citation} projectId="project-1" openCitation={open} />);
    expect(screen.getByText("Research PDF")).toBeTruthy();
    const card = view.container.querySelector(".citation-detail");
    expect(card?.classList.contains("selected")).toBe(true);
    expect(card?.querySelector(".citation-badge")?.textContent).toBe("S1");
    fireEvent.click(screen.getByRole("button", { name: /Open original source|打开原始来源/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ projectId: "project-1", citationId: "citation-1" }));
  });


  it("deduplicates citation cards, removes the index buttons, and scrolls the selected card into view", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const view = render(<CitationPanel citations={[citation, citationTwo, citationThree]} selected={citationThree} projectId="project-1" />);
    expect(view.container.querySelector('[role="list"]')).toBeNull();
    expect(view.container.querySelectorAll("span")).toHaveLength(2);
    expect(view.container.querySelectorAll("article")).toHaveLength(2);
    fireEvent.click(view.container.querySelector(".citation-detail:not(.selected)")!);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(view.container.textContent).toContain("Second finding.");
    expect(view.container.querySelector(".citation-detail.selected")?.textContent).toContain("S1");
  });

  it("uses the clicked message citation when another message reuses the same label", () => {
    const first = { ...citation, id: "first-s1", sourceDisplayName: "First source" };
    const second = { ...citation, id: "second-s1", sourceDisplayName: "Second source" };
    const view = render(<CitationPanel citations={[first, second]} selected={second} projectId="project-1" />);
    expect(view.container.querySelector(".citation-detail")?.textContent).toContain("Second source");
    expect(view.container.querySelector(".citation-detail")?.textContent).not.toContain("First source");
  });
});
