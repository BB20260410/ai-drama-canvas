import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { createEditProject, exportEditProjectOtio, importEditProjectOtio, probeVideoEngine, renderEditProject, saveEditProject } from "../src/core/editor.js";
import { evaluateEditTransformAt } from "../src/core/keyframe-curve.js";
import { readMachineMediaRuntimeSnapshot } from "../src/core/media-runtime.js";
import { listPublicationReceipts } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, readJson, writeJsonAtomic } from "../src/core/sidecar.js";
import type { EditClip } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "keyframe-bezier-render-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
await mkdir(evidenceDirectory, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-bezier-render-"));
const registryPath = path.join(os.tmpdir(), `ai-canvas-bezier-render-registry-${process.pid}-${Date.now()}.json`);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function analyzeRedOverlay(filePath: string) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    const offset = (y * info.width + x) * info.channels;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    if (red < 170 || green > 90 || blue > 90 || red < green * 1.8 || red < blue * 1.8) continue;
    count += 1;
    sumX += x;
    sumY += y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!count) throw new Error(`采样帧没有检测到高饱和红色覆盖层：${filePath}`);
  return { pixels: count, centroid: { x: sumX / count, y: sumY / count }, bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

try {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath || !engine.ffprobePath) throw new Error(`FFmpeg/ffprobe 不可用：${engine.issues.join("；")}`);
  const config = await ensureSidecar(root);
  config.sourceRoots = [root];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const basePath = path.join(root, "bezier-base-black.mp4");
  const overlayPath = path.join(root, "bezier-overlay-red.mp4");
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", basePath]);
  await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", overlayPath]);
  await scanAndPersist(root);

  const project = await createEditProject(root, { name: "cubic-bezier 真实渲染验收", width: 320, height: 320, fps: 24, autoPopulate: false });
  const mainTrack = project.tracks.find((track) => track.kind === "visual")!;
  mainTrack.clips.push({ id: "clip-bezier-base", trackId: mainTrack.id, kind: "video", name: "黑底", sourcePath: basePath, startSeconds: 0, durationSeconds: 2, trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: 1, muted: false, positionX: 0, positionY: 0, scale: 1, rotation: 0, filter: "none", filterIntensity: 1, keyframes: [] });
  const overlayTrackId = "track-bezier-real-overlay";
  const overlayClip: EditClip = {
    id: "clip-bezier-real-overlay",
    trackId: overlayTrackId,
    kind: "video",
    name: "红色曲线采样块",
    sourcePath: overlayPath,
    startSeconds: 0,
    durationSeconds: 2,
    trimStartSeconds: 0,
    playbackRate: 1,
    volume: 0,
    opacity: 1,
    muted: false,
    positionX: -100,
    positionY: 0,
    scale: .1,
    rotation: 0,
    filter: "none",
    filterIntensity: 1,
    keyframes: [
      { id: "kf-bezier-real-start", timeSeconds: 0, easing: "hold", positionX: -100, positionY: 0, scale: .1, rotation: 0 },
      { id: "kf-bezier-real-end", timeSeconds: 2, easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 100, positionY: 0, scale: .1, rotation: 0 },
    ],
  };
  project.tracks.splice(1, 0, { id: overlayTrackId, kind: "visual", name: "曲线覆盖层", order: 1, locked: false, muted: false, hidden: false, clips: [overlayClip] });
  project.tracks.forEach((track, order) => track.order = order);
  const saved = await saveEditProject(root, project, project.revision);
  const savedOverlay = saved.tracks.flatMap((track) => track.clips).find((clip) => clip.id === overlayClip.id)!;

  const otio = await exportEditProjectOtio(root, saved.id, saved.revision);
  const otioDocument = await readJson<Record<string, any>>(otio.path, {});
  const imported = await importEditProjectOtio(root, otio.path, "曲线 OTIO 回读");
  const importedCurve = imported.tracks.flatMap((track) => track.clips).find((clip) => clip.name === overlayClip.name)?.keyframes?.at(-1);
  if (JSON.stringify(importedCurve?.bezier) !== JSON.stringify({ x1: .25, y1: .1, x2: .25, y2: 1 })) throw new Error("OTIO 回读没有保留自定义曲线控制点。");

  const render = await renderEditProject(root, saved.id, { expectedRevision: saved.revision, outputDirectory: root });
  if (render.status !== "succeeded") throw new Error(render.error || "真实曲线成片导出失败。");
  const permanentVideo = path.join(evidenceDirectory, "keyframe-bezier-render-20260714.mp4");
  await copyFile(render.outputPath, permanentVideo);
  const probe = JSON.parse((await execFileAsync(engine.ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration,size", "-of", "json", permanentVideo])).stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const videoHeader = (await readFile(permanentVideo)).subarray(0, 16).toString("latin1");
  if (!videoHeader.includes("ftyp")) throw new Error("真实曲线成片缺少 MP4 ftyp 魔数。");

  const sampleTimes = [.5, 1, 1.5];
  const samples = [];
  for (const timeSeconds of sampleTimes) {
    const frame = Math.round(timeSeconds * 24);
    const samplePath = path.join(evidenceDirectory, `keyframe-bezier-sample-f${String(frame).padStart(3, "0")}-20260714.png`);
    await execFileAsync(engine.ffmpegPath, ["-v", "error", "-i", permanentVideo, "-vf", `select=eq(n\\,${frame})`, "-fps_mode", "vfr", "-frames:v", "1", "-y", samplePath]);
    const measured = await analyzeRedOverlay(samplePath);
    const expectedTransform = evaluateEditTransformAt(savedOverlay, timeSeconds);
    const expectedCentroidX = 159.5 + expectedTransform.positionX;
    const linearCentroidX = 159.5 + (-100 + 200 * (timeSeconds / 2));
    const errorPixels = Math.abs(measured.centroid.x - expectedCentroidX);
    const distanceFromLinearPixels = Math.abs(measured.centroid.x - linearCentroidX);
    if (errorPixels > 3) throw new Error(`F${frame} 红块位置与共享求值器偏差 ${errorPixels.toFixed(3)}px。`);
    if (distanceFromLinearPixels < 12) throw new Error(`F${frame} 没有证明自定义曲线区别于线性插值。`);
    samples.push({ frame, timeSeconds, expectedTransform, expectedCentroidX, linearCentroidX, measured, errorPixels, distanceFromLinearPixels, file: { path: samplePath, bytes: (await stat(samplePath)).size, sha256: await sha256(samplePath) } });
  }

  const runtime = await readMachineMediaRuntimeSnapshot();
  const lockFiles = await readdir(path.join(getSidecarPaths(root).root, "locks")).catch(() => [] as string[]);
  const receipts = await listPublicationReceipts(root);
  const sourceFiles = ["src/core/keyframe-curve.ts", "src/core/editor.ts", "src/core/types.ts", "src/mcp/server.ts", "src/renderer/src/components/VideoEditorView.vue"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => [relative, await sha256(path.join(workspace, relative))])));
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: { kind: "isolated-synthetic", root, width: 320, height: 320, fps: 24, durationSeconds: 2, background: "black", overlay: "high-saturation-red" },
    curve: { ownership: "destination-keyframe-controls-entering-segment", easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, samples },
    render: { path: permanentVideo, bytes: (await stat(permanentVideo)).size, sha256: await sha256(permanentVideo), magic: "ftyp", probe, job: { id: render.id, status: render.status, revision: saved.revision, publicationReceiptId: render.publicationReceiptId } },
    persistence: { savedRevision: saved.revision, otio: { path: otio.path, contract: otioDocument.metadata?.aicanvas?.keyframeCurveContract, portability: otioDocument.metadata?.aicanvas?.curvePortability, importedCurve } },
    publication: { receipts: receipts.map((receipt) => ({ id: receipt.id, sha256: receipt.check.sha256, bytes: receipt.check.size, targetPath: receipt.targetPath })) },
    terminal: { machineActiveWeight: runtime.activeWeight, machineQueueDepth: runtime.queueDepth, projectLockFiles: lockFiles },
    sourceHashes,
  };
  if (runtime.activeWeight !== 0 || runtime.queueDepth !== 0 || lockFiles.length !== 0) throw new Error(`真实曲线 smoke 结束后运行态未归零：${JSON.stringify(evidence.terminal)}`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, render: evidence.render, samples: samples.map((sample) => ({ frame: sample.frame, expectedCentroidX: sample.expectedCentroidX, actualCentroidX: sample.measured.centroid.x, errorPixels: sample.errorPixels, distanceFromLinearPixels: sample.distanceFromLinearPixels })), terminal: evidence.terminal }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(registryPath, { force: true });
}
