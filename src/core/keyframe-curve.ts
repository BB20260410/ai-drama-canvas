import type {
  EditClip,
  EditCubicBezier,
  EditCubicBezierSourceWindow,
  EditKeyframe,
  EditKeyframeEasing,
  EditKeyframeSourceTransform,
  EditKeyframeTransform,
} from "./types.js";

export const EDIT_KEYFRAME_EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "hold", "cubic_bezier"] as const satisfies readonly EditKeyframeEasing[];
export const DEFAULT_EDIT_CUBIC_BEZIER: Readonly<EditCubicBezier> = Object.freeze({ x1: .42, y1: 0, x2: .58, y2: 1 });
export const EDIT_KEYFRAME_CURVE_CONTRACT = "aicanvas.cubic-bezier.v2";
export const LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT = "aicanvas.cubic-bezier.v1";
export const EDIT_KEYFRAME_CURVE_CONTRACTS = [LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT, EDIT_KEYFRAME_CURVE_CONTRACT] as const;

const TRANSFORM_PROPERTIES = ["positionX", "positionY", "scale", "rotation"] as const;
export type EditTransform = EditKeyframeTransform;
const DERIVED_CONTROL_LIMIT = 1_000_000;
const MONOTONE_EPSILON = 1e-9;

function roundCurve(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function cubicDerivativeMinimum(first: number, second: number): number {
  // coordinate'(t) / 3 = c + b*t + a*t². 端点和凸二次的内部顶点共同决定 [0,1] 最小值。
  const a = 1 + 3 * first - 3 * second;
  const b = 2 * (second - 2 * first);
  const c = first;
  const values = [c, a + b + c];
  if (a > 0) {
    const vertex = -b / (2 * a);
    if (vertex > 0 && vertex < 1) values.push(a * vertex * vertex + b * vertex + c);
  }
  return 3 * Math.min(...values);
}

export function editKeyframeCurveIssue(easing: string | undefined, bezier: EditCubicBezier | undefined): string | undefined {
  const normalizedEasing = easing ?? "linear";
  if (!EDIT_KEYFRAME_EASINGS.includes(normalizedEasing as EditKeyframeEasing)) return `关键帧缓动类型不受支持：${normalizedEasing}`;
  if (normalizedEasing !== "cubic_bezier") return bezier === undefined ? undefined : `${normalizedEasing} 预设不能携带 cubic-bezier 控制点。`;
  if (!bezier || typeof bezier !== "object") return "cubic-bezier 关键帧必须提供四个控制点。";
  const entries = [["x1", bezier.x1], ["y1", bezier.y1], ["x2", bezier.x2], ["y2", bezier.y2]] as const;
  if (entries.some(([, value]) => !Number.isFinite(value))) return "cubic-bezier 控制点必须是有效数字。";
  const mode = bezier.mode ?? "unit";
  if (!["unit", "derived_monotone"].includes(mode)) return `cubic-bezier 控制点模式不受支持：${String(mode)}`;
  if (mode === "unit" && entries.some(([, value]) => value < 0 || value > 1)) return "unit cubic-bezier 控制点必须全部位于 0–1。";
  if (mode === "unit" && bezier.sourceWindow !== undefined) return "unit cubic-bezier 不能携带派生 sourceWindow。";
  if (mode === "derived_monotone") {
    if (entries.some(([, value]) => Math.abs(value) > DERIVED_CONTROL_LIMIT)) return `派生 cubic-bezier 控制点绝对值不能超过 ${DERIVED_CONTROL_LIMIT}。`;
    if (cubicDerivativeMinimum(bezier.x1, bezier.x2) < -MONOTONE_EPSILON || cubicDerivativeMinimum(bezier.y1, bezier.y2) < -MONOTONE_EPSILON) return "派生 cubic-bezier 的 x/y 坐标必须单调，拒绝无法唯一反解或产生 overshoot 的曲线。";
    const source = bezier.sourceWindow;
    if (!source || typeof source !== "object") return "derived_monotone cubic-bezier 必须携带原曲线 sourceWindow，避免病态求逆破坏分段保真。";
    const sourceEntries = [["x1", source.x1], ["y1", source.y1], ["x2", source.x2], ["y2", source.y2], ["startX", source.startX], ["endX", source.endX]] as const;
    if (sourceEntries.some(([, value]) => !Number.isFinite(value))) return "派生 cubic-bezier sourceWindow 必须是有效数字。";
    if (!["linear", "ease_in", "ease_out", "ease_in_out", "cubic_bezier"].includes(source.sourceEasing)) return "派生 cubic-bezier sourceWindow 必须记录原始连续 easing。";
    if ([source.x1, source.y1, source.x2, source.y2, source.startX, source.endX].some((value) => value < 0 || value > 1)) return "派生 cubic-bezier sourceWindow 必须位于原曲线的 0–1 定义域。";
    if (source.startX >= source.endX) return "派生 cubic-bezier sourceWindow 必须满足 startX < endX。";
    if (cubicDerivativeMinimum(source.x1, source.x2) < 0 || cubicDerivativeMinimum(source.y1, source.y2) < 0) return "派生 cubic-bezier sourceWindow 原曲线必须单调。";
    if (source.sourceEasing !== "cubic_bezier") {
      const expected = presetCubicBezier(source.sourceEasing);
      if ([source.x1 - expected.x1, source.y1 - expected.y1, source.x2 - expected.x2, source.y2 - expected.y2].some((difference) => Math.abs(difference) > 1e-12)) return "派生 cubic-bezier sourceWindow 与记录的原始 easing 不一致。";
    }
    const frameFields = [source.startFrame, source.endFrame, source.totalFrames];
    if (frameFields.some((value) => value !== undefined) && !frameFields.every((value) => Number.isInteger(value))) return "派生 cubic-bezier sourceWindow 的帧窗口必须同时提供整数 startFrame/endFrame/totalFrames。";
    if (source.startFrame !== undefined && source.endFrame !== undefined && source.totalFrames !== undefined && (source.startFrame < 0 || source.startFrame >= source.endFrame || source.endFrame > source.totalFrames || source.totalFrames < 1)) return "派生 cubic-bezier sourceWindow 的帧窗口范围无效。";
  }
  return undefined;
}

export function normalizeEditCubicBezier(bezier: EditCubicBezier): EditCubicBezier {
  const issue = editKeyframeCurveIssue("cubic_bezier", bezier);
  if (issue) throw new Error(issue);
  const mode = bezier.mode ?? "unit";
  const digits = mode === "derived_monotone" ? 15 : 6;
  const normalized: EditCubicBezier = {
    x1: roundCurve(bezier.x1, digits),
    y1: roundCurve(bezier.y1, digits),
    x2: roundCurve(bezier.x2, digits),
    y2: roundCurve(bezier.y2, digits),
    ...(mode === "derived_monotone" ? {
      mode,
      sourceWindow: {
        x1: roundCurve(bezier.sourceWindow!.x1, 15),
        y1: roundCurve(bezier.sourceWindow!.y1, 15),
        x2: roundCurve(bezier.sourceWindow!.x2, 15),
        y2: roundCurve(bezier.sourceWindow!.y2, 15),
        sourceEasing: bezier.sourceWindow!.sourceEasing,
        startX: roundCurve(bezier.sourceWindow!.startX, 15),
        endX: roundCurve(bezier.sourceWindow!.endX, 15),
        ...(bezier.sourceWindow!.startFrame !== undefined ? {
          startFrame: bezier.sourceWindow!.startFrame,
          endFrame: bezier.sourceWindow!.endFrame,
          totalFrames: bezier.sourceWindow!.totalFrames,
        } : {}),
      },
    } : {}),
  };
  const normalizedIssue = editKeyframeCurveIssue("cubic_bezier", normalized);
  if (normalizedIssue) throw new Error(normalizedIssue);
  return normalized;
}

export function editKeyframeSourceTransformIssue(
  easing: EditKeyframeEasing | undefined,
  bezier: EditCubicBezier | undefined,
  sourceTransform: EditKeyframeSourceTransform | undefined,
): string | undefined {
  const derived = easing === "cubic_bezier" && bezier?.mode === "derived_monotone";
  if (!derived) return sourceTransform === undefined ? undefined : "非派生关键帧不能携带 sourceTransform。";
  if (!sourceTransform || typeof sourceTransform !== "object") return "derived_monotone 关键帧必须携带原入段 sourceTransform。";
  const source = bezier.sourceWindow;
  if (source?.startFrame === undefined || source.endFrame === undefined || source.totalFrames === undefined) return "derived_monotone 关键帧必须携带完整整数帧 sourceWindow。";
  for (const anchor of [sourceTransform.start, sourceTransform.end]) {
    if (!anchor || !TRANSFORM_PROPERTIES.every((property) => Number.isFinite(anchor[property]))) return "derived_monotone 关键帧的 sourceTransform 必须包含有效变换数值。";
  }
  return undefined;
}

export function cubicCoordinate(parameter: number, first: number, second: number): number {
  const inverse = 1 - parameter;
  return 3 * inverse * inverse * parameter * first + 3 * inverse * parameter * parameter * second + parameter * parameter * parameter;
}

function solveCubicParameterAtX(curve: EditCubicBezier, progress: number): number {
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const parameter = (lower + upper) / 2;
    const coordinate = cubicCoordinate(parameter, curve.x1, curve.x2);
    if (coordinate === progress) return parameter;
    if (coordinate < progress) lower = parameter;
    else upper = parameter;
  }
  return (lower + upper) / 2;
}

export function solveEditCubicBezierParameterAtX(bezier: EditCubicBezier, ratio: number): number {
  if (!Number.isFinite(ratio)) throw new Error("关键帧插值比例必须是有效数字。");
  const progress = Math.max(0, Math.min(1, ratio));
  const curve = normalizeEditCubicBezier(bezier);
  if (progress === 0 || progress === 1) return progress;
  return solveCubicParameterAtX(curve, progress);
}

function evaluateCubicBezierControls(curve: EditCubicBezier, progress: number): number {
  if (progress === 0 || progress === 1) return progress;
  return cubicCoordinate(solveCubicParameterAtX(curve, progress), curve.y1, curve.y2);
}

function evaluatePresetEasing(easing: Exclude<EditKeyframeEasing, "hold" | "cubic_bezier">, progress: number): number {
  if (easing === "ease_in") return progress * progress;
  if (easing === "ease_out") return 1 - (1 - progress) * (1 - progress);
  if (easing === "ease_in_out") return progress * progress * (3 - 2 * progress);
  return progress;
}

function sourceWindowCurve(source: EditCubicBezierSourceWindow): EditCubicBezier {
  return { x1: source.x1, y1: source.y1, x2: source.x2, y2: source.y2 };
}

function evaluateSourceWindowEasing(source: EditCubicBezierSourceWindow, progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  if (source.sourceEasing === "cubic_bezier") return evaluateCubicBezierControls(sourceWindowCurve(source), clamped);
  return evaluatePresetEasing(source.sourceEasing, clamped);
}

export function evaluateEditKeyframeEasing(easing: EditKeyframeEasing | undefined, ratio: number, bezier?: EditCubicBezier): number {
  if (!Number.isFinite(ratio)) throw new Error("关键帧插值比例必须是有效数字。");
  const progress = Math.max(0, Math.min(1, ratio));
  const normalizedEasing = easing ?? "linear";
  const issue = editKeyframeCurveIssue(normalizedEasing, bezier);
  if (issue) throw new Error(issue);
  if (["linear", "ease_in", "ease_out", "ease_in_out"].includes(normalizedEasing)) return evaluatePresetEasing(normalizedEasing as Exclude<EditKeyframeEasing, "hold" | "cubic_bezier">, progress);
  if (normalizedEasing === "hold") return 0;
  if (progress === 0 || progress === 1) return progress;
  const curve = normalizeEditCubicBezier(bezier!);
  const source = curve.sourceWindow;
  if (!source) return evaluateCubicBezierControls(curve, progress);
  const startY = evaluateSourceWindowEasing(source, source.startX);
  const endY = evaluateSourceWindowEasing(source, source.endX);
  const sourceProgress = source.startX + (source.endX - source.startX) * progress;
  return (evaluateSourceWindowEasing(source, sourceProgress) - startY) / (endY - startY);
}

export function evaluateEditKeyframeEasingAtFrame(
  easing: EditKeyframeEasing | undefined,
  frameOffset: number,
  segmentFrames: number,
  bezier?: EditCubicBezier,
): number {
  if (!Number.isInteger(frameOffset) || !Number.isInteger(segmentFrames) || segmentFrames < 1) throw new Error("关键帧曲线帧窗口必须使用有效整数。");
  const clampedFrame = Math.max(0, Math.min(segmentFrames, frameOffset));
  const normalizedEasing = easing ?? "linear";
  const issue = editKeyframeCurveIssue(normalizedEasing, bezier);
  if (issue) throw new Error(issue);
  if (normalizedEasing !== "cubic_bezier") return evaluateEditKeyframeEasing(normalizedEasing, clampedFrame / segmentFrames, bezier);
  const curve = normalizeEditCubicBezier(bezier!);
  const source = curve.sourceWindow;
  if (source?.startFrame === undefined || source.endFrame === undefined || source.totalFrames === undefined) return evaluateEditKeyframeEasing(normalizedEasing, clampedFrame / segmentFrames, curve);
  if (source.endFrame - source.startFrame !== segmentFrames) throw new Error("派生 cubic-bezier 帧窗口与目标关键帧区段长度不一致。");
  if (clampedFrame === 0 || clampedFrame === segmentFrames) return clampedFrame / segmentFrames;
  const startY = evaluateSourceWindowEasing(source, source.startFrame / source.totalFrames);
  const endY = evaluateSourceWindowEasing(source, source.endFrame / source.totalFrames);
  const sourceProgress = (source.startFrame + clampedFrame) / source.totalFrames;
  return (evaluateSourceWindowEasing(source, sourceProgress) - startY) / (endY - startY);
}

export interface EditKeyframeCurveSpec {
  easing: EditKeyframeEasing;
  bezier?: EditCubicBezier;
}

export interface EditKeyframeCurveSubdivision {
  parameter: number;
  valueRatio: number;
  left: EditKeyframeCurveSpec;
  right: EditKeyframeCurveSpec;
}

interface CubicPoint { x: number; y: number }

function lerpPoint(left: CubicPoint, right: CubicPoint, ratio: number): CubicPoint {
  return { x: left.x + (right.x - left.x) * ratio, y: left.y + (right.y - left.y) * ratio };
}

function presetCubicBezier(easing: Exclude<EditKeyframeEasing, "hold" | "cubic_bezier">): EditCubicBezier {
  if (easing === "ease_in") return { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 / 3 };
  if (easing === "ease_out") return { x1: 1 / 3, y1: 2 / 3, x2: 2 / 3, y2: 1 };
  if (easing === "ease_in_out") return { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 };
  return { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
}

export interface EditKeyframeSubdivisionFrameWindow {
  segmentFrames: number;
  splitFrame: number;
}

export function subdivideEditKeyframeEasing(
  easing: EditKeyframeEasing | undefined,
  splitRatio: number,
  bezier?: EditCubicBezier,
  frameWindow?: EditKeyframeSubdivisionFrameWindow,
): EditKeyframeCurveSubdivision {
  if (!Number.isFinite(splitRatio)) throw new Error("关键帧曲线分段比例必须是有效数字。");
  if (splitRatio <= 0 || splitRatio >= 1) throw new Error("关键帧曲线只能在片段内部的比例分段。");
  if (frameWindow && (!Number.isInteger(frameWindow.segmentFrames) || !Number.isInteger(frameWindow.splitFrame) || frameWindow.segmentFrames < 2 || frameWindow.splitFrame < 1 || frameWindow.splitFrame >= frameWindow.segmentFrames || frameWindow.splitFrame / frameWindow.segmentFrames !== splitRatio)) throw new Error("关键帧曲线分段帧窗口与分段比例不一致。");
  const normalizedEasing = easing ?? "linear";
  const issue = editKeyframeCurveIssue(normalizedEasing, bezier);
  if (issue) throw new Error(issue);
  if (normalizedEasing === "hold") return { parameter: splitRatio, valueRatio: 0, left: { easing: "linear" }, right: { easing: "hold" } };

  const curve = normalizedEasing === "cubic_bezier"
    ? normalizeEditCubicBezier(bezier!)
    : presetCubicBezier(normalizedEasing);
  const parameter = solveCubicParameterAtX(curve, splitRatio);
  const p0 = { x: 0, y: 0 };
  const p1 = { x: curve.x1, y: curve.y1 };
  const p2 = { x: curve.x2, y: curve.y2 };
  const p3 = { x: 1, y: 1 };
  const a = lerpPoint(p0, p1, parameter);
  const b = lerpPoint(p1, p2, parameter);
  const c = lerpPoint(p2, p3, parameter);
  const d = lerpPoint(a, b, parameter);
  const e = lerpPoint(b, c, parameter);
  const split = lerpPoint(d, e, parameter);
  const approximationValueRatio = split.y;
  if (approximationValueRatio <= 0 || approximationValueRatio >= 1) throw new Error("关键帧曲线在切点无法形成连续子区间；拒绝静默改变动画。");
  const valueRatio = frameWindow
    ? evaluateEditKeyframeEasingAtFrame(normalizedEasing, frameWindow.splitFrame, frameWindow.segmentFrames, bezier)
    : evaluateEditKeyframeEasing(normalizedEasing, splitRatio, bezier);
  const existingSource = curve.sourceWindow;
  const parentSource = existingSource
    ? { x1: existingSource.x1, y1: existingSource.y1, x2: existingSource.x2, y2: existingSource.y2, sourceEasing: existingSource.sourceEasing, startX: existingSource.startX, endX: existingSource.endX }
    : { x1: curve.x1, y1: curve.y1, x2: curve.x2, y2: curve.y2, sourceEasing: normalizedEasing, startX: 0, endX: 1 };
  let leftFrameWindow: Pick<NonNullable<EditCubicBezier["sourceWindow"]>, "startFrame" | "endFrame" | "totalFrames"> | undefined;
  let rightFrameWindow: typeof leftFrameWindow;
  let sourceSplitX = parentSource.startX + (parentSource.endX - parentSource.startX) * splitRatio;
  if (frameWindow) {
    const sourceStartFrame = existingSource?.startFrame ?? 0;
    const sourceEndFrame = existingSource?.endFrame ?? frameWindow.segmentFrames;
    const sourceTotalFrames = existingSource?.totalFrames ?? frameWindow.segmentFrames;
    if (sourceEndFrame - sourceStartFrame !== frameWindow.segmentFrames) throw new Error("派生 cubic-bezier 帧窗口与待分段区间长度不一致。");
    const sourceSplitFrame = sourceStartFrame + frameWindow.splitFrame;
    sourceSplitX = sourceSplitFrame / sourceTotalFrames;
    leftFrameWindow = { startFrame: sourceStartFrame, endFrame: sourceSplitFrame, totalFrames: sourceTotalFrames };
    rightFrameWindow = { startFrame: sourceSplitFrame, endFrame: sourceEndFrame, totalFrames: sourceTotalFrames };
  }
  const mode = "derived_monotone" as const;
  const left = normalizeEditCubicBezier({
    x1: a.x / splitRatio,
    y1: a.y / approximationValueRatio,
    x2: d.x / splitRatio,
    y2: d.y / approximationValueRatio,
    mode,
    sourceWindow: { ...parentSource, endX: sourceSplitX, ...leftFrameWindow },
  });
  const right = normalizeEditCubicBezier({
    x1: (e.x - splitRatio) / (1 - splitRatio),
    y1: (e.y - approximationValueRatio) / (1 - approximationValueRatio),
    x2: (c.x - splitRatio) / (1 - splitRatio),
    y2: (c.y - approximationValueRatio) / (1 - approximationValueRatio),
    mode,
    sourceWindow: { ...parentSource, startX: sourceSplitX, ...rightFrameWindow },
  });
  return { parameter, valueRatio, left: { easing: "cubic_bezier", bezier: left }, right: { easing: "cubic_bezier", bezier: right } };
}

interface EditTransformPoint extends EditTransform {
  timeSeconds: number;
  frame?: number;
  easing: EditKeyframeEasing;
  bezier?: EditCubicBezier;
  sourceTransform?: EditKeyframeSourceTransform;
}

function pointFromKeyframe(keyframe: EditKeyframe): EditTransformPoint {
  return {
    timeSeconds: keyframe.timeSeconds,
    frame: keyframe.frame,
    easing: keyframe.easing ?? "linear",
    bezier: keyframe.bezier,
    sourceTransform: keyframe.sourceTransform,
    positionX: keyframe.positionX,
    positionY: keyframe.positionY,
    scale: keyframe.scale,
    rotation: keyframe.rotation,
  };
}

function interpolateSourceTransform(sourceTransform: EditKeyframeSourceTransform, source: EditCubicBezierSourceWindow, sourceProgress: number): EditTransform {
  const ratio = evaluateSourceWindowEasing(source, sourceProgress);
  return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, sourceTransform.start[property] + (sourceTransform.end[property] - sourceTransform.start[property]) * ratio])) as unknown as EditTransform;
}

export function evaluateEditKeyframeSourceTransformAtFrame(keyframe: Pick<EditKeyframe, "easing" | "bezier" | "sourceTransform">, frameOffset: number, segmentFrames: number): EditTransform {
  const curveIssue = editKeyframeCurveIssue(keyframe.easing, keyframe.bezier);
  if (curveIssue) throw new Error(curveIssue);
  const sourceIssue = editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
  if (sourceIssue) throw new Error(sourceIssue);
  if (!Number.isInteger(frameOffset) || !Number.isInteger(segmentFrames) || segmentFrames < 1) throw new Error("派生关键帧 sourceTransform 必须使用有效整数帧窗口。");
  const source = keyframe.bezier!.sourceWindow!;
  if (source.endFrame! - source.startFrame! !== segmentFrames) throw new Error("派生关键帧 sourceTransform 与目标关键帧区段长度不一致。");
  const clampedFrame = Math.max(0, Math.min(segmentFrames, frameOffset));
  return interpolateSourceTransform(keyframe.sourceTransform!, source, (source.startFrame! + clampedFrame) / source.totalFrames!);
}

function evaluateEditKeyframeSourceTransformAtRatio(keyframe: Pick<EditKeyframe, "easing" | "bezier" | "sourceTransform">, ratio: number): EditTransform {
  const sourceIssue = editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
  if (sourceIssue) throw new Error(sourceIssue);
  const source = keyframe.bezier!.sourceWindow!;
  const progress = Math.max(0, Math.min(1, ratio));
  return interpolateSourceTransform(keyframe.sourceTransform!, source, source.startX + (source.endX - source.startX) * progress);
}

export function editTransformPoints(clip: EditClip): EditTransformPoint[] {
  const points: EditTransformPoint[] = [{
    timeSeconds: 0,
    easing: "linear",
    positionX: Number(clip.positionX ?? 0),
    positionY: Number(clip.positionY ?? 0),
    scale: Number(clip.scale ?? 1),
    rotation: Number(clip.rotation ?? 0),
  }];
  for (const keyframe of clip.keyframes ?? []) {
    const point = pointFromKeyframe(keyframe);
    const duplicate = points.findIndex((candidate) => Math.abs(candidate.timeSeconds - point.timeSeconds) < .0000005);
    if (duplicate >= 0) points[duplicate] = point;
    else points.push(point);
  }
  return points.sort((left, right) => left.timeSeconds - right.timeSeconds);
}

export function evaluateEditTransformAt(clip: EditClip, localTimeSeconds: number): EditTransform {
  if (!Number.isFinite(localTimeSeconds)) throw new Error("关键帧预览时间必须是有效数字。");
  const points = editTransformPoints(clip);
  const time = Math.max(0, Math.min(clip.durationSeconds, localTimeSeconds));
  const exactIndex = points.findIndex((point) => Math.abs(point.timeSeconds - time) < .0000005);
  if (exactIndex >= 0) {
    const exact = points[exactIndex]!;
    const previous = points[exactIndex - 1];
    if (previous && exact.bezier?.mode === "derived_monotone") return evaluateEditKeyframeSourceTransformAtRatio(exact, 1);
    const next = points[exactIndex + 1];
    if (next?.bezier?.mode === "derived_monotone") return evaluateEditKeyframeSourceTransformAtRatio(next, 0);
    return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, exact[property]])) as unknown as EditTransform;
  }
  if (time <= points[0]!.timeSeconds) return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, points[0]![property]])) as unknown as EditTransform;
  if (time >= points.at(-1)!.timeSeconds) return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, points.at(-1)![property]])) as unknown as EditTransform;
  const nextIndex = points.findIndex((point) => point.timeSeconds > time);
  const before = points[nextIndex - 1]!;
  const after = points[nextIndex]!;
  const linearRatio = (time - before.timeSeconds) / Math.max(.000001, after.timeSeconds - before.timeSeconds);
  if (after.bezier?.mode === "derived_monotone") return evaluateEditKeyframeSourceTransformAtRatio(after, linearRatio);
  const ratio = evaluateEditKeyframeEasing(after.easing, linearRatio, after.bezier);
  return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, before[property] + (after[property] - before[property]) * ratio])) as unknown as EditTransform;
}

export function editTransformFramePoints(clip: EditClip, frameRate: number): Array<EditTransformPoint & { frame: number }> {
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error("关键帧帧率必须是有效正数。");
  const points: Array<EditTransformPoint & { frame: number }> = [{
    frame: 0,
    timeSeconds: 0,
    easing: "linear",
    positionX: Number(clip.positionX ?? 0),
    positionY: Number(clip.positionY ?? 0),
    scale: Number(clip.scale ?? 1),
    rotation: Number(clip.rotation ?? 0),
  }];
  for (const keyframe of clip.keyframes ?? []) {
    const point = { ...pointFromKeyframe(keyframe), frame: Number.isInteger(keyframe.frame) ? keyframe.frame! : Math.max(0, Math.round(keyframe.timeSeconds * frameRate)) };
    const duplicate = points.findIndex((candidate) => candidate.frame === point.frame);
    if (duplicate >= 0) points[duplicate] = point;
    else points.push(point);
  }
  return points.sort((left, right) => left.frame - right.frame);
}

export function evaluateEditTransformAtFrame(clip: EditClip, localFrame: number, frameRate: number): EditTransform {
  if (!Number.isFinite(localFrame)) throw new Error("关键帧预览帧必须是有效数字。");
  const points = editTransformFramePoints(clip, frameRate);
  const durationFrames = Number.isInteger(clip.durationFrames) ? clip.durationFrames! : Math.max(1, Math.round(clip.durationSeconds * frameRate));
  const frame = Math.max(0, Math.min(durationFrames, localFrame));
  const exactIndex = points.findIndex((point) => point.frame === frame);
  if (exactIndex >= 0) {
    const exact = points[exactIndex]!;
    const previous = points[exactIndex - 1];
    if (previous && exact.bezier?.mode === "derived_monotone") return evaluateEditKeyframeSourceTransformAtFrame(exact, exact.frame - previous.frame, exact.frame - previous.frame);
    const next = points[exactIndex + 1];
    if (next?.bezier?.mode === "derived_monotone") return evaluateEditKeyframeSourceTransformAtFrame(next, 0, next.frame - exact.frame);
    return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, exact[property]])) as unknown as EditTransform;
  }
  if (frame <= points[0]!.frame) return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, points[0]![property]])) as unknown as EditTransform;
  if (frame >= points.at(-1)!.frame) return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, points.at(-1)![property]])) as unknown as EditTransform;
  const nextIndex = points.findIndex((point) => point.frame > frame);
  const before = points[nextIndex - 1]!;
  const after = points[nextIndex]!;
  const segmentFrames = Math.max(1, after.frame - before.frame);
  if (after.bezier?.mode === "derived_monotone") return evaluateEditKeyframeSourceTransformAtFrame(after, frame - before.frame, segmentFrames);
  const ratio = evaluateEditKeyframeEasingAtFrame(after.easing, frame - before.frame, segmentFrames, after.bezier);
  return Object.fromEntries(TRANSFORM_PROPERTIES.map((property) => [property, before[property] + (after[property] - before[property]) * ratio])) as unknown as EditTransform;
}

function ffmpegNumber(value: number): string {
  const normalized = roundCurve(value, 15);
  return Object.is(normalized, -0) ? "0" : String(normalized);
}

export interface FfmpegEasingFrameWindow {
  frameOffsetExpression: string;
  segmentFrames: number;
}

export function buildFfmpegEasingExpression(
  easing: EditKeyframeEasing | undefined,
  ratioExpression: string,
  bezier?: EditCubicBezier,
  frameWindow?: FfmpegEasingFrameWindow,
): string {
  const normalizedEasing = easing ?? "linear";
  const issue = editKeyframeCurveIssue(normalizedEasing, bezier);
  if (issue) throw new Error(issue);
  if (normalizedEasing === "ease_in") return `(${ratioExpression})*(${ratioExpression})`;
  if (normalizedEasing === "ease_out") return `1-(1-(${ratioExpression}))*(1-(${ratioExpression}))`;
  if (normalizedEasing === "ease_in_out") return `(${ratioExpression})*(${ratioExpression})*(3-2*(${ratioExpression}))`;
  if (normalizedEasing === "hold") return "0";
  if (normalizedEasing !== "cubic_bezier") return ratioExpression;
  const curve = normalizeEditCubicBezier(bezier!);
  const localProgress = `max(0,min(1,${ratioExpression}))`;
  const source = curve.sourceWindow;
  const useSourceFrames = Boolean(source && frameWindow && source.startFrame !== undefined && source.endFrame !== undefined && source.totalFrames !== undefined);
  if (useSourceFrames && source!.endFrame! - source!.startFrame! !== frameWindow!.segmentFrames) throw new Error("派生 cubic-bezier FFmpeg 帧窗口与目标关键帧区段长度不一致。");
  if (source) {
    const progress = useSourceFrames
      ? `max(0,min(1,(${source.startFrame}+(${frameWindow!.frameOffsetExpression}))/${source.totalFrames}))`
      : `max(0,min(1,${ffmpegNumber(source.startX)}+(${ffmpegNumber(source.endX - source.startX)})*(${localProgress})))`;
    const raw = buildFfmpegEasingExpression(source.sourceEasing, progress, source.sourceEasing === "cubic_bezier" ? sourceWindowCurve(source) : undefined);
    const startProgress = useSourceFrames ? source.startFrame! / source.totalFrames! : source.startX;
    const endProgress = useSourceFrames ? source.endFrame! / source.totalFrames! : source.endX;
    const startY = evaluateSourceWindowEasing(source, startProgress);
    const endY = evaluateSourceWindowEasing(source, endProgress);
    return `((${raw})-${ffmpegNumber(startY)})/${ffmpegNumber(endY - startY)}`;
  }
  const progress = localProgress;
  const parameter = "ld(0)";
  const x = `3*(1-${parameter})*(1-${parameter})*${parameter}*${ffmpegNumber(curve.x1)}+3*(1-${parameter})*${parameter}*${parameter}*${ffmpegNumber(curve.x2)}+${parameter}*${parameter}*${parameter}`;
  const root = `root((${x})-(${progress}),1)`;
  const solved = "ld(1)";
  const y = `3*(1-${solved})*(1-${solved})*${solved}*${ffmpegNumber(curve.y1)}+3*(1-${solved})*${solved}*${solved}*${ffmpegNumber(curve.y2)}+${solved}*${solved}*${solved}`;
  return `st(1,${root})*0+(${y})`;
}

export function buildFfmpegKeyframeSourceTransformExpression(
  keyframe: Pick<EditKeyframe, "easing" | "bezier" | "sourceTransform">,
  property: keyof EditTransform,
  frameOffsetExpression: string,
  segmentFrames: number,
): string {
  const curveIssue = editKeyframeCurveIssue(keyframe.easing, keyframe.bezier);
  if (curveIssue) throw new Error(curveIssue);
  const sourceIssue = editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
  if (sourceIssue) throw new Error(sourceIssue);
  const source = keyframe.bezier!.sourceWindow!;
  if (source.endFrame! - source.startFrame! !== segmentFrames) throw new Error("派生关键帧 FFmpeg sourceTransform 与目标关键帧区段长度不一致。");
  const progress = `max(0,min(1,(${source.startFrame}+(${frameOffsetExpression}))/${source.totalFrames}))`;
  const raw = buildFfmpegEasingExpression(source.sourceEasing, progress, source.sourceEasing === "cubic_bezier" ? sourceWindowCurve(source) : undefined);
  const start = keyframe.sourceTransform!.start[property];
  const delta = keyframe.sourceTransform!.end[property] - start;
  return `${ffmpegNumber(start)}+(${ffmpegNumber(delta)})*(${raw})`;
}
