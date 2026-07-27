import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { createDefaultProjectConfig, SIDECAR_DIR } from "./constants.js";
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
    || value.schemaVersion !== 1
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

export interface ActiveProjectState {
  schemaVersion: 2;
  primaryRoot: string;
  activationId: string;
  activatedAt: string;
  updatedAt: string;
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
      schemaVersion: 2,
      primaryRoot: path.resolve(state.primaryRoot),
      activationId,
      activatedAt: state.updatedAt,
      updatedAt: state.updatedAt,
    };
  }
  if (state.schemaVersion !== 2
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
    schemaVersion: 2,
    primaryRoot: path.resolve(state.primaryRoot),
    activationId: state.activationId,
    activatedAt: state.activatedAt,
    updatedAt: state.updatedAt,
    ...(studio ? { studio } : {}),
  };
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

/**
 * 在同一注册表锁内执行调用方的只读冲突门，再登记工程。用于需要跨项目唯一性的
 * owner；guard 不得反向调用任何会再次取得 project-registry 锁的 API。
 */
export async function registerProjectGuarded(
  config: ProjectConfig,
  guard: (current: ProjectRegistryEntry[]) => Promise<void> | void,
): Promise<void> {
  const registryPath = getRegistryPath();
  assertProjectRegistryWriteIsIsolated(config.primaryRoot, registryPath);
  await withRegistryLock(registryPath, async () => {
    const registry = await readJson<ProjectRegistryEntry[]>(registryPath, []);
    await guard(registry.map((entry) => ({ ...entry })));
    const entry = { id: config.id, name: config.name, primaryRoot: config.primaryRoot, updatedAt: new Date().toISOString() };
    // 注册表是跨工程 owner 唯一性门的既有事实源，不能用展示层 LRU 截断。
    // 一旦旧工程被第 31 个登记淘汰，guard 将无法再发现其长期占用并可能建立
    // 平行 owner。列表展示若需限量，应在只读投影层分页，持久化登记必须完整保留，
    // 直到显式 unregister/prune。
    const next = [entry, ...registry.filter((item) => item.primaryRoot !== config.primaryRoot)];
    await writeJsonAtomic(registryPath, next);
    advanceProjectRegistryRevision();
  });
}

export async function registerProject(config: ProjectConfig): Promise<void> {
  return registerProjectGuarded(config, () => undefined);
}

export async function listRegisteredProjects(): Promise<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>> {
  return readJson(getRegistryPath(), []);
}

export async function getActiveProjectRegistration(): Promise<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt"> | null> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const state = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
    if (!state) return null;
    const activeRoot = path.resolve(state.primaryRoot);
    const registry = await readJson<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>>(registryPath, []);
    return registry.find((project) => path.resolve(project.primaryRoot) === activeRoot) ?? null;
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
    const state = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
    const hook = afterActiveProjectStateSnapshotHookForTests;
    afterActiveProjectStateSnapshotHookForTests = null;
    await hook?.();
    if (!state) return { state: null, registration: null };
    const activeRoot = path.resolve(state.primaryRoot);
    const registry = await readJson<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>>(
      registryPath,
      [],
    );
    return {
      state,
      registration: registry.find((project) => path.resolve(project.primaryRoot) === activeRoot) ?? null,
    };
  });
}

function activeRegistrationSnapshotKey(input: {
  state: ActiveProjectState | null;
  registration: ProjectRegistryEntry | null;
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
  registration: ProjectRegistryEntry | null;
}> {
  const state = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
  if (!state) return { state: null, registration: null };
  const activeRoot = path.resolve(state.primaryRoot);
  const registry = await readJson<ProjectRegistryEntry[]>(registryPath, []);
  return {
    state,
    registration: registry.find((project) => path.resolve(project.primaryRoot) === activeRoot) ?? null,
  };
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
  return after;
}

export async function getActiveProjectState(): Promise<ActiveProjectState | null> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => normalizeActiveProjectState(
    await readJson<unknown>(getActiveProjectPath(), null),
  ));
}

/** 纯只读活动指针读取；不创建 registry lock 文件，供轮询/诊断控制面使用。 */
export async function getActiveProjectStateReadOnly(): Promise<ActiveProjectState | null> {
  return normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
}

export async function setActiveProjectRegistration(projectRoot: string): Promise<void> {
  const registryPath = getRegistryPath();
  await withActiveProjectActivationFence(() => withRegistryLock(registryPath, async () => {
      const absoluteRoot = path.resolve(projectRoot);
      const registry = await readJson<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>>(registryPath, []);
      if (!registry.some((project) => path.resolve(project.primaryRoot) === absoluteRoot)) {
        throw new Error(`活动项目必须先完成登记：${absoluteRoot}`);
      }
      const previous = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
      const now = new Date().toISOString();
      const sameProject = previous && path.resolve(previous.primaryRoot) === absoluteRoot;
      await writeJsonAtomic(getActiveProjectPath(), {
        schemaVersion: 2,
        primaryRoot: absoluteRoot,
        activationId: sameProject ? previous.activationId : randomUUID(),
        activatedAt: sameProject ? previous.activatedAt : now,
        updatedAt: now,
        ...(sameProject && previous.studio ? { studio: previous.studio } : {}),
      } satisfies ActiveProjectState);
    }));
}

export async function setActiveStudioContext(
  projectRoot: string,
  input: { mode: ActiveStudioMode; focus?: ActiveStudioFocus },
): Promise<ActiveProjectState> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const state = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
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
    await writeJsonAtomic(getActiveProjectPath(), next);
    return next;
  });
}

export async function saveRegisteredProjects(projects: Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>): Promise<void> {
  const registryPath = getRegistryPath();
  await withRegistryLock(registryPath, async () => {
    const current = await readJson<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>>(registryPath, []);
    const requestedRoots = new Set(projects.map((project) => path.resolve(project.primaryRoot)));
    const concurrentlyAdded = current.filter((project) => !requestedRoots.has(path.resolve(project.primaryRoot)));
    const stillExisting = (await Promise.all(concurrentlyAdded.map(async (project) => await access(project.primaryRoot).then(() => project).catch(() => undefined)))).filter((project): project is NonNullable<typeof project> => Boolean(project));
    // 与 registerProjectGuarded 相同：该文件是 owner 登记事实源，不是最多 30 项的
    // 展示缓存。显式保存列表也不得淘汰仍登记的长期 owner。
    const next = [...projects, ...stillExisting.filter((project) => !projects.some((candidate) => path.resolve(candidate.primaryRoot) === path.resolve(project.primaryRoot)))];
    await writeJsonAtomic(registryPath, next);
    advanceProjectRegistryRevision();
  });
}

export async function pruneUnavailableRegisteredProjects(): Promise<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>> {
  const registryPath = getRegistryPath();
  return withRegistryLock(registryPath, async () => {
    const current = await readJson<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>>(registryPath, []);
    const available = (await Promise.all(current.map(async (project) => await access(project.primaryRoot).then(() => project).catch(() => undefined))))
      .filter((project): project is NonNullable<typeof project> => Boolean(project));
    if (available.length !== current.length) {
      await writeJsonAtomic(registryPath, available);
      advanceProjectRegistryRevision();
    }
    return available;
  });
}

export async function unregisterProject(projectRoot: string): Promise<void> {
  const registryPath = getRegistryPath();
  await withRegistryLock(registryPath, async () => {
    const registry = await readJson<Array<Pick<ProjectConfig, "id" | "name" | "primaryRoot" | "updatedAt">>>(registryPath, []);
    await writeJsonAtomic(
      registryPath,
      registry.filter((project) => path.resolve(project.primaryRoot) !== path.resolve(projectRoot)),
    );
    advanceProjectRegistryRevision();
    const active = normalizeActiveProjectState(await readJson<unknown>(getActiveProjectPath(), null));
    if (active && path.resolve(active.primaryRoot) === path.resolve(projectRoot)) {
      await rm(getActiveProjectPath(), { force: true });
    }
  });
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
