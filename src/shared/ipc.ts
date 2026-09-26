import { z } from "zod";
import { conversationSchema, messageSchema } from "./chat";
import type { ConversationDto, MessageDto } from "./chat";
import type { CreateProjectInput, ProjectDto, ProjectIdInput, RenameProjectInput } from "./projects";
import { appErrorDtoSchema, type Result } from "./app-errors";
import type {
  CredentialInput,
  CredentialProfileInput,
  CredentialStatusDto,
  DefaultModelRoutesDto,
  DeleteModelProfileInput,
  DiscoverModelsInput,
  DiscoverSpeechVoicesInput,
  SpeechVoiceDescriptor,
  ModelDescriptorDto,
  ModelProfileDto,
  ModelProfileListDto,
  ModelTestResultDto,
  SaveModelProfileInput,
  SetDefaultModelRoutesInput,
  TestModelInput,
  UpdateGenerationSettingsInput
} from "./models";
import type { AppSettingsDto, UpdateAppSettingsInput } from "./settings";
import type { AppTheme } from "./settings";
import { sourceKindSchema, type SourceDto, type SourceKind } from "./sources";
import type { NoteDto, NoteLinkDto, CreateNoteInput, UpdateNoteInput, NoteStateInput, NoteIdInput, CreateNoteLinkInput, DeleteNoteLinkInput, GenerateNoteTitleInput } from "./notes";
import type { TransformationDto, CreateTransformationInput, UpdateTransformationInput, InsightDto, TransformationRunInput, BuiltinTransformationDto } from "./transformations";
import { modelTaskKindSchema, type ModelRouteDto, type ModelRouteAttemptDto, type ModelTaskKind } from "./models";
import type { TaskDto } from "./tasks";
import type { RetrievalSearchInput, SearchHitDto, VectorHealthDto, VectorProfileInput, VectorSpaceInput, VectorTaskIdInput, VectorTaskInput } from "./vector";

export const SOURCE_CHANNELS = { chooseFiles: "sources:v1:choose-files", importFile: "sources:v1:import-file", importUrl: "sources:v1:import-url", list: "sources:v1:list", open: "sources:v1:open", remove: "sources:v1:remove", retry: "sources:v1:retry", cancel: "tasks:v1:cancel", listTasks: "tasks:v1:list", subscribe: "tasks:v1:subscribe", update: "tasks:v1:update" } as const;

export const PROJECT_CHANNELS = {
  list: "projects:list",
  listArchived: "projects:list-archived",
  listDeleteFailed: "projects:list-delete-failed",
  create: "projects:create",
  rename: "projects:rename",
  archive: "projects:archive",
  remove: "projects:remove",
  restore: "projects:restore",
  undo: "projects:undo",
  retryDelete: "projects:retry-delete"
} as const;

export const SETTINGS_CHANNELS = {
  get: "settings:v1:get",
  update: "settings:v1:update"
} as const;

export const MODEL_CHANNELS = {
  listProfiles: "models:v1:list-profiles",
  chooseLocalModel: "models:v1:choose-local-model",
  getDefaultRoutes: "models:v1:get-default-routes",
  setDefaultRoutes: "models:v1:set-default-routes",
  saveProfile: "models:v1:save-profile",
  deleteProfile: "models:v1:delete-profile",
  discover: "models:v1:discover",
  discoverVoices: "models:v1:discover-voices",
  test: "models:v1:test",
  updateGenerationSettings: "models:v1:update-generation-settings",
  getRoutes: "models:v1:get-routes",
  saveRoutes: "models:v1:save-routes",
  listRouteAttempts: "models:v1:list-route-attempts"
} as const;

export const NOTE_CHANNELS = {
  create: "notes:v1:create", get: "notes:v1:get", list: "notes:v1:list", update: "notes:v1:update",
  archive: "notes:v1:archive", restore: "notes:v1:restore", delete: "notes:v1:delete",
  createLink: "notes:v1:create-link", listLinks: "notes:v1:list-links", deleteLink: "notes:v1:delete-link", generateTitle: "notes:v1:generate-title"
} as const;

export const TRANSFORMATION_CHANNELS = {
  listRules: "transformations:v1:list-rules", createRule: "transformations:v1:create-rule", updateRule: "transformations:v1:update-rule", deleteRule: "transformations:v1:delete-rule",
  listBuiltins: "transformations:v1:list-builtins", run: "transformations:v1:run", cancel: "transformations:v1:cancel", retry: "transformations:v1:retry",
  listInsights: "transformations:v1:list-insights", deleteInsight: "transformations:v1:delete-insight", convertToNote: "transformations:v1:convert-to-note", getAudio: "transformations:v1:get-audio"
} as const;

export const modelRoutesInputSchema = z.object({ taskKind: modelTaskKindSchema }).strict();
export const saveModelRoutesInputSchema = z.object({ taskKind: modelTaskKindSchema, profileIds: z.array(z.uuid()).min(1).max(16) }).strict();
export const modelRouteAttemptsInputSchema = z.object({ projectId: z.uuid(), taskKind: modelTaskKindSchema.optional(), limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().max(100_000).optional() }).strict();
export const noteListInputSchema = z.object({ projectId: z.uuid(), includeArchived: z.boolean().optional() }).strict();
export const noteGenerateTitleInputSchema = z.object({ projectId: z.uuid(), noteId: z.uuid(), locale: z.enum(["zh-CN", "en"]), profileId: z.uuid().optional() }).strict();
export const transformationRulesInputSchema = z.object({ projectId: z.uuid() }).strict();
export const transformationBuiltinInputSchema = z.object({ language: z.enum(["zh-CN", "en"]).optional() }).strict();
export const transformationInsightsInputSchema = z.object({ projectId: z.uuid(), limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().max(100_000).optional() }).strict();
export const transformationTaskInputSchema = z.object({ projectId: z.uuid(), taskId: z.uuid() }).strict();
export const transformationConvertInputSchema = z.object({ projectId: z.uuid(), insightId: z.uuid() }).strict();

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
  continue: "chat:v1:continue",
  subscribeRequest: "chat:v1:subscribe-request",
  unsubscribeRequest: "chat:v1:unsubscribe-request",
  update: "chat:v1:update"
} as const;

export const CITATION_CHANNELS = {
  open: "citations:v1:open",
  detail: "citations:v1:detail"
} as const;

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
  export const chatSendInputSchema = z.object({ requestId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), question: z.string().trim().min(1).max(20_000), generationProfileId: z.uuid().optional(), thinking: z.enum(["off", "low", "medium", "high"]).optional() }).strict();
export const chatStopInputSchema = z.object({ projectId: z.uuid(), requestId: z.uuid() }).strict();
export const chatRegenerateInputSchema = z.object({ requestId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), messageId: z.string().min(1).max(128), question: z.string().trim().min(1).max(20_000).optional(), thinking: z.enum(["off", "low", "medium", "high"]).optional() }).strict();
export const chatContinueInputSchema = z.object({ requestId: z.uuid(), projectId: z.uuid(), conversationId: z.uuid(), messageId: z.string().min(1).max(128), expectedRevision: z.number().int().nonnegative() }).strict();
export const chatRequestIdInputSchema = z.object({ requestId: z.uuid() }).strict();
export const citationOpenInputSchema = z.object({ projectId: z.uuid(), citationId: z.string().trim().min(1).max(256) }).strict();

export const chatSendResultValueSchema = z.object({ requestId: z.uuid(), assistantMessageId: z.string() }).strict();
export type ChatSendResultValue = z.infer<typeof chatSendResultValueSchema>;
export const chatOpenedResultValueSchema = z.object({ opened: z.enum(["document", "url"]) }).strict();
const citationSheetStyleSchema = z.object({
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().optional(),
  fontStyle: z.literal("italic").optional(),
  textDecoration: z.literal("underline").optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  whiteSpace: z.enum(["pre-wrap", "nowrap"]).optional()
}).strict();
export const citationSheetPreviewSchema = z.object({
  name: z.string(),
  columns: z.array(z.object({ number: z.number().int().positive(), width: z.number().positive() }).strict()).max(256),
  rows: z.array(z.object({
    number: z.number().int().positive(),
    height: z.number().positive().optional(),
    cells: z.array(z.object({
      column: z.number().int().positive(),
      text: z.string(),
      colSpan: z.number().int().positive().optional(),
      rowSpan: z.number().int().positive().optional(),
      covered: z.boolean().optional(),
      formula: z.string().optional(),
      style: citationSheetStyleSchema.optional()
    }).strict()).max(256)
  }).strict()).max(105)
}).strict();
export type CitationSheetPreview = z.infer<typeof citationSheetPreviewSchema>;
export const citationImagePreviewSchema = z.object({
  data: z.instanceof(Uint8Array),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]),
  altText: z.string().max(500).optional(),
  cellRef: z.string().max(32).optional()
}).strict();
export type CitationImagePreview = z.infer<typeof citationImagePreviewSchema>;
export const citationDetailResultValueSchema = z.object({
  text: z.string().nullable(),
  kind: sourceKindSchema,
  data: z.instanceof(Uint8Array).nullable(),
  sheet: citationSheetPreviewSchema.nullable(),
  images: z.array(citationImagePreviewSchema).max(12)
}).strict();
export type CitationDetailResultValue = z.infer<typeof citationDetailResultValueSchema>;

/**
 * Renderer-facing stream events keyed by opaque requestId. retrieved/fallback are
 * part of the frozen contract for upcoming routing work; the service simply does
 * not emit them yet.
 */
export const chatRequestEventSchemas = {
  started: z.object({
    type: z.literal("started"),
    requestId: z.uuid(),
    messageId: z.string().min(1),
    /** Continuations report their operation plus the authoritative old message. */
    operation: z.enum(["initial", "continue"]).optional(),
    message: messageSchema.optional(),
    /** JS string length the next delta continues from (continuations). */
    offset: z.number().int().nonnegative().optional()
  }),
  retrieval: z.object({ type: z.literal("retrieval"), requestId: z.uuid() }),
  "text-delta": z.object({ type: z.literal("text-delta"), requestId: z.uuid(), messageId: z.string().min(1), text: z.string(), offset: z.number().int().nonnegative().optional() }),
  usage: z.object({ type: z.literal("usage"), requestId: z.uuid(), usage: chatUsageDtoSchema }),
  fallback: z.object({
    type: z.literal("fallback"),
    requestId: z.uuid(),
    attempted: z.object({ provider: z.string(), model: z.string(), profileId: z.string().nullable() }).strict(),
    next: z.object({ provider: z.string(), model: z.string(), profileId: z.string().nullable() }).strict(),
    errorCode: z.string()
  }),
  completed: z.object({ type: z.literal("completed"), requestId: z.uuid(), messageId: z.string().min(1), message: messageSchema }),
  cancelled: z.object({ type: z.literal("cancelled"), requestId: z.uuid(), messageId: z.string().min(1), message: messageSchema, operation: z.enum(["initial", "continue"]).optional() }),
  failed: z.object({
    type: z.literal("failed"),
    requestId: z.uuid(),
    messageId: z.string().min(1),
    error: appErrorDtoSchema,
    operation: z.enum(["initial", "continue"]).optional(),
    message: messageSchema.optional()
  })
} as const;

export const chatRequestEventTypeSchema = z.enum(Object.keys(chatRequestEventSchemas) as [(keyof typeof chatRequestEventSchemas), ...(keyof typeof chatRequestEventSchemas)[]]);
export type ChatRequestEventType = keyof typeof chatRequestEventSchemas;
export type ChatRequestEvent =
  | { type: "started"; requestId: string; messageId: string; operation?: "initial" | "continue"; message?: MessageDto; offset?: number }
  | { type: "retrieval"; requestId: string }
  | { type: "text-delta"; requestId: string; messageId: string; text: string; offset?: number }
  | { type: "usage"; requestId: string; usage: z.infer<typeof chatUsageDtoSchema> }
  | { type: "fallback"; requestId: string; attempted: { provider: string; model: string; profileId: string | null }; next: { provider: string; model: string; profileId: string | null }; errorCode: string }
  | { type: "completed"; requestId: string; messageId: string; message: MessageDto }
  | { type: "cancelled"; requestId: string; messageId: string; message: MessageDto; operation?: "initial" | "continue" }
  | { type: "failed"; requestId: string; messageId: string; error: import("./app-errors").AppErrorDto; operation?: "initial" | "continue"; message?: MessageDto };

export interface DesktopApi {
  vector: { getHealth(input: VectorTaskInput): Promise<Result<VectorHealthDto>>; startMigration(input: VectorProfileInput): Promise<Result<TaskDto>>; rebuild(input: VectorSpaceInput): Promise<Result<TaskDto>>; optimize(input: VectorSpaceInput): Promise<Result<TaskDto>>; cancelTask(input: VectorTaskIdInput): Promise<Result<TaskDto>>; subscribe(projectId: string, listener: (task: TaskDto) => void): () => void; };
  retrieval: { search(input: RetrievalSearchInput): Promise<Result<SearchHitDto[]>> };
  sources?: { chooseFiles(input: { projectId: string }): Promise<string[] | null>; importFile(input: { projectId: string; dialogToken: string }): Promise<Result<SourceDto>>; importUrl(input: { projectId: string; url: string }): Promise<Result<SourceDto>>; list(input: { projectId: string }): Promise<SourceDto[]>; open(input: { projectId: string; sourceId: string }): Promise<Result<{ opened: "document" | "url" }>>; remove(input: { projectId: string; sourceId: string }): Promise<Result<void>>; retry(input: { projectId: string; sourceId: string }): Promise<Result<TaskDto>>; };
  tasks?: { list(input: { projectId: string }): Promise<TaskDto[]>; cancel(input: { projectId: string; taskId: string }): Promise<Result<TaskDto>>; subscribe(projectId: string, listener: (task: TaskDto) => void): () => void; };
  projects: {
    list(): Promise<ProjectDto[]>;
    listArchived(): Promise<ProjectDto[]>;
    listDeleteFailed(): Promise<ProjectDto[]>;
    create(input: CreateProjectInput): Promise<ProjectDto>;
    rename(input: RenameProjectInput): Promise<ProjectDto>;
    archive(input: ProjectIdInput): Promise<ProjectDto>;
    remove(input: ProjectIdInput): Promise<ProjectDto>;
    restore(input: ProjectIdInput): Promise<ProjectDto>;
    undo(input: ProjectIdInput): Promise<ProjectDto>;
    retryDelete(input: ProjectIdInput): Promise<ProjectDto>;
  };
  settings: {
    get(): Promise<Result<AppSettingsDto>>;
    update(input: UpdateAppSettingsInput): Promise<Result<AppSettingsDto>>;
  };
  models: {
    listProfiles(): Promise<Result<ModelProfileListDto>>;
    chooseLocalModel(): Promise<Result<string | null>>;
    getDefaultRoutes(): Promise<Result<DefaultModelRoutesDto>>;
    setDefaultRoutes(input: SetDefaultModelRoutesInput): Promise<Result<DefaultModelRoutesDto>>;
    saveProfile(input: SaveModelProfileInput): Promise<Result<ModelProfileDto>>;
    deleteProfile(input: DeleteModelProfileInput): Promise<Result<void>>;
    discover(input: DiscoverModelsInput): Promise<Result<ModelDescriptorDto[]>>;
    discoverVoices(input: DiscoverSpeechVoicesInput): Promise<Result<SpeechVoiceDescriptor[]>>;
    test(input: TestModelInput): Promise<Result<ModelTestResultDto>>;
    updateGenerationSettings(input: UpdateGenerationSettingsInput): Promise<Result<ModelProfileDto>>;
    getRoutes?(input: { taskKind: ModelTaskKind }): Promise<Result<ModelRouteDto[]>>;
    saveRoutes?(input: { taskKind: ModelTaskKind; profileIds: string[] }): Promise<Result<ModelRouteDto[]>>;
    listRouteAttempts?(input: { projectId: string; taskKind?: ModelTaskKind; limit?: number; offset?: number }): Promise<Result<ModelRouteAttemptDto[]>>;
  };
  notes?: {
    create(input: CreateNoteInput): Promise<Result<NoteDto>>; get(input: NoteIdInput): Promise<Result<NoteDto | null>>; list(input: { projectId: string; includeArchived?: boolean }): Promise<Result<NoteDto[]>>;
    update(input: UpdateNoteInput): Promise<Result<NoteDto>>; archive(input: NoteStateInput): Promise<Result<NoteDto>>; restore(input: NoteStateInput): Promise<Result<NoteDto>>; delete(input: NoteStateInput): Promise<Result<void>>;
    createLink(input: CreateNoteLinkInput): Promise<Result<NoteLinkDto>>; listLinks(input: NoteIdInput): Promise<Result<NoteLinkDto[]>>; deleteLink(input: DeleteNoteLinkInput): Promise<Result<void>>; generateTitle(input: GenerateNoteTitleInput): Promise<Result<NoteDto>>;
  };
  transformations?: {
    listRules(input: { projectId: string }): Promise<Result<TransformationDto[]>>; createRule(input: CreateTransformationInput): Promise<Result<TransformationDto>>; updateRule(input: UpdateTransformationInput): Promise<Result<TransformationDto>>; deleteRule(input: { projectId: string; id: string; version: number }): Promise<Result<void>>;
    listBuiltins(input?: { language?: "zh-CN" | "en" }): Promise<Result<BuiltinTransformationDto[]>>; run(input: TransformationRunInput): Promise<Result<TaskDto>>; cancel(input: { projectId: string; taskId: string }): Promise<Result<TaskDto>>; retry(input: { projectId: string; taskId: string }): Promise<Result<TaskDto>>;
    listInsights(input: { projectId: string; limit?: number; offset?: number }): Promise<Result<InsightDto[]>>; deleteInsight(input: { projectId: string; insightId: string }): Promise<Result<void>>; convertToNote(input: { projectId: string; insightId: string }): Promise<Result<NoteDto>>;
    getAudio(input: { projectId: string; insightId: string }): Promise<Result<import("./transformations").PodcastAudioDto>>;
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
    send(input: { requestId: string; projectId: string; conversationId: string; question: string; generationProfileId?: string; thinking?: "off" | "low" | "medium" | "high" }): Promise<Result<ChatSendResultValue>>;
    stop(input: { projectId: string; requestId: string }): Promise<Result<boolean>>;
    regenerate(input: { requestId: string; projectId: string; conversationId: string; messageId: string; question?: string; thinking?: "off" | "low" | "medium" | "high" }): Promise<Result<ChatSendResultValue>>;
    continue(input: { requestId: string; projectId: string; conversationId: string; messageId: string; expectedRevision: number; }): Promise<Result<ChatSendResultValue>>;
    subscribe(requestId: string, listener: (event: ChatRequestEvent) => void): () => void;
    unsubscribe(requestId: string): void;
  };
  citations: {
    open(input: { projectId: string; citationId: string }): Promise<Result<{ opened: "document" | "url" }>>;
    detail(input: { projectId: string; citationId: string }): Promise<Result<CitationDetailResultValue>>;
  };
}
