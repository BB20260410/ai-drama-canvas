/**
 * T5 单一状态归约器：deriveGenerationTargetState()
 *
 * readiness/dashboard/history/checkpoint gate/画布全部只消费此结果。
 * 同一 U00 不得再出现 readiness=ready 与 gate=尚待验收并存。
 *
 * 状态枚举（严格生命周期顺序）：
 * binding_blocked → ready_to_freeze → ready_to_plan → ready_to_dispatch
 * → dispatched_no_call → generation_unknown → result_pending_review
 * → pass / rework → failed_retryable / cancelled
 */
import { listStudioGenerationActiveRuns, type StudioGenerationActiveRunProjection } from "./studio-generation-ledger.js";
import { queryStudioGenerationFreeze } from "./studio-generation.js";
import { queryStudioUnitGridGenerationFreeze } from "./studio-unit-grid-generation.js";

/** 归约器输出的唯一权威状态枚举。 */
export type GenerationTargetState =
  | "binding_blocked"
  | "ready_to_freeze"
  | "ready_to_plan"
  | "ready_to_dispatch"
  | "dispatched_no_call"
  | "generation_unknown"
  | "result_pending_review"
  | "pass"
  | "rework"
  | "failed_retryable"
  | "cancelled";

export interface GenerationTargetStateProjection {
  schemaVersion: 1;
  kind: "studio-generation-target-state";
  targetKind: "panel" | "unit-grid";
  unitId: string;
  panelId?: string;
  /** 唯一权威状态。 */
  state: GenerationTargetState;
  /** 状态推导依据（人类可读）。 */
  reason: string;
  /** 当前阻断 run（若非终态或 generation_unknown）。 */
  blockingRunId?: string;
  /** 恢复动作建议。 */
  nextAction: string;
  /** 最新 run 投影（供消费方直接使用，避免二次查询）。 */
  latestRun?: StudioGenerationActiveRunProjection;
}

/**
 * 从账本事实推导唯一目标状态。
 *
 * 优先级（2026-07-25 修订）：
 * 1) **活跃 / 终态 run 账本**（含 Review PASS / 待审 / 失败）优先于当前绑定就绪；
 * 2) **仅当无 run** 时，绑定阻断 → binding_blocked，否则 ready_to_freeze。
 *
 * 理由：continuity 后置变 opaque 不得把已 Review PASS 的单元从时间线抹成 binding_blocked
 * （此前 full 投影与 fastMode 对 gaiden S1E2 差 26/26，属假 blocked）。
 * 新冻结仍走 queryStudio*GenerationFreeze，与本归约器展示态分离。
 */
export async function deriveGenerationTargetState(
  projectRoot: string,
  query: { unitId: string; targetKind?: "panel" | "unit-grid"; panelId?: string },
): Promise<GenerationTargetStateProjection> {
  const targetKind = query.targetKind ?? "panel";
  const unitId = query.unitId;
  const panelId = targetKind === "panel" ? query.panelId : undefined;
  const base = {
    schemaVersion: 1 as const,
    kind: "studio-generation-target-state" as const,
    targetKind,
    unitId,
    ...(panelId ? { panelId } : {}),
  };

  // 1. 查询活跃 run 投影（账本优先）
  const activeRuns = await listStudioGenerationActiveRuns(projectRoot, {
    unitId,
    targetKind,
    ...(panelId ? { panelId } : {}),
  });

  // 2. 有 run：终态 / 非终态一律优先于当前绑定就绪
  if (activeRuns.runs.length > 0) {
    const latestRun = activeRuns.runs[0]!;

    // 非终态 run 存在 → 活跃状态
    if (!latestRun.terminal) {
      if (latestRun.callStatus === "generation_unknown") {
        return {
          ...base,
          state: "generation_unknown",
          reason: `run ${latestRun.generationRunId} 存在未对账的 generation_unknown 调用`,
          blockingRunId: latestRun.generationRunId,
          nextAction: "reconcile_studio_imagegen_call 或 abandon_studio_generation_unknown",
          latestRun,
        };
      }
      if (latestRun.hasCallIntent) {
        return {
          ...base,
          state: "dispatched_no_call",
          reason: `run ${latestRun.generationRunId} 已 prepare 但尚无终态`,
          blockingRunId: latestRun.generationRunId,
          nextAction: "等待结果登记或对账 call intent",
          latestRun,
        };
      }
      return {
        ...base,
        state: "dispatched_no_call",
        reason: `run ${latestRun.generationRunId} 已 dispatch 但未 prepare call`,
        blockingRunId: latestRun.generationRunId,
        nextAction: "prepare_studio_imagegen_call 或 cancel_studio_generation_run",
        latestRun,
      };
    }

    // 终态 run：按结果和 Review 裁决（不被 binding 覆盖）
    if (latestRun.hasResultPair) {
      if (latestRun.reviewStatus === "pass") {
        return {
          ...base,
          state: "pass",
          reason: `run ${latestRun.generationRunId} 成对结果已 Review PASS`,
          nextAction: "complete（可继续下一单元）",
          latestRun,
        };
      }
      if (latestRun.reviewStatus === "rework") {
        return {
          ...base,
          state: "rework",
          reason: `run ${latestRun.generationRunId} 成对结果 Review 返工`,
          nextAction: "retry_studio_generation_plan_nodes 或新 dispatch",
          latestRun,
        };
      }
      return {
        ...base,
        state: "result_pending_review",
        reason: `run ${latestRun.generationRunId} 成对结果未审片`,
        blockingRunId: latestRun.generationRunId,
        nextAction: "submit_studio_generation_review",
        latestRun,
      };
    }

    // 终态无完整对
    if (latestRun.latestEventKind === "failed") {
      return {
        ...base,
        state: "failed_retryable",
        reason: `run ${latestRun.generationRunId} 失败（可重试）`,
        nextAction: "retry_studio_generation_plan_nodes 或新 dispatch",
        latestRun,
      };
    }
    if (latestRun.latestEventKind === "cancelled") {
      return {
        ...base,
        state: "cancelled",
        reason: `run ${latestRun.generationRunId} 已取消`,
        nextAction: "retry_studio_generation_plan_nodes 或新 dispatch",
        latestRun,
      };
    }
    if (latestRun.latestEventKind === "retry-superseded") {
      const previousRun = activeRuns.runs[1];
      if (previousRun) {
        return {
          ...base,
          state: previousRun.terminal && previousRun.hasResultPair
            ? previousRun.reviewStatus === "pass"
              ? "pass"
              : "result_pending_review"
            : "ready_to_dispatch",
          reason: `最新 run 已被取代，前序 run ${previousRun.generationRunId} 状态为准`,
          nextAction: "查看前序 run 状态",
          latestRun: previousRun,
        };
      }
      return {
        ...base,
        state: "ready_to_dispatch",
        reason: "所有 run 已被取代，可重新派发",
        nextAction: "dispatch_studio_generation_pack",
      };
    }

    return {
      ...base,
      state: "ready_to_dispatch",
      reason: "状态推导兜底（有 run 但无明确终态）",
      nextAction: "检查 active-runs 详情",
      latestRun,
    };
  }

  // 3. 无 run：才看绑定就绪（决定能否新冻结）
  try {
    if (targetKind === "unit-grid") {
      const readiness = await queryStudioUnitGridGenerationFreeze(projectRoot, {
        targetKind: "unit-grid",
        unitId,
      });
      if (readiness.status === "blocked") {
        return {
          ...base,
          state: "binding_blocked",
          reason: readiness.message,
          nextAction: "解决绑定阻断后重新检查 readiness",
        };
      }
    } else {
      const readiness = await queryStudioGenerationFreeze(projectRoot, {
        unitId,
        panelId: panelId!,
      });
      if (readiness.status === "blocked") {
        return {
          ...base,
          state: "binding_blocked",
          reason: readiness.message,
          nextAction: "解决绑定阻断后重新检查 readiness",
        };
      }
    }
  } catch {
    return {
      ...base,
      state: "binding_blocked",
      reason: "绑定就绪查询异常（fail-safe）",
      nextAction: "检查受管项目完整性",
    };
  }

  return {
    ...base,
    state: "ready_to_freeze",
    reason: "绑定就绪且无历史 run",
    nextAction: "freeze_studio_generation_pack → create_plan → dispatch",
  };
}
