import { describe, expect, it } from "vitest";
import { createCanvasUndoStack, type CanvasPositionMap } from "../src/renderer/src/studio-canvas-undo.js";

/**
 * P23 §4-4 undo 栈定向测试（规范 v2.1）：push/undo/redo/有界/清空/400 节点回放。
 */

function mapOf(entries: Array<[string, number, number]>): CanvasPositionMap {
  return Object.fromEntries(entries.map(([id, x, y]) => [id, { x, y }]));
}

describe("P23 createCanvasUndoStack", () => {
  it("push/undo/redo 语义：undo 回动作前，redo 回动作后，push 清 redo", () => {
    const stack = createCanvasUndoStack();
    const s0 = mapOf([["a", 0, 0]]);
    const s1 = mapOf([["a", 10, 0]]);
    const s2 = mapOf([["a", 20, 0]]);
    expect(stack.canUndo()).toBe(false);
    stack.push(s0);
    stack.push(s1);
    expect(stack.canUndo()).toBe(true);
    // 当前态 s2：undo → 回到 s1（s2 入 redo）
    expect(stack.undo(s2)).toEqual(s1);
    expect(stack.canRedo()).toBe(true);
    // 再 undo → 回到 s0（s1 入 redo）
    expect(stack.undo(s1)).toEqual(s0);
    expect(stack.canUndo()).toBe(false);
    // redo → 回到 s1（s0 回 undo 栈）
    expect(stack.redo(s0)).toEqual(s1);
    expect(stack.canUndo()).toBe(true);
    // redo → 回到 s2
    expect(stack.redo(s1)).toEqual(s2);
    expect(stack.canRedo()).toBe(false);
    // 新 push 清 redo
    stack.push(mapOf([["a", 30, 0]]));
    expect(stack.canRedo()).toBe(false);
    // undo 弹最近动作前快照；clear 后空栈不动作
    expect(stack.undo(mapOf([["a", 40, 0]]))).toEqual(mapOf([["a", 30, 0]]));
    stack.clear();
    expect(stack.undo(s0)).toBeNull();
    expect(stack.redo(s0)).toBeNull();
  });

  it("有界：超过 maxEntries 队首淘汰", () => {
    const stack = createCanvasUndoStack({ maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) stack.push(mapOf([["a", index, 0]]));
    expect(stack.size()).toEqual({ undo: 3, redo: 0 });
    // 最旧（index=0,1）已淘汰：连撤 3 步后无栈
    const current = mapOf([["a", 99, 0]]);
    expect(stack.undo(current)).toEqual(mapOf([["a", 4, 0]]));
    expect(stack.undo(mapOf([["a", 4, 0]]))).toEqual(mapOf([["a", 3, 0]]));
    expect(stack.undo(mapOf([["a", 3, 0]]))).toEqual(mapOf([["a", 2, 0]]));
    expect(stack.canUndo()).toBe(false);
    expect(() => createCanvasUndoStack({ maxEntries: 0 })).toThrow(/正整数/u);
  });

  it("clear 与 400 节点快照回放正确性", () => {
    const stack = createCanvasUndoStack();
    const big = mapOf(Array.from({ length: 400 }, (_, index) => [`node-${index}`, index * 10, index * 3] as [string, number, number]));
    const after = mapOf(Array.from({ length: 400 }, (_, index) => [`node-${index}`, 0, 0] as [string, number, number]));
    stack.push(big);
    const restored = stack.undo(after);
    expect(restored).toEqual(big);
    expect(Object.keys(restored!)).toHaveLength(400);
    stack.clear();
    expect(stack.size()).toEqual({ undo: 0, redo: 0 });
  });
});
