/**
 * P2 成片/声音合同层（纯函数，clean-room）。
 * 真实 ffmpeg/TTS 由执行层调用；此处可测计划与校验。
 */

/** P2.1 按标点切句供 TTS */
export function splitDialogueForTts(text: string): string[] {
  const t = text?.trim() ?? "";
  if (!t) throw new Error("tts-split: 对白为空。");
  const parts = t
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("tts-split: 切句结果为空。");
  return parts;
}

/** P2.2 词级时间戳 → SRT（简化均匀分配） */
export type WordTimestamp = { word: string; start: number; end: number };

export function wordsToSrt(words: WordTimestamp[]): string {
  if (!words.length) throw new Error("srt: words 为空。");
  for (const w of words) {
    if (!(w.end > w.start) || !w.word.trim()) throw new Error("srt: 非法词时间戳。");
  }
  const start = words[0]!.start;
  const end = words[words.length - 1]!.end;
  const text = words.map((w) => w.word).join("");
  return `1\n${fmt(start)} --> ${fmt(end)}\n${text}\n`;
}

function fmt(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(milli).padStart(3, "0")}`;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** P2.3 VoiceIdentity */
export type StudioVoiceIdentity = {
  voiceId: string;
  engine: string;
  refAudioPath?: string;
  refText?: string;
  emotionPresets?: Array<{ name: string; instruct: string }>;
  defaultSpeed?: number;
};

export function validateVoiceIdentity(v: StudioVoiceIdentity): void {
  if (!v.voiceId?.trim() || !v.engine?.trim()) throw new Error("voice: voiceId/engine 必填。");
  if (v.defaultSpeed !== undefined && (!(v.defaultSpeed > 0) || v.defaultSpeed > 3)) {
    throw new Error("voice: defaultSpeed 须在 (0,3]。");
  }
}

/** P2.4 整集 merge + 响度计划 */
export function planEpisodeMerge(clipPaths: string[], outputName: string): {
  steps: string[];
  loudnorm: { integratedLufs: number; truePeak: number };
} {
  if (!clipPaths.length) throw new Error("merge: 无片段。");
  if (clipPaths.some((p) => !p.trim())) throw new Error("merge: 空路径。");
  if (!outputName.endsWith(".mp4")) throw new Error("merge: 输出须 .mp4");
  return {
    steps: ["concat demuxer", "loudnorm two-pass", `write ${outputName}`],
    loudnorm: { integratedLufs: -14, truePeak: -1.5 },
  };
}

/** P2.5 字幕样式 preset */
export type SubtitleStylePreset = {
  id: string;
  fontName: string;
  fontSize: number;
  primaryColour: string;
  outline: number;
  alignment: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9;
};

export const DEFAULT_SUBTITLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: "drama-white-outline",
    fontName: "PingFang SC",
    fontSize: 48,
    primaryColour: "&H00FFFFFF",
    outline: 2,
    alignment: 2,
  },
];

export function getSubtitleStylePreset(id: string): SubtitleStylePreset {
  const p = DEFAULT_SUBTITLE_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`subtitle-preset: 未知 ${id}`);
  return p;
}

/** P2.6 竖屏压制配方 */
export function verticalEncodeRecipe(width = 1080, height = 1920): {
  scalePad: string;
  crf: number;
  audioBitrate: string;
} {
  if (width !== 1080 || height !== 1920) throw new Error("vertical: 当前仅支持 1080x1920");
  return {
    scalePad: "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
    crf: 18,
    audioBitrate: "192k",
  };
}

/** P2.7 首尾帧 FLF2V 合同 */
export type Flf2vContract = {
  firstFramePath: string;
  lastFramePath: string;
  prompt: string;
  seed?: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
};

export function validateFlf2vContract(c: Flf2vContract): void {
  if (!c.firstFramePath?.trim() || !c.lastFramePath?.trim()) throw new Error("flf2v: 首尾帧路径必填。");
  if (!c.prompt?.trim()) throw new Error("flf2v: prompt 必填。");
  if (!(c.frames >= 8 && c.frames <= 241)) throw new Error("flf2v: frames 范围 8–241。");
  if (!(c.fps > 0 && c.fps <= 60)) throw new Error("flf2v: fps 非法。");
}

/** P2.8 末帧血缘 */
export type LastFrameLineage = {
  sourceVideoHash: string;
  parentJobId?: string;
  frameIndex: number;
  extractedAt: string;
};

export function validateLastFrameLineage(l: LastFrameLineage): void {
  if (!/^[a-f0-9]{64}$/i.test(l.sourceVideoHash)) throw new Error("lineage: sourceVideoHash 须 sha256 hex。");
  if (!Number.isInteger(l.frameIndex) || l.frameIndex < 0) throw new Error("lineage: frameIndex 非法。");
  if (!l.extractedAt?.trim()) throw new Error("lineage: extractedAt 必填。");
}

/** P2.9 Animatic 计划 */
export function planAnimatic(
  frames: Array<{ path: string; durationSeconds: number }>,
): { totalSeconds: number; steps: string[] } {
  if (!frames.length) throw new Error("animatic: 无帧。");
  let total = 0;
  for (const f of frames) {
    if (!f.path.trim() || !(f.durationSeconds > 0)) throw new Error("animatic: 非法帧。");
    total += f.durationSeconds;
  }
  return { totalSeconds: total, steps: ["still→clip per duration", "concat", "export preview mp4"] };
}

/** P2.10 BGM ducking */
export function planBgmDucking(dialogueDb = -16, bgmDb = -28): { filter: string } {
  if (!(dialogueDb < 0) || !(bgmDb < dialogueDb)) throw new Error("ducking: 电平参数不合理。");
  return { filter: `sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200` };
}
