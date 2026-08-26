import { describe, expect, it } from "vitest";
import { SpaceService } from "./space-service";
describe("SpaceService", () => {
  it("rolls back a failed, cancelled, or crashed build and retains the old space", async () => {
    const states: string[] = []; const service = new SpaceService({ createOrReuse: () => ({ id: "new", state: "preparing" }), activate: () => states.push("active"), fail: () => states.push("failed") } as never);
    await expect(service.build({} as never, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(states).toEqual(["failed"]);
  });
  it("uses explicit cancellation semantics", async () => {
    const states: string[] = []; const service = new SpaceService({ createOrReuse: () => ({ id: "new", projectId: "p", state: "preparing" }), activate: () => states.push("active"), fail: () => states.push("failed"), cancel: () => states.push("cancelled") } as never);
    const error = await service.build({} as never, async () => {}, AbortSignal.abort()).catch(e => e);
    expect(error).toMatchObject({ code: "SPACE_BUILD_CANCELLED" }); expect(states).toEqual(["cancelled"]);
  });
  it("runs startup recovery, rebuilds from SQLite, and schedules optimize", async () => {
    const calls: string[] = []; const service = new SpaceService({ recoverInterrupted: () => { calls.push("recover"); } } as never, { rebuild: async () => { calls.push("rebuild"); }, optimize: async () => { calls.push("optimize"); } });
    service.recoverInterrupted(); await service.rebuild({} as never); const task = service.optimize({} as never); expect(task).toBeInstanceOf(Promise); await task; expect(calls).toEqual(["recover", "rebuild", "optimize"]);
  });
});
