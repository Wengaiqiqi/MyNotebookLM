import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { PreparedChunk } from "../../workers/ingestion/types";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export type WorkerMessage =
  | { version: 1; type: "start"; taskId: string; kind: string; data: Uint8Array }
  | { version: 1; type: "cancel"; taskId: string };
export function defaultWorkerConcurrency(parallelism = availableParallelism()): number { return Math.max(1, Math.min(2, parallelism - 1)); }
export function parseWorkerMessage(value: unknown): WorkerMessage {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("Invalid worker message");
  const message = value as Record<string, unknown>;
  if (message.type === "cancel" && typeof message.taskId === "string") return { version: 1, type: "cancel", taskId: message.taskId };
  if (message.type === "start" && typeof message.taskId === "string" && typeof message.kind === "string" && message.data instanceof Uint8Array) return message as WorkerMessage;
  throw new Error("Invalid worker message");
}
export type WorkerResult = { taskId: string; chunks: PreparedChunk[] };
export class WorkerPool {
  readonly concurrency: number;
  private readonly workers = new Set<Worker>();
  constructor(concurrency = defaultWorkerConcurrency(), private readonly workerUrl = new URL("../../workers/ingestion/worker-entry.ts", import.meta.url)) { this.concurrency = concurrency; }
  start(taskId: string, kind: string, data: Uint8Array): Promise<WorkerResult> {
    const worker = new Worker(this.workerUrl, { workerData: undefined }); this.workers.add(worker);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Worker hard-terminated")); }, 5000);
      worker.once("message", (message: unknown) => { clearTimeout(timer); void worker.terminate(); if (message && typeof message === "object" && (message as { type?: unknown }).type === "result") resolve(message as WorkerResult); else reject(new Error("Worker failed")); });
      worker.once("error", (error) => { clearTimeout(timer); this.workers.delete(worker); reject(error); });
      worker.postMessage({ version: 1, type: "start", taskId, kind, data });
    });
  }
  cancel(taskId: string): void { for (const worker of this.workers) worker.postMessage({ version: 1, type: "cancel", taskId }); }
  async close(): Promise<void> { await Promise.all([...this.workers].map((worker) => worker.terminate())); this.workers.clear(); }
}
