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
  NOTE_CHANNELS,
  TRANSFORMATION_CHANNELS,
  modelRoutesInputSchema,
  saveModelRoutesInputSchema,
  modelRouteAttemptsInputSchema,
  noteListInputSchema,
  transformationRulesInputSchema,
  transformationBuiltinInputSchema,
  transformationInsightsInputSchema,
  transformationTaskInputSchema,
  transformationConvertInputSchema,
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
  citationOpenInputSchema,
  citationDetailResultValueSchema
} from "../shared/ipc";
import { sourceDtoSchema } from "../shared/sources";
import { createNoteInputSchema, createNoteLinkInputSchema, deleteNoteLinkInputSchema, generateNoteTitleInputSchema, noteDtoSchema, noteIdInputSchema, noteLinkDtoSchema, noteStateInputSchema, updateNoteInputSchema } from "../shared/notes";
import { builtinTransformationDtoSchema, createTransformationInputSchema, insightDtoSchema, transformationDtoSchema, transformationRunInputSchema, updateTransformationInputSchema } from "../shared/transformations";
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
  modelRouteDtoSchema,
  modelRouteAttemptDtoSchema,
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

const settingsResultSchema = resultSchema(appSettingsDtoSchema);
const profileListResultSchema = resultSchema(modelProfileListDtoSchema);
const defaultRoutesResultSchema = resultSchema(defaultModelRoutesDtoSchema);
const profileResultSchema = resultSchema(modelProfileDtoSchema);
const deleteProfileResultSchema = resultSchema(z.undefined());
const discoveryResultSchema = resultSchema(modelDescriptorSchema.array());
const modelTestResultSchema = resultSchema(modelTestResultDtoSchema);
const credentialResultSchema = resultSchema(credentialStatusDtoSchema);
const modelRoutesResultSchema = resultSchema(modelRouteDtoSchema.array());
const modelAttemptsResultSchema = resultSchema(modelRouteAttemptDtoSchema.array());
const noteResultSchema = resultSchema(noteDtoSchema);
const nullableNoteResultSchema = resultSchema(noteDtoSchema.nullable());
const notesResultSchema = resultSchema(noteDtoSchema.array());
const noteLinkResultSchema = resultSchema(noteLinkDtoSchema);
const noteLinksResultSchema = resultSchema(noteLinkDtoSchema.array());
const transformationResultSchema = resultSchema(transformationDtoSchema);
const transformationsResultSchema = resultSchema(transformationDtoSchema.array());
const builtinResultSchema = resultSchema(builtinTransformationDtoSchema.array());
const insightResultSchema = resultSchema(insightDtoSchema.array());
const transformationTaskResultSchema = resultSchema(taskDtoSchema);
const voidResultSchema = resultSchema(z.undefined());
const titleOverlayInputSchema = z.object({ theme: appThemeSchema }).strict();
const titleOverlayResultSchema = resultSchema(z.undefined());
const chatRequestEventSchemaList = Object.values(chatRequestEventSchemas);
const chatRequestEventSchema = z.union(chatRequestEventSchemaList as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
const projectResponse = (raw: unknown) => projectDtoSchema.parse(raw && typeof raw === "object" && "ok" in raw && (raw as { ok?: unknown }).ok === true && "value" in raw ? (raw as { value: unknown }).value : raw);
const unwrapResult = (raw: unknown) => raw && typeof raw === "object" && "ok" in raw && (raw as { ok?: unknown }).ok === true && "value" in raw ? (raw as { value: unknown }).value : raw;

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
      chooseFiles: async (input) => { const parsed = z.object({ projectId: z.uuid() }).strict().safeParse(input); if (!parsed.success) return null; const raw = await ipc.invoke(SOURCE_CHANNELS.chooseFiles, parsed.data); const unwrapped = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw; return unwrapped === null || unwrapped === undefined ? null : z.string().array().parse(unwrapped); },
      importFile: (input) => invokeResult(ipc, SOURCE_CHANNELS.importFile, z.object({ projectId: z.uuid(), dialogToken: z.string().min(1) }).strict(), resultSchema(sourceDtoSchema), input),
      importUrl: (input) => invokeResult(ipc, SOURCE_CHANNELS.importUrl, z.object({ projectId: z.uuid(), url: z.url() }).strict(), resultSchema(sourceDtoSchema), input),
      list: async (input) => sourceDtoSchema.array().parse(unwrapResult(await ipc.invoke(SOURCE_CHANNELS.list, z.object({ projectId: z.uuid() }).strict().parse(input)))),
      open: (input) => invokeResult(ipc, SOURCE_CHANNELS.open, z.object({ projectId: z.uuid(), sourceId: z.uuid() }).strict(), resultSchema(chatOpenedResultValueSchema), input),
      remove: (input) => invokeResult(ipc, SOURCE_CHANNELS.remove, z.object({ projectId: z.uuid(), sourceId: z.uuid() }).strict(), resultSchema(z.undefined()), input),
      retry: (input) => invokeResult(ipc, SOURCE_CHANNELS.retry, z.object({ projectId: z.uuid(), sourceId: z.uuid() }).strict(), resultSchema(taskDtoSchema), input)
    },
    tasks: {
      list: async (input) => taskDtoSchema.array().parse(unwrapResult(await ipc.invoke(SOURCE_CHANNELS.listTasks, z.object({ projectId: z.uuid() }).strict().parse(input)))),
      cancel: (input) => invokeResult(ipc, SOURCE_CHANNELS.cancel, z.object({ projectId: z.uuid(), taskId: z.uuid() }).strict(), resultSchema(taskDtoSchema), input),
      subscribe: (projectId, listener) => { const parsedProject = z.uuid().safeParse(projectId); if (!parsedProject.success) return () => undefined; const channel = SOURCE_CHANNELS.update + ":" + parsedProject.data; const handler = (_event: unknown, raw: unknown) => { const parsed = taskDtoSchema.safeParse(raw); if (parsed.success && parsed.data.projectId === parsedProject.data) listener(parsed.data); }; ipc.on?.(channel, handler); return () => ipc.removeListener?.(channel, handler); }
    },
    projects: {
      list: async () => projectDtoSchema.array().parse(await ipc.invoke(PROJECT_CHANNELS.list)),
      listArchived: async () => projectDtoSchema.array().parse(await ipc.invoke(PROJECT_CHANNELS.listArchived)),
      listDeleteFailed: async () => projectDtoSchema.array().parse(await ipc.invoke(PROJECT_CHANNELS.listDeleteFailed)),
      create: async (input) =>
        projectDtoSchema.parse(await ipc.invoke(PROJECT_CHANNELS.create, createProjectInputSchema.parse(input))),
      rename: async (input) =>
        projectDtoSchema.parse(await ipc.invoke(PROJECT_CHANNELS.rename, renameProjectInputSchema.parse(input))),
      archive: async (input) =>
        projectDtoSchema.parse(await ipc.invoke(PROJECT_CHANNELS.archive, projectIdInputSchema.parse(input))),
      remove: async (input) => projectResponse(await ipc.invoke(PROJECT_CHANNELS.remove, projectIdInputSchema.parse(input))),
      restore: async (input) => projectResponse(await ipc.invoke(PROJECT_CHANNELS.restore, projectIdInputSchema.parse(input))),
      undo: async (input) => projectResponse(await ipc.invoke(PROJECT_CHANNELS.undo, projectIdInputSchema.parse(input))),
      retryDelete: async (input) => projectResponse(await ipc.invoke(PROJECT_CHANNELS.retryDelete, projectIdInputSchema.parse(input)))
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
      ),
      getRoutes: (input) => invokeResult(ipc, MODEL_CHANNELS.getRoutes, modelRoutesInputSchema, modelRoutesResultSchema, input),
      saveRoutes: (input) => invokeResult(ipc, MODEL_CHANNELS.saveRoutes, saveModelRoutesInputSchema, modelRoutesResultSchema, input),
      listRouteAttempts: (input) => invokeResult(ipc, MODEL_CHANNELS.listRouteAttempts, modelRouteAttemptsInputSchema, modelAttemptsResultSchema, input)
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
      open: (input) => invokeResult(ipc, CITATION_CHANNELS.open, citationOpenInputSchema, resultSchema(chatOpenedResultValueSchema), input),
      detail: (input) => invokeResult(ipc, CITATION_CHANNELS.detail, citationOpenInputSchema, resultSchema(citationDetailResultValueSchema), input)
    },
    notes: {
      create: (input) => invokeResult(ipc, NOTE_CHANNELS.create, createNoteInputSchema, noteResultSchema, input),
      get: (input) => invokeResult(ipc, NOTE_CHANNELS.get, noteIdInputSchema, nullableNoteResultSchema, input),
      list: (input) => invokeResult(ipc, NOTE_CHANNELS.list, noteListInputSchema, notesResultSchema, input),
      update: (input) => invokeResult(ipc, NOTE_CHANNELS.update, updateNoteInputSchema, noteResultSchema, input),
      archive: (input) => invokeResult(ipc, NOTE_CHANNELS.archive, noteStateInputSchema, noteResultSchema, input),
      restore: (input) => invokeResult(ipc, NOTE_CHANNELS.restore, noteStateInputSchema, noteResultSchema, input),
      delete: (input) => invokeResult(ipc, NOTE_CHANNELS.delete, noteStateInputSchema, voidResultSchema, input),
      createLink: (input) => invokeResult(ipc, NOTE_CHANNELS.createLink, createNoteLinkInputSchema, noteLinkResultSchema, input),
      listLinks: (input) => invokeResult(ipc, NOTE_CHANNELS.listLinks, noteIdInputSchema, noteLinksResultSchema, input),
      deleteLink: (input) => invokeResult(ipc, NOTE_CHANNELS.deleteLink, deleteNoteLinkInputSchema, voidResultSchema, input),
      generateTitle: (input) => invokeResult(ipc, NOTE_CHANNELS.generateTitle, generateNoteTitleInputSchema, noteResultSchema, input)
    },
    transformations: {
      listRules: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.listRules, transformationRulesInputSchema, transformationsResultSchema, input),
      createRule: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.createRule, createTransformationInputSchema, transformationResultSchema, input),
      updateRule: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.updateRule, updateTransformationInputSchema, transformationResultSchema, input),
      deleteRule: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.deleteRule, updateTransformationInputSchema.pick({ projectId: true, id: true, version: true }), voidResultSchema, input),
      listBuiltins: (input = {}) => invokeResult(ipc, TRANSFORMATION_CHANNELS.listBuiltins, transformationBuiltinInputSchema, builtinResultSchema, input),
      run: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.run, transformationRunInputSchema, transformationTaskResultSchema, input),
      cancel: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.cancel, transformationTaskInputSchema, transformationTaskResultSchema, input),
      retry: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.retry, transformationTaskInputSchema, transformationTaskResultSchema, input),
      listInsights: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.listInsights, transformationInsightsInputSchema, insightResultSchema, input),
      convertToNote: (input) => invokeResult(ipc, TRANSFORMATION_CHANNELS.convertToNote, transformationConvertInputSchema, noteResultSchema, input)
    }
  };
}
