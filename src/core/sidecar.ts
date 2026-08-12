import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { createDefaultProjectConfig, SIDECAR_DIR } from "./constants.js";
import { MANAGED_PROJECT_WRITER_SCHEMA_VERSION } from "./novel-types.js";
import type { ProjectConfig, ProjectEvent, ProjectIndex, ProjectOverrides, TaskPack } from "./types.js";
import { getOperationContext } from "./operation-context.js";
import { withFileLock } from "./locks.js";

export interface SidecarPaths {
  root: string;
  config: string;
  index: string;
  events: string;
  overrides: string;
  tasks: string;
  cache: string;
  progressMarkdown: string;
  documentHistory: string;
  generationSettings: string;
  generationJobs: string;
  generationRequests: string;
  generationDownloads: string;
  publications: string;
  timeline: string;
  canvasSemantic: string;
  canvasHistory: string;
  reviews: string;
  context: string;
  skills: string;
  skillHistory: string;
  handoffs: string;
  storyRoot: string;
  storyIndex: string;
  storyChapters: string;
  storySnapshots: string;
  storyEvents: string;
  storyAdaptation: string;
  storyAnalysisTasks: string;
  storyAnalysisProviders: string;
  storyHistory: string;
  storyMigrations: string;
  storyMigrationStaging: string;
  productionWorkflow: string;
  creativeBibles: string;
  storyboards: string;
  assetRelations: string;
  canonicalAssets: string;
  fusionProjectManifest: string;
  productionAssets: string;
  continuityTracks: string;
  referenceBoards: string;
  storyboardGrids: string;
  storyboardGridSelections: string;
  panelReferenceResolutions: string;
  panelVisualConstraints: string;
  storyboardSheets: string;
  storyboardSheetIndex: string;
  assetConsistencyBatches: string;
  assetConsistencyBoards: string;
  voiceIdentities: string;
  editorRoot: string;
  editorSession: string;
  editorProjects: string;
  editorDependencies: string;
  editorRenderPlans: string;
  editorNestedCache: string;
  editorRenders: string;
  editorOutputs: string;
  editorContinuations: string;
  editorProvenance: string;
  editorHistory: string;
  editorOtio: string;
  editorPreviews: string;
  editorProxies: string;
  editorPreviewIndex: string;
  commandLedger: string;
}

export function getSidecarPaths(projectRoot: string): SidecarPaths {
  const root = path.join(projectRoot, SIDECAR_DIR);
  return {
    root,
    config: path.join(root, "project.json"),
    index: path.join(root, "index.json"),
    events: path.join(root, "events.jsonl"),
    overrides: path.join(root, "overrides.json"),
    tasks: path.join(root, "tasks"),
    cache: path.join(root, "cache.sqlite"),
    progressMarkdown: path.join(projectRoot, "00_画布进度.md"),
    documentHistory: path.join(root, "history", "documents"),
    generationSettings: path.join(root, "generation.json"),
    generationJobs: path.join(root, "generation-jobs.json"),
    generationRequests: path.join(root, "generation-requests"),
    generationDownloads: path.join(root, "generation-downloads"),
    publications: path.join(root, "publications.json"),
    timeline: path.join(root, "timeline.json"),
    canvasSemantic: path.join(root, "canvas.json"),
    canvasHistory: path.join(root, "canvas-history.json"),
    reviews: path.join(root, "reviews.json"),
    context: path.join(root, "context.json"),
    skills: path.join(root, "skills"),
    skillHistory: path.join(root, "history", "skills"),
    handoffs: path.join(root, "handoffs"),
    storyRoot: path.join(root, "story"),
    storyIndex: path.join(root, "story", "index.json"),
    storyChapters: path.join(root, "story", "chapters"),
    storySnapshots: path.join(root, "story", "sources"),
    storyEvents: path.join(root, "story", "events.json"),
    storyAdaptation: path.join(root, "story", "adaptation.json"),
    storyAnalysisTasks: path.join(root, "story", "analysis-tasks"),
    storyAnalysisProviders: path.join(root, "story", "analysis-providers.json"),
    storyHistory: path.join(root, "history", "story"),
    storyMigrations: path.join(root, "history", "story", "migrations"),
    storyMigrationStaging: path.join(root, "history", "story", ".migration-staging"),
    productionWorkflow: path.join(root, "production-workflow.json"),
    creativeBibles: path.join(root, "creative-bibles.json"),
    storyboards: path.join(root, "storyboards.json"),
    assetRelations: path.join(root, "asset-relations.json"),
    canonicalAssets: path.join(root, "canonical-assets.json"),
    fusionProjectManifest: path.join(root, "fusion-project-manifest.json"),
    productionAssets: path.join(root, "production-assets.json"),
    continuityTracks: path.join(root, "continuity-tracks.json"),
    referenceBoards: path.join(root, "reference-boards"),
    storyboardGrids: path.join(root, "storyboard-grids"),
    storyboardGridSelections: path.join(root, "storyboard-grid-selections.json"),
    panelReferenceResolutions: path.join(root, "panel-reference-resolutions.json"),
    panelVisualConstraints: path.join(root, "panel-visual-constraints.json"),
    storyboardSheets: path.join(root, "storyboard-sheets"),
    storyboardSheetIndex: path.join(root, "storyboard-sheet-index.json"),
    assetConsistencyBatches: path.join(root, "asset-consistency-batches.json"),
    assetConsistencyBoards: path.join(root, "asset-consistency-boards"),
    voiceIdentities: path.join(root, "voice-identities.json"),
    editorRoot: path.join(root, "editor"),
    editorSession: path.join(root, "editor", "editor-session.json"),
    editorProjects: path.join(root, "editor", "projects"),
    editorDependencies: path.join(root, "editor", "dependencies"),
    editorRenderPlans: path.join(root, "editor", "render-plans"),
    editorNestedCache: path.join(root, "editor", "nested-cache"),
    editorRenders: path.join(root, "editor", "renders.json"),
    editorOutputs: path.join(root, "editor", "outputs"),
    editorContinuations: path.join(root, "editor", "continuations"),
    editorProvenance: path.join(root, "editor", "provenance.jsonl"),
    editorHistory: path.join(root, "editor", "history"),
    editorOtio: path.join(root, "editor", "otio"),
    editorPreviews: path.join(root, "editor", "previews"),
    editorProxies: path.join(root, "editor", "proxies"),
    editorPreviewIndex: path.join(root, "editor", "previews.json"),
    commandLedger: path.join(root, "command-ledger.json"),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectConfigValue(value: unknown, filePath: string): ProjectConfig {
  if (!recordValue(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.primaryRoot !== "string"
    || !Array.isArray(value.sourceRoots) || !value.sourceRoots.every((entry) => typeof entry === "string")
    || !Array.isArray(value.outputRoots) || !value.outputRoots.every((entry) => typeof entry === "string")
    || !Array.isArray(value.ignoreSegments) || !value.ignoreSegments.every((entry) => typeof entry === "string")
    || !Array.isArray(value.hardLocks)
    || (value.namingRules !== undefined && (!recordValue(value.namingRules) || !Array.isArray(value.namingRules.patterns) || !Array.isArray(value.namingRules.manualMappings)))
    || !recordValue(value.automation)) {
    throw new Error(`项目配置 JSON 结构无效，已停止写入：${filePath}`);
  }
  if (value.schemaVersion === 1) {
    if ("workspaceMode" in value || "minimumWriterSchemaVersion" in value) {
      throw new Error(`schema v1 项目配置不得夹带 v2 writer 字段，已停止写入：${filePath}`);
    }
  } else if ((value.workspaceMode !== "novel" && value.workspaceMode !== "hybrid")
    || value.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(`schema v2 项目配置 writer 声明无效，已停止写入：${filePath}`);
  }
  return value as unknown as ProjectConfig;
}

function projectIndexValue(value: unknown, filePath: string): ProjectIndex | null {
  if (value === null) return null;
  if (!recordValue(value)
    || value.schemaVersion !== 1
    || typeof value.scanId !== "string"
    || typeof value.scannedAt !== "string"
    || typeof value.scanDurationMs !== "number"
    || !Array.isArray(value.warnings)
    || !Array.isArray(value.items)
    || !Array.isArray(value.artifacts)
    || !recordValue(value.summary) || typeof value.summary.total !== "number") {
    throw new Error(`扫描索引 JSON 结构无效，已停止读取：${filePath}`);
  }
  projectConfigValue(value.project, filePath);
  return value as unknown as ProjectIndex;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = await stat(filePath).then((metadata) => metadata.mode & 0o777).catch(() => 0o600);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonAtomicExclusive(filePath: string, value: unknown): Promise<"created" | "existing"> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(tempPath, filePath);
      await syncDirectory(directory);
      return "created";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
      const existing = await readFile(filePath, "utf8");
      if (existing !== content) throw new Error(`内容寻址文件已存在但内容不一致，拒绝覆盖：${filePath}`);
      return "existing";
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new Error(`侧车 JSON 已损坏，已停止写入以保留现场：${filePath}`, { cause: error });
    throw error;
  }
}

export async function ensureSidecar(
  projectRoot: string,
  options: { register?: boolean } = {},
): Promise<ProjectConfig> {
  const paths = getSidecarPaths(projectRoot);
  await mkdir(paths.tasks, { recursive: true });
  await mkdir(paths.documentHistory, { recursive: true });
  await mkdir(paths.generationRequests, { recursive: true });
  await mkdir(paths.generationDownloads, { recursive: true });
  await mkdir(paths.storyboardSheets, { recursive: true });
  await mkdir(paths.assetConsistencyBoards, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  await mkdir(paths.skillHistory, { recursive: true });
  await mkdir(paths.handoffs, { recursive: true });
  await mkdir(paths.storyChapters, { recursive: true });
  await mkdir(paths.storySnapshots, { recursive: true });
  await mkdir(paths.storyAnalysisTasks, { recursive: true });
  await mkdir(paths.storyHistory, { recursive: true });
  await mkdir(paths.editorProjects, { recursive: true });
  await mkdir(paths.editorDependencies, { recursive: true });
  await mkdir(paths.editorRenderPlans, { recursive: true });
  await mkdir(paths.editorNestedCache, { recursive: true });
  await mkdir(paths.editorOutputs, { recursive: true });
  await mkdir(paths.editorContinuations, { recursive: true });
  await mkdir(paths.editorHistory, { recursive: true });
  await mkdir(paths.editorOtio, { recursive: true });
  await mkdir(paths.editorPreviews, { recursive: true });
  await mkdir(paths.editorProxies, { recursive: true });
  const config = (await exists(paths.config))
    ? projectConfigValue(await readJson<unknown>(paths.config, createDefaultProjectConfig(projectRoot)), paths.config)
    : createDefaultProjectConfig(projectRoot);

  config.namingRules = config.namingRules ?? { patterns: [], manualMappings: [] };
  config.primaryRoot = projectRoot;
  config.updatedAt = new Date().toISOString();
  await writeJsonAtomic(paths.config, config);
  if (!(await exists(paths.overrides))) {
    await writeJsonAtomic(paths.overrides, { schemaVersion: 1, items: {} } satisfies ProjectOverrides);
  }
  if (!(await exists(paths.events))) {
    await writeTextAtomic(paths.events, "");
  }
  if (options.register !== false) await registerProject(config);
  return config;
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = getSidecarPaths(projectRoot).config;
  const config = projectConfigValue(await readJson<unknown>(configPath, createDefaultProjectConfig(projectRoot)), configPath);
  config.namingRules = config.namingRules ?? { patterns: [], manualMappings: [] };
  return config;
}

export async function loadOverrides(projectRoot: string): Promise<ProjectOverrides> {
  return readJson(getSidecarPaths(projectRoot).overrides, { schemaVersion: 1, items: {} });
}

export async function saveOverrides(projectRoot: string, overrides: ProjectOverrides): Promise<void> {
  await writeJsonAtomic(getSidecarPaths(projectRoot).overrides, overrides);
}

export async function loadIndex(projectRoot: string): Promise<ProjectIndex | null> {
  const indexPath = getSidecarPaths(projectRoot).index;
  return projectIndexValue(await readJson<unknown>(indexPath, null), indexPath);
}

export async function saveIndex(index: ProjectIndex): Promise<void> {
  const paths = getSidecarPaths(index.project.primaryRoot);
  await writeJsonAtomic(paths.index, index);
  await writeTextAtomic(paths.progressMarkdown, renderProgressMarkdown(index));
}

export async function appendEvent(
  projectRoot: string,
  event: Omit<ProjectEvent, "id" | "at"> & Partial<Pick<ProjectEvent, "id" | "at">>,
): Promise<ProjectEvent> {
  const operation = getOperationContext();
  const normalized: ProjectEvent = {
    ...event,
    requestId: event.requestId ?? operation?.requestId,
    idempotencyKey: event.idempotencyKey ?? operation?.idempotencyKey,
    command: event.command ?? operation?.command,
    id: event.id ?? randomUUID(),
    at: event.at ?? new Date().toISOString(),
  };
  const paths = getSidecarPaths(projectRoot);
  await mkdir(paths.root, { recursive: true });
  const handle = await open(paths.events, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(normalized)}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return normalized;
}

export async function writeTaskPack(projectRoot: string, task: TaskPack): Promise<string> {
  if (!/^task-[a-zA-Z0-9_-]{8,160}$/.test(task.id)) throw new Error("任务包 ID 不合法。 ");
  task.schemaVersion = 2;
  task.revision = Math.max(1, task.revision ?? 1);
  const taskPath = path.join(getSidecarPaths(projectRoot).tasks, `${task.id}.json`);
  await writeJsonAtomic(taskPath, task);
  return taskPath;
}

export async function readTaskPack(projectRoot: string, taskId: string): Promise<TaskPack | null> {
  if (!/^task-[a-zA-Z0-9_-]{8,160}$/.test(taskId)) throw new Error("任务包 ID 不合法。 ");
  const task = await readJson<TaskPack | null>(path.join(getSidecarPaths(projectRoot).tasks, `${taskId}.json`), null);
  return task ? normalizeTaskPack(task) : null;
}

function normalizeTaskPack(task: TaskPack): TaskPack {
  const legacy = task as TaskPack & { schemaVersion: number; revision?: number };
  return { ...task, schemaVersion: 2, revision: Math.max(1, legacy.revision ?? 1) };
}

export function getProjectRegistryPath(): string {
  return process.env.AI_CANVAS_REGISTRY_PATH
    ? path.resolve(process.env.AI_CANVAS_REGISTRY_PATH)
    : path.join(os.homedir(), ".aicanvas", "projects.json");
}

/**
 * schema v2 novel/hybrid 工程与旧 writer 共享同一注册表目录和锁，但不共享
 * legacy projects.json 的可见条目。旧构建的项目列表与常规激活入口只读
 * projects.json，因而无法从这些入口把 v2 工程设为活动工程。
 */
export function getProjectRegistryV2Path(): string {
  const legacyPath = getProjectRegistryPath();
  const v2Path = path.join(path.dirname(legacyPath), "projects-v2.json");
  if (path.resolve(v2Path) === path.resolve(legacyPath)) {
    throw new Error("AI_CANVAS_REGISTRY_PATH 必须指向 legacy projects.json，不得占用 projects-v2.json。");
  }
  return v2Path;
}

/** hybrid 桌面偏好独立于旧 writer 共享的 active-project.json。 */
export function getWorkspacePreferencesV2Path(): string {
  return path.join(path.dirname(getProjectRegistryPath()), "workspace-preferences-v2.json");
}

function getRegistryPath(): string {
  return getProjectRegistryPath();
}

function pathIsWithin(candidate: string, container: string): boolean {
  const relative = path.relative(path.resolve(container), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTemporaryFilesystemPath(candidate: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedTemporaryRoot = path.resolve(os.tmpdir());
  const temporaryRoots = new Set([resolvedTemporaryRoot]);
  if (resolvedTemporaryRoot.startsWith("/var/")) temporaryRoots.add(`/private${resolvedTemporaryRoot}`);
  if (resolvedTemporaryRoot.startsWith("/private/var/")) temporaryRoots.add(resolvedTemporaryRoot.slice("/private".length));
  return [...temporaryRoots].some((root) => pathIsWithin(resolvedCandidate, root));
}

/**
 * 非 Vitest/tsx 临时脚本也必须显式把注册表隔离到临时目录。此门在取得注册表锁
 * 之前执行，失败时不会创建 ~/.aicanvas、锁文件或任何注册记录。
 */
export function assertProjectRegistryWriteIsIsolated(
  projectRoot: string,
  registryPath = getRegistryPath(),
  hasExplicitRegistryPath = Boolean(process.env.AI_CANVAS_REGISTRY_PATH?.trim()),
): void {
  if (!isTemporaryFilesystemPath(projectRoot)) return;
  if (!hasExplicitRegistryPath || !isTemporaryFilesystemPath(registryPath)) {
    throw new Error(
      "临时工程禁止写入用户全局注册表；请显式设置 AI_CANVAS_REGISTRY_PATH 为临时隔离路径后重试。",
    );
  }
}

export function diagnoseProjectRegistryEntries(
  entries: readonly ProjectRegistryEntry[],
): {
  total: number;
  temporaryEntries: ProjectRegistryEntry[];
  cleanupPlan: string[];
} {
  return {
    total: entries.length,
    temporaryEntries: entries.filter((entry) => isTemporaryFilesystemPath(entry.primaryRoot)).map((entry) => ({ ...entry })),
    cleanupPlan: [
      "先确认临时工程已无正在运行的调用或持有者。",
      "逐项核对 primaryRoot、id 与 updatedAt，不使用批量 prune 清理外接盘或暂时离线工程。",
      "仅通过显式 unregisterProject(primaryRoot) 移除已确认的临时条目，并在操作后重新运行只读诊断。",
    ],
  };
}

function getActiveProjectPath(): string {
  return path.join(path.dirname(getRegistryPath()), "active-project.json");
}

export type ActiveStudioMode = "canvas" | "dashboard" | "library" | "binding" | "continuity-review";

export interface ActiveStudioFocus {
  unitId?: string;
  panelId?: string;
  assetId?: string;
}

export type HybridWorkspacePreferenceMode = "novel" | "drama";

export interface HybridWorkspacePreference {
  mode: HybridWorkspacePreferenceMode;
  updatedAt: string;
}

export interface ActiveHybridWorkspacePreference extends HybridWorkspacePreference {
  projectId: string;
}

export interface ActiveProjectState {
  schemaVersion: 3;
  primaryRoot: string;
  activationId: string;
  activatedAt: string;
  updatedAt: string;
  workspacePreferences: Record<string, HybridWorkspacePreference>;
  studio?: {
    mode: ActiveStudioMode;
    focus?: ActiveStudioFocus;
    updatedAt: string;
  };
}

interface LegacyActiveProjectRegistration {
  schemaVersion: 1;
  primaryRoot: string;
  updatedAt: string;
}

type ActiveProjectStateV2 = Omit<ActiveProjectState, "schemaVersion" | "workspacePreferences"> & {
  schemaVersion: 2;
};

type ActiveProjectStateV3File = Omit<ActiveProjectState, "workspacePreferences">;

interface WorkspacePreferencesV2File {
  schemaVersion: 2;
  kind: "ai-canvas-workspace-preferences";
  minimumWriterSchemaVersion: typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  preferences: Record<string, HybridWorkspacePreference>;
}

const ACTIVE_CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

function normalizeActiveFocus(value: unknown): ActiveStudioFocus | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`活动项目焦点状态已损坏，已停止自动打开：${getActiveProjectPath()}`);
  }
  const record = value as Record<string, unknown>;
  const focus: ActiveStudioFocus = {};
  for (const key of ["unitId", "panelId", "assetId"] as const) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !ACTIVE_CONTEXT_ID_PATTERN.test(entry.trim())) {
      throw new Error(`活动项目焦点 ${key} 无效，已停止自动打开：${getActiveProjectPath()}`);
    }
    focus[key] = entry.trim();
  }
  return Object.keys(focus).length > 0 ? focus : undefined;
}

function normalizeWorkspacePreferenceProjectId(value: unknown): string {
  if (typeof value !== "string" || !ACTIVE_CONTEXT_ID_PATTERN.test(value) || value !== value.trim()) {
    throw new Error(`活动项目工作区偏好 projectId 无效，已停止自动打开：${getActiveProjectPath()}`);
  }
  return value;
}

function normalizeHybridWorkspacePreferenceMode(value: unknown): HybridWorkspacePreferenceMode {
  if (value !== "novel" && value !== "drama") {
    throw new Error(`活动项目工作区偏好 mode 无效，已停止自动打开：${getActiveProjectPath()}`);
  }
  return value;
}

function normalizeActiveWorkspacePreferences(value: unknown): Record<string, HybridWorkspacePreference> {
  if (!recordValue(value)) {
    throw new Error(`活动项目工作区偏好已损坏，已停止自动打开：${getActiveProjectPath()}`);
  }
  const normalized: Record<string, HybridWorkspacePreference> = {};
  for (const [rawProjectId, entry] of Object.entries(value)) {
    const projectId = normalizeWorkspacePreferenceProjectId(rawProjectId);
    if (!recordValue(entry)) {
      throw new Error(`活动项目工作区偏好已损坏，已停止自动打开：${getActiveProjectPath()}`);
    }
    if (typeof entry.updatedAt !== "string") {
      throw new Error(`活动项目工作区偏好 updatedAt 无效，已停止自动打开：${getActiveProjectPath()}`);
    }
    normalized[projectId] = {
      mode: normalizeHybridWorkspacePreferenceMode(entry.mode),
      updatedAt: entry.updatedAt,
    };
  }
  return normalized;
}

function normalizeActiveProjectState(value: unknown): ActiveProjectState | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`活动项目状态已损坏，已停止自动打开：${getActiveProjectPath()}`);
  }
  const state = value as Record<string, unknown>;
  if (typeof state.primaryRoot !== "string" || typeof state.updatedAt !== "string") {
    throw new Error(`活动项目状态已损坏，已停止自动打开：${getActiveProjectPath()}`);
  }
  if (state.schemaVersion === 1) {
    const activationId = createHash("sha256")
      .update(`${path.resolve(state.primaryRoot)}\0${state.updatedAt}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    return {
      schemaVersion: 3,
      primaryRoot: path.resolve(state.primaryRoot),
      activationId,
      activatedAt: state.updatedAt,
      updatedAt: state.updatedAt,
      workspacePreferences: {},
    };
  }
  if ((state.schemaVersion !== 2 && state.schemaVersion !== 3)
    || typeof state.activationId !== "string"
    || !/^[a-f0-9-]{16,64}$/u.test(state.activationId)
    || typeof state.activatedAt !== "string") {
    throw new Error(`活动项目状态已损坏，已停止自动打开：${getActiveProjectPath()}`);
  }
  let studio: ActiveProjectState["studio"];
  if (state.studio !== undefined) {
    if (!state.studio || typeof state.studio !== "object" || Array.isArray(state.studio)) {
      throw new Error(`活动项目 Studio 状态已损坏，已停止自动打开：${getActiveProjectPath()}`);
    }
    const rawStudio = state.studio as Record<string, unknown>;
    if (!(["canvas", "dashboard", "library", "binding", "continuity-review"] as const).includes(rawStudio.mode as ActiveStudioMode)
      || typeof rawStudio.updatedAt !== "string") {
      throw new Error(`活动项目 Studio 状态已损坏，已停止自动打开：${getActiveProjectPath()}`);
    }
    const focus = normalizeActiveFocus(rawStudio.focus);
    studio = {
      mode: rawStudio.mode as ActiveStudioMode,
      ...(focus ? { focus } : {}),
      updatedAt: rawStudio.updatedAt,
    };
  }
  return {
    schemaVersion: 3,
    primaryRoot: path.resolve(state.primaryRoot),
    activationId: state.activationId,
    activatedAt: state.activatedAt,
    updatedAt: state.updatedAt,
    workspacePreferences: state.schemaVersion === 3 && state.workspacePreferences !== undefined
      ? normalizeActiveWorkspacePreferences(state.workspacePreferences)
      : {},
    ...(studio ? { studio } : {}),
  };
}

async function readWorkspacePreferencesV2(): Promise<Record<string, HybridWorkspacePreference>> {
  const filePath = getWorkspacePreferencesV2Path();
  const raw = await readJson<unknown>(filePath, null);
  if (raw === null) return {};
  if (!recordValue(raw)
    || raw.schemaVersion !== 2
    || raw.kind !== "ai-canvas-workspace-preferences"
    || raw.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(`hybrid 工作区偏好 sidecar 已损坏：${filePath}`);
  }
  return normalizeActiveWorkspacePreferences(raw.preferences);
}

async function writeWorkspacePreferencesV2(
  preferences: Record<string, HybridWorkspacePreference>,
): Promise<void> {
  if (Object.keys(preferences).length === 0) return;
  const ordered = Object.fromEntries(Object.entries(preferences)
    .sort(([left], [right]) => left.localeCompare(right, "en")));
  await writeJsonAtomic(getWorkspacePreferencesV2Path(), {
    schemaVersion: 2,
    kind: "ai-canvas-workspace-preferences",
    minimumWriterSchemaVersion: MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
    preferences: ordered,
  } satisfies WorkspacePreferencesV2File);
}

async function readActiveProjectStateWithPreferences(): Promise<ActiveProjectState | null> {
  const state = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
  if (!state) return null;
  const separate = await readWorkspacePreferencesV2();
  return {
    ...state,
    workspacePreferences: {
      ...state.workspacePreferences,
      ...separate,
    },
  };
}

function activeProjectStateForWrite(
  state: ActiveProjectState,
  forceCurrentSchema = false,
): ActiveProjectStateV3File | ActiveProjectStateV2 {
  const { workspacePreferences: _workspacePreferences, ...legacy } = state;
  return { ...legacy, schemaVersion: forceCurrentSchema ? 3 : 2 };
}

async function withRegistryLock<T>(registryPath: string, operation: () => Promise<T>): Promise<T> {
  const registryRoot = path.dirname(registryPath);
  await mkdir(registryRoot, { recursive: true });
  return withFileLock(path.join(registryRoot, "locks"), "project-registry", operation, {
    confinementRoot: registryRoot,
  });
}

/**
 * 活动工程切换 fence。付费调用授权必须从 projectContextToken 首检直到 call intent
 * 落盘都持有该锁；活动工程切换也必须取得同一把锁，避免 A→B→A 或 A→B 穿越授权窗口。
 */
export async function withActiveProjectActivationFence<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const registryRoot = path.dirname(getRegistryPath());
  await mkdir(registryRoot, { recursive: true });
  return withFileLock(path.join(registryRoot, "locks"), "active-project-activation", operation, {
    confinementRoot: registryRoot,
  });
}

let projectRegistryRevision = 0;
let afterActiveProjectStateSnapshotHookForTests:
  | (() => void | Promise<void>)
  | null = null;

/** 仅供 Vitest 在 state 已读、registration 尚未投影的窗口注入工程切换。 */
export function __setAfterActiveProjectStateSnapshotHookForTests(
  hook: typeof afterActiveProjectStateSnapshotHookForTests,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("active project snapshot hook 仅允许测试环境。");
  afterActiveProjectStateSnapshotHookForTests = hook;
}

/**
 * 进程内注册表修订号。依赖已登记工程根的缓存必须同时绑定该值，避免注销/清理后
 * 仍在 TTL 窗口内继续放行旧工程。只在注册表写入成功后递增。
 */
export function getProjectRegistryRevision(): number {
  return projectRegistryRevision;
}

function advanceProjectRegistryRevision(): void {
  projectRegistryRevision += 1;
}

type ProjectRegistryEntry = Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">;

export type ProjectRegistryLane = "legacy" | "v2";

interface ProjectRegistryV2File {
  schemaVersion: 2;
  kind: "ai-canvas-project-registry";
  minimumWriterSchemaVersion: typeof MANAGED_PROJECT_WRITER_SCHEMA_VERSION;
  projects: ProjectRegistryEntry[];
}

interface ProjectRegistryPair {
  legacy: ProjectRegistryEntry[];
  v2: ProjectRegistryEntry[];
}

function normalizeProjectRegistryEntry(value: unknown, filePath: string): ProjectRegistryEntry {
  if (!recordValue(value)) throw new Error(`项目注册条目结构无效：${filePath}`);
  if (typeof value.id !== "string" || !value.id.trim()
    || typeof value.name !== "string" || !value.name.trim()
    || typeof value.primaryRoot !== "string" || !path.isAbsolute(value.primaryRoot)
    || typeof value.updatedAt !== "string") {
    throw new Error(`项目注册条目结构无效：${filePath}`);
  }
  return {
    id: value.id,
    name: value.name,
    primaryRoot: path.resolve(value.primaryRoot),
    updatedAt: value.updatedAt,
  };
}

async function readProjectRegistryV2(v2Path = getProjectRegistryV2Path()): Promise<ProjectRegistryEntry[]> {
  const raw = await readJson<unknown>(v2Path, null);
  if (raw === null) return [];
  if (!recordValue(raw)) throw new Error(`schema v2 项目注册表结构无效：${v2Path}`);
  if (typeof raw.schemaVersion === "number"
    && Number.isSafeInteger(raw.schemaVersion)
    && raw.schemaVersion > MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(`项目注册表 schema v${raw.schemaVersion} 高于当前 writer v${MANAGED_PROJECT_WRITER_SCHEMA_VERSION}，已停止读写：${v2Path}`);
  }
  if (raw.schemaVersion !== 2
    || raw.kind !== "ai-canvas-project-registry"
    || raw.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION
    || !Array.isArray(raw.projects)) {
    throw new Error(`schema v2 项目注册表结构无效：${v2Path}`);
  }
  const projects = raw.projects.map((entry) => normalizeProjectRegistryEntry(entry, v2Path));
  const roots = new Set<string>();
  for (const project of projects) {
    const root = path.resolve(project.primaryRoot);
    if (roots.has(root)) throw new Error(`schema v2 项目注册表含重复根：${root}`);
    roots.add(root);
  }
  return projects;
}

async function writeProjectRegistryV2(v2Path: string, projects: ProjectRegistryEntry[]): Promise<void> {
  await writeJsonAtomic(v2Path, {
    schemaVersion: 2,
    kind: "ai-canvas-project-registry",
    minimumWriterSchemaVersion: MANAGED_PROJECT_WRITER_SCHEMA_VERSION,
    projects,
  } satisfies ProjectRegistryV2File);
}

async function readProjectRegistryPair(registryPath = getRegistryPath()): Promise<ProjectRegistryPair> {
  const [legacy, v2] = await Promise.all([
    readJson<ProjectRegistryEntry[]>(registryPath, []),
    readProjectRegistryV2(getProjectRegistryV2Path()),
  ]);
  return { legacy, v2 };
}

function mergeProjectRegistryPair(pair: ProjectRegistryPair): ProjectRegistryEntry[] {
  if (pair.v2.length === 0) return pair.legacy.map((entry) => ({ ...entry }));
  if (pair.legacy.length === 0) return pair.v2.map((entry) => ({ ...entry }));
  const merged = pair.legacy.map((entry) => ({ ...entry }));
  const indexByRoot = new Map(merged.map((entry, index) => [path.resolve(entry.primaryRoot), index]));
  for (const entry of pair.v2) {
    const root = path.resolve(entry.primaryRoot);
    const existingIndex = indexByRoot.get(root);
    if (existingIndex === undefined) {
      indexByRoot.set(root, merged.length);
      merged.push({ ...entry });
      continue;
    }
    const existing = merged[existingIndex]!;
    if (existing.id !== entry.id) {
      throw new Error(`legacy/v2 项目注册表对同一根的身份冲突：${root}`);
    }
    // 早期 P1 预览可能曾把同一 v2 条目写入 legacy 表；当前 writer
    // 只投影一份 v2 身份，下次显式 register 会将 legacy 泄漏安全移出。
    merged[existingIndex] = { ...entry };
  }
  return merged;
}

function findRegisteredProjectInPair(
  pair: ProjectRegistryPair,
  projectRoot: string,
): { entry: ProjectRegistryEntry; lane: ProjectRegistryLane } | null {
  const absoluteRoot = path.resolve(projectRoot);
  const v2 = pair.v2.find((entry) => path.resolve(entry.primaryRoot) === absoluteRoot);
  if (v2) return { entry: v2, lane: "v2" };
  const legacy = pair.legacy.find((entry) => path.resolve(entry.primaryRoot) === absoluteRoot);
  return legacy ? { entry: legacy, lane: "legacy" } : null;
}

async function projectRegistryLaneForConfig(
  config: Pick<ProjectConfig, "id" | "primaryRoot">,
): Promise<ProjectRegistryLane> {
  const manifestPath = path.join(path.resolve(config.primaryRoot), SIDECAR_DIR, "managed-project.json");
  const manifest = await readJson<unknown>(manifestPath, null);
  if (manifest === null) return "legacy";
  if (!recordValue(manifest) || manifest.kind !== "ai-canvas-managed-project") {
    throw new Error(`受管工程 manifest 结构无效，拒绝选择注册表：${manifestPath}`);
  }
  if (manifest.schemaVersion === 1) {
    if ("workspaceMode" in manifest || "minimumWriterSchemaVersion" in manifest || "novelManifest" in manifest) {
      throw new Error(`schema v1 manifest 不得夹带 v2 工作区字段：${manifestPath}`);
    }
    return "legacy";
  }
  if (typeof manifest.schemaVersion === "number"
    && Number.isSafeInteger(manifest.schemaVersion)
    && manifest.schemaVersion > MANAGED_PROJECT_WRITER_SCHEMA_VERSION) {
    throw new Error(`受管工程 schema v${manifest.schemaVersion} 高于当前 writer v${MANAGED_PROJECT_WRITER_SCHEMA_VERSION}，拒绝登记：${manifestPath}`);
  }
  if (manifest.schemaVersion !== 2
    || manifest.minimumWriterSchemaVersion !== MANAGED_PROJECT_WRITER_SCHEMA_VERSION
    || (manifest.workspaceMode !== "novel" && manifest.workspaceMode !== "hybrid")
    || manifest.projectId !== config.id) {
    throw new Error(`schema v2 受管工程声明无效，拒绝登记：${manifestPath}`);
  }
  return "v2";
}

async function findLegacyV2RegistryLeaks(pair: ProjectRegistryPair): Promise<ProjectRegistryEntry[]> {
  const classified = await Promise.all(pair.legacy.map(async (entry) => ({
    entry,
    lane: await projectRegistryLaneForConfig(entry),
  })));
  return classified.filter(({ lane }) => lane === "v2").map(({ entry }) => entry);
}

function rawActiveProjectSchemaVersion(value: unknown): number | null {
  return recordValue(value) && typeof value.schemaVersion === "number" ? value.schemaVersion : null;
}

async function repairLegacyV2RegistryLeaksUnderLock(
  registryPath: string,
  pair: ProjectRegistryPair,
): Promise<ProjectRegistryPair> {
  const leaked = await findLegacyV2RegistryLeaks(pair);
  const leakedRoots = new Set(leaked.map((entry) => path.resolve(entry.primaryRoot)));
  const nextV2 = [...pair.v2];
  for (const entry of leaked) {
    const root = path.resolve(entry.primaryRoot);
    const existing = nextV2.find((candidate) => path.resolve(candidate.primaryRoot) === root);
    if (existing && existing.id !== entry.id) {
      throw new Error(`legacy/v2 项目注册表对同一根的身份冲突：${root}`);
    }
    if (!existing) nextV2.push({ ...entry });
  }

  const rawActive = await readJson<unknown>(getActiveProjectPath(), null);
  const normalizedActive = rawActive === null ? null : await readActiveProjectStateWithPreferences();
  const v2Roots = new Set(nextV2.map((entry) => path.resolve(entry.primaryRoot)));
  const activeNeedsWriterFence = normalizedActive
    && v2Roots.has(path.resolve(normalizedActive.primaryRoot))
    && rawActiveProjectSchemaVersion(rawActive) !== 3;
  if (activeNeedsWriterFence) {
    // 先升级活动指针。即使进程随后中断，旧 writer 也会因不认识 schema 3
    // 在任何活动状态改写前失败关闭。
    await writeWorkspacePreferencesV2(normalizedActive.workspacePreferences);
    await writeJsonAtomic(getActiveProjectPath(), activeProjectStateForWrite(normalizedActive, true));
  }

  if (leaked.length === 0) return pair;
  const nextLegacy = pair.legacy.filter((entry) => !leakedRoots.has(path.resolve(entry.primaryRoot)));
  const v2Changed = nextV2.length !== pair.v2.length;
  // 再从旧 writer 可见表移除，最后写入 v2 表；任一中间状态都不会让旧 writer
  // 获得对 v2 工程的可写活动身份。
  await writeJsonAtomic(registryPath, nextLegacy);
  // 仅 legacy 泄漏时 v2 表可能已包含同一身份；不要重写健康 v2 文件。
  if (v2Changed) await writeProjectRegistryV2(getProjectRegistryV2Path(), nextV2);
  advanceProjectRegistryRevision();
  return { legacy: nextLegacy, v2: nextV2 };
}

export async function repairProjectRegistryCompatibility(): Promise<ProjectRegistryEntry[]> {
  const registryPath = getRegistryPath();
  const repaired = await withActiveProjectActivationFence(() => withRegistryLock(
    registryPath,
    async () => repairLegacyV2RegistryLeaksUnderLock(
      registryPath,
      await readProjectRegistryPair(registryPath),
    ),
  ));
  return mergeProjectRegistryPair(repaired);
}

export interface ActiveProjectStartupReconcileExpectation {
  primaryRoot: string;
  activationId: string;
}

/**
 * 冷启动的同根 CAS 对账。调用方只能提供先前纯只读投影中的 root+activationId；
 * 这里从不把旧 root 重新设为活动工程。validate 回调必须保持只读且不能再取
 * registry lock，因而 manifest 可在同一锁域内验证而不会产生锁顺序反转。
 */
export async function reconcileActiveProjectStartup<T>(
  expected: ActiveProjectStartupReconcileExpectation,
  validateManagedProject: (
    registration: Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">,
  ) => Promise<T>,
): Promise<{ registration: Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">; value: T }> {
  const expectedRoot = path.resolve(expected.primaryRoot);
  if (!expected.primaryRoot || expectedRoot !== expected.primaryRoot
    || typeof expected.activationId !== "string" || !/^[a-f0-9-]{16,64}$/u.test(expected.activationId)) {
    throw new Error("活动工程启动快照参数无效。 ");
  }
  const assertExpected = (state: ActiveProjectState | null): ActiveProjectState => {
    if (!state
      || path.resolve(state.primaryRoot) !== expectedRoot
      || state.activationId !== expected.activationId) {
      throw new Error("活动工程启动快照已变化，拒绝恢复旧工程。 ");
    }
    return state;
  };
  const registryPath = getRegistryPath();
  // 冷启动对账不属于付费调用授权窗口；它只需和活动指针/注册表写入串行。
  // 若在这里额外持有 activation fence，首卡恢复会和真正需要该 fence 的意图
  // 提交相互排队，且不会增加 root+activationId CAS 的保护强度。
  return withRegistryLock(registryPath, async () => {
    // 冲突先失败，不能因为旧 UI 快照而触发 compatibility repair 的写入。
    assertExpected(await readActiveProjectStateWithPreferences());
    const repaired = await repairLegacyV2RegistryLeaksUnderLock(
      registryPath,
      await readProjectRegistryPair(registryPath),
    );
    const registration = findRegisteredProjectInPair(repaired, expectedRoot)?.entry;
    if (!registration) throw new Error(`活动工程登记已丢失，拒绝冷启动：${expectedRoot}`);
    const value = await validateManagedProject({ ...registration, primaryRoot: expectedRoot });
    // A→B→A 不能只按 root 判断；activationId 也必须仍等于初始快照。
    assertExpected(await readActiveProjectStateWithPreferences());
    return { registration: { ...registration, primaryRoot: expectedRoot }, value };
  });
}

/**
 * 在同一注册表锁内执行调用方的只读冲突门，再登记工程。用于需要跨项目唯一性的
 * owner；guard 不得反向调用任何会再次取得 project-registry 锁的 API。
 */
export async function registerProjectGuarded(
  config: ProjectConfig,
  guard: (current: ProjectRegistryEntry[]) => Promise<void> | void,
): Promise<void> {
  const registryPath = getRegistryPath();
  const registryV2Path = getProjectRegistryV2Path();
  assertProjectRegistryWriteIsIsolated(config.primaryRoot, registryPath);
  assertProjectRegistryWriteIsIsolated(config.primaryRoot, registryV2Path);
  const targetLane = await projectRegistryLaneForConfig(config);
  await withActiveProjectActivationFence(() => withRegistryLock(registryPath, async () => {
    const loadedPair = await readProjectRegistryPair(registryPath);
    // guard 保持先于任何兼容迁移；冲突拒绝不能产生注册表或活动指针副作用。
    await guard(mergeProjectRegistryPair(loadedPair));
    // main restore 与其他调用方只需继续调用 registerProject(config)：若这是早期
    // P1 已泄漏的 v2 根，登记前先完成注册表迁移与活动指针 writer fence。
    const pair = targetLane === "v2"
      ? await repairLegacyV2RegistryLeaksUnderLock(registryPath, loadedPair)
      : loadedPair;
    const entry = { id: config.id, name: config.name, primaryRoot: config.primaryRoot, updatedAt: new Date().toISOString() };
    // 注册表是跨工程 owner 唯一性门的既有事实源，不能用展示层 LRU 截断。
    // 一旦旧工程被第 31 个登记淘汰，guard 将无法再发现其长期占用并可能建立
    // 平行 owner。列表展示若需限量，应在只读投影层分页，持久化登记必须完整保留，
    // 直到显式 unregister/prune。
    const absoluteRoot = path.resolve(config.primaryRoot);
    const matchingLegacy = pair.legacy.find((item) => path.resolve(item.primaryRoot) === absoluteRoot);
    const matchingV2 = pair.v2.find((item) => path.resolve(item.primaryRoot) === absoluteRoot);
    if (targetLane === "legacy") {
      if (matchingV2) {
        throw new Error(`schema v2 工程不得降级登记到 legacy 注册表：${absoluteRoot}`);
      }
      const next = [entry, ...pair.legacy.filter((item) => path.resolve(item.primaryRoot) !== absoluteRoot)];
      await writeJsonAtomic(registryPath, next);
    } else {
      if (matchingLegacy && matchingLegacy.id !== config.id) {
        throw new Error(`legacy/v2 项目注册表对同一根的身份冲突：${absoluteRoot}`);
      }
      if (matchingV2 && matchingV2.id !== config.id) {
        throw new Error(`schema v2 项目注册表对同一根的身份冲突：${absoluteRoot}`);
      }
      // 早期 P1 预览曾可能把 v2 根写进 legacy 表。先移除旧 writer 的项目列表
      // 可见条目，再登记到 v2 表；中途失败时旧版常规激活只会看见“未登记”。
      if (matchingLegacy) {
        await writeJsonAtomic(
          registryPath,
          pair.legacy.filter((item) => path.resolve(item.primaryRoot) !== absoluteRoot),
        );
      }
      const next = [entry, ...pair.v2.filter((item) => path.resolve(item.primaryRoot) !== absoluteRoot)];
      await writeProjectRegistryV2(registryV2Path, next);
    }
    advanceProjectRegistryRevision();
  }));
}

export async function registerProject(config: ProjectConfig): Promise<void> {
  return registerProjectGuarded(config, () => undefined);
}

export async function listRegisteredProjects(): Promise<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>> {
  return mergeProjectRegistryPair(await readProjectRegistryPair());
}

/**
 * 显式打开目标的物理只读 lane 投影。不得补旧泄漏、取得 registry lock 或改写登记；
 * 调用方据此决定是否允许 legacy 路由回退。
 */
export async function getRegisteredProjectLaneReadOnly(projectRoot: string): Promise<ProjectRegistryLane | null> {
  return findRegisteredProjectInPair(await readProjectRegistryPair(), projectRoot)?.lane ?? null;
}

export async function getActiveProjectRegistration(): Promise<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt"> | null> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const state = await readActiveProjectStateWithPreferences();
    if (!state) return null;
    return findRegisteredProjectInPair(
      await readProjectRegistryPair(registryPath),
      state.primaryRoot,
    )?.entry ?? null;
  });
}

/**
 * 活动 state 与 registration 的单锁快照。切换路径同时需要 registry 锁，因此不会把
 * A 的 activationId 与 B 的 registration 拼成一个虚假上下文。
 */
export async function getActiveProjectRegistrationSnapshot(): Promise<{
  state: ActiveProjectState | null;
  registration: Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt"> | null;
}> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const state = await readActiveProjectStateWithPreferences();
    const hook = afterActiveProjectStateSnapshotHookForTests;
    afterActiveProjectStateSnapshotHookForTests = null;
    await hook?.();
    if (!state) return { state: null, registration: null };
    return {
      state,
      registration: findRegisteredProjectInPair(
        await readProjectRegistryPair(registryPath),
        state.primaryRoot,
      )?.entry ?? null,
    };
  });
}

function activeRegistrationSnapshotKey(input: {
  state: ActiveProjectState | null;
  registration: { entry: ProjectRegistryEntry; lane: ProjectRegistryLane } | null;
}): string {
  return JSON.stringify({
    state: input.state,
    registration: input.registration,
  });
}

async function readActiveProjectRegistrationPairReadOnly(
  registryPath: string,
): Promise<{
  state: ActiveProjectState | null;
  registration: { entry: ProjectRegistryEntry; lane: ProjectRegistryLane } | null;
}> {
  const state = await readActiveProjectStateWithPreferences();
  if (!state) return { state: null, registration: null };
  return {
    state,
    registration: findRegisteredProjectInPair(
      await readProjectRegistryPair(registryPath),
      state.primaryRoot,
    ),
  };
}

function requireMatchingActiveProject(
  snapshot: { state: ActiveProjectState | null; registration: { entry: ProjectRegistryEntry; lane: ProjectRegistryLane } | null },
  projectId: string,
): { state: ActiveProjectState; registration: ProjectRegistryEntry } {
  if (!snapshot.state || !snapshot.registration
    || snapshot.registration.entry.id !== projectId
    || path.resolve(snapshot.registration.entry.primaryRoot) !== path.resolve(snapshot.state.primaryRoot)) {
    throw new Error(`只能读取或更新当前活动工程的 hybrid 工作区偏好：${projectId}`);
  }
  return { state: snapshot.state, registration: snapshot.registration.entry };
}

async function assertHybridWorkspaceCapability(projectRoot: string, projectId: string): Promise<void> {
  const manifestPath = path.join(projectRoot, SIDECAR_DIR, "managed-project.json");
  const manifest = await readJson<unknown>(manifestPath, null);
  if (!recordValue(manifest)
    || manifest.schemaVersion !== 2
    || manifest.kind !== "ai-canvas-managed-project"
    || manifest.projectId !== projectId
    || manifest.workspaceMode !== "hybrid"
    || manifest.minimumWriterSchemaVersion !== 2) {
    throw new Error(`只有 schema v2 hybrid 受管工程可以保存工作区偏好：${projectId}`);
  }
}

/**
 * 活动工程的物理零写稳定快照。
 *
 * 不能取得 project-registry 文件锁（取得锁本身会创建 locks 目录/文件），因此用
 * state+对应 registration 的双读一致性检查：任一字段在窗口内变化都失败关闭，
 * 由上层把它当作瞬时竞态重试。A→B→A 也会因 activationId 换代而被识别。
 */
export async function getActiveProjectRegistrationSnapshotReadOnly(): Promise<{
  state: ActiveProjectState | null;
  registration: Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt"> | null;
  registrationLane: ProjectRegistryLane | null;
}> {
  const registryPath = getRegistryPath();
  const before = await readActiveProjectRegistrationPairReadOnly(registryPath);
  const hook = afterActiveProjectStateSnapshotHookForTests;
  afterActiveProjectStateSnapshotHookForTests = null;
  await hook?.();
  const after = await readActiveProjectRegistrationPairReadOnly(registryPath);
  if (activeRegistrationSnapshotKey(before) !== activeRegistrationSnapshotKey(after)) {
    throw new Error("active project registration snapshot changed while reading");
  }
  return {
    state: after.state,
    registration: after.registration?.entry ?? null,
    registrationLane: after.registration?.lane ?? null,
  };
}

export async function getActiveProjectState(): Promise<ActiveProjectState | null> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, readActiveProjectStateWithPreferences);
}

/** 纯只读活动指针读取；不创建 registry lock 文件，供轮询/诊断控制面使用。 */
export async function getActiveProjectStateReadOnly(): Promise<ActiveProjectState | null> {
  return readActiveProjectStateWithPreferences();
}

/**
 * 读取当前 hybrid 工程的桌面显示偏好。纯只读：不取得文件锁、不迁移旧 sidecar，
 * 并在 active state / registry 于读取窗口变化时失败关闭。
 */
export async function getActiveHybridWorkspacePreference(
  projectId: string,
): Promise<ActiveHybridWorkspacePreference | null> {
  const normalizedProjectId = normalizeWorkspacePreferenceProjectId(projectId);
  const registryPath = getRegistryPath();
  const before = await readActiveProjectRegistrationPairReadOnly(registryPath);
  const active = requireMatchingActiveProject(before, normalizedProjectId);
  await assertHybridWorkspaceCapability(active.state.primaryRoot, normalizedProjectId);
  const after = await readActiveProjectRegistrationPairReadOnly(registryPath);
  if (activeRegistrationSnapshotKey(before) !== activeRegistrationSnapshotKey(after)) {
    throw new Error("active project workspace preference changed while reading");
  }
  const preference = requireMatchingActiveProject(after, normalizedProjectId)
    .state.workspacePreferences[normalizedProjectId];
  return preference ? { projectId: normalizedProjectId, ...preference } : null;
}

/**
 * 保存当前 hybrid 工程的桌面显示偏好。该偏好只属于全局 active-project sidecar，
 * 不进入项目 manifest/fingerprint，也不创建 manuscript/story-bible/novel 目录。
 */
export async function setActiveHybridWorkspacePreference(
  projectId: string,
  mode: HybridWorkspacePreferenceMode,
): Promise<ActiveHybridWorkspacePreference> {
  const normalizedProjectId = normalizeWorkspacePreferenceProjectId(projectId);
  const normalizedMode = normalizeHybridWorkspacePreferenceMode(mode);
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const state = await readActiveProjectStateWithPreferences();
    const activeRoot = state ? path.resolve(state.primaryRoot) : null;
    const registration = activeRoot
      ? findRegisteredProjectInPair(
        await repairLegacyV2RegistryLeaksUnderLock(
          registryPath,
          await readProjectRegistryPair(registryPath),
        ),
        activeRoot,
      )
      : null;
    const active = requireMatchingActiveProject({ state, registration }, normalizedProjectId);
    await assertHybridWorkspaceCapability(active.state.primaryRoot, normalizedProjectId);

    const existing = active.state.workspacePreferences[normalizedProjectId];
    if (existing?.mode === normalizedMode) return { projectId: normalizedProjectId, ...existing };

    const now = new Date().toISOString();
    const preference: ActiveHybridWorkspacePreference = {
      projectId: normalizedProjectId,
      mode: normalizedMode,
      updatedAt: now,
    };
    const next: ActiveProjectState = {
      ...active.state,
      schemaVersion: 3,
      updatedAt: now,
      workspacePreferences: Object.fromEntries(Object.entries({
        ...active.state.workspacePreferences,
        [normalizedProjectId]: { mode: preference.mode, updatedAt: preference.updatedAt },
      }).sort(([left], [right]) => left.localeCompare(right, "en"))),
    };
    await writeWorkspacePreferencesV2(next.workspacePreferences);
    await writeJsonAtomic(getActiveProjectPath(), activeProjectStateForWrite(next, true));
    return { ...preference };
  });
}

export async function setActiveProjectRegistration(projectRoot: string): Promise<void> {
  const registryPath = getRegistryPath();
  await withActiveProjectActivationFence(() => withRegistryLock(registryPath, async () => {
      const absoluteRoot = path.resolve(projectRoot);
      const registration = findRegisteredProjectInPair(
        await repairLegacyV2RegistryLeaksUnderLock(
          registryPath,
          await readProjectRegistryPair(registryPath),
        ),
        absoluteRoot,
      );
      if (!registration) {
        throw new Error(`活动项目必须先完成登记：${absoluteRoot}`);
      }
      const previous = await readActiveProjectStateWithPreferences();
      const now = new Date().toISOString();
      const sameProject = previous && path.resolve(previous.primaryRoot) === absoluteRoot;
      const next: ActiveProjectState = {
        schemaVersion: 3,
        primaryRoot: absoluteRoot,
        activationId: sameProject ? previous.activationId : randomUUID(),
        activatedAt: sameProject ? previous.activatedAt : now,
        updatedAt: now,
        workspacePreferences: previous?.workspacePreferences ?? {},
        ...(sameProject && previous.studio ? { studio: previous.studio } : {}),
      };
      // v2 工程的活动指针也写为 schema 3。旧 writer 只认识 schema 1/2，
      // 因而即使直接调用旧 unregister，也会在删除指针前失败关闭。
      await writeWorkspacePreferencesV2(next.workspacePreferences);
      await writeJsonAtomic(
        getActiveProjectPath(),
        activeProjectStateForWrite(next, registration.lane === "v2"),
      );
    }));
}

export async function setActiveStudioContext(
  projectRoot: string,
  input: { mode: ActiveStudioMode; focus?: ActiveStudioFocus },
): Promise<ActiveProjectState> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const state = await readActiveProjectStateWithPreferences();
    if (!state || path.resolve(state.primaryRoot) !== path.resolve(projectRoot)) {
      throw new Error("只能更新当前活动工程的 Studio 焦点。");
    }
    const focus = normalizeActiveFocus(input.focus);
    const now = new Date().toISOString();
    const next: ActiveProjectState = {
      ...state,
      updatedAt: now,
      studio: {
        mode: input.mode,
        ...(focus ? { focus } : {}),
        updatedAt: now,
      },
    };
    const registration = findRegisteredProjectInPair(
      await repairLegacyV2RegistryLeaksUnderLock(
        registryPath,
        await readProjectRegistryPair(registryPath),
      ),
      state.primaryRoot,
    );
    if (!registration) {
      throw new Error(`活动项目登记已丢失，拒绝更新 Studio 焦点：${state.primaryRoot}`);
    }
    await writeWorkspacePreferencesV2(next.workspacePreferences);
    await writeJsonAtomic(
      getActiveProjectPath(),
      activeProjectStateForWrite(next, registration.lane === "v2"),
    );
    return next;
  });
}

export async function saveRegisteredProjects(projects: Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>): Promise<void> {
  const registryPath = getRegistryPath();
  await withRegistryLock(registryPath, async () => {
    const current = await readProjectRegistryPair(registryPath);
    const requestedRoots = new Set(projects.map((project) => path.resolve(project.primaryRoot)));
    if (requestedRoots.size !== projects.length) {
      throw new Error("保存项目注册表时发现重复工程根，已停止写入。");
    }
    const requestedWithLane = await Promise.all(projects.map(async (project) => {
      const currentRegistration = findRegisteredProjectInPair(current, project.primaryRoot);
      const lane = currentRegistration?.lane === "v2"
        ? "v2"
        : await projectRegistryLaneForConfig(project);
      return { project, lane };
    }));
    const requestedLegacy = requestedWithLane.filter(({ lane }) => lane === "legacy").map(({ project }) => project);
    const requestedV2 = requestedWithLane.filter(({ lane }) => lane === "v2").map(({ project }) => project);
    const retainExisting = async (entries: ProjectRegistryEntry[]): Promise<ProjectRegistryEntry[]> => (
      await Promise.all(entries
        .filter((project) => !requestedRoots.has(path.resolve(project.primaryRoot)))
        .map(async (project) => await access(project.primaryRoot).then(() => project).catch(() => undefined)))
    ).filter((project): project is ProjectRegistryEntry => Boolean(project));
    const [stillExistingLegacy, stillExistingV2] = await Promise.all([
      retainExisting(current.legacy),
      retainExisting(current.v2),
    ]);
    // 与 registerProjectGuarded 相同：该文件是 owner 登记事实源，不是最多 30 项的
    // 展示缓存。显式保存列表也不得淘汰仍登记的长期 owner。
    const nextLegacy = [...requestedLegacy, ...stillExistingLegacy];
    const nextV2 = [...requestedV2, ...stillExistingV2];
    await writeJsonAtomic(registryPath, nextLegacy);
    if (current.v2.length > 0 || nextV2.length > 0) {
      await writeProjectRegistryV2(getProjectRegistryV2Path(), nextV2);
    }
    advanceProjectRegistryRevision();
  });
}

export async function pruneUnavailableRegisteredProjects(): Promise<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const current = await readProjectRegistryPair(registryPath);
    const retainAvailable = async (entries: ProjectRegistryEntry[]): Promise<ProjectRegistryEntry[]> => (
      await Promise.all(entries.map(async (project) => await access(project.primaryRoot).then(() => project).catch(() => undefined)))
    ).filter((project): project is ProjectRegistryEntry => Boolean(project));
    const [availableLegacy, availableV2] = await Promise.all([
      retainAvailable(current.legacy),
      retainAvailable(current.v2),
    ]);
    let changed = false;
    if (availableLegacy.length !== current.legacy.length) {
      await writeJsonAtomic(registryPath, availableLegacy);
      changed = true;
    }
    if (availableV2.length !== current.v2.length) {
      await writeProjectRegistryV2(getProjectRegistryV2Path(), availableV2);
      changed = true;
    }
    if (changed) {
      advanceProjectRegistryRevision();
    }
    return mergeProjectRegistryPair({ legacy: availableLegacy, v2: availableV2 });
  });
}

export async function unregisterProject(projectRoot: string): Promise<void> {
  const registryPath = getRegistryPath();
  await withActiveProjectActivationFence(() => withRegistryLock(registryPath, async () => {
    const absoluteRoot = path.resolve(projectRoot);
    const current = await readProjectRegistryPair(registryPath);
    const inLegacy = current.legacy.some((project) => path.resolve(project.primaryRoot) === absoluteRoot);
    const inV2 = current.v2.some((project) => path.resolve(project.primaryRoot) === absoluteRoot);
    // 纯 legacy 路径保持旧行为（包括未命中时仍重写 projects.json）；v2 路径只改
    // projects-v2.json，除非清理早期预览遗留的同根 legacy 泄漏。
    if (!inV2 || inLegacy) {
      await writeJsonAtomic(
        registryPath,
        current.legacy.filter((project) => path.resolve(project.primaryRoot) !== absoluteRoot),
      );
    }
    if (inV2) {
      await writeProjectRegistryV2(
        getProjectRegistryV2Path(),
        current.v2.filter((project) => path.resolve(project.primaryRoot) !== absoluteRoot),
      );
    }
    advanceProjectRegistryRevision();
    const active = await readActiveProjectStateWithPreferences();
    if (active && path.resolve(active.primaryRoot) === absoluteRoot) {
      await rm(getActiveProjectPath(), { force: true });
    }
  }));
}

export async function listTaskPacks(projectRoot: string): Promise<TaskPack[]> {
  const taskDirectory = getSidecarPaths(projectRoot).tasks;
  try {
    const files = (await readdir(taskDirectory)).filter((name) => name.endsWith(".json"));
    const tasks = await Promise.all(files.map((name) => readJson<TaskPack | null>(path.join(taskDirectory, name), null)));
    return tasks.filter((task): task is TaskPack => Boolean(task)).map(normalizeTaskPack).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listEvents(projectRoot: string, limit = 200): Promise<ProjectEvent[]> {
  try {
    const lines = (await readFile(getSidecarPaths(projectRoot).events, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines
      .slice(-Math.max(1, Math.min(limit, 2_000)))
      .map((line) => JSON.parse(line) as ProjectEvent)
      .reverse();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function findEventsByIdempotencyKey(projectRoot: string, idempotencyKey: string, limit = 100): Promise<ProjectEvent[]> {
  const matches: ProjectEvent[] = [];
  try {
    const lines = createInterface({ input: createReadStream(getSidecarPaths(projectRoot).events, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(idempotencyKey)) continue;
      try {
        const event = JSON.parse(line) as ProjectEvent;
        if (event.idempotencyKey === idempotencyKey) {
          matches.push(event);
          if (matches.length > Math.max(1, Math.min(limit, 1_000))) matches.shift();
        }
      } catch {
        // 单行损坏不应阻止扫描其余追加式事件。
      }
    }
  } catch {
    return [];
  }
  return matches.reverse();
}

function renderProgressMarkdown(index: ProjectIndex): string {
  const shotCount = index.items.filter((item) => item.type === "shot").length;
  const nestedShotCount = index.items.filter((item) => item.type === "shot" && item.parentId).length;
  const statusRows = Object.entries(index.summary.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join("\n");
  const episodeRows = Object.entries(index.summary.byEpisode)
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map(([episode, value]) => `| ${episode} | ${value.total} | ${value.completed} | ${value.active} |`)
    .join("\n");
  const nextItems = index.items
    .filter((item) => !["已完成", "弃用"].includes(item.status))
    .sort((a, b) => a.priority - b.priority || (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0))
    .slice(0, 20)
    .map((item) => `| ${item.id} | ${item.parentId ?? "—"} | ${item.title} | ${item.status} | ${item.nextAction} |`)
    .join("\n");

  return `# ${index.project.name} · 画布进度\n\n` +
    `- 扫描时间：${index.scannedAt}\n` +
    `- 扫描 ID：${index.scanId}\n` +
    `- 生产单元：${index.summary.total}\n` +
    `- 原镜头节点：${shotCount}（已归属 15 秒单元：${nestedShotCount}）\n` +
    `- 已完成：${index.summary.completed}\n` +
    `- 活跃待办：${index.summary.active}\n` +
    `- 机械验收失败：${index.summary.mechanicalFailures}\n\n` +
    `## 状态汇总\n\n| 状态 | 数量 |\n|---|---:|\n${statusRows}\n\n` +
    `## 分集汇总\n\n| 集数 | 总数 | 已完成 | 活跃 |\n|---|---:|---:|---:|\n${episodeRows}\n\n` +
    `## 下一批候选\n\n| ID | 父单元 | 节点 | 状态 | 下一动作 |\n|---|---|---|---|---|\n${nextItems}\n\n` +
    `> 本文件由 AI 漫剧画布生成。完成状态以真实文件、机械验收和视觉验收记录共同判定。\n`;
}
