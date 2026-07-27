/**
 * 宫格 JSON 契约（对照 ai-comic-factory panel/instructions/speech/caption）。
 * 用于拆格 draft 与本地校验，不替代冻结包 nine-field。
 */

export type StudioPanelJsonDraft = {
  panel: number;
  instructions: string;
  speech?: string;
  caption?: string;
  /** 可选关联镜头草稿字段 */
  shotType?: string;
  videoPrompt?: string;
};

export type StudioPanelJsonValidation =
  | { ok: true; panels: StudioPanelJsonDraft[] }
  | { ok: false; errors: string[] };

/**
 * 校验 2–6 格 panel 数组：
 * - panel 为 1..N 连续
 * - instructions 非空且须含最低视觉约束线索（性别/地点/光线等关键词之一，或长度≥20）
 * - 禁止空 speech 冒充
 */
export function validateStudioPanelJsonArray(
  panels: unknown,
  options?: { minPanels?: number; maxPanels?: number },
): StudioPanelJsonValidation {
  const minP = options?.minPanels ?? 2;
  const maxP = options?.maxPanels ?? 6;
  if (!Array.isArray(panels)) {
    return { ok: false, errors: ["panels 必须是数组。"] };
  }
  if (panels.length < minP || panels.length > maxP) {
    return { ok: false, errors: [`宫格数须在 ${minP}–${maxP}，实得 ${panels.length}。`] };
  }

  const errors: string[] = [];
  const out: StudioPanelJsonDraft[] = [];

  for (let i = 0; i < panels.length; i++) {
    const row = panels[i] as Record<string, unknown>;
    if (!row || typeof row !== "object") {
      errors.push(`第 ${i + 1} 项不是对象。`);
      continue;
    }
    const panel = row.panel;
    if (!Number.isInteger(panel) || (panel as number) !== i + 1) {
      errors.push(`第 ${i + 1} 项 panel 须为 ${i + 1}，实得 ${String(panel)}。`);
    }
    const instructions = typeof row.instructions === "string" ? row.instructions.trim() : "";
    if (!instructions) {
      errors.push(`第 ${i + 1} 格 instructions 不能为空。`);
    } else if (instructions.length < 12) {
      errors.push(`第 ${i + 1} 格 instructions 过短（须含构图/人物/环境线索）。`);
    } else {
      // 弱约束：鼓励含地点/光线/人物线索之一
      const hasCue =
        /光|夜|日|室内|室外|男|女|角色|场景|近景|远景|特写|light|night|man|woman|interior|exterior/i.test(
          instructions,
        );
      if (!hasCue && instructions.length < 24) {
        errors.push(`第 ${i + 1} 格 instructions 缺少性别/地点/光线等线索且过短。`);
      }
    }
    const speech = row.speech === undefined || row.speech === null ? "" : String(row.speech);
    const caption = row.caption === undefined || row.caption === null ? "" : String(row.caption);
    out.push({
      panel: i + 1,
      instructions,
      speech: speech || undefined,
      caption: caption || undefined,
      shotType: typeof row.shotType === "string" ? row.shotType : undefined,
      videoPrompt: typeof row.videoPrompt === "string" ? row.videoPrompt : undefined,
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, panels: out };
}
