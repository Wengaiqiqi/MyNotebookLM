import { describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../shared/ipc";
import { createDesktopApi } from "./create-desktop-api";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research",
  archived: false,
  status: "deleting" as const,
  deletedAt: "2026-08-28T00:00:00.000Z",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

describe("project lifecycle preload round-trip", () => {
  it("validates and routes undo, restore, retry and deletion DTOs", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValue({ ok: true, value: project });
    const api = createDesktopApi({ invoke });
    await expect(api.projects.remove({ id: project.id })).resolves.toEqual(project);
    await expect(api.projects.undo?.({ id: project.id })).resolves.toEqual(project);
    await expect(api.projects.restore?.({ id: project.id })).resolves.toEqual(project);
    await expect(api.projects.retryDelete?.({ id: project.id })).resolves.toEqual(project);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      PROJECT_CHANNELS.remove,
      PROJECT_CHANNELS.undo,
      PROJECT_CHANNELS.restore,
      PROJECT_CHANNELS.retryDelete
    ]);
  });
});
