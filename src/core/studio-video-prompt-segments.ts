/**
 * video_prompt 分段解析/校验（clean-room，对照火宝 0-3秒 / <n> 分段语义）。
 * 不调用外网；供拆格 draft 与冻结包字段预检。
 */

export type StudioVideoPromptSegment = {
  /** 段序，从 0 起 */
  index: number;
  /** 起始秒（含） */
  startSeconds: number;
  /** 结束秒（不含或闭区间展示均可；校验 end > start） */
  endSeconds: number;
  /** 段正文（去时码头） */
  body: string;
  raw: string;
};

export type ParseVideoPromptResult =
  | { ok: true; segments: StudioVideoPromptSegment[]; totalSpanSeconds: number }
  | { ok: false; errors: string[] };

const SEGMENT_SPLIT = /(?:\n\s*)?(?:<n>\s*)|(?:\n(?=\d+(?:\.\d+)?\s*[-–—~～到至]\s*\d+))/i;
const TIME_HEAD =
  /^\s*(\d+(?:\.\d+)?)\s*[-–—~～到至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|sec|secs)?\s*[：:]\s*/i;

/**
 * 解析多段 video_prompt。
 * 支持：
 * - `0-3秒：...` / `0-3: ...`
 * - `<n>` 或换行 + 新时码头 分段
 */
export function parseStudioVideoPromptSegments(videoPrompt: string): ParseVideoPromptResult {
  const text = videoPrompt?.trim() ?? "";
  if (!text) {
    return { ok: false, errors: ["video_prompt 为空。"] };
  }
  if (text.length > 8000) {
    return { ok: false, errors: ["video_prompt 超过 8000 字符。"] };
  }

  const chunks = text
    .split(SEGMENT_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);

  if (chunks.length === 0) {
    return { ok: false, errors: ["video_prompt 无有效分段。"] };
  }

  const segments: StudioVideoPromptSegment[] = [];
  const errors: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const raw = chunks[i]!;
    const m = raw.match(TIME_HEAD);
    if (!m) {
      errors.push(`第 ${i + 1} 段缺少时码头（如 0-3秒：…）：${raw.slice(0, 40)}`);
      continue;
    }
    const startSeconds = Number(m[1]);
    const endSeconds = Number(m[2]);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      errors.push(`第 ${i + 1} 段时码非数字。`);
      continue;
    }
    if (endSeconds <= startSeconds) {
      errors.push(`第 ${i + 1} 段结束须大于开始（${startSeconds}-${endSeconds}）。`);
      continue;
    }
    if (startSeconds < 0 || endSeconds > 60) {
      errors.push(`第 ${i + 1} 段时码超出合理范围 0–60s。`);
      continue;
    }
    const body = raw.slice(m[0].length).trim();
    if (!body) {
      errors.push(`第 ${i + 1} 段正文为空。`);
      continue;
    }
    segments.push({
      index: segments.length,
      startSeconds,
      endSeconds,
      body,
      raw,
    });
  }

  if (errors.length) return { ok: false, errors };
  if (segments.length === 0) return { ok: false, errors: ["未解析到任何有效分段。"] };

  // 非重叠、可接续（允许紧接；禁止严格重叠）
  const ordered = [...segments].sort((a, b) => a.startSeconds - b.startSeconds);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.startSeconds < prev.endSeconds) {
      return {
        ok: false,
        errors: [
          `分段时码重叠：${prev.startSeconds}-${prev.endSeconds} 与 ${cur.startSeconds}-${cur.endSeconds}`,
        ],
      };
    }
  }

  const totalSpanSeconds = ordered[ordered.length - 1]!.endSeconds - ordered[0]!.startSeconds;
  return { ok: true, segments: ordered.map((s, index) => ({ ...s, index })), totalSpanSeconds };
}

/**
 * 校验 video_prompt：可解析 + 总跨度不超过 maxDurationSeconds（默认 15）。
 */
export function validateStudioVideoPrompt(
  videoPrompt: string,
  options?: { maxDurationSeconds?: number; requireSegments?: boolean },
): ParseVideoPromptResult {
  const maxDur = options?.maxDurationSeconds ?? 15;
  const parsed = parseStudioVideoPromptSegments(videoPrompt);
  if (!parsed.ok) return parsed;
  if (options?.requireSegments !== false && parsed.segments.length < 1) {
    return { ok: false, errors: ["至少需要 1 个分段。"] };
  }
  const lastEnd = Math.max(...parsed.segments.map((s) => s.endSeconds));
  if (lastEnd > maxDur) {
    return {
      ok: false,
      errors: [`video_prompt 末段结束 ${lastEnd}s 超过单元上限 ${maxDur}s。`],
    };
  }
  return parsed;
}
