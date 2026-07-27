import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultProjectConfig } from "./constants.js";
import {
  assertFusionSourceInventoryUnchanged,
  createAssetGenerationContract,
  createFusionProjectManifest,
  inspectFusionPackage,
  type AssetGenerationContract,
  type ContinuitySpan,
  type ContinuityTrack,
  type FusionPackageInspection,
  type FusionProjectManifest,
  type FusionUnitDefinition,
  type ProductionAssetDefinition,
} from "./fusion-package.js";
import { getSidecarPaths, readJson } from "./sidecar.js";
import type { CreativeBible, GenerationSettings, StoryboardRow, StoryboardStore, TimelineOverrides } from "./types.js";

export interface FusionAuthorityInput {
  id: string;
  assetId?: string;
  name: string;
  sourcePath: string;
  expectedSha256: string;
  rules: string[];
  exposeToGeneration: boolean;
}

export interface MaterializedAuthorityReference {
  id: string;
  assetId?: string;
  name: string;
  sourcePath: string;
  sourceSha256: string;
  snapshotPath: string;
  snapshotSha256: string;
  rules: string[];
  exposeToGeneration: boolean;
}

export interface FusionProductionAssetEntry {
  workItemId: string;
  definition: ProductionAssetDefinition;
  contract: AssetGenerationContract;
  directoryPath: string;
  infoPath: string;
  outputDirectory: string;
  authority?: MaterializedAuthorityReference;
}

export interface FusionProductionAssetCatalog {
  schemaVersion: 1;
  kind: "fusion-production-assets";
  revision: number;
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  assets: FusionProductionAssetEntry[];
  updatedAt: string;
}

export interface MaterializedContinuitySpan extends ContinuitySpan {
  unitItemId: string;
  shotItemIds: string[];
}

export interface MaterializedContinuityTrack extends Omit<ContinuityTrack, "spans"> {
  workItemId: string;
  spans: MaterializedContinuitySpan[];
}

export interface FusionContinuityStore {
  schemaVersion: 1;
  kind: "fusion-continuity-tracks";
  sourceContentAddress: `sha256:${string}`;
  tracks: MaterializedContinuityTrack[];
  updatedAt: string;
}

export interface FusionMaterializedFileDigest {
  relativePath: string;
  bytes: number;
  sha256: string;
  role: "source-snapshot" | "unit" | "shot" | "asset-definition" | "visual-bible" | "manifest" | "authority";
}

export interface FusionMaterializationReceipt {
  schemaVersion: 1;
  kind: "fusion-production-materialization";
  receiptId: string;
  createdAt: string;
  sourceContentAddress: `sha256:${string}`;
  sourceInventorySha256: string;
  targetRoot: string;
  fusionManifestPath: string;
  assetCatalogPath: string;
  continuityStorePath: string;
  storyboardStorePath: string;
  visualBiblePath: string;
  authorities: MaterializedAuthorityReference[];
  ownedFiles: FusionMaterializedFileDigest[];
  ownedFilesSha256: string;
  counts: FusionPackageInspection["counts"];
}

export interface MaterializeFusionProjectOptions {
  inspection: FusionPackageInspection;
  targetParent: string;
  authorities?: FusionAuthorityInput[];
}

export interface MaterializeFusionProjectResult {
  created: boolean;
  targetRoot: string;
  manifest: FusionProjectManifest;
  receipt: FusionMaterializationReceipt;
  assetCatalog: FusionProductionAssetCatalog;
  continuity: FusionContinuityStore;
}

interface ParsedShotContract {
  referenceAssetIds: string[];
  videoPrompt: string;
  endFramePrompt: string;
  shotSize: string;
  cameraMovement: string;
  cameraAngle?: string;
  lens?: string;
}

// 必须有标识边界；旧表达式会把 EP01/EP02 中的 P01/P02 误当成道具资产。
const ASSET_ID_PATTERN = /(?<![A-Za-z0-9])[CSP]\d{2}[a-z]?(?![A-Za-z0-9])/gu;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`只允许常规文件：${filePath}`);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`读取期间文件发生变化：${filePath}`);
  return { bytes: content.byteLength, sha256: sha256(content) };
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeName(value: string): string {
  return [...value.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "")
    .replace(/[\s.]+/gu, "_")
    .replace(/^_+|_+$/gu, "")].slice(0, 48).join("") || "未命名";
}

function unitWorkItemId(unit: FusionPackageInspection["units"][number]): string {
  return `season-三-ep${String(unit.episodeNumber).padStart(2, "0")}-unit${String(unit.sequence).padStart(3, "0")}`;
}

function shotWorkItemId(unit: FusionPackageInspection["units"][number], shot: number): string {
  return `${unitWorkItemId(unit)}-shot${String(shot).padStart(2, "0")}`;
}

function extractSection(markdown: string, heading: RegExp, nextHeading: RegExp): string {
  const start = markdown.search(heading);
  if (start < 0) return "";
  const tail = markdown.slice(start).replace(/^##[^\n]*\n/u, "");
  const end = tail.search(nextHeading);
  return (end < 0 ? tail : tail.slice(0, end)).trim();
}

function parseCameraTable(markdown: string): Map<number, Pick<ParsedShotContract, "shotSize" | "cameraMovement" | "cameraAngle" | "lens">> {
  const table = extractSection(markdown, /^##\s+3\./mu, /^##\s+4\./mu);
  const result = new Map<number, Pick<ParsedShotContract, "shotSize" | "cameraMovement" | "cameraAngle" | "lens">>();
  for (const line of table.split("\n")) {
    if (!/^\|\s*镜\d+/u.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim());
    const shot = Number(cells[0]?.match(/镜(\d+)/u)?.[1]);
    if (!Number.isInteger(shot)) continue;
    result.set(shot, {
      shotSize: cells[1] || "中景",
      lens: cells[2] || undefined,
      cameraAngle: cells[3] || undefined,
      cameraMovement: cells[4] || "固定",
    });
  }
  return result;
}

function parseShotContracts(markdown: string): Map<number, ParsedShotContract> {
  const cameras = parseCameraTable(markdown);
  // 任一后续三级标题都结束当前原镜块，避免最后一镜吞入后续 EPxx 说明。
  const matches = [...markdown.matchAll(/^###\s+原镜(\d+)\s+视频提示词\s*$([\s\S]*?)(?=^###\s+|^##\s+9\.)/gmu)];
  const result = new Map<number, ParsedShotContract>();
  for (const match of matches) {
    const shot = Number(match[1]);
    const block = match[2]?.trim() ?? "";
    const endFramePrompt = block.match(/(?:^|\n)尾帧[：:]\s*([^\n]+)/u)?.[1]?.trim() || "保持末镜动作与空间连续，形成可续接尾帧。";
    const camera = cameras.get(shot);
    result.set(shot, {
      referenceAssetIds: [...new Set(block.match(ASSET_ID_PATTERN) ?? [])],
      videoPrompt: block.replace(/(?:^|\n)尾帧[：:][\s\S]*$/u, "").trim() || `原镜${shot}按来源提示词执行。`,
      endFramePrompt,
      shotSize: camera?.shotSize ?? "中景",
      cameraMovement: camera?.cameraMovement ?? "固定",
      cameraAngle: camera?.cameraAngle,
      lens: camera?.lens,
    });
  }
  return result;
}

export function parseFusionUnitStoryboardReferenceAssetIds(
  unit: FusionUnitDefinition,
  markdown: string,
): Map<number, string[]> {
  const contracts = parseShotContracts(markdown);
  const lastSourceRow = unit.schedule.filter((row) => row.kind === "source-shot").at(-1);
  const fallbackLast = lastSourceRow?.sourceShotNumber === undefined ? undefined : contracts.get(lastSourceRow.sourceShotNumber);
  return new Map(unit.schedule.map((schedule) => {
    const sourceContract = schedule.sourceShotNumber === undefined ? undefined : contracts.get(schedule.sourceShotNumber);
    const references = schedule.kind === "extension"
      ? fallbackLast?.referenceAssetIds ?? unit.assetIds
      : sourceContract?.referenceAssetIds.length ? sourceContract.referenceAssetIds : unit.assetIds;
    return [schedule.index, [...new Set(references)].sort()] as const;
  }));
}

function unitStartFramePrompt(markdown: string, fallback: string): string {
  return extractSection(markdown, /^##\s+7\./mu, /^##\s+8\./mu).trim() || `电影级写实风格，9:16 竖屏。首帧画面：${fallback}`;
}

function storyboardRowsForUnit(
  unit: FusionPackageInspection["units"][number],
  markdown: string,
  timestamp: string,
): StoryboardRow[] {
  const contracts = parseShotContracts(markdown);
  const firstSourceRow = unit.schedule.find((row) => row.kind === "source-shot");
  const lastSourceRow = unit.schedule.filter((row) => row.kind === "source-shot").at(-1);
  const startPrompt = unitStartFramePrompt(markdown, firstSourceRow?.content ?? unit.storyGoal);
  const fallbackReferences = [...unit.assetIds];
  return unit.schedule.map((schedule) => {
    const sourceContract = schedule.sourceShotNumber === undefined ? undefined : contracts.get(schedule.sourceShotNumber);
    const fallbackLast = lastSourceRow?.sourceShotNumber === undefined ? undefined : contracts.get(lastSourceRow.sourceShotNumber);
    const referenceNames = schedule.kind === "extension"
      ? fallbackLast?.referenceAssetIds ?? fallbackReferences
      : sourceContract?.referenceAssetIds.length ? sourceContract.referenceAssetIds : fallbackReferences;
    const isFirst = schedule.index === firstSourceRow?.index;
    const firstFramePrompt = isFirst
      ? startPrompt
      : `电影级写实风格，中国神话史诗质感，商周时代考据，9:16竖屏。首帧定格：${schedule.content}`;
    const endFramePrompt = schedule.kind === "extension"
      ? `${fallbackLast?.endFramePrompt ?? "保持末镜空间与动作连续。"} 延展至第15秒，不新增剧情事件。`
      : sourceContract?.endFramePrompt ?? `尾帧定格：${schedule.content}`;
    const shotNumber = schedule.sourceShotNumber;
    return {
      id: `storyboard-${unit.id}-${String(schedule.index + 1).padStart(2, "0")}`,
      itemId: unitWorkItemId(unit),
      shotItemId: shotNumber === undefined ? undefined : shotWorkItemId(unit, shotNumber),
      order: schedule.index + 1,
      durationSeconds: schedule.durationSeconds,
      shotSize: sourceContract?.shotSize ?? (schedule.kind === "extension" ? "延展镜头" : "中景"),
      cameraMovement: sourceContract?.cameraMovement ?? (schedule.kind === "extension" ? "承接末镜延展" : "固定"),
      cameraAngle: sourceContract?.cameraAngle,
      lens: sourceContract?.lens,
      action: schedule.content,
      continuityBefore: schedule.index === 0 ? `承接上一单元或本集起幅：${unit.storyGoal}` : `承接本单元第 ${schedule.index} 行尾态。`,
      continuityAfter: schedule.endSeconds === 15 ? "作为下一单元可续接尾态。" : `连续进入 ${schedule.endSeconds.toFixed(1)} 秒后的下一行。`,
      referenceNames,
      firstFramePrompt,
      endFramePrompt,
      videoPrompt: schedule.kind === "source-shot" ? sourceContract?.videoPrompt ?? schedule.content : schedule.content,
      referencePaths: [],
      referenceArtifactIds: [],
      continuityNotes: [
        `融合包时间段 ${schedule.startSeconds.toFixed(1)}-${schedule.endSeconds.toFixed(1)}s`,
        schedule.kind === "extension" ? "扩写段，不对应也不伪造原镜头。" : `来源原镜：镜${String(shotNumber).padStart(2, "0")}`,
      ],
      status: "confirmed",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
}

function shotInformation(
  unit: FusionPackageInspection["units"][number],
  row: StoryboardRow,
  sourceContentAddress: string,
): string {
  return [
    `# ${unit.episode} 镜${String(row.shotItemId?.match(/shot(\d+)$/u)?.[1] ?? "").padStart(2, "0")}｜${unit.title}`,
    "",
    `- 父单元：${unit.id}`,
    `- 原镜 WorkItem：${row.shotItemId}`,
    `- 时长：${row.durationSeconds}s`,
    `- 景别：${row.shotSize}`,
    `- 运镜：${row.cameraMovement}`,
    `- 来源内容地址：${sourceContentAddress}`,
    `- 参考资产：${(row.referenceNames ?? []).join(", ") || "无"}`,
    "",
    "## 动作",
    "",
    row.action,
    "",
    "## 首帧提示词",
    "",
    row.firstFramePrompt,
    "",
    "## 尾帧提示词",
    "",
    row.endFramePrompt,
    "",
    "## 视频提示词",
    "",
    row.videoPrompt,
    "",
  ].join("\n");
}

function assetInformation(entry: Omit<FusionProductionAssetEntry, "infoPath">): string {
  return [
    `# ${entry.definition.id} ${entry.definition.name}`,
    "",
    `- 类别：${entry.definition.category}`,
    `- WorkItem：${entry.workItemId}`,
    `- 生成状态：${entry.authority ? "已有用户授权权威参考" : "待生成"}`,
    `- 硬锁状态：${entry.authority ? "用户明确锁定" : "视觉验收后方可提升"}`,
    `- 来源资产段 SHA-256：${entry.definition.sourceSectionSha256}`,
    "",
    "## 生成合同",
    "",
    "```json",
    JSON.stringify(entry.contract, null, 2),
    "```",
    "",
    "## 来源定义",
    "",
    entry.definition.sourceSection,
    "",
  ].join("\n");
}

function visualBibleMarkdown(authorities: MaterializedAuthorityReference[], manifest: FusionProjectManifest): string {
  const authorityLines = authorities.map((authority) => `- ${authority.name}：${authority.snapshotPath}（SHA-256 ${authority.snapshotSha256}）`).join("\n");
  return `# 《蜀道山·古蜀卷》第三季视觉 Bible

- 项目内容地址：${manifest.contentAddress}
- 画幅：9:16 竖屏
- 风格：电影级写实、中国神话史诗质感、商周时代考据、戏剧性自然光影。

## 最高权威输入

${authorityLines || "- 无外部权威参考。"}

## 角色与道具铁律

- 阿航固定同一张脸、黑衣、发髻和左侧银白挑染；覆盖源资产库中的灰褐衣、赤红鬓发描述。
- 嘟嘟固定犬种、脸型、黑白棕花纹与白色卷尾；保持普通犬态，禁止拟人和变身。
- 黄金面具固定为完整结构；第三季只作为 P01 不透明布囊内部身份来源，EP32 前不得露出实体。
- 禁止半面具、裂面具、面具口型、第二只眼或完整脸提前显露。
- 禁止现代建筑、现代交通工具、现代电器、纸张、铁器、马镫、字幕、水印、拼图和多余人物。

## 生产门禁

- 资产图必须完成机械验收和绑定当前 SHA-256 的人工视觉通过，才可提升为硬锁。
- 分镜首帧只取首个原镜的显式资产引用；尾帧只取最后一个原镜的显式资产引用。
- 单镜显式参考最多 6 项；超过 6 项必须先建立并审核组合派生资产，禁止静默丢弃。
- 完整黄金面具权威图只用于视觉规则核验，不进入 EP32 前分镜上传白名单。
`;
}

function defaultGenerationSettings(targetRoot: string, timestamp: string): GenerationSettings {
  return {
    schemaVersion: 1,
    revision: 1,
    providers: [{
      id: "artlist-gpt-image-2",
      name: "Artlist · GPT Image 2",
      adapter: "codex-browser",
      kinds: ["image"],
      enabled: true,
      model: "GPT Image 2",
      siteUrl: "https://toolkit.artlist.io/image-video-generator?mode=image",
      executionSurface: { id: "codex-in-app-side-browser", version: "1" },
      browserInstructions: "仅使用 Codex 应用内侧边浏览器的已登录会话；9:16、Medium、1 Image、并发1。出现购买积分或额度不足提示时在点击前停止。禁止切换到 Chrome 或其他外部浏览器。",
      capabilities: {
        referenceModes: ["text", "multi_image"],
        maxReferenceImages: 6,
        maxReferenceVideos: 0,
        supportedDurations: [],
        supportedAspectRatios: ["9:16"],
        supportedResolutions: ["Medium"],
        models: ["GPT Image 2"],
        maxConcurrency: 1,
        supportsCancel: false,
      },
      outputRoot: targetRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    defaultImageProviderId: "artlist-gpt-image-2",
    concurrency: 1,
    updatedAt: timestamp,
  };
}

async function canonicalTargetParent(targetParent: string, sourceRoot: string): Promise<string> {
  const absolute = path.resolve(targetParent);
  const metadata = await lstat(absolute).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error(`目标父目录不存在、不是目录或为符号链接：${absolute}`);
  const canonical = await realpath(absolute);
  if (isSameOrInside(canonical, sourceRoot) || isSameOrInside(sourceRoot, canonical)) {
    throw new Error(`隔离工程目标父目录不得与第三季只读源根互相包含：${canonical}`);
  }
  return canonical;
}

async function verifyAuthorityInput(input: FusionAuthorityInput): Promise<{ canonicalPath: string; bytes: number; sha256: string }> {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256)) throw new Error(`权威输入 ${input.id} 的 expectedSha256 无效。`);
  const metadata = await lstat(input.sourcePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`权威输入不存在、不是文件或为符号链接：${input.sourcePath}`);
  const canonicalPath = await realpath(input.sourcePath);
  const digest = await sha256File(canonicalPath);
  if (digest.sha256 !== input.expectedSha256) throw new Error(`权威输入内容与授权 SHA-256 不一致：${input.id}`);
  return { canonicalPath, ...digest };
}

function stableOwnedDigest(files: FusionMaterializedFileDigest[]): string {
  return sha256(files
    .slice()
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))
    .map((file) => `${file.relativePath}\0${file.bytes}\0${file.sha256}\0${file.role}`)
    .join("\n"));
}

async function verifyExistingMaterialization(targetRoot: string, manifest: FusionProjectManifest): Promise<MaterializeFusionProjectResult | undefined> {
  const receiptPath = path.join(targetRoot, "fusion-production-materialization.json");
  const receipt = await readJson<FusionMaterializationReceipt | null>(receiptPath, null);
  if (!receipt) return undefined;
  if (receipt.kind !== "fusion-production-materialization" || receipt.sourceContentAddress !== manifest.contentAddress || path.resolve(receipt.targetRoot) !== targetRoot) {
    throw new Error(`内容寻址目标已存在但不属于当前融合包：${targetRoot}`);
  }
  for (const file of receipt.ownedFiles) {
    const absolute = path.resolve(targetRoot, file.relativePath);
    if (!isSameOrInside(absolute, targetRoot)) throw new Error(`物化清单含越界路径：${file.relativePath}`);
    const digest = await sha256File(absolute).catch(() => undefined);
    if (!digest || digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
      throw new Error(`内容寻址目标中的不可变基线文件发生冲突：${file.relativePath}`);
    }
  }
  if (stableOwnedDigest(receipt.ownedFiles) !== receipt.ownedFilesSha256) throw new Error("物化回执 ownedFiles 摘要失配。 ");
  const paths = getSidecarPaths(targetRoot);
  const [storedManifest, assetCatalog, continuity] = await Promise.all([
    readJson<FusionProjectManifest | null>(paths.fusionProjectManifest, null),
    readJson<FusionProductionAssetCatalog | null>(paths.productionAssets, null),
    readJson<FusionContinuityStore | null>(paths.continuityTracks, null),
  ]);
  if (!storedManifest || storedManifest.manifestSha256 !== manifest.manifestSha256 || !assetCatalog || !continuity) {
    throw new Error("内容寻址目标的工作侧车缺失或与当前 manifest 冲突。 ");
  }
  return { created: false, targetRoot, manifest: storedManifest, receipt, assetCatalog, continuity };
}

export async function loadFusionProjectManifest(projectRoot: string): Promise<FusionProjectManifest | null> {
  return readJson(getSidecarPaths(projectRoot).fusionProjectManifest, null);
}

export async function loadFusionProductionAssets(projectRoot: string): Promise<FusionProductionAssetCatalog | null> {
  return readJson(getSidecarPaths(projectRoot).productionAssets, null);
}

export async function loadFusionContinuityStore(projectRoot: string): Promise<FusionContinuityStore | null> {
  return readJson(getSidecarPaths(projectRoot).continuityTracks, null);
}

export async function materializeFusionProject(options: MaterializeFusionProjectOptions): Promise<MaterializeFusionProjectResult> {
  const inspection = options.inspection;
  const manifest = createFusionProjectManifest(inspection);
  const targetParent = await canonicalTargetParent(options.targetParent, inspection.sourceRoot);
  const targetRoot = path.join(targetParent, manifest.directoryName);
  const existingStats = await lstat(targetRoot).catch(() => undefined);
  if (existingStats) {
    if (!existingStats.isDirectory() || existingStats.isSymbolicLink()) throw new Error(`内容寻址目标冲突：${targetRoot}`);
    const existing = await verifyExistingMaterialization(targetRoot, manifest);
    if (!existing) throw new Error(`目标目录已存在但没有有效物化回执：${targetRoot}`);
    const refreshed = await inspectFusionPackage({
      packageRoot: inspection.packageRoot,
      sourceRoot: inspection.sourceRoot,
      expectedCounts: inspection.expectedCounts,
    });
    assertFusionSourceInventoryUnchanged(inspection.inventory, refreshed.inventory);
    return existing;
  }

  const authorityInputs = options.authorities ?? [];
  const authorityIds = new Set<string>();
  const authorityAssets = new Set<string>();
  for (const authority of authorityInputs) {
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/u.test(authority.id) || authorityIds.has(authority.id)) throw new Error(`权威输入 ID 非法或重复：${authority.id}`);
    authorityIds.add(authority.id);
    if (authority.assetId) {
      if (authorityAssets.has(authority.assetId)) throw new Error(`同一资产只能绑定一项最高权威输入：${authority.assetId}`);
      if (!inspection.assets.some((asset) => asset.id === authority.assetId)) throw new Error(`权威输入绑定了不存在的资产：${authority.assetId}`);
      authorityAssets.add(authority.assetId);
    }
  }
  const verifiedAuthorities = await Promise.all(authorityInputs.map(async (input) => ({ input, verified: await verifyAuthorityInput(input) })));
  const temporaryRoot = path.join(targetParent, `.${manifest.directoryName}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  const timestamp = new Date().toISOString();
  const ownedFiles: FusionMaterializedFileDigest[] = [];
  let temporaryCreated = false;
  const writeOwned = async (relativePath: string, content: string | Buffer, role: FusionMaterializedFileDigest["role"]): Promise<void> => {
    const portablePath = portable(relativePath);
    const absolute = path.join(temporaryRoot, ...portablePath.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    await writeFile(absolute, bytes, { flag: "wx" });
    ownedFiles.push({ relativePath: portablePath, bytes: bytes.byteLength, sha256: sha256(bytes), role });
  };
  const copyOwned = async (sourcePath: string, relativePath: string, role: FusionMaterializedFileDigest["role"]): Promise<void> => {
    const portablePath = portable(relativePath);
    const destination = path.join(temporaryRoot, ...portablePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
    const digest = await sha256File(destination);
    ownedFiles.push({ relativePath: portablePath, ...digest, role });
  };

  try {
    await mkdir(temporaryRoot);
    temporaryCreated = true;
    const authorities: MaterializedAuthorityReference[] = [];
    for (const { input, verified } of verifiedAuthorities) {
      const relativePath = path.join("authorities", input.id, path.basename(verified.canonicalPath));
      await copyOwned(verified.canonicalPath, relativePath, "authority");
      const copied = ownedFiles.at(-1)!;
      if (copied.sha256 !== verified.sha256 || copied.bytes !== verified.bytes) throw new Error(`权威输入隔离复制校验失败：${input.id}`);
      authorities.push({
        id: input.id,
        assetId: input.assetId,
        name: input.name,
        sourcePath: verified.canonicalPath,
        sourceSha256: verified.sha256,
        snapshotPath: path.join(targetRoot, ...portable(relativePath).split("/")),
        snapshotSha256: copied.sha256,
        rules: [...new Set(input.rules.map((rule) => rule.trim()).filter(Boolean))],
        exposeToGeneration: input.exposeToGeneration,
      });
    }

    for (const sourceFile of inspection.inventory.files) {
      const sourcePath = path.join(inspection.sourceRoot, ...sourceFile.relativePath.split("/"));
      const snapshotRelative = path.join("source_snapshot", ...sourceFile.relativePath.split("/"));
      await copyOwned(sourcePath, snapshotRelative, "source-snapshot");
      const copied = ownedFiles.at(-1)!;
      if (copied.bytes !== sourceFile.bytes || copied.sha256 !== sourceFile.sha256) throw new Error(`源快照校验失败：${sourceFile.relativePath}`);
    }

    const storyboardRows: StoryboardRow[] = [];
    const timeline: TimelineOverrides = { schemaVersion: 1, units: {} };
    for (const unit of inspection.units) {
      const sourceUnitPath = path.join(inspection.packageRoot, ...unit.markdownPath.split("/"));
      const markdown = await readFile(sourceUnitPath, "utf8");
      const directoryRelative = path.join("production", path.dirname(unit.markdownPath), path.basename(unit.markdownPath, path.extname(unit.markdownPath)));
      await writeOwned(path.join(directoryRelative, "00_信息.md"), markdown, "unit");
      const unitRows = storyboardRowsForUnit(unit, markdown, timestamp);
      storyboardRows.push(...unitRows);
      const shotRows = unitRows.filter((row) => row.shotItemId);
      for (const row of shotRows) {
        const shotNumber = Number(row.shotItemId?.match(/shot(\d+)$/u)?.[1]);
        await writeOwned(
          path.join(directoryRelative, `${unit.episode}_镜${String(shotNumber).padStart(2, "0")}.md`),
          shotInformation(unit, row, manifest.contentAddress),
          "shot",
        );
      }
      timeline.units[unitWorkItemId(unit)] = {
        shots: shotRows.map((row, order) => ({ shotId: row.shotItemId!, order, durationSeconds: row.durationSeconds })),
        updatedAt: timestamp,
      };
    }

    const assetEntries: FusionProductionAssetEntry[] = [];
    for (const definition of inspection.assets) {
      const authority = authorities.find((candidate) => candidate.assetId === definition.id);
      const promptOverride = definition.id === "C01"
        ? "严格使用阿航权威参考图中的同一张脸、黑色古代衣袍、发髻和左侧银白挑染；禁止赤红鬓发、灰褐衣、换脸、明星脸。生成电影级写实9:16角色参考图。"
        : definition.id === "C02"
          ? "严格使用嘟嘟权威参考图中的同一犬种、脸型、黑白棕花纹与白色卷尾；普通犬态，禁止拟人、换犬种、改花纹。生成电影级写实9:16角色参考图。"
          : definition.id === "P01"
            ? `生成不透明素麻胸前布囊参考图。完整黄金面具只能作为布囊内部身份来源，任何角度均不得露出实体、纹样、眼口或金色边缘；禁止半面具、裂面具和口型。\n${definition.generationPrompts[0]?.prompt ?? ""}`
            : undefined;
      const authorityReferences = authority?.exposeToGeneration
        ? [{ path: authority.snapshotPath, sha256: authority.snapshotSha256, role: "authority" as const }]
        : [];
      const contract = createAssetGenerationContract(definition, {
        promptOverride,
        authorityReferences,
        acceptanceRequirements: [
          "图片可解码、9:16竖屏、非占位图，raw/labeled 可追溯配对",
          "无字幕、水印、拼图、现代物或多余人物",
          "身份、服装、犬纹、道具结构与视觉 Bible 一致",
          ...(definition.id === "P01" ? ["布囊不透明且完整黄金面具绝不露出实体、眼口、裂缝或金色边缘"] : []),
        ],
      });
      const directoryRelative = path.join("assets", `${definition.id}_${safeName(definition.name)}`);
      const directoryPath = path.join(targetRoot, directoryRelative);
      const partial: Omit<FusionProductionAssetEntry, "infoPath"> = {
        workItemId: `asset-${definition.id}`,
        definition,
        contract,
        directoryPath,
        outputDirectory: path.join(directoryPath, "AI画布生成"),
        authority,
      };
      const infoRelative = path.join(directoryRelative, "00_信息.md");
      await writeOwned(infoRelative, assetInformation(partial), "asset-definition");
      await mkdir(path.join(temporaryRoot, directoryRelative, "AI画布生成"), { recursive: true });
      assetEntries.push({ ...partial, infoPath: path.join(targetRoot, infoRelative) });
    }

    const continuity: FusionContinuityStore = {
      schemaVersion: 1,
      kind: "fusion-continuity-tracks",
      sourceContentAddress: manifest.contentAddress,
      tracks: inspection.continuityTracks.map((track) => ({
        ...track,
        workItemId: `asset-${track.assetId}`,
        spans: track.spans.map((span) => ({
          ...span,
          unitItemId: unitWorkItemId(inspection.units.find((unit) => unit.id === span.unitId)!),
          shotItemIds: span.sourceShots.map((shot) => shotWorkItemId(inspection.units.find((unit) => unit.id === span.unitId)!, shot)),
        })),
      })),
      updatedAt: timestamp,
    };
    const assetCatalog: FusionProductionAssetCatalog = {
      schemaVersion: 1,
      kind: "fusion-production-assets",
      revision: 1,
      projectId: manifest.projectId,
      sourceContentAddress: manifest.contentAddress,
      assets: assetEntries,
      updatedAt: timestamp,
    };
    const storyboardStore: StoryboardStore = { schemaVersion: 1, revision: 1, rows: storyboardRows, updatedAt: timestamp };
    const visualBiblePath = path.join(targetRoot, "docs", "第三季视觉Bible.md");
    const visualBible = visualBibleMarkdown(authorities, manifest);
    await writeOwned(path.join("docs", "第三季视觉Bible.md"), visualBible, "visual-bible");
    await writeOwned("fusion-project-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "manifest");

    const sidecar = path.join(temporaryRoot, ".aicanvas");
    await mkdir(sidecar, { recursive: true });
    const sidecarPaths = getSidecarPaths(temporaryRoot);
    const config = createDefaultProjectConfig(targetRoot);
    config.id = manifest.projectId;
    config.name = "蜀道山·古蜀卷 第三季";
    config.primaryRoot = targetRoot;
    config.sourceRoots = [];
    config.outputRoots = [targetRoot];
    config.automation.imageBatchSize = 6;
    config.automation.videoBatchSize = 1;
    config.automation.pauseAfterVisualBatch = true;
    const bibleRecord: CreativeBible = {
      schemaVersion: 1,
      id: "bible-gushujuan-s3-visual",
      kind: "visual",
      name: "古蜀卷第三季视觉 Bible",
      summary: "锁定阿航、嘟嘟、完整黄金面具与商周时代视觉连续性；所有资产和分镜必须按显式引用与内容哈希生产。",
      rules: [
        "阿航同脸、黑衣、发髻、左侧银白挑染",
        "嘟嘟犬种、脸型、黑白棕花纹与白色卷尾固定",
        "完整黄金面具 EP32 前不露实体",
        "单镜参考最多6项且禁止静默丢弃",
      ],
      forbidden: ["半面具", "裂面具", "面具口型", "现代物", "字幕水印", "拼图分屏", "多余人物"],
      referencePaths: authorities.map((authority) => authority.snapshotPath),
      tags: ["古蜀卷第三季", "9:16", "电影写实", "hard-lock"],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await Promise.all([
      writeFile(sidecarPaths.config, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.fusionProjectManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.productionAssets, `${JSON.stringify(assetCatalog, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.continuityTracks, `${JSON.stringify(continuity, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.storyboards, `${JSON.stringify(storyboardStore, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.timeline, `${JSON.stringify(timeline, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.creativeBibles, `${JSON.stringify({ schemaVersion: 1, revision: 1, bibles: [bibleRecord], updatedAt: timestamp }, null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.generationSettings, `${JSON.stringify(defaultGenerationSettings(targetRoot, timestamp), null, 2)}\n`, { flag: "wx" }),
      writeFile(sidecarPaths.assetConsistencyBatches, `${JSON.stringify({ schemaVersion: 1, kind: "fusion-asset-consistency", projectId: manifest.projectId, sourceContentAddress: manifest.contentAddress, batchSize: 6, revision: 1, batches: [], updatedAt: timestamp }, null, 2)}\n`, { flag: "wx" }),
    ]);

    const refreshed = await inspectFusionPackage({
      packageRoot: inspection.packageRoot,
      sourceRoot: inspection.sourceRoot,
      expectedCounts: inspection.expectedCounts,
    });
    assertFusionSourceInventoryUnchanged(inspection.inventory, refreshed.inventory);
    for (const { input, verified } of verifiedAuthorities) {
      const after = await sha256File(verified.canonicalPath);
      if (after.sha256 !== verified.sha256 || after.bytes !== verified.bytes) throw new Error(`物化期间权威输入发生变化：${input.id}`);
    }
    ownedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
    const receipt: FusionMaterializationReceipt = {
      schemaVersion: 1,
      kind: "fusion-production-materialization",
      receiptId: `fusion-materialization-${manifest.manifestSha256.slice(0, 20)}`,
      createdAt: timestamp,
      sourceContentAddress: manifest.contentAddress,
      sourceInventorySha256: inspection.inventory.aggregateSha256,
      targetRoot,
      fusionManifestPath: path.join(targetRoot, "fusion-project-manifest.json"),
      assetCatalogPath: path.join(targetRoot, ".aicanvas", "production-assets.json"),
      continuityStorePath: path.join(targetRoot, ".aicanvas", "continuity-tracks.json"),
      storyboardStorePath: path.join(targetRoot, ".aicanvas", "storyboards.json"),
      visualBiblePath,
      authorities,
      ownedFiles,
      ownedFilesSha256: stableOwnedDigest(ownedFiles),
      counts: inspection.counts,
    };
    await writeFile(path.join(temporaryRoot, "fusion-production-materialization.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryRoot, targetRoot);
    temporaryCreated = false;
    return { created: true, targetRoot, manifest, receipt, assetCatalog, continuity };
  } catch (error) {
    if (temporaryCreated) await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
