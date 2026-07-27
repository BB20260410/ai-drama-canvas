import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  applyEditOperation,
  createEditProject,
  extractTimelineFrame,
  exportEditProjectOtio,
  probeVideoEngine,
  renderEditProject,
  saveEditProject,
} from "../src/core/editor.js";
import { evaluateEditTransformAtFrame } from "../src/core/keyframe-curve.js";
import { readMachineMediaRuntimeSnapshot } from "../src/core/media-runtime.js";
import { listPublicationReceipts } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, readJson, writeJsonAtomic } from "../src/core/sidecar.js";
import type { EditClip, EditProject } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "keyframe-subdivision-render-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const width = 320;
const height = 320;
const frameBytes = width * height * 3;
const rateNumerator = 24_000;
const rateDenominator = 1_001;
const frameRate = rateNumerator / rateDenominator;
const totalFrames = 48;
const splitFrame = 13;
const trimEndFrame = 31;
const durationSeconds = totalFrames / frameRate;
await mkdir(evidenceDirectory, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-keyframe-subdivision-render-"));
const registryPath = path.join(os.tmpdir(), `ai-canvas-keyframe-subdivision-render-registry-${process.pid}-${Date.now()}.json`);
const keepFixture = process.env.AI_CANVAS_KEEP_SUBDIVISION_FIXTURE === "1";
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function frameSeconds(frame: number): number {
  return frame / frameRate;
}

const expectedSourceTransform = {
  start: { positionX: -110, positionY: 0, scale: .12, rotation: 0 },
  end: { positionX: 110, positionY: 0, scale: .12, rotation: 0 },
};

function assertDerivedAuthority(keyframe: NonNullable<EditClip["keyframes"]>[number], label: string): void {
  if (keyframe.bezier?.mode !== "derived_monotone") throw new Error(`${label} 没有生成派生曲线。`);
  if (keyframe.bezier.sourceWindow?.sourceEasing !== "cubic_bezier") throw new Error(`${label} 没有保留原始 cubic_bezier easing。`);
  if (JSON.stringify(keyframe.sourceTransform) !== JSON.stringify(expectedSourceTransform)) {
    throw new Error(`${label} 没有保留原段 transform anchors：${JSON.stringify(keyframe.sourceTransform)}`);
  }
}

interface RedFrameAnalysis {
  pixels: number;
  centroid: { x: number; y: number };
  bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  mean: { red: number; green: number; blue: number };
}

function analyzeRedFrame(frame: Buffer): RedFrameAnalysis {
  let pixels = 0;
  let sumX = 0;
  let sumY = 0;
  let sumRed = 0;
  let sumGreen = 0;
  let sumBlue = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3;
    const red = frame[offset] ?? 0;
    const green = frame[offset + 1] ?? 0;
    const blue = frame[offset + 2] ?? 0;
    if (red < 60 || red < green * 1.5 || red < blue * 1.5) continue;
    pixels += 1;
    sumX += x;
    sumY += y;
    sumRed += red;
    sumGreen += green;
    sumBlue += blue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!pixels) throw new Error("解码帧没有检测到红色覆盖层。");
  return {
    pixels,
    centroid: { x: sumX / pixels, y: sumY / pixels },
    bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    mean: { red: sumRed / pixels, green: sumGreen / pixels, blue: sumBlue / pixels },
  };
}

function frameDifference(left: Buffer, right: Buffer) {
  let sum = 0;
  let max = 0;
  let changedChannels = 0;
  for (let index = 0; index < left.length; index += 1) {
    const difference = Math.abs((left[index] ?? 0) - (right[index] ?? 0));
    sum += difference;
    max = Math.max(max, difference);
    if (difference) changedChannels += 1;
  }
  return { meanAbsoluteChannelDifference: sum / left.length, maxChannelDifference: max, changedChannels };
}

const transformProperties = ["positionX", "positionY", "scale", "rotation"] as const;

function compareCoreTransforms(
  label: string,
  original: EditClip,
  frames: number[],
  candidateAtFrame: (frame: number) => { clip: EditClip; localFrame: number },
) {
  let maximumAbsoluteDifference = 0;
  let worst: { frame: number; property: (typeof transformProperties)[number]; difference: number } | undefined;
  for (const frame of frames) {
    const expected = evaluateEditTransformAtFrame(original, frame, frameRate);
    const candidate = candidateAtFrame(frame);
    const actual = evaluateEditTransformAtFrame(candidate.clip, candidate.localFrame, frameRate);
    for (const property of transformProperties) {
      const difference = Math.abs(actual[property] - expected[property]);
      if (difference > maximumAbsoluteDifference) {
        maximumAbsoluteDifference = difference;
        worst = { frame, property, difference };
      }
    }
  }
  if (maximumAbsoluteDifference !== 0) throw new Error(`${label} 核心逐帧 transform 不是严格零差值：${JSON.stringify({ maximumAbsoluteDifference, worst })}`);
  return { framesCompared: frames.length, frames, maximumAbsoluteDifference, exact: true };
}

interface LosslessTimelineFrame {
  frame: number;
  actualTimeSeconds: number;
  pixels: Buffer;
}

async function extractLosslessTimelineFrames(project: EditProject, frames: number[]): Promise<Map<number, LosslessTimelineFrame>> {
  const extracted = new Map<number, LosslessTimelineFrame>();
  for (const frame of frames) {
    const result = await extractTimelineFrame(root, { editProjectId: project.id, expectedRevision: project.revision, timeSeconds: frameSeconds(frame) });
    const pixels = await sharp(result.framePath, { failOn: "error" }).removeAlpha().raw().toBuffer();
    if (pixels.length !== frameBytes) throw new Error(`lossless F${frame} 解码字节 ${pixels.length}，预期 ${frameBytes}。`);
    extracted.set(frame, { frame, actualTimeSeconds: result.timeSeconds, pixels });
  }
  return extracted;
}

function compareLosslessTimelineFrames(
  label: string,
  baseline: Map<number, LosslessTimelineFrame>,
  candidate: Map<number, LosslessTimelineFrame>,
  frames: number[],
) {
  const baselineHash = createHash("sha256");
  const candidateHash = createHash("sha256");
  let changedFrames = 0;
  let changedChannels = 0;
  let maximumChannelDifference = 0;
  let worstFrame: number | undefined;
  for (const frame of frames) {
    const left = baseline.get(frame);
    const right = candidate.get(frame);
    if (!left || !right) throw new Error(`${label} 缺少 lossless F${frame}。`);
    baselineHash.update(left.pixels);
    candidateHash.update(right.pixels);
    const difference = frameDifference(left.pixels, right.pixels);
    if (difference.changedChannels > 0) changedFrames += 1;
    changedChannels += difference.changedChannels;
    if (difference.maxChannelDifference > maximumChannelDifference) {
      maximumChannelDifference = difference.maxChannelDifference;
      worstFrame = frame;
    }
  }
  const baselineRawSha256 = baselineHash.digest("hex");
  const candidateRawSha256 = candidateHash.digest("hex");
  if (changedFrames !== 0 || changedChannels !== 0 || maximumChannelDifference !== 0 || baselineRawSha256 !== candidateRawSha256) {
    throw new Error(`${label} pre-encode/lossless 逐帧画面不是严格零差值：${JSON.stringify({ changedFrames, changedChannels, maximumChannelDifference, worstFrame, baselineRawSha256, candidateRawSha256 })}`);
  }
  return { framesCompared: frames.length, frames, changedFrames, changedChannels, maximumChannelDifference, baselineRawSha256, candidateRawSha256, exact: true };
}

async function decodeFrames(ffmpegPath: string, filePath: string): Promise<Buffer[]> {
  const result = await execFileAsync(ffmpegPath, ["-v", "error", "-i", filePath, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: null, maxBuffer: 80 * 1024 * 1024 }) as unknown as { stdout: Buffer };
  if (result.stdout.length % frameBytes !== 0) throw new Error(`原始帧字节数无法按 ${frameBytes} 对齐：${filePath}`);
  return Array.from({ length: result.stdout.length / frameBytes }, (_, index) => result.stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
}

async function createAnimatedProject(name: string, basePath: string, overlayPath: string): Promise<{ project: EditProject; overlay: EditClip }> {
  const project = await createEditProject(root, { name, width, height, fps: frameRate, autoPopulate: false });
  const mainTrack = project.tracks.find((track) => track.kind === "visual")!;
  mainTrack.clips.push({
    id: `clip-base-${name}`, trackId: mainTrack.id, kind: "video", name: "黑底", sourcePath: basePath,
    startSeconds: 0, durationSeconds, trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: 1, muted: false,
    positionX: 0, positionY: 0, scale: 1, rotation: 0, filter: "none", filterIntensity: 1, keyframes: [],
  });
  const overlayTrackId = `track-overlay-${name}`;
  const overlay: EditClip = {
    id: `clip-overlay-${name}`, trackId: overlayTrackId, kind: "video", name: "红色交叉曲线块", sourcePath: overlayPath,
    startSeconds: 0, durationSeconds, trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: .45, muted: false,
    positionX: -110, positionY: 0, scale: .12, rotation: 0, filter: "none", filterIntensity: 1,
    keyframes: [
      { id: `kf-start-${name}`, frame: 0, timeSeconds: 0, easing: "hold", positionX: -110, positionY: 0, scale: .12, rotation: 0 },
      { id: `kf-end-${name}`, frame: totalFrames, timeSeconds: durationSeconds, easing: "cubic_bezier", bezier: { x1: 1, y1: 0, x2: 0, y2: 1 }, positionX: 110, positionY: 0, scale: .12, rotation: 0 },
    ],
  };
  project.tracks.splice(1, 0, { id: overlayTrackId, kind: "visual", name: "交叉曲线覆盖层", order: 1, locked: false, muted: false, hidden: false, clips: [overlay] });
  project.tracks.forEach((track, order) => { track.order = order; });
  const saved = await saveEditProject(root, project, project.revision);
  return { project: saved, overlay: saved.tracks.flatMap((track) => track.clips).find((clip) => clip.id === overlay.id)! };
}

async function renderPermanent(label: string, project: EditProject) {
  const render = await renderEditProject(root, project.id, { expectedRevision: project.revision, outputDirectory: root });
  if (render.status !== "succeeded") throw new Error(render.error || `${label} 成片导出失败。`);
  const permanentPath = path.join(evidenceDirectory, `keyframe-subdivision-${label}-20260714.mp4`);
  await copyFile(render.outputPath, permanentPath);
  const bytes = (await stat(permanentPath)).size;
  const header = (await readFile(permanentPath)).subarray(0, 16).toString("latin1");
  if (bytes <= 1_000 || !header.includes("ftyp")) throw new Error(`${label} 成片为空或缺少 MP4 ftyp 魔数。`);
  return { render, permanentPath, bytes, sha256: await sha256(permanentPath) };
}

function compareRanges(label: string, baseline: Buffer[], candidate: Buffer[], frames: number[]) {
  const comparisons = frames.map((frame) => {
    let baselineAnalysis: RedFrameAnalysis;
    let candidateAnalysis: RedFrameAnalysis;
    try { baselineAnalysis = analyzeRedFrame(baseline[frame]!); }
    catch (error) { throw new Error(`${label} baseline F${frame}：${error instanceof Error ? error.message : String(error)}`); }
    try { candidateAnalysis = analyzeRedFrame(candidate[frame]!); }
    catch (error) { throw new Error(`${label} candidate F${frame}：${error instanceof Error ? error.message : String(error)}`); }
    const difference = frameDifference(baseline[frame]!, candidate[frame]!);
    return {
      frame,
      centroidError: Math.hypot(candidateAnalysis.centroid.x - baselineAnalysis.centroid.x, candidateAnalysis.centroid.y - baselineAnalysis.centroid.y),
      redMeanError: Math.abs(candidateAnalysis.mean.red - baselineAnalysis.mean.red),
      redPixelDifference: Math.abs(candidateAnalysis.pixels - baselineAnalysis.pixels),
      bboxDifference: Math.max(
        Math.abs(candidateAnalysis.bbox.minX - baselineAnalysis.bbox.minX),
        Math.abs(candidateAnalysis.bbox.maxX - baselineAnalysis.bbox.maxX),
        Math.abs(candidateAnalysis.bbox.minY - baselineAnalysis.bbox.minY),
        Math.abs(candidateAnalysis.bbox.maxY - baselineAnalysis.bbox.maxY),
      ),
      difference,
      baseline: baselineAnalysis,
      candidate: candidateAnalysis,
    };
  });
  const maxima = {
    centroidError: Math.max(...comparisons.map((entry) => entry.centroidError)),
    redMeanError: Math.max(...comparisons.map((entry) => entry.redMeanError)),
    redPixelDifference: Math.max(...comparisons.map((entry) => entry.redPixelDifference)),
    bboxDifference: Math.max(...comparisons.map((entry) => entry.bboxDifference)),
    meanAbsoluteChannelDifference: Math.max(...comparisons.map((entry) => entry.difference.meanAbsoluteChannelDifference)),
    maxChannelDifference: Math.max(...comparisons.map((entry) => entry.difference.maxChannelDifference)),
  };
  if (maxima.centroidError > .45 || maxima.redMeanError > 6 || maxima.bboxDifference > 1 || maxima.meanAbsoluteChannelDifference > 2.5) {
    const worst = comparisons.slice().sort((left, right) => right.centroidError - left.centroidError || right.bboxDifference - left.bboxDifference)[0];
    throw new Error(`${label} 逐帧等价超出预算：${JSON.stringify({ maxima, worst })}`);
  }
  return { framesCompared: comparisons.length, frames, maxima, boundary: comparisons.filter((entry) => [splitFrame - 1, splitFrame, splitFrame + 1, trimEndFrame - 1].includes(entry.frame)) };
}

try {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath || !engine.ffprobePath) throw new Error(`FFmpeg/ffprobe 不可用：${engine.issues.join("；")}`);
  const config = await ensureSidecar(root);
  config.sourceRoots = [root];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const basePath = path.join(root, "subdivision-base-black.mp4");
  const overlayPath = path.join(root, "subdivision-overlay-red.mp4");
  const sourceRate = `${rateNumerator}/${rateDenominator}`;
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${sourceRate}:d=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", basePath]);
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=red:s=${width}x${height}:r=${sourceRate}:d=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", overlayPath]);
  await scanAndPersist(root);

  const baselineProject = await createAnimatedProject("baseline", basePath, overlayPath);
  const splitProject = await createAnimatedProject("split", basePath, overlayPath);
  const splitOperation = await applyEditOperation(root, splitProject.project.id, splitProject.project.revision, { type: "split_clip", clipId: splitProject.overlay.id, timeSeconds: frameSeconds(splitFrame) });
  const splitClips = splitOperation.project.tracks.flatMap((track) => track.clips).filter((clip) => clip.trackId === splitProject.overlay.trackId).sort((left, right) => left.startFrame! - right.startFrame!);
  const leftBoundary = splitClips[0]!.keyframes!.at(-1)!;
  const rightTarget = splitClips[1]!.keyframes![0]!;
  assertDerivedAuthority(leftBoundary, "split 左段边界");
  assertDerivedAuthority(rightTarget, "split 右段目标");
  if (!([leftBoundary.bezier!.x1, leftBoundary.bezier!.y1, leftBoundary.bezier!.x2, leftBoundary.bezier!.y2, rightTarget.bezier!.x1, rightTarget.bezier!.y1, rightTarget.bezier!.x2, rightTarget.bezier!.y2].some((value) => value < 0 || value > 1))) throw new Error("真实 smoke 没有覆盖框外派生控制点。");

  const trimStartProject = await createAnimatedProject("trim-start", basePath, overlayPath);
  const trimStartOperation = await applyEditOperation(root, trimStartProject.project.id, trimStartProject.project.revision, { type: "trim_to_playhead", clipId: trimStartProject.overlay.id, timeSeconds: frameSeconds(splitFrame), side: "start" });
  const trimEndProject = await createAnimatedProject("trim-end", basePath, overlayPath);
  const trimEndOperation = await applyEditOperation(root, trimEndProject.project.id, trimEndProject.project.revision, { type: "trim_to_playhead", clipId: trimEndProject.overlay.id, timeSeconds: frameSeconds(trimEndFrame), side: "end" });
  const trimStartDerived = trimStartOperation.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === trimStartProject.overlay.id)!.keyframes![0]!;
  const trimEndDerived = trimEndOperation.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === trimEndProject.overlay.id)!.keyframes!.at(-1)!;
  const trimStartClip = trimStartOperation.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === trimStartProject.overlay.id)!;
  const trimEndClip = trimEndOperation.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === trimEndProject.overlay.id)!;
  assertDerivedAuthority(trimStartDerived, "trim-start 目标");
  assertDerivedAuthority(trimEndDerived, "trim-end 边界");

  const originalOverlay = baselineProject.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === baselineProject.overlay.id)!;
  const splitFrames = Array.from({ length: totalFrames }, (_, frame) => frame);
  const trimStartFrames = Array.from({ length: totalFrames - splitFrame }, (_, index) => splitFrame + index);
  const trimEndFrames = Array.from({ length: trimEndFrame }, (_, frame) => frame);
  const coreEquivalence = {
    split: compareCoreTransforms("split", originalOverlay, Array.from({ length: totalFrames + 1 }, (_, frame) => frame), (frame) => ({ clip: frame < splitFrame ? splitClips[0]! : splitClips[1]!, localFrame: frame < splitFrame ? frame : frame - splitFrame })),
    trimStart: compareCoreTransforms("trim-start", originalOverlay, Array.from({ length: totalFrames - splitFrame + 1 }, (_, index) => splitFrame + index), (frame) => ({ clip: trimStartClip, localFrame: frame - splitFrame })),
    trimEnd: compareCoreTransforms("trim-end", originalOverlay, Array.from({ length: trimEndFrame + 1 }, (_, frame) => frame), (frame) => ({ clip: trimEndClip, localFrame: frame })),
  };

  const baselineLossless = await extractLosslessTimelineFrames(baselineProject.project, splitFrames);
  const losslessEquivalence = {
    split: compareLosslessTimelineFrames("split", baselineLossless, await extractLosslessTimelineFrames(splitOperation.project, splitFrames), splitFrames),
    trimStart: compareLosslessTimelineFrames("trim-start", baselineLossless, await extractLosslessTimelineFrames(trimStartOperation.project, trimStartFrames), trimStartFrames),
    trimEnd: compareLosslessTimelineFrames("trim-end", baselineLossless, await extractLosslessTimelineFrames(trimEndOperation.project, trimEndFrames), trimEndFrames),
  };

  const baselineRender = await renderPermanent("baseline", baselineProject.project);
  const splitRender = await renderPermanent("split", splitOperation.project);
  const trimStartRender = await renderPermanent("trim-start", trimStartOperation.project);
  const trimEndRender = await renderPermanent("trim-end", trimEndOperation.project);
  const rendered = { baseline: baselineRender, split: splitRender, trimStart: trimStartRender, trimEnd: trimEndRender };
  const decoded = {
    baseline: await decodeFrames(engine.ffmpegPath, baselineRender.permanentPath),
    split: await decodeFrames(engine.ffmpegPath, splitRender.permanentPath),
    trimStart: await decodeFrames(engine.ffmpegPath, trimStartRender.permanentPath),
    trimEnd: await decodeFrames(engine.ffmpegPath, trimEndRender.permanentPath),
  };
  for (const [label, frames] of Object.entries(decoded)) if (frames.length !== totalFrames) throw new Error(`${label} 解码帧数 ${frames.length}，预期 ${totalFrames}。`);

  const equivalence = {
    split: compareRanges("split", decoded.baseline, decoded.split, splitFrames),
    trimStart: compareRanges("trim-start", decoded.baseline, decoded.trimStart, trimStartFrames),
    trimEnd: compareRanges("trim-end", decoded.baseline, decoded.trimEnd, trimEndFrames),
  };

  const splitOtio = await exportEditProjectOtio(root, splitOperation.project.id, splitOperation.project.revision);
  const splitOtioDocument = await readJson<Record<string, any>>(splitOtio.path, {});
  if (splitOtioDocument.metadata?.aicanvas?.keyframeCurveContract !== "aicanvas.cubic-bezier.v2") throw new Error("含派生曲线的 OTIO 未使用 v2 合同。");
  const probes = Object.fromEntries(await Promise.all(Object.entries(rendered).map(async ([label, value]) => [label, JSON.parse((await execFileAsync(engine.ffprobePath!, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration,size", "-of", "json", value.permanentPath])).stdout)])));
  const receipts = await listPublicationReceipts(root);
  const runtime = await readMachineMediaRuntimeSnapshot();
  const lockFiles = await readdir(path.join(getSidecarPaths(root).root, "locks")).catch(() => [] as string[]);
  const sourceFiles = ["src/core/types.ts", "src/core/keyframe-curve.ts", "src/core/editor.ts", "src/core/codex.ts", "src/mcp/server.ts", "src/renderer/src/components/VideoEditorView.vue", "scripts/keyframe-subdivision-render-smoke.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, await sha256(path.join(workspace, relative))])));
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: { kind: "isolated-synthetic", width, height, frameRate, timebase: { rateNumerator, rateDenominator }, totalFrames, splitFrame, trimEndFrame, opacity: .45 },
    contract: { algorithm: "de-casteljau-coordinate-renormalization", semanticAuthority: "sourceWindow+sourceTransform", sourceWindow: "original-easing-and-integer-frame-window", sourceTransform: "original-segment-start-and-end-transform-anchors", frameAuthority: true, curve: { x1: 1, y1: 0, x2: 0, y2: 1 }, derivedControlPointsOutsideUnitRange: true },
    operations: {
      split: { revision: splitOperation.project.revision, clips: splitClips.map((clip) => ({ id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames, staticTransform: { positionX: clip.positionX, positionY: clip.positionY, scale: clip.scale, rotation: clip.rotation }, keyframes: clip.keyframes })) },
      trimStart: { revision: trimStartOperation.project.revision, clip: trimStartOperation.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === trimStartProject.overlay.id) },
      trimEnd: { revision: trimEndOperation.project.revision, clip: trimEndOperation.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === trimEndProject.overlay.id) },
    },
    equivalence: {
      semanticGeometry: { core: coreEquivalence, preEncodeLossless: losslessEquivalence },
      deliveryH264CodecDifference: { note: "不同可见区间会改变 x264 GOP/lookahead 量化；该层只作编码回归诊断，不作为关键帧空间语义容差。", split: equivalence.split, trimStart: equivalence.trimStart, trimEnd: equivalence.trimEnd },
    },
    media: Object.fromEntries(Object.entries(rendered).map(([label, value]) => [label, { path: value.permanentPath, bytes: value.bytes, sha256: value.sha256, magic: "ftyp", probe: probes[label], job: { id: value.render.id, status: value.render.status, publicationReceiptId: value.render.publicationReceiptId } }])),
    otio: { path: splitOtio.path, contract: splitOtioDocument.metadata?.aicanvas?.keyframeCurveContract, portability: splitOtioDocument.metadata?.aicanvas?.curvePortability },
    publication: { receiptCount: receipts.length, receipts: receipts.map((receipt) => ({ id: receipt.id, targetPath: receipt.targetPath, bytes: receipt.check.size, sha256: receipt.check.sha256 })) },
    terminal: { machineActiveWeight: runtime.activeWeight, machineQueueDepth: runtime.queueDepth, projectLockFiles: lockFiles },
    sourceHashes,
  };
  if (receipts.length < 4 || runtime.activeWeight !== 0 || runtime.queueDepth !== 0 || lockFiles.length !== 0) throw new Error(`专项 smoke 终态或 Publication 回执不完整：${JSON.stringify({ receipts: receipts.length, terminal: evidence.terminal })}`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, media: evidence.media, equivalence: { semanticGeometry: evidence.equivalence.semanticGeometry, deliveryH264CodecDifference: { split: equivalence.split.maxima, trimStart: equivalence.trimStart.maxima, trimEnd: equivalence.trimEnd.maxima } }, terminal: evidence.terminal }, null, 2)}\n`);
} finally {
  if (keepFixture) process.stderr.write(`保留调试夹具：${root}\n注册表：${registryPath}\n`);
  else {
    await rm(root, { recursive: true, force: true });
    await rm(registryPath, { force: true });
  }
}
