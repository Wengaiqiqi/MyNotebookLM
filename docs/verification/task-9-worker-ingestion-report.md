# Task 9：Worker 解析管线报告

## 完成内容

- 增加版本号为 1 的 worker start/cancel 协议校验与默认并发计算。
- 增加 worker entry，复用现有文本、Markdown、CSV parser 和 chunker。
- 增加真实 WorkerPool 生命周期：并发槽位与 FIFO 排队、worker 工厂边界、5 秒硬终止、监听器/worker 清理、异常/exit 释放槽位。
- 完整校验 version/type/taskId/chunks result schema；取消在 worker 端标记并丢弃竞态结果。
- 增加进度节流（每 task 每秒最多 10 次）。
- 增加 IngestionService 调用链：service 启动共享 WorkerPool，只有成功结果才进入 chunks/revision/task 单事务；worker 失败或取消不写入。
- 增加 crash 恢复：WorkerPool 从 durable payload loader 重新排队原 task，替换 crashed worker 并复用原 Promise；IngestionService 提供 durable loader 注册接口。
- 增加 Vite worker bundle 入口。

## 验证

- RED：先运行新增 WorkerPool 生命周期测试，旧实现直接 new Worker，无法提供排队/可控槽位/完整 schema seam，测试失败；随后实现 GREEN。
- GREEN：Task 9 聚焦测试：2 文件、6 测试通过。
- 相关全量：19 文件、140 测试通过；全量：45 文件、434 测试通过。
- npm run typecheck 通过；npm run build 通过，并生成 out/main/ingestionWorker.js。
- P1 复审补齐：RED 证明 crash 不会恢复；GREEN 验证替换 worker、重派发 durable task 与 service loader 注册。
- 本轮聚焦与相关测试通过：Task9 相关 2 文件/8 tests；相关目录 19 文件/142 tests。
- 本轮复审修复：durable payload loader 保持 Task9 最小注册接口；取消统一返回 `state: cancelled`，worker 异常/超时保持 failed；worker progress 通过 pool callback 接入并由 `throttleProgress` 限频；result chunk 使用完整字段与 locator schema 校验，error 必须为 `{ code, message }`；timeout/error/exit/cancel 共用清理收口，并补充队列取消、progress、严格 schema 端到端契约测试。
- 全量测试仍有 2 个既有主进程/Task10 失败（43 passed、2 failed、438 total）；未修改其 IPC 文件。typecheck 也仍被既有主进程/Task10 文件错误阻断；本轮新增文件无类型错误。build 通过。

## 范围

工作树：D:\fix\mynotebokklm\.worktrees\desktop-foundation。保留了已有无关改动；未修改 Task 10 IPC 文件，也未执行 reset/checkout。
