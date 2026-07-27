/**
 * 驾驶舱 unit 详情选格：无 panelId 时确保最终有 selectedPanel（准备清单依赖）。
 * pure 函数，供 UI 与测试共用。
 */

export interface StudioUnitDetailSelectionSlice {
  selectedPanelId?: string;
  selectedPanel?: { panel: { id: string } } | null;
  panels: ReadonlyArray<{ id: string }>;
}

/**
 * 决定下一次 unit 查询应携带的 panelId。
 * - 已有完整 selectedPanel → 不需要二次请求
 * - 仅有 selectedPanelId 或 panels[0] 但缺 selectedPanel 对象 → 需带 panelId 二次拉取
 */
export function resolveUnitPanelFetchPlan(
  unitId: string,
  detail: StudioUnitDetailSelectionSlice | null | undefined,
  requestedPanelId?: string,
): { unitId: string; panelId?: string; needsRefetchWithPanel: boolean } {
  const uid = unitId.trim();
  if (!uid) {
    return { unitId: "", needsRefetchWithPanel: false };
  }
  const requested = requestedPanelId?.trim();
  if (requested) {
    // 已显式请求某格：若响应缺 selectedPanel，仍要按该 id 再拉一次
    if (detail?.selectedPanel?.panel?.id === requested) {
      return { unitId: uid, panelId: requested, needsRefetchWithPanel: false };
    }
    if (detail && !detail.selectedPanel) {
      return { unitId: uid, panelId: requested, needsRefetchWithPanel: true };
    }
    return { unitId: uid, panelId: requested, needsRefetchWithPanel: !detail?.selectedPanel };
  }

  if (detail?.selectedPanel?.panel?.id) {
    return {
      unitId: uid,
      panelId: detail.selectedPanel.panel.id,
      needsRefetchWithPanel: false,
    };
  }

  const fallback =
    detail?.selectedPanelId?.trim()
    || detail?.panels[0]?.id?.trim()
    || undefined;

  if (fallback) {
    return { unitId: uid, panelId: fallback, needsRefetchWithPanel: true };
  }

  return { unitId: uid, needsRefetchWithPanel: false };
}

/** 选格是否足以渲染准备清单（需要 selectedPanel.panel.id）。 */
export function unitDetailHasPrepChecklistSource(
  detail: StudioUnitDetailSelectionSlice | null | undefined,
): boolean {
  return Boolean(detail?.selectedPanel?.panel?.id);
}
