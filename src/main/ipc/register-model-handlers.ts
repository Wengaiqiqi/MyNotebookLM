import type { IpcMain } from "electron";
import { z } from "zod";
import { resultSchema } from "../../shared/app-errors";
import {
  CREDENTIAL_CHANNELS,
  MODEL_CHANNELS,
  SETTINGS_CHANNELS
} from "../../shared/ipc";
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
const profileResultSchema = resultSchema(modelProfileDtoSchema);
const deleteResultSchema = resultSchema(undefinedSchema);
const discoveryResultSchema = resultSchema(modelDescriptorSchema.array());
const testResultSchema = resultSchema(modelTestResultDtoSchema);
const credentialResultSchema = resultSchema(credentialStatusDtoSchema);

export function registerModelHandlers(
  ipc: IpcMainLike,
  service: ModelService
): () => void {
  ipc.handle(SETTINGS_CHANNELS.get, async (_event, input) => {
    undefinedSchema.parse(input);
    return settingsResultSchema.parse(await service.getSettings());
  });
  ipc.handle(SETTINGS_CHANNELS.update, async (_event, input) =>
    settingsResultSchema.parse(
      await service.updateSettings(updateAppSettingsInputSchema.parse(input))
    )
  );
  ipc.handle(MODEL_CHANNELS.listProfiles, async (_event, input) => {
    undefinedSchema.parse(input);
    return profileListResultSchema.parse(await service.listProfiles());
  });
  ipc.handle(MODEL_CHANNELS.saveProfile, async (_event, input) =>
    profileResultSchema.parse(
      await service.saveProfile(saveModelProfileInputSchema.parse(input))
    )
  );
  ipc.handle(MODEL_CHANNELS.deleteProfile, async (_event, input) =>
    deleteResultSchema.parse(
      await service.deleteProfile(deleteModelProfileInputSchema.parse(input))
    )
  );
  ipc.handle(MODEL_CHANNELS.discover, async (_event, input) =>
    discoveryResultSchema.parse(
      await service.discover(discoverModelsInputSchema.parse(input))
    )
  );
  ipc.handle(MODEL_CHANNELS.test, async (_event, input) =>
    testResultSchema.parse(await service.test(testModelInputSchema.parse(input)))
  );
  ipc.handle(CREDENTIAL_CHANNELS.set, async (_event, input) =>
    credentialResultSchema.parse(
      await service.setCredential(credentialInputSchema.parse(input))
    )
  );
  ipc.handle(CREDENTIAL_CHANNELS.remove, async (_event, input) =>
    credentialResultSchema.parse(
      await service.removeCredential(credentialProfileInputSchema.parse(input))
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
