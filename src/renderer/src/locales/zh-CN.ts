const zhCN = {
  app: {
    name: "MyNotebookLM",
    settings: "设置"
  },
  project: {
    title: "研究项目",
    create: "新建项目",
    rename: "重命名",
    archive: "归档",
    remove: "删除项目",
    emptyTitle: "开始新的研究项目",
    emptyBody: "创建项目，在一处整理资料、笔记与后续研究。",
    nameLabel: "项目名称",
    menu: "项目操作",
    removeConfirm: "这将永久删除所选项目，且无法撤销。"
  },
  common: {
    cancel: "取消",
    confirm: "确认",
    language: "语言",
    theme: "主题",
    light: "浅色",
    dark: "深色"
  },
  error: {
    loadProjects: "无法加载项目，请重试。",
    createProject: "无法创建项目。",
    renameProject: "无法重命名项目。",
    archiveProject: "无法归档项目。",
    removeProject: "无法删除项目。"
  },
  research: {
    workspaceTitle: "导入资料，开始你的研究",
    importSources: "导入资料",
    sources: "来源与引用",
    noSourcesTitle: "暂无来源",
    noSourcesBody: "导入的来源与引用内容将在这里显示。",
    ask: "针对这个项目提问",
    sourceImportUnavailable: "资料导入将在后续步骤中提供。",
    researchChatUnavailable: "研究对话将在资料导入功能提供后可用。",
    settingsUnavailable: "设置将在后续步骤中提供。"
  }
} as const;

export default zhCN;
