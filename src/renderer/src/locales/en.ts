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
    dark: "Dark"
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
    workspaceBody: "Source import and research chat will be available in a later step.",
    importSources: "Import sources",
    sources: "Sources and citations",
    noSourcesTitle: "No sources yet",
    noSourcesBody: "Imported sources and citations will appear here.",
    ask: "Ask about this project",
    unavailable: "Available after sources are added"
  }
} as const;

export default en;
