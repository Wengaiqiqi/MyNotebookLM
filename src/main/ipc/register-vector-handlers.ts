import type { IpcMain } from "electron";
import { z } from "zod";
import { internalFailure, resultSchema, validationFailure, type Result } from "../../shared/app-errors";
import { RETRIEVAL_CHANNELS, VECTOR_CHANNELS } from "../../shared/ipc";
import { taskDtoSchema, type TaskDto } from "../../shared/tasks";
import { retrievalSearchInputSchema, searchHitSchema, vectorHealthSchema, vectorProfileInputSchema, vectorSpaceInputSchema, vectorTaskIdInputSchema, vectorTaskInputSchema } from "../../shared/vector";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;
type Service = {
  getHealth(input: z.infer<typeof vectorTaskInputSchema>): Promise<Result<z.infer<typeof vectorHealthSchema>>>;
  startMigration(input: z.infer<typeof vectorProfileInputSchema>): Promise<Result<TaskDto>>;
  rebuild(input: z.infer<typeof vectorSpaceInputSchema>): Promise<Result<TaskDto>>;
  optimize(input: z.infer<typeof vectorSpaceInputSchema>): Promise<Result<TaskDto>>;
  cancelTask(input: z.infer<typeof vectorTaskIdInputSchema>): Promise<Result<TaskDto>>;
  search(input: z.infer<typeof retrievalSearchInputSchema>): Promise<Result<z.infer<typeof searchHitSchema>[]>>;
};

async function validatedCall<I>(schema: z.ZodType<I>, output: z.ZodType, input: unknown, call: (value: I) => Promise<unknown>): Promise<unknown> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return validationFailure();
  try {
    const result = output.safeParse(await call(parsed.data));
    return result.success ? result.data : internalFailure();
  } catch {
    return internalFailure();
  }
}

export function registerVectorHandlers(ipc: IpcMainLike, service: Service): () => void {
  const healthResult = resultSchema(vectorHealthSchema);
  const taskResult = resultSchema(taskDtoSchema);
  const searchResult = resultSchema(searchHitSchema.array());
  ipc.handle(VECTOR_CHANNELS.getHealth, (_event, input) => validatedCall(vectorTaskInputSchema, healthResult, input, service.getHealth));
  ipc.handle(VECTOR_CHANNELS.startMigration, (_event, input) => validatedCall(vectorProfileInputSchema, taskResult, input, service.startMigration));
  ipc.handle(VECTOR_CHANNELS.rebuild, (_event, input) => validatedCall(vectorSpaceInputSchema, taskResult, input, service.rebuild));
  ipc.handle(VECTOR_CHANNELS.optimize, (_event, input) => validatedCall(vectorSpaceInputSchema, taskResult, input, service.optimize));
  ipc.handle(VECTOR_CHANNELS.cancelTask, (_event, input) => validatedCall(vectorTaskIdInputSchema, taskResult, input, service.cancelTask));
  ipc.handle(RETRIEVAL_CHANNELS.search, (_event, input) => validatedCall(retrievalSearchInputSchema, searchResult, input, service.search));
  const channels = [...Object.values(VECTOR_CHANNELS).filter(channel => channel !== VECTOR_CHANNELS.taskUpdate), ...Object.values(RETRIEVAL_CHANNELS)];
  return () => channels.forEach(channel => ipc.removeHandler(channel));
}
