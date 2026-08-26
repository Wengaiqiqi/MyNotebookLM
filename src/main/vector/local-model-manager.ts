import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_MODEL_MANIFEST, type LocalModelManifest } from "./local-model-manifest";
export type ModelManifest = { modelId: string; revision: string; dimension: number; files: Readonly<Record<string, string>> };

export type DownloadProgress = (value: number) => void;
export type ModelDownloader = (file: string, offset: number, onProgress: DownloadProgress, signal: AbortSignal) => Promise<Uint8Array>;
export type ModelRuntime<T> = (directory: string, signal: AbortSignal) => Promise<T>;
export class OfflineModelError extends Error { constructor() { super("本地模型未安装，当前处于离线模式"); this.name = "OfflineModelError"; } }

export class LocalModelManager<T = unknown> {
  private loading: Promise<T> | undefined;
  constructor(private readonly root: string, private readonly downloader: ModelDownloader, private readonly runtime: ModelRuntime<T>, private readonly manifest: ModelManifest = LOCAL_MODEL_MANIFEST) {}
  private activeDir() { return path.join(this.root, `${this.manifest.modelId.replaceAll("/", "__")}-${this.manifest.revision}`); }
  async ensureReady(offline = false, onProgress: DownloadProgress = () => {}, signal = new AbortController().signal): Promise<T> {
    if (this.loading) return this.loading;
    this.loading = this.load(offline, onProgress, signal).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async load(offline: boolean, onProgress: DownloadProgress, signal: AbortSignal): Promise<T> {
    const active = this.activeDir(); await mkdir(this.root, { recursive: true });
    try { for (const [file, hash] of Object.entries(this.manifest.files)) { const bytes = await readFile(path.join(active, file)); if (hash !== "UNRESOLVED" && sha(bytes) !== hash) throw new Error(`模型文件校验失败: ${file}`); } return this.runtime(active, signal); }
    catch (e) { if (offline) throw new OfflineModelError(); }
    const staging = `${active}.partial`; await mkdir(staging, { recursive: true });
    try { let done = 0; const files = Object.entries(this.manifest.files); for (const [file, expected] of files) { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); const target = path.join(staging, file); await mkdir(path.dirname(target), { recursive: true }); let offset = 0; try { offset = (await stat(`${target}.part`)).size; } catch {} const bytes = await this.downloader(file, offset, v => onProgress((done + v) / files.length), signal); if (expected !== "UNRESOLVED" && sha(bytes) !== expected) { await rm(`${target}.part`, { force: true }); throw new Error(`模型文件校验失败: ${file}`); } await writeFile(`${target}.part`, bytes); await rename(`${target}.part`, target); done++; onProgress(done / files.length); } await rm(active, { recursive: true, force: true }); await rename(staging, active); return this.runtime(active, signal); } catch (e) { await rm(staging, { recursive: true, force: true }); throw e; }
  }
}
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
