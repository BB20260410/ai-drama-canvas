import type {
  StudioContinuityReviewControl,
  StudioContinuityReviewControlInput,
} from "../../core/studio-continuity-review-control.js";
import type { StudioContinuityField, StudioContinuityScopeInput } from "../../core/studio-continuity.js";
import type { SubmitStudioGenerationReviewInput, StudioGenerationReviewProjection } from "../../core/studio-generation-review.js";

/**
 * 桌面端只提交公开 Review 载荷；幂等 operationId 由 command bus 按请求哈希生成。
 * 若把 Core 内部字段暴露给 UI，公开写面会按失败关闭合同拒绝整条命令。
 */
export type StudioGenerationReviewUiInput = Omit<SubmitStudioGenerationReviewInput, "operationId">;

/**
 * 只暴露“人工确认的可见事实”这一最小写面。
 * state/provenance 由桌面层限定，避免 UI 把内部 locator、伪造来源或账本字段写回连续性账本。
 */
export interface StudioContinuityCorrectionUiInput {
  expectedHeadRevision: number;
  scope: StudioContinuityScopeInput;
  subjectId: string;
  field: Exclude<StudioContinuityField, "referenceSha256">;
  supersedesEntryId: string;
  state:
    | { status: "resolved"; value: string }
    | { status: "not-applicable"; reason: string };
}

export const STUDIO_CONTINUITY_REVIEW_UI_ASSET_LIMIT = 6 as const;
export const STUDIO_CONTINUITY_REVIEW_UI_TIMELINE_LIMIT = 18 as const;
export const STUDIO_CONTINUITY_REVIEW_UI_CONFLICT_LIMIT = 18 as const;
export const STUDIO_CONTINUITY_REVIEW_UI_HISTORY_LIMIT = 12 as const;
export const STUDIO_CONTINUITY_REVIEW_UI_CHECKPOINT_LIMIT = 6 as const;

export interface StudioContinuityReviewUiApi {
  getControl(
    projectRoot: string,
    input: StudioContinuityReviewControlInput,
  ): Promise<StudioContinuityReviewControl>;
  getMedia?(projectRoot: string, sha256: string): Promise<{ mediaUrl: string; thumbnail?: { url: string } } | null>;
  getReviewIdentity?(projectRoot: string, packId: string): Promise<{ packId: string; packFingerprint: string; continuityFingerprint: string }>;
  submitReview?(projectRoot: string, input: StudioGenerationReviewUiInput): Promise<StudioGenerationReviewProjection>;
  appendContinuityCorrection?(projectRoot: string, input: StudioContinuityCorrectionUiInput): Promise<void>;
}

export interface StudioContinuityReviewQueryDraft {
  unitId: string;
  unitRevision: string;
  panelId: string;
  startMilliseconds: string;
  endMilliseconds: string;
  assetIds: string;
  generationRunId: string;
}

/** 画布 / 驾驶舱传入的业务定位；正常审片不再要求用户手填技术 ID。 */
export interface StudioContinuityReviewFocus {
  token: number;
  unitId: string;
  unitRevision: number;
  panelId: string;
  startMilliseconds: number;
  endMilliseconds: number;
  assetIds: string[];
  generationRunId?: string;
  rawResultId?: string;
  rawSha256?: string;
  labeledResultId?: string;
  labeledSha256?: string;
  packId?: string;
  /** 驾驶舱读取旧的已停检画面时只允许人工观察；常规受管审片省略此值，默认可写。 */
  reviewWriteAllowed?: boolean;
  evidenceSource?: "checkpoint-attested" | "historical-import";
  /** 审片对象身份；panelId 仍只表示连续性辅助查询范围。 */
  generationTarget?:
    | { targetKind: "panel"; targetKey: string; panelId: string }
    | { targetKind: "unit-grid"; targetKey: string };
}

export interface StudioContinuityReviewLoadToken {
  revision: number;
  projectRoot: string;
}

export interface StudioContinuityReviewLoadState {
  revision: number;
  projectRoot: string;
  loading: boolean;
  control: StudioContinuityReviewControl | null;
  error: string;
}

function integer(value: string, label: string, minimum: number, maximum: number): number {
  const normalized = Number(value.trim());
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} 必须是 ${minimum}-${maximum} 的整数。`);
  }
  return normalized;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空。`);
  return normalized;
}

export function parseStudioContinuityReviewAssetIds(value: string): string[] {
  const ids = value.split(/[\s,，、]+/u).map((entry) => entry.trim()).filter(Boolean);
  if (ids.length > STUDIO_CONTINUITY_REVIEW_UI_ASSET_LIMIT) {
    throw new Error(`每格最多查询 ${STUDIO_CONTINUITY_REVIEW_UI_ASSET_LIMIT} 项资产。`);
  }
  if (new Set(ids).size !== ids.length) throw new Error("资产 ID 不能重复。");
  return ids;
}

export function buildStudioContinuityReviewQuery(
  draft: StudioContinuityReviewQueryDraft,
  page: Partial<Pick<StudioContinuityReviewControlInput,
    "timelineOffset" | "conflictOffset" | "reviewCursor" | "checkpointOffset">> = {},
): StudioContinuityReviewControlInput {
  const startMilliseconds = integer(draft.startMilliseconds, "开始毫秒", 0, 14_999);
  const endMilliseconds = integer(draft.endMilliseconds, "结束毫秒", 1, 15_000);
  if (endMilliseconds <= startMilliseconds) throw new Error("结束毫秒必须大于开始毫秒。");
  const generationRunId = draft.generationRunId.trim();
  return {
    unitId: requiredText(draft.unitId, "unitId"),
    unitRevision: integer(draft.unitRevision, "unitRevision", 1, Number.MAX_SAFE_INTEGER),
    panelId: requiredText(draft.panelId, "panelId"),
    startMilliseconds,
    endMilliseconds,
    assetIds: parseStudioContinuityReviewAssetIds(draft.assetIds),
    ...(generationRunId ? { generationRunId } : {}),
    timelineOffset: page.timelineOffset ?? 0,
    timelineLimit: STUDIO_CONTINUITY_REVIEW_UI_TIMELINE_LIMIT,
    conflictOffset: page.conflictOffset ?? 0,
    conflictLimit: STUDIO_CONTINUITY_REVIEW_UI_CONFLICT_LIMIT,
    ...(page.reviewCursor ? { reviewCursor: page.reviewCursor } : {}),
    reviewLimit: STUDIO_CONTINUITY_REVIEW_UI_HISTORY_LIMIT,
    checkpointOffset: page.checkpointOffset ?? 0,
    checkpointLimit: STUDIO_CONTINUITY_REVIEW_UI_CHECKPOINT_LIMIT,
    // P19：审片加载即请求有界一致性评估；同键命中评估缓存即时返回。
    evaluateConsistency: true,
  };
}

export function createStudioContinuityReviewLoadState(): StudioContinuityReviewLoadState {
  return { revision: 0, projectRoot: "", loading: false, control: null, error: "" };
}

export function beginStudioContinuityReviewLoad(
  state: StudioContinuityReviewLoadState,
  projectRoot: string,
): StudioContinuityReviewLoadToken {
  state.revision += 1;
  state.projectRoot = projectRoot;
  state.loading = true;
  state.error = "";
  return { revision: state.revision, projectRoot };
}

function tokenCurrent(
  state: StudioContinuityReviewLoadState,
  token: StudioContinuityReviewLoadToken,
): boolean {
  return state.revision === token.revision && state.projectRoot === token.projectRoot;
}

export function commitStudioContinuityReviewLoad(
  state: StudioContinuityReviewLoadState,
  token: StudioContinuityReviewLoadToken,
  control: StudioContinuityReviewControl,
): boolean {
  if (!tokenCurrent(state, token)) return false;
  state.control = control;
  state.loading = false;
  state.error = "";
  return true;
}

export function failStudioContinuityReviewLoad(
  state: StudioContinuityReviewLoadState,
  token: StudioContinuityReviewLoadToken,
  reason: unknown,
): boolean {
  if (!tokenCurrent(state, token)) return false;
  state.loading = false;
  state.error = reason instanceof Error ? reason.message : String(reason);
  return true;
}

export function invalidateStudioContinuityReviewLoad(
  state: StudioContinuityReviewLoadState,
  projectRoot = "",
): void {
  state.revision += 1;
  state.projectRoot = projectRoot;
  state.loading = false;
  state.control = null;
  state.error = "";
}
