import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_CHANNELS } from "../../shared/ipc";
import type { ProjectService } from "../projects/project-service";
import { registerProjectHandlers } from "./register-project-handlers";

const project = {
  id: "6db5e7a1-6f22-4a0d-afdf-6a6e4b8df44d",
  name: "研究",
  archived: false,
  status: "active" as const,
  deletedAt: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z"
};

type Handler = Parameters<IpcMain["handle"]>[1];

class FakeIpcMain implements Pick<IpcMain, "handle" | "removeHandler"> {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

function createService() {
  return {
    list: vi.fn(() => [project]),
    create: vi.fn(() => project),
    rename: vi.fn(() => project),
    archive: vi.fn(() => project),
    remove: vi.fn(() => project),
    listArchived: vi.fn(() => [project]),
    listDeleteFailed: vi.fn(() => [project]),
    restore: vi.fn(() => project),
    undo: vi.fn(() => project),
    retryDelete: vi.fn(() => project)
  };
}

function invoke(ipc: FakeIpcMain, channel: string, input?: unknown): unknown {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({} as never, input);
}

describe("registerProjectHandlers", () => {
  it("registers exactly the named project channels", () => {
    const ipc = new FakeIpcMain();

    registerProjectHandlers(ipc, createService() as unknown as ProjectService);

    expect([...ipc.handlers.keys()].sort()).toEqual(Object.values(PROJECT_CHANNELS).sort());
  });

  it.each([
    [PROJECT_CHANNELS.create, { name: "" }],
    [PROJECT_CHANNELS.rename, { id: "not-a-uuid", name: "Renamed" }],
    [PROJECT_CHANNELS.archive, { id: "not-a-uuid" }],
    [PROJECT_CHANNELS.remove, { id: "not-a-uuid" }]
  ])("rejects invalid input on %s before calling the service", async (channel, input) => {
    const ipc = new FakeIpcMain();
    const service = createService();
    registerProjectHandlers(ipc, service as unknown as ProjectService);

    await expect(Promise.resolve().then(() => invoke(ipc, channel, input))).rejects.toThrow();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
    expect(service.rename).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("rejects a list payload before calling the service", async () => {
    const ipc = new FakeIpcMain();
    const service = createService();
    registerProjectHandlers(ipc, service as unknown as ProjectService);

    await expect(
      Promise.resolve().then(() => invoke(ipc, PROJECT_CHANNELS.list, {}))
    ).rejects.toThrow();
    expect(service.list).not.toHaveBeenCalled();
  });

  it("routes valid calls to the selected service methods", () => {
    const ipc = new FakeIpcMain();
    const service = createService();
    registerProjectHandlers(ipc, service as unknown as ProjectService);

    expect(invoke(ipc, PROJECT_CHANNELS.list)).toEqual([project]);
    expect(invoke(ipc, PROJECT_CHANNELS.create, { name: "研究" })).toEqual(project);
    expect(
      invoke(ipc, PROJECT_CHANNELS.rename, { id: project.id, name: "Renamed" })
    ).toEqual(project);
    expect(invoke(ipc, PROJECT_CHANNELS.archive, { id: project.id })).toEqual(project);
    expect(invoke(ipc, PROJECT_CHANNELS.remove, { id: project.id })).toEqual(project);
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.create).toHaveBeenCalledWith({ name: "研究" });
    expect(service.rename).toHaveBeenCalledWith({ id: project.id, name: "Renamed" });
    expect(service.archive).toHaveBeenCalledWith({ id: project.id });
    expect(service.remove).toHaveBeenCalledWith({ id: project.id });
  });

  it("rejects malformed service output", async () => {
    const ipc = new FakeIpcMain();
    const service = createService();
    registerProjectHandlers(ipc, service as unknown as ProjectService);

    service.list.mockReturnValueOnce([{} as never]);
    await expect(
      Promise.resolve().then(() => invoke(ipc, PROJECT_CHANNELS.list))
    ).rejects.toThrow();

    for (const [channel, call] of [
      [PROJECT_CHANNELS.create, () => service.create.mockReturnValueOnce({} as never)],
      [PROJECT_CHANNELS.rename, () => service.rename.mockReturnValueOnce({} as never)],
      [PROJECT_CHANNELS.archive, () => service.archive.mockReturnValueOnce({} as never)]
    ] as const) {
      call();
      await expect(
        Promise.resolve().then(() => invoke(ipc, channel, {
          id: project.id,
          name: "Renamed"
        }))
      ).rejects.toThrow();
    }
  });

  it("rejects a non-undefined remove service result", async () => {
    const ipc = new FakeIpcMain();
    const service = createService();
    service.remove.mockReturnValueOnce("unexpected" as never);
    registerProjectHandlers(ipc, service as unknown as ProjectService);

    await expect(
      Promise.resolve().then(() =>
        invoke(ipc, PROJECT_CHANNELS.remove, { id: project.id })
      )
    ).rejects.toThrow();
    expect(service.remove).toHaveBeenCalledWith({ id: project.id });
  });

  it("removes every registered project handler during cleanup", () => {
    const ipc = new FakeIpcMain();
    const cleanup = registerProjectHandlers(
      ipc,
      createService() as unknown as ProjectService
    );

    cleanup();

    expect([...ipc.handlers.keys()]).toEqual([]);
  });
});
