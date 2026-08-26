import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, appendFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_MODEL_ID, LOCAL_MODEL_MANIFEST, LOCAL_MODEL_REVISION, type LocalModelManifest } from "./local-model-manifest";
export type ModelManifest = { modelId: string; revision: string; dimension: number; files: Readonly<Record<string, string>> };

export type DownloadProgress = (value: number) => void;
export type ModelDownloader = (file: string, offset: number, onProgress: DownloadProgress, signal: AbortSignal) => Promise<Uint8Array>;
export type ModelRuntime<T> = (directory: string, signal: AbortSignal) => Promise<T>;
function validateManagedIdentity(manifest: Pick<ModelManifest, "modelId" | "revision">): void {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(manifest.modelId) || !/^[A-Za-z0-9._-]+$/.test(manifest.revision) || manifest.revision === "." || manifest.revision === "..") throw new Error("模型标识或 revision 无效");
}
export function managedActiveDirectory(root: string, manifest: Pick<ModelManifest, "modelId" | "revision">): string { validateManagedIdentity(manifest); return path.join(path.resolve(root), `${manifest.modelId.replaceAll("/", "__")}-${manifest.revision}`); }
export function managedStagingDirectory(root: string, manifest: Pick<ModelManifest, "modelId" | "revision">): string { return `${managedActiveDirectory(root, manifest)}.partial`; }
const MODEL_FILES = new Set(Object.keys(LOCAL_MODEL_MANIFEST.files));
const HF_ROOT = `https://huggingface.co/${LOCAL_MODEL_ID}/resolve/${LOCAL_MODEL_REVISION}`;
export function createLocalModelDownloader(fetcher: typeof fetch = fetch): ModelDownloader {
  return async (file, offset, onProgress, signal) => {
    if (!MODEL_FILES.has(file) || file.includes("..") || path.isAbsolute(file)) throw new Error("不允许的模型文件路径");
    const init: RequestInit = { signal }; if (offset) init.headers = { Range: `bytes=${offset}-` };
    const response = await fetcher(`${HF_ROOT}/${file}`, init);
    if (offset ? response.status !== 206 : response.status !== 200) throw new Error(`模型下载失败: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); onProgress(bytes.length ? 1 : 0); return bytes;
  };
}
export function createLocalModelManager<T>(root: string, runtime: ModelRuntime<T>, fetcher: typeof fetch = fetch, stagingRuntime: ModelRuntime<T> = runtime) {
  return new LocalModelManager(root, createLocalModelDownloader(fetcher), runtime, LOCAL_MODEL_MANIFEST, stagingRuntime);
}
export class OfflineModelError extends Error { constructor() { super("本地模型未安装，当前处于离线模式"); this.name = "OfflineModelError"; } }

export class LocalModelManager<T = unknown> {
  private loading: LoadingOperation<T> | undefined;
  constructor(private readonly root: string, private readonly downloader: ModelDownloader, private readonly runtime: ModelRuntime<T>, private readonly manifest: ModelManifest = LOCAL_MODEL_MANIFEST, private readonly stagingRuntime: ModelRuntime<T> = runtime) {}
  private activeDir() { return managedActiveDirectory(this.root, this.manifest); }
  private stagingDir() { return managedStagingDirectory(this.root, this.manifest); }
  async ensureReady(offline = false, onProgress: DownloadProgress = () => {}, signal = new AbortController().signal): Promise<T> {
    let loading = this.loading;
    if (!loading) {
      const controller = new AbortController();
      const operation = { controller, waiters: new Set<LoadingWaiter>(), promise: undefined as unknown as Promise<T> };
      operation.promise = this.load(offline, value => { for (const waiter of operation.waiters) waiter.onProgress(value); }, controller.signal).finally(() => {
        if (this.loading === operation) this.loading = undefined;
      });
      this.loading = operation;
      loading = operation;
    }
    return this.waitFor(loading, onProgress, signal);
  }
  private waitFor(operation: LoadingOperation<T>, onProgress: DownloadProgress, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let abort!: () => void;
      const waiter: LoadingWaiter = { onProgress, signal };
      operation.waiters.add(waiter);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        operation.waiters.delete(waiter);
        signal.removeEventListener("abort", abort);
        callback();
      };
      abort = () => {
        const reason = signal.reason ?? new DOMException("Aborted", "AbortError");
        finish(() => reject(reason));
        if (operation.waiters.size === 0) operation.controller.abort(reason);
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      operation.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  private async load(offline: boolean, onProgress: DownloadProgress, signal: AbortSignal): Promise<T> {
    const active = this.activeDir(); await mkdir(this.root, { recursive: true });
    let missing = false;
    try { for (const [file, hash] of Object.entries(this.manifest.files)) { const bytes = await readFile(path.join(active, file)); if (hash === "UNRESOLVED" || sha(bytes) !== hash) throw new Error(`模型文件校验失败: ${file}`); } return this.runtime(active, signal); }
    catch (e) { missing = (e as NodeJS.ErrnoException).code === "ENOENT"; if (offline) throw missing ? new OfflineModelError() : e; }
    const staging = this.stagingDir(); await mkdir(staging, { recursive: true });
    try { let done = 0; const files = Object.entries(this.manifest.files); for (const [file, expected] of files) { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); const target = path.join(staging, file); await mkdir(path.dirname(target), { recursive: true }); let offset = 0; try { offset = (await stat(`${target}.part`)).size; } catch {} const bytes = await this.downloader(file, offset, v => onProgress((done + v) / files.length), signal); await appendFile(`${target}.part`, bytes); const complete = await readFile(`${target}.part`); if (expected !== "UNRESOLVED" && sha(complete) !== expected) { await rm(`${target}.part`, { force: true }); throw new Error(`模型文件校验失败: ${file}`); } await rename(`${target}.part`, target); done++; onProgress(done / files.length); }
      await this.stagingRuntime(staging, signal);
      const backup = `${active}.old`; await rm(backup, { recursive: true, force: true }); let hadActive = true; try { await rename(active, backup); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; hadActive = false; }
      try { await rename(staging, active); } catch (e) { if (hadActive) await rename(backup, active); throw e; }
      try { const result = await this.runtime(active, signal); await rm(backup, { recursive: true, force: true }); return result; } catch (e) {
        await rm(active, { recursive: true, force: true });
        if (hadActive) await rename(backup, active);
        throw e;
      }
    } catch (e) { await rm(staging, { recursive: true, force: true }); throw e; }
  }
}
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

type LoadingWaiter = { onProgress: DownloadProgress; signal: AbortSignal };
type LoadingOperation<T> = { controller: AbortController; waiters: Set<LoadingWaiter>; promise: Promise<T> };
