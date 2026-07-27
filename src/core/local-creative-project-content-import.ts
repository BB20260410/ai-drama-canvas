import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  getStudioCanonicalAsset,
  getStudioMedia,
  importStudioMedia,
  listStudioMedia,
  listStudioMediaImportOrigins,
  type StudioCanonicalAssetCategory,
  type StudioMediaImportOrigin,
  type StudioMediaKind,
} from "./material-studio.js";
import {
  importStudioTextLibraryFiles,
  type ScriptLibraryImportFileResult,
} from "./studio-script-library-import.js";
import {
  buildLocalCreativeSourceDocumentInventory,
  classifyLocalCreativeSourceDocument,
  type LocalCreativeSourceDocumentInventory,
} from "./local-creative-document-inventory.js";
import {
  localCreativeSourceInventoryFromPreview,
  type LocalCreativeSourceInventorySnapshot,
} from "./local-creative-source-inventory.js";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
} from "./confined-project-storage.js";
import { withProjectLock } from "./locks.js";
import { writeJsonAtomic } from "./sidecar.js";
import type {
  LocalCreativeFileStatus,
  LocalCreativeIngestFile,
  LocalCreativeProjectIngestPreview,
  LocalCreativeSourceLayerRole,
} from "./local-creative-project-ingest.js";
import { LOCAL_CREATIVE_SOURCE_LAYER_ROLES } from "./local-creative-project-ingest.js";

export const LOCAL_CREATIVE_AUTHORITY_POLICIES = [
  "FORBID_ALL",
  "CREATE_PENDING_FROM_APPROVED_LOCKS",
] as const;

export type LocalCreativeAuthorityPolicy = typeof LOCAL_CREATIVE_AUTHORITY_POLICIES[number];

export interface LocalCreativeProjectContentImportInput {
  projectRoot: string;
  preview: LocalCreativeProjectIngestPreview;
  authorityPolicy: LocalCreativeAuthorityPolicy;
  documentLimit?: number;
  /**
   * 普通媒体累计多少项后原子落盘；失败、权威决策和结束不受此间隔影响。
   * 默认 10，正式媒体导入并发仍恒为 1。
   */
  checkpointEvery?: number;
  onProgress?: (event: LocalCreativeProjectContentImportProgressEvent) => void | Promise<void>;
  mediaKindByFileId?: Record<string, StudioMediaKind>;
  canonicalCategoryByFileId?: Record<string, StudioCanonicalAssetCategory>;
}

export interface LocalCreativeProjectContentImportProgressEvent {
  phase: "initialized" | "documents" | "media" | "canonical-asset" | "completed";
  projectRoot: string;
  progressPath: string;
  completedMedia: number;
  totalMedia: number;
  remainingMedia: number;
  elapsedMs: number;
  ratePerSecond: number;
  checkpointWritten: boolean;
  currentFileId?: string;
  currentPath?: string;
  action?:
    | "document-batch"
    | "imported"
    | "reconciled-existing"
    | "skipped-recorded"
    | "failed"
    | LocalCreativeCanonicalDecision["decision"]
    | "completed";
  runSummary: LocalCreativeProjectContentImportProgress["runSummary"];
}

export interface LocalCreativeDocumentSelection {
  fileId: string;
  path: string;
  sourceRoot: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  documentKind: "script" | "prompt";
  score: number;
  reasons: string[];
}

export interface LocalCreativeDocumentCoverage {
  sourceDocuments: number;
  eligibleTextDocuments: number;
  selectedDocuments: number;
  importEligibleDocuments: number;
  inventoryOnlyDocuments: number;
  excludedUnsupportedFormat: number;
  excludedRejected: number;
  unselectedByLimit: number;
  limitHit: boolean;
}

export interface LocalCreativeImportedMediaProgress {
  fileId: string;
  sourcePath: string;
  sourceLayerRole: LocalCreativeSourceLayerRole;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  kind: StudioMediaKind;
  status: "imported" | "reconciled-existing";
  lastAction: "imported" | "reconciled-existing" | "skipped-recorded";
  importedAt: string;
  updatedAt: string;
}

export interface ValidatedLocalCreativeImportedMediaIdentity {
  fileId: string;
  sourcePath: string;
  sourceLayerRole: LocalCreativeSourceLayerRole;
  sizeBytes: number;
  sha256: string;
  kind: StudioMediaKind;
  status: "imported" | "reconciled-existing";
}

export interface LocalCreativeCanonicalDecision {
  fileId: string;
  sourcePath: string;
  sourceStatus: LocalCreativeFileStatus;
  decision:
    | "pending-version-created"
    | "pending-version-reconciled"
    | "forbidden-by-policy"
    | "forbidden-inbox"
    | "category-unresolved"
    | "not-applicable";
  assetId?: string;
  category?: StudioCanonicalAssetCategory;
  versionId?: string;
  mediaSha256?: string;
  authorityPromoted: false;
  sourceApprovalEvidence: Array<{
    level: string;
    sourceFileId: string;
    sourcePath: string;
    declaredSha256?: string;
  }>;
  updatedAt: string;
}

export interface LocalCreativeContentImportFailure {
  phase: "document" | "media" | "canonical-asset";
  fileId?: string;
  path?: string;
  error: string;
  occurredAt: string;
}

export interface LocalCreativeProjectContentImportProgress {
  schemaVersion: 1;
  kind: "local-creative-project-content-import-progress";
  projectRoot: string;
  sourceProject: {
    key: string;
    name: string;
    type: string;
  };
  authorityPolicy: LocalCreativeAuthorityPolicy;
  authorityPolicyHistory: LocalCreativeAuthorityPolicy[];
  previewFingerprint: string;
  previewFingerprints: string[];
  sourceInventory?: LocalCreativeSourceInventorySnapshot;
  documentInventory?: LocalCreativeSourceDocumentInventory;
  status: "in-progress" | "completed" | "completed-with-failures";
  documentLimit: number;
  checkpointEvery: number;
  documents: {
    selected: LocalCreativeDocumentSelection[];
    results: ScriptLibraryImportFileResult[];
    coverage?: LocalCreativeDocumentCoverage;
  };
  mediaByFileId: Record<string, LocalCreativeImportedMediaProgress>;
  canonicalDecisionsByFileId: Record<string, LocalCreativeCanonicalDecision>;
  sourceStatusCounts: Record<LocalCreativeFileStatus, number>;
  lockReferenceIndex: Array<{
    lockFileId: string;
    lockPath: string;
    status: "APPROVED_LOCK" | "CANDIDATE_LOCK";
    referencedBy: Array<{
      fileId: string;
      path: string;
      evidenceLevels: string[];
    }>;
  }>;
  failures: LocalCreativeContentImportFailure[];
  runSummary: {
    documentsSelected: number;
    documentsImported: number;
    documentsSkippedDuplicate: number;
    documentsFailed: number;
    mediaEligible: number;
    mediaImported: number;
    mediaReconciled: number;
    mediaSkippedRecorded: number;
    mediaRejected: number;
    mediaFailed: number;
    pendingAssetsCreated: number;
    pendingAssetsReconciled: number;
    authorityPromotions: 0;
  };
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * 只有终态导入在不可变、内容寻址基线收据落盘后才可设置。
   * 旧进度允许缺失，但状态投影必须将其视为 UNVERIFIED。
   */
  completionBaselineFingerprint?: string;
}

export interface LocalCreativeContentImportCompletionBaselineReceipt {
  schemaVersion: 1;
  kind: "local-creative-content-import-completion-baseline";
  project: {
    id: string;
    root: string;
    manifestFingerprint: string;
    sourceProject: LocalCreativeProjectContentImportProgress["sourceProject"];
  };
  previewFingerprint: string;
  sourceInventory: LocalCreativeSourceInventorySnapshot;
  completion: {
    status: "completed" | "completed-with-failures";
    authorityPolicy: LocalCreativeAuthorityPolicy;
    documentLimit: number;
    checkpointEvery: number;
    completedAt: string;
    runSummary: LocalCreativeProjectContentImportProgress["runSummary"];
    processedMediaRecords: number;
    failures: {
      total: number;
      byPhase: Record<LocalCreativeContentImportFailure["phase"], number>;
    };
    documentCoverage: LocalCreativeDocumentCoverage | null;
  };
  fingerprint: string;
}

export interface LocalCreativeProjectContentImportSummary {
  schemaVersion: 1;
  kind: "local-creative-project-content-import-summary";
  projectRoot: string;
  sourceProject: LocalCreativeProjectContentImportProgress["sourceProject"];
  authorityPolicy: LocalCreativeAuthorityPolicy;
  documentLimit: number;
  checkpointEvery: number;
  previewFingerprint: string;
  previewFingerprints: string[];
  /**
   * 只有终态不可变收据已经安全落盘后才存在。项目中心必须核验该收据，
   * 不能只凭 mutable summary + 当前来源指纹显示 current-complete。
   */
  completionBaselineFingerprint?: string;
  sourceInventory?: LocalCreativeSourceInventorySnapshot;
  documentInventory?: LocalCreativeSourceDocumentInventory;
  documentCoverage?: LocalCreativeDocumentCoverage;
  status: LocalCreativeProjectContentImportProgress["status"];
  runSummary: LocalCreativeProjectContentImportProgress["runSummary"];
  processedCounts: {
    media: number;
    eligibleMedia: number;
    documents: number;
    pendingAssets: number;
  };
  decisionCounts: Record<string, number>;
  failureCounts: {
    total: number;
    document: number;
    media: number;
    canonicalAsset: number;
  };
  updatedAt: string;
  completedAt?: string;
}

export const LOCAL_CREATIVE_CONTENT_PROGRESS_RELATIVE_PATH = ".aicanvas/local-creative-project-content-import.json";
export const LOCAL_CREATIVE_CONTENT_SUMMARY_RELATIVE_PATH = ".aicanvas/local-creative-project-content-summary.json";
export const LOCAL_CREATIVE_CONTENT_COMPLETION_BASELINE_RELATIVE_ROOT =
  ".aicanvas/local-creative-content-import-completion-baselines";
const PROGRESS_RELATIVE_PATH = LOCAL_CREATIVE_CONTENT_PROGRESS_RELATIVE_PATH;
const DEFAULT_DOCUMENT_LIMIT = 500;
const MAX_DOCUMENT_LIMIT = 5_000;
const DEFAULT_CHECKPOINT_EVERY = 10;
const MAX_CHECKPOINT_EVERY = 10_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREVIEW_FINGERPRINT_PATTERN = /^local-creative-[a-f0-9]{64}$/u;
const DOCUMENT_ROLE_SCORE: Record<LocalCreativeSourceLayerRole, number> = {
  PRIMARY_AUTHORITY: 140,
  ACTIVE_PRODUCTION: 130,
  UPSTREAM_SCRIPT: 120,
  UNASSIGNED_INBOX: 40,
  LEGACY_HISTORY: 25,
  EXPORT: 10,
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function semanticFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function completionFailureCounts(
  failures: LocalCreativeContentImportFailure[],
): LocalCreativeContentImportCompletionBaselineReceipt["completion"]["failures"] {
  return {
    total: failures.length,
    byPhase: {
      document: failures.filter((failure) => failure.phase === "document").length,
      media: failures.filter((failure) => failure.phase === "media").length,
      "canonical-asset": failures.filter((failure) => failure.phase === "canonical-asset").length,
    },
  };
}

export function buildLocalCreativeContentImportCompletionBaseline(input: {
  project: LocalCreativeContentImportCompletionBaselineReceipt["project"];
  previewFingerprint: string;
  sourceInventory: LocalCreativeSourceInventorySnapshot;
  completion: LocalCreativeContentImportCompletionBaselineReceipt["completion"];
}): LocalCreativeContentImportCompletionBaselineReceipt {
  if (!path.isAbsolute(input.project.root)
    || !input.project.id
    || !SHA256_PATTERN.test(input.project.manifestFingerprint)
    || !PREVIEW_FINGERPRINT_PATTERN.test(input.previewFingerprint)
    || (input.sourceInventory.contentIdentity !== "sha256"
      && input.sourceInventory.contentIdentity !== "metadata")
    || !SHA256_PATTERN.test(input.sourceInventory.fingerprint)
    || (input.completion.status !== "completed" && input.completion.status !== "completed-with-failures")
    || !Number.isFinite(Date.parse(input.completion.completedAt))) {
    throw new Error("内容导入完成基线语义无效。");
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: "local-creative-content-import-completion-baseline" as const,
    project: stableValue(input.project) as LocalCreativeContentImportCompletionBaselineReceipt["project"],
    previewFingerprint: input.previewFingerprint,
    sourceInventory: stableValue(input.sourceInventory) as LocalCreativeSourceInventorySnapshot,
    completion: stableValue(input.completion) as LocalCreativeContentImportCompletionBaselineReceipt["completion"],
  };
  return {
    ...semantic,
    fingerprint: semanticFingerprint(semantic),
  };
}

export function localCreativeContentImportCompletionBaselineRelativePath(fingerprint: string): string {
  if (!SHA256_PATTERN.test(fingerprint)) throw new Error("内容导入完成基线 fingerprint 无效。");
  return `${LOCAL_CREATIVE_CONTENT_COMPLETION_BASELINE_RELATIVE_ROOT}/${fingerprint}.json`;
}

async function persistCompletionBaseline(
  projectRoot: string,
  receipt: LocalCreativeContentImportCompletionBaselineReceipt,
): Promise<void> {
  const directoryPath = path.join(projectRoot, LOCAL_CREATIVE_CONTENT_COMPLETION_BASELINE_RELATIVE_ROOT);
  const directory = await ensureConfinedDirectory(projectRoot, directoryPath);
  const bytes = Buffer.from(`${JSON.stringify(stableValue(receipt), null, 2)}\n`, "utf8");
  await persistConfinedBytesNoReplace(
    directory,
    `${receipt.fingerprint}.json`,
    bytes,
  );
}

function emptyRunSummary(): LocalCreativeProjectContentImportProgress["runSummary"] {
  return {
    documentsSelected: 0,
    documentsImported: 0,
    documentsSkippedDuplicate: 0,
    documentsFailed: 0,
    mediaEligible: 0,
    mediaImported: 0,
    mediaReconciled: 0,
    mediaSkippedRecorded: 0,
    mediaRejected: 0,
    mediaFailed: 0,
    pendingAssetsCreated: 0,
    pendingAssetsReconciled: 0,
    authorityPromotions: 0,
  };
}

function normalizedDocumentLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_DOCUMENT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_DOCUMENT_LIMIT) {
    throw new Error(`documentLimit 必须是 0-${MAX_DOCUMENT_LIMIT} 的整数。`);
  }
  return limit;
}

function normalizedCheckpointEvery(value: number | undefined): number {
  const checkpointEvery = value ?? DEFAULT_CHECKPOINT_EVERY;
  if (!Number.isInteger(checkpointEvery) || checkpointEvery < 1 || checkpointEvery > MAX_CHECKPOINT_EVERY) {
    throw new Error(`checkpointEvery 必须是 1-${MAX_CHECKPOINT_EVERY} 的整数。`);
  }
  return checkpointEvery;
}

function documentCoverage(
  preview: LocalCreativeProjectIngestPreview,
  limit: number,
  selectedDocuments?: number,
): LocalCreativeDocumentCoverage {
  const documents = preview.files.filter((file) => file.mediaKind === "document");
  const eligible = documents.filter((file) => (
    (file.extension === ".md" || file.extension === ".txt")
    && file.status !== "REJECTED_OR_FORBIDDEN"
  ));
  const classified = eligible.map((file) => ({
    file,
    classification: classifyLocalCreativeSourceDocument(file),
  }));
  const importEligible = classified.filter(({ classification }) => (
    classification.importTarget === "script" || classification.importTarget === "prompt"
  ));
  const inventoryOnlyDocuments = classified.length - importEligible.length;
  const selected = selectedDocuments ?? Math.min(importEligible.length, limit);
  return {
    sourceDocuments: documents.length,
    eligibleTextDocuments: eligible.length,
    selectedDocuments: selected,
    importEligibleDocuments: importEligible.length,
    inventoryOnlyDocuments,
    excludedUnsupportedFormat: documents.filter((file) => file.extension !== ".md" && file.extension !== ".txt").length,
    excludedRejected: documents.filter((file) => (
      (file.extension === ".md" || file.extension === ".txt")
      && file.status === "REJECTED_OR_FORBIDDEN"
    )).length,
    unselectedByLimit: Math.max(0, importEligible.length - selected),
    limitHit: importEligible.length > selected,
  };
}

function scoreDocument(
  file: LocalCreativeIngestFile,
  documentKind: "script" | "prompt",
): LocalCreativeDocumentSelection {
  const normalized = `${file.relativePath} ${file.basename}`.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const reasons = [`source:${file.sourceLayer.role}`];
  let score = DOCUMENT_ROLE_SCORE[file.sourceLayer.role];
  const categories: Array<{ pattern: RegExp; score: number; reason: string }> = [
    { pattern: /剧本|script|screenplay|episode|第.{0,8}集|ep\d+/iu, score: 130, reason: "story-script" },
    { pattern: /分镜|storyboard|shot|镜头|宫格/iu, score: 120, reason: "storyboard" },
    { pattern: /设定|圣经|角色|人物|场景|道具|资产|canon|bible/iu, score: 110, reason: "bible-asset" },
    { pattern: /索引|index|status|tasks|总表|交接|验收|裁决|合同/iu, score: 90, reason: "index-qc" },
  ];
  for (const category of categories) {
    if (!category.pattern.test(normalized)) continue;
    score += category.score;
    reasons.push(category.reason);
    break;
  }
  const depth = file.relativePath.split("/").length - 1;
  const depthBonus = Math.max(0, 50 - depth * 5);
  score += depthBonus;
  reasons.push(`depth:${depth}`);
  if (file.status === "APPROVED_LOCK") {
    score += 40;
    reasons.push("approved-lock");
  } else if (file.status === "CANDIDATE_LOCK") {
    score += 20;
    reasons.push("candidate-lock");
  }
  return {
    fileId: file.fileId,
    path: file.absolutePath,
    sourceRoot: file.sourceLayer.rootPath,
    sizeBytes: file.sizeBytes,
    mtimeMs: Math.trunc(file.mtimeMs),
    sha256: file.sha256 ?? "",
    documentKind,
    score,
    reasons,
  };
}

export function selectLocalCreativeProjectDocuments(
  preview: LocalCreativeProjectIngestPreview,
  limit = DEFAULT_DOCUMENT_LIMIT,
): LocalCreativeDocumentSelection[] {
  const normalizedLimit = normalizedDocumentLimit(limit);
  return preview.files
    .filter((file) => (
      file.mediaKind === "document"
      && (file.extension === ".md" || file.extension === ".txt")
      && file.status !== "REJECTED_OR_FORBIDDEN"
    ))
    .flatMap((file) => {
      const classification = classifyLocalCreativeSourceDocument(file);
      return classification.importTarget === "script" || classification.importTarget === "prompt"
        ? [scoreDocument(file, classification.importTarget)]
        : [];
    })
    .sort((left, right) => (
      right.score - left.score
      || left.path.localeCompare(right.path, "en")
      || left.fileId.localeCompare(right.fileId, "en")
    ))
    .slice(0, normalizedLimit);
}

function cloneStatusCounts(preview: LocalCreativeProjectIngestPreview): Record<LocalCreativeFileStatus, number> {
  return { ...preview.statistics.byStatus };
}

function progressLockReferenceIndex(
  preview: LocalCreativeProjectIngestPreview,
): LocalCreativeProjectContentImportProgress["lockReferenceIndex"] {
  return preview.lockReferenceIndex.map((entry) => ({
    lockFileId: entry.lockFileId,
    lockPath: entry.lockPath,
    status: entry.status,
    referencedBy: entry.referencedBy.map((reference) => ({
      fileId: reference.fileId,
      path: reference.path,
      evidenceLevels: [...reference.evidenceLevels],
    })),
  }));
}

function parseProgress(value: unknown, progressPath: string): LocalCreativeProjectContentImportProgress {
  const candidate = value as Partial<LocalCreativeProjectContentImportProgress>;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || candidate.schemaVersion !== 1
    || candidate.kind !== "local-creative-project-content-import-progress"
    || typeof candidate.projectRoot !== "string"
    || !candidate.sourceProject || typeof candidate.sourceProject.key !== "string"
    || !candidate.mediaByFileId || typeof candidate.mediaByFileId !== "object"
    || !candidate.canonicalDecisionsByFileId || typeof candidate.canonicalDecisionsByFileId !== "object"
    || !Array.isArray(candidate.failures)
    || (candidate.completionBaselineFingerprint !== undefined
      && !SHA256_PATTERN.test(candidate.completionBaselineFingerprint))) {
    throw new Error(`本机创作项目内容导入进度结构无效：${progressPath}`);
  }
  return candidate as LocalCreativeProjectContentImportProgress;
}

async function loadProgress(progressPath: string): Promise<LocalCreativeProjectContentImportProgress | null> {
  const metadata = await lstat(progressPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`内容导入进度不是安全普通文件：${progressPath}`);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(progressPath, "utf8")); }
  catch (error) { throw new Error(`内容导入进度 JSON 已损坏：${progressPath}`, { cause: error }); }
  return parseProgress(parsed, progressPath);
}

function assertExactRecordKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function validatedImportedMediaProgress(
  fileId: string,
  value: unknown,
): LocalCreativeImportedMediaProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`内容导入媒体记录 ${fileId} 结构无效。`);
  }
  const record = value as LocalCreativeImportedMediaProgress;
  assertExactRecordKeys(record as unknown as Record<string, unknown>, [
    "fileId",
    "sourcePath",
    "sourceLayerRole",
    "sizeBytes",
    "mtimeMs",
    "sha256",
    "kind",
    "status",
    "lastAction",
    "importedAt",
    "updatedAt",
  ], `内容导入媒体记录 ${fileId}`);
  const validTime = (time: unknown): time is string => typeof time === "string"
    && Number.isFinite(Date.parse(time))
    && new Date(time).toISOString() === time;
  if (record.fileId !== fileId
    || typeof record.sourcePath !== "string"
    || !path.isAbsolute(record.sourcePath)
    || path.normalize(record.sourcePath) !== record.sourcePath
    || !LOCAL_CREATIVE_SOURCE_LAYER_ROLES.includes(record.sourceLayerRole)
    || !Number.isSafeInteger(record.sizeBytes)
    || record.sizeBytes < 0
    || !Number.isFinite(record.mtimeMs)
    || record.mtimeMs < 0
    || !SHA256_PATTERN.test(record.sha256)
    || !["image", "video", "audio"].includes(record.kind)
    || !["imported", "reconciled-existing"].includes(record.status)
    || !["imported", "reconciled-existing", "skipped-recorded"].includes(record.lastAction)
    || !validTime(record.importedAt)
    || !validTime(record.updatedAt)) {
    throw new Error(`内容导入媒体记录 ${fileId} 字段无效。`);
  }
  return record;
}

function pathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 供来源物化器消费的受信媒体索引。进度 JSON 只负责定位；每条命中的 identity
 * 还必须重新证明来源层、CAS 对象和 import origin，禁止直接信任 sidecar 字段。
 */
export async function readValidatedLocalCreativeImportedMediaIdentityIndex(
  projectRootInput: string,
  input: {
    expectedSourceFingerprint: string;
    sourcePaths: string[];
  },
): Promise<Map<string, ValidatedLocalCreativeImportedMediaIdentity>> {
  const shell = await inspectManagedProjectReadOnly(projectRootInput);
  const projectRoot = shell.paths.root;
  if (!SHA256_PATTERN.test(input.expectedSourceFingerprint)) {
    throw new Error("expectedSourceFingerprint 无效。");
  }
  const progressPath = path.join(projectRoot, PROGRESS_RELATIVE_PATH);
  const progress = await loadProgress(progressPath);
  if (!progress) return new Map();
  if (path.resolve(progress.projectRoot) !== projectRoot) {
    throw new Error("内容导入进度绑定了其他受管工程。");
  }
  if (progress.sourceInventory?.contentIdentity !== "sha256"
    || progress.sourceInventory.fingerprint !== input.expectedSourceFingerprint) {
    throw new Error("内容导入媒体索引不属于当前精确来源快照。");
  }
  const bySourcePath = new Map<string, LocalCreativeImportedMediaProgress>();
  for (const [fileId, rawRecord] of Object.entries(progress.mediaByFileId)) {
    const record = validatedImportedMediaProgress(fileId, rawRecord);
    const matchingLayer = progress.sourceInventory.layers.find((layer) => (
      layer.role === record.sourceLayerRole && pathInsideRoot(record.sourcePath, layer.rootPath)
    ));
    if (!matchingLayer) throw new Error(`内容导入媒体记录 ${fileId} 不属于声明的来源层。`);
    const existing = bySourcePath.get(record.sourcePath);
    if (existing && (existing.sha256 !== record.sha256 || existing.fileId !== record.fileId)) {
      throw new Error(`同一来源路径存在冲突媒体记录：${record.sourcePath}`);
    }
    bySourcePath.set(record.sourcePath, record);
  }
  const requested = [...new Set(input.sourcePaths.map((sourcePath) => path.resolve(sourcePath)))];
  const verified = new Map<string, ValidatedLocalCreativeImportedMediaIdentity>();
  for (const sourcePath of requested) {
    const record = bySourcePath.get(sourcePath);
    if (!record) continue;
    const sourceMetadata = await lstat(sourcePath).catch(() => null);
    const sourceRealPath = sourceMetadata ? await realpath(sourcePath).catch(() => null) : null;
    if (!sourceMetadata
      || !sourceMetadata.isFile()
      || sourceMetadata.isSymbolicLink()
      || sourceRealPath !== sourcePath
      || sourceMetadata.size !== record.sizeBytes
      || await sha256File(sourcePath) !== record.sha256) {
      throw new Error(`内容导入媒体 ${record.fileId} 已不属于当前来源文件身份。`);
    }
    const media = await getStudioMedia(projectRoot, record.sha256);
    if (!media
      || media.sha256 !== record.sha256
      || media.kind !== record.kind
      || media.sizeBytes !== record.sizeBytes) {
      throw new Error(`内容导入媒体 ${record.fileId} 的 CAS 元数据缺失或漂移。`);
    }
    const objectMetadata = await lstat(media.objectPath);
    if (!objectMetadata.isFile()
      || objectMetadata.isSymbolicLink()
      || objectMetadata.size !== record.sizeBytes
      || await sha256File(media.objectPath) !== record.sha256) {
      throw new Error(`内容导入媒体 ${record.fileId} 的 CAS 对象缺失或漂移。`);
    }
    if (!await hasExactOrigin(projectRoot, record.sha256, sourcePath, record.sizeBytes)) {
      throw new Error(`内容导入媒体 ${record.fileId} 缺少精确 import origin。`);
    }
    verified.set(sourcePath, {
      fileId: record.fileId,
      sourcePath,
      sourceLayerRole: record.sourceLayerRole,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      kind: record.kind,
      status: record.status,
    });
  }
  return verified;
}

function initialProgress(
  projectRoot: string,
  input: LocalCreativeProjectContentImportInput,
  documentLimit: number,
  checkpointEvery: number,
  existing: LocalCreativeProjectContentImportProgress | null,
): LocalCreativeProjectContentImportProgress {
  const now = new Date().toISOString();
  if (existing) {
    if (path.resolve(existing.projectRoot) !== projectRoot) throw new Error("内容导入进度绑定了其他受管工程。");
    if (existing.sourceProject.key !== input.preview.project.key) throw new Error("内容导入进度绑定了其他源项目。");
    const eligibleMedia = input.preview.files.filter((file) => (
      file.mediaKind !== "document" && file.status !== "REJECTED_OR_FORBIDDEN"
    ));
    const eligibleFileIds = new Set(eligibleMedia.map((file) => file.fileId));
    const eligiblePaths = new Set(eligibleMedia.map((file) => path.resolve(file.absolutePath)));
    const eligibleMediaById = new Map(eligibleMedia.map((file) => [file.fileId, file]));
    const mediaByFileId = Object.fromEntries(
      Object.entries(existing.mediaByFileId).filter(([fileId, record]) => {
        const current = eligibleMediaById.get(fileId);
        return Boolean(current
          && record.fileId === fileId
          && record.sourcePath === path.resolve(current.absolutePath)
          && record.sourceLayerRole === current.sourceLayer.role
          && record.sizeBytes === current.sizeBytes
          && record.mtimeMs === Math.trunc(current.mtimeMs)
          && (!current.sha256 || record.sha256 === current.sha256)
          && record.kind === current.mediaKind);
      }),
    );
    const canonicalDecisionsByFileId = Object.fromEntries(
      Object.entries(existing.canonicalDecisionsByFileId)
        .filter(([fileId]) => eligibleFileIds.has(fileId)),
    );
    return {
      ...existing,
      authorityPolicy: input.authorityPolicy,
      authorityPolicyHistory: [...new Set([...existing.authorityPolicyHistory, input.authorityPolicy])],
      previewFingerprint: input.preview.previewFingerprint,
      previewFingerprints: [...new Set([...existing.previewFingerprints, input.preview.previewFingerprint])],
      sourceInventory: localCreativeSourceInventoryFromPreview(input.preview),
      documentInventory: buildLocalCreativeSourceDocumentInventory(input.preview),
      status: "in-progress",
      documentLimit,
      checkpointEvery,
      documents: {
        ...existing.documents,
        coverage: documentCoverage(input.preview, documentLimit),
      },
      mediaByFileId,
      canonicalDecisionsByFileId,
      sourceStatusCounts: cloneStatusCounts(input.preview),
      lockReferenceIndex: progressLockReferenceIndex(input.preview),
      failures: existing.failures.filter((failure) => (
        failure.phase !== "media"
        || (Boolean(failure.fileId) && eligibleFileIds.has(failure.fileId!))
        || (Boolean(failure.path) && eligiblePaths.has(path.resolve(failure.path!)))
      )),
      runSummary: emptyRunSummary(),
      updatedAt: now,
      completedAt: undefined,
      completionBaselineFingerprint: undefined,
    };
  }
  return {
    schemaVersion: 1,
    kind: "local-creative-project-content-import-progress",
    projectRoot,
    sourceProject: { ...input.preview.project },
    authorityPolicy: input.authorityPolicy,
    authorityPolicyHistory: [input.authorityPolicy],
    previewFingerprint: input.preview.previewFingerprint,
    previewFingerprints: [input.preview.previewFingerprint],
    sourceInventory: localCreativeSourceInventoryFromPreview(input.preview),
    documentInventory: buildLocalCreativeSourceDocumentInventory(input.preview),
    status: "in-progress",
    documentLimit,
    checkpointEvery,
    documents: {
      selected: [],
      results: [],
      coverage: documentCoverage(input.preview, documentLimit),
    },
    mediaByFileId: {},
    canonicalDecisionsByFileId: {},
    sourceStatusCounts: cloneStatusCounts(input.preview),
    lockReferenceIndex: progressLockReferenceIndex(input.preview),
    failures: [],
    runSummary: emptyRunSummary(),
    startedAt: now,
    updatedAt: now,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function inspectCurrentSource(file: LocalCreativeIngestFile): Promise<{
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}> {
  const requested = path.resolve(file.absolutePath);
  const before = await lstat(requested);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("源媒体不是安全普通文件或已变成符号链接。");
  const sourcePath = path.normalize(await realpath(requested));
  if (sourcePath !== requested) throw new Error("源媒体 realpath 已漂移。");
  const sizeBytes = before.size;
  const mtimeMs = Math.trunc(before.mtimeMs);
  if (sizeBytes !== file.sizeBytes || mtimeMs !== file.mtimeMs) {
    throw new Error("源媒体 size/mtime 已不同于只读预览；请重新盘点后再导入。");
  }
  const sha256 = await sha256File(sourcePath);
  const after = await lstat(sourcePath);
  if (!after.isFile() || after.isSymbolicLink()
    || after.size !== before.size
    || Math.trunc(after.mtimeMs) !== mtimeMs) {
    throw new Error("源媒体在 SHA 计算期间发生漂移。");
  }
  if (file.sha256 && file.sha256 !== sha256) throw new Error("源媒体 SHA-256 已不同于只读预览。");
  return { sourcePath, sizeBytes, mtimeMs, sha256 };
}

function originAbsolutePath(projectRoot: string, origin: StudioMediaImportOrigin): string {
  return origin.source.scope === "project"
    ? path.resolve(projectRoot, origin.source.projectRelativePath)
    : path.resolve(origin.source.absolutePath);
}

/**
 * 校验一个"来源合同声明引用"路径的媒体身份：路径可位于内容导入源层之外
 * （如独立锁库或另一工程的 imports），只要该文件曾经真实导入（精确 import
 * origin：同路径+同字节数+同 SHA）且现场文件与 CAS 对象双复验通过。
 * 与 readValidatedLocalCreativeImportedMediaIdentityIndex 主路径同强度
 * fail-closed；任何一环不满足返回 null，绝不猜测。
 */
export async function readValidatedExternalDeclaredReferenceMediaSha256(
  projectRootInput: string,
  sourcePathInput: string,
): Promise<string | null> {
  const shell = await inspectManagedProjectReadOnly(projectRootInput);
  const projectRoot = shell.paths.root;
  const sourcePath = path.resolve(sourcePathInput);
  const metadata = await lstat(sourcePath).catch(() => null);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) return null;
  const realPath = await realpath(sourcePath).catch(() => null);
  if (realPath !== sourcePath) return null;
  const sha256 = await sha256File(sourcePath);
  if (!await hasExactOrigin(projectRoot, sha256, sourcePath, metadata.size)) return null;
  const media = await getStudioMedia(projectRoot, sha256);
  if (!media || media.sha256 !== sha256 || media.sizeBytes !== metadata.size) return null;
  const objectMetadata = await lstat(media.objectPath).catch(() => null);
  if (!objectMetadata
    || !objectMetadata.isFile()
    || objectMetadata.isSymbolicLink()
    || objectMetadata.size !== metadata.size
    || await sha256File(media.objectPath) !== sha256) {
    return null;
  }
  return sha256;
}

async function hasExactOrigin(
  projectRoot: string,
  sha256: string,
  sourcePath: string,
  sizeBytes: number,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await listStudioMediaImportOrigins(projectRoot, sha256, { cursor, limit: 100 });
    if (page.items.some((origin) => (
      originAbsolutePath(projectRoot, origin) === sourcePath
      && origin.sourceSizeBytes === sizeBytes
    ))) return true;
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

async function loadExistingMediaSha256(projectRoot: string): Promise<Set<string>> {
  const sha256 = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listStudioMedia(projectRoot, { cursor, limit: 100 });
    for (const item of page.items) sha256.add(item.sha256);
    cursor = page.nextCursor;
  } while (cursor);
  return sha256;
}

function mediaKindFor(file: LocalCreativeIngestFile, overrides: Record<string, StudioMediaKind> | undefined): StudioMediaKind {
  const explicit = overrides?.[file.fileId];
  if (explicit) return explicit;
  if (file.mediaKind === "image" || file.mediaKind === "video" || file.mediaKind === "audio") return file.mediaKind;
  throw new Error(`文件不是可导入媒体：${file.absolutePath}`);
}

function inferCanonicalCategory(file: LocalCreativeIngestFile): StudioCanonicalAssetCategory | null {
  const value = `${file.relativePath} ${file.basename}`.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const matches: StudioCanonicalAssetCategory[] = [];
  if (/(?:^|[/_.\-\s])(char(?:acter)?|role)(?:[/_.\-\s]|$)|角色|人物|三视图|身份锁/iu.test(value)) matches.push("character");
  if (/(?:^|[/_.\-\s])scene(?:[/_.\-\s]|$)|场景|环境|全景|地点/iu.test(value)) matches.push("scene");
  if (/(?:^|[/_.\-\s])prop(?:[/_.\-\s]|$)|道具|器物|武器|面具|法宝/iu.test(value)) matches.push("prop");
  if (/(?:^|[/_.\-\s])style(?:[/_.\-\s]|$)|风格|画风|视觉样式/iu.test(value)) matches.push("style");
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0]! : null;
}

function canonicalAssetId(
  projectKey: string,
  category: StudioCanonicalAssetCategory,
  mediaSha256: string,
): string {
  const projectSlug = projectKey.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "local-project";
  return `local-${projectSlug}-${category}-${mediaSha256.slice(0, 24)}`.slice(0, 128);
}

function canonicalName(file: LocalCreativeIngestFile): string {
  const withoutExtension = file.basename.slice(0, Math.max(0, file.basename.length - file.extension.length));
  const cleaned = withoutExtension
    .normalize("NFKC")
    .replace(/(?:^|[_\-\s])(user[-_ ]?approved|approved|authority|locked?|final)(?:$|[_\-\s])/giu, " ")
    .replace(/[_\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (cleaned || withoutExtension || "未命名锁图").slice(0, 256);
}

function sourceApprovalEvidence(file: LocalCreativeIngestFile): LocalCreativeCanonicalDecision["sourceApprovalEvidence"] {
  return file.evidence.map((entry) => ({
    level: entry.level,
    sourceFileId: entry.sourceFileId,
    sourcePath: entry.sourcePath,
    ...(entry.declaredSha256 ? { declaredSha256: entry.declaredSha256 } : {}),
  }));
}

function addFailure(
  progress: LocalCreativeProjectContentImportProgress,
  failure: Omit<LocalCreativeContentImportFailure, "occurredAt">,
): void {
  const entry: LocalCreativeContentImportFailure = { ...failure, occurredAt: new Date().toISOString() };
  const key = `${entry.phase}\0${entry.fileId ?? ""}\0${entry.path ?? ""}\0${entry.error}`;
  const exists = progress.failures.some((candidate) => (
    `${candidate.phase}\0${candidate.fileId ?? ""}\0${candidate.path ?? ""}\0${candidate.error}` === key
  ));
  if (!exists) progress.failures.push(entry);
}

function clearMediaFailure(
  progress: LocalCreativeProjectContentImportProgress,
  file: Pick<LocalCreativeIngestFile, "fileId" | "absolutePath">,
): void {
  const sourcePath = path.resolve(file.absolutePath);
  progress.failures = progress.failures.filter((failure) => (
    failure.phase !== "media"
    || (failure.fileId !== file.fileId && (!failure.path || path.resolve(failure.path) !== sourcePath))
  ));
}

export function buildLocalCreativeProjectContentSummary(
  progress: LocalCreativeProjectContentImportProgress,
): LocalCreativeProjectContentImportSummary {
  const decisionCounts: Record<string, number> = {};
  const pendingAssetIds = new Set<string>();
  for (const [fileId, decision] of Object.entries(progress.canonicalDecisionsByFileId)) {
    decisionCounts[decision.decision] = (decisionCounts[decision.decision] ?? 0) + 1;
    if (decision.decision === "pending-version-created" || decision.decision === "pending-version-reconciled") {
      pendingAssetIds.add(decision.assetId ?? fileId);
    }
  }
  return {
    schemaVersion: 1,
    kind: "local-creative-project-content-import-summary",
    projectRoot: progress.projectRoot,
    sourceProject: { ...progress.sourceProject },
    authorityPolicy: progress.authorityPolicy,
    documentLimit: progress.documentLimit,
    checkpointEvery: progress.checkpointEvery,
    previewFingerprint: progress.previewFingerprint,
    previewFingerprints: [...progress.previewFingerprints],
    ...(progress.completionBaselineFingerprint
      ? { completionBaselineFingerprint: progress.completionBaselineFingerprint }
      : {}),
    ...(progress.sourceInventory ? { sourceInventory: { ...progress.sourceInventory } } : {}),
    ...(progress.documentInventory ? { documentInventory: { ...progress.documentInventory } } : {}),
    ...(progress.documents.coverage ? { documentCoverage: { ...progress.documents.coverage } } : {}),
    status: progress.status,
    runSummary: { ...progress.runSummary },
    processedCounts: {
      media: Object.keys(progress.mediaByFileId).length,
      eligibleMedia: progress.runSummary.mediaEligible,
      documents: progress.runSummary.documentsImported + progress.runSummary.documentsSkippedDuplicate,
      pendingAssets: pendingAssetIds.size,
    },
    decisionCounts,
    failureCounts: {
      total: progress.failures.length,
      document: progress.failures.filter((failure) => failure.phase === "document").length,
      media: progress.failures.filter((failure) => failure.phase === "media").length,
      canonicalAsset: progress.failures.filter((failure) => failure.phase === "canonical-asset").length,
    },
    updatedAt: progress.updatedAt,
    ...(progress.completedAt ? { completedAt: progress.completedAt } : {}),
  };
}

/**
 * 项目列表使用的小型、严格终态核验。
 *
 * 只读取 compact summary 指向的一份内容寻址收据，不读取可能达到数十 MB 的
 * mutable progress。任何缺字段、换项目、换 manifest、换 inventory 或收据被
 * 替换都返回 false；调用方只能显示 unverified，不能回退到“completed 即当前”。
 */
export async function verifyLocalCreativeContentImportSummaryCompletionBaseline(
  requestedProjectRoot: string,
  summary: LocalCreativeProjectContentImportSummary,
): Promise<boolean> {
  try {
    if ((summary.status !== "completed" && summary.status !== "completed-with-failures")
      || !summary.completionBaselineFingerprint
      || !summary.sourceInventory
      || !summary.documentCoverage
      || !summary.completedAt
      || !Number.isInteger(summary.documentLimit)
      || !Number.isInteger(summary.checkpointEvery)) {
      return false;
    }
    const shell = await inspectManagedProjectReadOnly(requestedProjectRoot);
    const projectRoot = shell.paths.root;
    if (path.resolve(summary.projectRoot) !== projectRoot) return false;
    const expected = buildLocalCreativeContentImportCompletionBaseline({
      project: {
        id: shell.project.id,
        root: projectRoot,
        manifestFingerprint: shell.manifestFingerprint,
        sourceProject: { ...summary.sourceProject },
      },
      previewFingerprint: summary.previewFingerprint,
      sourceInventory: summary.sourceInventory,
      completion: {
        status: summary.status,
        authorityPolicy: summary.authorityPolicy,
        documentLimit: summary.documentLimit,
        checkpointEvery: summary.checkpointEvery,
        completedAt: summary.completedAt,
        runSummary: { ...summary.runSummary, authorityPromotions: 0 as const },
        processedMediaRecords: summary.processedCounts.media,
        failures: {
          total: summary.failureCounts.total,
          byPhase: {
            document: summary.failureCounts.document,
            media: summary.failureCounts.media,
            "canonical-asset": summary.failureCounts.canonicalAsset,
          },
        },
        documentCoverage: { ...summary.documentCoverage },
      },
    });
    if (expected.fingerprint !== summary.completionBaselineFingerprint) return false;
    const directory = await inspectExistingConfinedDirectory(
      projectRoot,
      path.join(projectRoot, LOCAL_CREATIVE_CONTENT_COMPLETION_BASELINE_RELATIVE_ROOT),
    );
    const read = await readConfinedRegularFileWithIdentity(
      directory,
      `${summary.completionBaselineFingerprint}.json`,
      4 * 1024 * 1024,
    );
    const parsed = JSON.parse(read.bytes.toString("utf8")) as LocalCreativeContentImportCompletionBaselineReceipt;
    return parsed.fingerprint === expected.fingerprint
      && JSON.stringify(stableValue(parsed)) === JSON.stringify(stableValue(expected));
  } catch {
    return false;
  }
}

async function assertOptionalSafeSummaryTarget(summaryPath: string): Promise<void> {
  const metadata = await lstat(summaryPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`内容导入摘要不是安全普通文件：${summaryPath}`);
  }
}

async function persistProgress(
  progressPath: string,
  progress: LocalCreativeProjectContentImportProgress,
): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  await writeJsonAtomic(progressPath, progress);
  const summaryPath = path.join(path.dirname(progressPath), path.basename(LOCAL_CREATIVE_CONTENT_SUMMARY_RELATIVE_PATH));
  await assertOptionalSafeSummaryTarget(summaryPath);
  await writeJsonAtomic(summaryPath, buildLocalCreativeProjectContentSummary(progress));
}

async function emitProgress(
  callback: LocalCreativeProjectContentImportInput["onProgress"],
  input: Omit<LocalCreativeProjectContentImportProgressEvent, "elapsedMs" | "ratePerSecond" | "remainingMedia" | "runSummary"> & {
    startedAtMs: number;
    progress: LocalCreativeProjectContentImportProgress;
  },
): Promise<void> {
  if (!callback) return;
  const elapsedMs = Math.max(0, Date.now() - input.startedAtMs);
  const remainingMedia = Math.max(0, input.totalMedia - input.completedMedia);
  await callback({
    phase: input.phase,
    projectRoot: input.projectRoot,
    progressPath: input.progressPath,
    completedMedia: input.completedMedia,
    totalMedia: input.totalMedia,
    remainingMedia,
    elapsedMs,
    ratePerSecond: elapsedMs > 0 ? Number((input.completedMedia * 1_000 / elapsedMs).toFixed(3)) : 0,
    checkpointWritten: input.checkpointWritten,
    ...(input.currentFileId ? { currentFileId: input.currentFileId } : {}),
    ...(input.currentPath ? { currentPath: input.currentPath } : {}),
    ...(input.action ? { action: input.action } : {}),
    runSummary: { ...input.progress.runSummary },
  });
}

async function importDocuments(
  projectRoot: string,
  progressPath: string,
  progress: LocalCreativeProjectContentImportProgress,
  preview: LocalCreativeProjectIngestPreview,
  onProgress: LocalCreativeProjectContentImportInput["onProgress"],
  startedAtMs: number,
): Promise<void> {
  const selected = selectLocalCreativeProjectDocuments(preview, progress.documentLimit);
  progress.documents.selected = selected;
  progress.documents.coverage = documentCoverage(preview, progress.documentLimit, selected.length);
  progress.runSummary.documentsSelected = selected.length;
  await persistProgress(progressPath, progress);
  if (!selected.length) {
    progress.documents.results = [];
    await emitProgress(onProgress, {
      phase: "documents",
      projectRoot,
      progressPath,
      completedMedia: 0,
      totalMedia: 0,
      checkpointWritten: true,
      action: "document-batch",
      startedAtMs,
      progress,
    });
    return;
  }
  const results = [];
  for (const kind of ["script", "prompt"] as const) {
    const sources = selected
      .filter((entry) => entry.documentKind === kind)
      .map((entry) => ({
        path: entry.path,
        sourceRoot: entry.sourceRoot,
        sizeBytes: entry.sizeBytes,
        mtimeMs: entry.mtimeMs,
        sha256: entry.sha256,
      }));
    if (!sources.length) continue;
    results.push(await importStudioTextLibraryFiles(projectRoot, {
      sourceSnapshots: sources,
      kind,
      source: `local-creative-ingest:${preview.project.key}`,
      sourceVersion: progress.sourceInventory?.fingerprint.slice(-24) ?? preview.previewFingerprint.slice(-24),
    }));
  }
  progress.documents.results = results.flatMap((result) => result.files);
  progress.runSummary.documentsImported = results.reduce((sum, result) => sum + result.imported, 0);
  progress.runSummary.documentsSkippedDuplicate = results.reduce((sum, result) => sum + result.skippedDuplicate, 0);
  progress.runSummary.documentsFailed = results.reduce((sum, result) => sum + result.failed, 0);
  for (const file of progress.documents.results.filter((entry) => entry.status === "failed")) {
    const selectedFile = selected.find((entry) => entry.path === file.sourcePath);
    addFailure(progress, {
      phase: "document",
      fileId: selectedFile?.fileId,
      path: file.sourcePath,
      error: file.error ?? "剧本文档导入失败。",
    });
  }
  await persistProgress(progressPath, progress);
  await emitProgress(onProgress, {
    phase: "documents",
    projectRoot,
    progressPath,
    completedMedia: 0,
    totalMedia: 0,
    checkpointWritten: true,
    action: "document-batch",
    startedAtMs,
    progress,
  });
}

async function materializePendingAsset(
  projectRoot: string,
  progress: LocalCreativeProjectContentImportProgress,
  file: LocalCreativeIngestFile,
  mediaSha256: string,
  categoryOverride: StudioCanonicalAssetCategory | undefined,
): Promise<LocalCreativeCanonicalDecision> {
  const now = new Date().toISOString();
  const base: Omit<LocalCreativeCanonicalDecision, "decision"> = {
    fileId: file.fileId,
    sourcePath: file.absolutePath,
    sourceStatus: file.status,
    mediaSha256,
    authorityPromoted: false,
    sourceApprovalEvidence: sourceApprovalEvidence(file),
    updatedAt: now,
  };
  if (progress.authorityPolicy === "FORBID_ALL") return { ...base, decision: "forbidden-by-policy" };
  if (file.sourceLayer.role === "UNASSIGNED_INBOX") return { ...base, decision: "forbidden-inbox" };
  if (file.status !== "APPROVED_LOCK" || file.mediaKind !== "image") return { ...base, decision: "not-applicable" };
  const category = categoryOverride ?? inferCanonicalCategory(file);
  if (!category) return { ...base, decision: "category-unresolved" };
  const assetId = canonicalAssetId(progress.sourceProject.key, category, mediaSha256);
  let asset = await getStudioCanonicalAsset(projectRoot, assetId);
  let created = false;
  if (!asset) {
    asset = await createStudioCanonicalAsset(projectRoot, {
      id: assetId,
      expectedRevision: 0,
      category,
      name: canonicalName(file),
      description: "由本机创作项目只读盘点中的显式 APPROVED_LOCK 证据建立；当前仅为待人工复核资产，未批准、未提升主权威。",
      aliases: [file.basename],
      applicability: { projects: [progress.sourceProject.key], tags: ["local-creative-ingest", "pending-authority-review"] },
    });
    created = true;
  }
  if (asset.category !== category) throw new Error(`确定性资产 ${assetId} 的类别与当前导入冲突。`);
  const existingVersion = asset.versions.find((version) => version.mediaSha256 === mediaSha256);
  if (existingVersion) {
    return {
      ...base,
      decision: "pending-version-reconciled",
      assetId,
      category,
      versionId: existingVersion.id,
    };
  }
  const appended = await appendStudioAssetVersion(projectRoot, {
    assetId,
    mediaSha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
    sourceNote: `外部源声明 APPROVED_LOCK；证据来自 ${file.relativePath}。只创建 pending，等待本工程人工视觉裁决。`,
  });
  return {
    ...base,
    decision: created ? "pending-version-created" : "pending-version-reconciled",
    assetId,
    category,
    versionId: appended.version.id,
  };
}

async function importMediaSequentially(
  projectRoot: string,
  progressPath: string,
  progress: LocalCreativeProjectContentImportProgress,
  input: LocalCreativeProjectContentImportInput,
): Promise<void> {
  const mediaFiles = input.preview.files.filter((file) => (
    file.mediaKind === "image" || file.mediaKind === "video" || file.mediaKind === "audio"
  ));
  progress.runSummary.mediaRejected = mediaFiles.filter((file) => file.status === "REJECTED_OR_FORBIDDEN").length;
  const eligible = mediaFiles
    .filter((file) => file.status !== "REJECTED_OR_FORBIDDEN")
    .sort((left, right) => (
      left.sourceLayer.role.localeCompare(right.sourceLayer.role, "en")
      || left.absolutePath.localeCompare(right.absolutePath, "en")
      || left.fileId.localeCompare(right.fileId, "en")
    ));
  progress.runSummary.mediaEligible = eligible.length;
  await persistProgress(progressPath, progress);
  const existingMediaSha256 = await loadExistingMediaSha256(projectRoot);
  const startedAtMs = Date.now();
  let completedMedia = 0;
  let sinceCheckpoint = 0;

  // 有意保持 for...of + await；正式媒体导入并发恒为 1。
  for (const file of eligible) {
    try {
      const current = await inspectCurrentSource(file);
      const kind = mediaKindFor(file, input.mediaKindByFileId);
      const recorded = progress.mediaByFileId[file.fileId];
      const recordedMatches = Boolean(recorded
        && recorded.sourcePath === current.sourcePath
        && recorded.sizeBytes === current.sizeBytes
        && recorded.mtimeMs === current.mtimeMs
        && recorded.sha256 === current.sha256
        && recorded.kind === kind);
      const mediaExists = existingMediaSha256.has(current.sha256);
      const originExists = !recordedMatches && mediaExists
        ? await hasExactOrigin(projectRoot, current.sha256, current.sourcePath, current.sizeBytes)
        : false;
      let lastAction: LocalCreativeImportedMediaProgress["lastAction"];
      let status: LocalCreativeImportedMediaProgress["status"];
      if (recordedMatches && mediaExists) {
        lastAction = "skipped-recorded";
        status = recorded!.status;
        progress.runSummary.mediaSkippedRecorded += 1;
      } else if (originExists) {
        lastAction = "reconciled-existing";
        status = "reconciled-existing";
        progress.runSummary.mediaReconciled += 1;
      } else {
        const imported = await importStudioMedia(projectRoot, {
          sourcePath: current.sourcePath,
          kind,
          expectedSha256: current.sha256,
        });
        if (imported.sha256 !== current.sha256 || imported.kind !== kind) {
          throw new Error("Material Studio 返回的媒体身份与导入请求不一致。");
        }
        lastAction = "imported";
        status = "imported";
        progress.runSummary.mediaImported += 1;
        existingMediaSha256.add(imported.sha256);
      }
      const now = new Date().toISOString();
      progress.mediaByFileId[file.fileId] = {
        fileId: file.fileId,
        sourcePath: current.sourcePath,
        sourceLayerRole: file.sourceLayer.role,
        sizeBytes: current.sizeBytes,
        mtimeMs: current.mtimeMs,
        sha256: current.sha256,
        kind,
        status,
        lastAction,
        importedAt: recorded?.importedAt ?? now,
        updatedAt: now,
      };
      clearMediaFailure(progress, file);
      completedMedia += 1;
      sinceCheckpoint += 1;

      if (file.status === "APPROVED_LOCK" && kind === "image") {
        let decisionAction: LocalCreativeCanonicalDecision["decision"] | "failed";
        try {
          const decision = await materializePendingAsset(
            projectRoot,
            progress,
            file,
            current.sha256,
            input.canonicalCategoryByFileId?.[file.fileId],
          );
          progress.canonicalDecisionsByFileId[file.fileId] = decision;
          decisionAction = decision.decision;
          if (decision.decision === "pending-version-created") progress.runSummary.pendingAssetsCreated += 1;
          else if (decision.decision === "pending-version-reconciled") progress.runSummary.pendingAssetsReconciled += 1;
        } catch (error) {
          decisionAction = "failed";
          addFailure(progress, {
            phase: "canonical-asset",
            fileId: file.fileId,
            path: file.absolutePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await persistProgress(progressPath, progress);
        sinceCheckpoint = 0;
        await emitProgress(input.onProgress, {
          phase: "canonical-asset",
          projectRoot,
          progressPath,
          completedMedia,
          totalMedia: eligible.length,
          checkpointWritten: true,
          currentFileId: file.fileId,
          currentPath: file.absolutePath,
          action: decisionAction,
          startedAtMs,
          progress,
        });
      } else {
        const checkpointWritten = sinceCheckpoint >= progress.checkpointEvery;
        if (checkpointWritten) {
          await persistProgress(progressPath, progress);
          sinceCheckpoint = 0;
        }
        await emitProgress(input.onProgress, {
          phase: "media",
          projectRoot,
          progressPath,
          completedMedia,
          totalMedia: eligible.length,
          checkpointWritten,
          currentFileId: file.fileId,
          currentPath: file.absolutePath,
          action: lastAction,
          startedAtMs,
          progress,
        });
      }
    } catch (error) {
      completedMedia += 1;
      progress.runSummary.mediaFailed += 1;
      clearMediaFailure(progress, file);
      addFailure(progress, {
        phase: "media",
        fileId: file.fileId,
        path: file.absolutePath,
        error: error instanceof Error ? error.message : String(error),
      });
      await persistProgress(progressPath, progress);
      sinceCheckpoint = 0;
      await emitProgress(input.onProgress, {
        phase: "media",
        projectRoot,
        progressPath,
        completedMedia,
        totalMedia: eligible.length,
        checkpointWritten: true,
        currentFileId: file.fileId,
        currentPath: file.absolutePath,
        action: "failed",
        startedAtMs,
        progress,
      });
    }
  }
  // 即便最后一批不足 checkpointEvery，结束前也必须把累计成功项落盘。
  await persistProgress(progressPath, progress);
}

export async function importLocalCreativeProjectContent(
  input: LocalCreativeProjectContentImportInput,
): Promise<LocalCreativeProjectContentImportProgress> {
  if (!LOCAL_CREATIVE_AUTHORITY_POLICIES.includes(input.authorityPolicy)) {
    throw new Error(`未知 authorityPolicy：${String(input.authorityPolicy)}`);
  }
  if (input.preview.kind !== "local-creative-project-ingest-preview" || !input.preview.readOnly) {
    throw new Error("必须提供只读本机创作项目盘点预览。");
  }
  if (!SHA256_PATTERN.test(input.preview.previewFingerprint.replace(/^local-creative-/u, ""))) {
    throw new Error("盘点预览 fingerprint 无效。");
  }
  const shell = await inspectManagedProjectReadOnly(input.projectRoot);
  const projectRoot = shell.paths.root;
  const documentLimit = normalizedDocumentLimit(input.documentLimit);
  const checkpointEvery = normalizedCheckpointEvery(input.checkpointEvery);
  const progressPath = path.join(projectRoot, PROGRESS_RELATIVE_PATH);

  return withProjectLock(projectRoot, "local-creative-content-import", async () => {
    const startedAtMs = Date.now();
    const existing = await loadProgress(progressPath);
    const progress = initialProgress(projectRoot, input, documentLimit, checkpointEvery, existing);
    await persistProgress(progressPath, progress);
    await emitProgress(input.onProgress, {
      phase: "initialized",
      projectRoot,
      progressPath,
      completedMedia: 0,
      totalMedia: input.preview.files.filter((file) => file.mediaKind !== "document" && file.status !== "REJECTED_OR_FORBIDDEN").length,
      checkpointWritten: true,
      startedAtMs,
      progress,
    });
    await importDocuments(projectRoot, progressPath, progress, input.preview, input.onProgress, startedAtMs);
    await importMediaSequentially(projectRoot, progressPath, progress, input);
    progress.status = progress.runSummary.documentsFailed > 0 || progress.runSummary.mediaFailed > 0
      || progress.failures.some((failure) => failure.phase === "canonical-asset")
      ? "completed-with-failures"
      : "completed";
    progress.completedAt = new Date().toISOString();
    if (!progress.sourceInventory) {
      throw new Error("内容导入完成但缺少精确来源 inventory，拒绝签发完成基线。");
    }
    const completionBaseline = buildLocalCreativeContentImportCompletionBaseline({
      project: {
        id: shell.project.id,
        root: projectRoot,
        manifestFingerprint: shell.manifestFingerprint,
        sourceProject: { ...progress.sourceProject },
      },
      previewFingerprint: progress.previewFingerprint,
      sourceInventory: progress.sourceInventory,
      completion: {
        status: progress.status,
        authorityPolicy: progress.authorityPolicy,
        documentLimit: progress.documentLimit,
        checkpointEvery: progress.checkpointEvery,
        completedAt: progress.completedAt,
        runSummary: { ...progress.runSummary },
        processedMediaRecords: Object.keys(progress.mediaByFileId).length,
        failures: completionFailureCounts(progress.failures),
        documentCoverage: progress.documents.coverage ? { ...progress.documents.coverage } : null,
      },
    });
    // 提交顺序：不可变基线先落盘，随后 mutable progress 只登记其内容身份。
    // 崩溃在两者之间只会留下不可达孤儿收据，旧 progress 仍保持 in-progress。
    await persistCompletionBaseline(projectRoot, completionBaseline);
    progress.completionBaselineFingerprint = completionBaseline.fingerprint;
    await persistProgress(progressPath, progress);
    await emitProgress(input.onProgress, {
      phase: "completed",
      projectRoot,
      progressPath,
      completedMedia: progress.runSummary.mediaEligible,
      totalMedia: progress.runSummary.mediaEligible,
      checkpointWritten: true,
      action: "completed",
      startedAtMs,
      progress,
    });
    return progress;
  });
}

export interface BackfillLocalCreativeProjectContentSummaryResult {
  projectRoot: string;
  progressPath: string;
  summaryPath: string;
  summary: LocalCreativeProjectContentImportSummary;
}

/**
 * 只读取既有导入进度并写入紧凑摘要；不会重扫来源、重算媒体 SHA 或修改活动项目。
 */
export async function backfillLocalCreativeProjectContentSummary(
  requestedProjectRoot: string,
): Promise<BackfillLocalCreativeProjectContentSummaryResult> {
  const shell = await inspectManagedProjectReadOnly(requestedProjectRoot);
  const projectRoot = shell.paths.root;
  const progressPath = path.join(projectRoot, LOCAL_CREATIVE_CONTENT_PROGRESS_RELATIVE_PATH);
  const summaryPath = path.join(projectRoot, LOCAL_CREATIVE_CONTENT_SUMMARY_RELATIVE_PATH);
  return withProjectLock(projectRoot, "local-creative-content-import", async () => {
    const progress = await loadProgress(progressPath);
    if (!progress) throw new Error(`项目没有可回填的内容导入进度：${progressPath}`);
    if (path.resolve(progress.projectRoot) !== projectRoot) {
      throw new Error(`内容导入进度绑定了其他项目，拒绝回填：${progressPath}`);
    }
    await assertOptionalSafeSummaryTarget(summaryPath);
    const summary = buildLocalCreativeProjectContentSummary(progress);
    await writeJsonAtomic(summaryPath, summary);
    return { projectRoot, progressPath, summaryPath, summary };
  });
}
