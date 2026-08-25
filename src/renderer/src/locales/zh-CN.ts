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
    openSettings: "打开设置",
    retry: "重试"
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
    dataIndex: "数据与索引",
    loadError: "无法加载模型设置，请检查应用连接后重试。"
  },
  errors: {
    authentication: "身份验证失败，请检查 API Key 和提供商权限。",
    authorization: "访问被拒绝，请检查 API Key 权限和提供商账户。",
    builtInModelImmutable: "内置嵌入模型不可编辑，请将它直接选为嵌入路由。",
    cancelled: "请求已取消，请重试。",
    configuration: "请检查提供商地址、API Key 和模型配置后重试。",
    credentialBinding: "已保存的密钥与当前提供商地址不匹配，请重新输入 API Key。",
    internal: "模型服务无法完成请求，请重试。",
    invalidResponse: "提供商返回了无效响应，请检查其服务状态后重试。",
    modelCapability: "此提供商或模型不支持所需能力，请选择其他模型。",
    modelNotFound: "未找到该模型，请重新获取模型或输入有效的模型名称。",
    modelProfileNotFound: "此模型配置已不存在，请重新加载设置并选择其他配置。",
    modelRouteInconsistent: "已保存的模型路由不一致，请重新打开设置并保存两个模型。",
    network: "无法连接提供商，请检查 API 地址和网络后重试。",
    provider: "提供商返回无效响应或暂时不可用，请检查其服务状态后重试。",
    rateLimited: "提供商限制了请求频率，请稍等片刻后重试。",
    timeout: "提供商响应超时，请检查地址或网络后重试。",
    validation: "请检查提供商地址、模型名称和必填项。"
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
