import { z } from "zod";
import { conversationSchema, messageSchema } from "./chat";
import type { ConversationDto, MessageDto } from "./chat";
import type { CreateProjectInput, ProjectDto, ProjectIdInput, RenameProjectInput } from "./projects";
import type { Result } from "./app-errors";
import type {
  CredentialInput,
  CredentialProfileInput,
  CredentialStatusDto,
  DefaultModelRoutesDto,
  DeleteModelProfileInput,
  DiscoverModelsInput,
  ModelDescriptorDto,
  ModelProfileDto,
  ModelProfileListDto,
  ModelTestResultDto,
  SaveModelProfileInput,
  SetDefaultModelRoutesInput,
  TestModelInput
} from "./models";
import type { AppSettingsDto, UpdateAppSettingsInput } from "./settings";
import type { AppTheme } from "./settings";
import type { SourceDto } from "./sources";
import type { TaskDto } from "./tasks";
import type { RetrievalSearchInput, SearchHitDto, VectorHealthDto, VectorProfileInput, VectorSpaceInput, VectorTaskIdInput, VectorTaskInput } from "./vector";

export const SOURCE_CHANNELS = { chooseFiles: "sources:v1:choose-files", importFile: "sources:v1:import-file", importUrl: "sources:v1:import-url", list: "sources:v1:list", remove: "sources:v1:remove", retry: "sources:v1:retry", cancel: "tasks:v1:cancel", listTasks: "tasks:v1:list", subscribe: "tasks:v1:subscribe", update: "tasks:v1:update" } as const;

export const PROJECT_CHANNELS = {
  list: "projects:list",
  create: "projects:create",
  rename: "projects:rename",
  archive: "projects:archive",
  remove: "projects:remove"
} as const;

export const SETTINGS_CHANNELS = {
  get: "settings:v1:get",
  update: "settings:v1:update"
} as const;

export const MODEL_CHANNELS = {
  listProfiles: "models:v1:list-profiles",
  getDefaultRoutes: "models:v1:get-default-routes",
  setDefaultRoutes: "models:v1:set-default-routes",
  saveProfile: "models:v1:save-profile",
  deleteProfile: "models:v1:delete-profile",
  discover: "models:v1:discover",
  test: "models:v1:test"
} as const;

export const CREDENTIAL_CHANNELS = {
  set: "credentials:v1:set",
  remove: "credentials:v1:remove"
} as const;

export const TITLE_OVERLAY_CHANNELS = {
  setTheme: "window:v1:set-title-overlay"
} as const;
export const VECTOR_CHANNELS = { getHealth: "vector:v1:get-health", startMigration: "vector:v1:start-migration", rebuild: "vector:v1:rebuild", optimize: "vector:v1:optimize", cancelTask: "vector:v1:cancel-task", taskUpdate: "vector:v1:task-update" } as const;
export const RETRIEVAL_CHANNELS = { search: "retrieval:v1:search" } as const;

export const CHAT_CHANNELS = {
  listConversations: "chat:v1:list-conversations",
  createConversation: "chat:v1:create-conversation",
  rename: "chat:v1:rename-conversation",
  archive: "chat:v1:archive-conversation",
  deleteConversation: "chat:v1:delete-conversation",
  listMessages: "chat:v1:list-messages",
  send: "chat:v1:send",
  stop: "chat:v1:stop",
  regenerate: "chat:v1:regenerate",
  subscribeRequest: "chat:v1:subscribe-request",
  unsubscribeRequest: "chat:v1:unsubscribe-request",
  update: "chat:v1:update"
} as const;

export const CITATION_CHANNELS = { open: "citations:v1:open" } as const;

const chatUsageDtoSchema = z
  .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() })
  .strict();

const chatProjectSchema = z.object({ projectId: z.uuid() }).strict();
const chatTitleSchema = z.string().trim().min(1).max(200);

export const chatListConversationsInputSchema = chatProjectSchema;
export const chatCreateConversationInputSchema = z.object({ projectId: z.uuid(), title: chatTitleSchema }).strict();
export const chatRenameConversationInputSchema = z.object({ projectId: z.uuid(), conversationId: z.uuid(), title: chatTitleSchema }).strict();
export const chatConversationInputSchema = z.object({ projectId: z.uuid(), conversationId: z.uuid() }).strict();
export const chatListMessagesInputSchema = z.object({ projectId: z.uuid(), conversationId: z.uuid() }).strict();
export const chatSendInputSchema = z.object({ projectId: z.uuid(), conversationId: z.uuid(), question: z.string().trim().min(1).max(20_000) }).strict();
export const chatStopInputSchema = z.object({ projectId: z.uuid(), requestId: z.uuid() }).strict();
export const chatRegenerateInputSchema = z.object({ projectId: z.uuid(), conversationId: z.uuid(), messageId: z.string().min(1).max(128) }).strict();
export const chatRequestIdInputSchema = z.object({ requestId: z.uuid() }).strict();
export const citationOpenInputSchema = z.object({ projectId: z.uuid(), citationId: z.string().trim().min(1).max(256) }).strict();

export const chatSendResultValueSchema = z.object({ requestId: z.string(), assistantMessageId: z.string() }).strict();
export type ChatSendResultValue = z.infer<typeof chatSendResultValueSchema>;
export const chatOpenedResultValueSchema = z.object({ opened: z.enum(["document", "url"]) }).strict();

/**
 * Renderer-facing stream events keyed by opaque requestId. retrieved/fallback are
 * part of the frozen contract for upcoming routing work; the service simply does
 * not emit them yet.
 */
export const chatRequestEventSchemas = {
  started: z.object({ type: z.literal("started"), requestId: z.uuid(), messageId: z.string().min(1) }),
  retrieval: z.object({ type: z.literal("retrieval"), requestId: z.uuid() }),
  "text-delta": z.object({ type: z.literal("text-delta"), requestId: z.uuid(), messageId: z.string().min(1), text: z.string() }),
  usage: z.object({ type: z.literal("usage"), requestId: z.uuid(), usage: chatUsageDtoSchema }),
  fallback: z.object({
    type: z.literal("fallback"),
    requestId: z.uuid(),
    attempted: z.object({ provider: z.string(), model: z.string(), profileId: z.string().nullable() }).strict(),
    next: z.object({ provider: z.string(), model: z.string(), profileId: z.string().nullable() }).strict(),
    errorCode: z.string()
  }),
  completed: z.object({ type: z.literal("completed"), requestId: z.uuid(), messageId: z.string().min(1), message: messageSchema }),
  cancelled: z.object({ type: z.literal("cancelled"), requestId: z.uuid(), messageId: z.string().min(1), message: messageSchema }),
  failed: z.object({
    type: z.literal("failed"),
    requestId: z.uuid(),
    messageId: z.string().min(1),
    error: z.object({ code: z.string(), messageKey: z.string(), recoverable: z.boolean() })
  })
} as const;

export const chatRequestEventTypeSchema = z.enum(Object.keys(chatRequestEventSchemas) as [(keyof typeof chatRequestEventSchemas), ...(keyof typeof chatRequestEventSchemas)[]]);
export type ChatRequestEventType = keyof typeof chatRequestEventSchemas;
export type ChatRequestEvent =
  | { type: "started"; requestId: string; messageId: string }
  | { type: "retrieval"; requestId: string }
  | { type: "text-delta"; requestId: string; messageId: string; text: string }
  | { type: "usage"; requestId: string; usage: z.infer<typeof chatUsageDtoSchema> }
  | { type: "fallback"; requestId: string; attempted: { provider: string; model: string; profileId: string | null }; next: { provider: string; model: string; profileId: string | null }; errorCode: string }
  | { type: "completed"; requestId: string; messageId: string; message: MessageDto }
  | { type: "cancelled"; requestId: string; messageId: string; message: MessageDto }
  | { type: "failed"; requestId: string; messageId: string; error: { code: string; messageKey: string; recoverable: boolean } };

export interface DesktopApi {
  vector: { getHealth(input: VectorTaskInput): Promise<Result<VectorHealthDto>>; startMigration(input: VectorProfileInput): Promise<Result<TaskDto>>; rebuild(input: VectorSpaceInput): Promise<Result<TaskDto>>; optimize(input: VectorSpaceInput): Promise<Result<TaskDto>>; cancelTask(input: VectorTaskIdInput): Promise<Result<TaskDto>>; subscribe(projectId: string, listener: (task: TaskDto) => void): () => void; };
  retrieval: { search(input: RetrievalSearchInput): Promise<Result<SearchHitDto[]>> };
  sources?: { chooseFiles(input: { projectId: string }): Promise<string[] | null>; importFile(input: { projectId: string; dialogToken: string }): Promise<Result<SourceDto>>; importUrl(input: { projectId: string; url: string }): Promise<Result<SourceDto>>; list(input: { projectId: string }): Promise<SourceDto[]>; remove(input: { projectId: string; sourceId: string }): Promise<Result<void>>; retry(input: { projectId: string; sourceId: string }): Promise<Result<TaskDto>>; };
  tasks?: { list(input: { projectId: string }): Promise<TaskDto[]>; cancel(input: { projectId: string; taskId: string }): Promise<Result<TaskDto>>; subscribe(projectId: string, listener: (task: TaskDto) => void): () => void; };
  projects: {
    list(): Promise<ProjectDto[]>;
    create(input: CreateProjectInput): Promise<ProjectDto>;
    rename(input: RenameProjectInput): Promise<ProjectDto>;
    archive(input: ProjectIdInput): Promise<ProjectDto>;
    remove(input: ProjectIdInput): Promise<void>;
  };
  settings: {
    get(): Promise<Result<AppSettingsDto>>;
    update(input: UpdateAppSettingsInput): Promise<Result<AppSettingsDto>>;
  };
  models: {
    listProfiles(): Promise<Result<ModelProfileListDto>>;
    getDefaultRoutes(): Promise<Result<DefaultModelRoutesDto>>;
    setDefaultRoutes(input: SetDefaultModelRoutesInput): Promise<Result<DefaultModelRoutesDto>>;
    saveProfile(input: SaveModelProfileInput): Promise<Result<ModelProfileDto>>;
    deleteProfile(input: DeleteModelProfileInput): Promise<Result<void>>;
    discover(input: DiscoverModelsInput): Promise<Result<ModelDescriptorDto[]>>;
    test(input: TestModelInput): Promise<Result<ModelTestResultDto>>;
  };
  credentials: {
    set(input: CredentialInput): Promise<Result<CredentialStatusDto>>;
    remove(input: CredentialProfileInput): Promise<Result<CredentialStatusDto>>;
  };
  titleOverlay: {
    setTheme(input: { theme: AppTheme }): Promise<Result<void>>;
  };
  conversations: {
    list(input: { projectId: string }): Promise<Result<ConversationDto[]>>;
    create(input: { projectId: string; title: string }): Promise<Result<ConversationDto>>;
    rename(input: { projectId: string; conversationId: string; title: string }): Promise<Result<ConversationDto>>;
    archive(input: { projectId: string; conversationId: string }): Promise<Result<ConversationDto>>;
    delete(input: { projectId: string; conversationId: string }): Promise<Result<void>>;
    listMessages(input: { projectId: string; conversationId: string }): Promise<Result<MessageDto[]>>;
  };
  chat: {
    send(input: { projectId: string; conversationId: string; question: string }): Promise<Result<ChatSendResultValue>>;
    stop(input: { projectId: string; requestId: string }): Promise<Result<boolean>>;
    regenerate(input: { projectId: string; conversationId: string; messageId: string }): Promise<Result<ChatSendResultValue>>;
    subscribe(requestId: string, listener: (event: ChatRequestEvent) => void): () => void;
    unsubscribe(requestId: string): void;
  };
  citations: {
    open(input: { projectId: string; citationId: string }): Promise<Result<{ opened: "document" | "url" }>>;
  };
}
