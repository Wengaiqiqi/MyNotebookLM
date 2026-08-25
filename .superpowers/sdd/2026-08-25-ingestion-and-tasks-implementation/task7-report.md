# Task 7 报告：PDF 和 DOCX 解析器

## 实现内容

- 新增 PDF.js PDF 解析器：逐页读取 text content，规范化空白，保持页面顺序；空页不生成空 block，正文 block 使用 page locator。
- 新增 DOCX OOXML 解析器：使用 JSZip 与 fast-xml-parser 读取 word/document.xml，解析标题层级路径、段落、有序/无序列表和表格；表格 block 使用 cell locator。
- 新增 PDF/DOCX golden 测试与确定性 fixture。

## TDD 记录

- RED：先运行测试，两个测试套件因解析器模块不存在而失败。
- GREEN：实现最小解析逻辑后，聚焦测试通过。
- REFACTOR：修正 OOXML XML 树遍历、属性读取和递归文本提取；测试保持通过。

## 验证结果

- 聚焦测试：2 个测试文件，2 个测试通过。
- ingestion 相关全量测试：8 个测试文件，35 个测试通过。
- typecheck：通过。
- sample.pdf SHA-256：4B4013EB0691FD62609C4153A5B6299969D58F323E316E80ED960FEC0BD4BDDE
- sample.docx SHA-256：854CFDD7AE4E014687A57EAA3D3AC29B6F5DDA3BFA22BFD71E9155CAD485C7ED

## 提交

提交信息：feat: parse pdf and docx sources
