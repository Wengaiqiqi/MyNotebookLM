import { z } from "zod";
import {
  internalFailure,
  resultSchema,
  validationFailure,
  type Result
} from "../shared/app-errors";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  PROJECT_CHANNELS,
  SETTINGS_CHANNELS,
  TITLE_OVERLAY_CHANNELS,
  type DesktopApi
} from "../shared/ipc";
import {
  credentialInputSchema,
  credentialProfileInputSchema,
  credentialStatusDtoSchema,
  defaultModelRoutesDtoSchema,
  deleteModelProfileInputSchema,
  discoverModelsInputSchema,
  modelDescriptorSchema,
  modelProfileDtoSchema,
  modelProfileListDtoSchema,
  modelTestResultDtoSchema,
  saveModelProfileInputSchema,
  setDefaultModelRoutesInputSchema,
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
  appThemeSchema,
  updateAppSettingsInputSchema
} from "../shared/settings";

type IpcInvoker = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
};

const removeProjectResponseSchema = z.undefined();
const settingsResultSchema = resultSchema(appSettingsDtoSchema);
const profileListResultSchema = resultSchema(modelProfileListDtoSchema);
const defaultRoutesResultSchema = resultSchema(defaultModelRoutesDtoSchema);
const profileResultSchema = resultSchema(modelProfileDtoSchema);
const deleteProfileResultSchema = resultSchema(z.undefined());
const discoveryResultSchema = resultSchema(modelDescriptorSchema.array());
const modelTestResultSchema = resultSchema(modelTestResultDtoSchema);
const credentialResultSchema = resultSchema(credentialStatusDtoSchema);
const titleOverlayInputSchema = z.object({ theme: appThemeSchema }).strict();
const titleOverlayResultSchema = resultSchema(z.undefined());

async function invokeResult<I, O>(
  ipc: IpcInvoker,
  channel: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<Result<O>>,
  input?: unknown
): Promise<Result<O>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return validationFailure();
  try {
    const raw = parsed.data === undefined
      ? await ipc.invoke(channel)
      : await ipc.invoke(channel, parsed.data);
    const output = outputSchema.safeParse(raw);
    return output.success ? output.data : internalFailure();
  } catch {
    return internalFailure();
  }
}

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
      get: () => invokeResult(ipc, SETTINGS_CHANNELS.get, z.undefined(), settingsResultSchema),
      update: (input) => invokeResult(
        ipc,
        SETTINGS_CHANNELS.update,
        updateAppSettingsInputSchema,
        settingsResultSchema,
        input
      )
    },
    models: {
      listProfiles: () => invokeResult(
        ipc,
        MODEL_CHANNELS.listProfiles,
        z.undefined(),
        profileListResultSchema
      ),
      getDefaultRoutes: () => invokeResult(
        ipc,
        MODEL_CHANNELS.getDefaultRoutes,
        z.undefined(),
        defaultRoutesResultSchema
      ),
      setDefaultRoutes: (input) => invokeResult(
        ipc,
        MODEL_CHANNELS.setDefaultRoutes,
        setDefaultModelRoutesInputSchema,
        defaultRoutesResultSchema,
        input
      ),
      saveProfile: (input) => invokeResult(
        ipc,
        MODEL_CHANNELS.saveProfile,
        saveModelProfileInputSchema,
        profileResultSchema,
        input
      ),
      deleteProfile: (input) => invokeResult(
        ipc,
        MODEL_CHANNELS.deleteProfile,
        deleteModelProfileInputSchema,
        deleteProfileResultSchema,
        input
      ),
      discover: (input) => invokeResult(
        ipc,
        MODEL_CHANNELS.discover,
        discoverModelsInputSchema,
        discoveryResultSchema,
        input
      ),
      test: (input) => invokeResult(
        ipc,
        MODEL_CHANNELS.test,
        testModelInputSchema,
        modelTestResultSchema,
        input
      )
    },
    credentials: {
      set: (input) => invokeResult(
        ipc,
        CREDENTIAL_CHANNELS.set,
        credentialInputSchema,
        credentialResultSchema,
        input
      ),
      remove: (input) => invokeResult(
        ipc,
        CREDENTIAL_CHANNELS.remove,
        credentialProfileInputSchema,
        credentialResultSchema,
        input
      )
    },
    titleOverlay: {
      setTheme: (input) => invokeResult(
        ipc,
        TITLE_OVERLAY_CHANNELS.setTheme,
        titleOverlayInputSchema,
        titleOverlayResultSchema,
        input
      )
    }
  };
}
