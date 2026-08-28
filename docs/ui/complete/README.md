# Complete UI Visual Baseline and Evidence Contract

## Approval

- **状态：** 已批准采用现有 Foundation UI 基线；七张新的生成式 mockup 已豁免，不代表七张 PNG 已生成或已批准。
- **书面批准日期：** 2026-08-28。
- **批准决定：** 不运行 imagegen，不创建 `source-import.png`、`source-task-error.png`、`index-space.png`、`research-chat.png`、`notes.png`、`transformations.png` 或 `model-routing.png`。功能页直接沿用现有视觉，最终以真实 Windows Electron 截图作为逐页证据。

## 基线

- 视觉契约：`docs/ui/foundation/README.md`
- 已批准基础图：
  - `docs/ui/foundation/first-launch.png`（当前文件：1586×992）
  - `docs/ui/foundation/empty-project.png`
  - `docs/ui/foundation/project-list.png`
  - `docs/ui/foundation/create-project.png`
  - `docs/ui/foundation/settings-models.png`
- 几何规则：延续基础图的全窗口布局与信息层级；本次不生成固定 1600×1000 的中间稿。真实 Electron 截图必须记录实际像素尺寸、语言、主题和所处状态。

## 一致性规则

- 暖白表面、炭色文字、克制靛蓝强调；浅色和深色保持相同信息层级。
- 左侧保留项目导航，设置、`中文 | EN`、`浅色 | 深色` 位于导航底部并保持紧凑居中。
- 应用表面连续覆盖标题区域；右上角保留原生 Windows 最小化、最大化、关闭控件，不出现分离的标题色带。
- 对话框相对完整应用视口数学居中，遮罩覆盖侧栏和工作区，并支持焦点陷阱与恢复。
- 所有可见操作必须可执行，或提供具体的导入、设置、索引、网络等修复动作；不得加入永久禁用占位入口。
- 不加入播客、音频、语音、麦克风、TTS、STT 或音视频界面。
- 中文与英文必须使用同一状态和操作层级；深色主题只改变变量与对比度，不改变布局语义。

## 功能页状态与交互证据

下表记录的是功能页必须开放的能力与几何约束，不是七张不存在的 PNG 清单。`待真实截图` 由对应功能 Task 和 Gate F 完成。

| 页面 | 负责 Task | 必须开放的状态与操作 | 几何/证据状态 | 生成方式与 prompt set |
| --- | --- | --- | --- | --- |
| source-import | Task 3 | 文件/URL 导入、支持格式说明、来源校验、队列/阶段进度、取消、重试/删除、来源选择与重启恢复、已填充来源列表 | Foundation 全窗口布局；待 Task 3 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |
| source-task-error | Task 3 | 可读失败原因、重试、移除、打开设置、检查/重建索引；对话框覆盖完整视口并居中 | Foundation 全窗口布局；待 Task 3 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |
| index-space | Task 4 | Space 指纹、模型下载/构建进度、健康/不可用/损坏/失败状态、优化、重建、迁移、取消及失败后保留旧 Space 的回滚路径 | 设置工作区沿用 Foundation 导航与窗口几何；待 Task 4 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |
| research-chat | Task 5 | 会话新建/选择/重命名/归档/删除、引用流式回答、来源 chips、引用详情及打开原文件/URL、停止、复制、重新生成、模型覆盖、回退提示和导入/设置/重建修复动作 | 工作区可含引用详情侧栏，但仍是单一连续窗口；待 Task 5 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |
| notes | Task 6 | Markdown 编辑与安全预览、来源/消息/引用关联、新建/编辑/归档/恢复/删除、保存冲突处理、显式 AI 标题动作及失败保留原标题和正文 | Foundation 全窗口布局；待 Task 6 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |
| transformations | Task 6 | 摘要、要点、Q&A、自定义规则；四个明确文本占位符校验；运行进度、取消、重试、幂等洞察结果和转换为笔记 | Foundation 全窗口布局；待 Task 6 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |
| model-routing | Task 7 | 按任务配置首选/有序回退、能力过滤、重复阻止、Embedding 单配置约束、可访问的上移/下移排序、显式覆盖与回退历史 | 设置工作区沿用 Foundation 导航与窗口几何；待 Task 7 记录真实 Electron 截图 | 未生成；imagegen 豁免；prompt set：N/A |

## Gate F 要求

Gate F（打包前）仍必须满足：每个新增功能视觉都有书面批准记录，并在状态有差异时保存真实 Windows Electron 截图。截图要求如下：

1. 至少覆盖 `zh-CN/light` 与 `en/dark`；若某状态或布局存在差异，分别捕获并记录。
2. 截图放在 `docs/verification/screenshots/`，并在最终验证台账中逐页映射到对应 Task、运行状态、实际尺寸与本 README 的基线规则。
3. 截图必须来自真实 Electron 窗口，包含连续应用表面、左侧项目导航和右上原生窗口控件；不得用本次豁免的生成图代替。
4. Gate F 完成前不得把本 README 或任一功能页描述为已有最终运行证据；本次文档只完成视觉决策收口。

本 README 的批准状态只适用于“复用 Foundation 基线、免除七张新 mockup”的决定；不提前批准任何尚未完成的功能实现或 Gate F 截图。
