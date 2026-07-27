/**
 * Qwen D3 · 定高列表虚拟窗口（纯计算）
 *
 * 侧栏/素材列表用：给定 scrollTop + 视口高度 + 行高 → 可见切片。
 * 不改分页合同；仅减少 DOM 挂载量。
 */

export interface VirtualListWindow {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
  visibleCount: number;
}

export function computeVirtualListWindow(input: {
  itemCount: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}): VirtualListWindow {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const itemHeight = Math.max(1, input.itemHeight);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
  const totalHeight = itemCount * itemHeight;
  if (itemCount === 0 || viewportHeight === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight, visibleCount: 0 };
  }
  const scrollTop = Math.min(Math.max(0, input.scrollTop), Math.max(0, totalHeight - 1));
  const rawStart = Math.floor(scrollTop / itemHeight);
  const visible = Math.ceil(viewportHeight / itemHeight) + 1;
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(itemCount, rawStart + visible + overscan);
  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * itemHeight,
    totalHeight,
    visibleCount: Math.max(0, endIndex - startIndex),
  };
}

export function sliceVirtualWindow<T>(items: readonly T[], window: VirtualListWindow): T[] {
  return items.slice(window.startIndex, window.endIndex);
}
