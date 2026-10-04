import { describe, expect, it, vi } from "vitest";
import { registerMindMapHandlers } from "./register-mindmap-handlers";
import { MINDMAP_CHANNELS } from "../../shared/mindmaps";
import { MindMapNotFoundError } from "../notes/mindmap-service";

describe("mind map IPC boundary", () => {
  it("rejects extra destinations and unbound references before opening any file", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const ipc = { handle: (channel: string, handler: any) => handlers.set(channel, handler), removeHandler: vi.fn((channel: string) => handlers.delete(channel)) };
    const service = { get: vi.fn(), saveView: vi.fn(), conversation: vi.fn(), reference: vi.fn(() => { throw new MindMapNotFoundError(); }) };
    const opener = { openChunk: vi.fn() };
    const dispose = registerMindMapHandlers(ipc as any, service as any, opener);
    const input = { projectId: "11111111-1111-4111-8111-111111111111", insightId: "22222222-2222-4222-8222-222222222222", nodeId: "node-0", chunkId: "chunk" };
    const open = handlers.get(MINDMAP_CHANNELS.openReference)!;
    expect(await open({}, { ...input, path: "D:/private.txt" })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(service.reference).not.toHaveBeenCalled();
    expect(await open({}, input)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(opener.openChunk).not.toHaveBeenCalled();
    expect(await handlers.get(MINDMAP_CHANNELS.saveView)!({}, { projectId: input.projectId, insightId: input.insightId, view: { panX: Infinity } })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    dispose(); expect(handlers.size).toBe(0);
  });
});
