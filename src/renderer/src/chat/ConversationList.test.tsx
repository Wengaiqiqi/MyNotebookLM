// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import ConversationList from "./ConversationList";

const conversation = (id: string, title: string) => ({
  id, projectId: "11111111-1111-4111-8111-111111111111", title,
  createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
  deletedAt: null, archivedAt: null
});

describe("ConversationList", () => {
  it("uses one dropdown with title/time/delete and a bottom new-conversation row", async () => {
    const first = conversation("c1", "First");
    const second = conversation("c2", "Second");
    const list = vi.fn().mockResolvedValue({ ok: true, value: [first] });
    const create = vi.fn().mockResolvedValue({ ok: true, value: second });
    const rename = vi.fn().mockResolvedValue({ ok: true, value: { ...first, title: "Renamed" } });
    const archive = vi.fn().mockResolvedValue({ ok: true, value: { ...first, archivedAt: "2026-08-29T01:00:00.000Z" } });
    const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const onSelect = vi.fn();
    render(<ConversationList projectId={first.projectId} api={{ list, create, rename, archive, delete: remove }} selectedId="c1" onSelect={onSelect} />);

    await screen.findByRole("button", { name: "First⌄" });
    expect(screen.queryByRole("button", { name: /Rename|重命名|Archive|归档/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "First⌄" }));
    expect(screen.getByText(/2026\/8\/29/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /New conversation|新建对话/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: first.projectId, title: expect.stringMatching(/New conversation|新建对话/) })));
    fireEvent.click(screen.getByRole("button", { name: /Second2026/ }));
    expect(onSelect).toHaveBeenCalledWith("c2");
    fireEvent.click(screen.getByRole("button", { name: /Delete First|删除 First/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ projectId: first.projectId, conversationId: "c1" }));
  });
});
