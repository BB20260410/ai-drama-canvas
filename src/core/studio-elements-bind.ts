/**
 * Elements 式显式绑定（clean-room，对照 LTX Elements 叙事 + 本仓 binding fail-close）。
 * 不写 CAS：只产出 bind 计划或 blocked 原因；歧义/越权禁止静默取第一候选。
 */

import { planExplicitBindingDecision, type ExplicitBindingProposalInput } from "./studio-binding-explicit-decision.js";

export type StudioElementKind = "character" | "scene" | "prop";

/** 由 assetId 前缀推断 Elements 栏类型（本仓规范资产命名）。 */
export function classifyStudioElementKind(assetId: string): StudioElementKind | null {
  const id = assetId?.trim() ?? "";
  if (!id) return null;
  if (id.startsWith("character-") || id.startsWith("char-")) return "character";
  if (id.startsWith("scene-") || id.startsWith("location-")) return "scene";
  if (id.startsWith("prop-") || id.startsWith("item-")) return "prop";
  return null;
}

export type ExplicitElementBindInput = {
  panelId: string;
  /** 用户从 Elements 栏拖入的资产 */
  assetId: string;
  /** 期望栏类型；若提供则必须与 asset 分类一致 */
  expectedKind?: StudioElementKind;
  /** 当前单元/宫格允许绑定的资产闭包 */
  allowedAssetIds: string[];
  /** 若为 true，必须提供 assetId 且不得靠「第一个候选」 */
  ambiguousContext?: boolean;
  entityText?: string;
  role?: string;
};

export type ExplicitElementBindPlan =
  | {
      kind: "bind";
      panelId: string;
      assetId: string;
      elementKind: StudioElementKind;
      role: string;
      note: string;
    }
  | { kind: "blocked"; code: string; reason: string };

/**
 * 计划「拖到格上固定」：仅当资产在允许集内、类型一致、无未消歧时允许 bind。
 */
export function planExplicitElementBind(input: ExplicitElementBindInput): ExplicitElementBindPlan {
  const panelId = input.panelId?.trim() ?? "";
  const assetId = input.assetId?.trim() ?? "";
  if (!panelId) return { kind: "blocked", code: "panel-missing", reason: "panelId 不能为空。" };
  if (!assetId) return { kind: "blocked", code: "asset-missing", reason: "assetId 不能为空（禁止静默选第一候选）。" };

  const elementKind = classifyStudioElementKind(assetId);
  if (!elementKind) {
    return { kind: "blocked", code: "unknown-kind", reason: `无法识别资产类型：${assetId}` };
  }
  if (input.expectedKind && input.expectedKind !== elementKind) {
    return {
      kind: "blocked",
      code: "kind-mismatch",
      reason: `期望 ${input.expectedKind}，资产 ${assetId} 属于 ${elementKind}。`,
    };
  }

  const allowed = new Set((input.allowedAssetIds ?? []).map((a) => a.trim()).filter(Boolean));
  if (allowed.size === 0) {
    return { kind: "blocked", code: "empty-allow-set", reason: "允许资产集为空，禁止绑定。" };
  }
  if (!allowed.has(assetId)) {
    return {
      kind: "blocked",
      code: "not-in-scope",
      reason: `资产 ${assetId} 不在当前单元/宫格允许集内（属集校验失败）。`,
    };
  }

  if (input.ambiguousContext) {
    // 歧义上下文仍要求显式 assetId（已有）且在允许集；额外走决策表防静默
    const proposal: ExplicitBindingProposalInput = {
      entityText: input.entityText?.trim() || assetId,
      status: "ambiguous",
      candidates: [...allowed].map((id) => ({ assetId: id })),
      role: input.role,
    };
    const decision = planExplicitBindingDecision(proposal);
    if (decision.kind === "blocked") {
      return { kind: "blocked", code: "ambiguous", reason: decision.reason };
    }
    if (decision.kind === "exclude") {
      return { kind: "blocked", code: "excluded", reason: decision.note };
    }
    if (decision.selectedAssetId !== assetId) {
      return {
        kind: "blocked",
        code: "decision-mismatch",
        reason: `显式拖入 ${assetId} 与决策表 ${decision.selectedAssetId} 不一致。`,
      };
    }
  }

  return {
    kind: "bind",
    panelId,
    assetId,
    elementKind,
    role: (input.role?.trim() || elementKind).slice(0, 120),
    note: `Elements 显式绑定 ${elementKind}:${assetId} → ${panelId}`,
  };
}
