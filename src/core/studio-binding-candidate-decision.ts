/**
 * Binding 候选确认语义（clean-room 对齐 Jellyfish extracted-candidate linked/ignored）。
 * - 映射到本库 resolveStudioEntityProposal 的 decision
 * - 不新建第二真源；仅合同层
 */
export type JellyfishCandidateStatus = "pending" | "linked" | "ignored";

export type StudioBindingCandidateUiAction = "confirm" | "ignore";

export type StudioBindingResolveDecision = "accept" | "select" | "exclude";

export interface StudioBindingCandidateDecisionMap {
  schemaVersion: 1;
  kind: "studio-binding-candidate-decision-map";
  /** Jellyfish → 本库 */
  fromJellyfish: Record<JellyfishCandidateStatus, string>;
  /** UI 确认/忽略 → resolve decision */
  uiToResolve: Record<StudioBindingCandidateUiAction, StudioBindingResolveDecision>;
}

export const STUDIO_BINDING_CANDIDATE_DECISION_MAP: StudioBindingCandidateDecisionMap = {
  schemaVersion: 1,
  kind: "studio-binding-candidate-decision-map",
  fromJellyfish: {
    pending: "待确认（本库 proposal 未 resolve）",
    linked: "已确认绑定（accept/select）",
    ignored: "已忽略（exclude）",
  },
  uiToResolve: {
    confirm: "select",
    ignore: "exclude",
  },
};

export interface StudioBindingCandidateConfirmInput {
  proposalId: string;
  /** 人工选中的资产；confirm 必填 */
  selectedAssetId?: string;
  /** 若 proposal 已是明确 match，可用 accept */
  matchedAssetId?: string;
  preferAcceptWhenMatched?: boolean;
}

export interface StudioBindingCandidateConfirmPlan {
  schemaVersion: 1;
  kind: "studio-binding-candidate-confirm-plan";
  action: StudioBindingCandidateUiAction;
  decision: StudioBindingResolveDecision;
  selectedAssetId?: string;
  ok: boolean;
  reason: string;
}

/**
 * 构建「确认候选」计划：有匹配可 accept，否则必须 select + selectedAssetId。
 */
export function planStudioBindingCandidateConfirm(
  input: StudioBindingCandidateConfirmInput,
): StudioBindingCandidateConfirmPlan {
  const proposalId = input.proposalId.trim();
  if (!proposalId) {
    return {
      schemaVersion: 1,
      kind: "studio-binding-candidate-confirm-plan",
      action: "confirm",
      decision: "select",
      ok: false,
      reason: "proposalId 不能为空。",
    };
  }
  const matched = input.matchedAssetId?.trim();
  const selected = input.selectedAssetId?.trim();
  if (input.preferAcceptWhenMatched && matched) {
    return {
      schemaVersion: 1,
      kind: "studio-binding-candidate-confirm-plan",
      action: "confirm",
      decision: "accept",
      selectedAssetId: matched,
      ok: true,
      reason: "明确匹配可 accept（Jellyfish linked）。",
    };
  }
  if (!selected) {
    return {
      schemaVersion: 1,
      kind: "studio-binding-candidate-confirm-plan",
      action: "confirm",
      decision: "select",
      ok: false,
      reason: "确认候选需要 selectedAssetId（Jellyfish link）。",
    };
  }
  return {
    schemaVersion: 1,
    kind: "studio-binding-candidate-confirm-plan",
    action: "confirm",
    decision: "select",
    selectedAssetId: selected,
    ok: true,
    reason: "人工选择后 select（Jellyfish link）。",
  };
}

/** 忽略候选 → exclude（Jellyfish ignore） */
export function planStudioBindingCandidateIgnore(proposalId: string): StudioBindingCandidateConfirmPlan {
  const id = proposalId.trim();
  if (!id) {
    return {
      schemaVersion: 1,
      kind: "studio-binding-candidate-confirm-plan",
      action: "ignore",
      decision: "exclude",
      ok: false,
      reason: "proposalId 不能为空。",
    };
  }
  return {
    schemaVersion: 1,
    kind: "studio-binding-candidate-confirm-plan",
    action: "ignore",
    decision: "exclude",
    ok: true,
    reason: "忽略候选 → exclude（Jellyfish ignored）。",
  };
}
