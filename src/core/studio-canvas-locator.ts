/**
 * 列表 ↔ 画布双入口 locator（视图导航，不推导 nextAction）。
 * 稳定字段与 dashboard locator 对齐：unitId / panelId / assetId。
 */
export type StudioCanvasMode = "canvas" | "dashboard" | "library" | "binding" | "continuity-review";

export interface StudioCanvasFocusLocator {
  unitId?: string;
  panelId?: string;
  assetId?: string;
  /** 来源模式，便于返回 */
  fromMode?: StudioCanvasMode;
}

export interface StudioCanvasNavigationIntent {
  /** 目标素材中心 mode */
  mode: StudioCanvasMode;
  focus: StudioCanvasFocusLocator;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

function optionalId(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) {
    throw new Error(`${field} 非法：${value}`);
  }
  return normalized;
}

/** 规范化 focus；panel 存在时建议带 unitId（UI 可只靠 panel 再查）。 */
export function normalizeStudioCanvasFocus(input: StudioCanvasFocusLocator): StudioCanvasFocusLocator {
  const unitId = optionalId(input.unitId, "unitId");
  const panelId = optionalId(input.panelId, "panelId");
  const assetId = optionalId(input.assetId, "assetId");
  if (!unitId && !panelId && !assetId) {
    throw new Error("focus 至少需要 unitId、panelId 或 assetId 之一。");
  }
  return {
    ...(unitId ? { unitId } : {}),
    ...(panelId ? { panelId } : {}),
    ...(assetId ? { assetId } : {}),
    ...(input.fromMode ? { fromMode: input.fromMode } : {}),
  };
}

/** 从驾驶舱/列表打开画布并聚焦。 */
export function intentOpenCanvasFromDashboard(focus: StudioCanvasFocusLocator): StudioCanvasNavigationIntent {
  return {
    mode: "canvas",
    focus: normalizeStudioCanvasFocus({ ...focus, fromMode: focus.fromMode ?? "dashboard" }),
  };
}

/** 从画布返回驾驶舱 unit 详情。 */
export function intentOpenDashboardFromCanvas(focus: StudioCanvasFocusLocator): StudioCanvasNavigationIntent {
  const normalized = normalizeStudioCanvasFocus({ ...focus, fromMode: focus.fromMode ?? "canvas" });
  if (!normalized.unitId && !normalized.panelId) {
    throw new Error("返回驾驶舱需要 unitId 或 panelId。");
  }
  return { mode: "dashboard", focus: normalized };
}

/** 判断两个 locator 是否指向同一 unit/panel（用于选中态）。 */
export function studioCanvasFocusMatches(
  current: { unitId?: string; panelId?: string },
  focus: StudioCanvasFocusLocator,
): boolean {
  if (focus.panelId) {
    return current.panelId === focus.panelId
      && (focus.unitId === undefined || current.unitId === focus.unitId);
  }
  if (focus.unitId) {
    return current.unitId === focus.unitId;
  }
  return false;
}

/** 稳定序列化，便于 props / query 传递（非 URL 强制）。 */
export function encodeStudioCanvasFocus(focus: StudioCanvasFocusLocator): string {
  const normalized = normalizeStudioCanvasFocus(focus);
  return JSON.stringify(normalized);
}

export function decodeStudioCanvasFocus(raw: string): StudioCanvasFocusLocator {
  const parsed = JSON.parse(raw) as StudioCanvasFocusLocator;
  return normalizeStudioCanvasFocus(parsed);
}
