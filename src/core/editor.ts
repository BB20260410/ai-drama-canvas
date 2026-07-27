import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { upsertAssetRelation } from "./asset-registry.js";
import { RejectedCommandFailure } from "./command-outcome.js";
import { enqueueGeneration, listGenerationJobs } from "./generation.js";
import {
  EDIT_KEYFRAME_CURVE_CONTRACT,
  EDIT_KEYFRAME_CURVE_CONTRACTS,
  LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT,
  buildFfmpegEasingExpression,
  buildFfmpegKeyframeSourceTransformExpression,
  editKeyframeCurveIssue,
  editKeyframeSourceTransformIssue,
  editTransformFramePoints,
  evaluateEditKeyframeSourceTransformAtFrame,
  evaluateEditTransformAtFrame,
  normalizeEditCubicBezier,
  subdivideEditKeyframeEasing,
  type EditTransform,
} from "./keyframe-curve.js";
import { cancelPublication, failPublication, getPublicationIntent, preflightPublication, registerPublication } from "./publication.js";
import { appendEvent, ensureSidecar, getSidecarPaths, loadProjectConfig, readJson, writeJsonAtomic, writeJsonAtomicExclusive } from "./sidecar.js";
import { getProjectIndex, registerArtifact } from "./service.js";
import type { Artifact, EditClip, EditKeyframe, EditKeyframeSourceTransform, EditMediaItem, EditMediaPreview, EditNestedTimelinePreview, EditNestedTimelineRef, EditProject, EditRationalFrame, EditRenderDependencyRef, EditRenderJob, EditorRecoveryInfo, EditorSessionOpenResult, EditorSessionResolution, EditorSessionState, EditTrack, GenerationJob, LastFrameExtraction, TimelineFrameExtraction, VideoContinuationPack, VideoEngineInfo, WorkItem } from "./types.js";
import { withProjectLock } from "./locks.js";
import { MEDIA_WEIGHTS, mediaStageTimeout, reapMachineMediaRuntime, runMediaProcess, startManagedMediaProcess, terminateProcessTree, type ManagedMediaProcess, type ManagedMediaProcessResult, type MediaTool } from "./media-runtime.js";
import { probeStudioOtioDocument } from "./studio-otio-capability-matrix.js";

const MAX_TRACKS = 16;
const MAX_CLIPS = 1_000;
const MAX_KEYFRAMES_PER_CLIP = 200;
const MAX_RENDER_LOG = 200_000;
const MAX_NESTED_TIMELINE_DEPTH = 8;
const MAX_RESOLVED_EDIT_PROJECTS = 64;
const MAX_EXPANDED_EDIT_CLIPS = 5_000;
const NESTED_TIMELINE_CONTRACT = "aicanvas.nested-timeline.v1" as const;
const NESTED_RENDER_CONTRACT = "aicanvas.nested-timeline.ffmpeg.v1";
const OTIO_EFFECT_TRANSITION_CONTRACT = "aicanvas.otio-effect-transition.v1" as const;
const OTIO_TRANSITION_CONTRACT = "aicanvas.otio-transition.v1" as const;
const EDIT_TRANSFORM_PROPERTIES = ["positionX", "positionY", "scale", "rotation"] as const;

function roundTime(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundTransform(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function greatestCommonDivisorBigInt(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

function rationalFromBigInt(numerator: bigint, denominator: bigint): EditRationalFrame {
  if (denominator === 0n) throw new Error("嵌套时间线有理数分母不能为 0。");
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = greatestCommonDivisorBigInt(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (numerator < -max || numerator > max || denominator > max) throw new Error("嵌套时间线有理数超出安全整数范围。");
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

function normalizeEditRational(value: EditRationalFrame, label = "嵌套时间线有理数"): EditRationalFrame {
  if (!Number.isSafeInteger(value?.numerator) || !Number.isSafeInteger(value?.denominator) || value.denominator <= 0) throw new Error(`${label}必须由安全整数分子和正分母组成。`);
  return rationalFromBigInt(BigInt(value.numerator), BigInt(value.denominator));
}

function addEditRational(left: EditRationalFrame, right: EditRationalFrame): EditRationalFrame {
  const a = normalizeEditRational(left);
  const b = normalizeEditRational(right);
  return rationalFromBigInt(BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator));
}

function multiplyEditRational(left: EditRationalFrame, right: EditRationalFrame): EditRationalFrame {
  const a = normalizeEditRational(left);
  const b = normalizeEditRational(right);
  return rationalFromBigInt(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator));
}

function compareEditRational(left: EditRationalFrame, right: EditRationalFrame): number {
  const a = normalizeEditRational(left);
  const b = normalizeEditRational(right);
  const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function rationalForInteger(value: number): EditRationalFrame {
  if (!Number.isSafeInteger(value)) throw new Error("嵌套时间线整数帧超出安全范围。");
  return { numerator: value, denominator: 1 };
}

function rationalTimesInteger(value: EditRationalFrame, multiplier: number): EditRationalFrame {
  return multiplyEditRational(value, rationalForInteger(multiplier));
}

function rationalQuotientInteger(numerator: EditRationalFrame, denominator: EditRationalFrame, label: string): number {
  const left = normalizeEditRational(numerator);
  const right = normalizeEditRational(denominator);
  if (right.numerator === 0) throw new Error(`${label}的除数不能为 0。`);
  const top = BigInt(left.numerator) * BigInt(right.denominator);
  const bottom = BigInt(left.denominator) * BigInt(right.numerator);
  if (bottom === 0n || top % bottom !== 0n) throw new Error(`${label}无法证明落在父整数帧边界。`);
  const quotient = top / bottom;
  if (quotient < 0n || quotient > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}超出安全整数范围。`);
  return Number(quotient);
}

function floorEditRational(value: EditRationalFrame): number {
  const normalized = normalizeEditRational(value);
  if (normalized.numerator < 0) throw new Error("嵌套时间线帧坐标不能为负。 ");
  const result = BigInt(normalized.numerator) / BigInt(normalized.denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("嵌套时间线帧坐标超出安全范围。 ");
  return Number(result);
}

function ceilPositiveRationalDivision(integer: number, divisor: EditRationalFrame): number {
  if (!Number.isSafeInteger(integer) || integer <= 0) throw new Error("嵌套时间线源时长必须是正安全整数。");
  const normalized = normalizeEditRational(divisor, "嵌套时间线源步长");
  if (normalized.numerator <= 0) throw new Error("嵌套时间线源步长必须为正数。");
  const top = BigInt(integer) * BigInt(normalized.denominator);
  const bottom = BigInt(normalized.numerator);
  const result = (top + bottom - 1n) / bottom;
  if (result < 1n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("嵌套时间线映射时长超出安全范围。");
  return Number(result);
}

function timebaseForFrameRate(value: number): { rateNumerator: number; rateDenominator: number; fps: number } {
  if (!Number.isFinite(value) || value < 12 || value > 120) throw new Error("帧率必须在 12–120 fps 之间。");
  const commonRates = [24_000, 30_000, 48_000, 60_000, 120_000];
  for (const numerator of commonRates) {
    const rate = numerator / 1_001;
    if (Math.abs(value - rate) < .001 || Math.abs(value - roundTime(rate)) < .0001) return { rateNumerator: numerator, rateDenominator: 1_001, fps: roundTime(rate) };
  }
  const rounded = roundTime(value);
  if (Math.abs(value - rounded) > .000001) throw new Error("帧率最多保留三位小数。");
  const numerator = Math.round(rounded * 1_000);
  const divisor = greatestCommonDivisor(numerator, 1_000);
  return { rateNumerator: numerator / divisor, rateDenominator: 1_000 / divisor, fps: rounded };
}

function normalizedProjectTimebase(project: Pick<EditProject, "fps" | "timebase">): { rateNumerator: number; rateDenominator: number; fps: number } {
  const candidate = project.timebase;
  if (candidate !== undefined) {
    if (!Number.isSafeInteger(candidate.rateNumerator) || !Number.isSafeInteger(candidate.rateDenominator) || candidate.rateNumerator <= 0 || candidate.rateDenominator <= 0) throw new Error("剪辑工程 timebase 必须由正安全整数组成。");
    const divisor = greatestCommonDivisor(candidate.rateNumerator, candidate.rateDenominator);
    const rateNumerator = candidate.rateNumerator / divisor;
    const rateDenominator = candidate.rateDenominator / divisor;
    const rate = rateNumerator / rateDenominator;
    if (!Number.isFinite(rate) || rate < 12 || rate > 120) throw new Error("帧率必须在 12–120 fps 之间。");
    if (Number.isFinite(project.fps) && Math.abs(project.fps - rate) > .001) throw new Error("剪辑工程 fps 与精确 timebase 冲突。");
    return { rateNumerator, rateDenominator, fps: roundTime(rate) };
  }
  return timebaseForFrameRate(project.fps);
}

function projectFrameRate(project: Pick<EditProject, "fps" | "timebase">): number {
  const timebase = project.timebase;
  if (timebase && Number.isInteger(timebase.rateNumerator) && Number.isInteger(timebase.rateDenominator) && timebase.rateNumerator > 0 && timebase.rateDenominator > 0) return timebase.rateNumerator / timebase.rateDenominator;
  return project.fps;
}

function projectFrameForSeconds(project: Pick<EditProject, "fps" | "timebase">, seconds: number): number {
  return Math.max(0, Math.round(seconds * projectFrameRate(project)));
}

function projectSecondsForFrame(project: Pick<EditProject, "fps" | "timebase">, frame: number): number {
  return roundTime(Math.max(0, Math.round(frame)) / projectFrameRate(project));
}

function ffmpegSecondsForFrame(project: Pick<EditProject, "fps" | "timebase">, frame: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error("FFmpeg 帧时间必须是非负安全整数。 ");
  const timebase = normalizedProjectTimebase(project);
  const seconds = frame * timebase.rateDenominator / timebase.rateNumerator;
  return seconds.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function exactScaledFrameCount(frames: number, scalar: number, label: string): number {
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isFinite(scalar) || scalar <= 0) throw new Error(`${label}的帧数或速度无效。`);
  const scaled = frames * scalar;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-9) throw new Error(`${label}无法证明映射到整数源帧。`);
  return rounded;
}

function exactUnscaledFrameCount(sourceFrames: number, scalar: number, label: string): number {
  if (!Number.isSafeInteger(sourceFrames) || sourceFrames < 1 || !Number.isFinite(scalar) || scalar <= 0) throw new Error(`${label}的帧数或速度无效。`);
  const unscaled = sourceFrames / scalar;
  const rounded = Math.round(unscaled);
  if (!Number.isSafeInteger(rounded) || rounded < 1 || Math.abs(unscaled - rounded) > 1e-9) throw new Error(`${label}无法证明映射到项目整数帧。`);
  return rounded;
}

function sourceRangeEnd(range: NonNullable<EditClip["sourceAvailableRange"]>): number {
  return range.startFrame + range.durationFrames;
}

function editClipStartFrame(project: Pick<EditProject, "fps" | "timebase">, clip: EditClip): number {
  return Number.isInteger(clip.startFrame) ? clip.startFrame! : projectFrameForSeconds(project, clip.startSeconds);
}

function editClipDurationFrames(project: Pick<EditProject, "fps" | "timebase">, clip: EditClip): number {
  return Number.isInteger(clip.durationFrames) ? Math.max(1, clip.durationFrames!) : Math.max(1, projectFrameForSeconds(project, clip.durationSeconds));
}

function ffmpegFrameRate(project: Pick<EditProject, "fps" | "timebase">): string {
  const timebase = normalizedProjectTimebase(project);
  return `${timebase.rateNumerator}/${timebase.rateDenominator}`;
}

function clipEnd(clip: EditClip): number {
  return roundTime(clip.startSeconds + clip.durationSeconds);
}

function safeName(value: string): string {
  const cleaned = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").slice(0, 100);
  return cleaned || "未命名剪辑";
}

function editProjectLockName(editProjectId: string): string {
  return `editor-project-${editProjectId}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function executable(filePath: string): Promise<boolean> {
  return access(filePath, fsConstants.X_OK).then(() => true).catch(() => false);
}

async function findExecutable(name: "ffmpeg" | "ffprobe"): Promise<string | undefined> {
  const explicit = name === "ffmpeg" ? process.env.AI_CANVAS_FFMPEG : process.env.AI_CANVAS_FFPROBE;
  const candidates = [
    explicit,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) if (await executable(candidate)) return candidate;
  return undefined;
}

async function runProcess(
  projectRoot: string | undefined,
  command: string,
  args: string[],
  options: { tool: MediaTool; stage: string; weight: number; timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number },
): Promise<ManagedMediaProcessResult> {
  return runMediaProcess(command, args, { projectRoot, ...options });
}

export async function probeVideoEngine(): Promise<VideoEngineInfo> {
  const ffmpegPath = await findExecutable("ffmpeg");
  const ffprobePath = await findExecutable("ffprobe");
  const issues: string[] = [];
  if (!ffmpegPath) issues.push("未找到 FFmpeg；请安装 FFmpeg 或设置 AI_CANVAS_FFMPEG。 ");
  if (!ffprobePath) issues.push("未找到 FFprobe；素材扫描的时长与尺寸检测会受限。");
  let ffmpegVersion: string | undefined;
  if (ffmpegPath) {
    try {
      const result = await runProcess(undefined, ffmpegPath, ["-version"], { tool: "ffmpeg", stage: "engine-version", weight: MEDIA_WEIGHTS.probe, timeoutMs: mediaStageTimeout("ffmpeg", 10_000) });
      ffmpegVersion = result.output.split("\n")[0]?.trim();
      if (result.status !== "succeeded") issues.push(result.status === "timed_out" ? "FFmpeg 存在，但版本探测超时。" : "FFmpeg 存在，但版本探测失败。");
    } catch (error) {
      issues.push(`FFmpeg 存在，但版本探测未取得机器容量：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { available: Boolean(ffmpegPath), ffmpegPath, ffprobePath, ffmpegVersion, issues };
}

function mediaName(item: WorkItem, artifact: Artifact): string {
  const prefix = item.episode ? `EP${String(item.episode).padStart(2, "0")} ` : "";
  return `${prefix}${item.title} · ${path.basename(artifact.path)}`;
}

const EDITOR_MEDIA_CAPACITY_LOCK = "editor-media-capacity";
const EDITOR_MEDIA_CAPACITY_TIMEOUT_MS = 30_000;

async function withEditorMediaCapacity<T>(projectRoot: string, action: string, work: () => Promise<T>): Promise<T> {
  return withProjectLock(projectRoot, EDITOR_MEDIA_CAPACITY_LOCK, async () => {
    const activeRenders = (await listEditRenderJobs(projectRoot)).filter((job) => job.status === "running");
    if (activeRenders.length) {
      throw new Error(`项目正在进行成片导出 ${activeRenders.map((job) => job.id).join("、")}；${action}已暂停，等待导出完成或取消后再试。`);
    }
    return work();
  }, { timeoutMs: EDITOR_MEDIA_CAPACITY_TIMEOUT_MS, staleMs: 300_000 });
}

export async function listEditMedia(projectRoot: string, episode?: number): Promise<EditMediaItem[]> {
  const index = await getProjectIndex(projectRoot);
  const previewStore = await readJson<{ schemaVersion: 1; previews: Record<string, EditMediaPreview> }>(getSidecarPaths(projectRoot).editorPreviewIndex, { schemaVersion: 1, previews: {} });
  const itemMap = new Map(index.items.map((item) => [item.id, item]));
  return index.artifacts
    .filter((artifact) => !artifact.deprecated && artifact.check.ok && ["video", "audio", "raw-image", "labeled-image"].includes(artifact.kind))
    .map((artifact): EditMediaItem | null => {
      const item = itemMap.get(artifact.itemId);
      if (!item || (episode !== undefined && item.episode !== episode)) return null;
      const cached = previewStore.previews[artifact.id]?.sourceModifiedAt === artifact.modifiedAt ? previewStore.previews[artifact.id] : undefined;
      return {
        id: `media-${artifact.id}`,
        artifactId: artifact.id,
        itemId: item.id,
        kind: artifact.kind === "video" ? "video" : artifact.kind === "audio" ? "audio" : "image",
        name: mediaName(item, artifact),
        path: artifact.path,
        thumbnailPath: cached?.thumbnailPath ?? (artifact.kind === "audio" ? undefined : artifact.kind === "video" ? item.thumbnailPath : artifact.path),
        filmstripPath: cached?.filmstripPath,
        waveformPath: cached?.waveformPath,
        proxyPath: cached?.proxyPath,
        durationSeconds: artifact.check.duration,
        width: artifact.check.width,
        height: artifact.check.height,
        authoritative: artifact.authoritative,
        accepted: artifact.accepted,
        episode: item.episode,
        unit: item.unit,
      };
    })
    .filter((item): item is EditMediaItem => Boolean(item))
    .sort((a, b) => Number(b.authoritative) - Number(a.authoritative) || Number(b.accepted) - Number(a.accepted) || (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

async function prepareEditMediaPreviewUnlocked(projectRoot: string, artifactId: string): Promise<EditMediaPreview> {
  const index = await getProjectIndex(projectRoot);
  const artifact = index.artifacts.find((candidate) => candidate.id === artifactId && !candidate.deprecated && candidate.check.ok && ["video", "audio", "raw-image", "labeled-image"].includes(candidate.kind));
  if (!artifact) throw new Error(`找不到可生成预览的素材：${artifactId}`);
  const kind: EditMediaPreview["kind"] = artifact.kind === "video" ? "video" : artifact.kind === "audio" ? "audio" : "image";
  const paths = getSidecarPaths(projectRoot);
  const store = await readJson<{ schemaVersion: 1; previews: Record<string, EditMediaPreview> }>(paths.editorPreviewIndex, { schemaVersion: 1, previews: {} });
  const cached = store.previews[artifact.id];
  if (cached?.sourceModifiedAt === artifact.modifiedAt) {
    const outputs = [cached.thumbnailPath, cached.filmstripPath, cached.waveformPath].filter((value): value is string => Boolean(value));
    if (outputs.length && (await Promise.all(outputs.map((filePath) => access(filePath).then(() => true).catch(() => false)))).every(Boolean)) return cached;
  }
  await mkdir(paths.editorPreviews, { recursive: true });
  const safeId = artifact.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  const now = new Date().toISOString();
  const preview: EditMediaPreview = { artifactId: artifact.id, kind, sourceModifiedAt: artifact.modifiedAt, generatedAt: now, proxyPath: cached?.proxyPath };
  if (kind === "image") {
    const thumbnailPath = path.join(paths.editorPreviews, `${safeId}-thumb.jpg`);
    await sharp(artifact.path, { failOn: "error" }).resize(320, 180, { fit: "contain", background: "#080907" }).jpeg({ quality: 82 }).toFile(thumbnailPath);
    preview.thumbnailPath = thumbnailPath;
  } else if (kind === "audio") {
    const engine = await probeVideoEngine();
    if (!engine.ffmpegPath) throw new Error("生成音频波形需要 FFmpeg。 ");
    const waveformPath = path.join(paths.editorPreviews, `${safeId}-waveform.png`);
    const result = await runProcess(projectRoot, engine.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", artifact.path, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=900x120:colors=0xD7AF55", "-frames:v", "1", "-y", waveformPath], { tool: "ffmpeg", stage: "preview-waveform", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 120_000) });
    if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "音频波形生成超时，进程树已终止。" : result.output.trim().split("\n").slice(-10).join("\n") || "音频波形生成失败。 ");
    preview.waveformPath = waveformPath;
  } else {
    const engine = await probeVideoEngine();
    if (!engine.ffmpegPath) throw new Error("生成视频胶片条需要 FFmpeg。 ");
    const duration = Math.max(.1, artifact.check.duration ?? 1);
    const temporaryFrames: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const framePath = path.join(paths.editorPreviews, `${safeId}-frame-${index}.png`);
      const timestamp = Math.max(0, Math.min(duration - .04, duration * ((index + .5) / 5)));
      const result = await runProcess(projectRoot, engine.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", String(roundTime(timestamp)), "-i", artifact.path, "-frames:v", "1", "-vf", "scale=160:100:force_original_aspect_ratio=decrease,pad=160:100:(ow-iw)/2:(oh-ih)/2:color=0x080907", "-y", framePath], { tool: "ffmpeg", stage: "preview-filmstrip", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 120_000) });
      if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "视频缩略帧生成超时，进程树已终止。" : result.output.trim().split("\n").slice(-10).join("\n") || "视频缩略帧生成失败。 ");
      temporaryFrames.push(framePath);
    }
    const filmstripPath = path.join(paths.editorPreviews, `${safeId}-filmstrip.jpg`);
    await sharp({ create: { width: 800, height: 100, channels: 3, background: "#080907" } }).composite(temporaryFrames.map((input, index) => ({ input, left: index * 160, top: 0 }))).jpeg({ quality: 82 }).toFile(filmstripPath);
    const thumbnailPath = path.join(paths.editorPreviews, `${safeId}-thumb.jpg`);
    await sharp(temporaryFrames[2]!, { failOn: "error" }).jpeg({ quality: 84 }).toFile(thumbnailPath);
    await Promise.all(temporaryFrames.map((filePath) => unlink(filePath).catch(() => undefined)));
    preview.thumbnailPath = thumbnailPath;
    preview.filmstripPath = filmstripPath;
  }
  store.previews[artifact.id] = preview;
  await writeJsonAtomic(paths.editorPreviewIndex, store);
  await appendEvent(projectRoot, { actor: "app", type: "editor.media-preview-generated", itemId: artifact.itemId, data: { artifactId: artifact.id, kind, thumbnailPath: preview.thumbnailPath, filmstripPath: preview.filmstripPath, waveformPath: preview.waveformPath } });
  return preview;
}

export async function prepareEditMediaPreview(projectRoot: string, artifactId: string): Promise<EditMediaPreview> {
  return withEditorMediaCapacity(projectRoot, "预览生成", () => prepareEditMediaPreviewUnlocked(projectRoot, artifactId));
}

async function prepareEditMediaProxyUnlocked(projectRoot: string, artifactId: string): Promise<EditMediaPreview> {
  const index = await getProjectIndex(projectRoot);
  const artifact = index.artifacts.find((candidate) => candidate.id === artifactId && candidate.kind === "video" && !candidate.deprecated && candidate.check.ok);
  if (!artifact) throw new Error(`找不到可生成代理的视频素材：${artifactId}`);
  const paths = getSidecarPaths(projectRoot);
  const store = await readJson<{ schemaVersion: 1; previews: Record<string, EditMediaPreview> }>(paths.editorPreviewIndex, { schemaVersion: 1, previews: {} });
  const cached = store.previews[artifact.id];
  if (cached?.sourceModifiedAt === artifact.modifiedAt && cached.proxyPath && await access(cached.proxyPath).then(() => true).catch(() => false)) return cached;
  const engine = await probeVideoEngine();
  if (!engine.ffmpegPath) throw new Error("生成剪辑代理需要 FFmpeg。 ");
  await mkdir(paths.editorProxies, { recursive: true });
  const safeId = artifact.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  const proxyPath = path.join(paths.editorProxies, `${safeId}-${artifact.modifiedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}.mp4`);
  const result = await runProcess(projectRoot, engine.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", artifact.path, "-map", "0:v:0", "-map", "0:a?", "-vf", "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", proxyPath], { tool: "ffmpeg", stage: "proxy-transcode", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 30 * 60_000) });
  if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "剪辑代理生成超时，进程树已终止。" : result.output.trim().split("\n").slice(-12).join("\n") || "剪辑代理生成失败。 ");
  await access(proxyPath, fsConstants.R_OK);
  const preview: EditMediaPreview = { ...(cached ?? { artifactId: artifact.id, kind: "video", sourceModifiedAt: artifact.modifiedAt, generatedAt: new Date().toISOString() }), artifactId: artifact.id, kind: "video", sourceModifiedAt: artifact.modifiedAt, proxyPath, generatedAt: new Date().toISOString() };
  store.previews[artifact.id] = preview;
  await writeJsonAtomic(paths.editorPreviewIndex, store);
  await appendEvent(projectRoot, { actor: "app", type: "editor.media-proxy-generated", itemId: artifact.itemId, data: { artifactId: artifact.id, sourcePath: artifact.path, proxyPath, widthLimit: 1280 } });
  return preview;
}

export async function prepareEditMediaProxy(projectRoot: string, artifactId: string): Promise<EditMediaPreview> {
  return withEditorMediaCapacity(projectRoot, "代理转码", () => prepareEditMediaProxyUnlocked(projectRoot, artifactId));
}

function projectFile(projectRoot: string, editProjectId: string): string {
  if (!/^[a-zA-Z0-9_-]{3,120}$/.test(editProjectId)) throw new Error("剪辑工程 ID 不合法。");
  return path.join(getSidecarPaths(projectRoot).editorProjects, `${editProjectId}.json`);
}

interface EditHistoryStore { schemaVersion: 1; past: EditProject[]; future: EditProject[]; updatedAt: string }
function historyFile(projectRoot: string, editProjectId: string): string {
  if (!/^[a-zA-Z0-9_-]{3,120}$/.test(editProjectId)) throw new Error("剪辑工程 ID 不合法。 ");
  return path.join(getSidecarPaths(projectRoot).editorHistory, `${editProjectId}.json`);
}
async function loadEditHistory(projectRoot: string, editProjectId: string): Promise<EditHistoryStore> {
  return readJson(historyFile(projectRoot, editProjectId), { schemaVersion: 1, past: [], future: [], updatedAt: new Date(0).toISOString() });
}
async function saveEditHistory(projectRoot: string, editProjectId: string, history: EditHistoryStore): Promise<void> {
  history.past = history.past.slice(-30);
  history.future = history.future.slice(-30);
  history.updatedAt = new Date().toISOString();
  await writeJsonAtomic(historyFile(projectRoot, editProjectId), history);
}

async function loadEditorSession(projectRoot: string): Promise<EditorSessionState | null> {
  return readJson<EditorSessionState | null>(getSidecarPaths(projectRoot).editorSession, null);
}

async function rawRunningRenderIds(projectRoot: string): Promise<string[]> {
  const store = await readJson<{ schemaVersion: 1; jobs: EditRenderJob[] }>(getSidecarPaths(projectRoot).editorRenders, { schemaVersion: 1, jobs: [] });
  return [...new Set(store.jobs.filter((job) => job.status === "running").map((job) => job.id))];
}

async function findHistoryRevision(projectRoot: string, editProjectId: string, revision?: number): Promise<EditProject | undefined> {
  if (revision === undefined) return undefined;
  const current = await getEditProject(projectRoot, editProjectId).catch(() => undefined);
  if (current?.revision === revision) return current;
  const history = await loadEditHistory(projectRoot, editProjectId);
  return [...history.past, ...history.future].find((project) => project.revision === revision);
}

export async function getEditorSessionState(projectRoot: string): Promise<EditorSessionState | null> {
  return loadEditorSession(projectRoot);
}

export async function beginEditorSession(projectRoot: string): Promise<EditorSessionOpenResult> {
  await ensureSidecar(projectRoot);
  const result = await withProjectLock(projectRoot, "editor-session", async () => {
    const previous = await loadEditorSession(projectRoot);
    const previousProject = previous?.lastProjectId ? await getEditProject(projectRoot, previous.lastProjectId).catch(() => undefined) : undefined;
    const interrupted = Boolean(previous && !previous.cleanShutdown && previousProject);
    const stableSnapshot = interrupted && previousProject ? await findHistoryRevision(projectRoot, previousProject.id, previous?.lastStableRevision) : undefined;
    const stableAvailable = Boolean(stableSnapshot && stableSnapshot.revision !== previousProject?.revision);
    const activeRenderIds = await rawRunningRenderIds(projectRoot);
    const now = new Date().toISOString();
    const recovery: EditorRecoveryInfo | undefined = interrupted && previousProject ? {
      projectId: previousProject.id,
      projectName: previousProject.name,
      latestRevision: previousProject.revision,
      stableRevision: previous?.lastStableRevision,
      stableAvailable,
      interruptedAt: previous!.updatedAt,
      incompleteRenderIds: [...new Set([...(previous?.incompleteRenderIds ?? []), ...activeRenderIds])],
    } : undefined;
    const state: EditorSessionState = {
      schemaVersion: 1,
      sessionId: `editor-session-${randomUUID()}`,
      cleanShutdown: false,
      recoveryPending: Boolean(recovery),
      lastProjectId: previousProject?.id,
      lastProjectRevision: previousProject?.revision,
      lastStableRevision: recovery ? previous?.lastStableRevision : previousProject?.revision,
      incompleteRenderIds: recovery?.incompleteRenderIds ?? activeRenderIds,
      openedAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(getSidecarPaths(projectRoot).editorSession, state);
    return { state, recovery } satisfies EditorSessionOpenResult;
  });
  await appendEvent(projectRoot, { actor: "app", type: result.recovery ? "editor.session-recovery-required" : "editor.session-opened", data: { sessionId: result.state.sessionId, editProjectId: result.state.lastProjectId, latestRevision: result.recovery?.latestRevision, stableRevision: result.recovery?.stableRevision, incompleteRenderIds: result.state.incompleteRenderIds } });
  return result;
}

export async function setEditorSessionProject(projectRoot: string, sessionId: string, editProjectId: string): Promise<EditorSessionState> {
  const project = await getEditProject(projectRoot, editProjectId);
  return withProjectLock(projectRoot, "editor-session", async () => {
    const state = await loadEditorSession(projectRoot);
    if (!state || state.sessionId !== sessionId || state.cleanShutdown) throw new Error("剪辑会话已失效，请重新进入导演剪辑台。");
    if (state.recoveryPending) throw new Error("必须先选择恢复稳定修订或打开最新修订。");
    const projectChanged = state.lastProjectId !== project.id;
    state.lastProjectId = project.id;
    state.lastProjectRevision = project.revision;
    if (projectChanged || state.lastStableRevision === undefined) state.lastStableRevision = project.revision;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).editorSession, state);
    return state;
  });
}

export async function resolveEditorSessionRecovery(projectRoot: string, sessionId: string, choice: "stable" | "latest"): Promise<EditorSessionResolution> {
  const resolution = await withProjectLock(projectRoot, "editor-session", async () => {
    const state = await loadEditorSession(projectRoot);
    if (!state || state.sessionId !== sessionId || state.cleanShutdown) throw new Error("剪辑恢复会话已失效，请重新进入导演剪辑台。");
    if (!state.recoveryPending || !state.lastProjectId) throw new Error("当前没有待处理的异常退出恢复选择。");
    const current = await getEditProject(projectRoot, state.lastProjectId);
    let project = current;
    if (choice === "stable") {
      const snapshot = await findHistoryRevision(projectRoot, current.id, state.lastStableRevision);
      if (!snapshot || snapshot.revision === current.revision) throw new Error("最近稳定修订已不可用，请选择打开最新修订。");
      const restored = await validateEditProject(projectRoot, structuredClone(snapshot));
      restored.revision = current.revision + 1;
      restored.updatedAt = new Date().toISOString();
      const history = await loadEditHistory(projectRoot, current.id);
      history.past.push(current);
      history.future = [];
      await Promise.all([writeJsonAtomic(projectFile(projectRoot, current.id), restored), saveEditHistory(projectRoot, current.id, history)]);
      project = restored;
    }
    state.recoveryPending = false;
    state.lastProjectRevision = project.revision;
    state.lastStableRevision = project.revision;
    state.incompleteRenderIds = await rawRunningRenderIds(projectRoot);
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).editorSession, state);
    return { state, project, choice } satisfies EditorSessionResolution;
  });
  await appendEvent(projectRoot, { actor: "user", type: `editor.session-recovered-${choice}`, data: { sessionId, editProjectId: resolution.project.id, revision: resolution.project.revision } });
  return resolution;
}

export async function closeEditorSession(projectRoot: string, sessionId: string): Promise<EditorSessionState | null> {
  const result = await withProjectLock(projectRoot, "editor-session", async () => {
    const state = await loadEditorSession(projectRoot);
    if (!state || state.sessionId !== sessionId) return state;
    // 用户尚未作出恢复选择时，关闭窗口不能把异常现场洗成“正常退出”。
    if (state.recoveryPending) return state;
    const project = state.lastProjectId ? await getEditProject(projectRoot, state.lastProjectId).catch(() => undefined) : undefined;
    const now = new Date().toISOString();
    state.cleanShutdown = true;
    state.lastProjectRevision = project?.revision ?? state.lastProjectRevision;
    state.lastStableRevision = project?.revision ?? state.lastStableRevision;
    state.incompleteRenderIds = await rawRunningRenderIds(projectRoot);
    state.closedAt = now;
    state.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).editorSession, state);
    return state;
  });
  if (result?.cleanShutdown) await appendEvent(projectRoot, { actor: "app", type: "editor.session-closed", data: { sessionId, editProjectId: result.lastProjectId, revision: result.lastProjectRevision, incompleteRenderIds: result.incompleteRenderIds } });
  return result;
}

async function refreshEditorSessionRenderIds(projectRoot: string): Promise<void> {
  const activeRenderIds = await rawRunningRenderIds(projectRoot);
  await withProjectLock(projectRoot, "editor-session", async () => {
    const state = await loadEditorSession(projectRoot);
    if (!state || state.cleanShutdown) return;
    state.incompleteRenderIds = activeRenderIds;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).editorSession, state);
  });
}

export async function listEditProjects(projectRoot: string): Promise<EditProject[]> {
  const directory = getSidecarPaths(projectRoot).editorProjects;
  const names = await readdir(directory).catch(() => [] as string[]);
  const projects = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<EditProject | null>(path.join(directory, name), null)));
  return projects.filter((project): project is EditProject => Boolean(project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getEditProject(projectRoot: string, editProjectId: string): Promise<EditProject> {
  const project = await readJson<EditProject | null>(projectFile(projectRoot, editProjectId), null);
  if (!project) throw new Error(`找不到剪辑工程：${editProjectId}`);
  return project;
}

function chooseInitialMedia(media: EditMediaItem[]): EditMediaItem[] {
  const videos = media.filter((item) => item.kind === "video" && item.authoritative);
  if (videos.length) return videos;
  const images = media.filter((item) => item.kind === "image" && item.authoritative);
  const chosen = new Map<string, EditMediaItem>();
  for (const item of images) if (!chosen.has(item.itemId) || /raw/i.test(path.basename(item.path))) chosen.set(item.itemId, item);
  return [...chosen.values()];
}

function mediaToClip(media: EditMediaItem, trackId: string, startSeconds: number, project?: Pick<EditProject, "fps" | "timebase">): EditClip {
  const duration = media.kind === "video" ? Math.max(0.1, media.durationSeconds ?? 5) : 5;
  const availableDurationFrames = project && Number.isFinite(media.durationSeconds) && (media.durationSeconds ?? 0) > 0
    ? Math.max(1, projectFrameForSeconds(project, media.durationSeconds!))
    : undefined;
  return {
    id: `clip-${randomUUID()}`,
    trackId,
    kind: media.kind,
    name: media.name,
    sourcePath: media.path,
    artifactId: media.artifactId,
    itemId: media.itemId,
    ...(availableDurationFrames ? { sourceAvailableRange: { startFrame: 0, durationFrames: availableDurationFrames } } : {}),
    startSeconds: roundTime(startSeconds),
    durationSeconds: roundTime(duration),
    trimStartSeconds: 0,
    playbackRate: 1,
    volume: 1,
    opacity: 1,
    muted: false,
    positionX: 0,
    positionY: 0,
    scale: 1,
    rotation: 0,
    filter: "none",
    filterIntensity: 1,
    keyframes: [],
  };
}

export async function createEditProject(
  projectRoot: string,
  input: { name?: string; episode?: number; width?: number; height?: number; fps?: number; autoPopulate?: boolean } = {},
): Promise<EditProject> {
  const config = await ensureSidecar(projectRoot);
  const now = new Date().toISOString();
  const id = `edit-${randomUUID()}`;
  const visualTrackId = `track-${randomUUID()}`;
  const initialTimebase = timebaseForFrameRate(input.fps ?? 24);
  const projectTime = { fps: initialTimebase.fps, timebase: { rateNumerator: initialTimebase.rateNumerator, rateDenominator: initialTimebase.rateDenominator } };
  const tracks: EditTrack[] = [
    { id: visualTrackId, kind: "visual", name: "主画面", order: 0, locked: false, muted: false, hidden: false, clips: [] },
    { id: `track-${randomUUID()}`, kind: "audio", name: "配音 / 音乐", order: 1, locked: false, muted: false, hidden: false, clips: [] },
    { id: `track-${randomUUID()}`, kind: "subtitle", name: "字幕", order: 2, locked: false, muted: false, hidden: false, clips: [] },
  ];
  if (input.autoPopulate !== false) {
    const selected = chooseInitialMedia(await listEditMedia(projectRoot, input.episode));
    let cursor = 0;
    for (const media of selected) {
      const clip = mediaToClip(media, visualTrackId, cursor, projectTime);
      tracks[0]!.clips.push(clip);
      cursor = clipEnd(clip);
    }
  }
  const project: EditProject = {
    schemaVersion: 1,
    id,
    projectId: config.id,
    name: safeName(input.name ?? (input.episode ? `EP${String(input.episode).padStart(2, "0")} 成片` : "全片剪辑")),
    episode: input.episode,
    width: input.width ?? 1080,
    height: input.height ?? 1920,
    fps: initialTimebase.fps,
    timebase: { rateNumerator: initialTimebase.rateNumerator, rateDenominator: initialTimebase.rateDenominator },
    backgroundColor: "#000000",
    tracks,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const normalized = await validateEditProject(projectRoot, project);
  await writeJsonAtomic(projectFile(projectRoot, id), normalized);
  await saveEditHistory(projectRoot, id, { schemaVersion: 1, past: [], future: [], updatedAt: now });
  await appendEvent(projectRoot, { actor: "user", type: "editor.project-created", data: { editProjectId: id, episode: input.episode, clips: tracks[0]!.clips.length } });
  return normalized;
}

interface EditValidationOptions {
  pathStack?: string[];
  depth?: number;
  resolvedProjectIds?: Set<string>;
  expandedClipCount?: { value: number };
}

function validateEditTransitions(project: EditProject): void {
  const mainVisual = project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0];
  for (const track of project.tracks) {
    const clips = track.clips.slice().sort((left, right) => editClipStartFrame(project, left) - editClipStartFrame(project, right));
    for (const [index, clip] of clips.entries()) {
      if (clip.transitionOut !== "smpte_dissolve") {
        if (clip.transition) throw new Error(`${clip.name} 不是 SMPTE Dissolve，却携带标准转场身份。`);
        if (clip.transitionOut === "fade" && track.id !== mainVisual?.id) throw new Error(`${clip.name} 的背景淡变只支持主视觉轨。`);
        continue;
      }
      if (track.id !== mainVisual?.id || track.kind !== "visual") throw new Error(`${clip.name} 的 SMPTE Dissolve 只支持最低 order 主视觉轨。`);
      const transition = clip.transition;
      if (!transition || transition.contract !== OTIO_TRANSITION_CONTRACT || transition.kind !== "smpte_dissolve") throw new Error(`${clip.name} 缺少受支持的 SMPTE Dissolve 结构化合同。`);
      const target = clips[index + 1];
      if (!target || target.id !== transition.targetClipId) throw new Error(`${clip.name} 的 SMPTE Dissolve 目标不是同轨紧邻后继片段。`);
      if (clip.kind !== "video" || target.kind !== "video" || clip.muted || target.muted) throw new Error(`${clip.name} 的 SMPTE Dissolve 只支持两个启用的普通视频片段。`);
      if (editClipStartFrame(project, target) !== editClipStartFrame(project, clip) + editClipDurationFrames(project, clip)) throw new Error(`${clip.name} 的 SMPTE Dissolve 相邻片段必须共享同一整数帧切点。`);
      const { inOffsetFrames, outOffsetFrames } = transition;
      if (!Number.isSafeInteger(inOffsetFrames) || !Number.isSafeInteger(outOffsetFrames) || inOffsetFrames < 1 || outOffsetFrames < 1) throw new Error(`${clip.name} 的 SMPTE Dissolve in/out offset 必须是正安全整数帧。`);
      if (inOffsetFrames > editClipDurationFrames(project, clip) || outOffsetFrames > editClipDurationFrames(project, target)) throw new Error(`${clip.name} 的 SMPTE Dissolve offset 超过相邻片段可见时长。`);
      if (clip.playbackRate !== 1 || target.playbackRate !== 1) throw new Error(`${clip.name} 的首版 SMPTE Dissolve 不支持与 LinearTimeWarp 组合。`);
      if ((clip.keyframes?.length ?? 0) || (target.keyframes?.length ?? 0)) throw new Error(`${clip.name} 的首版 SMPTE Dissolve 不支持变换关键帧组合。`);
      if ((clip.fadeInSeconds ?? 0) || (clip.fadeOutSeconds ?? 0) || (target.fadeInSeconds ?? 0) || (target.fadeOutSeconds ?? 0)) throw new Error(`${clip.name} 的首版 SMPTE Dissolve 不支持淡入淡出包络组合。`);
      if ((clip.transitionDurationSeconds ?? 0) !== 0) throw new Error(`${clip.name} 的 SMPTE Dissolve 只能使用整数帧 in/out offset，不能携带旧秒制时长。`);
      const outgoingAvailable = clip.sourceAvailableRange;
      const incomingAvailable = target.sourceAvailableRange;
      if (!outgoingAvailable || !incomingAvailable) throw new Error(`${clip.name} 的 SMPTE Dissolve 缺少可证明的媒体 available_range。`);
      if (outgoingAvailable.startFrame !== 0 || incomingAvailable.startFrame !== 0) throw new Error(`${clip.name} 的 SMPTE Dissolve v1 只支持从本地媒体起点开始的 available_range。`);
      const outgoingRequiredEnd = (clip.trimStartFrame ?? 0) + editClipDurationFrames(project, clip) + outOffsetFrames;
      const incomingRequiredStart = (target.trimStartFrame ?? 0) - inOffsetFrames;
      if (sourceRangeEnd(outgoingAvailable) < outgoingRequiredEnd) throw new Error(`${clip.name} 的 SMPTE Dissolve 尾部 post-roll handle 不足。`);
      if (incomingAvailable.startFrame > incomingRequiredStart || incomingRequiredStart < 0) throw new Error(`${clip.name} 的 SMPTE Dissolve 头部 pre-roll handle 不足。`);
      const previous = clips[index - 1];
      if (previous?.transitionOut === "smpte_dissolve" && previous.transition?.targetClipId === clip.id) {
        if (previous.transition.outOffsetFrames + inOffsetFrames > editClipDurationFrames(project, clip)) throw new Error(`${clip.name} 两端的 SMPTE Dissolve 时域发生重叠。`);
      }
    }
  }
}

function authoritativeClipFrame(project: Pick<EditProject, "fps" | "timebase">, stored: number | undefined, seconds: number, minimum: number): number {
  const fromSeconds = projectFrameForSeconds(project, seconds);
  if (stored === undefined || !Number.isSafeInteger(stored) || stored < minimum) return Math.max(minimum, fromSeconds);
  const storedSeconds = projectSecondsForFrame(project, stored);
  return Math.abs(storedSeconds - roundTime(seconds)) <= .001 ? stored : Math.max(minimum, fromSeconds);
}

async function validateEditProject(projectRoot: string, project: EditProject, options: EditValidationOptions = {}): Promise<EditProject> {
  if (!project.id || !project.projectId) throw new Error("剪辑工程缺少 ID。");
  if (!Number.isInteger(project.width) || project.width < 256 || project.width > 7_680) throw new Error("画面宽度必须是 256–7680 的整数。");
  if (!Number.isInteger(project.height) || project.height < 256 || project.height > 7_680) throw new Error("画面高度必须是 256–7680 的整数。");
  const normalizedTimebase = normalizedProjectTimebase(project);
  project.fps = normalizedTimebase.fps;
  project.timebase = { rateNumerator: normalizedTimebase.rateNumerator, rateDenominator: normalizedTimebase.rateDenominator };
  const frameRate = projectFrameRate(project);
  if (!/^#[0-9a-f]{6}$/i.test(project.backgroundColor)) throw new Error("背景色必须是六位十六进制颜色。");
  if (!project.tracks.length || project.tracks.length > MAX_TRACKS) throw new Error(`轨道数量必须为 1–${MAX_TRACKS}。`);
  const allClips = project.tracks.flatMap((track) => track.clips);
  if (allClips.length > MAX_CLIPS) throw new Error(`单个剪辑工程最多允许 ${MAX_CLIPS} 个片段。`);
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const [trackOrder, track] of project.tracks.sort((a, b) => a.order - b.order).entries()) {
    if (!track.id || trackIds.has(track.id)) throw new Error("存在重复或空轨道 ID。");
    trackIds.add(track.id);
    track.order = trackOrder;
    track.name = safeName(track.name);
    track.clips.sort((a, b) => editClipStartFrame(project, a) - editClipStartFrame(project, b) || a.id.localeCompare(b.id));
    let previousEnd = 0;
    for (const clip of track.clips) {
      if (!clip.id || clipIds.has(clip.id)) throw new Error("存在重复或空片段 ID。");
      clipIds.add(clip.id);
      if (clip.trackId !== track.id) throw new Error(`片段 ${clip.name} 的轨道引用不一致。`);
      const kindMatchesTrack = track.kind === "visual" ? ["video", "image", "timeline"].includes(clip.kind) : clip.kind === track.kind;
      if (!kindMatchesTrack) throw new Error(`片段 ${clip.name} 的类型与轨道“${track.name}”不匹配。`);
      if (clip.kind === "timeline") {
        if (!clip.nestedTimeline) throw new Error(`${clip.name} 缺少冻结的嵌套时间线引用。`);
        if (clip.sourcePath || clip.artifactId || clip.itemId) throw new Error(`${clip.name} 的嵌套时间线不能伪装成普通媒体来源。`);
        if (clip.playbackRate !== 1) throw new Error(`${clip.name} 的嵌套时间线播放速率由有理映射决定，不能使用浮点 playbackRate。`);
      } else if (clip.nestedTimeline) throw new Error(`${clip.name} 不是嵌套时间线，却携带冻结引用。`);
      for (const [label, value] of [["开始时间", clip.startSeconds], ["时长", clip.durationSeconds], ["裁切起点", clip.trimStartSeconds], ["播放速率", clip.playbackRate], ["音量", clip.volume], ["透明度", clip.opacity]] as const) {
        if (!Number.isFinite(value)) throw new Error(`${clip.name} 的${label}不是有效数字。`);
      }
      if (clip.startSeconds < 0 || clip.durationSeconds <= 0 || clip.trimStartSeconds < 0 || clip.playbackRate < .1 || clip.playbackRate > 8) throw new Error(`${clip.name} 的时间参数无效；播放速率必须在 0.1–8 之间。`);
      if (clip.kind === "timeline" && ((clip.trimStartFrame ?? 0) !== 0 || clip.trimStartSeconds !== 0)) throw new Error(`${clip.name} 的嵌套源偏移必须只由有理 sourceOffset 表达。`);
      clip.startFrame = authoritativeClipFrame(project, clip.startFrame, clip.startSeconds, 0);
      clip.durationFrames = authoritativeClipFrame(project, clip.durationFrames, clip.durationSeconds, 1);
      clip.trimStartFrame = clip.kind === "timeline" ? 0 : authoritativeClipFrame(project, clip.trimStartFrame, clip.trimStartSeconds, 0);
      clip.startSeconds = roundTime(clip.startFrame / frameRate);
      clip.durationSeconds = roundTime(clip.durationFrames / frameRate);
      clip.trimStartSeconds = roundTime(clip.trimStartFrame / frameRate);
      if (clip.sourceAvailableRange !== undefined) {
        if (!Number.isSafeInteger(clip.sourceAvailableRange.startFrame) || clip.sourceAvailableRange.startFrame < 0 || !Number.isSafeInteger(clip.sourceAvailableRange.durationFrames) || clip.sourceAvailableRange.durationFrames < 1) throw new Error(`${clip.name} 的 source available range 必须是非负起点和正安全整数帧时长。`);
      }
      if (clip.playbackRate !== 1) {
        if (!["video", "audio"].includes(clip.kind)) throw new Error(`${clip.name} 的 LinearTimeWarp 只支持普通视频或音频片段。`);
        if (!clip.sourceAvailableRange) throw new Error(`${clip.name} 的 LinearTimeWarp 缺少可证明的媒体 available_range。`);
        if (clip.sourceAvailableRange.startFrame !== 0) throw new Error(`${clip.name} 的 LinearTimeWarp v1 只支持从本地媒体起点开始的 available_range。`);
        const requiredSourceFrames = exactScaledFrameCount(clip.durationFrames, clip.playbackRate, `${clip.name} 的 LinearTimeWarp`);
        if ((clip.trimStartFrame ?? 0) < clip.sourceAvailableRange.startFrame || (clip.trimStartFrame ?? 0) + requiredSourceFrames > sourceRangeEnd(clip.sourceAvailableRange)) throw new Error(`${clip.name} 的 LinearTimeWarp 超出媒体 available_range。`);
      }
      if (clip.volume < 0 || clip.volume > 4 || clip.opacity < 0 || clip.opacity > 1) throw new Error(`${clip.name} 的音量或透明度超出范围。`);
      if (track.kind === "visual") {
        clip.positionX ??= 0;
        clip.positionY ??= 0;
        clip.scale ??= 1;
        clip.rotation ??= 0;
        clip.filter ??= "none";
        clip.filterIntensity ??= 1;
        clip.keyframes ??= [];
        clip.transitionOut ??= "cut";
        if (![clip.positionX, clip.positionY].every(Number.isFinite)) throw new Error(`${clip.name} 的画面位置必须是有效数字。`);
        if (Math.abs(clip.positionX) > project.width * 4 || Math.abs(clip.positionY) > project.height * 4) throw new Error(`${clip.name} 的画面位置超出安全范围。`);
        if (!Number.isFinite(clip.scale) || clip.scale < 0.02 || clip.scale > 4) throw new Error(`${clip.name} 的缩放必须在 0.02–4 之间。`);
        if (!Number.isFinite(clip.rotation) || Math.abs(clip.rotation) > 3_600) throw new Error(`${clip.name} 的旋转角度无效。`);
        if (!["none", "grayscale", "sepia", "warm", "cool", "vivid", "contrast", "blur"].includes(clip.filter)) throw new Error(`${clip.name} 的滤镜不受支持。`);
        if (!Number.isFinite(clip.filterIntensity) || clip.filterIntensity < 0 || clip.filterIntensity > 2) throw new Error(`${clip.name} 的滤镜强度必须在 0–2 之间。`);
        if (clip.keyframes.length > MAX_KEYFRAMES_PER_CLIP) throw new Error(`${clip.name} 的关键帧不能超过 ${MAX_KEYFRAMES_PER_CLIP} 个。`);
        const keyframeIds = new Set<string>();
        const keyframeFrames = new Set<number>();
        clip.keyframes.sort((a, b) => a.timeSeconds - b.timeSeconds);
        for (const keyframe of clip.keyframes) {
          if (!keyframe.id || keyframeIds.has(keyframe.id)) throw new Error(`${clip.name} 存在重复或空关键帧 ID。`);
          keyframeIds.add(keyframe.id);
          if (!Number.isFinite(keyframe.timeSeconds) || keyframe.timeSeconds < 0 || keyframe.timeSeconds > clip.durationSeconds) throw new Error(`${clip.name} 的关键帧时间超出片段范围。`);
          if (![keyframe.positionX, keyframe.positionY, keyframe.scale, keyframe.rotation].every(Number.isFinite)) throw new Error(`${clip.name} 的关键帧包含无效数值。`);
          if (Math.abs(keyframe.positionX) > project.width * 4 || Math.abs(keyframe.positionY) > project.height * 4) throw new Error(`${clip.name} 的关键帧画面位置超出安全范围。`);
          if (keyframe.scale < 0.02 || keyframe.scale > 4) throw new Error(`${clip.name} 的关键帧缩放超出范围。`);
          if (Math.abs(keyframe.rotation) > 3_600) throw new Error(`${clip.name} 的关键帧旋转角度无效。`);
          keyframe.easing ??= "linear";
          const curveIssue = editKeyframeCurveIssue(keyframe.easing, keyframe.bezier);
          if (curveIssue) throw new Error(`${clip.name} 的${curveIssue}`);
          if (keyframe.easing === "cubic_bezier") keyframe.bezier = normalizeEditCubicBezier(keyframe.bezier!);
          const sourceTransformIssue = editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
          if (sourceTransformIssue) throw new Error(`${clip.name} 的${sourceTransformIssue}`);
          if (keyframe.sourceTransform) {
            keyframe.sourceTransform = {
              start: Object.fromEntries(EDIT_TRANSFORM_PROPERTIES.map((property) => [property, roundTransform(keyframe.sourceTransform!.start[property])])) as unknown as EditKeyframeSourceTransform["start"],
              end: Object.fromEntries(EDIT_TRANSFORM_PROPERTIES.map((property) => [property, roundTransform(keyframe.sourceTransform!.end[property])])) as unknown as EditKeyframeSourceTransform["end"],
            };
            for (const anchor of [keyframe.sourceTransform.start, keyframe.sourceTransform.end]) {
              if (Math.abs(anchor.positionX) > project.width * 4 || Math.abs(anchor.positionY) > project.height * 4) throw new Error(`${clip.name} 的派生关键帧 sourceTransform 画面位置超出安全范围。`);
              if (anchor.scale < .02 || anchor.scale > 4) throw new Error(`${clip.name} 的派生关键帧 sourceTransform 缩放超出范围。`);
              if (Math.abs(anchor.rotation) > 3_600) throw new Error(`${clip.name} 的派生关键帧 sourceTransform 旋转角度无效。`);
            }
          }
          keyframe.frame = Math.max(0, Math.min(clip.durationFrames, Math.round(keyframe.timeSeconds * frameRate)));
          if (keyframeFrames.has(keyframe.frame)) throw new Error(`${clip.name} 存在量化到同一帧 F${keyframe.frame} 的重复关键帧。`);
          keyframeFrames.add(keyframe.frame);
          keyframe.timeSeconds = roundTime(keyframe.frame / frameRate);
          keyframe.positionX = roundTransform(keyframe.positionX);
          keyframe.positionY = roundTransform(keyframe.positionY);
          keyframe.scale = roundTransform(keyframe.scale);
          keyframe.rotation = roundTransform(keyframe.rotation);
        }
        clip.keyframes.sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
        for (const [index, keyframe] of clip.keyframes.entries()) {
          if (keyframe.bezier?.mode !== "derived_monotone") continue;
          const previous = clip.keyframes[index - 1];
          const previousFrame = previous?.frame ?? 0;
          const segmentFrames = keyframe.frame! - previousFrame;
          if (segmentFrames < 1) throw new Error(`${clip.name} 的派生关键帧必须位于有效入段终点。`);
          const source = keyframe.bezier.sourceWindow!;
          if (source.endFrame! - source.startFrame! !== segmentFrames) throw new Error(`${clip.name} 的派生关键帧 sourceWindow 与入段长度不一致。`);
          const actualStart = previous ?? { positionX: clip.positionX!, positionY: clip.positionY!, scale: clip.scale!, rotation: clip.rotation! };
          const semanticStart = evaluateEditKeyframeSourceTransformAtFrame(keyframe, 0, segmentFrames);
          const semanticEnd = evaluateEditKeyframeSourceTransformAtFrame(keyframe, segmentFrames, segmentFrames);
          if (EDIT_TRANSFORM_PROPERTIES.some((property) => Math.abs(semanticStart[property] - actualStart[property]) > 1e-9 || Math.abs(semanticEnd[property] - keyframe[property]) > 1e-9)) throw new Error(`${clip.name} 的派生关键帧 sourceTransform 与当前片段边界不一致。`);
        }
      } else if ((clip.keyframes?.length ?? 0) > 0) throw new Error(`${clip.name} 的 transform 关键帧只支持视觉片段。`);
      for (const fade of [clip.fadeInSeconds ?? 0, clip.fadeOutSeconds ?? 0]) if (!Number.isFinite(fade) || fade < 0 || fade > clip.durationSeconds) throw new Error(`${clip.name} 的淡入淡出时长无效。`);
      if (clip.transitionOut && !["cut", "fade", "smpte_dissolve"].includes(clip.transitionOut)) throw new Error(`${clip.name} 的转场类型不受支持。`);
      if (clip.transitionOut === "fade" && (!Number.isFinite(clip.transitionDurationSeconds) || (clip.transitionDurationSeconds ?? 0) <= 0 || (clip.transitionDurationSeconds ?? 0) > Math.min(3, clip.durationSeconds / 2))) throw new Error(`${clip.name} 的淡出转场时长无效。`);
      if (clip.kind === "subtitle") {
        if (!clip.text?.trim()) throw new Error(`${clip.name} 的字幕内容为空。`);
        if (clip.fontSize !== undefined && (!Number.isFinite(clip.fontSize) || clip.fontSize < 12 || clip.fontSize > 200)) throw new Error(`${clip.name} 的字幕字号无效。`);
      }
      if (clip.startSeconds + 0.001 < previousEnd) throw new Error(`轨道“${track.name}”中的片段发生重叠：${clip.name}`);
      if (["video", "image", "audio"].includes(clip.kind)) {
        if (!clip.sourcePath || !path.isAbsolute(clip.sourcePath)) throw new Error(`${clip.name} 缺少绝对素材路径。`);
        await access(clip.sourcePath, fsConstants.R_OK).catch(() => { throw new Error(`素材不存在或不可读：${clip.sourcePath}`); });
      }
      clip.name = safeName(clip.name);
      clip.startSeconds = roundTime(clip.startSeconds);
      clip.durationSeconds = roundTime(clip.durationSeconds);
      clip.trimStartSeconds = roundTime(clip.trimStartSeconds);
      clip.playbackRate = roundTime(clip.playbackRate);
      clip.volume = roundTime(clip.volume);
      clip.opacity = roundTime(clip.opacity);
      if (clip.positionX !== undefined) clip.positionX = roundTransform(clip.positionX);
      if (clip.positionY !== undefined) clip.positionY = roundTransform(clip.positionY);
      if (clip.scale !== undefined) clip.scale = roundTransform(clip.scale);
      if (clip.rotation !== undefined) clip.rotation = roundTransform(clip.rotation);
      if (clip.filterIntensity !== undefined) clip.filterIntensity = roundTime(clip.filterIntensity);
      if (clip.fadeInSeconds !== undefined) clip.fadeInSeconds = roundTime(clip.fadeInSeconds);
      if (clip.fadeOutSeconds !== undefined) clip.fadeOutSeconds = roundTime(clip.fadeOutSeconds);
      if (clip.transitionDurationSeconds !== undefined) clip.transitionDurationSeconds = roundTime(clip.transitionDurationSeconds);
      previousEnd = clipEnd(clip);
    }
  }
  validateEditTransitions(project);
  await validateNestedTimelineDependencies(projectRoot, project, options);
  return project;
}

interface EditProjectDependencySnapshot {
  schemaVersion: 1;
  project: EditProject;
}

interface PreparedNestedDependency {
  snapshot: EditProjectDependencySnapshot;
  snapshotSha256: string;
}

function dependencySnapshotFile(projectRoot: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("嵌套时间线快照 SHA-256 格式无效。");
  return path.join(getSidecarPaths(projectRoot).editorDependencies, `${sha256}.json`);
}

async function readEditProjectDependencySnapshot(projectRoot: string, sha256: string): Promise<EditProjectDependencySnapshot> {
  const filePath = dependencySnapshotFile(projectRoot, sha256);
  const snapshot = await readJson<EditProjectDependencySnapshot | null>(filePath, null).catch((error) => {
    throw new Error(`嵌套时间线快照损坏或不可读：${filePath}`, { cause: error });
  });
  if (!snapshot) throw new Error(`嵌套时间线快照缺失：${filePath}`);
  if (snapshot.schemaVersion !== 1 || !snapshot.project || typeof snapshot.project !== "object") throw new Error(`嵌套时间线快照结构无效：${filePath}`);
  const actual = sha256Json(snapshot);
  if (actual !== sha256) throw new Error(`嵌套时间线快照哈希不一致：期望 ${sha256}，实际 ${actual}。`);
  return snapshot;
}

function sourceStepForTimebases(parent: Pick<EditProject, "fps" | "timebase">, child: Pick<EditProject, "fps" | "timebase">): EditRationalFrame {
  const parentTimebase = normalizedProjectTimebase(parent);
  const childTimebase = normalizedProjectTimebase(child);
  return rationalFromBigInt(
    BigInt(childTimebase.rateNumerator) * BigInt(parentTimebase.rateDenominator),
    BigInt(childTimebase.rateDenominator) * BigInt(parentTimebase.rateNumerator),
  );
}

function validateNestedReferenceAgainstSnapshot(parent: EditProject, clip: EditClip, snapshot: EditProjectDependencySnapshot): void {
  const reference = clip.nestedTimeline!;
  const child = snapshot.project;
  if (reference.contract !== NESTED_TIMELINE_CONTRACT) throw new Error(`${clip.name} 的嵌套时间线合同不受支持。`);
  if (reference.ownerProjectId !== parent.projectId || child.projectId !== parent.projectId) throw new Error(`${clip.name} 引用了不同 AI Canvas 项目的子时间线。`);
  if (reference.childEditProjectId !== child.id || reference.childEditProjectRevision !== child.revision) throw new Error(`${clip.name} 的嵌套时间线身份或修订与冻结快照不一致。`);
  const childTimebase = normalizedProjectTimebase(child);
  if (reference.childTimebase.rateNumerator !== childTimebase.rateNumerator || reference.childTimebase.rateDenominator !== childTimebase.rateDenominator) throw new Error(`${clip.name} 的子时间线 timebase 与冻结快照不一致。`);
  if (reference.childCanvas.width !== child.width || reference.childCanvas.height !== child.height) throw new Error(`${clip.name} 的子时间线画布与冻结快照不一致。`);
  const childDurationFrames = renderDurationFrames(child);
  if (reference.childDurationFrames !== childDurationFrames || childDurationFrames < 1) throw new Error(`${clip.name} 的子时间线持续时间与冻结快照不一致。`);
  const range = reference.sourceRange;
  if (!Number.isSafeInteger(range?.startFrame) || !Number.isSafeInteger(range?.durationFrames) || range.startFrame < 0 || range.durationFrames < 1 || range.startFrame + range.durationFrames > childDurationFrames) throw new Error(`${clip.name} 的嵌套源区间超出冻结子时间线范围。`);
  reference.sourceOffset = normalizeEditRational(reference.sourceOffset, `${clip.name} 的嵌套 sourceOffset`);
  reference.sourceStep = normalizeEditRational(reference.sourceStep, `${clip.name} 的嵌套 sourceStep`);
  const expectedStep = sourceStepForTimebases(parent, child);
  if (compareEditRational(reference.sourceStep, expectedStep) !== 0) throw new Error(`${clip.name} 的嵌套时间基映射与父子 timebase 不一致。`);
  if (compareEditRational(reference.sourceOffset, rationalForInteger(0)) < 0) throw new Error(`${clip.name} 的嵌套 sourceOffset 不能为负。`);
  const offsetParentFrames = rationalQuotientInteger(reference.sourceOffset, reference.sourceStep, `${clip.name} 的嵌套 sourceOffset`);
  const mappedDurationFrames = ceilPositiveRationalDivision(range.durationFrames, reference.sourceStep);
  if (!Number.isSafeInteger(reference.mappedDurationFrames) || reference.mappedDurationFrames !== mappedDurationFrames) throw new Error(`${clip.name} 的嵌套映射总时长不一致。`);
  if (offsetParentFrames + editClipDurationFrames(parent, clip) > mappedDurationFrames) throw new Error(`${clip.name} 的父片段时长超出冻结嵌套源范围。`);
  const lastSample = addEditRational(reference.sourceOffset, rationalTimesInteger(reference.sourceStep, editClipDurationFrames(parent, clip) - 1));
  if (compareEditRational(lastSample, rationalForInteger(range.durationFrames)) >= 0) throw new Error(`${clip.name} 的末帧采样超出冻结嵌套源范围。`);
}

async function validateNestedTimelineDependencies(projectRoot: string, project: EditProject, options: EditValidationOptions): Promise<void> {
  const pathStack = options.pathStack ?? [project.id];
  const depth = options.depth ?? 0;
  const resolvedProjectIds = options.resolvedProjectIds ?? new Set<string>();
  const expandedClipCount = options.expandedClipCount ?? { value: 0 };
  resolvedProjectIds.add(project.id);
  if (resolvedProjectIds.size > MAX_RESOLVED_EDIT_PROJECTS) throw new Error(`嵌套时间线展开工程数超过 ${MAX_RESOLVED_EDIT_PROJECTS}。`);
  expandedClipCount.value += project.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  if (expandedClipCount.value > MAX_EXPANDED_EDIT_CLIPS) throw new Error(`嵌套时间线展开片段数超过 ${MAX_EXPANDED_EDIT_CLIPS}。`);
  for (const clip of project.tracks.flatMap((track) => track.clips).filter((entry) => entry.kind === "timeline")) {
    const reference = clip.nestedTimeline!;
    if (reference.childEditProjectId === project.id) throw new Error(`${clip.name} 不能引用自身剪辑工程。`);
    if (pathStack.includes(reference.childEditProjectId)) throw new Error(`检测到嵌套时间线循环：${[...pathStack, reference.childEditProjectId].join(" → ")}`);
    if (depth + 1 > MAX_NESTED_TIMELINE_DEPTH) throw new Error(`嵌套时间线深度超过 ${MAX_NESTED_TIMELINE_DEPTH}。`);
    const snapshot = await readEditProjectDependencySnapshot(projectRoot, reference.childSnapshotSha256);
    validateNestedReferenceAgainstSnapshot(project, clip, snapshot);
    const current = await getEditProject(projectRoot, reference.childEditProjectId).catch(() => undefined);
    if (!current) throw new Error(`${clip.name} 的子时间线项目已缺失。`);
    if (current.revision !== reference.childEditProjectRevision) throw new Error(`${clip.name} 的子时间线修订已漂移：冻结 r${reference.childEditProjectRevision}，当前 r${current.revision}；请显式刷新。`);
    const currentSha256 = sha256Json({ schemaVersion: 1, project: current } satisfies EditProjectDependencySnapshot);
    if (currentSha256 !== reference.childSnapshotSha256) throw new Error(`${clip.name} 的子时间线内容哈希已漂移；请显式刷新。`);
    await validateEditProject(projectRoot, structuredClone(snapshot.project), {
      pathStack: [...pathStack, reference.childEditProjectId],
      depth: depth + 1,
      resolvedProjectIds,
      expandedClipCount,
    });
  }
}

async function prepareNestedDependencySnapshot(projectRoot: string, childEditProjectId: string, expectedRevision: number): Promise<PreparedNestedDependency> {
  return withProjectLock(projectRoot, editProjectLockName(childEditProjectId), async () => {
    const current = await getEditProject(projectRoot, childEditProjectId);
    if (current.revision !== expectedRevision) throw new RejectedCommandFailure(`子时间线已被其他窗口更新（当前修订 ${current.revision}），请重新读取后重试。`, { schemaVersion: 1, applied: false, reason: "revision_conflict", editProjectId: childEditProjectId, expectedRevision, currentRevision: current.revision });
    const project = await validateEditProject(projectRoot, structuredClone(current), { pathStack: [current.id] });
    const snapshot: EditProjectDependencySnapshot = { schemaVersion: 1, project };
    const snapshotSha256 = sha256Json(snapshot);
    await writeJsonAtomicExclusive(dependencySnapshotFile(projectRoot, snapshotSha256), snapshot);
    await readEditProjectDependencySnapshot(projectRoot, snapshotSha256);
    return { snapshot, snapshotSha256 };
  });
}

interface EditTimelineRenderPlan {
  schemaVersion: 1;
  contract: typeof NESTED_RENDER_CONTRACT;
  rootEditProjectId: string;
  rootEditProjectRevision: number;
  rootProjectSha256: string;
  dependencyManifestSha256: string;
  dependencyRefs: EditRenderDependencyRef[];
}

interface ResolvedEditTimeline {
  rootProject: EditProject;
  snapshots: Map<string, EditProjectDependencySnapshot>;
  dependencyRefs: EditRenderDependencyRef[];
  dependencyManifestSha256: string;
  renderPlanSha256: string;
  renderPlanPath: string;
  resolvedProject?: EditProject;
}

interface ActiveTimelineLineage {
  sourceClipRefs: NonNullable<TimelineFrameExtraction["sourceClipRefs"]>;
  sourceClipIds: string[];
  sourceArtifactIds: string[];
  sourceItemIds: string[];
}

function collectActiveTimelineLineage(resolved: ResolvedEditTimeline, rootFrame: number): ActiveTimelineLineage {
  const refs = new Map<string, NonNullable<TimelineFrameExtraction["sourceClipRefs"]>[number]>();
  const artifactIds = new Set<string>();
  const itemIds = new Set<string>();
  const visit = (project: EditProject, frame: number): void => {
    for (const track of project.tracks.filter((entry) => !entry.hidden && !entry.muted)) for (const clip of track.clips) {
      const startFrame = editClipStartFrame(project, clip);
      const durationFrames = editClipDurationFrames(project, clip);
      if (clip.muted || frame < startFrame || frame >= startFrame + durationFrames) continue;
      const key = `${project.id}:${project.revision}:${clip.id}`;
      refs.set(key, { editProjectId: project.id, editProjectRevision: project.revision, clipId: clip.id });
      if (clip.artifactId) artifactIds.add(clip.artifactId);
      if (clip.itemId) itemIds.add(clip.itemId);
      if (clip.kind !== "timeline" || !clip.nestedTimeline) continue;
      const reference = clip.nestedTimeline;
      const snapshot = resolved.snapshots.get(reference.childSnapshotSha256);
      if (!snapshot) throw new Error(`嵌套时间线血缘缺少冻结快照：${reference.childSnapshotSha256}`);
      const localFrame = frame - startFrame;
      const childCoordinate = addEditRational(
        rationalForInteger(reference.sourceRange.startFrame),
        addEditRational(reference.sourceOffset, rationalTimesInteger(reference.sourceStep, localFrame)),
      );
      visit(snapshot.project, floorEditRational(childCoordinate));
    }
  };
  visit(resolved.rootProject, rootFrame);
  const sourceClipRefs = [...refs.values()].sort((left, right) => left.editProjectId.localeCompare(right.editProjectId) || left.clipId.localeCompare(right.clipId));
  return {
    sourceClipRefs,
    sourceClipIds: [...new Set(sourceClipRefs.map((entry) => entry.clipId))],
    sourceArtifactIds: [...artifactIds].sort(),
    sourceItemIds: [...itemIds].sort(),
  };
}

async function collectResolvedEditTimeline(projectRoot: string, rootProject: EditProject): Promise<ResolvedEditTimeline> {
  const validatedRoot = await validateEditProject(projectRoot, structuredClone(rootProject));
  const snapshots = new Map<string, EditProjectDependencySnapshot>();
  const depthBySnapshot = new Map<string, number>();
  const visit = async (project: EditProject, depth: number): Promise<void> => {
    for (const clip of project.tracks.flatMap((track) => track.clips).filter((entry) => entry.kind === "timeline")) {
      const reference = clip.nestedTimeline!;
      const snapshot = await readEditProjectDependencySnapshot(projectRoot, reference.childSnapshotSha256);
      snapshots.set(reference.childSnapshotSha256, snapshot);
      const currentDepth = depthBySnapshot.get(reference.childSnapshotSha256);
      if (currentDepth === undefined || depth + 1 < currentDepth) depthBySnapshot.set(reference.childSnapshotSha256, depth + 1);
      await visit(snapshot.project, depth + 1);
    }
  };
  await visit(validatedRoot, 0);
  const dependencyRefs = [...snapshots.entries()].map(([snapshotSha256, snapshot]) => ({
    editProjectId: snapshot.project.id,
    revision: snapshot.project.revision,
    snapshotSha256,
    depth: depthBySnapshot.get(snapshotSha256) ?? 1,
  })).sort((left, right) => left.depth - right.depth || left.editProjectId.localeCompare(right.editProjectId) || left.snapshotSha256.localeCompare(right.snapshotSha256));
  const dependencyManifestSha256 = sha256Json({ contract: NESTED_TIMELINE_CONTRACT, dependencies: dependencyRefs });
  const plan: EditTimelineRenderPlan = {
    schemaVersion: 1,
    contract: NESTED_RENDER_CONTRACT,
    rootEditProjectId: validatedRoot.id,
    rootEditProjectRevision: validatedRoot.revision,
    rootProjectSha256: sha256Json(validatedRoot),
    dependencyManifestSha256,
    dependencyRefs,
  };
  const renderPlanSha256 = sha256Json(plan);
  const renderPlanPath = path.join(getSidecarPaths(projectRoot).editorRenderPlans, `${renderPlanSha256}.json`);
  await writeJsonAtomicExclusive(renderPlanPath, plan);
  return { rootProject: validatedRoot, snapshots, dependencyRefs, dependencyManifestSha256, renderPlanSha256, renderPlanPath };
}

async function collectEditDependencySnapshots(projectRoot: string, project: EditProject): Promise<Map<string, EditProjectDependencySnapshot>> {
  const snapshots = new Map<string, EditProjectDependencySnapshot>();
  const visit = async (current: EditProject): Promise<void> => {
    for (const clip of current.tracks.flatMap((track) => track.clips).filter((entry) => entry.kind === "timeline")) {
      const snapshotSha256 = clip.nestedTimeline!.childSnapshotSha256;
      if (snapshots.has(snapshotSha256)) continue;
      const snapshot = await readEditProjectDependencySnapshot(projectRoot, snapshotSha256);
      snapshots.set(snapshotSha256, snapshot);
      await visit(snapshot.project);
    }
  };
  await visit(project);
  return snapshots;
}

async function materializeNestedMappedProxy(
  projectRoot: string,
  engine: VideoEngineInfo & { ffmpegPath: string },
  parent: EditProject,
  child: EditProject,
  childProjectProxyPath: string,
  reference: EditNestedTimelineRef,
): Promise<string> {
  const parentTimebase = normalizedProjectTimebase(parent);
  const childTimebase = normalizedProjectTimebase(child);
  const cacheKey = sha256Json({ contract: `${NESTED_RENDER_CONTRACT}.mapped.frames-v2`, childProjectProxyPath: path.basename(childProjectProxyPath), reference: { ...reference, sourceOffset: undefined }, parentTimebase });
  const target = path.join(getSidecarPaths(projectRoot).editorNestedCache, `mapped-${cacheKey}.mkv`);
  return withProjectLock(projectRoot, `nested-cache-${cacheKey}`, async () => {
    if (await renderedOutputValid(projectRoot, target)) return target;
    await unlink(target).catch(() => undefined);
    const temporary = path.join(getSidecarPaths(projectRoot).editorNestedCache, `.mapped-${cacheKey}-${randomUUID()}.mkv`);
    const startSample = timelineAudioSampleForFrame(child, reference.sourceRange.startFrame);
    const endSample = timelineAudioSampleForFrame(child, reference.sourceRange.startFrame + reference.sourceRange.durationFrames);
    const outputSamples = timelineAudioSampleForFrame(parent, reference.mappedDurationFrames);
    const frameRate = `${parentTimebase.rateNumerator}/${parentTimebase.rateDenominator}`;
    const filter = [
      `[0:v]trim=start_frame=${reference.sourceRange.startFrame}:end_frame=${reference.sourceRange.startFrame + reference.sourceRange.durationFrames},settb=expr=${childTimebase.rateDenominator}/${childTimebase.rateNumerator},setpts=N,fps=fps=${frameRate}:round=up:start_time=0,tpad=stop_mode=clone:stop=-1,trim=end_frame=${reference.mappedDurationFrames},setpts=PTS-STARTPTS[v]`,
      `[0:a]aresample=48000,atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${outputSamples}[a]`,
    ].join(";");
    const args = ["-hide_banner", "-loglevel", "warning", "-i", childProjectProxyPath, "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "ffv1", "-level", "3", "-g", "1", "-pix_fmt", "yuv420p", "-r", frameRate, "-c:a", "pcm_s16le", "-n", temporary];
    const result = await runProcess(projectRoot, engine.ffmpegPath, args, { tool: "ffmpeg", stage: "nested-range-cache", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 30 * 60_000), maxOutputBytes: MAX_RENDER_LOG });
    if (result.status !== "succeeded") {
      await unlink(temporary).catch(() => undefined);
      throw new Error(result.status === "timed_out" ? "嵌套时间线范围缓存生成超时。" : result.output.trim().split("\n").slice(-12).join("\n") || "嵌套时间线范围缓存生成失败。 ");
    }
    if (!(await renderedOutputValid(projectRoot, temporary))) {
      await unlink(temporary).catch(() => undefined);
      throw new Error("嵌套时间线范围缓存未通过 FFprobe 完整性检查。 ");
    }
    await rename(temporary, target);
    return target;
  });
}

async function materializeResolvedProjectProxy(
  projectRoot: string,
  engine: VideoEngineInfo & { ffmpegPath: string },
  project: EditProject,
  resolved: ResolvedEditTimeline,
): Promise<string> {
  const cacheKey = sha256Json({ contract: `${NESTED_RENDER_CONTRACT}.project`, project });
  const target = path.join(getSidecarPaths(projectRoot).editorNestedCache, `project-${cacheKey}.mkv`);
  return withProjectLock(projectRoot, `nested-cache-${cacheKey}`, async () => {
    if (await renderedOutputValid(projectRoot, target)) return target;
    await unlink(target).catch(() => undefined);
    const temporary = path.join(getSidecarPaths(projectRoot).editorNestedCache, `.project-${cacheKey}-${randomUUID()}.mkv`);
    const overlays = await createSubtitleOverlays(project, path.join(getSidecarPaths(projectRoot).editorNestedCache, "overlays", cacheKey));
    const args = buildFfmpegArgs(project, temporary, overlays, { lossless: true });
    const result = await runProcess(projectRoot, engine.ffmpegPath, args, { tool: "ffmpeg", stage: "nested-project-cache", weight: MEDIA_WEIGHTS.render, timeoutMs: mediaStageTimeout("ffmpeg", 30 * 60_000), maxOutputBytes: MAX_RENDER_LOG });
    if (result.status !== "succeeded") {
      await unlink(temporary).catch(() => undefined);
      throw new Error(result.status === "timed_out" ? "嵌套子工程无损合成超时。" : result.output.trim().split("\n").slice(-12).join("\n") || "嵌套子工程无损合成失败。 ");
    }
    if (!(await renderedOutputValid(projectRoot, temporary))) {
      await unlink(temporary).catch(() => undefined);
      throw new Error("嵌套子工程无损合成未通过 FFprobe 完整性检查。 ");
    }
    await rename(temporary, target);
    return target;
  });
}

async function resolveProjectMediaForRender(
  projectRoot: string,
  engine: VideoEngineInfo & { ffmpegPath: string },
  source: EditProject,
  resolved: ResolvedEditTimeline,
): Promise<EditProject> {
  const project = structuredClone(source);
  for (const clip of project.tracks.flatMap((track) => track.clips).filter((entry) => entry.kind === "timeline")) {
    const reference = clip.nestedTimeline!;
    const snapshot = resolved.snapshots.get(reference.childSnapshotSha256) ?? await readEditProjectDependencySnapshot(projectRoot, reference.childSnapshotSha256);
    const childResolved = await resolveProjectMediaForRender(projectRoot, engine, snapshot.project, resolved);
    const childProxy = await materializeResolvedProjectProxy(projectRoot, engine, childResolved, resolved);
    clip.sourcePath = await materializeNestedMappedProxy(projectRoot, engine, project, childResolved, childProxy, reference);
  }
  return project;
}

async function prepareResolvedEditTimeline(
  projectRoot: string,
  project: EditProject,
  engine: VideoEngineInfo & { ffmpegPath: string },
): Promise<ResolvedEditTimeline> {
  const resolved = await collectResolvedEditTimeline(projectRoot, project);
  resolved.resolvedProject = await resolveProjectMediaForRender(projectRoot, engine, resolved.rootProject, resolved);
  return resolved;
}

async function materializeNestedBrowserPreview(
  projectRoot: string,
  engine: VideoEngineInfo & { ffmpegPath: string },
  mappedProxyPath: string,
  project: EditProject,
): Promise<{ path: string; width: number; height: number }> {
  const timebase = normalizedProjectTimebase(project);
  const width = project.width + project.width % 2;
  const height = project.height + project.height % 2;
  const cacheKey = sha256Json({
    contract: `${NESTED_RENDER_CONTRACT}.browser-preview.v1`,
    mappedProxy: path.basename(mappedProxyPath),
    width,
    height,
    timebase: { rateNumerator: timebase.rateNumerator, rateDenominator: timebase.rateDenominator },
  });
  const target = path.join(getSidecarPaths(projectRoot).editorNestedCache, `preview-${cacheKey}.mp4`);
  return withProjectLock(projectRoot, `nested-cache-${cacheKey}`, async () => {
    if (await renderedOutputValid(projectRoot, target)) return { path: target, width, height };
    await unlink(target).catch(() => undefined);
    const temporary = path.join(getSidecarPaths(projectRoot).editorNestedCache, `.preview-${cacheKey}-${randomUUID()}.mp4`);
    const frameRate = `${timebase.rateNumerator}/${timebase.rateDenominator}`;
    const args = [
      "-hide_banner", "-loglevel", "warning", "-i", mappedProxyPath,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-r", frameRate,
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", temporary,
    ];
    const result = await runProcess(projectRoot, engine.ffmpegPath, args, { tool: "ffmpeg", stage: "nested-browser-preview", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 30 * 60_000), maxOutputBytes: MAX_RENDER_LOG });
    if (result.status !== "succeeded") {
      await unlink(temporary).catch(() => undefined);
      throw new Error(result.status === "timed_out" ? "嵌套时间线浏览器预览生成超时。" : result.output.trim().split("\n").slice(-12).join("\n") || "嵌套时间线浏览器预览生成失败。 ");
    }
    if (!(await renderedOutputValid(projectRoot, temporary))) {
      await unlink(temporary).catch(() => undefined);
      throw new Error("嵌套时间线浏览器预览未通过 FFprobe 完整性检查。 ");
    }
    await rename(temporary, target);
    return { path: target, width, height };
  });
}

async function prepareNestedTimelinePreviewUnlocked(
  projectRoot: string,
  parentEditProjectId: string,
  expectedRevision: number,
  clipId: string,
): Promise<EditNestedTimelinePreview> {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath) throw new Error(engine.issues.join("；") || "FFmpeg 不可用。 ");
  const project = await validateEditProject(projectRoot, structuredClone(await getEditProject(projectRoot, parentEditProjectId)));
  if (project.revision !== expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${project.revision}），请重新载入后准备嵌套预览。`);
  const persistedClip = locateClip(project, clipId).clip;
  if (persistedClip.kind !== "timeline" || !persistedClip.nestedTimeline) throw new Error("只能为嵌套时间线片段准备预览。 ");
  const resolved = await prepareResolvedEditTimeline(projectRoot, project, { ...engine, ffmpegPath: engine.ffmpegPath });
  const resolvedClip = locateClip(resolved.resolvedProject!, clipId).clip;
  if (!resolvedClip.sourcePath) throw new Error("嵌套时间线预览代理没有落盘。 ");
  const browserPreview = await materializeNestedBrowserPreview(projectRoot, { ...engine, ffmpegPath: engine.ffmpegPath }, resolvedClip.sourcePath, project);
  const trimStartFrame = rationalQuotientInteger(persistedClip.nestedTimeline.sourceOffset, persistedClip.nestedTimeline.sourceStep, `${persistedClip.name} 的预览起点`);
  const timebase = normalizedProjectTimebase(project);
  return {
    schemaVersion: 1,
    clipId,
    path: browserPreview.path,
    width: browserPreview.width,
    height: browserPreview.height,
    durationFrames: editClipDurationFrames(project, persistedClip),
    trimStartFrame,
    trimStartSeconds: projectSecondsForFrame(project, trimStartFrame),
    timebase: { rateNumerator: timebase.rateNumerator, rateDenominator: timebase.rateDenominator },
    childEditProjectId: persistedClip.nestedTimeline.childEditProjectId,
    childEditProjectRevision: persistedClip.nestedTimeline.childEditProjectRevision,
    childSnapshotSha256: persistedClip.nestedTimeline.childSnapshotSha256,
    dependencyManifestSha256: resolved.dependencyManifestSha256,
    renderPlanSha256: resolved.renderPlanSha256,
  };
}

export async function prepareNestedTimelinePreview(
  projectRoot: string,
  parentEditProjectId: string,
  expectedRevision: number,
  clipId: string,
): Promise<EditNestedTimelinePreview> {
  return withEditorMediaCapacity(projectRoot, "嵌套时间线预览生成", () => withProjectLock(projectRoot, editProjectLockName(parentEditProjectId), () => prepareNestedTimelinePreviewUnlocked(projectRoot, parentEditProjectId, expectedRevision, clipId)));
}

async function saveEditProjectUnlocked(projectRoot: string, input: EditProject, expectedRevision: number, actor: "user" | "codex"): Promise<EditProject> {
  const current = await getEditProject(projectRoot, input.id);
  if (current.revision !== expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${current.revision}），请重新载入。`);
  if (current.projectId !== input.projectId || current.createdAt !== input.createdAt) throw new Error("不能更改剪辑工程的归属或创建时间。");
  const next = await validateEditProject(projectRoot, structuredClone(input));
  next.name = safeName(next.name);
  next.revision = current.revision;
  next.updatedAt = current.updatedAt;
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
  next.revision = current.revision + 1;
  next.updatedAt = new Date().toISOString();
  const history = await loadEditHistory(projectRoot, next.id);
  history.past.push(current);
  history.future = [];
  await saveEditHistory(projectRoot, next.id, history);
  await writeJsonAtomic(projectFile(projectRoot, next.id), next);
  await appendEvent(projectRoot, { actor, type: "editor.project-saved", data: { editProjectId: next.id, revision: next.revision, clips: next.tracks.reduce((sum, track) => sum + track.clips.length, 0) } });
  return next;
}

export async function saveEditProject(projectRoot: string, input: EditProject, expectedRevision: number, actor: "user" | "codex" = "user"): Promise<EditProject> {
  return withProjectLock(projectRoot, editProjectLockName(input.id), () => saveEditProjectUnlocked(projectRoot, input, expectedRevision, actor));
}

export async function getEditHistoryInfo(projectRoot: string, editProjectId: string): Promise<{ canUndo: boolean; canRedo: boolean; pastCount: number; futureCount: number }> {
  const history = await loadEditHistory(projectRoot, editProjectId);
  return { canUndo: history.past.length > 0, canRedo: history.future.length > 0, pastCount: history.past.length, futureCount: history.future.length };
}

async function undoEditProjectUnlocked(projectRoot: string, editProjectId: string, expectedRevision: number, actor: "user" | "codex"): Promise<EditProject> {
  const current = await getEditProject(projectRoot, editProjectId);
  if (current.revision !== expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${current.revision}），请重新载入后撤销。`);
  const history = await loadEditHistory(projectRoot, editProjectId);
  const previous = history.past.pop();
  if (!previous) throw new Error("剪辑工程没有可撤销的操作。 ");
  history.future.push(current);
  const restored = await validateEditProject(projectRoot, structuredClone(previous));
  restored.revision = current.revision + 1;
  restored.updatedAt = new Date().toISOString();
  await Promise.all([writeJsonAtomic(projectFile(projectRoot, editProjectId), restored), saveEditHistory(projectRoot, editProjectId, history)]);
  await appendEvent(projectRoot, { actor, type: "editor.project-undo", data: { editProjectId, revision: restored.revision, restoredFromRevision: previous.revision } });
  return restored;
}

export async function undoEditProject(projectRoot: string, editProjectId: string, expectedRevision: number, actor: "user" | "codex" = "codex"): Promise<EditProject> {
  return withProjectLock(projectRoot, editProjectLockName(editProjectId), () => undoEditProjectUnlocked(projectRoot, editProjectId, expectedRevision, actor));
}

async function redoEditProjectUnlocked(projectRoot: string, editProjectId: string, expectedRevision: number, actor: "user" | "codex"): Promise<EditProject> {
  const current = await getEditProject(projectRoot, editProjectId);
  if (current.revision !== expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${current.revision}），请重新载入后重做。`);
  const history = await loadEditHistory(projectRoot, editProjectId);
  const next = history.future.pop();
  if (!next) throw new Error("剪辑工程没有可重做的操作。 ");
  history.past.push(current);
  const restored = await validateEditProject(projectRoot, structuredClone(next));
  restored.revision = current.revision + 1;
  restored.updatedAt = new Date().toISOString();
  await Promise.all([writeJsonAtomic(projectFile(projectRoot, editProjectId), restored), saveEditHistory(projectRoot, editProjectId, history)]);
  await appendEvent(projectRoot, { actor, type: "editor.project-redo", data: { editProjectId, revision: restored.revision, restoredFromRevision: next.revision } });
  return restored;
}

export async function redoEditProject(projectRoot: string, editProjectId: string, expectedRevision: number, actor: "user" | "codex" = "codex"): Promise<EditProject> {
  return withProjectLock(projectRoot, editProjectLockName(editProjectId), () => redoEditProjectUnlocked(projectRoot, editProjectId, expectedRevision, actor));
}

export type EditOperation =
  | { type: "add_track"; kind: EditTrack["kind"]; name?: string }
  | { type: "remove_track"; trackId: string }
  | { type: "add_media_clip"; trackId: string; mediaId?: string; artifactId?: string; startSeconds: number }
  | { type: "add_nested_timeline"; trackId: string; childEditProjectId: string; childExpectedRevision: number; startFrame: number; sourceStartFrame?: number; sourceDurationFrames?: number }
  | { type: "refresh_nested_timeline"; clipId: string; childExpectedRevision: number }
  | { type: "add_subtitle"; trackId: string; startSeconds: number; durationSeconds: number; text: string }
  | { type: "update_clip"; clipId: string; patch: Partial<Pick<EditClip, "name" | "startSeconds" | "durationSeconds" | "trimStartSeconds" | "playbackRate" | "volume" | "opacity" | "muted" | "positionX" | "positionY" | "scale" | "rotation" | "filter" | "filterIntensity" | "keyframes" | "fadeInSeconds" | "fadeOutSeconds" | "transitionOut" | "transitionDurationSeconds" | "transition" | "text" | "fontSize" | "fontColor" | "subtitleBackground" | "note">> }
  | { type: "move_clip"; clipId: string; targetTrackId: string; startSeconds: number }
  | { type: "split_clip"; clipId: string; timeSeconds: number }
  | { type: "trim_to_playhead"; clipId: string; timeSeconds: number; side: "start" | "end" }
  | { type: "ripple_delete"; clipId: string; allUnlockedTracks?: boolean }
  | { type: "ripple_insert_gap"; timeSeconds: number; durationSeconds: number; trackIds?: string[] }
  | { type: "remove_clip"; clipId: string };

function locateClip(project: EditProject, clipId: string): { track: EditTrack; clip: EditClip; index: number } {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  throw new Error(`找不到剪辑片段：${clipId}`);
}

function keyframeFrame(project: Pick<EditProject, "fps" | "timebase">, keyframe: EditKeyframe): number {
  return Number.isInteger(keyframe.frame) ? keyframe.frame! : projectFrameForSeconds(project, keyframe.timeSeconds);
}

function setClipTransform(clip: EditClip, transform: EditTransform): void {
  clip.positionX = roundTransform(transform.positionX);
  clip.positionY = roundTransform(transform.positionY);
  clip.scale = roundTransform(transform.scale);
  clip.rotation = roundTransform(transform.rotation);
}

function keyframeTransform(value: Pick<EditClip | EditKeyframe, "positionX" | "positionY" | "scale" | "rotation">): EditTransform {
  return {
    positionX: Number(value.positionX ?? 0),
    positionY: Number(value.positionY ?? 0),
    scale: Number(value.scale ?? 1),
    rotation: Number(value.rotation ?? 0),
  };
}

function rebaseKeyframe(
  project: Pick<EditProject, "fps" | "timebase">,
  keyframe: EditKeyframe,
  boundaryFrame: number,
  regenerateId: boolean,
): EditKeyframe {
  const frame = keyframeFrame(project, keyframe) - boundaryFrame;
  return {
    ...structuredClone(keyframe),
    ...(regenerateId ? { id: `kf-${randomUUID()}` } : {}),
    frame,
    timeSeconds: projectSecondsForFrame(project, frame),
  };
}

interface PartitionedKeyframes {
  boundaryTransform: EditTransform;
  left: EditKeyframe[];
  right: EditKeyframe[];
}

function partitionClipKeyframes(
  project: Pick<EditProject, "fps" | "timebase">,
  clip: EditClip,
  boundaryFrame: number,
  regenerateRightIds: boolean,
): PartitionedKeyframes {
  const frameRate = projectFrameRate(project);
  const source = (clip.keyframes ?? [])
    .map((keyframe) => structuredClone(keyframe))
    .sort((left, right) => keyframeFrame(project, left) - keyframeFrame(project, right));
  const boundaryTransform = evaluateEditTransformAtFrame(clip, boundaryFrame, frameRate);
  if (!source.length) return { boundaryTransform, left: [], right: [] };

  const exact = source.find((keyframe) => keyframeFrame(project, keyframe) === boundaryFrame);
  const left = source.filter((keyframe) => keyframeFrame(project, keyframe) <= boundaryFrame);
  const future = source.filter((keyframe) => keyframeFrame(project, keyframe) > boundaryFrame);
  const right = future.map((keyframe) => rebaseKeyframe(project, keyframe, boundaryFrame, regenerateRightIds));

  // 已有边界关键帧由右片段的静态基值承接；下一目标关键帧继续拥有其原入段曲线。
  if (exact) return { boundaryTransform, left, right };
  // 最后一个关键帧后的尾段本来就是常量，不制造冗余边界关键帧。
  if (!future.length) return { boundaryTransform, left, right };

  const target = future[0]!;
  const targetFrame = keyframeFrame(project, target);
  const previous = [...source].reverse().find((keyframe) => keyframeFrame(project, keyframe) < boundaryFrame);
  const previousFrame = previous ? keyframeFrame(project, previous) : 0;
  if (target.bezier?.mode === "derived_monotone" && !target.sourceTransform) throw new Error("派生关键帧缺少原入段 sourceTransform；拒绝从舍入后的子边界反推原动画。");
  const sourceTransform: EditKeyframeSourceTransform = target.bezier?.mode === "derived_monotone"
    ? structuredClone(target.sourceTransform!)
    : { start: keyframeTransform(previous ?? clip), end: keyframeTransform(target) };
  const splitRatio = (boundaryFrame - previousFrame) / (targetFrame - previousFrame);
  const subdivision = subdivideEditKeyframeEasing(target.easing, splitRatio, target.bezier, {
    segmentFrames: targetFrame - previousFrame,
    splitFrame: boundaryFrame - previousFrame,
  });
  const boundaryKeyframe: EditKeyframe = {
    id: `kf-${randomUUID()}`,
    frame: boundaryFrame,
    timeSeconds: projectSecondsForFrame(project, boundaryFrame),
    easing: subdivision.left.easing,
    ...(subdivision.left.bezier ? { bezier: subdivision.left.bezier } : {}),
    ...(subdivision.left.bezier?.mode === "derived_monotone" ? { sourceTransform: structuredClone(sourceTransform) } : {}),
    positionX: roundTransform(boundaryTransform.positionX),
    positionY: roundTransform(boundaryTransform.positionY),
    scale: roundTransform(boundaryTransform.scale),
    rotation: roundTransform(boundaryTransform.rotation),
  };
  const firstRight = right[0]!;
  firstRight.easing = subdivision.right.easing;
  if (subdivision.right.bezier) firstRight.bezier = subdivision.right.bezier;
  else delete firstRight.bezier;
  if (subdivision.right.bezier?.mode === "derived_monotone") firstRight.sourceTransform = structuredClone(sourceTransform);
  else delete firstRight.sourceTransform;
  return {
    boundaryTransform,
    left: [...source.filter((keyframe) => keyframeFrame(project, keyframe) < boundaryFrame), boundaryKeyframe],
    right,
  };
}

async function applyEditOperationUnlocked(
  projectRoot: string,
  editProjectId: string,
  expectedRevision: number,
  operation: EditOperation,
  actor: "user" | "codex" = "codex",
  preparedNestedDependency?: PreparedNestedDependency,
): Promise<{ project: EditProject; affectedTrackIds: string[]; affectedClipIds: string[] }> {
  const current = await getEditProject(projectRoot, editProjectId);
  if (current.revision !== expectedRevision) throw new RejectedCommandFailure(`剪辑工程已被其他窗口更新（当前修订 ${current.revision}），请重新读取后重试。`, { schemaVersion: 1, applied: false, reason: "revision_conflict", editProjectId, expectedRevision, currentRevision: current.revision });
  const project = structuredClone(current);
  const affectedTrackIds = new Set<string>();
  const affectedClipIds = new Set<string>();
  if (operation.type === "add_track") {
    const id = `track-${randomUUID()}`;
    project.tracks.push({ id, kind: operation.kind, name: operation.name?.trim() || (operation.kind === "visual" ? "叠加画面" : operation.kind === "audio" ? "音频" : "字幕"), order: project.tracks.length, locked: false, muted: false, hidden: false, clips: [] });
    affectedTrackIds.add(id);
  } else if (operation.type === "remove_track") {
    const track = project.tracks.find((candidate) => candidate.id === operation.trackId);
    if (!track) throw new Error(`找不到轨道：${operation.trackId}`);
    if (track.clips.length) throw new Error("只能删除空轨道；请先移动或删除其中的片段。");
    if (project.tracks.filter((candidate) => candidate.kind === track.kind).length <= 1) throw new Error(`不能删除最后一条${track.kind}轨道。`);
    project.tracks = project.tracks.filter((candidate) => candidate.id !== track.id);
    affectedTrackIds.add(track.id);
  } else if (operation.type === "add_media_clip") {
    const track = project.tracks.find((candidate) => candidate.id === operation.trackId);
    if (!track) throw new Error(`找不到轨道：${operation.trackId}`);
    const media = (await listEditMedia(projectRoot, project.episode)).find((candidate) => candidate.id === operation.mediaId || candidate.artifactId === operation.artifactId);
    if (!media) throw new Error("找不到指定的可剪辑媒体；请先调用 list_edit_media。 ");
    if ((track.kind === "visual" && !["video", "image"].includes(media.kind)) || (track.kind === "audio" && media.kind !== "audio") || track.kind === "subtitle") throw new Error("媒体类型与目标轨道不匹配。 ");
    const clip = mediaToClip(media, track.id, operation.startSeconds, project);
    track.clips.push(clip);
    affectedTrackIds.add(track.id);
    affectedClipIds.add(clip.id);
  } else if (operation.type === "add_nested_timeline") {
    const track = project.tracks.find((candidate) => candidate.id === operation.trackId && candidate.kind === "visual");
    if (!track) throw new Error("找不到目标视觉轨道。 ");
    if (operation.childEditProjectId === project.id) throw new Error("嵌套时间线不能引用自身剪辑工程。 ");
    if (!preparedNestedDependency || preparedNestedDependency.snapshot.project.id !== operation.childEditProjectId || preparedNestedDependency.snapshot.project.revision !== operation.childExpectedRevision) throw new Error("嵌套时间线冻结快照与操作输入不一致。 ");
    if (!Number.isSafeInteger(operation.startFrame) || operation.startFrame < 0) throw new Error("嵌套时间线父起点必须是非负安全整数帧。 ");
    const child = preparedNestedDependency.snapshot.project;
    const childDurationFrames = renderDurationFrames(child);
    const sourceStartFrame = operation.sourceStartFrame ?? 0;
    const sourceDurationFrames = operation.sourceDurationFrames ?? childDurationFrames - sourceStartFrame;
    if (!Number.isSafeInteger(sourceStartFrame) || !Number.isSafeInteger(sourceDurationFrames) || sourceStartFrame < 0 || sourceDurationFrames < 1 || sourceStartFrame + sourceDurationFrames > childDurationFrames) throw new Error("嵌套时间线源区间超出冻结子工程范围。 ");
    const sourceStep = sourceStepForTimebases(project, child);
    const mappedDurationFrames = ceilPositiveRationalDivision(sourceDurationFrames, sourceStep);
    const reference: EditNestedTimelineRef = {
      contract: NESTED_TIMELINE_CONTRACT,
      ownerProjectId: child.projectId,
      childEditProjectId: child.id,
      childEditProjectRevision: child.revision,
      childSnapshotSha256: preparedNestedDependency.snapshotSha256,
      childTimebase: {
        rateNumerator: normalizedProjectTimebase(child).rateNumerator,
        rateDenominator: normalizedProjectTimebase(child).rateDenominator,
      },
      childCanvas: { width: child.width, height: child.height },
      childDurationFrames,
      sourceRange: { startFrame: sourceStartFrame, durationFrames: sourceDurationFrames },
      sourceOffset: rationalForInteger(0),
      sourceStep,
      mappedDurationFrames,
    };
    const clip: EditClip = {
      id: `clip-${randomUUID()}`,
      trackId: track.id,
      kind: "timeline",
      name: safeName(`${child.name} · 冻结 r${child.revision}`),
      nestedTimeline: reference,
      startFrame: operation.startFrame,
      durationFrames: mappedDurationFrames,
      trimStartFrame: 0,
      startSeconds: projectSecondsForFrame(project, operation.startFrame),
      durationSeconds: projectSecondsForFrame(project, mappedDurationFrames),
      trimStartSeconds: 0,
      playbackRate: 1,
      volume: 1,
      opacity: 1,
      muted: false,
      positionX: 0,
      positionY: 0,
      scale: 1,
      rotation: 0,
      filter: "none",
      filterIntensity: 1,
      keyframes: [],
    };
    track.clips.push(clip);
    affectedTrackIds.add(track.id);
    affectedClipIds.add(clip.id);
  } else if (operation.type === "refresh_nested_timeline") {
    const located = locateClip(project, operation.clipId);
    if (located.clip.kind !== "timeline" || !located.clip.nestedTimeline) throw new Error("只能刷新嵌套时间线片段。 ");
    const previous = located.clip.nestedTimeline;
    if (!preparedNestedDependency || preparedNestedDependency.snapshot.project.id !== previous.childEditProjectId || preparedNestedDependency.snapshot.project.revision !== operation.childExpectedRevision) throw new Error("刷新快照与嵌套时间线操作不一致。 ");
    const child = preparedNestedDependency.snapshot.project;
    const childDurationFrames = renderDurationFrames(child);
    if (previous.sourceRange.startFrame + previous.sourceRange.durationFrames > childDurationFrames) throw new Error("新子时间线不足以容纳现有冻结源区间，拒绝静默改成整段。 ");
    located.clip.nestedTimeline = {
      ...structuredClone(previous),
      ownerProjectId: child.projectId,
      childEditProjectRevision: child.revision,
      childSnapshotSha256: preparedNestedDependency.snapshotSha256,
      childTimebase: {
        rateNumerator: normalizedProjectTimebase(child).rateNumerator,
        rateDenominator: normalizedProjectTimebase(child).rateDenominator,
      },
      childCanvas: { width: child.width, height: child.height },
      childDurationFrames,
      sourceStep: sourceStepForTimebases(project, child),
      mappedDurationFrames: ceilPositiveRationalDivision(previous.sourceRange.durationFrames, sourceStepForTimebases(project, child)),
    };
    located.clip.name = safeName(`${child.name} · 冻结 r${child.revision}`);
    affectedTrackIds.add(located.track.id);
    affectedClipIds.add(located.clip.id);
  } else if (operation.type === "add_subtitle") {
    const track = project.tracks.find((candidate) => candidate.id === operation.trackId && candidate.kind === "subtitle");
    if (!track) throw new Error("找不到目标字幕轨道。 ");
    const clip: EditClip = { id: `clip-${randomUUID()}`, trackId: track.id, kind: "subtitle", name: safeName(operation.text.slice(0, 40) || "字幕"), startSeconds: operation.startSeconds, durationSeconds: operation.durationSeconds, trimStartSeconds: 0, playbackRate: 1, volume: 1, opacity: 1, muted: false, text: operation.text, fontSize: Math.max(28, project.width * .046), fontColor: "#ffffff", subtitleBackground: "#000000" };
    track.clips.push(clip);
    affectedTrackIds.add(track.id);
    affectedClipIds.add(clip.id);
  } else if (operation.type === "update_clip") {
    const located = locateClip(project, operation.clipId);
    Object.assign(located.clip, operation.patch);
    if (operation.patch.transitionOut !== undefined && operation.patch.transitionOut !== "smpte_dissolve") located.clip.transition = undefined;
    affectedTrackIds.add(located.track.id);
    affectedClipIds.add(located.clip.id);
  } else if (operation.type === "move_clip") {
    const located = locateClip(project, operation.clipId);
    const target = project.tracks.find((candidate) => candidate.id === operation.targetTrackId);
    if (!target) throw new Error(`找不到目标轨道：${operation.targetTrackId}`);
    const compatible = target.kind === "visual" ? ["video", "image", "timeline"].includes(located.clip.kind) : target.kind === located.clip.kind;
    if (!compatible) throw new Error("片段类型与目标轨道不匹配。 ");
    located.track.clips.splice(located.index, 1);
    located.clip.trackId = target.id;
    located.clip.startSeconds = operation.startSeconds;
    target.clips.push(located.clip);
    affectedTrackIds.add(located.track.id);
    affectedTrackIds.add(target.id);
    affectedClipIds.add(located.clip.id);
  } else if (operation.type === "split_clip") {
    const located = locateClip(project, operation.clipId);
    const startFrame = editClipStartFrame(project, located.clip);
    const originalDurationFrames = editClipDurationFrames(project, located.clip);
    const splitFrame = projectFrameForSeconds(project, operation.timeSeconds);
    const localFrames = splitFrame - startFrame;
    if (localFrames < 1 || localFrames >= originalDurationFrames) throw new Error("分割点必须位于片段内部，并与边界至少相距 1 帧。 ");
    const partitioned = (located.clip.keyframes?.length ?? 0) > 0
      ? partitionClipKeyframes(project, located.clip, localFrames, true)
      : undefined;
    const localTime = projectSecondsForFrame(project, localFrames);
    const second = structuredClone(located.clip);
    second.id = `clip-${randomUUID()}`;
    second.name = safeName(`${located.clip.name} · 后段`);
    second.startFrame = splitFrame;
    second.durationFrames = originalDurationFrames - localFrames;
    second.startSeconds = projectSecondsForFrame(project, splitFrame);
    second.durationSeconds = projectSecondsForFrame(project, second.durationFrames);
    if (["video", "audio"].includes(second.kind)) {
      second.trimStartFrame = projectFrameForSeconds(project, located.clip.trimStartSeconds) + Math.round(localFrames * located.clip.playbackRate);
      second.trimStartSeconds = projectSecondsForFrame(project, second.trimStartFrame);
    }
    if (second.kind === "timeline" && second.nestedTimeline) second.nestedTimeline.sourceOffset = addEditRational(second.nestedTimeline.sourceOffset, rationalTimesInteger(second.nestedTimeline.sourceStep, localFrames));
    if (partitioned) {
      setClipTransform(second, partitioned.boundaryTransform);
      second.keyframes = partitioned.right;
    }
    located.clip.durationFrames = localFrames;
    located.clip.durationSeconds = localTime;
    if (partitioned) located.clip.keyframes = partitioned.left;
    second.transitionOut = located.clip.transitionOut;
    second.transitionDurationSeconds = located.clip.transitionDurationSeconds;
    second.transition = located.clip.transition ? structuredClone(located.clip.transition) : undefined;
    located.clip.transitionOut = "cut";
    located.clip.transitionDurationSeconds = undefined;
    located.clip.transition = undefined;
    located.track.clips.splice(located.index + 1, 0, second);
    affectedTrackIds.add(located.track.id);
    affectedClipIds.add(located.clip.id);
    affectedClipIds.add(second.id);
  } else if (operation.type === "trim_to_playhead") {
    const located = locateClip(project, operation.clipId);
    const startFrame = editClipStartFrame(project, located.clip);
    const originalDurationFrames = editClipDurationFrames(project, located.clip);
    const trimFrame = projectFrameForSeconds(project, operation.timeSeconds);
    const localFrames = trimFrame - startFrame;
    if (localFrames < 1 || localFrames >= originalDurationFrames) throw new Error("裁切播放头必须位于片段内部，并与边界至少相距 1 帧。 ");
    const partitioned = (located.clip.keyframes?.length ?? 0) > 0
      ? partitionClipKeyframes(project, located.clip, localFrames, false)
      : undefined;
    const localTime = projectSecondsForFrame(project, localFrames);
    if (operation.side === "start") {
      located.clip.startFrame = trimFrame;
      located.clip.durationFrames = originalDurationFrames - localFrames;
      located.clip.startSeconds = projectSecondsForFrame(project, trimFrame);
      located.clip.durationSeconds = projectSecondsForFrame(project, located.clip.durationFrames);
      if (["video", "audio"].includes(located.clip.kind)) {
        located.clip.trimStartFrame = projectFrameForSeconds(project, located.clip.trimStartSeconds) + Math.round(localFrames * located.clip.playbackRate);
        located.clip.trimStartSeconds = projectSecondsForFrame(project, located.clip.trimStartFrame);
      }
      if (located.clip.kind === "timeline" && located.clip.nestedTimeline) located.clip.nestedTimeline.sourceOffset = addEditRational(located.clip.nestedTimeline.sourceOffset, rationalTimesInteger(located.clip.nestedTimeline.sourceStep, localFrames));
      if (partitioned) {
        setClipTransform(located.clip, partitioned.boundaryTransform);
        located.clip.keyframes = partitioned.right;
      }
    } else {
      located.clip.durationFrames = localFrames;
      located.clip.durationSeconds = localTime;
      if (partitioned) located.clip.keyframes = partitioned.left;
    }
    located.clip.fadeInSeconds = Math.min(located.clip.fadeInSeconds ?? 0, located.clip.durationSeconds);
    located.clip.fadeOutSeconds = Math.min(located.clip.fadeOutSeconds ?? 0, located.clip.durationSeconds);
    if ((located.clip.transitionDurationSeconds ?? 0) > located.clip.durationSeconds / 2) located.clip.transitionDurationSeconds = roundTime(Math.max(.04, located.clip.durationSeconds / 2));
    affectedTrackIds.add(located.track.id);
    affectedClipIds.add(located.clip.id);
  } else if (operation.type === "ripple_delete") {
    const located = locateClip(project, operation.clipId);
    const removedStartFrame = editClipStartFrame(project, located.clip);
    const removedDurationFrames = editClipDurationFrames(project, located.clip);
    const removedEndFrame = removedStartFrame + removedDurationFrames;
    located.track.clips.splice(located.index, 1);
    const tracks = operation.allUnlockedTracks === false ? [located.track] : project.tracks.filter((track) => !track.locked);
    for (const track of tracks) {
      affectedTrackIds.add(track.id);
      for (const clip of track.clips) if (editClipStartFrame(project, clip) >= removedEndFrame) {
        clip.startFrame = Math.max(0, editClipStartFrame(project, clip) - removedDurationFrames);
        clip.startSeconds = projectSecondsForFrame(project, clip.startFrame);
        affectedClipIds.add(clip.id);
      }
    }
    affectedClipIds.add(located.clip.id);
  } else if (operation.type === "ripple_insert_gap") {
    if (!Number.isFinite(operation.timeSeconds) || operation.timeSeconds < 0 || !Number.isFinite(operation.durationSeconds) || operation.durationSeconds <= 0) throw new Error("Ripple 插入时间和时长无效。 ");
    const insertFrame = projectFrameForSeconds(project, operation.timeSeconds);
    const durationFrames = projectFrameForSeconds(project, operation.durationSeconds);
    if (durationFrames < 1) throw new Error("Ripple 插入间隔必须至少为 1 帧。 ");
    const selectedIds = operation.trackIds ? new Set(operation.trackIds) : undefined;
    const tracks = project.tracks.filter((track) => !track.locked && (!selectedIds || selectedIds.has(track.id)));
    if (selectedIds && tracks.length !== selectedIds.size) throw new Error("Ripple 插入包含不存在或已锁定的轨道。 ");
    for (const track of tracks) {
      affectedTrackIds.add(track.id);
      for (const clip of track.clips) if (editClipStartFrame(project, clip) >= insertFrame) {
        clip.startFrame = editClipStartFrame(project, clip) + durationFrames;
        clip.startSeconds = projectSecondsForFrame(project, clip.startFrame);
        affectedClipIds.add(clip.id);
      }
    }
  } else if (operation.type === "remove_clip") {
    const located = locateClip(project, operation.clipId);
    located.track.clips.splice(located.index, 1);
    affectedTrackIds.add(located.track.id);
    affectedClipIds.add(located.clip.id);
  }
  const saved = await saveEditProjectUnlocked(projectRoot, project, expectedRevision, actor);
  await appendEvent(projectRoot, { actor, type: `editor.operation.${operation.type}`, data: { editProjectId, revision: saved.revision, affectedTrackIds: [...affectedTrackIds], affectedClipIds: [...affectedClipIds] } });
  return { project: saved, affectedTrackIds: [...affectedTrackIds], affectedClipIds: [...affectedClipIds] };
}

export async function applyEditOperation(
  projectRoot: string,
  editProjectId: string,
  expectedRevision: number,
  operation: EditOperation,
  actor: "user" | "codex" = "codex",
): Promise<{ project: EditProject; affectedTrackIds: string[]; affectedClipIds: string[] }> {
  let preparedNestedDependency: PreparedNestedDependency | undefined;
  if (operation.type === "add_nested_timeline") {
    if (operation.childEditProjectId === editProjectId) throw new Error("嵌套时间线不能引用自身剪辑工程。 ");
    preparedNestedDependency = await prepareNestedDependencySnapshot(projectRoot, operation.childEditProjectId, operation.childExpectedRevision);
  } else if (operation.type === "refresh_nested_timeline") {
    const current = await getEditProject(projectRoot, editProjectId);
    if (current.revision !== expectedRevision) throw new RejectedCommandFailure(`剪辑工程已被其他窗口更新（当前修订 ${current.revision}），请重新读取后重试。`, { schemaVersion: 1, applied: false, reason: "revision_conflict", editProjectId, expectedRevision, currentRevision: current.revision });
    const located = locateClip(current, operation.clipId);
    if (located.clip.kind !== "timeline" || !located.clip.nestedTimeline) throw new Error("只能刷新嵌套时间线片段。 ");
    if (located.clip.nestedTimeline.childEditProjectId === editProjectId) throw new Error("嵌套时间线不能引用自身剪辑工程。 ");
    preparedNestedDependency = await prepareNestedDependencySnapshot(projectRoot, located.clip.nestedTimeline.childEditProjectId, operation.childExpectedRevision);
  }
  return withProjectLock(projectRoot, editProjectLockName(editProjectId), () => applyEditOperationUnlocked(projectRoot, editProjectId, expectedRevision, operation, actor, preparedNestedDependency));
}

function otioRationalTime(value: number, rate: number) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate };
}

function otioTimeRange(startFrame: number, durationFrames: number, fps: number) {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: otioRationalTime(startFrame, fps), duration: otioRationalTime(durationFrames, fps) };
}

function otioCurveContract(project: EditProject): typeof EDIT_KEYFRAME_CURVE_CONTRACT | typeof LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT {
  const hasDerivedCurve = project.tracks.some((track) => track.clips.some((clip) => clip.keyframes?.some((keyframe) => keyframe.bezier?.mode === "derived_monotone")));
  return hasDerivedCurve ? EDIT_KEYFRAME_CURVE_CONTRACT : LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT;
}

function editProjectOtioTracks(project: EditProject, snapshots: Map<string, EditProjectDependencySnapshot>): unknown[] {
  const frameRate = projectFrameRate(project);
  return project.tracks.map((track) => {
    const children: unknown[] = [];
    let cursor = 0;
    for (const clip of track.clips.slice().sort((a, b) => editClipStartFrame(project, a) - editClipStartFrame(project, b))) {
      const startFrame = editClipStartFrame(project, clip);
      const durationFrames = editClipDurationFrames(project, clip);
      if (startFrame > cursor) children.push({ OTIO_SCHEMA: "Gap.1", name: "Gap", source_range: otioTimeRange(0, startFrame - cursor, frameRate), effects: [], markers: [], metadata: {} });
      if (clip.kind === "timeline" && clip.nestedTimeline) {
        const reference = clip.nestedTimeline;
        const snapshot = snapshots.get(reference.childSnapshotSha256);
        if (!snapshot) throw new Error(`OTIO 导出缺少嵌套快照：${reference.childSnapshotSha256}`);
        const embeddedTracks = editProjectOtioTracks(snapshot.project, snapshots);
        const offsetParentFrames = rationalQuotientInteger(reference.sourceOffset, reference.sourceStep, `${clip.name} 的 OTIO 嵌套源起点`);
        children.push({
          OTIO_SCHEMA: "Stack.1",
          name: clip.name,
          source_range: otioTimeRange(offsetParentFrames, durationFrames, frameRate),
          effects: [],
          markers: [],
          children: embeddedTracks,
          metadata: {
            aicanvas: {
              contract: NESTED_TIMELINE_CONTRACT,
              clip: { ...clip, sourcePath: undefined, nestedTimeline: undefined },
              nestedTimeline: reference,
              embeddedProjectSha256: sha256Json(snapshot.project),
              embeddedOtioSha256: sha256Json(embeddedTracks),
            },
          },
        });
      } else {
        const availableRange = clip.sourceAvailableRange
          ? otioTimeRange(clip.sourceAvailableRange.startFrame, clip.sourceAvailableRange.durationFrames, frameRate)
          : null;
        const mediaReference = clip.sourcePath
          ? { OTIO_SCHEMA: "ExternalReference.1", target_url: pathToFileURL(clip.sourcePath).href, available_range: availableRange, available_image_bounds: null, metadata: {} }
          : { OTIO_SCHEMA: "MissingReference.1", available_range: availableRange, available_image_bounds: null, metadata: {} };
        const sourceDurationFrames = clip.playbackRate === 1 ? durationFrames : exactScaledFrameCount(durationFrames, clip.playbackRate, `${clip.name} 的 OTIO LinearTimeWarp`);
        const effects = clip.playbackRate === 1 ? [] : [{
          OTIO_SCHEMA: "LinearTimeWarp.1",
          name: "Linear Time Warp",
          effect_name: "LinearTimeWarp",
          time_scalar: clip.playbackRate,
          enabled: true,
          metadata: otioCompatibilityMetadata(),
        }];
        children.push({
          OTIO_SCHEMA: "Clip.2",
          name: clip.name,
          source_range: otioTimeRange(clip.trimStartFrame ?? Math.round(clip.trimStartSeconds * frameRate), sourceDurationFrames, frameRate),
          media_reference: mediaReference,
          effects,
          markers: [],
          metadata: { aicanvas: { ...clip, sourcePath: undefined } },
        });
        if (clip.transitionOut === "smpte_dissolve" && clip.transition) children.push({
          OTIO_SCHEMA: "Transition.1",
          name: "SMPTE Dissolve",
          transition_type: "SMPTE_Dissolve",
          in_offset: otioRationalTime(clip.transition.inOffsetFrames, frameRate),
          out_offset: otioRationalTime(clip.transition.outOffsetFrames, frameRate),
          enabled: true,
          metadata: otioCompatibilityMetadata(),
        });
      }
      cursor = startFrame + durationFrames;
    }
    return { OTIO_SCHEMA: "Track.1", name: track.name, kind: track.kind === "audio" ? "Audio" : "Video", source_range: null, effects: [], markers: [], children, metadata: { aicanvas: { id: track.id, kind: track.kind, order: track.order, locked: track.locked, muted: track.muted, hidden: track.hidden } } };
  });
}

async function exportEditProjectOtioUnlocked(projectRoot: string, editProjectId: string, expectedRevision: number, outputPath?: string): Promise<{ path: string; editProjectId: string; revision: number; clips: number }> {
  const project = await validateEditProject(projectRoot, structuredClone(await getEditProject(projectRoot, editProjectId)));
  if (project.revision !== expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${project.revision}），请重新载入后导出。`);
  const config = await loadProjectConfig(projectRoot);
  const defaultPath = path.join(getSidecarPaths(projectRoot).editorOtio, `${safeName(project.name)}_r${project.revision}_${Date.now()}.otio`);
  const target = path.resolve(outputPath ?? defaultPath);
  const allowedRoots = [getSidecarPaths(projectRoot).editorOtio, config.primaryRoot, ...config.outputRoots].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))) throw new Error("OTIO 输出路径必须位于项目根、输出根或侧车 OTIO 目录内。 ");
  await mkdir(path.dirname(target), { recursive: true });
  const resolved = await collectResolvedEditTimeline(projectRoot, project);
  const tracks = editProjectOtioTracks(project, resolved.snapshots);
  const hasEffectTransition = project.tracks.some((track) => track.clips.some((clip) => clip.playbackRate !== 1 || clip.transitionOut === "smpte_dissolve"));
  const document = { OTIO_SCHEMA: "Timeline.1", name: project.name, global_start_time: null, tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", source_range: null, effects: [], markers: [], children: tracks, metadata: {} }, metadata: { aicanvas: { schemaVersion: 1, projectId: project.projectId, editProjectId: project.id, revision: project.revision, width: project.width, height: project.height, fps: project.fps, timebase: project.timebase, backgroundColor: project.backgroundColor, keyframeCurveContract: otioCurveContract(project), curvePortability: "aicanvas-private-metadata", nestedTimelineContract: project.tracks.some((track) => track.clips.some((clip) => clip.kind === "timeline")) ? NESTED_TIMELINE_CONTRACT : undefined, effectTransitionContract: hasEffectTransition ? OTIO_EFFECT_TRANSITION_CONTRACT : undefined } } };
  // OTIO-1：导出前能力矩阵 probe（拒绝未知/禁止 schema 泄漏）
  const probe = probeStudioOtioDocument(document);
  if (!probe.ok) {
    throw new Error(`OTIO 导出文档未通过子集 probe：${probe.issues.join("；")}`);
  }
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await appendEvent(projectRoot, { actor: "user", type: "editor.otio-exported", data: { editProjectId, revision: project.revision, path: target } });
  return { path: target, editProjectId, revision: project.revision, clips: project.tracks.reduce((sum, track) => sum + track.clips.length, 0) };
}

export async function exportEditProjectOtio(projectRoot: string, editProjectId: string, expectedRevision: number, outputPath?: string): Promise<{ path: string; editProjectId: string; revision: number; clips: number }> {
  return withProjectLock(projectRoot, editProjectLockName(editProjectId), () => exportEditProjectOtioUnlocked(projectRoot, editProjectId, expectedRevision, outputPath));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function requiredOtioRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function rationalFrames(value: unknown, targetRate: number): { frames: number; rate: number } {
  const source = requiredOtioRecord(value, "OTIO RationalTime");
  if (source.OTIO_SCHEMA !== "RationalTime.1") throw new Error("OTIO 时间值必须使用 RationalTime.1。 ");
  if (typeof source.rate !== "number" || !Number.isFinite(source.rate) || source.rate <= 0) throw new Error("OTIO RationalTime.rate 必须是正数。 ");
  if (typeof source.value !== "number" || !Number.isFinite(source.value)) throw new Error("OTIO RationalTime.value 必须是有限数。 ");
  if (!Number.isFinite(targetRate) || targetRate <= 0) throw new Error("OTIO 目标帧率必须是正数。 ");
  const rate = source.rate;
  const sourceValue = source.value;
  return { frames: Math.round((sourceValue / rate) * targetRate), rate };
}

function firstOtioRate(document: Record<string, unknown>): number | undefined {
  const tracks = Array.isArray(record(document.tracks).children) ? record(document.tracks).children as unknown[] : [];
  for (const track of tracks) for (const child of Array.isArray(record(track).children) ? record(track).children as unknown[] : []) {
    const duration = record(record(record(child).source_range).duration);
    const rate = Number(duration.rate);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return undefined;
}

function requireEmptyOtioCollection(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length) throw new Error(`${label} 必须是空数组；拒绝静默丢失不受支持的 OTIO 语义。`);
}

function requireOnlyOtioFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknown.length) throw new Error(`${label} 包含未支持字段：${unknown.join(", ")}。`);
}

function requireOtioCompatibilityMetadata(value: unknown, label: string): void {
  if (value === undefined) return;
  const metadata = requiredOtioRecord(value, `${label} metadata`);
  const keys = Object.keys(metadata);
  if (!keys.length) return;
  if (keys.length !== 1 || keys[0] !== "aicanvas") throw new Error(`${label} metadata 不是受支持的空对象或 AI Canvas 合同。`);
  const aicanvas = requiredOtioRecord(metadata.aicanvas, `${label} metadata.aicanvas`);
  requireOnlyOtioFields(aicanvas, ["contract"], `${label} metadata.aicanvas`);
  if (aicanvas.contract !== OTIO_EFFECT_TRANSITION_CONTRACT) throw new Error(`${label} metadata 合同不受支持。`);
}

function strictRationalFrames(value: unknown, targetRate: number, label: string): number {
  const source = requiredOtioRecord(value, label);
  if (source.OTIO_SCHEMA !== "RationalTime.1") throw new Error(`${label} 必须使用 RationalTime.1。`);
  if (typeof source.rate !== "number" || !Number.isFinite(source.rate) || source.rate <= 0) throw new Error(`${label}.rate 必须是正数。`);
  if (typeof source.value !== "number" || !Number.isFinite(source.value)) throw new Error(`${label}.value 必须是有限数。`);
  const scaled = source.value / source.rate * targetRate;
  const frames = Math.round(scaled);
  if (!Number.isSafeInteger(frames) || Math.abs(scaled - frames) > 1e-9) throw new Error(`${label} 无法无损换算到项目整数帧。`);
  return frames;
}

function parseOtioAvailableRange(value: unknown, targetRate: number, label: string): EditClip["sourceAvailableRange"] {
  if (value === undefined || value === null) return undefined;
  const range = requiredOtioRecord(value, `${label} available_range`);
  if (range.OTIO_SCHEMA !== "TimeRange.1") throw new Error(`${label} available_range 必须使用 TimeRange.1。`);
  const startFrame = strictRationalFrames(range.start_time, targetRate, `${label} available_range.start_time`);
  const durationFrames = strictRationalFrames(range.duration, targetRate, `${label} available_range.duration`);
  if (startFrame < 0 || durationFrames < 1) throw new Error(`${label} available_range 必须是非负起点和正整数帧时长。`);
  return { startFrame, durationFrames };
}

function parseOtioLinearTimeWarp(value: unknown, label: string): number {
  if (value === undefined) return 1;
  if (!Array.isArray(value)) throw new Error(`${label} effects 必须是数组。`);
  if (!value.length) return 1;
  if (value.length !== 1) throw new Error(`${label} 首版只支持一个 active LinearTimeWarp.1。`);
  const effect = requiredOtioRecord(value[0], `${label} effect`);
  requireOnlyOtioFields(effect, ["OTIO_SCHEMA", "name", "effect_name", "time_scalar", "enabled", "metadata"], `${label} effect`);
  if (effect.OTIO_SCHEMA !== "LinearTimeWarp.1") throw new Error(`${label} 不支持 ${String(effect.OTIO_SCHEMA || "unknown")}；只允许 LinearTimeWarp.1。`);
  if (effect.enabled !== undefined && effect.enabled !== true) throw new Error(`${label} 只接受 active LinearTimeWarp.1；disabled 对象拒绝往返丢失。`);
  if (effect.effect_name !== "LinearTimeWarp") throw new Error(`${label} LinearTimeWarp.1.effect_name 必须精确为 LinearTimeWarp。`);
  if (typeof effect.time_scalar !== "number" || !Number.isFinite(effect.time_scalar) || effect.time_scalar < .1 || effect.time_scalar > 8) throw new Error(`${label} LinearTimeWarp.1.time_scalar 必须在 0.1–8。`);
  requireOtioCompatibilityMetadata(effect.metadata, `${label} LinearTimeWarp.1`);
  return effect.time_scalar;
}

function parseOtioSmpteDissolve(value: Record<string, unknown>, targetRate: number): { inOffsetFrames: number; outOffsetFrames: number } {
  requireOnlyOtioFields(value, ["OTIO_SCHEMA", "name", "transition_type", "in_offset", "out_offset", "enabled", "metadata"], "OTIO Transition.1");
  if (value.OTIO_SCHEMA !== "Transition.1" || value.transition_type !== "SMPTE_Dissolve") throw new Error(`只支持 active Transition.1/SMPTE_Dissolve，实际为 ${String(value.OTIO_SCHEMA || "unknown")}/${String(value.transition_type || "unknown")}。`);
  if (value.enabled !== undefined && value.enabled !== true) throw new Error("只接受 active SMPTE_Dissolve；disabled Transition 拒绝往返丢失。 ");
  requireOtioCompatibilityMetadata(value.metadata, "OTIO SMPTE_Dissolve");
  const inOffsetFrames = strictRationalFrames(value.in_offset, targetRate, "OTIO SMPTE_Dissolve.in_offset");
  const outOffsetFrames = strictRationalFrames(value.out_offset, targetRate, "OTIO SMPTE_Dissolve.out_offset");
  if (inOffsetFrames < 1 || outOffsetFrames < 1) throw new Error("OTIO SMPTE_Dissolve in/out offset 必须至少各 1 帧。 ");
  return { inOffsetFrames, outOffsetFrames };
}

function otioCompatibilityMetadata() {
  return { aicanvas: { contract: OTIO_EFFECT_TRANSITION_CONTRACT } };
}

async function probeOtioLocalMediaDurationFrames(projectRoot: string, filePath: string, targetRate: number): Promise<number> {
  const engine = await probeVideoEngine();
  if (!engine.ffprobePath) throw new Error("OTIO Effect/Transition 可保真导入需要 FFprobe 验证本地媒体时长。 ");
  const result = await runProcess(projectRoot, engine.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath], { tool: "ffprobe", stage: "otio-effect-transition-preflight", weight: MEDIA_WEIGHTS.probe, timeoutMs: mediaStageTimeout("ffprobe") });
  if (result.status !== "succeeded") throw new Error(`OTIO Effect/Transition 媒体无法通过 FFprobe：${path.basename(filePath)}。`);
  const duration = Number((JSON.parse(result.output) as { format?: { duration?: string } }).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`OTIO Effect/Transition 媒体缺少可证明时长：${path.basename(filePath)}。`);
  const frames = Math.floor(duration * targetRate + 1e-6);
  if (!Number.isSafeInteger(frames) || frames < 1) throw new Error(`OTIO Effect/Transition 媒体时长无法换算为项目帧：${path.basename(filePath)}。`);
  return frames;
}

async function validateOtioCompatibilityMediaRanges(projectRoot: string, project: EditProject): Promise<void> {
  const compatibilityClipIds = new Set<string>();
  for (const clip of project.tracks.flatMap((track) => track.clips)) {
    if (clip.playbackRate !== 1) compatibilityClipIds.add(clip.id);
    if (clip.transitionOut === "smpte_dissolve" && clip.transition) {
      compatibilityClipIds.add(clip.id);
      compatibilityClipIds.add(clip.transition.targetClipId);
    }
  }
  if (!compatibilityClipIds.size) return;
  const durationProbes = new Map<string, Promise<number>>();
  const clips = project.tracks.flatMap((track) => track.clips).filter((clip) => compatibilityClipIds.has(clip.id));
  await Promise.all(clips.map(async (clip) => {
    if (!clip.sourcePath || !clip.sourceAvailableRange) throw new Error(`${clip.name} 的 OTIO Effect/Transition 缺少可验证的本地媒体 available_range。`);
    let probe = durationProbes.get(clip.sourcePath);
    if (!probe) {
      probe = probeOtioLocalMediaDurationFrames(projectRoot, clip.sourcePath, projectFrameRate(project));
      durationProbes.set(clip.sourcePath, probe);
    }
    const actualDurationFrames = await probe;
    if (sourceRangeEnd(clip.sourceAvailableRange) > actualDurationFrames) throw new Error(`${clip.name} 声明的 available_range 超过本地媒体实际时长 ${actualDurationFrames} 帧。`);
  }));
}

function validateEmbeddedNestedOtioTracks(values: unknown[], depth = 1): void {
  if (depth > MAX_NESTED_TIMELINE_DEPTH) throw new Error(`OTIO 嵌套 Stack 深度超过 ${MAX_NESTED_TIMELINE_DEPTH}。`);
  for (const value of values) {
    const track = record(value);
    if (track.OTIO_SCHEMA !== "Track.1") throw new Error(`OTIO 嵌套 Stack 只能包含 Track.1，实际为 ${String(track.OTIO_SCHEMA || "unknown")}。`);
    requireEmptyOtioCollection(track.effects, "OTIO 嵌套轨道 effects");
    requireEmptyOtioCollection(track.markers, "OTIO 嵌套轨道 markers");
    if (!Array.isArray(track.children)) throw new Error("OTIO 嵌套轨道 children 必须是数组。 ");
    for (const childValue of track.children) {
      const child = record(childValue);
      requireEmptyOtioCollection(child.effects, "OTIO 嵌套子项 effects");
      requireEmptyOtioCollection(child.markers, "OTIO 嵌套子项 markers");
      if (["Gap.1", "Clip.2"].includes(String(child.OTIO_SCHEMA))) continue;
      if (child.OTIO_SCHEMA !== "Stack.1") throw new Error(`OTIO 嵌套轨道不支持 ${String(child.OTIO_SCHEMA || "unknown")}；拒绝静默跳过。`);
      const metadata = record(record(child.metadata).aicanvas);
      if (metadata.contract !== NESTED_TIMELINE_CONTRACT) throw new Error("OTIO 嵌套 Stack 缺少受支持的 AI Canvas 私有合同。 ");
      if (!Array.isArray(child.children)) throw new Error("OTIO 嵌套 Stack children 必须是数组。 ");
      validateEmbeddedNestedOtioTracks(child.children, depth + 1);
    }
  }
}

export async function importEditProjectOtio(projectRoot: string, filePath: string, name?: string): Promise<EditProject> {
  const absolutePath = path.resolve(filePath);
  const fileStat = await stat(absolutePath);
  if (fileStat.size <= 0 || fileStat.size > 20_000_000) throw new Error("OTIO 文件为空或超过 20MB。 ");
  const document = JSON.parse(await readFile(absolutePath, "utf8")) as Record<string, unknown>;
  if (document.OTIO_SCHEMA !== "Timeline.1") throw new Error("只支持 OpenTimelineIO Timeline.1 文档。 ");
  requireEmptyOtioCollection(document.effects, "OTIO Timeline effects");
  requireEmptyOtioCollection(document.markers, "OTIO Timeline markers");
  const documentTracks = record(document.tracks);
  if (documentTracks.OTIO_SCHEMA !== "Stack.1") throw new Error("OTIO Timeline.tracks 必须是 Stack.1。 ");
  requireEmptyOtioCollection(documentTracks.effects, "OTIO 根 Stack effects");
  requireEmptyOtioCollection(documentTracks.markers, "OTIO 根 Stack markers");
  const metadata = record(record(document.metadata).aicanvas);
  const curveContract = typeof metadata.keyframeCurveContract === "string" ? metadata.keyframeCurveContract : undefined;
  if (curveContract && !EDIT_KEYFRAME_CURVE_CONTRACTS.some((supported) => supported === curveContract)) throw new Error(`不支持 OTIO 关键帧曲线合同 ${curveContract}；拒绝静默降级。`);
  const nestedTimelineContract = typeof metadata.nestedTimelineContract === "string" ? metadata.nestedTimelineContract : undefined;
  if (nestedTimelineContract && nestedTimelineContract !== NESTED_TIMELINE_CONTRACT) throw new Error(`不支持 OTIO 嵌套时间线合同 ${nestedTimelineContract}；拒绝静默降级。`);
  const effectTransitionContract = typeof metadata.effectTransitionContract === "string" ? metadata.effectTransitionContract : undefined;
  if (effectTransitionContract && effectTransitionContract !== OTIO_EFFECT_TRANSITION_CONTRACT) throw new Error(`不支持 OTIO Effect/Transition 合同 ${effectTransitionContract}；拒绝静默降级。`);
  const inferredRate = firstOtioRate(document);
  const importedTimebase = timebaseForFrameRate(Math.max(12, Math.min(120, Number(metadata.fps) || inferredRate || 24)));
  const fps = importedTimebase.rateNumerator / importedTimebase.rateDenominator;
  const importWidth = Number(metadata.width) || 1080;
  const importHeight = Number(metadata.height) || 1920;
  const importedTracks: EditTrack[] = [];
  const trackDocuments = Array.isArray(documentTracks.children) ? documentTracks.children as unknown[] : [];
  if (!trackDocuments.length || trackDocuments.length > MAX_TRACKS) throw new Error(`OTIO 轨道数量必须为 1–${MAX_TRACKS}。`);
  for (const [trackIndex, trackValue] of trackDocuments.entries()) {
    const trackDocument = record(trackValue);
    if (trackDocument.OTIO_SCHEMA !== "Track.1") throw new Error(`暂不支持 OTIO 轨道容器 ${String(trackDocument.OTIO_SCHEMA || "unknown")}；拒绝静默丢失嵌套时间线。`);
    requireEmptyOtioCollection(trackDocument.effects, "OTIO 轨道 effects");
    requireEmptyOtioCollection(trackDocument.markers, "OTIO 轨道 markers");
    const trackMetadata = record(record(trackDocument.metadata).aicanvas);
    const trackKind = ["visual", "audio", "subtitle"].includes(String(trackMetadata.kind)) ? String(trackMetadata.kind) as EditTrack["kind"] : trackDocument.kind === "Audio" ? "audio" : "visual";
    const trackId = `track-${randomUUID()}`;
    const track: EditTrack = { id: trackId, kind: trackKind, name: safeName(String(trackDocument.name || `${trackKind} ${trackIndex + 1}`)), order: trackIndex, locked: Boolean(trackMetadata.locked), muted: Boolean(trackMetadata.muted), hidden: Boolean(trackMetadata.hidden), clips: [] };
    let cursorFrame = 0;
    if (!Array.isArray(trackDocument.children)) throw new Error("OTIO 轨道 children 必须是数组；拒绝静默丢失片段。 ");
    const children = trackDocument.children;
    let previousChildWasClip = false;
    let pendingTransition: { outgoing: EditClip; inOffsetFrames: number; outOffsetFrames: number } | undefined;
    for (const childValue of children) {
      const child = record(childValue);
      if (child.OTIO_SCHEMA === "Transition.1") {
        if (pendingTransition || !previousChildWasClip) throw new Error("OTIO SMPTE_Dissolve 必须位于两个普通 Clip.2 之间，不能连续或邻接 Gap/Stack。 ");
        if (trackIndex !== 0 || trackKind !== "visual") throw new Error("OTIO SMPTE_Dissolve 只支持最低 order 主视觉轨。 ");
        requireEmptyOtioCollection(child.effects, "OTIO Transition effects");
        requireEmptyOtioCollection(child.markers, "OTIO Transition markers");
        const outgoing = track.clips.at(-1);
        if (!outgoing || outgoing.kind !== "video") throw new Error("OTIO SMPTE_Dissolve 前项必须是普通视频 Clip.2。 ");
        const parsed = parseOtioSmpteDissolve(child, fps);
        if (outgoing.playbackRate !== 1) throw new Error("OTIO SMPTE_Dissolve 不支持与 LinearTimeWarp 组合。 ");
        const privateTransition = outgoing.transition;
        if (outgoing.transitionOut !== undefined && outgoing.transitionOut !== "cut" && outgoing.transitionOut !== "smpte_dissolve") throw new Error("OTIO 标准 SMPTE_Dissolve 与 AI Canvas 私有 transitionOut 冲突。 ");
        if (privateTransition && (privateTransition.contract !== OTIO_TRANSITION_CONTRACT || privateTransition.kind !== "smpte_dissolve" || privateTransition.inOffsetFrames !== parsed.inOffsetFrames || privateTransition.outOffsetFrames !== parsed.outOffsetFrames)) throw new Error("OTIO 标准 SMPTE_Dissolve 与 AI Canvas 私有 transition metadata 冲突。 ");
        pendingTransition = { outgoing, ...parsed };
        previousChildWasClip = false;
        continue;
      }
      if (pendingTransition && child.OTIO_SCHEMA !== "Clip.2") throw new Error("OTIO SMPTE_Dissolve 后项必须是普通视频 Clip.2。 ");
      if (!["Gap.1", "Clip.2", "Stack.1"].includes(String(child.OTIO_SCHEMA))) throw new Error(`暂不支持 OTIO 子项 ${String(child.OTIO_SCHEMA || "unknown")}；拒绝静默跳过 Effect、Transition 或嵌套 Stack。`);
      requireEmptyOtioCollection(child.markers, "OTIO 子项 markers");
      const range = requiredOtioRecord(child.source_range, "OTIO 子项 source_range");
      if (range.OTIO_SCHEMA !== "TimeRange.1") throw new Error("OTIO 子项 source_range 必须使用 TimeRange.1。 ");
      const sourceDurationFrames = rationalFrames(range.duration, fps).frames;
      const timeScalar = child.OTIO_SCHEMA === "Clip.2" ? parseOtioLinearTimeWarp(child.effects, `OTIO Clip ${String(child.name || "未命名")}`) : 1;
      const duration = timeScalar === 1 ? sourceDurationFrames : exactUnscaledFrameCount(sourceDurationFrames, timeScalar, `OTIO Clip ${String(child.name || "未命名")} 的 LinearTimeWarp`);
      if (duration < 0) throw new Error("OTIO 子项时长不能为负数。 ");
      if (child.OTIO_SCHEMA === "Gap.1") { requireEmptyOtioCollection(child.effects, "OTIO Gap effects"); cursorFrame += duration; previousChildWasClip = false; continue; }
      if (child.OTIO_SCHEMA === "Stack.1") {
        if (trackKind !== "visual") throw new Error("OTIO 嵌套 Stack 只能位于视觉轨道。 ");
        if (nestedTimelineContract !== NESTED_TIMELINE_CONTRACT) throw new Error("OTIO 嵌套 Stack 缺少根级 AI Canvas 私有合同声明。 ");
        requireEmptyOtioCollection(child.effects, "OTIO 嵌套 Stack effects");
        requireEmptyOtioCollection(child.markers, "OTIO 嵌套 Stack markers");
        if (duration <= 0) throw new Error("OTIO 嵌套 Stack 时长必须为正数。 ");
        const nestedMetadata = record(record(child.metadata).aicanvas);
        if (nestedMetadata.contract !== NESTED_TIMELINE_CONTRACT) throw new Error("OTIO 嵌套 Stack 私有合同缺失或不受支持。 ");
        const embeddedTracks = Array.isArray(child.children) ? child.children : undefined;
        if (!embeddedTracks) throw new Error("OTIO 嵌套 Stack children 必须是数组。 ");
        validateEmbeddedNestedOtioTracks(embeddedTracks);
        if (typeof nestedMetadata.embeddedOtioSha256 !== "string" || sha256Json(embeddedTracks) !== nestedMetadata.embeddedOtioSha256) throw new Error("OTIO 嵌套 Stack 标准视图哈希不一致。 ");
        const nestedTimeline = structuredClone(nestedMetadata.nestedTimeline) as EditNestedTimelineRef;
        if (!nestedTimeline || typeof nestedTimeline !== "object" || nestedTimeline.contract !== NESTED_TIMELINE_CONTRACT) throw new Error("OTIO 嵌套 Stack 缺少冻结引用。 ");
        const snapshot = await readEditProjectDependencySnapshot(projectRoot, nestedTimeline.childSnapshotSha256);
        if (typeof nestedMetadata.embeddedProjectSha256 !== "string" || sha256Json(snapshot.project) !== nestedMetadata.embeddedProjectSha256) throw new Error("OTIO 嵌套 Stack 的冻结工程哈希不一致。 ");
        const validatedSnapshotProject = await validateEditProject(projectRoot, structuredClone(snapshot.project));
        const embeddedSnapshots = await collectEditDependencySnapshots(projectRoot, validatedSnapshotProject);
        const canonicalEmbeddedTracks = editProjectOtioTracks(validatedSnapshotProject, embeddedSnapshots);
        if (sha256Json(canonicalEmbeddedTracks) !== sha256Json(embeddedTracks)) throw new Error("OTIO 嵌套 Stack 标准视图与冻结工程不一致。 ");
        const standardOffset = rationalFrames(range.start_time, fps).frames;
        const expectedOffset = rationalQuotientInteger(nestedTimeline.sourceOffset, nestedTimeline.sourceStep, "OTIO 嵌套 Stack source_range");
        if (standardOffset !== expectedOffset) throw new Error("OTIO 嵌套 Stack 标准 source_range 与精确有理映射不一致。 ");
        const clipMetadata = requiredOtioRecord(nestedMetadata.clip, "OTIO 嵌套 Stack 私有 clip metadata");
        if (clipMetadata.kind !== "timeline") throw new Error("OTIO 嵌套 Stack 私有 clip kind 必须是 timeline。 ");
        if (typeof clipMetadata.id !== "string" || !clipMetadata.id || typeof clipMetadata.trackId !== "string" || !clipMetadata.trackId || typeof clipMetadata.name !== "string" || !clipMetadata.name) throw new Error("OTIO 嵌套 Stack 私有 clip 身份不完整。 ");
        if (!Number.isSafeInteger(clipMetadata.startFrame) || Number(clipMetadata.startFrame) !== cursorFrame) throw new Error("OTIO 嵌套 Stack 标准起点与私有 metadata 不一致。 ");
        if (!Number.isSafeInteger(clipMetadata.durationFrames) || Number(clipMetadata.durationFrames) !== duration) throw new Error("OTIO 嵌套 Stack 标准时长与私有 metadata 不一致。 ");
        if (clipMetadata.trimStartFrame !== 0 || clipMetadata.trimStartSeconds !== 0 || clipMetadata.playbackRate !== 1) throw new Error("OTIO 嵌套 Stack 私有 clip 的源偏移或播放速率无效。 ");
        if (![clipMetadata.startSeconds, clipMetadata.durationSeconds, clipMetadata.volume, clipMetadata.opacity, clipMetadata.positionX, clipMetadata.positionY, clipMetadata.scale, clipMetadata.rotation, clipMetadata.filterIntensity].every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("OTIO 嵌套 Stack 私有 clip 数值字段不完整。 ");
        if (typeof clipMetadata.muted !== "boolean" || typeof clipMetadata.filter !== "string" || !Array.isArray(clipMetadata.keyframes)) throw new Error("OTIO 嵌套 Stack 私有 clip 结构不完整。 ");
        const clip: EditClip = {
          id: `clip-${randomUUID()}`,
          trackId,
          kind: "timeline",
          name: safeName(String(child.name || snapshot.project.name)),
          nestedTimeline,
          startFrame: cursorFrame,
          durationFrames: duration,
          trimStartFrame: 0,
          startSeconds: cursorFrame / fps,
          durationSeconds: duration / fps,
          trimStartSeconds: 0,
          playbackRate: 1,
          volume: Number(clipMetadata.volume ?? 1),
          opacity: Number(clipMetadata.opacity ?? 1),
          muted: Boolean(clipMetadata.muted),
          positionX: Number(clipMetadata.positionX ?? 0),
          positionY: Number(clipMetadata.positionY ?? 0),
          scale: Number(clipMetadata.scale ?? 1),
          rotation: Number(clipMetadata.rotation ?? 0),
          filter: typeof clipMetadata.filter === "string" ? clipMetadata.filter as EditClip["filter"] : "none",
          filterIntensity: Number(clipMetadata.filterIntensity ?? 1),
          keyframes: Array.isArray(clipMetadata.keyframes) ? structuredClone(clipMetadata.keyframes) as EditKeyframe[] : [],
          fadeInSeconds: Number(clipMetadata.fadeInSeconds ?? 0),
          fadeOutSeconds: Number(clipMetadata.fadeOutSeconds ?? 0),
          transitionOut: clipMetadata.transitionOut === "fade" ? "fade" : "cut",
          transitionDurationSeconds: Number(clipMetadata.transitionDurationSeconds ?? .5),
          note: typeof clipMetadata.note === "string" ? clipMetadata.note : undefined,
        };
        track.clips.push(clip);
        cursorFrame += duration;
        previousChildWasClip = false;
        continue;
      }
      if (child.OTIO_SCHEMA !== "Clip.2") throw new Error(`暂不支持 OTIO 子项 ${String(child.OTIO_SCHEMA || "unknown")}。`);
      if (duration <= 0) throw new Error("OTIO Clip 时长必须为正数。 ");
      const clipMetadata = record(record(child.metadata).aicanvas);
      if (clipMetadata.keyframes !== undefined && !Array.isArray(clipMetadata.keyframes)) throw new Error("OTIO AI Canvas 关键帧 metadata 必须是数组；拒绝静默丢失。 ");
      const keyframes: NonNullable<EditClip["keyframes"]> = Array.isArray(clipMetadata.keyframes) ? structuredClone(clipMetadata.keyframes) as NonNullable<EditClip["keyframes"]> : [];
      if (keyframes.length > MAX_KEYFRAMES_PER_CLIP) throw new Error(`OTIO AI Canvas 单片段关键帧不能超过 ${MAX_KEYFRAMES_PER_CLIP} 个。`);
      const hasCustomCurve = keyframes.some((keyframe) => keyframe?.easing === "cubic_bezier");
      const hasDerivedCurve = keyframes.some((keyframe) => keyframe?.bezier?.mode === "derived_monotone");
      if (hasCustomCurve && !curveContract) throw new Error(`OTIO 自定义关键帧曲线缺少 ${hasDerivedCurve ? EDIT_KEYFRAME_CURVE_CONTRACT : LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT} 合同；拒绝静默降级。`);
      if (curveContract === LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT && hasDerivedCurve) throw new Error(`OTIO ${LEGACY_EDIT_KEYFRAME_CURVE_CONTRACT} 不能承载 derived_monotone 子曲线；必须使用 ${EDIT_KEYFRAME_CURVE_CONTRACT}。`);
      const importedKeyframeIds = new Set<string>();
      const importedKeyframeFrames = new Set<number>();
      for (const keyframe of keyframes) {
        if (!keyframe || typeof keyframe !== "object") throw new Error("OTIO AI Canvas 关键帧结构无效。 ");
        if (typeof keyframe.id !== "string" || !keyframe.id || importedKeyframeIds.has(keyframe.id)) throw new Error("OTIO AI Canvas 存在重复或空关键帧 ID。 ");
        importedKeyframeIds.add(keyframe.id);
        if (!Number.isFinite(keyframe.timeSeconds)) throw new Error("OTIO AI Canvas 关键帧时间超出片段范围。 ");
        if (![keyframe.positionX, keyframe.positionY, keyframe.scale, keyframe.rotation].every(Number.isFinite)) throw new Error("OTIO AI Canvas 关键帧包含无效数值。 ");
        if (Math.abs(keyframe.positionX) > importWidth * 4 || Math.abs(keyframe.positionY) > importHeight * 4 || keyframe.scale < .02 || keyframe.scale > 4 || Math.abs(keyframe.rotation) > 3_600) throw new Error("OTIO AI Canvas 关键帧变换超出安全范围。 ");
        // AI Canvas 的时间合同以整数帧为权威。分数帧率下，端点秒数会按毫秒
        // 落盘（例如 7 / 23.976 -> 0.292），不能拿这个近似值与精确秒数比较。
        const keyframeFrame = Number.isInteger(keyframe.frame) ? Number(keyframe.frame) : Math.round(keyframe.timeSeconds * fps);
        if (keyframeFrame < 0 || keyframeFrame > duration) throw new Error("OTIO AI Canvas 关键帧时间超出片段范围。 ");
        if (importedKeyframeFrames.has(keyframeFrame)) throw new Error(`OTIO AI Canvas 存在量化到同一帧 F${keyframeFrame} 的重复关键帧。`);
        importedKeyframeFrames.add(keyframeFrame);
        keyframe.frame = keyframeFrame;
        keyframe.timeSeconds = roundTime(keyframeFrame / fps);
        const issue = editKeyframeCurveIssue(keyframe.easing, keyframe.bezier);
        if (issue) throw new Error(`OTIO AI Canvas ${issue}`);
        const sourceTransformIssue = editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
        if (sourceTransformIssue) throw new Error(`OTIO AI Canvas ${sourceTransformIssue}`);
      }
      const mediaReference = record(child.media_reference);
      const targetUrl = typeof mediaReference.target_url === "string" ? mediaReference.target_url : undefined;
      const sourcePath = targetUrl?.startsWith("file:") ? fileURLToPath(targetUrl) : undefined;
      const inferredKind: EditClip["kind"] = trackKind === "audio" ? "audio" : trackKind === "subtitle" ? "subtitle" : sourcePath && /\.(png|jpe?g|webp)$/i.test(sourcePath) ? "image" : "video";
      if (["video", "image", "audio"].includes(inferredKind) && (!sourcePath || !path.isAbsolute(sourcePath))) throw new Error("OTIO 媒体片段缺少可导入的本地绝对路径；拒绝创建残留工程。 ");
      if (sourcePath) await access(sourcePath, fsConstants.R_OK).catch(() => { throw new Error(`OTIO 媒体不存在或不可读：${sourcePath}`); });
      if (timeScalar !== 1 && !["video", "audio"].includes(inferredKind)) throw new Error("OTIO LinearTimeWarp.1 只支持普通视频或音频 Clip.2。 ");
      const sourceAvailableRange = parseOtioAvailableRange(mediaReference.available_range, fps, `OTIO Clip ${String(child.name || "未命名")}`);
      const trimStart = rationalFrames(range.start_time, fps).frames;
      const privatePlaybackRate = clipMetadata.playbackRate === undefined ? undefined : Number(clipMetadata.playbackRate);
      const legacyPrivateTimeWarp = timeScalar === 1 && !effectTransitionContract && privatePlaybackRate !== undefined && privatePlaybackRate !== 1;
      const playbackRate = legacyPrivateTimeWarp ? privatePlaybackRate! : timeScalar;
      if (privatePlaybackRate !== undefined && (!Number.isFinite(privatePlaybackRate) || privatePlaybackRate <= 0 || (!legacyPrivateTimeWarp && Math.abs(privatePlaybackRate - timeScalar) > 1e-12))) throw new Error("OTIO 标准 LinearTimeWarp 与 AI Canvas 私有 playbackRate 冲突。 ");
      if (timeScalar !== 1 && !sourceAvailableRange) throw new Error("OTIO LinearTimeWarp.1 缺少可证明的 ExternalReference.available_range。 ");
      const privateTransitionOut = clipMetadata.transitionOut === "fade" ? "fade" : clipMetadata.transitionOut === "smpte_dissolve" ? "smpte_dissolve" : "cut";
      const privateTransition = clipMetadata.transition && typeof clipMetadata.transition === "object" ? structuredClone(clipMetadata.transition) as EditClip["transition"] : undefined;
      const clip: EditClip = {
        id: `clip-${randomUUID()}`, trackId, kind: inferredKind, name: safeName(String(child.name || path.basename(sourcePath ?? "字幕"))), sourcePath, artifactId: typeof clipMetadata.artifactId === "string" ? clipMetadata.artifactId : undefined, itemId: typeof clipMetadata.itemId === "string" ? clipMetadata.itemId : undefined,
        sourceAvailableRange,
        startSeconds: cursorFrame / fps, durationSeconds: duration / fps, trimStartSeconds: trimStart / fps, startFrame: cursorFrame, durationFrames: duration, trimStartFrame: trimStart,
        playbackRate, volume: Number(clipMetadata.volume ?? 1), opacity: Number(clipMetadata.opacity ?? 1), muted: Boolean(clipMetadata.muted),
        positionX: Number(clipMetadata.positionX ?? 0), positionY: Number(clipMetadata.positionY ?? 0), scale: Number(clipMetadata.scale ?? 1), rotation: Number(clipMetadata.rotation ?? 0), filter: typeof clipMetadata.filter === "string" ? clipMetadata.filter as EditClip["filter"] : "none", filterIntensity: Number(clipMetadata.filterIntensity ?? 1), keyframes,
        fadeInSeconds: Number(clipMetadata.fadeInSeconds ?? 0), fadeOutSeconds: Number(clipMetadata.fadeOutSeconds ?? 0), transitionOut: privateTransitionOut, transitionDurationSeconds: clipMetadata.transitionDurationSeconds === undefined ? undefined : Number(clipMetadata.transitionDurationSeconds), transition: privateTransition, text: typeof clipMetadata.text === "string" ? clipMetadata.text : undefined, fontSize: Number(clipMetadata.fontSize) || undefined, fontColor: typeof clipMetadata.fontColor === "string" ? clipMetadata.fontColor : undefined, subtitleBackground: typeof clipMetadata.subtitleBackground === "string" ? clipMetadata.subtitleBackground : undefined, note: typeof clipMetadata.note === "string" ? clipMetadata.note : undefined,
      };
      if (pendingTransition) {
        if (clip.kind !== "video" || playbackRate !== 1) throw new Error("OTIO SMPTE_Dissolve 后项必须是未变速普通视频 Clip.2。 ");
        pendingTransition.outgoing.transitionOut = "smpte_dissolve";
        pendingTransition.outgoing.transitionDurationSeconds = undefined;
        pendingTransition.outgoing.transition = {
          contract: OTIO_TRANSITION_CONTRACT,
          kind: "smpte_dissolve",
          targetClipId: clip.id,
          inOffsetFrames: pendingTransition.inOffsetFrames,
          outOffsetFrames: pendingTransition.outOffsetFrames,
        };
        pendingTransition = undefined;
      }
      track.clips.push(clip);
      cursorFrame += duration;
      previousChildWasClip = true;
    }
    if (pendingTransition) throw new Error("OTIO SMPTE_Dissolve 缺少后继普通视频 Clip.2。 ");
    importedTracks.push(track);
  }
  if (!importedTracks.some((track) => track.kind === "visual")) throw new Error("OTIO 文档没有可导入的视频轨道。 ");
  for (const kind of ["audio", "subtitle"] as const) if (!importedTracks.some((track) => track.kind === kind)) importedTracks.push({ id: `track-${randomUUID()}`, kind, name: kind === "audio" ? "配音 / 音乐" : "字幕", order: importedTracks.length, locked: false, muted: false, hidden: false, clips: [] });
  const config = await loadProjectConfig(projectRoot);
  const now = new Date().toISOString();
  const candidate: EditProject = {
    schemaVersion: 1,
    id: `edit-${randomUUID()}`,
    projectId: config.id,
    name: safeName(name ?? String(document.name || path.basename(filePath, path.extname(filePath)))),
    width: importWidth,
    height: importHeight,
    fps: importedTimebase.fps,
    timebase: { rateNumerator: importedTimebase.rateNumerator, rateDenominator: importedTimebase.rateDenominator },
    backgroundColor: typeof metadata.backgroundColor === "string" ? metadata.backgroundColor : "#000000",
    tracks: importedTracks,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  await validateOtioCompatibilityMediaRanges(projectRoot, candidate);
  const validated = await validateEditProject(projectRoot, candidate);
  await Promise.all([
    writeJsonAtomic(projectFile(projectRoot, validated.id), validated),
    saveEditHistory(projectRoot, validated.id, { schemaVersion: 1, past: [], future: [], updatedAt: now }),
  ]);
  await appendEvent(projectRoot, { actor: "user", type: "editor.otio-imported", data: { editProjectId: validated.id, path: absolutePath, revision: validated.revision } });
  return validated;
}

function mainVisualTrack(project: Pick<EditProject, "tracks">): EditTrack | undefined {
  return project.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0];
}

function renderDurationFrames(project: EditProject): number {
  const baseTrack = mainVisualTrack(project);
  if (!baseTrack || baseTrack.hidden || baseTrack.muted) return 0;
  return Math.max(0, ...baseTrack.clips.map((clip) => editClipStartFrame(project, clip) + editClipDurationFrames(project, clip)));
}

function renderDuration(project: EditProject): number {
  return renderDurationFrames(project) / projectFrameRate(project);
}

function outputFileName(project: EditProject): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${safeName(project.name)}_${stamp}_v${String(project.revision).padStart(3, "0")}.mp4`;
}

interface SubtitleOverlay {
  clip: EditClip;
  path: string;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function subtitleLines(text: string, maxCharacters: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    const clean = paragraph.trim();
    if (!clean) continue;
    for (let index = 0; index < clean.length; index += maxCharacters) lines.push(clean.slice(index, index + maxCharacters));
  }
  return lines.slice(0, 4);
}

async function createSubtitleOverlays(project: EditProject, directory: string): Promise<SubtitleOverlay[]> {
  const clips = project.tracks
    .filter((track) => track.kind === "subtitle" && !track.hidden && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === "subtitle" && clip.text?.trim())
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (!clips.length) return [];
  await mkdir(directory, { recursive: true });
  const overlays: SubtitleOverlay[] = [];
  for (const [index, clip] of clips.entries()) {
    const fontSize = Math.round(clip.fontSize ?? Math.max(28, project.width * 0.046));
    const lines = subtitleLines(clip.text!, Math.max(8, Math.floor(project.width / (fontSize * 1.04))));
    const lineHeight = Math.round(fontSize * 1.35);
    const boxHeight = lines.length * lineHeight + Math.round(fontSize * 0.9);
    const boxY = Math.max(20, project.height - boxHeight - Math.round(project.height * 0.075));
    const fontColor = /^#[0-9a-f]{6}$/i.test(clip.fontColor ?? "") ? clip.fontColor! : "#ffffff";
    const background = /^#[0-9a-f]{6}$/i.test(clip.subtitleBackground ?? "") ? clip.subtitleBackground! : "#000000";
    const tspans = lines.map((line, lineIndex) => `<tspan x="${project.width / 2}" y="${boxY + Math.round(fontSize * 1.15) + lineIndex * lineHeight}">${xmlEscape(line)}</tspan>`).join("");
    const svg = `<svg width="${project.width}" height="${project.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${Math.round(project.width * 0.07)}" y="${boxY}" width="${Math.round(project.width * 0.86)}" height="${boxHeight}" rx="${Math.round(fontSize * 0.35)}" fill="${background}" fill-opacity="0.72"/><text text-anchor="middle" font-family="PingFang SC,Heiti SC,Arial,sans-serif" font-size="${fontSize}" font-weight="600" fill="${fontColor}" stroke="#000000" stroke-width="${Math.max(1, Math.round(fontSize * 0.04))}" paint-order="stroke" letter-spacing="1">${tspans}</text></svg>`;
    const overlayPath = path.join(directory, `subtitle-${String(index + 1).padStart(3, "0")}.png`);
    await sharp(Buffer.from(svg)).png().toFile(overlayPath);
    overlays.push({ clip, path: overlayPath });
  }
  return overlays;
}

function atempoChain(rate: number): string[] {
  const filters: string[] = [];
  let remaining = rate;
  while (remaining > 2) { filters.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { filters.push("atempo=0.5"); remaining /= 0.5; }
  if (Math.abs(remaining - 1) > 0.0001) filters.push(`atempo=${roundTime(remaining)}`);
  return filters;
}

function timelineAudioSampleForFrame(project: Pick<EditProject, "fps" | "timebase">, frame: number): number {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error("时间线音频帧位置必须是非负安全整数。 ");
  const timebase = normalizedProjectTimebase(project);
  const samples = BigInt(frame) * 48_000n * BigInt(timebase.rateDenominator) / BigInt(timebase.rateNumerator);
  if (samples > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("时间线音频采样位置超出安全范围。 ");
  return Number(samples);
}

function temporalVideoFilter(project: Pick<EditProject, "fps" | "timebase">, clip: EditClip, handles: { preFrames?: number; postFrames?: number } = {}): string {
  if (clip.kind === "timeline" && clip.nestedTimeline) {
    const startFrame = rationalQuotientInteger(clip.nestedTimeline.sourceOffset, clip.nestedTimeline.sourceStep, `${clip.name} 的嵌套代理起点`);
    const durationFrames = Math.max(1, clip.durationFrames ?? 1);
    return `trim=start_frame=${startFrame}:end_frame=${startFrame + durationFrames},setpts=PTS-STARTPTS`;
  }
  const preFrames = handles.preFrames ?? 0;
  const postFrames = handles.postFrames ?? 0;
  if (preFrames || postFrames) {
    if (clip.kind !== "video" || clip.playbackRate !== 1) throw new Error(`${clip.name} 的 SMPTE Dissolve handle 只支持未变速普通视频。`);
    const startFrame = (clip.trimStartFrame ?? 0) - preFrames;
    const endFrame = (clip.trimStartFrame ?? 0) + editClipDurationFrames(project, clip) + postFrames;
    if (startFrame < 0) throw new Error(`${clip.name} 的 SMPTE Dissolve 头部 handle 越界。`);
    return `trim=start=${ffmpegSecondsForFrame(project, startFrame)}:end=${ffmpegSecondsForFrame(project, endFrame)},setpts=PTS-STARTPTS`;
  }
  const sourceDuration = roundTime(clip.durationSeconds * clip.playbackRate);
  return clip.kind === "video"
    ? `trim=start=${clip.trimStartSeconds}:end=${roundTime(clip.trimStartSeconds + sourceDuration)},setpts=(PTS-STARTPTS)/${clip.playbackRate}`
    : `trim=duration=${clip.durationSeconds},setpts=PTS-STARTPTS`;
}

function visualFilterChain(clip: EditClip): string[] {
  const intensity = Math.max(0, Math.min(2, clip.filterIntensity ?? 1));
  switch (clip.filter ?? "none") {
    case "grayscale": return [`hue=s=${roundTime(1 - Math.min(1, intensity))}`];
    case "sepia": return ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"];
    case "warm": return [`colorbalance=rs=${roundTime(.13 * intensity)}:gs=${roundTime(.04 * intensity)}:bs=${roundTime(-.1 * intensity)}`];
    case "cool": return [`colorbalance=rs=${roundTime(-.1 * intensity)}:gs=${roundTime(.02 * intensity)}:bs=${roundTime(.14 * intensity)}`];
    case "vivid": return [`eq=saturation=${roundTime(1 + .8 * intensity)}`];
    case "contrast": return [`eq=contrast=${roundTime(1 + .45 * intensity)}`];
    case "blur": return [`boxblur=${roundTime(.6 + intensity * 2.2)}:1`];
    default: return [];
  }
}

function keyframeExpression(project: EditProject, clip: EditClip, property: "positionX" | "positionY" | "scale" | "rotation", variableFrame: string): string {
  const points = editTransformFramePoints(clip, projectFrameRate(project)).map((point) => ({ ...point, value: Number(point[property]) }));
  if (points.length === 1) return String(roundTransform(points[0]!.value));
  let expression = String(roundTransform(points.at(-1)!.value));
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const delta = roundTransform(end.value - start.value);
    const durationFrames = Math.max(1, end.frame - start.frame);
    const frameOffsetExpression = `(${variableFrame}-${start.frame})`;
    const ratio = `max(0,min(1,(${frameOffsetExpression})/${durationFrames}))`;
    const interpolated = end.bezier?.mode === "derived_monotone"
      ? buildFfmpegKeyframeSourceTransformExpression(end, property, frameOffsetExpression, durationFrames)
      : `${roundTransform(start.value)}+(${delta})*(${buildFfmpegEasingExpression(end.easing, ratio, end.bezier, { frameOffsetExpression, segmentFrames: durationFrames })})`;
    expression = `if(lt(${variableFrame},${end.frame}),${interpolated},${expression})`;
  }
  return expression;
}

function visualTransformExpressions(project: EditProject, clip: EditClip, transformFrame: string, positionFrame = transformFrame, rotationFrame = transformFrame): { positionX: string; positionY: string; scale: string; rotation: string } {
  return {
    positionX: keyframeExpression(project, clip, "positionX", positionFrame),
    positionY: keyframeExpression(project, clip, "positionY", positionFrame),
    scale: keyframeExpression(project, clip, "scale", transformFrame),
    rotation: keyframeExpression(project, clip, "rotation", rotationFrame),
  };
}

function rotationCanvasSize(project: EditProject, clip: EditClip): number {
  const scales = [
    Number(clip.scale ?? 1),
    ...(clip.keyframes ?? []).flatMap((keyframe) => [keyframe.scale, keyframe.sourceTransform?.start.scale, keyframe.sourceTransform?.end.scale]),
  ].filter((value): value is number => Number.isFinite(value));
  // rotate 的 ow/oh 只在初始化时求值，不能依赖前一层逐帧 scale 的首帧尺寸。
  // 等比适配后的前景始终位于项目矩形内，因此项目对角线 × 本片段最大缩放
  // 是所有合法动态角度的固定安全包围盒。
  return Math.max(2, Math.ceil(Math.hypot(project.width, project.height) * Math.max(...scales, 1)));
}

function mainClipNeedsComposition(clip: EditClip): boolean {
  return (clip.keyframes?.length ?? 0) > 0
    || Math.abs(Number(clip.positionX ?? 0)) > 1e-12
    || Math.abs(Number(clip.positionY ?? 0)) > 1e-12
    || Math.abs(Number(clip.scale ?? 1) - 1) > 1e-12
    || Math.abs(Number(clip.rotation ?? 0)) > 1e-12
    || Math.abs(Number(clip.opacity ?? 1) - 1) > 1e-12;
}

function buildFfmpegArgs(project: EditProject, outputPath: string, subtitleOverlays: SubtitleOverlay[], options: { withProgress?: boolean; frameAtSeconds?: number; lossless?: boolean } = {}): string[] {
  const visualTracks = project.tracks.filter((track) => track.kind === "visual").sort((a, b) => a.order - b.order);
  const baseTrack = visualTracks[0];
  if (!baseTrack) throw new Error("剪辑工程没有可渲染的主画面轨道。");
  if (baseTrack.hidden || baseTrack.muted) throw new Error("主画面轨道已隐藏或静音；拒绝把叠加轨静默提升为主画面。");
  const baseClips = baseTrack.clips.filter((clip) => ["video", "image", "timeline"].includes(clip.kind)).sort((a, b) => editClipStartFrame(project, a) - editClipStartFrame(project, b));
  if (!baseClips.length) throw new Error("主画面轨道没有可渲染片段。");
  let cursorFrame = 0;
  for (const clip of baseClips) {
    const startFrame = editClipStartFrame(project, clip);
    if (startFrame !== cursorFrame) throw new Error(`主画面轨道存在空隙或非连续时间：${clip.name} 应从 F${cursorFrame} 开始，实际为 F${startFrame}。`);
    cursorFrame += editClipDurationFrames(project, clip);
  }
  const totalFrames = cursorFrame;
  const totalDuration = totalFrames / projectFrameRate(project);
  const outgoingDissolves = new Map(baseClips.flatMap((clip) => clip.transitionOut === "smpte_dissolve" && clip.transition ? [[clip.id, clip.transition] as const] : []));
  const incomingDissolves = new Map([...outgoingDissolves.values()].map((transition) => [transition.targetClipId, transition] as const));
  const overlayEntries = visualTracks.slice(1).filter((track) => !track.hidden && !track.muted).flatMap((track) => track.clips
    .filter((clip) => ["video", "image", "timeline"].includes(clip.kind) && !clip.muted)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((clip) => ({ track, clip })));
  const visualEntries = [
    ...baseClips.filter((clip) => !clip.muted).map((clip) => ({ track: baseTrack, clip })),
    ...overlayEntries,
  ];
  const inputIndexByClip = new Map(visualEntries.map((entry, index) => [entry.clip.id, index]));
  const frameRate = ffmpegFrameRate(project);
  const renderTimebase = timebaseForFrameRate(projectFrameRate(project));
  const args: string[] = ["-hide_banner", "-loglevel", "warning"];
  if (options.withProgress) args.push("-progress", "pipe:1", "-nostats");
  for (const { clip } of visualEntries) {
    if (clip.kind === "image") args.push("-loop", "1", "-framerate", frameRate);
    args.push("-i", clip.sourcePath!);
  }
  const standaloneAudioClips = options.frameAtSeconds === undefined ? project.tracks
    .filter((track) => track.kind === "audio" && !track.hidden && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === "audio" && !clip.muted)
    .sort((a, b) => a.startSeconds - b.startSeconds) : [];
  for (const clip of standaloneAudioClips) args.push("-i", clip.sourcePath!);
  for (const overlay of subtitleOverlays) args.push("-loop", "1", "-framerate", frameRate, "-i", overlay.path);

  const background = project.backgroundColor.replace("#", "0x");
  const filters: string[] = [];
  baseClips.forEach((clip, index) => {
    const durationFrames = editClipDurationFrames(project, clip);
    const outgoingDissolve = outgoingDissolves.get(clip.id);
    const incomingDissolve = incomingDissolves.get(clip.id);
    const renderedDurationFrames = durationFrames + (incomingDissolve?.inOffsetFrames ?? 0) + (outgoingDissolve?.outOffsetFrames ?? 0);
    const previousFade = index > 0 && baseClips[index - 1]!.transitionOut === "fade" ? Math.min(baseClips[index - 1]!.transitionDurationSeconds ?? .5, clip.durationSeconds / 2) : 0;
    const nextFade = clip.transitionOut === "fade" ? Math.min(clip.transitionDurationSeconds ?? .5, clip.durationSeconds / 2) : 0;
    const fadeFilters: string[] = [];
    if (previousFade > 0) fadeFilters.push(`fade=t=in:st=0:d=${roundTime(previousFade)}`);
    if (nextFade > 0) fadeFilters.push(`fade=t=out:st=${roundTime(clip.durationSeconds - nextFade)}:d=${roundTime(nextFade)}`);
    if (clip.muted) {
      filters.push(`color=c=${background}:s=${project.width}x${project.height}:r=${frameRate},trim=end_frame=${renderedDurationFrames},setpts=PTS-STARTPTS,format=yuv420p${fadeFilters.length ? `,${fadeFilters.join(",")}` : ""}[baseclip${index}]`);
      return;
    }
    const inputIndex = inputIndexByClip.get(clip.id);
    if (inputIndex === undefined) throw new Error(`主画面片段缺少 FFmpeg 输入映射：${clip.name}`);
    if (!mainClipNeedsComposition(clip)) {
      const chain = [
        `[${inputIndex}:v]${temporalVideoFilter(project, clip, { preFrames: incomingDissolve?.inOffsetFrames, postFrames: outgoingDissolve?.outOffsetFrames })}`,
        `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease`,
        `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=${background}`,
        ...visualFilterChain(clip),
        "setsar=1",
        `fps=${frameRate}`,
        "format=yuv420p",
        `trim=end_frame=${renderedDurationFrames}`,
        "setpts=PTS-STARTPTS",
        ...fadeFilters,
      ];
      filters.push(`${chain.join(",")}[baseclip${index}]`);
      return;
    }
    const localFrame = "(n-1)";
    // scale/overlay 的 n 首帧为 1，rotate 的 n 首帧为 0；分别换算后才都对应项目 F0。
    const transform = visualTransformExpressions(project, clip, localFrame, localFrame, "n");
    const rotationSize = rotationCanvasSize(project, clip);
    const backgroundLabel = `basebg${index}`;
    const foregroundLabel = `basefg${index}`;
    const composedLabel = `basecomposed${index}`;
    filters.push(`color=c=${background}:s=${project.width}x${project.height}:r=${frameRate},trim=end_frame=${renderedDurationFrames},setpts=PTS-STARTPTS[${backgroundLabel}]`);
    filters.push(`${[
      `[${inputIndex}:v]${temporalVideoFilter(project, clip, { preFrames: incomingDissolve?.inOffsetFrames, postFrames: outgoingDissolve?.outOffsetFrames })}`,
      `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease`,
      ...visualFilterChain(clip),
      "setsar=1",
      `fps=${frameRate}`,
      `scale=w='iw*(${transform.scale})':h='ih*(${transform.scale})':eval=frame`,
      "format=rgba",
      `colorchannelmixer=aa=${roundTime(clip.opacity)}`,
      // scale 会逐帧改变输入尺寸；先居中到固定透明画布，避免下游 rotate
      // 只按首帧输入尺寸配置后裁掉后续放大的画面。
      `pad=${rotationSize}:${rotationSize}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame`,
      `rotate=angle='(${transform.rotation})*PI/180':ow=iw:oh=ih:c=none`,
      `trim=end_frame=${renderedDurationFrames}`,
      "setpts=PTS-STARTPTS",
    ].join(",")}[${foregroundLabel}]`);
    filters.push(`[${backgroundLabel}][${foregroundLabel}]overlay=x='(W-w)/2+(${transform.positionX})':y='(H-h)/2+(${transform.positionY})':eval=frame:eof_action=pass:shortest=1:format=auto[${composedLabel}]`);
    filters.push(`[${composedLabel}]format=yuv420p,trim=end_frame=${renderedDurationFrames},setpts=PTS-STARTPTS${fadeFilters.length ? `,${fadeFilters.join(",")}` : ""}[baseclip${index}]`);
  });
  if (baseClips.length === 1) filters.push("[baseclip0]null[basev]");
  else {
    let composedLabel = "baseclip0";
    let cutFrame = editClipDurationFrames(project, baseClips[0]!);
    for (let index = 0; index < baseClips.length - 1; index += 1) {
      const outgoing = baseClips[index]!;
      const transition = outgoingDissolves.get(outgoing.id);
      const outputLabel = `basejoin${index}`;
      if (transition) {
        const transitionFrames = transition.inOffsetFrames + transition.outOffsetFrames;
        const transitionStartFrame = cutFrame - transition.inOffsetFrames;
        filters.push(`[${composedLabel}][baseclip${index + 1}]xfade=transition=fade:duration=${ffmpegSecondsForFrame(project, transitionFrames)}:offset=${ffmpegSecondsForFrame(project, transitionStartFrame)}[${outputLabel}]`);
      } else filters.push(`[${composedLabel}][baseclip${index + 1}]concat=n=2:v=1:a=0[${outputLabel}]`);
      composedLabel = outputLabel;
      cutFrame += editClipDurationFrames(project, baseClips[index + 1]!);
    }
    filters.push(`[${composedLabel}]trim=end_frame=${totalFrames},setpts=PTS-STARTPTS[basev]`);
  }

  let videoLabel = "basev";
  overlayEntries.forEach(({ clip }, index) => {
    const inputIndex = inputIndexByClip.get(clip.id)!;
    const startFrame = editClipStartFrame(project, clip);
    const durationFrames = editClipDurationFrames(project, clip);
    const endFrame = startFrame + durationFrames;
    const localFilterFrame = "(n-1)";
    // FFmpeg overlay 的 x/y 与 scale/rotate 表达式 n 从 1 开始；减一后才对应项目 F0。
    // 通用 enable 时间线中的 n 则从 0 开始，因此下方半开区间直接使用 n。
    const globalLocalFrame = `(n-1-${startFrame})`;
    const transform = visualTransformExpressions(project, clip, localFilterFrame, globalLocalFrame, "n");
    const rotationSize = rotationCanvasSize(project, clip);
    const overlayLabel = `overlayclip${index}`;
    const outputLabel = `overlayout${index}`;
    const chain = [
      `[${inputIndex}:v]${temporalVideoFilter(project, clip)}`,
      `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease`,
      ...visualFilterChain(clip),
      `fps=${frameRate}`,
      `scale=w='iw*(${transform.scale})':h='ih*(${transform.scale})':eval=frame`,
      "format=rgba",
      `colorchannelmixer=aa=${clip.opacity}`,
      `pad=${rotationSize}:${rotationSize}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame`,
      `rotate=angle='(${transform.rotation})*PI/180':ow=iw:oh=ih:c=none`,
      `trim=end_frame=${durationFrames}`,
      `setpts=PTS-STARTPTS+${startFrame}*${renderTimebase.rateDenominator}/${renderTimebase.rateNumerator}/TB`,
    ];
    filters.push(`${chain.join(",")}[${overlayLabel}]`);
    filters.push(`[${videoLabel}][${overlayLabel}]overlay=x='(W-w)/2+(${transform.positionX})':y='(H-h)/2+(${transform.positionY})':enable='gte(n,${startFrame})*lt(n,${endFrame})':eof_action=pass:shortest=0[${outputLabel}]`);
    videoLabel = outputLabel;
  });

  const subtitleInputStart = visualEntries.length + standaloneAudioClips.length;
  subtitleOverlays.forEach((overlay, index) => {
    const inputIndex = subtitleInputStart + index;
    const overlayLabel = `subtitle${index}`;
    const outputLabel = `subtitleout${index}`;
    filters.push(`[${inputIndex}:v]format=rgba[${overlayLabel}]`);
    const startFrame = editClipStartFrame(project, overlay.clip);
    const endFrame = startFrame + editClipDurationFrames(project, overlay.clip);
    filters.push(`[${videoLabel}][${overlayLabel}]overlay=0:0:enable='gte(n,${startFrame})*lt(n,${endFrame})':eof_action=pass[${outputLabel}]`);
    videoLabel = outputLabel;
  });
  if (options.frameAtSeconds !== undefined) {
    const targetFrame = Math.max(0, Math.min(totalFrames - 1, projectFrameForSeconds(project, options.frameAtSeconds)));
    filters.push(`[${videoLabel}]format=yuv420p,trim=start_frame=${targetFrame}:end_frame=${targetFrame + 1},setpts=PTS-STARTPTS[outv]`);
  } else filters.push(`[${videoLabel}]format=yuv420p[outv]`);

  const timelineAudioEntries = options.frameAtSeconds === undefined ? visualEntries
    .filter((entry) => entry.clip.kind === "timeline" && !entry.clip.muted)
    .map((entry) => ({ clip: entry.clip, inputIndex: inputIndexByClip.get(entry.clip.id)! })) : [];
  const audioEntries = [
    ...standaloneAudioClips.map((clip, index) => ({ clip, inputIndex: visualEntries.length + index })),
    ...timelineAudioEntries,
  ];
  audioEntries.forEach(({ clip, inputIndex }, index) => {
    const nestedOffsetFrames = clip.kind === "timeline" && clip.nestedTimeline
      ? rationalQuotientInteger(clip.nestedTimeline.sourceOffset, clip.nestedTimeline.sourceStep, `${clip.name} 的嵌套音频起点`)
      : undefined;
    const startSample = nestedOffsetFrames === undefined ? undefined : timelineAudioSampleForFrame(project, nestedOffsetFrames);
    const endSample = nestedOffsetFrames === undefined ? undefined : timelineAudioSampleForFrame(project, nestedOffsetFrames + editClipDurationFrames(project, clip));
    const sourceDuration = roundTime(clip.durationSeconds * clip.playbackRate);
    const chain = nestedOffsetFrames === undefined ? [
      `[${inputIndex}:a]atrim=start=${clip.trimStartSeconds}:end=${roundTime(clip.trimStartSeconds + sourceDuration)}`,
      "asetpts=PTS-STARTPTS",
      ...atempoChain(clip.playbackRate),
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `volume=${clip.volume}`,
    ] : [
      `[${inputIndex}:a]aresample=48000`,
      `atrim=start_sample=${startSample}:end_sample=${endSample}`,
      "asetpts=PTS-STARTPTS",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `volume=${clip.volume}`,
    ];
    const fadeIn = Math.min(clip.fadeInSeconds ?? 0, clip.durationSeconds);
    const fadeOut = Math.min(clip.fadeOutSeconds ?? 0, clip.durationSeconds);
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${roundTime(fadeIn)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${roundTime(clip.durationSeconds - fadeOut)}:d=${roundTime(fadeOut)}`);
    const startFrame = editClipStartFrame(project, clip);
    const durationFrames = editClipDurationFrames(project, clip);
    const timebase = normalizedProjectTimebase(project);
    chain.push(`atrim=end_sample=${timelineAudioSampleForFrame(project, durationFrames)}`, `asetpts=PTS-STARTPTS+${startFrame}*${timebase.rateDenominator}/${timebase.rateNumerator}/TB[a${index}]`);
    filters.push(chain.join(","));
  });
  if (audioEntries.length) filters.push(`${audioEntries.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioEntries.length}:duration=longest:normalize=0,atrim=end_sample=${timelineAudioSampleForFrame(project, totalFrames)}[outa]`);
  else if (options.lossless) filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${timelineAudioSampleForFrame(project, totalFrames)}[outa]`);
  if (options.frameAtSeconds !== undefined) {
    args.push("-filter_complex", filters.join(";"), "-map", "[outv]", "-frames:v", "1", "-update", "1", "-c:v", "png", "-n", outputPath);
  } else {
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[outv]",
      ...((audioEntries.length || options.lossless) ? ["-map", "[outa]", "-c:a", ...(options.lossless ? ["pcm_s16le"] : ["aac", "-b:a", "192k"])] : ["-an"]),
      "-c:v", ...(options.lossless ? ["ffv1", "-level", "3", "-g", "1"] : ["libx264", "-preset", "medium", "-crf", "18"]),
      "-pix_fmt", "yuv420p",
      "-r", frameRate,
      "-t", String(totalDuration),
      ...(options.lossless ? [] : ["-movflags", "+faststart"]),
      "-n",
      outputPath,
    );
  }
  return args;
}

async function saveRenderJobs(projectRoot: string, jobs: EditRenderJob[]): Promise<void> {
  await writeJsonAtomic(getSidecarPaths(projectRoot).editorRenders, { schemaVersion: 1, jobs });
}

const renderProcesses = new Map<string, ManagedMediaProcess>();
const renderCompletions = new Map<string, Promise<EditRenderJob>>();
const renderRuntimeJobs = new Map<string, EditRenderJob>();
const MAX_ACTIVE_EDIT_RENDERS_PER_PROJECT = 1;
async function mutateRenderJobs(projectRoot: string, mutate: (jobs: EditRenderJob[]) => EditRenderJob[] | Promise<EditRenderJob[]>): Promise<EditRenderJob[]> {
  return withProjectLock(projectRoot, "editor-renders", async () => {
    const store = await readJson<{ schemaVersion: 1; jobs: EditRenderJob[] }>(getSidecarPaths(projectRoot).editorRenders, { schemaVersion: 1, jobs: [] });
    const jobs = (await mutate(store.jobs)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 200);
    await saveRenderJobs(projectRoot, jobs);
    return jobs;
  });
}

function processExists(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function persistRenderJob(projectRoot: string, job: EditRenderJob): Promise<void> {
  await mutateRenderJobs(projectRoot, (jobs) => [job, ...jobs.filter((candidate) => candidate.id !== job.id)]);
  await refreshEditorSessionRenderIds(projectRoot);
}

async function renderedOutputValid(projectRoot: string, outputPath: string): Promise<boolean> {
  try {
    const metadata = await stat(outputPath);
    if (metadata.size <= 0) return false;
    const ffprobePath = await findExecutable("ffprobe");
    if (!ffprobePath) return false;
    const result = await runProcess(projectRoot, ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", outputPath], { tool: "ffprobe", stage: "render-validation", weight: MEDIA_WEIGHTS.probe, timeoutMs: mediaStageTimeout("ffprobe") });
    if (result.status !== "succeeded") return false;
    const probe = JSON.parse(result.stdout) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }>; format?: { duration?: string } };
    return Boolean(probe.streams?.[0]?.codec_name && probe.streams[0].width && probe.streams[0].height && Number(probe.format?.duration) > 0);
  } catch { return false; }
}

async function registerRenderPublication(projectRoot: string, job: EditRenderJob): Promise<void> {
  if (job.publicationReceiptId) return;
  if (!job.publicationIntentId || !job.publicationReservationToken || !job.publicationIntentRevision) throw new Error("剪辑导出缺少发布预留，拒绝把未审计文件标记为成功。");
  const current = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!current) throw new Error("剪辑导出的发布预留已丢失。 ");
  if (job.editProjectRevision !== undefined || job.dependencyManifestSha256 || job.renderPlanSha256 || job.renderPlanPath || job.commandSha256) {
    if (!job.editProjectRevision || !job.dependencyManifestSha256 || !job.renderPlanSha256 || !job.renderPlanPath || !job.commandSha256 || !job.commandPath) throw new Error("剪辑导出的冻结渲染身份不完整。 ");
    const plan = JSON.parse(await readFile(job.renderPlanPath, "utf8")) as EditTimelineRenderPlan;
    if (sha256Json(plan) !== job.renderPlanSha256 || plan.dependencyManifestSha256 !== job.dependencyManifestSha256 || plan.rootEditProjectId !== job.editProjectId || plan.rootEditProjectRevision !== job.editProjectRevision) throw new Error("剪辑导出的 render plan 已缺失、损坏或与任务身份不一致。 ");
    const command = await readFile(job.commandPath, "utf8");
    if (createHash("sha256").update(command).digest("hex") !== job.commandSha256) throw new Error("剪辑导出的 FFmpeg 命令文件哈希不一致。 ");
    const metadata = current.context.metadata ?? {};
    if (metadata.editProjectId !== job.editProjectId || metadata.editProjectRevision !== job.editProjectRevision || metadata.dependencyManifestSha256 !== job.dependencyManifestSha256 || metadata.renderPlanSha256 !== job.renderPlanSha256) throw new Error("剪辑导出的 Publication 预留与冻结渲染身份不一致。 ");
  }
  // 即使另一个进程已经登记，也必须经 registerPublication 重新校验当前文件哈希；
  // 不能仅凭侧车里的 receiptId 把被替换或损坏的成片恢复为成功。
  const receipt = await registerPublication(projectRoot, {
    intentId: job.publicationIntentId,
    reservationToken: job.publicationReservationToken,
    expectedRevision: current.revision,
  }, "app");
  const settled = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!settled || settled.status !== "registered" || settled.receiptId !== receipt.id) throw new Error("剪辑导出的发布回执与当前意图终态不一致。 ");
  job.publicationIntentRevision = settled.revision;
  job.publicationReceiptId = receipt.id;
}

async function finishRenderPublication(projectRoot: string, job: EditRenderJob, status: "cancelled" | "failed", reason: string): Promise<void> {
  if (!job.publicationIntentId || !job.publicationReservationToken || job.publicationReceiptId) return;
  const current = await getPublicationIntent(projectRoot, job.publicationIntentId);
  if (!current || current.status !== "reserved") return;
  const input = { intentId: current.id, reservationToken: job.publicationReservationToken, expectedRevision: current.revision, reason };
  const finished = status === "cancelled" ? await cancelPublication(projectRoot, input, "app") : await failPublication(projectRoot, input, "app");
  job.publicationIntentRevision = finished.revision;
}

async function pidBelongsToRender(job: EditRenderJob): Promise<boolean> {
  if (!job.pid || !processExists(job.pid)) return false;
  try {
    const result = await runProcess(undefined, "ps", ["-p", String(job.pid), "-o", "command="], { tool: "utility", stage: "render-pid-verify", weight: MEDIA_WEIGHTS.probe, timeoutMs: 5_000 });
    if (result.status !== "succeeded") return false;
    const command = result.stdout.trim();
    return /(?:^|\/)ffmpeg(?:\s|$)/i.test(command) && command.includes(job.outputPath);
  } catch { return false; }
}

export async function listEditRenderJobs(projectRoot: string): Promise<EditRenderJob[]> {
  // 该入口本来就会做持久化恢复，因此也负责回收死亡宿主遗留的 FFmpeg
  // 进程组与机器租约；纯只读资源入口使用 readEditRenderJobs，不触发回收。
  await reapMachineMediaRuntime();
  return mutateRenderJobs(projectRoot, async (jobs) => {
    for (const job of jobs) {
      if (job.status !== "running" || renderProcesses.has(job.id) || processExists(job.pid)) continue;
      let validOutput = await renderedOutputValid(projectRoot, job.outputPath);
      if (validOutput && job.publicationIntentId) {
        try { await registerRenderPublication(projectRoot, job); }
        catch (error) { validOutput = false; job.error = error instanceof Error ? error.message : String(error); }
      }
      job.status = validOutput ? "succeeded" : job.cancelRequestedAt ? "cancelled" : "failed";
      job.progress = validOutput ? 1 : job.progress;
      job.error = validOutput ? undefined : job.error ?? (job.cancelRequestedAt ? "导出已取消。" : "应用重启后未找到存活的 FFmpeg，且输出文件未通过 ffprobe 完整性检查。");
      job.completedAt = new Date().toISOString();
      if (!validOutput) await finishRenderPublication(projectRoot, job, job.status === "cancelled" ? "cancelled" : "failed", job.error ?? "剪辑导出恢复失败").catch(() => undefined);
    }
    return jobs;
  });
}

/**
 * 只读渲染任务快照。不会恢复运行中任务、登记发布回执、创建侧车或争抢写锁；
 * 供证据审计、资源读取等声明为 readOnly 的入口使用。
 */
export async function readEditRenderJobs(projectRoot: string): Promise<EditRenderJob[]> {
  const store = await readJson<{ schemaVersion: 1; jobs: EditRenderJob[] }>(getSidecarPaths(projectRoot).editorRenders, { schemaVersion: 1, jobs: [] });
  return [...store.jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 200);
}

function allowedOutputDirectory(config: Awaited<ReturnType<typeof loadProjectConfig>>, projectRoot: string, requested?: string): string {
  const outputDirectory = requested ? path.resolve(requested) : path.join(config.outputRoots[0] ?? projectRoot, "成片输出");
  const roots = [...new Set([config.primaryRoot, ...config.outputRoots])].map((root) => path.resolve(root));
  if (!roots.some((root) => outputDirectory === root || outputDirectory.startsWith(`${root}${path.sep}`))) throw new Error("剪辑输出目录必须位于项目允许的输出根内。 ");
  return outputDirectory;
}

async function prepareRender(
  projectRoot: string,
  editProjectId: string,
  options: { expectedRevision: number; outputDirectory?: string; withProgress?: boolean },
): Promise<{ engine: VideoEngineInfo & { ffmpegPath: string }; project: EditProject; resolved: ResolvedEditTimeline; job: EditRenderJob; args: string[] }> {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath) throw new Error(engine.issues.join("；") || "FFmpeg 不可用。 ");
  const project = await validateEditProject(projectRoot, structuredClone(await getEditProject(projectRoot, editProjectId)));
  if (project.revision !== options.expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${project.revision}），请重新载入后导出。`);
  const resolved = await prepareResolvedEditTimeline(projectRoot, project, { ...engine, ffmpegPath: engine.ffmpegPath });
  const renderProject = resolved.resolvedProject!;
  const durationSeconds = renderDuration(project);
  if (durationSeconds <= 0) throw new Error("剪辑工程总时长为 0，无法导出。 ");
  const config = await loadProjectConfig(projectRoot);
  const outputDirectory = allowedOutputDirectory(config, projectRoot, options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const paths = getSidecarPaths(projectRoot);
  const id = `render-${randomUUID()}`;
  const publication = await preflightPublication(projectRoot, {
    idempotencyKey: `edit-render:${id}`,
    requestedPath: path.join(outputDirectory, outputFileName(project)),
    kind: "video",
    context: { purpose: "edit-render", jobId: id, metadata: { editProjectId: project.id, editProjectRevision: project.revision, dependencyManifestSha256: resolved.dependencyManifestSha256, renderPlanSha256: resolved.renderPlanSha256 } },
    note: `剪辑工程 ${project.id} r${project.revision} 的不可覆盖成片输出`,
  }, "app");
  const outputPath = publication.targetPath;
  const logPath = path.join(paths.editorRoot, `${id}.log`);
  const commandPath = path.join(paths.editorRoot, `${id}.command.txt`);
  const subtitleOverlays = await createSubtitleOverlays(renderProject, path.join(paths.editorRoot, "overlays", id));
  const args = buildFfmpegArgs(renderProject, outputPath, subtitleOverlays, { withProgress: options.withProgress });
  const command = `${shellQuote(engine.ffmpegPath)} ${args.map(shellQuote).join(" ")}\n`;
  await writeFile(commandPath, command, "utf8");
  const job: EditRenderJob = {
    schemaVersion: 1,
    id,
    editProjectId,
    editProjectRevision: project.revision,
    dependencyManifestSha256: resolved.dependencyManifestSha256,
    renderPlanSha256: resolved.renderPlanSha256,
    renderPlanPath: resolved.renderPlanPath,
    commandSha256: createHash("sha256").update(command).digest("hex"),
    dependencyRefs: resolved.dependencyRefs,
    status: "running",
    outputPath,
    commandPath,
    logPath,
    progress: 0,
    durationSeconds,
    publicationIntentId: publication.id,
    publicationReservationToken: publication.reservationToken,
    publicationIntentRevision: publication.revision,
    startedAt: new Date().toISOString(),
  };
  return { engine: { ...engine, ffmpegPath: engine.ffmpegPath }, project, resolved, job, args };
}

async function renderEditProjectUnlocked(
  projectRoot: string,
  editProjectId: string,
  options: { expectedRevision: number; outputDirectory?: string },
): Promise<EditRenderJob> {
  const { engine, job, args } = await withProjectLock(projectRoot, editProjectLockName(editProjectId), () => prepareRender(projectRoot, editProjectId, options));
  await persistRenderJob(projectRoot, job);
  await appendEvent(projectRoot, { actor: "user", type: "editor.render-started", data: { editProjectId, renderId: job.id, outputPath: job.outputPath } });
  try {
    const result = await runProcess(projectRoot, engine.ffmpegPath, args, { tool: "ffmpeg", stage: "edit-render-sync", weight: MEDIA_WEIGHTS.render, timeoutMs: mediaStageTimeout("ffmpeg", 6 * 60 * 60_000), maxOutputBytes: MAX_RENDER_LOG });
    await writeFile(job.logPath, result.output, "utf8");
    if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "FFmpeg 成片导出超过阶段超时，进程树已终止。" : result.output.trim().split("\n").slice(-12).join("\n") || `FFmpeg 退出码 ${result.code}`);
    await access(job.outputPath, fsConstants.R_OK);
    if (!(await renderedOutputValid(projectRoot, job.outputPath))) throw new Error("FFmpeg 已退出，但输出没有通过 ffprobe 的视频流、尺寸和时长检查。");
    await registerRenderPublication(projectRoot, job);
    job.status = "succeeded";
    job.progress = 1;
    job.completedAt = new Date().toISOString();
    await appendEvent(projectRoot, { actor: "app", type: "editor.render-succeeded", data: { editProjectId, renderId: job.id, outputPath: job.outputPath } });
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.completedAt = new Date().toISOString();
    await finishRenderPublication(projectRoot, job, "failed", job.error).catch(() => undefined);
    await writeFile(job.logPath, `${await readFile(job.logPath, "utf8").catch(() => "")}\n${job.error}\n`, "utf8");
    await appendEvent(projectRoot, { actor: "app", type: "editor.render-failed", data: { editProjectId, renderId: job.id, outputPath: job.outputPath, error: job.error } });
  }
  await persistRenderJob(projectRoot, job);
  return job;
}

export async function renderEditProject(
  projectRoot: string,
  editProjectId: string,
  options: { expectedRevision: number; outputDirectory?: string },
): Promise<EditRenderJob> {
  return withEditorMediaCapacity(projectRoot, "同步成片导出", () => renderEditProjectUnlocked(projectRoot, editProjectId, options));
}

async function startPreparedEditRender(
  projectRoot: string,
  editProjectId: string,
  prepared: Awaited<ReturnType<typeof prepareRender>>,
): Promise<EditRenderJob> {
  const { engine, job, args } = prepared;
  let stdoutBuffer = "";
  let logOutput = "";
  let lastPersistAt = 0;
  let managed: ManagedMediaProcess;
  try {
    managed = await startManagedMediaProcess(engine.ffmpegPath, args, {
      projectRoot,
      tool: "ffmpeg",
      stage: "edit-render-background",
      weight: MEDIA_WEIGHTS.render,
      timeoutMs: mediaStageTimeout("ffmpeg", 6 * 60 * 60_000),
      maxOutputBytes: MAX_RENDER_LOG,
      onStdout: (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const [key, value] = line.split("=", 2);
          if ((key === "out_time_us" || key === "out_time_ms") && value) {
            const seconds = Number(value) / 1_000_000;
            if (Number.isFinite(seconds)) job.progress = Math.max(job.progress, Math.min(.995, seconds / Math.max(.001, job.durationSeconds)));
          } else if (key === "progress" && value === "end") job.progress = 1;
        }
        if (Date.now() - lastPersistAt > 250) { lastPersistAt = Date.now(); void persistRenderJob(projectRoot, job); }
      },
      onStderr: (chunk) => {
        logOutput += chunk.toString("utf8");
        if (logOutput.length > MAX_RENDER_LOG) logOutput = logOutput.slice(-MAX_RENDER_LOG);
      },
    });
  } catch (error) {
    job.status = "failed";
    job.error = `无法取得机器媒体容量或启动 FFmpeg：${error instanceof Error ? error.message : String(error)}`;
    job.completedAt = new Date().toISOString();
    await finishRenderPublication(projectRoot, job, "failed", job.error).catch(() => undefined);
    await writeFile(job.logPath, `${job.error}\n`, "utf8");
    await persistRenderJob(projectRoot, job);
    await appendEvent(projectRoot, { actor: "app", type: "editor.render-failed", data: { editProjectId, renderId: job.id, outputPath: job.outputPath, error: job.error } });
    throw error;
  }
  job.pid = managed.child.pid;
  job.processGroupId = process.platform === "win32" ? undefined : managed.child.pid;
  job.machineLeaseId = managed.leaseId;
  job.stageTimeoutMs = mediaStageTimeout("ffmpeg", 6 * 60 * 60_000);
  renderProcesses.set(job.id, managed);
  renderRuntimeJobs.set(job.id, job);
  await persistRenderJob(projectRoot, job);
  await appendEvent(projectRoot, { actor: "user", type: "editor.render-started", data: { editProjectId, renderId: job.id, outputPath: job.outputPath, background: true, pid: job.pid, machineLeaseId: job.machineLeaseId } });
  const completion = managed.completion.then(async (result): Promise<EditRenderJob> => {
    renderProcesses.delete(job.id);
    renderRuntimeJobs.delete(job.id);
    const persistedCancellation = (await readEditRenderJobs(projectRoot)).find((candidate) => candidate.id === job.id)?.cancelRequestedAt;
    if (persistedCancellation) job.cancelRequestedAt = persistedCancellation;
    job.completedAt = new Date().toISOString();
    if (job.cancelRequestedAt || result.status === "cancelled") {
      job.status = "cancelled";
      job.error = `导出已取消${result.signal ? `（${result.signal}）` : ""}。`;
    } else if (result.status === "timed_out") {
      job.status = "failed";
      job.error = "FFmpeg 成片导出超过阶段超时，完整进程树已终止。";
    } else if (result.status === "succeeded") {
      try {
        await access(job.outputPath, fsConstants.R_OK);
        if (await renderedOutputValid(projectRoot, job.outputPath)) {
          await registerRenderPublication(projectRoot, job);
          job.status = "succeeded";
          job.progress = 1;
        } else {
          job.status = "failed";
          job.error = "FFmpeg 正常退出，但输出没有通过 ffprobe 的视频流、尺寸和时长检查。";
        }
      } catch (error) {
        job.status = "failed";
        const reason = error instanceof Error ? error.message : String(error);
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
        job.error = code === "ENOENT" ? "FFmpeg 正常退出，但没有找到输出文件。" : `FFmpeg 输出已生成，但完整性检查或发布注册失败：${reason}`;
      }
    } else {
      job.status = "failed";
      job.error = result.error || result.stderr.trim().split("\n").slice(-12).join("\n") || `FFmpeg 退出码 ${result.code}`;
    }
    if (job.status === "cancelled") await finishRenderPublication(projectRoot, job, "cancelled", job.error ?? "用户取消剪辑导出").catch(() => undefined);
    if (job.status === "failed") await finishRenderPublication(projectRoot, job, "failed", job.error ?? "剪辑导出失败").catch(() => undefined);
    await writeFile(job.logPath, `${logOutput || result.stderr}${job.error ? `\n${job.error}\n` : ""}`, "utf8");
    await persistRenderJob(projectRoot, job);
    await appendEvent(projectRoot, { actor: "app", type: `editor.render-${job.status}`, data: { editProjectId, renderId: job.id, outputPath: job.outputPath, progress: job.progress, error: job.error, machineLeaseId: job.machineLeaseId } });
    renderCompletions.delete(job.id);
    return job;
  });
  renderCompletions.set(job.id, completion);
  return structuredClone(job);
}

export async function startEditRender(
  projectRoot: string,
  editProjectId: string,
  options: { expectedRevision: number; outputDirectory?: string },
): Promise<EditRenderJob> {
  return withProjectLock(projectRoot, EDITOR_MEDIA_CAPACITY_LOCK, () => withProjectLock(projectRoot, "editor-render-capacity", async () => {
    const active = (await listEditRenderJobs(projectRoot)).filter((job) => job.status === "running");
    if (active.length >= MAX_ACTIVE_EDIT_RENDERS_PER_PROJECT) {
      throw new Error(`项目已有活动成片导出 ${active.map((job) => job.id).join("、")}；请等待完成或调用 cancel_edit_render 后再启动新导出。`);
    }
    const prepared = await withProjectLock(projectRoot, editProjectLockName(editProjectId), () => prepareRender(projectRoot, editProjectId, { ...options, withProgress: true }));
    // 只在读取工程修订和建立发布预留时持有工程锁；机器容量排队和 FFmpeg
    // 启动不应长时间阻塞同一工程的只读恢复与取消路径。
    return startPreparedEditRender(projectRoot, editProjectId, prepared);
  }), { timeoutMs: EDITOR_MEDIA_CAPACITY_TIMEOUT_MS, staleMs: 300_000 });
}

export async function getEditRenderJob(projectRoot: string, renderId: string): Promise<EditRenderJob> {
  const job = (await listEditRenderJobs(projectRoot)).find((candidate) => candidate.id === renderId);
  if (!job) throw new Error(`找不到剪辑导出任务：${renderId}`);
  return job;
}

export async function waitForEditRender(projectRoot: string, renderId: string): Promise<EditRenderJob> {
  const completion = renderCompletions.get(renderId);
  if (completion) return completion;
  return getEditRenderJob(projectRoot, renderId);
}

export async function cancelEditRender(projectRoot: string, renderId: string): Promise<EditRenderJob> {
  const job = await getEditRenderJob(projectRoot, renderId);
  if (job.status !== "running") return job;
  job.cancelRequestedAt = new Date().toISOString();
  const runtimeJob = renderRuntimeJobs.get(renderId);
  if (runtimeJob) runtimeJob.cancelRequestedAt = job.cancelRequestedAt;
  await persistRenderJob(projectRoot, job);
  const child = renderProcesses.get(renderId);
  if (!child) {
    if (await pidBelongsToRender(job)) {
      await terminateProcessTree(job.processGroupId ?? job.pid!);
    } else if (processExists(job.pid)) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = "保存的 PID 仍存活，但命令与本导出任务不匹配；为避免误杀其他进程，已拒绝取消。";
      await finishRenderPublication(projectRoot, job, "failed", job.error).catch(() => undefined);
      await persistRenderJob(projectRoot, job);
    } else if (await renderedOutputValid(projectRoot, job.outputPath)) {
      try {
        if (job.publicationIntentId) await registerRenderPublication(projectRoot, job);
        job.status = "succeeded";
        job.progress = 1;
        job.completedAt = new Date().toISOString();
        job.error = undefined;
      } catch (error) {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : String(error);
        await finishRenderPublication(projectRoot, job, "failed", job.error).catch(() => undefined);
      }
      await persistRenderJob(projectRoot, job);
    } else {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      job.error = "导出进程已不存在，且没有通过完整性检查的输出；任务已标记取消。";
      await finishRenderPublication(projectRoot, job, "cancelled", job.error).catch(() => undefined);
      await persistRenderJob(projectRoot, job);
    }
  } else {
    await child.cancel();
  }
  await appendEvent(projectRoot, { actor: "user", type: "editor.render-cancel-requested", data: { renderId, editProjectId: job.editProjectId, pid: job.pid } });
  return job;
}

async function extractTimelineFrameUnlocked(
  projectRoot: string,
  input: { editProjectId: string; expectedRevision: number; timeSeconds?: number; itemId?: string; registerAsEndFrame?: boolean; registerVariant?: "start" | "end" },
): Promise<TimelineFrameExtraction> {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath) throw new Error(engine.issues.join("；") || "FFmpeg 不可用。 ");
  const project = await validateEditProject(projectRoot, structuredClone(await getEditProject(projectRoot, input.editProjectId)));
  if (project.revision !== input.expectedRevision) throw new Error(`剪辑工程已被其他窗口更新（当前修订 ${project.revision}），请重新载入后提取合成帧。`);
  const resolved = await prepareResolvedEditTimeline(projectRoot, project, { ...engine, ffmpegPath: engine.ffmpegPath });
  const renderProject = resolved.resolvedProject!;
  const duration = renderDuration(project);
  if (duration <= 0) throw new Error("剪辑工程没有可提取的主画面。 ");
  const requestedTimeSeconds = roundTime(input.timeSeconds ?? Math.max(0, duration - 1 / projectFrameRate(project)));
  if (requestedTimeSeconds < 0 || requestedTimeSeconds >= duration) throw new Error(`提取时间必须在 0–${duration.toFixed(3)} 秒之间。`);
  const index = await getProjectIndex(projectRoot);
  const item = input.itemId ? index.items.find((candidate) => candidate.id === input.itemId) : undefined;
  if (input.itemId && !item) throw new Error(`找不到要登记合成帧的生产节点：${input.itemId}`);
  const config = await loadProjectConfig(projectRoot);
  const outputDirectory = item
    ? path.join(path.dirname(item.infoPath ?? item.sourcePaths[0] ?? config.outputRoots[0] ?? projectRoot), "AI画布生成")
    : path.join(config.outputRoots[0] ?? projectRoot, "剪辑帧");
  await mkdir(outputDirectory, { recursive: true });
  const itemPrefix = item?.episode && item?.unit
    ? `EP${String(item.episode).padStart(2, "0")}_15s_${String(item.unit).padStart(3, "0")}`
    : safeName(project.name);
  const extractionId = `timeline-frame-${randomUUID()}`;
  const registerVariant = input.registerVariant ?? (input.registerAsEndFrame ? "end" : undefined);
  const variantLabel = registerVariant === "start" ? "首帧_" : registerVariant === "end" ? "尾帧_" : "";
  const subtitleOverlays = await createSubtitleOverlays(renderProject, path.join(getSidecarPaths(projectRoot).editorRoot, "overlays", extractionId));
  const frameRate = projectFrameRate(project);
  let timeSeconds = requestedTimeSeconds;
  let framePath = "";
  let width = 0;
  let height = 0;
  let lastDecodeError = "FFmpeg 没有输出可解码图片。";
  // 时间线末端受分数帧率、源媒体实际帧数和 concat 舍入影响，合法的 duration-1/fps
  // 偶尔仍会落在 EOF 边界。遇到“退出码为 0 但没有图片”时逐帧回退，避免把可恢复
  // 的末帧提取锁成 unknown 命令；显式请求的时间也保留实际回退时间用于血缘审计。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    timeSeconds = roundTime(Math.max(0, requestedTimeSeconds - attempt / frameRate));
    framePath = path.join(outputDirectory, `${itemPrefix}_${variantLabel}时间线合成_${String(Math.round(timeSeconds * 1_000)).padStart(7, "0")}ms_${extractionId.slice(-8)}_raw.png`);
    const args = buildFfmpegArgs(renderProject, framePath, subtitleOverlays, { frameAtSeconds: timeSeconds });
    const result = await runProcess(projectRoot, engine.ffmpegPath, args, { tool: "ffmpeg", stage: "timeline-frame", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 5 * 60_000) });
    if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "时间线合成帧提取超时，进程树已终止。" : result.output.trim().split("\n").slice(-12).join("\n") || "时间线合成帧提取失败。 ");
    try {
      const metadata = await sharp(framePath, { failOn: "error" }).metadata();
      width = metadata.width ?? 0;
      height = metadata.height ?? 0;
      if (width && height) break;
      lastDecodeError = "时间线已输出图片，但图片没有有效尺寸。";
    } catch (error) {
      lastDecodeError = error instanceof Error ? error.message : String(error);
    }
    await unlink(framePath).catch(() => undefined);
  }
  if (!width || !height) throw new Error(`时间线末端连续回退 4 帧后仍无法提取可解码图片：${lastDecodeError}`);
  const lineage = collectActiveTimelineLineage(resolved, projectFrameForSeconds(project, timeSeconds));
  const extraction: TimelineFrameExtraction = {
    schemaVersion: 1,
    id: extractionId,
    editProjectId: project.id,
    editProjectRevision: project.revision,
    timeSeconds,
    framePath,
    width,
    height,
    sourceClipIds: lineage.sourceClipIds,
    sourceArtifactIds: lineage.sourceArtifactIds,
    sourceItemIds: lineage.sourceItemIds,
    sourceClipRefs: lineage.sourceClipRefs,
    dependencyManifestSha256: resolved.dependencyManifestSha256,
    renderPlanSha256: resolved.renderPlanSha256,
    dependencyRefs: resolved.dependencyRefs,
    registeredItemId: item?.id,
    registeredVariant: registerVariant,
    extractedAt: new Date().toISOString(),
  };
  if (item && registerVariant) {
    const registered = await registerArtifact(projectRoot, { itemId: item.id, artifactPath: framePath, kind: "raw-image", variant: registerVariant, note: `剪辑工程 ${project.id} r${project.revision} 在 ${timeSeconds}s 的合成帧` });
    extraction.scanId = registered.scanId;
    const refreshed = await getProjectIndex(projectRoot);
    extraction.registeredArtifactId = refreshed.artifacts.find((artifact) => artifact.path === framePath)?.id;
  }
  await mkdir(path.dirname(getSidecarPaths(projectRoot).editorProvenance), { recursive: true });
  await appendFile(getSidecarPaths(projectRoot).editorProvenance, `${JSON.stringify(extraction)}\n`, "utf8");
  await appendEvent(projectRoot, { actor: "codex", type: "editor.timeline-frame-extracted", itemId: item?.id, data: { extractionId, editProjectId: project.id, editProjectRevision: project.revision, dependencyManifestSha256: resolved.dependencyManifestSha256, renderPlanSha256: resolved.renderPlanSha256, timeSeconds, framePath, sourceClipIds: extraction.sourceClipIds, sourceArtifactIds: extraction.sourceArtifactIds } });
  return extraction;
}

export async function extractTimelineFrame(
  projectRoot: string,
  input: { editProjectId: string; expectedRevision: number; timeSeconds?: number; itemId?: string; registerAsEndFrame?: boolean; registerVariant?: "start" | "end" },
): Promise<TimelineFrameExtraction> {
  return withEditorMediaCapacity(projectRoot, "时间线合成帧提取", () => withProjectLock(projectRoot, editProjectLockName(input.editProjectId), () => extractTimelineFrameUnlocked(projectRoot, input)));
}

export async function listTimelineFrameExtractions(projectRoot: string, editProjectId?: string, limit = 100): Promise<TimelineFrameExtraction[]> {
  try {
    const lines = (await readFile(getSidecarPaths(projectRoot).editorProvenance, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.map((line) => JSON.parse(line) as TimelineFrameExtraction).filter((entry) => !editProjectId || entry.editProjectId === editProjectId).reverse().slice(0, Math.max(1, Math.min(limit, 500)));
  } catch {
    return [];
  }
}

function continuationFile(projectRoot: string, continuationId: string): string {
  if (!/^continuation-[a-zA-Z0-9_-]{8,120}$/.test(continuationId)) throw new Error("视频续接包 ID 不合法。");
  return path.join(getSidecarPaths(projectRoot).editorContinuations, `${continuationId}.json`);
}

async function extractLastFrameUnlocked(
  projectRoot: string,
  input: { itemId: string; artifactId?: string; videoPath?: string },
): Promise<LastFrameExtraction> {
  const engine = await probeVideoEngine();
  if (!engine.available || !engine.ffmpegPath) throw new Error(engine.issues.join("；") || "FFmpeg 不可用。");
  const index = await getProjectIndex(projectRoot);
  const item = index.items.find((candidate) => candidate.id === input.itemId);
  if (!item) throw new Error(`找不到生产节点：${input.itemId}`);
  const artifact = input.artifactId ? index.artifacts.find((candidate) => candidate.id === input.artifactId && candidate.itemId === item.id) : undefined;
  if (input.artifactId && (!artifact || artifact.kind !== "video")) throw new Error("指定素材不是该节点的视频版本。");
  const sourceVideoPath = path.resolve(input.videoPath ?? artifact?.path ?? index.artifacts.find((candidate) => candidate.itemId === item.id && candidate.kind === "video" && candidate.authoritative && candidate.check.ok)?.path ?? "");
  if (!sourceVideoPath || !/\.(mp4|mov|m4v|webm)$/i.test(sourceVideoPath)) throw new Error("没有找到可提取末帧的视频路径。");
  await access(sourceVideoPath, fsConstants.R_OK).catch(() => { throw new Error(`视频不存在或不可读：${sourceVideoPath}`); });
  const outputDirectory = path.dirname(item.infoPath ?? item.sourcePaths[0] ?? sourceVideoPath);
  await mkdir(outputDirectory, { recursive: true });
  const prefix = item.episode && item.unit
    ? `EP${String(item.episode).padStart(2, "0")}_15s_${String(item.unit).padStart(3, "0")}`
    : safeName(item.title);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const framePath = path.join(outputDirectory, `${prefix}_尾帧_视频续接_${stamp}_raw.png`);
  const result = await runProcess(projectRoot, engine.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-sseof", "-0.08", "-i", sourceVideoPath, "-frames:v", "1", "-update", "1", "-n", framePath], { tool: "ffmpeg", stage: "source-last-frame", weight: MEDIA_WEIGHTS.foreground, timeoutMs: mediaStageTimeout("ffmpeg", 120_000) });
  if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "视频末帧提取超时，进程树已终止。" : result.output.trim().split("\n").slice(-10).join("\n") || "视频末帧提取失败。");
  const metadata = await sharp(framePath, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("已输出末帧文件，但图片无法解码。");
  const registered = await registerArtifact(projectRoot, { itemId: item.id, artifactPath: framePath, kind: "raw-image", variant: "end", note: `从视频末帧提取：${sourceVideoPath}` });
  const extractedAt = new Date().toISOString();
  await appendEvent(projectRoot, { actor: "app", type: "editor.last-frame-extracted", itemId: item.id, data: { sourceVideoPath, framePath, width: metadata.width, height: metadata.height } });
  return { itemId: item.id, sourceVideoPath, framePath, width: metadata.width, height: metadata.height, extractedAt, scanId: registered.scanId };
}

export async function extractLastFrame(
  projectRoot: string,
  input: { itemId: string; artifactId?: string; videoPath?: string },
): Promise<LastFrameExtraction> {
  return withEditorMediaCapacity(projectRoot, "源视频末帧提取", () => extractLastFrameUnlocked(projectRoot, input));
}

export async function createVideoContinuationPack(
  projectRoot: string,
  input: { itemId: string; sourceVideoPath?: string; lastFramePath: string; prompt?: string; sourceType?: "video" | "timeline"; editProjectId?: string; editProjectRevision?: number; dependencyManifestSha256?: string; renderPlanSha256?: string; timelineFrameId?: string; timelineTimeSeconds?: number; targetFirstFrameArtifactId?: string },
): Promise<VideoContinuationPack> {
  await ensureSidecar(projectRoot);
  const index = await getProjectIndex(projectRoot);
  const item = index.items.find((candidate) => candidate.id === input.itemId);
  if (!item) throw new Error(`找不到生产节点：${input.itemId}`);
  const sourceVideoPath = input.sourceVideoPath ? path.resolve(input.sourceVideoPath) : undefined;
  const lastFramePath = path.resolve(input.lastFramePath);
  await Promise.all([...(sourceVideoPath ? [access(sourceVideoPath, fsConstants.R_OK)] : []), access(lastFramePath, fsConstants.R_OK)]).catch(() => { throw new Error("续接视频或末帧图片不存在。 "); });
  const lastFrameMetadata = await sharp(lastFramePath, { failOn: "error" }).metadata();
  if (!lastFrameMetadata.width || !lastFrameMetadata.height) throw new Error("末帧参考图无法解码。");
  const hardLocks = index.project.hardLocks.filter((lock) => item.hardLockIds.includes(lock.id));
  const id = `continuation-${randomUUID()}`;
  const now = new Date().toISOString();
  const expectedOutputDirectory = path.dirname(item.infoPath ?? item.sourcePaths[0] ?? sourceVideoPath ?? lastFramePath);
  const prompt = input.prompt?.trim() || [
    `以上一个视频的最后一帧作为新视频第一帧，继续制作 ${item.title} 的后续动作。`,
    item.infoExcerpt ? `原节点说明：${item.infoExcerpt.slice(0, 2_000)}` : "保持前一段的镜头方向、景别、光线和动作惯性。",
    hardLocks.length ? `硬锁不得改变：${hardLocks.map((lock) => lock.name).join("、")}。` : "保持角色身份、服装、道具和场景连续性。",
    "不得回跳动作、换脸、改变完整黄金面具结构或制造首帧闪变。",
  ].join("\n");
  const pack: VideoContinuationPack = {
    schemaVersion: 1,
    id,
    revision: 1,
    projectId: index.project.id,
    itemId: item.id,
    sourceType: input.sourceType ?? "video",
    sourceVideoPath,
    editProjectId: input.editProjectId,
    editProjectRevision: input.editProjectRevision,
    dependencyManifestSha256: input.dependencyManifestSha256,
    renderPlanSha256: input.renderPlanSha256,
    timelineFrameId: input.timelineFrameId,
    timelineTimeSeconds: input.timelineTimeSeconds,
    targetFirstFrameArtifactId: input.targetFirstFrameArtifactId,
    lastFramePath,
    prompt,
    referencePaths: [...new Set([lastFramePath, ...hardLocks.map((lock) => lock.path)])],
    hardLocks,
    expectedOutputDirectory,
    acceptanceCriteria: [
      "新视频第一帧与提取末帧视觉连续",
      "角色、道具、服装、完整面具与场景硬锁不变",
      "动作方向、速度与摄影机运动自然续接",
      "输出必须是新文件，且可被 ffprobe 解码",
      "生成后登记回原生产节点并进入视频视觉验收",
    ],
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(continuationFile(projectRoot, id), pack);
  await appendEvent(projectRoot, { actor: "user", type: "editor.video-continuation-created", itemId: item.id, data: { continuationId: id, sourceType: pack.sourceType, sourceVideoPath, lastFramePath, editProjectId: pack.editProjectId, editProjectRevision: pack.editProjectRevision, timelineFrameId: pack.timelineFrameId, targetFirstFrameArtifactId: pack.targetFirstFrameArtifactId } });
  return pack;
}

async function prepareTimelineVideoContinuationUnlocked(
  projectRoot: string,
  input: { editProjectId: string; targetItemId: string; expectedRevision: number; timeSeconds?: number; prompt?: string; providerId?: string; enqueue?: boolean },
): Promise<{ extraction: TimelineFrameExtraction; pack: VideoContinuationPack; generationJob?: GenerationJob }> {
  const project = await validateEditProject(projectRoot, structuredClone(await getEditProject(projectRoot, input.editProjectId)));
  if (project.revision !== input.expectedRevision) throw new Error(`剪辑工程修订已变化（当前 r${project.revision}），拒绝使用旧时间线生成续接帧。`);
  const resolvedIdentity = await collectResolvedEditTimeline(projectRoot, project);
  const duration = renderDuration(project);
  if (duration <= 0) throw new Error("剪辑工程没有可续接的画面。 ");
  const requestedTimeSeconds = roundTime(input.timeSeconds ?? Math.max(0, duration - 1 / projectFrameRate(project)));
  const priorExtractions = await listTimelineFrameExtractions(projectRoot, project.id, 500);
  let reusableExtraction: TimelineFrameExtraction | undefined;
  for (const entry of priorExtractions) {
    const sameRequest = input.timeSeconds === undefined || entry.timeSeconds === requestedTimeSeconds;
    if (entry.editProjectRevision !== project.revision || entry.dependencyManifestSha256 !== resolvedIdentity.dependencyManifestSha256 || entry.renderPlanSha256 !== resolvedIdentity.renderPlanSha256 || !sameRequest || entry.registeredItemId !== input.targetItemId || entry.registeredVariant !== "start" || !entry.registeredArtifactId) continue;
    if (await access(entry.framePath, fsConstants.R_OK).then(() => true).catch(() => false)) { reusableExtraction = entry; break; }
  }
  const extraction = reusableExtraction ?? await extractTimelineFrameUnlocked(projectRoot, { editProjectId: project.id, expectedRevision: project.revision, timeSeconds: requestedTimeSeconds, itemId: input.targetItemId, registerVariant: "start" });
  const timeSeconds = extraction.timeSeconds;
  const baseTrack = mainVisualTrack(project);
  const activeVideo = baseTrack && !baseTrack.hidden && !baseTrack.muted
    ? baseTrack.clips.find((clip) => clip.kind === "video" && !clip.muted && timeSeconds >= clip.startSeconds && timeSeconds < clipEnd(clip))
    : undefined;
  if (!extraction.registeredArtifactId) throw new Error("时间线合成帧已输出，但没有映射为目标节点的新首帧版本。 ");
  if (!reusableExtraction) for (const sourceArtifactId of extraction.sourceArtifactIds) await upsertAssetRelation(projectRoot, { kind: "derived_from", parentArtifactId: sourceArtifactId, childArtifactId: extraction.registeredArtifactId, operation: `剪辑工程 ${project.id} r${project.revision} @ ${timeSeconds}s 合成为续接首帧` }, "codex");
  const reusablePack = (await listVideoContinuationPacks(projectRoot, input.targetItemId)).find((entry) => entry.sourceType === "timeline" && entry.editProjectId === project.id && entry.editProjectRevision === project.revision && entry.dependencyManifestSha256 === resolvedIdentity.dependencyManifestSha256 && entry.renderPlanSha256 === resolvedIdentity.renderPlanSha256 && entry.timelineFrameId === extraction.id && entry.targetFirstFrameArtifactId === extraction.registeredArtifactId && !["failed", "cancelled"].includes(entry.status) && (!input.prompt?.trim() || input.prompt.trim() === entry.prompt));
  const pack = reusablePack ?? await createVideoContinuationPack(projectRoot, { itemId: input.targetItemId, sourceVideoPath: activeVideo?.sourcePath, lastFramePath: extraction.framePath, prompt: input.prompt, sourceType: "timeline", editProjectId: project.id, editProjectRevision: project.revision, dependencyManifestSha256: resolvedIdentity.dependencyManifestSha256, renderPlanSha256: resolvedIdentity.renderPlanSha256, timelineFrameId: extraction.id, timelineTimeSeconds: timeSeconds, targetFirstFrameArtifactId: extraction.registeredArtifactId });
  let generationJob: GenerationJob | undefined;
  if (input.enqueue !== false) {
    generationJob = pack.generationJobId ? (await listGenerationJobs(projectRoot)).find((entry) => entry.id === pack.generationJobId) : undefined;
    if (generationJob && input.providerId && generationJob.providerId !== input.providerId) throw new Error(`续接包已由供应商 ${generationJob.providerId} 入队，拒绝用 ${input.providerId} 重复提交。`);
    if (!generationJob) {
      [generationJob] = await enqueueGeneration(projectRoot, {
        itemIds: [input.targetItemId],
        kind: "video",
        providerId: input.providerId,
        prompt: pack.prompt,
        continuation: { continuationId: pack.id, firstFrameArtifactId: extraction.registeredArtifactId },
      });
      const persistedPack = await readJson<VideoContinuationPack | null>(continuationFile(projectRoot, pack.id), null);
      if (!persistedPack || persistedPack.generationJobId !== generationJob?.id || persistedPack.status !== "queued") throw new Error("续接任务已入队，但任务包绑定回写不完整。 ");
      Object.assign(pack, persistedPack);
    }
  }
  await appendEvent(projectRoot, { actor: "codex", type: reusablePack ? "editor.timeline-continuation-reused" : "editor.timeline-continuation-prepared", itemId: input.targetItemId, data: { continuationId: pack.id, editProjectId: project.id, editProjectRevision: project.revision, dependencyManifestSha256: resolvedIdentity.dependencyManifestSha256, renderPlanSha256: resolvedIdentity.renderPlanSha256, timelineFrameId: extraction.id, firstFrameArtifactId: extraction.registeredArtifactId, generationJobId: generationJob?.id } });
  return { extraction, pack, generationJob };
}

export async function prepareTimelineVideoContinuation(
  projectRoot: string,
  input: { editProjectId: string; targetItemId: string; expectedRevision: number; timeSeconds?: number; prompt?: string; providerId?: string; enqueue?: boolean },
): Promise<{ extraction: TimelineFrameExtraction; pack: VideoContinuationPack; generationJob?: GenerationJob }> {
  return withEditorMediaCapacity(projectRoot, "时间线续接帧准备", () => withProjectLock(projectRoot, editProjectLockName(input.editProjectId), () => prepareTimelineVideoContinuationUnlocked(projectRoot, input)));
}

export async function listVideoContinuationPacks(projectRoot: string, itemId?: string): Promise<VideoContinuationPack[]> {
  const directory = getSidecarPaths(projectRoot).editorContinuations;
  const names = await readdir(directory).catch(() => [] as string[]);
  const packs = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<VideoContinuationPack | null>(path.join(directory, name), null)));
  return packs.filter((pack): pack is VideoContinuationPack => Boolean(pack) && (!itemId || pack?.itemId === itemId)).map((pack) => ({ ...pack, revision: Math.max(1, pack.revision || 1) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function updateVideoContinuationPack(
  projectRoot: string,
  continuationId: string,
  input: { expectedRevision: number; status: "failed" | "cancelled"; error: string },
): Promise<VideoContinuationPack> {
  return withProjectLock(projectRoot, "video-continuation", async () => {
    const filePath = continuationFile(projectRoot, continuationId);
    const pack = await readJson<VideoContinuationPack | null>(filePath, null);
    if (!pack) throw new Error(`找不到视频续接包：${continuationId}`);
    pack.revision = Math.max(1, pack.revision || 1);
    if (pack.revision !== input.expectedRevision) throw new Error(`视频续接包修订冲突：期望 ${input.expectedRevision}，当前 ${pack.revision}。`);
    if (pack.generationJobId) throw new Error(`视频续接包已绑定生成任务 ${pack.generationJobId}；状态只能由 GenerationJob 投影，禁止独立回写。`);
    if (["completed", "failed", "cancelled"].includes(pack.status)) throw new Error(`续接包已是 ${pack.status}，不能回退或覆盖终态。`);
    const error = input.error.trim();
    if (!error) throw new Error("放弃或终结未入队续接包必须记录原因。 ");
    const now = new Date().toISOString();
    pack.status = input.status;
    pack.error = error;
    pack.completedAt = now;
    pack.revision += 1;
    pack.updatedAt = now;
    await writeJsonAtomic(filePath, pack);
    await appendEvent(projectRoot, { actor: "codex", type: `editor.video-continuation-${input.status}`, itemId: pack.itemId, data: { continuationId, revision: pack.revision, error } });
    return pack;
  });
}
