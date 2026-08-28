import type { IpcMain } from "electron";
import { z } from "zod";
import {
  internalFailure,
  resultSchema,
  validationFailure
} from "../../shared/app-errors";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  SETTINGS_CHANNELS,
  modelRoutesInputSchema,
  saveModelRoutesInputSchema,
  modelRouteAttemptsInputSchema
} from "../../shared/ipc";
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
  modelRouteDtoSchema,
  modelRouteAttemptDtoSchema,
  modelTestResultDtoSchema,
  saveModelProfileInputSchema,
  setDefaultModelRoutesInputSchema,
  testModelInputSchema
} from "../../shared/models";
import {
  appSettingsDtoSchema,
  updateAppSettingsInputSchema
} from "../../shared/settings";
import type { ModelService } from "../models/model-service";

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

const undefinedSchema = z.undefined();
const settingsResultSchema = resultSchema(appSettingsDtoSchema);
const profileListResultSchema = resultSchema(modelProfileListDtoSchema);
const defaultRoutesResultSchema = resultSchema(defaultModelRoutesDtoSchema);
const profileResultSchema = resultSchema(modelProfileDtoSchema);
const deleteResultSchema = resultSchema(undefinedSchema);
const discoveryResultSchema = resultSchema(modelDescriptorSchema.array());
const testResultSchema = resultSchema(modelTestResultDtoSchema);
const credentialResultSchema = resultSchema(credentialStatusDtoSchema);
const routeResultSchema = resultSchema(modelRouteDtoSchema.array());
const attemptsResultSchema = resultSchema(modelRouteAttemptDtoSchema.array());

async function validatedCall<I>(
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType,
  input: unknown,
  call: (parsed: I) => Promise<unknown>
): Promise<unknown> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return validationFailure();
  try {
    const output = outputSchema.safeParse(await call(parsed.data));
    return output.success ? output.data : internalFailure();
  } catch {
    return internalFailure();
  }
}

export function registerModelHandlers(
  ipc: IpcMainLike,
  service: ModelService
): () => void {
  ipc.handle(SETTINGS_CHANNELS.get, (_event, input) =>
    validatedCall(undefinedSchema, settingsResultSchema, input, () => service.getSettings())
  );
  ipc.handle(SETTINGS_CHANNELS.update, (_event, input) =>
    validatedCall(updateAppSettingsInputSchema, settingsResultSchema, input, (parsed) =>
      service.updateSettings(parsed)
    )
  );
  ipc.handle(MODEL_CHANNELS.listProfiles, (_event, input) =>
    validatedCall(undefinedSchema, profileListResultSchema, input, () => service.listProfiles())
  );
  ipc.handle(MODEL_CHANNELS.getDefaultRoutes, (_event, input) =>
    validatedCall(undefinedSchema, defaultRoutesResultSchema, input, () =>
      service.getDefaultRoutes()
    )
  );
  ipc.handle(MODEL_CHANNELS.setDefaultRoutes, (_event, input) =>
    validatedCall(setDefaultModelRoutesInputSchema, defaultRoutesResultSchema, input, (parsed) =>
      service.setDefaultRoutes(parsed)
    )
  );
  ipc.handle(MODEL_CHANNELS.saveProfile, (_event, input) =>
    validatedCall(saveModelProfileInputSchema, profileResultSchema, input, (parsed) =>
      service.saveProfile(parsed)
    )
  );
  ipc.handle(MODEL_CHANNELS.deleteProfile, (_event, input) =>
    validatedCall(deleteModelProfileInputSchema, deleteResultSchema, input, (parsed) =>
      service.deleteProfile(parsed)
    )
  );
  ipc.handle(MODEL_CHANNELS.discover, (_event, input) =>
    validatedCall(discoverModelsInputSchema, discoveryResultSchema, input, (parsed) =>
      service.discover(parsed)
    )
  );
  ipc.handle(MODEL_CHANNELS.test, (_event, input) =>
    validatedCall(testModelInputSchema, testResultSchema, input, (parsed) =>
      service.test(parsed)
    )
  );
  ipc.handle(MODEL_CHANNELS.getRoutes, (_event, input) =>
    validatedCall(modelRoutesInputSchema, routeResultSchema, input, (parsed) => service.getRoutes(parsed as never))
  );
  ipc.handle(MODEL_CHANNELS.saveRoutes, (_event, input) =>
    validatedCall(saveModelRoutesInputSchema, routeResultSchema, input, (parsed) => service.saveRoutes(parsed as never))
  );
  ipc.handle(MODEL_CHANNELS.listRouteAttempts, (_event, input) =>
    validatedCall(modelRouteAttemptsInputSchema, attemptsResultSchema, input, (parsed) => service.listRouteAttempts(parsed as never))
  );
  ipc.handle(CREDENTIAL_CHANNELS.set, (_event, input) =>
    validatedCall(credentialInputSchema, credentialResultSchema, input, (parsed) =>
      service.setCredential(parsed)
    )
  );
  ipc.handle(CREDENTIAL_CHANNELS.remove, (_event, input) =>
    validatedCall(credentialProfileInputSchema, credentialResultSchema, input, (parsed) =>
      service.removeCredential(parsed)
    )
  );

  const channels = [
    ...Object.values(SETTINGS_CHANNELS),
    ...Object.values(MODEL_CHANNELS),
    ...Object.values(CREDENTIAL_CHANNELS)
  ];
  return () => {
    for (const channel of channels) ipc.removeHandler(channel);
  };
}
