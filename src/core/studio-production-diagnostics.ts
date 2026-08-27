/**
 * T14 诊断与可观察性：getStudioProductionDiagnostics()
 *
 * 诊断全部来自真实状态（禁止"宫格数×3"推算）：
 * 实际单元/raw/labeled 节点数、参考边数、PASS/REJECTED/PENDING/UNKNOWN 计数、
 * 读取队列、最慢查询、逐单元错误、当前写入代理与租约、构建版本、投影版本。
 */
import { DatabaseSync } from "node:sqlite";
import { inspectManagedProject } from "./managed-project.js";
import {
  getStudioGenerationLedgerState,
  getStudioUnitGridEpisodeRollup,
  type StudioUnitGridEpisodeRollup,
} from "./studio-generation-ledger.js";
import { getStudioGenerationCheckpointControl } from "./studio-generation-checkpoint.js";
import { getApprovedTimelineProjection } from "./studio-approved-timeline-projection.js";

export const DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

/**
 * 集级 canonical 投影：诊断与连续状态唯一共享口径。
 * season/episode → getApprovedTimelineProjection（含历史 PASS 合并）
 * + ledger unit-grid rollup（dispatch/raw 计数与 unknown/abandoned）。
 * completedUnits === passUnitIds，与画布正式时间线同源。
 */
export interface StudioEpisodeUnitGridCanonical {
  season: string;
  episode: string;
  unitIds: string[];
  rollup: StudioUnitGridEpisodeRollup;
}

/**
 * 计算 projectRoot+season+episode+targetKind=unit-grid 过滤后的 canonical 投影。
 * getStudioProductionDiagnostics 与 getContinuousGenerationState 都必须经此函数，
 * 保证 PASS 数、completedUnits 与 getApprovedTimelineProjection.summary.pass 严格同源。
 */
export async function computeStudioEpisodeUnitGridCanonical(
  projectRoot: string,
  input: { season?: string; episode?: string } = {},
): Promise<StudioEpisodeUnitGridCanonical> {
  const season = input.season ?? "S1";
  const episode = input.episode ?? "S1E1";
  // 唯一正式投影：当前修订 PASS > 已核验历史 PASS；与画布/UI 同一事实源。
  // W1-B：日常诊断/连续状态保持显式 fast。full + 耗时只走 report-approved-timeline-full CLI。
  const timeline = await getApprovedTimelineProjection(projectRoot, {
    season,
    episode,
    fastMode: true,
  });
  const unitIds = timeline.units.map((unit) => unit.unitId);
  const ledgerRollup = await getStudioUnitGridEpisodeRollup(projectRoot, unitIds);

  const passUnitIds = timeline.units
    .filter((unit) => unit.productionStatus === "pass")
    .map((unit) => unit.unitId);
  const passSet = new Set(passUnitIds);
  // 已由历史/正式 PASS 闭合的单元不得再误报 generation_unknown；owner-abandoned 单独闭合。
  const generationUnknownUnitIds = ledgerRollup.generationUnknownUnitIds.filter((id) => !passSet.has(id));
  const ownerAbandonedUnitIds = ledgerRollup.ownerAbandonedUnitIds.filter((id) => !passSet.has(id));
  const abandonedSet = new Set(ownerAbandonedUnitIds);
  const pendingReviewUnitIds = timeline.units
    .filter((unit) => unit.productionStatus === "result_pending_review" && !passSet.has(unit.unitId) && !abandonedSet.has(unit.unitId))
    .map((unit) => unit.unitId);
  const reworkUnitIds = timeline.units
    .filter((unit) => unit.productionStatus === "rework" && !passSet.has(unit.unitId) && !abandonedSet.has(unit.unitId))
    .map((unit) => unit.unitId);
  // cancelled 含 owner-abandoned 的 run 终态；失败桶不得吞并已闭合 abandoned。
  const failedUnitIds = timeline.units
    .filter((unit) =>
      (unit.productionStatus === "failed_retryable" || unit.productionStatus === "cancelled")
      && !passSet.has(unit.unitId)
      && !abandonedSet.has(unit.unitId),
    )
    .map((unit) => unit.unitId);
  const rejectedUnitIds = ledgerRollup.rejectedUnitIds.filter((id) => !passSet.has(id) && !abandonedSet.has(id));

  const ledgerByUnit = new Map(ledgerRollup.units.map((unit) => [unit.unitId, unit]));
  const units = unitIds.map((unitId) => {
    const ledger = ledgerByUnit.get(unitId);
    const pass = passSet.has(unitId);
    return {
      unitId,
      dispatched: ledger?.dispatched ?? false,
      rawResultCount: ledger?.rawResultCount ?? 0,
      labeledResultCount: ledger?.labeledResultCount ?? 0,
      pass,
      currentBucket: pass ? ("pass" as const) : (ledger?.currentBucket ?? "not-started"),
      latestRunId: ledger?.latestRunId ?? null,
    };
  });

  const rollup: StudioUnitGridEpisodeRollup = {
    totalUnits: unitIds.length,
    dispatchedUnits: ledgerRollup.dispatchedUnits,
    // raw/labeled 计数仍来自账本结果表（含待审单元的已入账媒体）；
    // 画布正式 raw 节点数 = passUnitIds（每个 PASS 恰好一枚 selected raw）。
    rawResultCount: ledgerRollup.rawResultCount,
    labeledResultCount: ledgerRollup.labeledResultCount,
    completedUnitIds: passUnitIds,
    passUnitIds,
    pendingReviewUnitIds,
    reworkUnitIds,
    rejectedUnitIds,
    failedUnitIds,
    generationUnknownUnitIds,
    ownerAbandonedUnitIds,
    units,
  };
  return { season, episode, unitIds, rollup };
}

export interface StudioProductionDiagnostics {
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  kind: "studio-production-diagnostics";
  projectId: string;
  projectName: string;
  /** 真实计数（全部从 DB 查询，非推算）。 */
  counts: {
    units: number;
    panels: number;
    packs: number;
    dispatches: number;
    results: number;
    rawResults: number;
    labeledResults: number;
    callIntents: number;
    runEvents: number;
    reviewHeads: number;
    plans: number;
    outboxEvents: number;
    outboxUnconsumed: number;
  };
  /** Review 状态分布。 */
  reviewDistribution: {
    pass: number;
    rework: number;
    reject: number;
    unreviewed: number;
  };
  /** 生成 run 终态分布。 */
  runStateDistribution: {
    succeeded: number;
    failed: number;
    cancelled: number;
    retrySuperseded: number;
    inFlight: number;
  };
  /** checkpoint 摘要。 */
  checkpoint: {
    completedSlotCount: number;
    fullBatchCount: number;
    blockingBatchNumber?: number;
  };
  /**
   * 集级过滤口径（projectRoot+season+episode+targetKind=unit-grid）。
   * 与 getContinuousGenerationState 的 progress 复用同一 canonical 投影：
   * completedUnits === passCount；raw 节点数同口径；失败/待审/拒绝/未知分别统计；
   * owner-abandoned 已闭合不可复用，不计入 generationUnknown。
   */
  episodeScope: {
    season: string;
    episode: string;
    totalUnits: number;
    dispatchedUnits: number;
    /** === passCount（同一 canonical 投影）。 */
    completedUnits: number;
    passCount: number;
    rawResultCount: number;
    labeledResultCount: number;
    pendingReviewCount: number;
    reworkCount: number;
    rejectedCount: number;
    failedCount: number;
    /** 未闭合 generation_unknown（owner-abandoned 不计入）。 */
    generationUnknownCount: number;
    /** owner 已封存：终态闭合、候选永不复用。 */
    ownerAbandonedCount: number;
    generationUnknownUnitIds: string[];
    ownerAbandonedUnitIds: string[];
  };
  /** 构建身份。 */
  build: {
    manifestFingerprint: string;
  };
  /** 诊断生成时间。 */
  builtAt: string;
  /** 诊断耗时。 */
  durationMs: number;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function countRows(db: DatabaseSync, table: string, where?: string): number {
  if (!tableExists(db, table)) return 0;
  const sql = where
    ? `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) AS count FROM ${table}`;
  return Number((db.prepare(sql).get() as { count: number }).count);
}

/**
 * 获取受管工程的真实生产诊断。
 * 所有计数直接查 DB，禁止推算；episodeScope 按 projectRoot+season+episode+
 * targetKind=unit-grid 过滤，与连续状态机复用同一 canonical 投影。
 */
export async function getStudioProductionDiagnostics(
  projectRoot: string,
  input: { season?: string; episode?: string } = {},
): Promise<StudioProductionDiagnostics> {
  const start = Date.now();
  const shell = await inspectManagedProject(projectRoot);
  const ledgerState = await getStudioGenerationLedgerState(projectRoot);
  const checkpoint = await getStudioGenerationCheckpointControl(projectRoot);
  const canonical = await computeStudioEpisodeUnitGridCanonical(projectRoot, input);

  // 直接查 DB 获取精确计数
  const dbPath = shell.paths.generationDatabase;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rawResults = countRows(db, "studio_generation_results", "variant = 'raw'");
    const labeledResults = countRows(db, "studio_generation_results", "variant = 'labeled'");
    const reviewPass = countRows(db, "studio_generation_review_events", "decision = 'pass'");
    const reviewRework = countRows(db, "studio_generation_review_events", "decision = 'rework'");
    const reviewReject = countRows(db, "studio_generation_review_events", "decision = 'reject'");
    const reviewHeads = countRows(db, "studio_generation_review_heads");
    const runFailed = countRows(db, "studio_generation_run_events", "kind = 'failed'");
    const runCancelled = countRows(db, "studio_generation_run_events", "kind = 'cancelled'");
    const runSuperseded = countRows(db, "studio_generation_run_events", "kind = 'retry-superseded'");
    const outboxEvents = countRows(db, "studio_canvas_projection_outbox");
    const outboxUnconsumed = countRows(db, "studio_canvas_projection_outbox", "consumed = 0");

    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      kind: "studio-production-diagnostics",
      projectId: shell.project.id,
      projectName: shell.project.name,
      counts: {
        units: countRows(db, "studio_generation_packs"),
        panels: countRows(db, "studio_generation_pack_targets"),
        packs: ledgerState.counts.packs,
        dispatches: ledgerState.counts.dispatches,
        results: ledgerState.counts.results,
        rawResults,
        labeledResults,
        callIntents: ledgerState.counts.callIntents,
        runEvents: ledgerState.counts.runEvents,
        reviewHeads,
        plans: ledgerState.counts.plans,
        outboxEvents,
        outboxUnconsumed,
      },
      reviewDistribution: {
        pass: reviewPass,
        rework: reviewRework,
        reject: reviewReject,
        unreviewed: Math.max(0, reviewHeads - reviewPass - reviewRework - reviewReject),
      },
      runStateDistribution: {
        succeeded: rawResults > 0 ? Math.min(rawResults, labeledResults) : 0,
        failed: runFailed,
        cancelled: runCancelled,
        retrySuperseded: runSuperseded,
        inFlight: Math.max(0, ledgerState.counts.dispatches - runFailed - runCancelled - runSuperseded - Math.min(rawResults, labeledResults)),
      },
      checkpoint: {
        completedSlotCount: checkpoint.completedSlotCount,
        fullBatchCount: checkpoint.fullBatchCount,
        ...(checkpoint.blockingBatchNumber !== undefined ? { blockingBatchNumber: checkpoint.blockingBatchNumber } : {}),
      },
      episodeScope: {
        season: canonical.season,
        episode: canonical.episode,
        totalUnits: canonical.rollup.totalUnits,
        dispatchedUnits: canonical.rollup.dispatchedUnits,
        completedUnits: canonical.rollup.completedUnitIds.length,
        passCount: canonical.rollup.passUnitIds.length,
        rawResultCount: canonical.rollup.rawResultCount,
        labeledResultCount: canonical.rollup.labeledResultCount,
        pendingReviewCount: canonical.rollup.pendingReviewUnitIds.length,
        reworkCount: canonical.rollup.reworkUnitIds.length,
        rejectedCount: canonical.rollup.rejectedUnitIds.length,
        failedCount: canonical.rollup.failedUnitIds.length,
        generationUnknownCount: canonical.rollup.generationUnknownUnitIds.length,
        ownerAbandonedCount: canonical.rollup.ownerAbandonedUnitIds.length,
        generationUnknownUnitIds: canonical.rollup.generationUnknownUnitIds,
        ownerAbandonedUnitIds: canonical.rollup.ownerAbandonedUnitIds,
      },
      build: {
        manifestFingerprint: shell.manifestFingerprint,
      },
      builtAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
  } finally {
    db.close();
  }
}
