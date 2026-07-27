import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  inspectLocalCreativeProject,
  LOCAL_CREATIVE_SOURCE_LAYER_ROLES,
  type LocalCreativeProjectIngestPreview,
  type LocalCreativeSourceLayerRole,
} from "./local-creative-project-ingest.js";
import {
  buildLocalCreativeContentImportCompletionBaseline,
  localCreativeContentImportCompletionBaselineRelativePath,
  LOCAL_CREATIVE_CONTENT_COMPLETION_BASELINE_RELATIVE_ROOT,
  type LocalCreativeContentImportCompletionBaselineReceipt,
  type LocalCreativeDocumentCoverage,
} from "./local-creative-project-content-import.js";
import {
  inspectExistingConfinedDirectory,
  readConfinedRegularFileWithIdentity,
} from "./confined-project-storage.js";
import {
  inspectLocalCreativeSourceInventory,
  localCreativeSourceInventoryFromPreview,
  type LocalCreativeSourceInventoryLayer,
  type LocalCreativeSourceInventorySnapshot,
} from "./local-creative-source-inventory.js";
import {
  buildLocalCreativeSourceDocumentInventory,
  classifyLocalCreativeSourceDocument,
  type LocalCreativeDocumentClass,
  type LocalCreativeSourceDocumentRecord,
} from "./local-creative-document-inventory.js";

const SCHEMA_VERSION = 1 as const;
const INGEST_RELATIVE_PATH = ".aicanvas/local-creative-project-ingest.json";
const CONTENT_IMPORT_RELATIVE_PATH = ".aicanvas/local-creative-project-content-import.json";
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const MAX_SOURCE_LAYERS = 64;
const MAX_REFERENCES_PER_LOCK = 20;
const MAX_EVIDENCE_PER_DECISION = 20;
const MAX_TEXT_LENGTH = 16_384;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREVIEW_FINGERPRINT_PATTERN = /^local-creative-[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface LocalCreativeProjectIngestStatusQuery {
  cursor?: string;
  limit?: number;
  /**
   * 默认 true：重新只读盘点当前外部来源，禁止把两份历史 fingerprint 相等
   * 冒充“源目录当前”。Project Center 的紧凑摘要使用独立轻量盘点。
   */
  refreshSource?: boolean;
}

export interface LocalCreativeProjectIngestStatusProjection {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "local-creative-project-ingest-status";
  project: {
    id: string;
    key: string;
    name: string;
    type: string;
    resolution: "CREATE_MANAGED" | "CREATE_INBOX";
    manifestFingerprint: string;
  };
  sourceLayers: Array<{
    order: number;
    role: string;
    root: string;
    rootBasename: string;
    rootFingerprint: string;
    label?: string;
    maxDepth?: number;
    excludeRelativePrefixes: string[];
  }>;
  scan: {
    status: "scanned";
    previewFingerprint: string | null;
    totalFiles: number;
    totalBytes: number;
    byMediaKind: Record<"document" | "image" | "video" | "audio", number>;
    byStatus: {
      approved: number;
      candidate: number;
      rejected: number;
      formalMedia: number;
      unknown: number;
    };
    references: number;
    locksWithReferences: number;
    warningCount: number;
  };
  contentImport: {
    status: "not-started" | "in-progress" | "completed" | "completed-with-failures";
    truthStatus:
      | "NOT_IMPORTED"
      | "IN_PROGRESS"
      | "CURRENT_COMPLETE"
      | "PARTIAL_BY_POLICY"
      | "RACE_DETECTED"
      | "STALE"
      | "FAILED"
      | "UNVERIFIED";
    appliedAuthorityPolicy: "FORBID_ALL" | "CREATE_PENDING_FROM_APPROVED_LOCKS" | null;
    previewFingerprint: string | null;
    sourceSnapshot: "not-imported" | "current" | "stale" | "race" | "unknown";
    sourceCheck: {
      checkedAt: string | null;
      verificationInventoryFingerprint: string | null;
      previewDerivedInventoryFingerprint: string | null;
      importBaselineInventoryFingerprint: string | null;
      /** @deprecated 使用 verificationInventoryFingerprint。 */
      livePreviewFingerprint: string | null;
      /** @deprecated 使用 previewDerivedInventoryFingerprint。 */
      previewInventoryFingerprint: string | null;
      /** @deprecated 使用 importBaselineInventoryFingerprint。 */
      baselinePreviewFingerprint: string | null;
      fingerprintBasis: "content-sha256-inventory-v3-double-scan";
      raceDetected: boolean;
      liveFiles: number | null;
      /** 当前内容导入基线；尚未导入时回落到首次物化扫描。 */
      baselineFiles: number;
      liveBytes: number | null;
      /** 当前内容导入基线；尚未导入时回落到首次物化扫描。 */
      baselineBytes: number;
      filesDelta: number | null;
      bytesDelta: number | null;
      error: string | null;
    };
    completionBaseline: {
      status: "not-applicable" | "valid" | "missing" | "invalid";
      fingerprint: string | null;
      relativePath: string | null;
      error: string | null;
    };
    documentCoverage: LocalCreativeDocumentCoverage;
    documentCoverageVerified: boolean;
    documentClassification: {
      verified: boolean;
      byClass: Record<LocalCreativeDocumentClass, number>;
      byImportTarget: Record<LocalCreativeSourceDocumentRecord["importTarget"], number>;
    };
    documentLimit: number | null;
    checkpointEvery: number | null;
    startedAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
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
      authorityPromotions: number;
    };
    processedMediaRecords: number;
    failures: {
      total: number;
      byPhase: Record<"document" | "media" | "canonical-asset", number>;
    };
  };
  managedCounts: {
    media: {
      unique: number;
      origins: number;
      image: number;
      video: number;
      audio: number;
    };
    documents: {
      total: number;
      script: number;
      prompt: number;
    };
    assets: {
      canonical: number;
      versions: number;
      pendingVersions: number;
      approvedVersions: number;
      rejectedVersions: number;
      primaryAuthorities: number;
    };
    production: {
      units: number;
      panels: number;
      timelineBindings: number;
    };
  };
  lockReferenceIndex: {
    available: boolean;
    total: number;
    offset: number;
    items: Array<{
      lockFileId: string;
      lockPath: string;
      lockBasename: string;
      lockPathFingerprint: string;
      status: "APPROVED_LOCK" | "CANDIDATE_LOCK";
      visualAppearance: "UNCONFIRMED";
      referencedByTotal: number;
      referencedByTruncated: boolean;
      referencedBy: Array<{
        fileId: string;
        path: string;
        basename: string;
        pathFingerprint: string;
        evidenceLevels: string[];
      }>;
    }>;
  };
  canonicalDecisions: {
    available: boolean;
    total: number;
    offset: number;
    counts: Record<
      | "pending-version-created"
      | "pending-version-reconciled"
      | "forbidden-by-policy"
      | "forbidden-inbox"
      | "category-unresolved"
      | "not-applicable",
      number
    >;
    items: Array<{
      fileId: string;
      sourcePath: string;
      sourceBasename: string;
      sourcePathFingerprint: string;
      sourceStatus: string;
      decision:
        | "pending-version-created"
        | "pending-version-reconciled"
        | "forbidden-by-policy"
        | "forbidden-inbox"
        | "category-unresolved"
        | "not-applicable";
      assetId?: string;
      category?: "character" | "scene" | "prop" | "style";
      versionId?: string;
      mediaSha256?: string;
      authorityPromoted: false;
      visualAppearance: "UNCONFIRMED";
      sourceApprovalEvidenceTotal: number;
      sourceApprovalEvidenceTruncated: boolean;
      sourceApprovalEvidence: Array<{
        level: string;
        sourceFileId: string;
        sourcePath: string;
        sourceBasename: string;
        sourcePathFingerprint: string;
        declaredSha256?: string;
      }>;
    }>;
  };
  page: {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
  };
  visualAppearance: "UNCONFIRMED";
  authority: {
    sourcePolicy: string;
    authorityInherited: false;
    sourceDeclarationsPromotedAutomatically: false;
    recordedImportPromotions: number;
    managedPrimaryAuthorities: number;
    note: string;
  };
  nextAction: {
    code:
      | "run-content-import"
      | "resume-content-import"
      | "refresh-source-preview"
      | "verify-source-snapshot"
      | "review-import-failures"
      | "review-document-coverage"
      | "resolve-canonical-categories"
      | "review-pending-assets"
      | "preview-production-units"
      | "ready-for-managed-reading";
    reason: string;
  };
  warnings: string[];
  fingerprint: string;
  builtAt: string;
}

interface SafeJsonSidecar {
  value: unknown;
  sha256: string;
}

interface ParsedIngestManifest {
  fingerprint: string;
  project: LocalCreativeProjectIngestStatusProjection["project"];
  sourceLayers: LocalCreativeProjectIngestStatusProjection["sourceLayers"];
  authorityPolicy: string;
  scan: LocalCreativeProjectIngestStatusProjection["scan"];
}

interface ParsedContentImport {
  rawSha256: string;
  previewFingerprint: string | null;
  documentCoverage: LocalCreativeDocumentCoverage | null;
  sourceInventory: LocalCreativeSourceInventorySnapshot | null;
  status: Exclude<LocalCreativeProjectIngestStatusProjection["contentImport"]["status"], "not-started">;
  appliedAuthorityPolicy: Exclude<LocalCreativeProjectIngestStatusProjection["contentImport"]["appliedAuthorityPolicy"], null>;
  documentLimit: number | null;
  checkpointEvery: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  runSummary: LocalCreativeProjectIngestStatusProjection["contentImport"]["runSummary"];
  processedMediaRecords: number;
  failures: LocalCreativeProjectIngestStatusProjection["contentImport"]["failures"];
  lockReferenceIndex: unknown[];
  canonicalDecisions: Array<[string, unknown]>;
  completionBaselineFingerprint: string | null;
}

interface ManagedDatabaseCounts {
  managedCounts: LocalCreativeProjectIngestStatusProjection["managedCounts"];
  warnings: string[];
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象。`);
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown, label: string, options: { optional?: boolean; max?: number } = {}): string | null {
  if (value === undefined || value === null) {
    if (options.optional) return null;
    throw new Error(`${label} 缺失。`);
  }
  if (typeof value !== "string") throw new Error(`${label} 必须是文本。`);
  const normalized = value.normalize("NFC");
  if (!normalized || normalized.includes("\0") || normalized.length > (options.max ?? MAX_TEXT_LENGTH)) {
    throw new Error(`${label} 为空、含 NUL 或过长。`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonRecord)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readSafeJsonSidecar(
  filePath: string,
  label: string,
  required: boolean,
): Promise<SafeJsonSidecar | null> {
  const before = await lstat(filePath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!before) {
    if (required) throw new Error(`${label} 不存在：${filePath}`);
    return null;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} 必须是非符号链接普通文件。`);
  if (before.size > MAX_SIDECAR_BYTES) throw new Error(`${label} 超过 ${MAX_SIDECAR_BYTES} 字节安全上限。`);
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink()
    || after.size !== before.size || Math.trunc(after.mtimeMs) !== Math.trunc(before.mtimeMs)
    || bytes.byteLength !== before.size) {
    throw new Error(`${label} 在读取期间发生变化，请重试。`);
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as unknown, sha256: sha256(bytes) };
  } catch (error) {
    throw new Error(`${label} JSON 无法解析。`, { cause: error });
  }
}

function parseSourceLayers(value: unknown): LocalCreativeProjectIngestStatusProjection["sourceLayers"] {
  if (!Array.isArray(value)) throw new Error("ingest manifest sourceLayers 必须是数组。");
  if (value.length > MAX_SOURCE_LAYERS) throw new Error(`ingest manifest sourceLayers 超过 ${MAX_SOURCE_LAYERS} 项。`);
  return value.map((entry, index) => {
    const layer = record(entry, `sourceLayers[${index}]`);
    const order = nonNegativeInteger(layer.order, index);
    const role = text(layer.role, `sourceLayers[${index}].role`)!;
    const root = text(layer.root, `sourceLayers[${index}].root`)!;
    if (!path.isAbsolute(root)) throw new Error(`sourceLayers[${index}].root 必须是绝对路径。`);
    const label = text(layer.label, `sourceLayers[${index}].label`, { optional: true });
    const maxDepth = optionalNonNegativeInteger(layer.maxDepth);
    const prefixes = Array.isArray(layer.excludeRelativePrefixes)
      ? layer.excludeRelativePrefixes.map((item, prefixIndex) => text(
        item,
        `sourceLayers[${index}].excludeRelativePrefixes[${prefixIndex}]`,
        { max: 4_096 },
      )!)
      : [];
    return {
      order,
      role,
      root,
      rootBasename: path.basename(root),
      rootFingerprint: sha256(root),
      ...(label ? { label } : {}),
      ...(maxDepth !== null ? { maxDepth } : {}),
      excludeRelativePrefixes: prefixes,
    };
  }).sort((left, right) => left.order - right.order || left.root.localeCompare(right.root, "en"));
}

function parseIngestManifest(
  value: unknown,
  shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>,
): ParsedIngestManifest {
  const manifest = record(value, "local creative ingest manifest");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "local-creative-project-ingest") {
    throw new Error("项目不是受支持的本机创作导入工程。");
  }
  const fingerprint = text(manifest.fingerprint, "ingest manifest fingerprint")!;
  if (!SHA256_PATTERN.test(fingerprint)) throw new Error("ingest manifest fingerprint 格式无效。");
  const { fingerprint: _ignored, ...semantic } = manifest;
  if (sha256(JSON.stringify(stableValue(semantic))) !== fingerprint) {
    throw new Error("ingest manifest fingerprint 不匹配。");
  }

  const projectValue = record(manifest.project, "ingest manifest project");
  const id = text(projectValue.projectId, "ingest project.projectId")!;
  const key = text(projectValue.key, "ingest project.key")!;
  const name = text(projectValue.name, "ingest project.name")!;
  const type = text(projectValue.type, "ingest project.type")!;
  const resolution = projectValue.resolution;
  if (resolution !== "CREATE_MANAGED" && resolution !== "CREATE_INBOX") {
    throw new Error("ingest project.resolution 无效。");
  }
  const recordedRoot = text(projectValue.projectRoot, "ingest project.projectRoot")!;
  if (path.resolve(recordedRoot) !== shell.paths.root || id !== shell.project.id || name !== shell.project.name) {
    throw new Error("ingest manifest 项目身份与受管工程不一致。");
  }
  const authorityPolicy = text(manifest.authorityPolicy, "ingest authorityPolicy")!;
  const scanSummary = record(manifest.scanSummary, "ingest scanSummary");
  const statistics = record(scanSummary.statistics, "ingest scanSummary.statistics");
  const media = optionalRecord(statistics.byMediaKind) ?? {};
  const statuses = optionalRecord(statistics.byStatus) ?? {};
  const locks = optionalRecord(scanSummary.lockEvidence) ?? {};
  const warnings = optionalRecord(scanSummary.warnings) ?? {};
  const previewFingerprint = typeof scanSummary.previewFingerprint === "string"
    && PREVIEW_FINGERPRINT_PATTERN.test(scanSummary.previewFingerprint)
    ? scanSummary.previewFingerprint
    : null;
  return {
    fingerprint,
    project: {
      id,
      key,
      name,
      type,
      resolution,
      manifestFingerprint: fingerprint,
    },
    sourceLayers: parseSourceLayers(manifest.sourceLayers),
    authorityPolicy,
    scan: {
      status: "scanned",
      previewFingerprint,
      totalFiles: nonNegativeInteger(statistics.totalFiles),
      totalBytes: nonNegativeInteger(statistics.totalBytes),
      byMediaKind: {
        document: nonNegativeInteger(media.document),
        image: nonNegativeInteger(media.image),
        video: nonNegativeInteger(media.video),
        audio: nonNegativeInteger(media.audio),
      },
      byStatus: {
        approved: nonNegativeInteger(locks.approved, nonNegativeInteger(statuses.APPROVED_LOCK)),
        candidate: nonNegativeInteger(locks.candidate, nonNegativeInteger(statuses.CANDIDATE_LOCK)),
        rejected: nonNegativeInteger(statuses.REJECTED_OR_FORBIDDEN),
        formalMedia: nonNegativeInteger(statuses.FORMAL_MEDIA),
        unknown: nonNegativeInteger(statuses.UNKNOWN),
      },
      references: nonNegativeInteger(locks.references, nonNegativeInteger(statistics.referenceCount)),
      locksWithReferences: nonNegativeInteger(locks.locksWithReferences),
      warningCount: nonNegativeInteger(warnings.total),
    },
  };
}

function emptyRunSummary(): LocalCreativeProjectIngestStatusProjection["contentImport"]["runSummary"] {
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

function parseRunSummary(value: unknown): LocalCreativeProjectIngestStatusProjection["contentImport"]["runSummary"] {
  const summary = optionalRecord(value) ?? {};
  const empty = emptyRunSummary();
  return Object.fromEntries(Object.keys(empty).map((key) => [
    key,
    nonNegativeInteger(summary[key]),
  ])) as unknown as LocalCreativeProjectIngestStatusProjection["contentImport"]["runSummary"];
}

function parseContentImport(
  sidecar: SafeJsonSidecar,
  manifest: ParsedIngestManifest,
  shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>,
): ParsedContentImport {
  const progress = record(sidecar.value, "local creative content import progress");
  if (progress.schemaVersion !== 1 || progress.kind !== "local-creative-project-content-import-progress") {
    throw new Error("local creative content import progress 结构无效。");
  }
  const projectRoot = text(progress.projectRoot, "content import projectRoot")!;
  const sourceProject = record(progress.sourceProject, "content import sourceProject");
  if (path.resolve(projectRoot) !== shell.paths.root
    || text(sourceProject.key, "content import sourceProject.key") !== manifest.project.key
    || text(sourceProject.name, "content import sourceProject.name") !== manifest.project.name
    || text(sourceProject.type, "content import sourceProject.type") !== manifest.project.type) {
    throw new Error("content import progress 绑定了其他项目。");
  }
  const status = progress.status;
  if (status !== "in-progress" && status !== "completed" && status !== "completed-with-failures") {
    throw new Error("content import progress status 无效。");
  }
  const previewFingerprint = typeof progress.previewFingerprint === "string"
    && PREVIEW_FINGERPRINT_PATTERN.test(progress.previewFingerprint)
    ? progress.previewFingerprint
    : null;
  const appliedAuthorityPolicy = progress.authorityPolicy;
  if (appliedAuthorityPolicy !== "FORBID_ALL" && appliedAuthorityPolicy !== "CREATE_PENDING_FROM_APPROVED_LOCKS") {
    throw new Error("content import authorityPolicy 无效。");
  }
  const mediaByFileId = optionalRecord(progress.mediaByFileId) ?? {};
  const failures = Array.isArray(progress.failures) ? progress.failures : [];
  const failureCounts = { document: 0, media: 0, "canonical-asset": 0 };
  for (const failure of failures) {
    const phase = optionalRecord(failure)?.phase;
    if (phase === "document" || phase === "media" || phase === "canonical-asset") failureCounts[phase] += 1;
  }
  const decisions = optionalRecord(progress.canonicalDecisionsByFileId) ?? {};
  const runSummary = parseRunSummary(progress.runSummary);
  const completionBaselineFingerprint = text(
    progress.completionBaselineFingerprint,
    "content import completionBaselineFingerprint",
    { optional: true, max: 64 },
  );
  if (completionBaselineFingerprint && !SHA256_PATTERN.test(completionBaselineFingerprint)) {
    throw new Error("content import completionBaselineFingerprint 格式无效。");
  }
  if (runSummary.authorityPromotions !== 0) {
    throw new Error("content import progress 违反“导入不提升权威”合同。");
  }
  return {
    rawSha256: sidecar.sha256,
    previewFingerprint,
    documentCoverage: parseDocumentCoverage(optionalRecord(progress.documents)?.coverage),
    sourceInventory: parseSourceInventory(progress.sourceInventory),
    status,
    appliedAuthorityPolicy,
    documentLimit: optionalNonNegativeInteger(progress.documentLimit),
    checkpointEvery: optionalNonNegativeInteger(progress.checkpointEvery),
    startedAt: optionalTimestamp(progress.startedAt),
    updatedAt: optionalTimestamp(progress.updatedAt),
    completedAt: optionalTimestamp(progress.completedAt),
    runSummary,
    processedMediaRecords: Object.keys(mediaByFileId).length,
    failures: { total: failures.length, byPhase: failureCounts },
    lockReferenceIndex: Array.isArray(progress.lockReferenceIndex) ? progress.lockReferenceIndex : [],
    canonicalDecisions: Object.entries(decisions),
    completionBaselineFingerprint,
  };
}

function parseSourceInventory(value: unknown): LocalCreativeSourceInventorySnapshot | null {
  const inventory = optionalRecord(value);
  if (!inventory) return null;
  if (inventory.schemaVersion !== 1
    || inventory.kind !== "local-creative-source-inventory"
    || !Number.isSafeInteger(inventory.totalFiles)
    || Number(inventory.totalFiles) < 0
    || typeof inventory.totalBytes !== "number"
    || !Number.isSafeInteger(inventory.totalBytes)
    || Number(inventory.totalBytes) < 0
    || typeof inventory.maxMtimeMs !== "number"
    || !Number.isFinite(inventory.maxMtimeMs)
    || !Array.isArray(inventory.layers)
    || typeof inventory.fingerprint !== "string"
    || !SHA256_PATTERN.test(inventory.fingerprint)
    || typeof inventory.scannedAt !== "string"
    || Number.isNaN(Date.parse(inventory.scannedAt))) {
    return null;
  }
  return inventory as unknown as LocalCreativeSourceInventorySnapshot;
}

type CompletionBaselineProjection =
  LocalCreativeProjectIngestStatusProjection["contentImport"]["completionBaseline"];

async function verifyCompletionBaseline(
  shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>,
  manifest: ParsedIngestManifest,
  content: ParsedContentImport | null,
): Promise<CompletionBaselineProjection> {
  if (!content || content.status === "in-progress") {
    return { status: "not-applicable", fingerprint: null, relativePath: null, error: null };
  }
  const fingerprint = content.completionBaselineFingerprint;
  if (!fingerprint) {
    return {
      status: "missing",
      fingerprint: null,
      relativePath: null,
      error: "终态内容导入缺少不可变完成基线收据；按旧数据只读兼容，但不得解锁生产。",
    };
  }
  const relativePath = localCreativeContentImportCompletionBaselineRelativePath(fingerprint);
  try {
    if (!content.sourceInventory
      || (content.sourceInventory.contentIdentity !== "sha256"
        && content.sourceInventory.contentIdentity !== "metadata")
      || content.documentLimit === null
      || content.checkpointEvery === null
      || content.completedAt === null) {
      throw new Error("终态进度缺少签发完成基线所需的精确字段。");
    }
    const directory = await inspectExistingConfinedDirectory(
      shell.paths.root,
      path.join(shell.paths.root, LOCAL_CREATIVE_CONTENT_COMPLETION_BASELINE_RELATIVE_ROOT),
    );
    const read = await readConfinedRegularFileWithIdentity(
      directory,
      `${fingerprint}.json`,
      4 * 1024 * 1024,
    );
    const parsed = JSON.parse(read.bytes.toString("utf8")) as LocalCreativeContentImportCompletionBaselineReceipt;
    const expected = buildLocalCreativeContentImportCompletionBaseline({
      project: {
        id: shell.project.id,
        root: shell.paths.root,
        manifestFingerprint: shell.manifestFingerprint,
        sourceProject: {
          key: manifest.project.key,
          name: manifest.project.name,
          type: manifest.project.type,
        },
      },
      previewFingerprint: content.previewFingerprint ?? "",
      sourceInventory: content.sourceInventory,
      completion: {
        status: content.status,
        authorityPolicy: content.appliedAuthorityPolicy,
        documentLimit: content.documentLimit,
        checkpointEvery: content.checkpointEvery,
        completedAt: content.completedAt,
        runSummary: { ...content.runSummary, authorityPromotions: 0 as const },
        processedMediaRecords: content.processedMediaRecords,
        failures: content.failures,
        documentCoverage: content.documentCoverage,
      },
    });
    if (fingerprint !== expected.fingerprint
      || parsed.fingerprint !== fingerprint
      || JSON.stringify(stableValue(parsed)) !== JSON.stringify(stableValue(expected))) {
      throw new Error("完成基线收据与当前终态进度摘要不一致。");
    }
    return { status: "valid", fingerprint, relativePath, error: null };
  } catch (error) {
    return {
      status: "invalid",
      fingerprint,
      relativePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseDocumentCoverage(value: unknown): LocalCreativeDocumentCoverage | null {
  const coverage = optionalRecord(value);
  if (!coverage) return null;
  const sourceDocuments = nonNegativeInteger(coverage.sourceDocuments);
  const eligibleTextDocuments = nonNegativeInteger(coverage.eligibleTextDocuments);
  const selectedDocuments = nonNegativeInteger(coverage.selectedDocuments);
  const importEligibleDocuments = coverage.importEligibleDocuments === undefined
    ? eligibleTextDocuments
    : nonNegativeInteger(coverage.importEligibleDocuments);
  const inventoryOnlyDocuments = coverage.inventoryOnlyDocuments === undefined
    ? Math.max(0, eligibleTextDocuments - importEligibleDocuments)
    : nonNegativeInteger(coverage.inventoryOnlyDocuments);
  const excludedUnsupportedFormat = nonNegativeInteger(coverage.excludedUnsupportedFormat);
  const excludedRejected = nonNegativeInteger(coverage.excludedRejected);
  const unselectedByLimit = nonNegativeInteger(coverage.unselectedByLimit);
  return {
    sourceDocuments,
    eligibleTextDocuments,
    selectedDocuments,
    importEligibleDocuments,
    inventoryOnlyDocuments,
    excludedUnsupportedFormat,
    excludedRejected,
    unselectedByLimit,
    limitHit: coverage.limitHit === true || unselectedByLimit > 0,
  };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?").get("table", table));
}

function count(db: DatabaseSync, sql: string, ...parameters: Array<string | number | null>): number {
  return Number((db.prepare(sql).get(...parameters) as { count: number }).count);
}

function readManagedDatabaseCounts(
  shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>,
): ManagedDatabaseCounts {
  const warnings: string[] = [];
  const material = new DatabaseSync(shell.paths.materialDatabase, { readOnly: true });
  const production = new DatabaseSync(shell.paths.productionDatabase, { readOnly: true });
  try {
    material.exec("PRAGMA query_only = ON");
    production.exec("PRAGMA query_only = ON");
    const requiredMaterial = ["studio_media", "studio_media_imports", "studio_canonical_assets", "studio_asset_versions"];
    const requiredProduction = ["studio_text_documents", "studio_production_units", "studio_production_panels"];
    for (const table of requiredMaterial) {
      if (!tableExists(material, table)) throw new Error(`素材库缺少表 ${table}。`);
    }
    for (const table of requiredProduction) {
      if (!tableExists(production, table)) throw new Error(`生产库缺少表 ${table}。`);
    }
    const timelineAvailable = tableExists(production, "studio_multimedia_timeline_bindings");
    if (!timelineAvailable) warnings.push("四媒体时间线绑定表尚未初始化；按 0 个绑定投影。");
    return {
      managedCounts: {
        media: {
          unique: count(material, "SELECT COUNT(*) AS count FROM studio_media"),
          origins: count(material, "SELECT COUNT(*) AS count FROM studio_media_imports"),
          image: count(material, "SELECT COUNT(*) AS count FROM studio_media WHERE kind = ?", "image"),
          video: count(material, "SELECT COUNT(*) AS count FROM studio_media WHERE kind = ?", "video"),
          audio: count(material, "SELECT COUNT(*) AS count FROM studio_media WHERE kind = ?", "audio"),
        },
        documents: {
          total: count(production, "SELECT COUNT(*) AS count FROM studio_text_documents"),
          script: count(production, "SELECT COUNT(*) AS count FROM studio_text_documents WHERE kind = ?", "script"),
          prompt: count(production, "SELECT COUNT(*) AS count FROM studio_text_documents WHERE kind = ?", "prompt"),
        },
        assets: {
          canonical: count(material, "SELECT COUNT(*) AS count FROM studio_canonical_assets"),
          versions: count(material, "SELECT COUNT(*) AS count FROM studio_asset_versions"),
          pendingVersions: count(material, "SELECT COUNT(*) AS count FROM studio_asset_versions WHERE review_status = ?", "pending"),
          approvedVersions: count(material, "SELECT COUNT(*) AS count FROM studio_asset_versions WHERE review_status = ?", "approved"),
          rejectedVersions: count(material, "SELECT COUNT(*) AS count FROM studio_asset_versions WHERE review_status = ?", "rejected"),
          primaryAuthorities: count(material, "SELECT COUNT(*) AS count FROM studio_canonical_assets WHERE primary_version_id IS NOT NULL"),
        },
        production: {
          units: count(production, "SELECT COUNT(*) AS count FROM studio_production_units"),
          panels: count(production, "SELECT COUNT(*) AS count FROM studio_production_panels"),
          timelineBindings: timelineAvailable
            ? count(production, "SELECT COUNT(*) AS count FROM studio_multimedia_timeline_bindings")
            : 0,
        },
      },
      warnings,
    };
  } finally {
    material.close();
    production.close();
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`limit 必须是 1-${MAX_PAGE_LIMIT} 的整数。`);
  }
  return limit;
}

function encodeCursor(datasetFingerprint: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, datasetFingerprint, offset }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, datasetFingerprint: string): number {
  if (!value) return 0;
  if (value.length > 4_096) throw new Error("cursor 过长。");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as JsonRecord;
    if (parsed.v !== 1 || parsed.datasetFingerprint !== datasetFingerprint
      || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error("invalid");
    }
    return Number(parsed.offset);
  } catch {
    throw new Error("cursor 无效或来源状态已更新，请从第一页重新读取。");
  }
}

function safePath(value: unknown, label: string): string {
  return text(value, label, { max: MAX_TEXT_LENGTH })!;
}

function safeEvidenceLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry, index) => text(entry, `evidenceLevels[${index}]`, { max: 256 })!);
}

function projectLockReference(
  value: unknown,
  index: number,
): LocalCreativeProjectIngestStatusProjection["lockReferenceIndex"]["items"][number] {
  const entry = record(value, `lockReferenceIndex[${index}]`);
  const status = entry.status;
  if (status !== "APPROVED_LOCK" && status !== "CANDIDATE_LOCK") {
    throw new Error(`lockReferenceIndex[${index}].status 无效。`);
  }
  const references = Array.isArray(entry.referencedBy) ? entry.referencedBy : [];
  return {
    lockFileId: text(entry.lockFileId, `lockReferenceIndex[${index}].lockFileId`)!,
    lockPath: safePath(entry.lockPath, `lockReferenceIndex[${index}].lockPath`),
    lockBasename: path.basename(safePath(entry.lockPath, `lockReferenceIndex[${index}].lockPath`)),
    lockPathFingerprint: sha256(safePath(entry.lockPath, `lockReferenceIndex[${index}].lockPath`)),
    status,
    visualAppearance: "UNCONFIRMED",
    referencedByTotal: references.length,
    referencedByTruncated: references.length > MAX_REFERENCES_PER_LOCK,
    referencedBy: references.slice(0, MAX_REFERENCES_PER_LOCK).map((rawReference, referenceIndex) => {
      const reference = record(rawReference, `lockReferenceIndex[${index}].referencedBy[${referenceIndex}]`);
      return {
        fileId: text(reference.fileId, "reference.fileId")!,
        path: safePath(reference.path, "reference.path"),
        basename: path.basename(safePath(reference.path, "reference.path")),
        pathFingerprint: sha256(safePath(reference.path, "reference.path")),
        evidenceLevels: safeEvidenceLevels(reference.evidenceLevels),
      };
    }),
  };
}

const CANONICAL_DECISIONS = [
  "pending-version-created",
  "pending-version-reconciled",
  "forbidden-by-policy",
  "forbidden-inbox",
  "category-unresolved",
  "not-applicable",
] as const;

function emptyCanonicalDecisionCounts(): LocalCreativeProjectIngestStatusProjection["canonicalDecisions"]["counts"] {
  return {
    "pending-version-created": 0,
    "pending-version-reconciled": 0,
    "forbidden-by-policy": 0,
    "forbidden-inbox": 0,
    "category-unresolved": 0,
    "not-applicable": 0,
  };
}

function projectCanonicalDecision(
  pair: [string, unknown],
  index: number,
): LocalCreativeProjectIngestStatusProjection["canonicalDecisions"]["items"][number] {
  const [fallbackFileId, raw] = pair;
  const decision = record(raw, `canonicalDecisions[${index}]`);
  const decisionValue = decision.decision;
  if (!CANONICAL_DECISIONS.includes(decisionValue as typeof CANONICAL_DECISIONS[number])) {
    throw new Error(`canonicalDecisions[${index}].decision 无效。`);
  }
  if (decision.authorityPromoted !== false) {
    throw new Error(`canonicalDecisions[${index}] 违反“导入不提升权威”合同。`);
  }
  const category = decision.category;
  if (category !== undefined && category !== "character" && category !== "scene"
    && category !== "prop" && category !== "style") {
    throw new Error(`canonicalDecisions[${index}].category 无效。`);
  }
  const evidence = Array.isArray(decision.sourceApprovalEvidence) ? decision.sourceApprovalEvidence : [];
  const sourcePath = safePath(decision.sourcePath, `canonicalDecisions[${index}].sourcePath`);
  const item: LocalCreativeProjectIngestStatusProjection["canonicalDecisions"]["items"][number] = {
    fileId: text(decision.fileId ?? fallbackFileId, `canonicalDecisions[${index}].fileId`)!,
    sourcePath,
    sourceBasename: path.basename(sourcePath),
    sourcePathFingerprint: sha256(sourcePath),
    sourceStatus: text(decision.sourceStatus, `canonicalDecisions[${index}].sourceStatus`)!,
    decision: decisionValue as typeof CANONICAL_DECISIONS[number],
    authorityPromoted: false,
    visualAppearance: "UNCONFIRMED",
    sourceApprovalEvidenceTotal: evidence.length,
    sourceApprovalEvidenceTruncated: evidence.length > MAX_EVIDENCE_PER_DECISION,
    sourceApprovalEvidence: evidence.slice(0, MAX_EVIDENCE_PER_DECISION).map((rawEvidence, evidenceIndex) => {
      const evidenceRecord = record(rawEvidence, `canonicalDecisions[${index}].sourceApprovalEvidence[${evidenceIndex}]`);
      const declaredSha256 = text(
        evidenceRecord.declaredSha256,
        "sourceApprovalEvidence.declaredSha256",
        { optional: true, max: 64 },
      );
      if (declaredSha256 && !SHA256_PATTERN.test(declaredSha256)) {
        throw new Error("sourceApprovalEvidence.declaredSha256 格式无效。");
      }
      const sourcePath = safePath(evidenceRecord.sourcePath, "sourceApprovalEvidence.sourcePath");
      return {
        level: text(evidenceRecord.level, "sourceApprovalEvidence.level", { max: 256 })!,
        sourceFileId: text(evidenceRecord.sourceFileId, "sourceApprovalEvidence.sourceFileId")!,
        sourcePath,
        sourceBasename: path.basename(sourcePath),
        sourcePathFingerprint: sha256(sourcePath),
        ...(declaredSha256 ? { declaredSha256 } : {}),
      };
    }),
  };
  const assetId = text(decision.assetId, "canonicalDecision.assetId", { optional: true });
  const versionId = text(decision.versionId, "canonicalDecision.versionId", { optional: true });
  const mediaSha256 = text(decision.mediaSha256, "canonicalDecision.mediaSha256", { optional: true, max: 64 });
  if (mediaSha256 && !SHA256_PATTERN.test(mediaSha256)) throw new Error("canonicalDecision.mediaSha256 格式无效。");
  if (assetId) item.assetId = assetId;
  if (category) item.category = category;
  if (versionId) item.versionId = versionId;
  if (mediaSha256) item.mediaSha256 = mediaSha256;
  return item;
}

function nextAction(
  manifest: ParsedIngestManifest,
  content: ParsedContentImport | null,
  managed: LocalCreativeProjectIngestStatusProjection["managedCounts"],
  decisionCounts: LocalCreativeProjectIngestStatusProjection["canonicalDecisions"]["counts"],
  sourceSnapshot: LocalCreativeProjectIngestStatusProjection["contentImport"]["sourceSnapshot"],
  documentCoveragePartial: boolean,
): LocalCreativeProjectIngestStatusProjection["nextAction"] {
  if (sourceSnapshot === "race") {
    return { code: "verify-source-snapshot", reason: "外部源目录在本次双重扫描期间仍在变化；必须等待写入停止并重新核验。" };
  }
  if (sourceSnapshot === "unknown") {
    return { code: "verify-source-snapshot", reason: "外部源目录尚未完成本次实时核验；正式生产前必须刷新来源状态。" };
  }
  if (sourceSnapshot === "stale") {
    return { code: "refresh-source-preview", reason: "外部源目录已不同于已导入快照；必须先预览增量并重新同步。" };
  }
  if (!content) return { code: "run-content-import", reason: "项目已盘点但尚未执行内容导入。" };
  if (content.status === "in-progress") return { code: "resume-content-import", reason: "内容导入仍处于 in-progress，应从现有进度恢复。" };
  if (content.status === "completed-with-failures" || content.failures.total > 0) {
    return { code: "review-import-failures", reason: "内容导入存在失败项，必须先核对失败证据。" };
  }
  if (documentCoveragePartial) {
    return { code: "review-document-coverage", reason: "来源文档未被全量、同类导入；必须先核对格式排除、拒绝项或数量上限。" };
  }
  if (decisionCounts["category-unresolved"] > 0) {
    return { code: "resolve-canonical-categories", reason: "显式锁图尚未唯一归类为角色、场景、道具或风格。" };
  }
  if (managed.assets.pendingVersions > 0 && managed.assets.primaryAuthorities === 0) {
    return { code: "review-pending-assets", reason: "存在待人工视觉复核的资产版本，尚未形成主权威。" };
  }
  if (manifest.project.type === "story-production" && managed.production.units === 0) {
    return { code: "preview-production-units", reason: "故事项目内容已入库，但尚无可读取的生产单元或时间线。" };
  }
  return { code: "ready-for-managed-reading", reason: "当前受管内容可通过既有只读工具继续读取；视觉出现仍未被自动确认。" };
}

export function localCreativeSourceRaceDetected(
  previewInventory: Pick<LocalCreativeSourceInventorySnapshot, "fingerprint">,
  verificationInventory: Pick<LocalCreativeSourceInventorySnapshot, "fingerprint">,
): boolean {
  return previewInventory.fingerprint !== verificationInventory.fingerprint;
}

export async function getLocalCreativeProjectIngestStatus(
  projectRoot: string,
  query: LocalCreativeProjectIngestStatusQuery = {},
): Promise<LocalCreativeProjectIngestStatusProjection> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const ingestSidecar = await readSafeJsonSidecar(
    path.join(shell.paths.root, INGEST_RELATIVE_PATH),
    "local creative ingest manifest",
    true,
  );
  const manifest = parseIngestManifest(ingestSidecar!.value, shell);
  const progressSidecar = await readSafeJsonSidecar(
    path.join(shell.paths.root, CONTENT_IMPORT_RELATIVE_PATH),
    "local creative content import progress",
    false,
  );
  const content = progressSidecar ? parseContentImport(progressSidecar, manifest, shell) : null;
  const completionBaseline = await verifyCompletionBaseline(shell, manifest, content);
  let livePreview: LocalCreativeProjectIngestPreview | null = null;
  let liveSourceInventory: LocalCreativeSourceInventorySnapshot | null = null;
  let previewSourceInventory: LocalCreativeSourceInventorySnapshot | null = null;
  let sourceRaceDetected = false;
  let sourceCheckError: string | null = null;
  if (query.refreshSource !== false) {
    try {
      const sourceInventoryLayers: LocalCreativeSourceInventoryLayer[] = manifest.sourceLayers.map((layer) => ({
        role: layer.role,
        rootPath: layer.root,
        ...(layer.maxDepth === undefined ? {} : { maxDepth: layer.maxDepth }),
        ...(!layer.excludeRelativePrefixes.length ? {} : {
          excludeRelativePrefixes: [...layer.excludeRelativePrefixes],
        }),
      }));
      livePreview = await inspectLocalCreativeProject({
        projectKey: manifest.project.key,
        projectName: manifest.project.name,
        projectType: manifest.project.type,
        sourceLayers: manifest.sourceLayers.map((layer) => {
          if (!LOCAL_CREATIVE_SOURCE_LAYER_ROLES.includes(layer.role as LocalCreativeSourceLayerRole)) {
            throw new Error(`来源层角色无效：${layer.role}`);
          }
          return {
            role: layer.role as LocalCreativeSourceLayerRole,
            rootPath: layer.root,
            ...(layer.label ? { label: layer.label } : {}),
            ...(layer.maxDepth === undefined ? {} : { maxDepth: layer.maxDepth }),
            ...(!layer.excludeRelativePrefixes.length ? {} : {
              excludeRelativePrefixes: [...layer.excludeRelativePrefixes],
            }),
          };
        }),
        // 正式 currentness 不能只信 size/mtime；同大小替换并恢复 mtime 也必须检出。
        computeSha256: true,
      });
      previewSourceInventory = localCreativeSourceInventoryFromPreview(livePreview);
      liveSourceInventory = await inspectLocalCreativeSourceInventory(sourceInventoryLayers, {
        cache: false,
        hashContents: true,
      });
      sourceRaceDetected = localCreativeSourceRaceDetected(previewSourceInventory, liveSourceInventory);
      if (sourceRaceDetected) {
        sourceCheckError = "SOURCE_RACE_DETECTED：来源目录在完整预览与复核扫描之间发生变化。";
      }
    } catch (error) {
      sourceCheckError = error instanceof Error ? error.message : String(error);
    }
  }
  const { managedCounts, warnings: databaseWarnings } = readManagedDatabaseCounts(shell);
  const warnings = [...databaseWarnings];
  if (sourceCheckError) warnings.push(`外部源目录实时核验失败：${sourceCheckError}`);
  if (completionBaseline.error) warnings.push(`内容导入完成基线未通过：${completionBaseline.error}`);
  const limit = normalizeLimit(query.limit);
  const datasetFingerprint = sha256(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    ingest: ingestSidecar!.sha256,
    progress: content?.rawSha256 ?? null,
  }));
  const offset = decodeCursor(query.cursor, datasetFingerprint);

  const allLockReferences = (content?.lockReferenceIndex ?? [])
    .map(projectLockReference)
    .sort((left, right) => left.lockFileId.localeCompare(right.lockFileId, "en"));
  const allCanonicalDecisions = (content?.canonicalDecisions ?? [])
    .map(projectCanonicalDecision)
    .sort((left, right) => left.fileId.localeCompare(right.fileId, "en"));
  const decisionCounts = emptyCanonicalDecisionCounts();
  for (const decision of allCanonicalDecisions) decisionCounts[decision.decision] += 1;
  const hasMore = offset + limit < Math.max(allLockReferences.length, allCanonicalDecisions.length);

  const legacyBaselineChanged = Boolean(
    content
    && liveSourceInventory
    && !content.sourceInventory
    && (
      liveSourceInventory.totalFiles !== manifest.scan.totalFiles
      || liveSourceInventory.totalBytes !== manifest.scan.totalBytes
      || (content.updatedAt !== null
        && liveSourceInventory.maxMtimeMs > Date.parse(content.updatedAt))
    )
  );
  const terminalBaselineInvalid = Boolean(
    content
    && content.status !== "in-progress"
    && completionBaseline.status !== "valid",
  );
  const sourceSnapshot = sourceRaceDetected
    ? "race" as const
    : terminalBaselineInvalid
      ? "unknown" as const
    : query.refreshSource !== false && !liveSourceInventory
      ? "unknown" as const
      : !content
        ? "not-imported" as const
        : !liveSourceInventory
          ? "unknown" as const
          : content.sourceInventory
            ? liveSourceInventory.fingerprint === content.sourceInventory.fingerprint
              ? "current" as const
              : "stale" as const
            : legacyBaselineChanged
              ? "stale" as const
              : "unknown" as const;
  const runSummary = content?.runSummary ?? emptyRunSummary();
  const fallbackSourceDocuments = livePreview?.statistics.byMediaKind.document ?? manifest.scan.byMediaKind.document;
  const fallbackSelectedDocuments = runSummary.documentsSelected;
  const liveDocuments = livePreview?.files.filter((file) => file.mediaKind === "document") ?? [];
  const liveEligibleDocuments = liveDocuments.filter((file) => (
    (file.extension === ".md" || file.extension === ".txt")
    && file.status !== "REJECTED_OR_FORBIDDEN"
  ));
  const liveImportEligibleDocuments = liveEligibleDocuments.filter((file) => {
    const target = classifyLocalCreativeSourceDocument(file).importTarget;
    return target === "script" || target === "prompt";
  });
  const documentCoverage: LocalCreativeDocumentCoverage = content?.documentCoverage ?? {
    sourceDocuments: fallbackSourceDocuments,
    eligibleTextDocuments: livePreview ? liveEligibleDocuments.length : fallbackSelectedDocuments,
    selectedDocuments: fallbackSelectedDocuments,
    importEligibleDocuments: livePreview ? liveImportEligibleDocuments.length : fallbackSelectedDocuments,
    inventoryOnlyDocuments: livePreview
      ? liveEligibleDocuments.length - liveImportEligibleDocuments.length
      : 0,
    excludedUnsupportedFormat: livePreview
      ? liveDocuments.filter((file) => file.extension !== ".md" && file.extension !== ".txt").length
      : 0,
    excludedRejected: livePreview
      ? liveDocuments.filter((file) => (
        (file.extension === ".md" || file.extension === ".txt")
        && file.status === "REJECTED_OR_FORBIDDEN"
      )).length
      : 0,
    unselectedByLimit: livePreview ? Math.max(0, liveImportEligibleDocuments.length - fallbackSelectedDocuments) : 0,
    limitHit: livePreview ? liveImportEligibleDocuments.length > fallbackSelectedDocuments : false,
  };
  const documentCoverageVerified = Boolean(content?.documentCoverage || livePreview);
  const liveDocumentInventory = livePreview
    ? buildLocalCreativeSourceDocumentInventory(livePreview)
    : null;
  const partialByPolicy = documentCoverage.limitHit
    || documentCoverage.unselectedByLimit > 0
    || documentCoverage.inventoryOnlyDocuments > 0
    || documentCoverage.excludedUnsupportedFormat > 0
    || documentCoverage.excludedRejected > 0;
  const truthStatus: LocalCreativeProjectIngestStatusProjection["contentImport"]["truthStatus"] = sourceSnapshot === "race"
    ? "RACE_DETECTED"
    : terminalBaselineInvalid
      ? "UNVERIFIED"
    : sourceSnapshot === "unknown"
      ? "UNVERIFIED"
      : !content
        ? "NOT_IMPORTED"
        : sourceSnapshot === "stale"
          ? "STALE"
          : content.status === "in-progress"
            ? "IN_PROGRESS"
            : content.status === "completed-with-failures" || content.failures.total > 0
              ? "FAILED"
              : partialByPolicy
                ? "PARTIAL_BY_POLICY"
                : "CURRENT_COMPLETE";
  const baselineFiles = content?.sourceInventory?.totalFiles ?? manifest.scan.totalFiles;
  const baselineBytes = content?.sourceInventory?.totalBytes ?? manifest.scan.totalBytes;
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "local-creative-project-ingest-status" as const,
    project: manifest.project,
    sourceLayers: manifest.sourceLayers,
    scan: manifest.scan,
    contentImport: {
      status: content?.status ?? "not-started" as const,
      truthStatus,
      appliedAuthorityPolicy: content?.appliedAuthorityPolicy ?? null,
      previewFingerprint: content?.previewFingerprint ?? null,
      sourceSnapshot,
      sourceCheck: {
        checkedAt: liveSourceInventory?.scannedAt ?? null,
        verificationInventoryFingerprint: liveSourceInventory?.fingerprint ?? null,
        previewDerivedInventoryFingerprint: previewSourceInventory?.fingerprint ?? null,
        importBaselineInventoryFingerprint: content?.sourceInventory?.fingerprint ?? null,
        livePreviewFingerprint: liveSourceInventory?.fingerprint ?? null,
        previewInventoryFingerprint: previewSourceInventory?.fingerprint ?? null,
        baselinePreviewFingerprint: content?.sourceInventory?.fingerprint ?? null,
        fingerprintBasis: "content-sha256-inventory-v3-double-scan" as const,
        raceDetected: sourceRaceDetected,
        liveFiles: liveSourceInventory?.totalFiles ?? null,
        baselineFiles,
        liveBytes: liveSourceInventory?.totalBytes ?? null,
        baselineBytes,
        filesDelta: liveSourceInventory ? liveSourceInventory.totalFiles - baselineFiles : null,
        bytesDelta: liveSourceInventory ? liveSourceInventory.totalBytes - baselineBytes : null,
        error: sourceCheckError,
      },
      completionBaseline,
      documentCoverage,
      documentCoverageVerified,
      documentClassification: {
        verified: Boolean(liveDocumentInventory),
        byClass: liveDocumentInventory?.byClass ?? {
          script: 0,
          prompt: 0,
          storyboard: 0,
          bible: 0,
          index: 0,
          qc: 0,
          manifest: 0,
          log: 0,
          other: 0,
        },
        byImportTarget: liveDocumentInventory?.byImportTarget ?? {
          script: 0,
          prompt: 0,
          "inventory-only": 0,
          unsupported: 0,
          rejected: 0,
        },
      },
      documentLimit: content?.documentLimit ?? null,
      checkpointEvery: content?.checkpointEvery ?? null,
      startedAt: content?.startedAt ?? null,
      updatedAt: content?.updatedAt ?? null,
      completedAt: content?.completedAt ?? null,
      runSummary,
      processedMediaRecords: content?.processedMediaRecords ?? 0,
      failures: content?.failures ?? { total: 0, byPhase: { document: 0, media: 0, "canonical-asset": 0 } },
    },
    managedCounts,
    lockReferenceIndex: {
      available: Boolean(content),
      total: allLockReferences.length,
      offset,
      items: allLockReferences.slice(offset, offset + limit),
    },
    canonicalDecisions: {
      available: Boolean(content),
      total: allCanonicalDecisions.length,
      offset,
      counts: decisionCounts,
      items: allCanonicalDecisions.slice(offset, offset + limit),
    },
    page: {
      offset,
      limit,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor(datasetFingerprint, offset + limit) } : {}),
    },
    visualAppearance: "UNCONFIRMED" as const,
    authority: {
      sourcePolicy: manifest.authorityPolicy,
      authorityInherited: false as const,
      sourceDeclarationsPromotedAutomatically: false as const,
      recordedImportPromotions: runSummary.authorityPromotions,
      managedPrimaryAuthorities: managedCounts.assets.primaryAuthorities,
      note: "源目录中的 APPROVED_LOCK 只作为待复核证据；未经过本工程人工视觉复核与主权威命令，不继承 authority。",
    },
    nextAction: nextAction(manifest, content, managedCounts, decisionCounts, sourceSnapshot, partialByPolicy),
    warnings,
  };
  return {
    ...body,
    fingerprint: sha256(JSON.stringify(stableValue(body))),
    builtAt: new Date().toISOString(),
  };
}
