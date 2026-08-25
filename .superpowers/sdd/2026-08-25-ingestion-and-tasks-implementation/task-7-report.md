# Task 7 修复报告：PDF 与 DOCX 解析

## 修复内容

- DOCX 改为使用 fast-xml-parser `preserveOrder` 遍历 `w:body`，段落、列表、标题和表格按 `document.xml` 原始顺序输出。
- DOCX 表格 locator 根据实际行数和最大列数生成 Excel 风格范围；示例表为 `A1:A2`，不再硬编码或伪造 `A1:B1`。DOCX 不生成页码。
- PDF 每一页都输出 page locator；空页保留空文本 block，因此页码顺序不会因空页而改变。
- 补充/更新 DOCX 覆盖与 PDF 空页真实断言。

## 严格 RED → GREEN

- RED：先将 DOCX 期望顺序改为“表格在列表之前”、期望真实范围 `A1:A2`，并为 PDF 第 2 页加入空页 block；聚焦测试按预期失败，分别暴露“段落/表格拼接排序”和“空页被过滤”。
- GREEN：最小修改解析器后，聚焦测试通过。

## JSZip 资源限制评估

当前 DOCX 路径使用 `JSZip.loadAsync(data)`，只读取 `word/document.xml`，不执行宏、外部关系、评论或嵌入对象；未调用其他文件的解压读取。该 API 会在内存中解析 ZIP，压缩炸弹或高压缩比 DOCX 仍可能造成内存峰值，因此不能把它视为资源隔离。入口的本地文件大小限制仍是第一道防线；后续若需要更强防护，应在 ZIP 读取前增加压缩后总大小/单条目大小/条目数量限制，或改用支持流式读取和配额的 ZIP 实现。当前任务不扩展依赖或引入第二套解压器。

## 验证

- 聚焦解析器：2 个文件，2 个测试通过。
- ingestion 相关：8 个文件，39 个测试通过。
- 全量：42 个文件，410 个测试通过。
- `npm run typecheck`：通过。

## 变更文件

- `src/workers/ingestion/parsers/docx-parser.ts`
- `src/workers/ingestion/parsers/docx-parser.test.ts`
- `src/workers/ingestion/parsers/pdf-parser.ts`
- `src/workers/ingestion/parsers/pdf-parser.test.ts`

## 备注

测试运行时 PDF.js 可能输出 `standardFontDataUrl` warning；不影响测试结果，但后续可在统一 PDF worker 配置中补充字体资源路径。
