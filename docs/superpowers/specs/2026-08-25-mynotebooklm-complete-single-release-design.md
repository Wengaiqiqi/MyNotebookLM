# MyNotebookLM 完整产品一次性交付设计规格

日期：2026-08-25

状态：用户已批准（2026-08-25）
基础规格：`docs/superpowers/specs/2026-08-24-mynotebooklm-desktop-design.md`

## 1. 决策与优先级

本规格把已经批准的桌面产品规格扩展为完整产品合同。发生冲突时，优先级为：用户在对话中明确确认的要求、本规格、基础规格、参考技术路线。参考技术路线只提供思路，不构成 Web、容器、SurrealDB、Python 或播客实现指令。

最终产品继续采用 Windows x64 Electron 桌面形态，不启动独立 HTTP 服务，不要求浏览器、Docker、Node.js 或开发工具。开发期间可以产生内部提交、测试构建和原生 Electron 运行证据，但不向用户交付中间安装包。只有本规格全部完成并通过验收后，才生成新的最终 `.exe`。

## 2. 完整交付范围

最终一次性交付包含：

1. 首次启动模型配置与可跳过流程。
2. 设置中心、凭据管理、模型发现、手动模型名和连接测试。
3. OpenAI、OpenAI 兼容、Anthropic、Google Gemini、Ollama 生成模型。
4. 应用内置本地、OpenAI、OpenAI 兼容、Gemini、Ollama Embedding。
5. 项目创建、选择、重命名、归档、删除与持久化。
6. TXT、Markdown、URL、PDF、DOCX、PPTX、XLSX、CSV 导入。
7. 后台解析、分块、Embedding、任务进度、取消、失败原因和重试。
8. SQLite 业务事实库与完整 LanceDB 向量库生命周期。
9. BM25、ANN、元数据过滤、RRF 融合和引用定位。
10. 多轮研究对话、流式回答、停止、复制、重新生成和会话持久化。
11. 独立笔记、AI 自动标题、资料关联和持久化。
12. 内置摘要、要点、Q&A 转换与自定义转换规则。
13. 多模型任务路由、用户覆盖选择和安全的失败回退。
14. Embedding Space 检查、优化、重建和无损模型迁移。
15. 中英文切换、浅深色主题、恢复状态和最终 Windows 安装验证。

明确排除：播客、TTS、STT、音视频处理、`.doc`、`.ppt`、`.xls`、云同步、多人协作、账号系统、移动端、macOS、Linux 和插件市场。

最终界面不得出现“后续步骤中提供”一类占位能力。可见操作必须可以执行；缺少模型、网络、来源或索引时，操作进入带明确修复路径的状态，而不是永久禁用的假入口。

## 3. 产品流程

### 3.1 首次启动

首次启动由 `app_settings.onboarding_completed` 决定。未完成时直接显示已批准的 `docs/ui/foundation/first-launch.png`，不先进入项目页。

- 生成模型与 Embedding 独立配置。
- 选择 Provider 后填入默认且可编辑的 `API 地址`。
- 需要凭据的 Provider 显示 `API Key`；Ollama 和内置本地 Embedding 不要求密钥。
- `获取模型` 成功后才显示 `获取成功` 和可选下拉列表。
- 用户始终可以手动输入模型名。
- `稍后配置模型` 保存语言、主题和已完成引导状态；进入需要模型的功能时显示可直接打开设置的修复动作。
- `完成并开始使用` 只有在所选配置通过校验后保存。

API Key 仅通过主进程 IPC 进入 `safeStorage`，以 Windows DPAPI 加密后落库。渲染进程不读取已保存的明文 Key，界面只显示是否已配置和掩码状态。

### 3.2 项目与窗口交互

- 当前已实现的左侧项目导航作为基准。
- 设置入口、`中文 | EN` 和 `浅色 | 深色` 在侧栏底部居中。
- 所有创建、重命名、删除、导入和确认弹窗相对完整应用窗口居中，遮罩覆盖整个应用。
- 标题区域与应用背景连续，不显示独立色带。Windows `—`、`□`、`×` 控件由 Electron title-bar overlay 保留并嵌入背景。
- 拖动区域使用 `-webkit-app-region: drag`，所有按钮和输入控件使用 `no-drag`。
- 项目删除在资料、笔记、会话、任务和向量清理完成前保持可恢复删除状态。

### 3.3 资料摄入

所有输入都先验证再创建任务：

1. 校验扩展名、内容签名、大小、路径或 URL。
2. 本地文件以唯一名称原子复制到应用数据目录。
3. SQLite 创建 `source`、`source_revision` 和 `task`。
4. Worker Thread 使用格式解析器生成结构化段落、表格与定位信息。
5. 按基础规格的版本化规则分块并生成内容哈希。
6. 使用当前 Embedding Space 批量向量化。
7. 将可重建块写入 LanceDB，创建或维护向量、FTS 和过滤索引。
8. 数量与试查校验通过后，SQLite 原子切换有效 revision 并标记可搜索。

解析必须保留引用定位：PDF 页码、PPTX 幻灯片、XLSX 工作表与单元格、CSV 行范围、DOCX 标题/段落/表格、Markdown 标题层级、网页章节与 URL、TXT 段落范围。

任务遵循 `queued → running → completed | failed | cancelled`。临时网络、限流和部分服务端错误可指数退避；认证、配置、格式和签名错误不可自动重试。UI 显示阶段、百分比、可读错误、取消与重试。

### 3.4 检索、对话与引用

检索只读取当前项目、有效 source revision 和当前健康 Embedding Space：

1. 查询 Embedding。
2. 并行执行 LanceDB ANN 与 BM25/FTS 召回。
3. 使用项目、来源、revision、space 元数据过滤。
4. 使用 RRF 合并排序并按来源与内容哈希去重。
5. 回到 SQLite 校验有效版本并补齐 locator。
6. 在 Token 预算内组装带不可忽略引用 ID 的上下文。
7. 通过选定生成模型流式输出回答和引用事件。

生成流支持停止。中断时保留已完成文本并标记未完成，可重新生成。消息、引用、Provider、模型、Token/用量元数据写入 SQLite。引用面板可打开原始文件或 URL，并定位到支持的页、幻灯片、工作表/单元格、段落或章节。

无检索结果、模型不可用、索引不可用和离线状态都提供可执行动作：调整问题、打开模型设置、检查/重建索引或等待网络恢复。

### 3.5 笔记、转换与洞察

- 笔记属于项目，可选择关联来源、消息或引用。
- 用户可新建、编辑、归档和删除 Markdown 笔记。
- AI 自动标题是显式动作；失败时保留原标题和正文。
- 内置转换包括摘要、要点和 Q&A。
- 自定义转换由名称、适用对象、提示词正文和启用状态组成。
- 自定义提示词只支持明确定义的文本占位符，不执行脚本、HTML 或任意模板代码。
- 转换作为后台任务运行，可取消、重试；结果作为 `insight` 持久化并可转成笔记。
- 同一 source revision、规则版本、模型配置和输入哈希形成幂等键，避免重复结果。

### 3.6 多模型路由与回退

生成、Embedding、标题和转换任务都通过统一 Provider 契约。模型路由保存任务类型、首选配置和有序回退配置。

- 用户在单次对话或转换中显式选择的模型优先于默认路由。
- 只对超时、连接失败、限流和可恢复的服务端错误尝试下一个配置。
- 认证失败、无效模型、输入过长、内容校验和取消不得静默回退。
- 每次回退在 UI 与结构化日志中可见，并记录实际使用的 Provider/模型。
- Embedding 不对单个批次跨模型回退，以免混合向量空间；失败时暂停任务并要求修复当前 Space，或由用户启动完整 Space 迁移。

## 4. 进程与安全边界

应用继续使用四个边界：React 渲染进程、白名单 preload、Electron 主进程、Worker Threads。

- Renderer 只能使用版本化 `DesktopApi`，不能导入 Node/Electron、访问文件系统、数据库、LanceDB 或凭据。
- Preload 对所有命令、事件负载、流事件和错误执行 Zod 校验，并返回取消订阅函数。
- Main 负责 SQLite、LanceDB、Provider、safeStorage、任务编排、系统对话框和日志。
- Worker 只接收可序列化任务，不直接持有 BrowserWindow、safeStorage 或 Renderer 对象。
- Worker 进度通过任务服务写 SQLite，再由主进程以节流事件通知 Renderer。
- 文件解析不执行宏、脚本、外部对象或公式引擎。
- URL 仅允许 HTTP/HTTPS，禁止本机、回环、私网、链路本地和重定向到受限地址；每次重定向重新校验。
- 模型响应 Markdown 必须清理危险 HTML、脚本和远程资源。
- 日志、IPC 错误和诊断导出不得出现 API Key、Authorization 或完整敏感正文。

## 5. 数据与可恢复性

SQLite 是业务事实来源，至少包含：

- `projects`
- `sources`
- `source_revisions`
- `source_chunks`
- `tasks`
- `conversations`
- `messages`
- `message_citations`
- `notes`
- `transformations`
- `insights`
- `model_profiles`
- `model_routes`
- `credentials`
- `embedding_spaces`
- `app_settings`

`source_chunks` 保存可重建文本、locator 和内容哈希；LanceDB 只保存检索副本和向量。任何 LanceDB 删除、损坏或版本不兼容都可以从 SQLite 与应用管理的原始文件重建。

迁移前使用 SQLite Backup API，滚动保留最近三个备份。迁移、Embedding Space 切换、删除清理和重建必须拥有可恢复状态，应用崩溃后由幂等任务恢复。

Embedding Space 固定 Provider、模型、版本、维度、距离、预处理版本和分块版本。切换 Embedding 时创建新 Space、后台重建、校验后原子切换；失败继续使用旧 Space。

## 6. 模块边界

完整实现按以下模块组织，不引入独立服务器：

- `main/settings`：应用设置、首次启动状态与数据目录。
- `main/credentials`：safeStorage 加密、解密和掩码元数据。
- `main/models`：Provider 适配器、发现、连接、流、取消、错误分类和路由。
- `main/sources`：来源、revision、文件管理和安全预检。
- `main/tasks`：SQLite 队列、状态机、恢复和进度事件。
- `workers/ingestion`：解析、分块、Embedding 与索引写入。
- `main/vector`：LanceDB 表、索引、检索、健康、优化和重建。
- `main/retrieval`：ANN、BM25、过滤、RRF、去重和 locator 补全。
- `main/chat`：会话、Token 预算、流式生成、停止、持久化和引用。
- `main/notes`：笔记、AI 标题、转换与洞察。
- `preload` 与 `shared`：版本化命令、事件和 Schema。
- `renderer`：已批准页面、状态与可访问交互。

只在责任确实独立时拆分文件，不引入全局状态库、通用 CRUD 基类、插件系统或未来平台抽象。

## 7. UI 与视觉合同

以下已批准资产是实现基准：

- `docs/ui/foundation/first-launch.png`
- `docs/ui/foundation/empty-project.png`
- `docs/ui/foundation/project-list.png`
- `docs/ui/foundation/create-project.png`
- `docs/ui/foundation/settings-models.png`

实现新增的资料处理、任务失败、索引状态、对话、笔记、转换和路由页面前，必须先生成高保真设计图并获得用户确认。每个页面完成后使用真实 Windows Electron 截图与批准图比较。

## 8. 内部开发顺序与单次发布规则

内部实现按依赖顺序推进，但不生成中间安装包：

1. 设置、凭据、首次启动与 Provider 契约。
2. SQLite 完整实体、任务系统、文件管理和解析器。
3. 本地/云端 Embedding、LanceDB 和 Embedding Space 生命周期。
4. 检索、流式 RAG、引用与会话。
5. 笔记、转换、洞察和模型路由/回退。
6. 全部 UI 状态、双语、主题、可访问性和恢复流程。
7. 完整自动化、真实 Provider 冒烟、全链路样本与最终一次 Windows 打包。

允许在开发中运行 `electron-vite build` 和开发入口 E2E；在第 7 步完成前不得把 `package:win` 产物作为交付物。最终打包前删除或覆盖旧 `dist` 产物，最终哈希只对应通过安装烟测的确切文件。

## 9. 测试与验收

每个生产行为遵循 RED→GREEN。自动测试不得依赖付费密钥，Provider 使用本地模拟 HTTP 服务进行契约测试；真实云端配置只做不记录密钥的人工冒烟。

必须通过：

- 所有 Provider 的发现、生成、Embedding、取消与错误映射契约。
- TXT、MD、URL、PDF、DOCX、PPTX、XLSX、CSV 固定样本解析与 locator。
- 文件签名、路径、URL SSRF、大小、超时和重定向安全测试。
- Worker 进度、取消、崩溃恢复、幂等和重试分类。
- LanceDB 建库、写入、删除、ANN、FTS、优化、损坏检测和全量重建。
- Embedding Space 无损迁移成功与失败回滚。
- RRF、去重、有效 revision 过滤、Token 预算和引用定位。
- 流式消息、停止、重新生成、会话和引用持久化。
- 笔记、AI 标题、内置/自定义转换和幂等 insight。
- 模型任务路由、显式覆盖、允许回退与禁止回退场景。
- 首次启动、设置、所有可见操作、进度/错误/恢复状态的 Electron E2E。
- 中英文和浅深色的键一致性、持久化和运行截图。
- 最终 `.exe` 的全新安装、覆盖安装、无开发环境启动、完整研究链路、重启持久化、卸载清理与用户数据保留。

最终验收需要在一条真实桌面链路中完成：配置模型 → 创建项目 → 逐类导入样本 → 等待索引 → 提问 → 查看/打开引用 → 保存笔记 → 运行内置和自定义转换 → 触发允许的模型回退 → 切换 Embedding 并完成 Space 迁移 → 重建索引 → 重启继续使用。

## 10. 完成定义

只有同时满足以下条件才可以生成并交付最终安装包：

1. 本规格范围内没有永久禁用或“后续提供”的可见功能。
2. 所有支持格式、Provider、Embedding、检索、对话、引用、笔记、转换和路由均有自动化证据。
3. 所有关键页面和错误状态已有用户批准的设计图与真实运行截图对照。
4. 单元、集成、Worker、LanceDB、Electron E2E、类型检查、安全扫描和生产构建全部通过。
5. 最终安装器的大小、SHA-256、打包内容和原生依赖已记录。
6. 安装烟测使用与交付完全相同的哈希；烟测后不再重打包。
7. 明确记录代码签名与独立干净 Windows 环境是否可用，不能用当前主机证据冒充不存在的证据。
