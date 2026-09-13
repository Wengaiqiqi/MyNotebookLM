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
/** Watchdog ceilings: heavy parses regularly stay silent for tens of seconds;
 *  the watchdog only fires when a worker stops reporting entirely. */
export const WORKER_START_TIMEOUT_MS = 120_000;
export const WORKER_IDLE_TIMEOUT_MS = 60_000;
type WorkerJob = {
  taskId: string;
  revisionId: string;
  kind: string;
  data: Uint8Array;
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
};

type ActiveWorkerJob = {
  worker: PoolWorker;
  finish: (error?: Error, message?: unknown, crashed?: boolean, terminateWorker?: boolean) => void;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class WorkerPool {
  readonly concurrency: number;
  private readonly workers = new Set<PoolWorker>();
  private readonly active = new Map<string, ActiveWorkerJob>();
  private readonly cancelled = new Set<string>();
  private readonly queue: WorkerJob[] = [];
  private durablePayload: DurablePayloadLoader | undefined;
  private onProgress: ((taskId: string, value: number) => void) | undefined;
  private closed = false;

  constructor(
    concurrency = defaultWorkerConcurrency(),
    private readonly workerUrl = new URL("../ingestionWorker.js", import.meta.url),
    private readonly factory: () => PoolWorker = () => new Worker(this.workerUrl) as PoolWorker,
    durablePayload?: DurablePayloadLoader,
    onProgress?: (taskId: string, value: number) => void
  ) {
    this.concurrency = Math.max(1, concurrency);
    this.durablePayload = durablePayload;
    this.onProgress = onProgress;
  }

  setDurablePayloadLoader(loader: DurablePayloadLoader): void { this.durablePayload = loader; }
  setProgressCallback(callback: (taskId: string, value: number) => void): void { this.onProgress = callback; }

  start(taskId: string, revisionId: string, kind: string, data: Uint8Array): Promise<WorkerResult> {
    if (this.closed) return Promise.reject(new Error("Worker pool is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ taskId, revisionId, kind, data, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      let worker: PoolWorker;
      try {
        worker = this.factory();
      } catch (reason) {
        job.reject(asError(reason));
        continue;
      }

      this.workers.add(worker);
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const activeJob: ActiveWorkerJob = { worker, finish: () => undefined };
      this.active.set(job.taskId, activeJob);

      const finish = (error?: Error, message?: unknown, crashed = false, terminateWorker = true): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.active.get(job.taskId)?.worker === worker) this.active.delete(job.taskId);
        this.workers.delete(worker);
        this.cancelled.delete(job.taskId);
        worker.removeAllListeners();
        if (terminateWorker) void worker.terminate().catch(() => undefined);

        if (!this.closed && crashed) {
          let durable: DurableWorkerPayload | undefined;
          try {
            durable = this.durablePayload && this.durablePayload.length > 1
              ? this.durablePayload(job.taskId, job.revisionId)
              : undefined;
          } catch {
            durable = undefined;
          }
          if (durable && durable.revisionId === job.revisionId) {
            this.queue.unshift({ ...job, kind: durable.kind, data: durable.data });
            this.pump();
            return;
          }
        }

        if (this.closed) {
          job.reject(error ?? new Error("Worker pool is closed"));
          return;
        }
        if (error) job.reject(error);
        else if (message && typeof message === "object" && (message as any).version === 1 && (message as any).taskId === job.taskId && (message as any).type === "error") {
          try {
            const structured = (message as any).error;
            job.reject(workerError(structured, job.taskId, structured?.code === "TASK_CANCELLED" ? "cancelled" : "failed"));
          } catch {
            job.reject(new Error("Invalid worker error"));
          }
        } else if (!message || typeof message !== "object" || (message as any).version !== 1 || (message as any).type !== "result" || (message as any).taskId !== job.taskId || !Array.isArray((message as any).chunks) || (message as any).chunks.some((chunk: unknown) => !preparedChunkSchema.safeParse(chunk).success)) {
          job.reject(new Error("Invalid worker result"));
        } else {
          job.resolve(message as WorkerResult);
        }
        this.pump();
      };
      activeJob.finish = finish;

      const onWatchdog = (): void => finish(new Error("Worker hard-terminated"), undefined, true);
      timer = setTimeout(onWatchdog, WORKER_START_TIMEOUT_MS);
      const kick = (): void => {
        clearTimeout(timer);
        timer = setTimeout(onWatchdog, WORKER_IDLE_TIMEOUT_MS);
      };
      const onMessage = (message: unknown): void => {
        if (message && typeof message === "object" && (message as any).type === "progress") {
          if ((message as any).version === 1 && (message as any).taskId === job.taskId && typeof (message as any).value === "number") {
            kick();
            this.onProgress?.(job.taskId, Math.max(0, Math.min(1000, (message as any).value)));
          }
          return;
        }
        finish(undefined, message);
      };
      worker.on?.("message", onMessage);
      worker.once("error", (reason) => finish(asError(reason), undefined, true));
      worker.once("exit", (code) => { if (code !== 0) finish(new Error("Worker exited: " + code), undefined, true); });
      try {
        worker.postMessage({ version: 1, type: "start", taskId: job.taskId, kind: job.kind, data: job.data });
      } catch (reason) {
        finish(asError(reason), undefined, true);
      }
    }
  }

  cancel(taskId: string): void {
    const index = this.queue.findIndex((job) => job.taskId === taskId);
    if (index >= 0) {
      this.queue.splice(index, 1)[0]!.reject(workerError({ code: "TASK_CANCELLED", message: "Task cancelled" }, taskId, "cancelled"));
      return;
    }
    const active = this.active.get(taskId);
    if (active) {
      this.cancelled.add(taskId);
      try { active.worker.postMessage({ version: 1, type: "cancel", taskId }); } catch { /* worker exit reports the terminal state */ }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Worker pool is closed");
    for (const job of this.queue.splice(0)) job.reject(error);
    const active = [...this.active.values()];
    const workers = [...this.workers];
    for (const job of active) job.finish(error, undefined, false, false);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    this.workers.clear();
  }
}
