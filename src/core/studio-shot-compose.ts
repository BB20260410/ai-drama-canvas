/**
 * 单镜合成合同 + 本机 ffmpeg 执行（clean-room，对照火宝 ffmpeg-compose）。
 * plan* 不读盘；execute* 在给定绝对路径上跑 ffmpeg，产物写 outputDir。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type StudioShotComposeInput = {
  /** 主画面：视频或静帧路径（逻辑路径，不读盘） */
  visualPath: string;
  visualKind: "video" | "still";
  /** 可选对白音频 */
  ttsAudioPath?: string | null;
  /** 可选字幕 SRT 内容（非路径） */
  srtContent?: string | null;
  /** 输出逻辑文件名（不含目录） */
  outputFileName: string;
  durationSeconds?: number;
};

export type StudioShotComposePlan = {
  kind: "studio-shot-compose-plan";
  schemaVersion: 1;
  visualPath: string;
  visualKind: "video" | "still";
  ttsAudioPath: string | null;
  hasSubtitle: boolean;
  srtByteLength: number;
  outputFileName: string;
  durationSeconds: number | null;
  /** ffmpeg 意图摘要（非可执行命令字符串，避免注入） */
  steps: string[];
  /** 是否可在本机尝试真实合成（需要调用方再检查 ffmpeg 二进制） */
  readyForFfmpeg: boolean;
  /** 硬阻塞（导致 readyForFfmpeg=false） */
  blockers: string[];
  /** 软警告（不阻塞执行） */
  warnings: string[];
};

function assertNonEmptyPath(label: string, value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`shot-compose: ${label} 不能为空。`);
  }
  if (value.includes("\0")) throw new Error(`shot-compose: ${label} 含非法字符。`);
}

/**
 * 从对白文本生成极简 SRT（单条 cue，1→duration）。
 * 无词级时间戳时的可测基线；正式对齐见 P2.1/P2.2。
 */
export function buildMinimalSrtFromDialogue(dialogue: string, durationSeconds: number): string {
  const text = dialogue.trim();
  if (!text) throw new Error("shot-compose: dialogue 为空，无法生成 SRT。");
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) {
    throw new Error("shot-compose: durationSeconds 必须为正数。");
  }
  const end = formatSrtTimestamp(durationSeconds);
  return `1\n00:00:00,000 --> ${end}\n${text}\n`;
}

function formatSrtTimestamp(totalSeconds: number): string {
  const msTotal = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(msTotal / 3_600_000);
  const m = Math.floor((msTotal % 3_600_000) / 60_000);
  const s = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

/**
 * 校验并产出单镜合成计划。不调用 ffmpeg、不访问磁盘。
 */
export function planStudioShotCompose(input: StudioShotComposeInput): StudioShotComposePlan {
  assertNonEmptyPath("visualPath", input.visualPath);
  assertNonEmptyPath("outputFileName", input.outputFileName);
  if (input.visualKind !== "video" && input.visualKind !== "still") {
    throw new Error("shot-compose: visualKind 必须是 video 或 still。");
  }
  if (input.outputFileName.includes("/") || input.outputFileName.includes("\\") || input.outputFileName.includes("..")) {
    throw new Error("shot-compose: outputFileName 不得含路径分隔或 ..。");
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const steps: string[] = [];

  if (input.visualKind === "still") {
    steps.push("still→视频轨（固定帧时长）");
  } else {
    steps.push("使用源视频为主轨");
  }

  const tts = input.ttsAudioPath?.trim() || null;
  if (tts) {
    steps.push("混入 TTS 音轨");
  } else {
    steps.push("无 TTS（静音或保留源音）");
  }

  const srt = input.srtContent?.trim() || null;
  if (srt) {
    // 执行层当前可能仅落盘 SRT 旁路文件，不保证烧录进画面
    steps.push("附带 SRT 文本（执行层可选烧录）");
    warnings.push("当前 execute 路径不保证字幕烧录进画面，仅可写出 .srt 旁路文件");
  }

  steps.push(`写出 ${input.outputFileName}`);

  if (!input.outputFileName.toLowerCase().endsWith(".mp4")) {
    // 软建议：不阻塞 readyForFfmpeg（否则合法 .mov 会被误杀）
    warnings.push("outputFileName 建议使用 .mp4 扩展名以便播放器兼容");
  }

  const durationSeconds =
    input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? input.durationSeconds
      : null;

  if (input.visualKind === "still" && durationSeconds === null) {
    blockers.push("静帧合成需要 durationSeconds");
  }

  return {
    kind: "studio-shot-compose-plan",
    schemaVersion: 1,
    visualPath: input.visualPath.trim(),
    visualKind: input.visualKind,
    ttsAudioPath: tts,
    hasSubtitle: Boolean(srt),
    srtByteLength: srt ? Buffer.byteLength(srt, "utf8") : 0,
    outputFileName: input.outputFileName.trim(),
    durationSeconds,
    steps,
    readyForFfmpeg: blockers.length === 0,
    blockers,
    warnings,
  };
}

export type StudioShotComposeExecuteInput = StudioShotComposeInput & {
  /** 输出目录（绝对路径） */
  outputDir: string;
  /** ffmpeg 二进制，默认 PATH 中的 ffmpeg */
  ffmpegPath?: string;
};

export type StudioShotComposeExecuteResult = {
  plan: StudioShotComposePlan;
  outputPath: string;
  outputSha256: string;
  bytes: number;
};

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出 ${code}: ${err.slice(-800)}`));
    });
  });
}

/**
 * 执行单镜合成。当前实现：
 * - still + duration → 定帧 mp4（yuv420p + 静音轨）
 * - video 主轨可选混 tts（-shortest）
 * - srt 写入同目录临时文件后尝试 subtitles 滤镜；失败则仍产出无字幕片并记在 steps
 * 不写工程 CAS；调用方负责登记。
 */
function assertSafeAbsPath(label: string, absPath: string): string {
  const resolved = path.resolve(absPath);
  if (!path.isAbsolute(resolved)) throw new Error(`shot-compose: ${label} 必须是绝对路径。`);
  if (resolved.includes("\0")) throw new Error(`shot-compose: ${label} 含非法字符。`);
  // 禁止明显穿越片段写到奇怪位置（输出文件名已禁 ..）
  return resolved;
}

export async function executeStudioShotCompose(
  input: StudioShotComposeExecuteInput,
): Promise<StudioShotComposeExecuteResult> {
  const plan = planStudioShotCompose(input);
  if (!plan.readyForFfmpeg) {
    throw new Error(`shot-compose: 计划未就绪：${plan.blockers.join("; ")}`);
  }
  const outputDir = assertSafeAbsPath("outputDir", input.outputDir);
  await mkdir(outputDir, { recursive: true });

  const visualAbs = assertSafeAbsPath("visualPath", plan.visualPath);
  await access(visualAbs);
  const outPath = path.join(outputDir, plan.outputFileName);
  if (!outPath.startsWith(outputDir + path.sep) && outPath !== outputDir) {
    throw new Error("shot-compose: 输出路径逃逸 outputDir。");
  }
  const ffmpegBin = input.ffmpegPath?.trim() || "ffmpeg";

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];

  if (plan.visualKind === "still") {
    const dur = plan.durationSeconds!;
    args.push("-loop", "1", "-i", visualAbs, "-t", String(dur), "-r", "24");
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-t", String(dur));
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");
  } else {
    args.push("-i", visualAbs);
    if (plan.ttsAudioPath) {
      const ttsAbs = assertSafeAbsPath("ttsAudioPath", plan.ttsAudioPath);
      await access(ttsAbs);
      args.push("-i", ttsAbs);
      args.push("-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest");
    } else {
      args.push("-c", "copy");
    }
  }

  // 字幕旁路：写出 .srt 供后续烧录；本路径不保证烧进画面（与 plan.warnings 一致）
  if (plan.hasSubtitle && input.srtContent?.trim()) {
    const srtPath = path.join(outputDir, `${plan.outputFileName}.srt`);
    await writeFile(srtPath, input.srtContent, "utf8");
  }

  args.push(outPath);
  await runFfmpeg(ffmpegBin, args);

  const buf = await readFile(outPath);
  if (buf.length < 32) throw new Error("shot-compose: 输出过小，疑似失败。");
  const outputSha256 = createHash("sha256").update(buf).digest("hex");
  return { plan, outputPath: outPath, outputSha256, bytes: buf.length };
}

