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
    dark: "深色",
    save: "保存更改",
    saving: "正在保存…",
    openSettings: "打开设置"
  },
  model: {
    generation: { title: "生成模型", description: "用于对话、总结与内容生成" },
    embedding: { title: "嵌入模型", description: "用于本地索引与语义检索" },
    newProfile: { generation: "新生成模型配置", embedding: "新嵌入模型配置" },
    savedProfile: "已保存配置",
    newProfileOption: "新建配置",
    provider: "提供商",
    providers: {
      openai: "OpenAI",
      "openai-compatible": "OpenAI Compatible",
      anthropic: "Anthropic",
      gemini: "Gemini",
      ollama: "Ollama",
      local: "内置本地模型"
    },
    apiAddress: "API 地址",
    apiKey: "API Key",
    showApiKey: "显示 API Key",
    hideApiKey: "隐藏 API Key",
    getModels: "获取模型",
    fetching: "正在获取…",
    fetchSuccess: "获取成功",
    model: "模型",
    modelName: "模型名称",
    chooseModel: "选择模型",
    manualModel: "手动输入模型名称",
    chooseDiscovered: "选择已获取模型",
    validation: {
      apiKey: "请输入 API Key。",
      address: "请输入有效的 HTTP 或 HTTPS API 地址。",
      complete: "请同时配置有效的生成模型与嵌入模型。"
    },
    errors: { request: "模型服务请求失败。" }
  },
  onboarding: {
    title: "欢迎使用 MyNotebookLM",
    subtitle: "配置模型后即可开启高效的研究与写作之旅。",
    finish: "完成并开始使用",
    skip: "稍后配置模型",
    localCredential: "凭据仅保存在本机"
  },
  settings: {
    title: "设置",
    subtitle: "管理模型、数据与应用偏好",
    general: "通用",
    languageAppearance: "语言与外观",
    modelServices: "模型服务",
    dataIndex: "数据与索引"
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
