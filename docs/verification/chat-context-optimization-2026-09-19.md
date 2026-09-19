# 聊天上下文优化执行验证记录

## 最新三项边界修复（2026-09-20）

本节是最新验证结果，后文1039项等数字为前轮记录。

- 半截引用：正文结尾为 `[`、`[S`、`[S1` 等时判为证据不确定，续写保留原证据；空间不足明确拒绝且不改变原回答。恢复足够预算后可接完标签并正确保存引用。代码区域中的相同字符不触发此规则。
- 用量完整性：分别记录输入/输出字段是否已知，每次备用尝试重置；只有两字段已知、正常终态且历史累计完整时标记完整。断流、取消、缺字段或前次统计不完整均保持 `usageComplete=false`，已知数值仍累加且不重复结算。
- 初次异常终态：失败/取消在同一事务保存正文对应引用、已知用量、消息状态和运行摘要，再发送终态。写入失败回滚并保留checkpoint；重启对初次生成也重建引用，恢复两次不会重复写入或累加。

新增12项回归（含参数化）：citation-parser 的四种半截标签；chat-service 的半截标签预算拒绝与恢复、三种用量状态、三种初次异常终态、部分续写用量持续不完整。

验证：全量102个文件、1051通过、1跳过；类型检查、main/preload/renderer构建、差异检查通过。未运行E2E或真实服务、未操作用户数据库、未提交或推送。本次结论仅为已确认的三项缺陷修复完成，不重新宣称整期无遗漏。

---

## 2026-09-20 整期复核与统一修复（最新结论）

本节覆盖后文早期记录。完成一次按 A01～A24 的跨模块核对、统一修复和最终回归；不再以单个补丁通过替代整期检查。代码级交付与真实服务/用户界面验收分开记录，未宣称软件绝无缺陷。

### 本次统一处理的缺陷

- 历史时间边界同时限制用户问题及助手回复，重生成不会读取后生成的回复；用户历史字面量保留，助手正文只清理代码区域外的合法引用，拒绝前导零。
- 实际发送前复核项目资料状态、版本、hash；备用大窗口按需补充历史及候选，同一个请求通过 AbortSignal 复用一次 embedding，固定本轮模型路由快照。旧续写快照即使缺少版本元数据也检查来源归属、当前版本及可用状态。
- 续写校验原问题仍一致，claim、快照及输出额度写入同一事务；开始事件和重启恢复使用本次额度，准备阶段失败回滚原回答。异步准备后再次检查取消，不调用已取消的模型请求。
- 引用快照使用实际发送的切片；同一 DOCX 表格的不同片段保留独立引用定位；证据名称/位置同样转义包装分隔符。
- 保留流式失败的安全 details，续写失败发失败事件并保留正文；识别不同输出参数错误、上下文窗口结束原因，错误正文受取消控制，任意 details 不透传。
- 分开发送的输入/输出 usage 采用字段级累计快照，不清零上一字段、重复事件不重复累加。
- 独立输入上限同时存在总窗口时，两个约束共同生效；缓存模型能力检查连接身份，能力发现返回时重新核验接入地址。
- 前端拒绝发送时撤回未落库的临时问题；只给最新回答展示继续按钮；补充中断原因、容量错误/中断的设置入口、未知上限提示、模型配置的作用范围及服务商输出能力上限。保持原布局和提供商表单，不做视觉重设计。
- 邻居读取按 revision/ordinal 窗口复用查询，减少重叠的数据库读取。

### A01～A24 自动化证据索引

下表是代码/组件/本地集成证据，不代表所有服务商或实际界面人工验收。

| 验收 | 可重复证据 | 验证边界 |
| --- | --- | --- |
| A01 | Settings.test.tsx 的 provider editor 与批量保存测试；ModelForm.test.tsx | 原提供商流程组件回归 |
| A02 | ModelAdvancedForm.test.tsx：only saves the two advanced fields；Settings 模型编辑测试 | 只有两个数值输入，不含 URL/Key |
| A03 | ModelAdvancedForm.test.tsx；chat-service.test.ts 的高级配置本地保存校验 | 保存无发现/凭据调用，拒绝非法组合 |
| A04 | settings-repository.test.ts：preserves advanced settings on provider save and restart | 提供商保存不清手动值，明确 null 才恢复 |
| A05 | database.test.ts：upgrades 014 to generation limits and contexts；settings-repository 重开测试 | 真实测试库升级、FK、参数重开 |
| A06 | generation-limits.test.ts；context-builder 默认预算测试；高级表单默认提示 | 未知能力默认可用 |
| A07 | context-builder 超过32测试；benchmark 的 short-48/citations-128/capacity-route | 48/128/244 片段实际进入请求布局 |
| A08 | chat-service.test.ts：keeps S100 through repeated length stops；SafeMarkdown/parser 测试 | S100 持久化与续写、标签校验与渲染 |
| A09 | context-builder 完整历史预留/补充/裁剪；history-500 benchmark | 历史读取不读取全部引用 |
| A10 | chat-service.test.ts：excludes a later regenerated answer；context-builder 历史字面量与代码测试 | 时序、配对与代码保真 |
| A11 | chat-service 小备用快照测试、expands evidence and history for a larger fallback | 各模型独立预算和引用，路由仅解析一次 |
| A12 | context-builder fixed overflow；chat-service 小窗口与配置拒绝 | 不截断当前问题，不调用超限请求 |
| A13 | chat-service length/empty length/incomplete；ChatPane 空正文失败测试 | 正常截断与异常区分 |
| A14 | http-client.test.ts 长流、事件保护、超时/取消测试 | 本地模拟响应，不代表真实服务吞吐 |
| A15 | retrieval-service 归属与版本测试；chat-service deleting/revision/hash 参数化测试 | 检索后失效阻断、索引错误显式报告 |
| A16 | chat-service send/regenerate/continue；useChatStream/IPC/preload | 同链路预算与订阅/终态 |
| A17 | settings-repository 身份失效与保留覆盖；model-service 连接绑定测试 | 地址/模型身份隔离 |
| A18 | generation-limits 独立输入/输出测试、context-builder 双上限测试 | 不从上下文推算输出能力 |
| A19 | chat-service S100 连续生成修改额度；useChatStream 编辑被拒绝测试 | 新额度生效，拒绝时不改原问题 |
| A20 | Settings 深链接/缺失配置处理；ChatPane 实际模型设置入口 | 不按同名模型代替目标 ID |
| A21 | chat-service S100 连续两次 length；rag-integration 重开续写 | 同一回答追加，不新增用户问题 |
| A22 | chat-service 中断/重复 request/终态失败/claim rollback/recovery；routed-generation prepare cancellation | 恢复与事务、重复用量防重 |
| A23 | chat-service legacy source deletion/question changed/stale capacity；context-builder 必需证据超限 | 不换模型、不丢固定输入 |
| A24 | chat-service S100 三次 usage；rag-integration 两次重开后 stop | 单次额度与累计用量分开 |

### 固定本地基准

命令：`node scripts/benchmark-chat-context.cjs`。每组预热一次、20 次计时；真实内存 SQLite、生产检索/组装/引用逻辑，向量/关键词结果和 embedding 为固定模拟。Git 对照为运行时 HEAD，本次为 `17211d1`。不联网、不读取用户资料。

最新一轮，单位 ms，数值为中位数 / P95：

| 样本 | 最终证据 / 输入估算 | 检索 | 组装 | 引用落库 |
| --- | --- | --- | --- | --- |
| 8 片段小项目 | 8 / 1023 | 0.625 / 0.919 | 0.082 / 0.148 | 0.531 / 0.850 |
| 48 短片段 | 48 / 3021 | 1.126 / 1.647 | 0.234 / 0.377 | 2.048 / 2.531 |
| 128 引用 | 128 / 7064 | 4.611 / 11.363 | 0.297 / 0.497 | 6.738 / 10.321 |
| 500 轮历史 | 48 / 4075 | 1.400 / 1.745 | 0.151 / 0.208 | 1.978 / 2.568 |
| 160 表格片段 | 160 / 10352 | 3.919 / 6.007 | 0.561 / 0.632 | 8.595 / 11.905 |
| 384 候选、容量扩展 | 244 / 13038 | 16.284 / 22.900 | 0.495 / 0.739 | 14.023 / 23.045 |

同成本对照：六组至多32个相同候选的组装/检索/引用落库中位数均未出现 >10% 回退。以48片段样本的32个相同输入为例：检索 2.502→0.715、组装 0.144→0.069、引用落库 17.394→1.793。500轮历史全消息读取 129.885/150.678，对照最近32对正文查询 0.176/0.219；这是按需读取与全量读取的机制差异，不是相同返回数据量的纯 SQL 加速。

所有样本停止原因为 exhausted；初始每路96，最多扩展到768；384个候选只有244个通过相关性/去重/结构限制，不把剩余140个宣称为全部相关。备用扩展只调用1次 embedding。邻居查询修复前后384样本的两轮观测约59→11ms，最新综合轮16.284ms，受系统负载影响，不作为稳定倍数承诺。

内部参数：默认容量32768、输出8192、安全余量max(512,10%)、历史预留25%、首轮候选96、扩展2倍、每路保护4096、最低证据预算96、候选正文32MiB、结构补充25%、相对首位RRF阈值0.2、邻居窗口32、权威读取批次400、流8～64MiB、单事件1MiB、错误正文16KiB/总2秒/单次等待250ms。

估算语料覆盖中文/无空格英文/代码/URL/表格/混合符号；旧→新估算分别400→600、2→575、67→550、2→571、2→440、2→640。这里证明旧规则严重低估无空格文本，不能证明新规则与真实token一致；全部标为未校准。UTF-8/2是保守起点，真实首字时间、回答质量、费用和token误差仍未测。

### 最终验证与剩余边界

- 全量自动化：102个文件，1039通过、1跳过；较本轮开始新增24项测试。类型检查、生产构建、差异检查通过；界面静态检查未报告问题。
- 本地基准六组、A01～A24证据索引已补齐。默认开发验证范围可收尾；不将其表述为真实服务/人工界面/安装包已验收。
- 未执行真实付费服务调用、E2E或安装包；未提交、推送，没有操作用户数据库或资料。
- 续写快照仍保存必要正文副本以保证原请求重放，未改为单独历史hash索引；现有引用版本元数据缺失的旧快照只能检查当前归属/状态，不能补造过去的hash。
- 相同请求扩大候选时复用embedding，但会重跑有界排序查询；未引入跨请求缓存或新的检索服务。

---

日期：2026-09-19；最近修复：2026-09-20

对应文档：`docs/prd/2026-09-19-chat-context-optimization.md`

## 交付范围

- 已保留现有项目级资料范围：导入且有效、当前、可用的资料继续属于检索范围；没有引入“当前选中资料”概念。
- 已将原模型编辑入口明确为“编辑提供商配置”，新增“编辑模型配置”只负责上下文容量和最大输出长度，并且保存不联网。
- 已实施预算驱动的历史、检索、流式输出和手动继续生成链路。
- 未实施自动/全面模式切换、全面读取项目全文、自动续写或自动提高输出额度。

## 任务结果

### T1：模型参数和编辑入口

新增模型生成能力的迁移、共享 DTO/schema、解析纯函数、repository 局部更新、IPC/preload 和 `ModelAdvancedForm`。未知模型能力使用明确的保守默认值：上下文 32,768 tokens、输出 8,192 tokens；手动值只覆盖对应字段。provider 配置仍负责 URL、Key、模型发现等原有字段，model 配置不重复保存这些字段。

主要文件：

- `src/main/db/migrations/015_model_generation_limits.sql`
- `src/main/models/generation-limits.ts`
- `src/main/settings/settings-repository.ts`
- `src/main/models/model-service.ts`
- `src/shared/models.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/features/models/ModelAdvancedForm.tsx`
- `src/renderer/src/features/settings/Settings.tsx`

### T2：预算、历史和证据

使用有效上下文窗口扣除输出额度和安全余量后计算输入预算；历史按完整用户/助手对读取，历史预留为可用输入预算的 25%，证据预算由剩余额度决定。生成前不再读取全历史或以固定 32 条作为最终证据上限。上下文组装返回 `selectedEvidence` 和历史消息 ID，供引用保存与续写快照使用。

主要文件：

- `src/main/chat/context-builder.ts`
- `src/main/chat/conversation-repository.ts`
- `src/main/chat/chat-service.ts`
- `src/main/models/generation-limits.test.ts`

### T3：检索与引用

聊天检索使用本轮证据 token 预算计算候选目标，首轮每路 96 条并按 2 倍扩容，候选保护上限为 4096；一次 query embedding 在所有轮次复用，权威资料按最多 400 个 chunkId 批量过滤，并返回 budget、exhausted、relevance-tail、candidate-limit、resource-limit、cancelled 停止原因。邻居补充受证据预算 25% 限制，Lance 同分扫描有界并可取消。引用编号与 parser、stream buffer、renderer 均支持安全整数范围，不再在 S32 截断。

主要文件：

- `src/main/retrieval/retrieval-service.ts`
- `src/main/chat/citation-parser.ts`
- `src/shared/chat.ts`
- `src/renderer/src/chat/SafeMarkdown.tsx`

### T4：模型路由和流式结束

每个实际 provider 尝试都可重新组装请求，备用模型不会沿用上一模型的静态 token 预算，并同步保存该次实际发送的证据切片。finish reason 已归一为 stop、length、context-limit、other；响应字节上限按本次输出额度在 8 MiB～64 MiB 内计算。非 2xx 错误正文使用 16 KiB 有界读取及超时保护，避免无限等待或把敏感正文带入错误信息。

### T5：持久化和手动继续生成

新增 `chat_generation_contexts`，保存生成快照、运行摘要、revision 和活动 request ID。继续生成通过 IPC、CAS revision 和原模型身份校验进入同一 assistant 消息；新请求只追加新内容，原回答和引用保持不变。达到 length 上限时保留回答、显示提示和“继续生成”按钮；每次继续都是独立请求，仍可能再次达到输出上限。没有自动续写、自动提额或模式切换。

主要文件：

- `src/main/db/migrations/016_chat_generation_contexts.sql`
- `src/main/chat/conversation-repository.ts`
- `src/main/chat/chat-service.ts`
- `src/shared/chat.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/chat/useChatStream.ts`
- `src/renderer/src/features/chat/ChatPane.tsx`

## 验证命令

- `npm test`（2026-09-20 最近复验）：101 个测试文件通过，1,015 个测试通过，1 个跳过；最近三项修复新增 5 个回归测试。
- `npm run typecheck`：通过。
- `npm run build`：通过，main/preload/renderer 均完成生产构建。
- `git diff --check`：通过；仅有工作区既存的 LF/CRLF 提示，无空白错误。

## 已知限制和未测项

- 未运行 E2E、安装包验证或真实 provider 调用；因此首字时间、答案质量、费用和真实吞吐没有实测结论。
- token 估算当前按 UTF-8 字节近似，代码已保留后续按具体 tokenizer 校准的边界；不能把估算值当成 provider 精确 token 计数。
- 检索候选规模和停止原因已实现，但固定基准表尚未执行；候选保护上限仍是有界保护，不等价于全面阅读项目资料。
- 续写快照已保存可恢复消息、模型身份、证据和 revision；来源版本/hash 校验仅对快照中存在完整元数据的证据执行，历史旧快照不自动伪造元数据。
- 没有提交、推送或修改用户已有的无关工作区改动。

## 2026-09-20 review 修复与证据

本轮只修复六项已确认问题，不增加自动/全面模式、自动续写或自动提高输出额度。

| 问题 | 修复 | 可重复的本地测试 |
| --- | --- | --- |
| 备用模型证据快照过期 | 每次实际尝试同时保存 messages、retrievals 和 evidence | chat-service：saves the evidence actually sent to a smaller fallback model |
| 全部证据被固定导致续写超限 | 已引用证据固定；未引用原切片可省略；保留原编号和顺序 | chat-service：continues a long answer by dropping uncited evidence；context-builder：drops optional frozen slices without changing sparse labels or cited text |
| 中断恢复缺引用且用量误报完整 | checkpoint 原子保存正文和本次用量；重启补引用、合并已知用量并标记不完整；后续续写不重复结算 | chat-service：rebuilds checkpoint citations and incomplete usage on restart exactly once；checkpoints the latest usage together with streaming content |
| 残留请求恢复丢继续按钮 | SQL 写入 JSON 布尔值而非数字 | chat-service：restores a boolean continuation flag for a stranded completed answer |
| 独立输入容量压缩默认输出 | input-only 不套共享窗口默认输出公式，固定输入超限不借用输出空间 | context-builder：does not reduce automatic output for an independent small input limit |
| 模型设置保存后重复打开 | 深链接对同一模型只消费一次 | Settings：opens a model deep link only once after saving and refreshing profiles |

验证方式为项目现有单元/集成测试与内存数据库，无真实服务或实际界面验收。固定性能基准、A01～A24 逐项完整证据仍待完成，不能据此宣称整期 PRD 已结束或速度/质量得到实测提升。

## 后续五项 review 修复

- 配置校验统一到 `generationSettingsError`，保存、初次生成/重新生成、继续生成及每个备用模型尝试均检查有效配置。能力更新后非法手动值在调用服务商前明确拒绝，不静默降低用户输出额度。
- 未填写上下文时，保存组合校验也使用实际默认窗口 32,768；输出 65,536 必须同时配置足够的上下文。input-only 仍保持输入和输出独立。
- 每次模型尝试开始清空该次用量，并立即记录实际尝试的模型身份；失败、取消和成功结果不再错误沿用主模型身份或上一失败尝试的用量。
- 初次失败终态携带数据库中的完整消息；空正文 length 错误重载后仍使用已保存的具体原因，并提供实际模型设置入口和重试，不显示继续生成。
- 模型配置表单展示校验详情中的额度值，避免显示未替换的占位符。

新增证据：`generation-limits.test.ts` 的能力刷新及默认窗口/独立输入校验；`chat-service.test.ts` 的非法保存、发送与续写拒绝、备用配置拒绝、备用成功/失败用量隔离与模型身份、空输出失败终态；`ChatPane.test.tsx` 的重载后空输出提示与实际模型设置入口。

本次全量测试 1,010 通过、1 跳过；类型检查、main/preload/renderer 构建和 diff 检查通过。未执行 E2E、真实服务调用、性能基准、安装包、提交或推送。

## 最近三项 review 修复

- 配置校验前移至发送和重新生成写入之前：非法配置不新增数据库问答，也不改写旧问题。前端编辑内容仅在主进程接受请求后更新，避免请求被拒绝时显示“新问题＋旧回答”。
- 检索使用现有上下文预算函数，统一扣除实际默认输出额度和固定输入；8,192 窗口下默认输出调整后仍可检索并发送有效证据，不再错误得到零预算。
- 固定输入计数包含系统消息和完整证据包装；最终完整消息仍超限时，依次移除补充历史、非必需证据、预留历史。按完整问答移除历史，保留必需引用编号/切片、当前问题及已有回答。诊断数量和历史 ID 与最终发送内容保持一致。

回归证据：`chat-service.test.ts` 的拒绝编辑/发送不改变原记录、小窗口实际检索及引用；`useChatStream.test.ts` 的拒绝编辑后保留原显示；`context-builder.test.ts` 的可选续写片段包装边界、最终布局超限时完整移除补充历史并保留必需证据。历史裁剪既有测试扩大样本，使其确实超过预算，而不是依赖旧诊断少计条数。

最新复验：1,015 项测试通过、1 项跳过；类型检查、构建及 diff 检查通过。未运行真实服务或实际界面验收，固定性能基准与逐项验收证据清单继续保留为未完成，未提交或推送。
