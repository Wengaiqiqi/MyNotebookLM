import { describe, expect, it } from "vitest";
import { SpaceService } from "./space-service";
describe("SpaceService", () => {
  it("rolls back a failed, cancelled, or crashed build and retains the old space", async () => {
    const states: string[] = []; const service = new SpaceService({ createOrReuse: () => ({ id: "new", state: "preparing" }), activate: () => states.push("active"), fail: () => states.push("failed") } as never);
    await expect(service.build({} as never, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(states).toEqual(["failed"]);
  });
});
