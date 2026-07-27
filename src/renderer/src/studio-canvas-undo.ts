/**
 * P23 画布布局撤销/重做：组件会话内几何快照栈（renderer-safe，禁 node:*，可直接断言）。
 * 快照=Record<id,{x,y}> 纯坐标；有界（条数上限，队首淘汰）；push 清空 redo；
 * 不跨工程（栈挂组件实例，切工程/卸载即清），不撤销任何正式业务命令。
 *
 * 模型：undo 栈存"动作前"快照（drag-start/对齐/分布应用前抓取，动作完成后 push）。
 * undo(current)：弹出最近动作前快照并把 current 压入 redo 栈（供 redo 回到动作后）。
 * redo(current)：弹出最近动作后快照并把 current 压回 undo 栈。
 */

export type CanvasPositionMap = Record<string, { x: number; y: number }>;

export interface CanvasUndoStack {
  push(before: CanvasPositionMap): void;
  undo(current: CanvasPositionMap): CanvasPositionMap | null;
  redo(current: CanvasPositionMap): CanvasPositionMap | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  size(): { undo: number; redo: number };
}

const DEFAULT_MAX_ENTRIES = 80;

export function createCanvasUndoStack(options?: { maxEntries?: number }): CanvasUndoStack {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries 必须是正整数。");
  let undoStack: CanvasPositionMap[] = [];
  let redoStack: CanvasPositionMap[] = [];
  return {
    push(before) {
      undoStack.push(before);
      redoStack = [];
      if (undoStack.length > maxEntries) undoStack = undoStack.slice(undoStack.length - maxEntries);
    },
    undo(current) {
      const before = undoStack.pop();
      if (!before) return null;
      redoStack.push(current);
      return before;
    },
    redo(current) {
      const after = redoStack.pop();
      if (!after) return null;
      undoStack.push(current);
      return after;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    clear() {
      undoStack = [];
      redoStack = [];
    },
    size() {
      return { undo: undoStack.length, redo: redoStack.length };
    },
  };
}
