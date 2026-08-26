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
    const first = pool.start("one", "revision", "text", new Uint8Array());
    const second = pool.start("two", "revision", "text", new Uint8Array());
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
    const pending = pool.start("bad", "revision", "text", new Uint8Array());
    worker.emit("message", { type: "result", taskId: "bad", chunks: [] });
    await expect(pending).rejects.toThrow();
    await pool.close();
  });

  it("rejects result chunks without the complete prepared-chunk schema", async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
    const pool = new WorkerPool(1, new URL("file:///fake"), () => worker as any);
    const pending = pool.start("bad-chunk", "revision", "text", new Uint8Array());
    worker.emit("message", { version: 1, type: "result", taskId: "bad-chunk", chunks: [{}] });
    await expect(pending).rejects.toThrow("Invalid worker result");
    await pool.close();
  });

  it("accepts only structured worker errors", async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
    const pool = new WorkerPool(1, new URL("file:///fake"), () => worker as any);
    const pending = pool.start("bad-error", "revision", "text", new Uint8Array());
    worker.emit("message", { version: 1, type: "error", taskId: "bad-error", error: { code: "PARSE_FAILED", message: "bad" } });
    await expect(pending).rejects.toMatchObject({ code: "PARSE_FAILED", message: "bad" });
    await pool.close();
  });

  it("routes real worker progress through the callback", async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
    const progress: number[] = [];
    const pool = new WorkerPool(1, new URL("file:///fake"), () => worker as any, undefined, (_taskId, value) => progress.push(value));
    const pending = pool.start("progress", "revision", "text", new Uint8Array());
    worker.emit("message", { version: 1, type: "progress", taskId: "progress", value: 500 });
    worker.emit("message", { version: 1, type: "result", taskId: "progress", chunks: [] });
    await pending;
    expect(progress).toEqual([500]);
    await pool.close();
  });

  it("rejects queued cancellation with the cancelled terminal state", async () => {
    const workers: Array<EventEmitter & { postMessage: (message: unknown) => void; terminate: () => Promise<number> }> = [];
    const pool = new WorkerPool(1, new URL("file:///fake"), () => {
      const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
      workers.push(worker); return worker;
    });
    const first = pool.start("first", "revision", "text", new Uint8Array());
    const queued = pool.start("queued", "revision", "text", new Uint8Array());
    pool.cancel("queued");
    await expect(queued).rejects.toMatchObject({ state: "cancelled", code: "TASK_CANCELLED" });
    workers[0]!.emit("message", { version: 1, type: "result", taskId: "first", chunks: [] });
    await first;
    await pool.close();
  });

  it("replaces a crashed worker and redispatches the durable task payload", async () => {
    const workers: EventEmitter[] = [];
    const pool = new WorkerPool(1, new URL("file:///fake"), () => {
      const worker = Object.assign(new EventEmitter(), { postMessage: () => undefined, terminate: async () => 0 });
      workers.push(worker); return worker as any;
    }, (taskId: string, revisionId: string) => taskId === "durable" && revisionId === "revision" ? { kind: "text", data: new Uint8Array([1]), revisionId } : undefined);
    const pending = pool.start("durable", "revision", "text", new Uint8Array([1]));
    workers[0]!.emit("error", new Error("crash"));
    expect(workers).toHaveLength(2);
    workers[1]!.emit("message", { version: 1, type: "result", taskId: "durable", chunks: [] });
    await expect(pending).resolves.toMatchObject({ taskId: "durable" });
    await pool.close();
  });
});
