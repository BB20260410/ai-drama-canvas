import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadSharpDefault } from "./sharp-lazy.js";
import { FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION, FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION, fusionStoryboardPanelDisplayTiming } from "./fusion-storyboard-grid.js";
import type { FusionStoryboardGridContract, FusionStoryboardGridPanel, FusionStoryboardGridTableField } from "./fusion-storyboard-grid.js";

const PAGE_WIDTH = 2_160;
const BASE_PAGE_HEIGHT = 3_840;
const DEFAULT_MAXIMUM_PAGE_HEIGHT = 32_000;
const MINIMUM_HEADER_HEIGHT = 330;
const COLUMN_HEADER_HEIGHT = 105;
const MINIMUM_FOOTER_HEIGHT = 210;
const IMAGE_COLUMN_WIDTH = 570;
const FIELD_COLUMNS = [
  { key: "imageContentAction", label: "画面内容 / 动作", width: 330 },
  { key: "shotComposition", label: "景别 / 构图", width: 285 },
  { key: "shootingMethod", label: "拍摄方式", width: 250 },
  { key: "continuitySound", label: "连续性 / 声音", width: 290 },
  { key: "dialogueSubtitle", label: "台词 / 字幕", width: 285 },
] as const satisfies ReadonlyArray<{ key: Exclude<FusionStoryboardGridTableField["key"], "duration">; label: string; width: number }>;
const TIME_COLUMN_WIDTH = PAGE_WIDTH - IMAGE_COLUMN_WIDTH - FIELD_COLUMNS.reduce((sum, column) => sum + column.width, 0);
const EPSILON = 0.001;

export const FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION = "fusion-storyboard-sheet-render-policy-v2" as const;

export interface FusionStoryboardSheetNormalizedPoint {
  x: number;
  y: number;
}

export interface FusionStoryboardSheetNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FusionStoryboardSheetPanelImageTransform =
  | { fit?: "contain"; focalPoint?: never; rect?: never }
  | { fit: "crop"; focalPoint: FusionStoryboardSheetNormalizedPoint; rect?: never }
  | { fit: "crop"; focalPoint?: never; rect: FusionStoryboardSheetNormalizedRect };

export interface FusionStoryboardSheetPanelImageInput {
  panelId: string;
  path: string;
  expectedSha256: string;
  /**
   * 缺省必须完整 contain。任何 crop 都必须显式给出归一化焦点或归一化矩形，
   * 且实际像素裁切会写入 render result 与 SVG metadata。
   */
  imageTransform?: FusionStoryboardSheetPanelImageTransform;
}

export type FusionStoryboardSheetRenderPurpose = "formal" | "layout-preview";

export interface FusionStoryboardSheetRenderPolicyInput {
  overflowPolicy?: "long-sheet";
  maximumPageHeight?: number;
}

export interface RenderFusionStoryboardSheetInput {
  contract: FusionStoryboardGridContract;
  panelImages: readonly FusionStoryboardSheetPanelImageInput[];
  outputPath: string;
  svgOutputPath?: string;
  /**
   * @deprecated 新调用应使用 renderFusionStoryboardSheetV2 并显式提供用途。
   * 这里保留可选字段只为兼容既有调用；缺省仍按历史 formal 行为处理。
   */
  renderPurpose?: FusionStoryboardSheetRenderPurpose;
  renderPolicy?: FusionStoryboardSheetRenderPolicyInput;
}

export interface RenderFusionStoryboardSheetV2Input extends Omit<RenderFusionStoryboardSheetInput, "renderPurpose"> {
  renderPurpose: FusionStoryboardSheetRenderPurpose;
}

export interface FusionStoryboardSheetArtifact {
  path: string;
  sha256: string;
  bytes: number;
  status: "created" | "existing";
}

export interface FusionStoryboardSheetPanelEvidence {
  panelId: string;
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
}

export interface FusionStoryboardSheetResolvedRenderPolicy {
  policyVersion: typeof FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION;
  renderer: "svg-sharp-v2";
  locale: "zh-CN";
  defaultImageFit: "contain";
  textMeasurement: "deterministic-character-units-v2";
  overflowPolicy: "long-sheet";
  rowHeightPolicy: "dynamic-content-measured";
  silentTruncation: false;
  pageWidth: typeof PAGE_WIDTH;
  basePageHeight: typeof BASE_PAGE_HEIGHT;
  maximumPageHeight: number;
}

export interface FusionStoryboardSheetPixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FusionStoryboardSheetPanelCropAudit {
  panelId: string;
  fit: "contain" | "crop";
  geometry: "none" | "focal-point" | "rect";
  focalPoint?: FusionStoryboardSheetNormalizedPoint;
  requestedRect?: FusionStoryboardSheetNormalizedRect;
  appliedRect?: FusionStoryboardSheetNormalizedRect;
  appliedPixelRect?: FusionStoryboardSheetPixelRect;
  sourceWidth: number;
  sourceHeight: number;
  orientedWidth: number;
  orientedHeight: number;
  targetWidth: number;
  targetHeight: number;
  cropApplied: boolean;
}

export interface FusionStoryboardSheetTextFieldAudit {
  panelId: string;
  field: Exclude<FusionStoryboardGridTableField["key"], "duration">;
  contentSha256: string;
  lineCount: number;
  requiredHeight: number;
  allocatedHeight: number;
  complete: true;
}

export interface FusionStoryboardSheetRowLayoutAudit {
  panelId: string;
  top: number;
  height: number;
  textFields: FusionStoryboardSheetTextFieldAudit[];
}

export interface FusionStoryboardSheetOverflowReport {
  policy: "long-sheet";
  basePageHeight: typeof BASE_PAGE_HEIGHT;
  actualPageHeight: number;
  expanded: boolean;
  overflowPixels: number;
  allRequiredTextVisible: true;
  silentTruncation: false;
  truncatedFields: [];
  rows: FusionStoryboardSheetRowLayoutAudit[];
}

export interface FusionStoryboardSheetPageResult {
  pageIndex: number;
  width: number;
  height: number;
  png: FusionStoryboardSheetArtifact;
  svg: FusionStoryboardSheetArtifact;
}

export interface FusionStoryboardSheetRenderInputAudit {
  contractSha256: string;
  panelInputsSha256: string;
  renderFingerprint: string;
}

export interface FusionStoryboardSheetRenderResult {
  schemaVersion: 2;
  kind: "fusion-storyboard-sheet-render";
  contractId: string;
  sourceFingerprint: string;
  renderFingerprint: string;
  inputAudit: FusionStoryboardSheetRenderInputAudit;
  renderPolicy: FusionStoryboardSheetResolvedRenderPolicy;
  overflowReport: FusionStoryboardSheetOverflowReport;
  cropAudit: FusionStoryboardSheetPanelCropAudit[];
  width: typeof PAGE_WIDTH;
  height: number;
  pageCount: number;
  pages: FusionStoryboardSheetPageResult[];
  panelCount: number;
  durationSeconds: 15;
  renderPurpose: FusionStoryboardSheetRenderPurpose;
  formalProductionEligible: boolean;
  reused: boolean;
  /** 单页 long-sheet 的向后兼容别名。 */
  png: FusionStoryboardSheetArtifact;
  /** 单页 long-sheet 的向后兼容别名。 */
  svg: FusionStoryboardSheetArtifact;
  panelImages: FusionStoryboardSheetPanelEvidence[];
}

interface LoadedPanelImage extends FusionStoryboardSheetPanelEvidence {
  bytesBuffer: Buffer;
  transform: ResolvedPanelImageTransform;
}

type ResolvedPanelImageTransform =
  | { fit: "contain" }
  | { fit: "crop"; focalPoint: FusionStoryboardSheetNormalizedPoint }
  | { fit: "crop"; rect: FusionStoryboardSheetNormalizedRect };

interface TextLayout {
  lines: string[];
  lineHeight: number;
  padding: number;
  requiredHeight: number;
}

interface PanelTextLayouts {
  panelId: string;
  layouts: Map<Exclude<FusionStoryboardGridTableField["key"], "duration">, TextLayout>;
  trace: TextLayout;
}

interface RowBounds {
  top: number;
  height: number;
}

interface SheetLayout {
  headerHeight: number;
  footerHeight: number;
  pageHeight: number;
  rows: RowBounds[];
  panelTextLayouts: PanelTextLayouts[];
  title: TextLayout;
  subtitle: TextLayout;
  metadataLine: TextLayout;
  footerSummary: TextLayout;
  footerIdentity: TextLayout;
  overflowReport: FusionStoryboardSheetOverflowReport;
}

interface NormalizedPanelImage {
  dataUri: string;
  cropAudit: FusionStoryboardSheetPanelCropAudit;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${label} 必须是完整 SHA-256。`);
  return normalized;
}

function assertAbsoluteFilePath(value: string, label: string): string {
  if (!value.trim() || !path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径。`);
  return path.normalize(value);
}

function assertNormalizedCoordinate(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} 必须是 0–1 的归一化数值。`);
  return value;
}

function resolvePanelImageTransform(input: FusionStoryboardSheetPanelImageInput): ResolvedPanelImageTransform {
  const transform = input.imageTransform;
  if (!transform || transform.fit === undefined || transform.fit === "contain") {
    if (transform && ("focalPoint" in transform || "rect" in transform)) throw new Error(`panel ${input.panelId} 的 contain 模式禁止携带裁切几何。`);
    return { fit: "contain" };
  }
  if (transform.fit !== "crop") throw new Error(`panel ${input.panelId} 的图片适配只允许 contain 或 crop。`);
  const hasFocalPoint = transform.focalPoint !== undefined;
  const hasRect = transform.rect !== undefined;
  if (hasFocalPoint === hasRect) throw new Error(`panel ${input.panelId} 的 crop 必须且只能提供 focalPoint 或 rect。`);
  if (transform.focalPoint) {
    return {
      fit: "crop",
      focalPoint: {
        x: assertNormalizedCoordinate(transform.focalPoint.x, `panel ${input.panelId} focalPoint.x`),
        y: assertNormalizedCoordinate(transform.focalPoint.y, `panel ${input.panelId} focalPoint.y`),
      },
    };
  }
  const rect = transform.rect!;
  const normalized = {
    x: assertNormalizedCoordinate(rect.x, `panel ${input.panelId} rect.x`),
    y: assertNormalizedCoordinate(rect.y, `panel ${input.panelId} rect.y`),
    width: assertNormalizedCoordinate(rect.width, `panel ${input.panelId} rect.width`),
    height: assertNormalizedCoordinate(rect.height, `panel ${input.panelId} rect.height`),
  };
  if (normalized.width <= 0 || normalized.height <= 0 || normalized.x + normalized.width > 1 + EPSILON || normalized.y + normalized.height > 1 + EPSILON) {
    throw new Error(`panel ${input.panelId} 的归一化 rect 必须具有正面积且完整位于源图内。`);
  }
  return { fit: "crop", rect: normalized };
}

function resolveRenderPolicy(input?: FusionStoryboardSheetRenderPolicyInput): FusionStoryboardSheetResolvedRenderPolicy {
  if (input?.overflowPolicy !== undefined && input.overflowPolicy !== "long-sheet") throw new Error("故事板 v2 overflowPolicy 只允许 long-sheet。 ");
  const maximumPageHeight = input?.maximumPageHeight ?? DEFAULT_MAXIMUM_PAGE_HEIGHT;
  if (!Number.isInteger(maximumPageHeight) || maximumPageHeight < BASE_PAGE_HEIGHT || maximumPageHeight > DEFAULT_MAXIMUM_PAGE_HEIGHT) {
    throw new Error(`故事板 maximumPageHeight 必须是 ${BASE_PAGE_HEIGHT}–${DEFAULT_MAXIMUM_PAGE_HEIGHT} 的整数。`);
  }
  return {
    policyVersion: FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
    renderer: "svg-sharp-v2",
    locale: "zh-CN",
    defaultImageFit: "contain",
    textMeasurement: "deterministic-character-units-v2",
    overflowPolicy: "long-sheet",
    rowHeightPolicy: "dynamic-content-measured",
    silentTruncation: false,
    pageWidth: PAGE_WIDTH,
    basePageHeight: BASE_PAGE_HEIGHT,
    maximumPageHeight,
  };
}

function roleLabel(role: FusionStoryboardGridPanel["frameRole"]): string {
  return role === "start" ? "首帧" : role === "end" ? "尾帧" : "";
}

function validateContract(contract: FusionStoryboardGridContract): FusionStoryboardGridPanel[] {
  if (contract.schemaVersion !== 1 || contract.kind !== "fusion-storyboard-grid-contract") throw new Error("分镜故事板合同版本无效。 ");
  if (!/^grid-[a-f0-9]{20}$/u.test(contract.contractId) || !/^[a-f0-9]{64}$/u.test(contract.sourceFingerprint)) throw new Error("分镜故事板合同身份无效。 ");
  if (Math.abs(contract.unit.standardDurationSeconds - 15) > EPSILON) throw new Error("本地故事板只接受严格 15 秒合同。 ");
  if (contract.localRendering.engine !== "svg-sharp"
    || contract.localRendering.textRendering !== "local-only"
    || contract.localRendering.panelImageMode !== "one-image-per-panel"
    || contract.localRendering.assetReferenceMode !== "one-image-per-asset"
    || contract.localRendering.aiImageContainsText !== false
    || !contract.localRendering.fontFallbacks.length) {
    throw new Error("分镜故事板必须声明 SVG/Sharp、本地中文和逐格纯画面策略。 ");
  }
  const panels = [...contract.panels].sort((left, right) => left.index - right.index);
  if (panels.length < 2 || panels.length > 6 || contract.selection.panelCount !== panels.length) throw new Error("分镜故事板必须包含 2–6 行。 ");
  if (contract.selection.algorithmVersion !== FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION
    || !Number.isInteger(contract.selection.detectedBeatCount)
    || contract.selection.detectedBeatCount < 1
    || contract.selection.rowPlans.length !== contract.selection.sourceRowCount) {
    throw new Error("分镜故事板缺少当前剧情节拍算法及逐 row 分配审计。 ");
  }
  if (contract.displayTiming?.policyVersion !== FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION
    || contract.displayTiming.decimals !== 1
    || contract.displayTiming.durationDerivedFromDisplayedBoundaries !== true
    || contract.displayTiming.totalVisibleDurationSeconds !== 15) {
    throw new Error("分镜故事板缺少当前可见时间量化策略。 ");
  }
  if (new Set(panels.map((panel) => panel.imageGenerationPrompt)).size !== panels.length) throw new Error("逐格生图提示词必须唯一。 ");
  if (contract.layout.pageOrientation !== "portrait" || contract.layout.pageAspectRatio !== "9:16"
    || contract.layout.gridColumns !== 1 || contract.layout.gridRows !== panels.length
    || contract.layout.panelCellModel !== "image-left-details-columns") {
    throw new Error("分镜故事板必须使用竖版左图右字段列布局。 ");
  }
  const expectedFieldOrder: FusionStoryboardGridTableField["key"][] = ["imageContentAction", "shotComposition", "shootingMethod", "continuitySound", "dialogueSubtitle", "duration"];
  if (JSON.stringify(contract.layout.detailFieldOrder) !== JSON.stringify(expectedFieldOrder)) throw new Error("分镜故事板字段顺序无效。 ");
  if (!contract.coverage.allStoryboardRowsCovered || !contract.coverage.allScheduleRowsCovered) throw new Error("分镜故事板没有完整覆盖正式分镜和 15 秒排期。 ");
  if (new Set(panels.map((panel) => panel.id)).size !== panels.length) throw new Error("分镜故事板 panel ID 不唯一。 ");
  let cursor = 0;
  panels.forEach((panel, zeroBased) => {
    const index = zeroBased + 1;
    const expectedRole = zeroBased === 0 ? "start" : zeroBased === panels.length - 1 ? "end" : "middle";
    if (panel.index !== index || panel.frameRole !== expectedRole) throw new Error(`第 ${index} 行的顺序或首尾帧角色无效。`);
    if (Math.abs(panel.startSeconds - cursor) > EPSILON || panel.endSeconds <= panel.startSeconds
      || Math.abs(panel.durationSeconds - (panel.endSeconds - panel.startSeconds)) > EPSILON) {
      throw new Error(`第 ${index} 行秒段不连续或时长无效。`);
    }
    if (panel.layout.row !== index || panel.layout.column !== 1 || panel.layout.readingOrder !== index
      || panel.layout.imagePlacement !== "left" || panel.layout.detailPlacement !== "right-table-columns") {
      throw new Error(`第 ${index} 行的本地排版位置无效。`);
    }
    if (panel.tableFields.length !== expectedFieldOrder.length
      || panel.tableFields.some((field, fieldIndex) => field.key !== expectedFieldOrder[fieldIndex])) {
      throw new Error(`第 ${index} 行的表格字段合同无效。`);
    }
    if (!panel.semanticBeats.length
      || panel.semanticBeats.some((beat) => !beat.storyboardRowId || !beat.text.trim())
      || panel.imageGenerationPrompt.includes("段内转折时刻")
      || panel.semanticBeats.some((beat) => !panel.imageGenerationPrompt.includes(beat.text))) {
      throw new Error(`第 ${index} 行缺少独立剧情节拍或提示词仍是机械占位。`);
    }
    const expectedValues: Record<FusionStoryboardGridTableField["key"], string> = {
      imageContentAction: panel.imageContentAction,
      shotComposition: panel.shotComposition,
      shootingMethod: panel.shootingMethod,
      continuitySound: panel.continuitySound,
      dialogueSubtitle: panel.dialogueSubtitle,
      duration: panel.durationLabel,
    };
    if (panel.durationLabel !== fusionStoryboardPanelDisplayTiming(panel.startSeconds, panel.endSeconds).fullLabel) {
      throw new Error(`第 ${index} 行的可见秒段与时长标签不一致。`);
    }
    if (panel.tableFields.some((field) => field.value !== expectedValues[field.key])) throw new Error(`第 ${index} 行字段快照与 panel 不一致。`);
    cursor = panel.endSeconds;
  });
  if (Math.abs(cursor - 15) > EPSILON) throw new Error(`分镜故事板行累计必须严格为 15 秒，当前为 ${cursor} 秒。`);
  if (contract.footer.rhythmChain.length !== panels.length
    || contract.footer.rhythmChain.some((entry, index) => entry.panelId !== panels[index]?.id)) {
    throw new Error("底部节奏链与分镜行不一致。 ");
  }
  return panels;
}

async function loadPanelImage(input: FusionStoryboardSheetPanelImageInput): Promise<LoadedPanelImage> {
  const filePath = assertAbsoluteFilePath(input.path, `panel ${input.panelId} 图片路径`);
  const expectedSha256 = normalizeSha256(input.expectedSha256, `panel ${input.panelId} expectedSha256`);
  const transform = resolvePanelImageTransform(input);
  const beforePath = await lstat(filePath).catch((error) => {
    throw new Error(`无法读取 panel ${input.panelId} 图片：${fileErrorCode(error) ?? String(error)}`);
  });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error(`panel ${input.panelId} 图片必须是非符号链接普通文件。`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow).catch((error) => {
    throw new Error(`无法安全打开 panel ${input.panelId} 图片：${fileErrorCode(error) ?? String(error)}`);
  });
  let content: Buffer;
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameFileIdentity(beforePath, openedBefore)) throw new Error(`panel ${input.panelId} 图片身份在打开前已漂移。`);
    content = await handle.readFile();
    const openedAfter = await handle.stat();
    const afterPath = await lstat(filePath);
    if (!sameFileIdentity(openedBefore, openedAfter) || !sameFileIdentity(openedAfter, afterPath)) throw new Error(`panel ${input.panelId} 图片在 SHA-256 校验期间发生漂移。`);
  } finally {
    await handle.close();
  }
  const digest = sha256(content);
  if (digest !== expectedSha256) throw new Error(`panel ${input.panelId} 图片 SHA-256 不一致。`);
  const metadata = await (await loadSharpDefault())(content, { failOn: "error" }).metadata().catch((error) => {
    throw new Error(`panel ${input.panelId} 图片无法解码：${error instanceof Error ? error.message : String(error)}`);
  });
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error(`panel ${input.panelId} 图片缺少有效尺寸或格式。`);
  return {
    panelId: input.panelId,
    path: filePath,
    sha256: digest,
    bytes: content.length,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    bytesBuffer: content,
    transform,
  };
}

function characterUnits(character: string): number {
  if (/^[\u0000-\u00ff]$/u.test(character)) return /[A-Za-z0-9]/u.test(character) ? 0.58 : 0.48;
  return 1;
}

function wrapLines(value: string, maximumUnits: number): string[] {
  const normalized = value.replace(/\r/gu, "").trim() || "无";
  const lines: string[] = [];
  let current = "";
  let currentUnits = 0;
  for (const character of normalized) {
    if (character === "\n") {
      lines.push(current.trimEnd() || " ");
      current = "";
      currentUnits = 0;
      continue;
    }
    const units = characterUnits(character);
    if (current && currentUnits + units > maximumUnits) {
      lines.push(current.trimEnd());
      current = character;
      currentUnits = units;
    } else {
      current += character;
      currentUnits += units;
    }
  }
  if (current || !lines.length) lines.push(current.trimEnd() || "无");
  return lines;
}

function measureText(value: string, width: number, fontSize: number, options: { padding?: number; lineHeight?: number } = {}): TextLayout {
  const padding = options.padding ?? 26;
  const lineHeight = options.lineHeight ?? Math.round(fontSize * 1.44);
  const maximumUnits = Math.max(2, (width - padding * 2) / fontSize);
  const lines = wrapLines(value, maximumUnits);
  return { lines, lineHeight, padding, requiredHeight: padding * 2 + lines.length * lineHeight };
}

function renderMeasuredText(options: {
  layout: TextLayout;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  weight?: number;
}): string {
  if (options.layout.requiredHeight > options.height) throw new Error(`文本完整排版需要 ${options.layout.requiredHeight}px，但仅分配 ${options.height}px；拒绝静默截断。`);
  const x = options.x + options.layout.padding;
  const firstBaseline = options.y + options.layout.padding + options.fontSize;
  const spans = options.layout.lines
    .map((line, index) => `<tspan x="${x}" y="${firstBaseline + index * options.layout.lineHeight}">${xml(line)}</tspan>`)
    .join("");
  return `<text fill="${options.color}" font-family="${options.fontFamily}" font-size="${options.fontSize}" font-weight="${options.weight ?? 500}">${spans}</text>`;
}

function bodyFontSize(panelCount: number): number {
  return panelCount <= 2 ? 43 : panelCount === 3 ? 40 : panelCount <= 5 ? 36 : 33;
}

function baseRowHeights(panelCount: number): number[] {
  const bodyHeight = BASE_PAGE_HEIGHT - MINIMUM_HEADER_HEIGHT - COLUMN_HEADER_HEIGHT - MINIMUM_FOOTER_HEIGHT;
  return Array.from({ length: panelCount }, (_, index) => {
    const top = Math.floor((index * bodyHeight) / panelCount);
    const bottom = Math.floor(((index + 1) * bodyHeight) / panelCount);
    return bottom - top;
  });
}

function buildSheetLayout(
  contract: FusionStoryboardGridContract,
  panels: FusionStoryboardGridPanel[],
  images: LoadedPanelImage[],
  policy: FusionStoryboardSheetResolvedRenderPolicy,
): SheetLayout {
  const bodyFont = bodyFontSize(panels.length);
  const title = measureText(contract.header.title, 1_560, 70, { padding: 0, lineHeight: 78 });
  const subtitle = measureText(contract.header.subtitle, 2_000, 32, { padding: 0, lineHeight: 44 });
  const metadataLine = measureText(contract.header.metadataLine, 2_000, 27, { padding: 0, lineHeight: 38 });
  const headerHeight = Math.max(MINIMUM_HEADER_HEIGHT, 48 + title.requiredHeight + 20 + subtitle.requiredHeight + 8 + metadataLine.requiredHeight + 28);
  const footerSummary = measureText(contract.footer.summary, 1_470, 28, { padding: 0, lineHeight: 38 });
  const footerIdentity = measureText(`${contract.contractId} · SHA256 ${contract.sourceFingerprint}`, 1_640, 20, { padding: 0, lineHeight: 28 });
  const footerHeight = Math.max(MINIMUM_FOOTER_HEIGHT, 36 + Math.max(48, footerSummary.requiredHeight) + 10 + footerIdentity.requiredHeight + 24);
  const minimumRows = baseRowHeights(panels.length);
  const panelTextLayouts = panels.map((panel, index) => {
    const fieldMap = new Map(panel.tableFields.map((field) => [field.key, field.value]));
    const layouts = new Map<Exclude<FusionStoryboardGridTableField["key"], "duration">, TextLayout>();
    for (const column of FIELD_COLUMNS) layouts.set(column.key, measureText(fieldMap.get(column.key) ?? "无", column.width, bodyFont));
    const trace = measureText(`${panel.assetIds.length ? `资产 ${panel.assetIds.join(" · ")}` : "资产 无"} · 图像 SHA256 ${images[index]!.sha256}`, IMAGE_COLUMN_WIDTH, 22, { padding: 18, lineHeight: 30 });
    return { panelId: panel.id, layouts, trace };
  });
  const rowHeights = panelTextLayouts.map((entry, index) => Math.max(
    minimumRows[index]!,
    190,
    entry.trace.requiredHeight + 112,
    ...[...entry.layouts.values()].map((layout) => layout.requiredHeight),
  ));
  const pageHeight = headerHeight + COLUMN_HEADER_HEIGHT + rowHeights.reduce((sum, height) => sum + height, 0) + footerHeight;
  if (pageHeight > policy.maximumPageHeight) {
    throw new Error(`正式中文分镜板完整排版需要 ${pageHeight}px，超过 long-sheet 上限 ${policy.maximumPageHeight}px；拒绝截断并失败关闭。`);
  }
  let top = headerHeight + COLUMN_HEADER_HEIGHT;
  const rows = rowHeights.map((height) => {
    const bounds = { top, height };
    top += height;
    return bounds;
  });
  const rowAudits = panels.map((panel, index): FusionStoryboardSheetRowLayoutAudit => {
    const allocatedHeight = rows[index]!.height;
    const entry = panelTextLayouts[index]!;
    return {
      panelId: panel.id,
      top: rows[index]!.top,
      height: allocatedHeight,
      textFields: FIELD_COLUMNS.map((column) => {
        const value = panel.tableFields.find((field) => field.key === column.key)?.value ?? "无";
        const measured = entry.layouts.get(column.key)!;
        return {
          panelId: panel.id,
          field: column.key,
          contentSha256: sha256(value),
          lineCount: measured.lines.length,
          requiredHeight: measured.requiredHeight,
          allocatedHeight,
          complete: true,
        };
      }),
    };
  });
  const overflowReport: FusionStoryboardSheetOverflowReport = {
    policy: "long-sheet",
    basePageHeight: BASE_PAGE_HEIGHT,
    actualPageHeight: pageHeight,
    expanded: pageHeight > BASE_PAGE_HEIGHT,
    overflowPixels: Math.max(0, pageHeight - BASE_PAGE_HEIGHT),
    allRequiredTextVisible: true,
    silentTruncation: false,
    truncatedFields: [],
    rows: rowAudits,
  };
  return { headerHeight, footerHeight, pageHeight, rows, panelTextLayouts, title, subtitle, metadataLine, footerSummary, footerIdentity, overflowReport };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedRectFromPixels(rect: FusionStoryboardSheetPixelRect, width: number, height: number): FusionStoryboardSheetNormalizedRect {
  return { x: rect.left / width, y: rect.top / height, width: rect.width / width, height: rect.height / height };
}

function focalCropRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number, focalPoint: FusionStoryboardSheetNormalizedPoint): FusionStoryboardSheetPixelRect {
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  let width = sourceWidth;
  let height = sourceHeight;
  if (sourceAspect > targetAspect) width = Math.max(1, Math.round(sourceHeight * targetAspect));
  else if (sourceAspect < targetAspect) height = Math.max(1, Math.round(sourceWidth / targetAspect));
  const left = clamp(Math.round(focalPoint.x * sourceWidth - width / 2), 0, sourceWidth - width);
  const top = clamp(Math.round(focalPoint.y * sourceHeight - height / 2), 0, sourceHeight - height);
  return { left, top, width, height };
}

function explicitCropRect(sourceWidth: number, sourceHeight: number, rect: FusionStoryboardSheetNormalizedRect): FusionStoryboardSheetPixelRect {
  const left = clamp(Math.floor(rect.x * sourceWidth), 0, sourceWidth - 1);
  const top = clamp(Math.floor(rect.y * sourceHeight), 0, sourceHeight - 1);
  const right = clamp(Math.ceil((rect.x + rect.width) * sourceWidth), left + 1, sourceWidth);
  const bottom = clamp(Math.ceil((rect.y + rect.height) * sourceHeight), top + 1, sourceHeight);
  return { left, top, width: right - left, height: bottom - top };
}

async function normalizedPanelData(image: LoadedPanelImage, bounds: RowBounds): Promise<NormalizedPanelImage> {
  const oriented = await (await loadSharpDefault())(image.bytesBuffer, { failOn: "error" }).rotate().toBuffer({ resolveWithObject: true });
  const orientedWidth = oriented.info.width;
  const orientedHeight = oriented.info.height;
  const background = { r: 16, g: 23, b: 17 };
  let buffer: Buffer;
  let audit: FusionStoryboardSheetPanelCropAudit;
  if (image.transform.fit === "contain") {
    buffer = await (await loadSharpDefault())(oriented.data, { failOn: "error" })
      .resize({ width: IMAGE_COLUMN_WIDTH, height: bounds.height, fit: "contain", background })
      .flatten({ background })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
    audit = {
      panelId: image.panelId,
      fit: "contain",
      geometry: "none",
      sourceWidth: image.width,
      sourceHeight: image.height,
      orientedWidth,
      orientedHeight,
      targetWidth: IMAGE_COLUMN_WIDTH,
      targetHeight: bounds.height,
      cropApplied: false,
    };
  } else {
    let geometry: "focal-point" | "rect";
    let focalPoint: FusionStoryboardSheetNormalizedPoint | undefined;
    let requestedRect: FusionStoryboardSheetNormalizedRect | undefined;
    let pixels: FusionStoryboardSheetPixelRect;
    if ("focalPoint" in image.transform) {
      geometry = "focal-point";
      focalPoint = image.transform.focalPoint;
      pixels = focalCropRect(orientedWidth, orientedHeight, IMAGE_COLUMN_WIDTH, bounds.height, focalPoint);
    } else {
      geometry = "rect";
      requestedRect = image.transform.rect;
      pixels = explicitCropRect(orientedWidth, orientedHeight, requestedRect);
    }
    let pipeline = (await loadSharpDefault())(oriented.data, { failOn: "error" }).extract(pixels);
    if (focalPoint) pipeline = pipeline.resize({ width: IMAGE_COLUMN_WIDTH, height: bounds.height, fit: "fill" });
    else pipeline = pipeline.resize({ width: IMAGE_COLUMN_WIDTH, height: bounds.height, fit: "contain", background });
    buffer = await pipeline
      .flatten({ background })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
    audit = {
      panelId: image.panelId,
      fit: "crop",
      geometry,
      ...(focalPoint ? { focalPoint } : { requestedRect: requestedRect! }),
      appliedRect: normalizedRectFromPixels(pixels, orientedWidth, orientedHeight),
      appliedPixelRect: pixels,
      sourceWidth: image.width,
      sourceHeight: image.height,
      orientedWidth,
      orientedHeight,
      targetWidth: IMAGE_COLUMN_WIDTH,
      targetHeight: bounds.height,
      cropApplied: true,
    };
  }
  return { dataUri: `data:image/jpeg;base64,${buffer.toString("base64")}`, cropAudit: audit };
}

function renderTraceText(layout: TextLayout, row: RowBounds, fontFamily: string): string {
  const traceHeight = layout.requiredHeight;
  const traceTop = row.top + row.height - traceHeight;
  return `<rect x="0" y="${traceTop}" width="${IMAGE_COLUMN_WIDTH}" height="${traceHeight}" fill="#061c32" opacity="0.9"/>${renderMeasuredText({
    layout,
    x: 0,
    y: traceTop,
    width: IMAGE_COLUMN_WIDTH,
    height: traceHeight,
    fontSize: 22,
    fontFamily,
    color: "#e7c86d",
    weight: 560,
  })}`;
}

async function renderSvg(
  contract: FusionStoryboardGridContract,
  panels: FusionStoryboardGridPanel[],
  images: LoadedPanelImage[],
  renderPurpose: FusionStoryboardSheetRenderPurpose,
  policy: FusionStoryboardSheetResolvedRenderPolicy,
  layout: SheetLayout,
  renderFingerprint: string,
): Promise<{ svg: Buffer; cropAudit: FusionStoryboardSheetPanelCropAudit[] }> {
  const isLayoutPreview = renderPurpose === "layout-preview";
  const fonts = xml(contract.localRendering.fontFallbacks.join(", "));
  const normalized = await Promise.all(images.map((image, index) => normalizedPanelData(image, layout.rows[index]!)));
  const bodyFont = bodyFontSize(panels.length);
  const columnHeaders = [
    { label: "画面", x: 0, width: IMAGE_COLUMN_WIDTH },
    ...FIELD_COLUMNS.reduce<Array<{ label: string; x: number; width: number }>>((items, column) => {
      const previous = items.at(-1);
      const x = previous ? previous.x + previous.width : IMAGE_COLUMN_WIDTH;
      items.push({ label: column.label, x, width: column.width });
      return items;
    }, []),
    { label: "时间", x: PAGE_WIDTH - TIME_COLUMN_WIDTH, width: TIME_COLUMN_WIDTH },
  ];
  const headerCells = columnHeaders.map((column) => `<rect x="${column.x}" y="${layout.headerHeight}" width="${column.width}" height="${COLUMN_HEADER_HEIGHT}" fill="#273b4b" stroke="#6f7b83" stroke-width="2"/><text x="${column.x + column.width / 2}" y="${layout.headerHeight + 66}" text-anchor="middle" fill="#f5f0e4" font-family="${fonts}" font-size="30" font-weight="650">${xml(column.label)}</text>`).join("");

  let rows = "";
  let fieldStart = IMAGE_COLUMN_WIDTH;
  const fieldX = new Map<string, number>();
  for (const column of FIELD_COLUMNS) {
    fieldX.set(column.key, fieldStart);
    fieldStart += column.width;
  }
  panels.forEach((panel, index) => {
    const row = layout.rows[index]!;
    const image = images[index]!;
    const fieldMap = new Map(panel.tableFields.map((field) => [field.key, field.value]));
    const textLayouts = layout.panelTextLayouts[index]!;
    const alternate = index % 2 === 0 ? "#f5f1e8" : "#ece8df";
    const role = roleLabel(panel.frameRole);
    const trace = `${panel.assetIds.length ? `资产 ${panel.assetIds.join(" · ")}` : "资产 无"} · 图像 SHA256 ${image.sha256}`;
    const traceLayout = measureText(trace, IMAGE_COLUMN_WIDTH, 22, { padding: 18, lineHeight: 30 });
    if (traceLayout.requiredHeight !== textLayouts.trace.requiredHeight) {
      throw new Error(`panel ${panel.id} 的图像 SHA 审计文本测量发生漂移。`);
    }
    rows += `<g id="${xml(panel.id)}">`;
    rows += `<rect x="0" y="${row.top}" width="${PAGE_WIDTH}" height="${row.height}" fill="${alternate}" stroke="#50606b" stroke-width="3"/>`;
    rows += `<image x="0" y="${row.top}" width="${IMAGE_COLUMN_WIDTH}" height="${row.height}" href="${normalized[index]!.dataUri}" preserveAspectRatio="xMidYMid meet"/>`;
    rows += `<rect x="0" y="${row.top}" width="${IMAGE_COLUMN_WIDTH}" height="${row.height}" fill="none" stroke="#344957" stroke-width="4"/>`;
    rows += `<circle cx="62" cy="${row.top + 62}" r="43" fill="#052d57" stroke="#d7ad4a" stroke-width="4"/><text x="62" y="${row.top + 75}" text-anchor="middle" fill="#ffffff" font-family="${fonts}" font-size="34" font-weight="750">${String(panel.index).padStart(2, "0")}</text>`;
    if (role) rows += `<rect x="${IMAGE_COLUMN_WIDTH - 156}" y="${row.top + 22}" width="132" height="64" rx="12" fill="${panel.frameRole === "start" ? "#d7ad4a" : "#4ba7b5"}"/><text x="${IMAGE_COLUMN_WIDTH - 90}" y="${row.top + 66}" text-anchor="middle" fill="#081d2d" font-family="${fonts}" font-size="30" font-weight="760">${role}</text>`;
    if (isLayoutPreview) {
      rows += `<rect x="92" y="${row.top + Math.max(105, row.height / 2 - 44)}" width="386" height="88" rx="18" fill="#7a1f1f" opacity="0.92" stroke="#f2d786" stroke-width="3"/><text x="285" y="${row.top + Math.max(105, row.height / 2 - 44) + 57}" text-anchor="middle" fill="#fff7df" font-family="${fonts}" font-size="31" font-weight="760">版式预览 · 非成片</text>`;
    }
    rows += renderTraceText(traceLayout, row, fonts);
    for (const column of FIELD_COLUMNS) {
      const x = fieldX.get(column.key)!;
      rows += `<rect x="${x}" y="${row.top}" width="${column.width}" height="${row.height}" fill="${alternate}" stroke="#7a858b" stroke-width="2"/>`;
      rows += renderMeasuredText({
        layout: textLayouts.layouts.get(column.key)!,
        x,
        y: row.top,
        width: column.width,
        height: row.height,
        fontSize: bodyFont,
        fontFamily: fonts,
        color: "#18242a",
        weight: 520,
      });
      if ((fieldMap.get(column.key) ?? "无") !== panel[column.key]) throw new Error(`panel ${panel.id} 的 ${column.key} 字段在渲染前发生漂移。`);
    }
    const timeX = PAGE_WIDTH - TIME_COLUMN_WIDTH;
    const visibleTiming = fusionStoryboardPanelDisplayTiming(panel.startSeconds, panel.endSeconds);
    rows += `<rect x="${timeX}" y="${row.top}" width="${TIME_COLUMN_WIDTH}" height="${row.height}" fill="#052d57" stroke="#657682" stroke-width="2"/>`;
    rows += `<text x="${timeX + TIME_COLUMN_WIDTH / 2}" y="${row.top + row.height / 2 - 18}" text-anchor="middle" fill="#ffffff" font-family="${fonts}" font-size="42" font-weight="760">${visibleTiming.durationLabel}</text>`;
    rows += `<text x="${timeX + TIME_COLUMN_WIDTH / 2}" y="${row.top + row.height / 2 + 36}" text-anchor="middle" fill="#bad1db" font-family="${fonts}" font-size="22" font-weight="520">${visibleTiming.rangeLabel}</text>`;
    rows += "</g>";
  });

  const footerTop = layout.pageHeight - layout.footerHeight;
  const metadata = xml(JSON.stringify({
    schemaVersion: 2,
    renderPurpose,
    formalProductionEligible: !isLayoutPreview,
    contractId: contract.contractId,
    sourceFingerprint: contract.sourceFingerprint,
    renderFingerprint,
    renderPolicy: policy,
    overflowReport: layout.overflowReport,
    cropAudit: normalized.map((entry) => entry.cropAudit),
    panelImages: images.map(({ panelId, sha256: digest }) => ({ panelId, sha256: digest })),
  }));
  const svg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${layout.pageHeight}" viewBox="0 0 ${PAGE_WIDTH} ${layout.pageHeight}">
  <title>${xml(contract.header.title)}</title>
  <desc>${isLayoutPreview ? "正式剧情合同的中文布局预览；逐格为非正式占位画面，不得计入生产。" : "中文由本地 SVG/Sharp 完整排版；逐格画面不含模型生成文字。"}</desc>
  <metadata>${metadata}</metadata>
  <rect width="${PAGE_WIDTH}" height="${layout.pageHeight}" fill="#f2eee5"/>
  <rect x="0" y="0" width="${PAGE_WIDTH}" height="${layout.headerHeight}" fill="#052d57"/>
  <rect x="0" y="${layout.headerHeight - 8}" width="${PAGE_WIDTH}" height="8" fill="#d7ad4a"/>
  ${renderMeasuredText({ layout: layout.title, x: 78, y: 48, width: 1_560, height: layout.title.requiredHeight, fontSize: 70, fontFamily: fonts, color: "#ffffff", weight: 760 })}
  ${renderMeasuredText({ layout: layout.subtitle, x: 80, y: 48 + layout.title.requiredHeight + 20, width: 2_000, height: layout.subtitle.requiredHeight, fontSize: 32, fontFamily: fonts, color: "#dce8ec", weight: 500 })}
  ${renderMeasuredText({ layout: layout.metadataLine, x: 80, y: 48 + layout.title.requiredHeight + 20 + layout.subtitle.requiredHeight + 8, width: 2_000, height: layout.metadataLine.requiredHeight, fontSize: 27, fontFamily: fonts, color: "#91b5c5", weight: 520 })}
  <rect x="1706" y="44" width="390" height="56" rx="28" fill="#0b466f" stroke="#d7ad4a" stroke-width="2"/>
  <text x="1901" y="82" text-anchor="middle" fill="#f2d786" font-family="${fonts}" font-size="24" font-weight="650">${isLayoutPreview ? "版式预览 · 不计入正式生产" : "中文本地排版 · AI 画面无字"}</text>
  ${headerCells}
  ${rows}
  <rect x="0" y="${footerTop}" width="${PAGE_WIDTH}" height="${layout.footerHeight}" fill="#052d57"/>
  <rect x="66" y="${footerTop + 36}" width="10" height="92" rx="5" fill="#d7ad4a"/>
  <text x="94" y="${footerTop + 75}" fill="#f2d786" font-family="${fonts}" font-size="34" font-weight="760">节奏链</text>
  ${renderMeasuredText({ layout: layout.footerSummary, x: 210, y: footerTop + 36, width: 1_470, height: layout.footerSummary.requiredHeight, fontSize: 28, fontFamily: fonts, color: "#f1f5f3", weight: 500 })}
  ${renderMeasuredText({ layout: layout.footerIdentity, x: 94, y: footerTop + 36 + Math.max(48, layout.footerSummary.requiredHeight) + 10, width: 1_640, height: layout.footerIdentity.requiredHeight, fontSize: 20, fontFamily: fonts, color: isLayoutPreview ? "#f0a7a7" : "#7899aa" })}
  <rect x="1802" y="${layout.pageHeight - 72}" width="294" height="44" rx="22" fill="#d7ad4a"/>
  <text x="1949" y="${layout.pageHeight - 41}" text-anchor="middle" fill="#09223a" font-family="${fonts}" font-size="23" font-weight="760">总时长 15.0s</text>
  ${isLayoutPreview ? `<text x="1802" y="${footerTop + 48}" fill="#f0a7a7" font-family="${fonts}" font-size="20">布局证据，不是正式图片</text>` : ""}
</svg>`);
  return { svg, cropAudit: normalized.map((entry) => entry.cropAudit) };
}

async function inspectExistingTarget(filePath: string, content: Buffer): Promise<"missing" | "existing"> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`输出目标不是非符号链接普通文件，拒绝使用：${filePath}`);
    const existing = await readFile(filePath);
    if (!existing.equals(content)) throw new Error(`故事板输出已存在但内容冲突，拒绝覆盖：${filePath}`);
    return "existing";
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

async function writeBufferExclusive(filePath: string, content: Buffer): Promise<"created" | "existing"> {
  const existing = await inspectExistingTarget(filePath, content);
  if (existing === "existing") return "existing";
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, filePath);
      return "created";
    } catch (error) {
      if (fileErrorCode(error) !== "EEXIST") throw error;
      if (await inspectExistingTarget(filePath, content) === "existing") return "existing";
      throw new Error(`故事板输出在并发发布期间消失，拒绝假定成功：${filePath}`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function renderFusionStoryboardSheetInternal(input: RenderFusionStoryboardSheetV2Input): Promise<FusionStoryboardSheetRenderResult> {
  const renderPurpose = input.renderPurpose;
  if (renderPurpose !== "formal" && renderPurpose !== "layout-preview") throw new Error("故事板 renderPurpose 必须是 formal 或 layout-preview。 ");
  const policy = resolveRenderPolicy(input.renderPolicy);
  const panels = validateContract(input.contract);
  const outputPath = assertAbsoluteFilePath(input.outputPath, "PNG 输出路径");
  if (path.extname(outputPath).toLowerCase() !== ".png") throw new Error("故事板 PNG 输出路径必须以 .png 结尾。 ");
  const svgOutputPath = assertAbsoluteFilePath(input.svgOutputPath ?? `${outputPath.slice(0, -4)}.svg`, "SVG 输出路径");
  if (path.extname(svgOutputPath).toLowerCase() !== ".svg") throw new Error("故事板 SVG 输出路径必须以 .svg 结尾。 ");
  if (outputPath === svgOutputPath) throw new Error("PNG 与 SVG 输出路径不能相同。 ");
  if (input.panelImages.length !== panels.length) throw new Error(`必须为 ${panels.length} 行逐格提供且只提供一张 panel 图片。`);
  const imageIds = new Set<string>();
  const imageByPanel = new Map<string, FusionStoryboardSheetPanelImageInput>();
  for (const image of input.panelImages) {
    if (!image.panelId.trim() || imageIds.has(image.panelId)) throw new Error(`panel 图片 ID 为空或重复：${image.panelId || "<empty>"}`);
    imageIds.add(image.panelId);
    imageByPanel.set(image.panelId, image);
  }
  const extras = [...imageIds].filter((panelId) => !panels.some((panel) => panel.id === panelId));
  if (extras.length) throw new Error(`存在合同外 panel 图片：${extras.join("、")}`);
  const orderedInputs = panels.map((panel) => {
    const image = imageByPanel.get(panel.id);
    if (!image) throw new Error(`缺少 panel 图片：${panel.id}`);
    return image;
  });
  const protectedPaths = new Set(orderedInputs.map((image) => assertAbsoluteFilePath(image.path, `panel ${image.panelId} 图片路径`)));
  if (protectedPaths.has(outputPath) || protectedPaths.has(svgOutputPath)) throw new Error("故事板输出路径不能覆盖任何逐格画面源文件。 ");
  const loaded = await Promise.all(orderedInputs.map(loadPanelImage));
  const layout = buildSheetLayout(input.contract, panels, loaded, policy);
  const contractSha256 = sha256(canonicalJson(input.contract));
  const panelInputsSha256 = sha256(canonicalJson(loaded.map((image) => ({ panelId: image.panelId, sha256: image.sha256, width: image.width, height: image.height, format: image.format, transform: image.transform }))));
  const renderFingerprint = sha256(canonicalJson({
    schemaVersion: 2,
    contractSha256,
    panelInputsSha256,
    renderPurpose,
    policy,
    layout: {
      headerHeight: layout.headerHeight,
      footerHeight: layout.footerHeight,
      pageHeight: layout.pageHeight,
      rows: layout.rows,
      overflowReport: layout.overflowReport,
    },
  }));
  const renderedSvg = await renderSvg(input.contract, panels, loaded, renderPurpose, policy, layout, renderFingerprint);
  const png = await (await loadSharpDefault())(renderedSvg.svg, { failOn: "error", limitInputPixels: 100_000_000 })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
  const pngMetadata = await (await loadSharpDefault())(png, { failOn: "error" }).metadata();
  if (pngMetadata.width !== PAGE_WIDTH || pngMetadata.height !== layout.pageHeight || pngMetadata.format !== "png") {
    throw new Error(`Sharp 生成的故事板尺寸或格式不符合 ${PAGE_WIDTH}×${layout.pageHeight} PNG 合同。`);
  }
  await Promise.all([inspectExistingTarget(outputPath, png), inspectExistingTarget(svgOutputPath, renderedSvg.svg)]);
  const [pngStatus, svgStatus] = await Promise.all([writeBufferExclusive(outputPath, png), writeBufferExclusive(svgOutputPath, renderedSvg.svg)]);
  const pngArtifact: FusionStoryboardSheetArtifact = { path: outputPath, sha256: sha256(png), bytes: png.length, status: pngStatus };
  const svgArtifact: FusionStoryboardSheetArtifact = { path: svgOutputPath, sha256: sha256(renderedSvg.svg), bytes: renderedSvg.svg.length, status: svgStatus };
  const inputAudit = { contractSha256, panelInputsSha256, renderFingerprint };
  const page = { pageIndex: 1, width: PAGE_WIDTH, height: layout.pageHeight, png: pngArtifact, svg: svgArtifact };
  return {
    schemaVersion: 2,
    kind: "fusion-storyboard-sheet-render",
    contractId: input.contract.contractId,
    sourceFingerprint: input.contract.sourceFingerprint,
    renderFingerprint,
    inputAudit,
    renderPolicy: policy,
    overflowReport: layout.overflowReport,
    cropAudit: renderedSvg.cropAudit,
    width: PAGE_WIDTH,
    height: layout.pageHeight,
    pageCount: 1,
    pages: [page],
    panelCount: panels.length,
    durationSeconds: 15,
    renderPurpose,
    formalProductionEligible: renderPurpose === "formal",
    reused: pngStatus === "existing" && svgStatus === "existing",
    png: pngArtifact,
    svg: svgArtifact,
    panelImages: loaded.map(({ bytesBuffer: _bytesBuffer, transform: _transform, ...evidence }) => evidence),
  };
}

/** v2 审计接口：用途必须显式，正式与预览不能由缺省值混淆。 */
export async function renderFusionStoryboardSheetV2(input: RenderFusionStoryboardSheetV2Input): Promise<FusionStoryboardSheetRenderResult> {
  return renderFusionStoryboardSheetInternal(input);
}

/** 向后兼容入口；新生产调用请使用 renderFusionStoryboardSheetV2。 */
export async function renderFusionStoryboardSheet(input: RenderFusionStoryboardSheetInput): Promise<FusionStoryboardSheetRenderResult> {
  return renderFusionStoryboardSheetInternal({ ...input, renderPurpose: input.renderPurpose ?? "formal" });
}
