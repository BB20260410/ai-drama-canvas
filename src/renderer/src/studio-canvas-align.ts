/**
 * P23 画布对齐/等距分布/吸附纯函数（renderer-safe，禁 node:*，可直接断言）。
 * 算法思想 clean-room 借鉴 Excalidraw（bbox 对齐、中线排序+退化分布、8÷zoom 吸附阈值）
 * 与 X6 snapline（边缘+中心线形态）；不复制任何源码。
 */

export interface CanvasNodeGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasAlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

function extentOf(item: CanvasNodeGeometry, axis: "x" | "y"): { start: number; end: number } {
  return axis === "x"
    ? { start: item.x, end: item.x + item.width }
    : { start: item.y, end: item.y + item.height };
}

/** 选区公共 bbox 对齐（start/center/end × x/y；<2 节点原样返回）。 */
export function alignCanvasNodes(
  items: readonly CanvasNodeGeometry[],
  mode: CanvasAlignMode,
): Record<string, { x: number; y: number }> {
  if (items.length < 2) return {};
  const axis: "x" | "y" = mode === "left" || mode === "centerX" || mode === "right" ? "x" : "y";
  const extents = items.map((item) => extentOf(item, axis));
  const min = Math.min(...extents.map((extent) => extent.start));
  const max = Math.max(...extents.map((extent) => extent.end));
  const mid = (min + max) / 2;
  const result: Record<string, { x: number; y: number }> = {};
  for (const [index, item] of items.entries()) {
    const extent = extents[index]!;
    let target: number;
    if (mode === "left" || mode === "top") target = min;
    else if (mode === "right" || mode === "bottom") target = max;
    else target = mid;
    const delta = (mode === "left" || mode === "top")
      ? target - extent.start
      : (mode === "right" || mode === "bottom")
        ? target - extent.end
        : target - (extent.start + extent.end) / 2;
    result[item.id] = axis === "x" ? { x: item.x + delta, y: item.y } : { x: item.x, y: item.y + delta };
  }
  return result;
}

/** 等距分布：中线排序 + step=(选区跨度−Σ跨度)/(n−1)；step<0 退化（首尾固定，其余中心均分）；n<3 原样。 */
export function distributeCanvasNodes(
  items: readonly CanvasNodeGeometry[],
  axis: "x" | "y",
): Record<string, { x: number; y: number }> {
  if (items.length < 3) return {};
  const sorted = [...items].sort((left, right) => {
    const leftCenter = extentOf(left, axis).start + extentOf(left, axis).end;
    const rightCenter = extentOf(right, axis).start + extentOf(right, axis).end;
    return leftCenter - rightCenter;
  });
  const extents = sorted.map((item) => extentOf(item, axis));
  const totalSpan = Math.max(...extents.map((extent) => extent.end)) - Math.min(...extents.map((extent) => extent.start));
  const totalSizes = extents.reduce((sum, extent) => sum + (extent.end - extent.start), 0);
  const step = (totalSpan - totalSizes) / (sorted.length - 1);
  const result: Record<string, { x: number; y: number }> = {};
  if (step >= 0) {
    let cursor = Math.min(...extents.map((extent) => extent.start));
    for (const [index, item] of sorted.entries()) {
      const extent = extents[index]!;
      const delta = cursor - extent.start;
      result[item.id] = axis === "x" ? { x: item.x + delta, y: item.y } : { x: item.x, y: item.y + delta };
      cursor = extent.end + step + delta;
    }
    return result;
  }
  // 退化：首尾固定，其余按中心均分。
  const firstCenter = (extents[0]!.start + extents[0]!.end) / 2;
  const lastCenter = (extents[extents.length - 1]!.start + extents[extents.length - 1]!.end) / 2;
  const degenerateStep = (lastCenter - firstCenter) / (sorted.length - 1);
  for (const [index, item] of sorted.entries()) {
    const extent = extents[index]!;
    const center = (extent.start + extent.end) / 2;
    const target = firstCenter + degenerateStep * index;
    const delta = target - center;
    result[item.id] = axis === "x" ? { x: item.x + delta, y: item.y } : { x: item.x, y: item.y + delta };
  }
  return result;
}

export interface CanvasSnapLine {
  axis: "x" | "y";
  position: number;
}

export interface CanvasSnapResult {
  dx: number;
  dy: number;
  lines: CanvasSnapLine[];
}

/** 吸附：候选=left/centerX/right 与 top/centerY/bottom，|Δ|≤threshold 取最小偏移；无命中零偏移空线。 */
export function computeCanvasSnap(
  dragged: Omit<CanvasNodeGeometry, "id">,
  candidates: readonly Omit<CanvasNodeGeometry, "id">[],
  threshold: number,
): CanvasSnapResult {
  const empty: CanvasSnapResult = { dx: 0, dy: 0, lines: [] };
  if (!Number.isFinite(threshold) || threshold <= 0 || candidates.length === 0) return empty;
  const self = {
    left: dragged.x,
    centerX: dragged.x + dragged.width / 2,
    right: dragged.x + dragged.width,
    top: dragged.y,
    centerY: dragged.y + dragged.height / 2,
    bottom: dragged.y + dragged.height,
  };
  let bestX: { delta: number; position: number } | null = null;
  let bestY: { delta: number; position: number } | null = null;
  for (const candidate of candidates) {
    const edges = [
      { position: candidate.x, axis: "x" as const },
      { position: candidate.x + candidate.width / 2, axis: "x" as const },
      { position: candidate.x + candidate.width, axis: "x" as const },
      { position: candidate.y, axis: "y" as const },
      { position: candidate.y + candidate.height / 2, axis: "y" as const },
      { position: candidate.y + candidate.height, axis: "y" as const },
    ];
    for (const edge of edges) {
      if (edge.axis === "x") {
        for (const selfValue of [self.left, self.centerX, self.right]) {
          const delta = edge.position - selfValue;
          if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
            bestX = { delta, position: edge.position };
          }
        }
      } else {
        for (const selfValue of [self.top, self.centerY, self.bottom]) {
          const delta = edge.position - selfValue;
          if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
            bestY = { delta, position: edge.position };
          }
        }
      }
    }
  }
  return {
    dx: bestX?.delta ?? 0,
    dy: bestY?.delta ?? 0,
    lines: [
      ...(bestX ? [{ axis: "x" as const, position: bestX.position }] : []),
      ...(bestY ? [{ axis: "y" as const, position: bestY.position }] : []),
    ],
  };
}
