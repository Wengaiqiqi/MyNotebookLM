const en = {
  app: {
    name: "MyNotebookLM",
    settings: "Settings"
  },
  project: {
    title: "Research projects",
    create: "New project",
    rename: "Rename",
    archive: "Archive",
    remove: "Delete project",
    emptyTitle: "Start a new research project",
    emptyBody: "Create a project to organize sources, notes, and future research in one place.",
    nameLabel: "Project name",
    menu: "Project actions",
    removeConfirm: "This starts a recoverable deletion. You have 30 seconds to undo it.",
    archived: "Archived projects",
    restore: "Restore",
    undo: "Undo deletion",
    retryDelete: "Retry deletion",
    deletionPending: "Project deletion is waiting for cleanup."
  },
  common: {
    cancel: "Cancel",
    confirm: "Confirm",
    language: "Language",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    save: "Save changes",
    saving: "Saving…",
    openSettings: "Open settings",
    retry: "Retry"
  },
  model: {
    generation: { title: "Generation model", description: "For chat, summaries, and writing" },
    embedding: { title: "Embedding model", description: "For local indexing and semantic search" },
    newProfile: { generation: "New generation profile", embedding: "New embedding profile" },
    savedProfile: "Saved profile",
    newProfileOption: "New profile",
    provider: "Provider",
    providers: {
      openai: "OpenAI",
      "openai-compatible": "OpenAI Compatible",
      anthropic: "Anthropic",
      gemini: "Gemini",
      ollama: "Ollama",
      local: "Built-in local"
    },
    apiAddress: "API address",
    apiKey: "API key",
    showApiKey: "Show API key",
    hideApiKey: "Hide API key",
    getModels: "Get models",
    fetching: "Fetching…",
    fetchSuccess: "Fetched successfully",
    model: "Model",
    modelName: "Model name",
    chooseModel: "Choose a model",
    manualModel: "Enter model name manually",
    chooseDiscovered: "Choose a fetched model",
    validation: {
      apiKey: "Enter an API key.",
      address: "Enter a valid HTTP or HTTPS API address.",
      complete: "Configure both a valid generation model and embedding model."
    },
    errors: { request: "The model service request failed." }
  },
  onboarding: {
    title: "Welcome to MyNotebookLM",
    subtitle: "Configure models to begin an efficient research and writing journey.",
    finish: "Finish and start",
    skip: "Configure later",
    localCredential: "Credentials are stored only on this device"
  },
  settings: {
    title: "Settings",
    subtitle: "Manage models, data, and app preferences",
    general: "General",
    languageAppearance: "Language & appearance",
    modelServices: "Model services",
    dataIndex: "Data & indexing",
    loadError: "Could not load model settings. Check the app connection and retry."
  },
  vector: {
    eyebrow: "Data & indexing",
    healthy: "Healthy",
    healthyBody: "The active Space has indexed {{count}} items.",
    unavailableBody: "The index is temporarily unavailable. Configure an embedding model or rebuild it.",
    corruptBody: "Index verification failed. Rebuild the active Space.",
    buildingBody: "A new embedding Space is being built and will be activated only after verification.",
    failedBody: "Space construction failed. Try again.",
    building: "Building",
    progress: "Index task progress",
    configureModel: "Go to model services",
    optimize: "Optimize index",
    rebuild: "Rebuild index",
    migrate: "Migrate embedding Space",
    cancelTask: "Cancel index task",
    previousSpaceKept: "The previous embedding Space remains active when migration fails.",
    migrationTitle: "Migrate embedding Space?",
    migrationBody: "Build a new Space with {{profile}}. The current Space is not replaced until verification succeeds.",
    migrationRunning: "Migrating embedding Space",
    migrationRunningBody: "The new Space is being built and verified; the current Space remains available.",
    migrationFailed: "Embedding Space migration failed",
    migrationFailedBody: "The new Space was not activated. Check the model settings and try again.",
    retryMigration: "Retry migration",
    noProject: "Select a research project to manage its index.",
    states: { healthy: "Healthy index", unavailable: "Index unavailable", corrupt: "Index needs repair", building: "Building index", failed: "Index build failed" }
  },
  errors: {
    authentication: "Authentication failed. Check the API key and provider permissions.",
    authorization: "Access was denied. Check the API key permissions and provider account.",
    builtInModelImmutable: "The built-in embedding model cannot be edited. Select it as the embedding route.",
    cancelled: "The request was cancelled. Try again.",
    configuration: "Check the provider address, API key, and model configuration, then retry.",
    credentialBinding: "The saved key does not match this provider address. Re-enter the API key.",
    internal: "The model service could not complete the request. Try again.",
    invalidResponse: "The provider returned an invalid response. Check its status and retry.",
    indexUnavailable: "The index is temporarily unavailable. Retry or rebuild it.",
    taskConflict: "An index task is already running. Try again shortly.",
    embeddingProfileUnavailable: "The embedding model is unavailable. Check model settings and retry.",
    notFound: "The requested resource could not be found. Reload settings.",
    modelCapability: "This provider or model does not support the required capability. Choose another model.",
    modelNotFound: "The model was not found. Fetch models again or enter a valid model name.",
    modelProfileNotFound: "This saved model profile no longer exists. Reload settings and choose another profile.",
    modelRouteInconsistent: "Saved model routes are inconsistent. Reopen settings and save both models again.",
    network: "Could not reach the provider. Check the API address and network, then retry.",
    provider: "The provider returned an invalid or unavailable response. Check its status and retry.",
    rateLimited: "The provider is rate limiting requests. Wait a moment and retry.",
    timeout: "The provider took too long to respond. Check the address or network, then retry.",
    validation: "Check the provider address, model name, and required fields."
  },
  error: {
    loadProjects: "Could not load projects. Try again.",
    createProject: "Could not create the project.",
    renameProject: "Could not rename the project.",
    archiveProject: "Could not archive the project.",
    removeProject: "Could not delete the project.",
    restoreProject: "Could not restore the project.",
    retryDeleteProject: "Could not retry project deletion."
  },
  chat: {
    message: {
      streaming: "Answering…",
      completed: "Answered",
      cancelled: "Stopped.",
      failed: "The answer failed."
    },
    repair: {
      retry: "Retry answer",
      repair: "Repair answer"
    },
    ui: {
      conversations: "Conversations", newConversation: "New conversation", rename: "Rename", archive: "Archive", remove: "Delete", saveTitle: "Save conversation title", noConversations: "No conversations yet.", conversationTitle: "Conversation title",
      citationTitle: "Source citations", citationEmpty: "Citations from answers will appear here.", openOriginal: "Open original source", opened: "Opened {{kind}}", sourceLabel: "Sources", indexed: "indexed", research: "Research", researchChat: "Research chat", askPlaceholder: "Ask about your sources…", model: "Model", generationModel: "Generation model", noModel: "No model", send: "Send", stop: "Stop", copy: "Copy", regenerate: "Regenerate", answerFailed: "Answer failed.", retryAnswer: "Retry answer", fallbackBanner: "The primary model was unavailable. The answer continued with a fallback model.", unavailableTitle: "Research chat is unavailable until a source is indexed and a generation model is configured.", unavailableImport: "Import a source and rebuild the index after processing completes.", unavailableModel: "Configure a generation model in settings to ask questions.", importSources: "Import sources", openSettings: "Open settings", rebuildIndex: "Rebuild index", pending: "pending", ready: "ready", sourceProgress: "{{stage}} · {{progress}}%", page: "Page", slide: "Slide", sheet: "Sheet", cell: "Cell"
    }
  },
  research: {
    workspaceTitle: "Bring in sources to begin your research",
    importSources: "Import sources",
    sources: "Sources and citations",
    noSourcesTitle: "No sources yet",
    noSourcesBody: "Imported sources and citations will appear here.",
    ask: "Ask about this project",
    sourceImportUnavailable: "Import files or web pages to start your research.",
    researchChatUnavailable: "Research chat will be available after source import.",
    settingsUnavailable: "Settings will be available in a later step.",
    chooseFiles: "Choose files",
    importUrl: "Import URL",
    webAddress: "Web address",
    removeSource: "Remove",
    indexed: "Indexed",
    pending: "Pending",
    selected: "Selected",
    formats: "Supported: PDF, DOCX, PPTX, XLSX, TXT, Markdown, URL, CSV",
    importing: "Importing…",
    importError: "Import failed",
    task: { cancel: "Cancel task", retry: "Retry task", remove: "Remove task", completed: "Completed", failed: "Failed", queued: "Queued", running: "In progress", cancelled: "Cancelled", validating: "Validating", staging: "Preparing", parsing: "Parsing", chunking: "Chunking", embedding: "Embedding", indexing: "Indexing", verifying: "Verifying", cleanup: "Cleaning up", finalizing: "Finalizing", preparing: "Preparing", generating: "Generating", saving: "Saving" }
  }
} as const;

export default en;
