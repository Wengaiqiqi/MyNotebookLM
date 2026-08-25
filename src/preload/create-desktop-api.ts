import { z } from "zod";
import { resultSchema } from "../shared/app-errors";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  PROJECT_CHANNELS,
  SETTINGS_CHANNELS,
  type DesktopApi
} from "../shared/ipc";
import {
  credentialInputSchema,
  credentialProfileInputSchema,
  credentialStatusDtoSchema,
  deleteModelProfileInputSchema,
  discoverModelsInputSchema,
  modelDescriptorSchema,
  modelProfileDtoSchema,
  modelProfileListDtoSchema,
  modelTestResultDtoSchema,
  saveModelProfileInputSchema,
  testModelInputSchema
} from "../shared/models";
import {
  createProjectInputSchema,
  projectDtoSchema,
  projectIdInputSchema,
  renameProjectInputSchema
} from "../shared/projects";
import {
  appSettingsDtoSchema,
  updateAppSettingsInputSchema
} from "../shared/settings";

type IpcInvoker = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
};

const removeProjectResponseSchema = z.undefined();
const settingsResultSchema = resultSchema(appSettingsDtoSchema);
const profileListResultSchema = resultSchema(modelProfileListDtoSchema);
const profileResultSchema = resultSchema(modelProfileDtoSchema);
const deleteProfileResultSchema = resultSchema(z.undefined());
const discoveryResultSchema = resultSchema(modelDescriptorSchema.array());
const modelTestResultSchema = resultSchema(modelTestResultDtoSchema);
const credentialResultSchema = resultSchema(credentialStatusDtoSchema);

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
    },
    settings: {
      get: async () => settingsResultSchema.parse(await ipc.invoke(SETTINGS_CHANNELS.get)),
      update: async (input) => settingsResultSchema.parse(
        await ipc.invoke(SETTINGS_CHANNELS.update, updateAppSettingsInputSchema.parse(input))
      )
    },
    models: {
      listProfiles: async () => profileListResultSchema.parse(
        await ipc.invoke(MODEL_CHANNELS.listProfiles)
      ),
      saveProfile: async (input) => profileResultSchema.parse(
        await ipc.invoke(MODEL_CHANNELS.saveProfile, saveModelProfileInputSchema.parse(input))
      ),
      deleteProfile: async (input) => deleteProfileResultSchema.parse(
        await ipc.invoke(MODEL_CHANNELS.deleteProfile, deleteModelProfileInputSchema.parse(input))
      ),
      discover: async (input) => discoveryResultSchema.parse(
        await ipc.invoke(MODEL_CHANNELS.discover, discoverModelsInputSchema.parse(input))
      ),
      test: async (input) => modelTestResultSchema.parse(
        await ipc.invoke(MODEL_CHANNELS.test, testModelInputSchema.parse(input))
      )
    },
    credentials: {
      set: async (input) => credentialResultSchema.parse(
        await ipc.invoke(CREDENTIAL_CHANNELS.set, credentialInputSchema.parse(input))
      ),
      remove: async (input) => credentialResultSchema.parse(
        await ipc.invoke(CREDENTIAL_CHANNELS.remove, credentialProfileInputSchema.parse(input))
      )
    }
  };
}
