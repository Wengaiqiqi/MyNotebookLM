# Task 3 修复报告

日期：2026-08-26
范围：受管存储根目录的 symlink/reparse point 防护与原子文件写入（P1 最终复审）

## P1 修复

`stageFile` 现在在受控 revision 目录内以独占临时文件写入并 `fsync`，再尽力关闭；若写入/同步与关闭同时失败，保留最初的写入/同步错误，并尽力清理临时文件。最终提交使用同目录 `linkSync`：目标已存在时原子失败，不覆盖已有 `content`，随后删除临时文件。目录链通过 `lstat` 与 `realpath` 交叉检查，拒绝可观察到的符号链接或目录 junction/reparse 路径。

## RED → GREEN

- RED：新增 close 与 fsync 同时失败保留原错误、临时文件清理、重复提交保留已有 content，以及 reparse-like 目录链拒绝测试。旧实现会抛出 close 错误并允许 `renameSync` 覆盖已有 content。
- GREEN：实现错误优先级与尽力清理；以同目录硬链接提交实现原子 no-overwrite 语义；以 `lstat`/`realpath` 组合检查目录链。
- 平台限制：Node 的 `lstat`/`realpath` 可验证符号链接和 junction 等可解析 reparse 路径；本测试环境未提供可稳定构造的所有 Windows reparse tag，因此未声称覆盖不可解析的任意 tag。

## 验证

- 聚焦：`src/main/sources/managed-files.test.ts`，10 tests passed。
- 相关全量：`src/main/sources`，5 files / 37 tests passed。
- TypeScript：`npm run typecheck` 通过。
- `git diff --check`：通过（仅 Git 提示工作树换行符将转换为 CRLF）。
- 仓库全量：41 files / 410 tests passed，1 个既有的 `docx-parser.test.ts` 转换语法错误导致 suite 失败；该错误位于本任务范围外。

## 变更文件

- `src/main/sources/managed-files.ts`
- `src/main/sources/managed-files.test.ts`
- `docs/verification/task-3-report.md`
