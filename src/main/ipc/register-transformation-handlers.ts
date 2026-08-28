import type { IpcMain } from "electron";
import { z } from "zod";
import { internalFailure, resultSchema, validationFailure } from "../../shared/app-errors";
import { TRANSFORMATION_CHANNELS, transformationBuiltinInputSchema, transformationConvertInputSchema, transformationInsightsInputSchema, transformationRulesInputSchema, transformationTaskInputSchema } from "../../shared/ipc";
import { builtinTransformationDtoSchema, createTransformationInputSchema, insightDtoSchema, transformationDtoSchema, transformationRunInputSchema, updateTransformationInputSchema } from "../../shared/transformations";
import { taskDtoSchema, type TaskDto } from "../../shared/tasks";
import { noteDtoSchema } from "../../shared/notes";
import { listBuiltinTransformations } from "../notes/builtin-transformations";
import type { TransformationService, TransformationRunRequest } from "../notes/transformation-service";

type Ipc = Pick<IpcMain, "handle" | "removeHandler">;
type Service = {
  listRules(input: { projectId: string }): unknown;
  createRule(input: unknown): unknown;
  updateRule(input: unknown): unknown;
  deleteRule(input: { projectId: string; id: string; version: number }): unknown;
  startTask(input: TransformationRunRequest, signal: AbortSignal, onFinished: () => void, onOwnership: (ownership: { taskId: string; owned: boolean }) => void): TaskDto;
  cancelTask(input: { projectId: string; taskId: string }): unknown;
  retryTask(input: { projectId: string; taskId: string }, signal: AbortSignal, onFinished: () => void, onOwnership: (ownership: { taskId: string; owned: boolean }) => void): TaskDto;
  listInsights(input: { projectId: string; limit?: number; offset?: number }): unknown;
  convertToNote(input: { projectId: string; insightId: string }): unknown;
};

const empty = z.undefined();
const ruleList = resultSchema(transformationDtoSchema.array());
const rule = resultSchema(transformationDtoSchema);
const task = resultSchema(taskDtoSchema);
const insights = resultSchema(insightDtoSchema.array());
const note = resultSchema(noteDtoSchema);
const builtins = resultSchema(builtinTransformationDtoSchema.array());
const voidResult = resultSchema(empty);

function errorResult(reason: unknown): ReturnType<typeof internalFailure> {
  const name = reason instanceof Error ? reason.name : "";
  if (name.includes("VersionConflict") || name.includes("InProgress") || name.includes("StaleTask")) return { ok: false, error: { code: "CONFLICT", messageKey: "errors.conflict", recoverable: true } };
  if (name.includes("NotFound")) return { ok: false, error: { code: "NOT_FOUND", messageKey: "errors.notFound", recoverable: false } };
  return internalFailure();
}

async function safe<I>(schema: z.ZodType<I>, output: z.ZodType, raw: unknown, call: (value: I) => unknown): Promise<unknown> {
  const parsed = schema.safeParse(raw); if (!parsed.success) return validationFailure();
  try { const value = await call(parsed.data); const candidate = value && typeof value === "object" && "ok" in value ? value : { ok: true, value }; const result = output.safeParse(candidate); return result.success ? result.data : internalFailure(); } catch (reason) { return errorResult(reason); }
}

export function registerTransformationHandlers(ipc: Ipc, service: Service): () => void {
  const controllers = new Map<string, AbortController>();
  ipc.handle(TRANSFORMATION_CHANNELS.listRules, (_event, input) => safe(transformationRulesInputSchema, ruleList, input, service.listRules.bind(service)));
  ipc.handle(TRANSFORMATION_CHANNELS.createRule, (_event, input) => safe(createTransformationInputSchema, rule, input, service.createRule.bind(service)));
  ipc.handle(TRANSFORMATION_CHANNELS.updateRule, (_event, input) => safe(updateTransformationInputSchema, rule, input, service.updateRule.bind(service)));
  ipc.handle(TRANSFORMATION_CHANNELS.deleteRule, (_event, input) => safe(updateTransformationInputSchema.pick({ projectId: true, id: true, version: true }), voidResult, input, service.deleteRule.bind(service)));
  ipc.handle(TRANSFORMATION_CHANNELS.listBuiltins, (_event, input) => safe(transformationBuiltinInputSchema, builtins, input ?? {}, (value) => listBuiltinTransformations().filter((item) => !value.language || item.language === value.language)));
  ipc.handle(TRANSFORMATION_CHANNELS.run, (_event, input) => safe(transformationRunInputSchema, task, input, (value) => { const controller = new AbortController(); let created!: TaskDto; let ownershipNotified = false; const onFinished = () => { if (created && controllers.get(created.id) === controller) controllers.delete(created.id); }; const onOwnership = ({ taskId, owned }: { taskId: string; owned: boolean }) => { if (ownershipNotified) return; ownershipNotified = true; if (owned) controllers.set(taskId, controller); else controller.abort(); }; created = service.startTask(value as TransformationRunRequest, controller.signal, onFinished, onOwnership); return created; }));
  ipc.handle(TRANSFORMATION_CHANNELS.cancel, (_event, input) => safe(transformationTaskInputSchema, task, input, (value) => { const result = service.cancelTask(value); controllers.get(value.taskId)?.abort(); controllers.delete(value.taskId); return result; }));
  ipc.handle(TRANSFORMATION_CHANNELS.retry, (_event, input) => safe(transformationTaskInputSchema, task, input, (value) => { const controller = new AbortController(); let created!: TaskDto; let ownershipNotified = false; const onFinished = () => { if (created && controllers.get(created.id) === controller) controllers.delete(created.id); }; const onOwnership = ({ taskId, owned }: { taskId: string; owned: boolean }) => { if (ownershipNotified) return; ownershipNotified = true; if (owned) controllers.set(taskId, controller); else controller.abort(); }; created = service.retryTask(value, controller.signal, onFinished, onOwnership); return created; }));
  ipc.handle(TRANSFORMATION_CHANNELS.listInsights, (_event, input) => safe(transformationInsightsInputSchema, insights, input, (value) => service.listInsights(value as never)));
  ipc.handle(TRANSFORMATION_CHANNELS.convertToNote, (_event, input) => safe(transformationConvertInputSchema, note, input, service.convertToNote.bind(service)));
  const channels = Object.values(TRANSFORMATION_CHANNELS);
  return () => { for (const controller of controllers.values()) controller.abort(); controllers.clear(); channels.forEach((channel) => ipc.removeHandler(channel)); };
}
