/**
 * P24：双向追溯组合查询（只读，规范 §2.2）。
 *
 * 合同语义：
 * - 历史结果还原当时真实输入：unit/script/prompt/bindingSet/continuity 身份全部经冻结包内记录还原，
 *   不读 head（"不用当前最新修订替换"）。
 * - changeClassification 输入 = 对 pack 的 bindingSetId 以 getStudioAssetBindingSetCurrentness
 *   实时重算的 staleReasons（BindingSet/confirmation 词表），经 studio-stale-classification 纯模块分类；
 *   context 一律经 buildStudioAssetBindingCurrentContext（metadata 诊断版）构建，禁第三份组装。
 * - 结果面 storedStaleReasons（`${freezeErrorCode}: ${message}` 冻结码格式）原样展示，不进 classify。
 * - 查询全部有界（runs/results/reviews/packs ≤100/≤50 帽 + truncated；impact 两层分页）。
 * - 本模块只读组合现有公开导出，不改任何写路径、不加新表。
 */
import {
  readAnyStudioGenerationFrozenPack,
  readStudioHistoricalGenerationEvidenceByPack,
  readStudioGenerationDispatch,
  readStudioGenerationResult,
  listStudioGenerationRunsByPack,
  listStudioGenerationResultsByPack,
  listStudioDetachedGenerationUnknownObservations,
  listStudioGenerationPacksByUnit,
  readStudioGenerationRunEventHistory,
  type AnyStudioGenerationFreezePack,
  type StudioGenerationPackIndexRecord,
  type StudioHistoricalGenerationEvidenceRecord,
  type StudioDetachedGenerationUnknownObservation,
} from "./studio-generation-ledger.js";
import type { StudioGenerationFreezePack } from "./studio-generation.js";
import {
  frozenPanelOverlaysFromFrozenPanelPacks,
  previousStandingsFromFrozenPanelPacks,
  type FrozenPanelOverlayRow,
  type FrozenPanelStandingRow,
} from "./studio-panel-standing.js";
import type { StudioUnitGridGenerationFreezePack } from "./studio-unit-grid-generation.js";
import {
  getStudioAssetBindingSetCurrentness,
  listStudioUnitRevisionsByScriptRevision,
} from "./studio-production.js";
import { buildStudioAssetBindingCurrentContext, StudioBindingControlError } from "./studio-binding-control.js";
import { listStudioGenerationReviewHistory } from "./studio-generation-review.js";
import { inspectManagedProject } from "./managed-project.js";
import {
  classifyStudioStaleReasons,
  type StudioStaleClassificationResult,
} from "./studio-stale-classification.js";

export class StudioTraceError extends Error {
  readonly code: "trace-selector-invalid" | "pack-not-found" | "run-not-found" | "result-not-found" | "invalid-cursor";

  constructor(code: StudioTraceError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioTraceError";
    this.code = code;
  }
}

const TRACE_RUNS_CAP = 100;
const TRACE_RESULTS_CAP = 100;
const TRACE_REVIEWS_CAP = 100;
const IMPACT_PACKS_CAP = 50;
const IMPACT_RUNS_CAP = 100;
const IMPACT_RESULTS_CAP = 100;

export type StudioGenerationTraceSelector = { packId: string } | { runId: string } | { resultId: string };

export interface StudioGenerationTraceRun {
  runId: string;
  provider: string;
  dispatchedAt: string;
  eventCount: number;
  latestEventKind: string | null;
  terminal: boolean;
}

export interface StudioGenerationTraceResult {
  resultId: string;
  variant: string;
  mediaSha256: string;
  inputCurrent: boolean;
  /** 冻结码格式 `${code}: ${message}` 原文，不进 classify（两套词表不混用）。 */
  storedStaleReasons: string[];
}

export interface StudioGenerationTraceReview {
  reviewId: string;
  generationRunId: string;
  kind: string;
  decision: string;
  createdAt: string;
  packId: string;
  packFingerprint: string;
  rawSha256: string;
  labeledSha256: string;
}

export interface StudioGenerationTraceScriptIdentity {
  documentId: string;
  revisionId: string;
  bodySha256: string;
}

export interface StudioGenerationTracePromptIdentity extends StudioGenerationTraceScriptIdentity {
  panelId: string;
}

export interface StudioGenerationTracePanelIdentity {
  panelId: string;
  panelIndex: number;
  sourceSpans: Array<{
    scriptRevisionId: string;
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    surfaceSha256: string;
  }>;
}

export interface StudioGenerationTraceBindingSetIdentity {
  id: string;
  fingerprint: string;
  assetReferenceCount: number;
  panelIds: string[];
  staleReasons: string[];
  changeClassification: StudioStaleClassificationResult;
}

/** 全 selector 形态统一的当时链投影（一切身份经冻结包还原，不读 head）。 */
export interface StudioGenerationTrace {
  pack: { packId: string; fingerprint: string; unitSnapshotFingerprint: string };
  target: { targetKind: "panel" | "unit-grid"; targetKey: string };
  unit: { unitId: string; unitRevision: number };
  script: StudioGenerationTraceScriptIdentity;
  /** panel 目标保留旧单值；unit-grid 必须读 prompts，不伪造某一格为整单元 prompt。 */
  prompt: Omit<StudioGenerationTracePromptIdentity, "panelId"> | null;
  prompts: StudioGenerationTracePromptIdentity[];
  /** panel 目标保留旧单值；unit-grid 必须读 panels，不泄漏内部兼容锚点。 */
  panel: StudioGenerationTracePanelIdentity | null;
  panels: StudioGenerationTracePanelIdentity[];
  /** panel 目标保留旧单值；unit-grid 必须读 bindingSets。 */
  bindingSet: Omit<StudioGenerationTraceBindingSetIdentity, "panelIds" | "staleReasons" | "changeClassification"> | null;
  bindingSets: StudioGenerationTraceBindingSetIdentity[];
  continuity: { fingerprint: string; assetCount: number };
  bindingSetStaleReasons: string[];
  changeClassification: StudioStaleClassificationResult;
  runs: StudioGenerationTraceRun[];
  runsTruncated: boolean;
  results: StudioGenerationTraceResult[];
  resultsTruncated: boolean;
  reviews: StudioGenerationTraceReview[];
  reviewsTruncated: boolean;
  /** 历史 PASS 的独立零调用证据；不伪造 run/result/provider/call。 */
  historicalEvidence?: StudioHistoricalGenerationEvidenceRecord;
  /** 仅在存在时返回；空项目保持既有 P24 投影逐字节兼容。 */
  detachedUnknownObservations?: StudioDetachedGenerationUnknownObservation[];
  /**
   * 锁版前镜：只从该包 renderedPrompt 还原，不读 unit head。
   * 仅当至少一格含「前镜交接」行时返回，以免改历史 P24 投影形状。
   */
  previousStandings?: FrozenPanelStandingRow[];
  /**
   * 冻结宫格光线/服装覆盖：只从该包 renderedPrompt 还原，不读 unit head。
   * 仅当至少一格含「光线/服装（宫格覆盖）」行时返回，以免改历史 P24 投影形状。
   */
  frozenPanelOverlays?: FrozenPanelOverlayRow[];
}

function selectorKeys(selector: Record<string, unknown>): string[] {
  return ["packId", "runId", "resultId"].filter((key) => typeof selector[key] === "string" && (selector[key] as string).trim());
}

async function resolveTracePack(projectRoot: string, selector: StudioGenerationTraceSelector): Promise<AnyStudioGenerationFreezePack> {
  const keys = selectorKeys(selector as Record<string, unknown>);
  if (keys.length !== 1) throw new StudioTraceError("trace-selector-invalid", "selector 必须恰好包含 packId/runId/resultId 之一。");
  if ("packId" in selector) {
    const pack = await readAnyStudioGenerationFrozenPack(projectRoot, selector.packId);
    if (!pack) throw new StudioTraceError("pack-not-found", `冻结包不存在：${selector.packId}`);
    return pack;
  }
  if ("runId" in selector) {
    const dispatch = await readStudioGenerationDispatch(projectRoot, selector.runId);
    if (!dispatch) throw new StudioTraceError("run-not-found", `生成 run 不存在：${selector.runId}`);
    const pack = await readAnyStudioGenerationFrozenPack(projectRoot, dispatch.packId);
    if (!pack) throw new StudioTraceError("pack-not-found", `run ${selector.runId} 的冻结包不存在：${dispatch.packId}`);
    return pack;
  }
  const result = await readStudioGenerationResult(projectRoot, selector.resultId);
  if (!result) throw new StudioTraceError("result-not-found", `生成结果不存在：${selector.resultId}`);
  const pack = await readAnyStudioGenerationFrozenPack(projectRoot, result.packId);
  if (!pack) throw new StudioTraceError("pack-not-found", `结果 ${selector.resultId} 的冻结包不存在：${result.packId}`);
  return pack;
}

function isUnitGridPack(pack: AnyStudioGenerationFreezePack): pack is StudioUnitGridGenerationFreezePack {
  return Number(pack.schemaVersion) === 5 || pack.provenance === "unit-grid-binding-sets";
}

/** pack→BindingSet 实时重算 currentness + 分类（单一映射：buildContext→currentness→classify）。 */
const DEGRADED_CONTEXT_CODES: ReadonlySet<string> = new Set([
  "binding-context-incomplete",
  "unit-not-found",
  "panel-not-found",
  "binding-set-not-found",
  "analysis-not-found",
]);

/** pack→BindingSet 实时重算 currentness + 分类（单一映射：buildContext→currentness→classify；含退化 fail-safe，main IPC 共用）。 */
export async function evaluatePackBindingCurrentness(
  projectRoot: string,
  bindingSetId: string,
): Promise<{ bindingSetStaleReasons: string[]; changeClassification: StudioStaleClassificationResult }> {
  try {
    const context = await buildStudioAssetBindingCurrentContext(projectRoot, bindingSetId);
    const currentness = await getStudioAssetBindingSetCurrentness(projectRoot, bindingSetId, context);
    const bindingSetStaleReasons = currentness?.staleReasons ?? [];
    return { bindingSetStaleReasons, changeClassification: classifyStudioStaleReasons(bindingSetStaleReasons) };
  } catch (error) {
    // 资产退化（权威闭包不完整/实体缺失等）：fail-safe 归 unexpected 并继续返回投影，
    // 不让单个退化 pack 炸掉整条 trace/impact 查询（盲审 P1 修复）。
    const code = error instanceof StudioBindingControlError && DEGRADED_CONTEXT_CODES.has(error.code) ? error.code : null;
    if (!code) throw error;
    const bindingSetStaleReasons = [`asset-context-incomplete:${code}`];
    return { bindingSetStaleReasons, changeClassification: classifyStudioStaleReasons(bindingSetStaleReasons) };
  }
}

export interface StudioGenerationPackCurrentness {
  targetKind: "panel" | "unit-grid";
  /** 旧 panel 调用方保留单值；unit-grid 不伪造某一格 BindingSet 为整板身份。 */
  bindingSetId: string | null;
  bindingSetIds: string[];
  bindingSetStaleReasons: string[];
  changeClassification: StudioStaleClassificationResult["classification"];
  expectedReasons: string[];
  unexpectedReasons: string[];
}

/**
 * 对任意冻结包按 target 维度汇总 BindingSet currentness。unit-grid 逐个重算
 * BindingSet 后去重聚合，不把兼容锚点或首格冒充整板身份。
 */
export async function evaluateStudioGenerationPackCurrentness(
  projectRoot: string,
  pack: AnyStudioGenerationFreezePack,
): Promise<StudioGenerationPackCurrentness> {
  const unitGrid = isUnitGridPack(pack);
  const bindingSetIds = [...new Set(
    (unitGrid ? pack.panels.map((panel) => panel.panelPack) : [pack])
      .map((panelPack) => panelPack.assetBinding.bindingSet.id),
  )].sort((left, right) => left.localeCompare(right, "en"));
  const currentnesses = await Promise.all(
    bindingSetIds.map((bindingSetId) => evaluatePackBindingCurrentness(projectRoot, bindingSetId)),
  );
  const bindingSetStaleReasons = [...new Set(
    currentnesses.flatMap((item) => item.bindingSetStaleReasons),
  )].sort((left, right) => left.localeCompare(right, "en"));
  const classification = classifyStudioStaleReasons(bindingSetStaleReasons);
  return {
    targetKind: unitGrid ? "unit-grid" : "panel",
    bindingSetId: unitGrid ? null : bindingSetIds[0]!,
    bindingSetIds,
    bindingSetStaleReasons,
    changeClassification: classification.classification,
    expectedReasons: classification.expectedReasons,
    unexpectedReasons: classification.unexpectedReasons,
  };
}

async function collectTraceRuns(
  projectRoot: string,
  packId: string,
  cap: number,
): Promise<{ runs: StudioGenerationTraceRun[]; truncated: boolean }> {
  const dispatches = await listStudioGenerationRunsByPack(projectRoot, { packId, limit: cap });
  const truncated = Boolean(dispatches.nextCursor);
  // terminal 语义与账本 runTerminalState 对齐：failed/cancelled/retry-superseded 或 raw+labeled 成对（succeeded）。
  // 结果逐页取全（单页 100 帽会把成对结果切到页外，导致 succeeded 误判非终态——F4-1）。
  const variantsByRun = new Map<string, Set<string>>();
  let resultsCursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const resultsPage = await listStudioGenerationResultsByPack(projectRoot, {
      packId,
      limit: TRACE_RESULTS_CAP,
      ...(resultsCursor ? { cursor: resultsCursor } : {}),
    });
    for (const result of resultsPage.items) {
      const variants = variantsByRun.get(result.generationRunId) ?? new Set<string>();
      variants.add(result.variant);
      variantsByRun.set(result.generationRunId, variants);
    }
    if (!resultsPage.nextCursor) break;
    resultsCursor = resultsPage.nextCursor;
  }
  const runs: StudioGenerationTraceRun[] = [];
  for (const dispatch of dispatches.items) {
    const events = await readStudioGenerationRunEventHistory(projectRoot, dispatch.generationRunId);
    const latest = events[events.length - 1];
    const variants = variantsByRun.get(dispatch.generationRunId);
    const succeeded = Boolean(variants?.has("raw") && variants?.has("labeled"));
    runs.push({
      runId: dispatch.generationRunId,
      provider: dispatch.provider,
      dispatchedAt: dispatch.dispatchedAt,
      eventCount: events.length,
      latestEventKind: latest?.kind ?? null,
      terminal: succeeded || latest?.kind === "failed" || latest?.kind === "cancelled" || latest?.kind === "retry-superseded",
    });
  }
  return { runs, truncated };
}

async function collectTraceReviews(
  projectRoot: string,
  runIds: string[],
  cap: number,
): Promise<{ reviews: StudioGenerationTraceReview[]; truncated: boolean }> {
  const reviews: StudioGenerationTraceReview[] = [];
  let truncated = false;
  for (const runId of runIds) {
    if (reviews.length >= cap) {
      truncated = true;
      break;
    }
    let cursor: string | undefined;
    for (;;) {
      const page = await listStudioGenerationReviewHistory(projectRoot, {
        generationRunId: runId,
        limit: Math.min(cap - reviews.length, 100),
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        if (reviews.length >= cap) {
          truncated = true;
          break;
        }
        reviews.push({
          reviewId: item.reviewId,
          generationRunId: item.generationRunId,
          kind: item.kind,
          decision: item.decision,
          createdAt: item.createdAt,
          packId: item.packId,
          packFingerprint: item.packFingerprint,
          rawSha256: item.rawSha256,
          labeledSha256: item.labeledSha256,
        });
      }
      if (truncated || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (truncated) break;
  }
  return { reviews, truncated };
}

/** 正向追溯：pack/run/result → 全链当时输入 + runs/results/reviews 有界投影。 */
export async function getStudioGenerationTrace(
  projectRoot: string,
  selector: StudioGenerationTraceSelector,
): Promise<StudioGenerationTrace> {
  const pack = await resolveTracePack(projectRoot, selector);
  const unitGrid = isUnitGridPack(pack);
  const panelPacks: StudioGenerationFreezePack[] = unitGrid
    ? pack.panels.map((panel) => panel.panelPack)
    : [pack];
  const firstPanelPack = panelPacks[0]!;
  const script = {
    documentId: firstPanelPack.scriptRevision.documentId,
    revisionId: firstPanelPack.scriptRevision.id,
    bodySha256: firstPanelPack.scriptRevision.bodySha256,
  };
  if (panelPacks.some((panelPack) => panelPack.scriptRevision.documentId !== script.documentId
    || panelPack.scriptRevision.id !== script.revisionId
    || panelPack.scriptRevision.bodySha256 !== script.bodySha256)) {
    throw new Error(`unit-grid ${pack.id} 内含冲突的剧本 revision 身份。`);
  }

  const bindingInputs = new Map<string, {
    fingerprint: string;
    assetReferenceCount: number;
    panelIds: string[];
  }>();
  for (const panelPack of panelPacks) {
    const binding = panelPack.assetBinding.bindingSet;
    const existing = bindingInputs.get(binding.id);
    if (existing && existing.fingerprint !== binding.fingerprint) {
      throw new Error(`unit-grid ${pack.id} 的 BindingSet ${binding.id} 指纹冲突。`);
    }
    if (existing) {
      if (!existing.panelIds.includes(panelPack.target.panelId)) existing.panelIds.push(panelPack.target.panelId);
      existing.assetReferenceCount = Math.max(existing.assetReferenceCount, panelPack.assets.length);
    } else {
      bindingInputs.set(binding.id, {
        fingerprint: binding.fingerprint,
        assetReferenceCount: panelPack.assets.length,
        panelIds: [panelPack.target.panelId],
      });
    }
  }
  const bindingSets = await Promise.all([...bindingInputs.entries()].map(async ([id, binding]) => {
    const currentness = await evaluatePackBindingCurrentness(projectRoot, id);
    return {
      id,
      fingerprint: binding.fingerprint,
      assetReferenceCount: binding.assetReferenceCount,
      panelIds: binding.panelIds,
      staleReasons: currentness.bindingSetStaleReasons,
      changeClassification: currentness.changeClassification,
    } satisfies StudioGenerationTraceBindingSetIdentity;
  }));
  const bindingSetStaleReasons = [...new Set(bindingSets.flatMap((binding) => binding.staleReasons))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const changeClassification = classifyStudioStaleReasons(bindingSetStaleReasons);
  const [runsBox, resultsPage, historicalEvidence, detachedUnknownObservations] = await Promise.all([
    collectTraceRuns(projectRoot, pack.id, TRACE_RUNS_CAP),
    listStudioGenerationResultsByPack(projectRoot, { packId: pack.id, limit: TRACE_RESULTS_CAP }),
    readStudioHistoricalGenerationEvidenceByPack(projectRoot, pack.id),
    listStudioDetachedGenerationUnknownObservations(projectRoot, { unitId: pack.target.unitId }),
  ]);
  const reviewsBox = await collectTraceReviews(projectRoot, runsBox.runs.map((run) => run.runId), TRACE_REVIEWS_CAP);
  const previousStandings = previousStandingsFromFrozenPanelPacks(panelPacks);
  const frozenPanelOverlays = frozenPanelOverlaysFromFrozenPanelPacks(panelPacks);
  const panels: StudioGenerationTracePanelIdentity[] = panelPacks.map((panelPack) => ({
    panelId: panelPack.target.panelId,
    panelIndex: panelPack.target.panelIndex,
    sourceSpans: panelPack.assetBinding.bindingSet.sourceSpans.map((span) => ({
      scriptRevisionId: span.scriptRevisionId,
      startOffsetUtf16: span.startOffsetUtf16,
      endOffsetUtf16: span.endOffsetUtf16,
      surfaceSha256: span.surfaceSha256,
    })),
  }));
  const prompts: StudioGenerationTracePromptIdentity[] = panelPacks.map((panelPack) => ({
    panelId: panelPack.target.panelId,
    documentId: panelPack.promptRevision.documentId,
    revisionId: panelPack.promptRevision.id,
    bodySha256: panelPack.promptRevision.bodySha256,
  }));
  return {
    pack: { packId: pack.id, fingerprint: pack.fingerprint, unitSnapshotFingerprint: pack.unitSnapshotFingerprint },
    target: {
      targetKind: unitGrid ? "unit-grid" : "panel",
      targetKey: unitGrid ? `unit-grid:${pack.target.unitId}` : `panel:${pack.target.unitId}:${pack.target.panelId}`,
    },
    unit: { unitId: pack.target.unitId, unitRevision: pack.target.unitRevision },
    script,
    prompt: unitGrid ? null : {
      documentId: prompts[0]!.documentId,
      revisionId: prompts[0]!.revisionId,
      bodySha256: prompts[0]!.bodySha256,
    },
    prompts,
    panel: unitGrid ? null : panels[0]!,
    panels,
    bindingSet: unitGrid ? null : {
      id: bindingSets[0]!.id,
      fingerprint: bindingSets[0]!.fingerprint,
      assetReferenceCount: bindingSets[0]!.assetReferenceCount,
    },
    bindingSets,
    continuity: {
      fingerprint: unitGrid ? pack.continuityFingerprint : pack.continuity.fingerprint,
      assetCount: panelPacks.reduce((count, panelPack) => count + panelPack.continuity.assets.length, 0),
    },
    bindingSetStaleReasons,
    changeClassification,
    runs: runsBox.runs,
    runsTruncated: runsBox.truncated,
    results: resultsPage.items.map((item) => ({
      resultId: item.resultId,
      variant: item.variant,
      mediaSha256: item.mediaSha256,
      inputCurrent: item.inputCurrent,
      storedStaleReasons: item.staleReasons,
    })),
    resultsTruncated: Boolean(resultsPage.nextCursor),
    reviews: reviewsBox.reviews,
    reviewsTruncated: reviewsBox.truncated,
    ...(historicalEvidence ? { historicalEvidence } : {}),
    ...(detachedUnknownObservations.length > 0 ? { detachedUnknownObservations } : {}),
    ...(previousStandings.length > 0 ? { previousStandings } : {}),
    ...(frozenPanelOverlays.length > 0 ? { frozenPanelOverlays } : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* 反向追溯：剧本 revision → 单元修订 → packs → runs → results                */
/* ------------------------------------------------------------------------ */

export interface StudioScriptRevisionImpactRow {
  targetKind?: "panel" | "unit-grid";
  targetKey?: string;
  panelId: string | null;
  packId: string | null;
  runId: string | null;
  resultId: string | null;
  inputCurrent: boolean | null;
  changeClassification: StudioStaleClassificationResult["classification"] | null;
}

export interface StudioScriptRevisionImpactUnit {
  unitId: string;
  unitRevision: number;
  title: string;
  panelCount: number;
  rows: StudioScriptRevisionImpactRow[];
  truncated: boolean;
}

export interface StudioScriptRevisionImpactPage {
  items: StudioScriptRevisionImpactUnit[];
  nextCursor?: string;
  /** 显式空标记：该剧本 revision 未钉到任何单元修订（合法形态）。 */
  empty: boolean;
}

/** 反向追溯（两层分页：页=单元修订 (unitId,revision) 键集；页内扇出带帽+truncated）。 */
export async function getStudioScriptRevisionImpact(
  projectRoot: string,
  query: { scriptRevisionId: string; limit?: number; cursor?: string },
): Promise<StudioScriptRevisionImpactPage> {
  // 非受管工程 fail-closed（与 Core/IPC/MCP 三口径一致；ensureProductionDirectories 不承担身份校验）。
  await inspectManagedProject(projectRoot);
  const page = await listStudioUnitRevisionsByScriptRevision(projectRoot, query);
  const items: StudioScriptRevisionImpactUnit[] = [];
  // 同一次 impact 调用内按 bindingSetId 缓存分类（一个 pack 一次 CAS+currentness 重算，有界）。
  const classificationCache = new Map<string, StudioStaleClassificationResult["classification"]>();
  for (const unitRevision of page.items) {
    const rows: StudioScriptRevisionImpactRow[] = [];
    let truncated = false;
    // F-R1-01/F-R2-01：修订过滤经 SQL 下推（不再 LIMIT 后内存过滤），目标修订 pack 不可能被挤出。
    const packs = await listStudioGenerationPacksByUnit(projectRoot, {
      unitId: unitRevision.unitId,
      unitRevision: unitRevision.revision,
      limit: IMPACT_PACKS_CAP + 1,
    });
    const revisionPacks = packs.items;
    if (revisionPacks.length > IMPACT_PACKS_CAP || packs.nextCursor) truncated = true;
    if (revisionPacks.length === 0) {
      // 从未冻结的单元修订：单元级空行（覆盖完整性声明）。
      rows.push({ panelId: null, packId: null, runId: null, resultId: null, inputCurrent: null, changeClassification: null });
    }
    for (const packIndex of revisionPacks.slice(0, IMPACT_PACKS_CAP)) {
      const classification = await impactClassification(projectRoot, packIndex, classificationCache);
      const runsPage = await listStudioGenerationRunsByPack(projectRoot, { packId: packIndex.packId, limit: IMPACT_RUNS_CAP });
      const resultsPage = await listStudioGenerationResultsByPack(projectRoot, { packId: packIndex.packId, limit: IMPACT_RESULTS_CAP });
      if (runsPage.nextCursor || resultsPage.nextCursor) truncated = true;
      const runIdsWithResults = new Set(resultsPage.items.map((result) => result.generationRunId));
      for (const result of resultsPage.items) {
        rows.push({
          targetKind: packIndex.targetKind,
          targetKey: packIndex.targetKey,
          panelId: packIndex.targetKind === "panel" ? packIndex.panelId : null,
          packId: packIndex.packId,
          runId: result.generationRunId,
          resultId: result.resultId,
          inputCurrent: result.inputCurrent,
          changeClassification: classification,
        });
      }
      for (const run of runsPage.items) {
        if (runIdsWithResults.has(run.generationRunId)) continue;
        rows.push({
          targetKind: packIndex.targetKind,
          targetKey: packIndex.targetKey,
          panelId: packIndex.targetKind === "panel" ? packIndex.panelId : null,
          packId: packIndex.packId,
          runId: run.generationRunId,
          resultId: null,
          inputCurrent: null,
          changeClassification: classification,
        });
      }
      if (runsPage.items.length === 0 && resultsPage.items.length === 0) {
        // 冻结但从未派发的 pack（packs-by-unit 导出后不再失明）。
        rows.push({
          targetKind: packIndex.targetKind,
          targetKey: packIndex.targetKey,
          panelId: packIndex.targetKind === "panel" ? packIndex.panelId : null,
          packId: packIndex.packId,
          runId: null,
          resultId: null,
          inputCurrent: null,
          changeClassification: classification,
        });
      }
    }
    items.push({
      unitId: unitRevision.unitId,
      unitRevision: unitRevision.revision,
      title: unitRevision.title,
      panelCount: unitRevision.panelCount,
      rows,
      truncated,
    });
  }
  return {
    items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    empty: page.items.length === 0,
  };
}

async function impactClassification(
  projectRoot: string,
  packIndex: StudioGenerationPackIndexRecord,
  cache: Map<string, StudioStaleClassificationResult["classification"]>,
): Promise<StudioStaleClassificationResult["classification"]> {
  const pack = await readAnyStudioGenerationFrozenPack(projectRoot, packIndex.packId);
  if (!pack) throw new StudioTraceError("pack-not-found", `impact 列举到的冻结包无法读取：${packIndex.packId}`);
  if (isUnitGridPack(pack)) {
    const cacheKey = `unit-grid:${pack.id}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const bindingSetIds = [...new Set(pack.panels.map((panel) => panel.panelPack.assetBinding.bindingSet.id))];
    const currentnesses = await Promise.all(bindingSetIds.map((bindingSetId) =>
      evaluatePackBindingCurrentness(projectRoot, bindingSetId)));
    const classification = classifyStudioStaleReasons(
      [...new Set(currentnesses.flatMap((item) => item.bindingSetStaleReasons))],
    ).classification;
    cache.set(cacheKey, classification);
    return classification;
  }
  const bindingSetId = pack.assetBinding.bindingSet.id;
  const cached = cache.get(bindingSetId);
  if (cached) return cached;
  const { changeClassification } = await evaluatePackBindingCurrentness(projectRoot, bindingSetId);
  cache.set(bindingSetId, changeClassification.classification);
  return changeClassification.classification;
}
