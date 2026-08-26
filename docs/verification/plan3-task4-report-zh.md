# Plan 3 Task 4：LanceDB 存储报告

## 变更

- 新增 lance-store.ts：真实 LanceDB 临时目录 create/open、按 chunkId upsert、计数、向量搜索、BM25/FTS 搜索、metadata filter、revision/project/space 删除和 close。
- 写入前校验向量维度，并对 locator 做递归键排序的规范 JSON 序列化。
- 通过每个 Space 的进程内 Promise mutex 串行化写入。
- 新增 lance-store.test.ts：真实临时目录覆盖重开、upsert/count、向量搜索、BM25、过滤、删除、维度拒绝和 locator 规范化。

## 验证

- 聚焦测试第 1 次：2/2 通过。
- 聚焦测试第 2 次：待主模型运行。
- npm run typecheck：待主模型运行。
- npm run build：待主模型运行。

请主模型继续任务
