import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import { RETRIEVAL_CHANNELS, VECTOR_CHANNELS } from "../../shared/ipc";
import { registerVectorHandlers } from "./register-vector-handlers";

type Handler = Parameters<IpcMain["handle"]>[1];
class FakeIpc implements Pick<IpcMain, "handle" | "removeHandler"> {
  handlers = new Map<string, Handler>();
  removed: string[] = [];
  handle(channel: string, handler: Handler) { this.handlers.set(channel, handler); }
  removeHandler(channel: string) { this.removed.push(channel); this.handlers.delete(channel); }
}

const projectId = "00000000-0000-4000-8000-000000000001";
const spaceId = "00000000-0000-4000-8000-000000000002";
const profileId = "00000000-0000-4000-8000-000000000003";
const taskId = "00000000-0000-4000-8000-000000000004";
const task = { id: taskId, projectId, sourceId: null, kind: "optimize" as const, state: "queued" as const, stage: "indexing" as const, progress: 0, attempt: 0, error: null, idempotencyKey: null, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" };
const health = { spaceId, healthy: true, indexedCount: 1 };
const ok = <T>(value: T) => ({ ok: true as const, value });
const validation = { ok: false as const, error: { code: "VALIDATION" as const, messageKey: "errors.validation", recoverable: false } };
async function invoke(ipc: FakeIpc, channel: string, input?: unknown) { const handler = ipc.handlers.get(channel); if (!handler) throw new Error("missing handler"); return handler({} as never, input); }
function service() { return { getHealth: vi.fn(async () => ok(health)), startMigration: vi.fn(async () => ok(task)), rebuild: vi.fn(async () => ok(task)), optimize: vi.fn(async () => ok(task)), cancelTask: vi.fn(async () => ok(task)), search: vi.fn(async () => ok([{ chunkId: taskId, score: 1, text: "hit", locator: {} }])), subscribe: vi.fn(() => vi.fn()) }; }

describe("registerVectorHandlers", () => {
  it("registers and routes vector/retrieval APIs", async () => { const ipc = new FakeIpc(); const svc = service(); registerVectorHandlers(ipc, svc); await invoke(ipc, VECTOR_CHANNELS.getHealth, { projectId }); await invoke(ipc, VECTOR_CHANNELS.startMigration, { projectId, profileId }); await invoke(ipc, VECTOR_CHANNELS.rebuild, { projectId, spaceId }); await invoke(ipc, VECTOR_CHANNELS.optimize, { projectId, spaceId }); await invoke(ipc, VECTOR_CHANNELS.cancelTask, { projectId, taskId }); await invoke(ipc, RETRIEVAL_CHANNELS.search, { projectId, query: "hello", limit: 12 }); expect(svc.getHealth).toHaveBeenCalledWith({ projectId }); expect(svc.startMigration).toHaveBeenCalledWith({ projectId, profileId }); expect(svc.rebuild).toHaveBeenCalledWith({ projectId, spaceId }); expect(svc.optimize).toHaveBeenCalledWith({ projectId, spaceId }); expect(svc.cancelTask).toHaveBeenCalledWith({ projectId, taskId }); expect(svc.search).toHaveBeenCalledWith({ projectId, query: "hello", limit: 12 }); });
  it("rejects forged IDs/raw filters and malformed output", async () => { const ipc = new FakeIpc(); const svc = service(); registerVectorHandlers(ipc, svc); await expect(invoke(ipc, VECTOR_CHANNELS.rebuild, { projectId, spaceId: "forged", filter: "x = 1" })).resolves.toEqual(validation); expect(svc.rebuild).not.toHaveBeenCalled(); svc.getHealth.mockResolvedValueOnce(ok({ ...health, indexedCount: -1 } as never)); await expect(invoke(ipc, VECTOR_CHANNELS.getHealth, { projectId })).resolves.toEqual({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", recoverable: false } }); });
  it("preserves ownership, capability, conflict and cancellation failures from the main service", async () => {
    const ipc = new FakeIpc(); const svc = service(); registerVectorHandlers(ipc, svc);
    const owned = { ok: false as const, error: { code: "NOT_FOUND" as const, messageKey: "errors.notFound", recoverable: false } };
    const capability = { ok: false as const, error: { code: "VALIDATION" as const, messageKey: "errors.modelCapability", recoverable: false } };
    const conflict = { ok: false as const, error: { code: "CONFLICT" as const, messageKey: "errors.taskConflict", recoverable: true } };
    svc.rebuild.mockResolvedValueOnce(owned as never); svc.startMigration.mockResolvedValueOnce(capability as never); svc.optimize.mockResolvedValueOnce(conflict as never);
    await expect(invoke(ipc, VECTOR_CHANNELS.rebuild, { projectId, spaceId })).resolves.toEqual(owned);
    await expect(invoke(ipc, VECTOR_CHANNELS.startMigration, { projectId, profileId })).resolves.toEqual(capability);
    await expect(invoke(ipc, VECTOR_CHANNELS.optimize, { projectId, spaceId })).resolves.toEqual(conflict);
    await expect(invoke(ipc, VECTOR_CHANNELS.cancelTask, { projectId, taskId })).resolves.toEqual(ok(task));
    expect(svc.cancelTask).toHaveBeenCalledWith({ projectId, taskId });
  });
  it("cleans up registered handlers", () => { const ipc = new FakeIpc(); registerVectorHandlers(ipc, service()); const cleanup = registerVectorHandlers(ipc, service()); cleanup(); expect(ipc.removed).toEqual(expect.arrayContaining(Object.values(VECTOR_CHANNELS).filter(channel => channel !== VECTOR_CHANNELS.taskUpdate))); });
});
