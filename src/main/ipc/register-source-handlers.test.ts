import { describe, expect, it, vi } from "vitest";
import { SOURCE_CHANNELS } from "../../shared/ipc";
import { registerSourceHandlers } from "./register-source-handlers";

function ipc() { const handlers = new Map<string, (...args: any[]) => any>(); return { handlers, handle: vi.fn((c, h) => handlers.set(c, h)), removeHandler: vi.fn((c) => handlers.delete(c)), on: vi.fn(), removeListener: vi.fn() }; }
const projectId = "11111111-1111-4111-8111-111111111111";

describe("source IPC handlers", () => {
  it("rejects a token from another project and invalid retry", async () => {
    const bus = ipc();
    const service = { resolveDialogToken: vi.fn().mockReturnValue({ projectId: "other", path: "x.txt" }), retryTask: vi.fn() };
    registerSourceHandlers(bus as any, service as any, { showOpenDialog: vi.fn() } as any);
    const retry = bus.handlers.get(SOURCE_CHANNELS.retry)!;
    expect(retry({}, { projectId, taskId: "22222222-2222-4222-8222-222222222222" })).toMatchObject({ ok: false });
    expect(service.retryTask).not.toHaveBeenCalled();
  });

  it("returns null for cancelled dialog and cleanup removes handlers", async () => {
    const bus = ipc();
    const dialog = { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) };
    const cleanup = registerSourceHandlers(bus as any, {} as any, dialog as any);
    const choose = bus.handlers.get(SOURCE_CHANNELS.chooseFiles)!;
    await expect(choose({}, { projectId })).resolves.toBeNull();
    cleanup();
    expect(bus.removeHandler).toHaveBeenCalledWith(SOURCE_CHANNELS.chooseFiles);
  });
});
