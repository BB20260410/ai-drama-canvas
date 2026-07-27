import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  importLocalCreativeProjectContent,
  type LocalCreativeAuthorityPolicy,
  type LocalCreativeProjectContentImportProgress,
} from "../src/core/local-creative-project-content-import.js";
import {
  inspectLocalCreativeProject,
  LOCAL_CREATIVE_SOURCE_LAYER_ROLES,
  type LocalCreativeProjectIngestPreview,
  type LocalCreativeSourceLayerInput,
} from "../src/core/local-creative-project-ingest.js";
import { writeJsonAtomic } from "../src/core/sidecar.js";

type CatalogResolution = "REUSE_READONLY" | "CREATE_MANAGED" | "CREATE_INBOX";
type ProjectRunStatus =
  | "pending"
  | "scanning"
  | "importing"
  | "completed"
  | "completed-with-failures"
  | "failed"
  | "skipped-readonly";

interface CatalogSource {
  root: string;
  role: string;
  label?: string;
  maxDepth?: number;
  excludeRelativePrefixes?: string[];
}

interface CatalogProject {
  key: string;
  name: string;
  projectType: string;
  resolution: CatalogResolution;
  managedProjectRoot?: string;
  authorityPolicy?: string;
  sources: CatalogSource[];
}

interface CatalogDocument {
  schemaVersion: 1;
  projects: CatalogProject[];
}

interface MaterializationResult {
  key: string;
  name: string;
  status: "materialized" | "failed";
  resolution: CatalogResolution;
  disposition?: string;
  projectId?: string;
  projectRoot?: string;
  ingestManifestPath?: string | null;
  error?: string;
}

interface MaterializationReport {
  schemaVersion: 1;
  kind: "local-creative-project-materialization-report";
  fingerprint: string;
  summary: {
    activePointerUnchanged: boolean;
  };
  results: MaterializationResult[];
}

interface ActivePointerSnapshot {
  exists: boolean;
  sizeBytes: number;
  sha256?: string;
}

interface CatalogContentImportProjectResult {
  key: string;
  name: string;
  resolution: CatalogResolution;
  status: ProjectRunStatus;
  projectRoot?: string;
  authorityPolicy?: LocalCreativeAuthorityPolicy;
  previewFingerprint?: string;
  inventory?: {
    files: number;
    bytes: number;
    documents: number;
    images: number;
    videos: number;
    audio: number;
    approvedLocks: number;
    candidateLocks: number;
    rejected: number;
    warnings: number;
  };
  progressPath?: string;
  importSummary?: LocalCreativeProjectContentImportProgress["runSummary"];
  failures?: LocalCreativeProjectContentImportProgress["failures"];
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LocalCreativeContentCatalogImportReport {
  schemaVersion: 1;
  kind: "local-creative-project-content-import-report";
  status: "in-progress" | "completed" | "completed-with-failures" | "aborted";
  catalogPath: string;
  materializationReportPath: string;
  materializationReportFingerprint: string;
  outputPath: string;
  selection: {
    requestedProjectKeys: string[];
    failFast: boolean;
    documentLimit?: number;
  };
  activePointer: {
    path: string;
    before: ActivePointerSnapshot;
    after?: ActivePointerSnapshot;
    unchanged?: boolean;
  };
  summary: {
    selected: number;
    completed: number;
    completedWithFailures: number;
    failed: number;
    skippedReadonly: number;
    pending: number;
    documentsImported: number;
    mediaImported: number;
    mediaReconciled: number;
    mediaSkippedRecorded: number;
    mediaFailed: number;
    pendingAssetsCreated: number;
    authorityPromotions: 0;
  };
  projects: CatalogContentImportProjectResult[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  abortReason?: string;
  fingerprint: string;
}

export interface RunLocalCreativeContentCatalogOptions {
  catalogPath: string;
  materializationReportPath: string;
  outputPath: string;
  projectKeys?: string[];
  failFast?: boolean;
  documentLimit?: number;
  registryPath?: string;
  progressIntervalMs?: number;
  onProgress?: (message: string) => void;
}

export interface LocalCreativeContentCatalogCliOptions extends RunLocalCreativeContentCatalogOptions {
  help: boolean;
}

const DEFAULT_CATALOG_PATH = ".planning/2026-07-25-local-story-image-project-ingestion/project-catalog.source.json";
const DEFAULT_MATERIALIZATION_REPORT_PATH = ".planning/2026-07-25-local-story-image-project-ingestion/local-creative-project-materialization-report.json";
const DEFAULT_OUTPUT_PATH = ".planning/2026-07-25-local-story-image-project-ingestion/local-creative-project-content-import-report.json";
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeProjectKey(value: string): string {
  const key = value.normalize("NFC").trim();
  if (!/^[a-z][a-z0-9-]{1,79}$/u.test(key)) throw new Error(`--project key 无效：${value}`);
  return key;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数。`);
  return value;
}

export function parseLocalCreativeContentCatalogArgs(
  argv: string[],
  cwd = process.cwd(),
): LocalCreativeContentCatalogCliOptions {
  let catalogPath = path.resolve(cwd, DEFAULT_CATALOG_PATH);
  let materializationReportPath = path.resolve(cwd, DEFAULT_MATERIALIZATION_REPORT_PATH);
  let outputPath = path.resolve(cwd, DEFAULT_OUTPUT_PATH);
  let failFast = false;
  let documentLimit: number | undefined;
  let help = false;
  const projectKeys: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--fail-fast") {
      failFast = true;
      continue;
    }
    if (argument === "--continue-on-error") {
      failFast = false;
      continue;
    }
    if (argument === "--catalog" || argument === "--materialization-report"
      || argument === "--output" || argument === "--project" || argument === "--document-limit") {
      const value = valueAfter(argv, index, argument);
      index += 1;
      if (argument === "--catalog") catalogPath = path.resolve(cwd, value);
      else if (argument === "--materialization-report") materializationReportPath = path.resolve(cwd, value);
      else if (argument === "--output") outputPath = path.resolve(cwd, value);
      else if (argument === "--project") projectKeys.push(normalizeProjectKey(value));
      else {
        documentLimit = Number(value);
        if (!Number.isInteger(documentLimit) || documentLimit < 0 || documentLimit > 5_000) {
          throw new Error("--document-limit 必须是 0–5000 的整数。");
        }
      }
      continue;
    }
    const equals = argument.match(/^--(catalog|materialization-report|output|project|document-limit)=(.+)$/u);
    if (equals) {
      const [, option, value] = equals;
      if (option === "catalog") catalogPath = path.resolve(cwd, value!);
      else if (option === "materialization-report") materializationReportPath = path.resolve(cwd, value!);
      else if (option === "output") outputPath = path.resolve(cwd, value!);
      else if (option === "project") projectKeys.push(normalizeProjectKey(value!));
      else {
        documentLimit = Number(value);
        if (!Number.isInteger(documentLimit) || documentLimit < 0 || documentLimit > 5_000) {
          throw new Error("--document-limit 必须是 0–5000 的整数。");
        }
      }
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }

  return {
    catalogPath,
    materializationReportPath,
    outputPath,
    projectKeys: [...new Set(projectKeys)],
    failFast,
    ...(documentLimit === undefined ? {} : { documentLimit }),
    help,
  };
}

function validateCatalog(value: unknown): CatalogDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目目录不是 JSON 对象。");
  const input = value as Partial<CatalogDocument>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.projects)) throw new Error("项目目录 schemaVersion/projects 无效。");
  const seen = new Set<string>();
  for (const project of input.projects) {
    if (!project || typeof project !== "object"
      || !project.key?.trim() || !project.name?.trim() || !project.projectType?.trim()) {
      throw new Error("项目目录存在缺失 key/name/projectType 的项目。");
    }
    if (seen.has(project.key)) throw new Error(`项目 key 重复：${project.key}`);
    seen.add(project.key);
    if (!["REUSE_READONLY", "CREATE_MANAGED", "CREATE_INBOX"].includes(project.resolution)) {
      throw new Error(`项目 ${project.key} 的 resolution 无效。`);
    }
    if (!Array.isArray(project.sources) || project.sources.length === 0) throw new Error(`项目 ${project.key} 没有 source。`);
    for (const source of project.sources) {
      if (!source?.root?.trim() || !LOCAL_CREATIVE_SOURCE_LAYER_ROLES.includes(source.role as never)) {
        throw new Error(`项目 ${project.key} 的 source root/role 无效。`);
      }
    }
  }
  return input as CatalogDocument;
}

function validateMaterializationReport(value: unknown): MaterializationReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("物化报告不是 JSON 对象。");
  const input = value as Partial<MaterializationReport>;
  if (input.schemaVersion !== 1
    || input.kind !== "local-creative-project-materialization-report"
    || typeof input.fingerprint !== "string" || !SHA256_PATTERN.test(input.fingerprint)
    || !input.summary || input.summary.activePointerUnchanged !== true
    || !Array.isArray(input.results)) {
    throw new Error("物化报告结构无效，或其活动项目指针校验未通过。");
  }
  const seen = new Set<string>();
  for (const result of input.results) {
    if (!result?.key || seen.has(result.key)) throw new Error(`物化报告项目 key 缺失或重复：${result?.key ?? "unknown"}`);
    seen.add(result.key);
  }
  return input as MaterializationReport;
}

async function readJsonFile<T>(filePath: string, validator: (value: unknown) => T): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON：${filePath}`, { cause: error });
  }
  return validator(value);
}

function activePointerPath(registryPath?: string): string {
  const registry = registryPath
    ? path.resolve(registryPath)
    : process.env.AI_CANVAS_REGISTRY_PATH
      ? path.resolve(process.env.AI_CANVAS_REGISTRY_PATH)
      : path.join(os.homedir(), ".aicanvas", "projects.json");
  return path.join(path.dirname(registry), "active-project.json");
}

async function snapshotActivePointer(filePath: string): Promise<ActivePointerSnapshot> {
  const metadata = await lstat(filePath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return { exists: false, sizeBytes: 0 };
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`活动项目指针不是安全普通文件：${filePath}`);
  const bytes = await readFile(filePath);
  return { exists: true, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sameActivePointer(left: ActivePointerSnapshot, right: ActivePointerSnapshot): boolean {
  return left.exists === right.exists
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256;
}

function resolveAuthorityPolicy(project: CatalogProject): LocalCreativeAuthorityPolicy {
  if (project.resolution === "CREATE_INBOX") {
    if (project.authorityPolicy && project.authorityPolicy !== "FORBID_ALL") {
      throw new Error(`CREATE_INBOX ${project.key} 的 authorityPolicy 必须是 FORBID_ALL。`);
    }
    return "FORBID_ALL";
  }
  if (!project.authorityPolicy || project.authorityPolicy === "EVIDENCE_REQUIRED"
    || project.authorityPolicy === "CREATE_PENDING_FROM_APPROVED_LOCKS") {
    return "CREATE_PENDING_FROM_APPROVED_LOCKS";
  }
  if (project.authorityPolicy === "FORBID_ALL") return "FORBID_ALL";
  throw new Error(`项目 ${project.key} 的 authorityPolicy 不受内容导入器支持：${project.authorityPolicy}`);
}

function sourceLayersFor(project: CatalogProject): LocalCreativeSourceLayerInput[] {
  return project.sources.map((source) => ({
    role: source.role as LocalCreativeSourceLayerInput["role"],
    rootPath: source.root,
    ...(source.label ? { label: source.label } : {}),
    ...(source.maxDepth === undefined ? {} : { maxDepth: source.maxDepth }),
    ...(source.excludeRelativePrefixes ? { excludeRelativePrefixes: source.excludeRelativePrefixes } : {}),
  }));
}

function inventorySummary(preview: LocalCreativeProjectIngestPreview): NonNullable<CatalogContentImportProjectResult["inventory"]> {
  return {
    files: preview.statistics.totalFiles,
    bytes: preview.statistics.totalBytes,
    documents: preview.statistics.byMediaKind.document,
    images: preview.statistics.byMediaKind.image,
    videos: preview.statistics.byMediaKind.video,
    audio: preview.statistics.byMediaKind.audio,
    approvedLocks: preview.statistics.byStatus.APPROVED_LOCK,
    candidateLocks: preview.statistics.byStatus.CANDIDATE_LOCK,
    rejected: preview.statistics.byStatus.REJECTED_OR_FORBIDDEN,
    warnings: preview.warnings.length,
  };
}

function emptySummary(): LocalCreativeContentCatalogImportReport["summary"] {
  return {
    selected: 0,
    completed: 0,
    completedWithFailures: 0,
    failed: 0,
    skippedReadonly: 0,
    pending: 0,
    documentsImported: 0,
    mediaImported: 0,
    mediaReconciled: 0,
    mediaSkippedRecorded: 0,
    mediaFailed: 0,
    pendingAssetsCreated: 0,
    authorityPromotions: 0,
  };
}

function summarize(results: CatalogContentImportProjectResult[]): LocalCreativeContentCatalogImportReport["summary"] {
  const summary = emptySummary();
  summary.selected = results.length;
  for (const result of results) {
    if (result.status === "completed") summary.completed += 1;
    else if (result.status === "completed-with-failures") summary.completedWithFailures += 1;
    else if (result.status === "failed") summary.failed += 1;
    else if (result.status === "skipped-readonly") summary.skippedReadonly += 1;
    else summary.pending += 1;
    if (!result.importSummary) continue;
    summary.documentsImported += result.importSummary.documentsImported;
    summary.mediaImported += result.importSummary.mediaImported;
    summary.mediaReconciled += result.importSummary.mediaReconciled;
    summary.mediaSkippedRecorded += result.importSummary.mediaSkippedRecorded;
    summary.mediaFailed += result.importSummary.mediaFailed;
    summary.pendingAssetsCreated += result.importSummary.pendingAssetsCreated;
  }
  return summary;
}

function reportSemantic(
  report: Omit<LocalCreativeContentCatalogImportReport, "fingerprint">,
): Omit<LocalCreativeContentCatalogImportReport, "fingerprint"> {
  return report;
}

async function persistReport(
  report: LocalCreativeContentCatalogImportReport,
): Promise<LocalCreativeContentCatalogImportReport> {
  report.updatedAt = new Date().toISOString();
  report.summary = summarize(report.projects);
  const { fingerprint: _ignored, ...semantic } = report;
  report.fingerprint = sha256(stableStringify(reportSemantic(semantic)));
  await writeJsonAtomic(report.outputPath, report);
  return report;
}

function newestMediaLabel(progress: LocalCreativeProjectContentImportProgress, runStartedAt: string): string {
  const entries = Object.values(progress.mediaByFileId)
    .filter((entry) => entry.updatedAt >= runStartedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return entries[0] ? path.basename(entries[0].sourcePath) : "等待首个媒体";
}

async function readProgress(
  progressPath: string,
): Promise<LocalCreativeProjectContentImportProgress | null> {
  return readFile(progressPath, "utf8")
    .then((content) => JSON.parse(content) as LocalCreativeProjectContentImportProgress)
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    });
}

async function startFileProgressMonitor(input: {
  projectKey: string;
  projectOrdinal: string;
  progressPath: string;
  runStartedAt: string;
  intervalMs: number;
  emit: (message: string) => void;
}): Promise<() => Promise<void>> {
  let stopped = false;
  let polling = false;
  let reportedProcessed = -1;
  let lastMessageAt = 0;
  let pendingPoll: Promise<void> | null = null;

  const poll = async (final = false): Promise<void> => {
    if (polling && !final) return;
    polling = true;
    try {
      const progress = await readProgress(input.progressPath);
      if (!progress) return;
      const summary = progress.runSummary;
      const processed = summary.mediaImported + summary.mediaReconciled
        + summary.mediaSkippedRecorded + summary.mediaFailed;
      const now = Date.now();
      if (processed !== reportedProcessed || final || now - lastMessageAt >= HEARTBEAT_INTERVAL_MS) {
        const label = newestMediaLabel(progress, input.runStartedAt);
        input.emit(
          `[${input.projectOrdinal}] ${input.projectKey} FILE ${processed}/${summary.mediaEligible} ${label}`
          + ` (imported=${summary.mediaImported}, reconciled=${summary.mediaReconciled}, skipped=${summary.mediaSkippedRecorded}, failed=${summary.mediaFailed})`,
        );
        reportedProcessed = processed;
        lastMessageAt = now;
      }
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => {
    if (stopped || pendingPoll) return;
    pendingPoll = poll().finally(() => { pendingPoll = null; });
  }, input.intervalMs);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await pendingPoll;
    await poll(true);
  };
}

function materializationByKey(report: MaterializationReport): Map<string, MaterializationResult> {
  return new Map(report.results.map((result) => [result.key, result]));
}

function assertMaterializedTarget(
  project: CatalogProject,
  materialized: MaterializationResult | undefined,
): string {
  if (!materialized) throw new Error(`物化报告缺少项目：${project.key}`);
  if (materialized.status !== "materialized") {
    throw new Error(`项目 ${project.key} 尚未成功物化：${materialized.error ?? "unknown"}`);
  }
  if (materialized.resolution !== project.resolution) throw new Error(`项目 ${project.key} 的 catalog/物化 resolution 不一致。`);
  if (!materialized.projectRoot) throw new Error(`项目 ${project.key} 的物化报告缺少 projectRoot。`);
  return path.resolve(materialized.projectRoot);
}

function reportStatus(
  report: LocalCreativeContentCatalogImportReport,
  aborted: boolean,
): LocalCreativeContentCatalogImportReport["status"] {
  if (aborted) return "aborted";
  if (report.projects.some((project) => project.status === "failed" || project.status === "completed-with-failures")) {
    return "completed-with-failures";
  }
  return "completed";
}

export async function runLocalCreativeContentCatalogImport(
  options: RunLocalCreativeContentCatalogOptions,
): Promise<LocalCreativeContentCatalogImportReport> {
  const catalogPath = path.resolve(options.catalogPath);
  const materializationReportPath = path.resolve(options.materializationReportPath);
  const outputPath = path.resolve(options.outputPath);
  const emit = options.onProgress ?? ((message: string) => process.stderr.write(`${message}\n`));
  const intervalMs = Math.max(100, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const [catalog, materialization] = await Promise.all([
    readJsonFile(catalogPath, validateCatalog),
    readJsonFile(materializationReportPath, validateMaterializationReport),
  ]);
  const catalogKeys = new Set(catalog.projects.map((project) => project.key));
  const requestedKeys = [...new Set((options.projectKeys ?? []).map(normalizeProjectKey))];
  const unknownKeys = requestedKeys.filter((key) => !catalogKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`--project 不在 catalog：${unknownKeys.join(", ")}`);
  const selected = requestedKeys.length === 0
    ? catalog.projects
    : catalog.projects.filter((project) => requestedKeys.includes(project.key));
  const materializedByKey = materializationByKey(materialization);
  const pointerPath = activePointerPath(options.registryPath);
  const activeBefore = await snapshotActivePointer(pointerPath);
  const startedAt = new Date().toISOString();
  const report: LocalCreativeContentCatalogImportReport = {
    schemaVersion: 1,
    kind: "local-creative-project-content-import-report",
    status: "in-progress",
    catalogPath,
    materializationReportPath,
    materializationReportFingerprint: materialization.fingerprint,
    outputPath,
    selection: {
      requestedProjectKeys: requestedKeys,
      failFast: options.failFast ?? false,
      ...(options.documentLimit === undefined ? {} : { documentLimit: options.documentLimit }),
    },
    activePointer: { path: pointerPath, before: activeBefore },
    summary: emptySummary(),
    projects: selected.map((project) => ({
      key: project.key,
      name: project.name,
      resolution: project.resolution,
      status: project.resolution === "REUSE_READONLY" ? "skipped-readonly" : "pending",
    })),
    startedAt,
    updatedAt: startedAt,
    fingerprint: "",
  };
  await persistReport(report);

  let aborted = false;
  for (let index = 0; index < selected.length; index += 1) {
    const project = selected[index]!;
    const result = report.projects[index]!;
    const ordinal = `${index + 1}/${selected.length}`;
    if (project.resolution === "REUSE_READONLY") {
      emit(`[${ordinal}] ${project.key} SKIP REUSE_READONLY`);
      await persistReport(report);
      continue;
    }

    let stopMonitor: (() => Promise<void>) | null = null;
    try {
      result.startedAt = new Date().toISOString();
      result.status = "scanning";
      emit(`[${ordinal}] ${project.key} SCAN_START`);
      await persistReport(report);

      const projectRoot = assertMaterializedTarget(project, materializedByKey.get(project.key));
      const authorityPolicy = resolveAuthorityPolicy(project);
      const preview = await inspectLocalCreativeProject({
        projectKey: project.key,
        projectName: project.name,
        projectType: project.projectType,
        sourceLayers: sourceLayersFor(project),
        computeSha256: false,
      });
      result.projectRoot = projectRoot;
      result.authorityPolicy = authorityPolicy;
      result.previewFingerprint = preview.previewFingerprint;
      result.inventory = inventorySummary(preview);
      result.progressPath = path.join(projectRoot, ".aicanvas/local-creative-project-content-import.json");
      result.status = "importing";
      emit(`[${ordinal}] ${project.key} SCAN_DONE files=${result.inventory.files} bytes=${result.inventory.bytes}`);
      await persistReport(report);

      stopMonitor = await startFileProgressMonitor({
        projectKey: project.key,
        projectOrdinal: ordinal,
        progressPath: result.progressPath,
        runStartedAt: result.startedAt,
        intervalMs,
        emit,
      });
      const progress = await importLocalCreativeProjectContent({
        projectRoot,
        preview,
        authorityPolicy,
        ...(options.documentLimit === undefined ? {} : { documentLimit: options.documentLimit }),
      });
      await stopMonitor();
      stopMonitor = null;
      if (progress.status === "in-progress") {
        throw new Error("内容导入器返回非终态 in-progress，已停止将其记为完成。");
      }
      result.status = progress.status;
      result.importSummary = { ...progress.runSummary };
      result.failures = progress.failures.map((failure) => ({ ...failure }));
      result.completedAt = new Date().toISOString();
      emit(
        `[${ordinal}] ${project.key} ${progress.status.toUpperCase()}`
        + ` media=${progress.runSummary.mediaImported}/${progress.runSummary.mediaEligible}`
        + ` docs=${progress.runSummary.documentsImported}/${progress.runSummary.documentsSelected}`,
      );
    } catch (error) {
      await stopMonitor?.().catch(() => undefined);
      result.status = "failed";
      result.error = errorMessage(error);
      result.completedAt = new Date().toISOString();
      emit(`[${ordinal}] ${project.key} FAILED ${result.error}`);
      if (options.failFast) {
        aborted = true;
        report.abortReason = `fail-fast: ${project.key}: ${result.error}`;
      }
    }

    const activeNow = await snapshotActivePointer(pointerPath);
    if (!sameActivePointer(activeBefore, activeNow)) {
      report.activePointer.after = activeNow;
      report.activePointer.unchanged = false;
      report.abortReason = `活动项目指针在 ${project.key} 内容导入期间发生变化，已安全停止。`;
      emit(`[${ordinal}] ${project.key} ABORT ACTIVE_POINTER_CHANGED`);
      aborted = true;
    }
    await persistReport(report);
    if (aborted) break;
  }

  const activeAfter = await snapshotActivePointer(pointerPath);
  report.activePointer.after = activeAfter;
  report.activePointer.unchanged = sameActivePointer(activeBefore, activeAfter);
  if (!report.activePointer.unchanged) {
    aborted = true;
    report.abortReason ??= "活动项目指针前后哈希不一致。";
  }
  report.status = reportStatus(report, aborted);
  report.completedAt = new Date().toISOString();
  await persistReport(report);
  emit(
    `CATALOG ${report.status.toUpperCase()} completed=${report.summary.completed}`
    + ` partial=${report.summary.completedWithFailures} failed=${report.summary.failed}`
    + ` skipped=${report.summary.skippedReadonly} activeUnchanged=${String(report.activePointer.unchanged)}`,
  );
  return report;
}

function usage(): string {
  return [
    "用法：npx tsx scripts/import-local-creative-project-content-catalog.ts [选项]",
    "",
    "选项：",
    "  --project <key>                 只导入指定项目；可重复",
    "  --catalog <path>                项目 catalog JSON",
    "  --materialization-report <path> 物化报告 JSON",
    "  --output <path>                 原子全局进度/结果报告",
    "  --document-limit <0-5000>       每项目最多导入的文档数",
    "  --fail-fast                     首个项目失败后清晰终止",
    "  --continue-on-error             失败后继续后续项目（默认）",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseLocalCreativeContentCatalogArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await runLocalCreativeContentCatalogImport(options);
  process.stdout.write(`${JSON.stringify({
    outputPath: report.outputPath,
    status: report.status,
    summary: report.summary,
    activePointerUnchanged: report.activePointer.unchanged,
    fingerprint: report.fingerprint,
  }, null, 2)}\n`);
  if (report.status !== "completed") process.exitCode = 2;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryUrl === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`FATAL\t${errorMessage(error)}\n`);
    process.exitCode = 2;
  });
}
