import { createHash } from "node:crypto";
import type { FusionScheduleRow } from "./fusion-package.js";
import type { StoryboardProductionContract } from "./types.js";

const EPSILON = 0.001;
const STANDARD_DURATION_SECONDS = 15;
const MIN_PANEL_COUNT = 2;
const MAX_PANEL_COUNT = 6;
export const FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION = "semantic-beat-v1" as const;
export const FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION = "one-decimal-boundaries-then-difference-v1" as const;
const NO_TEXT_PROMPT = "纯画面，画面内不要任何中文、英文、字母、数字、字幕、标题、表格线、水印或界面元素。";

export class FusionStoryboardGridValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionStoryboardGridValidationError";
  }
}

export interface FusionStoryboardGridUnitMetadata {
  unitId: string;
  title: string;
  episodeLabel?: string;
  unitSequence?: number;
  storyGoal?: string;
  aspectRatio?: string;
  standardDurationSeconds?: number;
}

export interface FusionStoryboardGridOverride {
  panelCount: number;
  /** 必须与读取 confirmed storyboard 时得到的 store revision 一致。 */
  expectedRevision: number;
  reason: string;
}

export interface FusionStoryboardGridReferenceOverride {
  /** 必须与读取 confirmed storyboard 时得到的 store revision 一致。 */
  expectedRevision: number;
  /** 记录为什么源分镜之外还需要连续性参考，禁止无理由扩张参考板。 */
  reason: string;
  /**
   * 仅为指定 row 补充已经在本单元其他 row 正式出现过的资产。
   * 这些资产是连续性参考，不代表当前格必须把它们强行画进画面。
   */
  additionalAssetIdsByRowId: Record<string, string[]>;
  /** 写入冻结生图提示词，说明何时可见、何时必须保持在画外或遮挡。 */
  promptInstruction: string;
}

export interface FusionStoryboardGridBuildInput {
  unit: FusionStoryboardGridUnitMetadata;
  storyboardRevision: number;
  /** 只能传 getConfirmedStoryboardContracts 返回的不可变合同。 */
  rows: readonly StoryboardProductionContract[];
  /** 必须是覆盖完整 15 秒且连续的融合排期。 */
  schedule: readonly FusionScheduleRow[];
  /** 每个 row 的正式资产 ID；缺省代表该 row 已确认无资产引用。 */
  assetIdsByRowId?: Readonly<Record<string, readonly string[]>>;
  override?: FusionStoryboardGridOverride;
  referenceOverride?: FusionStoryboardGridReferenceOverride;
}

export type FusionStoryboardGridFrameRole = "start" | "middle" | "end";
export type FusionStoryboardGridSelectionMode = "automatic" | "explicit-override";

export interface FusionStoryboardGridTableField {
  key: "imageContentAction" | "shotComposition" | "shootingMethod" | "continuitySound" | "dialogueSubtitle" | "duration";
  label: "画面内容/动作" | "景别/构图" | "拍摄方式" | "连续性/声音" | "台词/字幕" | "时长";
  value: string;
}

export interface FusionStoryboardGridPanelLayout {
  row: number;
  column: number;
  columnSpan: 1 | 2;
  readingOrder: number;
  imagePlacement: "left";
  detailPlacement: "right-table-columns";
  emphasis: "start" | "normal" | "end";
}

export interface FusionStoryboardGridPanel {
  id: string;
  index: number;
  frameRole: FusionStoryboardGridFrameRole;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  durationLabel: string;
  storyboardRowIds: string[];
  storyboardRowRevisions: number[];
  sourceShotItemIds: string[];
  sourceShotNumbers: number[];
  scheduleRowIndexes: number[];
  scheduleRowIds: string[];
  /**
   * 当前格的完整语义资产集合，允许超过供应商 6 槽上限。
   * 实际上传引用必须由独立 PanelReferenceResolution 压缩并证明完整覆盖，
   * 禁止在宫格几何阶段静默裁剪语义资产。
   */
  assetIds: string[];
  /** 由显式连续性覆盖补入，只作身份/道具连续性参考，未明确出镜时不得强行入画。 */
  continuityReferenceAssetIds: string[];
  semanticBeats: Array<{
    storyboardRowId: string;
    detectedBeatIndexes: number[];
    detectedBeatCount: number;
    kind: "narrative" | "continuity-extension" | "synthesized-phase";
    text: string;
  }>;
  imageContentAction: string;
  shotComposition: string;
  shootingMethod: string;
  continuitySound: string;
  dialogueSubtitle: string;
  /** 给逐格生图使用；只描述纯画面，中文信息由本地 renderer 叠加。 */
  imageGenerationPrompt: string;
  selectionReason: string;
  tableFields: FusionStoryboardGridTableField[];
  layout: FusionStoryboardGridPanelLayout;
}

export interface FusionStoryboardGridLayout {
  template: "portrait-storyboard-table";
  pageOrientation: "portrait";
  pageAspectRatio: "9:16";
  gridColumns: 1;
  gridRows: number;
  headerPlacement: "top-full-width";
  footerPlacement: "bottom-full-width";
  panelCellModel: "image-left-details-columns";
  detailFieldOrder: FusionStoryboardGridTableField["key"][];
}

export interface FusionStoryboardGridContract {
  schemaVersion: 1;
  kind: "fusion-storyboard-grid-contract";
  contractId: string;
  sourceStoryboardRevision: number;
  sourceFingerprint: string;
  /** 仅冻结逐格生图语义；本地表格样式字段变化不应迫使既有图片失效。 */
  productionFingerprint: string;
  displayTiming: {
    policyVersion: typeof FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION;
    decimals: 1;
    durationDerivedFromDisplayedBoundaries: true;
    totalVisibleDurationSeconds: 15;
  };
  unit: FusionStoryboardGridUnitMetadata & { standardDurationSeconds: number };
  header: {
    title: string;
    subtitle: string;
    metadataLine: string;
  };
  selection: {
    mode: FusionStoryboardGridSelectionMode;
    algorithmVersion: typeof FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION;
    panelCount: number;
    sourceRowCount: number;
    detectedBeatCount: number;
    cappedByMaximum: boolean;
    reason: string;
    overrideReason?: string;
    rowPlans: Array<{
      storyboardRowId: string;
      durationSeconds: number;
      detectedBeatCount: number;
      detectedBeats: string[];
      allocatedPanelCount: number;
      reason: string;
    }>;
  };
  referenceOverride?: FusionStoryboardGridReferenceOverride;
  panels: FusionStoryboardGridPanel[];
  layout: FusionStoryboardGridLayout;
  footer: {
    rhythmChain: Array<{
      panelId: string;
      frameRole: FusionStoryboardGridFrameRole;
      startSeconds: number;
      endSeconds: number;
      label: string;
    }>;
    summary: string;
  };
  coverage: {
    allStoryboardRowsCovered: true;
    storyboardRowIds: string[];
    groupedPanelIds: string[];
    splitStoryboardRowIds: string[];
    allScheduleRowsCovered: true;
    scheduleRowIndexes: number[];
  };
  localRendering: {
    engine: "svg-sharp";
    language: "zh-CN";
    textRendering: "local-only";
    panelImageMode: "one-image-per-panel";
    assetReferenceMode: "one-image-per-asset";
    aiImageContainsText: false;
    fontFallbacks: string[];
    outputArtifacts: ["panel-images", "storyboard-svg", "storyboard-png"];
    outputInstructions: string[];
    negativePrompt: string;
  };
}

interface RowWindow {
  row: StoryboardProductionContract;
  startSeconds: number;
  endSeconds: number;
}

interface SemanticBeat {
  text: string;
  detectedBeatIndexes: number[];
  detectedBeatCount: number;
  kind: "narrative" | "continuity-extension" | "synthesized-phase";
}

interface RowSemanticPlan extends RowWindow {
  detectedBeats: SemanticBeat[];
}

interface PanelFragment extends RowWindow {
  splitIndex: number;
  splitCount: number;
  semanticBeat: SemanticBeat;
}

function roundTime(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export interface FusionStoryboardPanelDisplayTiming {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  rangeLabel: string;
  durationLabel: string;
  fullLabel: string;
}

/**
 * 用户看到的是一位小数秒段，因此可见时长必须由同一组可见边界相减，
 * 不能把每格原始浮点时长独立四舍五入后造成总和 15.1s/14.9s。
 */
export function fusionStoryboardPanelDisplayTiming(startSeconds: number, endSeconds: number): FusionStoryboardPanelDisplayTiming {
  const visibleStart = Math.round(startSeconds * 10) / 10;
  const visibleEnd = Math.round(endSeconds * 10) / 10;
  const visibleDuration = Math.round((visibleEnd - visibleStart) * 10) / 10;
  return {
    startSeconds: visibleStart,
    endSeconds: visibleEnd,
    durationSeconds: visibleDuration,
    rangeLabel: `${visibleStart.toFixed(1)}–${visibleEnd.toFixed(1)}`,
    durationLabel: `${visibleDuration.toFixed(1)}s`,
    fullLabel: `${visibleStart.toFixed(1)}–${visibleEnd.toFixed(1)}s（${visibleDuration.toFixed(1)}s）`,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fusionStoryboardProductionFingerprint(contract: FusionStoryboardGridContract): string {
  return sha256({
    sourceFingerprint: contract.sourceFingerprint,
    unitId: contract.unit.unitId,
    panelCount: contract.selection.panelCount,
    panels: contract.panels.map((panel) => ({
      id: panel.id,
      index: panel.index,
      frameRole: panel.frameRole,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      storyboardRowIds: panel.storyboardRowIds,
      storyboardRowRevisions: panel.storyboardRowRevisions,
      sourceShotItemIds: panel.sourceShotItemIds,
      sourceShotNumbers: panel.sourceShotNumbers,
      scheduleRowIndexes: panel.scheduleRowIndexes,
      scheduleRowIds: panel.scheduleRowIds,
      assetIds: panel.assetIds,
      continuityReferenceAssetIds: panel.continuityReferenceAssetIds ?? [],
      imageGenerationPrompt: panel.imageGenerationPrompt,
    })),
  });
}

/**
 * v1 历史合同曾在 `continuityReferenceAssetIds` 尚未落盘时生成。缺省空数组
 * 属于 schema 兼容差异，不是剧情或生图语义漂移。
 */
export function normalizeFusionStoryboardGridContract(contract: FusionStoryboardGridContract): FusionStoryboardGridContract {
  const normalized = {
    ...contract,
    panels: contract.panels.map((panel) => ({
      ...panel,
      continuityReferenceAssetIds: panel.continuityReferenceAssetIds ?? [],
    })),
  };
  return {
    ...normalized,
    productionFingerprint: fusionStoryboardProductionFingerprint(normalized as FusionStoryboardGridContract),
  };
}

function assertPanelCount(value: number): void {
  if (!Number.isInteger(value) || value < MIN_PANEL_COUNT || value > MAX_PANEL_COUNT) {
    throw new FusionStoryboardGridValidationError("宫格分镜 panelCount 必须是 2–6 的整数");
  }
}

function validateSchedule(schedule: readonly FusionScheduleRow[], duration: number): FusionScheduleRow[] {
  if (!schedule.length) throw new FusionStoryboardGridValidationError("15 秒宫格分镜缺少融合排期");
  const sorted = [...schedule].sort((left, right) => left.startSeconds - right.startSeconds || left.index - right.index);
  let cursor = 0;
  const indexes = new Set<number>();
  for (const row of sorted) {
    if (!Number.isInteger(row.index) || row.index < 0 || indexes.has(row.index)) throw new FusionStoryboardGridValidationError("融合排期存在非法或重复 index");
    indexes.add(row.index);
    if (Math.abs(row.startSeconds - cursor) > EPSILON) throw new FusionStoryboardGridValidationError(`融合排期在 ${cursor}s 处不连续`);
    if (row.endSeconds <= row.startSeconds || Math.abs(row.durationSeconds - (row.endSeconds - row.startSeconds)) > EPSILON) {
      throw new FusionStoryboardGridValidationError(`融合排期 ${row.index} 的秒段与时长不一致`);
    }
    cursor = row.endSeconds;
  }
  if (Math.abs(cursor - duration) > EPSILON) throw new FusionStoryboardGridValidationError(`融合排期必须完整覆盖 ${duration} 秒`);
  return sorted;
}

function buildRowWindows(rows: readonly StoryboardProductionContract[], unitId: string, duration: number): RowWindow[] {
  if (!rows.length) throw new FusionStoryboardGridValidationError("没有已确认的 storyboard rows，不能构建宫格分镜");
  const sorted = [...rows].sort((left, right) => left.order - right.order || left.storyboardRowId.localeCompare(right.storyboardRowId));
  if (new Set(sorted.map((row) => row.storyboardRowId)).size !== sorted.length) throw new FusionStoryboardGridValidationError("storyboardRowId 不唯一");
  if (new Set(sorted.map((row) => row.order)).size !== sorted.length) throw new FusionStoryboardGridValidationError("confirmed storyboard rows 存在重复顺序");
  if (sorted.some((row) => row.itemId !== unitId)) throw new FusionStoryboardGridValidationError("宫格分镜不能混入其他 15 秒单元的 storyboard row");
  let cursor = 0;
  const windows = sorted.map((row) => {
    if (!Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0) throw new FusionStoryboardGridValidationError(`${row.storyboardRowId} 时长非法`);
    const startSeconds = cursor;
    cursor = roundTime(cursor + row.durationSeconds);
    return { row, startSeconds, endSeconds: cursor };
  });
  if (Math.abs(cursor - duration) > EPSILON) throw new FusionStoryboardGridValidationError(`confirmed storyboard rows 必须累计覆盖 ${duration} 秒，当前为 ${cursor} 秒`);
  return windows;
}

function trimTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。！？；，、：:]+$/u, "").trim();
}

function isGenericContinuityExtension(value: string): boolean {
  return /补足动作前奏\s*\/\s*反应\s*\/\s*收束|承接末镜延展|不新增改变剧情走向的事件|延展至第\s*15\s*秒/u.test(value);
}

function stripShotDescriptorPrefix(value: string): string {
  const normalized = value.trim();
  const firstStop = normalized.search(/[。！？；]/u);
  if (firstStop < 0) return normalized;
  const candidate = normalized.slice(0, firstStop).trim();
  const remainder = normalized.slice(firstStop + 1).trim();
  const looksLikeDescriptor = candidate.includes("·")
    && candidate.length <= 36
    && /(?:特写|近景|中景|全景|远景|俯拍|仰拍|低机位|高机位|跟拍|横移|推进|拉远|固定|胸前|背后|主观|侧面|正面)/u.test(candidate);
  return looksLikeDescriptor && remainder ? remainder : normalized;
}

function isContinuityConstraintSentence(value: string): boolean {
  const sentence = trimTerminalPunctuation(value);
  return /互不相露|不发光|不得露出|不可露出|保持不变|维持不变|不新增改变剧情走向/u.test(sentence)
    || /^(?:三件|两件|这些|上述|布囊|面具|衣着|发髻).{0,80}(?:不|无|保持|仍旧|依旧)/u.test(sentence);
}

function strongActionSentences(value: string): string[] {
  const withoutDescriptor = stripShotDescriptorPrefix(value)
    .replace(/\.{3,}|…+/gu, "。")
    .replace(/\s+/gu, " ")
    .trim();
  const strongSegments = withoutDescriptor.match(/[^。！？；]+[。！？；]?/gu) ?? [];
  const splitTransitions = strongSegments.flatMap((segment) => segment
    .split(/[，,]\s*(?=(?:随后|紧接着|继而|旋即|下一刻|转眼|然后|终于|立刻|顿时|猛地))/u)
    .map(trimTerminalPunctuation)
    .filter(Boolean));
  const beats: string[] = [];
  for (const sentence of splitTransitions) {
    if (isContinuityConstraintSentence(sentence) && beats.length) {
      beats[beats.length - 1] = `${beats[beats.length - 1]}；${sentence}`;
    } else {
      beats.push(sentence);
    }
  }
  return beats;
}

function detectSemanticBeats(window: RowWindow): RowSemanticPlan {
  const action = window.row.action.trim();
  if (isGenericContinuityExtension(action)) {
    return {
      ...window,
      detectedBeats: [{
        text: trimTerminalPunctuation(action),
        detectedBeatIndexes: [1],
        detectedBeatCount: 1,
        kind: "continuity-extension",
      }],
    };
  }
  const texts = strongActionSentences(action);
  const fallback = trimTerminalPunctuation(stripShotDescriptorPrefix(action)) || "保持本段已确认动作和连续性";
  const normalized = texts.length ? texts : [fallback];
  return {
    ...window,
    detectedBeats: normalized.map((text, index) => ({
      text,
      detectedBeatIndexes: [index + 1],
      detectedBeatCount: normalized.length,
      kind: "narrative",
    })),
  };
}

function conciseFrameAnchor(prompt: string, fallback: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  const marker = normalized.match(/(?:首帧画面|首帧定格)：/u);
  const afterMarker = marker?.index === undefined ? normalized : normalized.slice(marker.index + marker[0].length);
  const beforeTechnical = afterMarker.split(/\s*(?:光线：|机位\/焦段\/运镜参考：|参考素材编号：|禁止文字水印|禁止现代|避免错手)/u)[0]?.trim() ?? "";
  const concise = trimTerminalPunctuation(beforeTechnical);
  return concise && concise.length <= 260 ? concise : trimTerminalPunctuation(fallback);
}

function combineBeats(beats: readonly SemanticBeat[]): SemanticBeat {
  const text = beats.map((beat) => beat.text).join("；随后：");
  const detectedBeatIndexes = [...new Set(beats.flatMap((beat) => beat.detectedBeatIndexes))].sort((left, right) => left - right);
  return {
    text,
    detectedBeatIndexes,
    detectedBeatCount: Math.max(...beats.map((beat) => beat.detectedBeatCount)),
    kind: beats.every((beat) => beat.kind === "continuity-extension") ? "continuity-extension" : "narrative",
  };
}

function partitionBeatList(beats: readonly SemanticBeat[], targetCount: number): SemanticBeat[] {
  if (targetCount >= beats.length) return [...beats];
  const baseSize = Math.floor(beats.length / targetCount);
  const remainder = beats.length % targetCount;
  const groups: SemanticBeat[] = [];
  let cursor = 0;
  for (let index = 0; index < targetCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    groups.push(combineBeats(beats.slice(cursor, cursor + size)));
    cursor += size;
  }
  return groups;
}

function expandBeatList(plan: RowSemanticPlan, targetCount: number): SemanticBeat[] {
  if (targetCount <= plan.detectedBeats.length) return partitionBeatList(plan.detectedBeats, targetCount);
  const row = plan.row;
  const base = plan.detectedBeats.map((beat) => beat.text).join("；随后：");
  const first = conciseFrameAnchor(row.firstFramePrompt, base);
  const end = conciseFrameAnchor(row.endFramePrompt, base);
  const phaseLabels = ["起势定格", "动作建立", "动作推进", "关键变化", "结果显现", "落点定格"];
  return Array.from({ length: targetCount }, (_, index) => {
    const isFirst = index === 0;
    const isLast = index === targetCount - 1;
    const label = isFirst ? phaseLabels[0]! : isLast ? phaseLabels.at(-1)! : phaseLabels[Math.min(index, phaseLabels.length - 2)]!;
    const text = `${label}：${isFirst ? first : isLast ? end : base}`;
    return {
      text,
      detectedBeatIndexes: isFirst || isLast ? [] : plan.detectedBeats.flatMap((beat) => beat.detectedBeatIndexes),
      detectedBeatCount: plan.detectedBeats.length,
      kind: "synthesized-phase",
    };
  });
}

function automaticPanelCount(plans: readonly RowSemanticPlan[]): number {
  const detectedBeatCount = plans.reduce((sum, plan) => sum + plan.detectedBeats.length, 0);
  return Math.max(MIN_PANEL_COUNT, Math.min(MAX_PANEL_COUNT, detectedBeatCount));
}

function allocateSplitCounts(plans: readonly RowSemanticPlan[], panelCount: number): number[] {
  const counts = plans.map(() => 1);
  while (counts.reduce((sum, count) => sum + count, 0) < panelCount) {
    const candidates = plans.map((plan, index) => ({
      index,
      remainingDetected: Math.max(0, plan.detectedBeats.length - counts[index]!),
      secondsPerPanel: (plan.endSeconds - plan.startSeconds) / counts[index]!,
    }));
    candidates.sort((left, right) => right.remainingDetected - left.remainingDetected
      || right.secondsPerPanel - left.secondsPerPanel
      || left.index - right.index);
    const selected = candidates[0];
    if (!selected) throw new FusionStoryboardGridValidationError("无法分配剧情节拍宫格");
    counts[selected.index] = counts[selected.index]! + 1;
  }
  return counts;
}

function wholeRowFragment(plan: RowSemanticPlan): PanelFragment {
  return {
    row: plan.row,
    startSeconds: plan.startSeconds,
    endSeconds: plan.endSeconds,
    splitIndex: 0,
    splitCount: 1,
    semanticBeat: combineBeats(plan.detectedBeats),
  };
}

function parsedChineseInteger(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.startsWith("十")) return 10 + (digits[value.slice(1)] ?? Number.NaN);
  if (value.endsWith("十")) return (digits[value.slice(0, -1)] ?? Number.NaN) * 10;
  const [tens, ones] = value.split("十");
  if (tens !== undefined && ones !== undefined) return (digits[tens] ?? Number.NaN) * 10 + (digits[ones] ?? Number.NaN);
  return digits[value];
}

function semanticSplitBoundaries(plan: RowSemanticPlan, beats: readonly SemanticBeat[]): number[] {
  const boundaries: Array<number | undefined> = Array.from({ length: beats.length + 1 });
  boundaries[0] = plan.startSeconds;
  boundaries[beats.length] = plan.endSeconds;
  const duration = plan.endSeconds - plan.startSeconds;
  for (let index = 1; index < beats.length; index += 1) {
    const marker = beats[index]!.text.match(/^第([零一二两三四五六七八九十\d]+)秒/u);
    const second = marker ? parsedChineseInteger(marker[1]!) : undefined;
    if (second === undefined || !Number.isFinite(second)) continue;
    const absolute = second > plan.startSeconds + EPSILON && second < plan.endSeconds - EPSILON
      ? second
      : second > EPSILON && second < duration - EPSILON
        ? plan.startSeconds + second
        : undefined;
    if (absolute !== undefined) boundaries[index] = absolute;
  }
  const fixedIndexes = boundaries.map((value, index) => value === undefined ? undefined : index).filter((value): value is number => value !== undefined);
  for (let fixed = 0; fixed < fixedIndexes.length - 1; fixed += 1) {
    const leftIndex = fixedIndexes[fixed]!;
    const rightIndex = fixedIndexes[fixed + 1]!;
    const left = boundaries[leftIndex]!;
    const right = boundaries[rightIndex]!;
    if (right <= left + EPSILON) {
      for (let index = leftIndex + 1; index < rightIndex; index += 1) boundaries[index] = undefined;
      continue;
    }
    for (let index = leftIndex + 1; index < rightIndex; index += 1) {
      boundaries[index] = left + ((right - left) * (index - leftIndex)) / (rightIndex - leftIndex);
    }
  }
  const result = boundaries.map((value) => roundTime(value ?? 0));
  if (result.some((value, index) => index > 0 && value <= result[index - 1]! + EPSILON)) {
    const step = duration / beats.length;
    return Array.from({ length: beats.length + 1 }, (_, index) => index === beats.length ? plan.endSeconds : roundTime(plan.startSeconds + step * index));
  }
  return result;
}

function partitionRows(plans: RowSemanticPlan[], panelCount: number): PanelFragment[][] {
  if (panelCount < plans.length) {
    const baseSize = Math.floor(plans.length / panelCount);
    const remainder = plans.length % panelCount;
    const groups: PanelFragment[][] = [];
    let cursor = 0;
    for (let index = 0; index < panelCount; index += 1) {
      const size = baseSize + (index < remainder ? 1 : 0);
      groups.push(plans.slice(cursor, cursor + size).map(wholeRowFragment));
      cursor += size;
    }
    return groups;
  }
  const splitCounts = allocateSplitCounts(plans, panelCount);
  return plans.flatMap((plan, rowIndex) => {
    const splitCount = splitCounts[rowIndex]!;
    const beats = expandBeatList(plan, splitCount);
    const boundaries = semanticSplitBoundaries(plan, beats);
    return beats.map((semanticBeat, splitIndex) => [{
      row: plan.row,
      startSeconds: boundaries[splitIndex]!,
      endSeconds: boundaries[splitIndex + 1]!,
      splitIndex,
      splitCount,
      semanticBeat,
    }]);
  });
}

function overlappingScheduleRows(schedule: FusionScheduleRow[], startSeconds: number, endSeconds: number): FusionScheduleRow[] {
  return schedule.filter((row) => row.startSeconds < endSeconds - EPSILON && row.endSeconds > startSeconds + EPSILON);
}

function frameRole(index: number, count: number): FusionStoryboardGridFrameRole {
  if (index === 0) return "start";
  if (index === count - 1) return "end";
  return "middle";
}

function compact(values: Array<string | undefined>, separator = "；"): string {
  const normalized = unique(values.map((value) => value?.trim() ?? "").filter(Boolean));
  return normalized.length ? normalized.join(separator) : "无";
}

function promptStyleEnvelope(row: StoryboardProductionContract): string[] {
  const prompt = row.firstFramePrompt.replace(/\s+/gu, " ").trim();
  const markerIndex = prompt.search(/(?:首帧画面|首帧定格)：/u);
  const style = trimTerminalPunctuation(markerIndex > 0 ? prompt.slice(0, markerIndex) : "电影级写实风格，中国神话史诗质感，商周时代考据，戏剧性自然光影，9:16竖屏");
  const technical = prompt.match(/(?:光线：|机位\/焦段\/运镜参考：)[\s\S]*?(?=参考素材编号：|禁止文字水印|禁止现代|避免错手|$)/u)?.[0]?.trim();
  const guardIndex = prompt.search(/禁止文字水印|禁止现代|禁止半面具|避免错手/u);
  const guards = guardIndex >= 0 ? prompt.slice(guardIndex).trim() : "";
  return unique([style, technical, guards].filter((value): value is string => Boolean(value)));
}

function panelVisualPrompt(fragments: PanelFragment[], role: FusionStoryboardGridFrameRole): string {
  const row = fragments.at(-1)!.row;
  const beatText = fragments.map((fragment) => fragment.semanticBeat.text).join("；接续：");
  const roleLabel = role === "start" ? "首格起势" : role === "end" ? "末格落点" : "中段关键定格";
  const envelopes = unique(fragments.flatMap((fragment) => promptStyleEnvelope(fragment.row)));
  const startSeconds = fragments[0]!.startSeconds;
  const endSeconds = fragments.at(-1)!.endSeconds;
  return `${envelopes.join("。")}。${row.shotSize}，${row.composition?.trim() || row.staging?.trim() || "稳定构图"}，${roleLabel}，对应 ${startSeconds.toFixed(1)}–${endSeconds.toFixed(1)} 秒，当前格只呈现这一组剧情节拍：${beatText}。${NO_TEXT_PROMPT}`;
}

function normalizedReferenceOverride(
  input: FusionStoryboardGridBuildInput,
  rowIds: readonly string[],
): FusionStoryboardGridReferenceOverride | undefined {
  const override = input.referenceOverride;
  if (!override) return undefined;
  if (override.expectedRevision !== input.storyboardRevision) {
    throw new FusionStoryboardGridValidationError(`连续性参考覆盖已与 storyboard 冲突（当前修订 ${input.storyboardRevision}）`);
  }
  const reason = override.reason.trim();
  const promptInstruction = override.promptInstruction.trim();
  if (reason.length < 3) throw new FusionStoryboardGridValidationError("连续性参考覆盖必须记录原因");
  if (promptInstruction.length < 3) throw new FusionStoryboardGridValidationError("连续性参考覆盖必须提供生图约束");
  const validRows = new Set(rowIds);
  const baseUnitAssets = new Set(Object.values(input.assetIdsByRowId ?? {}).flatMap((assetIds) => assetIds.map((assetId) => assetId.trim()).filter(Boolean)));
  const additionalEntries: Array<[string, string[]]> = Object.entries(override.additionalAssetIdsByRowId)
    .map(([rowId, assetIds]): [string, string[]] => {
      const normalizedRowId = rowId.trim();
      if (!validRows.has(normalizedRowId)) throw new FusionStoryboardGridValidationError(`连续性参考覆盖包含非本单元 row：${normalizedRowId}`);
      const normalizedAssets = unique(assetIds.map((assetId) => assetId.trim()).filter(Boolean)).sort();
      if (!normalizedAssets.length) throw new FusionStoryboardGridValidationError(`连续性参考覆盖 ${normalizedRowId} 没有资产`);
      const unknown = normalizedAssets.filter((assetId) => !baseUnitAssets.has(assetId));
      if (unknown.length) throw new FusionStoryboardGridValidationError(`连续性参考只能复用本单元已正式出现的资产：${unknown.join("、")}`);
      return [normalizedRowId, normalizedAssets];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const additionalAssetIdsByRowId: Record<string, string[]> = Object.fromEntries(additionalEntries);
  if (!Object.keys(additionalAssetIdsByRowId).length) throw new FusionStoryboardGridValidationError("连续性参考覆盖不能为空");
  return {
    expectedRevision: override.expectedRevision,
    reason,
    promptInstruction,
    additionalAssetIdsByRowId,
  };
}

function selectionReason(fragments: PanelFragment[], sourceRowCount: number, panelCount: number): string {
  if (fragments.length > 1) return `剧情节拍超过 ${panelCount} 格容量，透明合并 ${fragments.length} 个连续 storyboard rows`;
  const fragment = fragments[0]!;
  if (fragment.semanticBeat.kind === "continuity-extension") return "延展段固定为一格，只承接动作和环境，不新增剧情事件";
  if (fragment.semanticBeat.kind === "synthesized-phase") return `剧情节拍不足显式格数，按可核验首尾画面补足第 ${fragment.splitIndex + 1}/${fragment.splitCount} 阶段`;
  if (fragment.semanticBeat.detectedBeatIndexes.length > 1) return `受六格上限约束，透明合并语义节拍 ${fragment.semanticBeat.detectedBeatIndexes.join("+")}`;
  return `语义节拍 ${fragment.semanticBeat.detectedBeatIndexes[0] ?? fragment.splitIndex + 1}/${fragment.semanticBeat.detectedBeatCount} 独立成格`;
}

function gridLayout(panelCount: number): FusionStoryboardGridLayout {
  return {
    template: "portrait-storyboard-table",
    pageOrientation: "portrait",
    pageAspectRatio: "9:16",
    gridColumns: 1,
    gridRows: panelCount,
    headerPlacement: "top-full-width",
    footerPlacement: "bottom-full-width",
    panelCellModel: "image-left-details-columns",
    detailFieldOrder: ["imageContentAction", "shotComposition", "shootingMethod", "continuitySound", "dialogueSubtitle", "duration"],
  };
}

function panelPlacement(index: number, panelCount: number, layout: FusionStoryboardGridLayout, role: FusionStoryboardGridFrameRole): FusionStoryboardGridPanelLayout {
  void panelCount;
  void layout;
  return {
    row: index,
    column: 1,
    columnSpan: 1,
    readingOrder: index,
    imagePlacement: "left",
    detailPlacement: "right-table-columns",
    emphasis: role === "start" ? "start" : role === "end" ? "end" : "normal",
  };
}

export function buildFusionStoryboardGrid(input: FusionStoryboardGridBuildInput): FusionStoryboardGridContract {
  if (!Number.isInteger(input.storyboardRevision) || input.storyboardRevision < 1) {
    throw new FusionStoryboardGridValidationError("storyboardRevision 必须是正整数");
  }
  const unitId = input.unit.unitId.trim();
  const title = input.unit.title.trim();
  if (!unitId || !title) throw new FusionStoryboardGridValidationError("宫格分镜必须提供单元 ID 和标题");
  const standardDurationSeconds = input.unit.standardDurationSeconds ?? STANDARD_DURATION_SECONDS;
  if (Math.abs(standardDurationSeconds - STANDARD_DURATION_SECONDS) > EPSILON) {
    throw new FusionStoryboardGridValidationError("当前宫格分镜合同仅支持严格 15 秒单元");
  }
  const schedule = validateSchedule(input.schedule, standardDurationSeconds);
  const windows = buildRowWindows(input.rows, unitId, standardDurationSeconds);
  const referenceOverride = normalizedReferenceOverride(input, windows.map((window) => window.row.storyboardRowId));
  const semanticPlans = windows.map(detectSemanticBeats);
  const detectedBeatCount = semanticPlans.reduce((sum, plan) => sum + plan.detectedBeats.length, 0);
  const override = input.override;
  if (override) {
    assertPanelCount(override.panelCount);
    if (override.expectedRevision !== input.storyboardRevision) {
      throw new FusionStoryboardGridValidationError(`宫格数覆盖已与 storyboard 冲突（当前修订 ${input.storyboardRevision}）`);
    }
    if (!override.reason.trim()) throw new FusionStoryboardGridValidationError("显式宫格数覆盖必须记录原因");
  }
  const panelCount = override?.panelCount ?? automaticPanelCount(semanticPlans);
  assertPanelCount(panelCount);
  const groups = partitionRows(semanticPlans, panelCount);
  if (groups.length !== panelCount || groups.some((group) => group.length === 0)) {
    throw new FusionStoryboardGridValidationError("宫格分镜内部分组失败");
  }
  const layout = gridLayout(panelCount);
  const panels: FusionStoryboardGridPanel[] = groups.map((fragments, zeroBasedIndex) => {
    const index = zeroBasedIndex + 1;
    const role = frameRole(zeroBasedIndex, groups.length);
    const startSeconds = fragments[0]!.startSeconds;
    const endSeconds = fragments.at(-1)!.endSeconds;
    const rows = fragments.map((fragment) => fragment.row);
    const scheduleRows = overlappingScheduleRows(schedule, startSeconds, endSeconds);
    const storyboardRowIds = unique(rows.map((row) => row.storyboardRowId));
    const baseAssetIds = unique(storyboardRowIds.flatMap((rowId) => [...(input.assetIdsByRowId?.[rowId] ?? [])].map((assetId) => assetId.trim()).filter(Boolean))).sort();
    const continuityReferenceAssetIds = unique(storyboardRowIds.flatMap((rowId) => referenceOverride?.additionalAssetIdsByRowId[rowId] ?? [])).filter((assetId) => !baseAssetIds.includes(assetId)).sort();
    const assetIds = unique([...baseAssetIds, ...continuityReferenceAssetIds]).sort();
    // 宫格几何与供应商引用槽解耦：这里保留完整语义集合，即使超过 6 项。
    // PanelReferenceResolution 会把它们显式映射到不超过 6 个直接/派生槽；
    // 在解析完成前生成入口保持失败关闭。
    const imageContentAction = compact(fragments.flatMap((fragment) => [
      fragment.semanticBeat.text,
      fragment.row.expression ? `表情：${fragment.row.expression}` : undefined,
      fragment.row.emotion ? `情绪：${fragment.row.emotion}` : undefined,
    ]));
    const shotComposition = compact(rows.map((row) => compact([row.shotSize, row.composition, row.staging], " / ")));
    const shootingMethod = compact(rows.map((row) => compact([row.cameraMovement, row.cameraAngle, row.lens], " / ")));
    const continuitySound = compact(rows.flatMap((row) => [
      row.continuityBefore ? `前承：${row.continuityBefore}` : undefined,
      row.continuityAfter ? `后接：${row.continuityAfter}` : undefined,
      row.ambience ? `环境：${row.ambience}` : undefined,
      ...(row.soundEffects ?? []).map((sound) => `音效：${sound}`),
      ...(continuityReferenceAssetIds.length && referenceOverride
        ? [`连续性参考：${continuityReferenceAssetIds.join("、")}；${referenceOverride.promptInstruction}`]
        : []),
    ]));
    const dialogueSubtitle = compact(rows.flatMap((row) => [
      row.dialogue ? `台词：${row.dialogue}` : undefined,
      row.narration ? `旁白/字幕：${row.narration}` : undefined,
    ]));
    const durationSeconds = roundTime(endSeconds - startSeconds);
    const durationLabel = fusionStoryboardPanelDisplayTiming(startSeconds, endSeconds).fullLabel;
    const tableFields: FusionStoryboardGridTableField[] = [
      { key: "imageContentAction", label: "画面内容/动作", value: imageContentAction },
      { key: "shotComposition", label: "景别/构图", value: shotComposition },
      { key: "shootingMethod", label: "拍摄方式", value: shootingMethod },
      { key: "continuitySound", label: "连续性/声音", value: continuitySound },
      { key: "dialogueSubtitle", label: "台词/字幕", value: dialogueSubtitle },
      { key: "duration", label: "时长", value: durationLabel },
    ];
    return {
      id: `${unitId}-panel-${String(index).padStart(2, "0")}`,
      index,
      frameRole: role,
      startSeconds,
      endSeconds,
      durationSeconds,
      durationLabel,
      storyboardRowIds,
      storyboardRowRevisions: rows.map((row) => row.storyboardRowRevision),
      sourceShotItemIds: unique(rows.map((row) => row.shotItemId ?? "")),
      sourceShotNumbers: [...new Set(scheduleRows.map((row) => row.sourceShotNumber).filter((value): value is number => value !== undefined))],
      scheduleRowIndexes: scheduleRows.map((row) => row.index),
      scheduleRowIds: scheduleRows.map((row) => `${unitId}:schedule:${row.index}`),
      assetIds,
      continuityReferenceAssetIds,
      semanticBeats: fragments.map((fragment) => ({
        storyboardRowId: fragment.row.storyboardRowId,
        detectedBeatIndexes: fragment.semanticBeat.detectedBeatIndexes,
        detectedBeatCount: fragment.semanticBeat.detectedBeatCount,
        kind: fragment.semanticBeat.kind,
        text: fragment.semanticBeat.text,
      })),
      imageContentAction,
      shotComposition,
      shootingMethod,
      continuitySound,
      dialogueSubtitle,
      imageGenerationPrompt: `${panelVisualPrompt(fragments, role)}${continuityReferenceAssetIds.length && referenceOverride
        ? ` 连续性参考硬约束（${continuityReferenceAssetIds.join("、")}）：${referenceOverride.promptInstruction}。这些参考只用于保持前后身份与道具一致；当前剧情和构图未明确展示时不得强行入画。`
        : ""}`,
      selectionReason: selectionReason(fragments, windows.length, panelCount),
      tableFields,
      layout: panelPlacement(index, panelCount, layout, role),
    };
  });

  const coveredRows = unique(panels.flatMap((panel) => panel.storyboardRowIds));
  const expectedRows = windows.map((window) => window.row.storyboardRowId);
  const coveredSchedule = [...new Set(panels.flatMap((panel) => panel.scheduleRowIndexes))].sort((left, right) => left - right);
  const expectedSchedule = schedule.map((row) => row.index).sort((left, right) => left - right);
  if (JSON.stringify([...coveredRows].sort()) !== JSON.stringify([...expectedRows].sort())) {
    throw new FusionStoryboardGridValidationError("宫格分组未完整覆盖所有 storyboard rows");
  }
  if (JSON.stringify(coveredSchedule) !== JSON.stringify(expectedSchedule)) {
    throw new FusionStoryboardGridValidationError("宫格分组未完整覆盖所有融合排期秒段");
  }
  const rowUseCounts = new Map(expectedRows.map((rowId) => [rowId, panels.filter((panel) => panel.storyboardRowIds.includes(rowId)).length]));
  const groupedPanelIds = panels.filter((panel) => panel.storyboardRowIds.length > 1).map((panel) => panel.id);
  const splitStoryboardRowIds = [...rowUseCounts].filter(([, count]) => count > 1).map(([rowId]) => rowId);
  const rowPlans = semanticPlans.map((plan) => {
    const allocatedPanelCount = rowUseCounts.get(plan.row.storyboardRowId) ?? 0;
    const reason = plan.detectedBeats[0]?.kind === "continuity-extension"
      ? "通用延展段固定为一格，不伪造新剧情节拍"
      : allocatedPanelCount < plan.detectedBeats.length
        ? `检测 ${plan.detectedBeats.length} 个剧情节拍，受六格上限约束连续归并为 ${allocatedPanelCount} 格`
        : allocatedPanelCount === plan.detectedBeats.length
          ? `检测 ${plan.detectedBeats.length} 个剧情节拍，逐节拍独立成格`
          : `检测 ${plan.detectedBeats.length} 个剧情节拍，按首尾画面补足为 ${allocatedPanelCount} 个可核验阶段`;
    return {
      storyboardRowId: plan.row.storyboardRowId,
      durationSeconds: roundTime(plan.endSeconds - plan.startSeconds),
      detectedBeatCount: plan.detectedBeats.length,
      detectedBeats: plan.detectedBeats.map((beat) => beat.text),
      allocatedPanelCount,
      reason,
    };
  });
  const sourceFingerprint = sha256({
    storyboardRevision: input.storyboardRevision,
    rows: windows.map(({ row }) => row),
    schedule,
    assetIdsByRowId: input.assetIdsByRowId ?? {},
    referenceOverride,
  });
  const selectionMode: FusionStoryboardGridSelectionMode = override ? "explicit-override" : "automatic";
  const selectionReasonText = override
    ? `根据显式覆盖生成 ${panelCount} 格：${override.reason.trim()}`
    : detectedBeatCount < MIN_PANEL_COUNT
      ? `剧情语义只检测到 ${detectedBeatCount} 个可画节拍，按首尾画面补足为 2 格`
      : detectedBeatCount > MAX_PANEL_COUNT
        ? `剧情语义检测到 ${detectedBeatCount} 个可画节拍，超过上限后按连续性透明归并为 6 格`
        : `剧情语义检测到 ${detectedBeatCount} 个可画节拍，自动采用 ${panelCount} 格`;
  const normalizedUnit = { ...input.unit, unitId, title, standardDurationSeconds };
  const contractPayload = {
    algorithmVersion: FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION,
    visibleTimePolicyVersion: FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION,
    sourceFingerprint,
    normalizedUnit,
    panelCount,
    panels,
    selectionMode,
    rowPlans,
    overrideReason: override?.reason.trim(),
    referenceOverride,
  };
  const productionFingerprint = sha256({
    sourceFingerprint,
    unitId,
    panelCount,
    panels: panels.map((panel) => ({
      id: panel.id,
      index: panel.index,
      frameRole: panel.frameRole,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      storyboardRowIds: panel.storyboardRowIds,
      storyboardRowRevisions: panel.storyboardRowRevisions,
      sourceShotItemIds: panel.sourceShotItemIds,
      sourceShotNumbers: panel.sourceShotNumbers,
      scheduleRowIndexes: panel.scheduleRowIndexes,
      scheduleRowIds: panel.scheduleRowIds,
      assetIds: panel.assetIds,
      continuityReferenceAssetIds: panel.continuityReferenceAssetIds,
      imageGenerationPrompt: panel.imageGenerationPrompt,
    })),
  });
  return {
    schemaVersion: 1,
    kind: "fusion-storyboard-grid-contract",
    contractId: `grid-${sha256(contractPayload).slice(0, 20)}`,
    sourceStoryboardRevision: input.storyboardRevision,
    sourceFingerprint,
    productionFingerprint,
    displayTiming: {
      policyVersion: FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION,
      decimals: 1,
      durationDerivedFromDisplayedBoundaries: true,
      totalVisibleDurationSeconds: 15,
    },
    unit: normalizedUnit,
    header: {
      title: `15秒分镜故事板·${title}`,
      subtitle: compact([input.unit.episodeLabel, unitId, input.unit.storyGoal], " | "),
      metadataLine: `${panelCount}格 | ${standardDurationSeconds.toFixed(1)}s | ${input.unit.aspectRatio ?? "9:16"} | storyboard r${input.storyboardRevision}`,
    },
    selection: {
      mode: selectionMode,
      algorithmVersion: FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION,
      panelCount,
      sourceRowCount: windows.length,
      detectedBeatCount,
      cappedByMaximum: !override && detectedBeatCount > MAX_PANEL_COUNT,
      reason: selectionReasonText,
      ...(override ? { overrideReason: override.reason.trim() } : {}),
      rowPlans,
    },
    ...(referenceOverride ? { referenceOverride } : {}),
    panels,
    layout,
    footer: {
      rhythmChain: panels.map((panel) => ({
        panelId: panel.id,
        frameRole: panel.frameRole,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        label: `${panel.index}. ${panel.imageContentAction.slice(0, 40)}`,
      })),
      summary: panels.map((panel) => `${panel.startSeconds.toFixed(1)}-${panel.endSeconds.toFixed(1)}s ${panel.imageContentAction.slice(0, 24)}`).join(" → "),
    },
    coverage: {
      allStoryboardRowsCovered: true,
      storyboardRowIds: expectedRows,
      groupedPanelIds,
      splitStoryboardRowIds,
      allScheduleRowsCovered: true,
      scheduleRowIndexes: expectedSchedule,
    },
    localRendering: {
      engine: "svg-sharp",
      language: "zh-CN",
      textRendering: "local-only",
      panelImageMode: "one-image-per-panel",
      assetReferenceMode: "one-image-per-asset",
      aiImageContainsText: false,
      fontFallbacks: ["PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", "sans-serif"],
      outputArtifacts: ["panel-images", "storyboard-svg", "storyboard-png"],
      outputInstructions: [
        "每格先单独生成一张无文字纯画面，不让生图模型绘制中文表格。",
        "资产参考图继续保持一图一资产，不把多个资产预先拼成一张参考图。",
        "再由本地 SVG 按 panel.layout 排布画面和 tableFields，使用中文字体回退链。",
        "最后用 Sharp 将 SVG 渲染为竖版 PNG，保留顶部单元元数据和底部节奏链。",
      ],
      negativePrompt: NO_TEXT_PROMPT,
    },
  };
}
