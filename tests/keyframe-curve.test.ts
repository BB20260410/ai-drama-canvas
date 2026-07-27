import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDIT_CUBIC_BEZIER,
  buildFfmpegKeyframeSourceTransformExpression,
  buildFfmpegEasingExpression,
  editKeyframeCurveIssue,
  editKeyframeSourceTransformIssue,
  evaluateEditKeyframeEasing,
  evaluateEditKeyframeEasingAtFrame,
  evaluateEditTransformAt,
  evaluateEditTransformAtFrame,
  normalizeEditCubicBezier,
  solveEditCubicBezierParameterAtX,
  subdivideEditKeyframeEasing,
} from "../src/core/keyframe-curve.js";
import type { EditClip } from "../src/core/types.js";

describe("关键帧 cubic-bezier 共享曲线合同", () => {
  function recomposedEasing(easing: Parameters<typeof evaluateEditKeyframeEasing>[0], splitRatio: number, ratio: number, bezier?: Parameters<typeof evaluateEditKeyframeEasing>[2]): number {
    const subdivision = subdivideEditKeyframeEasing(easing, splitRatio, bezier);
    if (ratio <= splitRatio) return subdivision.valueRatio * evaluateEditKeyframeEasing(subdivision.left.easing, ratio / splitRatio, subdivision.left.bezier);
    return subdivision.valueRatio + (1 - subdivision.valueRatio) * evaluateEditKeyframeEasing(subdivision.right.easing, (ratio - splitRatio) / (1 - splitRatio), subdivision.right.bezier);
  }

  it("保持既有五种预设的精确公式", () => {
    expect(evaluateEditKeyframeEasing("linear", .25)).toBe(.25);
    expect(evaluateEditKeyframeEasing("ease_in", .5)).toBe(.25);
    expect(evaluateEditKeyframeEasing("ease_out", .5)).toBe(.75);
    expect(evaluateEditKeyframeEasing("ease_in_out", .25)).toBe(.15625);
    expect(evaluateEditKeyframeEasing("hold", .999)).toBe(0);
  });

  it("先反解 x 再求 y，identity 与线性一致且标准 ease 单调确定", () => {
    const identity = { x1: 0, y1: 0, x2: 1, y2: 1 };
    for (const ratio of [0, .1, .25, .5, .75, .9, 1]) {
      expect(evaluateEditKeyframeEasing("cubic_bezier", ratio, identity)).toBeCloseTo(ratio, 8);
    }
    const ease = { x1: .25, y1: .1, x2: .25, y2: 1 };
    expect(evaluateEditKeyframeEasing("cubic_bezier", .5, ease)).toBeCloseTo(.802403, 5);
    const samples = Array.from({ length: 21 }, (_, index) => evaluateEditKeyframeEasing("cubic_bezier", index / 20, ease));
    expect(samples.every((value, index) => index === 0 || value >= samples[index - 1]!)).toBe(true);
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(1);
  });

  it("对缺失、非有限、越界和休眠控制点失败关闭", () => {
    expect(editKeyframeCurveIssue("cubic_bezier", undefined)).toContain("控制点");
    expect(editKeyframeCurveIssue("cubic_bezier", { x1: -0.01, y1: 0, x2: 1, y2: 1 })).toContain("0–1");
    expect(editKeyframeCurveIssue("cubic_bezier", { x1: Number.NaN, y1: 0, x2: 1, y2: 1 })).toContain("有效数字");
    expect(editKeyframeCurveIssue("linear", DEFAULT_EDIT_CUBIC_BEZIER)).toContain("不能携带");
    expect(() => normalizeEditCubicBezier({ x1: .123456789, y1: 0, x2: 1, y2: 1 })).not.toThrow();
    expect(normalizeEditCubicBezier({ x1: .123456789, y1: 0, x2: 1, y2: 1 }).x1).toBe(.123457);
    expect(() => evaluateEditKeyframeEasing("cubic_bezier", .5)).toThrow("控制点");
  });

  it("time=0 关键帧替换静态基值，目标关键帧控制进入区间", () => {
    const clip: EditClip = {
      id: "clip-curve",
      trackId: "track-overlay",
      kind: "video",
      name: "曲线覆盖层",
      startSeconds: 0,
      durationSeconds: 1,
      trimStartSeconds: 0,
      playbackRate: 1,
      volume: 0,
      opacity: 1,
      muted: true,
      positionX: 100,
      positionY: 20,
      scale: 1,
      rotation: 0,
      keyframes: [
        { id: "start", timeSeconds: 0, easing: "hold", positionX: 10, positionY: 20, scale: 1, rotation: 0 },
        { id: "end", timeSeconds: 1, easing: "cubic_bezier", bezier: { x1: 0, y1: 0, x2: 1, y2: 1 }, positionX: 110, positionY: 40, scale: 2, rotation: 90 },
      ],
    };
    expect(evaluateEditTransformAt(clip, 0)).toMatchObject({ positionX: 10, positionY: 20, scale: 1, rotation: 0 });
    const middle = evaluateEditTransformAt(clip, .5);
    expect(middle.positionX).toBeCloseTo(60, 8);
    expect(middle.positionY).toBeCloseTo(30, 8);
    expect(middle.scale).toBeCloseTo(1.5, 8);
    expect(middle.rotation).toBeCloseTo(45, 8);
    expect(evaluateEditTransformAt(clip, 1)).toMatchObject({ positionX: 110, positionY: 40, scale: 2, rotation: 90 });
  });

  it("为 FFmpeg 生成同一控制点数学定义的有界求根表达式", () => {
    const expression = buildFfmpegEasingExpression("cubic_bezier", "p", { x1: .25, y1: .1, x2: .25, y2: 1 });
    expect(expression).toContain("root(");
    expect(expression).toContain("ld(0)");
    expect(expression).toContain("max(0,min(1,p))");
    expect(expression.length).toBeLessThan(1_500);
    expect(buildFfmpegEasingExpression("ease_in_out", "p")).toBe("(p)*(p)*(3-2*(p))");
  });

  it("用 De Casteljau 精确重组四种连续预设与自定义曲线", () => {
    const curves = [
      ["linear", undefined],
      ["ease_in", undefined],
      ["ease_out", undefined],
      ["ease_in_out", undefined],
      ["cubic_bezier", { x1: .25, y1: .1, x2: .25, y2: 1 }],
    ] as const;
    for (const [easing, bezier] of curves) for (const splitRatio of [.1, .25, .5, .73, .9]) {
      const subdivision = subdivideEditKeyframeEasing(easing, splitRatio, bezier);
      expect(subdivision.parameter).toBeGreaterThan(0);
      expect(subdivision.parameter).toBeLessThan(1);
      expect(subdivision.valueRatio).toBeCloseTo(evaluateEditKeyframeEasing(easing, splitRatio, bezier), 10);
      expect(subdivision.left.bezier?.mode).toBe("derived_monotone");
      expect(subdivision.right.bezier?.mode).toBe("derived_monotone");
      expect(subdivision.left.bezier?.sourceWindow?.sourceEasing).toBe(easing);
      expect(subdivision.right.bezier?.sourceWindow?.sourceEasing).toBe(easing);
      for (let index = 0; index <= 1_000; index += 1) {
        const ratio = index / 1_000;
        expect(recomposedEasing(easing, splitRatio, ratio, bezier)).toBeCloseTo(evaluateEditKeyframeEasing(easing, ratio, bezier), 8);
      }
    }
  });

  it("派生单调合同承载单位曲线分段后的框外控制点，禁止 clamp 或伪造非单调输入", () => {
    const extreme = { x1: 1, y1: 1, x2: 0, y2: 0 };
    const subdivision = subdivideEditKeyframeEasing("cubic_bezier", .25, extreme);
    expect(subdivision.right.bezier).toEqual(expect.objectContaining({ mode: "derived_monotone" }));
    expect(subdivision.right.bezier!.x2).toBeLessThan(0);
    expect(editKeyframeCurveIssue("cubic_bezier", subdivision.right.bezier)).toBeUndefined();
    for (let index = 0; index <= 1_000; index += 1) {
      const ratio = index / 1_000;
      expect(recomposedEasing("cubic_bezier", .25, ratio, extreme)).toBeCloseTo(evaluateEditKeyframeEasing("cubic_bezier", ratio, extreme), 8);
    }
    expect(editKeyframeCurveIssue("cubic_bezier", { x1: -.2, y1: 0, x2: .5, y2: 1, mode: "derived_monotone" } as any)).toContain("单调");
    expect(editKeyframeCurveIssue("cubic_bezier", { x1: -.2, y1: 0, x2: .5, y2: 1 } as any)).toContain("0–1");
    expect(normalizeEditCubicBezier({
      x1: 1.195800350656,
      y1: 0,
      x2: .8,
      y2: 1,
      mode: "derived_monotone",
      sourceWindow: { x1: .25, y1: .1, x2: .25, y2: 1, sourceEasing: "cubic_bezier", startX: 0, endX: .25 },
    }).x1).toBeCloseTo(1.195800350656, 12);
  });

  it("用原曲线窗口承载零导数病态逆函数，并支持重复分段", () => {
    const cross = { x1: 1, y1: 0, x2: 0, y2: 1 };
    expect(evaluateEditKeyframeEasing("cubic_bezier", .5, cross)).toBe(.5);
    for (const splitRatio of [.1, .25, .5, .73, .9]) {
      const splitFrame = splitRatio * 1_000;
      const subdivision = subdivideEditKeyframeEasing("cubic_bezier", splitRatio, cross, { segmentFrames: 1_000, splitFrame });
      expect(subdivision.left.bezier?.sourceWindow).toEqual(expect.objectContaining({ sourceEasing: "cubic_bezier", startX: 0, endX: splitRatio, startFrame: 0, endFrame: splitFrame, totalFrames: 1_000 }));
      expect(subdivision.right.bezier?.sourceWindow).toEqual(expect.objectContaining({ sourceEasing: "cubic_bezier", startX: splitRatio, endX: 1, startFrame: splitFrame, endFrame: 1_000, totalFrames: 1_000 }));
      for (let frame = 0; frame <= 1_000; frame += 1) {
        const recomposed = frame <= splitFrame
          ? subdivision.valueRatio * evaluateEditKeyframeEasingAtFrame(subdivision.left.easing, frame, splitFrame, subdivision.left.bezier)
          : subdivision.valueRatio + (1 - subdivision.valueRatio) * evaluateEditKeyframeEasingAtFrame(subdivision.right.easing, frame - splitFrame, 1_000 - splitFrame, subdivision.right.bezier);
        expect(recomposed).toBeCloseTo(evaluateEditKeyframeEasingAtFrame("cubic_bezier", frame, 1_000, cross), 12);
      }
    }
    const first = subdivideEditKeyframeEasing("cubic_bezier", .25, cross, { segmentFrames: 1_000, splitFrame: 250 });
    const second = subdivideEditKeyframeEasing(first.right.easing, 480 / 750, first.right.bezier, { segmentFrames: 750, splitFrame: 480 });
    expect(second.left.bezier?.sourceWindow).toEqual(expect.objectContaining({ sourceEasing: "cubic_bezier", startX: .25, endX: .73, startFrame: 250, endFrame: 730, totalFrames: 1_000 }));
    expect(second.right.bezier?.sourceWindow).toEqual(expect.objectContaining({ sourceEasing: "cubic_bezier", startX: .73, endX: 1, startFrame: 730, endFrame: 1_000, totalFrames: 1_000 }));
  });

  it("派生 FFmpeg 表达式直接使用原段 anchors，不从舍入后的子段 delta 反推", () => {
    const keyframe = {
      id: "derived-source-affine",
      frame: 31,
      timeSeconds: 31 * 1_001 / 24_000,
      easing: "cubic_bezier" as const,
      bezier: {
        x1: 1.046,
        y1: 0,
        x2: .7,
        y2: 1,
        mode: "derived_monotone" as const,
        sourceWindow: { x1: 1, y1: 0, x2: 0, y2: 1, sourceEasing: "cubic_bezier" as const, startX: 0, endX: 31 / 48, startFrame: 0, endFrame: 31, totalFrames: 48 },
      },
      sourceTransform: {
        start: { positionX: -110, positionY: 0, scale: .12, rotation: 0 },
        end: { positionX: 110, positionY: 0, scale: .12, rotation: 0 },
      },
      positionX: 93.382406550484,
      positionY: 0,
      scale: .12,
      rotation: 0,
    };
    const expression = buildFfmpegKeyframeSourceTransformExpression(keyframe, "positionX", "n", 31);
    expect(expression).toContain("-110");
    expect(expression).toContain("220");
    expect(expression).toContain("48");
    expect(expression).not.toContain("203.382406550484");
  });

  it("sourceTransform 只允许派生目标携带，缺失、休眠或非法 anchor 均失败关闭", () => {
    const derived = subdivideEditKeyframeEasing("cubic_bezier", .4, { x1: 1, y1: 0, x2: 0, y2: 1 }, { segmentFrames: 10, splitFrame: 4 }).left.bezier;
    const valid = {
      start: { positionX: -10, positionY: 0, scale: .5, rotation: 0 },
      end: { positionX: 10, positionY: 5, scale: 1, rotation: 15 },
    };
    expect(editKeyframeSourceTransformIssue("cubic_bezier", derived, valid)).toBeUndefined();
    expect(editKeyframeSourceTransformIssue("cubic_bezier", derived, undefined)).toContain("sourceTransform");
    expect(editKeyframeSourceTransformIssue("linear", undefined, valid)).toContain("不能携带");
    expect(editKeyframeSourceTransformIssue("cubic_bezier", derived, { ...valid, end: { ...valid.end, scale: Number.NaN } })).toContain("有效变换数值");
  });

  it("不把长片段首尾一帧误判为退化，并在端点先校验曲线", () => {
    expect(() => subdivideEditKeyframeEasing("cubic_bezier", 1 / 10_000, { x1: 1, y1: 0, x2: 1, y2: 0 })).not.toThrow();
    expect(() => subdivideEditKeyframeEasing("cubic_bezier", 9_999 / 10_000, { x1: 0, y1: 1, x2: 0, y2: 1 })).not.toThrow();
    for (const ratio of [0, 1]) {
      expect(() => solveEditCubicBezierParameterAtX({ x1: Number.NaN, y1: 0, x2: 1, y2: 1 }, ratio)).toThrow("有效数字");
      expect(() => solveEditCubicBezierParameterAtX({ x1: -.1, y1: 0, x2: 1, y2: 1 }, ratio)).toThrow("0–1");
    }
  });

  it("保持 hold 在原目标帧跳变，并拒绝端点或无效比例分段", () => {
    const subdivision = subdivideEditKeyframeEasing("hold", .37);
    expect(subdivision).toMatchObject({ valueRatio: 0, left: { easing: "linear" }, right: { easing: "hold" } });
    for (const ratio of [0, .1, .37, .5, .999999]) expect(recomposedEasing("hold", .37, ratio)).toBe(0);
    expect(() => subdivideEditKeyframeEasing("linear", 0)).toThrow("片段内部");
    expect(() => subdivideEditKeyframeEasing("linear", 1)).toThrow("片段内部");
    expect(() => subdivideEditKeyframeEasing("linear", Number.NaN)).toThrow("有效数字");
  });

  it("整数帧求值不受三位秒数重基误差影响", () => {
    const clip: EditClip = {
      id: "clip-frame-evaluator", trackId: "track-overlay", kind: "video", name: "分数帧率",
      startSeconds: 0, durationSeconds: 1.001, durationFrames: 24, trimStartSeconds: 0, playbackRate: 1,
      volume: 0, opacity: 1, muted: true, positionX: -120, positionY: 0, scale: .3, rotation: 0,
      keyframes: [
        { id: "frame-start", frame: 0, timeSeconds: 0, easing: "hold", positionX: -120, positionY: 0, scale: .3, rotation: 0 },
        { id: "frame-end", frame: 24, timeSeconds: 1.001, easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 120, positionY: 40, scale: .6, rotation: 12 },
      ],
    };
    const atSeven = evaluateEditTransformAtFrame(clip, 7, 24_000 / 1_001);
    const expectedRatio = evaluateEditKeyframeEasing("cubic_bezier", 7 / 24, clip.keyframes![1]!.bezier);
    expect(atSeven.positionX).toBeCloseTo(-120 + 240 * expectedRatio, 9);
    expect(atSeven.positionY).toBeCloseTo(40 * expectedRatio, 9);
  });
});
