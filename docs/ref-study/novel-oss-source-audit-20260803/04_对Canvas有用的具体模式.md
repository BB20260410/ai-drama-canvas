# 对 Canvas 有用的具体模式

## 总体裁决

本轮不新增任何 P0。Canvas 当前的正文/状态安全闭环已经成立，外仓不能因为字段更多或 UI 更炫就取代 owner。

建议落盘为三个 P1，两个证据驱动 P2，其余延后或拒绝。

## P1-A：`NOVEL-DERIVED-SEARCH-GENERATION`

### 为什么需要

`src/core/novel-manuscript.ts` 的 `searchChapters` 当前分批读取 allowed chapters，然后对每章执行 `String.indexOf`。它安全、有界且会复验 manifest revision，但是数据量增长时查询成本依然随可搜章节正文总量线性增长。

这是本轮唯一由 Canvas live source 直接证明的百万字性能缺口。

### clean-room 协议

建议首先实现 Canvas 自有 FTS5，不先引入 vector runtime：

- canonical owner 仍是 chapter manifest + 正文实体文件；
- 索引 generation 字段至少包含 `generationId`、manifest/source revision、schemaVersion、tokenizer identity/config fingerprint、status、builtAt、coverage receipt、error；
- status 为 `building | active | stale | failed | inactive`；
- 新 generation 在独立位置构建，逐章验证 ID/revision/SHA/行数或字符覆盖，做 query probe 后才原子切换 active pointer；
- active generation 损坏、缺失、身份不匹配或 stale 时，失败关闭到当前线性扫描，不返回不完整“快结果”；
- 查询回执显示 `engine`、generation ID、freshness、manifest revision、fallback reason 和 scanned/indexed chapter count；
- 索引永远可删除后从正文重建，不接受人工直接编辑。

### 不先做语义向量的原因

百万字的首要问题是确定性字面定位的性能，而不是把更多模型引入正典路径。只有当真实《黑页》查询集证明 FTS 召回不足，且能建立 model fingerprint/dimension/metric/generation/fallback 合同时，才增加语义索引。

### 可能落点

- `src/core/novel-manuscript.ts`
- 新的 Canvas-owned 派生索引 core（文件名在实施时确定）
- `src/core/novel-agent-service.ts`
- `tests/novel-manuscript.test.ts`
- `tests/novel-scale-fixture.test.ts`
- 新的索引崩溃/代际切换定向测试

### 验收门

- 同 manifest/revision/query 结果与线性扫描语义一致；
- 枔建中、构建后未切换、切换前/后崩溃均不会产生半 active 索引；
- chapter 修订/新增/删除/外部替换后 freshness 正确；
- 损坏索引只导致带 reason 的 scan fallback，不影响正文 owner；
- 500/1000 章固定 fixture 记录 build/query p50/p95、峰值内存、实际读章数；性能裁决必须根据基线和真实查询集，不伪造通用毫秒承诺。

成本：中高。收益：百万字尺度最直接。

## P1-B：`NOVEL-ANALYSIS-EXECUTION-RECONCILIATION`

### 为什么需要

`src/core/novel-analysis-provider.ts` 在调用外部 HTTP 前会先把 task 持久化为 `executing`、execution 为 `submitting`，这一点正确。正常 catch 会转 `failed` 或 `submission_unknown`。

但如果进程在两者之间突然退出，execution 只有 `startedAt`，没有 lease owner、heartbeat、expiry 或人工对账转换。`replaceNovelAnalysisRunTaskAttempt` 只允许 `failed/submission_unknown`，因此该批会永久卡在 running。

### clean-room 协议

- execution 增加 lease/claim 身份、fence、heartbeat/leaseUntil 或明确的 dispatch checkpoint；
- doctor 将过期 `executing/submitting` 标记为 `reconciliation_required`，不自动变成 failed，也不自动创建 replacement；
- owner 必须记录“远程结果已回收”或“已核对无远程结果”的证据与说明；
- 只有确认无可回收结果，才允许新 attempt supersede 旧 attempt；
- 旧 worker 后到回写必须被 fence/revision 拒绝；
- 保留现有 request hash、provider/source revision pin 和 `submission_unknown` 安全语义。

### 可能落点

- `src/core/types.ts`
- `src/core/novel-analysis.ts`
- `src/core/novel-analysis-provider.ts`
- `tests/novel-analysis-provider.test.ts`
- 新的进程崩溃/过期/fence 定向测试

### 验收门

- HTTP 调用前崩溃、POST 后无响应崩溃、响应后未存 proposal 崩溃三种断点分别演练；
- 无任何过期路径自动发出第二次 POST；
- 人工对账审计事件、replacement link 和 request hash 可复现；
- 旧 worker 在新 fence 后返回时无法覆盖新状态。

成本：中。收益：多模型/长批次可靠性高。

## P1-C：`KERNEL-PACK-TRACE-SURFACE`

该项与已有 clean-room 研究一致，源码复核后证实价值成立。

### 目标

在现有 Writing OS dashboard 中直接投影真实 Context Pack receipt：

- target/cutoff/chapter brief/required cast；
- hard canon、critical memory、recent chapters 等预算分区；
- 每个 included/omitted 项的 source、优先级、规则和原因；
- protected/compressible 身份及压缩来源；
- pack/preflight fingerprint、stale/ready 和 nextTools；
- author-only/future chapter/绝对路径不泄露约束。

### 边界

UI 不二次推算，不新增 author intent/current focus 文件，不改 pack 排序/预算/fingerprint/save 合同。只投影 owner 已有事实。

成本：中。收益：让其他 AI 与人类 owner 能理解“这一章为什么得到这个作业包”，大幅降低误用和调试成本。

## P2-A：`KNOWLEDGE-PROVENANCE`

Canvas 已有知情账，不重建。候选增量只是：

- `acquisitionKind`：亲眼见证/听说/推断/阅读文件/被告知等；
- `confidence`：角色对该信息的主观置信度，不是模型自信度；
- `visibility/secretLevel`：可传播边界或秘密级别。

必须先用真实章节集做 A/B，证明它们能减少“角色将传闻当事实”、“尚未知晓秘密却泄露”等真问题，再实施 schema、migration/rebuild、candidate diff、probe 与 UI。

所有新字段仍必须经状态 candidate + human accept，不允许 AI 自动 settle。

成本：中高。收益：未经真实语料证明，暂不升 P1。

## P2-B：`NARRATIVE-OBLIGATION-DIAGNOSTICS`

Canvas 已有 foreshadowing setup/maintenance/payoff 生命周期。可选差额是：

- cause→event→effect→decision 的结构化因果链；
- promise/mystery/conflict 的 deadline chapter、last activated chapter、overdue/broken 诊断；
- 本章是否消费/维护/违背某个承诺的 evidence-bound candidate。

首先以派生诊断和人工候选运行，不直接改 owner state。只有真实长篇验收显示它能提前发现伏笔丢失/因果断裂，且假阳性可控，才正式进入 Context Pack hard/soft 规则。

成本：高。收益：潜在高，证据不足。

## 明确延后

### `STATE-CANDIDATE-DEPENDENCIES`

Canvas 当前一个 chapter state candidate 已能覆盖必备角色和五类状态。只有当新关系 endpoint/多候选人工决策需要跨 artifact 原子 apply 时，才借鉴 NovWr 的依赖图。

### `EXPORT-OUTBOX`

Canvas 正文 save 已有 durable intent/replay/recovery，不再造一个 outbox。只有当“已提交受管正文”与“已发布到独立外部稿件/平台”需要分态时再实施。

### `CHINESE-WEB-NOVEL-QUALITY-PACK`

OCNovel 的分类可作为诊断候选，但必须可选、可按题材/文风配置、只附 evidence 与建议，不得用固定对话比例/动作词/段落长度直接阻断正文保存。

## 明确拒绝

- 将 InkOS/MuMu/NovWr/AI-Novel-Writer 的数据库或 truth files 变成第二正典；
- 让外部运行时直接改 Canvas 角色、知情、关系、时间线或伏笔状态；
- 自动接受 LLM state settlement；
- 复制/链接 GPL/AGPL 代码；
- 用 README 声称替代实现、许可、测试和长篇证据；
- 用“模型自己记住”替代 Context Pack 与状态 owner。

## 建议实施顺序

1. P1-A 派生 FTS5 generation：直接消减已证实的线性搜索风险。
2. P1-B analysis execution reconciliation：封住外模长批次的进程崩溃死锁窗口。
3. P1-C pack trace surface：提高人类/其他 AI 可解释性和操作正确率。
4. 用真实小说语料对 P2-A/P2-B 做小样本证据实验；未证明前不改 schema。
