import { describe, expect, it } from "vitest";
import { ChatSessionRegistry } from "./chat-session-registry";

describe("ChatSessionRegistry", () => {
  const OWNER = { projectId: "p1", userId: "u1" };
  const OTHER = { projectId: "p2", userId: "u2" };

  it("registers and aborts the active controller for a request", () => {
    const registry = new ChatSessionRegistry();
    registry.register("r1", OWNER);
    expect(registry.isActive("r1")).toBe(true);
    expect(registry.cancel("r1", OWNER)).toBe(true);
  });

  it("rejects cancellation from another project or user", () => {
    const registry = new ChatSessionRegistry();
    registry.register("r1", OWNER);
    expect(registry.cancel("r1", OTHER)).toBe(false);
    expect(registry.cancel("missing", OWNER)).toBe(false);
  });

  it("completes by removing only its own entry and handles re-registration", () => {
    const registry = new ChatSessionRegistry();
    registry.register("r1", OWNER);
    registry.complete("r1", OWNER);
    expect(registry.isActive("r1")).toBe(false);
    expect(() => registry.register("r1", OWNER)).not.toThrow();
  });
});
