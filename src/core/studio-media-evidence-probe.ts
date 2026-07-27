import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  MEDIA_WEIGHTS,
  mediaStageTimeout,
  runMediaProcess,
} from "./media-runtime.js";

const MAX_PROCESS_OUTPUT_BYTES = 128 * 1_024;

export interface StudioVideoEvidenceProbe {
  durationSeconds: number;
  video: {
    codecName: string;
    width: number;
    height: number;
    decodedFrames: number;
  };
  audio: {
    present: boolean;
    codecName?: string;
  };
}

async function executableCandidate(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath, fsConstants.X_OK);
    const canonical = await realpath(filePath);
    const stats = await lstat(canonical);
    return stats.isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function resolveExecutable(name: "ffmpeg" | "ffprobe"): Promise<string> {
  const preferredKey = name === "ffmpeg" ? "AI_CANVAS_FFMPEG" : "AI_CANVAS_FFPROBE";
  const legacyKey = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  for (const key of [preferredKey, legacyKey]) {
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    const explicit = process.env[key]?.trim();
    if (!explicit) throw new Error(`${key} 已显式配置为空，媒体证据验证失败关闭。`);
    const executable = await executableCandidate(path.resolve(explicit));
    if (!executable) throw new Error(`${key} 指向的 ${name} 不可执行。`);
    return executable;
  }
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const executable = await executableCandidate(candidate);
    if (executable) return executable;
  }
  throw new Error(`未找到可执行 ${name}，媒体证据验证失败关闭。`);
}

async function runControlled(
  projectRoot: string,
  executable: string,
  args: string[],
  tool: "ffmpeg" | "ffprobe",
  stage: string,
) {
  const result = await runMediaProcess(executable, args, {
    projectRoot,
    tool,
    stage,
    weight: tool === "ffprobe" ? MEDIA_WEIGHTS.probe : MEDIA_WEIGHTS.foreground,
    timeoutMs: mediaStageTimeout(tool, tool === "ffprobe" ? 30_000 : 5 * 60_000),
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (result.status !== "succeeded") {
    const detail = result.status === "timed_out"
      ? `${stage} 超时。`
      : result.output.trim().split("\n").slice(-8).join("\n") || `${stage} 失败。`;
    throw new Error(detail);
  }
  return result;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 对受管 reviewed-video 做只读机械取证：先读取真实容器/流和帧计数，再完整解码。
 * 任一工具、容器、视频流、时长、帧计数或完整解码缺失都失败关闭。
 */
export async function probeStudioReviewedVideoEvidence(
  projectRoot: string,
  absolutePath: string,
): Promise<StudioVideoEvidenceProbe> {
  const [ffprobe, ffmpeg] = await Promise.all([
    resolveExecutable("ffprobe"),
    resolveExecutable("ffmpeg"),
  ]);
  const probeResult = await runControlled(projectRoot, ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,duration:format=duration,format_name",
    "-of", "json",
    absolutePath,
  ], "ffprobe", "studio-reviewed-video-evidence-probe");

  let parsed: {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(probeResult.stdout) as typeof parsed;
  } catch (error) {
    throw new Error("reviewed-video 的 FFprobe JSON 无效。", { cause: error });
  }
  if (!Array.isArray(parsed.streams)) {
    throw new Error("reviewed-video 未返回可验证媒体流。");
  }
  const videoStream = parsed.streams.find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("reviewed-video 不包含视频流。");
  const codecName = typeof videoStream.codec_name === "string"
    ? videoStream.codec_name.trim()
    : "";
  const width = positiveNumber(videoStream.width);
  const height = positiveNumber(videoStream.height);
  const decodedFrames = positiveNumber(videoStream.nb_read_frames);
  const durationSeconds = positiveNumber(parsed.format?.duration)
    ?? positiveNumber(videoStream.duration);
  if (!codecName || !width || !height || !decodedFrames || !durationSeconds) {
    throw new Error("reviewed-video 的编解码器、尺寸、时长或已读帧数无效。");
  }
  const audioStream = parsed.streams.find((stream) => stream.codec_type === "audio");
  const audioCodec = typeof audioStream?.codec_name === "string"
    ? audioStream.codec_name.trim()
    : "";

  await runControlled(projectRoot, ffmpeg, [
    "-hide_banner",
    "-v", "error",
    "-xerror",
    "-err_detect", "explode",
    "-i", absolutePath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-f", "null",
    "-",
  ], "ffmpeg", "studio-reviewed-video-evidence-full-decode");

  return {
    durationSeconds,
    video: {
      codecName,
      width,
      height,
      decodedFrames,
    },
    audio: {
      present: Boolean(audioStream && audioCodec),
      ...(audioCodec ? { codecName: audioCodec } : {}),
    },
  };
}
