import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, appendFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_MODEL_ID, LOCAL_MODEL_MANIFEST, LOCAL_MODEL_REVISION, type LocalModelManifest } from "./local-model-manifest";
export type ModelManifest = { modelId: string; revision: string; dimension: number; files: Readonly<Record<string, string>> };

export type DownloadProgress = (value: number) => void;
export type ModelDownloader = (file: string, offset: number, onProgress: DownloadProgress, signal: AbortSignal) => Promise<Uint8Array>;
export type ModelRuntime<T> = (directory: string, signal: AbortSignal) => Promise<T>;
export function managedActiveDirectory(root: string, manifest: Pick<ModelManifest, "modelId" | "revision">): string { return path.join(path.resolve(root), `${manifest.modelId.replaceAll("/", "__")}-${manifest.revision}`); }
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
export function createLocalModelManager<T>(root: string, runtime: ModelRuntime<T>, fetcher: typeof fetch = fetch) {
  return new LocalModelManager(root, createLocalModelDownloader(fetcher), runtime);
}
export class OfflineModelError extends Error { constructor() { super("本地模型未安装，当前处于离线模式"); this.name = "OfflineModelError"; } }

export class LocalModelManager<T = unknown> {
  private loading: Promise<T> | undefined;
  constructor(private readonly root: string, private readonly downloader: ModelDownloader, private readonly runtime: ModelRuntime<T>, private readonly manifest: ModelManifest = LOCAL_MODEL_MANIFEST) {}
  private activeDir() { return managedActiveDirectory(this.root, this.manifest); }
  async ensureReady(offline = false, onProgress: DownloadProgress = () => {}, signal = new AbortController().signal): Promise<T> {
    if (this.loading) return this.loading;
    this.loading = this.load(offline, onProgress, signal).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async load(offline: boolean, onProgress: DownloadProgress, signal: AbortSignal): Promise<T> {
    const active = this.activeDir(); await mkdir(this.root, { recursive: true });
    let missing = false;
    try { for (const [file, hash] of Object.entries(this.manifest.files)) { const bytes = await readFile(path.join(active, file)); if (hash === "UNRESOLVED" || sha(bytes) !== hash) throw new Error(`模型文件校验失败: ${file}`); } return this.runtime(active, signal); }
    catch (e) { missing = (e as NodeJS.ErrnoException).code === "ENOENT"; if (offline) throw missing ? new OfflineModelError() : e; }
    const staging = `${active}.partial`; await mkdir(staging, { recursive: true });
    try { let done = 0; const files = Object.entries(this.manifest.files); for (const [file, expected] of files) { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); const target = path.join(staging, file); await mkdir(path.dirname(target), { recursive: true }); let offset = 0; try { offset = (await stat(`${target}.part`)).size; } catch {} const bytes = await this.downloader(file, offset, v => onProgress((done + v) / files.length), signal); await appendFile(`${target}.part`, bytes); const complete = await readFile(`${target}.part`); if (expected !== "UNRESOLVED" && sha(complete) !== expected) { await rm(`${target}.part`, { force: true }); throw new Error(`模型文件校验失败: ${file}`); } await rename(`${target}.part`, target); done++; onProgress(done / files.length); }
      await this.runtime(staging, signal);
      const backup = `${active}.old`; await rm(backup, { recursive: true, force: true }); let hadActive = true; try { await rename(active, backup); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; hadActive = false; }
      try { await rename(staging, active); } catch (e) { if (hadActive) await rename(backup, active); throw e; }
      try { const result = await this.runtime(active, signal); await rm(backup, { recursive: true, force: true }); return result; } catch (e) { if (hadActive) { await rm(active, { recursive: true, force: true }); await rename(backup, active); } throw e; }
    } catch (e) { await rm(staging, { recursive: true, force: true }); throw e; }
  }
}
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
