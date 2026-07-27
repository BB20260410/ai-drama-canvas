import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type ProductionAssetCategory = "character" | "scene" | "prop";

export interface FusionPackageExpectedCounts {
  episodes: number;
  units: number;
  sourceShots: number;
  scheduleRows: number;
  assets: number;
  characters: number;
  scenes: number;
  props: number;
  standardDurationSeconds: number;
}

export const THIRD_SEASON_FUSION_EXPECTED_COUNTS: Readonly<FusionPackageExpectedCounts> = Object.freeze({
  episodes: 32,
  units: 1_288,
  sourceShots: 1_472,
  scheduleRows: 2_640,
  assets: 77,
  characters: 24,
  scenes: 20,
  props: 33,
  standardDurationSeconds: 15,
});

export interface FusionSourceFileDigest {
  relativePath: string;
  bytes: number;
  sha256: string;
  kind:
    | "fusion-index-json"
    | "asset-library-markdown"
    | "unit-markdown"
    | "source-prompt-markdown"
    | "source-script-markdown";
}

export interface FusionSourceInventory {
  algorithm: "sha256-portable-path-bytes-content-v1";
  aggregateSha256: string;
  totalBytes: number;
  files: FusionSourceFileDigest[];
}

export interface AssetPromptDefinition {
  label: string;
  prompt: string;
}

export interface ProductionAssetDefinition {
  id: string;
  category: ProductionAssetCategory;
  name: string;
  declaredUsage: string;
  generationPrompts: AssetPromptDefinition[];
  sourceMarkdownPath: string;
  sourceHeadingLine: number;
  sourceSectionSha256: string;
  sourceSection: string;
  generationStatus: "not-generated";
  hardLockStatus: "unlocked";
}

export interface AssetGenerationContractReference {
  path: string;
  sha256: string;
  role: "authority" | "supporting";
}

export interface AssetGenerationContract {
  schemaVersion: 1;
  kind: "asset-generation-contract";
  contractId: string;
  assetId: string;
  assetCategory: ProductionAssetCategory;
  prompt: string;
  provider: "artlist";
  model: "GPT Image 2";
  aspectRatio: "9:16";
  quality: "Medium";
  imageCount: 1;
  concurrency: 1;
  authorityReferences: AssetGenerationContractReference[];
  referencePolicy: {
    acceptedAssetsOnly: true;
    contentHashesRequired: true;
    maximumReferences: 6;
  };
  acceptanceRequirements: string[];
  hardLockPromotion: {
    automatic: false;
    visualReviewRequired: true;
  };
}

export interface FusionScheduleRow {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  label: string;
  content: string;
  kind: "source-shot" | "extension";
  sourceShotNumber?: number;
}

export interface FusionUnitDefinition {
  id: string;
  episode: string;
  episodeNumber: number;
  sequence: number;
  episodeTitle: string;
  title: string;
  markdownPath: string;
  markdownSha256: string;
  sourceScriptPath: string;
  sourcePromptTablePath: string;
  sourceShots: number[];
  sourceDurationSeconds: number;
  standardDurationSeconds: number;
  aspectRatio: string;
  storyGoal: string;
  schedule: FusionScheduleRow[];
  assetIds: string[];
  referenceImagePaths: string[];
}

export interface ContinuitySpan {
  id: string;
  assetId: string;
  episode: string;
  episodeNumber: number;
  unitId: string;
  unitSequence: number;
  sourceShots: number[];
  scheduleRowIndexes: number[];
  startSeconds: number;
  endSeconds: number;
  usageSources: Array<"fusion-index" | "source-prompt">;
  characterAssetIds: string[];
  sceneAssetIds: string[];
  propAssetIds: string[];
  /** 后续人工或自动标注可填；预检不猜测服装。 */
  costume?: string;
  /** 后续人工或自动标注可填；预检不从叙事文本臆造状态。 */
  state?: string;
  referenceVersion: string;
}

export interface ContinuityTrack {
  assetId: string;
  assetName: string;
  category: ProductionAssetCategory;
  episodeCodes: string[];
  unitIds: string[];
  spans: ContinuitySpan[];
}

export interface FusionPackageCounts extends FusionPackageExpectedCounts {
  promptReferencedAssets: number;
  indexReferencedAssets: number;
}

export interface FusionPackageInspection {
  schemaVersion: 1;
  kind: "fusion-package-inspection";
  readOnly: true;
  sourceRoot: string;
  packageRoot: string;
  indexPath: string;
  assetLibraryPath: string;
  counts: FusionPackageCounts;
  expectedCounts: FusionPackageExpectedCounts;
  inventory: FusionSourceInventory;
  assets: ProductionAssetDefinition[];
  units: FusionUnitDefinition[];
  continuityTracks: ContinuityTrack[];
}

export interface FusionProjectManifest {
  schemaVersion: 1;
  kind: "fusion-project-manifest";
  projectId: string;
  contentAddress: `sha256:${string}`;
  directoryName: string;
  manifestSha256: string;
  source: {
    root: string;
    packageRoot: string;
    readOnly: true;
    inventory: FusionSourceInventory;
  };
  counts: FusionPackageCounts;
  assets: ProductionAssetDefinition[];
  units: FusionUnitDefinition[];
  continuityTracks: ContinuityTrack[];
}

export interface InspectFusionPackageOptions {
  /** `15s_fused_units.json` 所在目录。 */
  packageRoot: string;
  /** JSON 中 `05_提示词/...` 和 `01_剧本/...` 的解析根；默认 packageRoot 的上级。 */
  sourceRoot?: string;
  indexPath?: string;
  assetLibraryPath?: string;
  expectedCounts?: Partial<FusionPackageExpectedCounts>;
}

export interface CreateAssetGenerationContractOptions {
  promptIndex?: number;
  promptOverride?: string;
  authorityReferences?: AssetGenerationContractReference[];
  acceptanceRequirements?: string[];
}

export class FusionPackageValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[] | string) {
    const normalized = Array.isArray(issues) ? issues : [issues];
    super(`融合包预检失败：\n- ${normalized.join("\n- ")}`);
    this.name = "FusionPackageValidationError";
    this.issues = normalized;
  }
}

interface TrackedFile {
  absolutePath: string;
  relativePath: string;
  content: Buffer;
  digest: FusionSourceFileDigest;
}

interface PromptShotReference {
  codes: string[];
  assetIds: Set<string>;
}

interface PromptTableInspection {
  shots: Map<number, PromptShotReference>;
  referencedAssetIds: Set<string>;
}

const ASSET_ID_PATTERN = /^[CSP]\d{2}[a-z]?$/u;
const ASSET_HEADING_PATTERN = /^###\s+([CSP]\d{2}[a-z]?)\s+(.+?)\s*$/gmu;
const UNIT_ID_PATTERN = /^(EP(\d{2}))_15s_(\d{3})$/u;
const EPSILON = 1e-9;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function portableRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function assetCategory(assetId: string): ProductionAssetCategory {
  if (assetId.startsWith("C")) return "character";
  if (assetId.startsWith("S")) return "scene";
  return "prop";
}

function normalizedExpectedCounts(
  overrides: Partial<FusionPackageExpectedCounts> | undefined,
): FusionPackageExpectedCounts {
  return { ...THIRD_SEASON_FUSION_EXPECTED_COUNTS, ...overrides };
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  try {
    const info = await lstat(input);
    if (!info.isDirectory()) throw new FusionPackageValidationError(`${label}不是目录：${input}`);
    if (info.isSymbolicLink()) throw new FusionPackageValidationError(`${label}禁止使用符号链接：${input}`);
    return await realpath(input);
  } catch (error) {
    if (error instanceof FusionPackageValidationError) throw error;
    throw new FusionPackageValidationError(`${label}不可访问：${input}`);
  }
}

async function readTrackedFile(
  sourceRoot: string,
  inputPath: string,
  kind: FusionSourceFileDigest["kind"],
  label: string,
): Promise<TrackedFile> {
  const candidate = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(sourceRoot, inputPath);
  if (!isSameOrInside(candidate, sourceRoot)) {
    throw new FusionPackageValidationError(`${label}越出只读源根：${inputPath}`);
  }
  try {
    const info = await lstat(candidate);
    if (!info.isFile()) throw new FusionPackageValidationError(`${label}不是文件：${inputPath}`);
    if (info.isSymbolicLink()) throw new FusionPackageValidationError(`${label}禁止使用符号链接：${inputPath}`);
    const canonical = await realpath(candidate);
    if (!isSameOrInside(canonical, sourceRoot)) {
      throw new FusionPackageValidationError(`${label}解析后越出只读源根：${inputPath}`);
    }
    const content = await readFile(canonical);
    const relativePath = portableRelativePath(sourceRoot, canonical);
    return {
      absolutePath: canonical,
      relativePath,
      content,
      digest: {
        relativePath,
        bytes: content.byteLength,
        sha256: sha256(content),
        kind,
      },
    };
  } catch (error) {
    if (error instanceof FusionPackageValidationError) throw error;
    throw new FusionPackageValidationError(`${label}缺失或不可读：${inputPath}`);
  }
}

function parseGenerationPrompts(section: string): AssetPromptDefinition[] {
  const lines = section.replace(/\r\n?/gu, "\n").split("\n");
  const prompts: AssetPromptDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index]?.match(
      /^-\s+\*\*([^*]*提示词(?:[（(][^）)]+[）)])?)\*\*[：:]?\s*(.*)$/u,
    );
    if (!marker) continue;
    const chunks: string[] = [];
    if (marker[2]?.trim()) chunks.push(marker[2].trim());
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (/^###\s+/u.test(line) || /^-\s+\*\*/u.test(line)) break;
      if (line.trim()) chunks.push(line.trim());
      index = next;
    }
    const prompt = chunks.join("\n").trim();
    if (prompt) prompts.push({ label: marker[1]?.trim() || "default", prompt });
  }
  return prompts;
}

function parseAssetLibrary(
  markdown: string,
  sourceMarkdownPath: string,
  issues: string[],
): ProductionAssetDefinition[] {
  const matches = [...markdown.matchAll(ASSET_HEADING_PATTERN)];
  const assets: ProductionAssetDefinition[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const id = match?.[1];
    const name = match?.[2]?.trim();
    if (!id || !name || match.index === undefined) continue;
    const end = matches[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(match.index, end).trim();
    if (seen.has(id)) {
      issues.push(`资产库存在重复资产 ID：${id}`);
      continue;
    }
    seen.add(id);
    const generationPrompts = parseGenerationPrompts(section);
    if (!generationPrompts.length) issues.push(`资产 ${id} 缺少 AI 出图提示词`);
    assets.push({
      id,
      category: assetCategory(id),
      name,
      declaredUsage: section.match(/^-\s+\*\*出场集数\*\*[：:]\s*(.+)$/mu)?.[1]?.trim() ?? "",
      generationPrompts,
      sourceMarkdownPath,
      sourceHeadingLine: markdown.slice(0, match.index).split(/\r\n?|\n/u).length,
      sourceSectionSha256: sha256(Buffer.from(section, "utf8")),
      sourceSection: section,
      generationStatus: "not-generated",
      hardLockStatus: "unlocked",
    });
  }
  return assets;
}

function parsePromptTable(markdown: string, sourcePath: string, issues: string[]): PromptTableInspection {
  const shots = new Map<number, PromptShotReference>();
  const referencedAssetIds = new Set<string>();
  const seenCodes = new Set<string>();
  let active: PromptShotReference | undefined;
  for (const line of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = line.match(/^####\s+镜(\d+)([a-z]?)\s+/iu);
    if (heading?.[1]) {
      const number = Number(heading[1]);
      const code = `${number}${heading[2]?.toLowerCase() ?? ""}`;
      if (seenCodes.has(code)) issues.push(`${sourcePath} 存在重复原镜标题：镜${code}`);
      seenCodes.add(code);
      active = shots.get(number) ?? { codes: [], assetIds: new Set<string>() };
      active.codes.push(code);
      shots.set(number, active);
      continue;
    }
    if (!active || !(/\*\*参考素材\*\*/u.test(line) || /^【参考】/u.test(line))) continue;
    for (const id of line.match(/(?<![A-Za-z0-9])[CSP]\d{2}[a-z]?(?![A-Za-z0-9])/gu) ?? []) {
      active.assetIds.add(id);
      referencedAssetIds.add(id);
    }
  }
  return { shots, referencedAssetIds };
}

function parseScheduleRows(
  raw: unknown,
  unitId: string,
  sourceShots: number[],
  standardDurationSeconds: number,
  sourceDurationSeconds: number,
  issues: string[],
): FusionScheduleRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${unitId} 缺少 schedule`);
    return [];
  }
  const schedule: FusionScheduleRow[] = [];
  let cursor = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const row = record(raw[index]);
    const start = numberValue(row?.start);
    const end = numberValue(row?.end);
    const seconds = numberValue(row?.seconds);
    const label = stringValue(row?.shot);
    const content = stringValue(row?.content);
    if (start === undefined || end === undefined || seconds === undefined || !label || !content) {
      issues.push(`${unitId} schedule[${index}] 字段不完整`);
      continue;
    }
    if (!sameNumber(start, cursor)) issues.push(`${unitId} schedule[${index}] 秒段不连续：应从 ${cursor} 开始`);
    if (start < 0 || end <= start || end > standardDurationSeconds + EPSILON) {
      issues.push(`${unitId} schedule[${index}] 非法秒段：${start}-${end}`);
    }
    if (!sameNumber(seconds, end - start)) {
      issues.push(`${unitId} schedule[${index}] seconds 与 end-start 不一致`);
    }
    const isExtension = label === "扩写补足";
    const shotMatch = label.match(/^镜(\d+)(?:[a-z])?$/iu);
    if (!isExtension && !shotMatch?.[1]) issues.push(`${unitId} schedule[${index}] 非法原镜标签：${label}`);
    if (isExtension && index !== raw.length - 1) issues.push(`${unitId} 扩写补足只能位于 schedule 末尾`);
    schedule.push({
      index,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: seconds,
      label,
      content,
      kind: isExtension ? "extension" : "source-shot",
      ...(shotMatch?.[1] ? { sourceShotNumber: Number(shotMatch[1]) } : {}),
    });
    cursor = end;
  }
  const scheduledSourceShots = schedule
    .filter((row) => row.kind === "source-shot")
    .map((row) => row.sourceShotNumber)
    .filter((value): value is number => value !== undefined);
  if (JSON.stringify(scheduledSourceShots) !== JSON.stringify(sourceShots)) {
    issues.push(`${unitId} schedule 原镜顺序与 source_shots 不一致`);
  }
  const scheduledSourceDuration = schedule
    .filter((row) => row.kind === "source-shot")
    .reduce((sum, row) => sum + row.durationSeconds, 0);
  if (!sameNumber(scheduledSourceDuration, sourceDurationSeconds)) {
    issues.push(`${unitId} 原镜排期总时长与 source_duration_seconds 不一致`);
  }
  if (!sameNumber(cursor, standardDurationSeconds)) {
    issues.push(`${unitId} schedule 总时长不是 ${standardDurationSeconds} 秒`);
  }
  return schedule;
}

function buildSourceInventory(files: Iterable<FusionSourceFileDigest>): FusionSourceInventory {
  const sorted = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const aggregateInput = sorted
    .map((file) => `${Buffer.byteLength(file.relativePath, "utf8")}:${file.relativePath}\0${file.bytes}\0${file.sha256}`)
    .join("\n");
  return {
    algorithm: "sha256-portable-path-bytes-content-v1",
    aggregateSha256: sha256(Buffer.from(aggregateInput, "utf8")),
    totalBytes: sorted.reduce((sum, file) => sum + file.bytes, 0),
    files: sorted,
  };
}

function validateExactCount(label: string, actual: number, expected: number, issues: string[]): void {
  if (actual !== expected) issues.push(`${label}数量应为 ${expected}，实际为 ${actual}`);
}

function buildContinuityTracks(
  units: FusionUnitDefinition[],
  assets: ProductionAssetDefinition[],
  promptReferences: Map<string, Map<number, PromptShotReference>>,
): ContinuityTrack[] {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const spans = new Map<string, ContinuitySpan[]>();
  for (const unit of units) {
    const perShot = promptReferences.get(unit.episode) ?? new Map<number, PromptShotReference>();
    const promptIds = uniqueSorted(unit.sourceShots.flatMap((shot) => [...(perShot.get(shot)?.assetIds ?? [])]));
    const effectiveIds = uniqueSorted([...unit.assetIds, ...promptIds]);
    const characterAssetIds = effectiveIds.filter((id) => assetCategory(id) === "character");
    const sceneAssetIds = effectiveIds.filter((id) => assetCategory(id) === "scene");
    const propAssetIds = effectiveIds.filter((id) => assetCategory(id) === "prop");
    for (const assetId of effectiveIds) {
      const sourcePromptShots = unit.sourceShots.filter((shot) => perShot.get(shot)?.assetIds.has(assetId));
      const sourceShots = sourcePromptShots.length ? sourcePromptShots : [...unit.sourceShots];
      let rows = unit.schedule.filter(
        (row) => row.kind === "source-shot" && row.sourceShotNumber !== undefined && sourceShots.includes(row.sourceShotNumber),
      );
      if (!rows.length) rows = unit.schedule.filter((row) => row.kind === "source-shot");
      const firstStart = rows[0]?.startSeconds ?? 0;
      let lastEnd = rows.at(-1)?.endSeconds ?? unit.standardDurationSeconds;
      const lastSourceRow = unit.schedule.filter((row) => row.kind === "source-shot").at(-1);
      if (rows.at(-1)?.index === lastSourceRow?.index && unit.schedule.at(-1)?.kind === "extension") {
        lastEnd = unit.standardDurationSeconds;
      }
      const definition = assetMap.get(assetId);
      const span: ContinuitySpan = {
        id: `${assetId}:${unit.id}`,
        assetId,
        episode: unit.episode,
        episodeNumber: unit.episodeNumber,
        unitId: unit.id,
        unitSequence: unit.sequence,
        sourceShots,
        scheduleRowIndexes: rows.map((row) => row.index),
        startSeconds: firstStart,
        endSeconds: lastEnd,
        usageSources: [
          ...(unit.assetIds.includes(assetId) ? ["fusion-index" as const] : []),
          ...(promptIds.includes(assetId) ? ["source-prompt" as const] : []),
        ],
        characterAssetIds,
        sceneAssetIds,
        propAssetIds,
        referenceVersion: definition?.sourceSectionSha256 ?? "missing-definition",
      };
      const assetSpans = spans.get(assetId) ?? [];
      assetSpans.push(span);
      spans.set(assetId, assetSpans);
    }
  }
  return assets.map((asset) => {
    const assetSpans = spans.get(asset.id) ?? [];
    return {
      assetId: asset.id,
      assetName: asset.name,
      category: asset.category,
      episodeCodes: uniqueSorted(assetSpans.map((span) => span.episode)),
      unitIds: assetSpans.map((span) => span.unitId),
      spans: assetSpans,
    };
  });
}

export async function inspectFusionPackage(options: InspectFusionPackageOptions): Promise<FusionPackageInspection> {
  const packageRoot = await canonicalDirectory(options.packageRoot, "融合包根目录");
  const sourceRoot = await canonicalDirectory(options.sourceRoot ?? path.dirname(packageRoot), "第三季只读源根");
  if (!isSameOrInside(packageRoot, sourceRoot)) {
    throw new FusionPackageValidationError(`融合包根目录不在第三季只读源根内：${packageRoot}`);
  }
  const expectedCounts = normalizedExpectedCounts(options.expectedCounts);
  const tracked = new Map<string, FusionSourceFileDigest>();
  const track = (file: TrackedFile): void => {
    const existing = tracked.get(file.relativePath);
    if (existing && existing.sha256 !== file.digest.sha256) {
      throw new FusionPackageValidationError(`同一路径在预检期间内容漂移：${file.relativePath}`);
    }
    tracked.set(file.relativePath, file.digest);
  };

  const indexFile = await readTrackedFile(
    sourceRoot,
    options.indexPath ?? path.join(packageRoot, "15s_fused_units.json"),
    "fusion-index-json",
    "融合包 JSON 索引",
  );
  track(indexFile);
  const assetLibraryFile = await readTrackedFile(
    sourceRoot,
    options.assetLibraryPath ?? path.join(sourceRoot, "05_提示词", "00_全季资产库.md"),
    "asset-library-markdown",
    "全季资产库",
  );
  track(assetLibraryFile);

  const issues: string[] = [];
  const assets = parseAssetLibrary(assetLibraryFile.content.toString("utf8"), assetLibraryFile.relativePath, issues);
  const assetIds = new Set(assets.map((asset) => asset.id));
  let rawUnits: unknown;
  try {
    rawUnits = JSON.parse(indexFile.content.toString("utf8")) as unknown;
  } catch {
    throw new FusionPackageValidationError("15s_fused_units.json 不是有效 JSON");
  }
  if (!Array.isArray(rawUnits)) throw new FusionPackageValidationError("15s_fused_units.json 顶层必须是数组");

  const units: FusionUnitDefinition[] = [];
  const unitIds = new Set<string>();
  const markdownPaths = new Set<string>();
  const indexedAssetIds = new Set<string>();
  for (let index = 0; index < rawUnits.length; index += 1) {
    const rawUnit = record(rawUnits[index]);
    if (!rawUnit) {
      issues.push(`units[${index}] 必须是对象`);
      continue;
    }
    const id = stringValue(rawUnit.id) ?? `units[${index}]`;
    const episode = stringValue(rawUnit.episode);
    const idMatch = id.match(UNIT_ID_PATTERN);
    if (!idMatch?.[1] || !idMatch[2] || !idMatch[3]) issues.push(`${id} 不符合 EPxx_15s_xxx 单元 ID 规范`);
    if (!episode) issues.push(`${id} 缺少 episode`);
    if (episode && idMatch?.[1] !== episode) issues.push(`${id} 的 episode 与 ID 不一致`);
    if (unitIds.has(id)) issues.push(`融合包存在重复单元 ID：${id}`);
    unitIds.add(id);

    const mdPath = stringValue(rawUnit.md_path);
    const sourceScriptPath = stringValue(rawUnit.source_script);
    const sourcePromptTablePath = stringValue(rawUnit.source_prompt_table);
    if (!mdPath) issues.push(`${id} 缺少 md_path`);
    if (!sourceScriptPath) issues.push(`${id} 缺少 source_script`);
    if (!sourcePromptTablePath) issues.push(`${id} 缺少 source_prompt_table`);
    if (mdPath && (path.isAbsolute(mdPath) || mdPath.split(/[\\/]/u).includes(".."))) {
      issues.push(`${id} 的 md_path 必须是融合包内相对路径`);
    }
    if (mdPath && markdownPaths.has(mdPath)) issues.push(`融合包存在重复 md_path：${mdPath}`);
    if (mdPath) markdownPaths.add(mdPath);

    const sourceShots = Array.isArray(rawUnit.source_shots)
      ? rawUnit.source_shots.filter((shot): shot is number => Number.isInteger(shot) && shot > 0)
      : [];
    if (!Array.isArray(rawUnit.source_shots) || sourceShots.length !== rawUnit.source_shots.length || !sourceShots.length) {
      issues.push(`${id} 的 source_shots 必须是非空正整数数组`);
    }
    if (sourceShots.some((shot, shotIndex) => shotIndex > 0 && shot <= (sourceShots[shotIndex - 1] ?? 0))) {
      issues.push(`${id} 的 source_shots 必须严格递增且不得重复`);
    }

    const sourceDurationSeconds = numberValue(rawUnit.source_duration_seconds) ?? -1;
    const standardDurationSeconds = numberValue(rawUnit.standard_duration_seconds) ?? -1;
    if (!(sourceDurationSeconds > 0 && sourceDurationSeconds <= standardDurationSeconds)) {
      issues.push(`${id} 的 source_duration_seconds 非法`);
    }
    if (!sameNumber(standardDurationSeconds, expectedCounts.standardDurationSeconds)) {
      issues.push(`${id} 的 standard_duration_seconds 必须为 ${expectedCounts.standardDurationSeconds}`);
    }
    if (stringValue(rawUnit.aspect_ratio) !== "9:16") issues.push(`${id} 的 aspect_ratio 必须为 9:16`);
    const validation = record(rawUnit.validation);
    if (validation?.source_order_preserved !== true) issues.push(`${id} 未声明 source_order_preserved=true`);
    if (validation?.source_duration_lte_15 !== true) issues.push(`${id} 未声明 source_duration_lte_15=true`);
    if (validation?.no_compression !== true) issues.push(`${id} 未声明 no_compression=true`);

    const rawAssetIds = Array.isArray(rawUnit.asset_ids) ? rawUnit.asset_ids : [];
    const unitAssetIds: string[] = [];
    const seenUnitAssets = new Set<string>();
    for (const value of rawAssetIds) {
      if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) {
        issues.push(`${id} 含非法资产 ID：${String(value)}`);
        continue;
      }
      if (seenUnitAssets.has(value)) issues.push(`${id} 重复引用资产：${value}`);
      seenUnitAssets.add(value);
      unitAssetIds.push(value);
      indexedAssetIds.add(value);
      if (!assetIds.has(value)) issues.push(`${id} 引用了未定义资产：${value}`);
    }
    if (!Array.isArray(rawUnit.asset_ids)) issues.push(`${id} 的 asset_ids 必须是数组`);

    const referenceImagePaths = Array.isArray(rawUnit.reference_image_paths)
      ? rawUnit.reference_image_paths.filter((value): value is string => typeof value === "string")
      : [];
    if (!Array.isArray(rawUnit.reference_image_paths)
      || referenceImagePaths.length !== rawUnit.reference_image_paths.length) {
      issues.push(`${id} 的 reference_image_paths 必须是字符串数组`);
    }
    const schedule = parseScheduleRows(
      rawUnit.schedule,
      id,
      sourceShots,
      standardDurationSeconds,
      sourceDurationSeconds,
      issues,
    );
    if (!episode || !idMatch?.[2] || !idMatch[3] || !mdPath || !sourceScriptPath || !sourcePromptTablePath) continue;
    units.push({
      id,
      episode,
      episodeNumber: Number(idMatch[2]),
      sequence: Number(idMatch[3]),
      episodeTitle: stringValue(rawUnit.episode_title) ?? "",
      title: stringValue(rawUnit.unit_title) ?? "",
      markdownPath: mdPath,
      markdownSha256: "",
      sourceScriptPath,
      sourcePromptTablePath,
      sourceShots,
      sourceDurationSeconds,
      standardDurationSeconds,
      aspectRatio: stringValue(rawUnit.aspect_ratio) ?? "",
      storyGoal: stringValue(rawUnit.story_goal) ?? "",
      schedule,
      assetIds: unitAssetIds,
      referenceImagePaths,
    });
  }

  const episodes = new Map<string, FusionUnitDefinition[]>();
  for (const unit of units) {
    const episodeUnits = episodes.get(unit.episode) ?? [];
    episodeUnits.push(unit);
    episodes.set(unit.episode, episodeUnits);
  }
  let previousEpisode = 0;
  let previousSequence = 0;
  for (const unit of units) {
    if (unit.episodeNumber < previousEpisode
      || (unit.episodeNumber === previousEpisode && unit.sequence <= previousSequence)) {
      issues.push(`${unit.id} 在 JSON 中的单元顺序倒置或重复`);
    }
    previousSequence = unit.episodeNumber === previousEpisode ? unit.sequence : 0;
    previousEpisode = unit.episodeNumber;
    previousSequence = unit.sequence;
  }
  for (const [episode, episodeUnits] of episodes) {
    const orderedShots = episodeUnits.flatMap((unit) => unit.sourceShots);
    orderedShots.forEach((shot, index) => {
      if (shot !== index + 1) issues.push(`${episode} 原镜顺序应为连续的 1..N，位置 ${index + 1} 实际为 ${shot}`);
    });
    episodeUnits.forEach((unit, index) => {
      if (unit.sequence !== index + 1) issues.push(`${episode} 15秒单元序号不连续：应为 ${index + 1}，实际为 ${unit.sequence}`);
    });
  }

  const promptReferences = new Map<string, Map<number, PromptShotReference>>();
  const promptReferencedAssetIds = new Set<string>();
  const promptPathByEpisode = new Map<string, string>();
  for (const unit of units) {
    const prior = promptPathByEpisode.get(unit.episode);
    if (prior && prior !== unit.sourcePromptTablePath) {
      issues.push(`${unit.episode} 引用了多个来源提示词表：${prior} / ${unit.sourcePromptTablePath}`);
    }
    promptPathByEpisode.set(unit.episode, unit.sourcePromptTablePath);
  }
  for (const [episode, promptPath] of promptPathByEpisode) {
    const promptFile = await readTrackedFile(sourceRoot, promptPath, "source-prompt-markdown", `${episode} 来源提示词表`);
    track(promptFile);
    const parsed = parsePromptTable(promptFile.content.toString("utf8"), promptFile.relativePath, issues);
    promptReferences.set(episode, parsed.shots);
    for (const id of parsed.referencedAssetIds) {
      promptReferencedAssetIds.add(id);
      if (!assetIds.has(id)) issues.push(`${promptFile.relativePath} 引用了未定义资产：${id}`);
    }
    for (const unit of episodes.get(episode) ?? []) {
      for (const shot of unit.sourceShots) {
        if (!parsed.shots.has(shot)) issues.push(`${promptFile.relativePath} 缺少 ${episode} 镜${shot} 提示词`);
      }
    }
  }

  const scriptPaths = uniqueSorted(units.map((unit) => unit.sourceScriptPath));
  for (const scriptPath of scriptPaths) {
    const scriptFile = await readTrackedFile(sourceRoot, scriptPath, "source-script-markdown", "来源剧本");
    track(scriptFile);
    if (!scriptFile.content.toString("utf8").trim()) issues.push(`来源剧本为空：${scriptFile.relativePath}`);
  }
  for (const unit of units) {
    const unitFile = await readTrackedFile(packageRoot, unit.markdownPath, "unit-markdown", `${unit.id} 单元 MD`);
    track({
      ...unitFile,
      digest: { ...unitFile.digest, relativePath: portableRelativePath(sourceRoot, unitFile.absolutePath) },
      relativePath: portableRelativePath(sourceRoot, unitFile.absolutePath),
    });
    unit.markdownSha256 = unitFile.digest.sha256;
    const heading = `# ${unit.episode} 15s-${String(unit.sequence).padStart(3, "0")}`;
    if (!unitFile.content.toString("utf8").includes(heading)) {
      issues.push(`${unit.id} 的 md_path 文件标题与 JSON 单元不一致`);
    }
  }

  for (const asset of assets) {
    if (!indexedAssetIds.has(asset.id)) issues.push(`资产 ${asset.id} 已定义但未被 fusion index 使用`);
    if (!promptReferencedAssetIds.has(asset.id)) issues.push(`资产 ${asset.id} 已定义但未被来源提示词使用`);
  }
  for (const id of indexedAssetIds) {
    if (!assetIds.has(id)) issues.push(`fusion index 使用了未定义资产 ${id}`);
  }

  const characterCount = assets.filter((asset) => asset.category === "character").length;
  const sceneCount = assets.filter((asset) => asset.category === "scene").length;
  const propCount = assets.filter((asset) => asset.category === "prop").length;
  const counts: FusionPackageCounts = {
    episodes: episodes.size,
    units: units.length,
    sourceShots: units.reduce((sum, unit) => sum + unit.sourceShots.length, 0),
    scheduleRows: units.reduce((sum, unit) => sum + unit.schedule.length, 0),
    assets: assets.length,
    characters: characterCount,
    scenes: sceneCount,
    props: propCount,
    standardDurationSeconds: expectedCounts.standardDurationSeconds,
    promptReferencedAssets: promptReferencedAssetIds.size,
    indexReferencedAssets: indexedAssetIds.size,
  };
  validateExactCount("集", counts.episodes, expectedCounts.episodes, issues);
  validateExactCount("15秒单元", counts.units, expectedCounts.units, issues);
  validateExactCount("原镜", counts.sourceShots, expectedCounts.sourceShots, issues);
  validateExactCount("时间段", counts.scheduleRows, expectedCounts.scheduleRows, issues);
  validateExactCount("资产", counts.assets, expectedCounts.assets, issues);
  validateExactCount("角色资产", counts.characters, expectedCounts.characters, issues);
  validateExactCount("场景资产", counts.scenes, expectedCounts.scenes, issues);
  validateExactCount("道具资产", counts.props, expectedCounts.props, issues);
  validateExactCount("fusion index 使用资产", counts.indexReferencedAssets, expectedCounts.assets, issues);
  validateExactCount("来源提示词使用资产", counts.promptReferencedAssets, expectedCounts.assets, issues);
  if (issues.length) throw new FusionPackageValidationError(issues);

  const inventory = buildSourceInventory(tracked.values());
  return {
    schemaVersion: 1,
    kind: "fusion-package-inspection",
    readOnly: true,
    sourceRoot,
    packageRoot,
    indexPath: indexFile.absolutePath,
    assetLibraryPath: assetLibraryFile.absolutePath,
    counts,
    expectedCounts,
    inventory,
    assets,
    units,
    continuityTracks: buildContinuityTracks(units, assets, promptReferences),
  };
}

export function createAssetGenerationContract(
  asset: ProductionAssetDefinition,
  options: CreateAssetGenerationContractOptions = {},
): AssetGenerationContract {
  const prompt = options.promptOverride?.trim()
    || asset.generationPrompts[options.promptIndex ?? 0]?.prompt
    || "";
  if (!prompt) throw new FusionPackageValidationError(`资产 ${asset.id} 没有可用生图提示词`);
  const authorityReferences = options.authorityReferences ?? [];
  if (authorityReferences.length > 6) {
    throw new FusionPackageValidationError(`资产 ${asset.id} 的权威参考超过 6 项`);
  }
  for (const reference of authorityReferences) {
    if (!reference.path.trim() || !/^[a-f0-9]{64}$/u.test(reference.sha256)) {
      throw new FusionPackageValidationError(`资产 ${asset.id} 含非法权威参考路径或 SHA-256`);
    }
  }
  const acceptanceRequirements = options.acceptanceRequirements ?? [
    "图片可解码、竖屏 9:16、非占位图",
    "无字幕、水印、拼图、现代物或多余人物",
    "身份、服装、道具结构与权威参考一致",
  ];
  const contractPayload = {
    assetId: asset.id,
    assetSectionSha256: asset.sourceSectionSha256,
    prompt,
    authorityReferences,
    acceptanceRequirements,
  };
  return {
    schemaVersion: 1,
    kind: "asset-generation-contract",
    contractId: `asset-${asset.id}-${sha256(JSON.stringify(contractPayload)).slice(0, 16)}`,
    assetId: asset.id,
    assetCategory: asset.category,
    prompt,
    provider: "artlist",
    model: "GPT Image 2",
    aspectRatio: "9:16",
    quality: "Medium",
    imageCount: 1,
    concurrency: 1,
    authorityReferences,
    referencePolicy: {
      acceptedAssetsOnly: true,
      contentHashesRequired: true,
      maximumReferences: 6,
    },
    acceptanceRequirements,
    hardLockPromotion: {
      automatic: false,
      visualReviewRequired: true,
    },
  };
}

export function createFusionProjectManifest(inspection: FusionPackageInspection): FusionProjectManifest {
  const contentAddress = `sha256:${inspection.inventory.aggregateSha256}` as const;
  const directoryName = `gushujuan-s3-${inspection.inventory.aggregateSha256.slice(0, 16)}`;
  const base = {
    schemaVersion: 1 as const,
    kind: "fusion-project-manifest" as const,
    projectId: directoryName,
    contentAddress,
    directoryName,
    source: {
      root: inspection.sourceRoot,
      packageRoot: inspection.packageRoot,
      readOnly: true as const,
      inventory: inspection.inventory,
    },
    counts: inspection.counts,
    assets: inspection.assets,
    units: inspection.units,
    continuityTracks: inspection.continuityTracks,
  };
  return { ...base, manifestSha256: sha256(JSON.stringify(base)) };
}

export function assertFusionSourceInventoryUnchanged(
  expected: FusionSourceInventory,
  actual: FusionSourceInventory,
): void {
  if (expected.algorithm !== actual.algorithm || expected.aggregateSha256 !== actual.aggregateSha256) {
    const expectedFiles = new Map(expected.files.map((file) => [file.relativePath, file]));
    const actualFiles = new Map(actual.files.map((file) => [file.relativePath, file]));
    const changed = uniqueSorted([...expectedFiles.keys(), ...actualFiles.keys()]).filter((relativePath) => {
      const before = expectedFiles.get(relativePath);
      const after = actualFiles.get(relativePath);
      return !before || !after || before.bytes !== after.bytes || before.sha256 !== after.sha256;
    });
    throw new FusionPackageValidationError(
      `第三季只读源内容漂移：${changed.length ? changed.join(", ") : "聚合摘要不一致"}`,
    );
  }
}
