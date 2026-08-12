/**
 * P8 无限画布生产驾驶舱：单一只读聚合投影。
 * 复用 P5–P7 owner，不建立 Dashboard DB/JSON，不恢复 Scanner。
 */
import { inspectManagedProject, inspectManagedProjectReadOnly } from "./managed-project.js";
import { digestStudioCanonicalJson as digest } from "./studio-canonical-json.js";
import {
  getMaterialStudioState,
  getStudioCanonicalAsset,
  listStudioCanonicalAssets,
  type StudioCanonicalAssetCategory,
  type StudioCanonicalAssetSummary,
} from "./material-studio.js";
import {
  getStudioBindingControl,
  listStudioBindingUnits,
  type StudioBindingPanelControl,
  type StudioBindingTimelineStatus,
  type StudioBindingUnitSummary,
} from "./studio-binding-control.js";
import {
  getStudioContinuityReviewControl,
  type StudioContinuityReviewControl,
  type StudioContinuityReviewNextAction,
} from "./studio-continuity-review-control.js";
import {
  listOpenStudioContinuityConflictPage,
  listOpenStudioContinuityConflicts,
  readStudioContinuityEntry,
} from "./studio-continuity-ledger.js";
import {
  getStudioGenerationCheckpointDashboardGate,
  getStudioGenerationCheckpointControl,
  type StudioGenerationCheckpointDashboardGate,
} from "./studio-generation-checkpoint.js";
import {
  listStudioGenerationLatestUnitGridRuns,
} from "./studio-generation-ledger.js";
import { queryStudioUnitGridGenerationFreeze } from "./studio-unit-grid-generation.js";
import {
  projectStudioUnitGridNextAction,
  type StudioUnitGridNextActionProjection,
} from "./studio-unit-grid-next-action.js";
import {
  getStudioProductionScopeFacets,
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
  getStudioUnitBindingHeadSummaries,
  listStudioProductionUnits,
  queryStudioAssetTimeline,
  type StudioAssetTimelineItem,
  type StudioProductionUnitSummary,
} from "./studio-production.js";
import { withStudioRequestSchemaCache } from "./studio-request-schema-cache.js";
import {
  measureStudioUnitsReadPhase,
  measureStudioUnitsReadSyncPhase,
  recordStudioUnitsReadCounter,
} from "./studio-units-read-phase-timeline.js";

export const STUDIO_DASHBOARD_SCHEMA_VERSION = 1 as const;
export const STUDIO_DASHBOARD_UNIT_PAGE_LIMIT = 36 as const;
export const STUDIO_DASHBOARD_PANEL_LIMIT = 6 as const;
export const STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT = 6 as const;
export const STUDIO_DASHBOARD_ASSET_PAGE_LIMIT = 36 as const;
export const STUDIO_DASHBOARD_APPEARANCE_PAGE_LIMIT = 36 as const;
export const STUDIO_DASHBOARD_QUEUE_PAGE_LIMIT = 36 as const;
/** 扫描有界队列时最多翻页的单元页数，避免无界全载。 */
export const STUDIO_DASHBOARD_QUEUE_SCAN_MAX_PAGES = 40 as const;
/**
 * 生产驾驶舱是只读辅助面，不能因 generation ledger 的历史数据或 WAL 竞态
 * 永久卡住角色、场景和 BindingSet 的读取。超时后保守降级为“不可派发”，
 * 但继续返回可审计的引用链。
 */
export const STUDIO_DASHBOARD_GENERATION_READ_TIMEOUT_MS = 2_000 as const;

export type StudioDashboardQueueKind =
  | "ambiguity"
  | "missing"
  | "stale"
  | "conflict"
  | "rework";

export type StudioDashboardCurrentness =
  | "current"
  | "stale"
  | "missing"
  | "blocked"
  | "not-applicable";

export type StudioProductionDashboardQuery =
  | { operation: "overview" }
  | {
    operation: "units";
    season?: string;
    episode?: string;
    /**
     * 禁止在分页 units 上做 status 内存过滤（会破坏 opaque cursor）。
     * 歧义/缺失/过期等请用 operation=queue。
     */
    cursor?: string;
    limit?: number;
  }
  | { operation: "unit"; unitId: string; panelId?: string }
  | {
    operation: "assets";
    /** 自由画布恢复固定素材时使用；最多六项，走精确主键读取，不扫描素材库。 */
    assetIds?: string[];
    category?: StudioCanonicalAssetCategory;
    search?: string;
    cursor?: string;
    limit?: number;
  }
  | { operation: "appearances"; assetId: string; cursor?: string; limit?: number }
  | {
    operation: "queue";
    queue: StudioDashboardQueueKind;
    cursor?: string;
    limit?: number;
  };

export interface StudioDashboardLocator {
  kind: "project" | "unit" | "panel" | "asset" | "queue-item";
  projectId: string;
  unitId?: string;
  panelId?: string;
  assetId?: string;
  queue?: StudioDashboardQueueKind;
  itemId?: string;
}

export interface StudioDashboardNextAction {
  code: string;
  label: string;
  reason: string;
  requiresWrite: boolean;
  command?: string;
  locator?: StudioDashboardLocator;
}

export interface StudioDashboardPage<T> {
  items: T[];
  limit: number;
  nextCursor?: string;
  total?: number;
}

export interface StudioDashboardBase {
  schemaVersion: typeof STUDIO_DASHBOARD_SCHEMA_VERSION;
  kind: "studio-production-dashboard";
  operation: StudioProductionDashboardQuery["operation"];
  projectId: string;
  projectName: string;
  manifestFingerprint: string;
  fingerprint: string;
  nextAction: StudioDashboardNextAction;
  locator: StudioDashboardLocator;
}

export interface StudioDashboardOverview extends StudioDashboardBase {
  operation: "overview";
  counts: {
    units: number;
    /** 当前 unit head 宫格精确 SUM（SQL）；与 panelsEstimated 同值。 */
    panels: number;
    /**
     * @deprecated 历史字段名；现等于 panels 精确值，不再抽样估算。
     */
    panelsEstimated: number;
    scriptDocuments: number;
    promptDocuments: number;
    characters: number;
    scenes: number;
    props: number;
    styles: number;
    canonicalAssets: number;
    media: number;
    assetBindingSets: number;
    mentionProposals: number;
  };
  facets: {
    seasons: string[];
    episodes: Array<{ season: string; episode: string }>;
  };
  queueTotals: Record<StudioDashboardQueueKind, number | "bounded-partial">;
  checkpoint: {
    completedSlotCount: number;
    fullBatchCount: number;
    collectingSlotCount: number;
    newSlotDispatchAllowed: boolean;
    blockingBatchNumber?: number;
    fingerprint: string;
  };
  capabilities: {
    sourceShot: StudioDashboardCurrentness;
    fusionStoryboardSheet: StudioDashboardCurrentness;
    legacyPublication: StudioDashboardCurrentness;
    p3VisualConstraints: StudioDashboardCurrentness;
  };
  generationProjection: {
    status: "current" | "degraded";
    reason?: string;
  };
}

export interface StudioDashboardUnitSummary {
  id: string;
  seasonId: string;
  episodeId: string;
  sequence: number;
  canonicalSuccessorUnitId: string | null;
  label: string;
  durationSeconds: number;
  panelCount: number;
  status: StudioBindingTimelineStatus;
  statusReason?: string;
  locator: StudioDashboardLocator;
  currentness: StudioDashboardCurrentness;
}

export interface StudioDashboardUnitsPage extends StudioDashboardBase {
  operation: "units";
  seasons: Array<{ id: string; label: string }>;
  episodes: Array<{ id: string; seasonId: string; label: string }>;
  page: StudioDashboardPage<StudioDashboardUnitSummary>;
}

export interface StudioDashboardPanelSummary {
  id: string;
  ordinal: number;
  label: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  status: StudioBindingTimelineStatus;
  statusReason?: string;
  bindingCurrentness: StudioDashboardCurrentness;
  bindingSetId?: string;
  bindingFingerprint?: string;
  assetIds: string[];
  locator: StudioDashboardLocator;
  visualAction?: string;
  shotComposition?: string;
  dialogue?: string;
  subtitle?: string;
}

export interface StudioDashboardUnitDetail extends StudioDashboardBase {
  operation: "unit";
  /** 详情页携带生产 head revision，供连续性人工校正写回时做并发保护。 */
  unit: StudioDashboardUnitSummary & { revision: number };
  panels: StudioDashboardPanelSummary[];
  selectedPanelId?: string;
  selectedPanel?: {
    panel: StudioDashboardPanelSummary;
    controlAssets: Array<{
      assetId: string;
      assetName: string;
      category?: StudioCanonicalAssetCategory;
      role?: string;
      presence?: string;
    }>;
    continuityReview?: Pick<
      StudioContinuityReviewControl,
      "fingerprint" | "scope" | "nextAction" | "generation" | "checkpoint" | "assets" | "conflicts" | "resolvedGenerationRunId"
    >;
    generation: {
      status: "ready" | "blocked" | "missing" | "not-applicable";
      packId?: string;
      fingerprint?: string;
      code?: string;
      message?: string;
    };
    legacy: {
      sourceShot: StudioDashboardCurrentness;
      fusionStoryboardSheet: StudioDashboardCurrentness;
      p3VisualConstraints: StudioDashboardCurrentness;
      publication: StudioDashboardCurrentness;
    };
  };
  bindingRevisionToken: string;
}

export interface StudioDashboardAssetSummary {
  id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  description: string;
  aliases: string[];
  revision: number;
  hasPrimaryAuthority: boolean;
  authorityMediaSha256?: string;
  /** 权威图缩略图 recipe（渲染层拼 aicanvas-studio://thumbnail/...） */
  authorityThumbnailRecipeKey?: string;
  locator: StudioDashboardLocator;
  currentness: StudioDashboardCurrentness;
}

export interface StudioDashboardAssetsPage extends StudioDashboardBase {
  operation: "assets";
  page: StudioDashboardPage<StudioDashboardAssetSummary>;
  requestedAssetIds?: string[];
  missingAssetIds?: string[];
}

export interface StudioDashboardAppearance {
  assetId: string;
  unitId: string;
  unitTitle: string;
  season: string;
  episode: string;
  unitSequence: number;
  panelId: string;
  panelIndex: number;
  panelTitle: string;
  startSeconds: number;
  endSeconds: number;
  presence: string;
  role: string;
  locator: StudioDashboardLocator;
}

export interface StudioDashboardAppearancesPage extends StudioDashboardBase {
  operation: "appearances";
  assetId: string;
  page: StudioDashboardPage<StudioDashboardAppearance>;
}

export interface StudioDashboardQueueItem {
  id: string;
  queue: StudioDashboardQueueKind;
  title: string;
  reason: string;
  severity: "blocking" | "warning";
  locator: StudioDashboardLocator;
  currentness: StudioDashboardCurrentness;
}

export interface StudioDashboardQueuePage extends StudioDashboardBase {
  operation: "queue";
  queue: StudioDashboardQueueKind;
  page: StudioDashboardPage<StudioDashboardQueueItem>;
  scanBounded: boolean;
}

export type StudioProductionDashboardResponse =
  | StudioDashboardOverview
  | StudioDashboardUnitsPage
  | StudioDashboardUnitDetail
  | StudioDashboardAssetsPage
  | StudioDashboardAppearancesPage
  | StudioDashboardQueuePage;

export class StudioProductionDashboardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StudioProductionDashboardError";
    this.code = code;
  }
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new StudioProductionDashboardError("invalid-input", `${field} 必须是 1-200 个字符。`);
  }
  return normalized;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new StudioProductionDashboardError("invalid-input", `${field} 必须是 1-${maximum} 的整数。`);
  }
  return limit;
}

function encodeOffsetCursor(scope: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      scope?: unknown;
      offset?: unknown;
    };
    if (value.v !== 1 || value.scope !== scope || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
      throw new Error("invalid");
    }
    return Number(value.offset);
  } catch {
    throw new StudioProductionDashboardError("invalid-input", "分页 cursor 无效或不属于当前队列。");
  }
}

function decodeLegacyQueueOffsetCursor(cursor: string | undefined, scope: string): number | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      scope?: unknown;
      offset?: unknown;
    };
    if (value.v !== 1 || value.scope !== scope || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
      return undefined;
    }
    return Number(value.offset);
  } catch {
    return undefined;
  }
}

function projectLocator(projectId: string): StudioDashboardLocator {
  return { kind: "project", projectId };
}

function unitLocator(projectId: string, unitId: string): StudioDashboardLocator {
  return { kind: "unit", projectId, unitId };
}

function panelLocator(projectId: string, unitId: string, panelId: string): StudioDashboardLocator {
  return { kind: "panel", projectId, unitId, panelId };
}

function assetLocator(projectId: string, assetId: string): StudioDashboardLocator {
  return { kind: "asset", projectId, assetId };
}

function queueItemLocator(
  projectId: string,
  queue: StudioDashboardQueueKind,
  itemId: string,
  extra?: Partial<StudioDashboardLocator>,
): StudioDashboardLocator {
  return {
    kind: "queue-item",
    projectId,
    queue,
    itemId,
    ...extra,
  };
}

function mapUnitSummary(
  projectId: string,
  unit: StudioBindingUnitSummary,
): StudioDashboardUnitSummary {
  const currentness: StudioDashboardCurrentness = unit.status === "generation-ready"
    ? "current"
    : unit.status === "stale"
      ? "stale"
      : unit.status === "ambiguous" || unit.status === "unmatched"
        ? "blocked"
        : unit.status === "bound" || unit.status === "unchecked"
          ? "current"
          : "missing";
  return {
    id: unit.id,
    seasonId: unit.seasonId,
    episodeId: unit.episodeId,
    sequence: unit.sequence,
    canonicalSuccessorUnitId: unit.canonicalSuccessorUnitId,
    label: unit.label,
    durationSeconds: unit.durationSeconds,
    panelCount: unit.panelCount,
    status: unit.status,
    ...(unit.statusReason ? { statusReason: unit.statusReason } : {}),
    locator: unitLocator(projectId, unit.id),
    currentness,
  };
}

/** Dashboard 的生成/连续性控制资产只包含实际允许入画的 Binding；forbidden 仅作安全约束。 */
export function studioDashboardPanelControlAssetIds(
  panel: Pick<StudioBindingPanelControl, "bindingSet" | "proposals">,
): string[] {
  const visibleProposals = panel.proposals.filter((proposal) => proposal.presence !== "forbidden");
  const fromBinding = panel.bindingSet
    ? visibleProposals
      .filter((proposal) => proposal.status === "matched" || proposal.resolvedAssetId)
      .map((proposal) => proposal.resolvedAssetId ?? proposal.matchedAssetId)
      .filter((value): value is string => Boolean(value))
    : [];
  const fromResolved = visibleProposals
    .map((proposal) => proposal.resolvedAssetId ?? proposal.matchedAssetId)
    .filter((value): value is string => Boolean(value));
  const ids = [...new Set(fromBinding.length ? fromBinding : fromResolved)].slice(0, STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT);
  return ids;
}

function mapPanel(
  projectId: string,
  unitId: string,
  panel: StudioBindingPanelControl,
  productionPanel?: { visualAction: string; shotComposition: string; dialogue: string; subtitle: string; durationSeconds: number },
): StudioDashboardPanelSummary {
  const bindingCurrentness: StudioDashboardCurrentness = panel.bindingSet
    ? (panel.bindingSet.currentness === "current" ? "current" : "stale")
    : panel.status === "ambiguous" || panel.status === "unmatched"
      ? "blocked"
      : "missing";
  return {
    id: panel.id,
    ordinal: panel.ordinal,
    label: panel.label,
    startSeconds: panel.startSeconds,
    endSeconds: panel.endSeconds,
    durationSeconds: productionPanel?.durationSeconds
      ?? Math.max(0, panel.endSeconds - panel.startSeconds),
    status: panel.status,
    ...(panel.statusReason ? { statusReason: panel.statusReason } : {}),
    bindingCurrentness,
    ...(panel.bindingSet ? {
      bindingSetId: panel.bindingSet.id,
      bindingFingerprint: panel.bindingSet.fingerprint,
    } : {}),
    assetIds: studioDashboardPanelControlAssetIds(panel),
    locator: panelLocator(projectId, unitId, panel.id),
    ...(productionPanel ? {
      visualAction: productionPanel.visualAction,
      shotComposition: productionPanel.shotComposition,
      dialogue: productionPanel.dialogue,
      subtitle: productionPanel.subtitle,
    } : {}),
  };
}

function deriveOverviewNextAction(input: {
  projectId: string;
  scriptDocuments: number;
  canonicalAssets: number;
  primaryAuthorities: number;
  units: number;
  bindingSets: number;
  queueTotals: Record<StudioDashboardQueueKind, number | "bounded-partial">;
  checkpoint: Pick<StudioGenerationCheckpointDashboardGate, "blockingBatchNumber" | "newSlotDispatchAllowed">;
}): StudioDashboardNextAction {
  if (input.scriptDocuments === 0) {
    return {
      code: "import-script",
      label: "导入第一份剧本",
      reason: "工程尚无剧本文档，无法建立可追溯文本修订与实体解析。",
      requiresWrite: true,
      command: "create_studio_script_document",
      locator: projectLocator(input.projectId),
    };
  }
  if (input.canonicalAssets === 0) {
    return {
      code: "create-canonical-assets",
      label: "建立角色、场景、道具、风格",
      reason: "尚无规范资产，后续 BindingSet 与连续性无法冻结身份。",
      requiresWrite: true,
      command: "create_studio_canonical_asset",
      locator: projectLocator(input.projectId),
    };
  }
  if (input.primaryAuthorities < input.canonicalAssets) {
    return {
      code: "promote-authority",
      label: "补齐权威参考媒体",
      reason: `${input.canonicalAssets - input.primaryAuthorities} 项资产尚未设定 primary authority。`,
      requiresWrite: true,
      command: "set_studio_primary_authority",
      locator: projectLocator(input.projectId),
    };
  }
  if (input.units === 0) {
    return {
      code: "create-production-units",
      label: "建立 15 秒生产单元",
      reason: "需要严格 15 秒、2–6 宫格的生产单元才能进入绑定与连续性。",
      requiresWrite: true,
      command: "create_studio_production_unit",
      locator: projectLocator(input.projectId),
    };
  }
  const conflictTotal = input.queueTotals.conflict;
  if (typeof conflictTotal === "number" && conflictTotal > 0) {
    return {
      code: "resolve-continuity-conflict",
      label: "处理连续性冲突队列",
      reason: `存在 ${conflictTotal} 项开放连续性冲突。`,
      requiresWrite: true,
      command: "append_studio_continuity_correction",
      locator: { kind: "queue-item", projectId: input.projectId, queue: "conflict", itemId: "head" },
    };
  }
  const ambiguityTotal = input.queueTotals.ambiguity;
  if (typeof ambiguityTotal === "number" && ambiguityTotal > 0) {
    return {
      code: "resolve-binding-ambiguity",
      label: "消歧剧本实体",
      reason: `存在 ${ambiguityTotal} 个含歧义提案的单元（有界扫描）。`,
      requiresWrite: true,
      command: "record_studio_mention_decision",
      locator: { kind: "queue-item", projectId: input.projectId, queue: "ambiguity", itemId: "head" },
    };
  }
  const missingTotal = input.queueTotals.missing;
  if (typeof missingTotal === "number" && missingTotal > 0) {
    return {
      code: "resolve-unmatched-entities",
      label: "处理未匹配实体",
      reason: `存在 ${missingTotal} 个含未匹配实体的单元（有界扫描）。`,
      requiresWrite: true,
      locator: { kind: "queue-item", projectId: input.projectId, queue: "missing", itemId: "head" },
    };
  }
  if (!input.checkpoint.newSlotDispatchAllowed) {
    return {
      code: "complete-checkpoint",
      label: input.checkpoint.blockingBatchNumber
        ? `完成第 ${input.checkpoint.blockingBatchNumber} 批六图停检`
        : "完成六图停检",
      reason: "新槽 dispatch 被 checkpoint 阻断，需先完成 Review/快照/attestation。",
      requiresWrite: true,
      command: "attest_studio_generation_checkpoint",
      locator: projectLocator(input.projectId),
    };
  }
  if (input.bindingSets === 0) {
    return {
      code: "freeze-binding-set",
      label: "解析并冻结宫格 BindingSet",
      reason: "已有生产单元，但尚无任何 AssetBindingSet。",
      requiresWrite: true,
      command: "freeze_studio_panel_asset_binding_set",
      locator: projectLocator(input.projectId),
    };
  }
  return {
    code: "open-production-dashboard",
    label: "在驾驶舱选择下一格并冻结生图包",
    reason: "素材与单元已就绪；由 Dashboard 打开单元视图，按 Core 投影处理阻塞宫格。",
    requiresWrite: false,
    locator: projectLocator(input.projectId),
  };
}

function continuityNextActionToDashboard(
  projectId: string,
  unitId: string,
  panelId: string,
  action: StudioContinuityReviewNextAction,
): StudioDashboardNextAction {
  return {
    code: action.code,
    label: action.label,
    reason: action.reason,
    requiresWrite: action.requiresWrite,
    ...(action.command ? { command: action.command } : {}),
    locator: panelLocator(projectId, unitId, panelId),
  };
}

async function readGenerationProjectionWithin<T>(
  operation: Promise<T>,
  label: string,
  timeoutMilliseconds: number = STUDIO_DASHBOARD_GENERATION_READ_TIMEOUT_MS,
): Promise<T> {
  const injectedDelayMilliseconds = process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_DASHBOARD_GENERATION_DELAY_LABEL === label
    ? Math.max(
      0,
      Math.min(
        10_000,
        Number(process.env.AI_CANVAS_TEST_DASHBOARD_GENERATION_DELAY_MS) || 0,
      ),
    )
    : 0;
  const observedOperation = injectedDelayMilliseconds > 0
    ? operation.then(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, injectedDelayMilliseconds));
      return value;
    })
    : operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observedOperation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StudioProductionDashboardError("generation-projection-timeout", `${label} 超过 ${timeoutMilliseconds}ms。`)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function generationProjectionDegradedNextAction(
  projectId: string,
  unitId: string,
): StudioDashboardNextAction {
  return {
    code: "generation-projection-degraded",
    label: "生成账本投影暂不可用",
    reason: "角色、场景、道具、风格与 BindingSet 引用仍可读取；生成状态未获证实，禁止据此重新派发或重复扣费。",
    requiresWrite: false,
    locator: unitLocator(projectId, unitId),
  };
}

/**
 * 冻结预检已经给出明确的连续性 P0 时，不能再等历史结果投影或把它降级为
 * “账本暂不可用”。该结论来自 Core freeze gate，前端只负责显示。
 */
function opaqueContinuityEntryId(
  freeze: Awaited<ReturnType<typeof queryStudioUnitGridGenerationFreeze>>,
): string | undefined {
  if (freeze.status !== "blocked") return undefined;
  for (const detail of freeze.details) {
    const separator = detail.lastIndexOf(":");
    if (separator <= 0) continue;
    const entryId = detail.slice(0, separator);
    if (entryId.startsWith("studio-continuity-")) return entryId;
  }
  return undefined;
}

async function unitGridFreezeBlockNextAction(
  projectRoot: string,
  projectId: string,
  unitId: string,
  freeze: Awaited<ReturnType<typeof queryStudioUnitGridGenerationFreeze>> | null,
): Promise<StudioDashboardNextAction | null> {
  if (!freeze || freeze.status !== "blocked" || freeze.code !== "continuity-opaque") return null;
  let locator = unitLocator(projectId, unitId);
  const entryId = opaqueContinuityEntryId(freeze);
  if (entryId) {
    try {
      const entry = await readStudioContinuityEntry(projectRoot, entryId);
      if (entry?.scope.kind === "panel" && entry.scope.unitId === unitId) {
        locator = panelLocator(projectId, unitId, entry.scope.scopeId);
      }
    } catch {
      // 门禁本身仍是硬 P0；定位反查失败时只降级为单元入口，绝不把它伪装成可派发。
    }
  }
  return {
    code: freeze.code,
    label: "补齐真实连续性状态",
    reason: freeze.message,
    requiresWrite: true,
    locator,
  };
}

/** unit-grid 终态投影 → 驾驶舱 nextAction（禁止误投 panel 生图）。 */
export function unitGridProjectionToDashboardNextAction(
  projectId: string,
  unitId: string,
  projection: StudioUnitGridNextActionProjection,
): StudioDashboardNextAction {
  return {
    code: projection.code,
    label: projection.label,
    reason: projection.forbidPanelGenerate
      ? `unit-grid 目标（phase=${projection.phase}）：禁止 panel 级 execute-agent-imagegen。`
      : `unit-grid 目标（phase=${projection.phase}）。`,
    requiresWrite: projection.phase === "ready-to-freeze"
      || projection.phase === "ready-to-dispatch"
      || projection.phase === "rework"
      || projection.phase === "not-invoked-needs-new-run"
      || projection.phase === "abandoned-needs-new-run"
      || projection.phase === "pending-review",
    locator: unitLocator(projectId, unitId),
  };
}

async function resolveUnitGridDashboardNextAction(
  projectRoot: string,
  projectId: string,
  unitId: string,
): Promise<StudioDashboardNextAction | null> {
  let latest: Awaited<ReturnType<typeof listStudioGenerationLatestUnitGridRuns>>[number] | undefined;
  try {
    // 已派发单元必须先读取“最新 run + 当前 Review Head”的 owner 投影。
    // 历史结果列表会把旧 attempt 的 pending 状态与新 attempt 的 PASS 混在一起，
    // 不能用于决定当前 nextAction。
    latest = (await readGenerationProjectionWithin(
      listStudioGenerationLatestUnitGridRuns(projectRoot, [unitId]),
      "unit-grid 最新 run 投影",
      6_000,
    ))[0];
  } catch {
    return generationProjectionDegradedNextAction(projectId, unitId);
  }

  const latestRun = latest?.latestRun;
  if (latestRun) {
    const callStatus = latestRun.callStatus === "generation_unknown"
      || latestRun.callStatus === "not-invoked"
      || latestRun.callStatus === "result-committed"
      || latestRun.callStatus === "owner-abandoned"
      ? latestRun.callStatus
      : null;
    const reviewDecision = latestRun.reviewStatus === "pass"
      ? "pass" as const
      : latestRun.reviewStatus === "rework"
        ? "rework" as const
        : latestRun.reviewStatus === "reject" || latestRun.reviewStatus === "rejected"
          ? "reject" as const
          : latestRun.hasResultPair
            ? "pending" as const
            : null;
    const projection = projectStudioUnitGridNextAction({
      hasCurrentPack: true,
      hasActiveRun: !latestRun.terminal,
      callStatus,
      pairComplete: latestRun.hasResultPair,
      reviewDecision,
    });
    return unitGridProjectionToDashboardNextAction(projectId, unitId, projection);
  }

  let unitGridReady: Awaited<ReturnType<typeof queryStudioUnitGridGenerationFreeze>> | null;
  try {
    // 从未派发时才做昂贵的完整 freeze 预检；已派发单元不应为展示 nextAction
    // 重建全部 panel pack、actual-tail 和媒体闭包。
    unitGridReady = await readGenerationProjectionWithin(
      queryStudioUnitGridGenerationFreeze(projectRoot, { targetKind: "unit-grid", unitId }).catch(() => null),
      "unit-grid 冻结预检",
      6_000,
    );
  } catch {
    return generationProjectionDegradedNextAction(projectId, unitId);
  }
  const freezeBlock = await unitGridFreezeBlockNextAction(projectRoot, projectId, unitId, unitGridReady);
  if (freezeBlock) return freezeBlock;
  const hasCurrentPack = Boolean(unitGridReady && unitGridReady.status === "ready");
  if (!hasCurrentPack) return null;
  const projection = projectStudioUnitGridNextAction({
    hasCurrentPack,
  });
  return unitGridProjectionToDashboardNextAction(projectId, unitId, projection);
}

function bindingNextActionToDashboard(
  projectId: string,
  unit: StudioBindingUnitSummary,
  nextAction: string,
  selectedPanelId?: string,
): StudioDashboardNextAction {
  const locator = selectedPanelId
    ? panelLocator(projectId, unit.id, selectedPanelId)
    : unitLocator(projectId, unit.id);
  if (unit.status === "ambiguous") {
    return {
      code: "resolve-binding-ambiguity",
      label: "消歧当前单元实体",
      reason: nextAction,
      requiresWrite: true,
      command: "record_studio_mention_decision",
      locator,
    };
  }
  if (unit.status === "unmatched") {
    return {
      code: "resolve-unmatched-entities",
      label: "处理未匹配实体",
      reason: nextAction,
      requiresWrite: true,
      locator,
    };
  }
  if (unit.status === "pending" || unit.status === "unchecked") {
    return {
      code: "continue-binding",
      label: "继续绑定控制",
      reason: nextAction,
      requiresWrite: true,
      locator,
    };
  }
  return {
    code: "unit-ready-for-continuity",
    label: "进入连续性 / 生图准备",
    reason: nextAction,
    requiresWrite: false,
    locator,
  };
}

async function scanBindingQueueItems(
  projectRoot: string,
  projectId: string,
  queue: "ambiguity" | "missing" | "stale",
  limit: number,
  offset: number,
): Promise<{ items: StudioDashboardQueueItem[]; total: number | "bounded-partial"; scanBounded: boolean }> {
  const collected: StudioDashboardQueueItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let scanned = 0;
  let hitBound = false;

  while (pages < STUDIO_DASHBOARD_QUEUE_SCAN_MAX_PAGES) {
    pages += 1;
    const page = await listStudioBindingUnits(projectRoot, {
      ...(cursor ? { cursor } : {}),
      limit: STUDIO_DASHBOARD_UNIT_PAGE_LIMIT,
    });
    for (const unit of page.items) {
      scanned += 1;
      let matches = false;
      let reason = unit.statusReason ?? unit.status;
      if (queue === "ambiguity" && unit.status === "ambiguous") matches = true;
      if (queue === "missing" && unit.status === "unmatched") matches = true;
      if (queue === "stale" && unit.status === "stale") matches = true;
      if (!matches && queue === "stale") {
        // unchecked 表示有 BindingSet 但列表未做深度当前性；不计入 stale
      }
      if (!matches) continue;
      collected.push({
        id: `${queue}:${unit.id}`,
        queue,
        title: unit.label,
        reason,
        severity: "blocking",
        locator: queueItemLocator(projectId, queue, unit.id, { unitId: unit.id }),
        currentness: "blocked",
      });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    if (pages >= STUDIO_DASHBOARD_QUEUE_SCAN_MAX_PAGES && page.nextCursor) {
      hitBound = true;
      break;
    }
  }

  const pageItems = collected.slice(offset, offset + limit);
  return {
    items: pageItems,
    total: hitBound ? "bounded-partial" : collected.length,
    scanBounded: hitBound,
  };
}

/**
 * Overview 只需要三类绑定队列总数；单次分页扫描同时归约，禁止为
 * ambiguity/missing/stale 对同一批 541+ 单元重复读取三遍。
 */
async function scanBindingQueueTotals(
  projectRoot: string,
): Promise<Record<"ambiguity" | "missing" | "stale", number | "bounded-partial">> {
  const totals = { ambiguity: 0, missing: 0, stale: 0 };
  let cursor: string | undefined;
  let hitBound = false;
  for (let pageNumber = 0; pageNumber < STUDIO_DASHBOARD_QUEUE_SCAN_MAX_PAGES; pageNumber += 1) {
    const page = await listStudioBindingUnits(projectRoot, {
      ...(cursor ? { cursor } : {}),
      limit: STUDIO_DASHBOARD_UNIT_PAGE_LIMIT,
    });
    for (const unit of page.items) {
      if (unit.status === "ambiguous") totals.ambiguity += 1;
      else if (unit.status === "unmatched") totals.missing += 1;
      else if (unit.status === "stale") totals.stale += 1;
    }
    if (!page.nextCursor) {
      cursor = undefined;
      break;
    }
    cursor = page.nextCursor;
    if (pageNumber + 1 >= STUDIO_DASHBOARD_QUEUE_SCAN_MAX_PAGES) hitBound = true;
  }
  return hitBound
    ? { ambiguity: "bounded-partial", missing: "bounded-partial", stale: "bounded-partial" }
    : totals;
}

async function collectConflictQueue(
  projectRoot: string,
  projectId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: StudioDashboardQueueItem[]; total: number; nextCursor?: string }> {
  // 新页直接复用 continuity owner 的 SQL keyset。仅兼容读取历史 offset cursor，
  // 不再把队列固定截断在最早 500 项。
  const legacyOffset = decodeLegacyQueueOffsetCursor(cursor, "queue:conflict");
  const result = legacyOffset === undefined
    ? await listOpenStudioContinuityConflictPage(projectRoot, { cursor, limit })
    : await Promise.all([
      listOpenStudioContinuityConflicts(projectRoot, { limit, offset: legacyOffset }),
      listOpenStudioContinuityConflictPage(projectRoot, { limit: 1 }),
    ]).then(([items, first]) => ({
      items,
      total: first.total,
      ...(legacyOffset + items.length < first.total
        ? { nextCursor: encodeOffsetCursor("queue:conflict", legacyOffset + items.length) }
        : {}),
    }));
  const items = result.items.map((conflict) => ({
    id: conflict.id,
    queue: "conflict" as const,
    title: `${conflict.subjectId} · ${conflict.field}`,
    reason: `开放冲突 ${conflict.overlapStartMilliseconds}-${conflict.overlapEndMilliseconds}ms`,
    severity: "blocking" as const,
    locator: queueItemLocator(projectId, "conflict", conflict.id, {
      unitId: conflict.scopeAnchor.unitId,
      panelId: conflict.scopeAnchor.scopeId,
      assetId: conflict.subjectId,
    }),
    currentness: "blocked" as const,
  }));
  return {
    items,
    total: result.total,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

async function collectReworkQueue(
  projectRoot: string,
  projectId: string,
  limit: number,
  offset: number,
): Promise<{ items: StudioDashboardQueueItem[]; total: number }> {
  const checkpoint = await getStudioGenerationCheckpointControl(projectRoot);
  const items: StudioDashboardQueueItem[] = [];
  for (const batch of checkpoint.batches) {
    if (batch.status === "passed") continue;
    if (batch.attestation?.decision === "rework" || batch.status === "review-blocked"
      || batch.status === "refresh-required" || batch.status === "attestation-required") {
      items.push({
        id: `rework:batch-${batch.batchNumber}`,
        queue: "rework",
        title: `六图批次 ${batch.batchNumber}`,
        reason: batch.blockers.join("；") || `状态 ${batch.status}`,
        severity: "blocking",
        locator: queueItemLocator(projectId, "rework", `batch-${batch.batchNumber}`),
        currentness: "blocked",
      });
    }
  }
  if (!checkpoint.newSlotDispatchAllowed && items.length === 0 && checkpoint.blockingBatchNumber) {
    items.push({
      id: `rework:batch-${checkpoint.blockingBatchNumber}`,
      queue: "rework",
      title: `六图批次 ${checkpoint.blockingBatchNumber}`,
      reason: "新槽 dispatch 被阻断。",
      severity: "blocking",
      locator: queueItemLocator(projectId, "rework", `batch-${checkpoint.blockingBatchNumber}`),
      currentness: "blocked",
    });
  }
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
  };
}

async function boundedQueueTotals(
  projectRoot: string,
  projectId: string,
  options: { includeRework?: boolean } = {},
): Promise<Record<StudioDashboardQueueKind, number | "bounded-partial">> {
  // 首屏只读取能在有界时间内完成的绑定/连续性队列。返工队列需要完整
  // checkpoint control，可能扫描全部历史批次；仅在用户明确打开返工队列时
  // 才计算，避免它拖住画布启动并让实际资产链不可读。
  const [bindingTotals, conflictFull] = await Promise.all([
    scanBindingQueueTotals(projectRoot),
    collectConflictQueue(projectRoot, projectId, STUDIO_DASHBOARD_QUEUE_PAGE_LIMIT),
  ]);
  const rework = options.includeRework
    ? (await collectReworkQueue(projectRoot, projectId, STUDIO_DASHBOARD_QUEUE_PAGE_LIMIT, 0)).total
    : "bounded-partial";
  return {
    ambiguity: bindingTotals.ambiguity,
    missing: bindingTotals.missing,
    stale: bindingTotals.stale,
    conflict: conflictFull.total,
    rework,
  };
}

async function buildOverview(projectRoot: string): Promise<StudioDashboardOverview> {
  const shell = await inspectManagedProject(projectRoot);
  const [material, production, facets] = await Promise.all([
    getMaterialStudioState(projectRoot),
    getStudioProductionState(projectRoot),
    getStudioProductionScopeFacets(projectRoot),
  ]);
  let checkpoint: StudioGenerationCheckpointDashboardGate;
  let queueTotals: Record<StudioDashboardQueueKind, number | "bounded-partial">;
  let generationProjection: StudioDashboardOverview["generationProjection"] = { status: "current" };
  try {
    [checkpoint, queueTotals] = await readGenerationProjectionWithin(Promise.all([
      getStudioGenerationCheckpointDashboardGate(projectRoot),
      boundedQueueTotals(projectRoot, shell.project.id, { includeRework: false }),
    ]), "概览生成账本投影");
    if (checkpoint.verification === "unverified-history") {
      generationProjection = {
        status: "degraded",
        reason: "历史生成批次待正式账本复核；画布资产与引用链可继续读取，但禁止从概览派发。",
      };
    }
  } catch {
    checkpoint = {
      schemaVersion: 1,
      kind: "studio-generation-checkpoint-dashboard-gate",
      completedSlotCount: 0,
      fullBatchCount: 0,
      collectingSlotCount: 0,
      evaluatedBatchCount: 0,
      newSlotDispatchAllowed: false,
      verification: "unverified-history",
      fingerprint: digest({ kind: "generation-projection-degraded", projectId: shell.project.id }),
    };
    queueTotals = {
      ambiguity: 0,
      missing: 0,
      stale: 0,
      conflict: 0,
      rework: "bounded-partial",
    };
    generationProjection = {
      status: "degraded",
      reason: "generation ledger 投影未在时限内完成；checkpoint 和队列数不作为生产依据，禁止据此派发。",
    };
  }

  // P9-R：宫格数必须 SQL 精确 SUM，禁止首屏抽样估算。
  const panelsExact = production.counts.panels;

  const nextAction = generationProjection.status === "degraded"
    ? {
      code: "generation-projection-degraded",
      label: "生成账本投影暂不可用",
      reason: generationProjection.reason ?? "generation ledger 投影未在时限内完成；禁止据此派发。",
      requiresWrite: false,
      locator: projectLocator(shell.project.id),
    }
    : deriveOverviewNextAction({
    projectId: shell.project.id,
    scriptDocuments: production.counts.scriptDocuments,
    canonicalAssets: material.counts.canonicalAssets,
    primaryAuthorities: material.counts.primaryAuthorities,
    units: production.counts.units,
    bindingSets: production.counts.assetBindingSets,
    queueTotals,
    checkpoint,
    });

  const body = {
    schemaVersion: STUDIO_DASHBOARD_SCHEMA_VERSION,
    kind: "studio-production-dashboard" as const,
    operation: "overview" as const,
    projectId: shell.project.id,
    projectName: shell.project.name,
    manifestFingerprint: shell.manifestFingerprint,
    nextAction,
    locator: projectLocator(shell.project.id),
    counts: {
      units: production.counts.units,
      panels: panelsExact,
      panelsEstimated: panelsExact,
      scriptDocuments: production.counts.scriptDocuments,
      promptDocuments: production.counts.promptDocuments,
      characters: material.counts.characters,
      scenes: material.counts.scenes,
      props: material.counts.props,
      styles: material.counts.styles,
      canonicalAssets: material.counts.canonicalAssets,
      media: material.counts.media,
      assetBindingSets: production.counts.assetBindingSets,
      mentionProposals: production.counts.mentionProposals,
    },
    facets: {
      seasons: facets.seasons,
      episodes: facets.episodes,
    },
    queueTotals,
    checkpoint: {
      completedSlotCount: checkpoint.completedSlotCount,
      fullBatchCount: checkpoint.fullBatchCount,
      collectingSlotCount: checkpoint.collectingSlotCount,
      newSlotDispatchAllowed: checkpoint.newSlotDispatchAllowed,
      ...(checkpoint.blockingBatchNumber === undefined
        ? {}
        : { blockingBatchNumber: checkpoint.blockingBatchNumber }),
      fingerprint: checkpoint.fingerprint,
    },
    capabilities: {
      sourceShot: "not-applicable" as const,
      fusionStoryboardSheet: "not-applicable" as const,
      legacyPublication: "not-applicable" as const,
      p3VisualConstraints: "not-applicable" as const,
    },
    generationProjection,
  };
  return { ...body, fingerprint: digest(body) };
}

async function buildUnits(
  projectRoot: string,
  query: Extract<StudioProductionDashboardQuery, { operation: "units" }>,
): Promise<StudioDashboardUnitsPage> {
  const limit = boundedLimit(query.limit, STUDIO_DASHBOARD_UNIT_PAGE_LIMIT, STUDIO_DASHBOARD_UNIT_PAGE_LIMIT, "limit");
  // units 是纯读取：外层只需要受管工程身份。Binding owner 内部仍执行完整
  // inspectManagedProject，因此 generation ledger 缺失/损坏继续失败关闭；这里只把
  // 重复的完整初始化降为只读检查，并与列表读取并行，缩短冷启动首卡关键路径。
  const [shell, page] = await Promise.all([
    measureStudioUnitsReadPhase(
      "dashboard-readonly-shell",
      () => inspectManagedProjectReadOnly(projectRoot),
    ),
    listStudioBindingUnits(projectRoot, {
      ...(query.season ? { seasonId: query.season } : {}),
      ...(query.episode ? { episodeId: query.episode } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit,
    }),
  ]);
  return measureStudioUnitsReadSyncPhase("dashboard-map-digest", () => {
    const items = page.items.map((unit) => mapUnitSummary(shell.project.id, unit));
    recordStudioUnitsReadCounter("returnedUnitCount", items.length);
    const nextAction: StudioDashboardNextAction = items[0]
      ? {
        code: "open-unit",
        label: "打开单元详情",
        reason: page.nextAction ?? "选择单元后按 Core 投影处理第一个阻塞宫格。",
        requiresWrite: false,
        locator: items[0].locator,
      }
      : {
        code: "create-production-units",
        label: "建立生产单元",
        reason: "当前筛选下没有单元。",
        requiresWrite: true,
        command: "create_studio_production_unit",
        locator: projectLocator(shell.project.id),
      };
    const body = {
      schemaVersion: STUDIO_DASHBOARD_SCHEMA_VERSION,
      kind: "studio-production-dashboard" as const,
      operation: "units" as const,
      projectId: shell.project.id,
      projectName: shell.project.name,
      manifestFingerprint: shell.manifestFingerprint,
      nextAction,
      locator: projectLocator(shell.project.id),
      seasons: page.seasons,
      episodes: page.episodes,
      page: {
        items,
        limit,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        ...(page.total === undefined ? {} : { total: page.total }),
      },
    };
    return { ...body, fingerprint: digest(body) };
  });
}

async function buildUnit(
  projectRoot: string,
  query: Extract<StudioProductionDashboardQuery, { operation: "unit" }>,
): Promise<StudioDashboardUnitDetail> {
  const shell = await inspectManagedProject(projectRoot);
  const unitId = requiredId(query.unitId, "unitId");
  const [binding, snapshot] = await Promise.all([
    getStudioBindingControl(projectRoot, { unitId }),
    getStudioProductionUnitSnapshot(projectRoot, unitId),
  ]);
  if (!snapshot) {
    throw new StudioProductionDashboardError("unit-not-found", `生产单元不存在：${unitId}`);
  }
  const unit = { ...mapUnitSummary(shell.project.id, binding.unit), revision: snapshot.unit.revision };
  const panels = binding.panels.slice(0, STUDIO_DASHBOARD_PANEL_LIMIT).map((panel) => {
    const productionPanel = snapshot.panels.find((item) => item.id === panel.id);
    return mapPanel(shell.project.id, unitId, panel, productionPanel ? {
      visualAction: productionPanel.visualAction,
      shotComposition: productionPanel.shotComposition,
      dialogue: productionPanel.dialogue,
      subtitle: productionPanel.subtitle,
      durationSeconds: productionPanel.durationSeconds,
    } : undefined);
  });
  let selectedPanelId = query.panelId
    ? requiredId(query.panelId, "panelId")
    : binding.selectedPanelId ?? panels.find((panel) => panel.status !== "generation-ready")?.id ?? panels[0]?.id;

  let selectedPanel: StudioDashboardUnitDetail["selectedPanel"];
  let nextAction = bindingNextActionToDashboard(shell.project.id, binding.unit, binding.nextAction, selectedPanelId);

  // unit-grid 终态优先：禁止 generation_unknown / pending-review / approved 时误投 panel 生图。
  const unitGridNext = await resolveUnitGridDashboardNextAction(projectRoot, shell.project.id, unitId);
  if (unitGridNext) nextAction = unitGridNext;
  // P0 必须聚焦到 freeze gate 真正指出的宫格，不能默认打开 G1 而让用户校正错范围。
  const opaqueContinuityLocator = unitGridNext?.code === "continuity-opaque"
    ? unitGridNext.locator
    : undefined;
  if (!query.panelId && opaqueContinuityLocator?.kind === "panel" && opaqueContinuityLocator.panelId) {
    selectedPanelId = opaqueContinuityLocator.panelId;
  }

  if (selectedPanelId) {
    const panel = panels.find((item) => item.id === selectedPanelId);
    const bindingPanel = binding.panels.find((item) => item.id === selectedPanelId);
    if (!panel || !bindingPanel) {
      throw new StudioProductionDashboardError("panel-not-found", `宫格不存在：${selectedPanelId}`);
    }
    const assetIds = panel.assetIds.slice(0, STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT);
    const startMilliseconds = Math.round(panel.startSeconds * 1_000);
    const endMilliseconds = Math.round(panel.endSeconds * 1_000);
    const assetDetails = await Promise.all(assetIds.map((assetId) => getStudioCanonicalAsset(projectRoot, assetId)));
    const assetDetailsById = new Map(assetDetails.filter(Boolean).map((asset) => [asset!.id, asset!]));
    const controlAssets = assetIds.map((assetId) => {
      const fromSnapshot = snapshot.panels
        .find((item) => item.id === selectedPanelId)
        ?.assets.find((asset) => asset.assetId === assetId);
      return {
        assetId,
        assetName: assetDetailsById.get(assetId)?.name ?? assetId,
        ...(assetDetailsById.get(assetId)?.category ? { category: assetDetailsById.get(assetId)!.category } : {}),
        ...(fromSnapshot?.role ? { role: fromSnapshot.role } : {}),
        ...(fromSnapshot?.presence ? { presence: fromSnapshot.presence } : {}),
      };
    });
    // generation ledger 不可投影，或 freeze 已明确连续性 P0 时，驾驶舱仍必须显示
    // 已冻结的角色、场景和道具引用；但不能再并发读取深层连续性/生成投影，避免
    // SQLite sidecar 竞争把明确 P0 误报为超时，也不能误报 ready 或允许重派。
    if (unitGridNext?.code === "generation-projection-degraded" || unitGridNext?.code === "continuity-opaque") {
      const continuityOpaque = unitGridNext.code === "continuity-opaque";
      selectedPanel = {
        panel,
        controlAssets,
        generation: {
          status: "blocked",
          code: unitGridNext.code,
          message: continuityOpaque
            ? "连续性仍含内部定位；先录入真实视觉状态，禁止冻结或重新派发。"
            : "生成账本状态未获证实；保留参考链只读可见，禁止重新派发。",
        },
        legacy: {
          sourceShot: "not-applicable",
          fusionStoryboardSheet: "not-applicable",
          p3VisualConstraints: "not-applicable",
          publication: "not-applicable",
        },
      };
    } else {
      try {
        const continuityReview = await readGenerationProjectionWithin(
          getStudioContinuityReviewControl(projectRoot, {
            unitId,
            unitRevision: snapshot.unit.revision,
            panelId: selectedPanelId,
            startMilliseconds,
            endMilliseconds,
            assetIds,
          }),
          "宫格连续性与生成投影",
        );
        // 仅在无 unit-grid 终态门禁时才回落到 panel continuity nextAction。
        if (!unitGridNext) {
          nextAction = continuityNextActionToDashboard(
            shell.project.id,
            unitId,
            selectedPanelId,
            continuityReview.nextAction,
          );
        }
        selectedPanel = {
          panel,
          controlAssets,
          continuityReview: {
            fingerprint: continuityReview.fingerprint,
            scope: continuityReview.scope,
            nextAction: continuityReview.nextAction,
            generation: continuityReview.generation,
            checkpoint: continuityReview.checkpoint,
            assets: continuityReview.assets,
            conflicts: continuityReview.conflicts,
            ...(continuityReview.resolvedGenerationRunId ? { resolvedGenerationRunId: continuityReview.resolvedGenerationRunId } : {}),
          },
          generation: continuityReview.generation.status === "ready"
            ? {
              status: "ready",
              packId: continuityReview.generation.packId,
              fingerprint: continuityReview.generation.fingerprint,
            }
            : {
              status: "blocked",
              code: continuityReview.generation.code,
              message: continuityReview.generation.message,
            },
          legacy: {
            sourceShot: "not-applicable",
            fusionStoryboardSheet: "not-applicable",
            p3VisualConstraints: "not-applicable",
            publication: "not-applicable",
          },
        };
      } catch (error) {
        if (!(error instanceof StudioProductionDashboardError)
          || error.code !== "generation-projection-timeout") {
          throw error;
        }
        nextAction = generationProjectionDegradedNextAction(shell.project.id, unitId);
        selectedPanel = {
          panel,
          controlAssets,
          generation: {
            status: "blocked",
            code: "generation-projection-degraded",
            message: "生成账本投影未在时限内完成；保留参考链只读可见，禁止重新派发。",
          },
          legacy: {
            sourceShot: "not-applicable",
            fusionStoryboardSheet: "not-applicable",
            p3VisualConstraints: "not-applicable",
            publication: "not-applicable",
          },
        };
      }
    }
  }

  const body = {
    schemaVersion: STUDIO_DASHBOARD_SCHEMA_VERSION,
    kind: "studio-production-dashboard" as const,
    operation: "unit" as const,
    projectId: shell.project.id,
    projectName: shell.project.name,
    manifestFingerprint: shell.manifestFingerprint,
    nextAction,
    locator: selectedPanelId
      ? panelLocator(shell.project.id, unitId, selectedPanelId)
      : unitLocator(shell.project.id, unitId),
    unit,
    panels,
    ...(selectedPanelId ? { selectedPanelId } : {}),
    ...(selectedPanel ? { selectedPanel } : {}),
    bindingRevisionToken: binding.revisionToken,
  };
  return { ...body, fingerprint: digest(body) };
}

function mapAsset(
  projectId: string,
  asset: StudioCanonicalAssetSummary,
): StudioDashboardAssetSummary {
  return {
    id: asset.id,
    category: asset.category,
    name: asset.name,
    description: asset.description,
    aliases: asset.aliases,
    revision: asset.revision,
    hasPrimaryAuthority: Boolean(asset.primaryAuthority),
    ...(asset.primaryAuthority?.mediaSha256
      ? { authorityMediaSha256: asset.primaryAuthority.mediaSha256 }
      : {}),
    ...(asset.primaryAuthority?.thumbnailRecipeKey
      ? { authorityThumbnailRecipeKey: asset.primaryAuthority.thumbnailRecipeKey }
      : {}),
    locator: assetLocator(projectId, asset.id),
    currentness: asset.primaryAuthority ? "current" : "missing",
  };
}

async function buildAssets(
  projectRoot: string,
  query: Extract<StudioProductionDashboardQuery, { operation: "assets" }>,
): Promise<StudioDashboardAssetsPage> {
  const shell = await inspectManagedProject(projectRoot);
  const requestedAssetIds = query.assetIds === undefined
    ? undefined
    : [...new Set(query.assetIds.map((assetId) => requiredId(assetId, "assetIds[]")))];
  if (requestedAssetIds && (requestedAssetIds.length < 1 || requestedAssetIds.length > STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT)) {
    throw new StudioProductionDashboardError(
      "invalid-input",
      `assetIds 必须包含 1-${STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT} 个唯一资产 ID。`,
    );
  }
  if (requestedAssetIds && (query.category !== undefined || query.search !== undefined || query.cursor !== undefined)) {
    throw new StudioProductionDashboardError("invalid-input", "assetIds 精确读取不能与 category/search/cursor 混用。");
  }
  const limit = boundedLimit(
    query.limit,
    requestedAssetIds?.length ?? STUDIO_DASHBOARD_ASSET_PAGE_LIMIT,
    requestedAssetIds ? STUDIO_DASHBOARD_ASSET_CONTROL_LIMIT : STUDIO_DASHBOARD_ASSET_PAGE_LIMIT,
    "limit",
  );
  const exactAssets = requestedAssetIds
    ? await Promise.all(requestedAssetIds.map((assetId) => getStudioCanonicalAsset(projectRoot, assetId)))
    : undefined;
  const page: { items: StudioCanonicalAssetSummary[]; nextCursor?: string } = exactAssets
    ? { items: exactAssets.filter((asset): asset is NonNullable<typeof asset> => Boolean(asset)).slice(0, limit) }
    : await listStudioCanonicalAssets(projectRoot, {
      ...(query.category ? { category: query.category } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit,
    });
  const items = page.items.map((asset) => mapAsset(shell.project.id, asset));
  const foundIds = new Set(items.map((item) => item.id));
  const missingAssetIds = requestedAssetIds?.filter((assetId) => !foundIds.has(assetId)) ?? [];
  const nextAction: StudioDashboardNextAction = items[0]
    ? {
      code: "open-asset-appearances",
      label: "查看资产出场",
      reason: "分页浏览规范资产；点击可直达出场 unit/panel。",
      requiresWrite: false,
      locator: items[0].locator,
    }
    : {
      code: "create-canonical-assets",
      label: "建立规范资产",
      reason: "当前筛选下没有资产。",
      requiresWrite: true,
      command: "create_studio_canonical_asset",
      locator: projectLocator(shell.project.id),
    };
  const body = {
    schemaVersion: STUDIO_DASHBOARD_SCHEMA_VERSION,
    kind: "studio-production-dashboard" as const,
    operation: "assets" as const,
    projectId: shell.project.id,
    projectName: shell.project.name,
    manifestFingerprint: shell.manifestFingerprint,
    nextAction,
    locator: projectLocator(shell.project.id),
    page: {
      items,
      limit,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
    ...(requestedAssetIds ? { requestedAssetIds, missingAssetIds } : {}),
  };
  return { ...body, fingerprint: digest(body) };
}

function mapAppearance(
  projectId: string,
  item: StudioAssetTimelineItem,
): StudioDashboardAppearance {
  return {
    assetId: item.assetId,
    unitId: item.unitId,
    unitTitle: item.unitTitle,
    season: item.season,
    episode: item.episode,
    unitSequence: item.unitSequence,
    panelId: item.panelId,
    panelIndex: item.panelIndex,
    panelTitle: item.panelTitle,
    startSeconds: item.startSeconds,
    endSeconds: item.endSeconds,
    presence: item.presence,
    role: item.role,
    locator: panelLocator(projectId, item.unitId, item.panelId),
  };
}

async function buildAppearances(
  projectRoot: string,
  query: Extract<StudioProductionDashboardQuery, { operation: "appearances" }>,
): Promise<StudioDashboardAppearancesPage> {
  const shell = await inspectManagedProject(projectRoot);
  const assetId = requiredId(query.assetId, "assetId");
  const limit = boundedLimit(
    query.limit,
    STUDIO_DASHBOARD_APPEARANCE_PAGE_LIMIT,
    STUDIO_DASHBOARD_APPEARANCE_PAGE_LIMIT,
    "limit",
  );
  const page = await queryStudioAssetTimeline(projectRoot, {
    assetId,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit,
  });
  const items = page.items.map((item) => mapAppearance(shell.project.id, item));
  const nextAction: StudioDashboardNextAction = items[0]
    ? {
      code: "jump-to-panel",
      label: "跳转到出场宫格",
      reason: `${assetId} 在 ${items[0].episode} / ${items[0].unitTitle} / ${items[0].panelTitle}`,
      requiresWrite: false,
      locator: items[0].locator,
    }
    : {
      code: "no-appearances",
      label: "暂无出场记录",
      reason: "该资产尚未绑定到任何生产宫格。",
      requiresWrite: false,
      locator: assetLocator(shell.project.id, assetId),
    };
  const body = {
    schemaVersion: STUDIO_DASHBOARD_SCHEMA_VERSION,
    kind: "studio-production-dashboard" as const,
    operation: "appearances" as const,
    projectId: shell.project.id,
    projectName: shell.project.name,
    manifestFingerprint: shell.manifestFingerprint,
    nextAction,
    locator: assetLocator(shell.project.id, assetId),
    assetId,
    page: {
      items,
      limit,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
  };
  return { ...body, fingerprint: digest(body) };
}

async function buildQueue(
  projectRoot: string,
  query: Extract<StudioProductionDashboardQuery, { operation: "queue" }>,
): Promise<StudioDashboardQueuePage> {
  const shell = await inspectManagedProject(projectRoot);
  const limit = boundedLimit(query.limit, STUDIO_DASHBOARD_QUEUE_PAGE_LIMIT, STUDIO_DASHBOARD_QUEUE_PAGE_LIMIT, "limit");
  const offset = query.queue === "conflict" ? 0 : decodeOffsetCursor(query.cursor, `queue:${query.queue}`);
  let items: StudioDashboardQueueItem[] = [];
  let total: number | "bounded-partial" = 0;
  let scanBounded = false;
  let ownerNextCursor: string | undefined;

  if (query.queue === "conflict") {
    const result = await collectConflictQueue(projectRoot, shell.project.id, limit, query.cursor);
    items = result.items;
    total = result.total;
    ownerNextCursor = result.nextCursor;
  } else if (query.queue === "rework") {
    const result = await collectReworkQueue(projectRoot, shell.project.id, limit, offset);
    items = result.items;
    total = result.total;
  } else {
    const result = await scanBindingQueueItems(projectRoot, shell.project.id, query.queue, limit, offset);
    items = result.items;
    total = result.total;
    scanBounded = result.scanBounded;
  }

  const nextOffset = offset + items.length;
  const hasMore = typeof total === "number"
    ? nextOffset < total
    : items.length === limit;
  const nextCursor = query.queue === "conflict"
    ? ownerNextCursor
    : hasMore ? encodeOffsetCursor(`queue:${query.queue}`, nextOffset) : undefined;

  const nextAction: StudioDashboardNextAction = items[0]
    ? {
      code: `process-${query.queue}`,
      label: `处理 ${query.queue} 队列首项`,
      reason: items[0].reason,
      requiresWrite: true,
      locator: items[0].locator,
    }
    : {
      code: "queue-empty",
      label: "队列为空",
      reason: `${query.queue} 队列在有界扫描范围内没有条目。`,
      requiresWrite: false,
      locator: projectLocator(shell.project.id),
    };

  const body = {
    schemaVersion: STUDIO_DASHBOARD_SCHEMA_VERSION,
    kind: "studio-production-dashboard" as const,
    operation: "queue" as const,
    projectId: shell.project.id,
    projectName: shell.project.name,
    manifestFingerprint: shell.manifestFingerprint,
    nextAction,
    locator: projectLocator(shell.project.id),
    queue: query.queue,
    page: {
      items,
      limit,
      ...(nextCursor ? { nextCursor } : {}),
      ...(typeof total === "number" ? { total } : {}),
    },
    scanBounded,
  };
  return { ...body, fingerprint: digest(body) };
}

export async function getStudioProductionDashboard(
  projectRoot: string,
  query: StudioProductionDashboardQuery,
): Promise<StudioProductionDashboardResponse> {
  return withStudioRequestSchemaCache(async () => {
    if (!query || typeof query !== "object" || !("operation" in query)) {
      throw new StudioProductionDashboardError("invalid-input", "query.operation 必填。");
    }
    switch (query.operation) {
      case "overview":
        return buildOverview(projectRoot);
      case "units":
        return measureStudioUnitsReadPhase(
          "dashboard-core-total",
          () => buildUnits(projectRoot, query),
        );
      case "unit":
        return buildUnit(projectRoot, query);
      case "assets":
        return buildAssets(projectRoot, query);
      case "appearances":
        return buildAppearances(projectRoot, query);
      case "queue":
        return buildQueue(projectRoot, query);
      default: {
        const exhaustive: never = query;
        throw new StudioProductionDashboardError(
          "invalid-input",
          `未知 operation：${String((exhaustive as { operation?: string }).operation)}`,
        );
      }
    }
  });
}
