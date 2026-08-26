/**
 * P21 create_studio_generation_plan 只读草稿。
 * 不执行命令、不派发、不读对照板 / SQLite。
 * 单镜只认该宫格自己的冻结 pack；整板只认已落盘 unit-grid pack。
 * 禁止用同行已出图 preview pack，禁止猜第一格，禁止用单镜 pack 冒充整板节点。
 */

export const STUDIO_GENERATION_PLAN_COMMAND = "create_studio_generation_plan" as const;
/** @deprecated 用 STUDIO_GENERATION_PLAN_COMMAND；SSL-5 兼容别名。 */
export const SSL5_GENERATION_PLAN_COMMAND = STUDIO_GENERATION_PLAN_COMMAND;

export type StudioGenerationPlanDraftNode =
  | { unitId: string; panelId: string }
  | { targetKind: "unit-grid"; unitId: string };

export type StudioGenerationPlanDraft = {
  command: typeof STUDIO_GENERATION_PLAN_COMMAND;
  ready: boolean;
  blockedReason: string | null;
  nodes: StudioGenerationPlanDraftNode[] | null;
  dispatch: false;
  note: string;
};

/** SSL-5 / 历史别名。 */
export type Ssl5GenerationPlanDraftNode = StudioGenerationPlanDraftNode;
export type Ssl5GenerationPlanDraft = StudioGenerationPlanDraft;

const NOTE_BLOCKED = "只读草稿。不执行、不派发。";
const NOTE_READY = "只起草建计划节点；不执行、不派发。派发须用计划推导 runId。";
const NOTE_HAS_PLAN = "计划已落盘。下一步 dispatch；不执行、不派发。派发须用计划推导 runId。";
const NOTE_WAIT = "计划节点进行中。下一步等待结果或对账；不执行、不派发。";
const NOTE_RETRY = "计划节点已失败或已取消。下一步 retry；不执行、不重试、不派发。";
const NOTE_REVIEW = "计划节点已有 raw+labeled。下一步 Review；不执行、不派发。";

/** 账本节点投影子集；retry-superseded 在只读面映射为 planned，不进本联合。 */
export type PersistedPlanNodeStatus =
  | "planned"
  | "dispatched"
  | "failed"
  | "cancelled"
  | "succeeded";

export const STUDIO_GENERATION_PLAN_ALREADY_EXISTS_PANEL =
  "该宫格已有生成计划，下一步是 dispatch（不派发）";
export const STUDIO_GENERATION_PLAN_ALREADY_EXISTS_UNIT_GRID =
  "该整板已有生成计划，下一步是 dispatch（不派发）";
export const STUDIO_GENERATION_PLAN_IN_FLIGHT_PANEL =
  "该宫格计划节点进行中，等待结果或对账（不派发）";
export const STUDIO_GENERATION_PLAN_IN_FLIGHT_UNIT_GRID =
  "该整板计划节点进行中，等待结果或对账（不派发）";
export const STUDIO_GENERATION_PLAN_RETRY_PANEL =
  "该宫格计划节点已失败/已取消，下一步是 retry（不重试、不派发）";
export const STUDIO_GENERATION_PLAN_RETRY_UNIT_GRID =
  "该整板计划节点已失败/已取消，下一步是 retry（不重试、不派发）";
export const STUDIO_GENERATION_PLAN_REVIEW_PANEL =
  "该宫格计划节点已有结果，下一步是 Review（不派发）";
export const STUDIO_GENERATION_PLAN_REVIEW_UNIT_GRID =
  "该整板计划节点已有结果，下一步是 Review（不派发）";
export const STUDIO_GENERATION_PLAN_UNIT_GRID_WAIT =
  "earliest / unit-grid 正在执行，等待结果或对账（不派发）";
export const STUDIO_GENERATION_PLAN_UNIT_GRID_RETRY =
  "earliest / unit-grid 计划节点已失败/已取消，下一步是 retry（不重试、不派发）";
export const STUDIO_GENERATION_PLAN_UNIT_GRID_REVIEW =
  "earliest / unit-grid 计划节点已有结果，下一步是 Review（不派发）";
export const STUDIO_GENERATION_PLAN_UNIT_GRID_RECONCILE =
  "earliest / unit-grid 未知生图 call，先对账（禁止重派）";

export type UnitGridBlockingKind = "wait" | "retry" | "review" | "reconcile";

/** 驾驶舱 / earliest nextAction code → 禁止再建议 create-plan/dispatch。 */
export function unitGridNextActionBlockingKind(
  code: string | null | undefined,
): UnitGridBlockingKind | null {
  if (code === "wait-or-reconcile-unit-grid-run") return "wait";
  if (code === "retry-unit-grid-plan-nodes") return "retry";
  if (code === "submit-unit-grid-review") return "review";
  if (code === "reconcile-unit-grid-call") return "reconcile";
  return null;
}

/** 已加载 unit-grid 节点状态 → 同上。planned 不挡（下一步仍是 dispatch）。 */
export function unitGridStatusBlockingKind(
  status: PersistedPlanNodeStatus | null | undefined,
): Exclude<UnitGridBlockingKind, "reconcile"> | null {
  if (status === "dispatched") return "wait";
  if (status === "failed" || status === "cancelled") return "retry";
  if (status === "succeeded") return "review";
  return null;
}

function blockedReasonForUnitGridBlocking(
  kind: UnitGridBlockingKind,
  label?: string | null,
): string {
  if (label) return label;
  if (kind === "wait") return STUDIO_GENERATION_PLAN_UNIT_GRID_WAIT;
  if (kind === "retry") return STUDIO_GENERATION_PLAN_UNIT_GRID_RETRY;
  if (kind === "review") return STUDIO_GENERATION_PLAN_UNIT_GRID_REVIEW;
  return STUDIO_GENERATION_PLAN_UNIT_GRID_RECONCILE;
}

/**
 * unit-grid 已在途/待重试/待审/对账时，单镜或整板草稿都不得再 ready 建计划。
 * 只精炼文案；不执行、不派发、不重试。
 */
export function refineStudioGenerationPlanDraftIfUnitGridBlocking(
  draft: StudioGenerationPlanDraft,
  input: {
    code?: string | null;
    status?: PersistedPlanNodeStatus | null;
    label?: string | null;
  },
): StudioGenerationPlanDraft {
  const kind = unitGridNextActionBlockingKind(input.code)
    ?? unitGridStatusBlockingKind(input.status);
  if (!kind) return draft;
  return {
    ...draft,
    ready: false,
    dispatch: false,
    blockedReason: blockedReasonForUnitGridBlocking(kind, input.label),
    note: "unit-grid 已占用下一步。不执行、不派发、不重试。",
  };
}

/** pack envelope `next` 与草稿同一套 unit-grid 阻塞。planned 不挡。 */
export function packEnvelopeNextOverrideForUnitGridBlocking(
  status?: PersistedPlanNodeStatus | null,
): string | null {
  const kind = unitGridStatusBlockingKind(status);
  if (kind === "wait") return "wait → result or reconcile (no dispatch)";
  if (kind === "retry") return "retry_studio_generation_plan_nodes (no retry here, no dispatch)";
  if (kind === "review") return "Review (no dispatch)";
  return null;
}

/**
 * 画布节点 freeze-dispatch：unit-grid 已在途/待重试/待审/对账时不得再建议派发。
 * 只改 enabled/文案；不执行、不派发、不重试。planned / create-plan / dispatch 不挡。
 */
export function canvasFreezeDispatchOverrideForUnitGridBlocking(
  code?: string | null,
  label?: string | null,
): { enabled: false; label: string; reason: string } | null {
  const kind = unitGridNextActionBlockingKind(code);
  if (!kind) return null;
  const text = blockedReasonForUnitGridBlocking(kind, label);
  return { enabled: false, label: text, reason: text };
}

/**
 * 画布节点 freeze-dispatch：已加载 overview 六图闸未放行时不得再建议派发。
 * 未投影（undefined）不挡。只改 enabled/文案；不执行停检、不派发。
 */
export function canvasFreezeDispatchOverrideForCheckpointGate(
  newSlotDispatchAllowed?: boolean | null,
  blockingBatchNumber?: number | null,
): { enabled: false; label: string; reason: string } | null {
  if (newSlotDispatchAllowed !== false) return null;
  const text = blockingBatchNumber != null
    ? `六图闸未放行（batch ${blockingBatchNumber}），先完成停检/Review（不派发）`
    : "六图闸未放行，先完成停检/Review（不派发）";
  return { enabled: false, label: text, reason: text };
}

export const ACTIVE_RUNS_NEXT_RECONCILE = "reconcile-or-commit-existing-call-only" as const;
export const ACTIVE_RUNS_NEXT_FOLLOW_READINESS = "follow-core-readiness" as const;

export const PLAN_ENVELOPE_NEXT_WAIT = "wait → result or reconcile (no dispatch)" as const;
export const PLAN_ENVELOPE_NEXT_RETRY = "retry_studio_generation_plan_nodes (no retry here, no dispatch)" as const;
export const PLAN_ENVELOPE_NEXT_REVIEW = "Review (no dispatch)" as const;
export const PLAN_ENVELOPE_NEXT_DISPATCH = "dispatch (no dispatch here)" as const;
export const PLAN_ENVELOPE_NEXT_CREATE = "create-plan (no execute)" as const;
export const PLAN_ENVELOPE_NEXT_FOLLOW = ACTIVE_RUNS_NEXT_FOLLOW_READINESS;

export function normalizePlanNodeStatusForEnvelope(
  status: string | null | undefined,
): PersistedPlanNodeStatus | null {
  if (status === "retry-superseded") return "planned";
  if (
    status === "planned"
    || status === "dispatched"
    || status === "failed"
    || status === "cancelled"
    || status === "succeeded"
  ) {
    return status;
  }
  return null;
}

/**
 * 单计划节点聚合下一步。dispatched > failed/cancelled > planned > 全 succeeded。
 * 空节点当 create-plan。retry-superseded 映射为 planned。不执行、不派发、不重试。
 */
export function planEnvelopeNextFromNodeStatuses(
  statuses: readonly (string | null | undefined)[],
): string {
  const normalized = statuses
    .map(normalizePlanNodeStatusForEnvelope)
    .filter((status): status is PersistedPlanNodeStatus => status !== null);
  if (normalized.some((status) => status === "dispatched")) return PLAN_ENVELOPE_NEXT_WAIT;
  if (normalized.some((status) => status === "failed" || status === "cancelled")) {
    return PLAN_ENVELOPE_NEXT_RETRY;
  }
  if (normalized.some((status) => status === "planned")) return PLAN_ENVELOPE_NEXT_DISPATCH;
  if (normalized.length > 0 && normalized.every((status) => status === "succeeded")) {
    return PLAN_ENVELOPE_NEXT_REVIEW;
  }
  return PLAN_ENVELOPE_NEXT_CREATE;
}

/** 生成控制计划列表中文下一步；与信封英文 next 同一套状态优先级。 */
export function planEnvelopeNextLabel(
  statuses: readonly (string | null | undefined)[],
): string {
  const next = planEnvelopeNextFromNodeStatuses(statuses);
  if (next === PLAN_ENVELOPE_NEXT_WAIT) return "下一步：等待结果或对账（不派发）";
  if (next === PLAN_ENVELOPE_NEXT_RETRY) return "下一步：retry（不重试、不派发）";
  if (next === PLAN_ENVELOPE_NEXT_REVIEW) return "下一步：Review（不派发）";
  if (next === PLAN_ENVELOPE_NEXT_DISPATCH) return "下一步：dispatch（不派发）";
  return "下一步：create-plan（不执行、不派发）";
}

/**
 * operation=plan 信封下一步。
 * 未限定列表 / not_found → follow-core-readiness（不猜单元）。
 * 按 planId 或单元查到计划 → 节点状态聚合。
 * 按单元查无计划 → create-plan。
 * 不执行、不派发、不重试。
 */
export function planOperationEnvelopeNext(input: {
  kind: "not-found" | "unscoped-list" | "scoped";
  statuses?: readonly (string | null | undefined)[];
}): string {
  if (input.kind === "not-found" || input.kind === "unscoped-list") {
    return PLAN_ENVELOPE_NEXT_FOLLOW;
  }
  return planEnvelopeNextFromNodeStatuses(input.statuses ?? []);
}

export type HistoryEnvelopeItem = {
  pairComplete?: boolean;
  status?: string | null;
  generationRunId?: string | null;
};

/**
 * 本页 consistencyPeek 用 run：优先成对项，否则本页第一项有 run 的。
 * 不翻页、不加 inspect、不用 previousActualTail。
 */
export function historyEnvelopePeekRunId(items: readonly HistoryEnvelopeItem[]): string | null {
  const paired = items.find((item) => item.pairComplete && item.generationRunId);
  if (paired?.generationRunId) return paired.generationRunId;
  return items.find((item) => item.generationRunId)?.generationRunId ?? null;
}

/**
 * operation=history 信封下一步。只看本页 items，不翻页、不加 inspect。
 * 未成对→wait；成对 pending→Review；成对 rejected→retry；空页/全 approved→follow-core-readiness。
 * 要看最新请 newest-first。不执行、不派发、不重试、不自动 Review PASS。
 */
export function historyEnvelopeNext(items: readonly HistoryEnvelopeItem[]): string {
  if (items.length === 0) return PLAN_ENVELOPE_NEXT_FOLLOW;
  const complete = items.filter((item) => item.pairComplete);
  if (complete.length === 0) return PLAN_ENVELOPE_NEXT_WAIT;
  if (complete.some((item) => item.status === "pending")) return PLAN_ENVELOPE_NEXT_REVIEW;
  if (complete.some((item) => item.status === "rejected")) return PLAN_ENVELOPE_NEXT_RETRY;
  return PLAN_ENVELOPE_NEXT_FOLLOW;
}

/** 生成控制结果列表中文下一步；与 history 信封英文 next 同一套本页优先级。 */
export function historyEnvelopeNextLabel(items: readonly HistoryEnvelopeItem[]): string {
  const next = historyEnvelopeNext(items);
  if (next === PLAN_ENVELOPE_NEXT_WAIT) return "下一步：等待成对写回或对账（不派发）";
  if (next === PLAN_ENVELOPE_NEXT_REVIEW) return "下一步：Review（不派发）";
  if (next === PLAN_ENVELOPE_NEXT_RETRY) return "下一步：返工后 retry（不重试、不派发）";
  return "下一步：跟随 readiness（不派发）";
}

/**
 * active-runs 信封下一步。本槽 unknown / 未审 / 在途优先；单镜再看同单元 unit-grid。
 * generationBlocked 仍由调用方按本槽 blockingRuns 决定。不执行、不派发、不重试。
 */
export function activeRunsEnvelopeNext(input: {
  hasUnknownCall?: boolean;
  hasUnreviewedPair?: boolean;
  hasInFlightRun?: boolean;
  generationBlocked?: boolean;
  unitGridBlockingStatus?: PersistedPlanNodeStatus | null;
}): string {
  if (input.hasUnknownCall) return ACTIVE_RUNS_NEXT_RECONCILE;
  const unitGridNext = packEnvelopeNextOverrideForUnitGridBlocking(input.unitGridBlockingStatus);
  if (unitGridNext) return unitGridNext;
  if (input.hasUnreviewedPair) return "Review (no dispatch)";
  if (input.hasInFlightRun || input.generationBlocked) {
    return "wait → result or reconcile (no dispatch)";
  }
  return ACTIVE_RUNS_NEXT_FOLLOW_READINESS;
}

function blocked(reason: string): StudioGenerationPlanDraft {
  return {
    command: STUDIO_GENERATION_PLAN_COMMAND,
    ready: false,
    blockedReason: reason,
    nodes: null,
    dispatch: false,
    note: NOTE_BLOCKED,
  };
}

function noteForPersistedPlan(status?: PersistedPlanNodeStatus): string {
  if (status === "dispatched") return NOTE_WAIT;
  if (status === "failed" || status === "cancelled") return NOTE_RETRY;
  if (status === "succeeded") return NOTE_REVIEW;
  return NOTE_HAS_PLAN;
}

export function blockedReasonForPersistedPlan(
  kind: "panel" | "unit-grid",
  status?: PersistedPlanNodeStatus,
): string {
  const panel = kind === "panel";
  if (status === "dispatched") {
    return panel ? STUDIO_GENERATION_PLAN_IN_FLIGHT_PANEL : STUDIO_GENERATION_PLAN_IN_FLIGHT_UNIT_GRID;
  }
  if (status === "failed" || status === "cancelled") {
    return panel ? STUDIO_GENERATION_PLAN_RETRY_PANEL : STUDIO_GENERATION_PLAN_RETRY_UNIT_GRID;
  }
  if (status === "succeeded") {
    return panel ? STUDIO_GENERATION_PLAN_REVIEW_PANEL : STUDIO_GENERATION_PLAN_REVIEW_UNIT_GRID;
  }
  return panel
    ? STUDIO_GENERATION_PLAN_ALREADY_EXISTS_PANEL
    : STUDIO_GENERATION_PLAN_ALREADY_EXISTS_UNIT_GRID;
}

function alreadyPlanned(
  reason: string,
  nodes: StudioGenerationPlanDraftNode[],
  status?: PersistedPlanNodeStatus,
): StudioGenerationPlanDraft {
  return {
    command: STUDIO_GENERATION_PLAN_COMMAND,
    ready: false,
    blockedReason: reason,
    nodes,
    dispatch: false,
    note: noteForPersistedPlan(status),
  };
}

export function composeStudioGenerationPlanDraft(input: {
  focusUnitId: string | null;
  focusPanelId: string | null;
  focusPackId: string | null;
  targetKind?: "panel" | "unit-grid";
  /** 账本已有对应 plan 时不再 ready 建计划。未传 status 时下一步仍写 dispatch，本面仍不派发。 */
  hasPersistedPlan?: boolean;
  /** 有计划时按节点状态区分 dispatch / wait / retry / Review。省略则保持 dispatch 文案。 */
  persistedPlanStatus?: PersistedPlanNodeStatus;
}): StudioGenerationPlanDraft {
  if (!input.focusUnitId) {
    return blocked("没有目标单元，不能建立计划");
  }
  if (input.targetKind === "unit-grid") {
    if (!input.focusPackId) {
      return blocked("该整板尚无冻结 pack，先 Binding→readiness→freeze。禁止用单镜或同行 preview pack 冒充整板节点");
    }
    const nodes: StudioGenerationPlanDraftNode[] = [{ targetKind: "unit-grid", unitId: input.focusUnitId }];
    if (input.hasPersistedPlan) {
      return alreadyPlanned(
        blockedReasonForPersistedPlan("unit-grid", input.persistedPlanStatus),
        nodes,
        input.persistedPlanStatus,
      );
    }
    return {
      command: STUDIO_GENERATION_PLAN_COMMAND,
      ready: true,
      blockedReason: null,
      nodes,
      dispatch: false,
      note: NOTE_READY,
    };
  }
  if (!input.focusPanelId) {
    return blocked("没有目标宫格，禁止猜第一格");
  }
  if (!input.focusPackId) {
    return blocked("该宫格尚无冻结 pack，先 Binding→readiness→freeze。禁止用同行已出图宫格的 packId");
  }
  const nodes: StudioGenerationPlanDraftNode[] = [{ unitId: input.focusUnitId, panelId: input.focusPanelId }];
  if (input.hasPersistedPlan) {
    return alreadyPlanned(
      blockedReasonForPersistedPlan("panel", input.persistedPlanStatus),
      nodes,
      input.persistedPlanStatus,
    );
  }
  return {
    command: STUDIO_GENERATION_PLAN_COMMAND,
    ready: true,
    blockedReason: null,
    nodes,
    dispatch: false,
    note: NOTE_READY,
  };
}

/** SSL-5 / 历史别名。 */
export const composeSsl5GenerationPlanDraft = composeStudioGenerationPlanDraft;
