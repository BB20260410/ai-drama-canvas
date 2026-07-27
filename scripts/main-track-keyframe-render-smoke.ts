import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyEditOperation,
  createEditProject,
  exportEditProjectOtio,
  extractTimelineFrame,
  probeVideoEngine,
  renderEditProject,
  saveEditProject,
  startEditRender,
  waitForEditRender,
} from "../src/core/editor.js";
import { evaluateEditTransformAtFrame } from "../src/core/keyframe-curve.js";
import { readMachineMediaRuntimeSnapshot } from "../src/core/media-runtime.js";
import { listPublicationReceipts } from "../src/core/publication.js";
import { ensureSidecar, getSidecarPaths, readJson, writeJsonAtomic } from "../src/core/sidecar.js";
import type { EditClip, EditProject, EditRenderJob } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "main-track-keyframe-render-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const rateNumerator = 24_000;
const rateDenominator = 1_001;
const frameRate = rateNumerator / rateDenominator;
const totalFrames = 48;
const animatedFrames = 36;
const mutedTailFrames = totalFrames - animatedFrames;
const splitFrame = 13;
const backgroundHex = "#18314f";
const expectedBackground = { red: 0x18, green: 0x31, blue: 0x4f };
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-main-track-keyframes-"));
const registryPath = path.join(os.tmpdir(), `ai-canvas-main-track-keyframes-registry-${process.pid}-${Date.now()}.json`);
const keepFixture = process.env.AI_CANVAS_KEEP_MAIN_TRACK_FIXTURE === "1";
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
await mkdir(evidenceDirectory, { recursive: true });

interface FrameAnalysis {
  redPixels: number;
  centroid?: { x: number; y: number };
  bbox?: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  redMean?: { red: number; green: number; blue: number };
  cornerMean: { red: number; green: number; blue: number };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function frameSeconds(frame: number): number {
  // 与工程持久化的毫秒精度一致；整数 frame 仍是权威。
  return Math.round(frame / frameRate * 1_000) / 1_000;
}

function analyzeFrame(frame: Buffer, width: number, height: number): FrameAnalysis {
  let redPixels = 0;
  let sumX = 0;
  let sumY = 0;
  let sumRed = 0;
  let sumGreen = 0;
  let sumBlue = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let cornerPixels = 0;
  let cornerRed = 0;
  let cornerGreen = 0;
  let cornerBlue = 0;
  const cornerSize = Math.max(8, Math.floor(Math.min(width, height) * .05));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3;
    const red = frame[offset] ?? 0;
    const green = frame[offset + 1] ?? 0;
    const blue = frame[offset + 2] ?? 0;
    if ((x < cornerSize || x >= width - cornerSize) && (y < cornerSize || y >= height - cornerSize)) {
      cornerPixels += 1;
      cornerRed += red;
      cornerGreen += green;
      cornerBlue += blue;
    }
    if (red < 85 || red < green * 2.2 || red < blue * 1.8) continue;
    redPixels += 1;
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
  return {
    redPixels,
    centroid: redPixels ? { x: sumX / redPixels, y: sumY / redPixels } : undefined,
    bbox: redPixels ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined,
    redMean: redPixels ? { red: sumRed / redPixels, green: sumGreen / redPixels, blue: sumBlue / redPixels } : undefined,
    cornerMean: { red: cornerRed / cornerPixels, green: cornerGreen / cornerPixels, blue: cornerBlue / cornerPixels },
  };
}

async function decodeFrames(ffmpegPath: string, filePath: string, width: number, height: number): Promise<Buffer[]> {
  const frameBytes = width * height * 3;
  const result = await execFileAsync(ffmpegPath, ["-v", "error", "-i", filePath, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: null, maxBuffer: 160 * 1024 * 1024 }) as unknown as { stdout: Buffer };
  if (result.stdout.length % frameBytes !== 0) throw new Error(`原始帧字节数无法按 ${frameBytes} 对齐：${filePath}`);
  return Array.from({ length: result.stdout.length / frameBytes }, (_, index) => result.stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
}

function assertBackground(analysis: FrameAnalysis, label: string): void {
  const error = Math.max(
    Math.abs(analysis.cornerMean.red - expectedBackground.red),
    Math.abs(analysis.cornerMean.green - expectedBackground.green),
    Math.abs(analysis.cornerMean.blue - expectedBackground.blue),
  );
  if (error > 12) throw new Error(`${label} 项目背景色偏差过大：${JSON.stringify({ actual: analysis.cornerMean, expectedBackground, error })}`);
}

function expectedFit(projectWidth: number, projectHeight: number, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const ratio = Math.min(projectWidth / sourceWidth, projectHeight / sourceHeight);
  return { width: sourceWidth * ratio, height: sourceHeight * ratio };
}

function verifyMotion(
  frames: Buffer[],
  project: EditProject,
  clip: EditClip,
  sourceSize: { width: number; height: number },
  sampleFrames: number[],
): Array<Record<string, unknown>> {
  const fit = expectedFit(project.width, project.height, sourceSize.width, sourceSize.height);
  return sampleFrames.map((frame) => {
    const analysis = analyzeFrame(frames[frame]!, project.width, project.height);
    if (!analysis.centroid || !analysis.bbox || !analysis.redMean) throw new Error(`${project.name} F${frame} 没有检测到主画面红色前景。`);
    assertBackground(analysis, `${project.name} F${frame}`);
    const transform = evaluateEditTransformAtFrame(clip, frame, frameRate);
    const expectedCentroid = { x: project.width / 2 + transform.positionX, y: project.height / 2 + transform.positionY };
    const radians = transform.rotation * Math.PI / 180;
    const scaledWidth = fit.width * transform.scale;
    const scaledHeight = fit.height * transform.scale;
    const expectedBbox = {
      width: Math.abs(scaledWidth * Math.cos(radians)) + Math.abs(scaledHeight * Math.sin(radians)),
      height: Math.abs(scaledWidth * Math.sin(radians)) + Math.abs(scaledHeight * Math.cos(radians)),
    };
    const centroidError = Math.hypot(analysis.centroid.x - expectedCentroid.x, analysis.centroid.y - expectedCentroid.y);
    const bboxError = Math.max(Math.abs(analysis.bbox.width - expectedBbox.width), Math.abs(analysis.bbox.height - expectedBbox.height));
    if (centroidError > 3 || bboxError > 10) throw new Error(`${project.name} F${frame} transform 偏差超限：${JSON.stringify({ transform, analysis, expectedCentroid, expectedBbox, centroidError, bboxError })}`);
    if (analysis.redMean.red >= 238 || analysis.redMean.red <= 130) throw new Error(`${project.name} F${frame} opacity 没有落在预期混色范围：${JSON.stringify(analysis.redMean)}`);
    return { frame, transform, actual: analysis, expectedCentroid, expectedBbox, centroidError, bboxError };
  });
}

function compareSplit(baseline: Buffer[], split: Buffer[], width: number, height: number): Record<string, unknown> {
  const comparisons = Array.from({ length: totalFrames }, (_, frame) => {
    const left = analyzeFrame(baseline[frame]!, width, height);
    const right = analyzeFrame(split[frame]!, width, height);
    if (frame >= animatedFrames) return { frame, baselineRedPixels: left.redPixels, splitRedPixels: right.redPixels, centroidError: 0, bboxError: 0 };
    if (!left.centroid || !right.centroid || !left.bbox || !right.bbox) throw new Error(`split 对照 F${frame} 缺少红色前景。`);
    return {
      frame,
      baselineRedPixels: left.redPixels,
      splitRedPixels: right.redPixels,
      centroidError: Math.hypot(left.centroid.x - right.centroid.x, left.centroid.y - right.centroid.y),
      bboxError: Math.max(Math.abs(left.bbox.minX - right.bbox.minX), Math.abs(left.bbox.maxX - right.bbox.maxX), Math.abs(left.bbox.minY - right.bbox.minY), Math.abs(left.bbox.maxY - right.bbox.maxY)),
    };
  });
  const maximumCentroidError = Math.max(...comparisons.map((entry) => entry.centroidError));
  const maximumBboxError = Math.max(...comparisons.map((entry) => entry.bboxError));
  const mutedTailRedPixels = Math.max(...comparisons.filter((entry) => entry.frame >= animatedFrames).map((entry) => Math.max(entry.baselineRedPixels, entry.splitRedPixels)));
  if (maximumCentroidError > .6 || maximumBboxError > 1 || mutedTailRedPixels > 0) throw new Error(`主画面 split 或静音尾段不等价：${JSON.stringify({ maximumCentroidError, maximumBboxError, mutedTailRedPixels })}`);
  return { framesCompared: totalFrames, maximumCentroidError, maximumBboxError, mutedTailRedPixels, boundary: comparisons.filter((entry) => [splitFrame - 1, splitFrame, splitFrame + 1, animatedFrames - 1, animatedFrames].includes(entry.frame)) };
}

async function createProject(
  label: string,
  size: { width: number; height: number },
  sourcePath: string,
  audioPath: string,
  transform: { start: { x: number; y: number; scale: number; rotation: number }; end: { x: number; y: number; scale: number; rotation: number } },
  withMutedTail: boolean,
): Promise<{ project: EditProject; clip: EditClip }> {
  const project = await createEditProject(root, { name: label, width: size.width, height: size.height, fps: frameRate, autoPopulate: false });
  project.backgroundColor = backgroundHex;
  const mainTrack = project.tracks.find((track) => track.kind === "visual")!;
  const durationFrames = withMutedTail ? animatedFrames : totalFrames;
  const clip: EditClip = {
    id: `clip-main-${label}`, trackId: mainTrack.id, kind: "video", name: `${label} 主画面动画`, sourcePath,
    startSeconds: 0, durationSeconds: frameSeconds(durationFrames), trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: .72, muted: false,
    positionX: transform.start.x, positionY: transform.start.y, scale: transform.start.scale, rotation: transform.start.rotation, filter: "none", filterIntensity: 1,
    keyframes: [
      { id: `kf-${label}-start`, frame: 0, timeSeconds: 0, easing: "hold", positionX: transform.start.x, positionY: transform.start.y, scale: transform.start.scale, rotation: transform.start.rotation },
      { id: `kf-${label}-end`, frame: durationFrames, timeSeconds: frameSeconds(durationFrames), easing: "cubic_bezier", bezier: { x1: 1, y1: 0, x2: 0, y2: 1 }, positionX: transform.end.x, positionY: transform.end.y, scale: transform.end.scale, rotation: transform.end.rotation },
    ],
  };
  mainTrack.clips.push(clip);
  if (withMutedTail) mainTrack.clips.push({
    ...structuredClone(clip),
    id: `clip-main-${label}-muted-tail`,
    name: `${label} 静音背景尾段`,
    startSeconds: frameSeconds(animatedFrames),
    durationSeconds: frameSeconds(mutedTailFrames),
    startFrame: animatedFrames,
    durationFrames: mutedTailFrames,
    muted: true,
    opacity: 1,
    positionX: 0,
    positionY: 0,
    scale: 1,
    rotation: 0,
    keyframes: [],
  });
  const audioTrack = project.tracks.find((track) => track.kind === "audio")!;
  audioTrack.clips.push({
    id: `clip-audio-${label}`, trackId: audioTrack.id, kind: "audio", name: `${label} 测试音频`, sourcePath: audioPath,
    startSeconds: 0, durationSeconds: frameSeconds(totalFrames), trimStartSeconds: 0, playbackRate: 1, volume: .5, opacity: 1, muted: false,
    fadeInSeconds: .05, fadeOutSeconds: .05,
  });
  const saved = await saveEditProject(root, project, project.revision);
  return { project: saved, clip: saved.tracks.flatMap((track) => track.clips).find((entry) => entry.id === clip.id)! };
}

async function preserveRender(label: string, job: EditRenderJob): Promise<{ job: EditRenderJob; path: string; bytes: number; sha256: string; commandSha256: string }> {
  if (job.status !== "succeeded") throw new Error(job.error || `${label} 导出失败。`);
  const target = path.join(evidenceDirectory, `main-track-keyframe-${label}-20260714.mp4`);
  await copyFile(job.outputPath, target);
  const bytes = (await stat(target)).size;
  const header = (await readFile(target)).subarray(0, 16).toString("latin1");
  if (bytes <= 1_000 || !header.includes("ftyp")) throw new Error(`${label} 成片为空或缺少 MP4 ftyp 魔数。`);
  const command = await readFile(job.commandPath!, "utf8");
  if (!command.includes("basebg0") || !command.includes("basefg0") || !command.includes("overlay=x=")) throw new Error(`${label} 命令没有进入主画面 transform 组合图。`);
  return { job, path: target, bytes, sha256: await sha256(target), commandSha256: await sha256(job.commandPath!) };
}

try {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath || !engine.ffprobePath) throw new Error(`FFmpeg/ffprobe 不可用：${engine.issues.join("；")}`);
  const config = await ensureSidecar(root);
  config.sourceRoots = [root];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);

  const portraitSource = path.join(root, "landscape-red-source.mp4");
  const landscapeSource = path.join(root, "portrait-red-source.mp4");
  const audioPath = path.join(root, "main-transform-tone.wav");
  const sourceRate = `${rateNumerator}/${rateDenominator}`;
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=red:s=320x180:r=${sourceRate}:d=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", portraitSource]);
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=red:s=180x320:r=${sourceRate}:d=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", landscapeSource]);
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", audioPath]);

  const portraitBaseline = await createProject("portrait-baseline", { width: 320, height: 480 }, portraitSource, audioPath, { start: { x: -45, y: -70, scale: .42, rotation: -16 }, end: { x: 35, y: 60, scale: .65, rotation: 17 } }, true);
  const portraitSplit = await createProject("portrait-split", { width: 320, height: 480 }, portraitSource, audioPath, { start: { x: -45, y: -70, scale: .42, rotation: -16 }, end: { x: 35, y: 60, scale: .65, rotation: 17 } }, true);
  const splitResult = await applyEditOperation(root, portraitSplit.project.id, portraitSplit.project.revision, { type: "split_clip", clipId: portraitSplit.clip.id, timeSeconds: frameSeconds(splitFrame) });
  const splitMain = splitResult.project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0]!;
  const splitAnimatedClips = splitMain.clips.filter((clip) => !clip.muted).sort((left, right) => left.startFrame! - right.startFrame!);
  if (splitAnimatedClips.length !== 2 || splitAnimatedClips[0]!.durationFrames !== splitFrame || splitAnimatedClips[1]!.startFrame !== splitFrame) throw new Error(`主画面 split 帧边界错误：${JSON.stringify(splitAnimatedClips)}`);
  if (!splitAnimatedClips.some((clip) => clip.keyframes?.some((keyframe) => keyframe.bezier?.mode === "derived_monotone"))) throw new Error("主画面 split 没有生成 v2 派生曲线。 ");
  const landscape = await createProject("landscape", { width: 480, height: 320 }, landscapeSource, audioPath, { start: { x: -70, y: 25, scale: .38, rotation: -22 }, end: { x: 70, y: -25, scale: .65, rotation: 23 } }, false);

  const portraitRender = await preserveRender("portrait-baseline", await renderEditProject(root, portraitBaseline.project.id, { expectedRevision: portraitBaseline.project.revision, outputDirectory: root }));
  const splitStarted = await startEditRender(root, splitResult.project.id, { expectedRevision: splitResult.project.revision, outputDirectory: root });
  if (splitStarted.status !== "running" || !splitStarted.pid) throw new Error("主画面 split 后台导出没有进入 running。 ");
  const splitRender = await preserveRender("portrait-split", await waitForEditRender(root, splitStarted.id));
  const landscapeRender = await preserveRender("landscape", await renderEditProject(root, landscape.project.id, { expectedRevision: landscape.project.revision, outputDirectory: root }));

  const portraitFrames = await decodeFrames(engine.ffmpegPath, portraitRender.path, 320, 480);
  const splitFrames = await decodeFrames(engine.ffmpegPath, splitRender.path, 320, 480);
  const landscapeFrames = await decodeFrames(engine.ffmpegPath, landscapeRender.path, 480, 320);
  for (const [label, frames] of Object.entries({ portraitFrames, splitFrames, landscapeFrames })) if (frames.length !== totalFrames) throw new Error(`${label} 解码帧数 ${frames.length}，预期 ${totalFrames}。`);
  const portraitMotion = verifyMotion(portraitFrames, portraitBaseline.project, portraitBaseline.clip, { width: 320, height: 180 }, [0, 9, 18, 27, 35]);
  const landscapeMotion = verifyMotion(landscapeFrames, landscape.project, landscape.clip, { width: 180, height: 320 }, [0, 12, 24, 36, 47]);
  const splitEquivalence = compareSplit(portraitFrames, splitFrames, 320, 480);
  for (let frame = animatedFrames; frame < totalFrames; frame += 1) assertBackground(analyzeFrame(portraitFrames[frame]!, 320, 480), `静音尾段 F${frame}`);

  const extracted = await extractTimelineFrame(root, { editProjectId: portraitBaseline.project.id, expectedRevision: portraitBaseline.project.revision, timeSeconds: frameSeconds(24) });
  if (extracted.width !== 320 || extracted.height !== 480 || !extracted.sourceClipIds.includes(portraitBaseline.clip.id)) throw new Error(`合成帧 provenance/尺寸错误：${JSON.stringify(extracted)}`);
  const extractedPermanent = path.join(evidenceDirectory, "main-track-keyframe-composite-F24-20260714.png");
  await copyFile(extracted.framePath, extractedPermanent);
  const extractedFrame = (await decodeFrames(engine.ffmpegPath, extractedPermanent, 320, 480))[0]!;
  const extractedAnalysis = analyzeFrame(extractedFrame, 320, 480);
  const renderedAnalysis = analyzeFrame(portraitFrames[24]!, 320, 480);
  if (!extractedAnalysis.centroid || !renderedAnalysis.centroid || !extractedAnalysis.bbox || !renderedAnalysis.bbox) throw new Error("F24 合成帧或成片帧缺少红色主画面。 ");
  const extractionComparison = {
    centroidError: Math.hypot(extractedAnalysis.centroid.x - renderedAnalysis.centroid.x, extractedAnalysis.centroid.y - renderedAnalysis.centroid.y),
    bboxError: Math.max(Math.abs(extractedAnalysis.bbox.minX - renderedAnalysis.bbox.minX), Math.abs(extractedAnalysis.bbox.maxX - renderedAnalysis.bbox.maxX), Math.abs(extractedAnalysis.bbox.minY - renderedAnalysis.bbox.minY), Math.abs(extractedAnalysis.bbox.maxY - renderedAnalysis.bbox.maxY)),
  };
  if (extractionComparison.centroidError > 1 || extractionComparison.bboxError > 2) throw new Error(`合成帧与成片 F24 不一致：${JSON.stringify(extractionComparison)}`);

  const unitOtio = await exportEditProjectOtio(root, portraitBaseline.project.id, portraitBaseline.project.revision, path.join(root, "main-track-unit.otio"));
  const splitOtio = await exportEditProjectOtio(root, splitResult.project.id, splitResult.project.revision, path.join(root, "main-track-split.otio"));
  const unitDocument = await readJson<Record<string, any>>(unitOtio.path, {});
  const splitDocument = await readJson<Record<string, any>>(splitOtio.path, {});
  if (unitDocument.metadata?.aicanvas?.keyframeCurveContract !== "aicanvas.cubic-bezier.v1" || splitDocument.metadata?.aicanvas?.keyframeCurveContract !== "aicanvas.cubic-bezier.v2") throw new Error("主画面 OTIO v1/v2 合同错误。 ");
  const permanentOtio = path.join(evidenceDirectory, "main-track-keyframe-split-20260714.otio");
  await copyFile(splitOtio.path, permanentOtio);

  const hidden = await createProject("hidden-main", { width: 320, height: 480 }, portraitSource, audioPath, { start: { x: 0, y: 0, scale: .5, rotation: 0 }, end: { x: 0, y: 0, scale: .5, rotation: 0 } }, false);
  const hiddenMainTrack = hidden.project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0]!;
  hiddenMainTrack.hidden = true;
  const visibleOverlayTrackId = "track-visible-overlay-hidden-main";
  hidden.project.tracks.splice(1, 0, {
    id: visibleOverlayTrackId,
    kind: "visual",
    name: "隐藏主轨时仍可见的画中画",
    order: 1,
    locked: false,
    muted: false,
    hidden: false,
    clips: [{
      ...structuredClone(hidden.clip),
      id: "clip-visible-overlay-hidden-main",
      trackId: visibleOverlayTrackId,
      name: "不得被提升为主画面的可见画中画",
      positionX: 0,
      positionY: 0,
      scale: .3,
      rotation: 0,
      opacity: 1,
      keyframes: [],
    }],
  });
  const hiddenSaved = await saveEditProject(root, hidden.project, hidden.project.revision);
  const visibleOverlayPresent = hiddenSaved.tracks.some((track) => track.id === visibleOverlayTrackId && track.kind === "visual" && !track.hidden && !track.muted && track.clips.some((clip) => !clip.muted));
  if (!visibleOverlayPresent) throw new Error("隐藏主轨失败关闭夹具没有保留可见画中画。 ");
  let hiddenMainError = "";
  try { await renderEditProject(root, hiddenSaved.id, { expectedRevision: hiddenSaved.revision, outputDirectory: root }); }
  catch (error) { hiddenMainError = error instanceof Error ? error.message : String(error); }
  if (!/总时长为 0|主画面轨道已隐藏/.test(hiddenMainError)) throw new Error(`隐藏主画面没有失败关闭：${hiddenMainError}`);

  const rendered = { portraitBaseline: portraitRender, portraitSplit: splitRender, landscape: landscapeRender };
  const probes = Object.fromEntries(await Promise.all(Object.entries(rendered).map(async ([label, value]) => [label, JSON.parse((await execFileAsync(engine.ffprobePath!, ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames:format=duration,size", "-of", "json", value.path])).stdout)])));
  for (const [label, probe] of Object.entries(probes) as Array<[string, any]>) {
    const types = probe.streams?.map((stream: { codec_type?: string }) => stream.codec_type).sort();
    if (JSON.stringify(types) !== JSON.stringify(["audio", "video"]) || Number(probe.format?.duration) < 1.99 || Number(probe.format?.duration) > 2.02) throw new Error(`${label} 音视频流或时长异常：${JSON.stringify(probe)}`);
  }
  const receipts = (await listPublicationReceipts(root)).filter((receipt) => receipt.context.purpose === "edit-render");
  const runtime = await readMachineMediaRuntimeSnapshot();
  const lockFiles = await readdir(path.join(getSidecarPaths(root).root, "locks")).catch(() => [] as string[]);
  const sourceFiles = ["src/core/editor.ts", "src/core/codex.ts", "src/core/keyframe-curve.ts", "src/renderer/src/components/VideoEditorView.vue", "tests/editor.test.ts", "tests/codex.test.ts", "tests/mcp-scan-cancel.test.ts", "scripts/main-track-keyframe-render-smoke.ts", "package.json"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, await sha256(path.join(workspace, relative))])));
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: { kind: "isolated-synthetic-h264", frameRate, timebase: { rateNumerator, rateDenominator }, totalFrames, animatedFrames, mutedTailFrames, splitFrame, backgroundHex, opacity: .72, portrait: { project: [320, 480], source: [320, 180] }, landscape: { project: [480, 320], source: [180, 320] } },
    contract: { mainTrack: "lowest-order-visual-track", coordinates: "project-pixels-relative-to-center-positive-right-down", transformOrder: "aspect-fit-then-scale-opacity-rotate-position-on-fixed-project-background", hiddenOrMutedMainTrack: "fail-closed-no-overlay-promotion", mutedMainClip: "project-background-preserving-duration", frameAuthority: "project-integer-frame", state: "EditKeyframe[]" },
    motion: { portrait: portraitMotion, landscape: landscapeMotion },
    split: { revision: splitResult.project.revision, clips: splitMain.clips.map((clip) => ({ id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames, muted: clip.muted, keyframes: clip.keyframes })), equivalence: splitEquivalence },
    extraction: { path: extractedPermanent, bytes: (await stat(extractedPermanent)).size, sha256: await sha256(extractedPermanent), frame: 24, timeSeconds: extracted.timeSeconds, sourceClipIds: extracted.sourceClipIds, comparisonToRenderedF24: extractionComparison },
    otio: { unitContract: unitDocument.metadata?.aicanvas?.keyframeCurveContract, splitContract: splitDocument.metadata?.aicanvas?.keyframeCurveContract, splitPath: permanentOtio, splitBytes: (await stat(permanentOtio)).size, splitSha256: await sha256(permanentOtio) },
    media: Object.fromEntries(Object.entries(rendered).map(([label, value]) => [label, { path: value.path, bytes: value.bytes, sha256: value.sha256, commandSha256: value.commandSha256, job: { id: value.job.id, status: value.job.status, publicationReceiptId: value.job.publicationReceiptId, background: label === "portraitSplit" }, probe: probes[label] }])),
    failureClosure: { hiddenMainError, visibleOverlayPresent, visibleOverlayTrackId },
    publication: { receiptCount: receipts.length, receipts: receipts.map((receipt) => ({ id: receipt.id, targetPath: receipt.targetPath, bytes: receipt.check.size, sha256: receipt.check.sha256 })) },
    terminal: { machineActiveWeight: runtime.activeWeight, machineQueueDepth: runtime.queueDepth, projectLockFiles: lockFiles },
    sourceHashes,
  };
  if (receipts.length !== 3 || runtime.activeWeight !== 0 || runtime.queueDepth !== 0 || lockFiles.length !== 0) throw new Error(`专项 smoke 终态不完整：${JSON.stringify({ receipts: receipts.length, terminal: evidence.terminal })}`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, media: evidence.media, split: splitEquivalence, extraction: evidence.extraction, failureClosure: evidence.failureClosure, terminal: evidence.terminal }, null, 2)}\n`);
} finally {
  if (keepFixture) process.stderr.write(`保留调试夹具：${root}\n注册表：${registryPath}\n`);
  else {
    await rm(root, { recursive: true, force: true });
    await rm(registryPath, { force: true });
  }
}
