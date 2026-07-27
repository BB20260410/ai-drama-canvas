/**
 * 分镜 Shot 中文 schema 校验（对照 Storyboardify / 火宝 16 要素子集）。
 * 兼容本仓 15s 单元 2–6 格：不强制 16 字段全满，但校验枚举与时长边界。
 * video_prompt 分段见 `studio-video-prompt-segments.ts`。
 */

import { validateStudioVideoPrompt } from "./studio-video-prompt-segments.js";

export const STUDIO_SHOT_TYPES = ["extreme_wide", "wide", "full", "medium", "close_up", "extreme_close_up", "insert", "extension"] as const;
export type StudioShotType = (typeof STUDIO_SHOT_TYPES)[number];

export const STUDIO_CAMERA_ANGLES = ["eye_level", "high", "low", "bird", "worm", "dutch", "side", "back"] as const;
export type StudioCameraAngle = (typeof STUDIO_CAMERA_ANGLES)[number];

export const STUDIO_CAMERA_MOVEMENTS = ["static", "push", "pull", "pan", "tilt", "track", "crane", "handheld", "zoom"] as const;
export type StudioCameraMovement = (typeof STUDIO_CAMERA_MOVEMENTS)[number];

/** 火宝式 16 要素字段袋（本仓兼容扩展；均可选，严格模式另校验） */
export type StudioShotSixteenFields = {
  title?: string;
  timeOfDay?: string;
  location?: string;
  shotType?: string;
  cameraAngle?: string;
  cameraMovement?: string;
  action?: string;
  dialogue?: string;
  result?: string;
  atmosphere?: string;
  durationSeconds?: number;
  imagePrompt?: string;
  videoPrompt?: string;
  bgmPrompt?: string;
  soundEffect?: string;
  sceneId?: string;
  characterIds?: string[];
};

export type StudioShotDraft = StudioShotSixteenFields & {
  shotNumber?: number;
  content?: string;
};

export type StudioShotValidation =
  | { ok: true; normalized: Required<Pick<StudioShotDraft, "shotType" | "durationSeconds">> & StudioShotDraft }
  | { ok: false; errors: string[] };

export function validateStudioShotDraft(
  draft: StudioShotDraft,
  options?: { maxDurationSeconds?: number; requireVideoPromptSegments?: boolean },
): StudioShotValidation {
  const errors: string[] = [];
  const maxDur = options?.maxDurationSeconds ?? 15;

  if (draft.shotType !== undefined && draft.shotType !== "") {
    if (!STUDIO_SHOT_TYPES.includes(draft.shotType as StudioShotType)) {
      errors.push(`shotType 非法：${draft.shotType}`);
    }
  }
  if (draft.cameraAngle !== undefined && draft.cameraAngle !== "") {
    if (!STUDIO_CAMERA_ANGLES.includes(draft.cameraAngle as StudioCameraAngle)) {
      errors.push(`cameraAngle 非法：${draft.cameraAngle}`);
    }
  }
  if (draft.cameraMovement !== undefined && draft.cameraMovement !== "") {
    if (!STUDIO_CAMERA_MOVEMENTS.includes(draft.cameraMovement as StudioCameraMovement)) {
      errors.push(`cameraMovement 非法：${draft.cameraMovement}`);
    }
  }
  if (draft.durationSeconds !== undefined) {
    if (!Number.isFinite(draft.durationSeconds) || draft.durationSeconds <= 0) {
      errors.push("durationSeconds 必须为正数。");
    } else if (draft.durationSeconds > maxDur) {
      errors.push(`durationSeconds 不得超过 ${maxDur}（本仓单元上限）。`);
    }
  }
  if (draft.characterIds !== undefined) {
    if (!Array.isArray(draft.characterIds)) {
      errors.push("characterIds 必须是数组。");
    } else if (draft.characterIds.some((id) => typeof id !== "string" || !id.trim())) {
      errors.push("characterIds 含空项。");
    }
  }
  if (draft.videoPrompt?.trim()) {
    const vp = validateStudioVideoPrompt(draft.videoPrompt, { maxDurationSeconds: maxDur });
    if (!vp.ok) errors.push(...vp.errors);
  } else if (options?.requireVideoPromptSegments) {
    errors.push("requireVideoPromptSegments 时必须提供可分段 video_prompt。");
  }
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    normalized: {
      ...draft,
      shotType: (draft.shotType?.trim() || "medium") as string,
      durationSeconds: draft.durationSeconds ?? 3,
    },
  };
}

/** 16 要素键名清单（文档/UI 对照用） */
export const STUDIO_SHOT_SIXTEEN_KEYS: (keyof StudioShotSixteenFields)[] = [
  "title",
  "timeOfDay",
  "location",
  "shotType",
  "cameraAngle",
  "cameraMovement",
  "action",
  "dialogue",
  "result",
  "atmosphere",
  "durationSeconds",
  "imagePrompt",
  "videoPrompt",
  "bgmPrompt",
  "soundEffect",
  "sceneId",
  "characterIds",
];

