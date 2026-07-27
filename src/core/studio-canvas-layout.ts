/**
 * Studio 生产画布布局合同（视图层，非事实源）。
 *
 * 设计对齐 LocalMiniDrama 公开计划中的原则（MIT，clean-room）：
 * - 真源仍是 unit/panel/asset/media/CAS；
 * - 画布只持久化坐标、视口、工作区模式、固定节点、草稿边与工作流组引用 ID；
 * - 草稿边仅供视觉编排和 Start 输入一致性预检，不能替代 BindingSet/冻结包 owner；
 * - 未知字段可忽略；无布局时调用方可自动布局。
 *
 * 本模块不读写磁盘/SQLite；调用方决定 sidecar 路径。
 */
import { createHash } from "node:crypto";
import { validateStudioCanvasEdges } from "./studio-canvas-edge-validation.js";
import type {
  StudioCanvasLayout,
  StudioCanvasLayoutDraft,
  StudioCanvasNodePosition,
  StudioCanvasViewport,
  StudioCanvasWorkflowGroup,
  StudioCanvasDraftEdge,
  StudioCanvasWorkflowStep,
  StudioCanvasWorkspaceMode,
} from "./studio-canvas-layout-types.js";
export type {
  StudioCanvasLayout,
  StudioCanvasLayoutDraft,
  StudioCanvasNodePosition,
  StudioCanvasViewport,
  StudioCanvasWorkflowGroup,
  StudioCanvasDraftEdge,
  StudioCanvasWorkflowStep,
  StudioCanvasWorkspaceMode,
} from "./studio-canvas-layout-types.js";
export {
  collectStudioCanvasNodePositions,
  resolveStudioCanvasNodePosition,
  studioCanvasNodeId,
} from "./studio-canvas-layout-geometry.js";
import { studioCanvasNodeId } from "./studio-canvas-layout-geometry.js";

export type StudioCanvasLayoutErrorCode = "invalid-input" | "schema-unsupported";

export class StudioCanvasLayoutError extends Error {
  readonly code: StudioCanvasLayoutErrorCode;
  readonly details: string[];

  constructor(code: StudioCanvasLayoutErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "StudioCanvasLayoutError";
    this.code = code;
    this.details = details;
  }
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const MAX_NODES = 5_000;
const MAX_PINNED_NODE_IDS = MAX_NODES;
const MAX_DRAFT_CANVAS_EDGES = 10_000;
const MAX_GROUPS = 200;
const MAX_PANELS_PER_GROUP = 64;
const PIPELINE_STEPS = new Set<StudioCanvasWorkflowStep>(["image", "video", "audio", "review"]);

function fail(code: StudioCanvasLayoutErrorCode, message: string, details: string[] = []): never {
  throw new StudioCanvasLayoutError(code, message, details);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid-input", `${field} 必须是有限数字。`);
  }
  return value;
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!NODE_ID_PATTERN.test(normalized)) fail("invalid-input", `${field} 非法：${value}`);
  return normalized;
}

function normalizeViewport(input: Partial<StudioCanvasViewport> | undefined): StudioCanvasViewport {
  const x = finiteNumber(input?.x ?? 0, "viewport.x");
  const y = finiteNumber(input?.y ?? 0, "viewport.y");
  const zoom = finiteNumber(input?.zoom ?? 1, "viewport.zoom");
  if (zoom <= 0 || zoom > 8) fail("invalid-input", "viewport.zoom 必须在 (0, 8]。");
  return { x, y, zoom };
}

function normalizeNodes(nodes: Record<string, StudioCanvasNodePosition> | undefined): Record<string, StudioCanvasNodePosition> {
  const source = nodes ?? {};
  const keys = Object.keys(source);
  if (keys.length > MAX_NODES) fail("invalid-input", `nodes 超过上限 ${MAX_NODES}。`);
  const out: Record<string, StudioCanvasNodePosition> = {};
  for (const key of keys.sort((a, b) => a.localeCompare(b, "en"))) {
    const id = requiredId(key, "nodes.key");
    const pos = source[key]!;
    out[id] = {
      x: finiteNumber(pos.x, `nodes.${id}.x`),
      y: finiteNumber(pos.y, `nodes.${id}.y`),
    };
  }
  return out;
}

function normalizeWorkspaceMode(mode: StudioCanvasWorkspaceMode | undefined): StudioCanvasWorkspaceMode {
  const value = mode ?? "projection";
  if (value !== "projection" && value !== "workflow") {
    fail("invalid-input", `workspaceMode 非法：${String(value)}`);
  }
  return value;
}

function normalizePinnedNodeIds(nodeIds: string[] | undefined): string[] {
  if (nodeIds === undefined) return [];
  if (!Array.isArray(nodeIds)) fail("invalid-input", "pinnedNodeIds 必须是数组。");
  if (nodeIds.length > MAX_PINNED_NODE_IDS) {
    fail("invalid-input", `pinnedNodeIds 超过上限 ${MAX_PINNED_NODE_IDS}。`);
  }
  const out = nodeIds.map((nodeId, index) => {
    if (typeof nodeId !== "string") fail("invalid-input", `pinnedNodeIds[${index}] 必须是字符串。`);
    return requiredId(nodeId, `pinnedNodeIds[${index}]`);
  });
  if (new Set(out).size !== out.length) fail("invalid-input", "pinnedNodeIds 含重复。");
  return out;
}

function normalizeDraftCanvasEdges(edges: StudioCanvasDraftEdge[] | undefined): StudioCanvasDraftEdge[] {
  if (edges === undefined) return [];
  if (!Array.isArray(edges)) fail("invalid-input", "draftCanvasEdges 必须是数组。");
  if (edges.length > MAX_DRAFT_CANVAS_EDGES) {
    fail("invalid-input", `draftCanvasEdges 超过上限 ${MAX_DRAFT_CANVAS_EDGES}。`);
  }
  const candidates = edges.map((edge, index) => {
    if (!edge || typeof edge !== "object") fail("invalid-input", `draftCanvasEdges[${index}] 必须是对象。`);
    if (typeof edge.sourceId !== "string" || typeof edge.targetId !== "string") {
      fail("invalid-input", `draftCanvasEdges[${index}] 必须包含字符串 sourceId/targetId。`);
    }
    if (typeof edge.sourceKind !== "string" || typeof edge.targetKind !== "string") {
      fail("invalid-input", `draftCanvasEdges[${index}] 必须包含字符串 sourceKind/targetKind。`);
    }
    return {
      sourceId: requiredId(edge.sourceId, `draftCanvasEdges[${index}].sourceId`),
      targetId: requiredId(edge.targetId, `draftCanvasEdges[${index}].targetId`),
      sourceKind: edge.sourceKind.trim(),
      targetKind: edge.targetKind.trim(),
    };
  });
  const validation = validateStudioCanvasEdges(candidates);
  if (!validation.ok) {
    fail(
      "invalid-input",
      `draftCanvasEdges 非法：${validation.issues[0]?.message ?? "unknown"}`,
      validation.issues.map((issue) => issue.message),
    );
  }
  return validation.accepted;
}

function normalizeWorkflowGroups(groups: StudioCanvasWorkflowGroup[] | undefined): StudioCanvasWorkflowGroup[] {
  const list = groups ?? [];
  if (list.length > MAX_GROUPS) fail("invalid-input", `workflowGroups 超过上限 ${MAX_GROUPS}。`);
  const ids = new Set<string>();
  return list.map((group, index) => {
    const id = requiredId(group.id, `workflowGroups[${index}].id`);
    if (ids.has(id)) fail("invalid-input", `workflowGroups id 重复：${id}`);
    ids.add(id);
    const title = group.title.trim();
    if (!title || title.length > 120) fail("invalid-input", `workflowGroups[${index}].title 无效。`);
    if (!Array.isArray(group.panelIds) || group.panelIds.length === 0) {
      fail("invalid-input", `workflowGroups[${index}].panelIds 不能为空。`);
    }
    if (group.panelIds.length > MAX_PANELS_PER_GROUP) {
      fail("invalid-input", `workflowGroups[${index}].panelIds 超过 ${MAX_PANELS_PER_GROUP}。`);
    }
    const panelIds = group.panelIds.map((panelId, panelIndex) => requiredId(panelId, `workflowGroups[${index}].panelIds[${panelIndex}]`));
    if (new Set(panelIds).size !== panelIds.length) {
      fail("invalid-input", `workflowGroups[${index}].panelIds 含重复。`);
    }
    if (!Array.isArray(group.pipeline) || group.pipeline.length === 0) {
      fail("invalid-input", `workflowGroups[${index}].pipeline 不能为空。`);
    }
    const pipeline = group.pipeline.map((step, stepIndex) => {
      if (!PIPELINE_STEPS.has(step)) {
        fail("invalid-input", `workflowGroups[${index}].pipeline[${stepIndex}] 非法：${step}`);
      }
      return step;
    });
    const createdAt = group.createdAt.trim();
    if (!createdAt) fail("invalid-input", `workflowGroups[${index}].createdAt 不能为空。`);
    return { id, title, panelIds, pipeline, createdAt };
  });
}

/** 规范化并计算内容指纹。 */
export function normalizeStudioCanvasLayout(draft: StudioCanvasLayoutDraft): StudioCanvasLayout {
  const viewport = normalizeViewport(draft.viewport);
  const nodes = normalizeNodes(draft.nodes);
  const workspaceMode = normalizeWorkspaceMode(draft.workspaceMode);
  const pinnedNodeIds = normalizePinnedNodeIds(draft.pinnedNodeIds);
  const draftCanvasEdges = normalizeDraftCanvasEdges(draft.draftCanvasEdges);
  const workflowGroups = normalizeWorkflowGroups(draft.workflowGroups);
  const updatedAt = (draft.updatedAt ?? new Date().toISOString()).trim();
  if (!updatedAt) fail("invalid-input", "updatedAt 不能为空。");
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-canvas-layout" as const,
    viewport,
    nodes,
    workspaceMode,
    pinnedNodeIds,
    draftCanvasEdges,
    workflowGroups,
    updatedAt,
  };
  return {
    ...semantic,
    fingerprint: digest(semantic),
  };
}

/** 合并已有布局与补丁；节点坐标按 key 覆盖，各数组字段整体替换（若提供）。 */
export function mergeStudioCanvasLayout(
  base: StudioCanvasLayout | null | undefined,
  patch: StudioCanvasLayoutDraft,
): StudioCanvasLayout {
  if (base && (base.schemaVersion !== 1 || base.kind !== "studio-canvas-layout")) {
    fail("schema-unsupported", "只接受 schemaVersion=1 的 studio-canvas-layout。");
  }
  const mergedNodes = { ...(base?.nodes ?? {}), ...(patch.nodes ?? {}) };
  return normalizeStudioCanvasLayout({
    viewport: { ...(base?.viewport ?? { x: 0, y: 0, zoom: 1 }), ...(patch.viewport ?? {}) },
    nodes: mergedNodes,
    workspaceMode: patch.workspaceMode ?? base?.workspaceMode ?? "projection",
    pinnedNodeIds: patch.pinnedNodeIds ?? base?.pinnedNodeIds ?? [],
    draftCanvasEdges: patch.draftCanvasEdges ?? base?.draftCanvasEdges ?? [],
    workflowGroups: patch.workflowGroups ?? base?.workflowGroups ?? [],
    updatedAt: patch.updatedAt,
  });
}

/** 稳定节点 id 约定（与 UI 适配器对齐）。 */
/**
 * 默认竖排自动布局：每 panel 一行，行距固定。
 * 不读取业务数据，仅几何。
 */
export function autoLayoutStudioPanels(
  panelIds: readonly string[],
  options?: { originX?: number; originY?: number; rowGap?: number },
): Record<string, StudioCanvasNodePosition> {
  const originX = options?.originX ?? 360;
  const originY = options?.originY ?? 80;
  const rowGap = options?.rowGap ?? 140;
  if (!Number.isFinite(originX) || !Number.isFinite(originY) || !Number.isFinite(rowGap) || rowGap <= 0) {
    fail("invalid-input", "autoLayout 参数非法。");
  }
  if (panelIds.length > MAX_NODES) fail("invalid-input", `panelIds 超过 ${MAX_NODES}。`);
  const nodes: Record<string, StudioCanvasNodePosition> = {};
  panelIds.forEach((panelId, index) => {
    const id = studioCanvasNodeId("panel", panelId);
    nodes[id] = { x: originX, y: originY + index * rowGap };
  });
  return nodes;
}

/**
 * 解析节点坐标：会话中拖动的位置 > 已持久化 layout > 默认自动布局点。
 * UI 与测试共用，避免 renderer 内重复优先级逻辑。
 */
