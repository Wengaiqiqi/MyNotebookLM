import { randomUUID } from "node:crypto";
import * as electron from "electron";
import type { IpcMain } from "electron";
import { z } from "zod";
import { SOURCE_CHANNELS } from "../../shared/ipc";
import { sourceDtoSchema } from "../../shared/sources";
import { taskDtoSchema } from "../../shared/tasks";
import { internalFailure, validationFailure } from "../../shared/app-errors";

type Ipc = Pick<IpcMain, "handle" | "removeHandler">;
type Service = { listSources(projectId: string): unknown[]; listTasks(projectId: string): unknown[]; importFile: (x: { projectId: string; path: string }) => unknown; importUrl: (x: { projectId: string; url: string }) => unknown; removeSource: (x: { projectId: string; sourceId: string }) => unknown; retryTask: (x: { projectId: string; sourceId: string }) => unknown; cancelTask: (x: { projectId: string; taskId: string }) => unknown; ownsSource?(projectId: string, sourceId: string): boolean; ownsTask?(projectId: string, taskId: string): boolean; };
type Dialog = Pick<typeof electron.dialog, "showOpenDialog">;
const project = z.object({ projectId: z.uuid() }).strict();
const token = z.object({ projectId: z.uuid(), dialogToken: z.string().trim().min(1) }).strict();
const source = z.object({ projectId: z.uuid(), sourceId: z.uuid() }).strict();
const task = z.object({ projectId: z.uuid(), taskId: z.uuid() }).strict();
export function registerSourceHandlers(ipc: Ipc, service: Service, dialogs?: Dialog): () => void {
  const tokens = new Map<string, { projectId: string; path: string }>();
  const safe = async (schema: z.ZodType, call: (input: any) => unknown, input: unknown) => { const parsed = schema.safeParse(input); if (!parsed.success) return validationFailure(); try { const value = await call(parsed.data); return { ok: true as const, value }; } catch (error) { const code = (error as { code?: string }).code; if (code === "UNSAFE_INPUT" || code === "UNSUPPORTED_FORMAT" || code === "NETWORK" || code === "TIMEOUT") return { ok: false as const, error: { code, messageKey: code === "UNSAFE_INPUT" ? "errors.unsafeInput" : code === "UNSUPPORTED_FORMAT" ? "errors.unsupportedFormat" : code === "TIMEOUT" ? "errors.timeout" : "errors.network", recoverable: code === "NETWORK" || code === "TIMEOUT" } }; return internalFailure(); } };
  ipc.handle(SOURCE_CHANNELS.chooseFiles, async (_event, input) => { const parsed = project.safeParse(input); if (!parsed.success) return validationFailure<string[]>(); try { const picked = await (dialogs ?? electron.dialog).showOpenDialog({ properties: ["openFile", "multiSelections"] }); if (picked.canceled) return { ok: true as const, value: null }; return { ok: true as const, value: picked.filePaths.map((path) => { const dialogToken = randomUUID(); tokens.set(dialogToken, { projectId: parsed.data.projectId, path }); return dialogToken; }) }; } catch { return internalFailure<string[] | null>(); } });
  ipc.handle(SOURCE_CHANNELS.importFile, (_event, input) => safe(token, (value) => { const entry = tokens.get(value.dialogToken); if (!entry || entry.projectId !== value.projectId) return validationFailure(); tokens.delete(value.dialogToken); return service.importFile({ projectId: value.projectId, path: entry.path }); }, input));
  ipc.handle(SOURCE_CHANNELS.importUrl, (_event, input) => safe(z.object({ projectId: z.uuid(), url: z.url() }).strict(), (value) => service.importUrl(value), input));
  ipc.handle(SOURCE_CHANNELS.list, (_event, input) => safe(project, (value) => z.array(sourceDtoSchema).parse(service.listSources(value.projectId)), input));
  ipc.handle(SOURCE_CHANNELS.listTasks, (_event, input) => safe(project, (value) => z.array(taskDtoSchema).parse(service.listTasks(value.projectId)), input));
  ipc.handle(SOURCE_CHANNELS.remove, (_event, input) => safe(source, (value) => { if (service.ownsSource?.(value.projectId, value.sourceId) === false) throw new Error("source not owned by project"); return service.removeSource(value); }, input));
  ipc.handle(SOURCE_CHANNELS.retry, (_event, input) => safe(source, (value) => { if (service.ownsSource?.(value.projectId, value.sourceId) === false) throw new Error("source not owned by project"); return service.retryTask(value); }, input));
  ipc.handle(SOURCE_CHANNELS.cancel, (_event, input) => safe(task, (value) => { if (service.ownsTask?.(value.projectId, value.taskId) === false) throw new Error("task not owned by project"); return service.cancelTask(value); }, input));
  return () => { for (const channel of Object.values(SOURCE_CHANNELS)) if (channel !== SOURCE_CHANNELS.update) ipc.removeHandler(channel); tokens.clear(); };
}
