/**
 * T9 核心批量正式时间线投影：getApprovedTimelineProjection()
 *
 * 单次快照返回一集所有单元的生产状态与正式结果选择。
 * 禁止前端 N 次循环查询；核心返回已闭合结果。
 * 选择规则同 T5 deriveGenerationTargetState：
 * - 当前修订 PASS > 已核验历史 PASS > REJECTED/PENDING/UNKNOWN 仅警告
 * - 候选永不覆盖 PASS；旧 PASS 被修订失效显示"已过期"不得消失
 *
 * 历史 PASS 合并（真实缺口修复）：
 * - 历史导入读取走 studio-generation-historical-imports-read.ts（单次只读快照，无 N+1）；
 * - 正式 run PASS 优先；无正式 PASS 时，已核验历史 PASS 提升为正式结果（来源可追溯）；
 * - 历史候选未通过闭合核验时不提升，仅在 candidateWarning 如实说明失败项。
 */
import { inspectManagedProject } from "./managed-project.js";
import { listStudioProductionUnits } from "./studio-production.js";
import {
  listStudioGenerationLatestUnitGridRuns,
  type StudioGenerationActiveRunProjection,
  type StudioGenerationApprovedResultIdentity,
} from "./studio-generation-ledger.js";
import { deriveGenerationTargetState, type GenerationTargetState } from "./studio-generation-target-state.js";
import { buildUnitDisplayIdentity } from "./studio-unit-display-identity.js";
import { readStudioGenerationProjectionSelectionFacts } from "./studio-generation-historical-imports-read.js";

export const APPROVED_TIMELINE_SCHEMA_VERSION = 1 as const;

/** 正式结果的选中来源。 */
export type ApprovedTimelineSelectedResultSource = "generation-run" | "historical-import";

/** 选中结果的参考闭包核验状态。 */
export type ApprovedTimelineReferenceClosureStatus =
  /** 历史来源且全部可实现闭合项核验通过。 */
  | "complete"
  /** 历史候选存在但闭合核验未通过（未选中，详见 candidateWarning）。 */
  | "failed"
  /** 正式 run 来源（闭包由账本审查闭环保证，投影层不复算）或无历史候选。 */
  | "not-applicable";

/** 单个单元的时间线投影。 */
export interface ApprovedTimelineUnitProjection {
  unitId: string;
  /** 显示序号（1-based，集内顺序）。 */
  displaySequence: number;
  /** 双编号标签：`029｜S1E01-U28` 格式（经 buildUnitDisplayIdentity，fullLabel 以权威 unitId 为准）。 */
  displayLabel: string;
  title: string;
  /** 归约器状态（含历史 PASS 合并后的最终状态）。 */
  productionStatus: GenerationTargetState;
  /** 正式选中的 raw SHA（generation-run 为最新 PASS run，historical-import 为历史导入证据）。 */
  selectedRawSha256: string | null;
  /** 正式选中的 labeled SHA。 */
  selectedLabeledSha256: string | null;
  /** 正式结果的选中来源（未选中任何结果为 null）。 */
  selectedResultSource: ApprovedTimelineSelectedResultSource | null;
  /** 选中的历史导入 importId（仅 selectedResultSource="historical-import" 时非 null）。 */
  historicalImportId: string | null;
  /** 选中结果所属 generationRunId（仅 selectedResultSource="generation-run" 时非 null）。 */
  selectedGenerationRunId: string | null;
  /** 选中结果的冻结包 fingerprint（run 来源取 dispatch 登记，历史来源取 import 行）。 */
  selectedPackFingerprint: string | null;
  /**
   * 同一 SQLite 快照闭合的当前 PASS 执行身份（仅 generation-run 来源）。
   * null 表示批量核验未闭合；消费端必须失败关闭或走兼容核验，不得补猜。
   */
  selectedRunExecutionIdentity: StudioGenerationApprovedResultIdentity | null;
  /** 最新 run 的 generationRunId（与选中无关，无 run 为 null）。 */
  latestRunId: string | null;
  /** 最新 run 的 Review 状态（无 run 为 null；历史 PASS 选中时不冒充 run 审查）。 */
  reviewStatus: string | null;
  /** 宫格数量。 */
  panelCount: number;
  /** 选中结果的参考闭包核验状态。 */
  referenceClosureStatus: ApprovedTimelineReferenceClosureStatus;
  /** 候选警告（如旧 PASS 被修订失效、run 未 PASS 而取历史 PASS、历史核验失败）。 */
  candidateWarning: string | null;
  /** 投影过程中的错误（单单元失败不影响其他）。 */
  projectionError: string | null;
}

export interface ApprovedTimelineProjection {
  schemaVersion: typeof APPROVED_TIMELINE_SCHEMA_VERSION;
  kind: "studio-approved-timeline-projection";
  projectId: string;
  season: string;
  episode: string;
  unitCount: number;
  /** 按 displaySequence 排序的单元投影。 */
  units: ApprovedTimelineUnitProjection[];
  /** 统计摘要。 */
  summary: {
    pass: number;
    pendingReview: number;
    inProgress: number;
    failed: number;
    blocked: number;
  };
  builtAt: string;
  /** 解析后的快慢开关（省略 query.fastMode 时为 true）。 */
  fastMode: boolean;
  /** 本次投影墙钟耗时（毫秒），供诊断/CLI 提示。 */
  durationMs: number;
  /** 是否应用了 unitIds/limit 有界查询（省略则为整集）。 */
  bounded: boolean;
}

/**
 * 双编号标签：统一经 buildUnitDisplayIdentity 生成。
 * unitId 即生产库/账本权威全编号（如 `S1E01-U28`）；查询 episode（如 `S1E1`）只是过滤条件，
 * 格式未必规范，故从 unitId 解析集号前缀，避免拼出 `S1E1-U28` 这类非规范编号。
 * identity 的 fullLabel 由 episode+0 基索引重组（U 后不补零），与权威 unitId 不一致时
 * （如 `S1E01-U08` 的补零差异）以 unitId 为准。
 */
function resolveUnitDisplayLabel(unitId: string, sequence: number, episode: string): string {
  const match = /^(.+)-U(\d+)$/u.exec(unitId);
  const episodePrefix = match && Number(match[2]) === sequence - 1 ? match[1] : episode;
  const identity = buildUnitDisplayIdentity({ unitId, sequence, episode: episodePrefix });
  return identity.fullLabel === unitId ? identity.displayLabel : `${identity.sequenceLabel}｜${unitId}`;
}

/** 第一遍状态推导结果（单单元失败先记错误，第二遍统一装配）。 */
interface DerivedUnitState {
  state: GenerationTargetState;
  latestRun: StudioGenerationActiveRunProjection | undefined;
  error: string | null;
}

/** 画布一页上限；有界查询不得超过此数。 */
export const APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT = 36;

/** 时间线投影查询。省略 `fastMode` 视为 true（产品默认快路径）。 */
export type ApprovedTimelineProjectionQuery = {
  season?: string;
  episode?: string;
  fastMode?: boolean;
  /** 只投影这些单元（须同季同集已存在）。上限 36。省略则整集。 */
  unitIds?: string[];
  /** 无 unitIds 时按集内顺序截断。上限 36。 */
  limit?: number;
};

export type ApprovedTimelineBound = {
  unitIds?: string[];
  limit?: number;
};

/**
 * 解析有界投影。省略 unitIds/limit → 整集。
 * 空数组 / 超 36 / 非正 limit 失败关闭，禁止静默整集。
 */
export function resolveApprovedTimelineBound(
  query: Pick<ApprovedTimelineProjectionQuery, "unitIds" | "limit"> | undefined,
): ApprovedTimelineBound {
  const unitIds = query?.unitIds;
  const limit = query?.limit;
  if (unitIds !== undefined) {
    if (!Array.isArray(unitIds) || unitIds.length === 0) {
      throw new Error("unitIds 必须是非空数组；省略该字段才表示整集。");
    }
    const unique = [...new Set(unitIds.map((id) => {
      if (typeof id !== "string" || id.trim() === "") throw new Error("unitIds 含空标识。");
      return id;
    }))];
    if (unique.length > APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT) {
      throw new Error(`unitIds 最多 ${APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT} 项。`);
    }
    return { unitIds: unique };
  }
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT) {
      throw new Error(`limit 必须是 1–${APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT} 的整数。`);
    }
    return { limit };
  }
  return {};
}

/**
 * 解析时间线投影快慢开关。
 * 省略或 undefined → true；仅显式 `false` 走 full（绑定就绪 / deriveGenerationTargetState）。
 */
export function resolveApprovedTimelineFastMode(
  query: Pick<ApprovedTimelineProjectionQuery, "fastMode"> | undefined,
): boolean {
  return query?.fastMode ?? true;
}

/**
 * 批量获取一集所有单元的正式时间线投影。
 * 使用 deriveGenerationTargetState 归约器确保状态一致性。
 * 性能优化：fastMode（默认 true）跳过绑定就绪查询（仅从账本推导状态）；
 * 最新 run、历史 PASS 候选与宫格数均循环外一次取齐（单次只读连接 + 列表行 panel_count），无 N+1 开库。
 * full 仅显式 `fastMode: false`（CLI `report-approved-timeline-full`）。日常诊断/canonical 保持 `true`。
 */
export async function getApprovedTimelineProjection(
  projectRoot: string,
  query: ApprovedTimelineProjectionQuery,
): Promise<ApprovedTimelineProjection> {
  const startedAt = Date.now();
  const shell = await inspectManagedProject(projectRoot);
  const season = query.season ?? "S1";
  const episode = query.episode ?? "S1E1";
  const bound = resolveApprovedTimelineBound(query);
  const wantedIds = bound.unitIds ? new Set(bound.unitIds) : undefined;

  // 1. 批量获取单元（单页最多 50）。省略 bound 则翻页至全量；
  //    有 unitIds/limit 时凑齐即停，不把未请求的单元送进后续账本批读。
  const unitSummaries: Array<{ id: string; sequence: number; title: string; revision: number; panelCount: number }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const batch = await listStudioProductionUnits(projectRoot, {
      season,
      episode,
      limit: 50,
      cursor,
    });
    for (const item of batch.items) {
      unitSummaries.push({ id: item.id, sequence: item.sequence, title: item.title, revision: item.revision, panelCount: item.panelCount });
    }
    if (wantedIds && unitSummaries.filter((unit) => wantedIds.has(unit.id)).length >= wantedIds.size) break;
    if (bound.limit !== undefined && unitSummaries.length >= bound.limit) break;
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
  unitSummaries.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const boundedSummaries = wantedIds
    ? unitSummaries.filter((unit) => wantedIds.has(unit.id))
    : bound.limit !== undefined
      ? unitSummaries.slice(0, bound.limit)
      : unitSummaries;

  // 2. 循环外一次取齐全部单元的最新 unit-grid run（单次只读连接，消除 N+1 串行开库）；
  //    同批带回最新 run 成对结果的 raw/labeled 媒体 SHA，供正式 SHA 填充。
  const latestUnitGridRuns = await listStudioGenerationLatestUnitGridRuns(
    projectRoot,
    boundedSummaries.map((unit) => unit.id),
  );
  const latestRunByUnit = new Map(latestUnitGridRuns.map((entry) => [entry.unitId, entry]));

  // 3. 先批量读取历史 PASS。fullMode 遇到“无正式 run + 已核验历史 PASS”时可直接
  // 跳过昂贵 freeze/readiness；最终仍由第二遍的历史选择规则提升为 PASS。
  const historicalSelectionFacts = await readStudioGenerationProjectionSelectionFacts(projectRoot, {
    units: boundedSummaries.map((unit) => ({ unitId: unit.id, revision: unit.revision })),
    generationRunIds: [],
  });

  // 4. 第一遍：逐单元推导状态（单单元失败不影响其他）
  const fastMode = resolveApprovedTimelineFastMode(query);
  const derivedByUnit = new Map<string, DerivedUnitState>();
  for (const unit of boundedSummaries) {
    try {
      if (fastMode) {
        // 快速模式：仅从账本推导状态（跳过绑定就绪查询，性能从 45s 降到 <3s）
        // 最新 run 来自循环外批量查询（与单项版 listStudioGenerationActiveRuns runs[0] 同口径）
        const latestRun = latestRunByUnit.get(unit.id)?.latestRun ?? undefined;
        let derivedState: GenerationTargetState;
        if (!latestRun) {
          derivedState = "ready_to_freeze";
        } else if (!latestRun.terminal) {
          derivedState = latestRun.callStatus === "generation_unknown" ? "generation_unknown" : "dispatched_no_call";
        } else if (latestRun.hasResultPair) {
          derivedState = latestRun.reviewStatus === "pass" ? "pass"
            : latestRun.reviewStatus === "rework" ? "rework" : "result_pending_review";
        } else if (latestRun.latestEventKind === "failed") {
          derivedState = "failed_retryable";
        } else if (latestRun.latestEventKind === "cancelled") {
          derivedState = "cancelled";
        } else {
          derivedState = "ready_to_dispatch";
        }
        derivedByUnit.set(unit.id, { state: derivedState, latestRun, error: null });
      } else {
        const latestRun = latestRunByUnit.get(unit.id)?.latestRun ?? undefined;
        const historical = historicalSelectionFacts.historicalPassByUnit.get(unit.id);
        if (!latestRun && historical?.verified) {
          // 历史 PASS 的修订、pack、raw/labeled 和参考闭包已经由批量只读事实核验；
          // 此处不得再为同一单元逐格构建 freeze pack。
          derivedByUnit.set(unit.id, { state: "ready_to_freeze", latestRun: undefined, error: null });
          continue;
        }
        const projection = await deriveGenerationTargetState(projectRoot, {
          unitId: unit.id,
          targetKind: "unit-grid",
        });
        derivedByUnit.set(unit.id, { state: projection.state, latestRun: projection.latestRun, error: null });
      }
    } catch (error) {
      derivedByUnit.set(unit.id, {
        state: "binding_blocked",
        latestRun: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 5. 循环外一次取齐正式 run 的 pack fingerprint；历史 PASS 已在推导前批量读取。
  //    表/库不存在返回空事实（老库防御）；账本损坏等整体失败向外抛出，不静默退化为"无历史 PASS"。
  const snapshotApprovedRunIds = new Set(latestUnitGridRuns.flatMap((entry) => (
    entry.approvedResultIdentity ? [entry.approvedResultIdentity.generationRunId] : []
  )));
  const formalPassRunIds = boundedSummaries
    .map((unit) => derivedByUnit.get(unit.id))
    .filter((derived): derived is DerivedUnitState => Boolean(
      derived && !derived.error && derived.state === "pass" && derived.latestRun?.hasResultPair,
    ))
    .map((derived) => derived.latestRun!.generationRunId)
    .filter((runId) => !snapshotApprovedRunIds.has(runId));
  const formalSelectionFacts = await readStudioGenerationProjectionSelectionFacts(projectRoot, {
    units: [],
    generationRunIds: formalPassRunIds,
  });
  const selectionFacts = {
    historicalPassByUnit: historicalSelectionFacts.historicalPassByUnit,
    packFingerprintByRunId: formalSelectionFacts.packFingerprintByRunId,
  };

  // 6. 第二遍：装配投影条目（选择优先级：当前修订正式 run PASS > 已核验历史 PASS > 仅警告）
  const units: ApprovedTimelineUnitProjection[] = [];
  const summary = { pass: 0, pendingReview: 0, inProgress: 0, failed: 0, blocked: 0 };

  for (const unit of boundedSummaries) {
    const derived = derivedByUnit.get(unit.id)!;
    const displayLabel = resolveUnitDisplayLabel(unit.id, unit.sequence, episode);
    if (derived.error !== null) {
      // 单单元失败不影响其他
      units.push({
        unitId: unit.id,
        displaySequence: unit.sequence,
        displayLabel,
        title: unit.title,
        productionStatus: "binding_blocked",
        selectedRawSha256: null,
        selectedLabeledSha256: null,
        selectedResultSource: null,
        historicalImportId: null,
        selectedGenerationRunId: null,
        selectedPackFingerprint: null,
        selectedRunExecutionIdentity: null,
        latestRunId: null,
        reviewStatus: null,
        panelCount: 0,
        referenceClosureStatus: "not-applicable",
        candidateWarning: null,
        projectionError: derived.error,
      });
      summary.blocked++;
      continue;
    }

    const historical = selectionFacts.historicalPassByUnit.get(unit.id);
    let productionStatus = derived.state;
    let selectedRawSha256: string | null = null;
    let selectedLabeledSha256: string | null = null;
    let selectedResultSource: ApprovedTimelineSelectedResultSource | null = null;
    let historicalImportId: string | null = null;
    let selectedGenerationRunId: string | null = null;
    let selectedPackFingerprint: string | null = null;
    let selectedRunExecutionIdentity: StudioGenerationApprovedResultIdentity | null = null;
    let referenceClosureStatus: ApprovedTimelineReferenceClosureStatus = "not-applicable";
    let candidateWarning: string | null = null;

    const latestRunId = derived.latestRun?.generationRunId ?? null;
    const reviewStatus = derived.latestRun?.reviewStatus ?? null;

    if (derived.state === "pass" && derived.latestRun?.hasResultPair) {
      // 当前修订正式 run PASS：最高优先级
      selectedResultSource = "generation-run";
      selectedGenerationRunId = derived.latestRun.generationRunId;
      const batchEntry = latestRunByUnit.get(unit.id);
      selectedRunExecutionIdentity = batchEntry?.latestRun?.generationRunId === selectedGenerationRunId
        ? batchEntry.approvedResultIdentity
        : null;
      selectedPackFingerprint = selectedRunExecutionIdentity?.packFingerprint
        ?? selectionFacts.packFingerprintByRunId.get(selectedGenerationRunId)
        ?? null;
      // 只有 PASS 状态的 run 才选为正式结果
      // 真实 SHA 由批量查询随最新 run 一并取回；取不到置 null，禁止占位字符串
      if (batchEntry?.latestRun?.generationRunId === selectedGenerationRunId) {
        selectedRawSha256 = batchEntry.rawMediaSha256;
        selectedLabeledSha256 = batchEntry.labeledMediaSha256;
      }
    } else if (historical?.verified) {
      // 已核验历史 PASS：次优选中；run 侧 REWORK/PENDING/UNKNOWN 等仅警告
      productionStatus = "pass";
      selectedResultSource = "historical-import";
      historicalImportId = historical.importId;
      selectedPackFingerprint = historical.packFingerprint;
      selectedRawSha256 = historical.rawMediaSha256;
      selectedLabeledSha256 = historical.labeledMediaSha256;
      referenceClosureStatus = "complete";
      if (derived.state === "rework" || derived.state === "result_pending_review"
        || derived.state === "generation_unknown" || derived.state === "failed_retryable") {
        candidateWarning = `最新 run ${latestRunId ?? "未知"} 未 PASS（${derived.state}），正式结果取自已核验历史 PASS`;
      }
    } else {
      // 无可用正式结果：历史候选核验失败如实警告；run 侧候选警告保持既有语义
      if (historical && !historical.verified) {
        referenceClosureStatus = "failed";
        candidateWarning = `历史 PASS 未通过闭合核验：${historical.verificationFailures.join("；")}`;
      }
      if (derived.state === "rework") {
        candidateWarning = candidateWarning
          ? `${candidateWarning}；最新 Review 为返工；旧结果仍存在但非正式`
          : "最新 Review 为返工；旧结果仍存在但非正式";
      }
    }

    units.push({
      unitId: unit.id,
      displaySequence: unit.sequence,
      displayLabel,
      title: unit.title,
      productionStatus,
      selectedRawSha256,
      selectedLabeledSha256,
      selectedResultSource,
      historicalImportId,
      selectedGenerationRunId,
      selectedPackFingerprint,
      selectedRunExecutionIdentity,
      latestRunId,
      reviewStatus,
      // 宫格数量直接取列表行 panel_count（不再逐单元开库取 snapshot）
      panelCount: unit.panelCount,
      referenceClosureStatus,
      candidateWarning,
      projectionError: null,
    });

    // 统计（按合并后的最终状态计数）
    switch (productionStatus) {
      case "pass": summary.pass++; break;
      case "result_pending_review": summary.pendingReview++; break;
      case "dispatched_no_call": case "generation_unknown": case "ready_to_dispatch": case "ready_to_freeze": case "ready_to_plan":
        summary.inProgress++; break;
      case "failed_retryable": case "cancelled": summary.failed++; break;
      case "binding_blocked": case "rework": summary.blocked++; break;
    }
  }

  return {
    schemaVersion: APPROVED_TIMELINE_SCHEMA_VERSION,
    kind: "studio-approved-timeline-projection",
    projectId: shell.project.id,
    season,
    episode,
    unitCount: units.length,
    units,
    summary,
    builtAt: new Date().toISOString(),
    fastMode,
    durationMs: Date.now() - startedAt,
    bounded: wantedIds !== undefined || bound.limit !== undefined,
  };
}
