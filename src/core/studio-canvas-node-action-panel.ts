/**
 * 画布节点内操作面板合同（视图层，clean-room 对齐 LocalMiniDrama CanvasStoryboardPanel）。
 * - 只读投影字段 + 可发起动作清单；不写业务真源
 * - 动作通过 execute_command / openDashboard 由上层执行
 */
export type StudioCanvasNodeActionCode =
  | "open-dashboard"
  | "open-binding"
  | "freeze-dispatch"
  | "focus-unit"
  | "close-panel";

export interface StudioCanvasNodeAction {
  code: StudioCanvasNodeActionCode;
  label: string;
  enabled: boolean;
  reason?: string;
}

export interface StudioCanvasNodeActionPanelInput {
  kind: "panel" | "unit" | "asset";
  id: string;
  unitId?: string;
  panelId?: string;
  title?: string;
  subtitle?: string;
  dialogue?: string;
  visualAction?: string;
  bindingCurrentness?: string;
  status?: string;
  assetCount?: number;
  /** 是否允许 freeze+dispatch（不假装生图） */
  canFreezeDispatch?: boolean;
  isBusy?: boolean;
}

export interface StudioCanvasNodeActionPanel {
  schemaVersion: 1;
  kind: "studio-canvas-node-action-panel";
  nodeKind: "panel" | "unit" | "asset";
  nodeId: string;
  title: string;
  fields: Array<{ key: string; label: string; value: string }>;
  actions: StudioCanvasNodeAction[];
}

export class StudioCanvasNodeActionPanelError extends Error {
  readonly code = "invalid-input" as const;
  constructor(message: string) {
    super(message);
    this.name = "StudioCanvasNodeActionPanelError";
  }
}

/**
 * 从选中节点投影构建节点内操作面板。
 */
export function buildStudioCanvasNodeActionPanel(
  input: StudioCanvasNodeActionPanelInput,
): StudioCanvasNodeActionPanel {
  const nodeKind = input.kind;
  const id = input.id.trim();
  if (!id) throw new StudioCanvasNodeActionPanelError("id 不能为空。");

  const title = (input.title ?? id).trim() || id;
  const fields: StudioCanvasNodeActionPanel["fields"] = [];
  const actions: StudioCanvasNodeAction[] = [];
  const busy = Boolean(input.isBusy);

  if (nodeKind === "panel") {
    const panelId = (input.panelId ?? id).trim();
    const unitId = (input.unitId ?? "").trim();
    fields.push(
      { key: "panel", label: "宫格", value: title },
      { key: "status", label: "状态", value: input.status ?? "—" },
      { key: "binding", label: "Binding", value: input.bindingCurrentness ?? "—" },
      { key: "assets", label: "控制资产", value: String(input.assetCount ?? 0) },
      { key: "visual", label: "动作", value: (input.visualAction ?? "").trim() || "—" },
      { key: "dialogue", label: "对白", value: (input.dialogue ?? "").trim() || "—" },
    );
    actions.push({
      code: "open-dashboard",
      label: "打开驾驶舱",
      enabled: !busy && Boolean(unitId || panelId),
      reason: unitId ? undefined : "缺少 unitId 时仅带 panelId 跳转",
    });
    actions.push({
      code: "open-binding",
      label: "绑定工作台",
      enabled: !busy && Boolean(unitId),
      reason: unitId ? undefined : "需要 unitId",
    });
    actions.push({
      code: "freeze-dispatch",
      label: "打开生成队列",
      enabled: !busy && Boolean(input.canFreezeDispatch) && Boolean(unitId && panelId),
      reason: input.canFreezeDispatch ? undefined : "未满足 freeze 条件",
    });
  } else if (nodeKind === "unit") {
    fields.push(
      { key: "unit", label: "单元", value: title },
      { key: "status", label: "状态", value: input.status ?? "—" },
      { key: "subtitle", label: "说明", value: input.subtitle ?? "—" },
    );
    actions.push({
      code: "focus-unit",
      label: "展开宫格",
      enabled: !busy,
    });
    actions.push({
      code: "open-dashboard",
      label: "打开驾驶舱",
      enabled: !busy,
    });
  } else {
    fields.push(
      { key: "asset", label: "资产", value: title },
      { key: "subtitle", label: "说明", value: input.subtitle ?? "—" },
    );
    actions.push({
      code: "open-dashboard",
      label: "查看出场",
      enabled: !busy,
    });
  }

  actions.push({ code: "close-panel", label: "收起", enabled: true });

  return {
    schemaVersion: 1,
    kind: "studio-canvas-node-action-panel",
    nodeKind,
    nodeId: nodeKind === "panel" ? `panel:${input.panelId ?? id}` : `${nodeKind}:${id}`,
    title,
    fields,
    actions,
  };
}
