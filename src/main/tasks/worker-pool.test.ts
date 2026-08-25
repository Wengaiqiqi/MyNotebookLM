import { describe, expect, it } from "vitest";
import { WORKER_PROTOCOL_VERSION, parseWorkerMessage, defaultWorkerConcurrency } from "./worker-pool";

describe("worker protocol", () => {
  it("rejects unversioned or malformed messages", () => {
    expect(() => parseWorkerMessage({ type: "start" })).toThrow();
    expect(parseWorkerMessage({ version: WORKER_PROTOCOL_VERSION, type: "cancel", taskId: "t" })).toEqual({ version: 1, type: "cancel", taskId: "t" });
  });
  it("uses the bounded parallelism default", () => expect(defaultWorkerConcurrency(8)).toBe(2));
});
