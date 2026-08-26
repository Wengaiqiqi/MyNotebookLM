# Task10 主服务复审修复报告

## 工作树

`D:\fix\mynotebokklm\.worktrees\desktop-foundation`

## 修复内容

- URL import：下载 payload 后写入受控托管存储，revision 的 `stored_path` 指向托管文件，不再把 URL 当本地文件路径。
- Durable loader：通过任务绑定的 `revisionId` 恢复对应 revision，避免同一 source 的新旧 revision 串读。
- 应用退出：先关闭 WorkerPool、任务 fanout 与 IPC 清理，再关闭数据库。
- Fanout 生命周期：增加关闭闸门，窗口销毁时跳过已销毁 webContents，避免异步任务继续访问关闭资源。
- 保留既有事务、project ownership 校验与 safe errors。

## 验证

- Typecheck：通过。
- Task10 聚焦：3 个测试文件，9 个测试通过。
- 相关测试：11 个测试文件，99 个测试通过。
- 全量测试：47 个测试文件，447 个测试通过。
- Build：通过。

## 范围

本提交仅包含 Task10 主进程、source orchestration、task update fanout、对应测试与本报告；未提交 Task9 worker 文件，也未包含截图、计划文件等无关改动。
