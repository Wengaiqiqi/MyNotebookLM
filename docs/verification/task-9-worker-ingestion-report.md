# Task 9：Worker 解析管线报告

## 完成内容

- 增加版本号为 1 的 worker start/cancel 协议校验与默认并发计算。
- 增加 worker entry，复用现有文本、Markdown、CSV parser 和 chunker。
- 增加 worker pool：5 秒硬终止、取消转发、异常后释放 worker。
- 增加进度节流（每 task 每秒最多 10 次）。
- 增加解析结果的单事务写入：chunks、revision 状态和 task running/awaiting_embedding 同步更新。
- 增加 Vite worker bundle 入口。

## 验证

- RED：新增测试在实现前因目标模块不存在而失败。
- GREEN：Task 9 聚焦测试通过，2 个测试文件、3 个测试全部通过。
- git diff --check 通过（仅报告换行转换提示）。
- npm run typecheck 的剩余失败来自预先存在的 Task 10 文件缺失：src/main/ipc/register-source-handlers.test.ts 引用尚未实现的 register-source-handlers 与 SOURCE_CHANNELS；Task 9 文件无类型错误。

## 范围

只修改了 Task 9 指定源码、Vite 配置和本报告；未修改 Task 10 文件，也未执行 reset/checkout。
