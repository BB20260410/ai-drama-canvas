/**
 * unit-grid 终态 → Dashboard/Agent 下一动作投影（纯函数）。
 *
 * 防止 unit-grid 已 Review pass / in-flight / pending-review 时误投 panel 级
 * `execute-agent-imagegen`。
 */

export type StudioUnitGridLedgerPhase =
  | "ready-to-freeze"
  | "ready-to-dispatch"
  | "in-flight"
  | "generation-unknown"
  | "pending-review"
  | "approved"
  | "rework"
  | "rejected"
  | "not-invoked-needs-new-run"
  | "abandoned-needs-new-run";

export interface StudioUnitGridNextActionProjection {
  phase: StudioUnitGridLedgerPhase;
  code: string;
  label: string;
  /** 是否禁止再发 panel 级 execute-agent-imagegen */
  forbidPanelGenerate: boolean;
  /** unit-grid 是否允许新 dispatch（新 generationRunId） */
  allowNewUnitGridRun: boolean;
  targetKind: "unit-grid";
}

export function projectStudioUnitGridNextAction(input: {
  hasCurrentPack: boolean;
  /** 已派发且尚未终态的 run；必须等待/恢复，不能把它误投影成可再次派发。 */
  hasActiveRun?: boolean;
  callStatus?: "generation_unknown" | "not-invoked" | "result-committed" | "owner-abandoned" | null;
  pairComplete?: boolean;
  reviewDecision?: "pass" | "rework" | "reject" | "pending" | null;
}): StudioUnitGridNextActionProjection {
  const callStatus = input.callStatus ?? null;
  const review = input.reviewDecision ?? null;

  if (callStatus === "generation_unknown") {
    return {
      phase: "generation-unknown",
      code: "reconcile-unit-grid-call",
      label: "对账 unit-grid 未知生图 call（禁止重试/禁止 panel 生图）",
      forbidPanelGenerate: true,
      allowNewUnitGridRun: false,
      targetKind: "unit-grid",
    };
  }

  if (callStatus === "not-invoked") {
    return {
      phase: "not-invoked-needs-new-run",
      code: "new-unit-grid-run-required",
      label: "not-invoked 已关账，使用新 generationRunId 再派发 unit-grid",
      forbidPanelGenerate: true,
      allowNewUnitGridRun: true,
      targetKind: "unit-grid",
    };
  }

  if (callStatus === "owner-abandoned") {
    return {
      phase: "abandoned-needs-new-run",
      code: "new-unit-grid-run-required-after-owner-abandon",
      label: "未知调用已封存；迟到结果拒收，使用新 generationRunId 再派发 unit-grid",
      forbidPanelGenerate: true,
      allowNewUnitGridRun: true,
      targetKind: "unit-grid",
    };
  }

  if (input.hasActiveRun) {
    return {
      phase: "in-flight",
      code: "wait-or-reconcile-unit-grid-run",
      label: "unit-grid 正在执行，等待结果或对账现有 run",
      forbidPanelGenerate: true,
      allowNewUnitGridRun: false,
      targetKind: "unit-grid",
    };
  }

  if (callStatus === "result-committed" || input.pairComplete) {
    if (review === "pass") {
      return {
        phase: "approved",
        code: "unit-grid-approved",
        label: "unit-grid 已通过审片，勿再 panel 级生图",
        forbidPanelGenerate: true,
        allowNewUnitGridRun: false,
        targetKind: "unit-grid",
      };
    }
    if (review === "rework") {
      return {
        phase: "rework",
        code: "unit-grid-rework",
        label: "unit-grid 返工：修正后重新 freeze 新 run",
        forbidPanelGenerate: true,
        allowNewUnitGridRun: true,
        targetKind: "unit-grid",
      };
    }
    if (review === "reject") {
      return {
        phase: "rejected",
        code: "unit-grid-rejected",
        label: "unit-grid 已拒绝，勿 panel 生图",
        forbidPanelGenerate: true,
        allowNewUnitGridRun: true,
        targetKind: "unit-grid",
      };
    }
    return {
      phase: "pending-review",
      code: "submit-unit-grid-review",
      label: "raw/labeled 已齐，提交 unit-grid Review",
      forbidPanelGenerate: true,
      allowNewUnitGridRun: false,
      targetKind: "unit-grid",
    };
  }

  if (input.hasCurrentPack) {
    return {
      phase: "ready-to-dispatch",
      code: "dispatch-unit-grid",
      label: "派发 unit-grid 生图包",
      forbidPanelGenerate: true,
      allowNewUnitGridRun: true,
      targetKind: "unit-grid",
    };
  }

  return {
    phase: "ready-to-freeze",
    code: "freeze-unit-grid",
    label: "冻结 unit-grid 生图包",
    forbidPanelGenerate: true,
    allowNewUnitGridRun: true,
    targetKind: "unit-grid",
  };
}
