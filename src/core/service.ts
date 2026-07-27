import { randomUUID } from "node:crypto";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { completionIssues } from "./acceptance.js";
import { DEFAULT_PROJECT_ROOT, STATUS_PRIORITY } from "./constants.js";
import { ProjectCache } from "./cache.js";
import { scanProject, type ScanProgress } from "./scanner.js";
import { listAgentSkills } from "./skills.js";
import { reviewCoversArtifacts } from "./review-evidence.js";
import {
  appendEvent,
  ensureSidecar,
  findEventsByIdempotencyKey,
  getActiveProjectRegistration,
  getActiveProjectStateReadOnly,
  listEvents,
  listTaskPacks,
  loadProjectConfig,
  loadIndex,
  loadOverrides,
  readJson,
  readTaskPack,
  saveIndex,
  saveOverrides,
  listRegisteredProjects,
  registerProject,
  unregisterProject,
  setActiveProjectRegistration,
  writeJsonAtomic,
  writeTaskPack,
  getSidecarPaths,
} from "./sidecar.js";
import type {
  Artifact,
  ArtifactKind,
  ArtifactVariant,
  CanvasPosition,
  ProjectIndex,
  ProjectConfig,
  ProjectEvent,
  ProjectOverrides,
  ReviewStore,
  StoryEventGraph,
  TaskPack,
  WorkItem,
  WorkItemStatus,
} from "./types.js";
import { WORK_ITEM_STATUSES } from "./types.js";
import { withProjectLock } from "./locks.js";
import { assertFusionAssetConsistencyApprovedForItem } from "./fusion-asset-consistency.js";
import { loadCanonicalAssetStore } from "./canonical-assets.js";
import {
  artifactAuthorityKey,
  buildFusionStoryboardReviewRequirement,
  loadFusionStoryboardEvidenceSnapshot,
} from "./fusion-storyboard-evidence.js";
import {
  createManagedProject,
  inspectManagedProject,
  isManagedProject,
  upgradeEmptyProjectToManaged,
  type CreateManagedProjectOptions,
  type ProjectShell,
} from "./managed-project.js";
import {
  inspectLocalCreativeSourceInventory,
  type LocalCreativeSourceInventoryLayer,
  type LocalCreativeSourceInventorySnapshot,
} from "./local-creative-source-inventory.js";
import {
  verifyLocalCreativeContentImportSummaryCompletionBaseline,
  type LocalCreativeProjectContentImportSummary,
} from "./local-creative-project-content-import.js";
import { readMaterialStudioProjectCenterCounts } from "./material-studio.js";

export interface PersistedScanOptions {
  includeHashes?: boolean;
  includeHashPaths?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

export interface LocalCreativeImportProjectSummary {
  projectKey: string;
  projectType: string;
  resolution: "CREATE_MANAGED" | "CREATE_INBOX";
  sourceLayerCount: number;
  authorityPolicy: string;
  indexedFiles: number;
  indexedBytes: number;
  approvedLocks: number;
  candidateLocks: number;
  warningCount: number;
  contentImport: {
    status:
      | "not-imported"
      | "importing"
      | "current-complete"
      | "partial"
      | "stale"
      | "has-failures"
      | "unverified";
    processedMedia: number;
    eligibleMedia: number;
    importedDocuments: number;
    sourceDocuments: number;
    selectedDocuments: number;
    excludedDocuments: number;
    documentLimitHit: boolean;
    pendingAssets: number;
    sourceSnapshot: "not-imported" | "current" | "stale" | "unknown";
    sourceCheckedAt: string | null;
    verifiedSourceFiles?: number;
    verifiedSourceBytes?: number;
    sourceVerificationError?: string;
  };
}

export interface ListedProjectSummary {
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
  available: boolean;
  unavailableReason?: string;
  localCreativeImport?: LocalCreativeImportProjectSummary;
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "项目扫描已取消。");
  error.name = "AbortError";
  throw error;
}

export async function scanAndPersist(projectRoot = DEFAULT_PROJECT_ROOT, options: boolean | PersistedScanOptions = false): Promise<ProjectIndex> {
  const normalized = typeof options === "boolean" ? { includeHashes: options } : options;
  if (await isManagedProject(projectRoot)) {
    throw new Error("受管素材工程采用 SQLite/CAS 增量目录，禁止启动旧文件系统扫描；请使用显式素材导入。");
  }
  throwIfScanAborted(normalized.signal);
  await ensureSidecar(projectRoot);
  return withProjectLock(projectRoot, "scan", async () => {
    throwIfScanAborted(normalized.signal);
    const previousIndex = await loadIndex(projectRoot);
    const index = await scanProject({
      projectRoot,
      includeHashes: normalized.includeHashes,
      includeHashPaths: normalized.includeHashPaths,
      previousIndex,
      signal: normalized.signal,
      onProgress: normalized.onProgress,
    });
    // 提交点之前允许取消；提交开始后必须完整同步 JSON、SQLite 与事件，避免半份新索引。
    throwIfScanAborted(normalized.signal);
    await saveIndex(index);
    const cache = new ProjectCache(projectRoot);
    try {
      cache.replaceIndex(index);
    } finally {
      cache.close();
    }
    await appendEvent(projectRoot, {
      actor: "scanner",
      type: "project.scanned",
      data: { scanId: index.scanId, total: index.summary.total, durationMs: index.scanDurationMs, scanStats: index.scanStats },
    });
    return index;
  });
}

export async function previewProjectScan(projectRoot: string, options: Pick<PersistedScanOptions, "signal" | "onProgress" | "includeHashPaths"> = {}): Promise<ProjectIndex> {
  const absoluteRoot = path.resolve(projectRoot);
  if (await isManagedProject(absoluteRoot)) {
    throw new Error("受管素材工程禁止预览旧文件系统扫描；请使用轻量分页索引。");
  }
  throwIfScanAborted(options.signal);
  await access(absoluteRoot);
  return scanProject({ projectRoot: absoluteRoot, persist: false, previousIndex: await loadIndex(projectRoot), includeHashPaths: options.includeHashPaths, signal: options.signal, onProgress: options.onProgress });
}

export async function getProjectIndex(projectRoot = DEFAULT_PROJECT_ROOT, refresh = false): Promise<ProjectIndex> {
  if (!refresh) {
    const existing = await loadIndex(projectRoot);
    if (existing) return existing;
  }
  return scanAndPersist(projectRoot);
}

function finiteNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function emptyLocalCreativeContentImportSummary(): LocalCreativeImportProjectSummary["contentImport"] {
  return {
    status: "not-imported",
    processedMedia: 0,
    eligibleMedia: 0,
    importedDocuments: 0,
    sourceDocuments: 0,
    selectedDocuments: 0,
    excludedDocuments: 0,
    documentLimitHit: false,
    pendingAssets: 0,
    sourceSnapshot: "not-imported",
    sourceCheckedAt: null,
  };
}

async function readLocalCreativeContentImportSummary(
  projectRoot: string,
  sourceContext: {
    initialPreviewFingerprint: unknown;
    initialFiles: number;
    initialBytes: number;
    initialDocuments: number;
    manifestRecordedAt: string | null;
    sourceLayers: LocalCreativeSourceInventoryLayer[];
  },
  options: { refreshSource: boolean; signal?: AbortSignal },
): Promise<LocalCreativeImportProjectSummary["contentImport"]> {
  throwIfScanAborted(options.signal);
  const compactPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-summary.json");
  let compact: unknown;
  try {
    const metadata = await lstat(compactPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata) {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512 * 1024) {
        return { ...emptyLocalCreativeContentImportSummary(), status: "has-failures" };
      }
      compact = await readJson<unknown>(compactPath, null);
    } else {
      compact = null;
    }
  } catch {
    // 内容摘要损坏不应触发对大型 progress 的回退解析，也不应把整个项目误判离线。
    return { ...emptyLocalCreativeContentImportSummary(), status: "has-failures" };
  }
  const compactRecord = objectRecord(compact);
  if (compact !== null && (compactRecord?.schemaVersion !== 1 || compactRecord.kind !== "local-creative-project-content-import-summary")) {
    return { ...emptyLocalCreativeContentImportSummary(), status: "has-failures" };
  }

  let record = compactRecord;
  const compactSummary = compactRecord?.kind === "local-creative-project-content-import-summary"
    ? compactRecord as unknown as LocalCreativeProjectContentImportSummary
    : null;
  if (!record) {
    try {
      const progress = await readJson<unknown>(
        path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json"),
        null,
      );
      if (progress !== null) record = objectRecord(progress);
    } catch {
      return { ...emptyLocalCreativeContentImportSummary(), status: "has-failures" };
    }
    if (record && (record.schemaVersion !== 1 || record.kind !== "local-creative-project-content-import-progress")) {
      return { ...emptyLocalCreativeContentImportSummary(), status: "has-failures" };
    }
  }

  const runSummary = objectRecord(record?.runSummary);
  const processedCounts = objectRecord(record?.processedCounts);
  const mediaByFileId = objectRecord(record?.mediaByFileId);
  const decisionsByFileId = objectRecord(record?.canonicalDecisionsByFileId);
  const documents = objectRecord(record?.documents);
  const documentResults = Array.isArray(documents?.results) ? documents.results : [];
  const documentCoverage = objectRecord(record?.documentCoverage) ?? objectRecord(documents?.coverage);
  const baselineInventory = objectRecord(record?.sourceInventory);
  const pendingAssetKeys = new Set<string>();
  for (const [fileId, rawDecision] of Object.entries(decisionsByFileId ?? {})) {
    const decision = objectRecord(rawDecision);
    if (decision?.decision === "pending-version-created" || decision?.decision === "pending-version-reconciled") {
      pendingAssetKeys.add(typeof decision.assetId === "string" && decision.assetId ? decision.assetId : fileId);
    }
  }
  const fallbackImportedDocuments = documentResults.filter((rawResult) => {
    const result = objectRecord(rawResult);
    return result?.status === "imported" || result?.status === "skipped-duplicate";
  }).length;
  const processedMedia = processedCounts
    ? finiteNonNegativeNumber(processedCounts.media)
    : Object.keys(mediaByFileId ?? {}).length;
  let currentInventory: LocalCreativeSourceInventorySnapshot | null = null;
  let sourceVerificationError: string | undefined;
  if (options.refreshSource) {
    try {
      currentInventory = await inspectLocalCreativeSourceInventory(sourceContext.sourceLayers, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      currentInventory = null;
      sourceVerificationError = (
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      ).replace(/\s+/gu, " ").slice(0, 500);
    }
  }
  const baselineFingerprint = typeof baselineInventory?.fingerprint === "string"
    ? baselineInventory.fingerprint
    : null;
  const manifestRecordedAtMs = sourceContext.manifestRecordedAt
    ? Date.parse(sourceContext.manifestRecordedAt)
    : Number.NaN;
  const sourceSnapshot = !record
    ? "not-imported" as const
    : !options.refreshSource || !currentInventory
      ? "unknown" as const
      : baselineFingerprint
        ? currentInventory.fingerprint === baselineFingerprint ? "current" as const : "stale" as const
        : currentInventory.totalFiles !== sourceContext.initialFiles
          || currentInventory.totalBytes !== sourceContext.initialBytes
          || (Number.isFinite(manifestRecordedAtMs) && currentInventory.maxMtimeMs > manifestRecordedAtMs)
          ? "stale" as const
          : "unknown" as const;
  const sourceDocuments = finiteNonNegativeNumber(
    currentInventory?.byMediaKind?.document
      ?? documentCoverage?.sourceDocuments
      ?? sourceContext.initialDocuments,
  );
  const selectedDocuments = finiteNonNegativeNumber(
    documentCoverage?.selectedDocuments ?? runSummary?.documentsSelected,
  );
  const excludedDocuments = !record
    ? 0
    : documentCoverage
      ? finiteNonNegativeNumber(documentCoverage.excludedUnsupportedFormat)
        + finiteNonNegativeNumber(documentCoverage.excludedRejected)
        + finiteNonNegativeNumber(documentCoverage.inventoryOnlyDocuments)
        + finiteNonNegativeNumber(documentCoverage.unselectedByLimit)
      : currentInventory
        ? Math.max(0, sourceDocuments - selectedDocuments)
        : 0;
  const documentLimitHit = Boolean(record && (
    documentCoverage?.limitHit === true
    || finiteNonNegativeNumber(documentCoverage?.unselectedByLimit) > 0
    || (
      !documentCoverage
      && currentInventory?.eligibleTextDocuments
      && currentInventory.eligibleTextDocuments > selectedDocuments
    )
  ));
  const completionBaselineValid = compactSummary
    ? await verifyLocalCreativeContentImportSummaryCompletionBaseline(projectRoot, compactSummary)
    : false;
  const baseStatus = !record
    ? "not-imported" as const
    : record.status === "in-progress"
    ? "importing" as const
    : record.status === "completed"
      ? !completionBaselineValid
        ? "unverified" as const
        : sourceSnapshot === "stale"
        ? "stale" as const
        : sourceSnapshot === "unknown"
          ? "unverified" as const
          : documentLimitHit || excludedDocuments > 0
            ? "partial" as const
            : "current-complete" as const
      : "has-failures" as const;
  return {
    status: baseStatus,
    processedMedia,
    eligibleMedia: finiteNonNegativeNumber(processedCounts?.eligibleMedia ?? runSummary?.mediaEligible),
    importedDocuments: processedCounts
      ? finiteNonNegativeNumber(processedCounts.documents)
      : fallbackImportedDocuments,
    sourceDocuments,
    selectedDocuments,
    excludedDocuments,
    documentLimitHit,
    pendingAssets: processedCounts
      ? finiteNonNegativeNumber(processedCounts.pendingAssets)
      : pendingAssetKeys.size,
    sourceSnapshot,
    sourceCheckedAt: currentInventory?.scannedAt ?? null,
    ...(currentInventory ? {
      verifiedSourceFiles: currentInventory.totalFiles,
      verifiedSourceBytes: currentInventory.totalBytes,
    } : {}),
    ...(sourceVerificationError ? { sourceVerificationError } : {}),
  };
}

async function readLocalCreativeImportProjectSummary(
  projectRoot: string,
  options: { refreshSource: boolean; signal?: AbortSignal },
): Promise<LocalCreativeImportProjectSummary | undefined> {
  throwIfScanAborted(options.signal);
  const manifest = await readJson<unknown>(
    path.join(projectRoot, ".aicanvas", "local-creative-project-ingest.json"),
    null,
  );
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
  const record = manifest as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "local-creative-project-ingest") return undefined;
  const project = record.project;
  const sourceLayers = record.sourceLayers;
  const scanSummary = record.scanSummary;
  if (!project || typeof project !== "object" || Array.isArray(project)
    || !Array.isArray(sourceLayers)
    || !scanSummary || typeof scanSummary !== "object" || Array.isArray(scanSummary)) return undefined;
  const projectRecord = project as Record<string, unknown>;
  const scanRecord = scanSummary as Record<string, unknown>;
  const statistics = scanRecord.statistics;
  const lockEvidence = scanRecord.lockEvidence;
  const warnings = scanRecord.warnings;
  if (typeof projectRecord.key !== "string" || typeof projectRecord.type !== "string"
    || (projectRecord.resolution !== "CREATE_MANAGED" && projectRecord.resolution !== "CREATE_INBOX")
    || typeof record.authorityPolicy !== "string"
    || !statistics || typeof statistics !== "object" || Array.isArray(statistics)
    || !lockEvidence || typeof lockEvidence !== "object" || Array.isArray(lockEvidence)
    || !warnings || typeof warnings !== "object" || Array.isArray(warnings)) return undefined;
  const stats = statistics as Record<string, unknown>;
  const locks = lockEvidence as Record<string, unknown>;
  const warningRecord = warnings as Record<string, unknown>;
  const sourceInventoryLayers: LocalCreativeSourceInventoryLayer[] = sourceLayers
    .map((rawLayer) => objectRecord(rawLayer))
    .filter((layer): layer is Record<string, unknown> => Boolean(layer))
    .map((layer) => ({
      role: typeof layer.role === "string" ? layer.role : "UNKNOWN",
      rootPath: typeof layer.root === "string" ? layer.root : "",
      ...(typeof layer.maxDepth === "number" ? { maxDepth: layer.maxDepth } : {}),
      ...(Array.isArray(layer.excludeRelativePrefixes)
        ? { excludeRelativePrefixes: layer.excludeRelativePrefixes.filter((entry): entry is string => typeof entry === "string") }
        : {}),
    }))
    .filter((layer) => path.isAbsolute(layer.rootPath));
  const contentImport = await readLocalCreativeContentImportSummary(projectRoot, {
    initialPreviewFingerprint: scanRecord.previewFingerprint,
    initialFiles: finiteNonNegativeNumber(stats.totalFiles),
    initialBytes: finiteNonNegativeNumber(stats.totalBytes),
    initialDocuments: finiteNonNegativeNumber(objectRecord(stats.byMediaKind)?.document),
    manifestRecordedAt: typeof record.recordedAt === "string" ? record.recordedAt : null,
    sourceLayers: sourceInventoryLayers,
  }, options);
  const materialCounts = await readMaterialStudioProjectCenterCounts(projectRoot);
  const livePendingAssets = materialCounts && (
    materialCounts.canonicalAssets > 0
    || materialCounts.pendingVersions > 0
    || materialCounts.primaryAuthorities > 0
  )
    ? materialCounts.pendingVersions
    : contentImport.pendingAssets;
  const currentIndexedFiles = contentImport.verifiedSourceFiles;
  const currentIndexedBytes = contentImport.verifiedSourceBytes;
  return {
    projectKey: projectRecord.key,
    projectType: projectRecord.type,
    resolution: projectRecord.resolution,
    sourceLayerCount: sourceLayers.length,
    authorityPolicy: record.authorityPolicy,
    indexedFiles: currentIndexedFiles ?? finiteNonNegativeNumber(stats.totalFiles),
    indexedBytes: currentIndexedBytes ?? finiteNonNegativeNumber(stats.totalBytes),
    approvedLocks: finiteNonNegativeNumber(locks.approved),
    candidateLocks: finiteNonNegativeNumber(locks.candidate),
    warningCount: finiteNonNegativeNumber(warningRecord.total),
    contentImport: {
      ...contentImport,
      pendingAssets: livePendingAssets,
    },
  };
}

export interface ListProjectsRequestOptions {
  /**
   * 默认只读落盘摘要，避免启动时对所有来源树做全量 SHA。
   * 显式核验可限定到一个受管工程；不指定 root 时才核验全部项目。
   */
  refreshSources?: boolean;
  sourceProjectRoot?: string;
  /** renderer→main 可取消请求身份；Core 只用于跨 IPC 对账。 */
  requestId?: string;
}

export interface ListProjectsOptions extends ListProjectsRequestOptions {
  /** 仅 Core/main 内部使用；不得跨 Electron structured-clone。 */
  signal?: AbortSignal;
}

export async function listProjects(options: ListProjectsOptions = {}): Promise<ListedProjectSummary[]> {
  throwIfScanAborted(options.signal);
  const registered = await listRegisteredProjects();
  throwIfScanAborted(options.signal);
  const selectedRoot = options.sourceProjectRoot
    ? path.resolve(options.sourceProjectRoot)
    : null;
  return Promise.all(registered.map(async (project) => {
    try {
      await access(project.primaryRoot);
      const refreshSource = options.refreshSources === true
        && (!selectedRoot || path.resolve(project.primaryRoot) === selectedRoot);
      const localCreativeImport = await readLocalCreativeImportProjectSummary(
        project.primaryRoot,
        { refreshSource, ...(options.signal ? { signal: options.signal } : {}) },
      );
      throwIfScanAborted(options.signal);
      return { ...project, available: true, ...(localCreativeImport ? { localCreativeImport } : {}) };
    } catch (error) {
      return { ...project, available: false, unavailableReason: error instanceof Error ? error.message : "项目根暂时不可访问" };
    }
  }));
}

export async function getActiveProject(): Promise<{ id: string; name: string; primaryRoot: string; updatedAt: string; available: boolean; unavailableReason?: string } | null> {
  const project = await getActiveProjectRegistration();
  if (!project) return null;
  try {
    await access(project.primaryRoot);
    return { ...project, available: true };
  } catch (error) {
    return { ...project, available: false, unavailableReason: error instanceof Error ? error.message : "活动项目根暂时不可访问" };
  }
}

/**
 * 面向 UI 轮询的物理只读活动项目投影。
 *
 * 不取得 registry lock，也不创建 locks 目录；短暂并发切换最多返回上一活动根的
 * 显示快照。任何激活或正式写入仍必须走带锁 owner 与运行时强门禁。
 */
export async function getActiveProjectReadOnly(): Promise<{
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
  available: boolean;
  unavailableReason?: string;
} | null> {
  const state = await getActiveProjectStateReadOnly();
  if (!state) return null;
  const activeRoot = path.resolve(state.primaryRoot);
  const project = (await listRegisteredProjects())
    .find((candidate) => path.resolve(candidate.primaryRoot) === activeRoot);
  if (!project) return null;
  try {
    await access(activeRoot);
    return { ...project, primaryRoot: activeRoot, available: true };
  } catch (error) {
    return {
      ...project,
      primaryRoot: activeRoot,
      available: false,
      unavailableReason: error instanceof Error ? error.message : "活动项目根暂时不可访问",
    };
  }
}

export async function activateProject(projectRoot: string): Promise<{ id: string; name: string; primaryRoot: string; updatedAt: string; available: true }> {
  const absoluteRoot = path.resolve(projectRoot);
  await access(absoluteRoot);
  const project = (await listRegisteredProjects()).find((candidate) => path.resolve(candidate.primaryRoot) === absoluteRoot);
  if (!project) throw new Error(`项目尚未登记，不能设为活动项目：${absoluteRoot}`);
  await setActiveProjectRegistration(absoluteRoot);
  return { ...project, primaryRoot: absoluteRoot, available: true };
}

export async function getManagedProjectShell(projectRoot: string): Promise<ProjectShell | null> {
  const absoluteRoot = path.resolve(projectRoot);
  if (!await isManagedProject(absoluteRoot)) return null;
  return inspectManagedProject(absoluteRoot);
}

export interface ManagedProjectCreatedEventReceipt {
  event: ProjectEvent;
  replayed: boolean;
}

function stableEventValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableEventValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableEventValue(entry)]));
}

function managedProjectCreatedEventData(shell: ProjectShell): Record<string, unknown> {
  return {
    projectMode: "story_first",
    projectId: shell.project.id,
    name: shell.project.name,
    sourceRoots: [],
    outputRoots: [shell.paths.root],
    startupPolicy: "no-filesystem-scan",
    manifestFingerprint: shell.manifestFingerprint,
  };
}

/**
 * 为本应用新建的受管工程记录唯一、可重放的创建事实。它不是旧 importer 的
 * project.imported 事件；冲突的同 key 事件会失败关闭，绝不追加第二条掩盖历史。
 */
export async function ensureManagedProjectCreatedEvent(shell: ProjectShell): Promise<ManagedProjectCreatedEventReceipt> {
  const projectRoot = shell.paths.root;
  const verified = await inspectManagedProject(projectRoot);
  if (verified.project.id !== shell.project.id
    || verified.project.name !== shell.project.name
    || verified.manifestFingerprint !== shell.manifestFingerprint) {
    throw new Error("受管工程创建事件输入与当前 manifest 身份冲突，已停止写入。");
  }
  const idempotencyKey = `project-managed-created-${verified.project.id}`;
  const expectedData = managedProjectCreatedEventData(verified);
  return withProjectLock(projectRoot, "managed-project-created-event", async () => {
    const matches = await findEventsByIdempotencyKey(projectRoot, idempotencyKey, 10);
    if (matches.length > 1) throw new Error("受管工程创建事件重复，已停止继续登记项目。");
    const existing = matches[0];
    if (existing) {
      const sameIdentity = existing.id === idempotencyKey
        && existing.type === "project.managed_created"
        && existing.actor === "app"
        && JSON.stringify(stableEventValue(existing.data ?? {})) === JSON.stringify(stableEventValue(expectedData));
      if (!sameIdentity) throw new Error("受管工程创建事件与当前 manifest 冲突，已停止继续登记项目。");
      return { event: existing, replayed: true };
    }
    const event = await appendEvent(projectRoot, {
      id: idempotencyKey,
      actor: "app",
      type: "project.managed_created",
      idempotencyKey,
      data: expectedData,
    });
    return { event, replayed: false };
  });
}

export async function createManagedStudioProject(options: CreateManagedProjectOptions): Promise<ProjectShell> {
  const shell = await createManagedProject(options);
  await ensureManagedProjectCreatedEvent(shell);
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);
  return shell;
}

export async function upgradeManagedStudioProject(projectRoot: string): Promise<ProjectShell> {
  const shell = await upgradeEmptyProjectToManaged(projectRoot);
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);
  return shell;
}

export async function removeProjectRegistration(projectRoot: string): Promise<void> {
  await unregisterProject(projectRoot);
}

export async function saveProjectConfig(config: ProjectConfig): Promise<ProjectIndex> {
  const projectRoot = path.resolve(config.primaryRoot);
  const current = await getProjectIndex(projectRoot);
  if (path.resolve(current.project.primaryRoot) !== projectRoot) throw new Error("项目主根不可通过设置页迁移，请重新导入目录。");
  const namingRules = config.namingRules ?? current.project.namingRules ?? { patterns: [], manualMappings: [] };
  for (const rule of namingRules.patterns) {
    try { new RegExp(rule.pattern, "i"); } catch { throw new Error(`自定义命名规则 ${rule.id} 不是有效正则表达式。`); }
  }
  const normalized: ProjectConfig = {
    ...config,
    primaryRoot: projectRoot,
    sourceRoots: [...new Set(config.sourceRoots.map((root) => path.resolve(root)))],
    outputRoots: [...new Set([projectRoot, ...config.outputRoots.map((root) => path.resolve(root))])],
    namingRules,
    updatedAt: new Date().toISOString(),
    automation: { ...config.automation, allowOverwriteAuthoritative: false },
  };
  await writeJsonAtomic(getSidecarPaths(projectRoot).config, normalized);
  await appendEvent(projectRoot, { actor: "user", type: "project.config_updated", data: { name: normalized.name } });
  return scanAndPersist(projectRoot);
}

export async function getTaskCenter(projectRoot: string): Promise<{ tasks: TaskPack[]; events: ProjectEvent[] }> {
  return { tasks: await listTaskPacks(projectRoot), events: await listEvents(projectRoot) };
}

export async function getProgress(projectRoot = DEFAULT_PROJECT_ROOT): Promise<{
  project: ProjectIndex["project"];
  scannedAt: string;
  scanId: string;
  scanStats?: ProjectIndex["scanStats"];
  summary: ProjectIndex["summary"];
  warnings: string[];
}> {
  const index = await getProjectIndex(projectRoot);
  return {
    project: index.project,
    scannedAt: index.scannedAt,
    scanId: index.scanId,
    scanStats: index.scanStats,
    summary: index.summary,
    warnings: index.warnings,
  };
}

export async function getItem(projectRoot: string, itemId: string): Promise<{
  item: WorkItem;
  artifacts: ProjectIndex["artifacts"];
}> {
  const index = await getProjectIndex(projectRoot);
  const item = index.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到节点：${itemId}`);
  return {
    item,
    artifacts: index.artifacts.filter((artifact) => item.artifactIds.includes(artifact.id)),
  };
}

export async function getNextTask(
  projectRoot = DEFAULT_PROJECT_ROOT,
  options: { episode?: number; itemType?: "unit" | "shot"; limit?: number } = {},
): Promise<WorkItem[]> {
  const { assertProductionWorkflowGate, getConfirmedStoryboardContracts } = await import("./production.js");
  await assertProductionWorkflowGate(projectRoot, "next_task");
  const [index, tasks] = await Promise.all([getProjectIndex(projectRoot), listTaskPacks(projectRoot)]);
  const reserved = new Set(tasks.filter((task) => ["ready", "claimed", "awaiting_review"].includes(task.status)).flatMap((task) => task.itemIds));
  const candidates = index.items
    .filter((item) => item.type === (options.itemType ?? "unit"))
    .filter((item) => options.episode === undefined || item.episode === options.episode)
    .filter((item) => !["已完成", "弃用", "阻塞", "视频生成中"].includes(item.status))
    .filter((item) => !reserved.has(item.id))
    .sort((a, b) => a.priority - b.priority || (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0))
    .slice(0, Math.max(1, Math.min(options.limit ?? 1, 20)));
  if (candidates.some((item) => ["待视频", "待视频验收"].includes(item.status))) await assertProductionWorkflowGate(projectRoot, "video", candidates.map((item) => item.id));
  if (candidates.length) await getConfirmedStoryboardContracts(projectRoot, candidates.map((item) => item.id));
  return candidates;
}

async function createTaskPackUnlocked(
  projectRoot = DEFAULT_PROJECT_ROOT,
  options: { itemIds?: string[]; episode?: number; mode?: TaskPack["mode"]; kind?: "image" | "video" } = {},
): Promise<{ task: TaskPack; path: string }> {
  const { assertProductionWorkflowGate, getConfirmedStoryboardContracts, getProductionWorkflow } = await import("./production.js");
  const kind = options.kind ?? "image";
  if (options.itemIds?.length) {
    await assertProductionWorkflowGate(projectRoot, kind, options.itemIds);
  } else {
    const workflow = await getProductionWorkflow(projectRoot);
    const requiredStageId = kind === "video" ? "frames" : "storyboard";
    const requiredIndex = workflow.stages.findIndex((stage) => stage.id === requiredStageId);
    if (workflow.stages.slice(0, requiredIndex + 1).some((stage) => stage.status !== "completed")) await assertProductionWorkflowGate(projectRoot, kind);
  }
  const [index, existingTasks] = await Promise.all([getProjectIndex(projectRoot), listTaskPacks(projectRoot)]);
  const reserved = new Set(existingTasks.filter((task) => ["ready", "claimed", "awaiting_review"].includes(task.status)).flatMap((task) => task.itemIds));
  const maxItems = kind === "video" ? index.project.automation.videoBatchSize : index.project.automation.imageBatchSize;
  const eligible = (item: WorkItem): boolean => {
    if (reserved.has(item.id) || (kind === "video" ? item.type !== "unit" : !["unit", "shot"].includes(item.type)) || ["已完成", "弃用", "阻塞", "视频生成中"].includes(item.status)) return false;
    return kind === "video"
      ? ["待视频", "待视频验收"].includes(item.status)
      : !["待视频", "待视频验收"].includes(item.status);
  };
  let items: WorkItem[];
  if (options.itemIds?.length) {
    const conflicts = options.itemIds.filter((id) => reserved.has(id));
    if (conflicts.length) throw new Error(`节点已经属于未结束任务包，不能重复建包：${conflicts.join("、")}`);
    items = options.itemIds
      .map((id) => index.items.find((item) => item.id === id))
      .filter((item): item is WorkItem => Boolean(item))
      .filter(eligible);
  } else {
    items = index.items
      .filter(eligible)
      .filter((item) => item.type === "unit")
      .filter((item) => options.episode === undefined || item.episode === options.episode)
      .sort((a, b) => a.priority - b.priority || (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0))
      .slice(0, maxItems);
  }
  if (items.length === 0) throw new Error(`没有可创建${kind === "video" ? "视频" : "图片"}任务包的待办节点。`);
  const firstEpisode = items[0]?.episode;
  items = items.filter((item) => item.episode === firstEpisode).slice(0, maxItems);
  const firstParent = items[0]?.type === "shot" ? items[0].parentId : undefined;
  if (firstParent) items = items.filter((item) => item.type === "shot" && item.parentId === firstParent);
  await assertProductionWorkflowGate(projectRoot, kind, items.map((item) => item.id));
  const storyboardContracts = await getConfirmedStoryboardContracts(projectRoot, items.map((item) => item.id), kind);
  const parentItems = items
    .map((item) => item.parentId ? index.items.find((candidate) => candidate.id === item.parentId) : undefined)
    .filter((item): item is WorkItem => Boolean(item));
  const taskHardLockIds = new Set([...items, ...parentItems].flatMap((item) => item.hardLockIds));
  const taskHardLocks = index.project.hardLocks.filter((lock) => taskHardLockIds.has(lock.id));
  const artifactMap = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]));
  const allowedOutputRoots = [...new Set([index.project.primaryRoot, ...index.project.outputRoots])].map((root) => path.resolve(root));
  const isInOutputRoot = (candidate: string) => allowedOutputRoots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  const suggestedOutputDirectory = (item: WorkItem) => {
    const nearby = path.dirname(item.infoPath ?? item.sourcePaths[0] ?? index.project.primaryRoot);
    if (isInOutputRoot(path.resolve(nearby))) return nearby;
    const episode = `EP${String(item.episode ?? 0).padStart(2, "0")}`;
    const node = item.type === "shot" ? `镜${item.shot ?? item.id}` : `15s_${String(item.unit ?? 0).padStart(3, "0")}`;
    return path.join(index.project.primaryRoot, "AI画布输出", episode, node);
  };
  const isShotBatch = items.every((item) => item.type === "shot");
  const activeSkills = await listAgentSkills(projectRoot, { enabledOnly: true });
  const storyGraph = await readJson<StoryEventGraph>(getSidecarPaths(projectRoot).storyEvents, { schemaVersion: 1, revision: 0, events: [], updatedAt: new Date(0).toISOString() });
  const task: TaskPack = {
    schemaVersion: 2,
    id: `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    projectId: index.project.id,
    revision: 1,
    status: "ready",
    kind,
    mode: options.mode ?? "autopilot",
    itemIds: items.map((item) => item.id),
    episode: firstEpisode,
    boundary: {
      episode: firstEpisode,
      parentId: firstParent,
      maxItems,
      pauseAfterVisualReview: index.project.automation.pauseAfterVisualBatch,
    },
    createdAt: new Date().toISOString(),
    instructions: [
      "先读取节点的 00_信息.md、提示词、硬锁和已有版本，再执行下一动作。",
      "读取 task.skillRefs 中全部已启用项目 Skill；若 Skill 与节点事实冲突，以真实文件和明确验收记录为准。",
      "若 itemSnapshots.storyEventIds 非空，调用 build_story_context 读取已确认事件与原文证据；草稿事件不能作为剧情事实。",
      "严格执行 itemSnapshots.storyboardRows 中已确认正式分镜；该快照是本任务的提示词、镜头时长和参考资产合同。",
      isShotBatch
        ? "按时间线顺序逐镜制作，每个原镜头单独生成一张图，保持与父单元及相邻镜头连续性。"
        : "每张图单独生成，保持角色、道具、场景和相邻镜头连续性。",
      "新结果使用新路径落盘，不覆盖或删除权威素材。",
      "每个节点完成后执行机械验收并登记；一批完成后暂停等待视觉验收。",
    ],
    hardLocks: taskHardLocks,
    skillRefs: activeSkills.map(({ id, name, description, category, path, revision }) => ({ id, name, description, category, path, revision })),
    outputRules: [
      "raw/labeled 必须成对",
      "禁止 base64、图片 JSON 或巨型日志进入 MCP 输出",
      "旧版、弃用、备份不计入完成度",
      "不得跨集推进当前任务包",
      ...(firstParent ? ["不得跨出当前 15 秒父单元"] : []),
    ],
    acceptanceCriteria: [
      "文件真实存在且非零字节",
      "图片可解码且最短边不少于 256px",
      isShotBatch ? "每个原镜头的 raw/labeled 成对，禁止用父单元图片冒充镜头结果" : "raw/labeled 成对且首尾帧齐全",
      "视觉结论不确定时停在待视觉验收，不虚报已完成",
    ],
    itemSnapshots: items.map((item) => {
      const parent = item.parentId ? index.items.find((candidate) => candidate.id === item.parentId) : undefined;
      const artifacts = [...item.artifactIds, ...(parent?.artifactIds ?? [])]
        .map((id) => artifactMap.get(id))
        .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact) && !artifact?.deprecated && Boolean(artifact?.authoritative));
      const storyboardRows = storyboardContracts.byItemId.get(item.id) ?? [];
      const referencePaths = [...new Set([
        ...storyboardRows.flatMap((row) => row.referencePaths),
        ...taskHardLocks.filter((lock) => item.hardLockIds.includes(lock.id) || parent?.hardLockIds.includes(lock.id)).map((lock) => lock.path),
        item.thumbnailPath,
        parent?.thumbnailPath,
        ...artifacts.filter((artifact) => ["raw-image", "labeled-image"].includes(artifact.kind)).map((artifact) => artifact.path),
      ].filter((value): value is string => Boolean(value)))].slice(0, 100);
      const storyboardPrompt = storyboardRows.map((row) => kind === "video"
        ? `镜头 ${row.order}（${row.durationSeconds} 秒）：${row.videoPrompt}`
        : item.status === "待尾帧" ? row.endFramePrompt : row.firstFramePrompt).join("\n");
      return {
        id: item.id,
        type: item.type,
        parentId: item.parentId,
        title: item.title,
        episode: item.episode,
        unit: item.unit,
        shot: item.shot,
        status: item.status,
        infoPath: item.infoPath,
        nextAction: item.nextAction,
        sourcePaths: item.sourcePaths.slice(0, 8),
        thumbnailPath: item.thumbnailPath,
        hardLockIds: [...new Set([...item.hardLockIds, ...(parent?.hardLockIds ?? [])])],
        promptExcerpt: storyboardPrompt.slice(0, 4_000),
        suggestedOutputDirectory: suggestedOutputDirectory(item),
        referencePaths,
        storyboardRows,
        storyEventIds: storyGraph.events.filter((event) => event.status === "confirmed" && (event.itemIds.includes(item.id) || (event.episode === item.episode && (!event.unit || event.unit === item.unit)))).map((event) => event.id),
      };
    }),
  };
  const taskPath = await writeTaskPack(projectRoot, task);
  await appendEvent(projectRoot, {
    actor: "codex",
    type: "task.created",
    taskId: task.id,
    data: { itemIds: task.itemIds, path: taskPath },
  });
  return { task, path: taskPath };
}

export async function createTaskPack(
  projectRoot = DEFAULT_PROJECT_ROOT,
  options: { itemIds?: string[]; episode?: number; mode?: TaskPack["mode"]; kind?: "image" | "video" } = {},
): Promise<{ task: TaskPack; path: string }> {
  return withProjectLock(projectRoot, "tasks", () => createTaskPackUnlocked(projectRoot, options));
}

function taskRevision(task: TaskPack): number { return Math.max(1, task.revision ?? 1); }
function leaseActive(task: TaskPack, now = Date.now()): boolean { return Boolean(task.lease && Date.parse(task.lease.leaseUntil) > now); }
function normalizedAgentId(value?: string): string {
  const agentId = value?.trim() || "codex";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,119}$/.test(agentId)) throw new Error("agentId 必须为 2–120 位稳定标识。 ");
  return agentId;
}
function assertTaskRevision(task: TaskPack, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("任务写操作必须提供有效的 expectedRevision。 ");
  if (taskRevision(task) !== expectedRevision) throw new Error(`任务包已被其他执行者更新（当前修订 ${taskRevision(task)}），请重新读取。`);
}

export async function claimTask(
  projectRoot: string,
  taskId: string,
  input: { agentId?: string; leaseSeconds?: number; expectedRevision: number },
): Promise<TaskPack> {
  return withProjectLock(projectRoot, "tasks", async () => {
    const task = await readTaskPack(projectRoot, taskId);
    if (!task) throw new Error(`找不到任务包：${taskId}`);
    if (!input) throw new Error("任务写操作必须提供有效的 expectedRevision。 ");
    task.revision = taskRevision(task);
    assertTaskRevision(task, input.expectedRevision);
    if (["awaiting_review", "completed", "blocked", "cancelled"].includes(task.status)) throw new Error(`任务包已经是 ${task.status}，不能领取。`);
    const agentId = normalizedAgentId(input.agentId);
    if (task.status === "claimed" && leaseActive(task)) {
      if (task.lease?.owner === agentId) return task;
      throw new Error(`任务包由 ${task.lease?.owner ?? "其他执行者"} 持有至 ${task.lease?.leaseUntil ?? "未知时间"}，不能重复领取。`);
    }
    if (task.status === "claimed") await appendEvent(projectRoot, { actor: "scanner", type: "task.lease-expired", taskId, data: { previousOwner: task.lease?.owner, previousLeaseId: task.lease?.id, leaseUntil: task.lease?.leaseUntil } });
    const now = new Date();
    const leaseSeconds = Math.max(30, Math.min(3_600, Math.trunc(input.leaseSeconds ?? 900)));
    const claimedAt = now.toISOString();
    task.status = "claimed";
    task.claimedAt = claimedAt;
    task.completedAt = undefined;
    task.result = undefined;
    task.lease = { id: `lease-${randomUUID()}`, owner: agentId, claimedAt, heartbeatAt: claimedAt, leaseUntil: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(), leaseSeconds };
    task.revision += 1;
    await writeTaskPack(projectRoot, task);
    await appendEvent(projectRoot, { actor: "codex", type: "task.claimed", taskId, data: { agentId, leaseId: task.lease.id, leaseUntil: task.lease.leaseUntil, revision: task.revision } });
    return task;
  });
}

export async function heartbeatTask(
  projectRoot: string,
  taskId: string,
  input: { leaseId: string; agentId?: string; leaseSeconds?: number; expectedRevision: number },
): Promise<TaskPack> {
  return withProjectLock(projectRoot, "tasks", async () => {
    const task = await readTaskPack(projectRoot, taskId);
    if (!task) throw new Error(`找不到任务包：${taskId}`);
    if (!input) throw new Error("任务写操作必须提供有效的 expectedRevision。 ");
    task.revision = taskRevision(task);
    assertTaskRevision(task, input.expectedRevision);
    const owner = normalizedAgentId(input.agentId);
    if (task.status !== "claimed" || !task.lease || task.lease.id !== input.leaseId || task.lease.owner !== owner) throw new Error("任务租约与当前执行者不匹配，拒绝续租。 ");
    if (!leaseActive(task)) throw new Error("任务租约已经过期，请重新领取任务包。 ");
    const leaseSeconds = Math.max(30, Math.min(3_600, Math.trunc(input.leaseSeconds ?? task.lease.leaseSeconds)));
    const heartbeatAt = new Date().toISOString();
    task.lease = { ...task.lease, heartbeatAt, leaseUntil: new Date(Date.now() + leaseSeconds * 1_000).toISOString(), leaseSeconds };
    task.revision += 1;
    await writeTaskPack(projectRoot, task);
    await appendEvent(projectRoot, { actor: "codex", type: "task.heartbeat", taskId, data: { agentId: owner, leaseId: input.leaseId, leaseUntil: task.lease.leaseUntil, revision: task.revision } });
    return task;
  });
}

export async function releaseTask(
  projectRoot: string,
  taskId: string,
  input: { leaseId: string; agentId?: string; expectedRevision: number; reason?: string },
): Promise<TaskPack> {
  return withProjectLock(projectRoot, "tasks", async () => {
    const task = await readTaskPack(projectRoot, taskId);
    if (!task) throw new Error(`找不到任务包：${taskId}`);
    if (!input) throw new Error("任务写操作必须提供有效的 expectedRevision。 ");
    task.revision = taskRevision(task);
    const owner = normalizedAgentId(input.agentId);
    assertTaskRevision(task, input.expectedRevision);
    if (task.status === "ready" && task.lastRelease?.leaseId === input.leaseId && task.lastRelease.owner === owner) return task;
    if (task.status !== "claimed" || !task.lease || task.lease.id !== input.leaseId || task.lease.owner !== owner) throw new Error("任务租约与当前执行者不匹配，拒绝释放。 ");
    task.status = "ready";
    task.lastRelease = { leaseId: task.lease.id, owner, reason: input.reason?.trim().slice(0, 2_000), releasedAt: new Date().toISOString() };
    task.lease = undefined;
    task.revision += 1;
    await writeTaskPack(projectRoot, task);
    await appendEvent(projectRoot, { actor: "codex", type: "task.released", taskId, data: { agentId: owner, leaseId: input.leaseId, reason: input.reason, revision: task.revision } });
    return task;
  });
}

export async function cancelTask(
  projectRoot: string,
  taskId: string,
  input: { expectedRevision: number; reason: string },
): Promise<TaskPack> {
  return withProjectLock(projectRoot, "tasks", async () => {
    const task = await readTaskPack(projectRoot, taskId);
    if (!task) throw new Error(`找不到任务包：${taskId}`);
    if (!input) throw new Error("任务写操作必须提供有效的 expectedRevision。 ");
    task.revision = taskRevision(task);
    assertTaskRevision(task, input.expectedRevision);
    const reason = input.reason.trim().slice(0, 2_000);
    if (!reason) throw new Error("取消任务必须填写真实原因。 ");
    if (task.status !== "ready" && task.status !== "claimed") throw new Error(`只能取消待领取或租约已过期的任务；当前状态为 ${task.status}。`);
    if (task.status === "claimed" && !task.lease) throw new Error("任务处于已领取状态但缺少可核验租约，拒绝取消。 ");
    if (task.status === "claimed" && leaseActive(task)) throw new Error("任务仍有活跃租约，不能强制取消；应由当前执行者先调用 release_task。 ");

    const previousStatus: "ready" | "claimed" = task.status;
    const previousLease = task.lease;
    if (previousStatus === "claimed") {
      await appendEvent(projectRoot, {
        actor: "scanner",
        type: "task.lease-expired",
        taskId,
        data: { previousOwner: previousLease?.owner, previousLeaseId: previousLease?.id, leaseUntil: previousLease?.leaseUntil, action: "cancel" },
      });
    }
    const cancelledAt = new Date().toISOString();
    task.status = "cancelled";
    task.cancelledAt = cancelledAt;
    task.completedAt = undefined;
    task.result = undefined;
    task.cancellation = {
      reason,
      cancelledAt,
      previousStatus,
      previousLeaseId: previousLease?.id,
      previousOwner: previousLease?.owner,
    };
    if (previousLease) task.lastRelease = { leaseId: previousLease.id, owner: previousLease.owner, reason: `cancelled: ${reason}`, releasedAt: cancelledAt };
    task.lease = undefined;
    task.revision += 1;
    await writeTaskPack(projectRoot, task);
    await appendEvent(projectRoot, {
      actor: "codex",
      type: "task.cancelled",
      taskId,
      data: {
        reason,
        previousStatus,
        previousLeaseId: previousLease?.id,
        previousOwner: previousLease?.owner,
        revision: task.revision,
      },
    });
    return task;
  });
}

export async function registerArtifact(
  projectRoot: string,
  input: {
    itemId: string;
    artifactPath: string;
    kind: ArtifactKind;
    variant?: ArtifactVariant;
    note?: string;
  },
): Promise<{ item: WorkItem; artifactPath: string; scanId: string }> {
  const config = (await getProjectIndex(projectRoot)).project;
  const absolutePath = path.resolve(input.artifactPath);
  const allowedRoots = [...new Set([config.primaryRoot, ...config.outputRoots])].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))) {
    throw new Error("结果路径不在项目允许的输出根目录内。");
  }
  await access(absolutePath);
  const index = await scanAndPersist(projectRoot);
  const item = index.items.find((candidate) => candidate.id === input.itemId);
  if (!item) throw new Error("文件已登记，但重新扫描后仍无法映射到指定节点；请检查 EP/15s/镜号命名。");
  const mapped = index.artifacts.find((artifact) => artifact.itemId === input.itemId
    && path.resolve(artifact.path) === absolutePath
    && artifact.kind === input.kind
    && artifact.variant === (input.variant ?? "generic"));
  if (!mapped) throw new Error("文件存在，但扫描后没有按指定 kind/variant 映射到目标节点；拒绝虚报已登记。请修正命名或导入映射规则后重试。 ");
  await appendEvent(projectRoot, {
    actor: "codex",
    type: "artifact.registered",
    itemId: input.itemId,
    data: { artifactId: mapped.id, path: absolutePath, kind: input.kind, variant: input.variant ?? "generic", note: input.note, sha256: mapped.check.sha256 },
  });
  return { item, artifactPath: absolutePath, scanId: index.scanId };
}

export async function verifyItem(projectRoot: string, itemId: string): Promise<ReturnType<typeof getItem>> {
  await scanAndPersist(projectRoot);
  const result = await getItem(projectRoot, itemId);
  await appendEvent(projectRoot, {
    actor: "scanner",
    type: "item.verified",
    itemId,
    data: {
      status: result.item.status,
      failures: result.artifacts.filter((artifact) => !artifact.check.ok).map((artifact) => artifact.path),
    },
  });
  return result;
}

async function mutateOverrides(projectRoot: string, mutate: (overrides: ProjectOverrides) => void): Promise<void> {
  await withProjectLock(projectRoot, "overrides", async () => {
    const overrides = await loadOverrides(projectRoot);
    mutate(overrides);
    await saveOverrides(projectRoot, overrides);
  });
}

export async function updateStatus(
  projectRoot: string,
  itemId: string,
  status: WorkItemStatus,
  note?: string,
  authoritativePath?: string,
  actor: ProjectEvent["actor"] = "codex",
  transitionAuthority: "general" | "review" = "general",
  transitionEvidenceId?: string,
  transitionReviewType?: "image" | "video",
  transitionRequirementId?: string,
): Promise<WorkItem> {
  if (!WORK_ITEM_STATUSES.includes(status)) throw new Error(`不支持的状态：${status}`);
  const current = await getItem(projectRoot, itemId);
  if (current.item.type === "asset" && await loadCanonicalAssetStore(projectRoot)) {
    throw new Error("规范资产库已启用；资产状态和权威不得写入旧 overrides，必须走规范资产命令总线。 ");
  }
  if (status === "已完成") {
    const issues = completionIssues(current.item, current.artifacts);
    if (issues.length) throw new Error(`完成门禁未通过：${issues.join("；")}`);
  }
  if (transitionAuthority !== "review" && ["unit", "shot"].includes(current.item.type)) {
    if (status === "已完成") throw new Error("生产节点只能由绑定当前素材版本的视觉验收推进为已完成。 ");
    if (current.item.type === "unit" && ["待视频", "视频生成中", "待视频验收"].includes(status)) throw new Error("15 秒单元的视频阶段只能由视觉验收或生成队列的受控状态机推进。 ");
  }
  if (transitionAuthority !== "review" && current.item.type === "asset" && status === "已完成") {
    throw new Error("资产节点只能由绑定当前权威图片内容的视觉验收推进为已完成。 ");
  }
  const authoritativeArtifact = authoritativePath ? current.artifacts.find((artifact) => path.resolve(artifact.path) === path.resolve(authoritativePath)) : undefined;
  if (authoritativePath && !authoritativeArtifact) throw new Error("权威路径不属于当前节点的真实素材版本。 ");
  if (transitionAuthority === "review" && (!transitionEvidenceId || !transitionReviewType)) throw new Error("视觉验收状态推进必须绑定不可变 ReviewRecord 及验收相位。 ");
  await mutateOverrides(projectRoot, (overrides) => {
    const previous = overrides.items[itemId];
    overrides.items[itemId] = {
      ...previous,
      status,
      statusAuthority: transitionAuthority,
      reviewEvidenceIds: transitionAuthority === "review"
        ? { ...(previous?.reviewEvidenceIds ?? {}), [transitionReviewType!]: transitionEvidenceId! }
        : previous?.reviewEvidenceIds,
      reviewRequirementIds: transitionAuthority === "review" && transitionRequirementId
        ? { ...(previous?.reviewRequirementIds ?? {}), [transitionReviewType!]: transitionRequirementId }
        : previous?.reviewRequirementIds,
      statusEvidenceId: transitionAuthority === "review" ? transitionEvidenceId : undefined,
      note,
      authoritativePath,
      authoritativeArtifactId: authoritativeArtifact?.id,
      updatedAt: new Date().toISOString(),
    };
  });
  await appendEvent(projectRoot, {
    actor,
    type: "item.status_updated",
    itemId,
    data: { from: current.item.status, to: status, note, authoritativePath },
  });
  const index = await scanAndPersist(projectRoot);
  const updated = index.items.find((item) => item.id === itemId);
  if (!updated) throw new Error(`状态写入后找不到节点：${itemId}`);
  return updated;
}

export async function updateStatusOverridesBatch(
  projectRoot: string,
  updates: Array<{ itemId: string; status: WorkItemStatus; note?: string }>,
  actor: ProjectEvent["actor"] = "app",
): Promise<ProjectIndex> {
  if (!updates.length) return getProjectIndex(projectRoot);
  const index = await getProjectIndex(projectRoot);
  const byId = new Map(index.items.map((item) => [item.id, item]));
  for (const update of updates) {
    if (!WORK_ITEM_STATUSES.includes(update.status)) throw new Error(`不支持的状态：${update.status}`);
    const item = byId.get(update.itemId);
    if (!item) throw new Error(`找不到批量状态节点：${update.itemId}`);
    if (item.type === "asset" && await loadCanonicalAssetStore(projectRoot)) {
      throw new Error(`${item.title} 已由规范资产库管理，禁止写入旧批量状态覆盖。`);
    }
    if (item.type === "asset" && update.status === "已完成") {
      throw new Error(`${item.title} 资产节点只能由绑定当前权威图片内容的视觉验收推进为已完成。`);
    }
    if (update.status === "已完成") {
      const artifacts = index.artifacts.filter((artifact) => item.artifactIds.includes(artifact.id));
      const issues = completionIssues(item, artifacts);
      if (issues.length) throw new Error(`${item.title} 完成门禁未通过：${issues.join("；")}`);
    }
  }
  const now = new Date().toISOString();
  await mutateOverrides(projectRoot, (overrides) => {
    for (const update of updates) {
      const previous = overrides.items[update.itemId];
      overrides.items[update.itemId] = {
        ...previous,
        status: update.status,
        statusAuthority: "general",
        reviewEvidenceIds: previous?.reviewEvidenceIds,
        statusEvidenceId: undefined,
        note: update.note,
        updatedAt: now,
      };
    }
  });
  for (const update of updates) {
    await appendEvent(projectRoot, { actor, type: "item.status_updated", itemId: update.itemId, data: { from: byId.get(update.itemId)?.status, to: update.status, note: update.note, batch: true } });
  }
  return scanAndPersist(projectRoot);
}

export async function setAuthoritativeArtifact(projectRoot: string, itemId: string, artifactId: string, note?: string): Promise<WorkItem> {
  const current = await getItem(projectRoot, itemId);
  if (current.item.type === "asset" && await loadCanonicalAssetStore(projectRoot)) {
    throw new Error("规范资产库已启用；资产权威不得写入旧 overrides，必须走规范资产命令总线。 ");
  }
  const artifact = current.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error(`节点中找不到素材版本：${artifactId}`);
  if (artifact.deprecated) throw new Error("弃用或备份版本不能直接设为权威版本。");
  if (!artifact.check.ok) throw new Error("机械验收未通过的素材不能设为权威版本。");
  if (artifact.fusionStoryboardPanel && (!current.item.fusionStoryboard
    || current.item.fusionStoryboard.contractId !== artifact.fusionStoryboardPanel.contractId
    || current.item.fusionStoryboard.sourceFingerprint !== artifact.fusionStoryboardPanel.sourceFingerprint
    || current.item.fusionStoryboard.productionFingerprint !== artifact.fusionStoryboardPanel.productionFingerprint)) {
    throw new Error("历史或已失效合同的宫格图片不能重新提升为当前权威版本。");
  }
  const key = artifactAuthorityKey(artifact);
  await mutateOverrides(projectRoot, (overrides) => {
    const previous = overrides.items[itemId] ?? { updatedAt: new Date().toISOString() };
    overrides.items[itemId] = {
      ...previous,
      authoritativePaths: { ...(previous.authoritativePaths ?? {}), [key]: artifact.path },
      authoritativeArtifactIds: { ...(previous.authoritativeArtifactIds ?? {}), [key]: artifact.id },
      note: note ?? previous.note,
      updatedAt: new Date().toISOString(),
    };
  });
  await appendEvent(projectRoot, {
    actor: "user",
    type: "artifact.authority_selected",
    itemId,
    data: { artifactId, path: artifact.path, key, note },
  });
  const index = await scanAndPersist(projectRoot);
  const updated = index.items.find((item) => item.id === itemId);
  if (!updated) throw new Error(`权威版本写入后找不到节点：${itemId}`);
  return updated;
}

export async function promoteAssetToHardLock(projectRoot: string, itemId: string, note?: string): Promise<WorkItem> {
  if (await loadCanonicalAssetStore(projectRoot)) {
    throw new Error("规范资产库已启用；旧 hardLocks 提升入口已关闭，禁止建立第二套资产权威。 ");
  }
  const previous = await getProjectIndex(projectRoot);
  const previousItem = previous.items.find((candidate) => candidate.id === itemId && candidate.type === "asset");
  if (!previousItem) throw new Error(`找不到可提升的资产节点：${itemId}`);
  const imagePaths = previous.artifacts
    .filter((candidate) => previousItem.artifactIds.includes(candidate.id) && candidate.authoritative && !candidate.deprecated && ["raw-image", "labeled-image"].includes(candidate.kind) && candidate.variant === "generic")
    .map((candidate) => candidate.path);
  const index = await scanAndPersist(projectRoot, { includeHashPaths: imagePaths });
  const item = index.items.find((candidate) => candidate.id === itemId && candidate.type === "asset");
  if (!item) throw new Error(`找不到可提升的资产节点：${itemId}`);
  const active = index.artifacts.filter((candidate) => item.artifactIds.includes(candidate.id) && candidate.authoritative && !candidate.deprecated);
  const artifact = active.find((candidate) => candidate.kind === "raw-image" && candidate.variant === "generic");
  const labeled = active.find((candidate) => candidate.kind === "labeled-image" && candidate.variant === "generic");
  if (!artifact?.check.ok || artifact.check.decodable === false) throw new Error("只有可解码且机械验收通过的当前权威 generic raw 才能提升为硬锁。");
  if (labeled && (!labeled.check.ok || labeled.check.decodable === false)) throw new Error("当前资产存在 generic labeled，但其机械验收未通过。");
  const store = await readJson<ReviewStore>(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] });
  const overrides = await loadOverrides(projectRoot);
  const requiredArtifacts = labeled ? [artifact, labeled] : [artifact];
  const candidates = store.records
    .filter((record) => record.itemId === item.id && record.reviewType === "image" && record.decision === "pass" && record.resultingStatus === "已完成")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const explicitEvidenceId = overrides.items[item.id]?.reviewEvidenceIds?.image;
  const review = explicitEvidenceId
    ? candidates.find((record) => record.id === explicitEvidenceId && reviewCoversArtifacts(record, requiredArtifacts))
    : candidates.find((record) => reviewCoversArtifacts(record, requiredArtifacts));
  if (!review) throw new Error("当前权威资产图缺少绑定当前文件内容的图片视觉通过证据，不能提升为硬锁。");
  const fusionManifest = await readJson<unknown | null>(getSidecarPaths(projectRoot).fusionProjectManifest, null);
  if (fusionManifest) await assertFusionAssetConsistencyApprovedForItem(projectRoot, itemId);
  const config = await loadProjectConfig(projectRoot);
  const lockId = item.id.startsWith("asset-") ? item.id.slice("asset-".length) : `manual-${randomUUID().slice(0, 12)}`;
  const existing = config.hardLocks.find((lock) => lock.id === lockId || path.resolve(lock.path) === path.resolve(artifact.path));
  const lockRecord = {
      id: lockId,
      name: item.title,
      path: artifact.path,
      note: note?.trim() || "在资产库中人工提升为显式硬锁；任务仅在镜头文本命中时携带。",
  };
  const revised = Boolean(existing && (path.resolve(existing.path) !== path.resolve(artifact.path) || existing.name !== lockRecord.name || existing.note !== lockRecord.note));
  if (!existing) config.hardLocks.push(lockRecord);
  else if (revised) config.hardLocks[config.hardLocks.indexOf(existing)] = lockRecord;
  if (!existing || revised) {
    config.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).config, config);
    await appendEvent(projectRoot, { actor: "user", type: revised ? "asset.hard_lock_revised" : "asset.promoted_to_hard_lock", itemId, data: { path: artifact.path, sha256: artifact.check.sha256, reviewId: review.id, note } });
  }
  const refreshed = await scanAndPersist(projectRoot);
  const updated = refreshed.items.find((candidate) => candidate.type === "asset" && candidate.sourcePaths.includes(artifact.path));
  if (!updated) throw new Error("资产已提升，但重新扫描后未找到对应节点。");
  return updated;
}

export async function finishBatch(
  projectRoot: string,
  taskId: string,
  input: { status?: "completed" | "blocked"; completedItemIds?: string[]; failedItemIds?: string[]; note?: string; leaseId: string; agentId?: string; expectedRevision: number },
): Promise<TaskPack> {
  return withProjectLock(projectRoot, "tasks", async () => {
    const task = await readTaskPack(projectRoot, taskId);
    if (!task) throw new Error(`找不到任务包：${taskId}`);
    if (!input) throw new Error("任务写操作必须提供有效的 expectedRevision。 ");
    task.revision = taskRevision(task);
    const status = input.status ?? "completed";
    const completedItemIds = [...new Set(input.completedItemIds ?? [])];
    const failedItemIds = [...new Set(input.failedItemIds ?? [])];
    const owner = normalizedAgentId(input.agentId);
    // pauseAfterVisualReview 只控制自动驾驶是否自动选取下一批，不能关闭视觉验收事实门禁。
    const targetStatus = status === "blocked" ? "blocked" : "awaiting_review";
    assertTaskRevision(task, input.expectedRevision);
    if (["awaiting_review", "completed", "blocked"].includes(task.status) && task.result?.status === targetStatus && task.result.completedItemIds.join("\0") === completedItemIds.join("\0") && task.result.failedItemIds.join("\0") === failedItemIds.join("\0") && task.lastRelease?.leaseId === input.leaseId) return task;
    if (task.status !== "claimed" || !task.lease || task.lease.id !== input.leaseId || task.lease.owner !== owner) throw new Error("结束批次必须持有匹配的有效任务租约。 ");
    if (!leaseActive(task)) throw new Error("任务租约已经过期，不能回写批次结果；请重新读取并领取。 ");
    const allowed = new Set(task.itemIds);
    const unknown = [...completedItemIds, ...failedItemIds].filter((id) => !allowed.has(id));
    if (unknown.length) throw new Error(`批次结果包含任务包之外的节点：${[...new Set(unknown)].join("、")}`);
    const overlap = completedItemIds.filter((id) => failedItemIds.includes(id));
    if (overlap.length) throw new Error(`节点不能同时标记成功和失败：${overlap.join("、")}`);
    if (status === "completed" && failedItemIds.length) throw new Error("存在失败节点时必须将批次标记为 blocked。 ");
    if (status === "blocked" && !failedItemIds.length && !input.note?.trim()) throw new Error("阻塞批次必须列出失败节点或填写阻塞原因。 ");
    const unaccounted = task.itemIds.filter((id) => !completedItemIds.includes(id) && !failedItemIds.includes(id));
    if (unaccounted.length) throw new Error(`结束批次前必须逐项归档成功或失败：${unaccounted.join("、")}`);
    const index = await scanAndPersist(projectRoot, true);
    const fusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
    const byId = new Map(index.items.map((item) => [item.id, item]));
    const unexplainedFailures = failedItemIds.filter((itemId) => !["返工", "阻塞"].includes(byId.get(itemId)?.status ?? ""));
    if (unexplainedFailures.length && !input.note?.trim()) throw new Error(`失败节点尚未标记返工/阻塞，必须填写真实失败原因：${unexplainedFailures.join("、")}`);
    const reviewNotBefore = new Date().toISOString();
    const reviewRequirements: NonNullable<NonNullable<TaskPack["result"]>["reviewRequirements"]> = {};
    for (const itemId of completedItemIds) {
      const item = byId.get(itemId);
      if (!item) throw new Error(`重新扫描后找不到已完成节点：${itemId}`);
      const artifacts = index.artifacts.filter((artifact) => artifact.itemId === itemId && artifact.authoritative && !artifact.deprecated);
      const fusionRequirement = task.kind === "image" && item.fusionStoryboard
        ? buildFusionStoryboardReviewRequirement(item, index.artifacts.filter((artifact) => artifact.itemId === itemId), fusionEvidence)
        : undefined;
      if (fusionRequirement && !fusionRequirement.complete) {
        throw new Error(`${item.title} 当前宫格合同尚未形成完整 Review requirement：${fusionRequirement.issues.join("；")}`);
      }
      const required = task.kind === "video"
        ? [{ kind: "video" as const, variants: ["generic", "start", "end"] }]
        : fusionRequirement
          ? []
        : item.type === "shot"
          ? [{ kind: "raw-image" as const, variants: ["generic", "start"] }, { kind: "labeled-image" as const, variants: ["generic", "start"] }]
          : [{ kind: "raw-image" as const, variants: ["start"] }, { kind: "labeled-image" as const, variants: ["start"] }, { kind: "raw-image" as const, variants: ["end"] }, { kind: "labeled-image" as const, variants: ["end"] }];
      const requiredArtifacts: Artifact[] = fusionRequirement
        ? fusionRequirement.artifactIds.map((artifactId) => artifacts.find((artifact) => artifact.id === artifactId)).filter((artifact): artifact is Artifact => Boolean(artifact))
        : [];
      for (const requirement of required) {
        const artifact = artifacts.find((candidate) => candidate.kind === requirement.kind && requirement.variants.includes(candidate.variant));
        if (!artifact) throw new Error(`${item.title} 缺少批次验收所需的 ${requirement.kind}/${requirement.variants.join("|")} 权威版本。`);
        if (!artifact.check.ok || !artifact.check.decodable) throw new Error(`${item.title} 的 ${path.basename(artifact.path)} 未通过机械解码验收。`);
        if (!artifact.check.sha256) throw new Error(`${item.title} 的 ${path.basename(artifact.path)} 缺少 SHA-256，不能锁定本批视觉验收版本。`);
        requiredArtifacts.push(artifact);
      }
      if (fusionRequirement && requiredArtifacts.length !== fusionRequirement.panelCount * 2) {
        throw new Error(`${item.title} 宫格批次验收没有冻结完整的 ${fusionRequirement.panelCount * 2} 个文件。`);
      }
      reviewRequirements[itemId] = {
        reviewType: task.kind === "video" ? "video" : "image",
        artifactIds: requiredArtifacts.map((artifact) => artifact.id).sort(),
        artifactHashes: Object.fromEntries(requiredArtifacts.map((artifact) => [artifact.id, artifact.check.sha256!])),
        requirementId: fusionRequirement?.id,
        notBefore: reviewNotBefore,
      };
      const allowedStatuses = task.kind === "video" ? ["待视频验收", "已完成"] : ["待视觉验收", "待视频", "待视频验收", "已完成"];
      if (!allowedStatuses.includes(item.status)) throw new Error(`${item.title} 当前状态为 ${item.status}，尚未到达批次验收暂停点。`);
    }
    const finishedAt = reviewNotBefore;
    task.status = targetStatus;
    task.completedAt = targetStatus === "blocked" ? finishedAt : undefined;
    task.result = { status: targetStatus, completedItemIds, failedItemIds, awaitingReviewItemIds: targetStatus === "awaiting_review" ? completedItemIds : [], verifiedScanId: index.scanId, reviewRequirements, note: input.note?.trim().slice(0, 4_000), finishedAt };
    task.lastRelease = { leaseId: task.lease.id, owner, reason: status === "completed" ? "batch-finished" : "batch-blocked", releasedAt: finishedAt };
    task.lease = undefined;
    task.revision += 1;
    await writeTaskPack(projectRoot, task);
    await appendEvent(projectRoot, {
      actor: "codex",
      type: "batch.finished",
      taskId,
      data: { completedItemIds, failedItemIds, note: input.note, pausedForVisualReview: true, agentId: owner, leaseId: input.leaseId, revision: task.revision },
    });
    return task;
  });
}

export async function reconcileTaskReviews(projectRoot: string, changedItemId: string): Promise<TaskPack[]> {
  return withProjectLock(projectRoot, "tasks", async () => {
    const [tasks, store] = await Promise.all([
      listTaskPacks(projectRoot),
      readJson<ReviewStore>(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] }),
    ]);
    // 扫描会原子刷新 project/index；P2 currentness 必须在该写入完成后再取证，
    // 否则同一进程会制造“配置读取中变化”的假并发漂移。
    const index = await scanAndPersist(projectRoot, true);
    const fusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
    const changed: TaskPack[] = [];
    for (const task of tasks.filter((entry) => entry.status === "awaiting_review" && entry.itemIds.includes(changedItemId))) {
      const reviewType = task.kind === "video" ? "video" : "image";
      const reviewItemIds = task.result?.awaitingReviewItemIds.length ? task.result.awaitingReviewItemIds : task.itemIds;
      const latest = new Map<string, ReviewStore["records"][number]>();
      for (const record of [...store.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const requirement = task.result?.reviewRequirements?.[record.itemId];
        const item = index.items.find((candidate) => candidate.id === record.itemId);
        const currentFusionRequirement = item?.fusionStoryboard
          ? buildFusionStoryboardReviewRequirement(item, index.artifacts.filter((artifact) => artifact.itemId === item.id), fusionEvidence)
          : undefined;
        const notBefore = requirement?.notBefore ?? task.result?.finishedAt ?? task.createdAt;
        const requiredIds = requirement?.artifactIds ?? [];
        const coversRequired = requiredIds.every((artifactId) => record.artifactIds.includes(artifactId));
        const evidenceMatches = reviewCoversArtifacts(record, requiredIds.map((artifactId) => index.artifacts.find((artifact) => artifact.id === artifactId)));
        const hashesStillMatch = Object.entries(requirement?.artifactHashes ?? {}).every(([artifactId, expectedHash]) => index.artifacts.find((artifact) => artifact.id === artifactId)?.check.sha256 === expectedHash);
        const requirementStillMatches = !requirement?.requirementId
          || (record.requirementId === requirement.requirementId && currentFusionRequirement?.id === requirement.requirementId);
        if (record.reviewType === reviewType && record.createdAt >= notBefore && coversRequired && evidenceMatches && hashesStillMatch && requirementStillMatches && reviewItemIds.includes(record.itemId) && !latest.has(record.itemId)) latest.set(record.itemId, record);
      }
      const reworked = reviewItemIds.filter((id) => latest.get(id)?.decision === "rework");
      const allPassed = reviewItemIds.length > 0 && reviewItemIds.every((id) => latest.get(id)?.decision === "pass");
      if (!reworked.length && !allPassed) continue;
      const now = new Date().toISOString();
      task.status = reworked.length ? "blocked" : "completed";
      task.completedAt = now;
      task.revision = taskRevision(task) + 1;
      task.result = {
        status: task.status,
        completedItemIds: reworked.length ? reviewItemIds.filter((id) => !reworked.includes(id)) : reviewItemIds,
        failedItemIds: reworked,
        awaitingReviewItemIds: [],
        verifiedScanId: task.result?.verifiedScanId ?? (await getProjectIndex(projectRoot)).scanId,
        note: reworked.length ? `视觉验收要求返工：${reworked.join("、")}` : task.result?.note,
        finishedAt: now,
      };
      await writeTaskPack(projectRoot, task);
      await appendEvent(projectRoot, { actor: "scanner", type: reworked.length ? "task.review-blocked" : "task.review-completed", taskId: task.id, data: { itemIds: reviewItemIds, failedItemIds: reworked, revision: task.revision } });
      changed.push(task);
    }
    return changed;
  });
}

export function saveCanvasPositions(projectRoot: string, viewKey: string, positions: Record<string, CanvasPosition>): void {
  const cache = new ProjectCache(projectRoot);
  try {
    cache.savePositions(viewKey, positions);
  } finally {
    cache.close();
  }
}

export function loadCanvasPositions(projectRoot: string, viewKey: string): Record<string, CanvasPosition> {
  const cache = new ProjectCache(projectRoot);
  try {
    return cache.loadPositions(viewKey);
  } finally {
    cache.close();
  }
}

export function summarizeForMcp(index: ProjectIndex): Record<string, unknown> {
  return {
    project: { id: index.project.id, name: index.project.name, primaryRoot: index.project.primaryRoot },
    scannedAt: index.scannedAt,
    scanId: index.scanId,
    scanDurationMs: index.scanDurationMs,
    scanStats: index.scanStats,
    summary: index.summary,
    warnings: index.warnings,
  };
}

export function sortByPriority(items: WorkItem[]): WorkItem[] {
  return [...items].sort(
    (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0),
  );
}
