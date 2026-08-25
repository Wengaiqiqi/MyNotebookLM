# Task 3 修复报告

日期：2026-08-26
范围：受管存储根目录的 symlink/reparse point 防护（P1）

## P1 修复

`stageFile` 原先只从存储根目录的子段开始执行 `lstat`，因此当 `root` 自身是 junction/symlink 时，会沿链接写入外部目录。现在在创建或检查子目录前先对根目录执行 `lstat`，拒绝 symlink/reparse point，并拒绝非目录根路径。

## RED → GREEN

- RED：新增“根目录自身为 junction 时拒绝写入”的回归测试；旧实现未抛错。
- GREEN：加入最小根目录 `lstat` 检查；聚焦测试通过。

## 验证

- 聚焦：`src/main/sources/managed-files.test.ts`，4 tests passed。
- 相关全量：`src/main/sources`，5 files / 31 tests passed。
- TypeScript：`npm run typecheck` 通过。
- 仓库全量：41 files / 410 tests passed，1 个既有的 `docx-parser.test.ts` 转换语法错误导致 suite 失败；该错误位于本任务范围外。

## 变更文件

- `src/main/sources/managed-files.ts`
- `src/main/sources/managed-files.test.ts`
- `docs/verification/task-3-report.md`
