import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import { TRANSFORMATION_CHANNELS } from "../../shared/ipc";
import { registerTransformationHandlers } from "./register-transformation-handlers";

type Handler = Parameters<IpcMain["handle"]>[1];
class FakeIpc implements Pick<IpcMain, "handle" | "removeHandler"> {
  handlers = new Map<string, Handler>(); removed: string[] = [];
  handle(channel: string, handler: Handler) { this.handlers.set(channel, handler); }
  removeHandler(channel: string) { this.removed.push(channel); this.handlers.delete(channel); }
}
const P = "11111111-1111-4111-8111-111111111111"; const T = "22222222-2222-4222-8222-222222222222";
const task = { id: T, projectId: P, sourceId: null, kind: "transformation" as const, state: "queued" as const, stage: "preparing" as const, progress: 0, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z" };
const ok = <TValue>(value: TValue) => ({ ok: true as const, value });
const invoke = (ipc: FakeIpc, channel: string, input?: unknown) => ipc.handlers.get(channel)!({} as never, input);

function service() {
  return {
    listRules: vi.fn(() => []), createRule: vi.fn(() => ({})), updateRule: vi.fn(() => ({})), deleteRule: vi.fn(() => undefined),
    listBuiltins: vi.fn(() => []), startTask: vi.fn(() => task), cancelTask: vi.fn(() => task), retryTask: vi.fn(() => task),
    listInsights: vi.fn(() => []), convertToNote: vi.fn(() => ({}))
  };
}

describe("registerTransformationHandlers", () => {
  it("returns a queued TaskDto for run/retry and validates all public inputs", async () => {
    const ipc = new FakeIpc(); const svc = service(); registerTransformationHandlers(ipc, svc as never);
    const runResult = await invoke(ipc, TRANSFORMATION_CHANNELS.run, { projectId: P, builtinKey: "summary", language: "en", sourceRevisionId: T }); expect(runResult).toEqual(ok(task));
    await expect(invoke(ipc, TRANSFORMATION_CHANNELS.retry, { projectId: P, taskId: T })).resolves.toEqual(ok(task));
    await expect(invoke(ipc, TRANSFORMATION_CHANNELS.run, { projectId: P, builtinKey: "summary", language: "en", sourceRevisionId: T, state: "completed" })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(svc.startTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: P, builtinKey: "summary" }), expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  });

  it("owns cancellation, forwards abort, and cleans every handler/controller", async () => {
    const ipc = new FakeIpc(); const svc = service(); const cleanup = registerTransformationHandlers(ipc, svc as never);
    await invoke(ipc, TRANSFORMATION_CHANNELS.run, { projectId: P, builtinKey: "summary", language: "en", sourceRevisionId: T });
    await invoke(ipc, TRANSFORMATION_CHANNELS.cancel, { projectId: P, taskId: T });
    expect(svc.cancelTask).toHaveBeenCalledWith({ projectId: P, taskId: T });
    cleanup(); expect(ipc.handlers.size).toBe(0); expect(ipc.removed).toEqual(expect.arrayContaining(Object.values(TRANSFORMATION_CHANNELS)));
  });

  it("maps a service ownership failure to NOT_FOUND without a preflight ownsTask call", async () => {
    const ipc = new FakeIpc(); const svc = service();
    (svc as typeof svc & { ownsTask: ReturnType<typeof vi.fn> }).ownsTask = vi.fn(() => false);
    svc.cancelTask.mockImplementation(() => { const error = new Error("missing"); error.name = "TransformationTaskNotFoundError"; throw error; });
    registerTransformationHandlers(ipc, svc as never);
    await expect(invoke(ipc, TRANSFORMATION_CHANNELS.cancel, { projectId: P, taskId: T })).resolves.toEqual({ ok: false, error: { code: "NOT_FOUND", messageKey: "errors.notFound", recoverable: false } });
    await expect(invoke(ipc, TRANSFORMATION_CHANNELS.cancel, { projectId: "33333333-3333-4333-8333-333333333333", taskId: T })).resolves.toEqual({ ok: false, error: { code: "NOT_FOUND", messageKey: "errors.notFound", recoverable: false } });
    expect(svc.cancelTask).toHaveBeenCalledWith({ projectId: P, taskId: T });
  });

  it("does not abort a controller when durable cancellation rejects ownership", async () => {
    const ipc = new FakeIpc(); const svc = service();
    let signal!: AbortSignal;
    svc.startTask.mockImplementation(((_input: unknown, receivedSignal: AbortSignal) => { signal = receivedSignal; return task; }) as any);
    svc.cancelTask.mockImplementation(() => { const error = new Error("missing"); error.name = "TransformationTaskNotFoundError"; throw error; });
    registerTransformationHandlers(ipc, svc as never);
    await invoke(ipc, TRANSFORMATION_CHANNELS.run, { projectId: P, builtinKey: "summary", language: "en", sourceRevisionId: T });
    await expect(invoke(ipc, TRANSFORMATION_CHANNELS.cancel, { projectId: "33333333-3333-4333-8333-333333333333", taskId: T })).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(signal.aborted).toBe(false);
  });

  it("registers only a service-confirmed owner controller", async () => {
    const ipc = new FakeIpc(); const svc = service();
    let signal!: AbortSignal;
    svc.startTask.mockImplementation(((_input: unknown, receivedSignal: AbortSignal, _onFinished: () => void, onOwnership: (ownership: { taskId: string; owned: boolean }) => void) => {
      signal = receivedSignal;
      onOwnership?.({ taskId: T, owned: false });
      return task;
    }) as any);
    registerTransformationHandlers(ipc, svc as never);
    await invoke(ipc, TRANSFORMATION_CHANNELS.run, { projectId: P, builtinKey: "summary", language: "en", sourceRevisionId: T });
    svc.cancelTask.mockImplementation(() => task);
    await invoke(ipc, TRANSFORMATION_CHANNELS.cancel, { projectId: P, taskId: T });
    expect((svc.cancelTask.mock.calls[0] as any)[0]).toEqual({ projectId: P, taskId: T });
    expect(signal.aborted).toBe(true);
  });

  it("forwards only the first ownership callback and does not retain a nonowner controller", async () => {
    const ipc = new FakeIpc(); const svc = service(); const cleanup = registerTransformationHandlers(ipc, svc as never);
    let signal!: AbortSignal;
    svc.startTask.mockImplementation(((_input: unknown, receivedSignal: AbortSignal, _onFinished: () => void, onOwnership: (ownership: { taskId: string; owned: boolean }) => void) => {
      signal = receivedSignal;
      onOwnership({ taskId: T, owned: false });
      onOwnership({ taskId: T, owned: true });
      return task;
    }) as any);
    await invoke(ipc, TRANSFORMATION_CHANNELS.run, { projectId: P, builtinKey: "summary", language: "en", sourceRevisionId: T });
    cleanup();
    expect(signal.aborted).toBe(true);
  });
});
