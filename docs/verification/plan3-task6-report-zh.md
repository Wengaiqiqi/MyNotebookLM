# Plan 3 Task 6 中文报告

实现 Space 生命周期最小闭环：fingerprint 复用、shadow Space 创建、事务式激活、旧 Space 保留、失败终态，以及 verified backup 保留最近三个。

验证：

- 聚焦测试：2 个文件、2 个测试通过
- `npm run typecheck`：通过
- `git diff --check`：通过

文件范围仅包含：`space-repository.ts/test`、`space-service.ts/test`、`vector-backup.ts` 与本报告。用户无关改动及其他代理未提交文件均未纳入提交。

请主模型继续任务
