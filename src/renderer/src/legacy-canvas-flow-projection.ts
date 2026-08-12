import type { Edge, Node } from "@vue-flow/core";
import type {
  AdaptationStore,
  Artifact,
  CanvasEntity,
  CanvasLinkKind,
  CanvasPosition,
  CanvasSemanticState,
  WorkItem,
} from "../../core/types.js";

const STAGES: WorkItem["stage"][] = ["剧本", "硬锁资产", "首尾帧", "视频", "验收"];
const STAGE_X: Record<WorkItem["stage"], number> = { 剧本: 0, 硬锁资产: 350, 首尾帧: 700, 视频: 1_050, 验收: 1_400 };

export interface LegacyCanvasVisibleItem {
  item: WorkItem;
  artifacts: Artifact[];
}

export interface LegacyCanvasProjectionActions {
  editCanvasEntity(entity: CanvasEntity): void;
  removeCanvasEntity(id: string): void;
}

export interface LegacyCanvasFlowProjectionInput {
  visibleItems: ReadonlyArray<LegacyCanvasVisibleItem>;
  canvasState: CanvasSemanticState;
  adaptationWorkspace: AdaptationStore | null;
  positions: Readonly<Record<string, CanvasPosition>>;
  showNarrative: boolean;
  compact: boolean;
  actions: LegacyCanvasProjectionActions;
}

export interface LegacyCanvasFlowProjection {
  nodes: Node[];
  edges: Edge[];
}

/** 旧画布的同步只读投影；调用方已完成可见项冻结、坐标读取与异步 token 校验。 */
export function projectLegacyCanvasFlow(input: LegacyCanvasFlowProjectionInput): LegacyCanvasFlowProjection {
  const { visibleItems, canvasState, adaptationWorkspace, positions, showNarrative, compact, actions } = input;
  const items = visibleItems.map(({ item }) => item);
  const narrativeOffset = showNarrative ? 1_120 : 0;
  const stageItems: Record<WorkItem["stage"], LegacyCanvasVisibleItem[]> = {
    "剧本": [], "硬锁资产": [], "首尾帧": [], "视频": [], "验收": [],
  };
  for (const visibleItem of visibleItems) stageItems[visibleItem.item.stage].push(visibleItem);
  const maxRows = Math.max(3, ...STAGES.map((stage) => stageItems[stage].length), showNarrative ? adaptationWorkspace?.beats.length ?? 0 : 0);
  const laneHeight = Math.max(600, maxRows * 250 + 120);
  const nodes: Node[] = STAGES.map((stage, stageIndex) => ({
    id: `zone-${stage}`,
    type: "zone",
    position: { x: STAGE_X[stage] + narrativeOffset, y: 0 },
    data: { title: stage, count: stageItems[stage].length, index: `0${stageIndex + 1}`, height: laneHeight },
    draggable: false,
    selectable: false,
    connectable: false,
    zIndex: -1,
    style: { width: "320px", height: `${laneHeight}px` },
  }));
  const groupByMember = new Map<string, CanvasEntity>();
  canvasState.entities.filter((entity) => entity.kind === "group").forEach((group) => group.memberIds.forEach((memberId) => {
    if (!groupByMember.has(memberId)) groupByMember.set(memberId, group);
  }));
  for (const entity of [...canvasState.entities].sort((a, b) => Number(a.kind === "note") - Number(b.kind === "note") || a.createdAt.localeCompare(b.createdAt))) {
    nodes.push({
      id: entity.id,
      type: entity.kind,
      position: entity.position,
      data: { entity, onEdit: actions.editCanvasEntity, onDelete: actions.removeCanvasEntity },
      dragHandle: ".canvas-entity-handle",
      zIndex: entity.kind === "group" ? 0 : 4,
      style: { width: `${entity.width}px`, height: `${entity.height}px` },
    });
  }
  const narrativeEdges: Edge[] = [];
  const visibleIds = new Set(items.map((item) => item.id));
  if (showNarrative && adaptationWorkspace) {
    const workspace = adaptationWorkspace;
    const eventFacts = workspace.facts.filter((fact) => fact.kind === "event").sort((a, b) => (a.sourceSpans[0]?.startOffset ?? 0) - (b.sourceSpans[0]?.startOffset ?? 0));
    const eventFactIds = new Set(eventFacts.map((fact) => fact.id));
    const sourceFactCounts = new Map<string, number>();
    for (const fact of eventFacts) {
      const sourceId = fact.sourceSpans[0]?.sourceId;
      if (sourceId) sourceFactCounts.set(sourceId, (sourceFactCounts.get(sourceId) ?? 0) + 1);
    }
    [...sourceFactCounts].forEach(([sourceId, count], row) => nodes.push({ id: `narrative-source-${sourceId}`, type: "narrative", position: { x: 0, y: 72 + row * 150 }, data: { kind: "source", title: `原文 ${row + 1}`, detail: sourceId, meta: `${count} 个可视事件`, compact }, draggable: false, zIndex: 2 }));
    eventFacts.forEach((fact, row) => {
      const nodeId = `narrative-fact-${fact.id}`;
      nodes.push({ id: nodeId, type: "narrative", position: { x: 280, y: 72 + row * 150 }, data: { kind: "fact", title: fact.statement.slice(0, 72), detail: fact.epistemicStatus === "confirmed" ? "原文确认" : fact.epistemicStatus === "inferred" ? "明确推断" : "待确认", meta: `${fact.id} · R${fact.revision}`, compact }, draggable: false, zIndex: 2 });
      const sourceId = fact.sourceSpans[0]?.sourceId;
      if (sourceId) narrativeEdges.push({ id: `source-${sourceId}-${fact.id}`, source: `narrative-source-${sourceId}`, target: nodeId, type: "smoothstep", style: { stroke: "#666a61", strokeWidth: 1.2 } });
    });
    workspace.beats.forEach((beat, row) => {
      const nodeId = `narrative-beat-${beat.id}`;
      nodes.push({ id: nodeId, type: "narrative", position: { x: 560, y: 72 + row * 150 }, data: { kind: "beat", title: `${String(beat.order).padStart(2, "0")} · ${beat.title.slice(0, 58)}`, detail: beat.narrativePurpose, meta: `${beat.estimatedDurationSeconds.toFixed(1)}s · 强度 ${beat.intensity}/5`, compact }, draggable: false, zIndex: 2 });
      beat.factIds.filter((factId) => eventFactIds.has(factId)).forEach((factId) => narrativeEdges.push({ id: `fact-${factId}-${beat.id}`, source: `narrative-fact-${factId}`, target: nodeId, type: "smoothstep", style: { stroke: "#667d65", strokeWidth: 1.3 } }));
    });
    workspace.plans.slice(0, 2).forEach((plan, row) => {
      const nodeId = `narrative-plan-${plan.id}`;
      nodes.push({ id: nodeId, type: "narrative", position: { x: 840, y: 72 + row * 190 }, data: { kind: "plan", title: plan.mode === "concise" ? "精简模式" : "拆分模式", detail: `${plan.units.length} 个 15 秒单元 · ${plan.units.reduce((sum, unit) => sum + unit.storyboardRows.length, 0)} 镜`, meta: `${plan.status} · ${plan.validation.hardErrors.length} 硬错误`, compact }, draggable: false, zIndex: 2 });
      const beatIds = new Set(plan.units.flatMap((unit) => unit.beatIds));
      beatIds.forEach((beatId) => narrativeEdges.push({ id: `beat-${beatId}-${plan.id}`, source: `narrative-beat-${beatId}`, target: nodeId, type: "smoothstep", style: { stroke: "#9a7a35", strokeWidth: 1.4 } }));
      for (const itemId of new Set(plan.units.flatMap((unit) => unit.storyboardRows.map((storyboard) => storyboard.itemId)).filter((id) => !id.startsWith("planned:")))) if (visibleIds.has(itemId)) narrativeEdges.push({ id: `plan-${plan.id}-${itemId}`, source: nodeId, target: itemId, type: "smoothstep", animated: plan.status === "selected", style: { stroke: "#d7af55", strokeWidth: 2 } });
    });
  }
  for (const stage of STAGES) {
    stageItems[stage].sort((a, b) => (a.item.episode ?? 0) - (b.item.episode ?? 0) || (a.item.unit ?? 0) - (b.item.unit ?? 0) || a.item.id.localeCompare(b.item.id)).forEach(({ item, artifacts }, row) => {
      const globalPosition = positions[item.id] ?? { x: STAGE_X[stage] + narrativeOffset + 20, y: 72 + row * 250 };
      const parentGroup = groupByMember.get(item.id);
      const memberOffset = parentGroup?.memberOffsets[item.id] ?? (parentGroup ? { x: globalPosition.x - parentGroup.position.x, y: globalPosition.y - parentGroup.position.y } : undefined);
      nodes.push({
        id: item.id,
        type: "production",
        position: memberOffset ?? globalPosition,
        parentNode: parentGroup?.id,
        data: { item, artifacts, compact, videoCount: artifacts.filter((artifact) => artifact.kind === "video" && !artifact.deprecated).length },
        dragHandle: ".node-header",
        zIndex: 2,
      });
    });
  }
  const nodeIds = new Set([...visibleIds, ...canvasState.entities.map((entity) => entity.id)]);
  const dependencyEdges: Edge[] = items.flatMap((item) => item.dependencies.filter((dependency) => visibleIds.has(dependency)).map((dependency) => ({
    id: `${dependency}-${item.id}`, source: dependency, target: item.id, type: "smoothstep", animated: item.status === "视频生成中", style: { stroke: item.status === "已完成" ? "#6d7f62" : "#6c6758", strokeWidth: 1.5 },
  })));
  const linkColors: Record<CanvasLinkKind, string> = { continuity: "#d7af55", reference: "#70a7c5", dependency: "#d36b59", comment: "#b98fdf" };
  const semanticEdges: Edge[] = canvasState.links.filter((link) => nodeIds.has(link.sourceId) && nodeIds.has(link.targetId)).map((link) => ({
    id: link.id, source: link.sourceId, target: link.targetId, type: "smoothstep", label: link.label || ({ continuity: "连续性", reference: "参考", dependency: "依赖", comment: "说明" } as const)[link.kind], zIndex: 3,
    style: { stroke: linkColors[link.kind], strokeWidth: 2, strokeDasharray: link.kind === "dependency" ? undefined : "6 4" }, labelStyle: { fill: linkColors[link.kind], fontSize: 9 }, labelBgStyle: { fill: "#151613", fillOpacity: 0.92 },
  }));
  return { nodes, edges: [...narrativeEdges, ...dependencyEdges, ...semanticEdges] };
}
