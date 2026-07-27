/**
 * 宫格「生成前准备检查清单」（视图投影合同）。
 *
 * clean-room 对齐 Jellyfish shot_preparation_state 的聚合思路：
 * - 前端/驾驶舱只消费结构化 checklist，不在 UI 散落 if
 * - 不写 SQLite/CAS；输入来自 dashboard unit 投影字段
 * - readyForGeneration = 全部检查项 ready
 */
import type { StudioDashboardCurrentness } from "./studio-production-dashboard.js";
import type { StudioBindingTimelineStatus } from "./studio-binding-control.js";

export type StudioPreparationCheckId =
  | "binding-closed"
  | "visual-action"
  | "continuity-clear"
  | "freeze-ready";

export interface StudioPreparationCheckItem {
  id: StudioPreparationCheckId;
  label: string;
  ready: boolean;
  reason: string;
}

export interface StudioPanelPreparationChecklistInput {
  unitId: string;
  panelId: string;
  panelStatus: StudioBindingTimelineStatus | string;
  bindingCurrentness?: StudioDashboardCurrentness | string;
  visualAction?: string;
  dialogue?: string;
  controlAssetCount?: number;
  continuityConflictCount?: number;
  /** freeze 门禁：ready | blocked | missing | not-applicable */
  generationStatus?: "ready" | "blocked" | "missing" | "not-applicable" | string;
  generationMessage?: string;
  nextActionReason?: string;
}

export interface StudioPanelPreparationChecklist {
  schemaVersion: 1;
  kind: "studio-panel-preparation-checklist";
  unitId: string;
  panelId: string;
  readyForGeneration: boolean;
  pendingCount: number;
  items: StudioPreparationCheckItem[];
  primaryBlocker?: StudioPreparationCheckItem;
}

export class StudioPanelPreparationChecklistError extends Error {
  readonly code = "invalid-input" as const;
  constructor(message: string) {
    super(message);
    this.name = "StudioPanelPreparationChecklistError";
  }
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new StudioPanelPreparationChecklistError(`${field} 不能为空。`);
  return normalized;
}

/**
 * 从 unit 投影字段构建准备清单（纯函数）。
 */
export function buildStudioPanelPreparationChecklist(
  input: StudioPanelPreparationChecklistInput,
): StudioPanelPreparationChecklist {
  const unitId = requiredId(input.unitId, "unitId");
  const panelId = requiredId(input.panelId, "panelId");
  const status = String(input.panelStatus ?? "").trim();
  const binding = String(input.bindingCurrentness ?? "").trim();
  const gen = String(input.generationStatus ?? "missing").trim();
  const conflicts = Number(input.continuityConflictCount ?? 0);
  const assetCount = Number(input.controlAssetCount ?? 0);
  const visual = (input.visualAction ?? "").trim();

  const bindingReady =
    status === "generation-ready"
    || binding === "current"
    || (assetCount > 0 && status !== "blocked" && status !== "missing-binding");

  const visualReady = visual.length > 0 || Boolean((input.dialogue ?? "").trim());

  const continuityReady = !Number.isFinite(conflicts) || conflicts <= 0;

  const freezeReady = gen === "ready" || gen === "not-applicable";

  const items: StudioPreparationCheckItem[] = [
    {
      id: "binding-closed",
      label: "绑定闭环",
      ready: bindingReady,
      reason: bindingReady
        ? `人物、场景和道具已确认 · ${assetCount} 项控制资产`
        : (input.nextActionReason?.trim() || "人物、场景或道具尚未绑定完整"),
    },
    {
      id: "visual-action",
      label: "镜头动作/对白",
      ready: visualReady,
      reason: visualReady ? "已填写镜头动作或对白" : "尚未填写镜头动作或对白",
    },
    {
      id: "continuity-clear",
      label: "连续性无冲突",
      ready: continuityReady,
      reason: continuityReady ? "无未解冲突" : `仍有 ${conflicts} 个连续性冲突`,
    },
    {
      id: "freeze-ready",
      label: "冻结包可派发",
      ready: freezeReady,
      reason: freezeReady
        ? "冻结包已就绪"
        : (input.generationMessage?.trim() || "冻结包尚未就绪"),
    },
  ];

  const pending = items.filter((item) => !item.ready);
  const primaryBlocker = pending[0];
  return {
    schemaVersion: 1,
    kind: "studio-panel-preparation-checklist",
    unitId,
    panelId,
    readyForGeneration: pending.length === 0,
    pendingCount: pending.length,
    items,
    ...(primaryBlocker ? { primaryBlocker } : {}),
  };
}

function countConflicts(conflicts: unknown): number {
  if (conflicts == null) return 0;
  if (Array.isArray(conflicts)) return conflicts.length;
  if (typeof conflicts === "object") {
    const record = conflicts as { total?: number; items?: unknown[]; length?: number };
    if (typeof record.total === "number" && Number.isFinite(record.total)) return Math.max(0, record.total);
    if (Array.isArray(record.items)) return record.items.length;
    if (typeof record.length === "number" && Number.isFinite(record.length)) return Math.max(0, record.length);
  }
  return 0;
}

/**
 * 从 dashboard unit detail 的 selectedPanel 形状抽取输入（避免 UI 手写映射）。
 * 入参放宽为结构子集，兼容完整 StudioDashboardUnitDetail。
 */
export function preparationInputFromUnitDetail(detail: {
  unit: { id: string };
  selectedPanelId?: string;
  selectedPanel?: {
    panel: {
      id: string;
      status: string;
      bindingCurrentness?: string;
      visualAction?: string;
      dialogue?: string;
      assetIds?: readonly string[];
    };
    continuityReview?: { conflicts?: unknown } | null;
    generation?: { status?: string; message?: string } | null;
  } | null;
  nextAction?: { reason?: string } | null;
}): StudioPanelPreparationChecklistInput | null {
  const selected = detail.selectedPanel;
  if (!selected?.panel?.id) return null;
  return {
    unitId: detail.unit.id,
    panelId: selected.panel.id,
    panelStatus: selected.panel.status,
    bindingCurrentness: selected.panel.bindingCurrentness,
    visualAction: selected.panel.visualAction,
    dialogue: selected.panel.dialogue,
    controlAssetCount: selected.panel.assetIds?.length ?? 0,
    continuityConflictCount: countConflicts(selected.continuityReview?.conflicts),
    generationStatus: selected.generation?.status,
    generationMessage: selected.generation?.message,
    nextActionReason: detail.nextAction?.reason ?? undefined,
  };
}
