# Task 3 修复报告

日期：2026-08-26
范围：受管存储根目录的 symlink/reparse point 防护与原子文件写入（P1）

## P1 修复

`stageFile` 原先直接用 `openSync(finalPath, "wx")` 创建最终文件，再写入并 `fsync`；写入或同步失败会留下残缺的 `content`，读者也可能看到半成品。现在根目录和中间目录继续拒绝 symlink/reparse point，并在受控 revision 目录内以独占临时文件写入、`fsync`、关闭后再原子 `rename` 到最终路径；失败只清理本次临时文件，最终文件不被破坏。

## RED → GREEN

- RED：新增 fsync 失败后无最终文件、可重试，以及 rename 前最终 `content` 不可见的回归测试；旧实现分别留下 `content`，且没有独立的 rename 阶段。
- GREEN：改为受控目录内独占临时文件写入并同步，关闭后原子 rename；失败清理临时文件，聚焦测试通过。

## 验证

- 聚焦：`src/main/sources/managed-files.test.ts`，7 tests passed。
- 相关全量：`src/main/sources`，5 files / 34 tests passed。
- TypeScript：`npm run typecheck` 通过。
- 仓库全量：41 files / 410 tests passed，1 个既有的 `docx-parser.test.ts` 转换语法错误导致 suite 失败；该错误位于本任务范围外。

## 变更文件

- `src/main/sources/managed-files.ts`
- `src/main/sources/managed-files.test.ts`
- `docs/verification/task-3-report.md`
