import { z } from "zod";
import { PROJECT_CHANNELS, type DesktopApi } from "../shared/ipc";
import {
  createProjectInputSchema,
  projectDtoSchema,
  projectIdInputSchema,
  renameProjectInputSchema
} from "../shared/projects";

type IpcInvoker = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
};

const removeProjectResponseSchema = z.undefined();

export function createDesktopApi(ipc: IpcInvoker): DesktopApi {
  return {
    projects: {
      list: async () => projectDtoSchema.array().parse(await ipc.invoke(PROJECT_CHANNELS.list)),
      create: async (input) =>
        projectDtoSchema.parse(await ipc.invoke(PROJECT_CHANNELS.create, createProjectInputSchema.parse(input))),
      rename: async (input) =>
        projectDtoSchema.parse(await ipc.invoke(PROJECT_CHANNELS.rename, renameProjectInputSchema.parse(input))),
      archive: async (input) =>
        projectDtoSchema.parse(await ipc.invoke(PROJECT_CHANNELS.archive, projectIdInputSchema.parse(input))),
      remove: async (input) => {
        removeProjectResponseSchema.parse(await ipc.invoke(PROJECT_CHANNELS.remove, projectIdInputSchema.parse(input)));
      }
    }
  };
}
