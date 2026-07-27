/**
 * 受管无限画布 · 剧情时间线布局与系统连线（纯几何/投影，无 SQLite/path）。
 *
 * 目标：资产列 → 15s 单元时间序 → 选中单元宫格（按 startSeconds）→ raw/labeled/review 流水线；
 * 系统边表达依赖，用户 draft 边不在此生成。
 */
import { validateStudioCanvasEdges, type StudioCanvasNodeKind } from "./studio-canvas-edge-validation.js";

export const STUDIO_CANVAS_TIMELINE_MAX_UNITS = 36;
export const STUDIO_CANVAS_TIMELINE_MAX_PANELS_PER_UNIT = 6;
export const STUDIO_CANVAS_TIMELINE_MAX_ASSETS = 36;
export const STUDIO_CANVAS_TIMELINE_MAX_REFERENCES_PER_UNIT = 6;

export interface StudioCanvasTimelineAssetInput {
  assetId: string;
  category: "character" | "scene" | "prop" | string;
  label?: string;
}

export interface StudioCanvasTimelinePanelInput {
  panelId: string;
  ordinal: number;
  label?: string;
  startSeconds: number;
  endSeconds?: number;
  assetIds?: readonly string[];
  hasRaw?: boolean;
  hasLabeled?: boolean;
  reviewDecision?: "pass" | "rework" | "reject" | "none" | "stale" | "unreviewed";
}

export interface StudioCanvasTimelineReferenceInput {
  /** pack 内稳定 referenceId；节点会按 unitId 作用域隔离。 */
  referenceId: string;
  referenceType: "character" | "scene" | "prop" | "style" | "vfx" | "mixed";
  label?: string;
}

export interface StudioCanvasTimelineUnitInput {
  unitId: string;
  label?: string;
  /** 剧情序；缺省时按输入数组顺序 */
  sequence?: number;
  /** 仅当最新整板 raw 已与 labeled 成对且人工审片 PASS 时为 true。 */
  hasApprovedUnitGridRaw?: boolean;
  /** 该正式整板生成时实际冻结并提交的 approved 控制参考图。 */
  references?: readonly StudioCanvasTimelineReferenceInput[];
  panels?: readonly StudioCanvasTimelinePanelInput[];
}

export interface StudioCanvasTimelineLayoutOptions {
  originX?: number;
  originY?: number;
  assetColX?: number;
  unitRowY?: number;
  unitColGap?: number;
  panelRowGap?: number;
  pipelineColGap?: number;
  assetRowGap?: number;
  /** 仅对 activeUnitId 展开宫格流水线；缺省取第一个带 panels 的单元 */
  activeUnitId?: string;
}

export interface StudioCanvasTimelineNodePosition {
  x: number;
  y: number;
}

export interface StudioCanvasTimelineEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceKind: StudioCanvasNodeKind;
  targetKind: StudioCanvasNodeKind;
  label: string;
  /** system = 自动时间线依赖；不写入 draft */
  role: "system";
}

export interface StudioCanvasTimelineLayout {
  schemaVersion: 1;
  kind: "studio-canvas-timeline-layout";
  unitCount: number;
  panelCount: number;
  assetCount: number;
  activeUnitId?: string;
  nodes: Record<string, StudioCanvasTimelineNodePosition>;
  edges: StudioCanvasTimelineEdge[];
  /** 宫格时间序（仅 active unit）供进度条 */
  panelTimeline: Array<{
    panelId: string;
    ordinal: number;
    startSeconds: number;
    hasRaw: boolean;
    hasLabeled: boolean;
    reviewDecision: string;
  }>;
}

export class StudioCanvasTimelineLayoutError extends Error {
  readonly code: "invalid-input" | "unbounded-rejected";

  constructor(code: "invalid-input" | "unbounded-rejected", message: string) {
    super(message);
    this.name = "StudioCanvasTimelineLayoutError";
    this.code = code;
  }
}

function fail(code: "invalid-input" | "unbounded-rejected", message: string): never {
  throw new StudioCanvasTimelineLayoutError(code, message);
}

function requiredId(value: string | undefined, field: string): string {
  const id = value?.trim() ?? "";
  if (!id) fail("invalid-input", `${field} 不能为空。`);
  return id;
}

const CATEGORY_ORDER: Record<string, number> = { character: 0, scene: 1, prop: 2, style: 3 };

/**
 * 按剧情时间线计算默认坐标与系统连线。
 * - 单元：从左到右按 sequence（或输入序）
 * - 宫格：仅 active unit，按 startSeconds → ordinal 自上而下
 * - 正式整板参考：每单元 raw 下方按 pack 顺序纵向排列，并由 reference→raw 类型化连线
 * - 流水线：panel → raw → labeled → review 向右
 * - 系统边：unit→panel、panel→panel(next)、panel 流水线、asset→panel（双方均在图中）
 */
export function buildStudioCanvasTimelineLayout(
  input: {
    units: readonly StudioCanvasTimelineUnitInput[];
    assets?: readonly StudioCanvasTimelineAssetInput[];
  },
  options?: StudioCanvasTimelineLayoutOptions,
): StudioCanvasTimelineLayout {
  const unitsIn = input.units ?? [];
  if (unitsIn.length > STUDIO_CANVAS_TIMELINE_MAX_UNITS) {
    fail("unbounded-rejected", `单元超过上限 ${STUDIO_CANVAS_TIMELINE_MAX_UNITS}，请分页。`);
  }
  const assetsIn = input.assets ?? [];
  if (assetsIn.length > STUDIO_CANVAS_TIMELINE_MAX_ASSETS) {
    fail("unbounded-rejected", `资产超过上限 ${STUDIO_CANVAS_TIMELINE_MAX_ASSETS}。`);
  }

  const originX = options?.originX ?? 40;
  const originY = options?.originY ?? 80;
  const assetColX = options?.assetColX ?? originX;
  const unitRowY = options?.unitRowY ?? originY;
  // 每个单元正式整板后还需要留出视频包与末格连续状态两列。
  // 600 能保证上一单元的连续状态卡不与下一单元的正式整板重叠；
  // 用户仍可在画布上手动压缩或使用已保存布局。
  const unitColGap = options?.unitColGap ?? 600;
  const panelRowGap = options?.panelRowGap ?? 160;
  const pipelineColGap = options?.pipelineColGap ?? 220;
  const assetRowGap = options?.assetRowGap ?? 150;
  for (const [name, value] of Object.entries({ originX, originY, assetColX, unitRowY, unitColGap, panelRowGap, pipelineColGap, assetRowGap })) {
    if (!Number.isFinite(value) || (name.includes("Gap") && (value as number) <= 0)) {
      fail("invalid-input", `${name} 非法。`);
    }
  }

  const units = [...unitsIn]
    .map((unit, index) => ({
      unitId: requiredId(unit.unitId, `units[${index}].unitId`),
      label: unit.label?.trim() || unit.unitId,
      sequence: Number.isFinite(unit.sequence) ? Number(unit.sequence) : index + 1,
      hasApprovedUnitGridRaw: Boolean(unit.hasApprovedUnitGridRaw),
      references: unit.references ?? [],
      panels: unit.panels ?? [],
      index,
    }))
    .sort((a, b) => a.sequence - b.sequence || a.index - b.index);

  const seenUnit = new Set<string>();
  for (const unit of units) {
    if (seenUnit.has(unit.unitId)) fail("invalid-input", `单元 ID 重复：${unit.unitId}`);
    seenUnit.add(unit.unitId);
    if (unit.panels.length > STUDIO_CANVAS_TIMELINE_MAX_PANELS_PER_UNIT) {
      fail("unbounded-rejected", `单元 ${unit.unitId} 宫格超过 ${STUDIO_CANVAS_TIMELINE_MAX_PANELS_PER_UNIT}。`);
    }
    if (unit.references.length > STUDIO_CANVAS_TIMELINE_MAX_REFERENCES_PER_UNIT) {
      fail("unbounded-rejected", `单元 ${unit.unitId} 冻结参考超过 ${STUDIO_CANVAS_TIMELINE_MAX_REFERENCES_PER_UNIT}。`);
    }
    const seenReference = new Set<string>();
    for (const [referenceIndex, reference] of unit.references.entries()) {
      const referenceId = requiredId(reference.referenceId, `unit ${unit.unitId} references[${referenceIndex}].referenceId`);
      if (seenReference.has(referenceId)) fail("invalid-input", `单元 ${unit.unitId} 冻结参考 ID 重复：${referenceId}`);
      seenReference.add(referenceId);
    }
  }

  const assets = [...assetsIn]
    .map((asset, index) => ({
      assetId: requiredId(asset.assetId, `assets[${index}].assetId`),
      category: (asset.category || "prop").trim(),
      label: asset.label?.trim() || asset.assetId,
      index,
    }))
    .sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9) || a.index - b.index);

  const seenAsset = new Set<string>();
  for (const asset of assets) {
    if (seenAsset.has(asset.assetId)) fail("invalid-input", `资产 ID 重复：${asset.assetId}`);
    seenAsset.add(asset.assetId);
  }

  const activeUnitId = options?.activeUnitId?.trim()
    || units.find((unit) => unit.panels.length > 0)?.unitId;

  const nodes: Record<string, StudioCanvasTimelineNodePosition> = {};
  const edges: StudioCanvasTimelineEdge[] = [];

  assets.forEach((asset, index) => {
    nodes[`asset:${asset.assetId}`] = {
      x: assetColX,
      y: originY + index * assetRowGap,
    };
  });

  const unitTrackX0 = assetColX + 280;
  units.forEach((unit, index) => {
    nodes[`unit:${unit.unitId}`] = {
      x: unitTrackX0 + index * unitColGap,
      y: unitRowY,
    };
    if (index > 0) {
      const prev = units[index - 1]!;
      edges.push({
        id: `system:unit-next:${prev.unitId}:${unit.unitId}`,
        sourceId: `unit:${prev.unitId}`,
        targetId: `unit:${unit.unitId}`,
        sourceKind: "unit",
        targetKind: "unit",
        label: "下一单元",
        role: "system",
      });
    }
    if (unit.hasApprovedUnitGridRaw) {
      const rawId = `media:unit-grid-raw:${unit.unitId}`;
      nodes[rawId] = {
        x: unitTrackX0 + index * unitColGap,
        y: unitRowY + 156,
      };
      // 这两个节点由渲染层根据真实提交包/连续性数据决定是否显示；
      // 但默认编排必须预留它们的位置，避免新项目或“强制时间线”后与下一单元重叠。
      nodes[`video-package:${unit.unitId}`] = {
        x: unitTrackX0 + index * unitColGap + 180,
        y: unitRowY + 156,
      };
      nodes[`continuity:out:${unit.unitId}`] = {
        x: unitTrackX0 + index * unitColGap + 360,
        y: unitRowY + 156,
      };
      edges.push({
        id: `system:unit-raw:${unit.unitId}`,
        sourceId: `unit:${unit.unitId}`,
        targetId: rawId,
        sourceKind: "unit",
        targetKind: "raw",
        label: "正式整板",
        role: "system",
      });
      unit.references.forEach((reference, referenceIndex) => {
        const referenceId = requiredId(reference.referenceId, `unit ${unit.unitId} referenceId`);
        const referenceNodeId = `reference:${unit.unitId}:${referenceId}`;
        nodes[referenceNodeId] = {
          x: unitTrackX0 + index * unitColGap + (referenceIndex % 3) * 180,
          y: unitRowY + 350 + Math.floor(referenceIndex / 3) * 170,
        };
        edges.push({
          id: `system:reference-raw:${unit.unitId}:${referenceId}`,
          sourceId: referenceNodeId,
          targetId: rawId,
          sourceKind: "asset",
          targetKind: "raw",
          label: reference.label?.trim() || `${reference.referenceType}参考`,
          role: "system",
        });
      });
    }
  });

  const panelTimeline: StudioCanvasTimelineLayout["panelTimeline"] = [];
  let panelCount = 0;

  if (activeUnitId) {
    const active = units.find((unit) => unit.unitId === activeUnitId);
    if (!active) fail("invalid-input", `activeUnitId 不在 units 中：${activeUnitId}`);

    const panels = [...active.panels]
      .map((panel, index) => {
        const panelId = requiredId(panel.panelId, `panel[${index}].panelId`);
        if (!Number.isFinite(panel.startSeconds) || panel.startSeconds < 0 || panel.startSeconds > 15) {
          fail("invalid-input", `panel ${panelId} startSeconds 必须在 0–15。`);
        }
        if (!Number.isSafeInteger(panel.ordinal) || panel.ordinal < 1) {
          fail("invalid-input", `panel ${panelId} ordinal 无效。`);
        }
        return {
          panelId,
          ordinal: panel.ordinal,
          startSeconds: panel.startSeconds,
          endSeconds: panel.endSeconds,
          assetIds: [...(panel.assetIds ?? [])].map((id) => id.trim()).filter(Boolean).slice(0, 6),
          hasRaw: Boolean(panel.hasRaw),
          hasLabeled: Boolean(panel.hasLabeled),
          reviewDecision: panel.reviewDecision ?? "none",
          label: panel.label,
        };
      })
      .sort((a, b) => a.startSeconds - b.startSeconds || a.ordinal - b.ordinal);

    const seenPanel = new Set<string>();
    for (const panel of panels) {
      if (seenPanel.has(panel.panelId)) fail("invalid-input", `宫格 ID 重复：${panel.panelId}`);
      seenPanel.add(panel.panelId);
    }

    panelCount = panels.length;
    const pipelineX0 = unitTrackX0 + Math.max(units.length, 1) * unitColGap + 40;
    const panelY0 = unitRowY + 160;

    panels.forEach((panel, row) => {
      const y = panelY0 + row * panelRowGap;
      const panelNodeId = `panel:${panel.panelId}`;
      const rawId = `media:raw:${panel.panelId}`;
      const labeledId = `media:labeled:${panel.panelId}`;
      const reviewId = `media:review:${panel.panelId}`;

      nodes[panelNodeId] = { x: pipelineX0, y };
      nodes[rawId] = { x: pipelineX0 + pipelineColGap, y };
      nodes[labeledId] = { x: pipelineX0 + pipelineColGap * 2, y };
      nodes[reviewId] = { x: pipelineX0 + pipelineColGap * 3, y };

      edges.push({
        id: `system:unit-panel:${activeUnitId}:${panel.panelId}`,
        sourceId: `unit:${activeUnitId}`,
        targetId: panelNodeId,
        sourceKind: "unit",
        targetKind: "panel",
        label: String(panel.ordinal),
        role: "system",
      });
      edges.push({
        id: `system:panel-raw:${panel.panelId}`,
        sourceId: panelNodeId,
        targetId: rawId,
        sourceKind: "panel",
        targetKind: "raw",
        label: "原始图",
        role: "system",
      });
      edges.push({
        id: `system:raw-labeled:${panel.panelId}`,
        sourceId: rawId,
        targetId: labeledId,
        sourceKind: "raw",
        targetKind: "labeled",
        label: "标注图",
        role: "system",
      });
      edges.push({
        id: `system:labeled-review:${panel.panelId}`,
        sourceId: labeledId,
        targetId: reviewId,
        sourceKind: "labeled",
        targetKind: "review",
        label: "审片",
        role: "system",
      });

      if (row > 0) {
        const prev = panels[row - 1]!;
        edges.push({
          id: `system:panel-next:${prev.panelId}:${panel.panelId}`,
          sourceId: `panel:${prev.panelId}`,
          targetId: panelNodeId,
          sourceKind: "panel",
          targetKind: "panel",
          label: "下一格",
          role: "system",
        });
      }

      for (const assetId of panel.assetIds) {
        const assetNodeId = `asset:${assetId}`;
        if (!nodes[assetNodeId]) continue;
        edges.push({
          id: `system:asset-panel:${assetId}:${panel.panelId}`,
          sourceId: assetNodeId,
          targetId: panelNodeId,
          sourceKind: "asset",
          targetKind: "panel",
          label: "出场",
          role: "system",
        });
      }

      panelTimeline.push({
        panelId: panel.panelId,
        ordinal: panel.ordinal,
        startSeconds: panel.startSeconds,
        hasRaw: panel.hasRaw,
        hasLabeled: panel.hasLabeled,
        reviewDecision: panel.reviewDecision,
      });
    });
  }

  const validation = validateStudioCanvasEdges(
    edges.map((edge) => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      sourceKind: edge.sourceKind,
      targetKind: edge.targetKind,
    })),
  );
  if (!validation.ok) {
    const first = validation.issues[0];
    fail("invalid-input", `系统边校验失败：${first?.message ?? "unknown"}`);
  }

  const blob = JSON.stringify({ nodes, edges, panelTimeline });
  if (/"localPath"|sqlite|base64|sha256/i.test(blob)) {
    fail("invalid-input", "时间线布局不得包含 localPath/sqlite/base64/sha256。");
  }

  return {
    schemaVersion: 1,
    kind: "studio-canvas-timeline-layout",
    unitCount: units.length,
    panelCount,
    assetCount: assets.length,
    ...(activeUnitId ? { activeUnitId } : {}),
    nodes,
    edges,
    panelTimeline,
  };
}

/**
 * 最小进度搜索：按 unitId / 资产（角色、场景、道具、SHA）/ review 状态过滤时间线投影。
 * 不读写 SQLite；仅投影过滤。
 */
export function filterStudioCanvasTimelineProgress(
  input: {
    units: readonly StudioCanvasTimelineUnitInput[];
    assets?: readonly StudioCanvasTimelineAssetInput[];
  },
  filter: {
    /** 集数、完整单元 ID 或单元标题的前缀/片段检索；例如 S1E2 命中整集。 */
    unitQuery?: string;
    unitId?: string;
    /** 任意实际资产的 assetId、名称或短 SHA；优先于 legacy characterQuery。 */
    assetQuery?: string;
    /** 兼容旧调用：仅匹配角色资产。 */
    characterQuery?: string;
    reviewStatus?: StudioCanvasTimelinePanelInput["reviewDecision"] | "any-pending";
  },
): {
  schemaVersion: 1;
  kind: "studio-canvas-timeline-progress-filter";
  matchedUnitIds: string[];
  matchedPanelIds: string[];
  unitCount: number;
  panelCount: number;
} {
  const unitId = filter.unitId?.trim();
  const unitQuery = filter.unitQuery?.trim().toLowerCase();
  const assetQuery = (filter.assetQuery ?? filter.characterQuery)?.trim().toLowerCase();
  const legacyCharacterOnly = !filter.assetQuery && Boolean(filter.characterQuery?.trim());
  const reviewStatus = filter.reviewStatus;
  const assets = input.assets ?? [];
  const queriedAssetIds = new Set(
    assets
      .filter((asset) => {
        if (legacyCharacterOnly && (asset.category || "").trim() !== "character") return false;
        if (!assetQuery) return true;
        const label = (asset.label || asset.assetId).toLowerCase();
        return asset.assetId.toLowerCase().includes(assetQuery) || label.includes(assetQuery);
      })
      .map((asset) => asset.assetId),
  );

  const matchedUnitIds: string[] = [];
  const matchedPanelIds: string[] = [];

  for (const unit of input.units ?? []) {
    if (!unit.unitId?.trim()) continue;
    if (unitId && unit.unitId !== unitId) continue;
    if (unitQuery) {
      const unitSearchText = `${unit.unitId} ${unit.label ?? ""}`.toLowerCase();
      if (!unitSearchText.includes(unitQuery)) continue;
    }
    const panels = unit.panels ?? [];
    let unitMatched = Boolean(unitId || unitQuery);
    for (const panel of panels) {
      if (!panel.panelId?.trim()) continue;
      const decision = panel.reviewDecision ?? "none";
      if (reviewStatus === "any-pending") {
        if (decision === "pass" || decision === "reject") continue;
      } else if (reviewStatus && decision !== reviewStatus) {
        continue;
      }
      if (assetQuery) {
        const ids = panel.assetIds ?? [];
        const hit = ids.some((id) => queriedAssetIds.has(id) || id.toLowerCase().includes(assetQuery));
        if (!hit) continue;
      }
      matchedPanelIds.push(panel.panelId);
      unitMatched = true;
    }
    // 仅按集数/单元过滤且无宫格时仍命中单元。
    if ((unitId || unitQuery) && panels.length === 0) unitMatched = true;
    if (!unitId && !unitQuery && !assetQuery && !reviewStatus) unitMatched = true;
    if (unitMatched) matchedUnitIds.push(unit.unitId);
  }

  return {
    schemaVersion: 1,
    kind: "studio-canvas-timeline-progress-filter",
    matchedUnitIds,
    matchedPanelIds,
    unitCount: matchedUnitIds.length,
    panelCount: matchedPanelIds.length,
  };
}

/**
 * 将时间线默认坐标应用到现有节点：仅覆盖 fallback 未钉死的节点。
 * pinnedNodeIds 中的坐标保留（调用方从 layout 读取）。
 */
export function applyStudioCanvasTimelinePositions(
  current: Readonly<Record<string, StudioCanvasTimelineNodePosition>>,
  timeline: StudioCanvasTimelineLayout,
  options?: { pinnedNodeIds?: readonly string[]; force?: boolean },
): Record<string, StudioCanvasTimelineNodePosition> {
  const pinned = new Set((options?.pinnedNodeIds ?? []).map((id) => id.trim()).filter(Boolean));
  const force = Boolean(options?.force);
  const next: Record<string, StudioCanvasTimelineNodePosition> = { ...current };
  for (const [id, position] of Object.entries(timeline.nodes)) {
    if (!force && pinned.has(id)) continue;
    next[id] = { x: position.x, y: position.y };
  }
  return next;
}
