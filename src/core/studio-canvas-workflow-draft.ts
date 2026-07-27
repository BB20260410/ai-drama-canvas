/**
 * 生产画布工作流草稿的 browser-safe 纯函数合同。
 *
 * 本模块只规范化视图层节点/边，并提取每个宫格的连接摘要；它不读取工程、
 * 不写入业务 owner，也不触发绑定、冻结或生成。
 */

export const STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES = 512;
export const STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES = 1_024;
export const STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL = 6;

export type StudioCanvasWorkflowDraftNodeKind = "asset" | "script" | "prompt" | "panel";

export type StudioCanvasWorkflowDraftNodeInput =
  | { id: string; kind: "asset"; assetId: string }
  | { id: string; kind: "script"; documentId: string }
  | { id: string; kind: "prompt"; documentId: string }
  | { id: string; kind: "panel"; panelId: string };

export type StudioCanvasWorkflowDraftNode = StudioCanvasWorkflowDraftNodeInput;

export interface StudioCanvasWorkflowDraftEdgeInput {
  /** 省略时根据规范化后的端点生成稳定 ID。 */
  id?: string;
  sourceId: string;
  targetId: string;
}

export interface StudioCanvasWorkflowDraftEdge {
  id: string;
  /** 始终是 asset/script/prompt 节点。 */
  sourceId: string;
  /** 始终是 panel 节点。 */
  targetId: string;
}

export interface StudioCanvasWorkflowPanelConnections {
  panelNodeId: string;
  panelId: string;
  assetIds: string[];
  scriptDocumentId: string | null;
  promptDocumentId: string | null;
}

export interface StudioCanvasWorkflowDraftInput {
  nodes: readonly StudioCanvasWorkflowDraftNodeInput[];
  edges: readonly StudioCanvasWorkflowDraftEdgeInput[];
}

export interface StudioCanvasWorkflowDraft {
  schemaVersion: 1;
  kind: "studio-canvas-workflow-draft";
  bounded: true;
  limits: {
    maxNodes: typeof STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES;
    maxEdges: typeof STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES;
    maxAssetsPerPanel: typeof STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL;
    maxScriptsPerPanel: 1;
    maxPromptsPerPanel: 1;
  };
  nodes: StudioCanvasWorkflowDraftNode[];
  edges: StudioCanvasWorkflowDraftEdge[];
  panels: StudioCanvasWorkflowPanelConnections[];
}

export type StudioCanvasWorkflowDraftErrorCode =
  | "invalid-input"
  | "limit-exceeded"
  | "invalid-id"
  | "duplicate-node"
  | "duplicate-reference"
  | "missing-endpoint"
  | "self-loop"
  | "invalid-edge-kind"
  | "duplicate-edge"
  | "panel-limit-exceeded";

export class StudioCanvasWorkflowDraftError extends Error {
  readonly code: StudioCanvasWorkflowDraftErrorCode;

  constructor(code: StudioCanvasWorkflowDraftErrorCode, message: string) {
    super(message);
    this.name = "StudioCanvasWorkflowDraftError";
    this.code = code;
  }
}

export type StudioCanvasWorkflowDraftValidationResult =
  | { ok: true; draft: StudioCanvasWorkflowDraft }
  | { ok: false; error: { code: StudioCanvasWorkflowDraftErrorCode; message: string } };

const NODE_KIND_ORDER: Readonly<Record<StudioCanvasWorkflowDraftNodeKind, number>> = {
  asset: 0,
  script: 1,
  prompt: 2,
  panel: 3,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new StudioCanvasWorkflowDraftError("invalid-id", `${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new StudioCanvasWorkflowDraftError("invalid-id", `${label}不能为空。`);
  }
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new StudioCanvasWorkflowDraftError("invalid-id", `${label}格式不正确。`);
  }
  return normalized;
}

function normalizeNode(value: StudioCanvasWorkflowDraftNodeInput): StudioCanvasWorkflowDraftNode {
  if (!value || typeof value !== "object") {
    throw new StudioCanvasWorkflowDraftError("invalid-input", "节点格式不正确。");
  }
  const id = normalizeId(value.id, "节点 ID");
  switch (value.kind) {
    case "asset":
      return { id, kind: value.kind, assetId: normalizeId(value.assetId, "资产 ID") };
    case "script":
      return { id, kind: value.kind, documentId: normalizeId(value.documentId, "剧本文档 ID") };
    case "prompt":
      return { id, kind: value.kind, documentId: normalizeId(value.documentId, "提示词文档 ID") };
    case "panel":
      return { id, kind: value.kind, panelId: normalizeId(value.panelId, "宫格 ID") };
    default:
      throw new StudioCanvasWorkflowDraftError("invalid-input", "节点类型只允许资产、剧本、提示词或宫格。");
  }
}

function nodeReferenceKey(node: StudioCanvasWorkflowDraftNode): string {
  switch (node.kind) {
    case "asset": return `${node.kind}\u0000${node.assetId}`;
    case "script": return `${node.kind}\u0000${node.documentId}`;
    case "prompt": return `${node.kind}\u0000${node.documentId}`;
    case "panel": return `${node.kind}\u0000${node.panelId}`;
  }
}

function stableEdgeId(sourceId: string, targetId: string): string {
  return `draft-edge:${encodeURIComponent(sourceId)}:${encodeURIComponent(targetId)}`;
}

function sortNodes(nodes: StudioCanvasWorkflowDraftNode[]): StudioCanvasWorkflowDraftNode[] {
  return nodes.sort((left, right) => (
    NODE_KIND_ORDER[left.kind] - NODE_KIND_ORDER[right.kind]
    || compareText(left.id, right.id)
  ));
}

function sortEdges(edges: StudioCanvasWorkflowDraftEdge[]): StudioCanvasWorkflowDraftEdge[] {
  return edges.sort((left, right) => (
    compareText(left.targetId, right.targetId)
    || compareText(left.sourceId, right.sourceId)
    || compareText(left.id, right.id)
  ));
}

function ensureArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new StudioCanvasWorkflowDraftError("invalid-input", `${label}必须是数组。`);
  }
}

/**
 * 规范化并校验只读工作流草稿。
 *
 * 用户从任一方向拖出的 asset/script/prompt ↔ panel 边都会被规范为输入节点 → panel；
 * 其他节点组合失败关闭。
 */
export function normalizeStudioCanvasWorkflowDraft(
  input: StudioCanvasWorkflowDraftInput,
): StudioCanvasWorkflowDraft {
  if (!input || typeof input !== "object") {
    throw new StudioCanvasWorkflowDraftError("invalid-input", "工作流草稿不能为空。");
  }
  ensureArray(input.nodes, "节点");
  ensureArray(input.edges, "边");
  if (input.nodes.length > STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES) {
    throw new StudioCanvasWorkflowDraftError(
      "limit-exceeded",
      `节点超过上限 ${STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES}，请先分页或筛选。`,
    );
  }
  if (input.edges.length > STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES) {
    throw new StudioCanvasWorkflowDraftError(
      "limit-exceeded",
      `边超过上限 ${STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES}，请先分页或筛选。`,
    );
  }

  const nodes = input.nodes.map(normalizeNode);
  const nodeById = new Map<string, StudioCanvasWorkflowDraftNode>();
  const referenceKeys = new Set<string>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) {
      throw new StudioCanvasWorkflowDraftError("duplicate-node", `节点 ID 重复：${node.id}。`);
    }
    const referenceKey = nodeReferenceKey(node);
    if (referenceKeys.has(referenceKey)) {
      throw new StudioCanvasWorkflowDraftError("duplicate-reference", `节点引用重复：${node.id}。`);
    }
    nodeById.set(node.id, node);
    referenceKeys.add(referenceKey);
  }

  const normalizedEdges: StudioCanvasWorkflowDraftEdge[] = [];
  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  for (const edge of input.edges) {
    if (!edge || typeof edge !== "object") {
      throw new StudioCanvasWorkflowDraftError("invalid-input", "边格式不正确。");
    }
    let sourceId = normalizeId(edge.sourceId, "边 sourceId");
    let targetId = normalizeId(edge.targetId, "边 targetId");
    if (sourceId === targetId) {
      throw new StudioCanvasWorkflowDraftError("self-loop", `禁止自环：${sourceId}。`);
    }
    let source = nodeById.get(sourceId);
    let target = nodeById.get(targetId);
    if (!source || !target) {
      throw new StudioCanvasWorkflowDraftError("missing-endpoint", `边端点不存在：${sourceId} → ${targetId}。`);
    }

    if (source.kind === "panel" && target.kind !== "panel") {
      [sourceId, targetId] = [targetId, sourceId];
      [source, target] = [target, source];
    }
    if (source.kind === "panel" || target.kind !== "panel") {
      throw new StudioCanvasWorkflowDraftError(
        "invalid-edge-kind",
        "只允许资产、剧本或提示词连接到宫格。",
      );
    }

    const id = edge.id === undefined
      ? stableEdgeId(sourceId, targetId)
      : normalizeId(edge.id, "边 ID");
    const pair = `${sourceId}\u0000${targetId}`;
    if (edgeIds.has(id) || endpointPairs.has(pair)) {
      throw new StudioCanvasWorkflowDraftError("duplicate-edge", `边重复：${sourceId} → ${targetId}。`);
    }
    edgeIds.add(id);
    endpointPairs.add(pair);
    normalizedEdges.push({ id, sourceId, targetId });
  }

  const connectionsByPanelNode = new Map<string, {
    assets: string[];
    scripts: string[];
    prompts: string[];
  }>();
  for (const node of nodes) {
    if (node.kind === "panel") {
      connectionsByPanelNode.set(node.id, { assets: [], scripts: [], prompts: [] });
    }
  }
  for (const edge of normalizedEdges) {
    const source = nodeById.get(edge.sourceId)!;
    const connected = connectionsByPanelNode.get(edge.targetId)!;
    if (source.kind === "asset") connected.assets.push(source.assetId);
    if (source.kind === "script") connected.scripts.push(source.documentId);
    if (source.kind === "prompt") connected.prompts.push(source.documentId);
  }

  const panels = nodes
    .filter((node): node is Extract<StudioCanvasWorkflowDraftNode, { kind: "panel" }> => node.kind === "panel")
    .map((panel): StudioCanvasWorkflowPanelConnections => {
      const connected = connectionsByPanelNode.get(panel.id)!;
      const assetIds = connected.assets.sort(compareText);
      if (assetIds.length > STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL) {
        throw new StudioCanvasWorkflowDraftError(
          "panel-limit-exceeded",
          `宫格 ${panel.panelId} 的资产超过上限 ${STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL}。`,
        );
      }
      if (connected.scripts.length > 1) {
        throw new StudioCanvasWorkflowDraftError("panel-limit-exceeded", `宫格 ${panel.panelId} 最多连接一个剧本文档。`);
      }
      if (connected.prompts.length > 1) {
        throw new StudioCanvasWorkflowDraftError("panel-limit-exceeded", `宫格 ${panel.panelId} 最多连接一个提示词文档。`);
      }
      return {
        panelNodeId: panel.id,
        panelId: panel.panelId,
        assetIds,
        scriptDocumentId: connected.scripts[0] ?? null,
        promptDocumentId: connected.prompts[0] ?? null,
      };
    })
    .sort((left, right) => compareText(left.panelId, right.panelId) || compareText(left.panelNodeId, right.panelNodeId));

  return {
    schemaVersion: 1,
    kind: "studio-canvas-workflow-draft",
    bounded: true,
    limits: {
      maxNodes: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_NODES,
      maxEdges: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_EDGES,
      maxAssetsPerPanel: STUDIO_CANVAS_WORKFLOW_DRAFT_MAX_ASSETS_PER_PANEL,
      maxScriptsPerPanel: 1,
      maxPromptsPerPanel: 1,
    },
    nodes: sortNodes(nodes),
    edges: sortEdges(normalizedEdges),
    panels,
  };
}

export function validateStudioCanvasWorkflowDraft(
  input: StudioCanvasWorkflowDraftInput,
): StudioCanvasWorkflowDraftValidationResult {
  try {
    return { ok: true, draft: normalizeStudioCanvasWorkflowDraft(input) };
  } catch (error) {
    if (error instanceof StudioCanvasWorkflowDraftError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
}

export function extractStudioCanvasWorkflowPanelConnections(
  input: StudioCanvasWorkflowDraftInput,
): StudioCanvasWorkflowPanelConnections[] {
  return normalizeStudioCanvasWorkflowDraft(input).panels;
}
