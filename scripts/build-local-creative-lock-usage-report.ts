import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type LockStatus = "APPROVED_LOCK" | "CANDIDATE_LOCK";
type SourceRole =
  | "PRIMARY_AUTHORITY"
  | "ACTIVE_PRODUCTION"
  | "UPSTREAM_SCRIPT"
  | "LEGACY_HISTORY"
  | "EXPORT"
  | "UNASSIGNED_INBOX"
  | "UNKNOWN";

interface CatalogSource {
  root: string;
  role: string;
}

interface CatalogProject {
  key: string;
  name: string;
  projectType: string;
  resolution: string;
  sources: CatalogSource[];
}

interface CatalogDocument {
  schemaVersion: 1;
  kind?: string;
  projects: CatalogProject[];
}

interface MaterializationResult {
  key: string;
  name: string;
  status: "materialized" | "failed";
  resolution: string;
  projectRoot?: string;
  error?: string;
}

interface MaterializationReport {
  schemaVersion: 1;
  kind: "local-creative-project-materialization-report";
  fingerprint: string;
  results: MaterializationResult[];
}

interface ProgressMedia {
  fileId: string;
  sourcePath: string;
  sourceLayerRole: string;
  sha256: string;
  kind?: "image" | "video" | "audio";
}

interface ProgressCanonicalDecision {
  fileId: string;
  sourcePath: string;
  sourceStatus: string;
  decision: string;
  assetId?: string;
  versionId?: string;
  mediaSha256?: string;
  authorityPromoted?: boolean;
}

interface ProgressReference {
  fileId: string;
  path: string;
  evidenceLevels: string[];
}

interface ProgressLock {
  lockFileId: string;
  lockPath: string;
  status: LockStatus;
  referencedBy: ProgressReference[];
}

interface ContentProgress {
  schemaVersion: 1;
  kind: "local-creative-project-content-import-progress";
  projectRoot: string;
  sourceProject: {
    key: string;
    name: string;
    type: string;
  };
  previewFingerprint: string;
  mediaByFileId: Record<string, ProgressMedia>;
  canonicalDecisionsByFileId: Record<string, ProgressCanonicalDecision>;
  sourceStatusCounts: Record<string, number>;
  lockReferenceIndex: ProgressLock[];
  status: string;
}

export interface LocalCreativeLockUsageReportOptions {
  catalogPath: string;
  materializationReportPath: string;
  outputPath: string;
}

export interface LocalCreativeLockUsageReportCliOptions extends LocalCreativeLockUsageReportOptions {
  help: boolean;
}

interface LockOccurrence {
  projectKey: string;
  projectName: string;
  projectRoot: string;
  fileId: string;
  path: string;
  status: LockStatus;
  sourceRole: SourceRole;
  mediaKind: "image" | "video" | "audio" | null;
  visualLockRecord: boolean;
  sha256: string | null;
  explicitReferencedBy: Array<{
    fileId: string;
    path: string;
    evidenceLevels: string[];
  }>;
  declaredReferencedBy: Array<{
    fileId: string;
    path: string;
    evidenceLevels: string[];
  }>;
  pendingLocalAsset?: {
    assetId?: string;
    versionId?: string;
    decision: string;
    authorityPromoted: false;
  };
  visualAppearance: {
    status: "UNCONFIRMED";
    reason: "declared-reference-is-not-pixel-level-appearance-evidence";
  };
  crossProjectAuthorityInherited: false;
}

interface ProjectReport {
  key: string;
  name: string;
  resolution: string;
  projectRoot?: string;
  progressPath?: string;
  progressStatus: "available" | "missing" | "materialization-failed" | "invalid";
  progressImportStatus?: string;
  error?: string;
  declaredStatusCounts?: Record<string, number>;
  summary: {
    approvedLocks: number;
    candidateLocks: number;
    approvedImageLocks: number;
    candidateImageLocks: number;
    nonImageLockEvidenceRecords: number;
    imageLocksWithExplicitReferences: number;
    imageExplicitReferences: number;
    locksWithExplicitReferences: number;
    explicitReferences: number;
    locksWithKnownSha256: number;
  };
  bySourceRole: Partial<Record<SourceRole, {
    approvedLocks: number;
    candidateLocks: number;
    explicitReferences: number;
  }>>;
  locks: LockOccurrence[];
}

export interface LocalCreativeLockUsageReport {
  schemaVersion: 1;
  kind: "local-creative-lock-usage-report";
  inputs: {
    catalogPath: string;
    materializationReportPath: string;
    materializationFingerprint: string;
  };
  outputPath: string;
  readOnlyInputs: true;
  evidencePolicy: {
    declaredReferenceMeaning: "TEXT_OR_MANIFEST_REFERENCE_ONLY";
    lockRecordMeaning: "SOURCE_STATUS_RECORDS_MAY_INCLUDE_NON_IMAGE_EVIDENCE";
    visualLockMetricMeaning: "IMPORTED_RASTER_IMAGE_LOCK_RECORDS_ONLY";
    visualAppearanceDefault: "UNCONFIRMED";
    exactShaMeaning: "BYTE_IDENTICAL_COMPLETE_FILES_ONLY";
    crossProjectAuthorityInheritance: "FORBIDDEN";
    authorityPromotionPerformed: false;
  };
  summary: {
    catalogProjects: number;
    projectsWithProgress: number;
    projectsMissingProgress: number;
    projectsInvalidProgress: number;
    materializationFailures: number;
    approvedLocks: number;
    candidateLocks: number;
    approvedImageLocks: number;
    candidateImageLocks: number;
    nonImageLockEvidenceRecords: number;
    imageLocksWithExplicitReferences: number;
    imageExplicitReferences: number;
    locksWithExplicitReferences: number;
    explicitReferences: number;
    locksWithKnownSha256: number;
    exactShaDuplicateGroups: number;
    crossProjectExactShaDuplicateGroups: number;
    visuallyConfirmedOccurrences: 0;
    inheritedAuthorities: 0;
  };
  bySourceRole: Partial<Record<SourceRole, {
    approvedLocks: number;
    candidateLocks: number;
    explicitReferences: number;
  }>>;
  projects: ProjectReport[];
  exactShaGroups: Array<{
    sha256: string;
    occurrenceCount: number;
    projectCount: number;
    sourceRoles: SourceRole[];
    statuses: LockStatus[];
    exactDuplicate: boolean;
    crossProjectDuplicate: boolean;
    meaning: "BYTE_IDENTICAL_COMPLETE_FILES_ONLY";
    visualAppearance: "UNCONFIRMED";
    crossProjectAuthorityInheritance: "FORBIDDEN";
    occurrences: Array<{
      projectKey: string;
      fileId: string;
      path: string;
      status: LockStatus;
      sourceRole: SourceRole;
      crossProjectAuthorityInherited: false;
    }>;
  }>;
  missingProgress: Array<{
    projectKey: string;
    projectRoot?: string;
    expectedProgressPath?: string;
    reason: string;
  }>;
  warnings: Array<{
    code:
      | "CONTENT_PROGRESS_MISSING"
      | "CONTENT_PROGRESS_INVALID"
      | "MATERIALIZATION_FAILED"
      | "LOCK_SHA_CONFLICT"
      | "CATALOG_MATERIALIZATION_MISMATCH";
    projectKey?: string;
    path?: string;
    message: string;
  }>;
  generatedAt: string;
  fingerprint: string;
}

const DEFAULT_CATALOG_PATH = ".planning/2026-07-25-local-story-image-project-ingestion/project-catalog.source.json";
const DEFAULT_MATERIALIZATION_PATH = ".planning/2026-07-25-local-story-image-project-ingestion/local-creative-project-materialization-report.json";
const DEFAULT_OUTPUT_PATH = ".planning/2026-07-25-local-story-image-project-ingestion/local-creative-lock-usage-report.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_ROLES = new Set<SourceRole>([
  "PRIMARY_AUTHORITY",
  "ACTIVE_PRODUCTION",
  "UPSTREAM_SCRIPT",
  "LEGACY_HISTORY",
  "EXPORT",
  "UNASSIGNED_INBOX",
  "UNKNOWN",
]);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sourceRole(value: string | undefined): SourceRole {
  return value && SOURCE_ROLES.has(value as SourceRole) ? value as SourceRole : "UNKNOWN";
}

function inferSourceRole(project: CatalogProject, filePath: string, media?: ProgressMedia): SourceRole {
  const recorded = sourceRole(media?.sourceLayerRole);
  if (recorded !== "UNKNOWN") return recorded;
  const matching = project.sources
    .filter((source) => isInside(filePath, source.root))
    .sort((left, right) => right.root.length - left.root.length);
  return sourceRole(matching[0]?.role);
}

function emptyProjectSummary(): ProjectReport["summary"] {
  return {
    approvedLocks: 0,
    candidateLocks: 0,
    approvedImageLocks: 0,
    candidateImageLocks: 0,
    nonImageLockEvidenceRecords: 0,
    imageLocksWithExplicitReferences: 0,
    imageExplicitReferences: 0,
    locksWithExplicitReferences: 0,
    explicitReferences: 0,
    locksWithKnownSha256: 0,
  };
}

function addRoleAggregate(
  aggregate: ProjectReport["bySourceRole"],
  role: SourceRole,
  status: LockStatus,
  explicitReferences: number,
): void {
  const current = aggregate[role] ?? { approvedLocks: 0, candidateLocks: 0, explicitReferences: 0 };
  if (status === "APPROVED_LOCK") current.approvedLocks += 1;
  else current.candidateLocks += 1;
  current.explicitReferences += explicitReferences;
  aggregate[role] = current;
}

async function readRequiredJson<T>(filePath: string, label: string): Promise<T> {
  const absolute = path.resolve(filePath);
  const metadata = await lstat(absolute).catch((error: unknown) => {
    throw new Error(`${label} 不存在：${absolute}`, { cause: error });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} 不是安全普通文件：${absolute}`);
  try { return JSON.parse(await readFile(absolute, "utf8")) as T; }
  catch (error) { throw new Error(`${label} JSON 无法解析：${absolute}`, { cause: error }); }
}

async function readOptionalProgress(progressPath: string): Promise<
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "available"; progress: ContentProgress }
> {
  const metadata = await lstat(progressPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return { status: "missing" };
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { status: "invalid", error: "进度不是安全普通文件。" };
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(progressPath, "utf8")); }
  catch (error) { return { status: "invalid", error: error instanceof Error ? error.message : String(error) }; }
  const progress = parsed as Partial<ContentProgress>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || progress.schemaVersion !== 1
    || progress.kind !== "local-creative-project-content-import-progress"
    || !progress.sourceProject || typeof progress.sourceProject.key !== "string"
    || !progress.mediaByFileId || typeof progress.mediaByFileId !== "object"
    || !progress.canonicalDecisionsByFileId || typeof progress.canonicalDecisionsByFileId !== "object"
    || !progress.sourceStatusCounts || typeof progress.sourceStatusCounts !== "object"
    || !Array.isArray(progress.lockReferenceIndex)) {
    return { status: "invalid", error: "进度 schema 或必要字段无效。" };
  }
  return { status: "available", progress: progress as ContentProgress };
}

function validateCatalog(value: CatalogDocument): CatalogDocument {
  if (value.schemaVersion !== 1 || !Array.isArray(value.projects)) throw new Error("catalog schemaVersion/projects 无效。");
  const keys = new Set<string>();
  for (const project of value.projects) {
    if (!project.key?.trim() || !project.name?.trim() || !Array.isArray(project.sources)) {
      throw new Error("catalog 存在缺失 key/name/sources 的项目。");
    }
    if (keys.has(project.key)) throw new Error(`catalog 项目 key 重复：${project.key}`);
    keys.add(project.key);
  }
  return value;
}

function validateMaterialization(value: MaterializationReport): MaterializationReport {
  if (value.schemaVersion !== 1
    || value.kind !== "local-creative-project-materialization-report"
    || !Array.isArray(value.results)
    || typeof value.fingerprint !== "string") {
    throw new Error("materialization report 格式无效。");
  }
  return value;
}

function assertOutputOutsideInputs(
  outputPath: string,
  catalogPath: string,
  materializationPath: string,
  catalog: CatalogDocument,
  materialization: MaterializationReport,
): void {
  const output = path.resolve(outputPath);
  if (output === path.resolve(catalogPath) || output === path.resolve(materializationPath)) {
    throw new Error("输出报告不能覆盖输入 catalog 或物化报告。");
  }
  const protectedRoots = [
    ...catalog.projects.flatMap((project) => project.sources.map((source) => source.root)),
    ...materialization.results.flatMap((result) => result.projectRoot ? [result.projectRoot] : []),
  ].map((root) => path.resolve(root));
  const matched = protectedRoots.find((root) => isInside(output, root));
  if (matched) throw new Error(`输出报告不得写入创作源或受管项目：${matched}`);
}

async function writeJsonAtomic(outputPath: string, value: unknown): Promise<void> {
  const target = path.resolve(outputPath);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function lockSha(
  lock: ProgressLock,
  progress: ContentProgress,
  warnings: LocalCreativeLockUsageReport["warnings"],
  projectKey: string,
): string | null {
  const mediaSha = progress.mediaByFileId[lock.lockFileId]?.sha256?.toLocaleLowerCase("en-US");
  const decisionSha = progress.canonicalDecisionsByFileId[lock.lockFileId]?.mediaSha256?.toLocaleLowerCase("en-US");
  const validMediaSha = mediaSha && SHA256_PATTERN.test(mediaSha) ? mediaSha : undefined;
  const validDecisionSha = decisionSha && SHA256_PATTERN.test(decisionSha) ? decisionSha : undefined;
  if (validMediaSha && validDecisionSha && validMediaSha !== validDecisionSha) {
    warnings.push({
      code: "LOCK_SHA_CONFLICT",
      projectKey,
      path: lock.lockPath,
      message: "同一锁图的媒体进度 SHA 与 canonical 决策 SHA 冲突，已从 SHA 聚合排除。",
    });
    return null;
  }
  return validMediaSha ?? validDecisionSha ?? null;
}

function buildProjectWithProgress(
  project: CatalogProject,
  materialized: MaterializationResult,
  progressPath: string,
  progress: ContentProgress,
  warnings: LocalCreativeLockUsageReport["warnings"],
): ProjectReport {
  const summary = emptyProjectSummary();
  const bySourceRole: ProjectReport["bySourceRole"] = {};
  const locks: LockOccurrence[] = [];
  const projectRoot = path.resolve(materialized.projectRoot!);
  for (const lock of [...progress.lockReferenceIndex].sort((left, right) => (
    left.lockPath.localeCompare(right.lockPath, "en") || left.lockFileId.localeCompare(right.lockFileId, "en")
  ))) {
    if (lock.status !== "APPROVED_LOCK" && lock.status !== "CANDIDATE_LOCK") continue;
    const media = progress.mediaByFileId[lock.lockFileId];
    const role = inferSourceRole(project, lock.lockPath, media);
    const explicitReferencedBy = lock.referencedBy
      .filter((reference) => reference.evidenceLevels.includes("explicit-reference"))
      .map((reference) => ({
        fileId: reference.fileId,
        path: reference.path,
        evidenceLevels: [...reference.evidenceLevels].sort(),
      }));
    const declaredReferencedBy = lock.referencedBy.map((reference) => ({
      fileId: reference.fileId,
      path: reference.path,
      evidenceLevels: [...reference.evidenceLevels].sort(),
    }));
    const sha = lockSha(lock, progress, warnings, project.key);
    const canonical = progress.canonicalDecisionsByFileId[lock.lockFileId];
    const mediaKind = media?.kind === "image" || media?.kind === "video" || media?.kind === "audio"
      ? media.kind
      : null;
    const visualLockRecord = mediaKind === "image";
    const occurrence: LockOccurrence = {
      projectKey: project.key,
      projectName: project.name,
      projectRoot,
      fileId: lock.lockFileId,
      path: lock.lockPath,
      status: lock.status,
      sourceRole: role,
      mediaKind,
      visualLockRecord,
      sha256: sha,
      explicitReferencedBy,
      declaredReferencedBy,
      ...(canonical ? {
        pendingLocalAsset: {
          ...(canonical.assetId ? { assetId: canonical.assetId } : {}),
          ...(canonical.versionId ? { versionId: canonical.versionId } : {}),
          decision: canonical.decision,
          // 即使旧/外部进度错误声称 true，本报告也不把它当作跨项目 authority。
          authorityPromoted: false,
        },
      } : {}),
      visualAppearance: {
        status: "UNCONFIRMED",
        reason: "declared-reference-is-not-pixel-level-appearance-evidence",
      },
      crossProjectAuthorityInherited: false,
    };
    locks.push(occurrence);
    if (lock.status === "APPROVED_LOCK") summary.approvedLocks += 1;
    else summary.candidateLocks += 1;
    if (visualLockRecord && lock.status === "APPROVED_LOCK") summary.approvedImageLocks += 1;
    else if (visualLockRecord) summary.candidateImageLocks += 1;
    else summary.nonImageLockEvidenceRecords += 1;
    if (explicitReferencedBy.length > 0) summary.locksWithExplicitReferences += 1;
    if (visualLockRecord && explicitReferencedBy.length > 0) summary.imageLocksWithExplicitReferences += 1;
    if (visualLockRecord) summary.imageExplicitReferences += explicitReferencedBy.length;
    summary.explicitReferences += explicitReferencedBy.length;
    if (sha) summary.locksWithKnownSha256 += 1;
    addRoleAggregate(bySourceRole, role, lock.status, explicitReferencedBy.length);
  }
  return {
    key: project.key,
    name: project.name,
    resolution: project.resolution,
    projectRoot,
    progressPath,
    progressStatus: "available",
    progressImportStatus: progress.status,
    declaredStatusCounts: { ...progress.sourceStatusCounts },
    summary,
    bySourceRole,
    locks,
  };
}

function mergeRoleAggregates(
  projects: ProjectReport[],
): LocalCreativeLockUsageReport["bySourceRole"] {
  const aggregate: LocalCreativeLockUsageReport["bySourceRole"] = {};
  for (const project of projects) {
    for (const [role, value] of Object.entries(project.bySourceRole) as Array<[SourceRole, NonNullable<ProjectReport["bySourceRole"][SourceRole]>]>) {
      const current = aggregate[role] ?? { approvedLocks: 0, candidateLocks: 0, explicitReferences: 0 };
      current.approvedLocks += value.approvedLocks;
      current.candidateLocks += value.candidateLocks;
      current.explicitReferences += value.explicitReferences;
      aggregate[role] = current;
    }
  }
  return aggregate;
}

function exactShaGroups(projects: ProjectReport[]): LocalCreativeLockUsageReport["exactShaGroups"] {
  const bySha = new Map<string, LockOccurrence[]>();
  for (const lock of projects.flatMap((project) => project.locks)) {
    if (!lock.sha256) continue;
    const entries = bySha.get(lock.sha256) ?? [];
    entries.push(lock);
    bySha.set(lock.sha256, entries);
  }
  return [...bySha.entries()]
    .map(([hash, occurrences]) => {
      const ordered = occurrences.sort((left, right) => (
        left.projectKey.localeCompare(right.projectKey, "en")
        || left.path.localeCompare(right.path, "en")
        || left.fileId.localeCompare(right.fileId, "en")
      ));
      const projectCount = new Set(ordered.map((entry) => entry.projectKey)).size;
      return {
        sha256: hash,
        occurrenceCount: ordered.length,
        projectCount,
        sourceRoles: [...new Set(ordered.map((entry) => entry.sourceRole))].sort(),
        statuses: [...new Set(ordered.map((entry) => entry.status))].sort(),
        exactDuplicate: ordered.length > 1,
        crossProjectDuplicate: projectCount > 1,
        meaning: "BYTE_IDENTICAL_COMPLETE_FILES_ONLY" as const,
        visualAppearance: "UNCONFIRMED" as const,
        crossProjectAuthorityInheritance: "FORBIDDEN" as const,
        occurrences: ordered.map((entry) => ({
          projectKey: entry.projectKey,
          fileId: entry.fileId,
          path: entry.path,
          status: entry.status,
          sourceRole: entry.sourceRole,
          crossProjectAuthorityInherited: false as const,
        })),
      };
    })
    .sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
}

export async function buildLocalCreativeLockUsageReport(
  options: LocalCreativeLockUsageReportOptions,
): Promise<LocalCreativeLockUsageReport> {
  const catalogPath = path.resolve(options.catalogPath);
  const materializationReportPath = path.resolve(options.materializationReportPath);
  const outputPath = path.resolve(options.outputPath);
  const [catalogRaw, materializationRaw] = await Promise.all([
    readRequiredJson<CatalogDocument>(catalogPath, "catalog"),
    readRequiredJson<MaterializationReport>(materializationReportPath, "materialization report"),
  ]);
  const catalog = validateCatalog(catalogRaw);
  const materialization = validateMaterialization(materializationRaw);
  assertOutputOutsideInputs(outputPath, catalogPath, materializationReportPath, catalog, materialization);
  const materializedByKey = new Map(materialization.results.map((result) => [result.key, result]));
  const warnings: LocalCreativeLockUsageReport["warnings"] = [];
  const missingProgress: LocalCreativeLockUsageReport["missingProgress"] = [];
  const projects: ProjectReport[] = [];

  for (const project of catalog.projects) {
    const materialized = materializedByKey.get(project.key);
    if (!materialized) {
      warnings.push({
        code: "CATALOG_MATERIALIZATION_MISMATCH",
        projectKey: project.key,
        message: "catalog 项目在物化报告中不存在。",
      });
      projects.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        progressStatus: "materialization-failed",
        error: "物化报告缺少项目。",
        summary: emptyProjectSummary(),
        bySourceRole: {},
        locks: [],
      });
      continue;
    }
    if (materialized.status !== "materialized" || !materialized.projectRoot) {
      const reason = materialized.error ?? "项目未成功物化。";
      warnings.push({ code: "MATERIALIZATION_FAILED", projectKey: project.key, message: reason });
      projects.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        ...(materialized.projectRoot ? { projectRoot: materialized.projectRoot } : {}),
        progressStatus: "materialization-failed",
        error: reason,
        summary: emptyProjectSummary(),
        bySourceRole: {},
        locks: [],
      });
      continue;
    }
    const projectRoot = path.resolve(materialized.projectRoot);
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const loaded = await readOptionalProgress(progressPath);
    if (loaded.status === "missing") {
      const reason = "项目尚无 content import 进度；无法恢复完整锁图路径、SHA 与 referencedBy。";
      warnings.push({ code: "CONTENT_PROGRESS_MISSING", projectKey: project.key, path: progressPath, message: reason });
      missingProgress.push({ projectKey: project.key, projectRoot, expectedProgressPath: progressPath, reason });
      projects.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        projectRoot,
        progressPath,
        progressStatus: "missing",
        summary: emptyProjectSummary(),
        bySourceRole: {},
        locks: [],
      });
      continue;
    }
    if (loaded.status === "invalid") {
      warnings.push({
        code: "CONTENT_PROGRESS_INVALID",
        projectKey: project.key,
        path: progressPath,
        message: loaded.error,
      });
      missingProgress.push({
        projectKey: project.key,
        projectRoot,
        expectedProgressPath: progressPath,
        reason: `进度无效：${loaded.error}`,
      });
      projects.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        projectRoot,
        progressPath,
        progressStatus: "invalid",
        error: loaded.error,
        summary: emptyProjectSummary(),
        bySourceRole: {},
        locks: [],
      });
      continue;
    }
    if (loaded.progress.sourceProject.key !== project.key
      || path.resolve(loaded.progress.projectRoot) !== projectRoot) {
      const error = "content progress 的项目 key/root 与 catalog/物化报告不一致。";
      warnings.push({ code: "CONTENT_PROGRESS_INVALID", projectKey: project.key, path: progressPath, message: error });
      missingProgress.push({ projectKey: project.key, projectRoot, expectedProgressPath: progressPath, reason: error });
      projects.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        projectRoot,
        progressPath,
        progressStatus: "invalid",
        error,
        summary: emptyProjectSummary(),
        bySourceRole: {},
        locks: [],
      });
      continue;
    }
    projects.push(buildProjectWithProgress(project, materialized, progressPath, loaded.progress, warnings));
  }
  for (const materialized of materialization.results) {
    if (catalog.projects.some((project) => project.key === materialized.key)) continue;
    warnings.push({
      code: "CATALOG_MATERIALIZATION_MISMATCH",
      projectKey: materialized.key,
      message: "物化报告项目在 catalog 中不存在；未纳入聚合。",
    });
  }

  const shaGroups = exactShaGroups(projects);
  const allLocks = projects.flatMap((project) => project.locks);
  const summary: LocalCreativeLockUsageReport["summary"] = {
    catalogProjects: catalog.projects.length,
    projectsWithProgress: projects.filter((project) => project.progressStatus === "available").length,
    projectsMissingProgress: projects.filter((project) => project.progressStatus === "missing").length,
    projectsInvalidProgress: projects.filter((project) => project.progressStatus === "invalid").length,
    materializationFailures: projects.filter((project) => project.progressStatus === "materialization-failed").length,
    approvedLocks: allLocks.filter((lock) => lock.status === "APPROVED_LOCK").length,
    candidateLocks: allLocks.filter((lock) => lock.status === "CANDIDATE_LOCK").length,
    approvedImageLocks: allLocks.filter((lock) => lock.visualLockRecord && lock.status === "APPROVED_LOCK").length,
    candidateImageLocks: allLocks.filter((lock) => lock.visualLockRecord && lock.status === "CANDIDATE_LOCK").length,
    nonImageLockEvidenceRecords: allLocks.filter((lock) => !lock.visualLockRecord).length,
    imageLocksWithExplicitReferences: allLocks.filter((lock) => lock.visualLockRecord && lock.explicitReferencedBy.length > 0).length,
    imageExplicitReferences: allLocks
      .filter((lock) => lock.visualLockRecord)
      .reduce((sum, lock) => sum + lock.explicitReferencedBy.length, 0),
    locksWithExplicitReferences: allLocks.filter((lock) => lock.explicitReferencedBy.length > 0).length,
    explicitReferences: allLocks.reduce((sum, lock) => sum + lock.explicitReferencedBy.length, 0),
    locksWithKnownSha256: allLocks.filter((lock) => Boolean(lock.sha256)).length,
    exactShaDuplicateGroups: shaGroups.filter((group) => group.exactDuplicate).length,
    crossProjectExactShaDuplicateGroups: shaGroups.filter((group) => group.crossProjectDuplicate).length,
    visuallyConfirmedOccurrences: 0,
    inheritedAuthorities: 0,
  };
  const semantic = {
    schemaVersion: 1 as const,
    kind: "local-creative-lock-usage-report" as const,
    inputs: {
      catalogPath,
      materializationReportPath,
      materializationFingerprint: materialization.fingerprint,
    },
    outputPath,
    readOnlyInputs: true as const,
    evidencePolicy: {
      declaredReferenceMeaning: "TEXT_OR_MANIFEST_REFERENCE_ONLY" as const,
      lockRecordMeaning: "SOURCE_STATUS_RECORDS_MAY_INCLUDE_NON_IMAGE_EVIDENCE" as const,
      visualLockMetricMeaning: "IMPORTED_RASTER_IMAGE_LOCK_RECORDS_ONLY" as const,
      visualAppearanceDefault: "UNCONFIRMED" as const,
      exactShaMeaning: "BYTE_IDENTICAL_COMPLETE_FILES_ONLY" as const,
      crossProjectAuthorityInheritance: "FORBIDDEN" as const,
      authorityPromotionPerformed: false as const,
    },
    summary,
    bySourceRole: mergeRoleAggregates(projects),
    projects,
    exactShaGroups: shaGroups,
    missingProgress,
    warnings: warnings.sort((left, right) => (
      left.code.localeCompare(right.code, "en")
      || (left.projectKey ?? "").localeCompare(right.projectKey ?? "", "en")
      || (left.path ?? "").localeCompare(right.path ?? "", "en")
    )),
  };
  const report: LocalCreativeLockUsageReport = {
    ...semantic,
    generatedAt: new Date().toISOString(),
    fingerprint: sha256(stableStringify(semantic)),
  };
  await writeJsonAtomic(outputPath, report);
  return report;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数。`);
  return value;
}

export function parseLocalCreativeLockUsageReportArgs(
  argv: string[],
  cwd = process.cwd(),
): LocalCreativeLockUsageReportCliOptions {
  let catalogPath = path.resolve(cwd, DEFAULT_CATALOG_PATH);
  let materializationReportPath = path.resolve(cwd, DEFAULT_MATERIALIZATION_PATH);
  let outputPath = path.resolve(cwd, DEFAULT_OUTPUT_PATH);
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--catalog" || argument === "--materialization-report" || argument === "--output") {
      const value = valueAfter(argv, index, argument);
      index += 1;
      if (argument === "--catalog") catalogPath = path.resolve(cwd, value);
      else if (argument === "--materialization-report") materializationReportPath = path.resolve(cwd, value);
      else outputPath = path.resolve(cwd, value);
      continue;
    }
    const equals = argument.match(/^--(catalog|materialization-report|output)=(.+)$/u);
    if (equals) {
      const [, option, value] = equals;
      if (option === "catalog") catalogPath = path.resolve(cwd, value!);
      else if (option === "materialization-report") materializationReportPath = path.resolve(cwd, value!);
      else outputPath = path.resolve(cwd, value!);
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return { catalogPath, materializationReportPath, outputPath, help };
}

function usage(): string {
  return [
    "用法：npx tsx scripts/build-local-creative-lock-usage-report.ts [选项]",
    "",
    "选项：",
    "  --catalog <path>                本机创作项目 catalog",
    "  --materialization-report <path> 项目物化报告",
    "  --output <path>                 原子 JSON 输出（禁止位于项目或创作源内）",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseLocalCreativeLockUsageReportArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await buildLocalCreativeLockUsageReport(options);
  process.stdout.write(`${JSON.stringify({
    outputPath: report.outputPath,
    fingerprint: report.fingerprint,
    summary: report.summary,
  }, null, 2)}\n`);
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryUrl === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`FATAL\t${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
