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
    removeConfirm: "This permanently deletes the selected project and cannot be undone."
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
  errors: {
    authentication: "Authentication failed. Check the API key and provider permissions.",
    authorization: "Access was denied. Check the API key permissions and provider account.",
    builtInModelImmutable: "The built-in embedding model cannot be edited. Select it as the embedding route.",
    cancelled: "The request was cancelled. Try again.",
    configuration: "Check the provider address, API key, and model configuration, then retry.",
    credentialBinding: "The saved key does not match this provider address. Re-enter the API key.",
    internal: "The model service could not complete the request. Try again.",
    invalidResponse: "The provider returned an invalid response. Check its status and retry.",
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
    removeProject: "Could not delete the project."
  },
  research: {
    workspaceTitle: "Bring in sources to begin your research",
    importSources: "Import sources",
    sources: "Sources and citations",
    noSourcesTitle: "No sources yet",
    noSourcesBody: "Imported sources and citations will appear here.",
    ask: "Ask about this project",
    sourceImportUnavailable: "Source import will be available in a later step.",
    researchChatUnavailable: "Research chat will be available after source import.",
    settingsUnavailable: "Settings will be available in a later step."
  }
} as const;

export default en;
