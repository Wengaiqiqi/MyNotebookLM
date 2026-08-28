import { describe, expect, it, vi } from "vitest";
import { SOURCE_CHANNELS } from "../../shared/ipc";
import { registerSourceHandlers } from "./register-source-handlers";

function ipc() { const handlers = new Map<string, (...args: any[]) => any>(); return { handlers, handle: vi.fn((c, h) => handlers.set(c, h)), removeHandler: vi.fn((c) => handlers.delete(c)), on: vi.fn(), removeListener: vi.fn() }; }
const projectId = "11111111-1111-4111-8111-111111111111";

describe("source IPC handlers", () => {
  it("requires project ownership before mutating a source or task", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const ipc = { handle: (name: string, fn: any) => handlers.set(name, fn), removeHandler: vi.fn() } as any;
    const service = { listSources: vi.fn(() => []), listTasks: vi.fn(() => []), ownsSource: vi.fn(() => false), removeSource: vi.fn(() => undefined), retryTask: vi.fn(() => undefined), cancelTask: vi.fn(() => undefined), importFile: vi.fn(), importUrl: vi.fn() };
    registerSourceHandlers(ipc, service);
    const result = await handlers.get(SOURCE_CHANNELS.remove)!({}, { projectId: "00000000-0000-4000-8000-000000000001", sourceId: "00000000-0000-4000-8000-000000000002" });
    expect(result.ok).toBe(false);
    expect(service.removeSource).not.toHaveBeenCalled();
  });
  it("does not read Electron dialog while registering when file selection is unused", () => {
    expect(() => registerSourceHandlers(ipc() as any, { listSources: () => [], listTasks: () => [] } as any, undefined as any)).not.toThrow();
  });
  it("rejects a token from another project and invalid retry", async () => {
    const bus = ipc();
    const service = { resolveDialogToken: vi.fn().mockReturnValue({ projectId: "other", path: "x.txt" }), retryTask: vi.fn() };
    registerSourceHandlers(bus as any, service as any, { showOpenDialog: vi.fn() } as any);
    const retry = bus.handlers.get(SOURCE_CHANNELS.retry)!;
    await expect(retry({}, { projectId, taskId: "22222222-2222-4222-8222-222222222222" })).resolves.toMatchObject({ ok: false });
    expect(service.retryTask).not.toHaveBeenCalled();
  });

  it("returns null for cancelled dialog and cleanup removes handlers", async () => {
    const bus = ipc();
    const dialog = { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) };
    const cleanup = registerSourceHandlers(bus as any, {} as any, dialog as any);
    const choose = bus.handlers.get(SOURCE_CHANNELS.chooseFiles)!;
    await expect(choose({}, { projectId })).resolves.toMatchObject({ ok: true, value: null });
    cleanup();
    expect(bus.removeHandler).toHaveBeenCalledWith(SOURCE_CHANNELS.chooseFiles);
  });

  it("returns safe errors for list and listTasks failures", async () => {
    const bus = ipc();
    registerSourceHandlers(bus as any, { listSources: () => { throw new Error("secret path"); }, listTasks: () => { throw new Error("secret sql"); } } as any);
    await expect(bus.handlers.get(SOURCE_CHANNELS.list)!({}, { projectId })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await expect(bus.handlers.get(SOURCE_CHANNELS.listTasks)!({}, { projectId })).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("maps authoritative source safety failures without leaking paths", async () => {
    const bus = ipc();
    registerSourceHandlers(bus as any, { importFile: vi.fn(), importUrl: vi.fn(async () => { throw Object.assign(new Error("private address"), { code: "UNSAFE_INPUT" }); }), listSources: () => [], listTasks: () => [] } as any);
    const result = await bus.handlers.get(SOURCE_CHANNELS.importUrl)!({}, { projectId, url: "https://example.com" });
    expect(result).toEqual({ ok: false, error: { code: "UNSAFE_INPUT", messageKey: "errors.unsafeInput", recoverable: false } });
  });
});
