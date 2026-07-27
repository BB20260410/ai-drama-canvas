# Task Plan: 无限画布生产中枢纵向闭环

## Goal

在只修改源码版本、不安装应用、不触碰正式创作源文件、不执行 Git 操作的前提下，按真实性状态与运行身份、文档/资产裁决、真实单元与时间线、实际末态连续性、通用视频包、运行性能的顺序，完成可复验的纵向产品闭环；随后组织多子代理互评、找 BUG、全面测试，并继续执行互评得出的下一项最小改进。

## Current Phase

Phase 13（P0—P9 已完成并最终验收）

## Overall Status

**CLOSED（源码 + 隔离本机候选包范围）**：P0—P9 全部完成。正式 Dudu 工程真实 Codex 生图、Review/actual-tail、四轨媒体、剧本产品环、跨项目资产复用、性能、30 分钟 soak、六阶段 SIGKILL 恢复、非 Dudu 真实工程隔离 canary、266 媒体完整性和 302 files / 1699 tests 均有落盘证据。未安装、签名、公证、发布或执行 Git。

## Phases

### Phase 1: 基线、边界与现状复核
- [x] 核对项目级规则、交接、活动写者、源码/构建/运行身份和脏工作区
- [x] 固定允许修改范围与真实 canary，不覆盖用户已有改动
- [x] 记录当前失败复现与回归基线
- **Status:** complete

### Phase 2: 真实性状态与运行身份
- [x] 增量源快照/失效检测，拆分 CURRENT/PARTIAL/STALE/FAILED/NOT_APPLICABLE
- [x] Project Center 展示源总量、覆盖率、排除原因和 limit 命中
- [x] 运行时 build/source 身份握手与过期写入门禁
- [x] 用嘟嘟世界观真实漂移作为 canary 定向验证
- **Status:** complete

### Phase 3: 文档分类与资产裁决
- [x] 文档分类与全文索引边界，避免提示词/报告污染剧本库
- [x] 未分类/pending 资产裁决入口与 Primary Authority 安全门
- [x] 现有引用分页与摘要 revision/fingerprint 补齐
- **Status:** complete

### Phase 4: 真实单元、Canonical Panel 与时间线
- [x] 按项目适用性区分 story-production 与 not-applicable
- [x] 从本地证据预览并物化真实 unit/panel，不凭文件名臆造
- [x] 明确 Studio panel revision 为编辑事实层，旧 Storyboard/Fusion 为导入或只读投影
- [x] 绑定已有 raw/labeled 单元并验证重启恢复
- **Status:** complete

### Phase 5: Review → ObservedEnd → 下一镜闭环
- [x] 建立内容寻址的实际末态观察收据并绑定 raw/尾帧 SHA 与 Review fingerprint
- [x] planned 与 observed 分离；无当前 PASS 收据时 fail closed
- [x] 接入下一镜连续性与 Seedance 编译链
- **Status:** complete

### Phase 6: 通用视频包
- [x] 抽象项目无关 VideoPackageSourceAdapter，保留 Dudu legacy adapter
- [x] 消除固定 S1E1 路径/模块依赖
- [x] 用非 Dudu 真实受管工程隔离副本完成 raw/labeled → JSON/Markdown → manifest/receipt 复验
- **Status:** complete

### Phase 7: 运行性能与 UI 真实验证
- [x] 增量文件索引、紧凑摘要、分页详情、局部投影和资源释放
- [x] 当前源码完成 fast/full、切换、媒体分页与负载回归；长时 soak 留入下一阶段
- [x] 源码 Electron/UI 真实验证；不安装应用
- **Status:** complete

### Phase 8: 多代理互评、BUG 修复与全面回归
- [x] 至少三条独立审查：数据真实性/安全、产品闭环、性能/UI
- [x] 交叉互评并修复已确认的数据安全、连续性、发布和 UI BUG
- [x] 定向测试、第二轮全量测试、类型检查与源码运行/UI；未覆盖安装版
- **Status:** complete

### Phase 9: 下一步优化计划与首个切片执行
- [x] 基于实际结果形成下一阶段详细计划
- [x] 执行首批切片：4 路身份核验、导入基线校正、dev 源码摘要、运行门禁四态
- [x] 执行互评整改：不可变导入收据、门禁前置、重绑恢复、receipt 同事务 CAS、异步读排空
- [x] 建立 36 单元源码 dev 硬预算 smoke，并以真实 Core/图片解码链通过
- [x] 执行交换复审整改：项目中心收据核验、跨工程 lane、多跳时钟回拨、唯一媒体/节点规模门、完整视频输入闭包 CAS
- [x] 更新真实交接、STATUS/TASKS 与最终证据
- **Status:** complete

### Phase 10: 全量剩余任务与依赖门审计
- [x] 从当前源码、TASKS、真实受管工程和运行进程重建唯一剩余清单
- [x] 三代理分别审计产品流程、数据权威/Codex 接入、性能/卡顿，并完成交换互评
- [x] 区分可直接实施、需要用户视觉裁决、需要维护窗口和当前无真实样本的任务
- [x] 形成唯一 P0—P9 计划和可复制 `/goal` 执行合同
- **Status:** complete

### Phase 11: P0—P2 可信运行、权威与单元驾驶舱
- [x] P0 恢复源码/MCP身份、修复只读热路径重复校验和生成入口误导（2026-07-26 21:45 关账）
  - [x] P0a IPC/MCP 副作用分类、TTL/singleflight、watcher 失效和真实入口文案
  - [x] P0b 活动生产上下文物理零写投影与冷暖时延集成证据
  - [x] P0c mutation epoch、stdio shutdown 和失败/门禁指标真实性（双路审查闭环）
  - [x] P0d 完整 fast 冻结轮、隔离 build/UI、不可变候选 673a2ebe、切换与 5/5 live 探针
- [x] P0.5 测试分层健康化；P0.6 guard 锁原子化与真实双进程竞争复验
- [x] P1 完成 W00—W02 所需最小 Authority、引用角色和镜头级 VFX
- [x] P2 完成 10 格 BindingSet、当前单元聚合投影、Codex 入口、时间线轻投影与重启恢复
- **Status:** complete

### Phase 12: P3—P6 连续性、真实生成、四轨与剧本产品环
- [x] P3 接通 Review PASS → observed actual-tail → next freeze
- [x] P4 完成一次真实 Codex 受管生图及下一格承接
- [x] P5 完成视频/音频 canary、真实播放和通用视频包
- [x] P6 完成存、读、图文对照、15 秒拆格产品环与 P6.5 跨工程资产复用
- **Status:** complete

### Phase 13: P7—P9 流畅度、可靠性、跨项目与最终验收
- [x] P7 达到首屏、首 raw、全部参考、交互、取消和 IPC drain 硬指标
- [x] P8 完成 30 分钟 soak、六阶段 SIGKILL/unknown 恢复和非 Dudu 真实工程隔离 canary
- [x] P9 完成机械、运行、视觉、性能、完整性和 302 files / 1699 tests 总验收
- **Status:** complete

### Phase 14: 关账后用户授权的 Grok current-source live 追加验收
- [x] Grok MCP 校正到当前 202-tools 源码身份并完成只读 capabilities / active context 探针
- [x] 全新隔离合成工程完成一次 Grok Build Imagine `image_gen`，并发 1、无重试
- [x] 完成 raw/labeled、独立原尺寸 Review、原子登记与供应方会话自证
- [x] 保留首次 Dashboard fail-safe 降级，并以零新增生图机械回放完成 3/3 恢复验证
- [x] 定向回归、证据、STATUS/TASKS/交接与最终报告更新
- **Status:** complete

## Decisions Made

| Decision | Rationale |
|---|---|
| 仅修改源码版本，不安装应用 | 用户永久规则；安装留到产品完全成型后 |
| 不触碰正式创作源目录 | 本任务是产品研发，canary 只读使用真实源文件 |
| 正式生图并发保持 1，本轮默认不生图 | 优先修复生产中枢；现有 raw/labeled 足以验证闭环 |
| 先纵向小切片，不先大重构 | 每个阶段都要有代码、测试和真实运行证据 |
| 旧活动计划不删除，仅切换 active pointer | 保留历史生产状态，避免覆盖用户工作 |
| 只读聚合和缓存不是事实 owner | 继续复用 Material/Binding/Generation/Review/Observation，避免第二套真相 |
| 用户已将本目标内全部裁决授权给主代理 | 主代理可执行具体视觉验收、Authority/Primary、VFX规则、raw验收和MCP维护切换；仍须保留证据且不得安装或覆盖正式素材 |
| 2026-07-26 18:11 执行交接，不继续 P1（历史） | 当时保留 P0 为 PARTIAL；该状态已被 2026-07-27 P0—P9 最终关账接替 |
| 当前最终候选不安装 | 原目标边界是源码与隔离候选验证；安装、签名、公证、公开发布需单独授权 |
| P7 允许字节级运行时等价转移 | 最终包自身有直接严格 PASS；与稳定 5 样本包仅内嵌 sourceDigest 常量不同，renderer/MCP/Electron 与归一化主进程均相同；高负载失败样本继续保留 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 当前 active plan 指向未完成的青灯客 P1 生图计划 | 1 | 保留原计划文件，创建新的独立研发计划并切换 active pointer |
| 新不可变完成收据上线后，真实工程旧终态进度被正确降为 `UNVERIFIED` | 1 | 先双重全量内容哈希，确认 309 文件稳定，再幂等重导入；收据有效且 live/preview/baseline 三指纹一致 |
| 36 单元 smoke 前三次被临时 fixture 的豁免、连续性和 registry 门禁拒绝 | 3 | 不放宽门禁，逐项修正隔离 fixture；第 4 次真实进入源码 Electron 并通过全部硬预算 |
| v4 规模门的 4 个 raw/参考实际各复用同一 SHA，且只渲染 1 个可见节点 | 1 | v5 将 36 个实际 VueFlow 唯一节点、4 个唯一 raw SHA/URL、4 个唯一参考 SHA/URL 全部升为硬门；14/14 PASS |
| Video receipt 首轮补丁只在 barrier 后复核 managed source，未重读完整输入闭包 | 1 | 主动纠正表述并复用 `externalFromIntent`；Canonical Unit 与 Observation 两项完整闭包竞态重新实跑 PASS |
| 当前最终包重复性能样本被本机高负载扰动 | 2 | 不删除失败、不降阈值；核对最终包直接 PASS，并以 7903 文件逐项 diff 证明与稳定 5 样本包仅 sourceDigest 常量不同，形成独立等价转移证据 |
