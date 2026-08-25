import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { WORKER_PROTOCOL_VERSION, parseWorkerMessage, defaultWorkerConcurrency, WorkerPool } from "./worker-pool";

describe("worker protocol", () => {
  it("rejects unversioned or malformed messages", () => {
    expect(() => parseWorkerMessage({ type: "start" })).toThrow();
    expect(parseWorkerMessage({ version: WORKER_PROTOCOL_VERSION, type: "cancel", taskId: "t" })).toEqual({ version: 1, type: "cancel", taskId: "t" });
  });
  it("uses the bounded parallelism default", () => expect(defaultWorkerConcurrency(8)).toBe(2));

  it("enforces slots and queues work until a slot is released", async () => {
    const workers: Array<EventEmitter & { postMessage: (message: unknown) => void; terminate: () => Promise<number> }> = [];
    const pool = new WorkerPool(1, new URL("file:///fake"), () => {
      const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
      workers.push(worker); return worker;
    });
    const first = pool.start("one", "text", new Uint8Array());
    const second = pool.start("two", "text", new Uint8Array());
    expect(workers).toHaveLength(1);
    workers[0]!.emit("message", { version: 1, type: "result", taskId: "one", chunks: [] });
    await first;
    workers[1]!.emit("message", { version: 1, type: "result", taskId: "two", chunks: [] });
    await second;
    expect(workers).toHaveLength(2);
    await pool.close();
  });

  it("rejects malformed result messages", async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
    const pool = new WorkerPool(1, new URL("file:///fake"), () => worker as any);
    const pending = pool.start("bad", "text", new Uint8Array());
    worker.emit("message", { type: "result", taskId: "bad", chunks: [] });
    await expect(pending).rejects.toThrow();
    await pool.close();
  });
});
