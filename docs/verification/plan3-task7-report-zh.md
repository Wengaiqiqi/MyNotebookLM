# Plan 3 Task 7 实现报告

## 范围

新增 `rrf.ts`、`rrf.test.ts`、`retrieval-service.ts` 与 `retrieval-service.test.ts`。

## 实现

- 使用 RRF 默认 `k=60`，按 content hash 合并重复候选并稳定排序。
- ANN 与 BM25 查询通过 `Promise.all` 并行执行。
- 查询结果回到 SQLite 复验 project、active source、current revision、ready revision，并从 SQLite hydrate 权威文本与 locator。
- 结果按 source 的邻近 ordinal 做多样性处理，默认最多 4 个相邻候选。
- 缺少 active Space、嵌入失败或索引查询失败时返回可修复的 `INDEX_UNAVAILABLE` 错误。
- provider 可注入，查询嵌入使用现有 `EmbeddingProvider`。

## 验证

- RED：新增测试在实现缺失时失败。
- GREEN：聚焦测试 2 个文件、4 个测试通过。
- `npm run typecheck`：通过。
- `git diff --check`：通过。

请主模型继续任务。
