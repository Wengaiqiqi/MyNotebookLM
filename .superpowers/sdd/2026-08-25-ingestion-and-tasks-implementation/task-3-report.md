# Task 3 修复报告

## 结果

修复 stageFile 的存储路径绕过：创建来源/修订目录时逐级使用 lstat，拒绝符号链接与 Windows reparse point，避免路径跳出存储根目录。保留原子写入、fsync，并验证失败时临时文件清理。

## TDD RED → GREEN

- RED：新增 symlink/junction 路径绕过测试与最终替换失败清理测试；修复前 2 项失败。
- GREEN：实现逐级安全目录创建和 reparse/symlink 拒绝；3 项聚焦测试全部通过。

## 验证

- 聚焦：npx vitest run src/main/sources/managed-files.test.ts — 3 项通过。
- 相关全量：npx vitest run src/main/sources src/main/db src/main/tasks — 9 个测试文件、91 项通过。
- TypeScript：npm run typecheck — 通过。
- git diff --check — 待提交前执行。

## 改动文件

- src/main/sources/managed-files.ts
- src/main/sources/managed-files.test.ts
- .superpowers/sdd/2026-08-25-ingestion-and-tasks-implementation/task-3-report.md
