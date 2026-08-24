import type { IpcMain } from "electron";
import { PROJECT_CHANNELS } from "../../shared/ipc";
import {
  createProjectInputSchema,
  projectDtoSchema,
  projectIdInputSchema,
  renameProjectInputSchema
} from "../../shared/projects";
import type { ProjectService } from "../projects/project-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

export function registerProjectHandlers(
  ipc: IpcMainLike,
  service: ProjectService
): () => void {
  ipc.handle(PROJECT_CHANNELS.list, () => projectDtoSchema.array().parse(service.list()));
  ipc.handle(PROJECT_CHANNELS.create, (_event, input) =>
    projectDtoSchema.parse(service.create(createProjectInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.rename, (_event, input) =>
    projectDtoSchema.parse(service.rename(renameProjectInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.archive, (_event, input) =>
    projectDtoSchema.parse(service.archive(projectIdInputSchema.parse(input)))
  );
  ipc.handle(PROJECT_CHANNELS.remove, (_event, input) => {
    service.remove(projectIdInputSchema.parse(input));
  });

  return () => {
    for (const channel of Object.values(PROJECT_CHANNELS)) ipc.removeHandler(channel);
  };
}
