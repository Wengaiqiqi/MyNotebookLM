# Task 6 实现报告

## 完成内容

- 新增 UTF-8 TXT 解析：处理 BOM、CRLF/LF、空段落，并生成段落定位。
- 新增 Markdown 解析：生成标题层级、标题祖先、列表、代码和表格文本块。
- 新增 CSV 解析：检测常见分隔符，保留带引号的逗号与换行，输出表头映射和 CSV 行定位。
- 为三类解析器增加 golden 测试、规范化快照和文档 fixture。

## TDD 记录

先编写测试并确认解析器模块缺失导致 RED；随后补充最小实现，三组测试 GREEN；最后合并重复的 UTF-8/BOM/换行规范化逻辑思路并保持测试通过。

## 验证

- 聚焦测试：3 个测试文件、3 个测试通过。
- typecheck：未通过，仓库已有的 `src/main/sources` 测试引用三个尚未提供的模块：`file-preflight`、`managed-files`、`source-repository`。
- 相关 parser 全量：task6 三组通过；已有 PPTX 测试失败，未修改其任务文件。
