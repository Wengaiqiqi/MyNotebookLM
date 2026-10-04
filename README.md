# MyNotebookLM

本地优先的 Windows 桌面研究助手，思路类似 NotebookLM：把文档和网页导入到项目中，基于这些来源进行带引用的问答，并生成笔记、测验、思维导图和播客。

## 功能

- **来源导入**：txt、Markdown、CSV（UTF-8、UTF-16 或 GBK/GB18030 编码）、PDF、Word、PowerPoint、Excel，以及网页 URL。
- **带引用的问答**：基于 SQLite 和 LanceDB 的混合检索（向量 + 全文），回答中的 `[S1]` 引用可以定位到原文。
- **Studio**：笔记、内置转换、测验、思维导图、播客。
- **模型提供方**：OpenAI 及兼容接口、Anthropic、Gemini、Ollama；也提供内置的本地 embedding 模型。API Key 使用系统 `safeStorage` 加密保存。
- 界面支持中文和英文。

## 开发

需要 Node.js 22。

```bash
npm ci
npm run dev          # 启动开发版
npm run typecheck    # 类型检查
npm run build        # 构建到 out/
npm test             # 单元测试（ingestion worker 集成测试需要先 build）
npm run test:e2e     # Playwright 端到端测试（需要先 build）
npm run package:win  # 打包 Windows 安装程序
```

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/main` | Electron 主进程：数据库、导入、检索、聊天、模型调用、IPC |
| `src/preload` | 通过 `contextBridge` 暴露给页面的受校验 API |
| `src/renderer` | React 界面 |
| `src/workers` | 文档解析与引用预览的 worker 线程 |
| `src/shared` | 主进程和页面共用的 zod schema 与类型 |
| `src/main/db/migrations` | SQLite 迁移脚本 |
| `e2e` | Playwright 端到端测试 |
| `docs` | 需求、设计与验收文档 |

用户数据保存在 Electron 的 `userData` 目录下（Windows 上为 `%APPDATA%\MyNotebookLM`）。
