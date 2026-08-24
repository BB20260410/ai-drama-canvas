import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  applyEditOperation,
  createEditProject,
  exportEditProjectOtio,
  extractTimelineFrame,
  importEditProjectOtio,
  listEditMedia,
  probeVideoEngine,
  renderEditProject,
  saveEditProject,
  startEditRender,
  waitForEditRender,
} from "../src/core/editor.js";
import { inspectFormalDramaSource, materializeFormalDramaProject, type FormalDramaEpisode, type FormalDramaShot } from "../src/core/formal-drama.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { getPublicationReceipt } from "../src/core/publication.js";
import { getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { toJsLiteral } from "../src/core/js-code-literal.js";
import type { EditClip } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(process.argv[2] || "");
const calibrationRoot = path.resolve(process.argv[3] || "");
const evidencePath = path.resolve(process.argv[4] || path.join(workspace, "docs", "evidence", "formal-project-nle-core.json"));
if (!process.argv[2] || !process.argv[3]) throw new Error("用法：tsx scripts/formal-project-nle-calibration.ts <只读正式源> <全新隔离根> [evidence.json]");
const allowedParent = path.join(workspace, "formal-calibration");
const relativeTarget = path.relative(allowedParent, calibrationRoot);
if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget) || relativeTarget === "") throw new Error(`隔离根必须是 ${allowedParent} 下的全新子目录。`);
if (await access(calibrationRoot).then(() => true).catch(() => false)) throw new Error(`隔离根已存在，拒绝覆盖：${calibrationRoot}`);
await mkdir(allowedParent, { recursive: true });
await mkdir(path.dirname(evidencePath), { recursive: true });

const registryPath = path.join(calibrationRoot, ".runtime", "registry.json");
process.env.AI_CANVAS_PROJECT_ROOT = calibrationRoot;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
const projectRateNumerator = 24_000;
const projectRateDenominator = 1_001;
const projectRate = projectRateNumerator / projectRateDenominator;
const width = 360;
const height = 640;

function secondsForFrame(frame: number): number {
  return Number((frame * projectRateDenominator / projectRateNumerator).toFixed(9));
}

function framesForSeconds(seconds: number): number {
  return Math.max(1, Math.round(seconds * projectRate));
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileEvidence(filePath: string) {
  const buffer = await readFile(filePath);
  return { path: filePath, bytes: buffer.byteLength, sha256: sha256(buffer) };
}

async function sourceMetadataSnapshot(inspection: Awaited<ReturnType<typeof inspectFormalDramaSource>>) {
  return Promise.all(inspection.inventory.files.map(async (entry) => {
    const filePath = path.join(inspection.sourceRoot, ...entry.relativePath.split("/"));
    const metadata = await stat(filePath, { bigint: true });
    return {
      relativePath: entry.relativePath,
      bytes: entry.bytes,
      sha256: entry.sha256,
      inode: metadata.ino.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
    };
  }));
}

function baseClip(input: {
  id: string;
  trackId: string;
  kind: "video" | "audio" | "subtitle" | "image";
  name: string;
  startFrame: number;
  durationFrames: number;
  sourcePath?: string;
  trimStartFrame?: number;
  playbackRate?: number;
  itemId?: string;
  artifactId?: string;
  note?: string;
  timelineRate?: number;
}): EditClip {
  const trimStartFrame = input.trimStartFrame ?? 0;
  const timelineRate = input.timelineRate ?? projectRate;
  const clipSeconds = (frame: number) => Number((frame / timelineRate).toFixed(9));
  const clipFrames = (seconds: number) => Math.max(1, Math.round(seconds * timelineRate));
  return {
    id: input.id,
    trackId: input.trackId,
    kind: input.kind,
    name: input.name,
    sourcePath: input.sourcePath,
    itemId: input.itemId,
    artifactId: input.artifactId,
    ...(input.kind === "video" || input.kind === "audio" ? { sourceAvailableRange: { startFrame: 0, durationFrames: clipFrames(input.kind === "audio" ? 457 : 24) } } : {}),
    startFrame: input.startFrame,
    durationFrames: input.durationFrames,
    trimStartFrame,
    startSeconds: clipSeconds(input.startFrame),
    durationSeconds: clipSeconds(input.durationFrames),
    trimStartSeconds: clipSeconds(trimStartFrame),
    playbackRate: input.playbackRate ?? 1,
    volume: input.kind === "audio" ? .18 : 0,
    opacity: 1,
    muted: false,
    positionX: 0,
    positionY: 0,
    scale: 1,
    rotation: 0,
    filter: "none",
    filterIntensity: 1,
    keyframes: [],
    ...(input.kind === "video" || input.kind === "image" ? { transitionOut: "cut" as const, transitionDurationSeconds: .5 } : {}),
    note: input.note,
  };
}

function rational(value: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate: projectRate };
}

function range(start: number, duration: number) {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rational(start), duration: rational(duration) };
}

function externalClip(name: string, sourcePath: string, start: number, duration: number, effects: unknown[] = []) {
  return {
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(start, duration),
    media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: pathToFileURL(sourcePath).href, available_range: range(0, framesForSeconds(24)), available_image_bounds: null, metadata: {} },
    effects,
    markers: [],
    metadata: {},
  };
}

function proofOtio(videos: string[], audioPath: string) {
  const timeWarp = { OTIO_SCHEMA: "LinearTimeWarp.1", name: "EP22 高帧慢镜 2x source", effect_name: "LinearTimeWarp", time_scalar: 2, enabled: true, metadata: {} };
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "封神篇正式剧本派生 Effect Transition Proof",
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
          name: "V1 正式参考板派生",
          kind: "Video",
          source_range: null,
          effects: [],
          markers: [],
          metadata: {},
          children: [
            externalClip("EP22 镜01 出项", videos[0]!, 24, 144),
            { OTIO_SCHEMA: "Transition.1", name: "EP22 节奏叠化", transition_type: "SMPTE_Dissolve", in_offset: rational(12), out_offset: rational(12), enabled: true, metadata: {} },
            externalClip("EP22 镜02 入项", videos[1]!, 24, 144),
            externalClip("EP22 高帧速度效果", videos[3]!, 0, 192, [timeWarp]),
          ],
        },
        {
          OTIO_SCHEMA: "Track.1",
          name: "A1 剧本音效占位",
          kind: "Audio",
          source_range: null,
          effects: [],
          markers: [],
          metadata: {},
          children: [externalClip("EP22 剧本音效语义轨", audioPath, 0, 384)],
        },
      ],
    },
    metadata: { aicanvas: { fps: projectRate, width, height, backgroundColor: "#080b12", sourceNativeMedia: false, formalSourceEpisode: 22 } },
  };
}

async function createDerivedVideo(ffmpegPath: string, imagePath: string, frameRate: number, outputPath: string): Promise<void> {
  await execFileAsync(ffmpegPath, [
    "-v", "error", "-loop", "1", "-i", imagePath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${frameRate}`,
    "-t", "24", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-y", outputPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
}

async function createLabeledImage(sourcePath: string, outputPath: string, label: string): Promise<void> {
  const escapedLabel = label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const svg = Buffer.from(`<svg width="1920" height="1080"><rect x="0" y="0" width="1920" height="104" fill="#111827dd"/><text x="44" y="70" font-size="48" fill="#f6d365" font-family="Hiragino Sans GB, sans-serif">${escapedLabel}</text><rect x="10" y="10" width="1900" height="1060" fill="none" stroke="#f6d365" stroke-width="10"/></svg>`);
  await sharp(sourcePath).composite([{ input: svg, top: 0, left: 0 }]).png().toFile(outputPath);
}

async function probeMedia(ffprobePath: string, filePath: string) {
  const result = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,duration,nb_frames:format=duration,size", "-of", "json", filePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

const sourceBefore = await inspectFormalDramaSource(sourceRoot);
const sourceMetadataBefore = await sourceMetadataSnapshot(sourceBefore);
if (sourceBefore.episodes.length !== 23 || sourceBefore.episodes.reduce((sum, episode) => sum + episode.shots.length, 0) !== 968) throw new Error("正式源不是已核验的 23 集 / 968 镜封神篇。 ");
const materialized = await materializeFormalDramaProject({ sourceRoot, targetRoot: calibrationRoot, episodes: [19, 21, 22] });
await mkdir(path.dirname(registryPath), { recursive: true });
const episode22 = materialized.episodes.find((episode) => episode.episodeNumber === 22);
const episode21 = materialized.episodes.find((episode) => episode.episodeNumber === 21);
if (!episode22 || episode22.shots.length !== 53 || episode22.totalDurationSeconds !== 456 || !episode21) throw new Error("EP22/EP21 正式剧本规范化结果不符合权威统计。 ");

const engine = await probeVideoEngine();
if (!engine.available || !engine.ffmpegPath || !engine.ffprobePath) throw new Error(`FFmpeg/FFprobe 不可用：${engine.issues.join("；")}`);
const mediaRoot = path.join(calibrationRoot, ".calibration_media");
await mkdir(mediaRoot, { recursive: true });
const referenceEntries = materialized.manifest.snapshotFiles.filter((entry) => entry.kind === "reference-png").sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
if (referenceEntries.length !== 4) throw new Error(`正式快照参考 PNG 不是 4 张：${referenceEntries.length}`);
const referencePaths = referenceEntries.map((entry) => path.join(calibrationRoot, ...entry.snapshotRelativePath.split("/")));
const semanticRates = [24, 48, 96, 120];
const derivedVideos = semanticRates.map((rate) => path.join(mediaRoot, `formal-reference-derived-${rate}fps.mp4`));
await Promise.all(derivedVideos.map((outputPath, index) => createDerivedVideo(engine.ffmpegPath!, referencePaths[index]!, semanticRates[index]!, outputPath)));
const audioPath = path.join(mediaRoot, "EP22_script-audio-cue-bed.m4a");
await execFileAsync(engine.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=233:sample_rate=48000:duration=457", "-af", "volume=0.08", "-c:a", "aac", "-b:a", "96k", "-y", audioPath], { maxBuffer: 4 * 1024 * 1024 });

const episode22Units = materialized.manifest.units.filter((unit) => unit.episodeNumber === 22).sort((left, right) => left.sequence - right.sequence);
for (let index = 0; index < 4; index += 1) {
  const unit = episode22Units[index]!;
  const stem = `EP22_15s_${String(index + 1).padStart(3, "0")}`;
  const rawPath = path.join(unit.directory, `${stem}_首帧_raw.png`);
  const labeledPath = path.join(unit.directory, `${stem}_首帧_labeled.png`);
  const videoPath = path.join(unit.directory, `${stem}_v1.mp4`);
  await Promise.all([
    copyFile(referencePaths[index]!, rawPath),
    createLabeledImage(referencePaths[index]!, labeledPath, `封神篇 EP22 镜${episode22.shots[index]!.sourceCode} · 校准派生`),
    copyFile(derivedVideos[index]!, videoPath),
  ]);
  const originalInfo = await readFile(unit.infoPath, "utf8");
  await writeFile(unit.infoPath, `${originalInfo.replace("- 衍生媒体已生成：false", "- 衍生媒体已生成：true")}\n## 校准派生媒体\n\n- raw：${rawPath}\n- labeled：${labeledPath}\n- video：${videoPath}\n- 说明：以上媒体仅在授权隔离副本中由正式参考板派生，不是源目录原生媒体。\n`, "utf8");
  unit.derivedMediaGenerated = true;
}
materialized.manifest.derivedMedia = {
  rawImagesGenerated: true,
  labeledImagesGenerated: true,
  videosGenerated: true,
  audioGenerated: true,
};
await writeFile(materialized.manifest.target.manifestPath, `${JSON.stringify(materialized.manifest, null, 2)}\n`, "utf8");

const preview = await prepareProjectImport({ primaryRoot: calibrationRoot, projectMode: "filesystem", name: "封神篇正式剧本派生 NLE 校准" });
if (!preview.canImport) throw new Error(`正式隔离根导入预检失败：${preview.issues.map((issue) => issue.message).join("；")}`);
await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "filesystem" });
const firstIndex = await scanAndPersist(calibrationRoot);
const secondIndex = await scanAndPersist(calibrationRoot);
const canonicalIndex = (index: typeof firstIndex) => JSON.stringify({
  items: index.items.map((item) => ({ id: item.id, type: item.type, episode: item.episode, unit: item.unit, status: item.status, title: item.title })).sort((left, right) => left.id.localeCompare(right.id)),
  artifacts: index.artifacts.map((artifact) => ({ id: artifact.id, itemId: artifact.itemId, kind: artifact.kind, path: artifact.path, bytes: artifact.check.size, sha256: artifact.check.sha256 })).sort((left, right) => left.id.localeCompare(right.id)),
});
if (canonicalIndex(firstIndex) !== canonicalIndex(secondIndex)) throw new Error("同内容重复扫描产生业务身份漂移。 ");
const projectIndex = await getProjectIndex(calibrationRoot);
const ep22IndexedUnits = projectIndex.items.filter((item) => item.type === "unit" && item.episode === 22).sort((left, right) => (left.unit ?? 0) - (right.unit ?? 0));
if (ep22IndexedUnits.length !== 53) throw new Error(`扫描后 EP22 不是 53 个正式单元：${ep22IndexedUnits.length}`);
const editMedia = await listEditMedia(calibrationRoot, 22);
const mediaByPath = new Map(editMedia.map((entry) => [path.resolve(entry.path), entry]));

const childInitial = await createEditProject(calibrationRoot, { name: "EP21 镜08 三段嵌套叠化子时间线", episode: 21, width, height, fps: 24, autoPopulate: false });
const childVisual = childInitial.tracks.find((track) => track.kind === "visual")!;
const childAudio = childInitial.tracks.find((track) => track.kind === "audio")!;
const childSubtitle = childInitial.tracks.find((track) => track.kind === "subtitle")!;
childVisual.clips = [0, 1, 2].map((index) => ({
  ...baseClip({ id: `clip-formal-child-${index + 1}`, trackId: childVisual.id, kind: "video", name: `EP21 镜08 子段 ${index + 1}`, startFrame: index * 72, durationFrames: 72, sourcePath: derivedVideos[index]!, trimStartFrame: 24, playbackRate: 1, timelineRate: 24, note: "源自 EP21 镜08 三段各约 3 秒叠化语义；媒体为正式参考板隔离派生。" }),
  sourceAvailableRange: { startFrame: 0, durationFrames: 576 },
}));
childAudio.clips = [{ ...baseClip({ id: "clip-formal-child-audio", trackId: childAudio.id, kind: "audio", name: "EP21 镜08 合成音效占位", startFrame: 0, durationFrames: 216, sourcePath: audioPath, timelineRate: 24 }), sourceAvailableRange: { startFrame: 0, durationFrames: 10_968 } }];
childSubtitle.clips = [{ ...baseClip({ id: "clip-formal-child-subtitle", trackId: childSubtitle.id, kind: "subtitle", name: "EP21 镜08 字幕", startFrame: 0, durationFrames: 216, timelineRate: 24 }), text: "EP21 镜08 · 三段子片段嵌套叠化", fontSize: 26, fontColor: "#f6d365", subtitleBackground: "#111827" }];
const child = await saveEditProject(calibrationRoot, childInitial, childInitial.revision, "codex");

const masterInitial = await createEditProject(calibrationRoot, { name: "EP22《斩鼎》53 镜正式长时间线", episode: 22, width, height, fps: 23.976, autoPopulate: false });
const masterVisual = masterInitial.tracks.find((track) => track.kind === "visual")!;
const masterAudio = masterInitial.tracks.find((track) => track.kind === "audio")!;
const masterSubtitle = masterInitial.tracks.find((track) => track.kind === "subtitle")!;
let cursorFrame = 0;
let semanticCursorSeconds = 0;
const frameQuantization: Array<{
  shotCode: string;
  sourceFps: number;
  playbackRate: number;
  requiredFrameMultiple: number;
  startFrame: number;
  durationFrames: number;
  endFrame: number;
  idealEndFrame: number;
  boundaryErrorFrames: number;
}> = [];
const shotClipIds = new Map<string, string>();
const sourceRateForShot = (shot: FormalDramaShot) => shot.frameRate ?? 24;
const mediaIndexForShot = (shot: FormalDramaShot) => sourceRateForShot(shot) >= 120 ? 3 : sourceRateForShot(shot) >= 96 ? 2 : sourceRateForShot(shot) >= 48 ? 1 : 0;
masterVisual.clips = episode22.shots.map((shot, index) => {
  const sourceRate = sourceRateForShot(shot);
  const playbackRate = sourceRate >= 120 ? .2 : sourceRate >= 96 ? .25 : sourceRate >= 48 ? .5 : 1;
  const requiredFrameMultiple = sourceRate >= 120 ? 5 : sourceRate >= 96 ? 4 : sourceRate >= 48 ? 2 : 1;
  semanticCursorSeconds += shot.durationSeconds;
  const idealEndFrame = framesForSeconds(semanticCursorSeconds);
  const desiredDurationFrames = idealEndFrame - cursorFrame;
  const durationFrames = Math.max(requiredFrameMultiple, Math.round(desiredDurationFrames / requiredFrameMultiple) * requiredFrameMultiple);
  const nextCursorFrame = cursorFrame + durationFrames;
  if (durationFrames < 1) throw new Error(`EP22 镜${shot.sourceCode} 累计时间量化后不是正整数帧。`);
  const sourceIndex = mediaIndexForShot(shot);
  const sourcePath = derivedVideos[sourceIndex]!;
  const scannerMedia = mediaByPath.get(path.resolve(path.join(episode22Units[sourceIndex]!.directory, `EP22_15s_${String(sourceIndex + 1).padStart(3, "0")}_v1.mp4`)));
  const id = `clip-formal-ep22-${String(index + 1).padStart(3, "0")}`;
  shotClipIds.set(shot.sourceCode, id);
  const clip = baseClip({
    id,
    trackId: masterVisual.id,
    kind: "video",
    name: `EP22 镜${shot.sourceCode} ${shot.title}`,
    startFrame: cursorFrame,
    durationFrames,
    sourcePath,
    trimStartFrame: 24,
    playbackRate,
    itemId: ep22IndexedUnits[index]?.id,
    artifactId: scannerMedia?.artifactId,
    note: `正式剧本 ${episode22.sourceFile} 镜${shot.sourceCode}；剧本帧率语义 ${sourceRate}fps；工程媒体为参考板隔离派生，sourceNativeMedia=false。`,
  });
  clip.sourceAvailableRange = { startFrame: 0, durationFrames: framesForSeconds(24) };
  if (shot.sourceCode === "44") {
    clip.positionX = -28;
    clip.positionY = 12;
    clip.scale = .86;
    clip.rotation = -2;
    clip.keyframes = [
      { id: "kf-formal-ep22-44-start", frame: 0, timeSeconds: 0, easing: "hold", positionX: -28, positionY: 12, scale: .86, rotation: -2 },
      { id: "kf-formal-ep22-44-end", frame: durationFrames, timeSeconds: Math.round(clip.durationSeconds * 1_000) / 1_000, easing: "cubic_bezier", bezier: { x1: .42, y1: 0, x2: .58, y2: 1 }, positionX: 30, positionY: -18, scale: 1.04, rotation: 2 },
    ];
  }
  frameQuantization.push({
    shotCode: shot.sourceCode,
    sourceFps: sourceRate,
    playbackRate,
    requiredFrameMultiple,
    startFrame: cursorFrame,
    durationFrames,
    endFrame: nextCursorFrame,
    idealEndFrame,
    boundaryErrorFrames: nextCursorFrame - idealEndFrame,
  });
  cursorFrame = nextCursorFrame;
  return clip;
});
if (semanticCursorSeconds !== episode22.totalDurationSeconds) throw new Error("EP22 累计剧本时长与解析总时长不一致。 ");
if (frameQuantization.some((entry) => entry.durationFrames % entry.requiredFrameMultiple !== 0)) throw new Error("EP22 帧量化没有满足高帧率慢放整除约束。 ");
const transitionSource = masterVisual.clips[0]!;
const transitionTarget = masterVisual.clips[1]!;
transitionSource.transitionOut = "smpte_dissolve";
transitionSource.transitionDurationSeconds = 0;
transitionSource.transition = { contract: "aicanvas.otio-transition.v1", kind: "smpte_dissolve", targetClipId: transitionTarget.id, inOffsetFrames: 12, outOffsetFrames: 12 };
masterAudio.clips = [{
  ...baseClip({ id: "clip-formal-ep22-audio", trackId: masterAudio.id, kind: "audio", name: "EP22 全集剧本音效语义占位轨", startFrame: 0, durationFrames: cursorFrame, sourcePath: audioPath, note: "本地确定性校准音轨；源剧本 53/53 镜均有显式音效字段，源目录不含原生音频。" }),
  sourceAvailableRange: { startFrame: 0, durationFrames: framesForSeconds(457) },
  fadeInSeconds: .25,
  fadeOutSeconds: .5,
}];
const subtitleCodes = new Set(["05", "24", "31", "33", "43", "53"]);
masterSubtitle.clips = episode22.shots.filter((shot) => subtitleCodes.has(shot.sourceCode)).map((shot) => {
  const videoClip = masterVisual.clips.find((clip) => clip.id === shotClipIds.get(shot.sourceCode))!;
  return { ...baseClip({ id: `subtitle-formal-ep22-${shot.sourceCode}`, trackId: masterSubtitle.id, kind: "subtitle", name: `EP22 镜${shot.sourceCode} 正式字幕`, startFrame: videoClip.startFrame!, durationFrames: videoClip.durationFrames! }), text: `镜${shot.sourceCode} · ${shot.title}`, fontSize: 25, fontColor: "#ffffff", subtitleBackground: "#111827cc" };
});
const masterSaved = await saveEditProject(calibrationRoot, masterInitial, masterInitial.revision, "codex");
const overlayAdded = await applyEditOperation(calibrationRoot, masterSaved.id, masterSaved.revision, { type: "add_track", kind: "visual", name: "EP21 镜08 冻结嵌套层" }, "codex");
const overlayTrack = overlayAdded.project.tracks.find((track) => track.name === "EP21 镜08 冻结嵌套层");
if (!overlayTrack) throw new Error("没有创建正式嵌套覆盖轨。 ");
const nestedAdded = await applyEditOperation(calibrationRoot, masterSaved.id, overlayAdded.project.revision, { type: "add_nested_timeline", trackId: overlayTrack.id, childEditProjectId: child.id, childExpectedRevision: child.revision, startFrame: framesForSeconds(60) }, "codex");
const keyframeClip = nestedAdded.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === shotClipIds.get("44"));
if (!keyframeClip?.startFrame || !keyframeClip.durationFrames) throw new Error("没有找到 EP22 镜44 关键帧片段。 ");
const keyframeQuantization = frameQuantization.find((entry) => entry.shotCode === "44");
if (!keyframeQuantization) throw new Error("没有找到 EP22 镜44 帧量化记录。 ");
const splitLocalFrames = Math.max(
  keyframeQuantization.requiredFrameMultiple,
  Math.round((keyframeClip.durationFrames / 2) / keyframeQuantization.requiredFrameMultiple) * keyframeQuantization.requiredFrameMultiple,
);
if (splitLocalFrames >= keyframeClip.durationFrames || (keyframeClip.durationFrames - splitLocalFrames) % keyframeQuantization.requiredFrameMultiple !== 0) throw new Error("EP22 镜44 无法在 LinearTimeWarp 整数源帧网格内拆分。 ");
const splitFrame = keyframeClip.startFrame + splitLocalFrames;
const split = await applyEditOperation(calibrationRoot, masterSaved.id, nestedAdded.project.revision, { type: "split_clip", clipId: keyframeClip.id, timeSeconds: secondsForFrame(splitFrame) }, "codex");
const master = split.project;
const mainTrack = master.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0]!;
if (mainTrack.clips.length !== 54) throw new Error(`EP22 split 后主轨应为 54 片段：${mainTrack.clips.length}`);
const totalFrames = Math.max(...mainTrack.clips.map((clip) => clip.startFrame! + clip.durationFrames!));
if (Math.abs(secondsForFrame(totalFrames) - 456) > .05) throw new Error(`EP22 长时间线时长漂移：${secondsForFrame(totalFrames)} 秒。`);

const proofSourceOtio = path.join(calibrationRoot, "EP22_formal-effect-transition-source.otio");
await writeFile(proofSourceOtio, `${JSON.stringify(proofOtio(derivedVideos, audioPath), null, 2)}\n`, "utf8");
const proof = await importEditProjectOtio(calibrationRoot, proofSourceOtio, "EP22 正式剧本派生 Effect Transition Proof");
const proofVisual = proof.tracks.find((track) => track.kind === "visual")!.clips;
const proofAudio = proof.tracks.find((track) => track.kind === "audio")!.clips[0]!;
if (!proofVisual.some((clip) => clip.transitionOut === "smpte_dissolve") || !proofVisual.some((clip) => clip.playbackRate === 2) || proofAudio.kind !== "audio") throw new Error("正式 proof 没有恢复 Effect/Transition/音轨。 ");

const masterOtio = await exportEditProjectOtio(calibrationRoot, master.id, master.revision);
const masterRoundTrip = await importEditProjectOtio(calibrationRoot, masterOtio.path, "EP22 正式长时间线 OTIO 往返");
const roundTripMain = masterRoundTrip.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0]!;
if (masterRoundTrip.timebase?.rateNumerator !== projectRateNumerator || masterRoundTrip.timebase.rateDenominator !== projectRateDenominator || roundTripMain.clips.length !== mainTrack.clips.length || !masterRoundTrip.tracks.flatMap((track) => track.clips).some((clip) => clip.kind === "timeline") || !roundTripMain.clips.some((clip) => clip.transitionOut === "smpte_dissolve")) throw new Error("正式 master OTIO 往返丢失 timebase/clip/nested/transition。 ");

const proofRender = await renderEditProject(calibrationRoot, proof.id, { expectedRevision: proof.revision });
if (proofRender.status !== "succeeded" || !proofRender.publicationReceiptId) throw new Error(proofRender.error || "正式短 proof 同步渲染失败。 ");
const masterStarted = await startEditRender(calibrationRoot, master.id, { expectedRevision: master.revision });
const masterRender = await waitForEditRender(calibrationRoot, masterStarted.id);
if (masterRender.status !== "succeeded" || !masterRender.publicationReceiptId) throw new Error(masterRender.error || "正式 EP22 456 秒后台渲染失败。 ");

const frameTimes = [secondsForFrame(1), secondsForFrame(Math.floor(totalFrames / 2)), secondsForFrame(totalFrames - 1)];
const extractedFrames = [];
for (const [index, timeSeconds] of frameTimes.entries()) {
  const extraction = await extractTimelineFrame(calibrationRoot, { editProjectId: master.id, expectedRevision: master.revision, timeSeconds });
  const target = path.join(calibrationRoot, "evidence", `EP22_master_frame_${index + 1}.png`);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(extraction.framePath, target);
  extractedFrames.push({ extraction, file: await fileEvidence(target) });
}

const targetItem = ep22IndexedUnits.at(-1)!;
const editorModule = pathToFileURL(path.join(workspace, "src", "core", "editor.ts")).href;
const continuationScript = `import { prepareTimelineVideoContinuation } from ${toJsLiteral(editorModule)}; const result = await prepareTimelineVideoContinuation(${toJsLiteral(calibrationRoot)}, ${toJsLiteral({ editProjectId: master.id, targetItemId: targetItem.id, expectedRevision: master.revision, timeSeconds: secondsForFrame(totalFrames - 1), enqueue: false, prompt: "承接 EP22 镜53 正式剧本结尾；保持封神台、涟漪、定格与淡出方向连续。" })}); process.stdout.write(JSON.stringify({ extractionId: result.extraction.id, framePath: result.extraction.framePath, packId: result.pack.id, sourceType: result.pack.sourceType, targetFirstFrameArtifactId: result.pack.targetFirstFrameArtifactId, generationJob: result.generationJob ?? null }));`;
const continuationRaw = await execFileAsync(process.execPath, ["--import", "tsx", "--eval", continuationScript], { cwd: workspace, env: { ...process.env, AI_CANVAS_PROJECT_ROOT: calibrationRoot, AI_CANVAS_REGISTRY_PATH: registryPath }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const continuation = JSON.parse(continuationRaw.stdout.trim());
if (continuation.sourceType !== "timeline" || !continuation.targetFirstFrameArtifactId || continuation.generationJob !== null) throw new Error(`fresh-process Continuation 无效：${JSON.stringify(continuation)}`);
const continuationFrame = path.join(calibrationRoot, "evidence", "EP22_continuation_frame.png");
await copyFile(continuation.framePath, continuationFrame);

const evidenceDirectory = path.join(calibrationRoot, "evidence");
await mkdir(evidenceDirectory, { recursive: true });
const proofEvidenceVideo = path.join(evidenceDirectory, "EP22_formal_proof_sync.mp4");
const masterEvidenceVideo = path.join(evidenceDirectory, "EP22_formal_master_456s.mp4");
await Promise.all([copyFile(proofRender.outputPath, proofEvidenceVideo), copyFile(masterRender.outputPath, masterEvidenceVideo)]);
const proofReceipt = await getPublicationReceipt(calibrationRoot, proofRender.publicationReceiptId);
const masterReceipt = await getPublicationReceipt(calibrationRoot, masterRender.publicationReceiptId);
if (!proofReceipt || !masterReceipt || proofReceipt.check.sha256 !== (await fileEvidence(proofRender.outputPath)).sha256 || masterReceipt.check.sha256 !== (await fileEvidence(masterRender.outputPath)).sha256) throw new Error("正式成片 Publication receipt/hash 不一致。 ");

const sourceAfter = await inspectFormalDramaSource(sourceRoot);
const sourceMetadataAfter = await sourceMetadataSnapshot(sourceAfter);
if (sourceAfter.inventory.aggregateSha256 !== sourceBefore.inventory.aggregateSha256 || JSON.stringify(sourceMetadataAfter) !== JSON.stringify(sourceMetadataBefore)) throw new Error("正式只读源在校准期间发生内容或元数据变化。 ");

const derivedMedia = await Promise.all([...derivedVideos, audioPath].map(async (filePath) => ({ ...await fileEvidence(filePath), probe: await probeMedia(engine.ffprobePath!, filePath) })));
const proofVideo = { ...await fileEvidence(proofEvidenceVideo), probe: await probeMedia(engine.ffprobePath, proofEvidenceVideo) };
const masterVideo = { ...await fileEvidence(masterEvidenceVideo), probe: await probeMedia(engine.ffprobePath, masterEvidenceVideo) };
const masterDuration = Number(masterVideo.probe.format?.duration);
if (!(masterDuration > 455.9 && masterDuration < 456.2)) throw new Error(`正式 EP22 成片不是约 456 秒：${masterDuration}`);

const statePath = path.join(calibrationRoot, "calibration-state.json");
const mcpWritableClipId = shotClipIds.get("10")!;
const state = {
  schemaVersion: 1,
  sourceRoot,
  sourceAggregateSha256: sourceBefore.inventory.aggregateSha256,
  projectRoot: calibrationRoot,
  registryPath,
  formalSourceManifestPath: materialized.manifest.target.manifestPath,
  masterEditProjectId: master.id,
  masterRevision: master.revision,
  proofEditProjectId: proof.id,
  proofRevision: proof.revision,
  childEditProjectId: child.id,
  childRevision: child.revision,
  roundTripEditProjectId: masterRoundTrip.id,
  roundTripRevision: masterRoundTrip.revision,
  mcpWritableClipId,
  expectedMasterMainClipCount: mainTrack.clips.length,
  expectedMasterTotalFrames: totalFrames,
  expectedMasterDurationSeconds: secondsForFrame(totalFrames),
  sourceSemanticDurationSeconds: episode22.totalDurationSeconds,
  maxFrameQuantizationBoundaryError: Math.max(...frameQuantization.map((entry) => Math.abs(entry.boundaryErrorFrames))),
  masterRenderJobId: masterRender.id,
  proofRenderJobId: proofRender.id,
  continuationPackId: continuation.packId,
  sourceNativeMedia: false,
  calibrationDerivedMedia: true,
};
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

const evidence = {
  schemaVersion: 1,
  kind: "aicanvas-formal-project-nle-core-calibration",
  generatedAt: new Date().toISOString(),
  status: "passed",
  authorization: { sourceRoot, sourceReadOnly: true, sourceWriteForbidden: true, writableIsolationRoot: calibrationRoot },
  source: {
    nativeMedia: false,
    episodes: sourceBefore.episodes.length,
    shots: sourceBefore.episodes.reduce((sum, episode) => sum + episode.shots.length, 0),
    durationSeconds: sourceBefore.episodes.reduce((sum, episode) => sum + episode.totalDurationSeconds, 0),
    inventory: sourceBefore.inventory,
    metadataBefore: sourceMetadataBefore,
    metadataAfter: sourceMetadataAfter,
    unchanged: true,
  },
  normalized: {
    selectedEpisodes: materialized.manifest.selectedEpisodes,
    units: materialized.manifest.units.length,
    ep22Units: ep22IndexedUnits.length,
    formalSourceManifest: await fileEvidence(materialized.manifest.target.manifestPath),
    repeatedScanStable: true,
    scanIds: [firstIndex.scanId, secondIndex.scanId],
  },
  derivedMedia: { sourceNativeMedia: false, calibrationDerived: true, files: derivedMedia },
  timeline: {
    master: { id: master.id, revision: master.revision, name: master.name, timebase: master.timebase, mainClipCount: mainTrack.clips.length, totalFrames, durationSeconds: secondsForFrame(totalFrames), sourceSemanticDurationSeconds: episode22.totalDurationSeconds, frameQuantizationDeltaSeconds: secondsForFrame(totalFrames) - episode22.totalDurationSeconds, maxFrameQuantizationBoundaryError: Math.max(...frameQuantization.map((entry) => Math.abs(entry.boundaryErrorFrames))), frameQuantization, audioClips: masterAudio.clips.length, subtitleClips: masterSubtitle.clips.length, nestedClips: master.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === "timeline").length, splitKeyframeClip: true },
    child: { id: child.id, revision: child.revision, timebase: child.timebase, clips: child.tracks.reduce((sum, track) => sum + track.clips.length, 0) },
    proof: { id: proof.id, revision: proof.revision, timebase: proof.timebase, transition: proofVisual.find((clip) => clip.transitionOut === "smpte_dissolve")?.transition, timeWarpRates: proof.tracks.flatMap((track) => track.clips).filter((clip) => clip.playbackRate !== 1).map((clip) => clip.playbackRate) },
    otioRoundTrip: { export: masterOtio, importedProjectId: masterRoundTrip.id, importedRevision: masterRoundTrip.revision, mainClipCount: roundTripMain.clips.length, timebase: masterRoundTrip.timebase, nestedPreserved: masterRoundTrip.tracks.flatMap((track) => track.clips).some((clip) => clip.kind === "timeline") },
  },
  renders: {
    synchronousProof: { jobId: proofRender.id, publicationReceiptId: proofRender.publicationReceiptId, file: proofVideo },
    backgroundMaster: { jobId: masterRender.id, publicationReceiptId: masterRender.publicationReceiptId, file: masterVideo },
    receipts: { proof: proofReceipt, master: masterReceipt },
  },
  extractedFrames,
  continuation: { ...continuation, generationEnqueued: false, frame: await fileEvidence(continuationFrame) },
  statePath,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: evidence.status, evidencePath, statePath, projectRoot: calibrationRoot, sourceUnchanged: true, units: materialized.manifest.units.length, master: { id: master.id, revision: master.revision, clips: mainTrack.clips.length, frames: totalFrames, durationSeconds: secondsForFrame(totalFrames), render: masterVideo.path }, proof: { id: proof.id, render: proofVideo.path } }, null, 2)}\n`);
