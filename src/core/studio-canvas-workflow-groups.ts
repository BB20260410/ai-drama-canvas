/**
 * 画布工作流组与 Node 侧布局组合。
 *
 * 纯 CRUD 位于 browser-safe core；本模块只补充需要 layout fingerprint 的
 * Node 侧组合函数，renderer 不得直接导入本模块。
 */
import {
  normalizeStudioCanvasLayout,
  StudioCanvasLayoutError,
  type StudioCanvasLayout,
  type StudioCanvasWorkflowGroup,
} from "./studio-canvas-layout.js";
import {
  createStudioCanvasWorkflowGroup,
  extractStudioCanvasPanelIdsFromSelection,
  StudioCanvasWorkflowGroupsError,
  type StudioCanvasSelectionItem,
} from "./studio-canvas-workflow-groups-core.js";

export * from "./studio-canvas-workflow-groups-core.js";

/** 将 groups 写入 layout（规范化 + fingerprint）；layout 可为 null。 */
export function applyStudioCanvasWorkflowGroupsToLayout(
  base: StudioCanvasLayout | null | undefined,
  groups: readonly StudioCanvasWorkflowGroup[],
  options?: { updatedAt?: string },
): StudioCanvasLayout {
  try {
    return normalizeStudioCanvasLayout({
      viewport: base?.viewport ?? { x: 0, y: 0, zoom: 1 },
      nodes: base?.nodes ?? {},
      workspaceMode: base?.workspaceMode ?? "projection",
      pinnedNodeIds: base?.pinnedNodeIds ?? [],
      draftCanvasEdges: base?.draftCanvasEdges ?? [],
      workflowGroups: [...groups],
      updatedAt: options?.updatedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof StudioCanvasLayoutError) {
      throw new StudioCanvasWorkflowGroupsError("invalid-input", error.message);
    }
    throw error;
  }
}

/** 从 selection 创建组并写回带 fingerprint 的完整 layout。 */
export function createWorkflowGroupFromCanvasSelection(
  base: StudioCanvasLayout | null | undefined,
  selected: readonly StudioCanvasSelectionItem[],
  options?: { title?: string; pipeline?: readonly string[]; now?: string; id?: string },
): { layout: StudioCanvasLayout; group: StudioCanvasWorkflowGroup } {
  const panelIds = extractStudioCanvasPanelIdsFromSelection(selected);
  const groups = createStudioCanvasWorkflowGroup(base?.workflowGroups, {
    title: options?.title,
    panelIds,
    pipeline: options?.pipeline,
    now: options?.now,
    id: options?.id,
  });
  const group = groups[groups.length - 1]!;
  return {
    layout: applyStudioCanvasWorkflowGroupsToLayout(base, groups, { updatedAt: options?.now }),
    group,
  };
}
