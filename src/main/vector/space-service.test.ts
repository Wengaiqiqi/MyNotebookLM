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
    const calls: string[] = []; const service = new SpaceService({ recoverInterrupted: () => { calls.push("recover"); }, createOrReuse: () => ({ id: "new", projectId: "p", state: "preparing" }), activate: () => {}, fail: () => {}, cancel: async () => {} } as never, { rebuild: async () => { calls.push("rebuild"); }, optimize: async () => { calls.push("optimize"); } });
    service.recoverInterrupted(); await service.rebuild({ spec: { projectId: "p" } } as never); const task = service.optimize({} as never); expect(task).toBeInstanceOf(Promise); await task; expect(calls).toEqual(["recover", "rebuild", "optimize"]);
  });
  it("backs up before activating and surfaces backup failure", async () => {
    const calls: string[] = []; const service = new SpaceService({ createOrReuse: () => ({ id: "new", state: "preparing" }), activate: () => calls.push("active"), fail: () => calls.push("failed") } as never, undefined, async () => { calls.push("backup"); throw new Error("backup failed"); });
    await expect(service.build({} as never, async () => {})).rejects.toThrow("backup failed"); expect(calls).toEqual(["backup", "failed"]);
  });
  it("rebuilds a shadow space from SQLite callback, validates it, then activates", async () => {
    const calls: string[] = []; const service = new SpaceService({ createOrReuse: () => ({ id: "new", projectId: "p", state: "preparing" }), activate: () => calls.push("active"), fail: () => calls.push("failed") } as never, { rebuild: async (input: unknown) => { expect(input).toMatchObject({ authoritative: "sqlite" }); calls.push("rebuild"); }, optimize: async () => {} }, async () => calls.push("backup"));
    await service.rebuild({ spec: { projectId: "p" }, authoritative: "sqlite", verify: async () => { calls.push("verify"); } });
    expect(calls).toEqual(["rebuild", "verify", "backup", "active"]);
  });
  it("keeps the active space when rebuild is cancelled", async () => {
    const calls: string[] = []; const service = new SpaceService({ createOrReuse: () => ({ id: "new", projectId: "p", state: "preparing" }), activate: () => calls.push("active"), fail: () => calls.push("failed"), cancel: async () => calls.push("cancelled") } as never, { rebuild: async () => { throw Object.assign(new Error("cancel"), { code: "SPACE_BUILD_CANCELLED" }); }, optimize: async () => {} });
    await expect(service.rebuild({ spec: { projectId: "p" } })).rejects.toMatchObject({ code: "SPACE_BUILD_CANCELLED" }); expect(calls).toEqual(["cancelled"]);
  });
});
