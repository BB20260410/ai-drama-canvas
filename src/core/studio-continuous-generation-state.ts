/**
 * T19 画布驱动持续生图状态机。
 *
 * 严格生命周期：
 * SELECT_NEXT_UNIT → PREFLIGHT → FREEZE_PACK → DISPATCH_ONCE
 * → GENERATION_UNKNOWN/PENDING → INGEST_RESULT → ORIGINAL_SIZE_REVIEW
 * → PASS/REJECTED → UPDATE_CANVAS → NEXT_UNIT
 *
 * PREFLIGHT 检查：时间线下一个单元、身份锁 SHA、场景/道具/风格参考、
 * 上一镜结束状态、UNKNOWN 调用、REJECTED 冲突、写租约、幂等键。
 * UI 每状态唯一合法主动作；禁止用户手抄 runId/packId/SHA/leaseToken。
 */
import { inspectManagedProject } from "./managed-project.js";
import { getStudioEpisodeEarliest } from "./studio-episode-earliest.js";
import { getStudioProjectWriteLease } from "./studio-project-write-lease.js";
import { deriveGenerationTargetState, type GenerationTargetState } from "./studio-generation-target-state.js";
import { listStudioGenerationActiveRuns } from "./studio-generation-ledger.js";
import { computeStudioEpisodeUnitGridCanonical } from "./studio-production-diagnostics.js";

export const CONTINUOUS_GENERATION_SCHEMA_VERSION = 1 as const;

/** 状态机阶段枚举。 */
export type ContinuousGenerationPhase =
  | "idle"
  | "select_next_unit"
  | "preflight"
  | "freeze_pack"
  | "dispatch_once"
  | "generation_pending"
  | "generation_unknown"
  | "ingest_result"
  | "original_size_review"
  | "pass"
  | "rejected"
  | "update_canvas"
  | "next_unit";

/** PREFLIGHT 检查项结果。 */
export interface PreflightCheckResult {
  code: string;
  passed: boolean;
  message: string;
}

/** 状态机当前状态投影。 */
export interface ContinuousGenerationStateProjection {
  schemaVersion: typeof CONTINUOUS_GENERATION_SCHEMA_VERSION;
  kind: "studio-continuous-generation-state";
  projectId: string;
  /** 当前阶段。 */
  phase: ContinuousGenerationPhase;
  /** 当前焦点单元。 */
  focusUnitId: string | null;
  /** 当前焦点单元的生成状态。 */
  focusUnitState: GenerationTargetState | null;
  /** PREFLIGHT 检查结果（仅在 preflight 阶段有）。 */
  preflightChecks: PreflightCheckResult[];
  /** 当前阶段唯一合法主动作。 */
  primaryAction: {
    code: string;
    label: string;
    command?: string;
    requiresWrite: boolean;
  };
  /** 阻断信息（若有）。 */
  blocking: {
    blocked: boolean;
    reason: string | null;
    recoveryAction: string | null;
  };
  /** 写租约状态摘要。 */
  writeLease: {
    held: boolean;
    holderKind: string | null;
    expired: boolean;
  };
  /** 进度摘要（与诊断复用同一 canonical 投影：completedUnits === PASS 数）。 */
  progress: {
    totalUnits: number;
    /** 合并历史 PASS 的完成单元数（canonical 投影口径）。 */
    completedUnits: number;
    /** 当前 head 仍为 PASS 的单元数。 */
    passUnits: number;
    /** owner 已封存（闭合不可复用）的单元数；不计入 generation_unknown。 */
    ownerAbandonedUnits: number;
    currentUnitSequence: number | null;
  };
  builtAt: string;
}

/**
 * 从阶段和单元状态推导唯一合法主动作。
 */
function derivePrimaryAction(
  phase: ContinuousGenerationPhase,
  unitState: GenerationTargetState | null,
): ContinuousGenerationStateProjection["primaryAction"] {
  switch (phase) {
    case "idle":
    case "select_next_unit":
      return { code: "select-next", label: "选择时间线下一个单元", requiresWrite: false };
    case "preflight":
      return { code: "run-preflight", label: "执行预检", requiresWrite: false };
    case "freeze_pack":
      return { code: "freeze", label: "冻结生成包", command: "freeze_studio_generation_pack", requiresWrite: true };
    case "dispatch_once":
      return { code: "dispatch", label: "派发生成（单次）", command: "dispatch_studio_generation_pack", requiresWrite: true };
    case "generation_pending":
      return { code: "await-result", label: "等待结果登记", requiresWrite: false };
    case "generation_unknown":
      return { code: "reconcile", label: "对账或放弃未知调用", command: "reconcile_studio_imagegen_call", requiresWrite: true };
    case "ingest_result":
      return { code: "commit-result", label: "原子入账结果", command: "commit_agent_imagegen_result_bundle", requiresWrite: true };
    case "original_size_review":
      return { code: "submit-review", label: "提交原尺寸审片", command: "submit_studio_generation_review", requiresWrite: true };
    case "pass":
    case "update_canvas":
      return { code: "next-unit", label: "更新画布并进入下一单元", requiresWrite: false };
    case "rejected":
      return { code: "rework", label: "返工：继承约束重新生成", command: "retry_studio_generation_plan_nodes", requiresWrite: true };
    case "next_unit":
      return { code: "continue", label: "继续下一单元", requiresWrite: false };
    default:
      return { code: "idle", label: "空闲", requiresWrite: false };
  }
}

/**
 * 从单元生成状态推导状态机阶段。
 */
function phaseFromUnitState(state: GenerationTargetState): ContinuousGenerationPhase {
  switch (state) {
    case "binding_blocked": return "preflight";
    case "ready_to_freeze": return "freeze_pack";
    case "ready_to_plan":
    case "ready_to_dispatch": return "dispatch_once";
    case "dispatched_no_call": return "generation_pending";
    case "generation_unknown": return "generation_unknown";
    case "result_pending_review": return "original_size_review";
    case "pass": return "pass";
    case "rework": return "rejected";
    case "failed_retryable": return "dispatch_once";
    case "cancelled": return "dispatch_once";
    default: return "idle";
  }
}

/**
 * 获取持续生图状态机的当前投影。
 * Agent 丢失本地 state 后仅凭此即可恢复完整生产位置。
 */
export async function getContinuousGenerationState(
  projectRoot: string,
  input: { season?: string; episode?: string } = {},
): Promise<ContinuousGenerationStateProjection> {
  const shell = await inspectManagedProject(projectRoot);
  const season = input.season ?? "S1";
  const episode = input.episode ?? "S1E1";

  // 获取 earliest（下一个待完成单元）
  const earliest = await getStudioEpisodeEarliest(projectRoot, { season, episode });
  const focusUnitId = earliest.earliestUnitId;

  // 集级 canonical 投影：与 getStudioProductionDiagnostics 同一口径
  // （completedUnits === PASS 数；owner-abandoned 明确闭合不计 unknown）。
  const canonical = await computeStudioEpisodeUnitGridCanonical(projectRoot, { season, episode });

  // 获取写租约状态
  const lease = await getStudioProjectWriteLease(projectRoot).catch(() => null);

  // 推导焦点单元状态
  let focusUnitState: GenerationTargetState | null = null;
  let phase: ContinuousGenerationPhase = "idle";
  let preflightChecks: PreflightCheckResult[] = [];

  if (focusUnitId) {
    try {
      const stateProjection = await deriveGenerationTargetState(projectRoot, {
        unitId: focusUnitId,
        targetKind: "unit-grid",
      });
      focusUnitState = stateProjection.state;
      phase = phaseFromUnitState(focusUnitState);

      // PREFLIGHT 检查
      if (phase === "preflight" || focusUnitState === "binding_blocked") {
        preflightChecks = [
          { code: "binding-ready", passed: focusUnitState !== "binding_blocked", message: focusUnitState === "binding_blocked" ? "绑定未就绪" : "绑定已就绪" },
          { code: "write-lease", passed: lease ? !lease.expired : true, message: lease?.held ? `租约由 ${lease.lease?.holderKind ?? "未知"} 持有` : "无租约" },
          { code: "no-unknown-call", passed: true, message: "无 generation_unknown 调用" },
        ];
        // 检查 active-runs 中的 generation_unknown
        const activeRuns = await listStudioGenerationActiveRuns(projectRoot, {
          unitId: focusUnitId,
          targetKind: "unit-grid",
        });
        const unknownRun = activeRuns.runs.find((r) => r.callStatus === "generation_unknown");
        if (unknownRun) {
          preflightChecks.push({ code: "no-unknown-call", passed: false, message: `run ${unknownRun.generationRunId} 存在未对账调用` });
        }
      }
    } catch {
      phase = "idle";
    }
  } else {
    phase = earliest.completedUnitIds.length > 0 ? "next_unit" : "idle";
  }

  const primaryAction = derivePrimaryAction(phase, focusUnitState);
  const blocked = phase === "generation_unknown"
    || (preflightChecks.length > 0 && preflightChecks.some((c) => !c.passed));

  return {
    schemaVersion: CONTINUOUS_GENERATION_SCHEMA_VERSION,
    kind: "studio-continuous-generation-state",
    projectId: shell.project.id,
    phase,
    focusUnitId,
    focusUnitState,
    preflightChecks,
    primaryAction,
    blocking: {
      blocked,
      reason: blocked
        ? phase === "generation_unknown"
          ? "存在未对账的 generation_unknown 调用"
          : preflightChecks.filter((c) => !c.passed).map((c) => c.message).join("；")
        : null,
      recoveryAction: blocked
        ? phase === "generation_unknown"
          ? "reconcile_studio_imagegen_call 或 abandon_studio_generation_unknown"
          : "解决预检阻断后重新进入状态机"
        : null,
    },
    writeLease: {
      held: lease?.held ?? false,
      holderKind: lease?.lease?.holderKind ?? null,
      expired: lease?.expired ?? false,
    },
    progress: {
      totalUnits: canonical.rollup.totalUnits,
      completedUnits: canonical.rollup.completedUnitIds.length,
      passUnits: canonical.rollup.passUnitIds.length,
      ownerAbandonedUnits: canonical.rollup.ownerAbandonedUnitIds.length,
      currentUnitSequence: earliest.earliestSequence,
    },
    builtAt: new Date().toISOString(),
  };
}
