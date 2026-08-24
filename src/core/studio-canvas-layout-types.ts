/** Renderer 与主进程共用的纯类型合同；不得引入任何运行时依赖。 */
import type { StudioCanvasEdgeCandidate } from "./studio-canvas-edge-validation.js";

export interface StudioCanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface StudioCanvasNodePosition {
  x: number;
  y: number;
}

export type StudioCanvasWorkflowStep = "image" | "video" | "audio" | "review";

export interface StudioCanvasWorkflowGroup {
  id: string;
  title: string;
  panelIds: string[];
  pipeline: StudioCanvasWorkflowStep[];
  createdAt: string;
}

/** 视图层空间编组；不进入 BindingSet / 生成事实源。 */
export interface StudioCanvasSpatialGroup {
  id: string;
  title: string;
  memberIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * projection 只展示业务真源的有界投影；workflow 允许用户整理视图节点与草稿连线。
 * 两种模式都只是画布视图状态，不承载业务状态。
 */
export type StudioCanvasWorkspaceMode = "projection" | "workflow";

/**
 * 浏览器安全的 visual-only 草稿边合同；落盘前仍需经过现有画布边校验。
 * 它绝不成为 BindingSet、生成输入或生成结果的事实源。Start 最多用其做
 * 输入一致性预检，正式冻结包仍须由权威 owner 重建。
 */
export type StudioCanvasDraftEdge = StudioCanvasEdgeCandidate;

export interface StudioCanvasLayout {
  schemaVersion: 1;
  kind: "studio-canvas-layout";
  fingerprint: string;
  viewport: StudioCanvasViewport;
  nodes: Record<string, StudioCanvasNodePosition>;
  workspaceMode: StudioCanvasWorkspaceMode;
  pinnedNodeIds: string[];
  /** visual-only / draft；绝不作为 BindingSet 或生成事实源。 */
  draftCanvasEdges: StudioCanvasDraftEdge[];
  workflowGroups: StudioCanvasWorkflowGroup[];
  /** 空则省略，保持旧 fingerprint。 */
  spatialGroups?: StudioCanvasSpatialGroup[];
  updatedAt: string;
}

export interface StudioCanvasLayoutDraft {
  viewport?: Partial<StudioCanvasViewport>;
  nodes?: Record<string, StudioCanvasNodePosition>;
  workspaceMode?: StudioCanvasWorkspaceMode;
  pinnedNodeIds?: string[];
  /** visual-only / draft；Start 仅可预检，不能据此冻结或派发。 */
  draftCanvasEdges?: StudioCanvasDraftEdge[];
  workflowGroups?: StudioCanvasWorkflowGroup[];
  spatialGroups?: StudioCanvasSpatialGroup[];
  updatedAt?: string;
}
