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
  RETRIEVAL_CHANNELS,
  CHAT_CHANNELS,
  CITATION_CHANNELS,
  type ChatRequestEvent,
  VECTOR_CHANNELS,
  type DesktopApi
} from "../shared/ipc";
import { SOURCE_CHANNELS } from "../shared/ipc";
import { conversationSchema, messageSchema } from "../shared/chat";
import {
  chatConversationInputSchema,
  chatCreateConversationInputSchema,
  chatListConversationsInputSchema,
  chatListMessagesInputSchema,
  chatRegenerateInputSchema,
  chatRequestIdInputSchema,
  chatRequestEventSchemas,
  chatOpenedResultValueSchema,
  chatRenameConversationInputSchema,
  chatSendInputSchema,
  chatSendResultValueSchema,
  chatStopInputSchema,
  citationOpenInputSchema
} from "../shared/ipc";
import { sourceDtoSchema } from "../shared/sources";
import { taskDtoSchema } from "../shared/tasks";
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
import { retrievalSearchInputSchema, searchHitSchema, vectorHealthSchema, vectorProfileInputSchema, vectorSpaceInputSchema, vectorTaskIdInputSchema, vectorTaskInputSchema } from "../shared/vector";

type IpcInvoker = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on?: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (channel: string, listener: (...args: unknown[]) => void) => void;
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
const chatRequestEventSchemaList = Object.values(chatRequestEventSchemas);
const chatRequestEventSchema = z.union(chatRequestEventSchemaList as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);

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
  const pendingSubscriptions = new Map<string, Promise<unknown>>();
  const awaitSubscription = async (requestId: string): Promise<void> => {
    await pendingSubscriptions.get(requestId);
  };
  return {
    vector: {
      getHealth: (input) => invokeResult(ipc, VECTOR_CHANNELS.getHealth, vectorTaskInputSchema, resultSchema(vectorHealthSchema), input),
      startMigration: (input) => invokeResult(ipc, VECTOR_CHANNELS.startMigration, vectorProfileInputSchema, resultSchema(taskDtoSchema), input),
      rebuild: (input) => invokeResult(ipc, VECTOR_CHANNELS.rebuild, vectorSpaceInputSchema, resultSchema(taskDtoSchema), input),
      optimize: (input) => invokeResult(ipc, VECTOR_CHANNELS.optimize, vectorSpaceInputSchema, resultSchema(taskDtoSchema), input),
      cancelTask: (input) => invokeResult(ipc, VECTOR_CHANNELS.cancelTask, vectorTaskIdInputSchema, resultSchema(taskDtoSchema), input),
      subscribe: (projectId, listener) => {
        const parsed = z.uuid().safeParse(projectId);
        if (!parsed.success) return () => undefined;
        const channel = SOURCE_CHANNELS.update + ":" + parsed.data;
        const handler = (_event: unknown, raw: unknown) => {
          const task = taskDtoSchema.safeParse(raw);
          if (task.success && task.data.projectId === parsed.data) listener(task.data);
        };
        ipc.on?.(channel, handler);
        return () => ipc.removeListener?.(channel, handler);
      }
    },
    retrieval: {
      search: (input) => invokeResult(ipc, RETRIEVAL_CHANNELS.search, retrievalSearchInputSchema, resultSchema(searchHitSchema.array()), input)
    },
    sources: {
      chooseFiles: async (input) => { const parsed = z.object({ projectId: z.uuid() }).strict().safeParse(input); if (!parsed.success) return null; const raw = await ipc.invoke(SOURCE_CHANNELS.chooseFiles, parsed.data); return raw === null ? null : z.string().array().parse(raw); },
      importFile: (input) => invokeResult(ipc, SOURCE_CHANNELS.importFile, z.object({ projectId: z.uuid(), dialogToken: z.string().min(1) }).strict(), resultSchema(sourceDtoSchema), input),
      importUrl: (input) => invokeResult(ipc, SOURCE_CHANNELS.importUrl, z.object({ projectId: z.uuid(), url: z.url() }).strict(), resultSchema(sourceDtoSchema), input),
      list: async (input) => sourceDtoSchema.array().parse(await ipc.invoke(SOURCE_CHANNELS.list, z.object({ projectId: z.uuid() }).strict().parse(input))),
      remove: (input) => invokeResult(ipc, SOURCE_CHANNELS.remove, z.object({ projectId: z.uuid(), sourceId: z.uuid() }).strict(), resultSchema(z.undefined()), input),
      retry: (input) => invokeResult(ipc, SOURCE_CHANNELS.retry, z.object({ projectId: z.uuid(), sourceId: z.uuid() }).strict(), resultSchema(taskDtoSchema), input)
    },
    tasks: {
      list: async (input) => taskDtoSchema.array().parse(await ipc.invoke(SOURCE_CHANNELS.listTasks, z.object({ projectId: z.uuid() }).strict().parse(input))),
      cancel: (input) => invokeResult(ipc, SOURCE_CHANNELS.cancel, z.object({ projectId: z.uuid(), taskId: z.uuid() }).strict(), resultSchema(taskDtoSchema), input),
      subscribe: (projectId, listener) => { const channel = SOURCE_CHANNELS.update + ":" + projectId; const handler = (_event: unknown, raw: unknown) => { const parsed = taskDtoSchema.safeParse(raw); if (parsed.success) listener(parsed.data); }; ipc.on?.(channel, handler); return () => ipc.removeListener?.(channel, handler); }
    },
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
    },
    conversations: {
      list: (input) => invokeResult(ipc, CHAT_CHANNELS.listConversations, chatListConversationsInputSchema, resultSchema(conversationSchema.array()), input),
      create: (input) => invokeResult(ipc, CHAT_CHANNELS.createConversation, chatCreateConversationInputSchema, resultSchema(conversationSchema), input),
      rename: (input) => invokeResult(ipc, CHAT_CHANNELS.rename, chatRenameConversationInputSchema, resultSchema(conversationSchema), input),
      archive: (input) => invokeResult(ipc, CHAT_CHANNELS.archive, chatConversationInputSchema, resultSchema(conversationSchema), input),
      delete: (input) => invokeResult(ipc, CHAT_CHANNELS.deleteConversation, chatConversationInputSchema, resultSchema(z.undefined()), input),
      listMessages: (input) => invokeResult(ipc, CHAT_CHANNELS.listMessages, chatListMessagesInputSchema, resultSchema(messageSchema.array()), input)
    },
    chat: {
      send: async (input) => {
        const parsed = chatSendInputSchema.safeParse(input);
        if (!parsed.success) return validationFailure();
        await awaitSubscription(parsed.data.requestId);
        return invokeResult(ipc, CHAT_CHANNELS.send, chatSendInputSchema, resultSchema(chatSendResultValueSchema), parsed.data);
      },
      stop: (input) => invokeResult(ipc, CHAT_CHANNELS.stop, chatStopInputSchema, resultSchema(z.boolean()), input),
      regenerate: async (input) => {
        const parsed = chatRegenerateInputSchema.safeParse(input);
        if (!parsed.success) return validationFailure();
        await awaitSubscription(parsed.data.requestId);
        return invokeResult(ipc, CHAT_CHANNELS.regenerate, chatRegenerateInputSchema, resultSchema(chatSendResultValueSchema), parsed.data);
      },
      subscribe: (requestId, listener) => {
        const parsed = z.uuid().safeParse(requestId);
        if (!parsed.success) return () => undefined;
        const channel = CHAT_CHANNELS.update + ":" + parsed.data;
        const handler = (_event: unknown, raw: unknown) => {
          const event = chatRequestEventSchema.safeParse(raw);
          // The main process is authoritative; the renderer re-validates defensively.
          if (event.success && (event.data as { requestId?: unknown }).requestId === parsed.data) listener(event.data as ChatRequestEvent);
        };
        ipc.on?.(channel, handler);
        // Main only fans out to windows registered here; register before streaming.
        const registration = Promise.resolve(ipc.invoke(CHAT_CHANNELS.subscribeRequest, { requestId: parsed.data })).catch(() => undefined);
        pendingSubscriptions.set(parsed.data, registration);
        return () => {
          ipc.removeListener?.(channel, handler);
          if (pendingSubscriptions.get(parsed.data) === registration) pendingSubscriptions.delete(parsed.data);
          void Promise.resolve(ipc.invoke(CHAT_CHANNELS.unsubscribeRequest, { requestId: parsed.data })).catch(() => undefined);
        };
      },
      unsubscribe: (requestId) => {
        const parsed = chatRequestIdInputSchema.safeParse({ requestId });
        if (!parsed.success) return;
        void ipc.invoke(CHAT_CHANNELS.unsubscribeRequest, parsed.data).catch(() => undefined);
      }
    },
    citations: {
      open: (input) => invokeResult(ipc, CITATION_CHANNELS.open, citationOpenInputSchema, resultSchema(chatOpenedResultValueSchema), input)
    }
  };
}
