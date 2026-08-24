import { describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS, type DesktopApi } from "../shared/ipc";
import { createDesktopApi } from "./create-desktop-api";

const project = {
  id: "6db5e7a1-6f22-4a0d-afdf-6a6e4b8df44d",
  name: "Research",
  archived: false,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
};

const projectId = { id: project.id };

describe("createDesktopApi", () => {
  it("exposes only named project commands", () => {
    const api = createDesktopApi({ invoke: vi.fn() });

    expect(Object.keys(api)).toEqual(["projects"]);
    expect(Object.keys(api.projects)).toEqual(["list", "create", "rename", "archive", "remove"]);
  });

  it("routes every project command through its selected channel", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(undefined);
    const api = createDesktopApi({ invoke });

    await api.projects.list();
    await api.projects.create({ name: "Notebook" });
    await api.projects.rename({ ...projectId, name: "Renamed" });
    await api.projects.archive(projectId);
    await expect(api.projects.remove(projectId)).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, PROJECT_CHANNELS.list);
    expect(invoke).toHaveBeenNthCalledWith(2, PROJECT_CHANNELS.create, { name: "Notebook" });
    expect(invoke).toHaveBeenNthCalledWith(3, PROJECT_CHANNELS.rename, { ...projectId, name: "Renamed" });
    expect(invoke).toHaveBeenNthCalledWith(4, PROJECT_CHANNELS.archive, projectId);
    expect(invoke).toHaveBeenNthCalledWith(5, PROJECT_CHANNELS.remove, projectId);
  });

  it.each([
    ["create", (api: DesktopApi) => api.projects.create({ name: " " })],
    ["rename", (api: DesktopApi) => api.projects.rename({ ...projectId, name: " " })],
    ["archive", (api: DesktopApi) => api.projects.archive({ id: "not-a-uuid" })],
    ["remove", (api: DesktopApi) => api.projects.remove({ id: "not-a-uuid" })]
  ])("rejects invalid %s input before invoking IPC", async (_command, call) => {
    const invoke = vi.fn();

    await expect(call(createDesktopApi({ invoke }))).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["list", (api: DesktopApi) => api.projects.list()],
    ["create", (api: DesktopApi) => api.projects.create({ name: "Notebook" })],
    ["rename", (api: DesktopApi) => api.projects.rename({ ...projectId, name: "Renamed" })],
    ["archive", (api: DesktopApi) => api.projects.archive(projectId)],
    ["remove", (api: DesktopApi) => api.projects.remove(projectId)]
  ])("rejects malformed %s IPC output", async (_command, call) => {
    const invoke = vi.fn().mockResolvedValue({});

    await expect(call(createDesktopApi({ invoke }))).rejects.toThrow();
  });
});
