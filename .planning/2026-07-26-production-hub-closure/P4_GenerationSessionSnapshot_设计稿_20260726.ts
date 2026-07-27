/**
 * ============================================================================
 * P4 设计稿（草稿，仅供评审，非实现）：GenerationSessionSnapshot
 * ============================================================================
 *
 * 产出说明：
 * - 本文件是只读研究后的设计草稿，写入 scratchpad，不修改仓库
 *   /Users/hxx/Documents/无限画布 的任何文件。
 * - 所有 `owner:` 注释里的 file:line 均为撰写时（2026-07-26）对源码逐行核实后的
 *   真实位置；源码变动后需要重新核对，不能当成永久锚点。
 * - 本文件里凡是与仓库真实类型同名/同形状的本地声明（如
 *   `GenerationSessionNextAction`），都只是"为了让草稿自洽可读"而临时复制的
 *   结构，实现阶段必须改成真实 `import type { ... } from "./studio-xxx.js"`，
 *   不得让两份定义在正式代码里同时存在。
 * - 背景：.planning/2026-07-26-production-hub-closure/next_phase_plan.md 第
 *   226-252 行 P4 验收项 + findings.md 第 157/235/236 行三代理互评结论。
 *
 * 与已有类型的边界（避免"重新造第二套状态机"，对应计划红线第 2/3 条）：
 * - `StudioGenerationFreezePack`（studio-generation.ts:578-599）是"已冻结、
 *   即将/已经执行"的生成请求包，其 `request.controlReferences` 合法携带
 *   localPath（因为消费者是真正要读文件的生图执行体）。
 * - `StudioAgentImagegenBrief`（studio-generation.ts:2372-2411）是"这个 pack
 *   该怎么执行"的简报，明确不带 localPath（同文件 2408 行注释：
 *   `referencePathSource: "pack-operation-controlReferences-only"`）。
 * - `GenerationSessionSnapshot`（本文件）在流程上更早：它是"当前情况是什么、
 *   接下来该做什么"的**决策前态势快照**，独立于是否已经有一个冻结包存在。
 *   它不复制 pack/brief 的字段，只引用（id + fingerprint + sha256），
 *   也永不携带 localPath —— 与 Brief 同一纪律，但服务的决策阶段更早。
 * - 本类型不是新 owner：所有字段均来自下面列出的既有只读函数的组合投影，
 *   落地时必须直接调用这些函数，不得绕过它们直读表。
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// 第 0 节：本草稿假设已存在、需要在实现时真实 import 的仓库类型（仅签名占位）
// ----------------------------------------------------------------------------
// import type { StudioDashboardNextAction, StudioDashboardLocator } from "./studio-production-dashboard.js"; // 128-134, 118-126
// import type { StudioBindingPanelControl } from "./studio-binding-control.js"; // 169-212（尤其 206-211 的 bindingSet 字段）
// import type { StudioSeedanceObservedState } from "./studio-seedance-prompt-compiler.js"; // 61-75
// import type { StudioPostResultObservationControl, StudioPostResultObservationProjection } from "./studio-post-result-observation.js"; // 228-242, 216-226
// import type { StudioGenerationCallIntentRecord } from "./studio-generation-ledger.js"; // 318-343
// import type { StudioGenerationPanelInstruction, StudioGenerationTarget } from "./studio-generation.js"; // 337-354, 302-318

// ============================================================================
// 第 1 节：GenerationSessionSnapshot 类型定义（逐字段标注数据来源 owner）
// ============================================================================

/**
 * 当前 unit/panel 的定位与时间片。
 *
 * owner（存在性 + 数值）：
 * - unitId/unitRevision/panelId/panelIndex/panelCount 与时间字段均来自
 *   `StudioGenerationTarget`（src/core/studio-generation.ts:302-318）。
 * - 但 `StudioGenerationTarget` 本身只活在"已冻结的 freeze pack"里
 *   （pack.target，同文件 587 行）——**尚未冻结 pack 的 panel 没有这个结构**。
 *   未冻结时，unitId/panelId 等定位字段改由
 *   `getStudioProductionUnitSnapshot(projectRoot, unitId)` 提供（该函数是
 *   `buildUnit` 自己在用的并行调用之一，见
 *   src/core/studio-production-dashboard.ts:1260-1441 内部实现），
 *   时间片字段此时应置 `undefined` 并让 `currentness` 反映 "missing"，
 *   不得用旧 pack 的时间片顶替（会话可能早已进入下一 revision）。
 */
export interface GenerationSessionUnitPanelLocator {
  unitId: string;
  unitRevision: number;
  panelId: string;
  panelIndex: number;
  panelCount: number;
  /** 仅在已有当前 revision 的冻结包时可得；否则 undefined。 */
  unitLocalStartSeconds?: number;
  unitLocalEndSeconds?: number;
  episodeAbsoluteStartSeconds?: number;
  episodeAbsoluteEndSeconds?: number;
  durationSeconds?: number;
}

/**
 * 剧本原文区间（span）。
 *
 * owner：优先取已冻结 BindingSet 的
 * `StudioFrozenAssetBindingProvenance.bindingSet.sourceSpans[]`
 * （studio-generation.ts:495-501，字段：scriptRevisionId/scriptSha256/
 * startOffsetUtf16/endOffsetUtf16/surfaceSha256）——这是权威、已 fingerprint
 * 化的版本。
 *
 * 若 BindingSet 尚未冻结，退化取
 * `StudioBindingPanelControl.sourceExcerpts[]`
 * （studio-binding-control.ts:177-192，字段名不同：
 * startOffset/endOffset/text/sha256，且可能有多个候选片段，非单一 span）。
 * 两种来源字段名不同、粒度也不同（前者是"已选定的唯一区间"，后者可能是
 * "多个候选区间"），因此本字段用 `origin` 显式标注取自哪一路，不做静默合并。
 */
export interface GenerationSessionScriptSpan {
  origin: "frozen-binding-set" | "binding-control-source-excerpt";
  scriptRevisionId: string;
  scriptSha256: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  surfaceSha256: string;
}

/**
 * BindingSet 引用（只做引用，不复制内容）。
 *
 * owner：`StudioBindingPanelControl.bindingSet`
 * （studio-binding-control.ts:206-211），来自
 * `getStudioBindingControl(projectRoot, {unitId})` 返回的
 * `StudioBindingControlSnapshot.panels[]`（同文件 214-220）里当前 panel 对应项。
 * 该字段本身已经是"正式冻结 BindingSet 的引用"，本类型原样复用其形状
 * （id/fingerprint/currentness/frozenAt），不重新定义、不展开
 * `StudioAssetBindingSet`（studio-production.ts:340-364）的完整 bindings[]
 * 明细——展开会让 snapshot 变成第二个 BindingSet 存储，违反红线。
 */
export interface GenerationSessionBindingReference {
  panelId: string;
  /** undefined = 该 panel 尚未冻结 BindingSet；此时应查
   *  `StudioBindingControlSnapshot.nextAction`（裸字符串，见下方 nextAction
   *  小节说明）判断是否该先 freeze_studio_asset_binding_set。 */
  bindingSet?: {
    id: string;
    fingerprint: string;
    currentness: "current" | "stale";
    frozenAt: string;
  };
}

/**
 * 单条引用资产条目。刻意不含 localPath —— 与
 * `StudioAgentImagegenBrief.controlReferences`
 * （studio-generation.ts:2385-2391）同一纪律。
 */
export interface GenerationSessionReferenceItem {
  assetId: string;
  /** StudioAssetCategory；此处不重复其定义，见 studio-production.ts。 */
  category: string;
  presence: "required" | "optional" | "forbidden";
  /**
   * 自由字符串 —— 全仓 `role` 字段目前均声明为 `role: string`
   * （studio-production.ts 第 138/174/219/231/327/523/532/772/932/976 行等，
   * panel-reference-resolution-core.ts 同样如此），**没有编译期 union**。
   * 下面 `GenerationSessionReferenceRoles` 的四个分组是按这个自由字符串的
   * 取值做运行时分桶，不是类型系统认可的枚举，需要调用方自己容忍
   * "role 取到未识别值"的第五种情况（本设计不强行归类，未识别值不进任何
   * 分组，只能通过原始 BindingSet 明细查到）。
   */
  role: string;
  /** 只有已绑定到具体媒体版本时才有；不带 localPath。 */
  mediaSha256?: string;
}

/**
 * 引用角色分组。
 *
 * owner：全部来自当前 panel 的 BindingSet 明细
 * （`StudioAssetBindingSet.bindings[]`，studio-production.ts:340-364，
 * 经 `getCurrentStudioPanelAssetBindingSet` 或已冻结 pack 的
 * `assetBinding`/`panelReferenceResolution` 取得），按 `role`/`presence`
 * 两个既有字段重新分桶，不新增来源。
 *
 * 现状核实结果（2026-07-26 全仓递归 grep 实测）：
 * - `canonical_identity`：0 命中。纯设计缺口，本设计稿只声明分组位置，
 *   不代表已有数据会落进来。
 * - `continuation_source`：12 处真实调用（studio-unit-grid-generation.ts
 *   等），已有生产语义，可直接分组。
 * - `composition_hint`：0 命中。同样是纯设计缺口；且核实发现
 *   `PanelReferenceControlPurpose`（panel-reference-resolution-core.ts:20）
 *   是**已有编译期类型**，取值仅 `"identity" | "continuity"`，没有第三个
 *   "composition" 取值 —— 也就是说 composition_hint 在 `role`（自由字符串）
 *   和 `purpose`（已有 union）两条路径上都没有现成落点，是真正意义上从零
 *   开始的新增语义，实现时需要先决定它挂在 `role` 自由字符串上（成本低，
 *   但无类型保护）还是扩展 `PanelReferenceControlPurpose` 的 union（成本高，
 *   要过一遍现有 "归一化后默认 identity" 的兼容逻辑，
 *   panel-reference-resolution-core.ts:184-185 注释）。本设计稿倾向前者
 *   （更小改动半径），但留给 P4 实现时确认。
 * - `forbidden`：**结构上不是 role 值**，而是独立的
 *   `StudioFrozenForbiddenAsset`/`forbiddenAssets` 数组
 *   （studio-generation.ts:384-398，`presence: "forbidden"`），已有实现。
 *   分组时用 `presence === "forbidden"` 判定，不要去匹配 `role === "forbidden"`
 *   字符串（源码里从未这样表达）。
 */
export interface GenerationSessionReferenceRoles {
  canonicalIdentity: GenerationSessionReferenceItem[];
  continuationSource: GenerationSessionReferenceItem[];
  compositionHint: GenerationSessionReferenceItem[];
  forbidden: GenerationSessionReferenceItem[];
}

/**
 * previous actual-tail（上一镜实际末态）。
 *
 * 这是全设计里唯一需要"跨两个 owner 做身份闭环 JOIN"才能拼出来的字段，
 * 因为没有任何单一函数直接按 unitId/panelId 查"上一镜实际长什么样"：
 *
 * 1. 先定位"上一个已 Review PASS 的 generationRunId"——真实先例见
 *    `freezePreviousUnitContinuationSource`
 *    （src/core/studio-unit-grid-generation.ts:556-650 附近）：
 *    取上一 unit 的 `listStudioGenerationLatestUnitGridRuns` →
 *    `latestRun.generationRunId` → `getStudioGenerationReviewControl` 核对
 *    review head 身份闭环（reviewId/reviewFingerprint/rawResultId/rawSha256/
 *    labeledResultId/labeledSha256/packId/packFingerprint 必须逐一相等，
 *    该函数对这条链路做了详尽交叉校验，本设计稿直接复用其结论，不重新校验）。
 * 2. 再用这个 generationRunId 调用
 *    `getStudioPostResultObservationControl(projectRoot, generationRunId)`
 *    （src/core/studio-post-result-observation.ts:2110 起）拿到
 *    `StudioPostResultObservationControl`（228-242 行）：
 *    - `.status`："missing" | "current" | "stale"
 *    - `.head`：`StudioPostResultObservationProjection`（216-226 行），
 *      其 `.observedState` 才是真正的 13 个结构化字段
 *      （`StudioSeedanceObservedState`，studio-seedance-prompt-compiler.ts:
 *      61-75：costume/injury/heldObject/position/facing/emotion/layout/
 *      lighting/referenceSha256/motionVector/cameraPhase/focusState/
 *      audioPhase），此处类型是
 *      `Pick<..,"referenceSha256"> & Partial<Omit<..,"referenceSha256">>`
 *      （studio-post-result-observation.ts:126-128）——referenceSha256 必填，
 *      其余 12 个字段均可选，取用时不能假设全部存在。
 *    - `.head.continuationEligible`：下一格能否以此为续镜起点的现成判定，
 *      直接透传，不重新实现判定逻辑。
 *
 * 注意：freeze pack 里也有一个名字很像的
 * `StudioPreviousApprovedRawSnapshot`（studio-generation.ts:320-335），
 * 但那是"上一个 approved raw 的身份/存证"（reviewId/rawResultId/rawSha256/
 * rawLocalPath 等），**不含**上述 13 个结构化状态字段本身 ——
 * 两者是同一条continuity 链路上的不同切面（存证 vs 结构化观测值），
 * `previousActualTail` 字段名对应任务要求的"actual-tail"，因此以
 * `StudioPostResultObservationControl.head.observedState` 为准，
 * 不要错误地用 `StudioPreviousApprovedRawSnapshot` 顶替。
 */
export interface GenerationSessionPreviousActualTail {
  sourceGenerationRunId: string;
  status: "missing" | "current" | "stale";
  observedState?: Partial<{
    costume: string;
    injury: string;
    heldObject: string;
    position: string;
    facing: string;
    emotion: string;
    layout: string;
    lighting: string;
    motionVector: string;
    cameraPhase: string;
    focusState: string;
    audioPhase: string;
  }> & { referenceSha256: string };
  continuationEligible?: boolean;
  /** = control.fingerprint；供调用方比对自己读到的是否与 snapshot 组装时一致。 */
  sourceFingerprint?: string;
}

/**
 * camera / axis（镜头与轴线信息）。
 *
 * 诚实的现状（核实结论，非本设计新增假设）：
 * - "current" 一侧目前唯一确认来源是**已冻结 freeze pack** 里的
 *   `StudioGenerationPanelInstruction`（studio-generation.ts:337-354）：
 *   `shotComposition`（构图/机位描述）、`filmingMethod`（拍摄方式）、
 *   `shotType`："original" | "extension"。均为自由文本或二值枚举，
 *   **没有结构化的镜头角度/机位坐标字段**。若当前 panel 尚未冻结 pack，
 *   这三个字段暂无确认来源（未核实 `StudioDashboardUnitDetail` 是否有更早
 *   期的规划态字段可用，本设计不臆测，标注在"实施时待办"里）。
 * - "previous" 一侧来自上面 `previousActualTail.observedState.cameraPhase`
 *   —— 同样是自由文本，不是结构化机位。
 * - **180 度轴线/越轴校验没有专用字段**：`STUDIO_CONTINUITY_FIELDS`
 *   （src/core/studio-continuity.ts:3-13）只有 9 个字段（costume/injury/
 *   heldObject/position/facing/emotion/layout/lighting/referenceSha256），
 *   不含任何 axis 相关字段。本设计**不新增**结构化轴线字段 ——
 *   一是没有真实数据源可填，二是新增会制造"轴线状态"这个新的迷你状态机，
 *   违反红线第 2/3 条。如果未来确实需要越轴校验，应该在
 *   `STUDIO_CONTINUITY_FIELDS` 上加字段（连续性系统内部演进），而不是在
 *   snapshot 投影层单独发明。本字段的 `axisContinuityNote` 因此只是一个
 *   自由文本占位，**内容仍需从 current/previous 的自由文本里人工/Codex
 *   推断**，不代表系统已有结构化越轴判断能力。
 */
export interface GenerationSessionCameraAxis {
  current?: {
    shotComposition: string;
    filmingMethod: string;
    shotType: "original" | "extension";
  };
  previous?: {
    cameraPhase: string;
  };
  /** 现状说明见上方类型注释；不是结构化校验结果，只是一句留白提示。 */
  axisContinuityNote: "no-structured-axis-field-exists-compare-current-and-previous-manually";
}

/**
 * 最危险失败项（唯一一条，按下方固定优先级从多个 owner 里挑选）。
 *
 * 优先级（从高到低，第一个非空的命中项即为 topRisk，不做多项并列）：
 * 1. call-intent 处于 "generation_unknown" 状态 —— 硬阻断：
 *    `assertRunNotGenerationUnknown`（studio-generation-ledger.ts:6684-6693）
 *    的报错原文就是"禁止失败、取消、重试或重复派发"，是唯一会让**所有**
 *    后续动作非法的状态，必须最优先暴露。
 * 2. `StudioBindingPanelControl.blockers`
 *    （studio-binding-control.ts:163-167 `StudioBindingBlocker`，
 *    含 `severity: "blocking" | "warning"`）里 severity="blocking" 的第一条
 *    —— BindingSet 本身没法冻结。
 * 3. freeze readiness 处于 `status: "blocked"`
 *    （见 codex.ts:472-483 `queryStudioUnitGridGenerationFreeze` 返回分支，
 *    只有 code/message/detailCount，没有 severity 字段，视为等同 blocking）
 *    —— 冻结包本身不可用（资产/权威/连续性未就绪）。
 * 4. `StudioPostResultObservationControl.status === "stale"` 或
 *    `.blockers`（string[]，无 severity 细分）非空 —— 续镜身份链有断裂风险。
 * 5. `StudioBindingPanelControl.blockers` 里 severity="warning" 的第一条
 *    —— 较低优先级提示。
 * 都没有命中则 `topRisk` 为 `null`（无实质风险，不强行填充占位对象）。
 *
 * `derivedFrom` 是唯一允许的"风险来源"表达方式：只能指向已有 owner 的已有
 * 字段，不得引入新的风险登记表/风险状态机（红线第 2/3 条）。
 */
export interface GenerationSessionRiskItem {
  code: string;
  message: string;
  severity: "blocking" | "warning";
  derivedFrom:
    | { source: "call-intent-generation-unknown"; generationRunId: string; callId: string }
    | { source: "binding-panel-blocker"; panelId: string; blockerCode: string }
    | { source: "freeze-readiness-blocked"; code: string }
    | { source: "post-result-observation"; generationRunId: string; status: "missing" | "stale" };
}

/**
 * 唯一 nextAction。
 *
 * 现状核实：各 owner 目前的 nextAction 形状并不统一 ——
 * - `StudioDashboardBase.nextAction`
 *   （studio-production-dashboard.ts:128-134 `StudioDashboardNextAction`）
 *   是结构化对象：code/label/reason/requiresWrite/command?/locator?。
 * - `StudioBindingControlSnapshot.nextAction`
 *   （studio-binding-control.ts:214-220）是**裸字符串**。
 * - `StudioPostResultObservationControl.nextAction`
 *   （studio-post-result-observation.ts:236-240）是一个**四值字符串联合**
 *   （"wait-for-current-pass-review" | "submit-observed-end-state" |
 *   "use-observed-end-state" | "reobserve-current-pass-result"），不是对象。
 *
 * 本类型统一采用 `StudioDashboardNextAction` 的结构化形状（对齐 P8 驾驶舱
 * 合同"Core 结构化 nextAction"要求），实现时对来自 binding-control/
 * post-result-observation 的裸字符串/枚举值做**一次性升格包装**
 * （code=原字符串本身，label/reason 由组装函数按已知取值表补全人类可读文案），
 * 不是简单透传 —— 这一步升格逻辑属于 snapshot 组装函数自身的职责，
 * 不应该反过来去改动 binding-control/post-result-observation 两个 owner
 * 自己的 nextAction 类型（那样属于修改既有 owner 的公开契约，影响范围更大，
 * 不在本次 P4 变更范围内）。
 */
export interface GenerationSessionNextAction {
  code: string;
  label: string;
  reason: string;
  requiresWrite: boolean;
  command?: string;
  locator?: {
    kind: "project" | "unit" | "panel" | "asset" | "queue-item";
    projectId: string;
    unitId?: string;
    panelId?: string;
    assetId?: string;
  };
}

/**
 * ============================================================================
 * GenerationSessionSnapshot 主体
 * ============================================================================
 * 顶层信封字段（schemaVersion/kind/projectId/manifestFingerprint/fingerprint/
 * nextAction/currentness）对齐 P8 驾驶舱合同
 * （docs/交接_给其他AI_20260718_P7完成_P8起点.md:249-264）：
 * 响应必须含 schemaVersion/kind/fingerprint；currentness 用文档要求的四态
 * （current/stale/missing/blocked，本设计不需要"not-applicable"，因为
 * session-snapshot 总是针对一个具体存在的 unit/panel 请求，不存在
 * "这个概念对当前上下文不适用"的情况）；严禁出现 SQLite/CAS 路径、
 * bodyPath/objectPath/localPath、媒体二进制。
 */
export interface GenerationSessionSnapshot {
  schemaVersion: 1;
  kind: "studio-generation-session-snapshot";
  projectId: string;
  /** owner: 与 buildUnit / get_studio_generation_control 现有封装一致，
   *  取当前受管工程的 manifest fingerprint，不重新计算。 */
  manifestFingerprint: string;

  unit: GenerationSessionUnitPanelLocator;
  /** undefined = 当前 panel 还没有可确定归属的原文区间（例如剧本已改版但
   *  BindingSet 尚未重新分析）。 */
  scriptSpan?: GenerationSessionScriptSpan;
  binding: GenerationSessionBindingReference;
  referenceRoles: GenerationSessionReferenceRoles;
  /** undefined = 当前是本 unit/episode 的第一格，没有"上一镜"可续。 */
  previousActualTail?: GenerationSessionPreviousActualTail;
  camera: GenerationSessionCameraAxis;
  topRisk: GenerationSessionRiskItem | null;
  nextAction: GenerationSessionNextAction;
  currentness: "current" | "stale" | "missing" | "blocked";
  fingerprint: string;
}

// ============================================================================
// 第 2 节：内容寻址 —— fingerprint 计算范围
// ============================================================================
/**
 * 参与指纹计算的字段子集（建议实现时用一个显式白名单对象，而不是对整个
 * snapshot 做指纹 —— 原因见下）：
 *
 *   {
 *     unit: { unitId, unitRevision, panelId, panelIndex },
 *     scriptSpan,                              // 若存在，整体入指纹
 *     binding: { bindingSetId: binding.bindingSet?.id,
 *                bindingSetFingerprint: binding.bindingSet?.fingerprint },
 *                // 注意：不含 frozenAt 时间戳 —— 同一个 BindingSet 被读取
 *                // 两次，frozenAt 不变，但如果误把"读取时刻"相关的任何字段
 *                // 混进来，会制造指纹漂移假阳性，这里特别排除时间戳类字段。
 *     referenceRoles: 四组各自按 assetId 升序排序后取
 *                     { assetId, role, presence, mediaSha256 } 数组，
 *                     // 排序是关键 —— 若不排序，同一份数据仅因为查询返回
 *                     // 顺序不同就会被误判 stale。
 *     previousActualTail: sourceGenerationRunId + observedState（若存在），
 *     camera: current + previous 的字符串字段（axisContinuityNote 是常量，
 *             不需要入指纹）,
 *     topRisk: topRisk?.code ?? null,          // 只取 code，不取 message ——
 *                                                // message 是自由文本描述，
 *                                                // 措辞调整不代表状态真变化。
 *   }
 *
 * 明确不参与指纹的字段：
 * - `nextAction` 全部字段 —— nextAction 是"依据以上字段 + currentness 推导出
 *   的结论"，如果把结论本身也塞进指纹计算的输入，会形成自我引用：
 *   同一份底层数据，只是 label 文案换了个说法，也会被判定成指纹变化。
 * - `currentness` 自身 —— 同理，衍生结论不进指纹。
 * - `fingerprint` 自身 —— 显然不能自己算自己。
 *
 * 与 freeze pack「executionSnapshotHash」的关系：**独立，不对齐，不合并**。
 *
 * 核实过程中发现的一处需要澄清的偏差（如实记录，不回避）：
 * 任务描述称"已确认 callIntentFields 含 ... executionSnapshotHash
 * （src/core/codex.ts:1372 附近）"—— 这一行确实存在，但它出现在
 * `subagentImagegen` 能力自描述块（codex.ts:1358-1383）里的
 * `callIntentFields: ["callId","runId","leaseId","owner","attempt",
 * "maxCalls","executionSnapshotHash"]`，这段词表**混合了两套模型**：
 *   - leaseId/owner/attempt/maxCalls/executionSnapshotHash 等取自同一能力块
 *     里紧邻的 `leaseFields`（1367 行：leaseId/owner/heartbeatAt/leaseUntil/
 *     leaseSeconds/fence）所描述的"旧版通用生成任务租约模型"—— 该模型的
 *     真实字段分布在 `src/core/generation.ts`（891/955/1922/2047/2134/2295/
 *     2324/2443/2530/2587/2976 行等 11 处）与 `src/core/types.ts`
 *     （1567/1586/1687/1857/1899 行 5 处），是一套**独立于**
 *     studio-generation-ledger.ts 的更早/更通用的生成子系统。
 *   - callId/runId 才对应本任务真正指向的"生成账本"——
 *     `src/core/studio-generation-ledger.ts` 的
 *     `studio_generation_call_intents` 表 / `StudioGenerationCallIntentRecord`
 *     （318-343 行）/ `CallIntentRow`（721-734 行）。
 * 经逐列核实，该表真实列为：call_id, generation_run_id, dispatch_id,
 * pack_id, pack_fingerprint, executor_provider('codex'|'grok' 二值),
 * target_kind, target_key, input_fingerprint, context_token_hash,
 * command_request_id, created_at（DDL 见 1059-1076 行）——
 * **没有 leaseId / owner / attempt / maxCalls / executionSnapshotHash 任何一个
 * 列**。也就是说 codex.ts:1372 的声明是一段"旧模型术语 → 新模型术语"的
 * 迁移期能力文档，不是 `studio_generation_call_intents` 的字面 schema。
 * 这不影响任务的核心结论（子代理身份追踪确实是 0 覆盖的真空区，见第 3 节），
 * 但 `executionSnapshotHash` 本身不存在于生成账本里，因此
 * GenerationSessionSnapshot 的 fingerprint 没有对象可对齐，只能独立计算。
 *
 * 即便未来 studio-generation-ledger.ts 里出现了同名字段，也不建议对齐，
 * 因为两者服务不同阶段：freeze pack/其证据哈希描述的是"已执行、已产生结果"
 * 的证据完整性；GenerationSessionSnapshot 描述的是"决策前，可能还没有任何
 * pack"的态势。若强行让两个指纹相等，snapshot 每多看一个字段（例如
 * topRisk），pack 的指纹就要跟着变，制造错误耦合，违反红线第 2/3 条
 * （聚合投影不能反向影响 owner）。
 */
export const GENERATION_SESSION_SNAPSHOT_FINGERPRINT_FIELDS = [
  "unit.unitId", "unit.unitRevision", "unit.panelId", "unit.panelIndex",
  "scriptSpan",
  "binding.bindingSet.id", "binding.bindingSet.fingerprint",
  "referenceRoles.*.assetId", "referenceRoles.*.role", "referenceRoles.*.presence", "referenceRoles.*.mediaSha256",
  "previousActualTail.sourceGenerationRunId", "previousActualTail.observedState",
  "camera.current", "camera.previous",
  "topRisk.code",
] as const;

// ============================================================================
// 第 3 节：callerId / agentId 方案
// ============================================================================
/**
 * 真实现状核实结论（studio-generation-ledger.ts）：
 *
 * - 表 `studio_generation_call_intents`（1059-1076 行 DDL）是 STRICT 表，
 *   且有 `no_update`/`no_delete` BEFORE 触发器（1189-1192 行，append-only，
 *   报错原文"generation call intents are append-only"）。
 * - 唯一真实调用方：`src/core/command-bus.ts:2798`
 *   （`prepare_studio_imagegen_call` 命令分支）。其中
 *   `commandRequestId: commandRequestHash(projectRoot, request)`
 *   —— 是命令请求内容的哈希，服务于"业务写入成功、命令收据未落盘"崩溃窗口的
 *   幂等对账（command-bus.ts:2794-2795 行注释），**不是**代理身份，
 *   而 `request.payload` 一路展开传下去也没有任何字段携带子代理身份。
 * - 结论：从 MCP 工具入参 → command-bus → ledger 落库，全链路当前
 *   **没有任何字段记录"是哪一个子代理实例/会话发起了这次调用"**。
 *   `executor_provider` 只做到 'codex'|'grok' 的供应商粗分类，无法区分
 *   同一 provider 下的多个并发子代理或多次独立会话。这是真实的 0 覆盖缺口，
 *   与任务诉求一致（只是不能拿 codex.ts:1372 的字面字段去对应这张表，
 *   见第 2 节澄清）。
 *
 * 方案：新增一个可空列，不新建事件表。
 *
 * - 加列：`studio_generation_call_intents.caller_agent_id TEXT`（可空）。
 *   自由字符串，建议格式留给实现时与 Codex MCP 客户端约定（例如
 *   `"codex-session-<uuid>"` / `"grok-run-<uuid>"` /
 *   `"human-operator:<identifier>"`），本设计稿不强制格式，只要求
 *   "同一次子代理会话/进程要能稳定复用同一个值"。
 * - 不新增 `caller_agent_kind` 列 —— `executor_provider` 已经是
 *   codex/grok 的粗分类，`caller_agent_id` 只补"具体是哪一次/哪个实例"这一
 *   个维度，两列组合已完整覆盖"子代理身份追踪"，不需要第三个字段。
 * - 迁移策略：复用本文件已有的 schema_version 演进机制 ——
 *   当前 `SCHEMA_VERSION = 6`（studio-generation-ledger.ts:60），且该文件
 *   已多次示范"建同名 `_migration` 后缀新表 → 搬历史数据 → 删旧表改名 →
 *   `UPDATE studio_generation_ledger_meta SET value=? WHERE key='schema_version'`"
 *   这套手法（1619-1620/1868 行 `ALTER TABLE ... RENAME TO ..._migration`
 *   即是先例）。新增列时同样：建
 *   `studio_generation_call_intents_v7_migration`（多一列
 *   `caller_agent_id TEXT`，允许 NULL）→ 历史行整体搬迁，
 *   `caller_agent_id` 一律填 NULL（代表"历史调用身份不可考"，不做不可靠的
 *   倒填猜测）→ 删旧表改名 → schema_version 6→7 → 迁移后的新表照旧加回
 *   `no_update`/`no_delete` 触发器，append-only 不变式不受影响
 *   （触发器挡的是 DML，不挡这次性质的 DDL 重建迁移）。
 * - 不做成独立事件表（例如 `studio_generation_call_intent_agents`）的理由：
 *   身份是"调用发起那一刻就确定、此后不再变"的静态属性，不像
 *   `studio_generation_call_events`（1078-1090 行）记录的是
 *   result-committed/not-invoked/unknown-observation 这种真正会追加的多次
 *   事件。做成旁表反而制造"要不要 JOIN、JOIN 不上算什么状态"的新歧义，
 *   单列更简单且语义更直接。
 * - 写入面改动范围（本节只列改动点，不在本设计稿内实现）：
 *   1. `PrepareStudioImagegenCallInput`（276-284 行）新增
 *      `callerAgentId?: string`。
 *   2. `prepareStudioImagegenCall()`（6093-6216 行）INSERT 语句新增该列。
 *   3. `callIntentRecord()`（5205 行起的映射函数）与
 *      `StudioGenerationCallIntentRecord`（318-343 行）同步新增
 *      `callerAgentId: string | null`。
 *   4. `command-bus.ts:2798` 的 `prepare_studio_imagegen_call` 分支从
 *      `request.payload` 透传该字段；`studio-command-runtime.ts:696`
 *      附近对应的 zod payload schema 需要同步放开这个可选字段，否则会被
 *      strict schema 拦截。
 *
 * 与现有 owner/agentRunId 字段的语义区分（三个维度互不重合、不合并）：
 * - `generation_run_id`（本表既有列）：标识"这一次生成运行"这个业务实体，
 *   不是身份。
 * - `command_request_id`（本表既有列）：标识"这一次 IPC 命令请求"的内容哈希，
 *   服务命令层幂等/崩溃对账，与身份无关 —— 当前确实没有人把它当身份用，
 *   但本设计稿显式划清，避免以后有人图省事复用它。
 * - 全仓其它地方出现的 "owner" 字样（例如 codex.ts:1367 leaseFields 里的
 *   owner）指的是"当前谁持有写锁/租约"这种排他性并发控制语义（谁能写、
 *   别人不能写）；新提议的 `callerAgentId` 是审计/追溯维度（回看历史时这次
 *   调用是谁发起的）。两者可以同时存在、职责不同，不应该合并成一个字段。
 */
export interface CallerIdMigrationSketch {
  addColumn: "studio_generation_call_intents.caller_agent_id";
  columnType: "TEXT";
  nullable: true;
  schemaVersionBump: { from: 6; to: 7 };
  migrationPattern: "rename-rebuild-copy"; // 与既有 v1→v2 等迁移手法一致
  backfillPolicy: "null-for-all-historical-rows"; // 不倒填不可靠数据
}

// ============================================================================
// 第 4 节：暴露通道
// ============================================================================
/**
 * 推荐：作为 `get_studio_generation_control` 的新 operation
 * （`{ operation: "session-snapshot"; unitId: string; panelId?: string }`），
 * 而不是新增独立只读 MCP 工具。
 *
 * 依据（均为核实结论，非主观偏好）：
 *
 * 1. `get_studio_generation_control` 已是"Codex 专用的本地生成控制封装"
 *    ——原话见其实现函数 `getStudioGenerationControlEnvelope`
 *    （codex.ts:461）正上方 458-460 行注释；已注册为真实 MCP 工具
 *    （src/mcp/server.ts:5171），已在 `managedStudio` 能力工具清单里
 *    （codex.ts:1122）。现有 7 种 operation ——
 *    readiness/pack/history/plan/call/active-runs/detached-unknown
 *    （`StudioGenerationControlQuery`，codex.ts:99-114）——
 *    全部共享同一个 `schemaVersion` + `kind: STUDIO_GENERATION_CONTROL_KIND`
 *    （= "studio-codex-generation-control-envelope"，codex.ts:116）封装模式，
 *    且该函数自身文档已经明确"普通就绪/历史投影不返回路径；只有 pack
 *    operation 才在重验后返回 localPath"—— 这正是 GenerationSessionSnapshot
 *    需要的"多数只读、唯独 pack 例外"合同，新增 `session-snapshot`
 *    operation 是同一形状的自然扩展，不需要发明新的封装规则。
 * 2. 避免 MCP 工具数量膨胀：新增独立工具需要同时改
 *    codex.ts 的 `commandTypes`/`managedStudio` 清单、server.ts 工具注册表、
 *    Codex 客户端能力发现文档三处；继续往 `get_studio_xxx_control
 *    (operation=...)` 这一族现有命名里加 operation，认知负担和维护成本都
 *    更低，也是仓库目前的既定风格（对照 P8 交接文档"新增一个只读 MCP：
 *    get_studio_production_dashboard；...禁止新增 Dashboard 具名写工具"
 *    体现的同一种"聚合只读工具做加法、不做具名工具膨胀"倾向）。
 * 3. 明确排除的备选项：挂到 `get_studio_production_dashboard` 的 "unit"
 *    operation（`buildUnit`，studio-production-dashboard.ts:1260-1441）。
 *    buildUnit 内部恰好已经并行读取 getStudioBindingControl +
 *    getStudioProductionUnitSnapshot + getStudioContinuityReviewControl +
 *    queryStudioGenerationFreeze，四路 join 和 GenerationSessionSnapshot
 *    高度重叠 —— 但 buildUnit 服务人类/UI（Vue 组件消费的通用"单元详情"，
 *    字段更宽泛、没有"唯一 nextAction"这种强约束），而
 *    GenerationSessionSnapshot 明确是"向 Codex 暴露"的决策前态势快照
 *    （任务原话），消费者和契约意图都与 get_studio_generation_control 的
 *    "Codex 专用"定位更贴合。不应把 Codex 专属窄契约叠加进面向人类/UI 的宽
 *    视图，两者职责边界应保持分离（红线：不重新实现/污染既有 Dashboard
 *    状态表）。
 * 4. 满足 P8 驾驶舱合同的具体条款：
 *    - schemaVersion/kind/fingerprint 三件套沿用现有封装外层已提供的模式；
 *    - nextAction 用本设计稿定义的结构化
 *      `GenerationSessionNextAction`（对齐 `StudioDashboardNextAction` 的
 *      code/label/reason/requiresWrite/command/locator 形状），不是
 *      binding-control 那种裸字符串；
 *    - currentness 用 current/stale/missing/blocked 四态；
 *    - `referenceRoles`/`previousActualTail`/`binding` 任何字段都不出现
 *      localPath/objectPath/SQLite path —— 涉及媒体只给 mediaSha256；
 *      需要真实路径时仍必须走 `get_studio_generation_control
 *      (operation="pack")` 或 dispatch 后的执行 payload，`session-snapshot`
 *      不是 pack operation，不承担返回路径的职责（与
 *      `StudioAgentImagegenBrief.referencePathSource:
 *      "pack-operation-controlReferences-only"` 同一纪律）。
 */
export type GenerationSessionSnapshotQueryOperation = {
  operation: "session-snapshot";
  unitId: string;
  panelId?: string;
};

// ============================================================================
// 第 5 节：实施时待办清单（本设计稿范围之外，留给实现阶段）
// ============================================================================
/**
 * 1. studio-generation-ledger.ts：SCHEMA_VERSION 6→7 迁移（caller_agent_id
 *    列）+ PrepareStudioImagegenCallInput/StudioGenerationCallIntentRecord/
 *    CallIntentRow 三处同步改类型 + callIntentRecord() 映射函数补分支。
 * 2. command-bus.ts:2798 与 studio-command-runtime.ts:696 附近的 zod
 *    payload schema 放开 callerAgentId 可选入参；需要与 Codex 侧约定
 *    "这个值由客户端每次调用自己传入固定 session id，还是由 server 侧
 *    根据 MCP 连接/进程自动派生"—— 本设计稿不代为决定，需要一次对齐。
 * 3. 新增 `buildGenerationSessionSnapshot(projectRoot, {unitId, panelId})`
 *    实现函数，倾向放新文件（例如
 *    studio-generation-session-snapshot.ts）而不是塞进
 *    studio-generation-ledger.ts —— 因为它纯做只读投影/组装，不持有任何表，
 *    符合"聚合 bundle 不能是新 owner"的红线，只是文件归属问题。内部只允许
 *    调用既有 owner 读函数（getStudioBindingControl/
 *    getStudioProductionUnitSnapshot/getStudioContinuityReviewControl/
 *    queryStudioGenerationFreeze/getStudioPostResultObservationControl/
 *    readStudioImagegenCallIntentByRun），不得直接写 SQL 或绕过这些函数。
 * 4. codex.ts 的 `StudioGenerationControlQuery` 增加
 *    `{ operation: "session-snapshot"; unitId: string; panelId?: string }`
 *    分支；`getStudioGenerationControlEnvelope` 增加对应 case；
 *    server.ts 该 MCP 工具的 zod 输入/输出 schema 与工具描述文案同步更新。
 * 5. `role` 取值 "canonical_identity"/"composition_hint" 目前只是自由字符串
 *    上的约定（全仓 role 字段均为 `role: string`，无编译期 union）。
 *    P1/P4 实现时如果要让这两个分组真正非空，需要先有生产者在写入
 *    BindingSet 时开始产出这两个字符串值 —— 这是"数据模型缺口"之外的
 *    "生产者缺口"，本设计稿只解决前者，不代为决定后者的产出时机。
 * 6. `camera.current`（shotComposition/filmingMethod/shotType）在 panel
 *    尚未冻结 pack 前没有确认来源。需要实现时明确二选一：
 *    (a) 接受"未冻结时 camera.current 为 undefined + currentness=missing"；
 *    (b) 去核实 `StudioDashboardUnitDetail`
 *    （studio-production-dashboard.ts:244-278）是否存在更早期的规划态字段
 *    可用 —— 本设计稿未逐字核实该接口的完整字段列表，不能替实现者下结论，
 *    需要对照源码确认后再定。
 * 7. `topRisk` 的五级优先级判定需要写单元测试锁定顺序
 *    （generation_unknown > binding blocking > freeze blocked >
 *    observation stale > binding warning），防止后续改动无声打乱优先级。
 * 8. fingerprint 参与字段集合一旦定稿，需要有"改字段必过"的回归测试
 *    （本设计稿未逐一核实仓库里 digest()/stableValue() 惯例对应的具体测试
 *    文件命名规范，实现时参照 buildUnit 等既有 fingerprint 用法旁边的测试
 *    写法）。
 * 9. 本设计稿的 `GenerationSessionNextAction`/`GenerationSessionRiskItem`
 *    等本地类型在真正落地时应删除本文件里的重复声明，直接从对应仓库文件
 *    import 复用（尤其 `StudioDashboardNextAction`），避免两份定义漂移。
 */
export const IMPLEMENTATION_TODO_COUNT = 9;
