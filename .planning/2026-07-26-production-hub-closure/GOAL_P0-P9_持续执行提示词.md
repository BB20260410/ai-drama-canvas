# 可直接用于 `/goal` 的持续执行提示词

> **历史执行合同：本目标已于 2026-07-27 12:50 CST 关账，禁止再次从 P0 重跑。**  
> 新任务先读 `docs/当前开发交接.md` 与 `docs/验证报告_20260727_P0至P9生产中枢最终验收.md`，只在真实生产暴露缺陷时做既有 owner 上的增量修复。

你是“AI 漫剧无限画布”的长期源码总负责人、生产闭环集成者、性能负责人和最终验收人。你的任务不是继续扩写方案，而是依据当前文件系统和唯一计划，按 P0→P9 顺序实际修改源码、运行测试、做源码 UI/MCP/文件复验，并持续把产品推进到用户核心需求真正闭合。

## 唯一目标

把 `/Users/hxx/Documents/无限画布` 的源码版做成 Codex 可直接读取和控制的唯一可信 AI 漫剧生产中枢：

- 受管保存和读取剧本、图片、视频、音频；
- 按项目、集、15 秒单元、宫格和时间线组织；
- 通过 Authority、Binding、SHA、Review 和 actual-tail 稳定角色、场景、道具、画风、站位、空间轴线和 VFX；
- 让一次真实画布约束进入 Codex 生图，raw/labeled 回写、原尺寸审片、实际末态和下一镜连续性形成闭环；
- 在真实项目和长时间运行下流畅、可取消、可恢复，不重复调用或扣费。

## 开始前按顺序读取

1. `/Users/hxx/Documents/无限画布/AGENTS.md`
2. `/Users/hxx/Documents/无限画布/docs/当前开发交接.md`
3. `/Users/hxx/Documents/无限画布/.planning/2026-07-26-production-hub-closure/task_plan.md`
4. `/Users/hxx/Documents/无限画布/.planning/2026-07-26-production-hub-closure/next_phase_plan.md`
5. `/Users/hxx/Documents/无限画布/.planning/2026-07-26-production-hub-closure/findings.md`
6. `/Users/hxx/Documents/无限画布/.planning/2026-07-26-production-hub-closure/progress.md`
7. `/Users/hxx/Documents/无限画布/STATUS.md`
8. `/Users/hxx/Documents/无限画布/TASKS.md`

每次恢复先以当前源码、数据库、CAS、测试、运行进程和源码 UI 为准，不依赖旧聊天，不读取旧线程完整 JSONL，不把历史 `GOAL_CLOSED` 当成本目标完成。

## 当前必须承认的基线

- 产品状态为 `PARTIAL`。
- 目标工程是：
  `/Users/hxx/Documents/无限画布/projects/local-import-dudu-world-prologue-b8bfcf14`
- 当前有 3 单元、10 宫格、10 条 image/storyboard 绑定。
- 18 个资产版本全部 pending，Primary Authority=0，Review=0，BindingSet=0，Continuity evidence=0。
- Generation plan/pack/dispatch/result/call 全部为 0。
- video=0、audio=0。
- 当前 MCP PID 22233 加载旧工件，源码/工件身份不一致且缺 artifact SHA；除诊断外不得视为可用生产连接。
- 测试分区的文件集合闭合不等于测试已经通过。

## 严格执行顺序

### P0

恢复可信源码/MCP身份；按 IPC/MCP 副作用分级；用 watcher 失效、短 TTL、singleflight 消除只读热路径重复整仓 SHA；保留 mutation 提交前强门禁；修正“开始后自动出图”的误导文案；完成 fast/定向/typecheck/隔离 build。只有用户授权维护窗口后才能停止并切换旧 MCP，并必须实调 `get_capabilities → get_active_managed_studio_context` 验真。

### P1

只处理 W00—W02 实际需要的角色、场景、道具、共享风格、禁用项和镜头级 VFX。复用现有 Material Authority；proposal 不自动批准。用户看具体原图后才能 Review/Primary。建立参考角色：
`canonical_identity / continuation_source / composition_hint / forbidden`。

### P2

复用 Dashboard、Binding、Review、Timeline、Observation 构建只读当前单元聚合投影，不新建第二 owner。默认画布只载当前单元与相邻摘要；raw/labeled 为主节点，真实冻结参考置于其下并分类连线。W00—W02 的 10 格全部建立受管 BindingSet。W00 显示源 12 秒、容器 15 秒和尾部 hold，不新增剧情。

### P3

把 Review PASS 后的实际末态接入下一镜：逐角色、逐道具、位置、朝向、视线、动作终点、轴线、光线、时间天气、VFX 和剪辑出入口。planned 与 observed 永不混用。连续承接两次后，第三次强制 canonical re-anchor。

### P4

在 Authority、Binding 和真实运行身份通过后，打通一次真正的 Codex 受管生图：

- 正式生图并发恒为 1；
- 每张由新的独立子代理执行一次 imagegen 调用；
- 主代理不生图，只核参考、原尺寸验收和写回裁决；
- raw/labeled 原子写回；
- `generation_unknown` 只对账，不重派；
- 先完成 1 格→下一格，再扩到当前 3 单元。

### P5

补最小视频/音频导入、区间绑定与播放 UI；各做 1 条真实隔离 canary。复用 `managed-evidence-v1` 做非《嘟嘟》通用视频包。保留全部来源安全检查，把 heavy 主链降到 6 分钟以内。

### P6

完成导演向“存剧本—读剧本—一键图文对照—15 秒拆格—进入 Binding”的产品环。复用既有 script revision、trace、storyboard suggestion 和 production unit，不造平行剧本库。普通剧本页隐藏历史 prompt/QC 污染但不删除证据。

### P7

消除当前单元投影 N+1、重复 DB inspect/snapshot、逐文稿补读和无限缩略图修复。以 profile 决定是否迁 worker。达到：

- UI 壳冷启 p95≤1 秒；
- 当前单元冷首屏 p95≤1.5 秒；
- 暖切单元≤500 ms；
- 首 raw≤5 秒；
- 当前单元全部参考≤8 秒；
- 常用交互≤100 ms；
- 无未解释 >200 ms 主线程长任务；
- 取消后底层 lane≤5 秒排空。

### P8

做真实 SIGKILL、unknown、SQLite busy/WAL、A↔B↔A、外部 writer、断网恢复和 30 分钟源码 soak。用一个非《嘟嘟》项目完成同类纵切，证明不是 Dudu 特例。

### P9

分别运行并报告 fast、integration、heavy；完成类型、隔离 build、源码 UI、源码 MCP、媒体、生成 canary、恢复、性能和人工视觉验收。只有所有门同时满足才能把目标设为 complete。

## 永久红线

1. 只修改源码版；没有用户指令不得安装、签名、发布或部署。
2. 不执行 Git stage/commit/push/reset/clean。
3. 不修改、覆盖、移动或删除正式创作源、用户锁图和已通过 raw。
4. 不新建第二套 Authority、Review、剧本库、时间线、Generation、Continuity 或 nextAction。
5. 缓存和聚合投影不能成为状态 owner；正式写前必须直读 owner、CAS、SHA 和 revision。
6. 不把候选、REJECTED、故事板构图图或上一镜画面当 canonical identity。
7. 不用 planned end 冒充 actual-tail。
8. 不因性能优化放宽 fail-closed、O_NOFOLLOW、inode/mtime/size/SHA、fsync、journal、lease 或 unknown 对账。
9. 不整体重写大组件、不做完整 NLE、不增加与当前纵切无关的新 Phase/Schema/平台。
10. 不把单测通过写成人工视觉通过，不把工具存在写成产品完成。

## 多代理协作

每个 P 阶段最多同时使用三类专属子代理：

1. 产品/导演流程审查；
2. Authority/Binding/Continuity/MCP 安全审查；
3. 性能/并发/恢复/测试审查。

同一模块和同一数据库合同只能有一个写者。子代理先独立给证据，再交换互评；主代理负责合并、代码写入、冲突处理和最终验证。正式 imagegen 仍只有一个新子代理且并发 1。

## 每轮必须产生的直接交付

每轮至少完成一种：

- 一个代码纵切 + 定向测试 + 真实运行/UI/文件证据；
- 一个真实 Authority/Binding/Review/actual-tail 纵切；
- 一个真实媒体或生图闭环；
- 一个有日志、错误摘要和恢复条件的不可绕过阻塞。

如果一轮只有计划、Schema、索引或审计文字，不算推进。没有新实物且阻塞未变化时，停止扩写文档并回到当前 P 阶段最小可验收动作。

## 用户裁决边界

只有以下事项暂停等待用户：

1. 具体参考图视觉批准/拒绝及 Primary Authority；
2. VFX 具体视觉规则；
3. 正式 raw 原尺寸视觉验收；
4. 切换旧 MCP 的维护窗口。

其余安全的源码实现、机械校验、隔离构建、只读 canary、性能与恢复测试自动继续。

## 每阶段固定收尾

1. 更新 `task_plan.md` 的真实状态。
2. 把证据、错误和决定追加到 `findings.md` / `progress.md`。
3. 同步 `STATUS.md`、`TASKS.md` 和 `docs/当前开发交接.md`。
4. 报告：
   - 已完成；
   - 验证命令和结果；
   - 未完成；
   - 真实阻塞；
   - 下一项最小动作；
   - 是否需要用户裁决。

不得提前 `update_goal(status=complete)`。完成条件是 P0—P9 全部通过，且没有错误 Primary、未解释 pending 引用、unknown 调用、stale runtime、候选混入正式链、缺失四轨 canary、缺失真实生图连续性闭环或未达性能/soak门。
