# 小说模式 V1：可执行验收规范

状态：`normative`  
原则：没有落盘证据不得宣称完成  
最后核对：2026-07-31

## 1. 关账规则

P0–P8 每阶段执行固定循环：代码/数据 → 定向测试 → 构建或真实运行 → 文件/UI 证据 → 阶段报告。任何阶段只完成其中一部分均为“部分完成”。只有本文件全部必选门通过，才可报告“小说本地软件和记忆库已落地”。

证据统一写入新目录 `docs/evidence/novel-mode-v1/`；不得覆盖既有 final-validation。每份 JSON 证据至少包含：schemaVersion、阶段、时间、构建 identity、源码 digest、命令、退出码、fixture/corpus SHA、目标章、计时、错误摘要和证据相对路径。

## 2. P0 基线门

必须记录执行当日 Git dirty 清单、允许修改白名单、OS/CPU/内存、Node/Electron 版本、测试分区指纹、源码 digest 和构建 identity。运行：

```bash
npm run test:partitions:audit
npm run typecheck
npm run build
npm run test:all
```

要求：

- 既有失败和小说新增回归分开记录；无法区分则停止业务代码。
- 正式活动短剧工程和正式小说原目录零写。
- Node 源码态、Electron 主进程和最终 packaged runtime 各有 FTS5 建表/写入/查询证据。
- CharacterArc/OpenFic 锁定来源、许可证和上游文件 SHA 可复现。

## 3. 确定性规模夹具

| ID | 章节数目标 | 正文字符目标 |
|---|---:|---:|
| S1 | 约 500 | 1,000,000 |
| S3 | 约 1,500 | 3,000,000 |
| S5 | 约 2,500 | 5,000,000 |

固定 seed 生成非重复中文内容，覆盖人物别名、地点、伤势、道具、关系、知识、目标、世界规则、伏笔、跨章变化和全部正典/认识论状态。manifest 至少含：seed、生成器源码 SHA、corpus aggregate SHA、golden SHA、章节数、UTF-16 字符数、UTF-8 字节数和逻辑指纹。

同 seed 在两个全新临时目录连续生成两次，corpus/golden/逻辑指纹必须完全一致。正确性套件不能调用外部模型。

每套至少 400 道 Oracle：

- 100 条精确原文检索；
- 100 条别名/近义查询；
- 100 条目标章状态；
- 50 条未来信息泄漏陷阱；
- 50 条矛盾、候选污染和证据失效。

正确性硬门：精确 Recall@5 = 100%；别名/近义 Recall@10 >= 95%；100 条状态题 = 100%；50 条未来陷阱泄漏数 = 0。每个答案必须能由相对路径、chapterId、UTF-16 offset、revision 和 SHA 反查原文。

## 4. 功能验收矩阵

| 能力 | 必须证明 |
|---|---|
| 三种工作区 | novel/drama/hybrid 路由正确；旧 v1 缺字段仍为 drama 且零迁移 |
| 导入 | TXT/MD/DOCX/目录只读预检；默认导入副本；重复导入幂等 |
| 稳定身份 | 章节改名、移动、重排后 chapterId 不变 |
| 编辑 | 创建、保存、切章、关闭、重开、恢复后正文与 revision 一致 |
| CAS | 外部改文或另一窗口先保存后，旧 revision/SHA 必须失败并显示三方 Diff |
| 故事圣经 | 每个实体、事实、关系、知识、时间线、伏笔有稳定 ID、双轴状态和来源 |
| 时态 | 所有状态查询强制 targetChapter；before/through 行为正确；未来泄漏为 0 |
| 检索 | 命中返回相对路径、章节、offset、SHA；不存在不可追溯摘要答案 |
| 上下文 | 热/温/冷层受预算约束，硬正典不漏，trace 列出纳入/排除和 stale 原因 |
| 候选 | AI 不能直写；拒绝、部分接受、stale、幂等、崩溃恢复闭环 |
| 索引 | 修改一章不全书重建；损坏/删除派生库不影响正文 |
| 备份恢复 | 新目录独立打开/编辑/检索；旧根零变化；绝对 locator 为失败 |
| 短剧交接 | 锁定版本携带章节/事实 SHA；下游变更不反写小说正典 |

## 5. 性能与资源硬门

在同一目标机、同一构建、无外部模型下测试。每项记录 1 次冷运行和至少 30 次热查询的 p50/p95/max。

| 指标 | S1 | S3 | S5 |
|---|---:|---:|---:|
| 冷导入、拆章、SHA、结构索引 | <=10s | <=30s | <=60s |
| 删除派生库后完整重建 | <=15s | <=45s | <=90s |
| 单章增量索引 p95 | <=1.0s | <=1.2s | <=1.5s |
| 精确/全文检索 p95 | <=150ms | <=250ms | <=400ms |
| 章级状态查询 p95 | <=100ms | <=150ms | <=250ms |
| 无模型上下文构建 p95 | <=400ms | <=700ms | <=1.2s |
| 热切换章节 p95 | <=300ms | <=350ms | <=450ms |
| S5 冷启动到可操作 | — | — | <=6s |

S5 额外硬门：Electron 总 RSS 峰值 <=1.5GB；renderer JS heap <=350MB；非向量派生索引 <= UTF-8 正文 2 倍；章节 DOM <=200；搜索结果 DOM <=100；相对锁定基线退化 <=15%。

30 分钟主动 soak：尾段 RSS 增长 <= `max(10%, 128MiB)`，文件描述符增长 <=64，无未处理 promise、renderer crash、空文件或持续 busy。

P0 只能用可复现证据收紧阈值；任何放宽必须形成书面决策并由用户确认。

## 6. 删除重建门

只允许在测试副本删除：

```text
.aicanvas/novel/novel-derived.sqlite
.aicanvas/novel/novel-derived.sqlite-wal
.aicanvas/novel/novel-derived.sqlite-shm
```

连续执行三轮：记录权威 aggregate SHA 和 golden → 关闭应用 → 删除上述派生文件 → 重启重建 → `PRAGMA quick_check` → 比较逻辑状态、行数、检索命中和答案 → 修改一章并验证增量更新。

三轮均要求权威 SHA 不变、逻辑答案 100% 一致、精确检索 100% 一致、无孤立 `.tmp`/WAL、无重复事件。SQLite 页布局和 DB 文件字节哈希不作等价标准。

## 7. 并发与故障注入门

| 场景 | 必须结果 |
|---|---|
| 两窗口同章 | 先提交成功，后提交 CAS 失败并显示三方 Diff |
| 两进程同幂等键 | 副作用恰好一次 |
| 不同幂等键同 revision | 恰好一成一败 |
| 重建期间查询 | 旧一致快照或明确“重建中”，不混合水位 |
| 重建期间正文改变 | 进入待重放队列，最终 watermark 等于最新 SHA |
| 100 次快速编辑后 SIGKILL | 重启后无空文件、截断或丢 revision |
| 临时文件写完前崩溃 | 旧正典完整 |
| fsync 后 rename 前崩溃 | 旧版有效，重启清理临时文件 |
| rename 后回执前崩溃 | 对账识别已提交，不重复写 |
| 正典提交后索引前崩溃 | 水位失配并自动补索引 |
| FTS/摘要批次崩溃 | 事务回滚或从 checkpoint 恢复 |
| 候选接受中崩溃 | 全接受或全不接受，无半合并 |
| SQLite 截断/随机损坏 | 隔离 DB，从正典重建 |
| SQLITE_BUSY 耗尽 | 明确 RESOURCE_BUSY，不伪装校验失败 |
| ENOSPC/无权限 | 失败关闭，无截断和伪成功 |

故障开关只允许测试构建，生产包扫描必须为 0。

## 8. 安全验收

- `../`、绝对 locator、symlink、特殊文件、越根 realpath、TOCTOU 替换全部失败关闭。
- 恶意/超限 DOCX 在隔离解析器内失败，不产生权威文件或网络请求。
- 项目、备份、导出、日志、renderer、证据和安装包中的明文测试密钥扫描命中数为 0。
- local-only smoke 的外网请求计数为 0；未授权正文外发计数为 0。
- 非法/残缺 AI JSON 不产生部分写入。
- SBOM、许可证和第三方 notices 进入源码与 packaged app；正式代码不含 InkOS/AGPL 实现。

## 9. 真实小说项目验收

正式样本：

```text
/Users/hxx/Documents/嘟嘟专属剧情。/山海有只小狗_小说项目_20260730/第一季_古蜀十三相_小说化_v1
```

该目录只读：前后生成路径、类型、大小、mtime、SHA 全树 manifest；不得新增 `.aicanvas`、锁、临时文件或索引。软件必须忠实显示 live 文件声明的 `UNAPPROVED / USER_APPROVAL_PENDING`、`NOT_STARTED` 和关闭写作门，不能从计划或聊天推断批准。

### 9.1 当前只读映射（2026-07-31 现场值）

下表只冻结适配入口和当次 SHA，不把文件内容复制进软件；正式验收必须重新计算 SHA。若 live 文件已变化则生成新映射，不能拿旧哈希当当前事实。

| 语义 owner | 项目相对路径 | 现场 SHA-256 | 读取用途 |
|---|---|---|---|
| 当前总状态 | `00_索引与当前状态.md` | `093efc3f054666bf049b9c8e8396fe6aed4d4c3873fae5acb3629bc18e74ca3b` | 基线、正文状态、写作门 |
| 正典守恒合同 | `01_小说改编权威与正典守恒合同.md` | `1803e280e9cef407b0102b512e7891572bbaecc4754ef240321c2ae0f8bc3300` | 来源优先级与禁止改写 |
| 全书状态 | `tracking/00_全书状态.md` | `2cba9976df6c29fc1cab257b5c7b1f131ec030f7573ec6186dc4a633fa98efdc` | 全局阶段、门禁与追踪水位 |
| 章节状态 | `tracking/chapter-state.md` | `ba0de254682f0ea75c5acf4fe6b152fb35d9a14d255056a80074c13d8f7fbd07` | 章入口/终态 |
| 角色知识 | `tracking/knowledge-state.md` | `ace614a949545a75118610f73d49a2bb04e0ae9923e21deb5d918d01650cb9f9` | 目标章知识边界 |
| 道具与伤势 | `tracking/object-injury-state.md` | `c76fc27f35267fb01c94c984468baeac65322cf8bcab9963196e31f6b76d40e9` | 持有物、伤势和持续状态 |
| 角色状态 | `tracking/character-state.md` | `01cacf18095fdcf92be7cca0e67b50e03ae8adb84b16a0acd16fb3c1bd5e27a8` | 角色位置/目标/状态 |
| 连续性结构账 | `tracking/continuity-state.json` | `4f4e9eb2ce51bc758501466b2dcbd0fe7ec98dc0cae9bef7eed297b82a7a0c2d` | 结构化连续性与状态投影 |
| 章事件增量 | `tracking/chapter-events.jsonl` | `8a17e35f7c7e9f17c2b10354a53c6b08f580ac439cadf7d854b952adbc84ee73` | append-only 事件状态 |
| CH01 蓝图 | `blueprints/CH01_树下的鱼_章节蓝图.md` | `bece59b6f0133db9cc8bbef80c736e07644c18d53743aa05c7f7b12984c98b49` | CH01 只读章证据 |
| CH10 蓝图 | `blueprints/CH10_火路_章节蓝图.md` | `0188b345c088e56c303eb04f27552c0594349039138205bddad6bd8d2a56e331` | CH10 只读章证据 |
| CH24 蓝图 | `blueprints/CH24_十三人第一次同桌_章节蓝图.md` | `c0b6fbd5ae51ab5efa69903656e31d6e28554963fbf2c2716b2d29e215ab621b` | CH24 只读章证据 |
| CH33 蓝图 | `blueprints/CH33_人间相_章节蓝图.md` | `d8f6b79865f04480806b732cf101df6ed51debc89ca5d1425cb732c994b7eeea` | CH33 只读章证据 |
| CH01 工作卡 | `workcards/CH01_树下的鱼_开写输入与逐场状态卡.md` | `7e5909b3c5177b35de7283a8bf375919b70556bb00421d59138fd6f8ac5b97ef` | 写作门、场级输入；不得执行写入 |
| 批准规则 | `approvals/README.md` | `8dcbcebe41849511246fb669376e7565a561460b13cc855036e309fe320fe640` | 识别真实批准，不推断批准 |
| 准备包清单 | `manifests/00_小说准备包清单.json` | `56faa5af04b85d53f6b34886827a8c3cd3d1d8ec1fc191d073ded86d3c46250f` | 输入完整性和包身份 |

当次状态断言固定为：`production_baseline = UNAPPROVED / USER_APPROVAL_PENDING`、`manuscript_status = NOT_STARTED`、`drafting/manuscript_gate = CLOSED`。任何 adapter、UI 或 AI 若显示为已批准、已开写或可写，立即判失败。正式目录只能使用只读 API；候选、索引、草稿、锁、日志和设置均不得落在该目录。

### 9.2 32 道金标准问题框架

这些题只规定查询意图和期望证据字段，不在规范中复制蓝图正文或预填剧情答案。P8 前由人工在独立 oracle JSON 中填入经过双人核对的短答案与精确 section/key；软件输出必须逐字段比对。

每道题共同要求返回：`questionId`、`targetChapterId`、`cutoff`、`visibility=past_only`、`answerStatus`、`relativePath`、`sectionOrKey`、`sourceSha256`、`canonStatus`、`epistemicStatus`、`gateStatus`。涉及段落时再返回 UTF-16 `startOffset/endOffset` 与 `excerptSha256`；禁止返回大段正文。

| ID | 目标章 | 查询意图 | 期望证据 owner |
|---|---|---|---|
| RP-01 | CH01 | 当前 production baseline、manuscript status 和写作门分别是什么？ | 总状态 + 全书状态 |
| RP-02 | CH01 | CH01 的稳定章标识、蓝图标题和准备状态如何映射？ | CH01 蓝图 + chapter-state |
| RP-03 | CH01 | CH01 开篇前允许引用的角色状态有哪些记录？ | character-state，`cutoff=before` |
| RP-04 | CH01 | CH01 开篇前角色可知信息边界是什么？ | knowledge-state，`cutoff=before` |
| RP-05 | CH01 | CH01 开篇前道具/伤势连续状态由哪些条目支持？ | object-injury-state |
| RP-06 | CH01 | CH01 蓝图与正典守恒合同有哪些显式依赖？ | CH01 蓝图 + 正典合同 |
| RP-07 | CH01 | CH01 工作卡当前是否允许正式写入？ | CH01 工作卡 + approvals；期望 CLOSED |
| RP-08 | CH01 | 查询 CH01 时是否错误命中 CH10/CH24/CH33 的披露事实？ | 四章蓝图 + knowledge/continuity；期望 0 |
| RP-09 | CH10 | CH10 的稳定章标识、蓝图标题和章节状态如何映射？ | CH10 蓝图 + chapter-state |
| RP-10 | CH10 | CH10 开篇状态与 CH09 终态是否有可追溯承接？ | chapter/character/continuity，`before` |
| RP-11 | CH10 | CH10 结尾比开篇新增哪些已披露记录？ | chapter/knowledge，比较 before/through |
| RP-12 | CH10 | 截至 CH10 某角色的位置/目标来自哪些状态条目？ | character-state + source span |
| RP-13 | CH10 | 截至 CH10 的知识答案是否排除 CH11 以后披露？ | knowledge-state；期望未来命中 0 |
| RP-14 | CH10 | 截至 CH10 的道具/伤势答案来自哪些有效记录？ | object-injury-state |
| RP-15 | CH10 | CH10 蓝图事件如何映射到 append-only 章事件账？ | CH10 蓝图 + chapter-events |
| RP-16 | CH10 | CH10 查询是否保持全局 UNAPPROVED/NOT_STARTED/CLOSED？ | 总状态 + approvals |
| RP-17 | CH24 | CH24 的稳定章标识、蓝图标题和章节状态如何映射？ | CH24 蓝图 + chapter-state |
| RP-18 | CH24 | CH24 开篇与 CH23 终态的连续性证据在哪里？ | chapter/continuity，`before` |
| RP-19 | CH24 | CH24 through 查询新增哪些角色状态记录？ | character/chapter，`through` |
| RP-20 | CH24 | 截至 CH24 的角色知识是否排除 CH25 以后事实？ | knowledge-state；期望未来命中 0 |
| RP-21 | CH24 | 截至 CH24 的关系状态由哪些带有效期记录支持？ | continuity-state + source span |
| RP-22 | CH24 | 截至 CH24 的道具/伤势状态是否与章入口一致？ | object-injury + chapter-state |
| RP-23 | CH24 | CH24 蓝图事件与结构化连续性账能否双向追溯？ | CH24 蓝图 + continuity-state |
| RP-24 | CH24 | CH24 查询是否错误纳入 CH33 结局披露？ | CH24/CH33 + knowledge；期望 0 |
| RP-25 | CH33 | CH33 的稳定章标识、蓝图标题和章节状态如何映射？ | CH33 蓝图 + chapter-state |
| RP-26 | CH33 | CH33 开篇与 CH32 终态的连续性证据在哪里？ | chapter/continuity，`before` |
| RP-27 | CH33 | CH33 through 的最终角色状态由哪些记录支持？ | character/chapter，`through` |
| RP-28 | CH33 | CH33 的角色知识与世界事实是否被分开返回？ | knowledge + continuity |
| RP-29 | CH33 | CH33 的道具/伤势终态由哪些有效记录支持？ | object-injury + source span |
| RP-30 | CH33 | CH33 蓝图事件与事件账、连续性账是否一致可追溯？ | CH33 + events + continuity |
| RP-31 | CH33 | 全书查询能否保留 conflicted/retconned/cut 历史而不提升为当前 canon？ | continuity/status + 双轴状态 |
| RP-32 | CH33 | 即使全书蓝图齐备，正式正文和批准门当前是什么状态？ | 总状态 + approvals；期望 UNAPPROVED/NOT_STARTED/CLOSED |

oracle 填写规则：答案只摘录完成判断所需的最短字段值；每题至少一条、最多五条来源；来源 SHA 不匹配时标记 `STALE` 并停止评分，不得用旧答案覆盖 live 文件。验收后正式项目 aggregate SHA 必须与前置相同。

写入流程只在 `mktemp -d` 或明确隔离副本执行。副本中创建候选、查看 Diff、拒绝候选后，正式语义账 aggregate SHA 必须不变；真实项目门关闭时必须阻止接受为正典。带测试 approval 的接受只允许专用合成 fixture，不得伪造用户批准。

## 10. Electron 和安装包证据

真实 Electron smoke 至少截图并写 JSON：三模式路由、正式项目只读门、2500 章虚拟滚动、目标章人物状态及来源、搜索证据、上下文预算 trace、索引 stale/重建、候选接受/拒绝、双窗口冲突、崩溃恢复提示。

源码态全门通过后才能制作最终安装包。packaged app 复跑：路由、FTS5、目标章状态、保存、恢复、许可证资源和 local-only 网络门。制作安装包不代表获准替换当前 `/Applications` 版本。

## 11. 最终命令组与 DoD

```bash
npm run test:partitions:audit
npm run test:fast
npm run test:medium
npm run test:integration
npm run test:heavy
npm run test:all
npm run typecheck
npm run build
```

另需新增并实跑规模、三轮重建、故障注入、Electron UI 和 packaged-app smoke。最终 `docs/evidence/novel-mode-v1/final-validation.json` 只有在以下全部为 PASS 时才能标记 PASS：

- 三种模式和旧 drama 回归；
- 文件权威、稳定 ID、路径安全和导入副本；
- S1/S3/S5 正确性、性能、资源与 soak；
- 目标章强制、状态准确率 100%、未来泄漏 0；
- 三轮派生库重建逻辑等价；
- AI 候选/Diff/CAS/幂等/恢复；
- local-only、凭据和外发安全；
- 备份恢复、Core/IPC/source MCP/compiled MCP 一致；
- 正式项目只读 aggregate SHA 不变；
- licenses/notices/SBOM/安装包资源完整；
- 当前索引、交接、数据字典、恢复手册、用户手册和续作提示词已更新。

文学质量、真实外部模型效果、安装替换、公开发布和正式项目写入若未单独执行，必须明确为 `NOT_RUN`，不能由上述机械 PASS 代替。
