/**
 * P26：把技术错误翻译成普通用户能理解、可行动的中文。
 * 共享于受管画布与素材中心壳的错误条；纯函数，无依赖。
 */

const ERROR_TRANSLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/database is locked|SQLITE_BUSY|busy_timeout/i, "数据正忙，请稍候再试一次。"],
  [/ENOENT|no such file or directory/i, "找不到需要的文件，请刷新后再试。"],
  [/EACCES|permission denied/i, "没有权限写入，请检查文件夹权限后重试。"],
  [/panel-run-in-flight/i, "这个宫格已有生成任务在进行中，请等它结束或先取消。"],
  [/unexpected-revision-impact/i, "本修订对已有图有非预期影响，须人工复核后再生成。"],
  [/run-cancelled/i, "该生成任务已取消，不能继续写入结果；如需重试请重新开始。"],
  [/input-drift/i, "内容在开始前发生了变化，请重新核对连线后再开始。"],
  [/continuity-drift/i, "连续性校验未通过，请重新核对角色、场景、道具和剧本后再开始。"],
  [/pack-cas-drift|cas-drift/i, "生成包内容被改动过，请重新冻结后再派发。"],
  [/revision-conflict|expectedRevision|修订冲突/i, "内容刚被更新过，请刷新后再修改。"],
  [/fingerprint-conflict|指纹不匹配/i, "画布刚被更新过，请刷新后再试。"],
  [/invalid-input|invalid_input|\bZodError\b/i, "输入格式不正确，请检查后重试。"],
  [/not-found|不存在/i, "要找的内容不存在或已被移除，请刷新列表。"],
  [/\bnetwork\b|fetch failed|ECONNREFUSED|ETIMEDOUT/i, "连接失败，请检查本机服务后重试。"],
];

/** 行内黑话替换（已是中文的消息透传时顺带清理夹杂的英文术语）。 */
export function polishUserFacingText(text: string): string {
  return text
    .replaceAll("AssetBindingSet", "生成绑定")
    .replaceAll("BindingSet", "生成绑定")
    .replaceAll("generationRunId", "生成任务")
    .replaceAll("packFingerprint", "生成包指纹")
    .replaceAll("fingerprint", "版本指纹")
    .replace(/ {2,}/g, " ")
    .replace(/([一-鿿]) (?=[一-鿿])/g, "$1");
}

/**
 * 把任意错误转成用户可读文案。
 * 已是中文的消息（替换行内黑话后）原样透传；英文/未知技术错误给可行动兜底并附截断原文。
 */
export function toUserFacingErrorText(error: unknown, fallback = "操作没有完成，请重试；多次失败请刷新页面。"): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();
  for (const [pattern, text] of ERROR_TRANSLATIONS) {
    if (pattern.test(raw)) return text;
  }
  if (!raw) return fallback;
  // 已含中文：视为业务文案透传（行内黑话替换）。
  if (/[一-鿿]/.test(raw)) return polishUserFacingText(raw);
  const detail = polishUserFacingText(raw.length > 120 ? `${raw.slice(0, 120)}…` : raw);
  return `${fallback}（${detail}）`;
}
