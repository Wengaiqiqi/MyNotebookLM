import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { PreparedChunk } from "../../workers/ingestion/types";
import { sourceLocatorSchema } from "../../shared/sources";
import { z } from "zod";

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
export type WorkerError = Error & { code: string; taskId: string; state: "failed" | "cancelled" };
export type WorkerProgress = { version: 1; type: "progress"; taskId: string; value: number };
const preparedChunkSchema = z.object({ ordinal: z.number().int().nonnegative(), text: z.string(), locator: sourceLocatorSchema, contentHash: z.string().min(1), tokenEstimate: z.number().int().nonnegative() }).strict();
const workerErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
function workerError(value: unknown, taskId: string, state: WorkerError["state"]): WorkerError { const parsed = workerErrorSchema.parse(value); const error = new Error(parsed.message) as WorkerError; error.code = parsed.code; error.taskId = taskId; error.state = state; return error; }
export type PoolWorker = { postMessage: (message: unknown) => void; terminate: () => Promise<number>; on?: (event: string, listener: (...args: any[]) => void) => PoolWorker; once: (event: string, listener: (...args: any[]) => void) => PoolWorker; removeAllListeners: () => PoolWorker };
export type DurableWorkerPayload = { kind: string; data: Uint8Array; revisionId?: string };
type DurablePayloadLoader = ((taskId: string, revisionId: string) => DurableWorkerPayload | undefined) | ((taskId: string) => DurableWorkerPayload | undefined);
export class WorkerPool {
  readonly concurrency: number;
  private readonly workers = new Set<PoolWorker>(); private readonly active = new Map<string, PoolWorker>(); private readonly cancelled = new Set<string>();
  private readonly queue: Array<{ taskId: string; revisionId: string; kind: string; data: Uint8Array; resolve: (r: WorkerResult) => void; reject: (e: Error) => void }> = [];
  private durablePayload: DurablePayloadLoader | undefined;
  private onProgress: ((taskId: string, value: number) => void) | undefined;
  constructor(concurrency = defaultWorkerConcurrency(), private readonly workerUrl = new URL("../../workers/ingestion/worker-entry.ts", import.meta.url), private readonly factory: () => PoolWorker = () => new Worker(this.workerUrl) as PoolWorker, durablePayload?: DurablePayloadLoader, onProgress?: (taskId: string, value: number) => void) { this.concurrency = Math.max(1, concurrency); this.durablePayload = durablePayload; this.onProgress = onProgress; }
  setDurablePayloadLoader(loader: DurablePayloadLoader): void { this.durablePayload = loader; }
  setProgressCallback(callback: (taskId: string, value: number) => void): void { this.onProgress = callback; }
  start(taskId: string, revisionId: string, kind: string, data: Uint8Array): Promise<WorkerResult> { return new Promise((resolve, reject) => { this.queue.push({ taskId, revisionId, kind, data, resolve, reject }); this.pump(); }); }
  private pump(): void { while (this.active.size < this.concurrency && this.queue.length) { const job = this.queue.shift()!; const worker = this.factory(); this.workers.add(worker); this.active.set(job.taskId, worker); let done = false; const finish = (error?: Error, message?: unknown, crashed = false) => { if (done) return; done = true; clearTimeout(timer); this.active.delete(job.taskId); this.workers.delete(worker); this.cancelled.delete(job.taskId); worker.removeAllListeners(); void worker.terminate(); if (crashed) { const durable = this.durablePayload && this.durablePayload.length > 1 ? this.durablePayload(job.taskId, job.revisionId) : undefined; if (durable && durable.revisionId === job.revisionId) { this.queue.unshift({ ...job, kind: durable.kind, data: durable.data }); this.pump(); return; } } if (error) job.reject(error); else if (message && typeof message === "object" && (message as any).version === 1 && (message as any).taskId === job.taskId && (message as any).type === "error") { try { const structured = (message as any).error; job.reject(workerError(structured, job.taskId, structured?.code === "TASK_CANCELLED" ? "cancelled" : "failed")); } catch { job.reject(new Error("Invalid worker error")); } } else if (!message || typeof message !== "object" || (message as any).version !== 1 || (message as any).type !== "result" || (message as any).taskId !== job.taskId || !Array.isArray((message as any).chunks) || (message as any).chunks.some((chunk: unknown) => !preparedChunkSchema.safeParse(chunk).success)) job.reject(new Error("Invalid worker result")); else job.resolve(message as WorkerResult); this.pump(); }; const timer = setTimeout(() => finish(new Error("Worker hard-terminated"), undefined, true), 5000); const onMessage = (message: unknown) => { if (message && typeof message === "object" && (message as any).type === "progress") { if ((message as any).version === 1 && (message as any).taskId === job.taskId && typeof (message as any).value === "number") this.onProgress?.(job.taskId, Math.max(0, Math.min(1000, (message as any).value))); return; } finish(undefined, message); }; worker.on?.("message", onMessage); worker.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error)), undefined, true)); worker.once("exit", (code) => { if (code !== 0) finish(new Error("Worker exited: " + code), undefined, true); }); worker.postMessage({ version: 1, type: "start", taskId: job.taskId, kind: job.kind, data: job.data }); } }
  cancel(taskId: string): void { const index = this.queue.findIndex((job) => job.taskId === taskId); if (index >= 0) { this.queue.splice(index, 1)[0]!.reject(workerError({ code: "TASK_CANCELLED", message: "Task cancelled" }, taskId, "cancelled")); return; } if (this.active.has(taskId)) { this.cancelled.add(taskId); this.active.get(taskId)!.postMessage({ version: 1, type: "cancel", taskId }); } }
  async close(): Promise<void> { await Promise.all([...this.workers].map((worker) => worker.terminate())); this.workers.clear(); }
}
