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
    openSettings: "Open settings"
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
    dataIndex: "Data & indexing"
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
