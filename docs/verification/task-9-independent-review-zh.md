# Plan 2 / Task 9 中文独立复审

复审对象：提交 25aad6d 及其后续集成（当前 HEAD 28e1693）。

范围：worker 消息 schema、并发上限、进度 10/s、取消与 5 秒硬终止、崩溃替换/恢复、事务写入、bundle 配置、测试边界。

## 结论

**阻止通过。存在 P1/P2。** 当前测试绿灯只覆盖协议解析和默认并发计算，未覆盖真实 worker 生命周期，也未证明 Task 9 已接入生产 ingestion 流程。

## Findings

### P1 — Task 9 worker 管线没有接入生产调用路径

位置：src/main/tasks/worker-pool.ts:18-33、src/main/sources/ingestion-service.ts:3-9。

WorkerPool、throttleProgress、persistParsedResult 在源码中没有任何生产调用方；搜索仅命中定义和测试。现有 source/task handler 不能因此自动使用 worker、进度节流或事务落库。提交交付了孤立组件，而不是可运行的 ingestion 集成，Task 9 的核心行为在应用内不会发生。

### P1 — 声称的并发上限未实现

位置：src/main/tasks/worker-pool.ts:19-23。

构造函数只保存 concurrency，start() 每次调用都立即 new Worker，没有队列、活动槽位计数或拒绝策略。因此连续调用 3 次（默认上限 2）会创建 3 个 worker；concurrency 只是公开字段，不是运行时约束。

### P2 — 取消不可靠，且取消后仍可能提交结果

位置：src/workers/ingestion/worker-entry.ts:8、src/main/tasks/worker-pool.ts:25-31。

worker 收到 cancel 只 return，没有取消状态；若 cancel 与 start/解析竞态，解析完成后仍会发送 result。主线程也没有按 task 保存 promise/worker 状态，不能把取消映射为稳定的任务结果或阻止后续持久化。测试没有覆盖取消竞态、取消中的任务和取消后的结果。

### P2 — worker 生命周期清理不完整，崩溃替换未实现

位置：src/main/tasks/worker-pool.ts:23-32。

成功消息和 5 秒超时路径调用 terminate()，但没有从 workers Set 删除 worker；超时路径也没有等待终止完成或清理监听器。error 路径虽删除 worker，但没有替换 worker、重试任务或通知任务服务恢复。现有“崩溃恢复”测试只验证 SQLite 中 stale running task 的重排队，未验证 worker 崩溃后的替换/恢复链路。

### P2 — worker 返回消息没有完整 schema 校验

位置：src/main/tasks/worker-pool.ts:26。

只检查返回对象的 type === result，直接把未知对象断言成 WorkerResult；未校验 version、taskId、chunks 结构和 chunk 字段。worker 的 error 消息也没有专门 schema，错误内容仅作为 Error 字符串发送。输入 start 校验同样只检查 kind 是任意字符串，未限制到支持的 kind。

## 已执行验证

- Task 9 聚焦：npx vitest run src/main/tasks/worker-pool.test.ts src/main/sources/ingestion-service.test.ts → 2 files / 3 tests passed。
- 相关测试：npx vitest run src/main/tasks src/main/sources src/workers src/shared → 19 files / 137 tests passed。
- typecheck：npm run typecheck → exit 0。
- bundle：npm run build → exit 0，生成 out/main/ingestionWorker.js。
- git diff --check 25aad6d^..HEAD 与工作树 git diff --check → exit 0。

## 测试边界

当前测试只验证：无版本/畸形输入会被拒绝、默认并发函数返回 2、单秒内最多发出 10 次。缺失：实际 worker 启动与结果校验、并发 2 槽位上限、排队、取消竞态、5 秒终止后的清理、worker error 后替换/任务恢复、事务失败回滚，以及从 source handler 到 worker 到 SQLite 的端到端链路。

## 复审决定

P1/P2 阻止通过。请主模型继续任务。

## 本轮独立复审补充实测

- 聚焦测试：2 files / 8 tests passed。
- 相关测试：19 files / 138 tests passed。
- 全量测试：46 files / 439 tests passed。
- typecheck：exit 0。
- build：exit 0，生成 out/main/ingestionWorker.js。
- git diff --check 25aad6d^..d2bb144：exit 0。

补充结论：应用启动未向 WorkerPool 注册 durable payload loader；活动任务取消会等待硬终止并由上层统一标记 failed；进度节流 helper 没有真实生产调用方；result 仅校验 chunks 为数组，未校验 chunk 字段，且 error 消息没有 schema。上述 P1/P2 仍阻止通过。
