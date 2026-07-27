# Findings: 无限画布生产中枢纵向闭环

## 已知基线

- 工作区没有 Git HEAD，且存在大量用户历史修改；禁止 reset/clean/stage/commit。
- 用户只允许源码版本，当前任务不得安装无限画布。
- 20 个新项目虽已接入文件与媒体，但 Studio unit/panel/timeline 尚未物化。
- 已确认外部源目录变化后仍可能返回 `sourceSnapshot=same`；真实性状态是第一优先级。
- 文档导入默认存在格式与数量策略上限，`completed` 不能代表全量覆盖。
- 正式资产 Authority、ObservedEnd 连续性和通用视频包尚未形成跨项目闭环。

## 技能约束

- `planning-with-files`：所有阶段、发现、错误和验证持续写入本计划目录。
- `ai-drama-continuity`：规划状态与实际观测状态必须分离；只有原尺寸 Review 通过的媒体可以产生 observed end；下一镜不得以 planned end 冒充实际承接。

## 待验证

- 当前源码、dist-mcp 与运行进程的准确身份。
- 现有源同步/摘要/文档分类/schema 可复用边界。
- 现有 Review、continuity、video package 的真实调用链与测试覆盖。
- UI 当前读路径是否会在首屏触发 full projection 或巨型 JSON fallback。

## Phase 1 发现

- 当前源码 MCP PID 3202 启动于 2026-07-25 14:29，Electron PID 72055 启动于 13:24；磁盘 `release-manifest.json` 与 `dist-mcp/mcp/server.js` 构建于 23:45。旧进程内存身份不可由当前磁盘 manifest 证明。
- 当前磁盘源码与 release manifest 的 `sourceDigest` 一致；需要新增 runtime boot identity，区分“磁盘构建当前”和“运行进程当前”。
- 嘟嘟世界观受管项目是 `projects/local-import-dudu-world-prologue-b8bfcf14`，源层为只读 `/Users/hxx/Documents/嘟嘟专属剧情。/世界观概念序章_神魔怪妖人仙_20260724`。
- 旧 MCP 门禁只核对启动合同中的源码摘要与当前磁盘源码；如果新进程加载旧 `dist-mcp`、却记录当前源码摘要，旧运行文件仍可被误放行。已增加 loaded artifact SHA-256 绑定，待定向测试。
- 源目录正在被外部任务继续写入，文件/字节数在审查期间继续增长；项目中心和详情不能依赖一次导入时的静态 `completed`。
- Review 链是真实接入的，但没有“人工审片后的实际末态”事实；现有画布把冻结包里的计划末态标为“下一镜可复用”，属于事实层级混淆。
- Seedance 编译器与 next-shot continuity 当前只有单测调用者；视频包链路深度绑定 Dudu S1E1，尚不是通用项目能力。
- 后续最小修复采用独立、内容寻址、CAS 修正的 post-result observation receipt；不改写旧 Review fingerprint，不复用生成前 continuity 账本冒充实际观测。

## Phase 2–4 实证

- 单次“完整预览”仍可能遇到扫描期间来源写入；详情状态现采用两次独立 fingerprint 核验，并把中途变化单独投影为 `RACE_DETECTED`，而不是误归类为 current/stale。
- Dudu 世界观真实同步后的稳定来源 fingerprint 为 `2b0bcef9…`，与内容导入 baseline 相同；303 个受支持来源文件已对账，0 失败且未提升任何 Authority。
- `PARTIAL_BY_POLICY` 的当前原因是非 script/prompt 文档只进入语义清单，以及不支持格式/拒绝项；它不等于导入失败。正式资产权威仍未解析，因此生图门禁必须保持关闭。
- 真实 W00 已证明可从外部证据进入 Canonical Unit/Panel：12 秒、4 格、时码连续；回执可由命令总线幂等恢复。该纵向 canary 没有虚构任何资产绑定，四格 `assets=[]` 并明确 `blocked-unresolved`。
- 当前文稿库含 48 个历史 script 文档和 48 个新 prompt 文档；历史 script 是旧导入分类留下的兼容数据，不能在无迁移/引用证据时删除。W00 物化另建立 1 个来源片段 script 与 4 个逐格 prompt。

## Phase 5–9 实证

- actual-tail observation 已升级为内容寻址收据，覆盖 12 项实际连续性字段；无可读证据时字段保持 `UNKNOWN`，不再用计划终态冒充观察事实。
- 豁免不再是进程内临时布尔值：用户授权和历史兼容均形成持久化收据，并由作用域、内容哈希和当前 head 共同校验。
- 活动工程切换增加 activation fence；外部调用返回后再绑定不可变 receipt，避免旧工程异步结果写入新工程。
- VideoPackage v4 使用 managed source、最终 CAS、发布 journal/recovery 与 receipt CAS；未获收据的祖先版本进入隔离，多个 pending 同时存在会失败关闭。
- 第二轮全量测试为 277 文件中 274 通过、3 个负载超时；1552 项中 1549 通过。三个失败单独运行均通过，分别定位为锁测试 2 秒阈值、Dudu 大型 fixture 170 秒路径和视频包 18 分钟级巨型用例，不存在已证实的确定性死锁。
- 锁测试阈值已与产品 15 秒默认等待一致，保留 12 个竞争者、互斥和清理断言；单跑 9/9 通过。
- Dudu 冻结来源身份校验改为最多 4 路有界并发，仍保留 `O_NOFOLLOW`、realpath、inode、mtime、size 与 SHA 前后校验；`expectedRevision` 重型用例从 170.410 秒降至 128.422 秒，约提升 24.6%。
- 真实来源当前稳定 fingerprint 为 `81861cf4…`：309 文件、607440192 字节、121 文档、188 图片；最近导入 167 个合格媒体，26 新增、4 重对账、137 跳过、21 拒绝、0 失败。
- 导入后状态面板曾把旧 197 文件物化清单当 baseline；现改为最近一次 `content.sourceInventory`。真实工程核对为 309/309 文件、字节 delta=0、`sourceSnapshot=current`、`truthStatus=PARTIAL_BY_POLICY`。
- `PARTIAL_BY_POLICY` 的剩余原因是 53 个不支持格式、17 个 inventory-only 和 3 个拒绝文档；这不是来源过期或导入失败。
- 当前真实工程仍只有 1 unit / 4 panels / 0 timeline bindings；19 个 `APPROVED_LOCK` 候选均未完成类别裁决，因此 canonical assets 为 0，正式生图门禁保持关闭。
- 开发态此前错误复用旧 `release-manifest` digest，导致新源码 UI 的写闸门全部拒绝。现 `electron-vite dev` 绑定当前源码 digest，build 仍只信发布清单。
- 运行时写门禁 UI 已把 `checking / allowed / blocked / unavailable` 分开；检查中只读但不再误报“必须重启”。
- T23 源码真实 UI 复验：11 PASS、1 SKIP（工程无 Core PASS raw）；四媒体轨可见，剧本可用、图片/视频/音频缺失，控制台 0 error，正式管理工程 814 项全树前后未变化。
- UI 首个单元在 dev 模式为 4529ms，超过 1500ms 软目标；该数据包含 Vite 首次编译，仍需在正式源码 build 上单独测量，不能据此宣称产品已达流畅目标。
- 互评确认 5 个 P1 并已修复：可变导入进度伪造当前基线、业务读早于 runtime gate、多跳 context rebind 恢复、Video receipt 的 post-CAS/pre-transaction 窗口、fail-soft 后台 IPC 堆积。另以规模 smoke 补齐真实性能证据。
- 新不可变完成收据上线后，真实工程旧终态按设计降为 `UNVERIFIED`。两次独立内容哈希均为 `5db4da53…`（309 文件、607440192 字节）；幂等重导入只跳过既有 48 文稿与 167 媒体，0 失败、0 权威提升。新收据 `be1642b8…` 有效，三份来源指纹一致，恢复为 `PARTIAL_BY_POLICY + current`。
- VideoPackage receipt 现在在 `BEGIN IMMEDIATE` 后重新核对当前 Review、raw/labeled 与 Observation。专项竞态回归在异步 CAS 后推进 Observation，构建拒绝为 `input-drift` 且 SQLite receipt count=0。
- 36 单元源码 dev 规模门实际通过：4 个机械 deep-verified PASS raw、4 个冻结参考，均可解码；dev→CDP 2320ms、首卡 4330ms、首 raw 19176ms、全部引用 27212ms、投影 IPC 峰值 4、结束 outstanding=0、控制台/页面错误 0。
- 性能仍有明确余量风险：首 raw 距 20 秒硬门仅 824ms，全部引用距 30 秒硬门 2788ms。后续应合并深核验重复读，不应放宽预算。
- T23 retry3 源码 UI：11 PASS、1 SKIP；runtime gate=`allowed`、无错误重启横幅、控制台/媒体错误 0，新增完成收据后正式工程 816 项全树前后不变。原尺寸截图人工核对通过；真实工程没有 Core PASS raw，因此图片解码项仍只能 SKIP。
- 交换复审发现 v4 性能 smoke 的 4 个 raw/4 个参考实际分别复用同一 SHA，且 UI 只有 1 个可见单元节点；因此 v4 不再作为“多媒体、多节点规模”结论依据。
- v5 已将 36 个实际 VueFlow 节点及唯一 ID、4 个唯一 raw SHA/URL、4 个唯一参考 SHA/URL 纳入 14 项硬门。实测全部通过并真实解码，但首 raw 19719/20000ms、全部引用 29142/30000ms，余量仅 281ms/858ms。
- 项目中心原 compact 状态未验证完成收据，可能与严格生产门形成“双真相”。现 compact summary 带完成收据 fingerprint，列表端对项目、manifest、source inventory 与完整终态语义做小型严格核验；收据篡改时即使来源 current 也显示 `unverified`。真实工程回填后为 `partial + current`。
- 超时底层 IPC 的 drain lane 已按 projectRoot 隔离；某项目永不结算不会污染其他工程。多跳 rebind 改按 AUTOINCREMENT sequence 顺序，墙钟回拨回归通过。
- Video receipt 使用 `studio-mutation` 项目 fence，并在 post-CAS barrier 后复用 `externalFromIntent` 重读完整输入闭包。Canonical Unit 与 Observation 两项完整闭包竞态分别 4:59、5:57 PASS，均拒绝漂移且 receipt=0。
- 仍无法对绕过公开 Studio command-bus/项目 fence 的底层直写和外部进程直接改文件给出跨文件系统+SQLite绝对原子性。最终 CAS 前漂移可被拒绝；CAS 返回后到 COMMIT 的极窄窗口需通过“外部输入先 CAS 化”或统一项目 lease 才能彻底关闭。

## Phase 10 初步审计

- TASKS 当前真实未完成项为 T13–T18、T24；同时 Phase 3 的裁决/引用分页、Phase 4 的真实 raw/labeled 绑定、Phase 6 的通用视频包仍未关账。
- 源码已经存在 `set_studio_primary_authority`、`attach_studio_multimedia_timeline_media`、`managed-evidence-v1` adapter、registry 只读诊断和多处 AbortSignal/SIGKILL 基础能力；剩余问题更可能是纵向接线、真实样本和性能，而不是全部从零开发。
- 当前常驻 Electron PID 72055 与 dist-mcp PID 73547 未重启；源码验证不能冒充常驻运行时已经更新。
- `npm run build` 会重建 `dist-mcp`，而当前常驻 MCP 正在使用该路径。正式源码 build 性能测量必须使用不会覆盖活动 `dist-mcp` 的隔离输出，或先取得维护窗口，不能直接执行现有 build 脚本。
- 用户仍未授权由代理替代其对 19 个视觉候选作具体图像审批；可以实现/验证裁决入口和安全门，但不能自动提升 Primary Authority。
## 2026-07-26 本轮聚焦核查补充

- 资产审查与主权提升并非完全缺失：`MaterialStudioView.vue` 已有候选版本审查与“设为 Primary Authority”入口，Core/Command Bus 已实现 `reviewStudioAssetVersion`、`setStudioPrimaryAuthority`；因此 T13 的关键不是再造一套状态机，而是核对 19 个候选是否已被真实导入、界面是否能按项目/角色/场景/道具完成逐项视觉裁决，以及在用户未裁决前保持非主权状态。
- 多媒体时间线已有 `attach_studio_multimedia_timeline_media` 正式命令；T14 应优先核对真实项目是否已有可绑定的正式媒体与连续单元，而不是另建平行时间线。
- 视频包已有 `studio-video-package-source-adapter.ts`，并已支持 `managed-evidence-v1`；Phase 6 的剩余项需以真实非《嘟嘟》样本验证适配器是否通用，不能把“源码存在”当成完成。
- 项目注册表已有 `scripts/diagnose-project-registry-safety.ts` 与 npm 诊断入口；后续应运行并补齐缺失的运行态证据，而不是重复实现同名能力。
- 当前持久 Electron 与 `dist-mcp` 进程仍在运行。现有 `npm run build` 会先执行 `build:mcp` 并删除/重建 `dist-mcp`，会污染正在运行的服务，因此正式构建性能必须在隔离副本或独立输出目录测量，未经用户维护窗口授权不得直接构建、重启或安装。
- 扫描器、媒体派生与服务层已有部分 `AbortSignal`、SIGKILL/锁恢复基础；仍需聚焦核对“全源目录深扫取消”“迁移/对账锁恢复”是否真正覆盖，而不是仅按关键词判断完成。
- `studio-video-package-source-adapter.ts` 明确只从 Managed Studio 的 Canonical Panel → unit-grid freeze pack → raw/labeled result → current PASS Review 构造来源规范，并包含调用方 expected fingerprint / observation CAS；这条链的设计已具备严格证据闭包，剩余风险集中在外部输入进入视频包前的不可变托管与重型测试耗时。
- `MaterialStudioView.vue` 已实现：媒体导入 CAS、创建规范资产、追加 pending 版本、输入审核备注、approved/rejected 裁决及 Primary Authority 提升；因此 19 张候选不能由程序自动“完成”，其唯一合法收口是把真实候选正确呈现给用户并等待逐图视觉决定。
- 当前 `package.json` 中大量 UI smoke 都隐含执行 `npm run build`；这会级联清空 `dist-mcp`。要在持久运行环境中做性能/界面验证，必须新增或采用隔离构建入口，不能直接复用这些脚本。
- 只读注册表诊断输出包含临时工程、不可用工程、清理建议与 `mutationPerformed:false`，适合纳入本轮真实运行验收。
- 资产版本界面已明确展示 pending 版本、审核依据必填、拒绝/批准按钮和 approved 版本的 Primary Authority 提升按钮；不存在“完全没有人工裁决入口”的缺口。后续要验证的是真实 19 个候选是否进入此工作流、媒体预览是否可读、分页/筛选是否足够。
- 真实《嘟嘟》世界序章托管工程目前只有 1 份 `local-creative-production-unit-materializations` 回执；工程内已有 production/material/generation/command 四类 SQLite 与导入完成基线，但文件结构本身不支持声称 ≥3 个连续生产单元已经物化。
- 视频包源码已覆盖 managed/external storage、最终 CAS barrier、receipt/manifest SHA、发布归档及终格裁图 lineage；是否仍有“外部非协作写入者在首次读取和复制之间换内容”的窗口，需聚焦函数级审查和故障测试，而不能仅凭关键词下结论。
- 真实导入进度显示来源分类共有 `APPROVED_LOCK=19`、`CANDIDATE_LOCK=12`、`FORMAL_MEDIA=97`，但本轮导入 `pendingAssetsCreated=0`、`pendingAssetsReconciled=0`、`authorityPromotions=0`。这证明“来源文件被标成 APPROVED_LOCK”不等于它已进入受管资产审查/主权链；T13 仍需把这些来源锁候选显式映射为可视觉裁决的 pending 版本，且不得自动提升。
- 导入已完成且 167 个媒体均因既有记录被跳过，21 个被策略拒绝，0 失败；内容导入的机械幂等成立，但视觉资产主权闭包尚未成立。
- 真实 SQLite 只读核对结果：production 仅 1 个 WORLD/PROLOGUE 单元（W00，4 panels），`binding_sets=0`、`panel_assets=0`、`mention_analyses=0`；Material Studio 有 234 张受管 image media，但 `assets=0`、`versions=0`、`reviews=0`、`authorities=0`。因此当前画布虽能存图，却还不能从受管资产层直接给 Codex 提供已裁决角色/场景/道具锁。
- W00 单元声明 15 秒，但四格时码仅覆盖 0–12 秒；这可能是源合同保留尾部停顿，也可能是物化校验缺口，必须回读候选合同后判断，不能擅自补时长。
- SQLite CLI 的 `-readonly` 在当前 WAL 持久运行现场返回 `SQLITE_CANTOPEN`，改用普通连接后立即执行 `PRAGMA query_only=ON` 可稳定只读查询；没有写入数据库。
- generation ledger 真实计数为 packs/plans/dispatches/results/call_intents/outbox 全部 0；T15 没有可供 Review PASS → actual-tail → 下一镜冻结的真实 raw 证据，不能用旧图片文件或计划文本冒充。
- Core 已有 `materializeLocalCreativeProductionUnits`，命令合同一次最多允许 3 个 candidateIds，正好符合“最多提前 3 单元”的生产约束。可安全物化相邻 W01/W02 的前提是复读当前 preview fingerprint/source fingerprint，并通过正式命令的 CAS，而非直接改 SQLite。
- 19 个 `APPROVED_LOCK` 的逐项记录全部是 `03_单格raw/...` 或 `04_单格labeled/...`，当前 canonical decision 均为 `category-unresolved`，没有 assetId/versionId。它们实际上是分镜单格结果，不是已经分类的“角色/场景/道具身份母版”；系统正确地没有自动创建权威资产，但“APPROVED_LOCK”扫描标签过宽，容易在项目概览中误导为 19 张待批准角色锁。
- 这 19 条 `category-unresolved` 已被进度文件持久化，真实数据库没有丢失 asset 行；此前“进度与 DB 不一致”的怀疑已排除。真正缺口是：界面需要让用户看图后选择“角色/场景/道具/风格/不应作为资产”，并把明确分类作为一次受管重试输入；程序不得自行分类或批准。
- 当前来源预览重新双扫成功：source fingerprint=`5db4da53…`，preview fingerprint=`d962f0e9…`，共 10 个连续单元/32 panels；W00–W09 都有 raw/labeled SHA。W01/W02 是时间线紧邻且各 15 秒、3 格，可作为 T14 的下一批受管物化目标。
- W00 的真实来源时长就是 12 秒，而 Materializer 为兼容固定单元合同写成 15 秒；这是源适配器的语义差异，不应把 3 秒空档伪造成新增镜头。后续界面/时间线需显示“源内容 12 秒 / 单元容器 15 秒”或显式尾部 hold。
- Renderer 只暴露通用 Material Studio 的“创建资产 → 追加 pending 媒体 → 审核 → 提升”流程；没有发现针对 `category-unresolved` 导入候选的分类/排除入口，T13 需要补这一纵向切片。
- W01/W02 已通过正式 `materialize_local_creative_production_units` 命令一次提交成功：来源 pre/post 双扫为 current，预览与来源 CAS 匹配，两个单元 disposition 均为 created，回执 fingerprint=`6190adf9…`；现在真实工程已有 W00–W02 三个连续受管单元。
- 新单元仍按合同标记 `assetBindingReadiness=blocked-unresolved`；这不是失败，而是明确禁止在来源参考尚未映射为用户批准 Authority 前直接正式生图。
- 多媒体时间线已经具备严格的四类投影：剧本自动可用；图片以 current PASS raw/labeled 或逐 panel storyboard track 展示；video/audio 没有真实媒体时明确 `missing` 并列 gap。系统不会用候选媒体补位，这符合“不伪造完成”的要求。
- `storyboard` 时间线绑定必须完整覆盖指定 panel，且媒体必须是受管 CAS image；因此不应把整张宫格粗暴绑定到整单元，应优先使用来源中真实存在的逐格 raw，按 W01/W02 的每个 panel 时码逐格挂载。
- W01/W02 的整张 raw/labeled 已在 Material Studio CAS 中，可解码身份由 SHA 管理；来源是否有全部逐格 raw 仍需从 candidate panel 合同和媒体表逐项核对。
- 真正的参考权威来源是源目录 `01_视觉资产锁/00_允许参考资产.json`，共 19 项，路径与 SHA 均为显式 fail-closed 合同：6 角色、9 场景、1 道具、2 风格、1 烛龙镜头级 VFX。它与扫描器误标为 `APPROVED_LOCK` 的 19 张分镜单格图片是两套完全不同的数据，UI 必须分开显示。
- 允许清单含 `forbidden_reference_markers`，明确禁止 REJECTED/CANDIDATE/UNAPPROVED/planning-only/storyboard-as-identity-reference/meteor-v2；后续导入 pending 资产必须读取这份清单并核 SHA，不能从文件名或聊天记忆猜锁。
- 当前 Canonical Asset 类别只有 character/scene/prop/style，无法准确表达清单中的镜头级 VFX；把 VFX 强塞进角色或风格会破坏用户“VFX 不修改身份母版”的长期规则，应补一等 `vfx` 类别或提供显式的受管 VFX 规则实体。
- W00–W02 的逐格 raw 文件真实存在；Material Studio origins 已找到 W00 四格、W01 G1、W02 三格，W01 G2/G3 需继续按 SHA 对账是否因重复内容只记录其他 origin。
- W01 G2/G3 是真实 2048×858 PNG、普通文件且 SHA 可计算，但既不在导入进度 `mediaByFileId`，也不在 Material Studio CAS；其他 8 个 W00–W02 逐格 raw 均已受管。它们很可能被来源策略归为 rejected/forbidden 或在导入选择中排除，必须先读取当前 ingest 分类证据，不能绕过策略直接挂载。
- 已复现分类误判：W01 G2/G3 当前正式 raw 在验收表中均写“通过”，但同一证据窗口后方还提到“G02 v1 已归入拒绝候选”，扫描器把旧候选的负面语句错误传播给当前 G2/G3，最终将两张 PASS raw 判成 `REJECTED_OR_FORBIDDEN`。这是会让正式素材消失的 P0 来源归因 bug，必须先修复并回归测试。
- 性能审计确认当前不能称“不卡顿”：v5 首卡 4.388s、首 deep raw 19.719s、全部参考 29.142s；36 单元仅 4 个 PASS，且 projection 存在 history/review/raw/pack/references/video/observation 多段串行 IPC。正式 source-build 首卡 <1.5s、30 分钟 soak、真实 AbortSignal 与 SIGKILL 恢复仍缺证据。
- 已修复来源负面语义跨段污染：表格行只按当前行裁决，JSON 只按命中字段行裁决，普通 Markdown/TXT 按目标所在段落裁决；较宽上下文仍保留用于证据展示与 SHA 完整性核对。
- 定向测试新增“当前 PASS + 后续旧 v1 拒绝段落”和“JSON 其他字段 forbidden”两类回归，`tests/local-creative-project-ingest.test.ts` 14/14 PASS；真实重扫中 W01 G1/G2/G3 现均正确为 `FORMAL_MEDIA`。
- 修复后重新执行真实内容同步成功：来源 preview 更新为 `local-creative-f23f…`，新增导入 6 个正式媒体（包括 W01 G2/G3 raw/labeled），既有 167 个幂等跳过，拒绝数由 21 降至 15，0 失败、0 Authority promotion。
- 子代理复核确认真正允许清单 19/19 路径与 SHA 匹配，且 10 个单元声明引用去重集合恰好等于这 19 项；但它们位于源根之外，当前受管 CAS 仍为 0/19。已启动严格清单 staging 纵切，所有媒体先入 CAS，18 项仅 pending，VFX 保持 category-blocked。
- T15 当前存在不可绕过的内容门：generation/review/observation 均为 0，历史 raw/labeled 不能自动继承为 Studio Review PASS 或 actual-tail；完成条件必须是一次真实原尺寸视觉裁决后的 Review PASS 与真实 observed end-state。
- W00–W02 共 10 个 panel 已通过正式 `attach_studio_multimedia_timeline_media` 命令逐格挂载，每条媒体都来自 CAS、`casVerified=true`，时码完整覆盖对应 panel；没有把整张宫格或候选图混入逐格轨。
- 四轨真实投影现为：script available；10 条 source storyboard track 可读；approved storyboard 仍 missing；video missing；audio missing。三个单元都保留 required gap `approved-storyboard-unavailable`，没有用来源 QC 冒充 Studio Review PASS。
- 发现一个 UI 真实性问题：顶部“图片”可用性直接复用 approvedStoryboard 状态，因而即使逐格 source storyboard 已在轨道中，仍显示“图片缺失”。应改为 `source-only/来源图未审`，同时保留 required PASS gap，避免用户误以为图片没有落入画布。
- 已修复上述 UI/投影语义：当 source storyboard track 存在但没有 current PASS raw/labeled 时，顶部状态显示 `source-only / 来源图未审`；`approved-storyboard-unavailable` 仍是 required gap。真实 W01 复验为 script=available、storyboard=source-only、video/audio=missing、3 tracks。
- 时间线定向验证：Core 更新用例 1 PASS、UI 合同 5/5 PASS、`npm run typecheck:app` PASS；未运行完整 ffmpeg 重测，避免在当前持久进程窗口重复 10 分钟级重型链。
- `local-creative-source-inventory.ts` 当前有并发上限 2、在途 Promise 复用和 5 秒完成后缓存，但 API 没有 `AbortSignal`；排队、readdir、逐文件 SHA stream 都不能被调用方真正中止。
- `project-list-refresh-controller.ts` 当前 timeout 只拒绝外层 Promise，随后立即从 `tasksByKey/current` 删除；底层 `fetchProjects` 仍继续运行，用户再次刷新会叠加第二次全量扫描。应让超时任务继续占有 singleflight/drain 槽直到底层真实结束，或在底层支持 Abort 后等待取消确认。
# 2026-07-26 · 本轮补充发现

- Material Studio 已有分页资产列表、详情、待审版本、审片和设置 Primary Authority 的界面与严格命令总线，并非完全缺少“人工裁决能力”。
- 当前真实缺口更窄：批准清单暂存模块未通过公共命令/Project Center 自动触发，T13 的 18 个 pending 资产虽已能在资产库中出现，但还需确认缩略图、来源说明、待审动作和 Primary Authority 提升在真实 UI 中对这批外部清单资产均可用。
- 因此不应另造第二套 Authority Inbox；应把清单验证/暂存接入既有 Material Studio 驾驶舱，并沿用现有 review/set-authority 合同。
- 既有资产详情确实允许 pending 版本填审核说明、批准/拒绝，并在批准后单独提升为硬锁权威；这符合“用户确认具体视觉图，不以抽象方案代替”的安全边界。
- 但版本历史当前只显示版本号、SHA、来源说明和审查按钮，不显示该 pending 版本自己的图片；顶部只显示“当前权威图”。在真实 18 项 pending 清单中，用户无法在同一裁决控件旁确认具体视觉图，这是 T13 UI 的决定性缺口。
- 测试分层尚未固化：默认 Vitest 会包含单文件 1200 秒预算的 `studio-video-package.test.ts`，该文件整合了真实 builder、崩溃恢复、发布 CAS 与 MCP，曾耗时约 19 分钟。普通开发回归若继续默认包含它，会造成“测试卡死”的直接体验。
- Registry 只读诊断当前仍为 68 项，其中 41 项不可用、38 项临时路径；诊断明确 `mutationPerformed=false`。Project Center 已存在逐项目“双击/二次确认只移除登记”的入口，且不会删除素材，因此“人工清理入口”本身已具备，不应再造批量 prune 或自动删除。
- Browser 后台会话当前没有可复用页签。常驻 Electron PID 72055 已运行约一天且父进程为 1；进程命令未暴露 dev URL，监听端口中存在 5173/5180 等多个本机服务，不能猜端口直接验收，需先按 PID/cwd/命令精确归因。
- 精确桌面检查显示 PID 72055 只是 Electron 默认欢迎页（`default_app.asar/index.html`），并非无限画布源码运行实例；5173 与 5180 也分别属于玛法史莱姆和新游戏。此前把该 PID 叫作“常驻无限画布”已失效，必须纠正，不能把它用于任何源码 UI 证据。
- 源码进程在并行代码写入后按设计进入 `runtime-restart-required`，Project Center 的 discover/list 均被 fail-closed；这不是可继续验收的稳定运行态，必须等代码落定后一次性重启源码 dev。
- 当前 dev 日志同时暴露两个独立问题：`unit-write-lease` 最长等待 15 秒，以及画布布局保存因 fingerprint 冲突连续失败。前者说明仍有写者或租约争用，后者说明 UI 在保存冲突后没有自动重读新 fingerprint 并停止重复提交；两者都是“不卡顿”结论的反证。
- 视频包 v5 交叉审查确认 SQLite `CHECK` 对 `NULL` 会放行，必须显式要求 v5 closure fingerprint 非空；同时仍需非空 v3/v4 迁移测试证明 intent、alias、receipt、supersession 与外键完整保真。
- `unit-write-lease` 超时已定位到旧登记工程 `projects/dudu-gaiden-lock-20260723-12a6516c/.aicanvas/locks/unit-write-lease.lock`：文件为空、mtime 为 2026-07-25 23:37:38，当前无进程持有。现有 file-lock 机制把这类崩溃遗留空锁视为活锁并等待 15 秒，缺少可验证 stale-lock 回收，是明确恢复性缺陷。
- 稳定重启源码 Electron 后，真实世界观工程可恢复为 18 assets / 3 units / 10 panels / 259 managed media / 108 documents；资产库按 6 角色、9 场景、1 道具、2 风格正确分页。
- T13 原图审查 UI 已真实通过：嘟嘟 v1 版本卡显示 pending 缩略图、SHA 来源说明、原图检查按钮；点击后只加载单张 `MANAGED CAS ORIGINAL`，画面可读且批准/拒绝仍保持 disabled 直到填写审核说明。全程未作视觉裁决、未提升 Authority。
- Project Center 当前性 P1 已真实复现：核验后状态从“待实时核验”变为“按策略部分接入”，但卡片仍显示导入期 197 files / pending 0；同一工程进入后驾驶舱真实显示 18 assets / 3 units / 10 panels。普通项目列表把导入基线误作当前计数，并会丢最近 verify 投影。
- 布局冲突只合并 nodes，仍可能用 stale-local 覆盖远端 `workflowGroups/draftCanvasEdges/pinnedNodeIds/workspaceMode`；需抽浏览器安全的三方合并函数并做两写入者语义回归。
- Project Center 修复后，来源新鲜度与素材审核事务已拆成两条事实：最近显式 SHA 核验负责 source snapshot/files/bytes，普通轻读取负责当前 pending；不再为了保留来源精确状态而冻结素材审核数量。
- 布局并发保存不能用简单“远端对象 + 本地整表”覆盖：全量节点快照中未变化的条目必须与 base 比较，否则第二窗口远端移动会被旧窗口下一次保存回滚。三方合并已按稳定节点/边/组 ID 关闭该问题；真正同字段冲突明确提示用户，不以 last-write-wins 假装成功。

## 2026-07-26 · P0—Pn 计划重建补充

- 源码并非缺少 Codex 读取入口：`get_studio_production_dashboard` 已提供 overview/units/unit/assets/appearances/queue 聚合投影；`get_studio_generation_control` 已提供 readiness/pack/history/plan/call/active-runs/unknown，并且只在 `pack` 操作逐项重验 media CAS 路径与 SHA 后暴露 control reference 本地路径。
- 但当前真实工程没有 Primary Authority、资产绑定或 Review PASS，所以上述正确接口只能 fail closed；“接口存在”不能替代“真实项目可直接持续生图”。
- 生产驾驶舱的 unit 投影已经合并 Binding、Continuity Review、generation freeze 和 nextAction，但时间线、权威资产和生成 pack 仍分属不同投影。后续应优先做一个内容寻址的“当前单元生成会话快照/引用清单”，减少 Codex 和用户跨多个界面/调用拼装上下文；不得绕过现有 owner 或复制一套状态机。
- 画布已有 lazy thumbnail、分页、36 单元投影上限、raw 投影最多 4 worker、singleflight/drain 与局部加载；因此性能问题不是完全没有治理，而是深层生成/Review/raw/reference/continuity 投影仍有串行等待和重复核验，现有 4–29 秒实测说明需要批量聚合、缓存复用和视口优先，而不是继续堆页面。
- 用户要求的视觉布局应被固化为产品合同：时间线 raw 为主节点，实际冻结使用的角色/场景/道具/风格/VFX 参考位于其下方并逐一连线；候选、REJECTED、UNKNOWN 和来源不明素材不进入正式画布链。
- 连续性需要在产品合同中补足四种引用角色：`canonical_identity`、`continuation_source`、`composition_hint`、`forbidden`；并把 completed/current/reserved 事件边界、两次续作后的重锚计数和原尺寸 Review 后才能写 observed end 作为硬门。

## 2026-07-26 · 三专属代理审计与交换互评结论

### 产品/导演流程

- 用户核心需要是“存剧本和四媒体 → 15 秒拆格 → 权威参考 → 连续生图 → 图文回读”，不是数据库、按钮或 MCP 工具数量。
- 当前 3 单元/10 格和四轨读取是底座；18 个版本全 pending、Primary/Binding/Review/Generation/Observation 全空，决定了产品仍不可正式连续生产。
- 时间线有读取与正式 attach owner，但 UI 缺最小导入、区间绑定和播放；普通剧本视图仍受历史 prompt/QC/索引错误分类污染。
- 画布帮助文案承诺“后台自动生成并回图”，而 runner 只记录 freeze/plan/dispatch；这是必须先修的用户误导。
- 单元中心应成为默认主视图，技术字段默认折叠但不可删除；不整体重写画布，不先做完整 NLE。

### Authority / Binding / Continuity / MCP

- Material DB 真实计数：259 media、18 assets、18 pending versions、0 Review、0 Primary、0 authority event；18 项 SHA 机械核对通过。
- Production DB：3 units、10 panels、10 image timeline bindings、0 BindingSet、0 asset binding、0 continuity evidence、108 documents。
- Generation Ledger：plan/pack/dispatch/result/call/continuity 全部为 0；当前项目没有 generation_unknown，也没有活动锁。
- 现有 Material Authority、Studio Binding、Generation Ledger、Review、Post-result Observation、Command Bus、Video source closure 必须继续作为唯一 owner，不得平行建设。
- 资产类别与本次引用角色必须分开：`canonical_identity / continuation_source / composition_hint / forbidden`。
- VFX 必须是 unit/panel 级暂态视觉约束，不能修改角色永久身份。
- 聚合 bundle 只作带 revision/fingerprint 的只读投影；跨数据库只能标注各自水位，不能冒充全局原子快照。
- 缓存不得给正式写授权；freeze/dispatch/Review/Primary/unknown 前继续直读 owner 与 CAS。

### 性能 / 可靠性

- `runtime-ipc-effect.ts` 当前只豁免两个诊断通道；其余只读 IPC 也逐次运行 runtime gate，而 gate 每次重新 glob/stat/SHA 全源码树，singleflight 只合并在途请求、结算即失效。
- 正式画布投影存在 N+1：每个 PASS 单元重复读取 history、review、raw/labeled、pack/reference、video、observation；旧 4 PASS 样本已产生约 31 次 IPC。
- 多条读路径重复 managed project inspect、schema/WAL 检查和 whole-DB snapshot；同步 DatabaseSync 与 busy timeout 可能阻塞 Electron main。
- 当前 MCP PID 22233 加载旧 `dist-mcp`，记录的 source digest 与当前 `e0dbf26d…` 不一致，且没有 recorded runtime artifact SHA；除 capabilities 外按设计失败关闭。
- 285 个测试文件分区机械闭合为 fast 249、integration 32、heavy 4，但最终 fast/integration/heavy 未在当前源码全跑。
- 当前源码尚无 30 分钟 soak；旧安装版 soak 不能证明现在的源码。

### 互评后的共同红线

- 只审当前纵向切片所需资产，但集合必须来自受管实体分析与人工 select/exclude，不得按文件名自动升权。
- 正常 UI 可折叠 SHA/版本等技术字段，但必须一键展开阻断原因、Review、actual-tail、unknown 和付费边界。
- watcher/TTL 可以加速只读展示，绝不能替代 mutation 提交前强门禁。
- 性能 bundle 前后必须逐字段验证 PASS 选择、SHA、Review/Observation head、pack/currentness/fingerprint 等价。
- 同一只读快照运行前后全树哨兵、SQLite `data_version` 和媒体身份必须不变。
- 真实生图前必须先完成 MCP 当前性、Primary、Binding；实际续作前必须有 Review PASS 与 observed actual-tail。

### 计划入口

- 唯一执行计划：`.planning/2026-07-26-production-hub-closure/next_phase_plan.md`
- 可复制 `/goal`：`.planning/2026-07-26-production-hub-closure/GOAL_P0-P9_持续执行提示词.md`

## 2026-07-26 · P0 实施期新增证据

- 不能按 `get/list` 名称把 Studio 读取接口直接放进短 TTL：`requireManagedStudioProject()` 会初始化 generation ledger/切换 watcher，Material/Production 多条读取又会打开可写 SQLite、执行 schema/WAL 初始化。把这些通道误列为只读，会让源码漂移后的旧进程在缓存窗口内继续产生持久副作用。
- P0 的安全切法确定为：未知通道默认 `mutation`；外部选择器、shell、剪贴板单列 `external-side-effect` 但仍走强门禁；只有经端到端零写证明的通道进入 `read-only`。首批只包含活动项目登记读取、默认受管根读取和内存操作状态读取。
- 只读 currentness 缓存必须由与 `computeSourceDigest` 同源的 watcher 驱动失效；watcher 未 ready、报错或核验期间 epoch 改变时不得保存通过结果。mutation/background write 永不复用只读缓存。
- 当前 live MCP 仍不可用于生产：源码已声明 201 工具，旧 release manifest 为 200；PID 22233 没有 recorded artifact SHA，且源码 digest、manifest digest、在线记录 digest 不一致。维护切换必须使用隔离构建的完整不可变 `dist-mcp` 树，不能只替换入口文件或直接覆盖 live 目录。
- 画布“开始”入口已完成源码真实性修正：按钮和反馈只承诺 freeze/plan/dispatch 记录，明确等待 Agent 领取；Review、音频、视频未接入该按钮时不再承诺自动生成或自动回图。
- MCP 的 `readOnlyHint` 不能作为物理只读证据。审计确认旧活动上下文至少有三条隐藏写：注册表 snapshot 会创建 lock；Dashboard 会初始化 ledger/目录/SQLite/WAL；写租约读取会再次创建 lock。`openSqliteReadOnlySnapshot` 还会在临时目录写 SQLite 副本，因此也不属于“全文件系统零写”。
- 当前确认物理零写的 MCP 最小工具集为 `get_canvas_state`、`list_context`、`list_story_sources`、`list_story_chapters`、`read_story_chapter`、`list_story_events`、`list_voice_identities`、`list_asset_relations`。其余 Studio get/list 在完成真实 query-only owner 重构前继续使用 mutation 强门禁。
- MCP runtime gate 采用与 Electron 相同的 watcher/短 TTL/singleflight 语义；诊断只给出状态，所有 mutation/外部动作仍逐批重新读取加载工件并计算源码摘要。未知工具默认 mutation，不能因名称看似只读而放行。
- `get_capabilities` 原来会在自身内部再次解析 build identity/currentness；现支持注入 MCP 启动时缓存的 BuildIdentity 与刚完成的门禁投影，避免 `get_capabilities → active context` 的重复整仓 SHA。视频引擎/机器媒体能力探针仍是诊断控制面，不纳入正式工程物理零写承诺。

## 2026-07-26 18:11 · P0 交接前复审结论

- 活动生产上下文现使用无锁 registry 双读、无锁 write-lease 展示和 immutable SQLite 投影；非空 WAL 会诚实降级，查询前后文件身份变化会失败关闭。物理零写集成测试已证明 registry、active pointer 与工程文件树内容、mtime、目录均不变，且无 lock/tmp/WAL/SHM 新增。
- MCP handler 已把启动时核验的 `runtimeBuildIdentity` 注入活动上下文，关闭 `capabilities → active context` 隐藏重复摘要；2 秒 TTL 集成测试实测 digestCalls=1。
- mutation 强检查仍有 epoch 竞态：如果 watcher 在强核验进行中失效，当前实现可能返回刚完成但已过期的允许结果。下一修复必须捕获检查前 epoch，并在检查后比较；变化则有界重验，无法稳定时失败关闭。
- MCP stdio 目前主要依赖 transport close 释放 watcher。需补 stdin `end`/`close` 和受管退出信号的幂等 shutdown，确保 watcher、transport、server 和 gate 全部释放，避免 EOF 后进程仍存活。
- MCP 包装器把“返回 `toolError`”视为成功，且门禁抛错时 gate duration 可能保持 0；这会让观测数据低报失败和门禁成本。修复时应同时覆盖返回错误和抛异常两条路径，并补专门测试。
- `get_capabilities` 仍会探测视频引擎/机器媒体能力，因此属于诊断控制面，不应纳入项目数据物理零写承诺。
- 当前正式 MCP 仍是 PID `52412` 的旧 `dist-mcp/mcp/server.js`，SHA-256 `7a03dc05a8b1427dea2c4ec5bfc97662e8cc7cb82a4dcacb73e244aba99c8c60`；配置没有 recorded runtime artifact SHA。本轮没有生成正式候选、没有切换运行时。
- P0 只能写为 PARTIAL：三套类型检查与最终 3 文件/9 测试通过，但完整 fast、隔离当前源码 build、源码 UI、候选产出、维护切换和 live 探针均未完成。

## 2026-07-26 晚 · P0 关账期新增发现（含三代理互评结论）

- mcp.test.ts 的 30 秒超时根因：数十次 mutation 工具调用 × 每次约 200ms 全仓摘要门禁 + 785 行断言体量，自身耗时 43-81 秒波动；与 P0c 修复无关（mutationEpochRetries=0、冷启 752ms）。它不匹配 `mcp-*` glob 故留在 fast——测试分层按文件名 glob 的结构性缝隙。
- Node 22.22.2 的 node:sqlite 无 enableDefensive 且 defensive 默认关（writable_schema 直接可用）；涉及该 API 的测试须 feature-detect。
- mcp-process-guard 锁获取"读→查存活→写"非原子（writeClaim tmp+rename 非 wx），双进程 SIGKILL 重启窗口可双写 claim；panel 互斥闸 assertPanelNotInFlight+INSERT 无 BEGIN IMMEDIATE——双进程可能重复 run（中高）。P0.6+P8 处置。
- 双进程 in-memory invalidationEpoch 互不可见：P0c epoch 修复隐含单进程假设，跨进程伪陈旧读场景纳入 P8 验收。
- Codex 入口 nextAction 为硬编码 degradedNextAction 系防高频入口同步开 ledger 的故意设计（active-managed-studio-context.ts:287-288 注释）；修复须二级方案（入口轻量，权威值经 buildUnit 受限路径按需取），禁止把 N+1 平移进单次调用。"人类通道真、Codex 通道假"是同一北星承诺的双标状态，P2 消除。
- 一致性锁链两端断裂实证：canonical_identity/composition_hint 全仓 0 命中（continuation_source 有约 10 处真实调用，P1 只需补 3 语义）；NextShotContinuitySnapshot 字段齐备但零调用，实际落库为扁平 13 字段。
- 跨集资产复用为三代理一致认定的最大产品盲区；正确合同=只读 content-addressed 导出包（SHA+来源），导入进目标项目自身 pending 重审，不跳 gate、不做活体克隆（P3.5 合同 → P6.5 实现）。
- live 零写探针语义教训：真实工程带历史 wal/shm/locks 残留，"存在即失败"仅适用纯净 fixture；live 断言须用"净新增为零"，且探针自身进程要以 ALLOW_MULTI 启动避免自写 singleton 锁污染快照。
- 时间线 UI 提前须拆两级：仅播放已缓存派生物可并入 P2；按需生成+多单元并发播放必须与并发限流/负缓存同批（media-derivatives 现无限流）。
- shell inspection 加缓存必须与"剧本变更主动波及清单"绑定同批验收，否则缓存读过期数据。

## 2026-07-27 13:20 · Grok current-source live 追加发现

- Grok MCP 的握手失败不是 202-tools 候选包失效：`~/.grok/config.toml` 仍记录旧 sourceDigest，且缺当前 runtime artifact SHA，同时已有 Codex MCP 单例。备份后校正 recorded identity、artifact SHA 与 `AI_CANVAS_MCP_ALLOW_MULTI=1`，doctor 即恢复 handshake / 202 tools PASS。
- 当前 Grok Build Imagine 生图能与 sourceDigest `d4b07c20…` 的冻结包闭合：一次 `image_gen`、raw SHA、attestation、labeled、Review 全部可验证；但工具没有密码学供应商回执，必须保留 `cryptographicProviderReceipt=false`。
- Dashboard 的 fail-safe 降级不能被 Review PASS 覆盖或删证据。首次 live canary 返回 `generation-projection-degraded`；零新增生图机械回放连续三次 `approved-raw-ready`，说明当前没有稳定复现，但也不能冒充同一临时 runtime 的原位恢复。
- 合成 canary 的 approved 控制参考是机械夹具，不是正式黄金面具权威图；即使视觉 Review PASS，也只能写 `synthetic-canary-contract`，不得提升为 `productionContinuityPassed=true`。
