/**
 * ============================================================================
 * P2 · StudioProductionProjectionBundle — 只读聚合投影设计草案（DRAFT，未接入仓库）
 * ============================================================================
 *
 * 本文件是调研产出的设计草案，写在 scratchpad 供主代理裁决，
 * 不属于 /Users/hxx/Documents/无限画布 仓库的一部分，未被任何模块 import。
 *
 * 设计合同来源：
 *   1) .planning/2026-07-26-production-hub-closure/next_phase_plan.md
 *      第 4 节"永久设计红线" + 第 5 节 P2「让画布成为'当前单元驾驶舱'」
 *   2) .claude/skills/ai-drama-canvas-agent/SKILL.md 的"P8 驾驶舱合同"
 *      （已实现且已 PASS 的既有契约，编号与 next_phase_plan 的 P2/P8 不同，
 *       本 bundle 是在其基础上做"扩展聚合"，不是替代/重做）
 *
 * 本轮修正说明（独立核对代理复核后的二次修订）：
 *   核对代理指出 4 处问题——3 处必修 + 1 处补全，均已在本稿逐一核实真实
 *   源码签名后修正，详见每处代码旁的修正注释。修正过程中额外发现的
 *   "假条件类型 / 过度防御性 cast / 字段遗漏 / 复制粘贴错误" 一并清理，
 *   不再等下一轮才修。修正范围严格限定在本文件内；仓库任何文件未被写入。
 *
 * ----------------------------------------------------------------------------
 * 一、设计决策（含依据）
 * ----------------------------------------------------------------------------
 *
 * D1. 零新状态机 / 零新 DB：
 *     buildStudioProductionProjectionBundle() 本身不持有任何状态、不开新的
 *     .sqlite 文件，只编排（orchestrate）以下已存在且已 PASS 的 owner 读接口：
 *       - studio-production-dashboard.ts  getStudioProductionDashboard()  — 复用 buildUnit 全部既有逻辑
 *       - studio-binding-control.ts       getStudioBindingControl()
 *       - studio-continuity-review-control.ts  getStudioContinuityReviewControl()
 *       - studio-generation.ts           queryStudioGenerationFreeze()
 *       - studio-generation-review.ts    getStudioGenerationReviewControl()
 *       - studio-generation-ledger.ts    readAnyStudioGenerationFrozenPack()
 *       - studio-post-result-observation.ts  getStudioPostResultObservationControl()
 *       - studio-multimedia-timeline.ts  getStudioMultimediaTimelineProjection()
 *       - studio-production.ts           getStudioCanonicalSuccessorUnitIds()
 *       - studio-video-package.ts        getStudioVideoPackageControl()
 *       - material-studio.ts             getStudioMedia() / getStudioCanonicalAsset()
 *     bundle 唯一新增的是"编排 + 裁剪 + 打水位戳"的胶水层，字段全部来自上述
 *     owner 的已有返回值，没有一个字段是 bundle 自己算出来的业务判断
 *     （nextAction 仍 100% 取自 Core，见 D5）。
 *     【本轮修正】上述 11 个函数此前有 4 个只在 import 里声明、骨架 body 内
 *     未被真正调用（getStudioBindingControl / readAnyStudioGenerationFrozenPack /
 *     getStudioVideoPackageControl / getStudioCanonicalAsset）。本稿已逐一读
 *     真实签名后补上真实调用点（buildPanelFrame 与主入口内），文档声称与
 *     骨架实现现已一致，见下方"二、映射表"更新说明与函数体注释。
 *
 * D2. "每格 raw/labeled 引用"不是逐格独立文件，是 unit-grid 级共享资产：
 *     读 ManagedStudioCanvasView.vue 的 rawProjectionWorker（第 2716-2886 行）
 *     确认：一次正式生成产出整个 2-6 格网格作为"一张图"，raw/labeled 是
 *     unit 级别的一对媒体（由 resolveUnitGridSelectedResultIdentity 解析出
 *     唯一 raw sha256 后 getStudioMedia 一次），不是每个 panelId 各自一份。
 *     因此本设计把 approvedRaw / approvedLabeled 放在 currentUnit 顶层，
 *     每个 panel 只带 panelIndex（客户端按 index 裁剪/定位到网格里的自己），
 *     不再重复引用。
 *     但 continuity review 与 generation freeze **确实是逐格（panelId 维度）**
 *     的状态（getStudioContinuityReviewControl / queryStudioGenerationFreeze
 *     的入参都要求 panelId），因为同一张网格图里每一格的人物/场景/道具连续性
 *     约束是独立判定的——这是本 bundle 相对于 buildUnit 现有返回的最主要扩展点，
 *     见下方"二、字段差集"。
 *     【本轮修正新增】binding（逐格绑定状态）同样是逐格维度，且 dashboard 的
 *     panel 摘要本身已经带了 status/statusReason/bindingCurrentness/
 *     bindingSetId/bindingFingerprint（见 StudioDashboardPanelSummary），
 *     本 bundle 额外调用 getStudioBindingControl() 补的是 dashboard 摘要里
 *     没有的结构化 blockers/freezeAllowed/confirmEmptyAllowed，两者不是
 *     重复读取而是互补（一个给状态结论，一个给结构化原因/可操作性）。
 *
 * D3. 单库同一只读事务快照，跨库各自水位，不伪称全局原子：
 *     - studio-production.sqlite（production + multimedia-timeline 共用）
 *       与 studio-generation-ledger.sqlite（generation-ledger +
 *       post-result-observation + generation-checkpoint + **video-package**
 *       共用，本轮核实 studio-video-package.ts 的 generationDatabasePath()
 *       与 ledger 是同一物理文件）是两个独立物理文件；owner 模块各自内部
 *       管理只读快照（如 studio-post-result-observation.ts 的
 *       openObservationReadSnapshot，模块私有，未导出）。
 *     - bundle 层因此不构造跨文件事务，而是让 currentUnit / timeline /
 *       observation.own / observation.incoming / adjacentUnits / 每个 panel
 *       各自携带一个
 *       StudioProjectionRevisionStamp{source, fingerprint, revision?, currentness}，
 *       source 显式标注其物理来源库，调用方（UI）据此各自判断陈旧与否，
 *       不做"全部一致才算成功"的假原子聚合。
 *     - 对 studio-production.sqlite 内部（production 表 + timeline 表）两个
 *       owner，由于同属一个物理文件，理论上可以在未来提供一个真正的跨表
 *       只读快照优化（同一事务内读 unit + timeline），但两个 owner 目前都是
 *       各自 openDatabase/close，本草案不新增跨 owner 事务包装，
 *       仅并发调用两者的公开只读函数（见 D6 开放问题）。
 *
 * D4. 媒体引用严格复用既有安全边界，不新开一条通道：
 *     - Core 层 getStudioMedia() 返回值含 objectPath（绝对路径）和
 *       thumbnail.path（绝对路径），这两个字段绝不能进入 bundle 响应。
 *     - main/index.ts 的 `canvas:get-studio-media` IPC handler（约 1592-1609 行）
 *       已示范了唯一被批准的清洗模式：
 *         const { objectPath: _objectPath, thumbnail, ...safe } = media;
 *         return { ...safe, mediaUrl: studioMediaUrl(projectRoot,"media",safe.sha256),
 *           thumbnail: thumbnail ? { recipe, recipeKey, width, height, format,
 *             url: studioMediaUrl(projectRoot,"thumbnail",thumbnail.recipeKey) } : undefined };
 *     - studio-production-dashboard.ts 的 mapAsset() 早已示范了 Core 层该怎么做：
 *       只暴露 authorityMediaSha256 / authorityThumbnailRecipeKey（无路径、无 URL），
 *       URL 拼接是 Electron 主进程的关注点（studioMediaUrl 用到了
 *       protocol scheme "aicanvas-studio://"，这是 main/index.ts 的职责，
 *       Core 模块不应该依赖 Electron protocol 构造逻辑）。
 *     - 因此本 bundle 的 Core 层类型（StudioProjectionMediaRef）只有
 *       mediaSha256 / mediaKind / thumbnailRecipeKey / thumbnailStatus，
 *       **没有 url 字段**。真正的 IPC/MCP 包装层（不在本次改动范围，
 *       由 P2 实现阶段的 main/index.ts 改动负责）需要对 bundle 顶层做一次
 *       与 canvas:get-studio-media 完全相同的清洗 + studioMediaUrl() 补全，
 *       否则如果 IPC handler 只是把 Core 返回值原样 JSON 序列化，
 *       只要 Core 层已经不含 path 字段就是安全的——这正是选择在 Core 层
 *       就不产出 path 字段的原因（防御性早剥离，而不是依赖 IPC 层记得剥离）。
 *     - 【本轮修正新增】videoPackage 首次真正接入（见 D6.d 决议），其来源
 *       StudioVideoPackageControlLookup 内的 `control` / `nextAction` / `query`
 *       子结构尚未逐字段核对是否可能携带非 IPC-safe 的内部形状，本稿只挑选
 *       已核实安全的标量字段（status/selectedIntentId/selectedIsDestinationHead/
 *       blockers/fingerprint）纳入 bundle，`control`/`nextAction` 明确不纳入，
 *       留作后续一轮专门审计，不因为"函数已经真调用了"就顺手把整个返回值透传。
 *
 * D5. 唯一 nextAction 来自 Core，UI 不推导：
 *     bundle.nextAction 直接取 getStudioProductionDashboard(unit 操作) 返回的
 *     unitDetail.nextAction（buildUnit 内部已经用
 *     resolveUnitGridDashboardNextAction 把 binding/continuity/generation
 *     多路 nextAction 按优先级合并过一次），bundle 不做第二次合并判断。
 *     子投影（timeline/observation/binding/continuity/review）各自的
 *     nextAction/blockers 仍然保留在子节点上供 UI 展示"原因"，
 *     但 UI 只应该执行 bundle 顶层这一个 nextAction。
 *
 * D6. 开放问题裁决记录（主代理已裁决 a/c/d/e；b 是产品语义问题，非裁决题，见下）：
 *
 *     【极重要】a/d 两条的"允许"仅代表主代理的设计裁决被记录在此注释里，
 *     不代表本次改动已经/将要触碰仓库任何文件。本次任务的只读约束是绝对的、
 *     优先于本节任何裁决内容——studio-production.ts 和
 *     studio-production-dashboard.ts 在本次改动中一个字节都没有被写入，
 *     裁决 a/d 只是"未来若要落地这个方向，主代理已经认可其技术方向"的记录，
 *     真正落地属于另一次会话在另一份任务授权下发生的动作。
 *
 *     a.（裁决：允许，尚未落地）adjacentUnits.previous 缺少对称 Core owner 函数
 *        （studio-production.ts 只有 getStudioCanonicalSuccessorUnitIds，
 *        没有 getStudioCanonicalPredecessorUnitIds）。主代理裁决：允许未来在
 *        studio-production.ts 新增只读、无副作用、与现有函数完全对称的
 *        getStudioCanonicalPredecessorUnitIds()。理由：纯读、SQL 对称（把
 *        successor 的 `sequence > current ORDER BY sequence ASC LIMIT 1`
 *        换成 `sequence < current ORDER BY sequence DESC LIMIT 1`），风险
 *        极低，且是"Core 计算"而非 bundle 自己做业务判断，符合 D1 红线精神。
 *        本文件内 resolvePreviousUnitId() 在该函数真正落地前维持骨架桩
 *        （恒定返回 null），不臆造启发式猜测。
 *
 *     b.（非裁决题，产品语义待定）observation.own 的 generationRunId 该绑定
 *        "unit 级已批准结果"对应的 run，还是"当前选中格"对应的 run？
 *        在 unit-grid 架构下两者理论上是同一个 run（整格一次生成），但若
 *        selectedPanelId 与请求方传入的 query.panelId 不一致，语义会分叉。
 *        这不是"是否允许碰某个文件"的权限问题，而是需要产品/交互方拍板的
 *        业务语义问题，主代理在本轮任务里不代为裁决，继续留 TODO；
 *        observation.incoming 依赖 (a) 先落地，目前恒为 undefined。
 *
 *     c.（裁决：采用显式 adjacentLocator，废弃 cursor 命名）
 *        "有界 cursor" 契约如何在单 unit 详情形状（非 list 分页）里体现？
 *        主代理裁决：不用"cursor"这个容易让人误以为是分页 opaque token 的
 *        名字，改用语义明确的 StudioProjectionAdjacentLocator，字段直接叫
 *        previousUnitId/nextUnitId——它们本来就是这两个具体 id，没有必要
 *        包装成不透明 token。旧的 StudioProjectionCursor 类型与
 *        bundle.cursor 字段已重命名/替换，不再保留"伪装成 cursor"的写法。
 *
 *     d.（裁决：允许，尚未落地）mapUnitSummary / mapAsset 等复用的映射函数
 *        目前是 studio-production-dashboard.ts 内部私有函数（未 export）。
 *        主代理裁决：允许该文件未来新增 export（对既有 owner 文件的最小加法，
 *        不算"新状态机"）。本文件当前仍保持"复制一份等价逻辑"的写法
 *        （如 stableValue/digest），并在对应函数注释里保留"未来应改为
 *        import 复用"的 TODO，不在本次只读任务里代为修改 owner 文件。
 *
 *     e.（裁决：本次 P2 首切片不做，留给 P7）getStudioMedia() 目前每次调用
 *        独立开关 db 连接（非快照复用），在 currentUnit（≤6 格的
 *        controlAssets 解析）+ adjacentUnits（前后各 1）场景下会产生多次
 *        独立连接。主代理裁决：连接复用优化不纳入本次 P2 首切片范围，
 *        正确性优先于该项性能优化，留待 P7 专门处理。
 *
 * ----------------------------------------------------------------------------
 * 二、旧 IPC 调用 → bundle 字段映射表（替换 loadPanelPipeline / rawProjectionWorker）
 * ----------------------------------------------------------------------------
 *
 * ManagedStudioCanvasView.vue::loadPanelPipeline（第 2173-2218 行，per-panel 触发）：
 *   listStudioGenerationPanelHistory(unitId,panelId)
 *     → currentUnit.panels[i].generationHistoryHead（本草案：仅暴露 head 摘要，
 *       非全历史；全历史仍走既有 IPC，bundle 不替代"查历史"这一操作——
 *       本轮修正范围不含此字段的展开，仍是 TODO，见类型定义处）
 *   getStudioGenerationReviewControl(generationRunId)
 *     → currentUnit.panels[i].review（status/blockers/stamp，已在
 *       buildPanelFrame 中真正调用，非本轮新增但保持不变）
 *   getStudioMedia(rawSha256) / getStudioMedia(labeledSha256)  ×2
 *     → currentUnit.approvedRaw / currentUnit.approvedLabeled（unit 级共享，见 D2；
 *       解析 sha256 的上游逻辑仍是 TODO，见 buildStudioProductionProjectionBundle 内注释）
 *
 * ManagedStudioCanvasView.vue::rawProjectionWorker（第 2716-2886 行，per-unit 链，
 * 4 路有界并发处理 ≤36 单元，是 next_phase_plan.md 3.2 节"约 31 次 IPC"的根源）：
 *   resolveUnitGridSelectedResultIdentity(unitId)
 *     → currentUnit.selectedResultSource / currentUnit.selectedGenerationRunId
 *       （adjacentUnits[].selectedResultSource 对相邻单元同理，取自
 *        useStudioTimelineProjection 的 TimelineUnitDisplay，非重新判定；
 *        selectedGenerationRunId 本轮已真实赋值为
 *        unitDetail.selectedPanel.continuityReview.resolvedGenerationRunId，
 *        selectedResultSource 仍是 TODO）
 *   getStudioMedia(raw)
 *     → currentUnit.approvedRaw（同 D2，仍是 TODO）
 *   loadFrozenReferencesForApprovedRaw → getStudioFrozenPack(packId) → getStudioMedia(ref)×N
 *     → currentUnit.frozenReferences[]（【本轮状态更新】完整的"角色/场景/
 *       道具/风格/VFX 连线"闭包展开仍是 TODO 占位，未变化；但
 *       readAnyStudioGenerationFrozenPack() 本身已在本轮真正接入，产出一个
 *       更小的 currentUnit.frozenPackIdentity{id,fingerprint,kind,provenance}
 *       字段——这是"冻结包身份"而非"冻结包内的资产闭包"，两者是不同粒度，
 *       不要混淆：frozenPackIdentity 已真实可用，frozenReferences 仍未展开）
 *   loadVideoPackageProjection → getStudioVideoPackageControl
 *     → currentUnit.videoPackage（【本轮修正】已从 unknown 占位改为真实调用 +
 *       真实（但经筛选的）投影类型，见 D4 末尾说明与 D6.d 决议）
 *   getStudioPostResultObservationControl(observationRunId)
 *     → observation.own（本 unit 的 actual-tail）
 *   （上一镜实际尾态，UI 目前靠 continuity 字段自行推导展示文本——本 bundle 改为
 *    observation.incoming 语义化字段，UI 不再自己拼 fieldLabels，见 D6.b 的 TODO）
 *
 * ----------------------------------------------------------------------------
 * 三、依赖的既有常量 / 上限（直接复用，不重新定义数值）
 * ----------------------------------------------------------------------------
 *   STUDIO_DASHBOARD_UNIT_PAGE_LIMIT = 36        → adjacentUnits 摘要及未来分页上限
 *   STUDIO_DASHBOARD_PANEL_LIMIT = 6             → currentUnit.panels 上限
 *   STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT = 6     → 当前格资产上限
 * ============================================================================
 */

import { createHash } from "node:crypto";
import {
  beginStudioProjectionPhase,
  finishStudioProjectionPhase,
  measureStudioProjectionPhase,
  type StudioProjectionPhaseInstrumentation,
} from "./studio-projection-phase-timeline.js";
import { createStudioProjectionAssetReader } from "./studio-projection-asset-reader.js";

// 自查新发现（本轮修正范围外的第 6 处）：上一版这里还 import 了
// inspectManagedProject（managed-project.js）与 StudioProductionDashboardError
// （见下方 dashboard 导入块），但 body 内都从未真正使用——是与核对代理指出的
// 4 处"声明但未真调用"完全同类的问题，只是我自己在本轮重写时不慎带入的，
// 借这次自查一并清掉，不留新的死 import：
//   - inspectManagedProject：本函数是纯编排层，11 个 owner 函数各自内部已经
//     做校验（很多本身就调用了 inspectManagedProject/等价的 shell 解析），
//     bundle 层不需要再加一次前置校验；而且该函数有初始化生成账本的副作用
//     （ensureManagedGenerationLedger），不属于"纯只读投影"该做的事，不能
//     为了"用上这个 import"就顺手引入一个写副作用。
//   - StudioProductionDashboardError：本文件的错误处理策略是"owner 错误原样
//     向上抛，不在 bundle 层 catch/包装"（见 StudioProjectionBundleError 类
//     注释），这个策略本身决定了不会有 catch(e: StudioProductionDashboardError)
//     这样的代码——需要它仅仅是为了写注释，注释保留、类型 import 应该去掉。

import {
  getStudioProductionDashboard,
  STUDIO_DASHBOARD_PANEL_LIMIT,
  STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT,
  // 不 import STUDIO_DASHBOARD_UNIT_PAGE_LIMIT（自查新发现第 8 处）：本文件
  // 头部注释提过这个常量（"adjacentUnits 摘要及未来分页上限"），但当前实现
  // 里 adjacentUnits 固定只取 previous/next 各一个、不做分页，body 内没有
  // 任何地方真正用到这个数值；留 import 只是又一个死 import，故不引入，
  // 待未来 adjacentUnits 真的分页化时再按需加回。
  type StudioDashboardCurrentness,
  type StudioDashboardLocator,
  type StudioDashboardNextAction,
  type StudioDashboardUnitDetail,
  type StudioDashboardPanelSummary, // 修正点 1：真实导出名是 StudioDashboardPanelSummary
  // （src/core/studio-production-dashboard.ts:224-243），不是草案曾用的
  // StudioDashboardPanelDetail——该名字在源文件里不存在。已通读该文件确认
  // 逐字段：{id, ordinal, label, startSeconds, endSeconds, durationSeconds,
  // status, statusReason?, bindingCurrentness, bindingSetId?, bindingFingerprint?,
  // assetIds, locator, visualAction?, shotComposition?, dialogue?, subtitle?}。
} from "./studio-production-dashboard.js";

import {
  getStudioCanonicalPredecessorUnitIds,
  getStudioCanonicalSuccessorUnitIds,
  // 说明：不再 import getStudioProductionUnitSnapshot / StudioProductionUnitSummary——
  // 草案曾经导入但从未在函数体里使用（resolvePreviousUnitId 是恒返回 null 的骨架桩，
  // 见 D6.a），保留死 import 会在真实 tsc（noUnusedLocals 语境下）报错，故本轮移除；
  // 若未来 (a) 方案落地或改走"启发式猜测"分支，再按需重新引入。
  type StudioAssetCategory, // P2d 新增：frozenReferences 逐条资产的真实类别
  // （character|scene|prop|style，studio-production.ts:38），供 buildFrozenReferences
  // 直接复用，不重新声明一份等价字面量。
} from "./studio-production.js";

import {
  getStudioBindingControl, // 修正点 4（1/4）：本轮真正调用，见 buildPanelFrame
  // 不 import StudioBindingControlSnapshot（自查新发现第 7 处）：bindingControl
  // 变量的类型完全由 getStudioBindingControl 的返回值签名推断得出，本文件
  // 从未需要手写这个类型名（无变量标注、无函数签名、无泛型参数用到它），
  // 显式 import 只会是又一个死 import，故不引入。
  type StudioBindingPanelControl,
  type StudioBindingBlocker,
  type StudioBindingTimelineStatus,
  // 不再 import StudioBindingUnitSummary——那是 unit 级摘要，本 bundle 的
  // panel 级 binding 状态应该对齐 StudioBindingPanelControl，用错实体类型
  // 是本草案上一版的另一处隐藏错误（尽管不在核对代理列出的 4 点里，仍属于
  // "逐个 import 与函数调用对真实签名"应发现并修正的范围）。
} from "./studio-binding-control.js";

import {
  getStudioContinuityReviewControl,
  getStudioContinuityReviewGenerationSource,
  type StudioContinuityReviewControl,
  type StudioContinuityReviewControlInput,
  type StudioContinuityReviewNextAction, // 修正点 2 需要：见下方 continuity 字段重设计
} from "./studio-continuity-review-control.js";

import {
  queryStudioGenerationFreeze,
  type StudioFrozenAssetReference,
  type StudioFrozenForbiddenAsset,
  type StudioGenerationQueryResult,
} from "./studio-generation.js";

import {
  getStudioGenerationReviewControl,
  type StudioGenerationReviewControl,
} from "./studio-generation-review.js";

import {
  readAnyStudioGenerationFrozenPack, // 修正点 4（2/4）：本轮真正调用，见主入口 frozenPackIdentity
  type AnyStudioGenerationFreezePack,
  // 不 import AnyStudioGenerationFreezePack（自查新发现第 9 处，与
  // StudioBindingControlSnapshot 同类）：frozenPack 变量的类型完全靠
  // readAnyStudioGenerationFrozenPack 的返回值签名推断得出（数组解构场景下
  // 也没有自然的地方手写这个类型名），不引入又一个死 import。
} from "./studio-generation-ledger.js";

import {
  getApprovedTimelineProjection,
  type ApprovedTimelineUnitProjection,
} from "./studio-approved-timeline-projection.js";

import {
  getStudioPostResultObservationControl,
  type StudioPostResultObservationControl,
  type StudioPostResultObservationProjection,
  type StudioPostResultObservedActualState,
} from "./studio-post-result-observation.js";
import type { NextShotContinuitySnapshot } from "./studio-next-shot-continuity.js";

import {
  getStudioMultimediaTimelineProjection,
  type StudioMultimediaTimelineProjection,
  type StudioMultimediaTimelineTrackProjection,
  type StudioMultimediaMediaProjection,
  type StudioMultimediaTimelineRole,
} from "./studio-multimedia-timeline.js";

import {
  getStudioVideoPackageControl, // 修正点 4（3/4）：本轮真正调用，见主入口 videoPackage
  type StudioVideoPackageControlLookup,
  type StudioVideoPackageControlQuery,
  type StudioVideoPackageAuthorityInput,
} from "./studio-video-package.js";

import {
  getStudioMedia,
  getStudioCanonicalAsset, // 修正点 4（4/4）：本轮真正调用，见 buildPanelFrame 的 controlAssets
  type StudioMediaMetadata,
  type StudioMediaKind,
  type StudioCanonicalAssetDetail,
} from "./material-studio.js";

// ============================================================================
// 常量：全部复用既有上限，不新定义数值
// ============================================================================

export const STUDIO_PROJECTION_BUNDLE_SCHEMA_VERSION = 2 as const;

/** 相邻单元摘要个数上限（前后各 1，语义常量，非 UI 分页上限） */
export const STUDIO_PROJECTION_ADJACENT_UNIT_COUNT = 1 as const;

// ============================================================================
// 类型：水位戳 / 媒体引用（跨子投影共享的基础形状）
// ============================================================================

/**
 * 标注某个子投影的物理来源库 + 版本水位。
 * 不同 source 对应不同物理 SQLite 文件（见文件头 D3），
 * bundle 不假装它们同属一个事务。
 */
export type StudioProjectionSource =
  | "studio-production-dashboard"   // .aicanvas/studio-production.sqlite（经 buildUnit 编排）
  | "studio-multimedia-timeline"    // .aicanvas/studio-production.sqlite（timeline 表）
  | "studio-post-result-observation" // .aicanvas/studio-generation-ledger.sqlite
  | "studio-generation-review"      // .aicanvas/studio-generation-ledger.sqlite
  | "studio-generation-freeze"      // .aicanvas/studio-generation-ledger.sqlite（冻结包）
  | "studio-binding-control"        // .aicanvas/studio-production.sqlite（经 binding 编排）
  | "studio-continuity-review-control" // .aicanvas/studio-production.sqlite（本轮新增：
  // 修正点 2 的副产品——草案上一版把 continuity 的 stamp 错标成
  // "studio-binding-control"（复制粘贴遗留），且当时联合类型里根本没有这个
  // 字面量可选，是两层错误叠加。现补齐字面量 + 修正调用处的实参。
  | "studio-video-package-control"; // .aicanvas/studio-generation-ledger.sqlite（本轮新增：
  // videoPackage 首次真正接入，见 D4/D6.d；已核实 studio-video-package.ts
  // 走 generationDatabasePath()，与 ledger/observation 同一物理文件）

export interface StudioProjectionRevisionStamp {
  readonly source: StudioProjectionSource;
  /** 该子投影自己的水位标识——多数 owner 是 sha256 hex fingerprint，
   *  但 studio-binding-control 这个 owner 只有 revisionToken（不保证是
   *  sha256 格式的不透明字符串），语义仍然类似 ETag，用于判断"这一小块
   *  是否比我上次看到的新/旧"，不是顶层 bundle.fingerprint 的组成部分。 */
  readonly fingerprint: string;
  /** 部分 owner（如 dashboard unit）有单调 revision 数字，部分（如 observation）没有，故可选。 */
  readonly revision?: number;
  readonly currentness: StudioDashboardCurrentness;
  /** 该子投影读取完成的时间戳（ISO 字符串），用于诊断跨库水位的时间差，不用于业务判断。 */
  readonly builtAt: string;
}

/**
 * 安全媒体引用：绝不含 objectPath / thumbnail.path（见文件头 D4）。
 * IPC/MCP 边界层负责在此基础上补 mediaUrl / thumbnail.url
 * （复用 main/index.ts 现有的 studioMediaUrl() + "aicanvas-studio://" 协议）。
 */
export interface StudioProjectionMediaRef {
  readonly mediaSha256: string;
  readonly mediaKind: StudioMediaKind;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
  readonly sourceBasename?: string;
  /** 缩略图确定性 key（thumbnailRecipeKey(sha256) 的结果），无路径。 */
  readonly thumbnailRecipeKey?: string;
  readonly thumbnailStatus: "ready" | "deriving" | "missing" | "not-applicable";
}

// ============================================================================
// 类型：当前单元详情（2-6 格网格）
// ============================================================================

export interface StudioProjectionControlAssetRef {
  readonly assetId: string;
  readonly assetName?: string;
  readonly authorityMediaSha256?: string;
  readonly authorityThumbnailRecipeKey?: string;
}

export interface StudioProjectionFrozenContinuityHead {
  readonly field: StudioFrozenAssetReference["continuity"]["heads"][number]["field"];
  readonly status: "resolved" | "not-applicable";
  readonly value?: string;
  readonly reason?: string;
  readonly fingerprint: string;
}

/**
 * 冻结包内的逐格引用闭包。只暴露内容身份与安全媒体引用，不透传 objectPath、
 * localPath 或 provenance.reference；同一资产在不同 panel 的 continuity 可能
 * 不同，因此以 panelId + assetId 为稳定行粒度。
 */
export interface StudioProjectionFrozenReference {
  readonly panelId: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly category: StudioAssetCategory;
  readonly presence: "required" | "optional" | "forbidden";
  readonly role: string;
  readonly semanticRevision: number;
  readonly definitionVersionId: string;
  readonly authorityEventId: string;
  readonly assetVersionId: string;
  readonly media: StudioProjectionMediaRef;
  readonly continuity?: {
    readonly requiredFields: StudioFrozenAssetReference["continuity"]["requiredFields"];
    readonly timelineFingerprint: string;
    readonly readinessFingerprint: string;
    readonly heads: StudioProjectionFrozenContinuityHead[];
    readonly fingerprint: string;
  };
  readonly sourceFingerprint: string;
}

/**
 * 单个网格格子（panel）的状态。
 * 重要：不含独立的 raw/labeled 媒体引用——那是 currentUnit 级别的共享资产（见 D2）。
 * panel 级别真正独立的是 binding / continuity review / generation freeze / review 状态。
 */
export interface StudioProjectionPanelFrame {
  readonly panelId: string;
  readonly panelIndex: number;
  readonly label?: string;

  /** 该格允许入画的控制资产（≤ STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT），
   *  assetId 列表本身复用 studio-production-dashboard.ts 里
   *  studioDashboardPanelControlAssetIds 的口径（已在 panel.assetIds 里
   *  有界给出），本 bundle 对每个 assetId 调用 getStudioCanonicalAsset()
   *  解析出 name/authorityMediaSha256/authorityThumbnailRecipeKey（修正点 4）。
   *  性能 TODO（非阻塞）：若当前 panel 正好是 selectedPanel，dashboard 的
   *  unitDetail.selectedPanel.controlAssets 已经带了 assetName，可以直接
   *  复用而不必对该格重新查一次 getStudioCanonicalAsset；骨架先对全部
   *  panel 一致处理，保正确性优先。 */
  readonly controlAssets: StudioProjectionControlAssetRef[];

  /** 逐格绑定状态。status/statusReason 与 dashboard panel 摘要里的同名字段
   *  同源（都来自 binding 编排），这里额外带 dashboard 摘要没有的结构化
   *  blockers/freezeAllowed/confirmEmptyAllowed（来自 getStudioBindingControl
   *  的逐格快照，修正点 4）。 */
  readonly binding: {
    readonly status: StudioBindingTimelineStatus;
    readonly statusReason?: string;
    readonly blockers: StudioBindingBlocker[];
    readonly freezeAllowed: boolean;
    readonly confirmEmptyAllowed: boolean;
    readonly bindingSet?: {
      readonly id: string;
      readonly fingerprint: string;
      readonly currentness: "current" | "stale";
      readonly frozenAt: string;
    };
    readonly stamp: StudioProjectionRevisionStamp;
  };

  /** 修正点 2：真实的 StudioContinuityReviewControl（studio-continuity-review-control.ts:221-237）
   *  没有 "head" 字段——草案上一版的 continuity.status 是对着一个不存在的
   *  字段瞎判断（`StudioContinuityReviewControl["head"] extends undefined ? ... `
   *  这种写法本身就是一个恒真的假条件类型，编译器不会替你验真伪）。
   *  真实接口里能表达"这一格连续性现在处于什么状态、下一步该干什么"的
   *  字段是 nextAction: StudioContinuityReviewNextAction（code/label/reason/
   *  requiresWrite/...），本 bundle 直接原样暴露这个 Core 对象，不再发明
   *  一个 status/blockers 的二次映射——真实接口也没有扁平的 blockers
   *  数组（只有 nextAction.reason 单条原因 + conflicts 结构化冲突，
   *  两者形状都与"字符串数组"不同），编造映射违反 D1"bundle 不做业务
   *  判断"的红线，所以选择"如实转发 Core 原字段"而不是"半发明一个新形状"。 */
  readonly continuity: {
    readonly nextAction: StudioContinuityReviewNextAction;
    readonly resolvedGenerationRunId?: string;
    readonly stamp: StudioProjectionRevisionStamp;
  };

  readonly generationFreeze: {
    readonly status: StudioGenerationQueryResult["status"];
    readonly packId?: string;
    readonly stamp: StudioProjectionRevisionStamp;
  };

  readonly review?: {
    readonly status: StudioGenerationReviewControl["status"];
    readonly blockers: StudioGenerationReviewControl["blockers"];
    readonly stamp: StudioProjectionRevisionStamp;
  };
}

export interface StudioProjectionCurrentUnit {
  readonly unitId: string;
  readonly revision: number;
  readonly locator: StudioDashboardLocator;
  readonly currentness: StudioDashboardCurrentness;

  /** StudioDashboardUnitSummary 真实字段名是 seasonId/episodeId（直接必填
   *  字符串字段，非可选，无需 cast/兜底）。bundle 自己的公开字段名保持
   *  season/episode（这是 bundle 对外契约的命名选择，不强制与内部 owner
   *  命名一一对应），但取值路径本轮已改为直接读取，不再有多余的
   *  `as unknown as {...}` + `String(...) ?? ""` 包装。 */
  readonly season: string;
  readonly episode: string;
  readonly sequence: number;
  readonly title: string;
  readonly durationSeconds: number;
  /** 修正点 3：StudioDashboardUnitSummary 没有 episodeStartSeconds/
   *  episodeEndSeconds 这两个字段（草案上一版对着一个不存在的字段猜，
   *  用 `?? 0` 兜底掩盖了本该是编译错误的问题）。真实来源是
   *  StudioMultimediaTimelineProjection.unit.episodeStartSeconds /
   *  .episodeEndSeconds（studio-multimedia-timeline.ts:124-125 一带，
   *  必填 number，非可选），取值处见 buildStudioProductionProjectionBundle。 */
  readonly episodeStartSeconds: number;
  readonly episodeEndSeconds: number;

  /** unit-grid 共享的正式生成结果（见 D2），可能为空（尚未有 PASS 结果）。 */
  readonly approvedRaw?: StudioProjectionMediaRef;
  readonly approvedLabeled?: StudioProjectionMediaRef;
  readonly selectedResultSource?: "generation-run" | "historical-import";
  readonly selectedGenerationRunId?: string;
  readonly selectedPackFingerprint?: string;

  readonly panels: StudioProjectionPanelFrame[]; // 上限 STUDIO_DASHBOARD_PANEL_LIMIT
  readonly selectedPanelId?: string;

  /** 冻结包内逐格角色/场景/道具/风格引用闭包；无冻结包时为空数组。 */
  readonly frozenReferences: StudioProjectionFrozenReference[];

  /** 【本轮修正】不再是 unknown 占位——readAnyStudioGenerationFrozenPack()
   *  已真正调用（修正点 4），取 currentUnit 对应（own）生成运行审核记录里
   *  的 packId 读回真实冻结包，只投影两种冻结包变体共有的身份字段
   *  （id/fingerprint/kind 两个变体同名同型；provenance 两个变体的字面量
   *  不同，故 union 起来）。包内 assets/forbiddenAssets 等更深的结构
   *  仍然是 frozenReferences 的 TODO 范畴，这里不重复展开。 */
  readonly frozenPackIdentity?: {
    readonly id: string;
    readonly fingerprint: string;
    readonly kind: "studio-generation-freeze-pack";
    readonly provenance: "asset-binding-set" | "unit-grid-binding-sets";
  };

  /** 【本轮修正】不再是 unknown 占位——getStudioVideoPackageControl() 已真正
   *  调用（修正点 4）。只投影已核实是安全标量的字段；control/nextAction/query
   *  子结构明确不纳入（见 D4 末尾说明），避免"函数真调用了就顺手全量透传"。 */
  readonly videoPackage?: {
    readonly status: StudioVideoPackageControlLookup["status"];
    readonly selectedIntentId: StudioVideoPackageControlLookup["selectedIntentId"];
    readonly selectedIsDestinationHead: StudioVideoPackageControlLookup["selectedIsDestinationHead"];
    readonly blockers: StudioVideoPackageControlLookup["blockers"];
    readonly stamp: StudioProjectionRevisionStamp;
  };

  readonly bindingRevisionToken?: string;
  readonly stamp: StudioProjectionRevisionStamp;
}

// ============================================================================
// 类型：整单元四轨 Timeline
// ============================================================================

export interface StudioProjectionTimelineTrackSummary {
  readonly role: StudioMultimediaTimelineRole;
  readonly slotId: string;
  readonly startSeconds: number;
  /** StudioMultimediaTimelineBinding.endSeconds 是必填 number（非可选），
   *  草案上一版误标成可选并且用 `as unknown as {endSeconds?:number}` 硬 cast
   *  绕过检查——真实字段直接可读，已改为必填、直接访问。 */
  readonly endSeconds: number;
  readonly panelIndex?: number;
  readonly panelId?: string;
  readonly media: StudioProjectionMediaRef;
}

export interface StudioProjectionTimelineBundle {
  readonly availability: StudioMultimediaTimelineProjection["availability"];
  readonly gaps: StudioMultimediaTimelineProjection["gaps"];
  readonly tracks: StudioProjectionTimelineTrackSummary[];
  readonly stamp: StudioProjectionRevisionStamp;
}

// ============================================================================
// 类型：Observation（actual-tail）—— own（本单元）与 incoming（上一镜喂入）
// ============================================================================

export interface StudioProjectionObservationTail {
  readonly status: "missing" | "current" | "stale";
  readonly generationRunId?: string;
  readonly terminalPanelId?: string;
  readonly observedState?: StudioPostResultObservedActualState;
  /** v4 实际末态的逐实体/轴线/剪辑结构；旧观察保持 undefined。 */
  readonly continuitySnapshot?: NextShotContinuitySnapshot;
  readonly continuationEligible: boolean;
  readonly continuationIneligibleReasons: string[];
  readonly blockers: string[];
  readonly stamp: StudioProjectionRevisionStamp;
}

export interface StudioProjectionObservationBundle {
  /** 当前单元自己的实际末态（末格 observedState）。 */
  readonly own?: StudioProjectionObservationTail;
  /** 上一单元喂给当前单元的实际末态（"下一镜摘要显示上一镜实际尾态"）。
   *  TODO(D6.a)：依赖先解析出 previous 单元的 generationRunId，
   *  目前无对称 owner 查询，故本字段在骨架实现中大概率为 undefined。 */
  readonly incoming?: StudioProjectionObservationTail;
}

// ============================================================================
// 类型：相邻单元摘要（前后各 1）
// ============================================================================

export type StudioProjectionAdjacentRelation = "previous" | "next";

export interface StudioProjectionAdjacentUnitSummary {
  readonly relation: StudioProjectionAdjacentRelation;
  readonly unitId: string;
  readonly locator: StudioDashboardLocator;
  readonly currentness: StudioDashboardCurrentness;
  readonly title: string;
  readonly sequence: number;
  readonly approvedRaw?: StudioProjectionMediaRef;
  readonly approvedLabeled?: StudioProjectionMediaRef;
  readonly selectedResultSource?: "generation-run" | "historical-import";
  readonly stamp: StudioProjectionRevisionStamp;
}

// ============================================================================
// 类型：相邻单元定位（D6.c 已裁决落地，不再是"占位 cursor"）
// ============================================================================

/**
 * 本 bundle 是"单 unit 详情"形状而非 list 分页形状，previousUnitId/nextUnitId
 * 就是两个具体、有意义的 id，本身已经可以被 UI 直接用来发起下一次
 * buildStudioProductionProjectionBundle 调用——没有必要包一层"opaque
 * token"假装是分页游标（D6.c 裁决：采用显式命名，废弃 cursor 说法）。
 */
export interface StudioProjectionAdjacentLocator {
  readonly previousUnitId?: string;
  readonly nextUnitId?: string;
}

// ============================================================================
// 顶层类型：StudioProductionProjectionBundle
// ============================================================================

export interface StudioProductionProjectionBundleQuery {
  readonly unitId: string;
  readonly panelId?: string;
}

export interface StudioProductionProjectionBundle {
  readonly schemaVersion: typeof STUDIO_PROJECTION_BUNDLE_SCHEMA_VERSION;
  readonly kind: "studio-production-projection-bundle";
  /** 对整个 body（key 排序后）做 sha256，复用 dashboard 现成的 stableValue+digest 手法。 */
  readonly fingerprint: string;

  readonly projectId: string;
  readonly projectName: string;
  readonly manifestFingerprint: string;

  readonly locator: StudioDashboardLocator;
  readonly currentness: StudioDashboardCurrentness;
  /** 唯一 nextAction，直接取自 buildUnit 已合并过的 Core 判断，bundle 不二次合并（D5）。 */
  readonly nextAction: StudioDashboardNextAction;
  readonly adjacentLocator: StudioProjectionAdjacentLocator;

  readonly currentUnit: StudioProjectionCurrentUnit;
  readonly timeline: StudioProjectionTimelineBundle;
  readonly observation: StudioProjectionObservationBundle;
  readonly adjacentUnits: {
    readonly previous?: StudioProjectionAdjacentUnitSummary;
    readonly next?: StudioProjectionAdjacentUnitSummary;
  };

  readonly builtAt: string;
}

// ============================================================================
// 错误类型：复用既有错误而非新建平行错误体系
// ============================================================================

/**
 * 仅用于"聚合编排层"自身的失败（例如多个子投影全部失败、无法构造有效 bundle）。
 * 来自各 owner 的错误（StudioProductionDashboardError /
 * StudioBindingControlError / StudioPostResultObservationError 等）
 * 应该直接向上抛出，不在此处吞掉或包装成另一种类型——bundle 不是新状态机，
 * 也不该是新错误分类法的起点。
 */
export class StudioProjectionBundleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StudioProjectionBundleError";
    this.code = code;
  }
}

// ============================================================================
// 内部辅助：stableValue / digest（与 studio-production-dashboard.ts 完全一致的手法，
// 未来实现阶段应考虑从该文件导出复用，而非复制一份——此处复制仅为草案自解释，见 D6.d）
// ============================================================================

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================================
// 内部辅助：媒体引用清洗（严格执行 D4，绝不透传 objectPath / thumbnail.path）
// ============================================================================

async function toMediaRef(
  projectRoot: string,
  sha256: string | null | undefined,
): Promise<StudioProjectionMediaRef | undefined> {
  if (!sha256) return undefined;
  const media: StudioMediaMetadata | null = await getStudioMedia(projectRoot, sha256);
  if (!media) return undefined;
  // 显式解构剥离，镜像 main/index.ts 的 canvas:get-studio-media handler（D4）。
  const { objectPath: _objectPath, thumbnail, ...safe } = media;
  void _objectPath; // 显式标注"已读且刻意丢弃"，防止 lint 误报未使用变量之外的误解
  return {
    mediaSha256: safe.sha256,
    mediaKind: safe.kind,
    sizeBytes: safe.sizeBytes,
    mimeType: safe.mimeType,
    sourceBasename: safe.sourceBasename,
    thumbnailRecipeKey: thumbnail?.recipeKey,
    // 自查新发现（本轮修正范围外的第 5 处，超出核对代理原 4 点，属于"逐个 import
    // 与函数调用再对真实签名"的自查产物）：StudioDerivativeStatus 真实只有
    // "ready"|"pending" 两个字面量（material-studio.ts:29），不是四个。上一版
    // 用 `as StudioProjectionMediaRef["thumbnailStatus"]` 把它硬转成本 bundle
    // 的四字面量类型，这本身就是"过度防御性 cast 掩盖真实类型错误"——如果
    // derivativeStatus 是 "pending"，硬转后字段里会出现一个不在声明类型里的
    // 字符串。现改为显式的双分支映射（无需 cast）："pending" 语义上就是
    // "还在生成中"，映射到 thumbnailStatus 的 "deriving"；"missing" 在这条
    // 路径上目前不可达（getStudioMedia 层没有"派生失败"信号），留给未来
    // 若 Core 层补充失败态时再接入，不在这里编造。
    thumbnailStatus: thumbnail ? (safe.derivativeStatus === "ready" ? "ready" : "deriving") : "not-applicable",
  };
}

function timelineMediaToRef(media: StudioMultimediaMediaProjection): StudioProjectionMediaRef {
  // StudioMultimediaMediaProjection 本身已是安全形状（无 objectPath），直接改名映射即可。
  // 缩略图 TODO 已解决：derivatives 是该媒体已产出的衍生物列表（含 thumbnail），
  // derivativeGaps 是"该有但还没产出"的衍生物缺口列表，两者结合可以准确判断
  // thumbnailStatus，不必再额外发起一次 getStudioMedia(sha256) 才能拿 recipeKey。
  const thumbnail = media.derivatives.find((derivative) => derivative.kind === "thumbnail");
  const thumbnailGap = media.derivativeGaps.find((gap) => gap.kind === "thumbnail");
  return {
    mediaSha256: media.sha256,
    mediaKind: media.kind,
    sizeBytes: media.sizeBytes,
    mimeType: media.mimeType,
    sourceBasename: media.sourceBasename,
    thumbnailRecipeKey: thumbnail?.key,
    thumbnailStatus: thumbnail ? "ready" : thumbnailGap ? "deriving" : "not-applicable",
  };
}

function projectFrozenContinuity(
  asset: StudioFrozenAssetReference,
): NonNullable<StudioProjectionFrozenReference["continuity"]> {
  return {
    requiredFields: asset.continuity.requiredFields,
    timelineFingerprint: asset.continuity.timelineFingerprint,
    readinessFingerprint: asset.continuity.readinessFingerprint,
    heads: asset.continuity.heads.map((head) => ({
      field: head.field,
      status: head.state.status,
      value: head.state.value,
      reason: head.state.reason,
      fingerprint: head.fingerprint,
    })),
    fingerprint: asset.continuity.fingerprint,
  };
}

async function projectFrozenReference(
  projectRoot: string,
  panelId: string,
  asset: StudioFrozenAssetReference | StudioFrozenForbiddenAsset,
): Promise<StudioProjectionFrozenReference> {
  const media = await toMediaRef(projectRoot, asset.version.mediaSha256);
  if (!media) {
    throw new StudioProjectionBundleError(
      "frozen-reference-media-missing",
      `冻结引用 ${panelId}/${asset.assetId} 的媒体 ${asset.version.mediaSha256} 不可验证。`,
    );
  }
  return {
    panelId,
    assetId: asset.assetId,
    assetName: asset.definition.name,
    category: asset.category,
    presence: asset.presence,
    role: asset.role,
    semanticRevision: asset.semanticRevision,
    definitionVersionId: asset.definition.id,
    authorityEventId: asset.authority.eventId,
    assetVersionId: asset.version.id,
    media,
    ...("continuity" in asset ? { continuity: projectFrozenContinuity(asset) } : {}),
    sourceFingerprint: asset.sourceFingerprint,
  };
}

async function buildFrozenReferences(
  projectRoot: string,
  pack: AnyStudioGenerationFreezePack | null,
): Promise<StudioProjectionFrozenReference[]> {
  if (!pack) return [];
  const panelPacks = pack.provenance === "asset-binding-set"
    ? [{ panelId: pack.target.panelId, pack }]
    : pack.panels.map((panel) => ({ panelId: panel.panelId, pack: panel.panelPack }));
  const references = await Promise.all(panelPacks.flatMap(({ panelId, pack: panelPack }) => [
    ...panelPack.assets.map((asset) => projectFrozenReference(projectRoot, panelId, asset)),
    ...panelPack.forbiddenAssets.map((asset) => projectFrozenReference(projectRoot, panelId, asset)),
  ]));
  return references.sort((left, right) =>
    left.panelId.localeCompare(right.panelId, "en")
    || left.assetId.localeCompare(right.assetId, "en")
    || left.presence.localeCompare(right.presence, "en"));
}

function stamp(
  source: StudioProjectionSource,
  fingerprint: string,
  options?: { revision?: number; currentness?: StudioDashboardCurrentness },
): StudioProjectionRevisionStamp {
  return {
    source,
    fingerprint,
    revision: options?.revision,
    currentness: options?.currentness ?? "current",
    builtAt: nowIso(),
  };
}

// ============================================================================
// 内部辅助：相邻单元摘要构建
// ============================================================================

async function buildAdjacentUnitSummary(
  projectRoot: string,
  relation: StudioProjectionAdjacentRelation,
  unitId: string | null,
  selected: ApprovedTimelineUnitProjection | undefined,
): Promise<StudioProjectionAdjacentUnitSummary | undefined> {
  if (!unitId) return undefined;

  // 复用 dashboard 的 unit 操作而非重新写一份摘要查询——保持"只有一处判断当前性/口径"。
  // 注意：这比"轻量摘要"重（会带出完整 panels），后续可优化为只取 unit 元信息，
  // 但优化前提是 studio-production-dashboard.ts 导出一个更细粒度的摘要函数（见 D6.d）。
  // 说明：这里把 { operation: "unit", unitId } 字面量直接作为参数传入（不经中间变量），
  // getStudioProductionDashboard 的判别式联合参数会按字面量做上下文类型收窄，
  // 不需要草案上一版那个绕过检查的 `as never`。
  const detail = await getStudioProductionDashboard(projectRoot, {
    operation: "unit",
    unitId,
  });

  // 保留：getStudioProductionDashboard 没有函数重载，返回类型是固定的响应联合，
  // 不会因为传入字面量是 "unit" 就自动把返回值窄化成 StudioDashboardUnitDetail——
  // 这个 cast 合法且必要，不是因为字段名不确定才加的。
  const unitDetail = detail as StudioDashboardUnitDetail;

  const [approvedRaw, approvedLabeled] = await Promise.all([
    toMediaRef(projectRoot, selected?.selectedRawSha256),
    toMediaRef(projectRoot, selected?.selectedLabeledSha256),
  ]);

  return {
    relation,
    unitId,
    locator: unitDetail.locator,
    currentness: unitDetail.unit.currentness,
    title: unitDetail.unit.label,
    sequence: unitDetail.unit.sequence,
    approvedRaw,
    approvedLabeled,
    selectedResultSource: selected?.selectedResultSource ?? undefined,
    stamp: stamp("studio-production-dashboard", unitDetail.fingerprint, {
      revision: unitDetail.unit.revision,
      currentness: unitDetail.unit.currentness,
    }),
  };
}

// ============================================================================
// 内部辅助：单元格 panel frame 构建（对齐 D2：binding/continuity/freeze/review 逐格）
// ============================================================================

async function buildPanelFrame(
  projectRoot: string,
  unitId: string,
  unitRevision: number,
  panel: StudioDashboardPanelSummary, // 修正点 1：类型名对齐真实导出
  bindingPanel: StudioBindingPanelControl | undefined,
  bindingRevisionToken: string,
  readControlAsset: (assetId: string) => Promise<StudioCanonicalAssetDetail | null>,
): Promise<StudioProjectionPanelFrame> {
  // 修正点 3 副带修复：panel.startSeconds/endSeconds/assetIds 都是
  // StudioDashboardPanelSummary 的真实直接字段（见导入处注释），
  // 草案上一版把起止毫秒硬编码成 0、assetIds 硬编码成 []，
  // 属于"明明有真实字段却没接上"的遗漏，本轮一并接上。
  const continuityInput: StudioContinuityReviewControlInput = {
    unitId,
    unitRevision,
    panelId: panel.id,
    startMilliseconds: Math.round(panel.startSeconds * 1000),
    endMilliseconds: Math.round(panel.endSeconds * 1000),
    assetIds: panel.assetIds,
  };

  const [continuityReview, controlAssets] = await Promise.all([
    getStudioContinuityReviewControl(projectRoot, continuityInput),
    // 修正点 4：真正调用 getStudioCanonicalAsset，逐个解析该格的控制资产身份。
    // panel.assetIds 已经是 studioDashboardPanelControlAssetIds 产出的有界
    // （≤ STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT）列表，这里不再二次限流。
    Promise.all(
      panel.assetIds.map(async (assetId): Promise<StudioProjectionControlAssetRef> => {
        const asset: StudioCanonicalAssetDetail | null = await readControlAsset(assetId);
        return {
          assetId,
          assetName: asset?.name,
          authorityMediaSha256: asset?.primaryAuthority?.mediaSha256,
          authorityThumbnailRecipeKey: asset?.primaryAuthority?.thumbnailRecipeKey,
        };
      }),
    ),
  ]);

  // 修正点 2：resolvedGenerationRunId 是 StudioContinuityReviewControl 顶层的
  // 真实可选字段（Pick<...,"resolvedGenerationRunId"> 已在 dashboard 的
  // selectedPanel.continuityReview 里确认过同名同源），直接访问，
  // 不再需要 `as unknown as {resolvedGenerationRunId?:string}` 这种过度防御 cast。
  const resolvedGenerationRunId = continuityReview.resolvedGenerationRunId;
  // 生产路径复用 continuity owner 已完成的同一次原始 generation 查询，避免每格
  // 重复冻结计算。测试/替身若未经过真实 owner，则安全回落到旧查询入口。
  const generationSource = getStudioContinuityReviewGenerationSource(continuityReview)
    ?? await queryStudioGenerationFreeze(projectRoot, { unitId, panelId: panel.id });

  let review: StudioProjectionPanelFrame["review"];
  if (resolvedGenerationRunId) {
    const reviewControl = await getStudioGenerationReviewControl(projectRoot, resolvedGenerationRunId);
    review = {
      status: reviewControl.status,
      blockers: reviewControl.blockers,
      stamp: stamp("studio-generation-review", reviewControl.fingerprint),
    };
  }

  return {
    panelId: panel.id,
    panelIndex: panel.ordinal, // 修正：真实字段 panel.ordinal，草案上一版硬编码成 0
    label: panel.label, // 修正：草案上一版遗漏赋值，label 字段此前一直是 undefined
    controlAssets,
    binding: {
      // bindingPanel 理论上应该总能按 panel.id 命中（两者同源于同一生产单元），
      // 命中失败属于跨 owner 数据不一致的异常情况；此时退回 dashboard 摘要自带的
      // status/statusReason（比完全臆造更安全），blockers/freezeAllowed/
      // confirmEmptyAllowed 没有对应兜底来源，保守给出空/false。
      status: bindingPanel?.status ?? panel.status,
      statusReason: bindingPanel?.statusReason ?? panel.statusReason,
      blockers: bindingPanel?.blockers ?? [],
      freezeAllowed: bindingPanel?.freezeAllowed ?? false,
      confirmEmptyAllowed: bindingPanel?.confirmEmptyAllowed ?? false,
      bindingSet: bindingPanel?.bindingSet,
      stamp: stamp("studio-binding-control", bindingRevisionToken),
    },
    continuity: {
      nextAction: continuityReview.nextAction,
      resolvedGenerationRunId,
      // 修正点 2 关联修复：source 改成新增的 "studio-continuity-review-control"，
      // 草案上一版这里错写成 "studio-binding-control"（复制粘贴遗留）。
      stamp: stamp("studio-continuity-review-control", continuityReview.fingerprint),
    },
    generationFreeze: {
      status: generationSource.status,
      packId: generationSource.status === "ready" ? generationSource.packId : undefined,
      stamp: stamp(
        "studio-generation-freeze",
        generationSource.status === "ready"
          ? generationSource.fingerprint
          : digest(generationSource),
      ),
    },
    review,
  };
}

// ============================================================================
// 内部辅助：Observation tail 投影
// ============================================================================

function projectObservationTail(
  control: StudioPostResultObservationControl,
): StudioProjectionObservationTail {
  const head: StudioPostResultObservationProjection | undefined = control.head;
  return {
    status: control.status,
    generationRunId: control.generationRunId,
    // terminalPanelId 是 StudioPostResultObservationRecord 的直接可选字段，
    // StudioPostResultObservationProjection 用 Omit 只摘掉了 observedState，
    // terminalPanelId 原样保留，无需 cast。
    terminalPanelId: head?.terminalPanelId,
    observedState: head?.observedState,
    continuitySnapshot: head?.continuitySnapshot,
    continuationEligible: head?.continuationEligible ?? false,
    continuationIneligibleReasons: head?.continuationIneligibleReasons ?? [],
    blockers: control.blockers,
    stamp: stamp("studio-post-result-observation", control.fingerprint, {
      revision: control.headRevision,
      currentness: control.status === "current" ? "current" : control.status === "stale" ? "stale" : "missing",
    }),
  };
}

// ============================================================================
// 内部辅助：Timeline 投影裁剪
// ============================================================================

function projectTimeline(
  projection: StudioMultimediaTimelineProjection,
): StudioProjectionTimelineBundle {
  const tracks: StudioProjectionTimelineTrackSummary[] = projection.tracks.map(
    (track: StudioMultimediaTimelineTrackProjection) => ({
      // role/endSeconds 都是 StudioMultimediaTimelineBinding 的直接必填字段，
      // 草案上一版用 `as unknown as {...}` 硬 cast 绕过检查纯属多余防御，
      // 已核实真实签名后去掉。
      role: track.binding.role,
      slotId: track.binding.slotId,
      startSeconds: track.binding.startSeconds,
      endSeconds: track.binding.endSeconds,
      panelIndex: track.binding.panelIndex,
      panelId: track.binding.panelId,
      media: timelineMediaToRef(track.media),
    }),
  );

  return {
    availability: projection.availability,
    gaps: projection.gaps,
    tracks,
    stamp: stamp("studio-multimedia-timeline", projection.fingerprint, {
      revision: projection.unit.revision,
    }),
  };
}

// ============================================================================
// 主入口：buildStudioProductionProjectionBundle
// ============================================================================

/**
 * 一次调用聚合当前单元驾驶舱所需的全部只读数据。
 *
 * 编排顺序（均为已存在 owner 的只读读取，无写入）：
 *   1. 并行调用 getStudioProductionDashboard(operation:"unit") 与
 *      getStudioBindingControl（修正点 4）——前者复用 buildUnit 全部逻辑拿到
 *      shell/unit 摘要/nextAction/panels 壳/selectedPanel 深度数据，
 *      后者拿到逐格 binding 的结构化 blockers/freezeAllowed/confirmEmptyAllowed。
 *      两者物理同库但各自快照，不构造跨 owner 事务（D3）。
 *   2. 对 unitDetail.panels（≤ STUDIO_DASHBOARD_PANEL_LIMIT）有界并发展开逐格
 *      binding/continuity/freeze/review/controlAssets（D2 的核心扩展点；
 *      selectedPanel 那一格理论上可直接复用 unitDetail.selectedPanel 已算出
 *      的结果避免重复读取——TODO 标注在 buildPanelFrame 与 controlAssets 处）。
 *   3. 并行调用 getStudioMultimediaTimelineProjection 取四轨、
 *      getStudioPostResultObservationControl 取 own 尾态、
 *      getStudioCanonicalSuccessorUnitIds 取 next、resolvePreviousUnitId 取
 *      previous（D6.a 恒 null）、以及（若 ownGenerationRunId 存在）
 *      getStudioGenerationReviewControl 取 own 审核记录头（用于下一步驱动
 *      frozenPackIdentity / videoPackage，修正点 4）。
 *   4. 用 own 审核记录头里的 packId/reviewId 并行调用
 *      readAnyStudioGenerationFrozenPack 与 getStudioVideoPackageControl
 *      （修正点 4），同时并行构建 previous/next 相邻单元摘要。
 *   5. 用 stableValue+digest 对整个 body 计算顶层 fingerprint。
 *
 * 单库读取的"同一只读事务快照"约束：本函数不新开跨 owner 事务——
 * 上述多个 owner 虽然有共享物理文件的情况（见 D3），但各自独立
 * openDatabase/close。若要做到真正的同一事务快照，需要这些 owner 模块
 * 本身提供一个"传入外部只读连接"的重载，这超出本次 bundle 编排层的
 * 改动权限，留在 D6 开放问题里给主代理裁决。
 */
export async function buildStudioProductionProjectionBundle(
  projectRoot: string,
  query: StudioProductionProjectionBundleQuery,
  instrumentation?: StudioProjectionPhaseInstrumentation,
): Promise<StudioProductionProjectionBundle> {
  const coreStartedAt = beginStudioProjectionPhase(instrumentation);
  try {
    const unitId = query.unitId;
    if (!unitId) throw new StudioProjectionBundleError("invalid-input", "unitId 不能为空。");

  // 步骤 1：dashboard 与 binding 并行只读，各自快照（D3）。
  // 字面量对象直接作为参数传入，触发 TS 对判别式联合参数的上下文类型收窄，
  // 不需要 `as never` 之类的绕过写法（两处 as never 均已移除）。
    const [dashboardDetail, bindingControl] = await measureStudioProjectionPhase(
      instrumentation,
      "current-dashboard-binding",
      () => Promise.all([
        getStudioProductionDashboard(projectRoot, {
          operation: "unit",
          unitId,
          panelId: query.panelId,
        }),
        getStudioBindingControl(projectRoot, { unitId }),
      ]),
    );

  // 保留：函数无重载，返回值不按输入字面量自动收窄，这个 cast 合法必要。
  const unitDetail = dashboardDetail as StudioDashboardUnitDetail;
  const unitRevision = unitDetail.unit.revision;

  const bindingPanelById = new Map<string, StudioBindingPanelControl>(
    bindingControl.panels.map((panel) => [panel.id, panel]),
  );

  // 步骤 2：逐格展开 binding/continuity/freeze/review/controlAssets（D2 扩展点）。
  // unitDetail.panels 是 StudioDashboardPanelSummary[] 的真实直接字段，
  // 草案上一版用 `as unknown as {panels: StudioDashboardPanelDetail[]}` 硬 cast，
  // 既用错了类型名也是多余的防御——已去掉。
  const panelSourceList = unitDetail.panels.slice(0, STUDIO_DASHBOARD_PANEL_LIMIT);
  let canonicalAssetReadCount = 0;
  const readControlAsset = createStudioProjectionAssetReader(async (assetId) => {
    canonicalAssetReadCount += 1;
    return getStudioCanonicalAsset(projectRoot, assetId);
  }, 4);
  let panels: StudioProjectionPanelFrame[] = [];
  panels = await measureStudioProjectionPhase(
    instrumentation,
    "panel-fanout",
    () => Promise.all(
      panelSourceList.map((panel) =>
        buildPanelFrame(
          projectRoot,
          unitId,
          unitRevision,
          panel,
          bindingPanelById.get(panel.id),
          bindingControl.revisionToken,
          readControlAsset,
        ),
      ),
    ),
    () => ({
      panelCount: panels.length || panelSourceList.length,
      // finally 在外层 `panels = await ...` 赋值之前运行；使用冻结输入统计本轮
      // fan-out 的控制资产引用数，避免成功阶段被误记为 0。
      controlAssetCount: panelSourceList.reduce((total, panel) => total + panel.assetIds.length, 0),
      canonicalAssetReadCount,
    }),
  );

  // 步骤 3：整单元四轨 Timeline、正式结果选择和前后邻接并行读取。
  const timelineProjectionPromise = getStudioMultimediaTimelineProjection(projectRoot, {
    unitId,
    unitRevision,
  });
  const approvedTimelinePromise = getApprovedTimelineProjection(projectRoot, {
    season: unitDetail.unit.seasonId,
    episode: unitDetail.unit.episodeId,
    fastMode: true,
  });
  const successorMapPromise = getStudioCanonicalSuccessorUnitIds(projectRoot, [unitId]);
  const predecessorMapPromise = getStudioCanonicalPredecessorUnitIds(projectRoot, [unitId]);

    const [timelineProjection, approvedTimeline, successorMap, predecessorMap] =
      await measureStudioProjectionPhase(
        instrumentation,
        "timeline-approved-neighbors",
        () => Promise.all([
          timelineProjectionPromise,
          approvedTimelinePromise,
          successorMapPromise,
          predecessorMapPromise,
        ]),
      );

  if (!timelineProjection) {
    throw new StudioProjectionBundleError("timeline-missing", `单元 ${unitId} 缺少多媒体时间线投影。`);
  }

  const approvedByUnit = new Map(approvedTimeline.units.map((unit) => [unit.unitId, unit]));
  const approvedUnit = approvedByUnit.get(unitId);
  const ownGenerationRunId = approvedUnit?.selectedResultSource === "generation-run"
    ? approvedUnit.selectedGenerationRunId ?? undefined
    : undefined;
  const previousUnitId = predecessorMap[unitId] ?? null;
  const nextUnitId = successorMap[unitId] ?? null;
  const previousApproved = previousUnitId ? approvedByUnit.get(previousUnitId) : undefined;
  const incomingGenerationRunId = previousApproved?.selectedResultSource === "generation-run"
    ? previousApproved.selectedGenerationRunId ?? undefined
    : undefined;

  // Observation 只绑定 unit 级正式 PASS 选择，不跟随 UI 当前选中格；历史 PASS
  // 没有 Studio observation owner 时保持缺失，不把 planned/raw 猜成 actual-tail。
    const [ownObservationControl, incomingObservationControl, ownReviewControl] = await measureStudioProjectionPhase(
      instrumentation,
      "observation-review",
      () => Promise.all([
        ownGenerationRunId
          ? getStudioPostResultObservationControl(projectRoot, ownGenerationRunId)
          : Promise.resolve(undefined),
        incomingGenerationRunId
          ? getStudioPostResultObservationControl(projectRoot, incomingGenerationRunId)
          : Promise.resolve(undefined),
        ownGenerationRunId
          ? getStudioGenerationReviewControl(projectRoot, ownGenerationRunId)
          : Promise.resolve(undefined),
      ]),
    );

  const ownPackId = ownReviewControl?.head?.packId;
  const ownReviewId = ownReviewControl?.head?.reviewId;

  const frozenPackPromise = ownPackId
    ? readAnyStudioGenerationFrozenPack(projectRoot, ownPackId)
    : Promise.resolve(null);

  const videoPackageQuery: StudioVideoPackageControlQuery | undefined = ownReviewId
    ? { by: "authority-latest", authority: { kind: "studio-review", reviewId: ownReviewId } satisfies StudioVideoPackageAuthorityInput }
    : undefined;
  const videoPackageControlPromise = videoPackageQuery
    ? getStudioVideoPackageControl(projectRoot, videoPackageQuery)
    : Promise.resolve(undefined);

  // 步骤 6：相邻摘要、冻结包和视频包并行读取。
    const [previousSummary, nextSummary, frozenPack, videoPackageControl] = await measureStudioProjectionPhase(
      instrumentation,
      "adjacent-pack-video",
      () => Promise.all([
        buildAdjacentUnitSummary(projectRoot, "previous", previousUnitId, previousApproved),
        buildAdjacentUnitSummary(
          projectRoot,
          "next",
          nextUnitId,
          nextUnitId ? approvedByUnit.get(nextUnitId) : undefined,
        ),
        frozenPackPromise,
        videoPackageControlPromise,
      ]),
      () => ({ neighborCount: Number(Boolean(previousUnitId)) + Number(Boolean(nextUnitId)) }),
    );
    let frozenReferences: StudioProjectionFrozenReference[] = [];
    frozenReferences = await measureStudioProjectionPhase(
      instrumentation,
      "frozen-reference-media",
      () => buildFrozenReferences(projectRoot, frozenPack),
      () => ({ frozenReferenceCount: frozenReferences.length }),
    );

  const observation: StudioProjectionObservationBundle = {
    own: ownObservationControl ? projectObservationTail(ownObservationControl) : undefined,
    incoming: incomingObservationControl
      ? projectObservationTail(incomingObservationControl)
      : undefined,
  };

  // frozenPack 是两种冻结包变体（AnyStudioGenerationFreezePack）之一，
  // id/fingerprint/kind 两个变体同名同型，provenance 字面量不同故 union。
  const frozenPackIdentity: StudioProjectionCurrentUnit["frozenPackIdentity"] = frozenPack
    ? {
        id: frozenPack.id,
        fingerprint: frozenPack.fingerprint,
        kind: frozenPack.kind,
        provenance: frozenPack.provenance,
      }
    : undefined;

  const videoPackage: StudioProjectionCurrentUnit["videoPackage"] = videoPackageControl
    ? {
        status: videoPackageControl.status,
        selectedIntentId: videoPackageControl.selectedIntentId,
        selectedIsDestinationHead: videoPackageControl.selectedIsDestinationHead,
        blockers: videoPackageControl.blockers,
        stamp: stamp("studio-video-package-control", videoPackageControl.fingerprint),
      }
    : undefined;

  const approvedRaw = timelineProjection.approvedStoryboard.raw
    ? timelineMediaToRef(timelineProjection.approvedStoryboard.raw)
    : undefined;
  const approvedLabeled = timelineProjection.approvedStoryboard.labeled
    ? timelineMediaToRef(timelineProjection.approvedStoryboard.labeled)
    : undefined;

  const currentUnit: StudioProjectionCurrentUnit = {
    unitId,
    revision: unitRevision,
    locator: unitDetail.locator,
    currentness: unitDetail.unit.currentness,
    // 修正点 3 关联修复：seasonId/episodeId 是 StudioDashboardUnitSummary 的
    // 真实必填直接字段，草案上一版套了 `as unknown as {...} ?? ""` 纯属多余防御。
    season: unitDetail.unit.seasonId,
    episode: unitDetail.unit.episodeId,
    sequence: unitDetail.unit.sequence,
    title: unitDetail.unit.label,
    durationSeconds: unitDetail.unit.durationSeconds,
    // 修正点 3：真实来源是 timelineProjection.unit.episodeStartSeconds/
    // episodeEndSeconds（studio-multimedia-timeline.ts），unitDetail.unit
    // 上根本没有这两个字段，草案上一版的 `as unknown as {...} ?? 0` 是在
    // 掩盖一个本该是编译错误的引用。
    episodeStartSeconds: timelineProjection.unit.episodeStartSeconds,
    episodeEndSeconds: timelineProjection.unit.episodeEndSeconds,
    approvedRaw,
    approvedLabeled,
    selectedResultSource: approvedUnit?.selectedResultSource ?? undefined,
    selectedGenerationRunId: ownGenerationRunId,
    selectedPackFingerprint: approvedUnit?.selectedPackFingerprint ?? undefined,
    panels,
    selectedPanelId: unitDetail.selectedPanelId,
    frozenReferences,
    frozenPackIdentity,
    videoPackage,
    bindingRevisionToken: unitDetail.bindingRevisionToken,
    stamp: stamp("studio-production-dashboard", unitDetail.fingerprint, {
      revision: unitRevision,
      currentness: unitDetail.unit.currentness,
    }),
  };

    return await measureStudioProjectionPhase(instrumentation, "assemble-digest", async () => {
      const bodyWithoutFingerprint = {
    schemaVersion: STUDIO_PROJECTION_BUNDLE_SCHEMA_VERSION,
    kind: "studio-production-projection-bundle" as const,
    projectId: unitDetail.projectId,
    projectName: unitDetail.projectName,
    manifestFingerprint: unitDetail.manifestFingerprint,
    locator: unitDetail.locator,
    currentness: unitDetail.unit.currentness,
    nextAction: unitDetail.nextAction, // D5：唯一 nextAction，直接取自 Core，不二次合并
    adjacentLocator: {
      previousUnitId: previousUnitId ?? undefined,
      nextUnitId: nextUnitId ?? undefined,
    } satisfies StudioProjectionAdjacentLocator,
    currentUnit,
    timeline: projectTimeline(timelineProjection),
    observation,
    adjacentUnits: {
      previous: previousSummary,
      next: nextSummary,
    },
    builtAt: nowIso(),
  };

      return {
        ...bodyWithoutFingerprint,
        fingerprint: digest(bodyWithoutFingerprint),
      };
    });
  } finally {
    finishStudioProjectionPhase(instrumentation, coreStartedAt, "core-total");
  }
}
