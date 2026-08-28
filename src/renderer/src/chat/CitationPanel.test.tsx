// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import CitationPanel from "./CitationPanel";
import type { CitationDto } from "../../../shared/chat";

const citation: CitationDto = { id: "citation-1", label: "S1", sourceId: "source-1", sourceChunkId: "chunk-1", sourceDisplayName: "Research PDF", sourceKind: "pdf", locator: { kind: "page", page: 4 }, quote: "A useful finding." };

describe("CitationPanel", () => {
  it("maps numbered citations to one detail card and only then opens the original", async () => {
    const open = vi.fn().mockResolvedValue({ ok: true, value: { opened: "document" } });
    render(<CitationPanel citations={[citation]} selected={citation} projectId="project-1" openCitation={open} />);
    expect(screen.getByText("Research PDF")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open original source|打开原始来源/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ projectId: "project-1", citationId: "citation-1" }));
  });
});
