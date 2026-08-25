# Task 3 修复报告

日期：2026-08-26
范围：受管存储根目录的 symlink/reparse point 防护（P1）

## P1 修复

`stageFile` 原先只从存储根目录的子段开始执行 `lstat`，因此当 `root` 自身是 junction/symlink 时，会沿链接写入外部目录；同时，检查后再按路径创建临时文件存在 TOCTOU 窗口。现在根目录和中间目录均拒绝 symlink/reparse point，并使用 `openSync(finalPath, "wx")` 直接以 Windows/Node 的 `CREATE_NEW` 语义原子独占创建最终文件：目标已存在或被链接替换时打开失败，不会跟随链接写入错误目标。

## RED → GREEN

- RED：新增“根目录自身为 junction 时拒绝写入”和“最终 staging 路径为 junction 时不写入外部目录”的回归测试；旧实现无法安全拒绝后者。
- GREEN：加入根目录 `lstat` 检查，并将最终文件改为 `wx` 原子独占创建；聚焦测试通过。

## 验证

- 聚焦：`src/main/sources/managed-files.test.ts`，5 tests passed。
- 相关全量：`src/main/sources`，5 files / 32 tests passed。
- TypeScript：`npm run typecheck` 通过。
- 仓库全量：41 files / 410 tests passed，1 个既有的 `docx-parser.test.ts` 转换语法错误导致 suite 失败；该错误位于本任务范围外。

## 变更文件

- `src/main/sources/managed-files.ts`
- `src/main/sources/managed-files.test.ts`
- `docs/verification/task-3-report.md`
