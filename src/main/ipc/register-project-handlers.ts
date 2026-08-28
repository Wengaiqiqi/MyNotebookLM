import type { IpcMain } from "electron";
import { z } from "zod";
import { PROJECT_CHANNELS } from "../../shared/ipc";
import {
  createProjectInputSchema,
  projectDtoSchema,
  projectIdInputSchema,
  renameProjectInputSchema
} from "../../shared/projects";
import type { ProjectService } from "../projects/project-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;
const undefinedSchema = z.undefined();

export function registerProjectHandlers(
  ipc: IpcMainLike,
  service: ProjectService
): () => void {
  ipc.handle(PROJECT_CHANNELS.list, (_event, input) => {
    undefinedSchema.parse(input);
    return projectDtoSchema.array().parse(service.list());
  });
  ipc.handle(PROJECT_CHANNELS.listArchived, (_event, input) => {
    undefinedSchema.parse(input);
    return projectDtoSchema.array().parse(service.listArchived());
  });
  ipc.handle(PROJECT_CHANNELS.listDeleteFailed, (_event, input) => {
    undefinedSchema.parse(input);
    return projectDtoSchema.array().parse(service.listDeleteFailed());
  });
  ipc.handle(PROJECT_CHANNELS.create, (_event, input) =>
    projectDtoSchema.parse(service.create(createProjectInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.rename, (_event, input) =>
    projectDtoSchema.parse(service.rename(renameProjectInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.archive, (_event, input) =>
    projectDtoSchema.parse(service.archive(projectIdInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.remove, (_event, input) =>
    projectDtoSchema.parse(service.remove(projectIdInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.restore, (_event, input) =>
    projectDtoSchema.parse(service.restore(projectIdInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.undo, (_event, input) =>
    projectDtoSchema.parse(service.undo(projectIdInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.retryDelete, (_event, input) =>
    projectDtoSchema.parse(service.retryDelete(projectIdInputSchema.parse(input)))
  );

  return () => {
    for (const channel of Object.values(PROJECT_CHANNELS)) ipc.removeHandler(channel);
  };
}
