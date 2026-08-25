import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { loadSharpDefault } from "./sharp-lazy.js";
import { completionIssues } from "./acceptance.js";
import { DEFAULT_PROJECT_ROOT, STATUS_PRIORITY } from "./constants.js";
import {
  loadCanonicalAssetStore,
  loadCanonicalAssetAuthorityProjectionForScanner,
  type CanonicalAssetPrimaryAuthoritySnapshot,
} from "./canonical-assets.js";
import { loadFusionProductionAssets, type FusionProductionAssetEntry } from "./fusion-production.js";
import { materializeAllFusionStoryboardGrids } from "./fusion-storyboard-production.js";
import {
  artifactAuthorityKey,
  buildFusionStoryboardProgress,
  buildFusionStoryboardReviewRequirement,
  currentFusionStoryboardArtifact,
  loadFusionStoryboardEvidenceSnapshot,
  type FusionStoryboardEvidenceSnapshot,
} from "./fusion-storyboard-evidence.js";
import { MEDIA_WEIGHTS, mediaStageTimeout, runMediaProcess } from "./media-runtime.js";
import { listPublicationIntents } from "./publication.js";
import { reviewCoversAnyArtifact, reviewCoversArtifacts, reviewCoversFusionStoryboardRequirement, reviewEvidencePaths } from "./review-evidence.js";
import { ensureSidecar, getSidecarPaths, loadProjectConfig, loadOverrides, readJson } from "./sidecar.js";
import type {
  Artifact,
  ArtifactKind,
  ArtifactVariant,
  MechanicalCheck,
  ProgressSummary,
  ProjectConfig,
  ProjectIndex,
  HardLock,
  ReviewRecord,
  ReviewStore,
  StatusOverride,
  WorkItem,
  WorkItemStatus,
} from "./types.js";
import { WORK_ITEM_STATUSES } from "./types.js";

const SCAN_PATTERNS = [
  "**/00_信息.md",
  "**/EP*15s*.md",
  "**/EP*15s*.txt",
  "**/EP*镜*.md",
  "**/EP*镜*.txt",
  "**/*_raw.png",
  "**/*_labeled.png",
  "**/*中文分镜故事板*.png",
  "**/*中文分镜故事板*.svg",
  "**/*中文分镜故事板*.json",
  "**/*中文分镜板*.png",
  "**/*中文分镜板*.svg",
  "**/*中文分镜板*.json",
  "**/*.{mp4,mov,webm,m4v}",
  "**/*.{wav,mp3,m4a,aac,flac,ogg}",
  "**/shot_manifest.json",
];
const INSPECTION_VERSION = 1;
const INSPECTION_CONCURRENCY = 6;

interface ParsedIdentity {
  id: string;
  type: "unit" | "shot" | "episode";
  episode: number;
  unit?: number;
  shot?: string;
  scope: string;
  parentId?: string;
}

interface Candidate {
  absolutePath: string;
  relativePath: string;
  sourceRoot: string;
  rootSlot: string;
  identity: ParsedIdentity;
  kind: ArtifactKind;
  variant: ArtifactVariant;
  deprecated: boolean;
  content?: string;
  title: string;
  fusionStoryboardPanel?: Artifact["fusionStoryboardPanel"];
  fusionStoryboardSheet?: Artifact["fusionStoryboardSheet"];
}

interface MutableGroup {
  identity: ParsedIdentity;
  candidates: Candidate[];
}

interface ReferenceAsset extends HardLock {
  locked: boolean;
  labeledPath?: string;
}

type ReviewPhase = "image" | "video";

interface ReviewOverrideValidation {
  issues: string[];
  fallback?: WorkItemStatus;
}

function authoritativeImageArtifacts(item: WorkItem, artifacts: Artifact[]): Array<Artifact | undefined> {
  if (item.fusionStoryboard) {
    return item.fusionStoryboard.panels.flatMap((panel) => [
      artifacts.find((artifact) => artifact.id === panel.rawArtifactId),
      artifacts.find((artifact) => artifact.id === panel.labeledArtifactId),
    ]);
  }
  const active = artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
  const find = (kind: ArtifactKind, variants: ArtifactVariant[]) => active.find((artifact) => artifact.kind === kind && variants.includes(artifact.variant));
  if (item.type === "asset") {
    const raw = find("raw-image", ["generic"]);
    const labeled = find("labeled-image", ["generic"]);
    return labeled ? [raw, labeled] : [raw];
  }
  if (item.type === "shot") return [find("raw-image", ["generic", "start"]), find("labeled-image", ["generic", "start"])];
  return [
    find("raw-image", ["start"]),
    find("labeled-image", ["start"]),
    find("raw-image", ["end"]),
    find("labeled-image", ["end"]),
  ];
}

function phaseRecord(
  phase: ReviewPhase,
  override: StatusOverride,
  itemRecords: ReviewRecord[],
  currentArtifacts: Array<Artifact | undefined>,
): ReviewRecord | undefined {
  const explicitId = override.reviewEvidenceIds?.[phase];
  if (explicitId) return itemRecords.find((record) => record.id === explicitId && record.reviewType === phase);
  const current = override.statusEvidenceId ? itemRecords.find((record) => record.id === override.statusEvidenceId) : undefined;
  if (current?.reviewType === phase) return current;
  // 兼容还没有 reviewEvidenceIds 的旧侧车，但只迁移仍能逐内容匹配当前素材的 pass。
  return itemRecords.find((record) => record.reviewType === phase && record.decision === "pass" && (
    phase === "image" ? reviewCoversArtifacts(record, currentArtifacts) : reviewCoversAnyArtifact(record, currentArtifacts.filter((artifact): artifact is Artifact => Boolean(artifact)))
  ));
}

function recordCoversOwnSelection(record: ReviewRecord | undefined, artifacts: Artifact[]): boolean {
  if (!record) return false;
  return reviewCoversArtifacts(record, record.artifactIds.map((artifactId) => artifacts.find((artifact) => artifact.id === artifactId)));
}

function reviewStatusOverrideValidation(
  item: WorkItem,
  artifacts: Artifact[],
  override: StatusOverride,
  records: ReviewRecord[],
  fusionEvidence: FusionStoryboardEvidenceSnapshot,
): ReviewOverrideValidation {
  if (!override.status) return { issues: [] };
  const itemRecords = records.filter((record) => record.itemId === item.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const statusRecord = override.statusEvidenceId
    ? itemRecords.find((candidate) => candidate.id === override.statusEvidenceId)
    : itemRecords.find((candidate) => candidate.resultingStatus === override.status);
  const reviewDerived = override.statusAuthority === "review" || (!override.statusAuthority && Boolean(statusRecord));
  const imageArtifacts = authoritativeImageArtifacts(item, artifacts);
  const videos = artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && artifact.kind === "video");
  const imageRecord = phaseRecord("image", override, itemRecords, imageArtifacts);
  const videoRecord = phaseRecord("video", override, itemRecords, videos);
  const imageRequirement = buildFusionStoryboardReviewRequirement(item, artifacts, fusionEvidence);
  const imagePassValid = Boolean(imageRecord?.decision === "pass" && (
    imageRequirement
      ? reviewCoversFusionStoryboardRequirement(imageRecord, imageRequirement, artifacts)
      : reviewCoversArtifacts(imageRecord, imageArtifacts)
  ));
  const videoPassValid = Boolean(videoRecord?.decision === "pass" && reviewCoversAnyArtifact(videoRecord, videos));
  const videoRework = override.status === "返工" && statusRecord?.reviewType === "video";
  const requiresImagePass = item.type === "asset" || item.type === "shot"
    ? override.status === "已完成"
    : ["待视频", "视频生成中", "待视频验收", "已完成"].includes(override.status) || videoRework;
  const requiresVideoPass = item.type === "unit" && override.status === "已完成";
  const issues: string[] = [];
  if (imageRequirement && override.reviewRequirementIds?.image && override.reviewRequirementIds.image !== imageRequirement.id) {
    issues.push("图片视觉验收 requirement 已变化");
  }

  if (reviewDerived && (!statusRecord || statusRecord.resultingStatus !== override.status || !recordCoversOwnSelection(statusRecord, artifacts))) {
    issues.push("视觉验收状态缺少匹配当前素材内容的不可变验收记录");
  }
  if (requiresImagePass && !imagePassValid) issues.push("当前权威图片缺少仍有效的视觉通过证据");
  if (requiresVideoPass && !videoPassValid) issues.push("当前权威视频缺少仍有效的视觉通过证据");
  if (!issues.length) return { issues };
  if (requiresImagePass && !imagePassValid) return { issues, fallback: "待视觉验收" };
  if (requiresVideoPass && !videoPassValid) return { issues, fallback: "待视频验收" };
  if (reviewDerived) return { issues, fallback: statusRecord?.reviewType === "video" && imagePassValid ? "待视频验收" : "待视觉验收" };
  return { issues };
}

function reviewRecordsNeededForHashing(overrides: Record<string, StatusOverride>, records: ReviewRecord[]): ReviewRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const selected = new Map<string, ReviewRecord>();
  for (const [itemId, override] of Object.entries(overrides)) {
    const explicitIds = [override.statusEvidenceId, ...Object.values(override.reviewEvidenceIds ?? {})].filter((id): id is string => Boolean(id));
    for (const id of explicitIds) {
      const record = byId.get(id);
      if (record) selected.set(record.id, record);
    }
    // 旧侧车没有相位 ID 时，只检查每相位最新 pass 与当前状态记录，避免永久哈希全部历史。
    const itemRecords = records.filter((record) => record.itemId === itemId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const phase of ["image", "video"] as const) {
      const record = itemRecords.find((candidate) => candidate.reviewType === phase && candidate.decision === "pass");
      if (record) selected.set(record.id, record);
    }
    const statusRecord = itemRecords.find((record) => record.resultingStatus === override.status);
    if (statusRecord) selected.set(statusRecord.id, statusRecord);
  }
  return [...selected.values()];
}

export interface ScanOptions {
  projectRoot?: string;
  persist?: boolean;
  includeHashes?: boolean;
  includeHashPaths?: string[];
  configOverride?: ProjectConfig;
  previousIndex?: ProjectIndex | null;
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

export interface ScanProgress {
  phase: "discover" | "read-text" | "inspect" | "build";
  discoveredFiles: number;
  candidateFiles: number;
  reservedPublicationFilesSkipped: number;
  inspectedChecks: number;
  reusedChecks: number;
  completedChecks: number;
  totalChecks: number;
}

export async function scanProject(options: ScanOptions = {}): Promise<ProjectIndex> {
  const projectRoot = path.resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  return scanProjectAfterDiscoveryPublicationSnapshot({ ...options, projectRoot });
}

interface ReservedPublicationSnapshot {
  targets: Set<string>;
  warning?: string;
}

async function loadReservedPublicationSnapshot(projectRoot: string, tolerateFailure = false): Promise<ReservedPublicationSnapshot> {
  try {
    const intents = await listPublicationIntents(projectRoot, "reserved");
    return { targets: new Set(intents.map((intent) => path.resolve(intent.targetPath))) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!tolerateFailure) throw new Error(`发布预留侧车无法读取，已停止扫描以保留上一份完整索引：${reason}`);
    return { targets: new Set(), warning: `无法读取发布预留快照；扫描可能看到写入中的输出：${reason}` };
  }
}

async function scanProjectAfterDiscoveryPublicationSnapshot(options: ScanOptions): Promise<ProjectIndex> {
  const startedAt = Date.now();
  throwIfScanAborted(options.signal);
  const projectRoot = path.resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const config = options.configOverride ?? (options.persist === false ? await loadProjectConfig(projectRoot) : await ensureSidecar(projectRoot));
  const scanRoots = [...new Set([projectRoot, ...config.sourceRoots.map((root) => path.resolve(root))])];
  const fusionAssetCatalog = await loadFusionProductionAssets(projectRoot);
  const canonicalAuthorityProjection = await loadCanonicalAssetAuthorityProjectionForScanner(projectRoot);
  const canonicalStore = canonicalAuthorityProjection ? await loadCanonicalAssetStore(projectRoot) : null;
  const canonicalAuthoritiesByAssetId = new Map(canonicalAuthorityProjection?.assets.map((entry) => [entry.assetId, entry]) ?? []);
  const canonicalAssetsById = new Map(canonicalStore?.assets.map((entry) => [entry.id, entry]) ?? []);
  const fusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
  const fusionEvidenceValidationWarnings: string[] = [];
  if (fusionEvidence.selections.size) {
    try {
      // 全季选择必须共享一次 manifest/storyboard/asset 输入快照。逐合同调用
      // validateFusionStoryboardGridAgainstCurrent 会把同一 1288 单元数据重复读取
      // 1288 次，正式工程一次 preview scan 会超过两分钟。
      const current = await materializeAllFusionStoryboardGrids(projectRoot, { persist: false });
      const currentContractIds = new Set(current.contractIds);
      for (const [itemId, selected] of fusionEvidence.selections) {
        if (currentContractIds.has(selected.contract.contractId)) continue;
        fusionEvidence.selections.delete(itemId);
        fusionEvidenceValidationWarnings.push(`${itemId} 当前宫格合同已与实时 storyboard 失配：批量重建未得到同一内容寻址合同`);
      }
    } catch (error) {
      for (const itemId of fusionEvidence.selections.keys()) {
        fusionEvidenceValidationWarnings.push(`${itemId} 当前宫格合同无法完成全季批量验真：${error instanceof Error ? error.message : String(error)}`);
      }
      fusionEvidence.selections.clear();
    }
  }
  let fusionSheetSnapshot: Awaited<ReturnType<typeof import("./fusion-storyboard-sheet-store.js").listFusionStoryboardSheetArtifactSnapshot>> = {
    storeRevision: 0,
    items: [],
    byPath: {},
  };
  const fusionSheetWarnings: string[] = [];
  try {
    const [{ loadFusionStoryboardSheetStore, listFusionStoryboardSheetArtifactSnapshot }, { inspectFusionStoryboardSheetEvidence }] = await Promise.all([
      import("./fusion-storyboard-sheet-store.js"),
      import("./fusion-storyboard-sheet-evidence.js"),
    ]);
    const sheetStore = await loadFusionStoryboardSheetStore(projectRoot);
    const currentEvidenceByItemId: Record<string, import("./fusion-storyboard-sheet-store.js").FusionStoryboardSheetCurrentEvidence | undefined> = {};
    for (const itemId of Object.keys(sheetStore.currentByItemId).sort()) {
      try { currentEvidenceByItemId[itemId] = (await inspectFusionStoryboardSheetEvidence(projectRoot, { itemId })).currentEvidence; }
      catch (error) { fusionSheetWarnings.push(`${itemId} 当前 P4 成板证据无法验真：${error instanceof Error ? error.message : String(error)}`); }
    }
    fusionSheetSnapshot = await listFusionStoryboardSheetArtifactSnapshot(projectRoot, { currentEvidenceByItemId, verifyFiles: true });
  } catch (error) {
    fusionSheetWarnings.push(`P4 中文分镜板 store 无法读取，全部 sheet Artifact 已失败关闭：${error instanceof Error ? error.message : String(error)}`);
  }
  const discoveredReferenceAssets = await discoverReferenceAssets(scanRoots, config, options.signal);
  const overrides = await loadOverrides(projectRoot);
  const reviewStore = await readJson<ReviewStore>(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] });
  const forcedHashPaths = new Set([
    ...(options.includeHashPaths ?? []),
    ...reviewEvidencePaths(reviewRecordsNeededForHashing(overrides.items, reviewStore.records)),
  ].map((candidate) => path.resolve(candidate)));
  const warnings: string[] = [];
  warnings.push(...fusionEvidence.warnings);
  warnings.push(...fusionEvidenceValidationWarnings);
  warnings.push(...fusionSheetWarnings);
  const scanStats = {
    discoveredFiles: 0,
    candidateFiles: 0,
    reservedPublicationFilesSkipped: 0,
    referenceAssets: 0,
    productionAssets: fusionAssetCatalog?.assets.length ?? 0,
    inspectedChecks: 0,
    reusedChecks: 0,
    textFilesRead: 0,
    includeHashes: options.includeHashes ?? false,
    inspectionConcurrency: INSPECTION_CONCURRENCY,
  };
  const reportProgress = (phase: ScanProgress["phase"], totalChecks = 0) => options.onProgress?.({
    phase,
    discoveredFiles: scanStats.discoveredFiles,
    candidateFiles: scanStats.candidateFiles,
    reservedPublicationFilesSkipped: scanStats.reservedPublicationFilesSkipped,
    inspectedChecks: scanStats.inspectedChecks,
    reusedChecks: scanStats.reusedChecks,
    completedChecks: scanStats.inspectedChecks + scanStats.reusedChecks,
    totalChecks,
  });

  const scannedFiles: Array<{ sourceRoot: string; rootSlot: string; relativePath: string; absolutePath: string }> = [];
  const seenPaths = new Set<string>();
  for (const [rootIndex, sourceRoot] of scanRoots.entries()) {
    throwIfScanAborted(options.signal);
    const rootSlot = rootIndex === 0 ? "main" : `source-${String(rootIndex).padStart(2, "0")}`;
    const relativeFiles = await fg(SCAN_PATTERNS, {
      cwd: sourceRoot,
      onlyFiles: true,
      unique: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ["**/.aicanvas/**", "**/.git/**", "**/__pycache__/**", "**/node_modules/**"],
    });
    throwIfScanAborted(options.signal);
    for (const relativePath of relativeFiles) {
      const absolutePath = path.resolve(sourceRoot, relativePath);
      if (seenPaths.has(absolutePath)) continue;
      seenPaths.add(absolutePath);
      scannedFiles.push({ sourceRoot, rootSlot, relativePath, absolutePath });
    }
    scanStats.discoveredFiles = scannedFiles.length;
    reportProgress("discover");
  }
  // 正式 P4 receipt 位于受控 .aicanvas/storyboard-sheets；它不会被普通
  // glob 扫描。这里只把 store 已登记的精确路径加入候选，不放宽为扫描整棵
  // sidecar，也让缺失成员继续以 invalid Artifact 留在索引中。
  for (const sheetArtifact of fusionSheetSnapshot.items) {
    const absolutePath = path.resolve(sheetArtifact.path);
    const relativePath = path.relative(projectRoot, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      warnings.push(`P4 sheet Artifact 越出隔离工程，未加入画布索引：${absolutePath}`);
      continue;
    }
    if (seenPaths.has(absolutePath)) continue;
    seenPaths.add(absolutePath);
    scannedFiles.push({ sourceRoot: projectRoot, rootSlot: "sheet-store", relativePath, absolutePath });
  }
  scanStats.discoveredFiles = scannedFiles.length;
  reportProgress("discover");

  // 必须在普通素材与参考资产的路径发现完成后再读取原子发布快照。若预留已
  // 存在，写入中目标会在快照中；若预留在快照之后才建立，其目标在发现时
  // 必然尚不存在，因此不会进入本轮候选。无需长时间持有 publications 锁，
  // 大项目哈希/ffprobe 也不会阻塞已完成结果的发布注册。
  const publicationSnapshot = await loadReservedPublicationSnapshot(projectRoot, options.persist === false);
  if (publicationSnapshot.warning) warnings.push(publicationSnapshot.warning);
  const skippedReservedPaths = new Set<string>();
  const catalogAssetIds = new Set(fusionAssetCatalog?.assets.map((entry) => entry.definition.id) ?? []);
  const catalogManagedPaths = new Set((fusionAssetCatalog?.assets ?? [])
    .map((entry) => entry.authority?.snapshotPath)
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value)));
  const referenceAssets = discoveredReferenceAssets.filter((asset) => {
    if (catalogAssetIds.has(asset.id) || catalogManagedPaths.has(path.resolve(asset.path))) return false;
    const reserved = [asset.path, asset.labeledPath]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => publicationSnapshot.targets.has(candidate));
    for (const candidate of reserved) skippedReservedPaths.add(candidate);
    return reserved.length === 0;
  });
  const configuredHardLockIds = new Set(config.hardLocks.map((lock) => lock.id));
  const effectiveConfig: ProjectConfig = {
    ...config,
    hardLocks: [
      ...config.hardLocks,
      ...referenceAssets.filter((asset) => asset.locked && !configuredHardLockIds.has(asset.id)),
    ],
  };
  scanStats.referenceAssets = referenceAssets.length;
  scanStats.reservedPublicationFilesSkipped = skippedReservedPaths.size;

  const candidates: Candidate[] = [];
  for (const scanned of scannedFiles) {
    throwIfScanAborted(options.signal);
    const { sourceRoot, rootSlot, relativePath, absolutePath } = scanned;
    if (publicationSnapshot.targets.has(absolutePath)) {
      skippedReservedPaths.add(absolutePath);
      scanStats.reservedPublicationFilesSkipped = skippedReservedPaths.size;
      reportProgress("read-text");
      continue;
    }
    const fallbackScope = rootSlot;
    const sheetSnapshot = fusionSheetSnapshot.byPath[path.resolve(absolutePath)];
    const identity = parseIdentity(relativePath, fallbackScope, effectiveConfig)
      ?? (sheetSnapshot ? parseStoredUnitIdentity(sheetSnapshot.itemId) : null);
    if (!identity) continue;
    const kind: ArtifactKind = sheetSnapshot
      ? ({ png: "storyboard-sheet-png", svg: "storyboard-sheet-svg", receipt: "storyboard-sheet-receipt" } as const)[sheetSnapshot.role]
      : classifyArtifact(relativePath);
    let content: string | undefined;
    if (kind === "info" || kind === "prompt" || kind === "manifest" || kind === "storyboard-sheet-receipt") {
      scanStats.textFilesRead += 1;
      content = await readTextSafely(absolutePath, options.signal);
      throwIfScanAborted(options.signal);
    }
    const sheetRole = kind === "storyboard-sheet-png" ? "png"
      : kind === "storyboard-sheet-svg" ? "svg"
        : kind === "storyboard-sheet-receipt" ? "receipt"
          : undefined;
    const fusionStoryboardSheet: Artifact["fusionStoryboardSheet"] = sheetSnapshot ? {
      schemaVersion: 1,
      type: "fusion-storyboard-sheet",
      sheetId: sheetSnapshot.sheetId,
      inputFingerprint: sheetSnapshot.inputFingerprint,
      contractId: sheetSnapshot.contractId,
      requirementId: sheetSnapshot.requirementId,
      reviewId: sheetSnapshot.reviewId,
      role: sheetSnapshot.role,
      pageIndex: sheetSnapshot.pageIndex,
      pageCount: sheetSnapshot.pageCount,
      status: sheetSnapshot.status,
      reasons: [...sheetSnapshot.reasons],
    } : sheetRole ? {
      schemaVersion: 1,
      type: "fusion-storyboard-sheet",
      sheetId: `orphan-sheet-${createHash("sha256").update(path.resolve(absolutePath)).digest("hex").slice(0, 32)}`,
      contractId: path.basename(absolutePath).match(/(grid-[a-f0-9]{20})/u)?.[1] ?? "orphan-unknown-contract",
      role: sheetRole,
      pageCount: 1,
      status: "invalid",
      reasons: ["orphan-sheet-file-not-registered-in-p4-store"],
    } : undefined;
    candidates.push({
      absolutePath,
      relativePath,
      sourceRoot,
      rootSlot,
      identity,
      kind,
      variant: classifyVariant(relativePath),
      // 已登记 P4 Artifact 的生命周期由 sheet store 派生，不能因为受控
      // `.aicanvas/storyboard-sheets` 路径命中通用忽略段而误判为弃用。
      deprecated: sheetSnapshot ? false : isDeprecatedPath(relativePath, effectiveConfig.ignoreSegments),
      content,
      title: deriveTitle(relativePath, identity),
      fusionStoryboardPanel: (() => {
        const binding = fusionEvidence.bindingsByPath.get(path.resolve(absolutePath));
        return binding?.kind === kind ? binding.binding : undefined;
      })(),
      fusionStoryboardSheet,
    });
    scanStats.candidateFiles = candidates.length;
    reportProgress("read-text");
  }

  const groups = new Map<string, MutableGroup>();
  for (const candidate of candidates) {
    const current = groups.get(candidate.identity.id) ?? { identity: candidate.identity, candidates: [] };
    current.candidates.push(candidate);
    groups.set(candidate.identity.id, current);
  }
  for (const group of groups.values()) {
    const roots = [...new Set(group.candidates.map((candidate) => candidate.sourceRoot))];
    if (roots.length > 1) warnings.push(`${group.identity.id} 在多个来源根中出现，已按版本规则合并：${roots.join("；")}`);
  }

  const catalogFiles = new Map<string, Array<{ path: string; kind: "raw-image" | "labeled-image" }>>();
  for (const entry of fusionAssetCatalog?.assets ?? []) {
    const files: Array<{ path: string; kind: "raw-image" | "labeled-image" }> = [];
    const canonicalAuthority = canonicalAuthoritiesByAssetId.get(entry.definition.id);
    if (canonicalAuthority && !publicationSnapshot.targets.has(path.resolve(canonicalAuthority.path))) {
      files.push({ path: path.resolve(canonicalAuthority.path), kind: "raw-image" });
      if (canonicalAuthority.labeledPath && !publicationSnapshot.targets.has(path.resolve(canonicalAuthority.labeledPath))) {
        files.push({ path: path.resolve(canonicalAuthority.labeledPath), kind: "labeled-image" });
      }
    } else if (!canonicalStore && entry.authority?.snapshotPath && !publicationSnapshot.targets.has(path.resolve(entry.authority.snapshotPath))) {
      files.push({ path: path.resolve(entry.authority.snapshotPath), kind: "raw-image" });
    }
    for (const scanned of scannedFiles) {
      const absolute = path.resolve(scanned.absolutePath);
      if (publicationSnapshot.targets.has(absolute)) continue;
      const relative = path.relative(path.resolve(entry.outputDirectory), absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (/_raw\.png$/iu.test(absolute)) files.push({ path: absolute, kind: "raw-image" });
      else if (/_labeled\.png$/iu.test(absolute)) files.push({ path: absolute, kind: "labeled-image" });
    }
    const seenCatalogMembers = new Set<string>();
    catalogFiles.set(entry.workItemId, files.filter((file) => {
      const key = `${file.kind}:${path.resolve(file.path)}`;
      if (seenCatalogMembers.has(key)) return false;
      seenCatalogMembers.add(key);
      return true;
    }));
  }

  const previousChecks = indexPreviousChecks(options.previousIndex);
  const totalChecks = candidates.length
    + referenceAssets.reduce((total, reference) => total + 1 + (reference.labeledPath ? 1 : 0), 0)
    + [...catalogFiles.values()].reduce((total, files) => total + files.length, 0);
  const checkArtifact = async (filePath: string, kind: ArtifactKind): Promise<MechanicalCheck> => {
    throwIfScanAborted(options.signal);
    const result = await inspectArtifactIncrementally(projectRoot, filePath, kind, (options.includeHashes ?? false) || forcedHashPaths.has(path.resolve(filePath)), previousChecks.get(previousCheckKey(filePath, kind)), options.signal);
    if (result.reused) scanStats.reusedChecks += 1;
    else scanStats.inspectedChecks += 1;
    reportProgress("inspect", totalChecks);
    throwIfScanAborted(options.signal);
    return result.check;
  };
  const artifactChecks = await mapLimit(candidates, INSPECTION_CONCURRENCY, async (candidate) => {
    const check = await checkArtifact(candidate.absolutePath, candidate.kind);
    return [candidate.absolutePath, check] as const;
  }, options.signal);
  const checks = new Map(artifactChecks);

  const artifacts: Artifact[] = [];
  const items: WorkItem[] = [];
  for (const group of groups.values()) {
    throwIfScanAborted(options.signal);
    const groupArtifacts = buildArtifacts(group, checks, effectiveConfig.id);
    selectAuthority(groupArtifacts, group.candidates);
    for (const artifact of groupArtifacts) {
      if (artifact.fusionStoryboardPanel && !currentFusionStoryboardArtifact(artifact, fusionEvidence)) artifact.authoritative = false;
    }
    artifacts.push(...groupArtifacts);
    const item = buildWorkItem(group, groupArtifacts, effectiveConfig, fusionEvidence);
    const override = overrides.items[item.id];
    if (override?.authoritativePath || override?.authoritativeArtifactId) {
      const selected = groupArtifacts.find((artifact) => artifact.id === override.authoritativeArtifactId) ?? groupArtifacts.find((artifact) => artifact.path === override.authoritativePath);
      if (selected) {
        const selectedKey = artifactAuthorityKey(selected);
        for (const artifact of groupArtifacts.filter((artifact) => artifactAuthorityKey(artifact) === selectedKey)) {
          artifact.authoritative = artifact.path === selected.path;
        }
      }
      item.thumbnailPath = chooseThumbnail(groupArtifacts);
    }
    if (override?.authoritativePaths || override?.authoritativeArtifactIds) {
      const keys = new Set([...Object.keys(override.authoritativePaths ?? {}), ...Object.keys(override.authoritativeArtifactIds ?? {})]);
      for (const key of keys) {
        const selectedPath = override.authoritativePaths?.[key];
        const selectedId = override.authoritativeArtifactIds?.[key];
        for (const artifact of groupArtifacts.filter((candidate) => artifactAuthorityKey(candidate) === key)) {
          artifact.authoritative = artifact.id === selectedId || (!selectedId && artifact.path === selectedPath);
        }
      }
      item.thumbnailPath = chooseThumbnail(groupArtifacts);
    }
    for (const artifact of groupArtifacts) {
      if (artifact.fusionStoryboardPanel && !currentFusionStoryboardArtifact(artifact, fusionEvidence)) artifact.authoritative = false;
      if (artifact.fusionStoryboardSheet) {
        if (!artifact.check.ok || artifact.deprecated) {
          artifact.fusionStoryboardSheet = {
            ...artifact.fusionStoryboardSheet,
            status: "invalid",
            reasons: [...new Set([
              ...artifact.fusionStoryboardSheet.reasons,
              ...(artifact.deprecated ? ["sheet-artifact-deprecated"] : []),
              ...artifact.check.issues.map((issue) => `sheet-artifact-mechanical-failure:${issue}`),
            ])],
          };
        }
        // P4 成板权威只由内容寻址 store + 当前证据派生。人工路径/Artifact
        // override 不能把 stale、invalid、legacy-invalid、损坏或弃用文件重新
        // 抬升为权威，否则旧板会绕过 Review/Publication/SHA 失效门禁。
        artifact.authoritative = artifact.fusionStoryboardSheet.status === "current"
          && artifact.check.ok
          && !artifact.deprecated;
        artifact.accepted = artifact.authoritative;
      }
    }
    if (groupArtifacts.some((artifact) => artifact.fusionStoryboardSheet)) item.thumbnailPath = chooseThumbnail(groupArtifacts);
    if (item.fusionStoryboard) item.fusionStoryboard = buildFusionStoryboardProgress(item.id, groupArtifacts, fusionEvidence);
    if (override?.status) {
      const reviewValidation = reviewStatusOverrideValidation(item, groupArtifacts, override, reviewStore.records, fusionEvidence);
      const overrideIssues = [
        ...(override.status === "已完成" ? completionIssues(item, groupArtifacts) : []),
        ...reviewValidation.issues,
      ];
      if (overrideIssues.length === 0) item.status = override.status;
      else {
        item.status = reviewValidation.fallback ?? item.status;
        const reason = `“${override.status}”覆盖已忽略：${overrideIssues.join("；")}`;
        item.failureReason = item.failureReason ? `${item.failureReason}；${reason}` : reason;
        warnings.push(`${item.id} ${reason}`);
      }
    }
    if (item.fusionStoryboard) {
      const imageRequirement = buildFusionStoryboardReviewRequirement(item, groupArtifacts, fusionEvidence);
      const imageEvidenceId = override?.reviewEvidenceIds?.image;
      const imageRecord = imageEvidenceId
        ? reviewStore.records.find((record) => record.id === imageEvidenceId)
        : reviewStore.records.find((record) => record.itemId === item.id && record.reviewType === "image" && record.decision === "pass");
      item.fusionStoryboard.visuallyApproved = Boolean(imageRequirement && reviewCoversFusionStoryboardRequirement(imageRecord, imageRequirement, groupArtifacts));
      if (item.fusionStoryboard.visuallyApproved) {
        item.fusionStoryboard.panels = item.fusionStoryboard.panels.map((panel) => ({ ...panel, state: "approved" }));
      }
    }
    item.priority = STATUS_PRIORITY[item.status];
    items.push(item);
  }

  for (const reference of referenceAssets) {
    throwIfScanAborted(options.signal);
    const id = `asset-${reference.id}`;
    const assetArtifacts: Artifact[] = [];
    for (const assetFile of [
      { path: reference.path, kind: "raw-image" as const },
      ...(reference.labeledPath ? [{ path: reference.labeledPath, kind: "labeled-image" as const }] : []),
    ]) {
      const check = await checkArtifact(assetFile.path, assetFile.kind);
      const matchingRootIndex = scanRoots.findIndex((root) => assetFile.path === root || assetFile.path.startsWith(`${root}${path.sep}`));
      const rootSlot = matchingRootIndex <= 0 ? "main" : `source-${String(matchingRootIndex).padStart(2, "0")}`;
      const relativePath = matchingRootIndex >= 0 ? path.relative(scanRoots[matchingRootIndex]!, assetFile.path) : `external/${reference.id}/${path.basename(assetFile.path)}`;
      const artifactId = artifactIdFor(id, rootSlot, relativePath);
      assetArtifacts.push({
        id: artifactId,
        uri: `aicanvas://projects/${effectiveConfig.id}/artifacts/${artifactId}`,
        itemId: id,
        path: assetFile.path,
        rootSlot,
        relativePath,
        kind: assetFile.kind,
        variant: "generic",
        versionLabel: reference.locked ? "硬锁" : "项目资产",
        deprecated: false,
        authoritative: true,
        accepted: check.ok,
        modifiedAt: await getModifiedAt(assetFile.path),
        check,
      });
    }
    artifacts.push(...assetArtifacts);
    const mechanicalIssues = completionIssues({ type: "asset" }, assetArtifacts);
    const inferredStatus: WorkItemStatus = mechanicalIssues.length ? "阻塞" : reference.locked ? "已完成" : "待视觉验收";
    const item: WorkItem = {
      id,
      type: "asset",
      title: reference.name,
      status: inferredStatus,
      inferredStatus,
      stage: "硬锁资产",
      priority: STATUS_PRIORITY[inferredStatus],
      sourcePaths: [reference.path, ...(reference.labeledPath ? [reference.labeledPath] : [])],
      infoExcerpt: reference.note,
      nextAction: mechanicalIssues.length
        ? "修复缺失或损坏的项目资产"
        : reference.locked
          ? "保持权威参考，不得静默替换"
          : "提交绑定当前内容的资产图片视觉验收",
      failureReason: mechanicalIssues.length ? mechanicalIssues.join("；") : undefined,
      hardLockIds: reference.locked ? [reference.id] : [],
      artifactIds: assetArtifacts.map((artifact) => artifact.id),
      thumbnailPath: assetArtifacts.find((artifact) => artifact.kind === "labeled-image" && artifact.check.ok)?.path
        ?? assetArtifacts.find((artifact) => artifact.kind === "raw-image" && artifact.check.ok)?.path,
      dependencies: [],
      updatedAt: new Date().toISOString(),
    };
    const override = overrides.items[item.id];
    if (override?.status) {
      const reviewValidation = reviewStatusOverrideValidation(item, assetArtifacts, override, reviewStore.records, fusionEvidence);
      const overrideIssues = [
        ...(override.status === "已完成" ? completionIssues(item, assetArtifacts) : []),
        ...reviewValidation.issues,
      ];
      if (overrideIssues.length === 0) item.status = override.status;
      else {
        item.status = reviewValidation.fallback ?? item.status;
        const reason = `“${override.status}”覆盖已忽略：${overrideIssues.join("；")}`;
        item.failureReason = item.failureReason ? `${item.failureReason}；${reason}` : reason;
        warnings.push(`${item.id} ${reason}`);
      }
    }
    item.priority = STATUS_PRIORITY[item.status];
    items.push(item);
  }

  for (const entry of fusionAssetCatalog?.assets ?? []) {
    throwIfScanAborted(options.signal);
    const itemArtifacts: Artifact[] = [];
    const canonicalAsset = canonicalAssetsById.get(entry.definition.id);
    const canonicalAuthority = canonicalAuthoritiesByAssetId.get(entry.definition.id);
    for (const file of catalogFiles.get(entry.workItemId) ?? []) {
      const check = await checkArtifact(file.path, file.kind);
      const relativePath = path.relative(projectRoot, file.path);
      const artifactId = artifactIdFor(entry.workItemId, "main", relativePath);
      itemArtifacts.push({
        id: artifactId,
        uri: `aicanvas://projects/${effectiveConfig.id}/artifacts/${artifactId}`,
        itemId: entry.workItemId,
        path: file.path,
        rootSlot: "main",
        relativePath,
        kind: file.kind,
        variant: "generic",
        versionLabel: canonicalAuthority && [canonicalAuthority.path, canonicalAuthority.labeledPath].filter(Boolean).some((candidate) => path.resolve(candidate!) === path.resolve(file.path))
          ? "规范主权威"
          : !canonicalStore && entry.authority && path.resolve(entry.authority.snapshotPath) === path.resolve(file.path)
            ? "用户授权权威"
          : deriveVersionLabel(relativePath),
        deprecated: isDeprecatedPath(relativePath, effectiveConfig.ignoreSegments),
        authoritative: false,
        accepted: false,
        modifiedAt: await getModifiedAt(file.path),
        check,
      });
    }
    selectFusionAssetAuthority(entry, itemArtifacts, overrides.items[entry.workItemId], canonicalAuthority, Boolean(canonicalStore));
    artifacts.push(...itemArtifacts);
    const active = itemArtifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
    const authoritativeRaw = active.find((artifact) => artifact.kind === "raw-image" && artifact.variant === "generic");
    const authoritativeLabeled = active.find((artifact) => artifact.kind === "labeled-image" && artifact.variant === "generic");
    const candidateRaw = authoritativeRaw ?? itemArtifacts.filter((artifact) => artifact.kind === "raw-image" && !artifact.deprecated).sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0];
    const candidateLabeled = authoritativeLabeled ?? itemArtifacts.filter((artifact) => artifact.kind === "labeled-image" && !artifact.deprecated).sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0];
    const configuredLock = canonicalStore ? undefined : effectiveConfig.hardLocks.find((lock) => authoritativeRaw && path.resolve(lock.path) === path.resolve(authoritativeRaw.path));
    const explicitAuthority = canonicalStore
      ? Boolean(canonicalAuthority && authoritativeRaw && path.resolve(canonicalAuthority.path) === path.resolve(authoritativeRaw.path))
      : Boolean(entry.authority && authoritativeRaw && path.resolve(entry.authority.snapshotPath) === path.resolve(authoritativeRaw.path));
    const mechanicalIssues = candidateRaw ? completionIssues({ type: "asset" }, canonicalAuthority ? active : [candidateRaw, ...(candidateLabeled ? [candidateLabeled] : [])]) : [];
    let inferredStatus: WorkItemStatus;
    if (!candidateRaw) inferredStatus = "待首帧";
    else if (mechanicalIssues.length || (!explicitAuthority && !candidateLabeled)) inferredStatus = "待机械验收";
    else if (explicitAuthority || configuredLock) inferredStatus = "已完成";
    else inferredStatus = "待视觉验收";
    const item: WorkItem = {
      id: entry.workItemId,
      type: "asset",
      assetCategory: canonicalAsset?.category ?? entry.definition.category,
      title: `${entry.definition.id} ${canonicalAsset?.canonicalName ?? entry.definition.name}`,
      status: inferredStatus,
      inferredStatus,
      stage: "硬锁资产",
      priority: STATUS_PRIORITY[inferredStatus],
      sourcePaths: [entry.infoPath, ...itemArtifacts.map((artifact) => artifact.path)],
      infoPath: entry.infoPath,
      infoExcerpt: `${entry.definition.category}｜${entry.definition.declaredUsage}\n${entry.contract.prompt}`.slice(0, 6_000),
      nextAction: inferredStatus === "待首帧"
        ? "按冻结的资产生成合同加入图片队列"
        : inferredStatus === "待机械验收"
          ? "完成 raw/labeled 配对与图片机械验收"
          : inferredStatus === "待视觉验收"
            ? "提交绑定当前内容哈希的资产图片视觉验收"
            : "保持权威参考；依赖分镜可按显式引用使用",
      failureReason: mechanicalIssues.length ? mechanicalIssues.join("；") : undefined,
      hardLockIds: explicitAuthority ? [entry.definition.id] : configuredLock ? [configuredLock.id] : [],
      artifactIds: itemArtifacts.map((artifact) => artifact.id),
      thumbnailPath: candidateLabeled?.check.ok ? candidateLabeled.path : candidateRaw?.check.ok ? candidateRaw.path : undefined,
      dependencies: [],
      updatedAt: new Date().toISOString(),
    };
    const override = overrides.items[item.id];
    if (override?.status && !explicitAuthority && !canonicalStore) {
      const reviewValidation = reviewStatusOverrideValidation(item, itemArtifacts, override, reviewStore.records, fusionEvidence);
      const overrideIssues = [
        ...(override.status === "已完成" ? completionIssues(item, itemArtifacts) : []),
        ...reviewValidation.issues,
      ];
      if (overrideIssues.length === 0) item.status = override.status;
      else {
        item.status = reviewValidation.fallback ?? item.status;
        const reason = `“${override.status}”覆盖已忽略：${overrideIssues.join("；")}`;
        item.failureReason = item.failureReason ? `${item.failureReason}；${reason}` : reason;
        warnings.push(`${item.id} ${reason}`);
      }
    }
    item.priority = STATUS_PRIORITY[item.status];
    items.push(item);
  }

  inheritParentContext(items);
  applySequentialDependencies(items);
  items.sort(compareItems);
  const summary = summarize(items, artifacts);
  if (scanStats.reservedPublicationFilesSkipped > 0) {
    warnings.push(`已跳过 ${scanStats.reservedPublicationFilesSkipped} 个仍处于发布预留状态的写入中输出；发布进入终态后，下次扫描会重新纳入。`);
  }
  if (scannedFiles.length > 0 && groups.size === 0) warnings.push("发现素材文件，但没有识别出 EP/15 秒/镜头编号。");

  throwIfScanAborted(options.signal);
  reportProgress("build", totalChecks);
  return {
    schemaVersion: 1,
    project: effectiveConfig,
    scanId: randomUUID(),
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - startedAt,
    scanStats,
    warnings,
    summary,
    items,
    artifacts,
  };
}

function selectFusionAssetAuthority(
  entry: FusionProductionAssetEntry,
  artifacts: Artifact[],
  override?: StatusOverride,
  canonicalAuthority?: CanonicalAssetPrimaryAuthoritySnapshot,
  canonicalMode = false,
): void {
  for (const artifact of artifacts) artifact.authoritative = false;
  if (canonicalMode) {
    if (!canonicalAuthority) return;
    const raw = artifacts.find((artifact) => artifact.kind === "raw-image"
      && path.resolve(artifact.path) === path.resolve(canonicalAuthority.path)
      && artifact.check.sha256 === canonicalAuthority.sha256);
    if (raw) raw.authoritative = true;
    if (canonicalAuthority.labeledPath && canonicalAuthority.labeledSha256) {
      const labeled = artifacts.find((artifact) => artifact.kind === "labeled-image"
        && path.resolve(artifact.path) === path.resolve(canonicalAuthority.labeledPath!)
        && artifact.check.sha256 === canonicalAuthority.labeledSha256);
      if (labeled) labeled.authoritative = true;
    }
    return;
  }
  const byNewest = (kind: "raw-image" | "labeled-image") => artifacts
    .filter((artifact) => artifact.kind === kind && !artifact.deprecated)
    .sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime() || right.path.localeCompare(left.path))[0];
  let raw = entry.authority
    ? artifacts.find((artifact) => artifact.kind === "raw-image" && path.resolve(artifact.path) === path.resolve(entry.authority!.snapshotPath))
    : undefined;
  raw ??= byNewest("raw-image");
  const selectedRawId = override?.authoritativeArtifactIds?.["raw-image:generic"];
  const selectedRawPath = override?.authoritativePaths?.["raw-image:generic"];
  if (selectedRawId || selectedRawPath) {
    raw = artifacts.find((artifact) => artifact.kind === "raw-image" && (
      artifact.id === selectedRawId || (selectedRawPath !== undefined && path.resolve(artifact.path) === path.resolve(selectedRawPath))
    )) ?? raw;
  }
  if (raw) raw.authoritative = true;
  let labeled = raw
    ? artifacts.find((artifact) => artifact.kind === "labeled-image"
      && path.basename(artifact.path).replace(/_labeled\.png$/iu, "") === path.basename(raw!.path).replace(/_raw\.png$/iu, ""))
    : undefined;
  labeled ??= byNewest("labeled-image");
  const selectedLabeledId = override?.authoritativeArtifactIds?.["labeled-image:generic"];
  const selectedLabeledPath = override?.authoritativePaths?.["labeled-image:generic"];
  if (selectedLabeledId || selectedLabeledPath) {
    labeled = artifacts.find((artifact) => artifact.kind === "labeled-image" && (
      artifact.id === selectedLabeledId || (selectedLabeledPath !== undefined && path.resolve(artifact.path) === path.resolve(selectedLabeledPath))
    )) ?? labeled;
  }
  if (labeled) labeled.authoritative = true;
}

async function discoverReferenceAssets(scanRoots: string[], config: ProjectConfig, signal?: AbortSignal): Promise<ReferenceAsset[]> {
  const discovered: string[] = [];
  const seen = new Set<string>();
  for (const scanRoot of scanRoots) {
    throwIfScanAborted(signal);
    const matches = await fg(
      [
        "**/00_全剧资产锁定/01_人物三视图/*.{png,jpg,jpeg,webp}",
        "**/00_全剧资产锁定/02_场景三视图/*.{png,jpg,jpeg,webp}",
        "**/01_硬锁参考图/*.{png,jpg,jpeg,webp}",
      ],
      {
        cwd: scanRoot,
        onlyFiles: true,
        unique: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: ["**/旧版/**", "**/弃用/**", "**/备份/**", "**/.aicanvas/**"],
      },
    );
    throwIfScanAborted(signal);
    for (const relativePath of matches) {
      const absolutePath = path.resolve(scanRoot, relativePath);
      if (!seen.has(absolutePath)) { seen.add(absolutePath); discovered.push(absolutePath); }
    }
  }
  const pairKey = (absolutePath: string) => {
    const extension = path.extname(absolutePath);
    const stem = path.basename(absolutePath, extension).replace(/_(?:raw|labeled)$/i, "");
    return path.join(path.dirname(absolutePath), stem);
  };
  const pairs = new Map<string, { rawPath?: string; labeledPath?: string }>();
  for (const absolutePath of discovered.sort((a, b) => a.localeCompare(b))) {
    const key = pairKey(absolutePath);
    const pair = pairs.get(key) ?? {};
    if (/_labeled\.(?:png|jpe?g|webp)$/i.test(absolutePath)) pair.labeledPath ??= absolutePath;
    else pair.rawPath ??= absolutePath;
    pairs.set(key, pair);
  }
  const explicitPairKeys = new Set(config.hardLocks.map((lock) => pairKey(path.resolve(lock.path))));
  const configured = config.hardLocks.map((lock): ReferenceAsset => ({
    ...lock,
    locked: true,
    labeledPath: pairs.get(pairKey(path.resolve(lock.path)))?.labeledPath,
  }));
  const automatic = [...pairs.entries()]
    .filter(([key, pair]) => Boolean(pair.rawPath) && !explicitPairKeys.has(key))
    .map(([key, pair]): ReferenceAsset => {
      const absolutePath = pair.rawPath!;
      const basename = path.basename(absolutePath);
      const locked = /硬锁|锁定|权威|最终/.test(basename) && !/候选/.test(basename);
      return {
        id: `auto-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`,
        name: basename.replace(/_(?:raw|labeled)(?=\.(?:png|jpe?g|webp)$)/i, "").replace(/\.(png|jpe?g|webp)$/i, ""),
        path: absolutePath,
        labeledPath: pair.labeledPath,
        note: locked
          ? "项目目录内自动发现的权威参考；任务只在镜头文本命中时携带。"
          : "项目目录内自动发现的参考资产；可在项目设置中提升为显式硬锁。",
        locked,
      };
    });
  return [...configured, ...automatic];
}

function identityFromParts(type: "unit" | "shot", episode: number, unit: number | undefined, shot: string | undefined, scope: string): ParsedIdentity | null {
  if (!Number.isInteger(episode) || episode < 1) return null;
  if (type === "unit") {
    if (!Number.isInteger(unit) || !unit || unit < 1) return null;
    return { id: `${scope}-ep${pad(episode, 2)}-unit${pad(unit, 3)}`, type, episode, unit, scope };
  }
  if (!shot) return null;
  const shotNumber = shot.toUpperCase();
  const parentId = Number.isInteger(unit) && unit! > 0 ? `${scope}-ep${pad(episode, 2)}-unit${pad(unit!, 3)}` : undefined;
  return { id: parentId ? `${parentId}-shot${shotNumber.toLowerCase()}` : `${scope}-ep${pad(episode, 2)}-shot${shotNumber.toLowerCase()}`, type, episode, unit, shot: shotNumber, scope, parentId };
}

function parseConfiguredIdentity(normalized: string, fallbackScope: string, config: ProjectConfig): ParsedIdentity | null {
  const naming = config.namingRules ?? { patterns: [], manualMappings: [] };
  const manual = [...naming.manualMappings].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length).find((mapping) => {
    const prefix = mapping.pathPrefix.normalize("NFKC").replaceAll("\\", "/").replace(/^\/+/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
  if (manual) return identityFromParts(manual.type, manual.episode, manual.unit, manual.shot, manual.scope || deriveScope(normalized, fallbackScope));
  for (const rule of naming.patterns) {
    let match: RegExpMatchArray | null = null;
    try { match = normalized.match(new RegExp(rule.pattern, "i")); } catch { continue; }
    if (!match) continue;
    const groups = match.groups ?? {};
    const episode = Number(groups.episode ?? match[1]);
    const unit = Number(groups.unit ?? (rule.type === "unit" ? match[2] : groups.unit));
    const shot = String(groups.shot ?? (rule.type === "shot" ? match[2] : "")).trim() || undefined;
    const identity = identityFromParts(rule.type, episode, Number.isFinite(unit) ? unit : undefined, shot, rule.scope || deriveScope(normalized, fallbackScope));
    if (identity) return identity;
  }
  return null;
}

function parseIdentity(relativePath: string, fallbackScope = "main", config?: ProjectConfig): ParsedIdentity | null {
  const normalized = relativePath.normalize("NFKC").replaceAll("\\", "/");
  const configured = config ? parseConfiguredIdentity(normalized, fallbackScope, config) : null;
  if (configured) return configured;
  const scope = deriveScope(normalized, fallbackScope);
  const unit = normalized.match(/EP\s*0*(\d{1,3}).{0,20}?15s[_\-\s]*0*(\d{1,4})/i);
  const shotMatches = [...normalized.matchAll(/(?:^|\/)EP\s*0*(\d{1,3})[_\-\s]*镜\s*0*(\d{1,4}[A-Z]?)/gi)];
  const shot = shotMatches.at(-1);
  if (shot) {
    const episode = Number(shot[1]);
    const shotNumber = shot[2]!.toUpperCase();
    const parentUnit = unit && Number(unit[1]) === episode ? Number(unit[2]) : undefined;
    const parentId = parentUnit === undefined ? undefined : `${scope}-ep${pad(episode, 2)}-unit${pad(parentUnit, 3)}`;
    return {
      id: parentId ? `${parentId}-shot${shotNumber.toLowerCase()}` : `${scope}-ep${pad(episode, 2)}-shot${shotNumber.toLowerCase()}`,
      type: "shot",
      episode,
      unit: parentUnit,
      shot: shotNumber,
      scope,
      parentId,
    };
  }
  if (unit) {
    const episode = Number(unit[1]);
    const unitNumber = Number(unit[2]);
    return {
      id: `${scope}-ep${pad(episode, 2)}-unit${pad(unitNumber, 3)}`,
      type: "unit",
      episode,
      unit: unitNumber,
      scope,
    };
  }
  const episodeMatch = normalized.match(/EP\s*0*(\d{1,3})/i);
  if (episodeMatch && normalized.endsWith("shot_manifest.json")) {
    const episode = Number(episodeMatch[1]);
    return { id: `${scope}-ep${pad(episode, 2)}`, type: "episode", episode, scope };
  }
  return null;
}

function parseStoredUnitIdentity(itemId: string): ParsedIdentity | null {
  const match = itemId.match(/^(.+)-ep(\d{2,3})-unit(\d{3,4})$/u);
  if (!match) return null;
  const episode = Number(match[2]);
  const unit = Number(match[3]);
  if (!Number.isInteger(episode) || episode < 1 || !Number.isInteger(unit) || unit < 1) return null;
  return { id: itemId, type: "unit", episode, unit, scope: match[1]! };
}

function deriveScope(relativePath: string, fallbackScope = "main"): string {
  const season = relativePath.match(/第([一二三四五六七八九十百0-9]+)季/);
  if (season) return `season-${season[1]}`;
  if (relativePath.includes("封神篇")) return "fengshen";
  return fallbackScope;
}

function classifyArtifact(filePath: string): ArtifactKind {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "00_信息.md") return "info";
  if (basename === "shot_manifest.json") return "manifest";
  if (/中文分镜(?:故事)?板.*\.png$/iu.test(basename)) return "storyboard-sheet-png";
  if (/中文分镜(?:故事)?板.*\.svg$/iu.test(basename)) return "storyboard-sheet-svg";
  if (/中文分镜(?:故事)?板.*\.json$/iu.test(basename)) return "storyboard-sheet-receipt";
  if (/_raw\.png$/i.test(basename)) return "raw-image";
  if (/_labeled\.png$/i.test(basename)) return "labeled-image";
  if (/\.(mp4|mov|webm|m4v)$/i.test(basename)) return "video";
  if (/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(basename)) return "audio";
  if (/\.(md|txt)$/i.test(basename)) return "prompt";
  return "other";
}

function classifyVariant(filePath: string): ArtifactVariant {
  if (/首帧/i.test(filePath)) return "start";
  if (/尾帧/i.test(filePath)) return "end";
  return "generic";
}

function isDeprecatedPath(relativePath: string, segments: string[]): boolean {
  const normalized = relativePath.toLowerCase();
  return /不合格|废弃|失败版本|reject(ed)?/i.test(normalized) || segments.some((segment) => normalized.includes(segment.toLowerCase()));
}

function deriveTitle(relativePath: string, identity: ParsedIdentity): string {
  const filename = path.basename(relativePath).replace(/\.(md|txt|png|mp4|mov|webm|json)$/i, "");
  const dirname = path.basename(path.dirname(relativePath));
  const source = filename === "00_信息" || filename === "shot_manifest" ? dirname : filename;
  const cleaned = source
    .replace(/_(首帧|尾帧)?_?(raw|labeled)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (cleaned && /EP/i.test(cleaned)) return cleaned;
  if (identity.type === "unit") return `EP${pad(identity.episode, 2)} · 15s ${pad(identity.unit ?? 0, 3)}`;
  if (identity.type === "shot") return `EP${pad(identity.episode, 2)} · 镜${identity.shot}`;
  return `EP${pad(identity.episode, 2)}`;
}

async function readTextSafely(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    throwIfScanAborted(signal);
    const fileStat = await stat(filePath);
    if (fileStat.size > 2_000_000) return undefined;
    const content = await readFile(filePath, { encoding: "utf8", signal });
    throwIfScanAborted(signal);
    return content;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function previousCheckKey(filePath: string, kind: ArtifactKind): string {
  return `${path.resolve(filePath)}\0${kind}`;
}

function indexPreviousChecks(index: ProjectIndex | null | undefined): Map<string, MechanicalCheck> {
  const checks = new Map<string, MechanicalCheck>();
  for (const artifact of index?.artifacts ?? []) checks.set(previousCheckKey(artifact.path, artifact.kind), artifact.check);
  return checks;
}

async function inspectArtifactIncrementally(
  projectRoot: string,
  filePath: string,
  kind: ArtifactKind,
  includeHash: boolean,
  previous: MechanicalCheck | undefined,
  signal?: AbortSignal,
): Promise<{ check: MechanicalCheck; reused: boolean }> {
  throwIfScanAborted(signal);
  let fileStat: Stats;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { check: { inspectionVersion: INSPECTION_VERSION, ok: false, exists: false, size: 0, issues: ["文件不存在"] }, reused: false };
  }
  throwIfScanAborted(signal);
  const modifiedAt = fileStat.mtime.toISOString();
  if (
    previous?.inspectionVersion === INSPECTION_VERSION
    && previous.exists
    && previous.size === fileStat.size
    && previous.modifiedAt === modifiedAt
    && previous.ctimeMs === fileStat.ctimeMs
    && (!includeHash || Boolean(previous.sha256))
  ) return { check: previous, reused: true };
  return { check: await inspectArtifact(projectRoot, filePath, kind, includeHash, fileStat, signal), reused: false };
}

async function inspectArtifact(
  projectRoot: string,
  filePath: string,
  kind: ArtifactKind,
  includeHash: boolean,
  knownStat?: Stats,
  signal?: AbortSignal,
): Promise<MechanicalCheck> {
  try {
    throwIfScanAborted(signal);
    const fileStat = knownStat ?? await stat(filePath);
    const issues: string[] = [];
    if (fileStat.size === 0) issues.push("零字节文件");
    const imageKind = kind === "raw-image" || kind === "labeled-image" || kind === "storyboard-sheet-png";
    if (imageKind && fileStat.size < 10_000) issues.push("图片体积过小，疑似占位图");
    let width: number | undefined;
    let height: number | undefined;
    let duration: number | undefined;
    let decodable: boolean | undefined;
    if (imageKind) {
      try {
        const metadata = await (await loadSharpDefault())(filePath, { failOn: "error" }).metadata();
        throwIfScanAborted(signal);
        width = metadata.width;
        height = metadata.height;
        decodable = Boolean(width && height);
        if (!decodable) issues.push("图片无法解码");
        if ((width ?? 0) < 256 || (height ?? 0) < 256) issues.push("图片尺寸小于 256px");
      } catch (error) {
        if (isAbortError(error)) throw error;
        decodable = false;
        issues.push("图片无法解码");
      }
    }
    if (kind === "storyboard-sheet-svg") {
      try {
        const content = await readFile(filePath, { encoding: "utf8", signal });
        throwIfScanAborted(signal);
        const externalReference = /(?:href|xlink:href)\s*=\s*["'](?:https?:|file:|\/\/)/iu.test(content);
        const unsafeMarkup = /<!DOCTYPE|<script(?:\s|>)|<foreignObject(?:\s|>)/iu.test(content);
        decodable = /<svg(?:\s|>)[\s\S]*<\/svg>/iu.test(content) && !externalReference && !unsafeMarkup;
        if (!decodable) issues.push("中文分镜板 SVG 结构无效");
      } catch (error) {
        if (isAbortError(error)) throw error;
        decodable = false;
        issues.push("中文分镜板 SVG 无法读取");
      }
    }
    if (kind === "storyboard-sheet-receipt") {
      try {
        const parsed = JSON.parse(await readFile(filePath, { encoding: "utf8", signal })) as { schemaVersion?: unknown; kind?: unknown };
        throwIfScanAborted(signal);
        decodable = (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)
          && (parsed.kind === "fusion-storyboard-sheet-production-receipt"
            || parsed.kind === "fusion-storyboard-sheet-production-receipt-v2"
            || parsed.kind === "fusion-storyboard-sheet-record");
        if (!decodable) issues.push("中文分镜板 receipt 结构或版本无效");
      } catch (error) {
        if (isAbortError(error)) throw error;
        decodable = false;
        issues.push("中文分镜板 receipt 无法解析");
      }
    }
    if (kind === "video") {
      if (fileStat.size < 50_000) issues.push("视频体积过小，疑似无效文件");
      try {
        const result = await runMediaProcess(process.env.FFPROBE_PATH || "ffprobe", [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,codec_name:format=duration",
          "-of", "json",
          filePath,
        ], { projectRoot, tool: "ffprobe", stage: "scan-video", weight: MEDIA_WEIGHTS.probe, timeoutMs: mediaStageTimeout("ffprobe"), signal, maxOutputBytes: 1_000_000 });
        throwIfScanAborted(signal);
        if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "ffprobe 探测超时" : result.output || `ffprobe 退出码 ${result.code}`);
        const probe = JSON.parse(result.stdout) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }>; format?: { duration?: string } };
        const stream = probe.streams?.[0];
        width = stream?.width;
        height = stream?.height;
        duration = Number(probe.format?.duration);
        decodable = Boolean(stream?.codec_name && width && height && Number.isFinite(duration) && duration > 0);
        if (!decodable) issues.push("视频无可解码画面流或有效时长");
        if ((width ?? 0) < 256 || (height ?? 0) < 256) issues.push("视频尺寸小于 256px");
      } catch (error) {
        if (isAbortError(error)) throw error;
        decodable = false;
        issues.push("ffprobe 无法解析视频");
      }
    }
    if (kind === "audio") {
      if (fileStat.size < 1_000) issues.push("音频体积过小，疑似无效文件");
      try {
        const result = await runMediaProcess(process.env.FFPROBE_PATH || "ffprobe", [
          "-v", "error",
          "-select_streams", "a:0",
          "-show_entries", "stream=codec_name:format=duration",
          "-of", "json",
          filePath,
        ], { projectRoot, tool: "ffprobe", stage: "scan-audio", weight: MEDIA_WEIGHTS.probe, timeoutMs: mediaStageTimeout("ffprobe"), signal, maxOutputBytes: 1_000_000 });
        throwIfScanAborted(signal);
        if (result.status !== "succeeded") throw new Error(result.status === "timed_out" ? "ffprobe 探测超时" : result.output || `ffprobe 退出码 ${result.code}`);
        const probe = JSON.parse(result.stdout) as { streams?: Array<{ codec_name?: string }>; format?: { duration?: string } };
        duration = Number(probe.format?.duration);
        decodable = Boolean(probe.streams?.[0]?.codec_name && Number.isFinite(duration) && duration > 0);
        if (!decodable) issues.push("音频无可解码音轨或有效时长");
      } catch (error) {
        if (isAbortError(error)) throw error;
        decodable = false;
        issues.push("ffprobe 无法解析音频");
      }
    }
    let sha256: string | undefined;
    if (includeHash || kind === "storyboard-sheet-png" || kind === "storyboard-sheet-svg" || kind === "storyboard-sheet-receipt") {
      sha256 = await hashFile(filePath, signal);
    }
    return {
      inspectionVersion: INSPECTION_VERSION,
      ok: issues.length === 0,
      exists: true,
      decodable,
      width,
      height,
      duration,
      size: fileStat.size,
      sha256,
      modifiedAt: fileStat.mtime.toISOString(),
      ctimeMs: fileStat.ctimeMs,
      issues,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { inspectionVersion: INSPECTION_VERSION, ok: false, exists: false, size: 0, issues: ["文件不存在"] };
  }
}

function buildArtifacts(group: MutableGroup, checks: Map<string, MechanicalCheck>, projectId: string): Artifact[] {
  return group.candidates.map((candidate) => ({
    id: artifactIdFor(group.identity.id, candidate.rootSlot, candidate.relativePath),
    uri: `aicanvas://projects/${projectId}/artifacts/${artifactIdFor(group.identity.id, candidate.rootSlot, candidate.relativePath)}`,
    itemId: group.identity.id,
    path: candidate.absolutePath,
    rootSlot: candidate.rootSlot,
    relativePath: candidate.relativePath,
    kind: candidate.kind,
    variant: candidate.variant,
    versionLabel: candidate.fusionStoryboardSheet
      ? `P4 ${candidate.fusionStoryboardSheet.status}`
      : deriveVersionLabel(candidate.relativePath),
    deprecated: candidate.deprecated,
    authoritative: false,
    accepted: candidate.fusionStoryboardSheet
      ? candidate.fusionStoryboardSheet.status === "current"
      : Boolean(candidate.content && isAcceptedText(candidate.content)),
    modifiedAt: checks.get(candidate.absolutePath)?.modifiedAt ?? new Date(0).toISOString(),
    check: checks.get(candidate.absolutePath) ?? { ok: false, exists: false, size: 0, issues: ["未完成验收"] },
    fusionStoryboardPanel: candidate.fusionStoryboardPanel,
    fusionStoryboardSheet: candidate.fusionStoryboardSheet,
  }));
}

function selectAuthority(artifacts: Artifact[], candidates: Candidate[]): void {
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.absolutePath, candidate]));
  const groups = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const key = artifactAuthorityKey(artifact);
    const list = groups.get(key) ?? [];
    list.push(artifact);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list[0]?.fusionStoryboardSheet) {
      const current = list
        .filter((artifact) => artifact.fusionStoryboardSheet?.status === "current" && artifact.check.ok && !artifact.deprecated)
        .sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime());
      if (current[0]) current[0].authoritative = true;
      continue;
    }
    list.sort((a, b) => {
      const scoreDifference = authorityScore(b, candidateByPath.get(b.path)) - authorityScore(a, candidateByPath.get(a.path));
      return scoreDifference || new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });
    if (list[0]) list[0].authoritative = true;
  }
}

function authorityScore(artifact: Artifact, candidate?: Candidate): number {
  let score = artifact.deprecated ? -20_000 : 10_000;
  if (artifact.accepted) score += 8_000;
  const value = candidate?.relativePath ?? artifact.path;
  if (/权威|最终|定稿/.test(value)) score += 3_000;
  if (/新版|新提示词|20260712/.test(value)) score += 2_000;
  if (artifact.check.ok) score += 500;
  return score;
}

function deriveVersionLabel(relativePath: string): string {
  if (/不合格|失败版本|rejected?/i.test(relativePath)) return "不合格版本";
  if (/旧版|弃用|废弃/i.test(relativePath)) return "弃用版本";
  if (/备份/i.test(relativePath)) return "备份版本";
  if (/权威|最终|定稿/i.test(relativePath)) return "权威版本";
  if (/新版|新提示词/i.test(relativePath)) return "新版";
  const date = relativePath.match(/20\d{6}/)?.[0];
  return date ? `版本 ${date}` : "当前版本";
}

function buildWorkItem(
  group: MutableGroup,
  artifacts: Artifact[],
  config: ProjectConfig,
  fusionEvidence: FusionStoryboardEvidenceSnapshot,
): WorkItem {
  const activeArtifacts = artifacts.filter((artifact) => !artifact.deprecated);
  const infoCandidates = group.candidates
    .filter((candidate) => candidate.kind === "info" || candidate.kind === "prompt")
    .sort((a, b) => authorityScoreForCandidate(b) - authorityScoreForCandidate(a));
  const primaryInfo = infoCandidates[0];
  const allText = infoCandidates.map((candidate) => candidate.content ?? "").join("\n");
  const fusionStoryboard = group.identity.type === "unit"
    ? buildFusionStoryboardProgress(group.identity.id, artifacts, fusionEvidence)
    : undefined;
  const inferredStatus = inferStatus(group.identity.type, artifacts, allText, fusionStoryboard);
  const status = inferredStatus;
  const title = primaryInfo?.title ?? group.candidates[0]?.title ?? group.identity.id;
  const hardLockIds = relevantHardLockIds(config.hardLocks, `${title}\n${primaryInfo?.content ?? ""}`);
  const issueText = activeArtifacts.flatMap((artifact) => artifact.check.issues).filter(Boolean);
  return {
    id: group.identity.id,
    parentId: group.identity.parentId,
    type: group.identity.type,
    title,
    episode: group.identity.episode,
    unit: group.identity.unit,
    shot: group.identity.shot,
    status,
    inferredStatus,
    stage: stageForStatus(status),
    priority: STATUS_PRIORITY[status],
    sourcePaths: [...new Set(group.candidates.map((candidate) => candidate.absolutePath))],
    infoPath: primaryInfo?.absolutePath,
    infoExcerpt: primaryInfo?.content ? compactExcerpt(primaryInfo.content) : undefined,
    nextAction: fusionStoryboard && status === "待尾帧"
      ? `完成当前合同缺失宫格：${fusionStoryboard.panels.filter((panel) => ["missing", "queued", "generating", "generation_unknown", "candidate_review", "visual_rejected"].includes(panel.state)).map((panel) => String(panel.panelIndex).padStart(2, "0")).join("、")}`
      : nextActionForItem(group.identity.type, status),
    failureReason: issueText.length ? [...new Set(issueText)].join("；") : undefined,
    hardLockIds,
    artifactIds: artifacts.map((artifact) => artifact.id),
    thumbnailPath: chooseThumbnail(artifacts),
    dependencies: [],
    updatedAt: new Date().toISOString(),
    fusionStoryboard,
  };
}

function relevantHardLockIds(hardLocks: HardLock[], sourceText: string): string[] {
  const haystack = sourceText.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const generic = new Set(["三视图", "动漫", "写实", "硬锁", "锁定", "参考", "候选", "场景", "角色", "道具", "正面", "背面", "侧面", "全身", "版本", "最终", "派生", "设定", "真人", "raw"]);
  return hardLocks
    .filter((lock) => {
      if (/全局|每个镜头|全剧通用/.test(lock.note)) return true;
      const cleaned = lock.name
        .normalize("NFKC")
        .replace(/^([A-Z]+\d+|\d+)[_\-\s]*/i, "")
        .replace(/\.(png|jpe?g|webp)$/i, "");
      const terms = cleaned
        .split(/[_\-\s·，,（）()]+/)
        .map((term) => term.replace(/(动漫|写实)?三视图|动漫设定|硬锁|锁定|候选|最终|版本|正面|背面|左侧|右侧|全身|派生|权威脸源|透明抠图|raw|v\d+$/gi, ""))
        .filter((term) => term.length >= 2 && !generic.has(term) && !/^[a-z0-9]+$/i.test(term));
      return terms.some((term) => haystack.includes(term.toLowerCase()));
    })
    .map((lock) => lock.id);
}

function authorityScoreForCandidate(candidate: Candidate): number {
  let score = candidate.deprecated ? -10_000 : 10_000;
  if (candidate.content && isAcceptedText(candidate.content)) score += 8_000;
  if (/权威|最终|定稿/.test(candidate.relativePath)) score += 3_000;
  if (/新版|新提示词|20260712/.test(candidate.relativePath)) score += 2_000;
  if (candidate.kind === "info") score += 500;
  return score;
}

function inferStatus(
  type: ParsedIdentity["type"],
  artifacts: Artifact[],
  text: string,
  fusionStoryboard?: WorkItem["fusionStoryboard"],
): WorkItemStatus {
  if (artifacts.length > 0 && artifacts.every((artifact) => artifact.deprecated)) return "弃用";
  const active = artifacts.filter((artifact) => !artifact.deprecated);
  if (type === "episode") return active.some((artifact) => artifact.check.ok) ? "待规划" : "阻塞";
  const raw = active.filter((artifact) => artifact.kind === "raw-image" && artifact.authoritative);
  const labeled = active.filter((artifact) => artifact.kind === "labeled-image" && artifact.authoritative);
  const videos = active.filter((artifact) => artifact.kind === "video" && artifact.authoritative);
  const hasPrompt = /提示词|prompt|画面|分镜/i.test(text) || active.some((artifact) => artifact.kind === "prompt");
  const hasStartRaw = raw.some((artifact) => artifact.variant === "start" || artifact.variant === "generic");
  const hasEndRaw = raw.some((artifact) => artifact.variant === "end");
  const hasStartLabeled = labeled.some((artifact) => artifact.variant === "start" || artifact.variant === "generic");
  const hasEndLabeled = labeled.some((artifact) => artifact.variant === "end");
  const imageFailure = [...raw, ...labeled].some((artifact) => !artifact.check.ok);
  const frameAccepted = isAcceptedText(text);
  const videoAccepted = /视频.{0,12}(验收|最终状态).{0,8}(通过|完成)|最终状态.{0,8}已完成/s.test(text);

  if (!text.trim() && !hasPrompt) return "待规划";
  if (!hasPrompt) return "待提示词";
  if (type === "unit" && fusionStoryboard) {
    const first = fusionStoryboard.panels[0];
    if (!first?.rawArtifactId) return "待首帧";
    if (fusionStoryboard.panels.some((panel) => !panel.rawArtifactId || !panel.labeledArtifactId || ["missing", "queued", "generating", "generation_unknown", "candidate_review", "visual_rejected"].includes(panel.state))) return "待尾帧";
    if (fusionStoryboard.panels.some((panel) => panel.state === "mechanical_failed" || panel.issues.length > 0)) return "待机械验收";
    return "待视觉验收";
  }
  if (!hasStartRaw) return "待首帧";
  if (type === "shot") {
    if (!hasStartLabeled || imageFailure) return "待机械验收";
    return frameAccepted ? "已完成" : "待视觉验收";
  }
  if (!hasEndRaw) return "待尾帧";
  if (!hasStartLabeled || !hasEndLabeled || imageFailure) return "待机械验收";
  if (!frameAccepted) return "待视觉验收";
  if (videos.length === 0) return "待视频";
  if (videos.some((video) => !video.check.ok) || !videoAccepted) return "待视频验收";
  return "已完成";
}

function isAcceptedText(text: string): boolean {
  return /最终状态\s*[：:]?\s*(通过|已完成)|逐项视觉验收|视觉验收\s*[：:]?\s*通过|验收结果\s*[：:]?\s*通过/s.test(text);
}

function stageForStatus(status: WorkItemStatus): WorkItem["stage"] {
  if (["待规划", "待提示词"].includes(status)) return "剧本";
  if (["待首帧", "待尾帧", "待机械验收", "待视觉验收", "返工"].includes(status)) return "首尾帧";
  if (["待视频", "视频生成中", "待视频验收"].includes(status)) return "视频";
  return "验收";
}

function nextActionForStatus(status: WorkItemStatus): string {
  const actions: Record<WorkItemStatus, string> = {
    待规划: "补齐镜头信息与生产目标",
    待提示词: "编写并落盘首尾帧与视频提示词",
    待首帧: "按硬锁生成并保存首帧 raw/labeled",
    待尾帧: "按连续性生成并保存尾帧 raw/labeled",
    待机械验收: "修复缺失配对、解码、尺寸或占位图问题",
    待视觉验收: "检查角色、道具、场景连续性并确认权威版本",
    待视频: "基于已验收首尾帧创建视频任务包",
    视频生成中: "等待并轮询视频结果",
    待视频验收: "检查视频时长、内容和连续性",
    已完成: "保持归档，等待下游剪辑",
    返工: "读取返工原因并生成新版本",
    阻塞: "处理阻塞原因后重新扫描",
    弃用: "仅保留历史，不计入完成度",
  };
  return actions[status];
}

function nextActionForItem(type: ParsedIdentity["type"], status: WorkItemStatus): string {
  if (type !== "shot") return nextActionForStatus(status);
  const shotActions: Partial<Record<WorkItemStatus, string>> = {
    待规划: "补齐原镜头画面目标、构图、动作和时长",
    待提示词: "编写并落盘原镜头单张画面提示词",
    待首帧: "按父单元连续性与硬锁生成原镜头 raw/labeled",
    待机械验收: "补齐原镜头 raw/labeled 配对或修复解码、尺寸问题",
    待视觉验收: "检查原镜头角色、道具、场景及前后镜连续性",
    已完成: "保持原镜头权威版本，供 15 秒参考板与下游视频使用",
    返工: "读取原镜头返工原因并生成新版本",
  };
  return shotActions[status] ?? nextActionForStatus(status);
}

function chooseThumbnail(artifacts: Artifact[]): string | undefined {
  const activeImages = artifacts.filter(
    (artifact) => artifact.authoritative && !artifact.deprecated && artifact.check.ok && artifact.kind === "raw-image",
  );
  return activeImages.find((artifact) => artifact.variant === "start")?.path ?? activeImages[0]?.path;
}

function compactExcerpt(content: string): string {
  return content.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6_000);
}

function applySequentialDependencies(items: WorkItem[]): void {
  const episodeGroups = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (item.type !== "unit" || item.episode === undefined) continue;
    const scope = item.id.split("-ep")[0];
    const key = `${scope}:ep${item.episode}`;
    const list = episodeGroups.get(key) ?? [];
    list.push(item);
    episodeGroups.set(key, list);
  }
  for (const list of episodeGroups.values()) {
    list.sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0));
    for (let index = 1; index < list.length; index += 1) {
      list[index]!.dependencies = [list[index - 1]!.id];
    }
  }
  const shotGroups = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (item.type !== "shot" || !item.parentId) continue;
    const list = shotGroups.get(item.parentId) ?? [];
    list.push(item);
    shotGroups.set(item.parentId, list);
  }
  for (const [parentId, list] of shotGroups) {
    list.sort((a, b) => String(a.shot ?? "").localeCompare(String(b.shot ?? ""), "zh-CN", { numeric: true }));
    list.forEach((item, index) => {
      item.dependencies = [index === 0 ? parentId : list[index - 1]!.id];
    });
  }
}

function inheritParentContext(items: WorkItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.type !== "shot" || !item.parentId) continue;
    const parent = byId.get(item.parentId);
    if (!parent || parent.type !== "unit") continue;
    item.hardLockIds = [...new Set([...parent.hardLockIds, ...item.hardLockIds])];
  }
}

function summarize(items: WorkItem[], artifacts: Artifact[]): ProgressSummary {
  const unitItems = items.filter((item) => item.type === "unit");
  const productionItems = unitItems.length > 0 ? unitItems : items.filter((item) => item.type === "shot");
  const byStatus = Object.fromEntries(WORK_ITEM_STATUSES.map((status) => [status, 0])) as Record<WorkItemStatus, number>;
  const byEpisode: ProgressSummary["byEpisode"] = {};
  for (const item of productionItems) {
    byStatus[item.status] += 1;
    const episode = item.episode ? `EP${pad(item.episode, 2)}` : "未分集";
    const current = byEpisode[episode] ?? { total: 0, completed: 0, active: 0 };
    current.total += 1;
    if (item.status === "已完成") current.completed += 1;
    if (!["已完成", "弃用"].includes(item.status)) current.active += 1;
    byEpisode[episode] = current;
  }
  const sheetStatusById = new Map<string, NonNullable<Artifact["fusionStoryboardSheet"]>["status"]>();
  const sheetPriority = { current: 0, stale: 1, "legacy-invalid": 2, invalid: 3 } as const;
  for (const artifact of artifacts) {
    const sheet = artifact.fusionStoryboardSheet;
    if (!sheet) continue;
    const previous = sheetStatusById.get(sheet.sheetId);
    if (!previous || sheetPriority[sheet.status] > sheetPriority[previous]) sheetStatusById.set(sheet.sheetId, sheet.status);
  }
  return {
    total: productionItems.length,
    active: productionItems.filter((item) => !["已完成", "弃用"].includes(item.status)).length,
    completed: productionItems.filter((item) => item.status === "已完成").length,
    deprecated: productionItems.filter((item) => item.status === "弃用").length,
    blocked: productionItems.filter((item) => item.status === "阻塞").length,
    byStatus,
    byEpisode,
    rawImages: artifacts.filter((artifact) => artifact.kind === "raw-image" && !artifact.deprecated).length,
    labeledImages: artifacts.filter((artifact) => artifact.kind === "labeled-image" && !artifact.deprecated).length,
    videos: artifacts.filter((artifact) => artifact.kind === "video" && !artifact.deprecated).length,
    storyboardSheets: {
      current: [...sheetStatusById.values()].filter((status) => status === "current").length,
      stale: [...sheetStatusById.values()].filter((status) => status === "stale").length,
      invalid: [...sheetStatusById.values()].filter((status) => status === "invalid").length,
      legacyInvalid: [...sheetStatusById.values()].filter((status) => status === "legacy-invalid").length,
      pages: artifacts.filter((artifact) => artifact.kind === "storyboard-sheet-png").length,
    },
    mechanicalFailures: artifacts.filter(
      (artifact) => !artifact.deprecated && ["raw-image", "labeled-image", "video"].includes(artifact.kind) && !artifact.check.ok,
    ).length,
    fusionStoryboardPanels: {
      required: items.reduce((total, item) => total + (item.fusionStoryboard?.panelCount ?? 0), 0),
      produced: items.reduce((total, item) => total + (item.fusionStoryboard?.completedPanelCount ?? 0), 0),
      mechanicallyValid: items.reduce((total, item) => total + (item.fusionStoryboard?.mechanicallyValidPanelCount ?? 0), 0),
      approved: items.reduce((total, item) => total + (item.fusionStoryboard?.visuallyApproved ? item.fusionStoryboard.panelCount : 0), 0),
    },
  };
}

function compareItems(a: WorkItem, b: WorkItem): number {
  if (a.type === "asset" && b.type !== "asset") return -1;
  if (b.type === "asset" && a.type !== "asset") return 1;
  return (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0) || Number(a.type === "shot") - Number(b.type === "shot") || String(a.shot ?? "").localeCompare(String(b.shot ?? ""), "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);
}

function artifactIdFor(itemId: string, rootSlot: string, relativePath: string): string {
  const logicalLocation = `${rootSlot}:${relativePath.split(path.sep).join("/").normalize("NFC")}`;
  return `${itemId}-${createHash("sha1").update(logicalLocation).digest("hex").slice(0, 12)}`;
}

async function getModifiedAt(filePath: string): Promise<string> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function hashFileIdentity(metadata: BigIntStats): string {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.nlink, metadata.size, metadata.mtimeNs, metadata.ctimeNs].map(String).join(":");
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  throwIfScanAborted(signal);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error("素材路径不是普通文件。");
    const openedIdentity = hashFileIdentity(opened);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      throwIfScanAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    throwIfScanAborted(signal);
    const [afterHandle, afterPath] = await Promise.all([handle.stat({ bigint: true }), lstat(filePath, { bigint: true })]);
    if (hashFileIdentity(afterHandle) !== openedIdentity || hashFileIdentity(afterPath) !== openedIdentity) throw new Error("素材内容在 SHA-256 校验期间发生变化。");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "项目扫描已取消。");
  error.name = "AbortError";
  throw error;
}

async function mapLimit<T, R>(values: T[], limit: number, worker: (value: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < values.length) {
      throwIfScanAborted(signal);
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}
