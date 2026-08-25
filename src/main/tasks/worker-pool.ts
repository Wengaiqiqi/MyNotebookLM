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
export type WorkerResult = { version: 1; type: "result"; taskId: string; chunks: PreparedChunk[] };
export type PoolWorker = { postMessage: (message: unknown) => void; terminate: () => Promise<number>; once: (event: string, listener: (...args: any[]) => void) => PoolWorker; removeAllListeners: () => PoolWorker };
export type DurableWorkerPayload = { kind: string; data: Uint8Array };
export class WorkerPool {
  readonly concurrency: number;
  private readonly workers = new Set<PoolWorker>(); private readonly active = new Map<string, PoolWorker>();
  private readonly queue: Array<{ taskId: string; kind: string; data: Uint8Array; resolve: (r: WorkerResult) => void; reject: (e: Error) => void }> = [];
  private durablePayload: ((taskId: string) => DurableWorkerPayload | undefined) | undefined;
  constructor(concurrency = defaultWorkerConcurrency(), private readonly workerUrl = new URL("../../workers/ingestion/worker-entry.ts", import.meta.url), private readonly factory: () => PoolWorker = () => new Worker(this.workerUrl) as PoolWorker, durablePayload?: (taskId: string) => DurableWorkerPayload | undefined) { this.concurrency = Math.max(1, concurrency); this.durablePayload = durablePayload; }
  setDurablePayloadLoader(loader: (taskId: string) => DurableWorkerPayload | undefined): void { this.durablePayload = loader; }
  start(taskId: string, kind: string, data: Uint8Array): Promise<WorkerResult> { return new Promise((resolve, reject) => { this.queue.push({ taskId, kind, data, resolve, reject }); this.pump(); }); }
  private pump(): void { while (this.active.size < this.concurrency && this.queue.length) { const job = this.queue.shift()!; const worker = this.factory(); this.workers.add(worker); this.active.set(job.taskId, worker); let done = false; const finish = (error?: Error, message?: unknown, crashed = false) => { if (done) return; done = true; clearTimeout(timer); this.active.delete(job.taskId); this.workers.delete(worker); worker.removeAllListeners(); void worker.terminate(); if (crashed) { const durable = this.durablePayload?.(job.taskId); if (durable) { this.queue.unshift({ ...job, kind: durable.kind, data: durable.data }); this.pump(); return; } } if (error) job.reject(error); else if (!message || typeof message !== "object" || (message as any).version !== 1 || (message as any).type !== "result" || (message as any).taskId !== job.taskId || !Array.isArray((message as any).chunks)) job.reject(new Error("Invalid worker result")); else job.resolve(message as WorkerResult); this.pump(); }; const timer = setTimeout(() => finish(new Error("Worker hard-terminated")), 5000); worker.once("message", (message: unknown) => finish(undefined, message)); worker.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error)), undefined, true)); worker.once("exit", (code) => finish(new Error("Worker exited: " + code), undefined, true)); worker.postMessage({ version: 1, type: "start", taskId: job.taskId, kind: job.kind, data: job.data }); } }
  cancel(taskId: string): void { const index = this.queue.findIndex((job) => job.taskId === taskId); if (index >= 0) { this.queue.splice(index, 1)[0]!.reject(new Error("Task cancelled")); return; } this.active.get(taskId)?.postMessage({ version: 1, type: "cancel", taskId }); }
  async close(): Promise<void> { await Promise.all([...this.workers].map((worker) => worker.terminate())); this.workers.clear(); }
}
