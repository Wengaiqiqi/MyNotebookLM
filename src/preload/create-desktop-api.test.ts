import { describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../shared/ipc";
import { createDesktopApi } from "./create-desktop-api";

describe("createDesktopApi", () => {
  it("exposes only named project commands", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const api = createDesktopApi({ invoke });

    await api.projects.list();

    expect(invoke).toHaveBeenCalledWith(PROJECT_CHANNELS.list);
    expect(Object.keys(api)).toEqual(["projects"]);
    expect(Object.keys(api.projects)).toEqual(["list", "create", "rename", "archive", "remove"]);
  });
});
