# Task 6 TXT/Markdown/CSV P1 修复报告

日期：2026-08-26

## 修复

- Markdown：解析使用规范化文本，但 fenced code、列表、表格的 offset locator 通过 BOM/CRLF 映射回原始输入，保持 UTF-16 半开区间。
- CSV：分隔符候选仅在所有非空记录宽度一致且实际多列时计分；空行不影响检测，无分隔符不会伪造分列，并列按 comma、tab、semicolon、pipe 的固定顺序确定。

## RED→GREEN

新增 BOM+CRLF Markdown offset、semicolon/pipe、候选字符干扰、单列数据和空行覆盖；先确认回归测试失败，再实现最小修复并通过。

## 验证

- `npx vitest run src/workers/ingestion/parsers/markdown-parser.test.ts src/workers/ingestion/parsers/csv-parser.test.ts`：2 个文件、8 个测试通过。
- `npm run typecheck`：通过。

## 范围

本次提交只包含 Task 6 parser/test/report 文件。工作树中原有的无关改动未暂存、未修改。
