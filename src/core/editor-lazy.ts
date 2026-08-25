/**
 * Wave 4-A：剪辑 / OTIO / 关键帧冷域。启动路径不得静态拉 editor.js。
 * 写路径仍走 command-bus 原命令；此处只延迟加载同一模块。
 */
export type EditorModule = typeof import("./editor.js");
export type KeyframeCurveModule = typeof import("./keyframe-curve.js");

let editorModule: Promise<EditorModule> | undefined;
let keyframeCurveModule: Promise<KeyframeCurveModule> | undefined;

export function loadEditor(): Promise<EditorModule> {
  editorModule ??= import("./editor.js");
  return editorModule;
}

export function loadKeyframeCurve(): Promise<KeyframeCurveModule> {
  keyframeCurveModule ??= import("./keyframe-curve.js");
  return keyframeCurveModule;
}

export async function withEditor<T>(read: (editor: EditorModule) => T | Promise<T>): Promise<T> {
  return read(await loadEditor());
}

/**
 * get_capabilities 握手不得 import editor / 探测 FFmpeg。
 * 实时 available/path/version 只经 probe_video_engine（仍走 withEditor）。
 */
export const DEFERRED_VIDEO_ENGINE_CAPABILITY = {
  status: "deferred",
  probed: false,
  probeTool: "probe_video_engine",
  issues: ["get_capabilities 不探测剪辑引擎；请调用 probe_video_engine。"],
} as const;
