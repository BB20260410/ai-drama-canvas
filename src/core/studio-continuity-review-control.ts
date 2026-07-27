import {
  STUDIO_CONTINUITY_FIELDS,
  normalizeStudioContinuityScope,
  normalizeStudioContinuityStableId,
  studioContinuityDigest,
  studioContinuitySpansOverlap,
  type StudioContinuityBlockerCode,
  type StudioContinuityField,
  type StudioContinuityFieldState,
  type StudioContinuityScope,
} from "./studio-continuity.js";
import {
  getStudioContinuityReadiness,
  listOpenStudioContinuityConflicts,
  queryStudioContinuityTimeline,
} from "./studio-continuity-ledger.js";
import {
  getStudioGenerationReviewControl,
  listStudioGenerationReviewHistory,
  type StudioGenerationReviewControl,
  type StudioGenerationReviewProjection,
} from "./studio-generation-review.js";
import {
  getStudioGenerationCheckpointControl,
  type StudioGenerationCheckpointBatchControl,
} from "./studio-generation-checkpoint.js";
import { queryStudioGenerationFreeze } from "./studio-generation.js";
import { listStudioGenerationPanelHistory, readAnyStudioGenerationFrozenPack, readStudioGenerationResultBundle } from "./studio-generation-ledger.js";
import { getStudioCanonicalAsset, getStudioMedia, type StudioCanonicalAssetCategory } from "./material-studio.js";
import {
  evaluateStudioConsistency,
  peekStudioConsistencyCache,
  type ConsistencyAssetCategory,
  type ConsistencyEvaluationReference,
  type ConsistencyEvaluationRequest,
  type ConsistencyEvaluationResult,
} from "./studio-consistency-evaluator.js";

export const STUDIO_CONTINUITY_REVIEW_ASSET_LIMIT = 6 as const;
export const STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT = 36 as const;
export const STUDIO_CONTINUITY_REVIEW_CONFLICT_LIMIT = 36 as const;
export const STUDIO_CONTINUITY_REVIEW_HISTORY_LIMIT = 20 as const;
export const STUDIO_CONTINUITY_REVIEW_CHECKPOINT_LIMIT = 12 as const;

export interface StudioContinuityReviewControlInput {
  unitId: string;
  unitRevision: number;
  panelId: string;
  startMilliseconds: number;
  endMilliseconds: number;
  assetIds: string[];
  generationRunId?: string;
  timelineOffset?: number;
  timelineLimit?: number;
  conflictOffset?: number;
  conflictLimit?: number;
  reviewCursor?: string;
  reviewLimit?: number;
  checkpointOffset?: number;
  checkpointLimit?: number;
  /** P19：为 true 时对当前 Review 目标执行有界一致性评估（同键缓存命中化）；缺省/ false 只反映缓存命中或未评估态。 */
  evaluateConsistency?: boolean;
  /** P19：MCP 侧真取消通道（handler 透传 extra.signal；UI 不使用）。 */
  signal?: AbortSignal;
}

export interface StudioContinuityReviewPage<T> {
  offset: number;
  limit: number;
  total: number;
  items: T[];
  nextOffset?: number;
}

export interface StudioContinuityReviewTimelineItem {
  assetId: string;
  headKey: string;
  headRevision: number;
  entryId: string;
  entryKind: "observation" | "correction";
  field: StudioContinuityField;
  startMilliseconds: number;
  endMilliseconds: number;
  state: StudioContinuityFieldState;
  openConflictIds: string[];
}

export type StudioContinuityReviewFieldStatus =
  | "resolved"
  | "not-applicable"
  | "unresolved"
  | "missing"
  | "conflict";

export interface StudioContinuityReviewFieldControl {
  field: StudioContinuityField;
  status: StudioContinuityReviewFieldStatus;
  blockerCodes: StudioContinuityBlockerCode[];
  spanCount: number;
}

export interface StudioContinuityReviewAssetControl {
  assetId: string;
  assetName: string;
  category?: StudioCanonicalAssetCategory;
  ready: boolean;
  readinessFingerprint: string;
  blockers: Awaited<ReturnType<typeof getStudioContinuityReadiness>>["blockers"];
  fields: StudioContinuityReviewFieldControl[];
  timeline: StudioContinuityReviewPage<StudioContinuityReviewTimelineItem>;
}

export interface StudioContinuityReviewConflictSummary {
  conflictId: string;
  revision: number;
  subjectId: string;
  field: StudioContinuityField;
  overlapStartMilliseconds: number;
  overlapEndMilliseconds: number;
  leftEntryId: string;
  rightEntryId: string;
  fingerprint: string;
}

export interface StudioContinuityReviewCheckpointBatchSummary {
  batchNumber: number;
  status: StudioGenerationCheckpointBatchControl["status"];
  blockers: string[];
  slotCount: number;
  checkpointHeadRevision: number;
  attestationHeadRevision: number;
  liveCheckpointId?: string;
  checkpoint?: {
    checkpointId: string;
    current: boolean;
    currentStaleReasons: string[];
    eligibleForPass: boolean;
  };
  attestation?: {
    attestationId: string;
    decision: "pass" | "rework";
    current: boolean;
    currentStaleReasons: string[];
  };
}

export interface StudioContinuityReviewCheckpointControl {
  completedSlotCount: number;
  fullBatchCount: number;
  collectingSlotCount: number;
  blockingBatchNumber?: number;
  newSlotDispatchAllowed: boolean;
  blockingBatch?: StudioContinuityReviewCheckpointBatchSummary;
  batches: StudioContinuityReviewPage<StudioContinuityReviewCheckpointBatchSummary>;
  fingerprint: string;
}

export interface StudioContinuityReviewReviewControl {
  control: StudioGenerationReviewControl;
  history: {
    items: StudioGenerationReviewProjection[];
    nextCursor?: string;
    limit: number;
  };
}

export type StudioContinuityReviewGenerationReadiness =
  | {
    status: "ready";
    packId: string;
    fingerprint: string;
  }
  | {
    status: "blocked";
    code: string;
    message: string;
    detailCount: number;
  };

export type StudioContinuityReviewNextActionCode =
  | "resolve-continuity-conflict"
  | "record-continuity-state"
  | "submit-review-observation"
  | "submit-review-correction"
  | "complete-checkpoint-reviews"
  | "refresh-checkpoint"
  | "attest-checkpoint"
  | "resolve-generation-input"
  | "freeze-generation-pack"
  | "execute-codex-imagegen"
  | "execute-agent-imagegen"
  | "approved-raw-ready";

export interface StudioContinuityReviewNextAction {
  code: StudioContinuityReviewNextActionCode;
  label: string;
  reason: string;
  requiresWrite: boolean;
  command?:
    | "append_studio_continuity_observation"
    | "append_studio_continuity_correction"
    | "submit_studio_generation_review"
    | "refresh_studio_generation_checkpoint"
    | "attest_studio_generation_checkpoint"
    | "freeze_studio_generation_pack"
    | "dispatch_studio_generation_pack"
    | "register_studio_generation_result";
  assetId?: string;
  field?: StudioContinuityField;
  conflictId?: string;
  batchNumber?: number;
  generationRunId?: string;
}

export interface StudioContinuityReviewConsistencyControl {
  status: "not-evaluated" | "evaluated" | "unavailable";
  reason?: string;
  evaluation?: ConsistencyEvaluationResult;
}

export interface StudioContinuityReviewControl {
  schemaVersion: 1;
  kind: "studio-continuity-review-control";
  scope: StudioContinuityScope;
  assetIds: string[];
  assets: StudioContinuityReviewAssetControl[];
  conflicts: StudioContinuityReviewPage<StudioContinuityReviewConflictSummary>;
  review?: StudioContinuityReviewReviewControl;
  generation: StudioContinuityReviewGenerationReadiness;
  checkpoint: StudioContinuityReviewCheckpointControl;
  nextAction: StudioContinuityReviewNextAction;
  /** 显式传入或从宫格结果账本自动解析的 generation run。 */
  resolvedGenerationRunId?: string;
  /** P19 一致性辅助判定：可选段，不进入 semantic/fingerprint；无 generation run 时缺省。 */
  consistency?: StudioContinuityReviewConsistencyControl;
  fingerprint: string;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} 必须是 ${minimum}-${maximum} 的整数。`);
  }
  return normalized;
}

function normalizedCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096) throw new Error("reviewCursor 必须是 1-4096 个字符。");
  return normalized;
}

function normalizedAssetIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > STUDIO_CONTINUITY_REVIEW_ASSET_LIMIT) {
    throw new Error(`assetIds 最多 ${STUDIO_CONTINUITY_REVIEW_ASSET_LIMIT} 项。`);
  }
  const normalized = values.map((value) => normalizeStudioContinuityStableId(value, "assetId"));
  if (new Set(normalized).size !== normalized.length) throw new Error("assetIds 不能重复。");
  return normalized;
}

export function paginateStudioContinuityReviewItems<T>(
  items: readonly T[],
  offset: number,
  limit: number,
  maximum: number,
): StudioContinuityReviewPage<T> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("maximum 必须是正整数。");
  const safeOffset = boundedInteger(offset, 0, "offset", 0, Number.MAX_SAFE_INTEGER);
  const safeLimit = boundedInteger(limit, Math.min(maximum, 1), "limit", 1, maximum);
  const pageItems = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + pageItems.length < items.length
    ? safeOffset + pageItems.length
    : undefined;
  return {
    offset: safeOffset,
    limit: safeLimit,
    total: items.length,
    items: [...pageItems],
    ...(nextOffset === undefined ? {} : { nextOffset }),
  };
}

function fieldStatus(
  field: StudioContinuityField,
  blockers: Awaited<ReturnType<typeof getStudioContinuityReadiness>>["blockers"],
  timelineItems: StudioContinuityReviewTimelineItem[],
): StudioContinuityReviewFieldControl {
  const fieldBlockers = blockers.filter((blocker) => blocker.field === field);
  const blockerCodes = [...new Set(fieldBlockers.map((blocker) => blocker.code))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const fieldItems = timelineItems.filter((item) => item.field === field);
  let status: StudioContinuityReviewFieldStatus;
  if (blockerCodes.some((code) => code === "required-state-conflict" || code === "undetected-overlap-conflict")) {
    status = "conflict";
  } else if (blockerCodes.some((code) => code === "required-state-missing" || code === "required-state-gap")) {
    status = "missing";
  } else if (blockerCodes.includes("required-state-unresolved")) {
    status = "unresolved";
  } else if (fieldItems.length > 0 && fieldItems.every((item) => item.state.status === "not-applicable")) {
    status = "not-applicable";
  } else if (fieldItems.some((item) => item.state.status === "resolved")) {
    status = "resolved";
  } else {
    status = "unresolved";
  }
  return { field, status, blockerCodes, spanCount: fieldItems.length };
}

function checkpointBatchSummary(
  batch: StudioGenerationCheckpointBatchControl,
): StudioContinuityReviewCheckpointBatchSummary {
  return {
    batchNumber: batch.batchNumber,
    status: batch.status,
    blockers: [...batch.blockers],
    slotCount: batch.slotOrdinals.length,
    checkpointHeadRevision: batch.checkpointHeadRevision,
    attestationHeadRevision: batch.attestationHeadRevision,
    ...(batch.liveCheckpoint ? { liveCheckpointId: batch.liveCheckpoint.checkpointId } : {}),
    ...(batch.checkpoint ? {
      checkpoint: {
        checkpointId: batch.checkpoint.checkpointId,
        current: batch.checkpoint.current,
        currentStaleReasons: [...batch.checkpoint.currentStaleReasons],
        eligibleForPass: batch.checkpoint.eligibleForPass,
      },
    } : {}),
    ...(batch.attestation ? {
      attestation: {
        attestationId: batch.attestation.attestationId,
        decision: batch.attestation.decision,
        current: batch.attestation.current,
        currentStaleReasons: [...batch.attestation.currentStaleReasons],
      },
    } : {}),
  };
}

function deriveNextAction(input: {
  assets: StudioContinuityReviewAssetControl[];
  conflicts: StudioContinuityReviewConflictSummary[];
  review?: StudioContinuityReviewReviewControl;
  generation: StudioContinuityReviewGenerationReadiness;
  checkpoint: StudioContinuityReviewCheckpointControl;
  resolvedGenerationRunId?: string;
}): StudioContinuityReviewNextAction {
  const conflict = input.conflicts[0];
  if (conflict) {
    const subjectName = input.assets.find((asset) => asset.assetId === conflict.subjectId)?.assetName ?? "锁定资产";
    return {
      code: "resolve-continuity-conflict",
      label: "修正连续性冲突",
      reason: `${subjectName}的连续性在 ${conflict.overlapStartMilliseconds / 1000}-${conflict.overlapEndMilliseconds / 1000} 秒存在未解决冲突。`,
      requiresWrite: true,
      command: "append_studio_continuity_correction",
      assetId: conflict.subjectId,
      field: conflict.field,
      conflictId: conflict.conflictId,
    };
  }
  const blockedAsset = input.assets.find((asset) => !asset.ready);
  const blocker = blockedAsset?.blockers[0];
  if (blockedAsset && blocker) {
    return {
      code: "record-continuity-state",
      label: "补齐连续性状态",
      reason: `${blockedAsset.assetName}：${blocker.message.replaceAll(blockedAsset.assetId, blockedAsset.assetName)}`,
      requiresWrite: true,
      command: "append_studio_continuity_observation",
      assetId: blockedAsset.assetId,
      field: blocker.field,
    };
  }
  const review = input.review?.control;
  if (review?.nextAction === "submit-observation") {
    return {
      code: "submit-review-observation",
      label: "提交首次画面 Review",
      reason: "当前 generation run 尚无 Review Head。",
      requiresWrite: true,
      command: "submit_studio_generation_review",
    };
  }
  if (review?.nextAction === "submit-correction") {
    return {
      code: "submit-review-correction",
      label: "追加 Review 修正",
      reason: review.blockers.join("；") || "当前 Review 需要显式 correction。",
      requiresWrite: true,
      command: "submit_studio_generation_review",
    };
  }
  const blocking = input.checkpoint.blockingBatch;
  if (blocking?.status === "review-blocked") {
    return {
      code: "complete-checkpoint-reviews",
      label: `补齐第 ${blocking.batchNumber} 批六图 Review`,
      reason: blocking.blockers.join("；") || "六图批次成员尚未全部通过当前 Review。",
      requiresWrite: true,
      command: "submit_studio_generation_review",
      batchNumber: blocking.batchNumber,
    };
  }
  if (blocking?.status === "refresh-required") {
    return {
      code: "refresh-checkpoint",
      label: `刷新第 ${blocking.batchNumber} 批六图快照`,
      reason: blocking.blockers.join("；") || "六图内容地址快照尚未建立或已陈旧。",
      requiresWrite: true,
      command: "refresh_studio_generation_checkpoint",
      batchNumber: blocking.batchNumber,
    };
  }
  if (blocking?.status === "attestation-required") {
    return {
      code: "attest-checkpoint",
      label: `验收第 ${blocking.batchNumber} 批六图`,
      reason: blocking.blockers.join("；") || "六图快照尚未获得当前 pass attestation。",
      requiresWrite: true,
      command: "attest_studio_generation_checkpoint",
      batchNumber: blocking.batchNumber,
    };
  }
  if (review?.nextAction === "approved-raw-ready") {
    return {
      code: "approved-raw-ready",
      label: "已验收 raw 可作为连续性参考",
      reason: "当前 Review 与冻结输入一致，approved raw 可被后续宫格显式引用。",
      requiresWrite: false,
      ...(input.resolvedGenerationRunId ? { generationRunId: input.resolvedGenerationRunId } : {}),
    };
  }
  if (input.generation.status === "blocked") {
    return {
      code: "resolve-generation-input",
      label: "修复生成输入闭包",
      reason: input.generation.message,
      requiresWrite: true,
    };
  }
  // 冻结输入已可构建：下一步是 Agent（Codex 或 Grok）执行并登记，而不是重复提示“再冻一次”。
  if (input.generation.status === "ready") {
    return {
      code: "execute-agent-imagegen",
      label: "用冻结包执行 Codex 或 Grok 生图并登记结果",
      reason: "九字段与 BindingSet 已就绪；任选 Codex/Grok Agent 消费冻结包，dispatch 时声明 provider，再 register raw/labeled。",
      requiresWrite: true,
      command: "dispatch_studio_generation_pack",
      ...(input.resolvedGenerationRunId ? { generationRunId: input.resolvedGenerationRunId } : {}),
    };
  }
  return {
    code: "freeze-generation-pack",
    label: "冻结当前宫格生成包",
    reason: "九字段连续性已就绪，且不存在未通过的六图停检。",
    requiresWrite: true,
    command: "freeze_studio_generation_pack",
  };
}

/**
 * 宫格历史中取最新 generation run：优先 raw+labeled 成对，其次任意最新结果。
 * Dashboard 常不传 generationRunId，必须能从账本自解析，否则 Review 后 nextAction 会卡在冻结包。
 */
export async function resolveLatestStudioGenerationRunForPanel(
  projectRoot: string,
  unitId: string,
  panelId: string,
): Promise<string | undefined> {
  const history = await listStudioGenerationPanelHistory(projectRoot, {
    unitId,
    panelId,
    limit: 100,
  });
  if (history.items.length === 0) return undefined;
  const byRun = new Map<string, { maxSequence: number; variants: Set<string> }>();
  for (const item of history.items) {
    const current = byRun.get(item.generationRunId) ?? {
      maxSequence: Number.NEGATIVE_INFINITY,
      variants: new Set<string>(),
    };
    current.maxSequence = Math.max(current.maxSequence, item.sequence);
    current.variants.add(item.variant);
    byRun.set(item.generationRunId, current);
  }
  const ranked = [...byRun.entries()].sort((left, right) => {
    const leftPair = left[1].variants.has("raw") && left[1].variants.has("labeled") ? 1 : 0;
    const rightPair = right[1].variants.has("raw") && right[1].variants.has("labeled") ? 1 : 0;
    if (leftPair !== rightPair) return rightPair - leftPair;
    return right[1].maxSequence - left[1].maxSequence;
  });
  return ranked[0]?.[0];
}

/**
 * P19：为当前 Review 目标 run 构建评估请求（读取结果对账本/冻结包/规范资产/媒体 CAS，全部只读）。
 * 返回 { request } 或 { reason }；不写任何事实。
 * P30：unit-grid 整板必须经 target-aware 入口读取，参考闭包覆盖全板逐格 panel pack，
 * 禁止回退到首格或旧 panel 读取路径冒充整板身份。
 */
async function buildStudioConsistencyEvaluationRequest(
  projectRoot: string,
  generationRunId: string,
): Promise<{ request: ConsistencyEvaluationRequest } | { reason: string }> {
  const bundle = await readStudioGenerationResultBundle(projectRoot, generationRunId);
  if (!bundle) return { reason: "result-pair-missing" };
  const pack = await readAnyStudioGenerationFrozenPack(projectRoot, bundle.packId);
  if (!pack) return { reason: "pack-missing" };
  const rawMedia = await getStudioMedia(projectRoot, bundle.raw.mediaSha256);
  if (!rawMedia) return { reason: "result-media-missing" };
  const packAssets = (pack.schemaVersion === 5
    ? pack.panels.flatMap((panel) => panel.panelPack.assets)
    : pack.assets
  ).filter((asset, index, all) => all.findIndex((candidate) => (
    candidate.assetId === asset.assetId && candidate.version.id === asset.version.id
  )) === index);
  const references: ConsistencyEvaluationReference[] = await Promise.all(
    packAssets.map(async (asset) => {
      const canonical = await getStudioCanonicalAsset(projectRoot, asset.assetId).catch(() => null);
      // 动物资产经 category=character 走人物权重路径；style 使用独立色调/边缘权重。
      // 动物资产经 category=character 走人物权重路径（有回归断言）；isAnimal 字段保留给显式声明的 API 调用方。
      return {
        assetId: asset.assetId,
        category: asset.category as ConsistencyAssetCategory,
        assetVersionId: asset.version.id,
        ...(canonical?.primaryAuthority ? { currentPrimaryAuthorityVersionId: canonical.primaryAuthority.versionId } : {}),
        mediaSha256: asset.media.sha256,
        objectPath: asset.media.objectPath,
        structuralChecklist: [...asset.definition.positiveLocks, ...asset.definition.negativeLocks.map((lock) => `禁止：${lock}`)],
      };
    }),
  );
  return {
    request: {
      projectRoot,
      projectId: pack.projectId,
      generationRunId,
      packFingerprint: bundle.packFingerprint,
      result: { sha256: bundle.raw.mediaSha256, objectPath: rawMedia.objectPath },
      references,
    },
  };
}

/**
 * P19：对当前 Review 目标 run 执行有界一致性评估。
 * 输入全部来自既有只读 Owner（结果对账本/冻结包/规范资产/媒体 CAS）；本函数不写任何事实。
 */
export async function evaluateStudioReviewTargetConsistency(
  projectRoot: string,
  input: { generationRunId: string; signal?: AbortSignal },
): Promise<StudioContinuityReviewConsistencyControl> {
  const built = await buildStudioConsistencyEvaluationRequest(projectRoot, input.generationRunId);
  if ("reason" in built) return { status: "unavailable", reason: built.reason };
  const evaluation = await evaluateStudioConsistency({
    ...built.request,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { status: "evaluated", evaluation };
}

export async function getStudioContinuityReviewControl(
  projectRoot: string,
  rawInput: StudioContinuityReviewControlInput,
): Promise<StudioContinuityReviewControl> {
  const scope = normalizeStudioContinuityScope({
    kind: "panel",
    scopeId: rawInput.panelId,
    unitId: rawInput.unitId,
    unitRevision: rawInput.unitRevision,
    startMilliseconds: rawInput.startMilliseconds,
    endMilliseconds: rawInput.endMilliseconds,
  });
  const assetIds = normalizedAssetIds(rawInput.assetIds);
  const explicitGenerationRunId = rawInput.generationRunId === undefined
    ? undefined
    : normalizeStudioContinuityStableId(rawInput.generationRunId, "generationRunId");
  const generationRunId = explicitGenerationRunId
    ?? await resolveLatestStudioGenerationRunForPanel(projectRoot, scope.unitId, scope.scopeId);
  const timelineOffset = boundedInteger(rawInput.timelineOffset, 0, "timelineOffset", 0, Number.MAX_SAFE_INTEGER);
  const timelineLimit = boundedInteger(
    rawInput.timelineLimit,
    STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT,
    "timelineLimit",
    1,
    STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT,
  );
  const conflictOffset = boundedInteger(rawInput.conflictOffset, 0, "conflictOffset", 0, Number.MAX_SAFE_INTEGER);
  const conflictLimit = boundedInteger(
    rawInput.conflictLimit,
    STUDIO_CONTINUITY_REVIEW_CONFLICT_LIMIT,
    "conflictLimit",
    1,
    STUDIO_CONTINUITY_REVIEW_CONFLICT_LIMIT,
  );
  const reviewLimit = boundedInteger(
    rawInput.reviewLimit,
    STUDIO_CONTINUITY_REVIEW_HISTORY_LIMIT,
    "reviewLimit",
    1,
    STUDIO_CONTINUITY_REVIEW_HISTORY_LIMIT,
  );
  const checkpointOffset = boundedInteger(rawInput.checkpointOffset, 0, "checkpointOffset", 0, Number.MAX_SAFE_INTEGER);
  const checkpointLimit = boundedInteger(
    rawInput.checkpointLimit,
    STUDIO_CONTINUITY_REVIEW_CHECKPOINT_LIMIT,
    "checkpointLimit",
    1,
    STUDIO_CONTINUITY_REVIEW_CHECKPOINT_LIMIT,
  );
  const reviewCursor = normalizedCursor(rawInput.reviewCursor);

  const [assetControls, openConflicts, checkpointSource, reviewControl, reviewHistory, generationSource] = await Promise.all([
    Promise.all(assetIds.map(async (assetId): Promise<StudioContinuityReviewAssetControl> => {
      const [readiness, timeline, asset] = await Promise.all([
        getStudioContinuityReadiness(projectRoot, {
          scope,
          subjectId: assetId,
          requiredFields: [...STUDIO_CONTINUITY_FIELDS],
        }),
        queryStudioContinuityTimeline(projectRoot, {
          scopeAnchor: scope,
          subjectId: assetId,
        }),
        getStudioCanonicalAsset(projectRoot, assetId),
      ]);
      const relevantItems = timeline.items
        .filter((item) => studioContinuitySpansOverlap(item.entry.scope, scope))
        .map((item): StudioContinuityReviewTimelineItem => ({
          assetId,
          headKey: item.headKey,
          headRevision: item.headRevision,
          entryId: item.entry.id,
          entryKind: item.entry.entryKind,
          field: item.entry.field,
          startMilliseconds: item.entry.scope.startMilliseconds,
          endMilliseconds: item.entry.scope.endMilliseconds,
          state: item.entry.state,
          openConflictIds: [...item.openConflictIds],
        }));
      return {
        assetId,
        assetName: asset?.name ?? assetId,
        ...(asset?.category ? { category: asset.category } : {}),
        ready: readiness.ready,
        readinessFingerprint: readiness.fingerprint,
        blockers: readiness.blockers,
        fields: STUDIO_CONTINUITY_FIELDS.map((field) => fieldStatus(field, readiness.blockers, relevantItems)),
        timeline: paginateStudioContinuityReviewItems(
          relevantItems,
          timelineOffset,
          timelineLimit,
          STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT,
        ),
      };
    })),
    listOpenStudioContinuityConflicts(projectRoot, { scope }),
    getStudioGenerationCheckpointControl(projectRoot),
    generationRunId ? getStudioGenerationReviewControl(projectRoot, generationRunId) : Promise.resolve(undefined),
    generationRunId
      ? listStudioGenerationReviewHistory(projectRoot, {
        generationRunId,
        ...(reviewCursor ? { cursor: reviewCursor } : {}),
        limit: reviewLimit,
      })
      : Promise.resolve(undefined),
    queryStudioGenerationFreeze(projectRoot, {
      unitId: scope.unitId,
      panelId: scope.scopeId,
    }),
  ]);

  const conflictSummaries = openConflicts.map((conflict): StudioContinuityReviewConflictSummary => ({
    conflictId: conflict.id,
    revision: conflict.revision,
    subjectId: conflict.subjectId,
    field: conflict.field,
    overlapStartMilliseconds: conflict.overlapStartMilliseconds,
    overlapEndMilliseconds: conflict.overlapEndMilliseconds,
    leftEntryId: conflict.leftEntry.id,
    rightEntryId: conflict.rightEntry.id,
    fingerprint: conflict.fingerprint,
  }));
  const batchSummaries = checkpointSource.batches.map(checkpointBatchSummary);
  const blockingBatch = checkpointSource.blockingBatchNumber === undefined
    ? undefined
    : batchSummaries.find((batch) => batch.batchNumber === checkpointSource.blockingBatchNumber);
  const checkpoint: StudioContinuityReviewCheckpointControl = {
    completedSlotCount: checkpointSource.completedSlotCount,
    fullBatchCount: checkpointSource.fullBatchCount,
    collectingSlotCount: checkpointSource.collectingSlotCount,
    ...(checkpointSource.blockingBatchNumber === undefined ? {} : {
      blockingBatchNumber: checkpointSource.blockingBatchNumber,
    }),
    newSlotDispatchAllowed: checkpointSource.newSlotDispatchAllowed,
    ...(blockingBatch ? { blockingBatch } : {}),
    batches: paginateStudioContinuityReviewItems(
      batchSummaries,
      checkpointOffset,
      checkpointLimit,
      STUDIO_CONTINUITY_REVIEW_CHECKPOINT_LIMIT,
    ),
    fingerprint: checkpointSource.fingerprint,
  };
  const review = reviewControl && reviewHistory
    ? {
      control: reviewControl,
      history: {
        items: reviewHistory.items,
        ...(reviewHistory.nextCursor ? { nextCursor: reviewHistory.nextCursor } : {}),
        limit: reviewLimit,
      },
    }
    : undefined;
  const generation: StudioContinuityReviewGenerationReadiness = generationSource.status === "ready"
    ? {
      status: "ready",
      packId: generationSource.packId,
      fingerprint: generationSource.fingerprint,
    }
    : {
      status: "blocked",
      code: generationSource.code,
      message: generationSource.message,
      detailCount: generationSource.details.length,
    };
  const conflicts = paginateStudioContinuityReviewItems(
    conflictSummaries,
    conflictOffset,
    conflictLimit,
    STUDIO_CONTINUITY_REVIEW_CONFLICT_LIMIT,
  );
  const nextAction = deriveNextAction({
    assets: assetControls,
    conflicts: conflictSummaries,
    ...(review ? { review } : {}),
    generation,
    checkpoint,
    ...(generationRunId ? { resolvedGenerationRunId: generationRunId } : {}),
  });
  // P19：consistency 段不进入 semantic/fingerprint；默认只反映评估缓存命中或未评估态（不触发像素计算），
  // 显式 evaluateConsistency 才执行有界评估；signal 为 MCP 侧真取消通道（盲审 R1-F2/R1-F3）。
  const consistency: StudioContinuityReviewConsistencyControl | undefined = generationRunId
    ? rawInput.evaluateConsistency === true
      ? await evaluateStudioReviewTargetConsistency(projectRoot, {
        generationRunId,
        ...(rawInput.signal ? { signal: rawInput.signal } : {}),
      })
      : await (async (): Promise<StudioContinuityReviewConsistencyControl> => {
        const built = await buildStudioConsistencyEvaluationRequest(projectRoot, generationRunId);
        if ("reason" in built) return { status: "unavailable", reason: built.reason };
        const cached = await peekStudioConsistencyCache(built.request);
        return cached ? { status: "evaluated", evaluation: cached } : { status: "not-evaluated" };
      })()
    : undefined;
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-continuity-review-control" as const,
    scope,
    assetIds,
    assets: assetControls,
    conflicts,
    ...(review ? { review } : {}),
    generation,
    checkpoint,
    nextAction,
    ...(generationRunId ? { resolvedGenerationRunId: generationRunId } : {}),
  };
  return { ...semantic, ...(consistency ? { consistency } : {}), fingerprint: studioContinuityDigest(semantic) };
}
