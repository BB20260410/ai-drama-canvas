import { describe, expect, it } from "vitest";
import {
  alignCanvasNodes,
  computeCanvasSnap,
  distributeCanvasNodes,
  type CanvasNodeGeometry,
} from "../src/renderer/src/studio-canvas-align.js";

/**
 * P23 §4-1..3 对齐/等距分布/吸附纯函数定向测试（规范 v2.1）。
 */

function node(id: string, x: number, y: number, width = 188, height = 200): CanvasNodeGeometry {
  return { id, x, y, width, height };
}

describe("P23 alignCanvasNodes", () => {
  const items = [node("a", 10, 0), node("b", 100, 50), node("c", 300, 90)];

  it("六向 bbox 公式：left/centerX/right/top/centerY/bottom", () => {
    expect(alignCanvasNodes(items, "left")).toEqual({
      a: { x: 10, y: 0 },
      b: { x: 10, y: 50 },
      c: { x: 10, y: 90 },
    });
    const right = alignCanvasNodes(items, "right");
    expect(right["a"]).toEqual({ x: 300, y: 0 });
    expect(right["b"]).toEqual({ x: 300, y: 50 });
    expect(right["c"]).toEqual({ x: 300, y: 90 });
    const centerX = alignCanvasNodes(items, "centerX");
    // 选区 bbox：min=10, max=488 → mid=249；各节点 centerX 对齐 249
    expect(centerX["a"]).toEqual({ x: 155, y: 0 });
    expect(centerX["b"]).toEqual({ x: 155, y: 50 });
    expect(centerX["c"]).toEqual({ x: 155, y: 90 });
    expect(alignCanvasNodes(items, "top")).toEqual({
      a: { x: 10, y: 0 },
      b: { x: 100, y: 0 },
      c: { x: 300, y: 0 },
    });
    const bottom = alignCanvasNodes(items, "bottom");
    expect(bottom["a"]).toEqual({ x: 10, y: 90 });
    expect(bottom["b"]).toEqual({ x: 100, y: 90 });
    expect(bottom["c"]).toEqual({ x: 300, y: 90 });
    const centerY = alignCanvasNodes(items, "centerY");
    // bbox y：min=0, max=290 → mid=145
    expect(centerY["a"]).toEqual({ x: 10, y: 45 });
    expect(centerY["b"]).toEqual({ x: 100, y: 45 });
    expect(centerY["c"]).toEqual({ x: 300, y: 45 });
  });

  it("空集/单节点原样返回", () => {
    expect(alignCanvasNodes([], "left")).toEqual({});
    expect(alignCanvasNodes([node("a", 5, 5)], "left")).toEqual({});
  });
});

describe("P23 distributeCanvasNodes", () => {
  it("正常等距：中线排序+等 step", () => {
    const items = [node("a", 0, 0), node("b", 100, 0), node("c", 300, 0)];
    const result = distributeCanvasNodes(items, "x");
    // bbox 0..488 跨度 488，Σ宽=564 → step=(488-564)/2<0？否：488-564=-76<0 → 退化
    // 用更开的场景验证正常 step
    expect(result["a"]).toBeDefined();
    const wide = [node("a", 0, 0), node("b", 400, 0), node("c", 800, 0)];
    const spread = distributeCanvasNodes(wide, "x");
    // bbox 0..988 跨度 988，Σ宽=564 → step=(988-564)/2=212
    expect(spread["a"]).toEqual({ x: 0, y: 0 });
    expect(spread["b"]).toEqual({ x: 400, y: 0 });
    expect(spread["c"]).toEqual({ x: 800, y: 0 });
    const tight = [node("a", 0, 0), node("b", 220, 0), node("c", 440, 0)];
    const tightResult = distributeCanvasNodes(tight, "x");
    // bbox 0..628，Σ宽=564 → step=(628-564)/2=32
    expect(tightResult["a"]).toEqual({ x: 0, y: 0 });
    expect(tightResult["b"]).toEqual({ x: 220, y: 0 });
    expect(tightResult["c"]).toEqual({ x: 440, y: 0 });
  });

  it("step<0 退化：首尾固定，其余中心均分", () => {
    const items = [node("a", 0, 0), node("b", 190, 0), node("c", 210, 0), node("d", 380, 0)];
    const result = distributeCanvasNodes(items, "x");
    // bbox 0..568，Σ宽=752 → step<0 → 退化：a/d 固定，b/c 中心均分
    expect(result["a"]).toEqual({ x: 0, y: 0 });
    expect(result["d"]).toEqual({ x: 380, y: 0 });
    // 首中心=94，末中心=474，step=(474-94)/3≈126.67
    const bCenter = result["b"]!.x + 94;
    const cCenter = result["c"]!.x + 94;
    expect(bCenter).toBeCloseTo(94 + (474 - 94) / 3, 5);
    expect(cCenter).toBeCloseTo(94 + ((474 - 94) / 3) * 2, 5);
  });

  it("n=2 原样；乱序输入稳定；y 轴可用", () => {
    expect(distributeCanvasNodes([node("a", 0, 0), node("b", 100, 0)], "x")).toEqual({});
    const shuffled = [node("c", 300, 0), node("a", 0, 0), node("b", 100, 0)];
    const ordered = [node("a", 0, 0), node("b", 100, 0), node("c", 300, 0)];
    expect(distributeCanvasNodes(shuffled, "x")).toEqual(distributeCanvasNodes(ordered, "x"));
    const vertical = distributeCanvasNodes([node("a", 0, 0), node("b", 0, 300), node("c", 0, 600)], "y");
    expect(vertical["a"]).toEqual({ x: 0, y: 0 });
    expect(vertical["b"]).toEqual({ x: 0, y: 300 });
    expect(vertical["c"]).toEqual({ x: 0, y: 600 });
  });
});

describe("P23 computeCanvasSnap", () => {
  const dragged = { x: 100, y: 100, width: 188, height: 200 };

  it("边缘/中心命中取最小偏移；threshold ÷zoom；无命中零偏移", () => {
    const candidates = [{ x: 290, y: 400, width: 188, height: 200 }];
    // dragged.right=288 vs candidate.left=290 → dx=2
    const result = computeCanvasSnap(dragged, candidates, 8);
    expect(result.dx).toBe(2);
    expect(result.lines).toEqual([{ axis: "x", position: 290 }]);
    // threshold 缩小（zoom=2 → 4）后不命中
    expect(computeCanvasSnap(dragged, candidates, 1.5).lines).toEqual([]);
    // 无候选
    expect(computeCanvasSnap(dragged, [], 8)).toEqual({ dx: 0, dy: 0, lines: [] });
  });

  it("多候选取最近；中心线命中；双轴同取", () => {
    const candidates = [
      { x: 500, y: 96, width: 188, height: 200 },
      { x: 1000, y: 900, width: 188, height: 200 },
    ];
    // y 向：dragged.top=100 vs candidate[0].top=96 → dy=-4（最近）
    const result = computeCanvasSnap(dragged, candidates, 8);
    expect(result.dy).toBe(-4);
    expect(result.lines).toContainEqual({ axis: "y", position: 96 });
    // 中心线：candidate[0].centerY=196 vs dragged.centerY=200 → 同为 -4，不更近
    // x 向中心：candidate[0].centerX=594 vs dragged.centerX=194 → 不命中；right=288 vs left=500 不命中
    expect(result.dx).toBe(0);
  });

  it("非法 threshold 零偏移", () => {
    expect(computeCanvasSnap(dragged, [{ x: 290, y: 400, width: 188, height: 200 }], 0).lines).toEqual([]);
    expect(computeCanvasSnap(dragged, [{ x: 290, y: 400, width: 188, height: 200 }], Number.NaN).lines).toEqual([]);
  });
});
