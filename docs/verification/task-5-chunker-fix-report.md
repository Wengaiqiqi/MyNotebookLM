# Task 5 修复轮报告：确定性分块器修正

Date: 2026-08-26
Scope: Task 5 chunker token estimation, chunk splitting, and locator range merging
Commit: `3dbd112` fix: correct chunker token estimate and locator ranges

## 评审指出的问题与修复

1. **无空格 CJK/英文 token 估算**：`estimateTokens` 原先按 `\s+` 分词，把 `ab你cd` 当作一个词导致低估。修复后以 CJK 码点与标点作为词边界逐字符扫描，`ab你cd` 计为 `ab` + `你` + `cd` 三个单元（1 CJK + 2 词 = 4 token）。
2. **900 上限兜底**：`splitByTokens` 原先只按空白分词，无法拆分无空格的超长 CJK 或混排串。新增 `tokenizeForChunk` 把文本切成 CJK 单字 / 词 / 标点单元后再贪心打包，保证任一分块片段 token 估算不超过上限。
3. **paragraph locator 丢范围**：`mergeLocators` 原先对 paragraph 只取 `Math.min(paragraph)` 丢上界。修复后输出 `{ paragraph, endParagraph }`。
4. **非 offset/row/paragraph locator 丢范围**：page/slide 现在合并为 `{ page, endPage }` / `{ slide, endSlide }`，不再退化为 `return first`。
5. **混合 locator 丢范围**：数值型 locator（offset/row/paragraph/page/slide）均按同 kind 合并为区间；真正跨 kind 的混合仍受单值 `SourceLocator` 约束，保留首个 locator。
6. **标点计数**：纯标点（`...`、`，。！？`）不再被计为词或 CJK，估算为 0 token。
7. **ceil 偏高**：非 CJK 词数改为仅对真实词计数，CJK 字独立计数，避免把无空格混排当整词放大。
8. **table 原子块超限**：原先 table 无条件作为单一原子块，超限仍塞进一块。现在 table 超限会按 token 目标切分成多个原子片段（`isAtomic: true`），既不参与 overlap 又满足 900 上限；小 table 仍保持单块原子。

## Schema 扩展

`src/shared/sources.ts` 的 `sourceLocatorSchema` 为 `page`/`slide`/`paragraph` 增加可选 `endPage`/`endSlide`/`endParagraph` 字段（含 `end >= start` 校验）。这是 locator 范围输出的必要契约扩展；单值输入仍向后兼容。

## 验证证据

- Task 5 聚焦测试 `npx vitest run src/workers/ingestion/chunker.test.ts`：25 个测试全部通过（含 8 个新增失败测试，先经 RED 确认再转 GREEN）。
- `npx vitest run src/shared/schemas-strict.test.ts`：5 个 schema 测试通过。
- 全量 `npx vitest run`：32 个测试文件、387 个测试全部通过。
- `npm run typecheck`（tsconfig.node + tsconfig.web）：通过，退出码 0。
- 双语 fixture 快照已随新估算与 locator 输出重新生成，连续两次运行字节一致。

## 边界说明

真正的跨 kind 混合 locator（例如同一 chunk 同时含 paragraph 与 offset）仍受单值 `SourceLocator` 约束，`mergeLocators` 保留首个 locator。若下游需在混合 chunk 内同时保留多种 locator，需将该字段扩展为数组，属更大契约变更，本轮未引入。

## 涉及文件

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `src/workers/ingestion/chunker.ts` | 修改 | 词边估计、token 拆分、locator 范围合并、table 超限分片 |
| `src/workers/ingestion/chunker.test.ts` | 修改 | 新增 8 项失败测试并修正 table 原子边界用例 |
| `src/workers/ingestion/__snapshots__/chunker.test.ts.snap` | 修改 | 随新估算与 locator 输出更新 |
| `src/shared/sources.ts` | 修改 | 为 page/slide/paragraph 增加可选 end 字段 |

## 未包含的无关改动

以下预先存在、与本任务无关的改动未暂存、未提交：`docs/superpowers/plans/2026-08-24-desktop-foundation-implementation.md`（删除）、`docs/verification/screenshots/onboarding-zh-light.png` / `settings-en-dark.png`（修改）、`docs/superpowers/2026-08-24-desktop-foundation-implementation.md`（新增）。
