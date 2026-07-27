/**
 * P3 一致性/资产 + P4 审片合同（纯函数）。
 */

/** P3.1 简化一致性分数聚合（不替代 P19 真图评） */
export function aggregateConsistencyScores(
  items: Array<{ verdict: "consistent" | "needs-review" | "drifted" | "not-checkable" }>,
): "consistent" | "needs-review" | "drifted" | "not-checkable" {
  if (!items.length) return "not-checkable";
  if (items.some((i) => i.verdict === "drifted")) return "drifted";
  if (items.some((i) => i.verdict === "needs-review")) return "needs-review";
  if (items.every((i) => i.verdict === "consistent")) return "consistent";
  return "not-checkable";
}

/** P3.2 角色 × prompts 批量 */
export function buildCharacterPromptBatch(
  characters: Array<{ id: string; name: string }>,
  prompts: string[],
): Array<{ characterId: string; prompt: string }> {
  if (!characters.length || !prompts.length) throw new Error("batch: characters/prompts 不能为空。");
  if (prompts.length !== characters.length && prompts.length !== 1) {
    throw new Error("batch: prompts 数量须为 1 或与角色数相同。");
  }
  return characters.map((c, i) => ({
    characterId: c.id,
    prompt: prompts.length === 1 ? `${prompts[0]} [char:${c.name}]` : prompts[i]!,
  }));
}

/** P3.3 LoRA 配方侧车 */
export type LoraRecipe = {
  triggerWord: string;
  dim: number;
  alpha: number;
  learningRate: number;
  steps: number;
};

export function validateLoraRecipe(r: LoraRecipe): void {
  if (!r.triggerWord?.trim()) throw new Error("lora: triggerWord 必填。");
  if (!(r.dim >= 4 && r.dim <= 128)) throw new Error("lora: dim 4–128。");
  if (!(r.alpha > 0)) throw new Error("lora: alpha 须为正。");
  if (!(r.learningRate > 0 && r.learningRate < 1)) throw new Error("lora: lr 非法。");
  if (!(r.steps >= 100 && r.steps <= 20000)) throw new Error("lora: steps 范围异常。");
}

/** P3.4 资产版本边 */
export type AssetRelationKind = "derivedFrom" | "versionOf" | "referenceFor" | "trainedOn";

export function assertAssetRelation(kind: AssetRelationKind, fromId: string, toId: string): void {
  if (!fromId.trim() || !toId.trim()) throw new Error("relation: id 空。");
  if (fromId === toId) throw new Error("relation: 禁止自环。");
  if (!["derivedFrom", "versionOf", "referenceFor", "trainedOn"].includes(kind)) {
    throw new Error("relation: kind 非法。");
  }
}

/** P3.5 权威图徽章 */
export function authorityBadge(input: {
  isAuthority: boolean;
  sha256?: string;
  revision?: number;
}): { label: string; locked: boolean } {
  if (!input.isAuthority) return { label: "候选", locked: false };
  const short = input.sha256?.slice(0, 8) ?? "????????";
  return { label: `权威 rev${input.revision ?? "?"} · ${short}`, locked: true };
}

/** P3.6 拼版 caption 折行 */
export function wrapCaption(text: string, maxChars = 16): string[] {
  const t = text.trim();
  if (!t) return [];
  const lines: string[] = [];
  for (let i = 0; i < t.length; i += maxChars) lines.push(t.slice(i, i + maxChars));
  return lines;
}

/** P3.7 风格/negative */
export const DEFAULT_NEGATIVE_LEXICON = ["文字", "字幕", "水印", "logo", "blurry", "lowres", "extra fingers"];
export function applyStyleTemplate(style: string, prompt: string): { positive: string; negative: string } {
  if (!style.trim() || !prompt.trim()) throw new Error("style: 空。");
  return {
    positive: `${prompt}, ${style}, high quality`,
    negative: DEFAULT_NEGATIVE_LEXICON.join(", "),
  };
}

/** P3.8 多角度参考板计划 */
export function planMultiAngleBoard(angles: string[]): { cells: number; angles: string[] } {
  if (angles.length < 2 || angles.length > 6) throw new Error("multi-angle: 2–6 角。");
  return { cells: angles.length, angles: [...angles] };
}

/** P3.9 GC 报告（内存） */
export function buildGcReportPure(referenced: string[], allObjects: string[]): {
  orphans: string[];
  referencedCount: number;
} {
  const ref = new Set(referenced);
  return {
    orphans: allObjects.filter((o) => !ref.has(o)),
    referencedCount: ref.size,
  };
}

/** P3.10 IP-Adapter 策略名 */
export const IP_ADAPTER_STRATEGIES = {
  character: "face-id",
  scene: "composition",
  prop: "plus-content",
} as const;

export function ipAdapterStrategyFor(kind: "character" | "scene" | "prop"): string {
  return IP_ADAPTER_STRATEGIES[kind];
}

// —— P4 审片 ——

/** P4.1 W3C 批注 selector */
export function buildW3cAnnotation(input: {
  x: number;
  y: number;
  w: number;
  h: number;
  tSeconds?: number;
  body: string;
}): { target: { selector: string }; body: string } {
  if (!(input.w > 0 && input.h > 0)) throw new Error("annotation: 矩形非法。");
  if (!input.body.trim()) throw new Error("annotation: body 空。");
  let selector = `xywh=pixel:${input.x},${input.y},${input.w},${input.h}`;
  if (input.tSeconds !== undefined) {
    if (!(input.tSeconds >= 0)) throw new Error("annotation: t 非法。");
    selector += `&t=${input.tSeconds}`;
  }
  return { target: { selector }, body: input.body.trim() };
}

/** P4.2 对比模式 */
export const REVIEW_COMPARE_MODES = ["off", "a-b", "wipe", "difference"] as const;
export type ReviewCompareMode = (typeof REVIEW_COMPARE_MODES)[number];

export function assertCompareMode(m: string): ReviewCompareMode {
  if (!REVIEW_COMPARE_MODES.includes(m as ReviewCompareMode)) throw new Error(`compare: 非法模式 ${m}`);
  return m as ReviewCompareMode;
}

/** P4.3 批注→返工 */
export type ReworkLink = {
  annotationId: string;
  panelId: string;
  newRunRequired: boolean;
  status: "open" | "in-progress" | "done";
};

export function openReworkFromAnnotation(annotationId: string, panelId: string): ReworkLink {
  if (!annotationId.trim() || !panelId.trim()) throw new Error("rework: id 空。");
  return { annotationId, panelId, newRunRequired: true, status: "open" };
}

/** P4.4 区间批注 */
export function validateTemporalRange(start: number, end: number): void {
  if (!(end > start) || start < 0) throw new Error("range: 非法区间。");
}

/** P4.8 状态文案 */
export const REVIEW_PIPELINE_LABELS = {
  wip: "制作中",
  review: "待审片",
  approved: "已通过",
  retake: "重拍",
} as const;

export function reviewPipelineLabel(s: keyof typeof REVIEW_PIPELINE_LABELS): string {
  return REVIEW_PIPELINE_LABELS[s];
}

/** P4.9 PNG 身份元数据键 */
export const PNG_IDENTITY_KEYS = ["aicanvas_packId", "aicanvas_runId", "aicanvas_panelId"] as const;

export function buildPngIdentityTextChunks(input: {
  packId: string;
  runId: string;
  panelId: string;
}): Record<string, string> {
  if (!input.packId || !input.runId || !input.panelId) throw new Error("png-meta: 字段空。");
  return {
    aicanvas_packId: input.packId,
    aicanvas_runId: input.runId,
    aicanvas_panelId: input.panelId,
  };
}

/** P4.7 审片 Markdown 报告片段 */
export function buildReviewReportMarkdown(rows: Array<{ panelId: string; decision: string; note?: string }>): string {
  if (!rows.length) throw new Error("report: 无行。");
  const lines = ["# 审片报告", ""];
  for (const r of rows) {
    lines.push(`- **${r.panelId}**: ${r.decision}${r.note ? ` — ${r.note}` : ""}`);
  }
  return lines.join("\n");
}
