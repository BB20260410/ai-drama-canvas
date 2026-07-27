/** Renderer-safe Studio 画布几何函数；本模块不得导入 node:*。 */
import type { StudioCanvasNodePosition } from "./studio-canvas-layout-types.js";

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

function validNodeId(value: string): string {
  const normalized = value.trim();
  if (!NODE_ID_PATTERN.test(normalized)) throw new Error(`nodeId 非法：${value}`);
  return normalized;
}

/** 稳定节点 id 约定；纯字符串函数，可安全用于 renderer。 */
export function studioCanvasNodeId(kind: "panel" | "unit" | "asset" | "media", id: string): string {
  return `${kind}:${validNodeId(id)}`;
}

/** 会话拖动位置 > 已持久化布局 > 默认自动布局点。 */
export function resolveStudioCanvasNodePosition(
  nodeId: string,
  options: {
    sessionPositions?: ReadonlyMap<string, StudioCanvasNodePosition> | Record<string, StudioCanvasNodePosition>;
    layoutNodes?: Readonly<Record<string, StudioCanvasNodePosition>> | null;
    fallback: StudioCanvasNodePosition;
  },
): StudioCanvasNodePosition {
  const id = validNodeId(nodeId);
  const session = options.sessionPositions;
  if (session) {
    if (session instanceof Map) {
      const hit = session.get(id);
      if (hit) return { x: hit.x, y: hit.y };
    } else {
      const hit = (session as Record<string, StudioCanvasNodePosition>)[id];
      if (hit) return { x: hit.x, y: hit.y };
    }
  }
  const layoutHit = options.layoutNodes?.[id];
  if (layoutHit) return { x: layoutHit.x, y: layoutHit.y };
  return { x: options.fallback.x, y: options.fallback.y };
}

/** 从图节点列表抽出可持久化坐标；非法 ID / 非 finite 坐标显式忽略。 */
export function collectStudioCanvasNodePositions(
  entries: ReadonlyArray<{ id: string; position: StudioCanvasNodePosition }>,
): Record<string, StudioCanvasNodePosition> {
  const nodes: Record<string, StudioCanvasNodePosition> = {};
  for (const entry of entries) {
    if (!NODE_ID_PATTERN.test(entry.id)) continue;
    if (!Number.isFinite(entry.position.x) || !Number.isFinite(entry.position.y)) continue;
    nodes[entry.id] = { x: entry.position.x, y: entry.position.y };
  }
  return nodes;
}
