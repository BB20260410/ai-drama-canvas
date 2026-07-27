import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { ProjectCache } from "./cache.js";
import { createDefaultProjectConfig } from "./constants.js";
import { scanProject } from "./scanner.js";
import {
  appendEvent,
  ensureSidecar,
  getSidecarPaths,
  listRegisteredProjects,
  loadProjectConfig,
  registerProject,
  saveIndex,
  unregisterProject,
  writeJsonAtomic,
} from "./sidecar.js";
import type {
  ImportRootReport,
  ProjectConfig,
  ProjectImportIssue,
  ProjectImportOptions,
  ProjectImportMode,
  ProjectImportPreview,
  ProjectIndex,
} from "./types.js";

const DISCOVERY_PATTERNS = ["**/*.{md,txt,json,png,jpg,jpeg,webp,mp4,mov,webm,m4v}"];
const DISCOVERY_IGNORE = ["**/.aicanvas/**", "**/.git/**", "**/__pycache__/**", "**/node_modules/**"];

function uniqueRoots(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value)))];
}

function isInside(candidate: string, root: string): boolean {
  const absolute = path.resolve(candidate);
  return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function permissions(root: string): Promise<{ exists: boolean; readable: boolean; writable: boolean }> {
  try {
    const value = await stat(root);
    if (!value.isDirectory()) return { exists: true, readable: false, writable: false };
    const readable = await access(root, fsConstants.R_OK).then(() => true).catch(() => false);
    const writable = await access(root, fsConstants.W_OK).then(() => true).catch(() => false);
    return { exists: true, readable, writable };
  } catch {
    return { exists: false, readable: false, writable: false };
  }
}

async function rootReport(root: string, role: ImportRootReport["role"], index: ProjectIndex): Promise<ImportRootReport> {
  const state = await permissions(root);
  const discoveredFiles = state.readable
    ? (await fg(DISCOVERY_PATTERNS, { cwd: root, onlyFiles: true, unique: true, followSymbolicLinks: false, suppressErrors: true, ignore: DISCOVERY_IGNORE })).length
    : 0;
  const recognizedArtifacts = index.artifacts.filter((artifact) => isInside(artifact.path, root)).length;
  return { root, role, ...state, discoveredFiles, recognizedArtifacts };
}

function normalizeConfig(options: ProjectImportOptions, existing?: ProjectConfig): ProjectConfig {
  const primaryRoot = path.resolve(options.primaryRoot);
  const base = existing ?? createDefaultProjectConfig(primaryRoot);
  const sourceRoots = uniqueRoots(options.sourceRoots ?? base.sourceRoots).filter((root) => root !== primaryRoot);
  const outputRoots = uniqueRoots([primaryRoot, ...(options.outputRoots ?? base.outputRoots)]);
  const ignoreSegments = [...new Set((options.ignoreSegments ?? base.ignoreSegments).map((value) => value.trim()).filter(Boolean))];
  const requestedRules = options.namingRules ?? base.namingRules ?? { patterns: [], manualMappings: [] };
  const patterns = requestedRules.patterns.map((rule, index) => {
    const pattern = rule.pattern.trim();
    try { new RegExp(pattern, "i"); } catch { throw new Error(`自定义命名规则 ${rule.id || index + 1} 不是有效正则表达式。`); }
    if (!pattern) throw new Error("自定义命名规则不能为空。 ");
    return { id: rule.id.trim() || `rule-${index + 1}`, type: rule.type, pattern, scope: rule.scope?.trim() || undefined };
  }).slice(0, 50);
  const manualMappings = requestedRules.manualMappings.map((mapping) => ({ ...mapping, pathPrefix: mapping.pathPrefix.normalize("NFKC").replaceAll("\\", "/").replace(/^\/+/, "").trim(), shot: mapping.shot?.trim(), title: mapping.title?.trim(), scope: mapping.scope?.trim() || undefined })).filter((mapping) => mapping.pathPrefix).slice(0, 2_000);
  for (const mapping of manualMappings) {
    if (!Number.isInteger(mapping.episode) || mapping.episode < 1 || (mapping.type === "unit" && (!Number.isInteger(mapping.unit) || !mapping.unit || mapping.unit < 1)) || (mapping.type === "shot" && !mapping.shot)) throw new Error(`手工路径映射 ${mapping.pathPrefix} 缺少有效集数、单元或镜号。`);
  }
  return {
    ...base,
    name: options.name?.trim() || base.name,
    primaryRoot,
    sourceRoots,
    outputRoots,
    ignoreSegments,
    namingRules: { patterns, manualMappings },
    updatedAt: new Date().toISOString(),
    automation: { ...base.automation, allowOverwriteAuthoritative: false },
  };
}

function previewFingerprint(config: ProjectConfig, projectMode: ProjectImportMode): string {
  const stable = {
    projectMode,
    id: config.id,
    name: config.name,
    primaryRoot: config.primaryRoot,
    sourceRoots: config.sourceRoots,
    outputRoots: config.outputRoots,
    ignoreSegments: config.ignoreSegments,
    namingRules: config.namingRules,
    hardLocks: config.hardLocks,
    automation: config.automation,
  };
  return `import-${createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 20)}`;
}

export async function prepareProjectImport(options: ProjectImportOptions): Promise<ProjectImportPreview> {
  if (!options.primaryRoot?.trim()) throw new Error("必须选择项目主根。");
  const projectMode = options.projectMode ?? "filesystem";
  const primaryRoot = path.resolve(options.primaryRoot);
  const sidecarExists = await exists(getSidecarPaths(primaryRoot).config);
  const existing = sidecarExists ? await loadProjectConfig(primaryRoot) : undefined;
  const config = normalizeConfig(options, existing);
  const registered = (await listRegisteredProjects()).some((project) => path.resolve(project.primaryRoot) === primaryRoot);
  const mode: ProjectImportPreview["mode"] = registered ? "registered" : sidecarExists ? "resume" : "new";
  const preliminaryIssues: ProjectImportIssue[] = [];

  const primaryState = await permissions(primaryRoot);
  if (!primaryState.exists) preliminaryIssues.push({ severity: "error", code: "primary_missing", message: "项目主根不存在。", path: primaryRoot });
  else if (!primaryState.readable) preliminaryIssues.push({ severity: "error", code: "primary_unreadable", message: "项目主根不可读取。", path: primaryRoot });
  else if (!primaryState.writable) preliminaryIssues.push({ severity: "error", code: "primary_readonly", message: "项目主根不可写，无法建立 .aicanvas 侧车。", path: primaryRoot });
  for (const sourceRoot of config.sourceRoots) {
    const state = await permissions(sourceRoot);
    if (!state.exists) preliminaryIssues.push({ severity: "error", code: "source_missing", message: "附加来源根不存在。", path: sourceRoot });
    else if (!state.readable) preliminaryIssues.push({ severity: "error", code: "source_unreadable", message: "附加来源根不可读取。", path: sourceRoot });
  }
  for (const outputRoot of config.outputRoots.filter((root) => root !== primaryRoot)) {
    const state = await permissions(outputRoot);
    if (!state.exists) preliminaryIssues.push({ severity: "warning", code: "output_missing", message: "允许输出根尚不存在，生成时需要先创建。", path: outputRoot });
    else if (!state.writable) preliminaryIssues.push({ severity: "error", code: "output_readonly", message: "允许输出根不可写。", path: outputRoot });
  }
  if (preliminaryIssues.some((issue) => issue.severity === "error")) {
    const blank = await scanProject({ projectRoot: primaryRoot, persist: false, configOverride: config }).catch(() => ({
      schemaVersion: 1 as const,
      project: config,
      scanId: "unavailable",
      scannedAt: new Date().toISOString(),
      scanDurationMs: 0,
      warnings: [],
      summary: { total: 0, active: 0, completed: 0, deprecated: 0, blocked: 0, byStatus: Object.fromEntries(["待规划","待提示词","待首帧","待尾帧","待机械验收","待视觉验收","待视频","视频生成中","待视频验收","已完成","返工","阻塞","弃用"].map((status) => [status, 0])) as ProjectIndex["summary"]["byStatus"], byEpisode: {}, rawImages: 0, labeledImages: 0, videos: 0, mechanicalFailures: 0 },
      items: [], artifacts: [],
    }));
    return buildPreview(config, mode, projectMode, blank, [], preliminaryIssues);
  }

  const index = await scanProject({ projectRoot: primaryRoot, persist: false, configOverride: config });
  const roles = [
    { root: primaryRoot, role: "primary" as const },
    ...config.sourceRoots.map((root) => ({ root, role: "source" as const })),
    ...config.outputRoots.filter((root) => root !== primaryRoot && !config.sourceRoots.includes(root)).map((root) => ({ root, role: "output" as const })),
  ];
  const roots = await Promise.all(roles.map(({ root, role }) => rootReport(root, role, index)));
  const issues = [...preliminaryIssues];
  if (!index.items.some((item) => item.type === "unit" || item.type === "shot")) {
    if (projectMode === "story_first") issues.push({ severity: "info", code: "story_first_empty", message: "小说起步项目当前没有生产单元；确认后只建立空索引与侧车，后续导入原文并物化分集单元。", path: primaryRoot });
    else issues.push({ severity: "error", code: "no_work_items", message: "没有识别出生产单元。请在导入规则中添加命名正则或手工路径映射后重新预检，避免建立错误空画布。", path: primaryRoot });
  }
  if (index.summary.mechanicalFailures) issues.push({ severity: "warning", code: "mechanical_failures", message: `${index.summary.mechanicalFailures} 个素材未通过解码、尺寸或文件完整性检查。` });
  for (const warning of index.warnings) issues.push({ severity: "warning", code: warning.includes("多个来源根") ? "cross_root_merge" : "scan_warning", message: warning });
  if (mode === "resume") issues.unshift({ severity: "info", code: "resume_sidecar", message: "检测到现有 .aicanvas，将保留画布、任务、验收和版本历史并重新登记。", path: getSidecarPaths(primaryRoot).root });
  if (mode === "registered") issues.unshift({ severity: "info", code: "already_registered", message: "该项目已登记，确认后会更新规则并重新扫描，不会重建历史。", path: primaryRoot });
  return buildPreview(config, mode, projectMode, index, roots, issues);
}

function buildPreview(config: ProjectConfig, mode: ProjectImportPreview["mode"], projectMode: ProjectImportMode, index: ProjectIndex, roots: ImportRootReport[], issues: ProjectImportIssue[]): ProjectImportPreview {
  const units = index.items.filter((item) => item.type === "unit");
  const shots = index.items.filter((item) => item.type === "shot");
  const assets = index.items.filter((item) => item.type === "asset");
  const paths = getSidecarPaths(config.primaryRoot);
  return {
    previewId: previewFingerprint(config, projectMode),
    mode,
    projectMode,
    canImport: !issues.some((issue) => issue.severity === "error"),
    config,
    summary: index.summary,
    scanDurationMs: index.scanDurationMs,
    roots,
    issues,
    sampleItems: index.items.filter((item) => ["unit", "shot"].includes(item.type)).slice(0, 16),
    recognized: {
      units: units.length,
      shots: shots.length,
      nestedShots: shots.filter((item) => item.parentId).length,
      assets: assets.length,
      artifacts: index.artifacts.length,
      deprecatedArtifacts: index.artifacts.filter((artifact) => artifact.deprecated).length,
      mechanicalFailures: index.summary.mechanicalFailures,
    },
    willWrite: [paths.config, paths.index, paths.events, paths.overrides, paths.cache, paths.progressMarkdown],
  };
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  return readFile(filePath).catch(() => null);
}

async function restoreOptional(filePath: string, value: Buffer | null): Promise<void> {
  if (value) await writeFile(filePath, value);
  else await rm(filePath, { force: true });
}

export async function commitProjectImport(input: { previewId: string; config: ProjectConfig; projectMode?: ProjectImportMode }): Promise<ProjectIndex> {
  const projectMode = input.projectMode ?? "filesystem";
  const preview = await prepareProjectImport({ ...input.config, projectMode });
  if (preview.previewId !== input.previewId) throw new Error("导入规则已变化，请重新预检后再确认。");
  if (!preview.canImport) throw new Error(`导入预检未通过：${preview.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("；")}`);
  const config = preview.config;
  const paths = getSidecarPaths(config.primaryRoot);
  const sidecarExisted = await exists(paths.root);
  const backups = sidecarExisted
    ? await Promise.all([paths.config, paths.index, paths.events, paths.overrides, paths.progressMarkdown].map(readOptional))
    : [];
  try {
    await ensureSidecar(config.primaryRoot);
    await writeJsonAtomic(paths.config, config);
    const index = await scanProject({ projectRoot: config.primaryRoot, configOverride: config });
    await saveIndex(index);
    const cache = new ProjectCache(config.primaryRoot);
    try { cache.replaceIndex(index); }
    finally { cache.close(); }
    await appendEvent(config.primaryRoot, { actor: "user", type: "project.imported", data: { mode: preview.mode, projectMode, sourceRoots: config.sourceRoots, outputRoots: config.outputRoots, previewId: preview.previewId } });
    await registerProject(config);
    return index;
  } catch (error) {
    if (!sidecarExisted) {
      await rm(paths.root, { recursive: true, force: true });
      await rm(paths.progressMarkdown, { force: true });
      await unregisterProject(config.primaryRoot);
    } else {
      const restorePaths = [paths.config, paths.index, paths.events, paths.overrides, paths.progressMarkdown];
      await Promise.all(restorePaths.map((filePath, index) => restoreOptional(filePath, backups[index] ?? null)));
    }
    throw error;
  }
}
