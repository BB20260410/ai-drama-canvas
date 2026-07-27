# 无限画布 P0—P9 全面整改执行计划

> **执行状态（2026-07-27 12:50 CST）：P0—P9 CLOSED。**  
> 本文件保留为原始验收合同；最终实际结果、偏差与证据入口见 `docs/验证报告_20260727_P0至P9生产中枢最终验收.md`、`STATUS.md` 和 `docs/当前开发交接.md`。关账范围为源码 + 隔离本机候选包；未安装、签名、公证或发布。

> 更新时间：2026-07-26（v2 修订：三专属代理独立分析 + 交叉互评收敛，主代理合并裁决）  
> 状态：**P0 实施中（P0c 三修复已落码验证；P0d 冻结轮 fast/切换进行中）**；产品仍为 PARTIAL  
> 约束：只修改源码版本；不安装、不发布、不执行 Git、不触碰正式创作源。

## v2 修订摘要（2026-07-26 晚 · 三代理互评共识）

评审组：产品/导演流程、数据权威/Codex 接入、性能/可靠性三专属代理各自独立分析后交叉互评；以下为主代理合并裁决的修订点（原 P1—P9 主体结构保留，插入新切片并调序）：

1. **P0.6（新增微切片，切换后立即）**：mcp-process-guard 锁获取"读→查存活→写"非原子（writeClaim tmp+rename 非 wx，check-then-write TOCTOU）——改 exclusive-create/wx 原子化；不作废本轮冻结证据，修后跑定向、下轮进 fast。
2. **P0.5（新增，与 P1 并行）**：测试分层健康化——vitest json reporter 建立逐文件耗时基线；新增 `test:medium` 层收纳 >5s 文件（已实测 studio-generation-ledger.test.ts 34 例约 340 秒错分 fast）；fast 目标 <15 分钟；P9 增加"fast 耗时不劣于上版"回归门。
3. **P1 工作量修正**：引用角色语义只缺 `canonical_identity`/`composition_hint`/`forbidden` 三项产品化（`continuation_source` 已有约 10 处真实 fail-closed 调用，不重做）。
4. **P2 扩容为"单元驾驶舱三合一"**：ProjectionBundle 聚合 + **Codex 入口整合**（active context 的 nextAction 现为硬编码 degradedNextAction——系防高频入口同步开 ledger 的故意设计，修法用二级方案：入口保持轻量只读，权威 nextAction 经 buildUnit 受限路径按需取，禁止把 N+1 平移进单次调用）+ P6 图文对照合并设计 + **时间线轻量播放子集**（仅播放已缓存派生物；按需生成与多单元并发播放留 P5 与并发限流同批）。同一北星承诺"人类通道真、Codex 通道假"必须在本阶段消除。
5. **P3 改"schema 收编"**：NextShotContinuitySnapshot（字段齐备但零调用）收编进 post-result-observation 真实落库路径，不另起通道；评估扁平 13 字段 StudioSeedanceObservedState 扩 per-entity（一格多角色/多道具独立追踪）。
6. **P3.5（新增，书面合同）**：跨集资产复用合同设计——只读 content-addressed 导出包（SHA + 来源 projectId/reviewId），导入即目标项目自身 Authority/Review 重进为新 pending 候选，源项目 SHA 仅作"已过审"提速提示，**不得跳过目标项目 gate、不做活体克隆/共享表**（红线 §4 禁第二状态机）。
7. **P4 追加**：GenerationSessionSnapshot 数据模型落地（现全仓 0 引用）；生成账本增加子代理身份追踪（callerId/agentId）。
8. **P5 追加**：darwin-dirfd-storage 批处理（现每次 ensure/persist/import/link 各 fork 一个 python3）+ fixture reflink，heavy 主链 ≤6 分钟。
9. **P6.5（新增）**：按 P3.5 合同实现跨集资产复用（导出/导入 + UI）——三代理一致认定的最大产品盲区（否则每季重走全部资产裁决）。
10. **P7 顺序固定**：shell inspection 缓存（**必须与"剧本变更主动波及清单"绑定同批验收**，防缓存读过期）→ Bundle 聚合消 N+1 → worker offload 最后（全仓 38 处 DatabaseSync 同步阻塞以 profile 驱动治理）。
11. **P8 扩容**：原矩阵 + guard 双进程 TOCTOU 复验（panel 互斥闸 assertPanelNotInFlight+INSERT 无 BEGIN IMMEDIATE，双进程可能重复 run——加事务或 flock）+ 双进程 in-memory epoch 互不可见的伪陈旧读验收 + 切工程时 in-flight lease 处置 + candidate 误删恢复。
12. **五要素基线（三方平均，当前）**：内容事实 3.3 / 生产闭环 1.7 / Codex 可控 3 / UI 可用 3.7 / 性能恢复 3 ≈ 总体 3/10；P1—P4 完成后预测约 5.5/10。最大缺口排序：真实生产闭环 > Codex 可控性 > 一致性锁落地 > 批量与跨集产品能力 > 性能硬指标。

## 1. 北星目标

把无限画布做成《嘟嘟》及其它 AI 漫剧项目的唯一可信生产中枢，而不是图片仓库或平行账本：

1. 剧本、图片、视频、音频能够受管保存，并按集数、15 秒单元、宫格和时间线读取。
2. 角色、场景、道具、风格和镜头级 VFX 都有明确来源、SHA、版本、状态与适用范围。
3. Codex 不依赖聊天记录，能一次读取当前单元的剧本、真实 Binding、权威参考、上一镜实际末态和唯一下一步。
4. 画布约束一次真实生成，raw/labeled 写回并经原尺寸 Review 后，实际末态能进入下一镜冻结包。
5. UI 面向导演工作流：少找文件、少手工连线、少暴露内部 ID；技术证据仍可一键展开审计。
6. 源码版在真实项目、多媒体和长时间运行下流畅、可取消、可恢复，不重复调用、不重复扣费。

完成判定必须同时满足“内容事实正确、生产闭环真实、Codex 可读可控、用户界面可用、性能与恢复有现场证据”。数据库表、MCP 工具、计划文字或单测存在都不能单独算完成。

## 2. 当前真实基线

### 2.1 已具备的基础

- 内容寻址媒体库、SHA/来源记录、缩略图和原图按需预览。
- 剧本文档/revision、Production Unit/Panel、四轨时间线读取投影。
- Material Authority、Studio Binding、Generation Ledger、Review、Post-result Observation、Command Bus 等既有 owner。
- 项目新鲜度核验、布局全字段 CAS 合并、跨 IPC 扫描取消、锁崩溃恢复、视频来源闭包和隔离构建探针。
- 目标工程已物化 W00—W02：3 个连续单元、10 个宫格、10 条 image/storyboard 时间线绑定。
- 当前测试文件分区机械闭合：285 个测试文件 = fast 249 + integration 32 + heavy 4，零遗漏、零重叠；这不等于测试已经运行通过。

### 2.2 尚未闭合的真实数据

目标工程：

`/Users/hxx/Documents/无限画布/projects/local-import-dudu-world-prologue-b8bfcf14`

| 领域 | 当前事实 | 结论 |
|---|---:|---|
| 受管媒体 | 259 | 有媒体底座 |
| Canonical Asset | 18（6 角色、9 场景、1 道具、2 风格） | 仅候选 |
| Asset Version | 18，全部 `pending` | 未视觉批准 |
| Primary Authority | 0 | 无正式身份/场景权威 |
| Review / authority event | 0 / 0 | 未裁决 |
| VFX | 1 个允许项已进入 CAS，但无镜头级 owner | 不得塞入角色身份锁 |
| Unit / Panel | 3 / 10 | 连续单元已物化 |
| Timeline | 10 条 image；video 0；audio 0 | 不是完整四轨实测 |
| BindingSet / asset binding | 0 / 0 | Codex 还拿不到正式引用 |
| Continuity evidence | 0 | 无实际末态 |
| Generation plan/pack/dispatch/result/call | 全部 0 | 未跑真实受管生成 |
| 文稿 | 108 | 历史错误分类仍污染普通剧本视图 |

### 2.3 当前运行态

- 当前 MCP 进程 PID 22233 加载旧 `dist-mcp/mcp/server.js`。
- 进程记录的源码摘要与当前源码摘要不一致，且启动合同缺 runtime artifact SHA。
- 除 `get_capabilities` 外，MCP 会被全局 currentness 门禁拒绝；当前不是“可持续连接但有点慢”，而是**只剩诊断能力**。
- 旧性能证据：36 节点首卡约 4.388 秒、首 raw 约 19.719 秒、全部参考约 29.142 秒；当前源码没有 30 分钟 soak，不能称“流畅不卡”。

## 3. 本轮新发现的问题

### 3.1 热路径重复做整仓安全核验

Electron 除两个诊断 IPC 外，所有只读请求也会执行 runtime gate。每次请求结算后缓存立即失效，下一跳重新 glob/stat/SHA 整个 `src/tests/scripts`。MCP 也存在同类前置核验。安全设计正确，但放置位置导致首屏和 Codex 多步读取重复付费。

### 3.2 画布正式投影存在 N+1

PASS 单元会重复读取 history、review、raw/labeled、pack、references、video、observation；多库检查、managed project inspect 和 SQLite snapshot 被多次重复。当前 4 个 PASS 单元规模证据已出现约 31 次 IPC。

### 3.3 “开始”按钮与真实能力不一致

源码 runner 目前只允许单一步骤 `image`，实际行为是 freeze → plan → dispatch 记录，不会直接调用模型；Review、audio、video 明确未实现。帮助文案却写“后台自动开始生成，完成后图片会出现在画布上”，会让用户误以为已经存在真实后台生成 worker。

### 3.4 资产类别不等于引用角色

角色/场景/道具/风格是资产类别；`canonical_identity`、`continuation_source`、`composition_hint`、`forbidden` 是本次生成中参考图的作用。当前缺少正式、可审计的引用角色语义，容易把上一镜构图图或故事板误当身份母版。

### 3.5 VFX 与角色身份锁边界未产品化

项目有镜头级天象/VFX 允许项，但现有资产类别只有 character/scene/prop/style。VFX 不能修改角色身份母版，也不应被强塞进 style。需要复用 Production/Binding 的镜头级视觉约束 owner。

### 3.6 连续性能力存在但未进入真实生产链

planned 与 observed 已分离，但目标工程没有 Observation。逐角色/逐道具、视线、动作终点、180 度轴线、时间天气、光线、VFX、剪辑出入口等信息未形成一条真实 `Review PASS → observed actual-tail → next freeze` 链。

### 3.7 剧本和时间线“能读”不等于“好用”

- 历史 prompt/QC/索引曾被错误登记为 script，普通剧本页会被污染。
- 时间线已有读取投影和正式 attach 命令，但 UI 缺少最小“导入 → 选择区间 → 绑定 → 播放”路径。
- 普通页面暴露大量 revision、SHA、panelId、role code；项目概览和技术诊断抢占主视野。
- 帮助要求逐格手工连齐所有参考，未充分利用已有 Binding proposal 和正式绑定。

### 3.8 流畅度仍缺真实证明

- `DatabaseSync`、5 秒 busy timeout、whole-DB snapshot、深哈希可能阻塞 Electron 主进程。
- 文稿和正式投影存在 list 后逐项补读。
- 缩略图修复、扫描订阅与取消仍需全局并发/退避和底层排空证明。
- heavy 视频包主链约 19.75 分钟，远高于 6 分钟目标。
- 当前源码没有 30 分钟稳定性、36 全 PASS、千缩略图、DB 锁和跨工程切换联合矩阵。

## 4. 永久设计红线

1. 不新建第二套 Authority、Review、剧本库、时间线、Generation 或 Continuity 状态机。
2. 聚合 bundle 只能是带 revision/fingerprint 的只读投影，不能成为新 owner。
3. 缓存只用于加速展示；任何 freeze、dispatch、Review、Primary、unknown 处置和正式写入前仍须直读 owner、CAS 和当前 SHA。
4. `generation_unknown` 只允许对账；只有可信 `remote-not-created` 结构证据才能开新 attempt。
5. 候选、REJECTED、来源不明、故事板构图图不得成为 canonical identity。
6. planned end 不能冒充 observed end；未原尺寸 Review PASS 不得续作。
7. VFX 是镜头级暂态视觉约束，不修改角色永久身份母版。
8. 不整体重写大型画布组件，不做完整 NLE，不用“优化平台”推迟最小真实闭环。
9. 不安装应用；只在用户授权维护窗口后切换源码 MCP 进程。

## 5. P0—P9 执行路线

## P0 · 恢复可信运行身份并移除首要误导

### 实施

1. 建立 IPC/MCP 副作用清单：`diagnostic-read / read-only / mutation / external-side-effect`。
2. 只读展示使用 source watcher 失效 + 短 TTL + singleflight 的 currentness 结果；mutation 和外部副作用继续在提交前做强门禁、直读 owner 和 CAS。
3. 对 runtime digest 次数、managed inspect 次数、DB snapshot 次数、每通道耗时建立探针。
4. 修正“开始”按钮及帮助文案：
   - 未有真实 worker 时明确写“冻结并记录派发，等待 Codex/Agent 领取”；
   - 不承诺自动出图；
   - Review/audio/video 未接入时显示不可用原因。
5. 运行 fast、定向、类型检查和隔离源码构建；生成 source digest + runtime artifact SHA 一致的源码 MCP 工件。
6. 取得用户维护窗口后停止旧 PID、切换新源码 MCP；现场调用 `get_capabilities → get_active_managed_studio_context`。

### 验收

- 旧/漂移工件对 mutation 继续 fail closed。
- 只读链不会每跳重算整仓 SHA；证据中 digest 次数显著收敛。
- MCP source digest、artifact SHA、当前源码和 active project 四者一致。
- Codex 冷启动到 active context ≤2 秒，暖读 ≤500 ms。
- 未授权维护窗口前只准备和验证工件，不替用户重启。

## P1 · 建立当前 3 单元的最小资产权威

### 实施

1. 由实体分析和单元需求生成 W00—W02 实际引用候选，只处理当前纵切需要的角色、场景、道具、共享风格和禁用项，不先审完整项目。
2. 对每项展示受管缩略图和按需 CAS 原图、SHA、来源、适用范围、正负锁、冲突版本。
3. 用户执行具体视觉批准/拒绝；批准和提升 Primary 保持两个独立动作。
4. 增加镜头级 VFX visual constraint，绑定 unit/panel、触发条件、颜色/形态/强度和 forbidden；不新增完整角色身份。
5. 引入引用角色：
   - `canonical_identity`
   - `continuation_source`
   - `composition_hint`
   - `forbidden`
6. 自动 proposal 只能建议映射；有歧义时等待人工决定，不得自动提升 Authority。

### 验收

- W00—W02 实际需要的每项正式参考都有原尺寸 Review、Primary、完整正负锁与适用范围。
- 本纵切 0 个未裁决引用，项目其它未使用候选可继续 pending。
- 改字节、错 SHA、过期版本、禁用引用进入冻结包时硬失败。
- VFX 独立可追溯，角色母版 SHA 不变。

### 用户门

- 具体参考图视觉批准。
- 正负身份锁和 VFX 具体视觉规则确认。

## P2 · 让画布成为“当前单元驾驶舱”

### 实施

1. 新增当前页 `StudioProductionProjectionBundle`：
   - 复用 Dashboard、Binding、Review、Generation、Timeline、Observation；
   - 一个 IPC/MCP 聚合当前单元和相邻摘要；
   - 单库同一只读事务快照；跨库绑定各自 revision/fingerprint，不伪称全局原子。
2. 默认只显示当前单元 2—6 格：
   - raw/labeled 是主时间节点；
   - 实际冻结引用位于下方；
   - 以角色/场景/道具/风格/VFX类型连线；
   - 下一镜摘要显示上一镜实际尾态。
3. W00—W02 全部建立受管 BindingSet；源目录 `02_BindingSet/*.json` 只作导入证据，不算正式冻结。
4. 技术字段默认折叠，但 SHA、版本、Review、actual-tail、unknown 和付费边界必须一键展开、复制。
5. 候选/REJECTED/UNKNOWN 默认不进入正式画布。
6. 明确 W00 的“源内容 12 秒 / 容器 15 秒 / 尾部 hold”，不虚构额外剧情。

### 验收

- 10 格均有可追溯 BindingSet，freeze pack SHA 与 Authority 完全一致。
- 无歧义引用不再需要逐格手工找图、复制路径或重复连线。
- 重启后单元、布局、Binding、连线和状态恢复一致。
- 快照优化前后 PASS 选择、raw/labeled SHA、Review/Observation head、pack/currentness/fingerprint 逐字段一致。

## P3 · 闭合真实连续性与重锚

### 实施

1. 在既有 Post-result Observation owner 中补齐：
   - 逐角色位置、朝向、视线、表情、服装/伤势；
   - 逐道具持有者、位置和状态；
   - 动作终点与下一镜动作起点；
   - 场景锚点、180 度轴线、屏幕方向；
   - 时间、天气、光线；
   - VFX 状态和剪辑出入口。
2. 明确事件边界：`completed / current / reserved`，禁止将下一事件提前塞进当前 15 秒。
3. 原图 Review PASS 后才允许创建 observed actual-tail；raw 替换、Review 撤销或 correction 会使下游冻结失效。
4. 连续承接两次后，第三次强制回到 canonical identity/scene anchor 重新锚定。

### 验收

- 完成至少 1 条 `Review PASS → Observation → actual-tail → next freeze`。
- 下一冻结包能指出每个字段来自哪个媒体 SHA、Review fingerprint 和 Observation head。
- 缺字段显示 UNKNOWN 并按风险 fail closed，不由提示词猜测。

## P4 · 接通一次真实 Codex 受管生成

### 实施

1. 复用现有 Dashboard、Generation Control、Command Bus、Ledger、Review，不新增平行队列。
2. 向 Codex 暴露一个内容寻址 `GenerationSessionSnapshot`：当前 unit/panel、剧本 span、Binding、引用角色、previous actual-tail、camera/axis、最危险失败项、唯一 nextAction。
3. 将 UI 的 dispatch 状态与 Agent 真正领取、imagegen call、result commit 分开显示。
4. 每张正式图：
   - 并发恒为 1；
   - 新独立生图子代理；
   - 一次正式 imagegen 调用；
   - 主代理只做参考核对和原尺寸视觉验收；
   - raw/labeled 原子写回；
   - unknown 不重派。
5. 先打通 1 格到下一格，再扩到当前 3 单元；失败只修一个可证视觉缺陷。

### 验收

- 至少一条真实 `画布约束 → Codex 领取 → imagegen → raw/labeled → Review PASS → actual-tail → 下一镜消费`。
- provider 调用数、call intent/event、结果 SHA 和 Review 一一对应。
- SIGKILL/断连后恢复不会增加 provider 调用数。
- 用户未视觉通过的 raw 不产生 observed tail。

### 用户门

- 正式 raw 原尺寸视觉 PASS/REJECTED。

## P5 · 四轨媒体与通用图生视频提交包

### 实施

1. 时间线增加最小“导入 → 选择单元/区间 → 绑定角色 → 播放”UI，仍调用既有正式 attach command。
2. 用隔离 canary 各导入 1 条真实短视频和音频，提取 ffprobe 元数据、poster/尾帧、waveform；重启后恢复。
3. 媒体首屏只取 thumbnail/poster/waveform；点击播放后使用 proxy + Range，不自动载入原片。
4. 复用 `managed-evidence-v1` VideoPackage adapter，完成非《嘟嘟》样本：
   raw/labeled → 逐格裁图 → video.md/json → manifest → CAS receipt。
5. builder 批处理、dirfd 批量安装、fixture reflink；保留 O_NOFOLLOW、inode/mtime/size/SHA、fsync、journal/recovery。
6. 外部输入优先固化为受管不可变 CAS；明确跨 SQLite/文件系统非协作写者边界。

### 验收

- script/image/video/audio 四轨各有一条真实可播放/可追溯证据。
- 非《嘟嘟》项目同一 adapter 成功构建提交包。
- heavy 主链 ≤6 分钟。
- 任一输入漂移时 receipt=0，旧包不被冒充为 current。

## P6 · 完成导演向“存—读—对照—拆”产品环

### 实施

1. 普通剧本库只显示 current script；历史 prompt/QC/索引进入诊断/迁移视图，不删除旧记录。
2. 剧本阅读页提供集/场/15 秒单元导航，当前单元高亮。
3. 一键图文对照：script span → unit/panel → raw/labeled/缺图；点击可进入画布和审片。
4. 15 秒向导：选 span → 2—6 格建议 → 人工修改 → 一键物化 unit → Binding readiness。
5. 多剧本批量导入使用现有 revision CAS，去重、版本化，不回写只读源目录。

### 验收

- 不打开 SQLite、不翻源目录即可回答“这段剧本对应哪些图、缺哪些图”。
- 从一段剧本到可冻结 15 秒单元不依赖手写脚本。
- prompt/QC 不再污染普通剧本列表，历史数据仍可追溯。

## P7 · 流畅度专项

### 实施

1. 消除当前单元正式投影 N+1；当前页只读 bundle、文稿按选中后取、timeline 结果复用。
2. read-only shell/DB 连接按真实只读语义缓存；迁移/建表/WAL 配置只在激活或写路径。
3. 主进程 requestId 真取消，lane 最迟 5 秒排空；扫描订阅采用引用计数。
4. 缩略图派生/修复全局并发 2，失败负缓存和退避。
5. 仅在 profile 证明同步 DB/哈希阻塞后移至 worker；禁止盲目线程化。
6. 建立每通道 p50/p95、event-loop lag、long task、RSS、FD、IPC outstanding 和 cache hit 证据。

### 硬指标

- 源码 UI 壳冷启 p95 ≤1 秒。
- 当前单元冷首屏 p95 ≤1.5 秒；暖切单元 ≤500 ms。
- 首个 raw ≤5 秒；当前单元全部引用 ≤8 秒。
- 常用输入/拖拽反馈 ≤100 ms；滚动画布稳定 50—60 FPS。
- 无超过 200 ms 的未解释主线程长任务。
- 取消后底层 lane ≤5 秒排空，结束 outstanding=0。

## P8 · 可靠性、恢复与跨项目通用性

### 实施

1. 真实 SIGKILL 矩阵：调用前、调用状态未知、结果 CAS、Review、Observation、视频包 receipt。
2. SQLite busy/WAL、项目 A↔B↔A、时钟回拨、多窗口 CAS、外部 writer 漂移和断网恢复。
3. 30 分钟源码 soak：持续切项目、滚动画布、打开原图、播放媒体、取消扫描。
4. Registry 提供只读诊断和人工“移除登记”入口；不得自动删除不可用根或历史临时工程。
5. 选一个非《嘟嘟》真实项目完成剧本/资产/单元/四轨/提交包纵切，证明产品不依赖 Dudu 特例。
6. 中断恢复只依赖画布、数据库、CAS、索引和交接，不读取旧聊天 JSONL。

### 验收

- 30 分钟 0 假死、0 跨工程旧结果、0 未解释错误；RSS 尾增 <10%，FD 净增 ≤5。
- unknown 状态下所有自动 nextAction 都是 reconcile，provider 调用数不增加。
- 非《嘟嘟》canary 全链通过，Dudu legacy 只读兼容不被破坏。

## P9 · 最终验收与发布前门

### 验收矩阵

1. 机械：fast、integration、heavy 分层运行并分别报告；typecheck、隔离 build、DB quick_check、媒体解码。
2. 运行：源码 UI、源码 MCP、真实项目切换、四轨播放、Codex 读取、生成 canary、恢复矩阵。
3. 人工：资产原图、raw/labeled 原图、时间线阅读、连线、下一镜连续性。
4. 性能：P7 全部指标 + 30 分钟 soak。
5. 完整性：无错误 Primary、无未解释 pending 引用、无未知调用、无 stale runtime、无候选混入正式画布。

只有全部满足时才能说“达到核心需求”。在此之前统一状态为 `PARTIAL`，并列出精确阻塞。安装、签名和桌面发布不属于本计划；产品完全成型后由用户另行授权。

## 6. 依赖与可并行边界

```text
P0 可信运行身份与热路径门禁
 ├─→ P1 当前纵切资产权威
 │    └─→ P2 Binding 与单元驾驶舱
 │          └─→ P3 实际连续性
 │                └─→ P4 真实生成闭环
 ├─→ P5 四轨与视频包
 └─→ P6 剧本产品环

P2/P5/P6 的真实数据完成后 → P7 性能 → P8 恢复与跨项目 → P9 总验收
```

- 可以并行：只读审计、测试设计、UI 投影、非重叠模块实现。
- 必须单写者：Command Bus、Authority/Binding schema、Generation Ledger、运行时门禁、同一数据库迁移。
- 正式 imagegen 始终并发 1。

## 7. 每阶段固定交付

每个 P 阶段必须同时落下：

1. 真实问题与基线证据。
2. 最小源码修改。
3. 定向测试和失败路径。
4. 隔离构建或源码真实运行证据。
5. 正式源/母版 SHA 前后不变。
6. 更新本计划、`STATUS.md`、`TASKS.md` 和 `docs/当前开发交接.md`。
7. 多代理交换审查；确定性 P0/P1 必须修复或写成不可绕过阻塞。

禁止只新增规划、Schema、审计报告或状态文字来模拟推进。

## 8. 只有这些事项需要用户裁决

1. 具体参考图的视觉批准/拒绝及 Primary Authority。
2. VFX 具体视觉规则。
3. 正式 raw 的原尺寸视觉验收。
4. 切换当前旧 MCP 的维护窗口。

其余源码实现、机械校验、隔离构建、只读 canary、性能测量和恢复测试均可按本计划持续执行。
