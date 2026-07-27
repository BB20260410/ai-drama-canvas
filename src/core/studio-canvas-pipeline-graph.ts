/**
 * 有界分镜流水线画布图（视图层）：unit 内 2–6 宫格 → raw/labeled/review 链。
 * 节点 data 仅 locator/投影字段，禁止媒体二进制与 SQLite path。
 * 构图末用 studio-canvas-edge-validation 校验边 kind（TwitCanva 合同）。
 */
import { studioCanvasNodeId } from "./studio-canvas-layout-geometry.js";
import { validateStudioCanvasEdges } from "./studio-canvas-edge-validation.js";

export const STUDIO_CANVAS_PIPELINE_MAX_PANELS = 6;
export const STUDIO_CANVAS_PIPELINE_MAX_UNITS_PAGE = 36;

export type StudioCanvasPipelineStage = "panel" | "raw" | "labeled" | "review";

export interface StudioCanvasPipelinePanelInput {
  panelId: string;
  ordinal: number;
  label: string;
  startSeconds?: number;
  endSeconds?: number;
  /** 可选投影状态文案，非真源 */
  status?: string;
  hasRaw?: boolean;
  hasLabeled?: boolean;
  reviewDecision?: "pass" | "rework" | "reject" | "none";
}

export interface StudioCanvasPipelineUnitInput {
  unitId: string;
  label: string;
  panels: readonly StudioCanvasPipelinePanelInput[];
}

export interface StudioCanvasPipelineGraphNode {
  id: string;
  kind: StudioCanvasPipelineStage | "unit";
  position: { x: number; y: number };
  label: string;
  data: {
    kind: StudioCanvasPipelineStage | "unit";
    unitId: string;
    panelId?: string;
    ordinal?: number;
    /** 仅布尔/枚举投影，不携带 SHA */
    flags?: {
      hasRaw?: boolean;
      hasLabeled?: boolean;
      reviewDecision?: string;
    };
  };
}

export interface StudioCanvasPipelineGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface StudioCanvasPipelineGraph {
  schemaVersion: 1;
  kind: "studio-canvas-pipeline-graph";
  unitId: string;
  panelCount: number;
  bounded: true;
  maxPanels: typeof STUDIO_CANVAS_PIPELINE_MAX_PANELS;
  nodes: StudioCanvasPipelineGraphNode[];
  edges: StudioCanvasPipelineGraphEdge[];
}

export class StudioCanvasPipelineGraphError extends Error {
  readonly code: "invalid-input" | "unbounded-rejected";

  constructor(code: "invalid-input" | "unbounded-rejected", message: string) {
    super(message);
    this.name = "StudioCanvasPipelineGraphError";
    this.code = code;
  }
}

/**
 * 构建单单元有界流水线图。panels 必须 1–6；超过即失败关闭（调用方应先分页/筛选）。
 */
export function buildStudioCanvasPipelineGraph(
  unit: StudioCanvasPipelineUnitInput,
  options?: {
    originX?: number;
    originY?: number;
    rowGap?: number;
    colGap?: number;
  },
): StudioCanvasPipelineGraph {
  const unitId = unit.unitId?.trim();
  if (!unitId) throw new StudioCanvasPipelineGraphError("invalid-input", "unitId 不能为空。");
  const panels = [...unit.panels].sort((a, b) => a.ordinal - b.ordinal);
  if (panels.length < 1) {
    throw new StudioCanvasPipelineGraphError("invalid-input", "至少需要 1 个宫格。");
  }
  if (panels.length > STUDIO_CANVAS_PIPELINE_MAX_PANELS) {
    throw new StudioCanvasPipelineGraphError(
      "unbounded-rejected",
      `单单元宫格超过上限 ${STUDIO_CANVAS_PIPELINE_MAX_PANELS}，拒绝一次构图。`,
    );
  }

  const originX = options?.originX ?? 360;
  const originY = options?.originY ?? 80;
  const rowGap = options?.rowGap ?? 160;
  const colGap = options?.colGap ?? 200;

  const nodes: StudioCanvasPipelineGraphNode[] = [];
  const edges: StudioCanvasPipelineGraphEdge[] = [];

  const unitNodeId = studioCanvasNodeId("unit", unitId);
  nodes.push({
    id: unitNodeId,
    kind: "unit",
    position: { x: originX - colGap, y: originY },
    label: unit.label || unitId,
    data: { kind: "unit", unitId },
  });

  panels.forEach((panel, row) => {
    const y = originY + row * rowGap;
    const panelNodeId = studioCanvasNodeId("panel", panel.panelId);
    const rawId = `media:raw:${panel.panelId}`;
    const labeledId = `media:labeled:${panel.panelId}`;
    const reviewId = `media:review:${panel.panelId}`;

    nodes.push({
      id: panelNodeId,
      kind: "panel",
      position: { x: originX, y },
      label: `${panel.ordinal}. ${panel.label}`,
      data: {
        kind: "panel",
        unitId,
        panelId: panel.panelId,
        ordinal: panel.ordinal,
        flags: {
          hasRaw: panel.hasRaw,
          hasLabeled: panel.hasLabeled,
          reviewDecision: panel.reviewDecision ?? "none",
        },
      },
    });
    nodes.push({
      id: rawId,
      kind: "raw",
      position: { x: originX + colGap, y },
      label: panel.hasRaw ? "raw ✓" : "raw ·",
      data: { kind: "raw", unitId, panelId: panel.panelId, flags: { hasRaw: panel.hasRaw } },
    });
    nodes.push({
      id: labeledId,
      kind: "labeled",
      position: { x: originX + colGap * 2, y },
      label: panel.hasLabeled ? "labeled ✓" : "labeled ·",
      data: { kind: "labeled", unitId, panelId: panel.panelId, flags: { hasLabeled: panel.hasLabeled } },
    });
    nodes.push({
      id: reviewId,
      kind: "review",
      position: { x: originX + colGap * 3, y },
      label: `review ${panel.reviewDecision ?? "none"}`,
      data: {
        kind: "review",
        unitId,
        panelId: panel.panelId,
        flags: { reviewDecision: panel.reviewDecision ?? "none" },
      },
    });

    edges.push({ id: `e:${unitNodeId}:${panelNodeId}`, source: unitNodeId, target: panelNodeId, label: String(panel.ordinal) });
    edges.push({ id: `e:${panelNodeId}:${rawId}`, source: panelNodeId, target: rawId, label: "raw" });
    edges.push({ id: `e:${rawId}:${labeledId}`, source: rawId, target: labeledId, label: "labeled" });
    edges.push({ id: `e:${labeledId}:${reviewId}`, source: labeledId, target: reviewId, label: "review" });

    if (row > 0) {
      const prev = panels[row - 1]!;
      const prevPanelId = studioCanvasNodeId("panel", prev.panelId);
      edges.push({
        id: `chain:${prevPanelId}:${panelNodeId}`,
        source: prevPanelId,
        target: panelNodeId,
        label: "next",
      });
    }
  });

  // 禁止泄漏 path/sha 键
  const blob = JSON.stringify({ nodes, edges });
  if (/"localPath"|sqlite|base64/i.test(blob)) {
    throw new StudioCanvasPipelineGraphError("invalid-input", "流水线图不得包含 localPath/sqlite/base64。");
  }

  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  const edgeCheck = validateStudioCanvasEdges(
    edges.map((edge) => ({
      sourceId: edge.source,
      targetId: edge.target,
      sourceKind: kindById.get(edge.source) ?? "unknown",
      targetKind: kindById.get(edge.target) ?? "unknown",
    })),
  );
  if (!edgeCheck.ok) {
    const first = edgeCheck.issues[0];
    throw new StudioCanvasPipelineGraphError(
      "invalid-input",
      `流水线边校验失败：${first?.message ?? "unknown"}`,
    );
  }

  return {
    schemaVersion: 1,
    kind: "studio-canvas-pipeline-graph",
    unitId,
    panelCount: panels.length,
    bounded: true,
    maxPanels: STUDIO_CANVAS_PIPELINE_MAX_PANELS,
    nodes,
    edges,
  };
}

/**
 * 全季/多单元入口：只接受已分页的 unit 列表，单页上限 36，防止一次构图爆炸。
 */
export function assertStudioCanvasUnitsPageBounded(unitCount: number): void {
  if (!Number.isSafeInteger(unitCount) || unitCount < 0) {
    throw new StudioCanvasPipelineGraphError("invalid-input", "unitCount 非法。");
  }
  if (unitCount > STUDIO_CANVAS_PIPELINE_MAX_UNITS_PAGE) {
    throw new StudioCanvasPipelineGraphError(
      "unbounded-rejected",
      `单元页超过上限 ${STUDIO_CANVAS_PIPELINE_MAX_UNITS_PAGE}，必须分页/筛选。`,
    );
  }
}
