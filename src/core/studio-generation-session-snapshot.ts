import { createHash } from "node:crypto";
import type { StudioProjectionFrozenReference } from "./studio-production-projection-bundle.js";
import {
  withStudioProductionProjectionBundle,
  withStudioProjectWriteLease,
} from "./studio-readonly-diagnostics-lazy.js";
import {
  listStudioGenerationLatestUnitGridRuns,
  listStudioGenerationPacksByUnit,
  listStudioGenerationPanelHistory,
  readAnyStudioGenerationFrozenPack,
  type AnyStudioGenerationFreezePack,
} from "./studio-generation-ledger.js";
import { queryStudioGenerationFreeze } from "./studio-generation.js";
import {
  formatFrozenPanelBeatReadonlyLine,
  formatFrozenPanelShotTypeReadonlyLine,
  formatFrozenStyleLockReadonlyLine,
  frozenPanelBeatFromAnyFrozenPack,
  parseFrozenPanelCostumeFromRenderedPrompt,
  parseFrozenPanelLightingFromRenderedPrompt,
  parseFrozenPanelShotTypeFromRenderedPrompt,
  previousStandingFromFrozenRenderedPrompt,
  styleLockRefsFromAnyFrozenPack,
  type StudioPanelStandingHandoff,
} from "./studio-panel-standing.js";
import { readStudioSceneBackReferences } from "./studio-scene-backrefs-read.js";
import type { CharacterBackReference, PropBackReference, SceneBackReference } from "./studio-scene-backrefs.js";
import {
  composeStudioGenerationPlanDraft,
  historyEnvelopePeekRunId,
  refineStudioGenerationPlanDraftIfUnitGridBlocking,
  type StudioGenerationPlanDraft,
} from "./studio-generation-plan-draft.js";
import {
  generationLedgerSidecarPath,
  readPersistedPanelPlanState,
  readPersistedUnitGridPlanState,
} from "./studio-unit-grid-persisted-plan-read.js";
import type { StudioDashboardCurrentness, StudioDashboardNextAction } from "./studio-production-dashboard.js";
import type { NextShotContinuitySnapshot } from "./studio-next-shot-continuity.js";
import type { StudioPostResultObservedActualState } from "./studio-post-result-observation.js";

export const STUDIO_GENERATION_SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SessionConsistencyPeek = {
  status: "cached" | "unevaluated";
  verdict?: "consistent" | "needs-review" | "drifted" | "not-checkable";
  generationRunId: string | null;
};

/** 只读 peek 投影。无 run / 未入 LRU → unevaluated（≠ 无法检查）。不 evaluate 像素。 */
export function sessionConsistencyPeekFromVerdict(
  generationRunId: string | null | undefined,
  verdict?: SessionConsistencyPeek["verdict"],
): SessionConsistencyPeek {
  if (!generationRunId) return { status: "unevaluated", generationRunId: null };
  if (verdict) return { status: "cached", verdict, generationRunId };
  return { status: "unevaluated", generationRunId };
}

/** 写租约只读 peek。只拷 held / holderId / denialHint / line，不暴露 token。 */
export type SessionWriteLeasePeek = {
  held: boolean;
  holderId: string | null;
  denialHint: string | null;
  line: string;
};

const SESSION_WRITE_LEASE_UNHELD_LINE = "写租约未持有；写命令前须 acquire-lease（不派发）";

/** 与对照板同文案。本地排版，不拉对照模块。未投影 ≠ 已持有。 */
export function formatSessionWriteLeaseLine(
  lease?: { held: boolean; holderId: string | null; denialHint: string | null } | null,
): string {
  if (!lease) return "会话快照未投影写租约";
  if (lease.held) {
    return lease.holderId
      ? `写租约由 ${lease.holderId} 持有；无该租约禁止写命令（不派发）`
      : "写租约已被持有；无该租约禁止写命令（不派发）";
  }
  return lease.denialHint || SESSION_WRITE_LEASE_UNHELD_LINE;
}

export function sessionWriteLeasePeekFailClosed(): SessionWriteLeasePeek {
  return {
    held: false,
    holderId: null,
    denialHint: null,
    line: SESSION_WRITE_LEASE_UNHELD_LINE,
  };
}

async function sessionWriteLeasePeek(projectRoot: string): Promise<SessionWriteLeasePeek> {
  try {
    const projection = await withStudioProjectWriteLease((mod) =>
      mod.getStudioProjectWriteLeaseReadOnly(projectRoot),
    );
    const peek = {
      held: projection.held === true,
      holderId: projection.lease?.holderId ?? null,
      denialHint: projection.denialHint ?? null,
    };
    return { ...peek, line: formatSessionWriteLeaseLine(peek) };
  } catch {
    return sessionWriteLeasePeekFailClosed();
  }
}

/** 六图闸只读 peek。只拷 newSlotDispatchAllowed / blockingBatchNumber / line。 */
export type SessionCheckpointPeek = {
  newSlotDispatchAllowed: boolean;
  blockingBatchNumber: number | null;
  line: string;
};

const SESSION_CHECKPOINT_BLOCKED_LINE = "六图闸未放行，先完成停检/Review（不派发）";

/** 与对照板同文案。本地排版，不拉对照模块。未投影 ≠ 已放行。 */
export function formatSessionCheckpointLine(
  checkpoint?: { newSlotDispatchAllowed: boolean; blockingBatchNumber?: number | null } | null,
): string {
  if (!checkpoint) return "会话快照未投影六图闸";
  if (checkpoint.newSlotDispatchAllowed === false) {
    return checkpoint.blockingBatchNumber != null
      ? `六图闸未放行（batch ${checkpoint.blockingBatchNumber}），先完成停检/Review（不派发）`
      : SESSION_CHECKPOINT_BLOCKED_LINE;
  }
  return "六图闸已放行新槽";
}

export function sessionCheckpointPeekFailClosed(): SessionCheckpointPeek {
  return {
    newSlotDispatchAllowed: false,
    blockingBatchNumber: null,
    line: SESSION_CHECKPOINT_BLOCKED_LINE,
  };
}

/** 动态 import 首屏闸。失败关闭为未放行。不改 nextAction / 草稿 ready。 */
async function sessionCheckpointPeek(projectRoot: string): Promise<SessionCheckpointPeek> {
  try {
    const { getStudioGenerationCheckpointDashboardGate } = await import("./studio-generation-checkpoint.js");
    const gate = await getStudioGenerationCheckpointDashboardGate(projectRoot);
    const peek = {
      newSlotDispatchAllowed: gate.newSlotDispatchAllowed !== false,
      blockingBatchNumber: gate.blockingBatchNumber ?? null,
    };
    return { ...peek, line: formatSessionCheckpointLine(peek) };
  } catch {
    return sessionCheckpointPeekFailClosed();
  }
}

/**
 * history 信封 consistencyPeek。只看本页 items；无 run 则省略字段。
 * 动态 import peek，不 evaluate 像素。机器不自动 Review PASS。
 */
export async function historyEnvelopeConsistencyPeek(
  items: ReadonlyArray<{ generationRunId?: string | null; pairComplete?: boolean }>,
): Promise<SessionConsistencyPeek | undefined> {
  const runId = historyEnvelopePeekRunId(items);
  if (!runId) return undefined;
  const { peekStudioConsistencyVerdictByRunId } = await import("./studio-consistency-evaluator.js");
  return sessionConsistencyPeekFromVerdict(runId, peekStudioConsistencyVerdictByRunId(runId));
}

export interface StudioGenerationSessionReference {
  assetId: string;
  category: "character" | "scene" | "prop" | "style";
  presence: "required" | "optional" | "forbidden";
  role: string;
  mediaSha256: string;
  sourceFingerprint: string;
}

export interface StudioGenerationSessionSnapshot {
  schemaVersion: typeof STUDIO_GENERATION_SESSION_SNAPSHOT_SCHEMA_VERSION;
  kind: "studio-generation-session-snapshot";
  projectId: string;
  manifestFingerprint: string;
  unit: {
    unitId: string;
    unitRevision: number;
    panelId: string;
    panelIndex: number;
    panelCount: number;
    unitLocalStartSeconds?: number;
    unitLocalEndSeconds?: number;
    episodeAbsoluteStartSeconds?: number;
    episodeAbsoluteEndSeconds?: number;
    durationSeconds?: number;
  };
  scriptSpans: Array<{
    scriptRevisionId: string;
    scriptSha256: string;
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    surfaceSha256: string;
  }>;
  binding: {
    status: string;
    bindingSet?: {
      id: string;
      fingerprint: string;
      currentness: "current" | "stale";
      frozenAt: string;
    };
  };
  referenceRoles: {
    canonicalIdentity: StudioGenerationSessionReference[];
    continuationSource: StudioGenerationSessionReference[];
    compositionHint: StudioGenerationSessionReference[];
    forbidden: StudioGenerationSessionReference[];
    unclassified: StudioGenerationSessionReference[];
  };
  previousActualTail?: {
    generationRunId?: string;
    status: "missing" | "current" | "stale";
    continuationEligible: boolean;
    observedState?: StudioPostResultObservedActualState;
    continuitySnapshot?: NextShotContinuitySnapshot;
    fingerprint: string;
  };
  /**
   * 锁版前镜：只从该包 renderedPrompt 还原，不读 unit head。
   * 历史包无「前镜交接」行则为 null。不是 BindingSet，也不是 previousActualTail。
   */
  previousStanding: (StudioPanelStandingHandoff & {
    source: "frozen-rendered-prompt";
  }) | null;
  /**
   * 冻结宫格光线/服装覆盖：只从该包 renderedPrompt 还原，不读 unit head。
   * 历史包无「光线/服装（宫格覆盖）」行则为 null。不是 BindingSet。
   */
  frozenPanelLighting: string | null;
  frozenPanelCostume: string | null;
  /**
   * 跨单元场景回指：只读生产库快照提及（category=scene），不读 unit head、不拆冻结包。
   * 无场景提及则为空数组；缺库失败关闭为空，不建库。不是 BindingSet。
   */
  sceneMentions: Array<{ assetId: string; role: string }>;
  sceneBackReferences: SceneBackReference[];
  sceneBackReferenceNote: string;
  /**
   * 跨单元道具回指：只读生产库快照提及（category=prop），不读 unit head、不拆冻结包。
   * 无道具提及则为空数组；缺库失败关闭为空，不建库。不是 BindingSet。
   */
  propMentions: Array<{ assetId: string; role: string }>;
  propBackReferences: PropBackReference[];
  propBackReferenceNote: string;
  /**
   * 跨单元角色回指：只读生产库快照提及（category=character），不读 unit head、不拆冻结包。
   * 无角色提及则为空数组；缺库失败关闭为空，不建库。不是 BindingSet。
   */
  characterMentions: Array<{ assetId: string; role: string }>;
  characterBackReferences: CharacterBackReference[];
  characterBackReferenceNote: string;
  /**
   * 冻结镜头类型只读句：只从该包 renderedPrompt 或 pack.panel.shotType 还原，不读 unit head。
   * 无扩写/原镜则为 null，不进 fingerprint。不是 BindingSet。
   */
  shotTypeLine: string | null;
  /**
   * 冻结风格锁只读句：只从该包 controlReferences / assets 的 category=style 还原，不读 unit head。
   * 无风格控制参考则为 null，不进 fingerprint。不是 BindingSet。
   */
  styleLockLine: string | null;
  /**
   * 冻结 15s 节拍只读句：只从该包 target 起止秒还原，不读 unit head，不写新冻结行。
   * 无时长则为 null，不进 fingerprint。不是 BindingSet。
   */
  beatLine: string | null;
  /**
   * P21 create-plan 只读草稿：有 query.panelId 只认该格已落盘单镜包；
   * 无 panelId 只认该单元已落盘 unit-grid pack，禁止猜第一格，禁止用 readiness 候选。
   * 账本已有对应 plan 时 ready=false，下一步是 dispatch。未冻结 / 未落盘则为 blocked。
   * 不进 fingerprint。不执行、不派发。
   */
  generationPlanDraft: StudioGenerationPlanDraft;
  /**
   * 一致性四态只读 peek：按当前宫格 newest-first 结果 run，否则整板 latest run。
   * 只读进程内 LRU；未评估 ≠ 无法检查。不进 fingerprint。不 evaluate 像素。机器不自动 Review PASS。
   */
  consistencyPeek: SessionConsistencyPeek;
  /**
   * 写租约只读 peek：经 withStudioProjectWriteLease 读 getStudioProjectWriteLeaseReadOnly。
   * 只拷 held / holderId / denialHint / 本地 line，不暴露 token。
   * 失败关闭为未持有+默认句，不让 snapshot 整体失败。
   * 不进 fingerprint。不改 nextAction。不改草稿 ready。不抢租约、不派发。
   */
  writeLease: SessionWriteLeasePeek;
  /**
   * 六图闸只读 peek：动态 import 首屏 DashboardGate。
   * 只拷 newSlotDispatchAllowed / blockingBatchNumber / 本地 line。
   * 失败关闭为未放行+默认句，不让 snapshot 整体失败。
   * 不进 fingerprint。不改 nextAction。不改草稿 ready。不执行停检、不派发。
   */
  checkpoint: SessionCheckpointPeek;
  camera: {
    current?: {
      shotComposition: string;
      filmingMethod: string;
      shotType: "original" | "extension";
    };
    previous?: {
      axisLine?: string;
      screenDirection?: string;
      cutExit?: string;
    };
  };
  topRisk: {
    code: string;
    message: string;
    severity: "blocking" | "warning";
    source: "generation-unknown" | "binding" | "freeze" | "observation";
  } | null;
  nextAction: StudioDashboardNextAction;
  currentness: StudioDashboardCurrentness | "blocked";
  fingerprint: string;
  builtAt: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

/** 只认 query.panelId 自己的已落盘单镜包；整板包 / 未落盘 / 无 panelId 失败关闭。 */
async function persistedPanelPackIdForDraft(
  projectRoot: string,
  panelId: string | undefined,
  readiness: { status: string; pack?: AnyStudioGenerationFreezePack | null },
): Promise<string | null> {
  if (!panelId || readiness.status !== "ready" || !readiness.pack) return null;
  const pack = readiness.pack;
  if (pack.provenance !== "asset-binding-set" || pack.target.panelId !== panelId) return null;
  try {
    const persisted = await readAnyStudioGenerationFrozenPack(projectRoot, pack.id);
    return persisted?.id === pack.id ? pack.id : null;
  } catch {
    return null;
  }
}

/** 只认账本已落盘 unit-grid pack；不用 readiness 候选，不猜第一格。 */
async function persistedUnitGridPackIdForDraft(
  projectRoot: string,
  unitId: string,
): Promise<string | null> {
  let cursor: string | undefined;
  let latest: { sequence: number; packId: string } | null = null;
  for (let page = 0; page < 8; page += 1) {
    const result = await listStudioGenerationPacksByUnit(projectRoot, {
      unitId,
      limit: 36,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of result.items) {
      if (item.targetKind === "unit-grid" && (!latest || item.sequence > latest.sequence)) {
        latest = { sequence: item.sequence, packId: item.packId };
      }
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  if (!latest) return null;
  try {
    const persisted = await readAnyStudioGenerationFrozenPack(projectRoot, latest.packId);
    if (!persisted || persisted.id !== latest.packId) return null;
    if (persisted.provenance !== "unit-grid-binding-sets") return null;
    if (persisted.target.targetKind !== "unit-grid" || persisted.target.unitId !== unitId) return null;
    return persisted.id;
  } catch {
    return null;
  }
}

function panelPack(
  pack: AnyStudioGenerationFreezePack | null,
  panelId: string,
) {
  if (!pack) return undefined;
  if (pack.provenance === "asset-binding-set") {
    return pack.target.panelId === panelId ? pack : undefined;
  }
  return pack.panels.find((panel) => panel.panelId === panelId)?.panelPack;
}

function referenceFromFrozen(
  reference: StudioProjectionFrozenReference,
): StudioGenerationSessionReference {
  return {
    assetId: reference.assetId,
    category: reference.category,
    presence: reference.presence,
    role: reference.role,
    mediaSha256: reference.media.mediaSha256,
    sourceFingerprint: reference.sourceFingerprint,
  };
}

function referenceRoles(
  references: StudioGenerationSessionReference[],
): StudioGenerationSessionSnapshot["referenceRoles"] {
  const sorted = [...references].sort((left, right) =>
    left.assetId.localeCompare(right.assetId, "en")
    || left.role.localeCompare(right.role, "en"));
  const canonicalIdentity = sorted.filter((entry) =>
    entry.presence !== "forbidden"
    && (entry.role === "canonical_identity" || entry.role === "canonical-identity"));
  const continuationSource = sorted.filter((entry) =>
    entry.presence !== "forbidden"
    && (entry.role === "continuation_source" || entry.role === "continuation-source"));
  const compositionHint = sorted.filter((entry) =>
    entry.presence !== "forbidden"
    && (entry.role === "composition_hint" || entry.role === "composition-hint"));
  const forbidden = sorted.filter((entry) => entry.presence === "forbidden");
  const classified = new Set([
    ...canonicalIdentity,
    ...continuationSource,
    ...compositionHint,
    ...forbidden,
  ].map((entry) => entry.sourceFingerprint));
  return {
    canonicalIdentity,
    continuationSource,
    compositionHint,
    forbidden,
    unclassified: sorted.filter((entry) => !classified.has(entry.sourceFingerprint)),
  };
}

/**
 * Codex 决策前态势快照。它只编排既有 owner 的只读投影，不拥有状态，
 * 不返回 localPath/objectPath/SQLite 路径，也不替代 freeze pack。
 */
export async function buildStudioGenerationSessionSnapshot(
  projectRoot: string,
  query: { unitId: string; panelId?: string },
): Promise<StudioGenerationSessionSnapshot> {
  const bundle = await withStudioProductionProjectionBundle((projection) =>
    projection.buildStudioProductionProjectionBundle(projectRoot, query),
  );
  const selectedPanelId = query.panelId
    ?? bundle.currentUnit.selectedPanelId
    ?? bundle.currentUnit.panels[0]?.panelId;
  const panel = bundle.currentUnit.panels.find((entry) => entry.panelId === selectedPanelId);
  if (!selectedPanelId || !panel) {
    throw new Error(`单元 ${query.unitId} 没有可用于生成会话的当前宫格。`);
  }
  const writeLeasePromise = sessionWriteLeasePeek(projectRoot);
  const checkpointPromise = sessionCheckpointPeek(projectRoot);

  // readiness 返回的是当前态候选包，尚未执行 freeze 时不会出现在账本里。
  // 会话快照必须直接使用这份内存候选，不能把“未持久化”误判成缺少剧本/
  // 参考资产；只有当前 readiness 已阻断时，才用正式 PASS 绑定的历史包补充
  // 只读上下文，而且 topRisk/currentness 仍保持 blocked。
  const readiness = await queryStudioGenerationFreeze(projectRoot, {
    unitId: query.unitId,
    panelId: selectedPanelId,
  });
  const persistedPackId = bundle.currentUnit.frozenPackIdentity?.id;
  const persistedPack = readiness.status === "blocked" && persistedPackId
    ? await readAnyStudioGenerationFrozenPack(projectRoot, persistedPackId)
    : null;
  const pack: AnyStudioGenerationFreezePack | null = readiness.status === "ready"
    ? readiness.pack
    : persistedPack;
  const frozenPanel = panelPack(pack, selectedPanelId);
  const latestRun = (await listStudioGenerationLatestUnitGridRuns(projectRoot, [query.unitId]))[0]?.latestRun;
  const panelHistoryRunId = (
    await listStudioGenerationPanelHistory(projectRoot, {
      unitId: query.unitId,
      panelId: selectedPanelId,
      order: "newest-first",
      limit: 1,
    })
  ).items[0]?.generationRunId;
  const consistencyPeekRunId = panelHistoryRunId ?? latestRun?.generationRunId;
  const { peekStudioConsistencyVerdictByRunId } = await import("./studio-consistency-evaluator.js");
  const consistencyPeek = sessionConsistencyPeekFromVerdict(
    consistencyPeekRunId,
    consistencyPeekRunId ? peekStudioConsistencyVerdictByRunId(consistencyPeekRunId) : undefined,
  );

  const frozenReferences = frozenPanel
    ? [
        ...frozenPanel.assets.map((entry) => ({
          assetId: entry.assetId,
          category: entry.category,
          presence: entry.presence,
          role: entry.role,
          mediaSha256: entry.version.mediaSha256,
          sourceFingerprint: entry.sourceFingerprint,
        })),
        ...frozenPanel.forbiddenAssets.map((entry) => ({
          assetId: entry.assetId,
          category: entry.category,
          presence: entry.presence,
          role: entry.role,
          mediaSha256: entry.version.mediaSha256,
          sourceFingerprint: entry.sourceFingerprint,
        })),
      ]
    : bundle.currentUnit.frozenReferences
      .filter((entry) => entry.panelId === selectedPanelId)
      .map(referenceFromFrozen);

  const bindingBlocking = panel.binding.blockers.find((entry) => entry.severity === "blocking");
  const bindingWarning = panel.binding.blockers.find((entry) => entry.severity === "warning");
  const incoming = bundle.observation.incoming;
  const topRisk: StudioGenerationSessionSnapshot["topRisk"] =
    latestRun?.callStatus === "generation_unknown"
      ? {
          code: "generation-unknown",
          message: `run ${latestRun.generationRunId} 的调用状态不明，必须先对账，禁止重派。`,
          severity: "blocking",
          source: "generation-unknown",
        }
      : bindingBlocking
        ? {
            code: bindingBlocking.code,
            message: bindingBlocking.message,
            severity: "blocking",
            source: "binding",
          }
        : panel.generationFreeze.status === "blocked"
          ? {
              code: "freeze-blocked",
              message: "当前宫格冻结准入被 Core 阻断；按 nextAction 修复后重新读取。",
              severity: "blocking",
              source: "freeze",
            }
          : incoming?.status === "stale" || (incoming?.blockers.length ?? 0) > 0
            ? {
                code: "previous-actual-tail-stale",
                message: incoming?.blockers[0] ?? "上一镜实际末态已陈旧。",
                severity: "blocking",
                source: "observation",
              }
            : bindingWarning
              ? {
                  code: bindingWarning.code,
                  message: bindingWarning.message,
                  severity: "warning",
                  source: "binding",
                }
              : null;

  const target = frozenPanel?.target;
  const previousSnapshot = incoming?.continuitySnapshot;
  const sceneBackref = readStudioSceneBackReferences(projectRoot, {
    unitId: bundle.currentUnit.unitId,
    unitRevision: bundle.currentUnit.revision,
    sequence: bundle.currentUnit.sequence,
    panelId: selectedPanelId,
    panelIndex: panel.panelIndex,
    season: bundle.currentUnit.season,
    episode: bundle.currentUnit.episode,
  });
  const body = {
    schemaVersion: STUDIO_GENERATION_SESSION_SNAPSHOT_SCHEMA_VERSION,
    kind: "studio-generation-session-snapshot" as const,
    projectId: bundle.projectId,
    manifestFingerprint: bundle.manifestFingerprint,
    unit: {
      unitId: bundle.currentUnit.unitId,
      unitRevision: bundle.currentUnit.revision,
      panelId: selectedPanelId,
      panelIndex: panel.panelIndex,
      panelCount: bundle.currentUnit.panels.length,
      ...(target
        ? {
            unitLocalStartSeconds: target.unitLocalStartSeconds,
            unitLocalEndSeconds: target.unitLocalEndSeconds,
            episodeAbsoluteStartSeconds: target.episodeAbsoluteStartSeconds,
            episodeAbsoluteEndSeconds: target.episodeAbsoluteEndSeconds,
            durationSeconds: target.durationSeconds,
          }
        : {}),
    },
    scriptSpans: frozenPanel?.assetBinding.bindingSet.sourceSpans ?? [],
    binding: {
      status: panel.binding.status,
      bindingSet: panel.binding.bindingSet,
    },
    referenceRoles: referenceRoles(frozenReferences),
    previousActualTail: incoming
      ? {
          generationRunId: incoming.generationRunId,
          status: incoming.status,
          continuationEligible: incoming.continuationEligible,
          observedState: incoming.observedState,
          continuitySnapshot: incoming.continuitySnapshot,
          fingerprint: incoming.stamp.fingerprint,
        }
      : undefined,
    previousStanding: (() => {
      const parsed = previousStandingFromFrozenRenderedPrompt(frozenPanel);
      return parsed ? { ...parsed, source: "frozen-rendered-prompt" as const } : null;
    })(),
    frozenPanelLighting: (() => {
      const prompt = frozenPanel?.request?.modelPayload?.renderedPrompt;
      return typeof prompt === "string" ? parseFrozenPanelLightingFromRenderedPrompt(prompt) : null;
    })(),
    frozenPanelCostume: (() => {
      const prompt = frozenPanel?.request?.modelPayload?.renderedPrompt;
      return typeof prompt === "string" ? parseFrozenPanelCostumeFromRenderedPrompt(prompt) : null;
    })(),
    sceneMentions: sceneBackref.sceneMentions,
    sceneBackReferences: sceneBackref.sceneBackReferences,
    sceneBackReferenceNote: sceneBackref.sceneBackReferenceNote,
    propMentions: sceneBackref.propMentions,
    propBackReferences: sceneBackref.propBackReferences,
    propBackReferenceNote: sceneBackref.propBackReferenceNote,
    characterMentions: sceneBackref.characterMentions,
    characterBackReferences: sceneBackref.characterBackReferences,
    characterBackReferenceNote: sceneBackref.characterBackReferenceNote,
    shotTypeLine: (() => {
      const prompt = frozenPanel?.request?.modelPayload?.renderedPrompt;
      const fromPrompt = typeof prompt === "string"
        ? parseFrozenPanelShotTypeFromRenderedPrompt(prompt)
        : null;
      const fromPanel = frozenPanel?.panel.shotType === "extension" || frozenPanel?.panel.shotType === "original"
        ? frozenPanel.panel.shotType
        : null;
      return formatFrozenPanelShotTypeReadonlyLine(fromPrompt ?? fromPanel);
    })(),
    styleLockLine: formatFrozenStyleLockReadonlyLine(styleLockRefsFromAnyFrozenPack(frozenPanel)),
    beatLine: formatFrozenPanelBeatReadonlyLine(frozenPanelBeatFromAnyFrozenPack(frozenPanel)),
    consistencyPeek,
    writeLease: await writeLeasePromise,
    checkpoint: await checkpointPromise,
    generationPlanDraft: refineStudioGenerationPlanDraftIfUnitGridBlocking(
      query.panelId
        ? composeStudioGenerationPlanDraft({
            focusUnitId: query.unitId,
            focusPanelId: query.panelId,
            focusPackId: await persistedPanelPackIdForDraft(projectRoot, query.panelId, readiness),
            ...(() => {
              const persisted = readPersistedPanelPlanState(
                generationLedgerSidecarPath(projectRoot),
                query.unitId,
                query.panelId,
              );
              return {
                hasPersistedPlan: persisted.hasPlan,
                persistedPlanStatus: persisted.status ?? undefined,
              };
            })(),
          })
        : composeStudioGenerationPlanDraft({
            focusUnitId: query.unitId,
            focusPanelId: null,
            focusPackId: await persistedUnitGridPackIdForDraft(projectRoot, query.unitId),
            targetKind: "unit-grid",
            ...(() => {
              const persisted = readPersistedUnitGridPlanState(
                generationLedgerSidecarPath(projectRoot),
                query.unitId,
              );
              return {
                hasPersistedPlan: persisted.hasPlan,
                persistedPlanStatus: persisted.status ?? undefined,
              };
            })(),
          }),
      {
        code: bundle.nextAction.code,
        label: bundle.nextAction.label,
      },
    ),
    camera: {
      current: frozenPanel
        ? {
            shotComposition: frozenPanel.panel.shotComposition,
            filmingMethod: frozenPanel.panel.filmingMethod,
            shotType: frozenPanel.panel.shotType,
          }
        : undefined,
      previous: previousSnapshot
        ? {
            axisLine: previousSnapshot.scene.axisLine,
            screenDirection: previousSnapshot.scene.screenDirection,
            cutExit: previousSnapshot.scene.cutExit,
          }
        : undefined,
    },
    topRisk,
    nextAction: bundle.nextAction,
    currentness: topRisk?.severity === "blocking"
      ? "blocked" as const
      : !panel.binding.bindingSet
        ? "missing" as const
        : bundle.currentness,
    builtAt: new Date().toISOString(),
  };
  return {
    ...body,
    fingerprint: digest({
      unit: body.unit,
      scriptSpans: body.scriptSpans,
      binding: body.binding.bindingSet
        ? { id: body.binding.bindingSet.id, fingerprint: body.binding.bindingSet.fingerprint }
        : null,
      referenceRoles: body.referenceRoles,
      previousActualTail: body.previousActualTail,
      ...(body.previousStanding ? { previousStanding: body.previousStanding } : {}),
      ...(body.frozenPanelLighting ? { frozenPanelLighting: body.frozenPanelLighting } : {}),
      ...(body.frozenPanelCostume ? { frozenPanelCostume: body.frozenPanelCostume } : {}),
      ...(body.sceneMentions.length > 0 || body.sceneBackReferences.length > 0
        ? {
            sceneMentions: body.sceneMentions,
            sceneBackReferences: body.sceneBackReferences,
          }
        : {}),
      ...(body.propMentions.length > 0 || body.propBackReferences.length > 0
        ? {
            propMentions: body.propMentions,
            propBackReferences: body.propBackReferences,
          }
        : {}),
      ...(body.characterMentions.length > 0 || body.characterBackReferences.length > 0
        ? {
            characterMentions: body.characterMentions,
            characterBackReferences: body.characterBackReferences,
          }
        : {}),
      ...(body.shotTypeLine ? { shotTypeLine: body.shotTypeLine } : {}),
      ...(body.styleLockLine ? { styleLockLine: body.styleLockLine } : {}),
      ...(body.beatLine ? { beatLine: body.beatLine } : {}),
      camera: body.camera,
      topRiskCode: body.topRisk?.code ?? null,
    }),
  };
}
