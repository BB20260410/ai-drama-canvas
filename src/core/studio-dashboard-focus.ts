/**
 * 驾驶舱 focus 应用：把 canvas↔dashboard locator 转成真实 getDashboard unit 查询。
 * UI 与测试共用，避免「只测字符串」抓不到挂载回程 bug。
 */
import type { StudioCanvasFocusLocator } from "./studio-canvas-locator.js";
import { normalizeStudioCanvasFocus } from "./studio-canvas-locator.js";
import type {
  StudioProductionDashboardQuery,
  StudioProductionDashboardResponse,
} from "./studio-production-dashboard.js";

export type StudioDashboardGetFn = (
  projectRoot: string,
  query: StudioProductionDashboardQuery,
) => Promise<StudioProductionDashboardResponse>;

/** focus → unit 查询；无 unitId 时返回 null（仅 asset 时由 UI 另处理）。 */
export function studioDashboardUnitQueryForFocus(
  focus: StudioCanvasFocusLocator,
): Extract<StudioProductionDashboardQuery, { operation: "unit" }> | null {
  const normalized = normalizeStudioCanvasFocus(focus);
  if (!normalized.unitId) return null;
  return {
    operation: "unit",
    unitId: normalized.unitId,
    ...(normalized.panelId ? { panelId: normalized.panelId } : {}),
  };
}

/**
 * 用真实 getDashboard 入口加载 focus 对应 unit 详情。
 * 返回 unit 响应；若 operation 非 unit 则抛错。
 */
export async function loadStudioDashboardUnitForFocus(
  getDashboard: StudioDashboardGetFn,
  projectRoot: string,
  focus: StudioCanvasFocusLocator,
): Promise<Extract<StudioProductionDashboardResponse, { operation: "unit" }>> {
  const query = studioDashboardUnitQueryForFocus(focus);
  if (!query) {
    throw new Error("focus 缺少 unitId，无法加载驾驶舱 unit 详情。");
  }
  const response = await getDashboard(projectRoot, query);
  if (response.operation !== "unit") {
    throw new Error(`期望 unit 响应，收到 ${response.operation}`);
  }
  if (response.unit.id !== query.unitId) {
    throw new Error(`unitId 不匹配：请求 ${query.unitId}，响应 ${response.unit.id}`);
  }
  if (query.panelId && response.selectedPanelId && response.selectedPanelId !== query.panelId) {
    // selectedPanelId 可能因 panel 不在 unit 而为 undefined；若有则必须一致
    throw new Error(`panelId 不匹配：请求 ${query.panelId}，响应 ${response.selectedPanelId}`);
  }
  return response;
}

/** 是否应在 units 页加载后优先应用 focus（而非默认选中第一项）。 */
export function shouldPreferFocusOverDefaultUnit(
  focus: StudioCanvasFocusLocator | null | undefined,
): boolean {
  return Boolean(focus?.unitId);
}
