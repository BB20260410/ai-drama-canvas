import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  exportEditProjectOtio,
  extractTimelineFrame,
  importEditProjectOtio,
  probeVideoEngine,
  renderEditProject,
  startEditRender,
  waitForEditRender,
} from "../src/core/editor.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { scanAndPersist, getProjectIndex } from "../src/core/service.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.resolve(process.argv[2] || path.join(workspace, "docs", "evidence", "effect-transition-render-smoke-20260714.json"));
const evidenceDirectory = path.dirname(evidencePath);
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-effect-transition-smoke-"));
const root = path.join(runtimeRoot, "project");
const registryPath = path.join(runtimeRoot, "registry.json");
const keepFixture = process.env.AI_CANVAS_KEEP_EFFECT_TRANSITION_FIXTURE === "1";
const rateNumerator = 24_000;
const rateDenominator = 1_001;
const frameRate = rateNumerator / rateDenominator;
const width = 320;
const height = 320;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

interface MeanColor { red: number; green: number; blue: number }

function rational(value: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate: frameRate };
}

function range(start: number, duration: number) {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rational(start), duration: rational(duration) };
}

function videoClip(name: string, sourcePath: string, start: number) {
  return {
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(start, 24),
    media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: pathToFileURL(sourcePath).href, available_range: range(0, 72), available_image_bounds: null, metadata: {} },
    effects: [],
    markers: [],
    metadata: {},
  };
}

function audioClip(sourcePath: string) {
  return {
    OTIO_SCHEMA: "Clip.2",
    name: "2x 变速音频",
    source_range: range(0, 48),
    media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: pathToFileURL(sourcePath).href, available_range: range(0, 95), available_image_bounds: null, metadata: {} },
    effects: [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "2x", effect_name: "LinearTimeWarp", time_scalar: 2, enabled: true, metadata: {} }],
    markers: [],
    metadata: {},
  };
}

function otioDocument(firstVideo: string, secondVideo: string, audio: string) {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "OTIO Effect Transition 永久 Smoke",
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "V1",
          kind: "Video",
          source_range: null,
          effects: [],
          markers: [],
          metadata: {},
          children: [
            videoClip("动态红场", firstVideo, 8),
            { OTIO_SCHEMA: "Transition.1", name: "非对称标准溶解", transition_type: "SMPTE_Dissolve", in_offset: rational(5), out_offset: rational(7), enabled: true, metadata: {} },
            videoClip("动态蓝场", secondVideo, 10),
          ],
        },
        { OTIO_SCHEMA: "Track.1", name: "A1", kind: "Audio", source_range: null, effects: [], markers: [], metadata: {}, children: [audioClip(audio)] },
      ],
    },
    metadata: { aicanvas: { fps: frameRate, width, height, backgroundColor: "#000000" } },
  };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function describeFile(filePath: string) {
  return { path: filePath, bytes: (await stat(filePath)).size, sha256: await sha256(filePath) };
}

async function decodeVideoFrames(ffmpegPath: string, filePath: string): Promise<Buffer[]> {
  const frameBytes = width * height * 3;
  const result = await execFileAsync(ffmpegPath, ["-v", "error", "-i", filePath, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: null, maxBuffer: 128 * 1024 * 1024 }) as unknown as { stdout: Buffer };
  if (result.stdout.length % frameBytes !== 0) throw new Error(`rawvideo 字节数不能按单帧 ${frameBytes} 对齐。`);
  return Array.from({ length: result.stdout.length / frameBytes }, (_, index) => result.stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
}

function meanColor(frame: Buffer): MeanColor {
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let offset = 0; offset < frame.length; offset += 3) {
    red += frame[offset] ?? 0;
    green += frame[offset + 1] ?? 0;
    blue += frame[offset + 2] ?? 0;
  }
  const pixels = frame.length / 3;
  return { red: red / pixels, green: green / pixels, blue: blue / pixels };
}

function verifyDissolveFrames(frames: Buffer[], label: string) {
  if (frames.length !== 48) throw new Error(`${label} 应为 48 帧，实际 ${frames.length}。`);
  const sampleFrames = [18, 19, 24, 28, 30, 31];
  const samples = sampleFrames.map((frame) => ({ frame, ...meanColor(frames[frame]!) }));
  const before = samples.find((entry) => entry.frame === 18)!;
  const after = samples.find((entry) => entry.frame === 31)!;
  if (before.red < 170 || before.blue > 65) throw new Error(`${label} 转场前不是红场：${JSON.stringify(before)}`);
  if (after.blue < 170 || after.red > 65) throw new Error(`${label} 转场后不是蓝场：${JSON.stringify(after)}`);
  const transitionSamples = samples.filter((entry) => entry.frame >= 19 && entry.frame <= 30);
  for (let index = 1; index < transitionSamples.length; index += 1) {
    const previous = transitionSamples[index - 1]!;
    const current = transitionSamples[index]!;
    if (current.red > previous.red + 8 || current.blue < previous.blue - 8) throw new Error(`${label} 交叉溶解权重不单调：${JSON.stringify({ previous, current })}`);
  }
  if (!transitionSamples.some((entry) => entry.red > 55 && entry.blue > 55)) throw new Error(`${label} 没有检测到两路同时贡献的混合帧。`);
  return samples;
}

async function analyzeImage(filePath: string): Promise<MeanColor & { width: number; height: number }> {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...meanColor(data), width: info.width, height: info.height };
}

async function probeStreams(ffprobePath: string, filePath: string): Promise<any> {
  const result = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,duration,nb_frames", "-of", "json", filePath], { encoding: "utf8" });
  return JSON.parse(result.stdout);
}

await mkdir(evidenceDirectory, { recursive: true });
await mkdir(root);

try {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath || !engine.ffprobePath) throw new Error(`FFmpeg/FFprobe 不可用：${engine.issues.join("；")}`);
  const firstUnit = path.join(root, "EP01_15s_001_标准转场前项");
  const secondUnit = path.join(root, "EP01_15s_002_标准转场续接");
  await Promise.all([mkdir(firstUnit, { recursive: true }), mkdir(secondUnit, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(firstUnit, "00_信息.md"), "# EP01-001\n\nOTIO SMPTE Dissolve 前项。\n", "utf8"),
    writeFile(path.join(secondUnit, "00_信息.md"), "# EP01-002\n\n时间线续接目标。\n", "utf8"),
  ]);
  const firstVideo = path.join(firstUnit, "EP01_15s_001_v1.mp4");
  const secondVideo = path.join(secondUnit, "EP01_15s_002_v1.mp4");
  const audio = path.join(root, "timewarp-source.wav");
  const sourceRate = `${rateNumerator}/${rateDenominator}`;
  await Promise.all([
    execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=red:s=${width}x${height}:r=${sourceRate}`, "-vf", "drawbox=x=52:y=125:w=60:h=70:color=yellow:t=fill", "-frames:v", "72", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", firstVideo]),
    execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=blue:s=${width}x${height}:r=${sourceRate}`, "-vf", "drawbox=x=208:y=125:w=60:h=70:color=cyan:t=fill", "-frames:v", "72", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", secondVideo]),
    execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=4", "-c:a", "pcm_s16le", "-y", audio]),
  ]);

  const importPreview = await prepareProjectImport({ primaryRoot: root, projectMode: "filesystem", name: "Effect Transition 永久 Smoke" });
  if (!importPreview.canImport) throw new Error(importPreview.issues.map((issue) => issue.message).join("；"));
  await commitProjectImport({ previewId: importPreview.previewId, config: importPreview.config, projectMode: "filesystem" });
  await scanAndPersist(root);
  const index = await getProjectIndex(root);
  const target = index.items.find((item) => item.type === "unit" && item.episode === 1 && item.unit === 2);
  if (!target) throw new Error("扫描索引没有建立 EP01-002 续接目标。");

  const sourceOtio = path.join(root, "effect-transition-source.otio");
  await writeFile(sourceOtio, `${JSON.stringify(otioDocument(firstVideo, secondVideo, audio), null, 2)}\n`, "utf8");
  const imported = await importEditProjectOtio(root, sourceOtio, "标准兼容永久 Smoke");
  const visualClips = imported.tracks.find((track) => track.kind === "visual")!.clips;
  const audioTrackClip = imported.tracks.find((track) => track.kind === "audio")!.clips[0]!;
  if (visualClips[0]?.transition?.inOffsetFrames !== 5 || visualClips[0]?.transition?.outOffsetFrames !== 7 || audioTrackClip.playbackRate !== 2) throw new Error("导入后的标准合同身份不完整。");

  const exported = await exportEditProjectOtio(root, imported.id, imported.revision);
  const reimported = await importEditProjectOtio(root, exported.path, "标准兼容往返 Smoke");
  const reimportedVisual = reimported.tracks.find((track) => track.kind === "visual")!.clips;
  if (reimported.timebase?.rateNumerator !== rateNumerator || reimported.timebase.rateDenominator !== rateDenominator || reimportedVisual[0]?.transition?.inOffsetFrames !== 5 || reimportedVisual[0]?.transition?.outOffsetFrames !== 7) throw new Error("分数时基或 offsets 在 OTIO 往返中漂移。");

  const syncJob = await renderEditProject(root, imported.id, { expectedRevision: imported.revision });
  if (syncJob.status !== "succeeded") throw new Error(syncJob.error || "同步导出失败。");
  const backgroundStarted = await startEditRender(root, imported.id, { expectedRevision: imported.revision });
  const backgroundJob = await waitForEditRender(root, backgroundStarted.id);
  if (backgroundJob.status !== "succeeded") throw new Error(backgroundJob.error || "后台导出失败。");

  const syncEvidenceVideo = path.join(evidenceDirectory, "effect-transition-sync-20260714.mp4");
  const backgroundEvidenceVideo = path.join(evidenceDirectory, "effect-transition-background-20260714.mp4");
  await Promise.all([copyFile(syncJob.outputPath, syncEvidenceVideo), copyFile(backgroundJob.outputPath, backgroundEvidenceVideo)]);
  const syncFrames = await decodeVideoFrames(engine.ffmpegPath, syncEvidenceVideo);
  const backgroundFrames = await decodeVideoFrames(engine.ffmpegPath, backgroundEvidenceVideo);
  const syncSamples = verifyDissolveFrames(syncFrames, "同步成片");
  const backgroundSamples = verifyDissolveFrames(backgroundFrames, "后台成片");

  const streamProbe = await probeStreams(engine.ffprobePath, syncEvidenceVideo);
  const videoStream = streamProbe.streams?.find((stream: any) => stream.codec_type === "video");
  const audioStream = streamProbe.streams?.find((stream: any) => stream.codec_type === "audio");
  if (Number(videoStream?.nb_frames) !== 48) throw new Error(`成片视频帧数不是 48：${JSON.stringify(videoStream)}`);
  const audioDuration = Number(audioStream?.duration);
  if (!(audioDuration > .95 && audioDuration < 1.06)) throw new Error(`2x 音频时长不在 1 秒附近：${audioDuration}`);

  const midpoint = await extractTimelineFrame(root, { editProjectId: imported.id, expectedRevision: imported.revision, timeSeconds: 24 / frameRate });
  const midpointEvidence = path.join(evidenceDirectory, "effect-transition-midpoint-20260714.png");
  await copyFile(midpoint.framePath, midpointEvidence);
  const midpointColor = await analyzeImage(midpointEvidence);
  if (midpointColor.red < 55 || midpointColor.blue < 55) throw new Error(`合成帧没有保留两路转场贡献：${JSON.stringify(midpointColor)}`);

  const editorModule = pathToFileURL(path.join(workspace, "src", "core", "editor.ts")).href;
  const childScript = `import { prepareTimelineVideoContinuation } from ${JSON.stringify(editorModule)}; const result = await prepareTimelineVideoContinuation(${JSON.stringify(root)}, ${JSON.stringify({ editProjectId: imported.id, targetItemId: target.id, expectedRevision: imported.revision, enqueue: false })}); process.stdout.write(JSON.stringify({ extractionId: result.extraction.id, framePath: result.extraction.framePath, packId: result.pack.id, sourceType: result.pack.sourceType, targetFirstFrameArtifactId: result.pack.targetFirstFrameArtifactId, generationJob: result.generationJob ?? null }));`;
  const childResult = await execFileAsync(process.execPath, ["--import", "tsx", "--eval", childScript], { cwd: workspace, env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const restartContinuation = JSON.parse(childResult.stdout.trim());
  if (restartContinuation.sourceType !== "timeline" || !restartContinuation.targetFirstFrameArtifactId || restartContinuation.generationJob !== null) throw new Error(`全新 Node 续接结果无效：${JSON.stringify(restartContinuation)}`);
  const continuationEvidence = path.join(evidenceDirectory, "effect-transition-continuation-20260714.png");
  await copyFile(restartContinuation.framePath, continuationEvidence);
  const continuationColor = await analyzeImage(continuationEvidence);
  if (continuationColor.blue < 150 || continuationColor.red > 90) throw new Error(`续接末帧不是转场后蓝场：${JSON.stringify(continuationColor)}`);

  const output = {
    schemaVersion: 1,
    kind: "aicanvas-effect-transition-render-smoke",
    generatedAt: new Date().toISOString(),
    status: "passed",
    contract: "aicanvas.otio-effect-transition.v1",
    timebase: { rateNumerator, rateDenominator, frameRate },
    standards: { linearTimeWarp: "LinearTimeWarp.1/LinearTimeWarp", transition: "Transition.1/SMPTE_Dissolve", inOffsetFrames: 5, outOffsetFrames: 7 },
    importRoundTrip: { sourceProjectId: imported.id, sourceRevision: imported.revision, reimportedProjectId: reimported.id, timebase: reimported.timebase, effectTransitionContract: "aicanvas.otio-effect-transition.v1" },
    renders: {
      synchronous: { ...(await describeFile(syncEvidenceVideo)), frameCount: syncFrames.length, samples: syncSamples },
      background: { ...(await describeFile(backgroundEvidenceVideo)), frameCount: backgroundFrames.length, samples: backgroundSamples },
      audio: { durationSeconds: audioDuration, playbackRate: audioTrackClip.playbackRate },
    },
    timelineFrame: { ...(await describeFile(midpointEvidence)), timeFrame: 24, color: midpointColor },
    restartContinuation: { ...restartContinuation, framePath: continuationEvidence, frame: await describeFile(continuationEvidence), color: continuationColor, enqueue: false },
    sourceMedia: { firstVideo: await describeFile(firstVideo), secondVideo: await describeFile(secondVideo), audio: await describeFile(audio) },
  };
  await writeFile(evidencePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: output.status, evidencePath, syncFrames: syncFrames.length, backgroundFrames: backgroundFrames.length, audioDuration, restartContinuation: { packId: restartContinuation.packId, generationJob: restartContinuation.generationJob } }, null, 2)}\n`);
} finally {
  if (!keepFixture) await rm(runtimeRoot, { recursive: true, force: true });
}
