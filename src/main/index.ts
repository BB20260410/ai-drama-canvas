import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { access, chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, protocol, shell } from "electron";
import chokidar, { type FSWatcher } from "chokidar";
import { DEFAULT_PROJECT_ROOT } from "../core/constants.js";
import {
  activateProject,
  claimTask,
  createManagedStudioProject,
  createTaskPack,
  finishBatch,
  heartbeatTask,
  getActiveProject,
  getActiveProjectReadOnly,
  getManagedProjectShell,
  getItem,
  getProjectIndex,
  getTaskCenter,
  listProjects,
  loadCanvasPositions,
  removeProjectRegistration,
  releaseTask,
  promoteAssetToHardLock,
  previewProjectScan,
  saveCanvasPositions,
  saveProjectConfig,
  scanAndPersist,
  setAuthoritativeArtifact,
  updateStatus,
  upgradeManagedStudioProject,
  type ListProjectsRequestOptions,
} from "../core/service.js";
import { inspectManagedProjectReadOnly, isManagedProject } from "../core/managed-project.js";
import { createScriptDocument, listScriptDocuments, readScriptDocument, saveScriptDocument } from "../core/documents.js";
import {
  cancelGenerationJob,
  enqueueGeneration,
  getGenerationSettings,
  listGenerationJobs,
  processGenerationQueue,
  saveGenerationSettings,
  updateSubagentImageGenerationJob,
} from "../core/generation.js";
import { createShotTaskPack, getUnitTimelines, saveUnitTimeline } from "../core/timeline.js";
import { getContinuitySpans, listContinuityTracks } from "../core/continuity.js";
import {
  auditFusionPanelReferences,
  getFusionPanelReferenceResolution,
  inspectFusionPanelReferenceCurrentness,
  listDerivedPanelReferenceAssets,
  listFusionPanelReferenceResolutions,
} from "../core/fusion-panel-references.js";
import {
  getFusionPanelVisualConstraint,
  inspectFusionPanelVisualConstraintCurrentness,
} from "../core/fusion-visual-constraint-store.js";
import { deleteCanvasEntity, deleteCanvasLink, getCanvasHistoryInfo, getCanvasSemanticState, moveCanvasEntities, redoCanvasSemanticState, undoCanvasSemanticState, upsertCanvasEntity, upsertCanvasLink } from "../core/canvas-state.js";
import { getSidecarPaths, listRegisteredProjects, loadProjectConfig, registerProject, setActiveStudioContext } from "../core/sidecar.js";
import {
  isLegacyUnhashedMediaPathAllowed,
  readLegacyAssetBytes,
  resolveLegacyAssetPath,
} from "../core/legacy-asset-confinement.js";
import { getReviewQueue, listReviewRecords, submitReview } from "../core/reviews.js";
import { commitProjectImport, prepareProjectImport } from "../core/importer.js";
import { deleteAgentSkill, listAgentSkills, readAgentSkill, saveAgentSkill } from "../core/skills.js";
import { createContinuationHandoff, deleteProjectContext, getContinuationSnapshot, listProjectContext, searchProjectContext, upsertProjectContext } from "../core/memory.js";
import { buildStoryContext, connectStoryEvents, importStoryFile, importStoryText, listStoryChapters, listStoryEvents, listStorySources, readStoryChapter, upsertStoryEvent } from "../core/story.js";
import {
  resolveRuntimeBuildIdentity,
  sourceDigestPathIsRelevant,
  sourceDigestWatchPaths,
} from "../core/build-identity.js";
import { createPackagedMcpRuntimeLaunchContract, RELEASE_MANIFEST_FILE_NAME } from "../core/release-manifest.js";
import {
  captureRuntimeBootIdentity,
  createRuntimeGateController,
} from "../core/runtime-write-gate.js";
import {
  runtimeIpcEffect,
  runtimeIpcGateMode,
} from "../core/runtime-ipc-effect.js";
import { createRuntimeIpcPerformanceProbe } from "../core/runtime-ipc-observability.js";
import { getRuntimeStorageReadMetrics } from "../core/runtime-storage-observability.js";
import { applyEditOperation, beginEditorSession, cancelEditRender, closeEditorSession, createEditProject, createVideoContinuationPack, exportEditProjectOtio, extractLastFrame, extractTimelineFrame, getEditHistoryInfo, getEditProject, getEditorSessionState, getEditRenderJob, importEditProjectOtio, listEditMedia, listEditProjects, listEditRenderJobs, listTimelineFrameExtractions, listVideoContinuationPacks, prepareEditMediaPreview, prepareEditMediaProxy, prepareNestedTimelinePreview, prepareTimelineVideoContinuation, probeVideoEngine, redoEditProject, renderEditProject, resolveEditorSessionRecovery, saveEditProject, setEditorSessionProject, startEditRender, undoEditProject, updateVideoContinuationPack, type EditOperation } from "../core/editor.js";
import { analyzeChangeImpact, getProductionWorkflow, getStoryboard, listCreativeBibles, updateProductionWorkflowStage, upsertCreativeBible, upsertStoryboardRow } from "../core/production.js";
import { analyzeAdaptationChangeImpact, analyzeNovelChapters, exportAdaptation, generateAdaptationPlans, getAdaptationWorkspace, materializeSelectedAdaptationPlan, regenerateAdaptationScope, selectAdaptationPlan, upsertNarrativeBeat, upsertNovelFact, validateAdaptationPlan } from "../core/adaptation.js";
import { listAssetRelations, listVoiceIdentities, upsertAssetRelation, upsertVoiceIdentity } from "../core/asset-registry.js";
import { createNovelAnalysisTask, listNovelAnalysisReviews, reviewNovelAnalysisBatch, reviewNovelAnalysisItem } from "../core/novel-analysis.js";
import { getNovelAnalysisProviderSettings, getNovelAnalysisRunProgress, listNovelAnalysisRunProgress, probeNovelAnalysisProvider } from "../core/novel-analysis-provider.js";
import {
  executeIdempotentCommand,
} from "../core/command-bus.js";
import { ensureDesktopWriteLeaseForCommand } from "../core/desktop-write-lease.js";
import {
  parseStudioIdempotentCommandInput,
  type StudioIdempotentCommandInput,
  type StudioPublicCommandRequest,
} from "../core/studio-command-runtime.js";
import { getFusionAssetConsistencyState } from "../core/fusion-asset-consistency.js";
import { getCanonicalAsset, getCanonicalAssetCatalogState, listCanonicalAssets, previewCanonicalAssetMigration } from "../core/canonical-assets.js";
import { FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION, FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION } from "../core/fusion-storyboard-grid.js";
import { getFusionStoryboardSheetState, listFusionStoryboardSheets } from "../core/fusion-storyboard-sheet-evidence.js";
import type { AgentSkillCategory, CanvasEntity, CanvasSemanticLink, EditProject, GenerationKind, GenerationSettings, ProjectConfig, ProjectContextKind, ProjectImportMode, ProjectImportOptions, ReviewDecision, ShotTiming, StoryEventStatus, SubmitReviewInput, TaskPack, WorkItemStatus } from "../core/types.js";
import { streamStudioMediaRequest, StudioMediaProtocolError } from "../core/studio-media-protocol.js";
import { resolveLegacyThumbnailFromBytes } from "../core/legacy-thumbnails.js";
import {
  getStudioMediaDerivatives,
  materializeStudioMediaDerivatives,
  type StudioMediaDerivativeRecord,
} from "../core/studio-media-derivatives.js";
import {
  getMaterialStudioState,
  getStudioMedia,
  getStudioCanonicalAsset,
  listStudioCanonicalAssets,
  listStudioMedia,
  type StudioCanonicalAssetListQuery,
  type StudioMediaListQuery,
} from "../core/material-studio.js";
import {
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
  getLatestStudioTextRevisionMetadata,
  getStudioTextDocument,
  getStudioTextRevision,
  listStudioProductionUnits,
  listStudioTextDocuments,
  listStudioTextRevisions,
  queryStudioAssetTimeline,
  type StudioAssetTimelineQuery,
  type StudioProductionUnitListQuery,
  type StudioTextDocumentListQuery,
} from "../core/studio-production.js";
import {
  getStudioGenerationLedgerState,
  listStudioGenerationPanelHistory,
  listStudioGenerationUnitGridHistory,
  readStudioHistoricalGenerationEvidenceByUnit,
  readAnyStudioGenerationFrozenPack,
} from "../core/studio-generation-ledger.js";
import {
  getStudioGenerationControlEnvelope,
  type StudioGenerationControlQuery,
} from "../core/codex.js";
import { getStudioGenerationReviewControl } from "../core/studio-generation-review.js";
import { getStudioGenerationCheckpointCanvasProjection } from "../core/studio-generation-checkpoint.js";
import {
  createCanvasProjectionEventApplier,
  reconcileCanvasProjectionOutbox,
  replayUnconsumedCanvasProjectionEvents,
} from "../core/studio-canvas-projection-outbox.js";
import {
  discoverDuduReadonlyImportProjects,
  getDuduReadonlyImportControl,
} from "../core/dudu-readonly-import.js";
import {
  getStudioVideoPackageControl,
  toStudioVideoPackagePublicControlLookup,
  type StudioVideoPackageControlQuery,
} from "../core/studio-video-package.js";
import { buildStudioGenerationPlanProgress } from "../core/studio-generation-plan-progress.js";
import { createStudioGenerationLedgerWatcher, type StudioGenerationLedgerWatcherHandle } from "./studio-generation-ledger-watcher.js";
import { isRendererNavigationAllowed } from "./renderer-navigation-policy.js";
import { createManagedProjectBackup, restoreManagedProjectBackup } from "../core/project-backup.js";
import {
  buildAgentConnectionCliArguments,
  createExecFileAgentConnectionRunner,
  inspectAgentConnections,
} from "../core/agent-connection-config.js";
import { getStudioBindingControl, listStudioBindingUnits } from "../core/studio-binding-control.js";
import { evaluateStudioGenerationPackCurrentness } from "../core/studio-trace.js";
import { getStudioContinuityReviewControl } from "../core/studio-continuity-review-control.js";
import { getStudioScriptMediaAlignBoard } from "../core/studio-script-media-align.js";
import { inspectStudioCrossProjectAssetPackage } from "../core/studio-cross-project-asset-reuse.js";
import { getStudioScriptLibraryIndex } from "../core/studio-script-library-projection.js";
import { getStudioScriptReaderView } from "../core/studio-script-library-reader.js";
import { openStudioStoryboardWizard } from "../core/studio-storyboard-wizard.js";
import { getStudioMultimediaTimelineProjection } from "../core/studio-multimedia-timeline.js";
import {
  getStudioProductionDashboard,
  type StudioProductionDashboardQuery,
} from "../core/studio-production-dashboard.js";
import {
  buildStudioProductionProjectionBundle,
  type StudioProductionProjectionBundleQuery,
} from "../core/studio-production-projection-bundle.js";
import {
  loadStudioCanvasLayout,
  saveStudioCanvasLayout,
  type SaveStudioCanvasLayoutInput,
} from "../core/studio-canvas-layout-store.js";
import {
  runStudioCanvasWorkflowGroup,
  type StudioCanvasWorkflowRunOptions,
} from "../core/studio-canvas-workflow-runner.js";
import type { StudioCanvasWorkflowGroup } from "../core/studio-canvas-layout-types.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRuntimeWorkspace = path.resolve(currentDir, "../..");
const sourceRuntimeArtifactSourceDigest = (
  globalThis as typeof globalThis & { __AI_CANVAS_BUILD_SOURCE_DIGEST__?: string }
).__AI_CANVAS_BUILD_SOURCE_DIGEST__ ?? "";
const sourceRuntimeBootIdentity = app.isPackaged
  ? undefined
  : captureRuntimeBootIdentity({
    workspace: sourceRuntimeWorkspace,
    loadedArtifactPath: fileURLToPath(import.meta.url),
    artifactSourceDigest: sourceRuntimeArtifactSourceDigest,
  });
const sourceRuntimeGateController = createRuntimeGateController();
const sourceRuntimeIpcPerformanceProbe = createRuntimeIpcPerformanceProbe();
let runtimeBuildIdentityPromise: ReturnType<typeof resolveRuntimeBuildIdentity> | null = null;
let sourceRuntimeGateWatchers: FSWatcher[] = [];
let mainWindow: BrowserWindow | null = null;
let watcher: FSWatcher | null = null;
let semanticWatcher: FSWatcher | null = null;
let watcherTimer: NodeJS.Timeout | null = null;
let watcherScanController: AbortController | null = null;
let watchedRoot = DEFAULT_PROJECT_ROOT;
let watcherEpoch = 0;
interface LegacyWatcherIdentity {
  projectRoot: string;
  watcherEpoch: number;
}
const manualScanControllers = new Map<string, AbortController>();
const activeProjectListControllers = new Map<string, AbortController>();
const activeScanPromises = new Set<Promise<unknown>>();
const activeEditorSessions = new Map<string, string>();
let quitSessionCleanupStarted = false;

function parseProjectListRequestOptions(value: unknown): ListProjectsRequestOptions {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目清单请求参数必须是对象。");
  }
  const record = value as Record<string, unknown>;
  if (record.refreshSources !== undefined && typeof record.refreshSources !== "boolean") {
    throw new Error("refreshSources 必须是布尔值。");
  }
  if (record.sourceProjectRoot !== undefined
    && (typeof record.sourceProjectRoot !== "string"
      || !path.isAbsolute(record.sourceProjectRoot)
      || record.sourceProjectRoot.length > 4_096)) {
    throw new Error("sourceProjectRoot 必须是有效绝对路径。");
  }
  if (record.requestId !== undefined
    && (typeof record.requestId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.requestId))) {
    throw new Error("项目清单 requestId 非法。");
  }
  return {
    ...(record.refreshSources === true ? { refreshSources: true } : {}),
    ...(typeof record.sourceProjectRoot === "string" ? { sourceProjectRoot: record.sourceProjectRoot } : {}),
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
  };
}

function projectListRequestKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`;
}
type ManagedProjectOperationKind = "backup" | "restore";
type ManagedProjectOperationPhase = "idle" | "running" | "succeeded" | "failed" | "canceled";
interface ManagedProjectOperationState {
  operationId: string;
  kind?: ManagedProjectOperationKind;
  phase: ManagedProjectOperationPhase;
  busy: boolean;
  stage: string;
  sourceRoot?: string;
  targetPath?: string;
  error?: string;
  updatedAt: string;
}
interface PendingRestoredProject {
  projectRoot: string;
  rendererValidated: boolean;
  operationId: string;
}
let managedProjectOperationState: ManagedProjectOperationState = {
  operationId: "",
  phase: "idle",
  busy: false,
  stage: "当前没有备份或恢复任务。",
  updatedAt: new Date(0).toISOString(),
};
const pendingRestoredProjects = new Map<string, PendingRestoredProject>();
type CanonicalAssetIpcListInput = Pick<NonNullable<Parameters<typeof listCanonicalAssets>[1]>, "category" | "search" | "authority"> & { offset: number; limit: number };

function installSourceRuntimeWriteGate(): void {
  if (!sourceRuntimeBootIdentity) return;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => originalHandle(
    channel,
    async (...args: Parameters<typeof listener>) => {
      const effect = runtimeIpcEffect(channel);
      const mode = runtimeIpcGateMode(channel);
      const startedAt = performance.now();
      let gateDurationMs = 0;
      let failed = false;
      try {
        if (mode !== "bypass") {
          const gateStartedAt = performance.now();
          try {
            const boot = await sourceRuntimeBootIdentity;
            if (mode === "cached-read") {
              await sourceRuntimeGateController.assertReadCurrent(boot, channel);
            } else {
              await sourceRuntimeGateController.assertMutationCurrent(boot, channel);
            }
          } finally {
            // 门禁拒绝路径同样要落真实 gate 耗时，与 MCP 侧包装器保持同一观测语义。
            gateDurationMs = performance.now() - gateStartedAt;
          }
        }
        return await listener(...args);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        sourceRuntimeIpcPerformanceProbe.record({
          channel,
          effect,
          durationMs: performance.now() - startedAt,
          gateDurationMs,
          failed,
        });
      }
    },
  )) as typeof ipcMain.handle;
}

async function startSourceRuntimeGateWatchers(): Promise<void> {
  if (!sourceRuntimeBootIdentity || sourceRuntimeGateWatchers.length > 0) return;
  const boot = await sourceRuntimeBootIdentity;
  const watchPaths = sourceDigestWatchPaths(boot.workspace);
  const workspaceRoot = watchPaths[0];
  if (!workspaceRoot) throw new Error("运行时源码 watcher 缺少 workspace 根。");
  const recursiveRoots = watchPaths.slice(1);
  let watcherFailed = false;
  const observe = (watcher: FSWatcher): Promise<void> => new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    watcher.once("ready", settle);
    watcher.once("error", (error) => {
      watcherFailed = true;
      sourceRuntimeGateController.setWatcherHealthy(false);
      console.warn("[runtime-gate] 源码 watcher 失效，已退化为每批完整核验：", error);
      settle();
    });
    watcher.on("add", invalidateIfRelevant);
    watcher.on("change", invalidateIfRelevant);
    watcher.on("unlink", invalidateIfRelevant);
  });
  const invalidateIfRelevant = (changedPath: string): void => {
    if (path.resolve(changedPath) === path.resolve(boot.loadedArtifactPath)
      || sourceDigestPathIsRelevant(boot.workspace, changedPath)) {
      sourceRuntimeGateController.invalidate();
    }
  };
  const commonOptions = {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  } as const;
  const shallowRootWatcher = chokidar.watch(workspaceRoot, {
    ...commonOptions,
    depth: 0,
  });
  const recursiveSourceWatcher = chokidar.watch(
    [...recursiveRoots, boot.loadedArtifactPath],
    commonOptions,
  );
  sourceRuntimeGateWatchers = [shallowRootWatcher, recursiveSourceWatcher];
  await Promise.all(sourceRuntimeGateWatchers.map(observe));
  if (!watcherFailed) sourceRuntimeGateController.setWatcherHealthy(true);
}

async function closeSourceRuntimeGateWatchers(): Promise<void> {
  const closing = sourceRuntimeGateWatchers;
  sourceRuntimeGateWatchers = [];
  sourceRuntimeGateController.setWatcherHealthy(false);
  await Promise.all(closing.map((watcherHandle) => watcherHandle.close()));
}

async function runRuntimeGatedBackgroundWrite<T>(
  action: string,
  work: () => Promise<T>,
): Promise<T> {
  if (sourceRuntimeBootIdentity) {
    await sourceRuntimeGateController.assertMutationCurrent(
      await sourceRuntimeBootIdentity,
      `background:${action}`,
    );
  }
  return work();
}

function requireStudioCommandInput(input: unknown): StudioIdempotentCommandInput & { request: StudioPublicCommandRequest } {
  return parseStudioIdempotentCommandInput(input, "user");
}

function studioMediaUrl(projectRoot: string, target: "media" | "thumbnail" | "derivative", key: string): string {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("素材 URL 必须使用完整 SHA-256 或冻结 recipe key。");
  const url = new URL(`aicanvas-studio://${target}/${key}`);
  url.searchParams.set("projectRoot", path.resolve(projectRoot));
  return url.toString();
}

function safeStudioDerivative(projectRoot: string, record: StudioMediaDerivativeRecord) {
  const { relativePath: _relativePath, ...safe } = record;
  return {
    ...safe,
    ...(record.status === "ready" ? { url: studioMediaUrl(projectRoot, "derivative", record.recipeKey) } : {}),
  };
}

async function executableOnPath(name: string): Promise<string | null> {
  const home = os.homedir();
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const directory of [...new Set(directories)]) {
    const candidate = path.join(directory, name);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

interface BuildIdentityManifestFields {
  version: string | null;
  buildId: string | null;
  sourceDigest: string | null;
  builtAt: string | null;
  mcpToolCount: number | null;
}

async function runtimeArtifactSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/**
 * 验收 7：逐字段松散读取 release manifest 供 UI 展示。
 * 文件缺失或字段缺失/非法时对应字段如实为 null，不用运行时推算冒充构建身份。
 */
async function readBuildIdentityManifestFields(manifestPath: string): Promise<BuildIdentityManifestFields> {
  const empty: BuildIdentityManifestFields = { version: null, buildId: null, sourceDigest: null, builtAt: null, mcpToolCount: null };
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const record = parsed as Record<string, unknown>;
    const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
    return {
      version: text(record.version),
      buildId: text(record.buildId),
      sourceDigest: text(record.sourceDigest),
      builtAt: text(record.builtAt),
      mcpToolCount: typeof record.mcpToolCount === "number" && Number.isInteger(record.mcpToolCount) ? record.mcpToolCount : null,
    };
  } catch {
    return empty;
  }
}

async function packagedAgentRuntimeLaunch() {
  if (!app.isPackaged) throw new Error("Agent 连接自动配置仅允许在安装版中执行。");
  const serverPath = path.join(process.resourcesPath, "app.asar.unpacked", "dist-mcp", "mcp", "server.js");
  const releaseManifestPath = path.join(process.resourcesPath, "release-manifest.json");
  await Promise.all([access(serverPath), access(releaseManifestPath)]);
  const identity = await resolveRuntimeBuildIdentity(process.resourcesPath);
  const registryPath = process.env.AI_CANVAS_REGISTRY_PATH?.trim()
    ? path.resolve(process.env.AI_CANVAS_REGISTRY_PATH)
    : path.join(os.homedir(), ".aicanvas", "projects.json");
  return createPackagedMcpRuntimeLaunchContract({
    appExecutable: process.execPath,
    serverPath,
    releaseManifestPath,
    sourceDigest: identity.sourceDigest,
    runtimeArtifactSha256: await runtimeArtifactSha256(serverPath),
    builtAt: identity.artifactBuiltAt ?? identity.builtAt,
    workspacePath: process.resourcesPath,
    registryPath,
  });
}

function publishManagedProjectOperation(next: ManagedProjectOperationState): void {
  managedProjectOperationState = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("canvas:managed-project-operation-state", next);
  }
}

function defaultManagedProjectsRoot(): string {
  const override = process.env.AI_CANVAS_MANAGED_PROJECTS_ROOT?.trim();
  return override ? path.resolve(override) : path.join(app.getPath("documents"), "AI漫剧项目");
}

function beginManagedProjectOperation(kind: ManagedProjectOperationKind, sourceRoot?: string): string {
  if (managedProjectOperationState.busy) {
    // F-06（main 审查）：渲染层中途关窗不再回调时 busy 会永久卡死——15 分钟无更新视为卡死，安全复位后允许新任务。
    const staleMs = Date.now() - Date.parse(managedProjectOperationState.updatedAt);
    if (!Number.isFinite(staleMs) || staleMs < 15 * 60_000) {
      throw new Error(`已有${managedProjectOperationState.kind === "backup" ? "备份" : "恢复"}任务正在执行，请等待完成后重试。`);
    }
    publishManagedProjectOperation({ operationId: "", phase: "idle", busy: false, stage: "上一次任务已超时复位。", updatedAt: new Date().toISOString() });
    for (const [root, pending] of pendingRestoredProjects) {
      if (!pending.rendererValidated) pendingRestoredProjects.delete(root);
    }
  }
  const operationId = `${kind}-${randomUUID()}`;
  publishManagedProjectOperation({
    operationId,
    kind,
    phase: "running",
    busy: true,
    stage: kind === "backup" ? "等待选择备份保存位置" : "等待选择备份来源",
    ...(sourceRoot ? { sourceRoot: path.resolve(sourceRoot) } : {}),
    updatedAt: new Date().toISOString(),
  });
  return operationId;
}

function updateManagedProjectOperation(operationId: string, patch: Partial<Omit<ManagedProjectOperationState, "operationId" | "kind">>): void {
  if (managedProjectOperationState.operationId !== operationId || !managedProjectOperationState.kind) return;
  publishManagedProjectOperation({
    ...managedProjectOperationState,
    ...patch,
    operationId,
    kind: managedProjectOperationState.kind,
    updatedAt: new Date().toISOString(),
  });
}

interface CodexConfigSnapshot {
  configPath: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

async function snapshotCodexConfig(homeDirectory: string): Promise<CodexConfigSnapshot> {
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  try {
    const [content, metadata] = await Promise.all([readFile(configPath), stat(configPath)]);
    return { configPath, existed: true, content, mode: metadata.mode & 0o777 };
  } catch (reason) {
    if (reason instanceof Error && "code" in reason && (reason as NodeJS.ErrnoException).code === "ENOENT") {
      return { configPath, existed: false };
    }
    throw reason;
  }
}

async function restoreCodexConfig(snapshot: CodexConfigSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.configPath, { force: true });
    return;
  }
  await mkdir(path.dirname(snapshot.configPath), { recursive: true, mode: 0o700 });
  const temporary = `${snapshot.configPath}.${process.pid}.${randomUUID()}.rollback`;
  try {
    await writeFile(temporary, snapshot.content!, { flag: "wx", mode: snapshot.mode ?? 0o600 });
    await chmod(temporary, snapshot.mode ?? 0o600);
    await rename(temporary, snapshot.configPath);
  } catch (reason) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw reason;
  }
}

async function repairCodexConnectionOnly(input: {
  homeDirectory: string;
  codexExecutable: string;
  launch: Awaited<ReturnType<typeof packagedAgentRuntimeLaunch>>;
}): Promise<{
  backupDirectory: string;
  codex: Awaited<ReturnType<typeof inspectAgentConnections>>["codex"];
  grok: Awaited<ReturnType<typeof inspectAgentConnections>>["grok"];
}> {
  const snapshot = await snapshotCodexConfig(input.homeDirectory);
  const backupParent = path.join(input.homeDirectory, ".aicanvas", "agent-config-backups");
  await mkdir(backupParent, { recursive: true, mode: 0o700 });
  await chmod(backupParent, 0o700);
  const backupDirectory = path.join(backupParent, `${new Date().toISOString().replace(/[:.]/gu, "-")}-codex-${randomUUID().slice(0, 8)}`);
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  const backupPath = path.join(backupDirectory, snapshot.existed ? "codex-config.toml" : "codex-config.toml.missing");
  await writeFile(backupPath, snapshot.existed ? snapshot.content! : "original-config-missing\n", { flag: "wx", mode: 0o600 });
  await chmod(backupPath, 0o600);

  const runner = createExecFileAgentConnectionRunner();
  const env = { ...process.env, HOME: path.resolve(input.homeDirectory) };
  try {
    await runner(input.codexExecutable, buildAgentConnectionCliArguments("codex", input.launch), { env, timeoutMs: 30_000 });
    await chmod(snapshot.configPath, 0o600);
    const inspection = await inspectAgentConnections({
      homeDirectory: input.homeDirectory,
      codexExecutable: input.codexExecutable,
      launch: input.launch,
    }, runner);
    if (!inspection.codex.current) throw new Error("Codex CLI 写入后连接身份仍不一致。");
    return { backupDirectory, codex: inspection.codex, grok: inspection.grok };
  } catch (reason) {
    await restoreCodexConfig(snapshot);
    throw new Error(`Codex 连接修复失败，原配置已回滚：${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

// P21：生成计划进度投影——对受管工程 .aicanvas/ 目录常驻监听（独立于 startWatcher
// 的受管早退），任何进程（含 MCP stdio）写 generation ledger 都会触发有界失效信号。
let generationLedgerWatcher: StudioGenerationLedgerWatcherHandle | null = null;
let generationLedgerWatchedRoot: string | null = null;

function broadcastStudioGenerationProgress(payload: { projectId: string; projectionHash: string }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("canvas:studio-generation-progress", payload);
  }
}

let generationLedgerWatcherChain: Promise<void> = Promise.resolve();
async function ensureStudioGenerationLedgerWatcher(projectRoot: string): Promise<void> {
  // F-08b（main 审查）：check→close→create 串行化，防并发不同 root 调用产生孤儿 watcher。
  const next = generationLedgerWatcherChain.then(() => ensureStudioGenerationLedgerWatcherExclusive(projectRoot));
  generationLedgerWatcherChain = next.catch(() => undefined);
  return next;
}

async function ensureStudioGenerationLedgerWatcherExclusive(projectRoot: string): Promise<void> {
  const targetRoot = path.resolve(projectRoot);
  if (generationLedgerWatchedRoot === targetRoot && generationLedgerWatcher) return;
  if (generationLedgerWatcher) {
    await generationLedgerWatcher.close();
    generationLedgerWatcher = null;
  }
  generationLedgerWatchedRoot = targetRoot;
  generationLedgerWatcher = createStudioGenerationLedgerWatcher({
    projectRoot: targetRoot,
    resolveProjectId: async () => (await getManagedProjectShell(targetRoot))?.project.id ?? null,
    send: broadcastStudioGenerationProgress,
    onError: (message) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("canvas:watch-error", message);
      }
    },
  });
}

/** P21 §2.5 快路径：main 本地生成变更命令提交成功后直接触发（不等待 watcher）。 */
const STUDIO_GENERATION_PROGRESS_COMMANDS = new Set([
  "dispatch_studio_generation_pack",
  "register_studio_generation_result",
  "prepare_studio_imagegen_call",
  "reconcile_studio_imagegen_call",
  "abandon_studio_generation_unknown",
  "abandon_studio_detached_generation_unknown",
  "rebind_studio_imagegen_call_context",
  "commit_agent_imagegen_result_bundle",
  "submit_studio_generation_review",
  "create_studio_generation_plan",
  "fail_studio_generation_run",
  "cancel_studio_generation_run",
  "retry_studio_generation_plan_nodes",
]);

/**
 * T11 outbox 包装层命令：Review/连续性 owner 文件不在可改范围，其 schema 合同
 * 禁止外挂 trigger，无法与源写入同一 SQLite 事务追加事件；这些命令提交成功后
 * 在此补缀（派生 eventId + INSERT OR IGNORE 幂等），启动 reconcile 兜底最终一致。
 */
const CANVAS_PROJECTION_OUTBOX_RECONCILE_COMMANDS = new Set([
  "submit_studio_generation_review",
  "append_studio_continuity_observation",
  "append_studio_continuity_correction",
]);

/**
 * T11：补缀 Review/连续性源事实并重放未消费画布投影事件。
 * 消费方按 projectionRevision 幂等应用（重复事件不产生重复节点）；
 * 任何失败仅记诊断，绝不阻断启动或命令返回。
 */
async function reconcileAndReplayCanvasProjectionOutbox(projectRoot: string, label: string): Promise<void> {
  try {
    const databasePath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
    if (!existsSync(databasePath)) return;
    const db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      db.exec("PRAGMA busy_timeout=5000;");
      reconcileCanvasProjectionOutbox(db);
      const applier = createCanvasProjectionEventApplier();
      const replay = replayUnconsumedCanvasProjectionEvents(db, (event) => {
        applier.apply(event);
      });
      if (replay.error) {
        console.warn(`[canvas-outbox] ${label}：重放部分失败（保持未消费等待下次重放）：${replay.error}`);
      }
      if (replay.consumed > 0) {
        // 有投影事件被消费：立刻通知 renderer 刷新投影，不丢正式节点。
        void generationLedgerWatcher?.emitNow().catch(() => undefined);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn(
      `[canvas-outbox] ${label}：失败（不阻断）：`,
      error instanceof Error ? error.message : String(error),
    );
  }
}


async function requireManagedStudioProject(projectRoot: string): Promise<NonNullable<Awaited<ReturnType<typeof getManagedProjectShell>>>> {
  const shell = await getManagedProjectShell(projectRoot);
  if (!shell) throw new Error("该项目不是受管素材工程，禁止写入素材知识库。");
  await ensureStudioGenerationLedgerWatcher(shell.paths.root);
  return shell;
}

async function requireManagedStudioProjectReadOnly(
  projectRoot: string,
): Promise<Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>> {
  try {
    return await inspectManagedProjectReadOnly(projectRoot);
  } catch (error) {
    throw new Error("该项目不是可安全只读的受管素材工程。", { cause: error });
  }
}

async function pickAndImportStudioText(
  projectRoot: string,
  kind: "script" | "prompt",
): Promise<{ imported: boolean; entryId?: string; unchanged?: boolean; revision?: unknown }> {
  await requireManagedStudioProject(projectRoot);
  if (!mainWindow) return { imported: false };
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: kind === "script" ? "导入剧本到受管生产知识库" : "导入提示词到受管生产知识库",
    properties: ["openFile"],
    filters: [{ name: kind === "script" ? "剧本文本" : "提示词文本", extensions: ["md", "txt"] }],
  });
  const filePath = picked.filePaths[0];
  if (picked.canceled || !filePath) return { imported: false };
  const bytes = await readFile(filePath);
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error(`单个${kind === "script" ? "剧本" : "提示词"}文本不得超过 16 MiB。`);
  const body = bytes.toString("utf8");
  const pathDigest = createHash("sha256").update(path.resolve(filePath)).digest("hex");
  const bodyDigest = createHash("sha256").update(body, "utf8").digest("hex");
  const documentId = `${kind}-${pathDigest.slice(0, 32)}`;
  let document = await getStudioTextDocument(projectRoot, documentId);
  if (!document) {
    const payload = { id: documentId, title: path.basename(filePath, path.extname(filePath)), expectedRevision: 0 as const };
    const created = await executeIdempotentCommand(projectRoot, {
      requestId: `ui-${kind}-create-${randomUUID()}`,
      idempotencyKey: `studio-${kind}-create-${documentId}`,
      request: kind === "script"
        ? { command: "create_studio_script_document", payload }
        : { command: "create_studio_prompt_document", payload },
    });
    document = (created.result ?? null) as Awaited<ReturnType<typeof getStudioTextDocument>>;
  }
  if (!document || document.kind !== kind) throw new Error(`${kind === "script" ? "剧本" : "提示词"}文档身份建立失败。`);
  const latest = await getLatestStudioTextRevisionMetadata(projectRoot, documentId);
  if (latest?.bodySha256 === bodyDigest) return { imported: true, entryId: documentId, unchanged: true };
  const payload = {
    documentId,
    expectedRevision: document.revision,
    body,
    source: path.resolve(filePath),
    sourceVersion: bodyDigest,
  };
  const appended = await executeIdempotentCommand(projectRoot, {
    requestId: `ui-${kind}-revision-${randomUUID()}`,
    idempotencyKey: `studio-${kind}-revision-${documentId}-r${document.revision}-${bodyDigest}`,
    request: kind === "script"
      ? { command: "append_studio_script_revision", payload }
      : { command: "append_studio_prompt_revision", payload },
  });
  return { imported: true, entryId: documentId, revision: appended.result };
}

function requireCanonicalProjectRoot(projectRoot: unknown): string {
  if (typeof projectRoot !== "string" || !projectRoot.trim() || !path.isAbsolute(projectRoot.trim())) {
    throw new Error("规范资产请求必须提供非空绝对 projectRoot。");
  }
  return path.normalize(projectRoot.trim());
}

function requireCanonicalAssetId(assetId: unknown): string {
  if (typeof assetId !== "string" || !assetId.trim() || assetId.trim().length > 200) {
    throw new Error("规范资产请求必须提供 1–200 字符的 assetId。");
  }
  return assetId.trim();
}

function requireCanonicalAssetListInput(input: unknown): CanonicalAssetIpcListInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("规范资产列表请求必须提供分页参数。");
  const value = input as Record<string, unknown>;
  const allowedKeys = new Set(["category", "search", "authority", "offset", "limit"]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`规范资产列表请求包含未支持参数：${unknownKey}`);
  if (typeof value.offset !== "number" || !Number.isInteger(value.offset) || value.offset < 0) throw new Error("offset 必须是大于等于 0 的整数。");
  if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100) throw new Error("limit 必须是 1–100 的整数。");
  if (value.category !== undefined && !["any", "character", "scene", "prop"].includes(String(value.category))) throw new Error("category 必须是 any、character、scene 或 prop。");
  if (value.search !== undefined && (typeof value.search !== "string" || value.search.trim().length > 200)) throw new Error("search 必须是不超过 200 字符的字符串。");
  if (value.authority !== undefined && !["any", "with-authority", "without-authority"].includes(String(value.authority))) throw new Error("authority 必须是 any、with-authority 或 without-authority。");
  return {
    category: value.category as "any" | "character" | "scene" | "prop" | undefined,
    search: typeof value.search === "string" ? value.search.trim() : undefined,
    authority: value.authority as "any" | "with-authority" | "without-authority" | undefined,
    offset: value.offset,
    limit: value.limit,
  };
}

async function cleanupActiveEditorSessions(): Promise<void> {
  const entries = [...activeEditorSessions.entries()];
  activeEditorSessions.clear();
  await Promise.all(entries.map(([projectRoot, sessionId]) => closeEditorSession(projectRoot, sessionId).catch(() => undefined)));
}

async function trackActiveScan<T>(operation: Promise<T>): Promise<T> {
  activeScanPromises.add(operation);
  try {
    return await operation;
  } finally {
    activeScanPromises.delete(operation);
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "aicanvas-asset",
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: "aicanvas-studio",
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
  },
]);

async function createWindow(): Promise<void> {
  const packagedRendererEntry = path.join(currentDir, "../renderer/index.html");
  // 安装态忽略外部注入的 ELECTRON_RENDERER_URL；只有真实开发进程可以启用 dev origin。
  const devRendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const requestedWidth = Math.max(1_180, Math.min(3_840, Number(process.env.AI_CANVAS_WINDOW_WIDTH) || 1_560));
  const requestedHeight = Math.max(720, Math.min(2_160, Number(process.env.AI_CANVAS_WINDOW_HEIGHT) || 980));
  mainWindow = new BrowserWindow({
    width: requestedWidth,
    height: requestedHeight,
    minWidth: 1180,
    minHeight: 720,
    title: "AI 漫剧画布",
    backgroundColor: "#111210",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(currentDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  // P27（main 审查 F-05）：新窗口与导航纵深防御——外链仅 https 经系统浏览器打开，主 frame 只允许本地文件与本地开发服务器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isRendererNavigationAllowed(url, {
      ...(devRendererUrl ? { devRendererUrl } : {}),
      packagedEntryPath: packagedRendererEntry,
    })) event.preventDefault();
  });
  const currentWindow = mainWindow;
  let closeAfterSessionCleanup = false;
  mainWindow.on("close", (event) => {
    if (closeAfterSessionCleanup || activeEditorSessions.size === 0) return;
    event.preventDefault();
    void cleanupActiveEditorSessions().finally(() => {
      closeAfterSessionCleanup = true;
      currentWindow.close();
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const launchImportRoot = process.env.AI_CANVAS_IMPORT_ROOT;
  if (devRendererUrl) {
    const rendererUrl = new URL(devRendererUrl);
    if (launchImportRoot) rendererUrl.searchParams.set("importRoot", launchImportRoot);
    await mainWindow.loadURL(rendererUrl.toString());
  } else {
    await mainWindow.loadFile(packagedRendererEntry, launchImportRoot ? { query: { importRoot: launchImportRoot } } : undefined);
  }

  const screenshotPath = process.env.AI_CANVAS_SCREENSHOT;
  if (screenshotPath) {
    let continuationAutomation: unknown;
    let taskAutomation: unknown;
    let adaptationAutomation: unknown;
    let adaptationImpactAutomation: unknown;
    let analysisReviewAutomation: unknown;
    let performanceProbe: unknown;
    let performanceProbePromise: Promise<void> | null = null;
    let p2324Probe: unknown;
    let p2324ProbePromise: Promise<void> | null = null;
    const screenshotDelay = Math.max(1_500, Number(process.env.AI_CANVAS_SCREENSHOT_DELAY_MS) || 2_000);
    const screenshotView = process.env.AI_CANVAS_SCREENSHOT_VIEW;
    if (screenshotView) {
      setTimeout(() => {
        const label = JSON.stringify(screenshotView);
        void mainWindow?.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.module-nav button')).find((button) => button.textContent?.includes(${label}))?.click()`,
        );
      }, Math.min(1_500, Math.round(screenshotDelay / 2)));
    }
    if (process.env.AI_CANVAS_NARRATIVE_CANVAS === "1") {
      setTimeout(() => { void mainWindow?.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toggle-row')).find((label) => label.textContent?.includes('显示小说叙事链'))?.querySelector('input')?.click()`); }, Math.min(2_500, Math.round(screenshotDelay * .38)));
    }
    const continuationTab = process.env.AI_CANVAS_CONTINUATION_TAB;
    if (continuationTab) {
      setTimeout(() => {
        const label = JSON.stringify(continuationTab);
        void mainWindow?.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.continuation-header nav button')).find((button) => button.textContent?.includes(${label}))?.click()`);
      }, Math.min(2_500, Math.round(screenshotDelay * 0.45)));
    }
    const storyMode = process.env.AI_CANVAS_STORY_MODE;
    if (storyMode) {
      setTimeout(() => {
        const label = JSON.stringify(storyMode);
        void mainWindow?.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.story-header nav button')).find((button) => button.textContent?.includes(${label}))?.click()`);
      }, Math.min(2_500, Math.round(screenshotDelay * 0.45)));
    }
    // P25：受管画布主题皮肤截图探针——截图前写入主题键并重载（仅截图链路，生产行为零影响）。
    const canvasThemeProbe = process.env.AI_CANVAS_CANVAS_THEME_PROBE;
    if (canvasThemeProbe) {
      setTimeout(() => {
        const theme = JSON.stringify(canvasThemeProbe);
        void mainWindow?.webContents.executeJavaScript(
          `(() => { try { window.localStorage.setItem("managed-canvas-theme", ${theme}); window.location.reload(); } catch { /* 探针路径忽略 */ } })()`,
        );
      }, Math.min(2_000, Math.round(screenshotDelay / 3)));
    }
    if (process.env.AI_CANVAS_ADAPTATION_PROBE === "1") {
      setTimeout(async () => {
        if (!mainWindow) return;
        const click = async (selector: string, index = 0) => {
          const point = await mainWindow!.webContents.executeJavaScript(`(() => { const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
          if (!point) throw new Error(`找不到自动改编控件：${selector}[${index}]`);
          for (const event of [{ type: "mouseMove" as const, x: point.x, y: point.y }, { type: "mouseDown" as const, x: point.x, y: point.y, button: "left" as const, clickCount: 1 }, { type: "mouseUp" as const, x: point.x, y: point.y, button: "left" as const, clickCount: 1 }]) mainWindow!.webContents.sendInputEvent(event);
          await new Promise((resolve) => setTimeout(resolve, 260));
        };
        try {
          await click(".adaptation-toolbar nav button", 0);
          await click(".adaptation-toolbar nav button", 1);
          await click(".fact-list > button", 1);
          await click(".beat-sequence > button", 1);
          await click(".shot-list > button", 1);
          const validatePoint = await mainWindow.webContents.executeJavaScript(`(() => { const element = Array.from(document.querySelectorAll('.plan-actions button')).find((button) => button.textContent?.includes('校验')); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
          if (validatePoint) {
            for (const event of [{ type: "mouseMove" as const, x: validatePoint.x, y: validatePoint.y }, { type: "mouseDown" as const, x: validatePoint.x, y: validatePoint.y, button: "left" as const, clickCount: 1 }, { type: "mouseUp" as const, x: validatePoint.x, y: validatePoint.y, button: "left" as const, clickCount: 1 }]) mainWindow.webContents.sendInputEvent(event);
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          adaptationAutomation = await mainWindow.webContents.executeJavaScript(`({ ok: true, activePlan: document.querySelector('.adaptation-toolbar nav button.active')?.textContent?.trim(), selectedFact: document.querySelector('.fact-list > button.active')?.textContent?.trim(), selectedBeat: document.querySelector('.beat-sequence > button.active')?.textContent?.trim(), selectedShot: document.querySelector('.shot-list > button.active')?.textContent?.trim(), validation: document.querySelector('.toolbar-status')?.textContent?.trim(), toast: document.querySelector('.toast-message')?.textContent?.trim() })`);
        } catch (error) { adaptationAutomation = { ok: false, error: String(error) }; }
      }, Math.min(4_200, Math.round(screenshotDelay * 0.48)));
    }
    if (process.env.AI_CANVAS_ADAPTATION_IMPACT_PROBE === "1") {
      setTimeout(async () => {
        if (!mainWindow) return;
        try {
          adaptationImpactAutomation = { ok: false, stage: "started" };
          const target = await mainWindow.webContents.executeJavaScript(`(() => { const element = document.querySelector('.fact-editor textarea'); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
          if (!target) throw new Error("找不到事实编辑器");
          adaptationImpactAutomation = { ok: false, stage: "editor-found", target };
          for (const event of [{ type: "mouseMove" as const, x: target.x, y: target.y }, { type: "mouseDown" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 }, { type: "mouseUp" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 }]) mainWindow.webContents.sendInputEvent(event);
          await mainWindow.webContents.insertText("（局部影响验证）");
          adaptationImpactAutomation = { ok: false, stage: "text-inserted", target };
          const save = await mainWindow.webContents.executeJavaScript(`(async () => { const element = document.querySelector('.fact-editor button[type="submit"]'); if (!element) return null; element.scrollIntoView({ block: 'center' }); await new Promise((resolve) => setTimeout(resolve, 180)); const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
          if (!save) throw new Error("找不到事实保存按钮");
          adaptationImpactAutomation = { ok: false, stage: "save-found", target, save };
          for (const event of [{ type: "mouseMove" as const, x: save.x, y: save.y }, { type: "mouseDown" as const, x: save.x, y: save.y, button: "left" as const, clickCount: 1 }, { type: "mouseUp" as const, x: save.x, y: save.y, button: "left" as const, clickCount: 1 }]) mainWindow.webContents.sendInputEvent(event);
          await new Promise((resolve) => setTimeout(resolve, 350));
          const mouseSubmitted = await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.impact-bar'))`);
          if (!mouseSubmitted) {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.fact-editor button[type="submit"]')?.focus()`);
            mainWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
            mainWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          }
          for (let attempt = 0; attempt < 30; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const result = await mainWindow.webContents.executeJavaScript(`(() => ({ text: document.querySelector('.impact-bar')?.textContent?.trim() ?? '', toast: document.querySelector('.toast-message')?.textContent?.trim() ?? '' }))()`);
            if (result.text) { adaptationImpactAutomation = { ok: true, ...result }; return; }
            adaptationImpactAutomation = { ok: false, stage: "waiting-impact", attempt, target, save, ...result };
          }
          adaptationImpactAutomation = { ok: false, reason: "impact-bar-timeout" };
        } catch (error) { adaptationImpactAutomation = { ok: false, error: String(error) }; }
      }, Math.min(5_000, Math.round(screenshotDelay * 0.52)));
    }
    if (process.env.AI_CANVAS_ANALYSIS_REVIEW_PROBE === "1") {
      setTimeout(async () => {
        if (!mainWindow) return;
        try {
          const target = await mainWindow.webContents.executeJavaScript(`(() => { const items = document.querySelectorAll('.review-ticker button'); const element = items[1] ?? items[0]; if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
          if (!target) throw new Error("找不到模型提案审核入口");
          for (const event of [{ type: "mouseMove" as const, x: target.x, y: target.y }, { type: "mouseDown" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 }, { type: "mouseUp" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 }]) mainWindow.webContents.sendInputEvent(event);
          await new Promise((resolve) => setTimeout(resolve, 700));
          analysisReviewAutomation = await mainWindow.webContents.executeJavaScript(`({ ok: Boolean(document.querySelector('.review-drawer')), selected: document.querySelector('.review-inspector h3')?.textContent?.trim(), issues: Array.from(document.querySelectorAll('.review-issue')).map((item) => item.textContent?.trim()), acceptDisabled: document.querySelector('.review-decisions button:first-child')?.disabled })`);
        } catch (error) { analysisReviewAutomation = { ok: false, error: String(error) }; }
      }, Math.min(4_500, Math.round(screenshotDelay * 0.55)));
    }
    const designTab = process.env.AI_CANVAS_DESIGN_TAB;
    if (designTab) {
      setTimeout(() => {
        const label = JSON.stringify(designTab);
        void mainWindow?.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.design-header nav button')).find((button) => button.textContent?.includes(${label}))?.click()`);
      }, Math.min(2_500, Math.round(screenshotDelay * 0.45)));
    }
    const storyContextItem = process.env.AI_CANVAS_STORY_CONTEXT_ITEM;
    if (storyContextItem) {
      setTimeout(() => {
        const value = JSON.stringify(storyContextItem);
        void mainWindow?.webContents.executeJavaScript(`void (async () => { const select = document.querySelector('.story-actions select'); if (!select) return; select.value = ${value}; select.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 180)); Array.from(document.querySelectorAll('.story-actions button')).find((button) => button.textContent?.includes('生产上下文'))?.click(); })()`);
      }, Math.min(4_000, Math.round(screenshotDelay * 0.62)));
    }
    const editorSeekSeconds = Number(process.env.AI_CANVAS_EDITOR_SEEK_SECONDS);
    if (Number.isFinite(editorSeekSeconds) && editorSeekSeconds > 0) {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(`void (() => { const input = document.querySelector('.transport input[type="range"]'); if (!input) return; input.value = ${editorSeekSeconds}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.timeline-clip.subtitle')?.click(); })()`);
      }, Math.min(4_500, Math.round(screenshotDelay * 0.68)));
    }
    if (process.env.AI_CANVAS_PREPARE_CONTINUATION === "1") {
      setTimeout(async () => {
        const target = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          let button;
          for (let attempt = 0; attempt < 80; attempt += 1) {
            button = Array.from(document.querySelectorAll('.timeline-tools button')).find((entry) => entry.textContent?.includes('末帧续视频'));
            if (button && !button.disabled) break;
            await sleep(150);
          }
          if (!button) return { ok: false, reason: 'button-not-found' };
          if (button.disabled) return { ok: false, reason: 'button-disabled', text: button.textContent?.trim() };
          const rect = button.getBoundingClientRect();
          return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), value: document.querySelector('.timeline-tools select')?.value ?? '' };
        })()`).catch((error) => ({ ok: false, reason: "locate-error", error: String(error) }));
        if (!target?.ok || !mainWindow) {
          continuationAutomation = target;
          return;
        }
        for (const event of [
          { type: "mouseMove" as const, x: target.x, y: target.y },
          { type: "mouseDown" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 },
          { type: "mouseUp" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 },
        ]) mainWindow.webContents.sendInputEvent(event);
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const result = await mainWindow.webContents.executeJavaScript(`(() => {
            const toast = document.querySelector('.toast-message');
            return { toast: toast?.textContent?.trim() ?? '', error: toast?.classList.contains('error') ?? false, buttonText: Array.from(document.querySelectorAll('.timeline-tools button')).find((entry) => entry.textContent?.includes('末帧续视频'))?.textContent?.trim() ?? '' };
          })()`).catch((error) => ({ toast: "", error: true, buttonText: "", executeError: String(error) }));
          if (result.toast.includes("时间线末帧已登记为续接首帧")) {
            continuationAutomation = { ok: true, targetItemId: target.value, message: result.toast };
            return;
          }
          if (result.error && result.toast) {
            continuationAutomation = { ok: false, reason: "ui-reported-failure", targetItemId: target.value, message: result.toast };
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        continuationAutomation = { ok: false, reason: "completion-timeout", targetItemId: target.value };
      }, Math.min(4_800, Math.round(screenshotDelay * 0.58)));
    }
    if (process.env.AI_CANVAS_TASK_CLAIM === "1") {
      setTimeout(async () => {
        const target = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const button = Array.from(document.querySelectorAll('.task-pack footer button')).find((entry) => entry.textContent?.trim() === '领取');
            if (button && !button.disabled) { const rect = button.getBoundingClientRect(); return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; }
            await sleep(150);
          }
          return { ok: false, reason: 'claim-button-not-ready' };
        })()`).catch((error) => ({ ok: false, reason: "locate-error", error: String(error) }));
        if (!target?.ok || !mainWindow) { taskAutomation = target; return; }
        for (const event of [
          { type: "mouseMove" as const, x: target.x, y: target.y },
          { type: "mouseDown" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 },
          { type: "mouseUp" as const, x: target.x, y: target.y, button: "left" as const, clickCount: 1 },
        ]) mainWindow.webContents.sendInputEvent(event);
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const result = await mainWindow.webContents.executeJavaScript(`(() => ({ text: document.querySelector('.task-pack')?.textContent ?? '', toast: document.querySelector('.toast-message')?.textContent?.trim() ?? '', error: document.querySelector('.toast-message')?.classList.contains('error') ?? false }))()`).catch((error) => ({ text: "", toast: String(error), error: true }));
          if (result.text.includes("desktop-app") && result.text.includes("租约至")) { taskAutomation = { ok: true, message: result.toast || "任务租约已显示" }; return; }
          if (result.error && result.toast) { taskAutomation = { ok: false, reason: "ui-reported-failure", message: result.toast }; return; }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        taskAutomation = { ok: false, reason: "completion-timeout" };
      }, Math.min(4_800, Math.round(screenshotDelay * 0.58)));
    }
    if (process.env.AI_CANVAS_PERF_PROBE === "1") {
      // 后台/被遮挡窗口的 rAF 会被 Chromium 节流冻结，探针的 paint() 双 rAF 曾因此永久挂起；
      // 关闭后台节流，保证探针在任何窗口状态下都能取到帧。
      mainWindow?.webContents.setBackgroundThrottling(false);
      setTimeout(() => {
        performanceProbePromise = (async () => {
          performanceProbe = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const waitUntil = async (predicate, timeout = 2500) => { const started = performance.now(); while (performance.now() - started < timeout) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 40)); } return false; };
          const measure = async (action) => { const started = performance.now(); await action(); await paint(); return Math.round((performance.now() - started) * 100) / 100; };
          const diagnostics = window.aiCanvasDiagnostics;
          if (!diagnostics) return { ok: false, error: 'canvas-diagnostics-unavailable' };
          const interactions = {};
          const episode = document.querySelector('.episode-select');
          if (episode) interactions.showAllEpisodesMs = await measure(async () => { episode.value = 'all'; episode.dispatchEvent(new Event('change', { bubbles: true })); await waitUntil(() => diagnostics.snapshot().logicalProductionNodes === 400); });
          const allEpisodes = diagnostics.snapshot();
          const search = document.querySelector('.search-box input');
          let filtered;
          if (search) {
            interactions.filterMs = await measure(async () => { search.value = '压力测试镜头 0400'; search.dispatchEvent(new Event('input', { bubbles: true })); await waitUntil(() => diagnostics.snapshot().logicalProductionNodes === 1); });
            filtered = diagnostics.snapshot();
            interactions.clearFilterMs = await measure(async () => { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); await waitUntil(() => diagnostics.snapshot().logicalProductionNodes === 400); });
          }
          const zoomBefore = diagnostics.snapshot().viewport.zoom;
          let zoomAfterIn = zoomBefore;
          interactions.zoomInMs = await measure(async () => { await diagnostics.setZoom(Math.min(1.8, zoomBefore + .18)); await waitUntil(() => diagnostics.snapshot().viewport.zoom > zoomBefore + .01); });
          zoomAfterIn = diagnostics.snapshot().viewport.zoom;
          interactions.zoomOutMs = await measure(async () => { await diagnostics.setZoom(zoomBefore); await waitUntil(() => diagnostics.snapshot().viewport.zoom < zoomAfterIn - .01); });
          const initialDomIds = Array.from(document.querySelectorAll('.vue-flow__node-production')).map((entry) => entry.getAttribute('data-id')).filter(Boolean);
          const targetNodeId = 'main-ep10-unit040';
          interactions.focusLastNodeMs = await measure(async () => { await diagnostics.focusNode(targetNodeId, .62); await waitUntil(() => Array.from(document.querySelectorAll('.vue-flow__node-production')).some((entry) => entry.getAttribute('data-id') === targetNodeId)); });
          const focusedDom = Array.from(document.querySelectorAll('.vue-flow__node-production'));
          const focusedDomIds = focusedDom.map((entry) => entry.getAttribute('data-id')).filter(Boolean);
          const targetElement = focusedDom.find((entry) => entry.getAttribute('data-id') === targetNodeId);
          const targetImages = Array.from(targetElement?.querySelectorAll('img') ?? []);
          const intervals = [];
          let previous = performance.now();
          for (let index = 0; index < 90; index += 1) await new Promise((resolve) => requestAnimationFrame((now) => { intervals.push(now - previous); previous = now; resolve(); }));
          const sorted = intervals.slice(1).sort((a, b) => a - b);
          const percentile = (value) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0) * 100) / 100;
          const images = Array.from(document.querySelectorAll('.production-node img'));
          const finalSnapshot = diagnostics.snapshot();
          const checks = {
            all400LogicalNodes: allEpisodes.logicalProductionNodes === 400,
            filterExactOne: filtered?.logicalProductionNodes === 1 && filtered?.productionNodeIds?.[0] === targetNodeId,
            autoLayoutNoDuplicates: allEpisodes.duplicatePositionPairs.length === 0,
            autoLayoutNoOverlaps: allEpisodes.overlapPairs.length === 0,
            zoomChanged: zoomAfterIn > zoomBefore + .01,
            lastNodeRenderedAfterPan: focusedDomIds.includes(targetNodeId),
            firstNodeUnloadedAfterPan: !focusedDomIds.includes('main-ep01-unit001'),
            targetThumbnailDecoded: targetImages.length > 0 && targetImages.every((entry) => entry.complete && entry.naturalWidth > 0),
            boundedDomImages: images.length <= 12,
          };
          return {
            ok: Object.values(checks).every(Boolean),
            checks,
            visibleCaption: document.querySelector('.canvas-caption')?.textContent?.trim() ?? '',
            logicalProductionNodes: finalSnapshot.logicalProductionNodes,
            vueFlowNodesInDom: document.querySelectorAll('.vue-flow__node').length,
            productionNodesInDom: document.querySelectorAll('.production-node').length,
            images: { total: images.length, decoded: images.filter((entry) => entry.complete && entry.naturalWidth > 0).length },
            viewport: { before: zoomBefore, afterZoomIn: zoomAfterIn, final: finalSnapshot.viewport },
            virtualization: { initialDomIds, focusedDomIds, targetNodeId },
            layout: { duplicatePositionPairs: allEpisodes.duplicatePositionPairs, overlapPairs: allEpisodes.overlapPairs },
            interactions,
            frames: { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: Math.round((sorted.at(-1) ?? 0) * 100) / 100 },
            heapUsedBytes: performance.memory?.usedJSHeapSize,
          };
        })()`).catch((error) => ({ ok: false, error: String(error) }));
        })();
      }, Math.min(7_000, Math.round(screenshotDelay * 0.55)));
    }
    // P23/P24 GLOBAL_VALIDATING 探针：真实 Electron 画布拖拽吸附/组拖/undo + U1–U4 诊断面。
    if (process.env.AI_CANVAS_P23_P24_PROBE === "1") {
      mainWindow?.webContents.setBackgroundThrottling(false);
      setTimeout(() => {
        p2324ProbePromise = (async () => {
          const win = mainWindow;
          if (!win) { p2324Probe = { ok: false, error: "main-window-missing" }; return; }
          const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const evalJs = async (code: string) => win.webContents.executeJavaScript(code);
          const waitForTruthyEval = async (code: string, timeoutMilliseconds = 12_000): Promise<unknown> => {
            const deadline = Date.now() + timeoutMilliseconds;
            let lastValue: unknown;
            do {
              lastValue = await evalJs(code);
              if (lastValue) return lastValue;
              await sleep(200);
            } while (Date.now() < deadline);
            throw new Error(`等待 UI 条件超时：${code.slice(0, 120)}；last=${String(lastValue)}`);
          };
          const mouse = async (type: "mouseMove" | "mouseDown" | "mouseUp", x: number, y: number, modifiers: Array<"shift" | "control" | "ctrl" | "alt" | "meta" | "command" | "cmd"> = []) => {
            win.webContents.sendInputEvent(type === "mouseMove" ? { type, x, y } : { type, x, y, button: "left", clickCount: 1, ...(modifiers.length ? { modifiers } : {}) });
            await sleep(type === "mouseMove" ? 35 : 70);
          };
          const rectOf = async (id: string) => evalJs(`(() => { const el = document.querySelector('.vue-flow__node[data-id="${id}"]'); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width) }; })()`);
          const keyCombo = async (keyCode: string, modifiers: Array<"shift" | "control" | "ctrl" | "alt" | "meta" | "command" | "cmd">) => {
            win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
            await sleep(60);
            win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
          };
          const keyHold = async (keyCode: string, down: boolean) => {
            win.webContents.sendInputEvent({ type: down ? "keyDown" : "keyUp", keyCode });
            await sleep(50);
          };
          const checks: Record<string, boolean> = {};
          const notes: Record<string, unknown> = {};
          try {
            // undo-empty 模式：仅核验重启/切工程后 undo/redo 按钮禁用（栈不跨会话/不跨工程），不做任何拖拽。
            if (process.env.AI_CANVAS_P23_P24_MODE === "undo-empty") {
              await evalJs(`(document.getElementById('studio-mode-canvas') ?? Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '无限画布'))?.click()`);
              await sleep(3_000);
              const states = await evalJs(`({ undo: document.querySelector('[data-testid="managed-canvas-undo"]')?.disabled ?? null, redo: document.querySelector('[data-testid="managed-canvas-redo"]')?.disabled ?? null, canvasMounted: Boolean(document.querySelector('[data-testid="managed-studio-canvas-view"]')) })`) as { undo: boolean | null; redo: boolean | null; canvasMounted: boolean };
              checks.canvasMounted = states.canvasMounted;
              checks.undoDisabled = states.undo === true;
              checks.redoDisabled = states.redo === true;
              p2324Probe = { ok: Object.values(checks).every(Boolean), checks, notes: states };
              return;
            }
            await evalJs(`(document.getElementById('studio-mode-canvas') ?? Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '无限画布'))?.click()`);
            await sleep(3_500);
            const nodeIds = await evalJs(`Array.from(document.querySelectorAll('.vue-flow__node')).map((el) => el.getAttribute('data-id')).filter(Boolean)`) as string[];
            notes.nodeIds = nodeIds;
            const unitId = nodeIds.find((id) => id.startsWith("unit:"));
            const assetId = nodeIds.find((id) => id.startsWith("asset:"));
            if (!unitId || !assetId) throw new Error(`画布缺少 unit/asset 节点：${nodeIds.join(",")}`);
            await evalJs(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '适配')?.click()`);
            await sleep(1_200);

            // 1. 单节点拖拽：unit 拖向 asset 附近，吸附参考线应出现；松手后参考线清零、位置改变。
            const beforeSingle = (await rectOf(unitId))!;
            const assetRect = (await rectOf(assetId))!;
            const unitRect = (await rectOf(unitId))!;
            await mouse("mouseMove", unitRect.x, unitRect.y);
            await mouse("mouseDown", unitRect.x, unitRect.y);
            let singleMaxGuides = 0;
            for (let index = 1; index <= 10; index += 1) {
              const stepX = Math.round(unitRect.x + (assetRect.left - 110 - unitRect.x) * (index / 10));
              const stepY = Math.round(unitRect.y + (assetRect.top - unitRect.y) * (index / 10));
              await mouse("mouseMove", stepX, stepY);
              singleMaxGuides = Math.max(singleMaxGuides, Number(await evalJs(`document.querySelectorAll('.snap-guide').length`)) || 0);
            }
            await mouse("mouseUp", Math.round(assetRect.left - 110), Math.round(assetRect.top));
            await sleep(500);
            const guidesAfterSingleStop = Number(await evalJs(`document.querySelectorAll('.snap-guide').length`)) || 0;
            const afterSingle = (await rectOf(unitId))!;
            checks.singleDragSnapGuidesSeen = singleMaxGuides > 0;
            checks.noGuidesAfterSingleStop = guidesAfterSingleStop === 0;
            checks.singleDragMoved = Math.abs(afterSingle.x - beforeSingle.x) > 4 || Math.abs(afterSingle.y - beforeSingle.y) > 4;
            notes.singleDrag = { beforeSingle, afterSingle, singleMaxGuides, guidesAfterSingleStop };

            // 2. undo/redo：⌘Z 回退、⌘⇧Z 重做。
            await keyCombo("z", ["meta"]);
            await sleep(600);
            const afterUndo = (await rectOf(unitId))!;
            await keyCombo("z", ["meta", "shift"]);
            await sleep(600);
            const afterRedo = (await rectOf(unitId))!;
            checks.undoReverts = Math.abs(afterUndo.x - beforeSingle.x) <= 4 && Math.abs(afterUndo.y - beforeSingle.y) <= 4;
            checks.redoRestores = Math.abs(afterRedo.x - afterSingle.x) <= 4 && Math.abs(afterRedo.y - afterSingle.y) <= 4;
            checks.undoButtonsEnabled = Boolean(await evalJs(`(() => { const undo = document.querySelector('[data-testid="managed-canvas-undo"]'); const redo = document.querySelector('[data-testid="managed-canvas-redo"]'); return undo && redo; })()`));
            notes.undoRedo = { afterUndo, afterRedo };

            // 3. 组拖：先 Escape 清场，再点击 asset、按住 Meta 点击 unit 精确多选
            // （库经 useKeyPress 听真实键盘事件判定多选键，必须先发 Meta keyDown），随后拖动 unit——参考线必须全程为 0，队形保持。
            await keyCombo("Escape", []);
            await sleep(300);
            const assetRectForBox = (await rectOf(assetId))!;
            const unitRectForBox = (await rectOf(unitId))!;
            await mouse("mouseMove", assetRectForBox.x, assetRectForBox.y);
            await mouse("mouseDown", assetRectForBox.x, assetRectForBox.y);
            await mouse("mouseUp", assetRectForBox.x, assetRectForBox.y);
            await sleep(400);
            const unitRectFresh = (await rectOf(unitId))!;
            await keyHold("Meta", true);
            await mouse("mouseMove", unitRectFresh.x, unitRectFresh.y);
            await mouse("mouseDown", unitRectFresh.x, unitRectFresh.y, ["meta"]);
            await mouse("mouseUp", unitRectFresh.x, unitRectFresh.y, ["meta"]);
            await keyHold("Meta", false);
            await sleep(500);
            const selectionCount = Number(await evalJs(`(() => { const el = Array.from(document.querySelectorAll('.selection-count')).find((entry) => entry.textContent?.includes('已选')); return el ? Number((el.textContent?.match(/已选 (\\d+) 节点/) ?? [])[1] ?? 0) : 0; })()`));
            // 关闭检查器并重新适配视口（检查器压缩画布后，视口剔除可能把目标节点卸载出 DOM）。
            await evalJs(`document.querySelector('.inspector-close')?.click()`);
            await sleep(400);
            await evalJs(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '适配')?.click()`);
            await sleep(900);
            const groupUnitBefore = await rectOf(unitId);
            const groupAssetBefore = await rectOf(assetId);
            if (!groupUnitBefore || !groupAssetBefore) {
              notes.domDump = await evalJs(`({ vueFlowNodes: document.querySelectorAll('.vue-flow__node').length, vueFlowMounted: Boolean(document.querySelector('.vue-flow')), flowLoading: Boolean(document.querySelector('.flow-loading')), loadingText: document.querySelector('.flow-loading')?.textContent ?? null, inspectorOpen: Boolean(document.querySelector('.canvas-inspector')), canvasError: document.querySelector('.canvas-error')?.textContent ?? null, selectionText: document.querySelector('.selection-count')?.textContent ?? null, bodyClasses: document.querySelector('.canvas-layout')?.className ?? null })`);
              throw new Error(`组拖前节点缺失：unit=${JSON.stringify(groupUnitBefore)} asset=${JSON.stringify(groupAssetBefore)} selection=${selectionCount}`);
            }
            const deltaBefore = { dx: groupAssetBefore.x - groupUnitBefore.x, dy: groupAssetBefore.y - groupUnitBefore.y };
            await mouse("mouseMove", groupUnitBefore.x, groupUnitBefore.y);
            await mouse("mouseDown", groupUnitBefore.x, groupUnitBefore.y);
            let groupMaxGuides = 0;
            for (let index = 1; index <= 6; index += 1) {
              await mouse("mouseMove", groupUnitBefore.x + index * 12, groupUnitBefore.y + index * 9);
              groupMaxGuides = Math.max(groupMaxGuides, Number(await evalJs(`document.querySelectorAll('.snap-guide').length`)) || 0);
            }
            await mouse("mouseUp", groupUnitBefore.x + 72, groupUnitBefore.y + 54);
            await sleep(400);
            const groupUnitAfter = (await rectOf(unitId))!;
            const groupAssetAfter = (await rectOf(assetId))!;
            const deltaAfter = { dx: groupAssetAfter.x - groupUnitAfter.x, dy: groupAssetAfter.y - groupUnitAfter.y };
            checks.groupDragNoGuides = groupMaxGuides === 0;
            checks.groupFormationKept = Math.abs(deltaAfter.dx - deltaBefore.dx) <= 3 && Math.abs(deltaAfter.dy - deltaBefore.dy) <= 3;
            checks.groupDragMoved = Math.abs(groupUnitAfter.x - groupUnitBefore.x) > 20;
            checks.groupSelectionCount = selectionCount >= 2;
            notes.groupDrag = { selectionCount, groupMaxGuides, deltaBefore, deltaAfter };
            // 组拖后撤销复位，避免影响后续截图布局。
            await keyCombo("z", ["meta"]);
            await sleep(400);

            // 4. U1/U2：生成步骤 → 选二格单元（其 panel-01 有冻结包与结果）→ 冻结包身份 + 结果行分类（@toggle 懒加载）。
            await evalJs(`document.getElementById('studio-step-generation')?.click()`);
            await sleep(2_500);
            await evalJs(`document.querySelector('[data-unit-id="p7-unit-b-two-panel"]')?.click()`);
            await sleep(1_800);
            await evalJs(`document.querySelector('[data-panel-id="p7-unit-b-panel-01"]')?.click()`);
            await sleep(1_800);
            const u1Text = String(await evalJs(`document.querySelector('[data-testid="studio-pack-identity"]')?.textContent ?? ''`) ?? "");
            checks.u1PackIdentity = u1Text.includes("冻结包身份（生成时版本）") && u1Text.includes("studio-generation-freeze");
            notes.u1Text = u1Text.slice(0, 240);
            await waitForTruthyEval(`Boolean(document.querySelector('.result-row .result-identity summary'))`);
            await evalJs(`document.querySelector('.result-row .result-identity summary')?.click()`);
            const u2Text = String(await waitForTruthyEval(`(() => { const text = document.querySelector('.result-row .result-identity')?.textContent ?? ''; return /输入当前|预期变化|非预期变化/u.test(text) ? text : ''; })()`, 15_000) ?? "");
            checks.u2Classification = /输入当前|预期变化|非预期变化/u.test(u2Text);
            notes.u2Text = u2Text.slice(0, 240);

            // 5. U3：进入审片 → 历史条目提交时身份。
            await waitForTruthyEval(`(() => { const button = document.querySelector('[data-testid="studio-generation-open-review"]'); return Boolean(button && !button.disabled); })()`);
            await evalJs(`document.querySelector('[data-testid="studio-generation-open-review"]')?.click()`);
            let u3Text = "";
            try {
              u3Text = String(await waitForTruthyEval(`(() => { const text = document.querySelector('.history-list')?.textContent ?? ''; return text.includes('提交时身份（生成时版本）') ? text : ''; })()`, 20_000) ?? "");
            } catch (reason) {
              notes.u3State = await evalJs(`({
                pane: Boolean(document.querySelector('#studio-continuity-review-pane')),
                busy: document.querySelector('[data-testid="studio-continuity-review-view"]')?.getAttribute('aria-busy') ?? null,
                focused: document.querySelector('[data-testid="continuity-focused-scope"]')?.textContent ?? null,
                empty: document.querySelector('.empty-control')?.textContent ?? null,
                error: document.querySelector('.error-banner')?.textContent ?? null,
                loading: document.querySelector('.binding-loading')?.textContent ?? null,
                historyCount: document.querySelectorAll('.history-list article').length,
                body: document.body?.innerText?.slice(0, 1200) ?? null,
              })`);
              throw reason;
            }
            checks.u3ReviewIdentity = u3Text.includes("提交时身份（生成时版本）");
            notes.u3Text = u3Text.slice(0, 240);

            // 6. U4：剧本步骤 → 文档详情修订历史（含当前标记）。
            await evalJs(`document.getElementById('studio-step-script')?.click()`);
            await sleep(2_000);
            await evalJs(`document.querySelector('.material-entry')?.click()`);
            await sleep(1_500);
            await evalJs(`(() => { const details = Array.from(document.querySelectorAll('details.technical-diagnostics')).find((entry) => entry.textContent?.includes('诊断详情')); if (details && !details.open) details.open = true; })()`);
            await sleep(1_200);
            const u4Text = String(await evalJs(`document.querySelector('[data-testid="studio-text-revision-history"]')?.textContent ?? ''`) ?? "");
            checks.u4RevisionHistory = u4Text.includes("修订历史") && u4Text.includes("（当前）");
            notes.u4Text = u4Text.slice(0, 240);

            p2324Probe = { ok: Object.values(checks).every(Boolean), checks, notes };
          } catch (error) {
            p2324Probe = { ok: false, error: String(error), checks, notes };
          }
        })();
      }, Math.min(9_000, Math.round(screenshotDelay * 0.5)));
    }
    if (process.env.AI_CANVAS_SELECT_FIRST === "1") {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(`document.querySelector('.production-node')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      }, Math.min(1_500, Math.round(screenshotDelay / 2)));
    }
    const undoCount = Math.max(0, Math.min(20, Number(process.env.AI_CANVAS_UNDO_COUNT) || 0));
    if (undoCount) {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(`void (async () => { for (let index = 0; index < ${undoCount}; index += 1) { document.querySelector('button[title^="撤销"]')?.click(); await new Promise((resolve) => setTimeout(resolve, 350)); } })()`);
      }, Math.min(3_000, Math.round(screenshotDelay / 2)));
    }
    if (process.env.AI_CANVAS_REVIEW_PASS === "1") {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(`void (async () => {
          document.querySelectorAll('.frame-tabs button')[1]?.click();
          document.querySelectorAll('.criteria-list .criterion-actions button:first-child').forEach((button) => button.click());
          await new Promise((resolve) => setTimeout(resolve, 250));
          document.querySelector('.decision-actions .pass')?.click();
          await new Promise((resolve) => setTimeout(resolve, 2200));
          const resolved = document.querySelector('.queue-filter input[type="checkbox"]');
          if (resolved && !resolved.checked) resolved.click();
        })()`);
      }, Math.min(4_500, Math.round(screenshotDelay * 0.55)));
    }
    const importStep = Math.max(0, Math.min(4, Number(process.env.AI_CANVAS_IMPORT_STEP) || 0));
    if (importStep) {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(`void (async () => {
          for (let index = 0; index < ${importStep}; index += 1) {
            for (let attempt = 0; attempt < 50; attempt += 1) {
              const button = document.querySelector('.wizard-footer .primary');
              if (button && !button.disabled) { button.click(); break; }
              await new Promise((resolve) => setTimeout(resolve, 120));
            }
            await new Promise((resolve) => setTimeout(resolve, 650));
          }
        })()`);
      }, Math.min(2_500, Math.round(screenshotDelay * 0.25)));
    }
    setTimeout(async () => {
      if (!mainWindow) return;
      const rendererState = await mainWindow.webContents.executeJavaScript(`({
        readyState: document.readyState,
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 2000) ?? "",
        bodyWidth: document.body?.scrollWidth ?? 0,
        bodyHeight: document.body?.scrollHeight ?? 0,
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth, canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight },
        visibleRegions: Object.fromEntries(['.adaptation-header','.adaptation-toolbar','.review-bar','.adaptation-grid','.facts-pane','.beats-pane','.plan-pane','.review-drawer'].map((selector) => { const element = document.querySelector(selector); const rect = element?.getBoundingClientRect(); return [selector, rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), clipped: rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight } : null]; })),
        moduleButtons: Array.from(document.querySelectorAll('.module-nav button')).map((button) => button.textContent?.trim()),
      })`).catch((error) => ({ error: String(error) }));
      const image = await mainWindow.capturePage();
      await writeFile(screenshotPath, image.toPNG());
      // 性能探针可能仍在执行：写 debug.json 前有界等待其完成，避免 performanceProbe 丢失。
      if (performanceProbePromise) await Promise.race([performanceProbePromise, new Promise((resolve) => setTimeout(resolve, 45_000))]);
      if (p2324ProbePromise) await Promise.race([p2324ProbePromise, new Promise((resolve) => setTimeout(resolve, 60_000))]);
      await writeFile(`${screenshotPath}.debug.json`, `${JSON.stringify({ url: mainWindow.webContents.getURL(), loading: mainWindow.webContents.isLoading(), visible: mainWindow.isVisible(), bounds: mainWindow.getBounds(), rendererState, continuationAutomation, taskAutomation, adaptationAutomation, adaptationImpactAutomation, analysisReviewAutomation, performanceProbe, p2324Probe }, null, 2)}\n`, "utf8");
      app.quit();
    }, screenshotDelay);
  }
}

function registerIpc(): void {
  installSourceRuntimeWriteGate();
  ipcMain.handle("canvas:get-runtime-write-gate", async () => {
    if (sourceRuntimeBootIdentity) {
      const status = await sourceRuntimeGateController.checkDiagnostic(
        await sourceRuntimeBootIdentity,
      );
      return {
        ...status,
        runtimeGateMetrics: sourceRuntimeGateController.getMetrics(),
        runtimeIpcMetrics: sourceRuntimeIpcPerformanceProbe.snapshot(),
        runtimeStorageReadMetrics: getRuntimeStorageReadMetrics(),
      };
    }
    return {
        schemaVersion: 1,
        kind: "packaged-runtime-write-gate",
        allowed: true,
        restartRequired: false,
        checkedAt: new Date().toISOString(),
        reasons: [],
      };
  });
  ipcMain.handle("canvas:list-projects", async (event, rawOptions) => {
    const options = parseProjectListRequestOptions(rawOptions);
    if (!options.requestId) return listProjects(options);
    const key = projectListRequestKey(event.sender.id, options.requestId);
    if (activeProjectListControllers.has(key)) {
      throw new Error(`项目清单 requestId 正在执行：${options.requestId}`);
    }
    const controller = new AbortController();
    activeProjectListControllers.set(key, controller);
    const onDestroyed = () => controller.abort("项目清单请求所属窗口已关闭。");
    event.sender.once("destroyed", onDestroyed);
    try {
      return await listProjects({
        ...options,
        signal: controller.signal,
      });
    } finally {
      if (activeProjectListControllers.get(key) === controller) {
        activeProjectListControllers.delete(key);
      }
      if (!event.sender.isDestroyed()) event.sender.removeListener("destroyed", onDestroyed);
    }
  });
  ipcMain.handle("canvas:cancel-project-list-request", (event, requestId: string) => {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)) {
      throw new Error("项目清单 requestId 非法。");
    }
    const controller = activeProjectListControllers.get(projectListRequestKey(event.sender.id, requestId));
    if (!controller) return false;
    controller.abort("项目清单读取已由当前窗口取消。");
    return true;
  });
  ipcMain.handle("canvas:get-active-project", () => getActiveProjectReadOnly());
  ipcMain.handle("canvas:activate-project", async (_event, projectRoot: string) => {
    const absoluteRoot = path.resolve(projectRoot);
    const pending = pendingRestoredProjects.get(absoluteRoot);
    if (!pending) return activateProject(absoluteRoot);
    if (!pending.rendererValidated) throw new Error("恢复副本尚未通过桌面受管工程读取校验，禁止激活。");
    const previousActive = await getActiveProject();
    const restoredShell = await requireManagedStudioProject(absoluteRoot);
    try {
      await registerProject(restoredShell.project);
      const activated = await activateProject(absoluteRoot);
      pendingRestoredProjects.delete(absoluteRoot);
      updateManagedProjectOperation(pending.operationId, {
        phase: "succeeded",
        busy: false,
        stage: "恢复副本已校验并作为当前工程打开",
        targetPath: absoluteRoot,
      });
      return activated;
    } catch (reason) {
      await removeProjectRegistration(absoluteRoot).catch(() => undefined);
      if (previousActive?.available) await activateProject(previousActive.primaryRoot).catch(() => undefined);
      updateManagedProjectOperation(pending.operationId, {
        phase: "failed",
        busy: false,
        stage: "恢复副本激活失败，活动工程已保持或回滚",
        targetPath: absoluteRoot,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      throw new Error(`恢复副本激活失败，新登记已回滚：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  });
  ipcMain.handle("canvas:get-managed-project-shell", async (_event, projectRoot: string) => {
    const absoluteRoot = path.resolve(projectRoot);
    const shell = await getManagedProjectShell(absoluteRoot);
    const pending = pendingRestoredProjects.get(absoluteRoot);
    if (!pending) return shell;
    if (!shell) {
      pendingRestoredProjects.delete(absoluteRoot);
      updateManagedProjectOperation(pending.operationId, {
        phase: "failed",
        busy: false,
        stage: "恢复副本无法作为受管工程打开，活动工程保持不变",
        targetPath: absoluteRoot,
      });
      throw new Error("恢复副本无法作为受管工程打开；原活动工程保持不变。");
    }
    pending.rendererValidated = true;
    return shell;
  });
  ipcMain.handle("canvas:create-managed-studio-project", (_event, input: { parentRoot: string; name: string; slug?: string }) =>
    createManagedStudioProject(input));
  ipcMain.handle("canvas:get-default-managed-projects-root", () => defaultManagedProjectsRoot());
  ipcMain.handle("canvas:pick-managed-projects-parent", async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: "选择 AI 漫剧工程保存位置",
      defaultPath: defaultPath?.trim() || defaultManagedProjectsRoot(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("canvas:set-active-studio-context", async (
    _event,
    projectRoot: string,
    context: Parameters<typeof setActiveStudioContext>[1],
  ) => {
    await requireManagedStudioProject(projectRoot);
    return setActiveStudioContext(projectRoot, context);
  });
  ipcMain.handle("canvas:upgrade-managed-studio-project", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    return upgradeManagedStudioProject(projectRoot);
  });
  ipcMain.handle("canvas:get-material-studio-state", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    return getMaterialStudioState(projectRoot);
  });
  ipcMain.handle("canvas:list-studio-media", async (_event, projectRoot: string, query: StudioMediaListQuery = {}) => {
    await requireManagedStudioProject(projectRoot);
    const page = await listStudioMedia(projectRoot, query);
    return {
      ...page,
      items: page.items.map(({ objectPath: _objectPath, thumbnail, ...media }) => ({
        ...media,
        mediaUrl: studioMediaUrl(projectRoot, "media", media.sha256),
        thumbnail: thumbnail ? {
          recipe: thumbnail.recipe,
          recipeKey: thumbnail.recipeKey,
          width: thumbnail.width,
          height: thumbnail.height,
          format: thumbnail.format,
          url: studioMediaUrl(projectRoot, "thumbnail", thumbnail.recipeKey),
        } : undefined,
      })),
    };
  });
  ipcMain.handle("canvas:get-studio-media", async (_event, projectRoot: string, sha256: string) => {
    await requireManagedStudioProject(projectRoot);
    const media = await getStudioMedia(projectRoot, sha256);
    if (!media) return null;
    const { objectPath: _objectPath, thumbnail, ...safe } = media;
    return {
      ...safe,
      mediaUrl: studioMediaUrl(projectRoot, "media", safe.sha256),
      thumbnail: thumbnail ? {
        recipe: thumbnail.recipe,
        recipeKey: thumbnail.recipeKey,
        width: thumbnail.width,
        height: thumbnail.height,
        format: thumbnail.format,
        url: studioMediaUrl(projectRoot, "thumbnail", thumbnail.recipeKey),
      } : undefined,
    };
  });
  ipcMain.handle("canvas:ensure-studio-image-thumbnail", async (_event, projectRoot: string, sha256: string) => {
    await requireManagedStudioProject(projectRoot);
    const { ensureStudioImageThumbnail } = await import("../core/material-studio.js");
    const media = await ensureStudioImageThumbnail(projectRoot, sha256);
    const { objectPath: _objectPath, thumbnail, ...safe } = media;
    return {
      ...safe,
      mediaUrl: studioMediaUrl(projectRoot, "media", safe.sha256),
      thumbnail: thumbnail ? {
        recipe: thumbnail.recipe,
        recipeKey: thumbnail.recipeKey,
        width: thumbnail.width,
        height: thumbnail.height,
        format: thumbnail.format,
        url: studioMediaUrl(projectRoot, "thumbnail", thumbnail.recipeKey),
      } : undefined,
    };
  });
  // P22：差分预检字节通道（SHA 寻址+复验，≤16MB；错误回传泛化文案，不含对象绝对路径）。
  ipcMain.handle("canvas:read-studio-media-bytes", async (_event, projectRoot: string, sha256: string) => {
    await requireManagedStudioProject(projectRoot);
    const media = await getStudioMedia(projectRoot, sha256);
    if (!media || media.kind !== "image") throw new Error("图片媒体不存在。");
    let bytes: Buffer;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const pathBefore = await lstat(media.objectPath, { bigint: true });
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error("unsafe-media-file");
      handle = await open(media.objectPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const descriptorBefore = await handle.stat({ bigint: true });
      if (!descriptorBefore.isFile()
        || descriptorBefore.dev !== pathBefore.dev
        || descriptorBefore.ino !== pathBefore.ino) throw new Error("media-identity-changed");
      if (descriptorBefore.size > BigInt(16 * 1024 * 1024)) throw new Error("media-byte-limit");
      bytes = await handle.readFile();
      const [descriptorAfter, pathAfter] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(media.objectPath, { bigint: true }),
      ]);
      if (pathAfter.isSymbolicLink()
        || descriptorAfter.dev !== descriptorBefore.dev
        || descriptorAfter.ino !== descriptorBefore.ino
        || descriptorAfter.size !== descriptorBefore.size
        || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
        || pathAfter.dev !== descriptorBefore.dev
        || pathAfter.ino !== descriptorBefore.ino
        || bytes.byteLength !== Number(descriptorBefore.size)) throw new Error("media-drifted-during-read");
    } catch (error) {
      if (error instanceof Error && error.message === "media-byte-limit") {
        throw new Error("图片超过差分预检大小上限。");
      }
      throw new Error("图片读取失败。");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== media.sha256) throw new Error("图片内容校验失败。");
    return bytes;
  });
  ipcMain.handle("canvas:get-studio-media-derivatives", async (_event, projectRoot: string, sha256: string) => {
    await requireManagedStudioProject(projectRoot);
    return (await getStudioMediaDerivatives(projectRoot, sha256)).map((record) => safeStudioDerivative(projectRoot, record));
  });
  ipcMain.handle("canvas:prepare-studio-media-derivatives", async (_event, projectRoot: string, sha256: string) => {
    await requireManagedStudioProject(projectRoot);
    const result = await materializeStudioMediaDerivatives(projectRoot, { mediaSha256: sha256 });
    return { ...result, derivatives: result.derivatives.map((record) => safeStudioDerivative(projectRoot, record)) };
  });
  ipcMain.handle("canvas:list-studio-assets", async (_event, projectRoot: string, query: StudioCanonicalAssetListQuery = {}) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioCanonicalAssets(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-asset", async (_event, projectRoot: string, assetId: string) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioCanonicalAsset(projectRoot, assetId);
  });
  ipcMain.handle("canvas:get-studio-production-state", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioProductionState(projectRoot);
  });
  ipcMain.handle("canvas:get-studio-generation-ledger-state", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioGenerationLedgerState(projectRoot);
  });
  ipcMain.handle("canvas:get-studio-generation-plan-progress", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    return buildStudioGenerationPlanProgress(projectRoot);
  });
  ipcMain.handle("canvas:get-dudu-readonly-import-control", async (_event, projectRoot: string) => (
    getDuduReadonlyImportControl(projectRoot)
  ));
  ipcMain.handle("canvas:discover-dudu-readonly-import-projects", async (_event, projectsRoot: string) => (
    discoverDuduReadonlyImportProjects(projectsRoot)
  ));
  // staging 期工程尚未登记，Dudu 三条查询不做 requireManagedStudioProject；
  // 视频包控制面经公开投影剔除外部生产根与相对路径后再过桥。
  ipcMain.handle("canvas:get-studio-video-package-control", async (
    _event,
    projectRoot: string,
    query: StudioVideoPackageControlQuery,
  ) => toStudioVideoPackagePublicControlLookup(await getStudioVideoPackageControl(projectRoot, query)));
  ipcMain.handle("canvas:get-studio-generation-control", async (
    _event,
    projectRoot: string,
    query: StudioGenerationControlQuery,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioGenerationControlEnvelope(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-detached-unknown-unit-states", async (
    _event,
    projectRoot: string,
    unitIds: readonly string[],
  ) => {
    await requireManagedStudioProject(projectRoot);
    const { getStudioDetachedGenerationUnknownUnitStates } = await import("../core/studio-generation-ledger.js");
    return getStudioDetachedGenerationUnknownUnitStates(projectRoot, { unitIds });
  });
  // T9 批量时间线投影（前端单次调用替代 N 次循环查询）
  ipcMain.handle("canvas:get-approved-timeline-projection", async (
    _event,
    projectRoot: string,
    query: { season?: string; episode?: string },
  ) => {
    await requireManagedStudioProject(projectRoot);
    const { getApprovedTimelineProjection } = await import("../core/studio-approved-timeline-projection.js");
    return getApprovedTimelineProjection(projectRoot, query);
  });
  // T19 持续生图状态机（Agent 恢复生产位置）
  ipcMain.handle("canvas:get-continuous-generation-state", async (
    _event,
    projectRoot: string,
    input: { season?: string; episode?: string },
  ) => {
    await requireManagedStudioProject(projectRoot);
    const { getContinuousGenerationState } = await import("../core/studio-continuous-generation-state.js");
    return getContinuousGenerationState(projectRoot, input);
  });
  // T15: 单元级写租约查询
  ipcMain.handle("canvas:get-studio-unit-write-leases", async (
    _event,
    projectRoot: string,
  ) => {
    await requireManagedStudioProjectReadOnly(projectRoot);
    const { getStudioUnitWriteLeases } = await import("../core/studio-project-write-lease.js");
    return getStudioUnitWriteLeases(projectRoot);
  });
  // T14: 生产诊断（真实计数，禁止推算）
  ipcMain.handle("canvas:get-studio-production-diagnostics", async (
    _event,
    projectRoot: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    const { getStudioProductionDiagnostics } = await import("../core/studio-production-diagnostics.js");
    return getStudioProductionDiagnostics(projectRoot);
  });
  // 运行时构建身份（开发态源码 / 安装态 Resources release-manifest）
  ipcMain.handle("canvas:get-runtime-build-identity", async () => {
    if (!runtimeBuildIdentityPromise) {
      const workspace = app.isPackaged
        ? (process.resourcesPath || app.getAppPath())
        : sourceRuntimeWorkspace;
      runtimeBuildIdentityPromise = resolveRuntimeBuildIdentity(workspace);
    }
    return runtimeBuildIdentityPromise;
  });
  ipcMain.handle("canvas:list-studio-generation-panel-history", async (
    _event,
    projectRoot: string,
    query: Parameters<typeof listStudioGenerationPanelHistory>[1],
  ) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioGenerationPanelHistory(projectRoot, query);
  });
  ipcMain.handle("canvas:list-studio-generation-unit-grid-history", async (
    _event,
    projectRoot: string,
    query: Parameters<typeof listStudioGenerationUnitGridHistory>[1],
  ) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioGenerationUnitGridHistory(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-generation-checkpoint-canvas-projection", async (
    _event,
    projectRoot: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioGenerationCheckpointCanvasProjection(projectRoot);
  });
  ipcMain.handle("canvas:get-studio-historical-generation-evidence-by-unit", async (
    _event,
    projectRoot: string,
    unitId: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return readStudioHistoricalGenerationEvidenceByUnit(projectRoot, unitId);
  });
  ipcMain.handle("canvas:get-studio-generation-review-control", async (
    _event,
    projectRoot: string,
    generationRunId: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioGenerationReviewControl(projectRoot, generationRunId);
  });
  ipcMain.handle("canvas:get-studio-post-result-observation-control", async (
    _event,
    projectRoot: string,
    generationRunId: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    const { getStudioPostResultObservationControl } = await import("../core/studio-post-result-observation.js");
    return getStudioPostResultObservationControl(projectRoot, generationRunId);
  });
  ipcMain.handle("canvas:get-studio-generation-review-identity", async (
    _event,
    projectRoot: string,
    packId: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    const pack = await readAnyStudioGenerationFrozenPack(projectRoot, packId);
    if (!pack) throw new Error("冻结生成包不存在，无法打开审片。");
    return {
      packId,
      packFingerprint: pack.fingerprint,
      continuityFingerprint: pack.schemaVersion === 5
        ? pack.continuityFingerprint
        : pack.continuity.fingerprint,
    };
  });
  ipcMain.handle("canvas:list-studio-text-documents", async (_event, projectRoot: string, query: StudioTextDocumentListQuery = {}) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioTextDocuments(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-text-document", async (_event, projectRoot: string, documentId: string) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioTextDocument(projectRoot, documentId);
  });
  ipcMain.handle("canvas:get-latest-studio-text-revision-metadata", async (_event, projectRoot: string, documentId: string) => {
    await requireManagedStudioProject(projectRoot);
    return getLatestStudioTextRevisionMetadata(projectRoot, documentId);
  });
  ipcMain.handle("canvas:get-studio-text-revision", async (_event, projectRoot: string, revisionId: string) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioTextRevision(projectRoot, revisionId);
  });
  ipcMain.handle("canvas:list-studio-production-units", async (_event, projectRoot: string, query: StudioProductionUnitListQuery = {}) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioProductionUnits(projectRoot, query);
  });
  ipcMain.handle("canvas:preview-local-creative-production-units", async (
    _event,
    projectRoot: string,
    input: import("../core/local-creative-production-unit-preview.js").LocalCreativeProductionUnitPreviewInput = {},
  ) => {
    await requireManagedStudioProject(projectRoot);
    const { previewLocalCreativeProductionUnits } = await import("../core/local-creative-production-unit-preview.js");
    return previewLocalCreativeProductionUnits(projectRoot, input);
  });
  ipcMain.handle("canvas:get-local-creative-project-ingest-status", async (
    _event,
    projectRoot: string,
    query: import("../core/local-creative-project-ingest-status.js").LocalCreativeProjectIngestStatusQuery = {},
  ) => {
    await requireManagedStudioProjectReadOnly(projectRoot);
    const { getLocalCreativeProjectIngestStatus } = await import("../core/local-creative-project-ingest-status.js");
    return getLocalCreativeProjectIngestStatus(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-production-unit", async (_event, projectRoot: string, unitId: string) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioProductionUnitSnapshot(projectRoot, unitId);
  });
  ipcMain.handle("canvas:list-studio-binding-units", async (
    _event,
    projectRoot: string,
    query: Parameters<typeof listStudioBindingUnits>[1] = {},
  ) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioBindingUnits(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-binding-control", async (
    _event,
    projectRoot: string,
    input: Parameters<typeof getStudioBindingControl>[1],
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioBindingControl(projectRoot, input);
  });
  ipcMain.handle("canvas:get-studio-continuity-review-control", async (
    _event,
    projectRoot: string,
    input: Parameters<typeof getStudioContinuityReviewControl>[1],
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioContinuityReviewControl(projectRoot, input);
  });
  // P24：追溯只读通道（规范 §2.3）。
  ipcMain.handle("canvas:get-studio-frozen-pack", async (
    _event,
    projectRoot: string,
    packId: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return readAnyStudioGenerationFrozenPack(projectRoot, packId);
  });
  ipcMain.handle("canvas:get-studio-pack-currentness", async (
    _event,
    projectRoot: string,
    packId: string,
  ) => {
    await requireManagedStudioProject(projectRoot);
    const pack = await readAnyStudioGenerationFrozenPack(projectRoot, packId);
    if (!pack) throw new Error(`冻结包不存在：${packId}`);
    // 与 trace 同一 target-aware fail-safe 口径；unit-grid 聚合全部 BindingSet，绝不拿首格冒充整板。
    return evaluateStudioGenerationPackCurrentness(projectRoot, pack);
  });
  ipcMain.handle("canvas:list-studio-text-revisions", async (
    _event,
    projectRoot: string,
    query: { documentId: string; limit?: number; cursor?: string },
  ) => {
    await requireManagedStudioProject(projectRoot);
    return listStudioTextRevisions(projectRoot, { ...query, limit: Math.min(query.limit ?? 20, 20) });
  });
  ipcMain.handle("canvas:get-studio-production-dashboard", async (
    _event,
    projectRoot: string,
    query: StudioProductionDashboardQuery,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioProductionDashboard(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-production-projection-bundle", async (
    _event,
    projectRoot: string,
    query: StudioProductionProjectionBundleQuery,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return buildStudioProductionProjectionBundle(projectRoot, query);
  });
  ipcMain.handle("canvas:get-studio-multimedia-timeline", async (
    _event,
    projectRoot: string,
    query: { unitId: string },
  ) => {
    await requireManagedStudioProject(projectRoot);
    return getStudioMultimediaTimelineProjection(projectRoot, query);
  });
  ipcMain.handle(
    "canvas:get-studio-script-media-align-board",
    async (
      _event,
      projectRoot: string,
      query: { season: string; episode: string; documentId?: string; revisionId?: string; evidenceDir?: string },
    ) => {
      await requireManagedStudioProject(projectRoot);
      return getStudioScriptMediaAlignBoard(projectRoot, query);
    },
  );
  ipcMain.handle(
    "canvas:get-studio-script-library-index",
    async (
      _event,
      projectRoot: string,
      query: { limit?: number; kind?: "script" | "prompt" } = {},
    ) => {
      await requireManagedStudioProjectReadOnly(projectRoot);
      return getStudioScriptLibraryIndex(projectRoot, query);
    },
  );
  ipcMain.handle(
    "canvas:get-studio-script-reader-view",
    async (
      _event,
      projectRoot: string,
      query: {
        documentId?: string;
        revisionId?: string;
        season?: string;
        episode?: string;
        includeBody?: boolean;
        evidenceDir?: string;
      },
    ) => {
      await requireManagedStudioProjectReadOnly(projectRoot);
      return getStudioScriptReaderView(projectRoot, query);
    },
  );
  ipcMain.handle(
    "canvas:open-studio-storyboard-wizard",
    async (
      _event,
      projectRoot: string,
      input: {
        scriptRevisionId: string;
        panelCount?: number;
        sourceRange?: { startOffsetUtf16: number; endOffsetUtf16: number };
      },
    ) => {
      await requireManagedStudioProjectReadOnly(projectRoot);
      return openStudioStoryboardWizard(projectRoot, input);
    },
  );
  ipcMain.handle("canvas:load-studio-canvas-layout", async (_event, projectRoot: string) => {
    await requireManagedStudioProjectReadOnly(projectRoot);
    return loadStudioCanvasLayout(projectRoot);
  });
  ipcMain.handle("canvas:save-studio-canvas-layout", async (
    _event,
    projectRoot: string,
    input: SaveStudioCanvasLayoutInput,
  ) => {
    await requireManagedStudioProject(projectRoot);
    return saveStudioCanvasLayout(projectRoot, input);
  });
  ipcMain.handle("canvas:run-studio-canvas-workflow-group", async (
    _event,
    projectRoot: string,
    group: StudioCanvasWorkflowGroup,
    options: StudioCanvasWorkflowRunOptions,
  ) => {
    await requireManagedStudioProject(projectRoot);
    // require 写租约：与 canvas:execute-studio-command 同一桌面自动租约（runner 内部
    // freeze/plan/dispatch 全属强制租约命令；凭据经 options 透传，不暴露给 renderer）。
    const writeLease = await ensureDesktopWriteLeaseForCommand(projectRoot, "freeze_studio_generation_pack");
    return runStudioCanvasWorkflowGroup(projectRoot, group, { ...options, writeLease });
  });
  ipcMain.handle("canvas:query-studio-asset-timeline", async (_event, projectRoot: string, query: StudioAssetTimelineQuery) => {
    await requireManagedStudioProject(projectRoot);
    return queryStudioAssetTimeline(projectRoot, query);
  });
  ipcMain.handle("canvas:execute-studio-command", async (_event, projectRoot: string, input: unknown) => {
    // IPC 不可信输入先过 user actor 严格 schema；坏 payload 在任何工程探测、锁和
    // command ledger I/O 前失败，且 Core-only 初始化命令不再向 renderer 暴露。
    const commandInput = requireStudioCommandInput(input);
    await requireManagedStudioProject(projectRoot);
    // require 写租约：桌面 UI 自动持有 desktop-ui-main，不把 token 暴露给 renderer。
    const leaseOpts = await ensureDesktopWriteLeaseForCommand(projectRoot, commandInput.request.command);
    const record = await executeIdempotentCommand(projectRoot, commandInput, leaseOpts);
    if (STUDIO_GENERATION_PROGRESS_COMMANDS.has(commandInput.request.command)) {
      void generationLedgerWatcher?.emitNow().catch(() => undefined);
    }
    if (CANVAS_PROJECTION_OUTBOX_RECONCILE_COMMANDS.has(commandInput.request.command)) {
      // T11：Review/连续性写入成功后补缀 outbox 事件并重放（幂等，失败不阻断）。
      void runRuntimeGatedBackgroundWrite(
        "canvas-projection-outbox-command-reconcile",
        () => reconcileAndReplayCanvasProjectionOutbox(path.resolve(projectRoot), "命令后补缀"),
      ).catch((error) => {
        console.warn("[canvas-outbox] 命令后补缀被运行时写闸门拒绝：", error instanceof Error ? error.message : String(error));
      });
    }
    return record;
  });
  ipcMain.handle("canvas:pick-studio-media-files", async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入图片、视频或音频到受管素材库",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "AI 短剧媒体", extensions: ["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff", "gif", "mp4", "mov", "mkv", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac", "ogg"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("canvas:pick-studio-cross-project-asset-export-root", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出跨工程资产复用包",
      buttonLabel: "导出复用包",
      nameFieldLabel: "复用包名称",
      defaultPath: `AI漫剧资产复用包-${new Date().toISOString().slice(0, 10)}`,
    });
    return result.canceled || !result.filePath ? null : path.resolve(result.filePath);
  });
  ipcMain.handle("canvas:pick-studio-cross-project-asset-package", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择跨工程资产复用包",
      buttonLabel: "盘点复用包",
      properties: ["openDirectory"],
    });
    const packageRoot = result.filePaths[0];
    if (result.canceled || !packageRoot) return null;
    return inspectStudioCrossProjectAssetPackage(path.resolve(packageRoot));
  });
  ipcMain.handle("canvas:pick-and-import-studio-script", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    if (!mainWindow) return { imported: false };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "导入剧本到受管生产知识库",
      properties: ["openFile"],
      filters: [{ name: "剧本文本", extensions: ["md", "txt"] }],
    });
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return { imported: false };
    const bytes = await readFile(filePath);
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("单个剧本文本不得超过 16 MiB。");
    const body = bytes.toString("utf8");
    const pathDigest = createHash("sha256").update(path.resolve(filePath)).digest("hex");
    const bodyDigest = createHash("sha256").update(body, "utf8").digest("hex");
    const documentId = `script-${pathDigest.slice(0, 32)}`;
    let document = await getStudioTextDocument(projectRoot, documentId);
    if (!document) {
      const created = await executeIdempotentCommand(projectRoot, {
        requestId: `ui-script-create-${randomUUID()}`,
        idempotencyKey: `studio-script-create-${documentId}`,
        request: {
          command: "create_studio_script_document",
          payload: { id: documentId, title: path.basename(filePath, path.extname(filePath)), expectedRevision: 0 },
        },
      });
      document = (created.result ?? null) as Awaited<ReturnType<typeof getStudioTextDocument>>;
    }
    if (!document) throw new Error("剧本文档身份建立失败。");
    const latest = await getLatestStudioTextRevisionMetadata(projectRoot, documentId);
    if (latest?.bodySha256 === bodyDigest) return { imported: true, entryId: documentId, unchanged: true };
    const appended = await executeIdempotentCommand(projectRoot, {
      requestId: `ui-script-revision-${randomUUID()}`,
      idempotencyKey: `studio-script-revision-${documentId}-r${document.revision}-${bodyDigest}`,
      request: {
        command: "append_studio_script_revision",
        payload: {
          documentId,
          expectedRevision: document.revision,
          body,
          source: path.resolve(filePath),
          sourceVersion: bodyDigest,
        },
      },
    });
    return { imported: true, entryId: documentId, revision: appended.result };
  });
  ipcMain.handle("canvas:pick-and-import-studio-prompt", (_event, projectRoot: string) =>
    pickAndImportStudioText(projectRoot, "prompt"));
  // P27（main 审查 F-03）：旧链路 projectRoot 统一解析——绝对路径+realpath 存在+拒绝系统目录。
  // 允许用户选择的新工程目录（首次扫描建 .aicanvas 是合法入门流程），只拦截明显危险目标。
  // 盲审 F-1 修复：黑名单必须先 realpath 规范化再比较（macOS /etc→/private/etc、/tmp→/private/tmp、/var→/private/var），
  // 且仅按**精确匹配**拦截系统根（startsWith 会误伤 /private/var 下的合法临时工程目录）。
  const LEGACY_PROJECT_ROOT_BLOCKED_LITERAL = ["/", "/System", "/Library", "/etc", "/usr", "/bin", "/sbin", "/dev", "/tmp", "/var", os.homedir()];
  let legacyProjectRootBlockedResolved: Set<string> | null = null;
  async function legacyProjectRootBlocked(): Promise<Set<string>> {
    if (legacyProjectRootBlockedResolved) return legacyProjectRootBlockedResolved;
    const resolved = new Set<string>(LEGACY_PROJECT_ROOT_BLOCKED_LITERAL);
    await Promise.all(LEGACY_PROJECT_ROOT_BLOCKED_LITERAL.map(async (entry) => {
      try {
        resolved.add(await realpath(entry));
      } catch {
        // 规范化失败时保留字面条目。
      }
    }));
    legacyProjectRootBlockedResolved = resolved;
    return resolved;
  }
  async function requireLegacyProjectRoot(candidate: string | undefined): Promise<string> {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error("工程根必须是绝对路径。");
    const resolved = await realpath(candidate).catch(() => {
      throw new Error("工程根不存在或不可读。");
    });
    const segments = resolved.split(path.sep).filter(Boolean);
    const blocked = await legacyProjectRootBlocked();
    if (blocked.has(resolved) || segments.length <= 1) {
      throw new Error("不允许把系统目录或磁盘根当作工程根。");
    }
    return resolved;
  }
  ipcMain.handle("canvas:get-index", async (_event, projectRoot?: string, refresh = false) => {
    const root = await requireLegacyProjectRoot(projectRoot ? path.resolve(projectRoot) : DEFAULT_PROJECT_ROOT);
    if (refresh && await isManagedProject(root)) throw new Error("受管素材工程采用 SQLite/CAS 增量目录，禁止启动旧文件系统扫描。");
    return getProjectIndex(root, refresh);
  });
  ipcMain.handle("canvas:scan", async (_event, projectRoot?: string) => {
    const root = await requireLegacyProjectRoot(projectRoot ? path.resolve(projectRoot) : DEFAULT_PROJECT_ROOT);
    if (await isManagedProject(root)) throw new Error("受管素材工程禁止旧文件系统扫描；请使用素材库导入。 ");
    manualScanControllers.get(root)?.abort("新的手动扫描已开始。");
    const controller = new AbortController();
    manualScanControllers.set(root, controller);
    try {
      return await trackActiveScan(scanAndPersist(root, { signal: controller.signal }));
    } finally {
      if (manualScanControllers.get(root) === controller) manualScanControllers.delete(root);
    }
  });
  ipcMain.handle("canvas:cancel-scan", (_event, projectRoot?: string) => {
    const root = path.resolve(projectRoot || DEFAULT_PROJECT_ROOT);
    const controller = manualScanControllers.get(root);
    if (!controller) return false;
    controller.abort("用户取消了手动扫描。");
    return true;
  });
  ipcMain.handle("canvas:preview-scan", async (_event, projectRoot: string) => {
    if (await isManagedProject(projectRoot)) throw new Error("受管素材工程禁止预览旧文件系统扫描。");
    return previewProjectScan(projectRoot);
  });
  ipcMain.handle("canvas:get-canonical-asset-catalog-state", (_event, projectRoot: string) => getCanonicalAssetCatalogState(requireCanonicalProjectRoot(projectRoot)));
  ipcMain.handle("canvas:list-canonical-assets", (_event, projectRoot: string, input: CanonicalAssetIpcListInput) => listCanonicalAssets(requireCanonicalProjectRoot(projectRoot), requireCanonicalAssetListInput(input)));
  ipcMain.handle("canvas:get-canonical-asset", (_event, projectRoot: string, assetId: string) => getCanonicalAsset(requireCanonicalProjectRoot(projectRoot), requireCanonicalAssetId(assetId)));
  ipcMain.handle("canvas:preview-canonical-asset-migration", (_event, projectRoot: string) => previewCanonicalAssetMigration(requireCanonicalProjectRoot(projectRoot)));
  ipcMain.handle("canvas:prepare-import", (_event, options: ProjectImportOptions) => prepareProjectImport(options));
  ipcMain.handle("canvas:commit-import", async (_event, input: { previewId: string; config: ProjectConfig; projectMode?: ProjectImportMode }) => {
    if (input?.config?.primaryRoot) await requireLegacyProjectRoot(input.config.primaryRoot);
    return commitProjectImport(input);
  });
  ipcMain.handle("canvas:list-context", (_event, projectRoot: string, options?: { kind?: ProjectContextKind; tag?: string; itemId?: string; limit?: number }) => listProjectContext(projectRoot, options));
  ipcMain.handle("canvas:search-context", (_event, projectRoot: string, query: string, limit?: number) => searchProjectContext(projectRoot, query, limit));
  ipcMain.handle("canvas:upsert-context", (_event, projectRoot: string, input: Parameters<typeof upsertProjectContext>[1]) => upsertProjectContext(projectRoot, input, "user"));
  ipcMain.handle("canvas:delete-context", (_event, projectRoot: string, input: Parameters<typeof deleteProjectContext>[1]) => deleteProjectContext(projectRoot, input, "user"));
  ipcMain.handle("canvas:list-skills", (_event, projectRoot: string, options?: { enabledOnly?: boolean }) => listAgentSkills(projectRoot, options));
  ipcMain.handle("canvas:read-skill", (_event, projectRoot: string, skillId: string) => readAgentSkill(projectRoot, skillId));
  ipcMain.handle("canvas:save-skill", (_event, projectRoot: string, input: { id: string; name: string; description: string; category: AgentSkillCategory; enabled: boolean; content: string; expectedUpdatedAt?: string }) => saveAgentSkill(projectRoot, input));
  ipcMain.handle("canvas:delete-skill", (_event, projectRoot: string, skillId: string) => deleteAgentSkill(projectRoot, skillId));
  ipcMain.handle("canvas:get-continuation", (_event, projectRoot: string, options?: { itemId?: string }) => getContinuationSnapshot(projectRoot, options));
  ipcMain.handle("canvas:create-handoff", (_event, projectRoot: string, options?: { itemId?: string }) => createContinuationHandoff(projectRoot, options));
  ipcMain.handle("canvas:import-story-file", async (_event, projectRoot: string, filePath: string, title?: string) => importStoryFile(await requireLegacyProjectRoot(projectRoot), filePath, title));
  ipcMain.handle("canvas:import-story-text", (_event, projectRoot: string, input: { title: string; content: string; kind?: "text" | "markdown" }) => importStoryText(projectRoot, input));
  ipcMain.handle("canvas:list-story-sources", (_event, projectRoot: string) => listStorySources(projectRoot));
  ipcMain.handle("canvas:list-story-chapters", (_event, projectRoot: string, sourceId?: string) => listStoryChapters(projectRoot, sourceId));
  ipcMain.handle("canvas:read-story-chapter", (_event, projectRoot: string, chapterId: string) => readStoryChapter(projectRoot, chapterId));
  ipcMain.handle("canvas:list-story-events", (_event, projectRoot: string, options?: { chapterId?: string; itemId?: string; status?: StoryEventStatus; includeOrphans?: boolean }) => listStoryEvents(projectRoot, options));
  ipcMain.handle("canvas:upsert-story-event", (_event, projectRoot: string, input: Parameters<typeof upsertStoryEvent>[1]) => upsertStoryEvent(projectRoot, input, "user"));
  ipcMain.handle("canvas:connect-story-events", (_event, projectRoot: string, sourceEventId: string, targetEventId: string) => connectStoryEvents(projectRoot, sourceEventId, targetEventId, "user"));
  ipcMain.handle("canvas:build-story-context", (_event, projectRoot: string, itemId: string) => buildStoryContext(projectRoot, itemId));
  ipcMain.handle("canvas:get-adaptation-workspace", (_event, projectRoot: string) => getAdaptationWorkspace(projectRoot));
  ipcMain.handle("canvas:analyze-novel-chapters", (_event, projectRoot: string, input: Parameters<typeof analyzeNovelChapters>[1]) => analyzeNovelChapters(projectRoot, input));
  ipcMain.handle("canvas:generate-adaptation-plans", (_event, projectRoot: string, input: Parameters<typeof generateAdaptationPlans>[1]) => generateAdaptationPlans(projectRoot, input));
  ipcMain.handle("canvas:select-adaptation-plan", (_event, projectRoot: string, planId: string, expectedRevision: number) => selectAdaptationPlan(projectRoot, planId, expectedRevision));
  ipcMain.handle("canvas:materialize-adaptation-plan", (_event, projectRoot: string, input: Parameters<typeof materializeSelectedAdaptationPlan>[1]) => materializeSelectedAdaptationPlan(projectRoot, input));
  ipcMain.handle("canvas:analyze-adaptation-impact", (_event, projectRoot: string, input: Parameters<typeof analyzeAdaptationChangeImpact>[1]) => analyzeAdaptationChangeImpact(projectRoot, input));
  ipcMain.handle("canvas:regenerate-adaptation-scope", (_event, projectRoot: string, input: Parameters<typeof regenerateAdaptationScope>[1]) => regenerateAdaptationScope(projectRoot, input));
  ipcMain.handle("canvas:create-novel-analysis-task", async (_event, projectRoot: string, input: Parameters<typeof createNovelAnalysisTask>[1]) => {
    const idempotencyKey = `ui-analysis-task-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "create_novel_analysis_task", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:list-novel-analysis-reviews", (_event, projectRoot: string, options?: Parameters<typeof listNovelAnalysisReviews>[1]) => listNovelAnalysisReviews(projectRoot, options));
  ipcMain.handle("canvas:review-novel-analysis-item", async (_event, projectRoot: string, input: Parameters<typeof reviewNovelAnalysisItem>[1]) => {
    const idempotencyKey = `ui-analysis-review-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "review_novel_analysis_item", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:review-novel-analysis-batch", async (_event, projectRoot: string, input: Parameters<typeof reviewNovelAnalysisBatch>[1]) => {
    const idempotencyKey = `ui-analysis-review-batch-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "review_novel_analysis_batch", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:get-novel-analysis-providers", (_event, projectRoot: string) => getNovelAnalysisProviderSettings(projectRoot));
  ipcMain.handle("canvas:probe-novel-analysis-provider", (_event, projectRoot: string, providerId: string) => probeNovelAnalysisProvider(projectRoot, providerId));
  ipcMain.handle("canvas:upsert-novel-analysis-provider", async (_event, projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").upsertNovelAnalysisProvider>[1]) => {
    const idempotencyKey = `ui-analysis-provider-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "upsert_novel_analysis_provider", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:plan-novel-analysis-run", async (_event, projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").planNovelAnalysisRun>[1]) => {
    const idempotencyKey = `ui-analysis-run-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "plan_novel_analysis_run", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:list-novel-analysis-runs", (_event, projectRoot: string) => listNovelAnalysisRunProgress(projectRoot));
  ipcMain.handle("canvas:get-novel-analysis-run", (_event, projectRoot: string, runId: string) => getNovelAnalysisRunProgress(projectRoot, runId));
  ipcMain.handle("canvas:execute-next-novel-analysis-run-task", async (_event, projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").executeNextNovelAnalysisRunTask>[1]) => {
    const idempotencyKey = `ui-analysis-run-next-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "execute_next_novel_analysis_run_task", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:replace-novel-analysis-run-task", async (_event, projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").replaceNovelAnalysisRunTask>[1]) => {
    const idempotencyKey = `ui-analysis-run-replace-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "replace_novel_analysis_run_task", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:execute-novel-analysis-task", async (_event, projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").executeNovelAnalysisTask>[1]) => {
    const idempotencyKey = `ui-analysis-execute-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "execute_novel_analysis_task", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:validate-adaptation-plan", (_event, projectRoot: string, planId: string) => getAdaptationWorkspace(projectRoot).then((workspace) => { const plan = workspace.plans.find((candidate) => candidate.id === planId); if (!plan) throw new Error(`找不到改编计划：${planId}`); return validateAdaptationPlan(projectRoot, plan, workspace); }));
  ipcMain.handle("canvas:upsert-novel-fact", (_event, projectRoot: string, input: Parameters<typeof upsertNovelFact>[1]) => upsertNovelFact(projectRoot, input));
  ipcMain.handle("canvas:upsert-narrative-beat", (_event, projectRoot: string, input: Parameters<typeof upsertNarrativeBeat>[1]) => upsertNarrativeBeat(projectRoot, input));
  ipcMain.handle("canvas:export-adaptation", (_event, projectRoot: string, input: Parameters<typeof exportAdaptation>[1]) => exportAdaptation(projectRoot, input));
  ipcMain.handle("canvas:get-production-workflow", (_event, projectRoot: string) => getProductionWorkflow(projectRoot, { includeEvidenceAudit: true }));
  ipcMain.handle("canvas:update-production-workflow-stage", (_event, projectRoot: string, input: Parameters<typeof updateProductionWorkflowStage>[1]) => updateProductionWorkflowStage(projectRoot, input, "user"));
  ipcMain.handle("canvas:list-creative-bibles", (_event, projectRoot: string, kind?: Parameters<typeof listCreativeBibles>[1]) => listCreativeBibles(projectRoot, kind));
  ipcMain.handle("canvas:upsert-creative-bible", (_event, projectRoot: string, input: Parameters<typeof upsertCreativeBible>[1]) => upsertCreativeBible(projectRoot, input, "user"));
  ipcMain.handle("canvas:get-storyboard", (_event, projectRoot: string, itemId?: string) => getStoryboard(projectRoot, itemId));
  ipcMain.handle("canvas:upsert-storyboard-row", (_event, projectRoot: string, input: Parameters<typeof upsertStoryboardRow>[1]) => upsertStoryboardRow(projectRoot, input, "user"));
  ipcMain.handle("canvas:build-fusion-storyboard-grid", async (_event, projectRoot: string, input: {
    itemId: string;
    override?: import("../core/fusion-storyboard-grid.js").FusionStoryboardGridOverride;
    referenceOverride?: import("../core/fusion-storyboard-grid.js").FusionStoryboardGridReferenceOverride;
  }) => {
    const idempotencyKey = `ui-fusion-grid-${createHash("sha256").update(JSON.stringify({ algorithmVersion: FUSION_STORYBOARD_BEAT_ALGORITHM_VERSION, visibleTimePolicyVersion: FUSION_STORYBOARD_VISIBLE_TIME_POLICY_VERSION, input })).digest("hex").slice(0, 48)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "build_fusion_storyboard_grid", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:migrate-fusion-storyboard-evidence", async (_event, projectRoot: string, input: { itemIds?: string[] } = {}) => {
    const sidecar = getSidecarPaths(projectRoot);
    const stateContents = await Promise.all([
      sidecar.generationJobs,
      sidecar.reviews,
      sidecar.storyboardGridSelections,
      sidecar.storyboards,
    ].map((filePath) => readFile(filePath).catch(() => Buffer.alloc(0))));
    const stateDigest = createHash("sha256");
    for (const content of stateContents) stateDigest.update(content);
    const idempotencyKey = `ui-fusion-evidence-migration-${createHash("sha256").update(JSON.stringify({ input, stateDigest: stateDigest.digest("hex") })).digest("hex").slice(0, 48)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "migrate_fusion_storyboard_evidence", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:get-fusion-storyboard-sheet-state", (_event, projectRoot: string, input: Parameters<typeof getFusionStoryboardSheetState>[1]) => getFusionStoryboardSheetState(projectRoot, input));
  ipcMain.handle("canvas:list-fusion-storyboard-sheets", (_event, projectRoot: string, input: Parameters<typeof listFusionStoryboardSheets>[1] = {}) => listFusionStoryboardSheets(projectRoot, input));
  ipcMain.handle("canvas:migrate-fusion-storyboard-sheets", async (_event, projectRoot: string, input: Parameters<typeof import("../core/fusion-storyboard-sheet-migration.js").migrateFusionStoryboardSheets>[1]) => {
    const idempotencyKey = `ui-fusion-sheet-migration-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "migrate_fusion_storyboard_sheets", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:render-fusion-storyboard-sheet", async (_event, projectRoot: string, input: import("../core/fusion-storyboard-production.js").RenderCompletedFusionStoryboardSheetInput) => {
    const idempotencyKey = `ui-fusion-sheet-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "render_fusion_storyboard_sheet", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:get-fusion-asset-consistency", (_event, projectRoot: string) => getFusionAssetConsistencyState(projectRoot));
  ipcMain.handle("canvas:prepare-fusion-asset-consistency-review", async (_event, projectRoot: string, input: { batchId?: string }) => {
    const idempotencyKey = `ui-fusion-asset-consistency-prepare-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "prepare_fusion_asset_consistency_review", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:submit-fusion-asset-consistency-review", async (_event, projectRoot: string, input: import("../core/fusion-asset-consistency.js").SubmitFusionAssetConsistencyReviewInput) => {
    const idempotencyKey = `ui-fusion-asset-consistency-submit-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "submit_fusion_asset_consistency_review", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:seal-final-fusion-asset-consistency-batch", async (_event, projectRoot: string, input: { batchId: string; expectedRevision: number }) => {
    const idempotencyKey = `ui-fusion-asset-consistency-seal-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, { requestId: `ui-${randomUUID()}`, idempotencyKey, request: { command: "seal_final_fusion_asset_consistency_batch", payload: input } });
    return result.result;
  });
  ipcMain.handle("canvas:analyze-change-impact", (_event, projectRoot: string, input: Parameters<typeof analyzeChangeImpact>[1]) => analyzeChangeImpact(projectRoot, input));
  ipcMain.handle("canvas:list-asset-relations", (_event, projectRoot: string, options?: Parameters<typeof listAssetRelations>[1]) => listAssetRelations(projectRoot, options));
  ipcMain.handle("canvas:upsert-asset-relation", async (_event, projectRoot: string, input: Parameters<typeof upsertAssetRelation>[1]) => {
    const idempotencyKey = `ui-asset-relation-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`;
    const result = await executeIdempotentCommand(projectRoot, {
      requestId: `ui-${randomUUID()}`,
      idempotencyKey,
      request: { command: "upsert_asset_relation", payload: input },
    });
    return result.result;
  });
  ipcMain.handle("canvas:list-voice-identities", (_event, projectRoot: string) => listVoiceIdentities(projectRoot));
  ipcMain.handle("canvas:upsert-voice-identity", (_event, projectRoot: string, input: Parameters<typeof upsertVoiceIdentity>[1]) => upsertVoiceIdentity(projectRoot, input, "user"));
  ipcMain.handle("canvas:list-edit-projects", (_event, projectRoot: string) => listEditProjects(projectRoot));
  ipcMain.handle("canvas:get-editor-session", (_event, projectRoot: string) => getEditorSessionState(projectRoot));
  ipcMain.handle("canvas:begin-editor-session", async (_event, projectRoot: string) => {
    const result = await beginEditorSession(projectRoot);
    activeEditorSessions.set(projectRoot, result.state.sessionId);
    return result;
  });
  ipcMain.handle("canvas:set-editor-session-project", (_event, projectRoot: string, sessionId: string, editProjectId: string) => setEditorSessionProject(projectRoot, sessionId, editProjectId));
  ipcMain.handle("canvas:resolve-editor-session-recovery", (_event, projectRoot: string, sessionId: string, choice: "stable" | "latest") => resolveEditorSessionRecovery(projectRoot, sessionId, choice));
  ipcMain.handle("canvas:close-editor-session", async (_event, projectRoot: string, sessionId: string) => {
    const result = await closeEditorSession(projectRoot, sessionId);
    if (activeEditorSessions.get(projectRoot) === sessionId) activeEditorSessions.delete(projectRoot);
    return result;
  });
  ipcMain.handle("canvas:get-edit-project", (_event, projectRoot: string, editProjectId: string) => getEditProject(projectRoot, editProjectId));
  ipcMain.handle("canvas:create-edit-project", (_event, projectRoot: string, input?: Parameters<typeof createEditProject>[1]) => createEditProject(projectRoot, input));
  ipcMain.handle("canvas:save-edit-project", (_event, projectRoot: string, project: EditProject, expectedRevision: number) => saveEditProject(projectRoot, project, expectedRevision));
  ipcMain.handle("canvas:apply-edit-operation", (_event, projectRoot: string, editProjectId: string, expectedRevision: number, operation: EditOperation) => applyEditOperation(projectRoot, editProjectId, expectedRevision, operation, "user"));
  ipcMain.handle("canvas:get-edit-history-info", (_event, projectRoot: string, editProjectId: string) => getEditHistoryInfo(projectRoot, editProjectId));
  ipcMain.handle("canvas:undo-edit-project", (_event, projectRoot: string, editProjectId: string, expectedRevision: number) => undoEditProject(projectRoot, editProjectId, expectedRevision, "user"));
  ipcMain.handle("canvas:redo-edit-project", (_event, projectRoot: string, editProjectId: string, expectedRevision: number) => redoEditProject(projectRoot, editProjectId, expectedRevision, "user"));
  ipcMain.handle("canvas:export-edit-otio", (_event, projectRoot: string, editProjectId: string, expectedRevision: number, outputPath?: string) => exportEditProjectOtio(projectRoot, editProjectId, expectedRevision, outputPath));
  ipcMain.handle("canvas:import-edit-otio", async (_event, projectRoot: string, filePath: string, name?: string) => importEditProjectOtio(await requireLegacyProjectRoot(projectRoot), filePath, name));
  ipcMain.handle("canvas:list-edit-media", (_event, projectRoot: string, episode?: number) => listEditMedia(projectRoot, episode));
  ipcMain.handle("canvas:prepare-edit-media-preview", (_event, projectRoot: string, artifactId: string) => prepareEditMediaPreview(projectRoot, artifactId));
  ipcMain.handle("canvas:prepare-edit-media-proxy", (_event, projectRoot: string, artifactId: string) => prepareEditMediaProxy(projectRoot, artifactId));
  ipcMain.handle("canvas:prepare-nested-timeline-preview", (_event, projectRoot: string, parentEditProjectId: string, expectedRevision: number, clipId: string) => prepareNestedTimelinePreview(projectRoot, parentEditProjectId, expectedRevision, clipId));
  ipcMain.handle("canvas:probe-video-engine", () => probeVideoEngine());
  ipcMain.handle("canvas:list-edit-render-jobs", (_event, projectRoot: string) => listEditRenderJobs(projectRoot));
  ipcMain.handle("canvas:render-edit-project", (_event, projectRoot: string, editProjectId: string, options: { expectedRevision: number; outputDirectory?: string }) => renderEditProject(projectRoot, editProjectId, options));
  ipcMain.handle("canvas:start-edit-render", (_event, projectRoot: string, editProjectId: string, options: { expectedRevision: number; outputDirectory?: string }) => startEditRender(projectRoot, editProjectId, options));
  ipcMain.handle("canvas:get-edit-render-job", (_event, projectRoot: string, renderId: string) => getEditRenderJob(projectRoot, renderId));
  ipcMain.handle("canvas:cancel-edit-render", (_event, projectRoot: string, renderId: string) => cancelEditRender(projectRoot, renderId));
  ipcMain.handle("canvas:extract-timeline-frame", (_event, projectRoot: string, input: Parameters<typeof extractTimelineFrame>[1]) => extractTimelineFrame(projectRoot, input));
  ipcMain.handle("canvas:prepare-timeline-continuation", async (_event, projectRoot: string, input: Parameters<typeof prepareTimelineVideoContinuation>[1]) => {
    if (input.expectedRevision === undefined) throw new Error("桌面端末帧续作必须锁定剪辑工程修订号。");
    const idempotencyKey = `ui-timeline-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
    const result = await executeIdempotentCommand(projectRoot, {
      requestId: `ui-${randomUUID()}`,
      idempotencyKey,
      request: { command: "prepare_timeline_continuation", payload: input },
    });
    return result.result;
  });
  ipcMain.handle("canvas:list-timeline-frames", (_event, projectRoot: string, editProjectId?: string, limit?: number) => listTimelineFrameExtractions(projectRoot, editProjectId, limit));
  ipcMain.handle("canvas:extract-last-frame", async (_event, projectRoot: string, input: { itemId: string; artifactId?: string; videoPath?: string }) => extractLastFrame(await requireLegacyProjectRoot(projectRoot), input));
  ipcMain.handle("canvas:create-video-continuation", async (_event, projectRoot: string, input: { itemId: string; sourceVideoPath?: string; lastFramePath: string; prompt?: string }) => createVideoContinuationPack(await requireLegacyProjectRoot(projectRoot), input));
  ipcMain.handle("canvas:list-video-continuations", (_event, projectRoot: string, itemId?: string) => listVideoContinuationPacks(projectRoot, itemId));
  ipcMain.handle("canvas:update-video-continuation", (_event, projectRoot: string, continuationId: string, input: { expectedRevision: number; status: "failed" | "cancelled"; error: string }) => updateVideoContinuationPack(projectRoot, continuationId, input));
  ipcMain.handle("canvas:get-item", (_event, projectRoot: string, itemId: string) => getItem(projectRoot, itemId));
  ipcMain.handle(
    "canvas:update-status",
    (_event, projectRoot: string, itemId: string, status: WorkItemStatus, note?: string, authoritativePath?: string) =>
      updateStatus(projectRoot, itemId, status, note, authoritativePath, "user"),
  );
  ipcMain.handle("canvas:save-layout", (_event, projectRoot: string, viewKey: string, positions: Record<string, { x: number; y: number }>) =>
    saveCanvasPositions(projectRoot, viewKey, positions),
  );
  ipcMain.handle("canvas:load-layout", (_event, projectRoot: string, viewKey: string) => loadCanvasPositions(projectRoot, viewKey));
  ipcMain.handle("canvas:get-semantic-state", (_event, projectRoot: string) => getCanvasSemanticState(projectRoot));
  ipcMain.handle("canvas:upsert-entity", (_event, projectRoot: string, input: Partial<CanvasEntity> & Pick<CanvasEntity, "kind" | "title">) => upsertCanvasEntity(projectRoot, input));
  ipcMain.handle("canvas:move-entities", (_event, projectRoot: string, positions: Record<string, { x: number; y: number }>) => moveCanvasEntities(projectRoot, positions));
  ipcMain.handle("canvas:delete-entity", (_event, projectRoot: string, entityId: string) => deleteCanvasEntity(projectRoot, entityId));
  ipcMain.handle("canvas:upsert-link", (_event, projectRoot: string, input: Partial<CanvasSemanticLink> & Pick<CanvasSemanticLink, "sourceId" | "targetId">) => upsertCanvasLink(projectRoot, input));
  ipcMain.handle("canvas:delete-link", (_event, projectRoot: string, linkId: string) => deleteCanvasLink(projectRoot, linkId));
  ipcMain.handle("canvas:get-history-info", (_event, projectRoot: string) => getCanvasHistoryInfo(projectRoot));
  ipcMain.handle("canvas:undo-semantic", (_event, projectRoot: string) => undoCanvasSemanticState(projectRoot));
  ipcMain.handle("canvas:redo-semantic", (_event, projectRoot: string) => redoCanvasSemanticState(projectRoot));
  ipcMain.handle("canvas:get-review-queue", (_event, projectRoot: string, options?: { episode?: number; includeResolved?: boolean }) => getReviewQueue(projectRoot, options));
  ipcMain.handle("canvas:list-review-records", (_event, projectRoot: string, options?: { itemId?: string; decision?: ReviewDecision; limit?: number }) => listReviewRecords(projectRoot, options));
  ipcMain.handle("canvas:submit-review", async (_event, projectRoot: string, input: SubmitReviewInput) => {
    const idempotencyKey = `ui-review-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`;
    const result = await executeIdempotentCommand(projectRoot, {
      requestId: `ui-${randomUUID()}`,
      idempotencyKey,
      request: { command: "submit_review", payload: input },
    });
    return result.result;
  });
  // P27（main 审查 F-02）：shell 原语白名单——仅已登记工程范围内路径；直接打开仅限已知安全类型（拒可执行文件）。
  const SHELL_OPEN_ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".m4a", ".aac", ".pdf", ".txt", ".md", ".json", ".csv", ".otio", ".xml", ".srt"]);
  async function assertShellPathAllowed(filePath: string, options: { forOpen?: boolean } = {}): Promise<string> {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("路径无效");
    if (!path.isAbsolute(filePath)) throw new Error("仅允许绝对路径");
    // 盲审 F-4：应用自带文件（app bundle / resources 内的 MCP server 等）放行——
    // 工程外但属应用安装内容的合法 reveal 场景（设置页"在 Finder 中显示 MCP 入口"）。
    const resolved = await realpath(filePath).catch(() => null);
    const appPrefixes = await Promise.all([app.getAppPath(), process.resourcesPath ? path.resolve(process.resourcesPath) : null]
      .filter((prefix): prefix is string => Boolean(prefix))
      .map(async (prefix) => realpath(prefix).catch(() => path.resolve(prefix))));
    const inAppBundle = resolved !== null && appPrefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`));
    const registeredPath = inAppBundle ? null : await resolveLegacyAssetPath(filePath);
    const canonicalPath = inAppBundle ? resolved : registeredPath;
    if (!canonicalPath) throw new Error("路径不在已登记工程范围内，或路径是符号链接/非普通文件");
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) throw new Error("只允许打开或显示普通文件");
    if (options.forOpen) {
      const extension = path.extname(canonicalPath).toLowerCase();
      if (!SHELL_OPEN_ALLOWED_EXTENSIONS.has(extension)) throw new Error(`该文件类型不允许直接打开：${extension || "(无扩展名)"}`);
    }
    return canonicalPath;
  }
  ipcMain.handle("canvas:show-in-folder", async (_event, filePath: string) => {
    const canonicalPath = await assertShellPathAllowed(filePath);
    shell.showItemInFolder(canonicalPath);
  });
  ipcMain.handle("canvas:open-path", async (_event, filePath: string) => {
    const canonicalPath = await assertShellPathAllowed(filePath, { forOpen: true });
    return shell.openPath(canonicalPath);
  });
  /** 画布拖出：把 CAS 媒体物化为带扩展名的临时文件，供 OS 原生拖拽到桌面/其他 App。 */
  const MEDIA_MIME_EXTENSION: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/tiff": ".tif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-m4v": ".m4v",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
  };
  function studioMediaExportTempRoot(): string {
    return path.join(app.getPath("temp"), "ai-drama-canvas-export");
  }
  function sanitizeExportBasename(value: string | undefined, fallback: string): string {
    const raw = (value ?? "").trim() || fallback;
    return raw
      .replace(/\.[^.]+$/u, "")
      .replace(/[^\w\u4e00-\u9fff._-]+/gu, "_")
      .replace(/_+/gu, "_")
      .replace(/^_|_$/gu, "")
      .slice(0, 80) || fallback;
  }
  ipcMain.handle(
    "canvas:prepare-studio-media-export",
    async (_event, projectRoot: string, mediaSha256: string, suggestedName?: string) => {
      await requireManagedStudioProject(projectRoot);
      if (typeof mediaSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(mediaSha256.trim())) {
        throw new Error("mediaSha256 无效");
      }
      const media = await getStudioMedia(projectRoot, mediaSha256.trim().toLowerCase());
      if (!media) throw new Error("媒体不存在。");
      if (media.kind !== "image" && media.kind !== "video") {
        throw new Error("仅支持拖出图片或视频。");
      }
      const objectMeta = await lstat(media.objectPath).catch(() => null);
      if (!objectMeta || objectMeta.isSymbolicLink() || !objectMeta.isFile()) {
        throw new Error("媒体文件不可读。");
      }
      const fromBasename = path.extname(media.sourceBasename || "");
      const ext =
        MEDIA_MIME_EXTENSION[media.mimeType]
        || (fromBasename && fromBasename.length <= 8 ? fromBasename.toLowerCase() : "")
        || (media.kind === "video" ? ".mp4" : ".png");
      const base = sanitizeExportBasename(suggestedName ?? media.sourceBasename, media.sha256.slice(0, 12));
      const exportDir = studioMediaExportTempRoot();
      await mkdir(exportDir, { recursive: true });
      const fileName = `${base}${ext.startsWith(".") ? ext : `.${ext}`}`;
      const exportPath = path.join(exportDir, fileName);
      await copyFile(media.objectPath, exportPath);
      return {
        exportPath,
        fileName,
        kind: media.kind,
        mimeType: media.mimeType,
        sha256: media.sha256,
        sizeBytes: media.sizeBytes,
      };
    },
  );
  /** 原生文件拖出：必须在 dragstart 同链路上同步调用 webContents.startDrag。 */
  ipcMain.on("canvas:start-native-file-drag", (event, exportPath: string) => {
    if (typeof exportPath !== "string" || !exportPath.trim() || !path.isAbsolute(exportPath)) return;
    const resolved = path.resolve(exportPath);
    const exportRoot = path.resolve(studioMediaExportTempRoot());
    if (resolved !== exportRoot && !resolved.startsWith(`${exportRoot}${path.sep}`)) return;
    let icon = nativeImage.createEmpty();
    try {
      const image = nativeImage.createFromPath(resolved);
      if (!image.isEmpty()) icon = image.resize({ width: 64, height: 64 });
    } catch {
      /* 视频等无法解码为图标时用空图标 */
    }
    try {
      event.sender.startDrag({ file: resolved, icon });
    } catch {
      /* 手势已结束或系统拒绝时静默 */
    }
  });
  ipcMain.handle("canvas:get-managed-project-operation-state", () => managedProjectOperationState);
  ipcMain.handle("canvas:backup-managed-project", async (_event, projectRoot: string) => {
    const absoluteRoot = path.resolve(projectRoot);
    await requireManagedStudioProject(absoluteRoot);
    const operationId = beginManagedProjectOperation("backup", absoluteRoot);
    try {
      const picked = await dialog.showOpenDialog({
        title: "选择备份保存位置",
        defaultPath: path.join(app.getPath("documents"), "AI漫剧备份"),
        properties: ["openDirectory", "createDirectory"],
      });
      const parent = picked.filePaths[0];
      if (picked.canceled || !parent) {
        updateManagedProjectOperation(operationId, { phase: "canceled", busy: false, stage: "备份已取消", targetPath: "未写入任何备份" });
        return { canceled: true as const };
      }
      updateManagedProjectOperation(operationId, { stage: "正在建立写入屏障与一致快照", targetPath: path.resolve(parent) });
      const result = await createManagedProjectBackup(absoluteRoot, parent);
      updateManagedProjectOperation(operationId, { phase: "succeeded", busy: false, stage: "一致备份已完成", targetPath: result.backupRoot });
      return {
        canceled: false as const,
        backupRoot: result.backupRoot,
        fileCount: result.manifest.fileCount,
        fingerprint: result.manifest.fingerprint,
        createdAt: result.manifest.createdAt,
      };
    } catch (reason) {
      updateManagedProjectOperation(operationId, {
        phase: "failed",
        busy: false,
        stage: "备份失败，工程未切换",
        error: reason instanceof Error ? reason.message : String(reason),
      });
      throw reason;
    }
  });
  ipcMain.handle("canvas:restore-managed-project", async () => {
    const activeBeforeRestore = await getActiveProject();
    const operationId = beginManagedProjectOperation("restore", activeBeforeRestore?.primaryRoot);
    try {
      const backup = await dialog.showOpenDialog({
        title: "选择要恢复的备份目录",
        properties: ["openDirectory"],
      });
      const backupRoot = backup.filePaths[0];
      if (backup.canceled || !backupRoot) {
        updateManagedProjectOperation(operationId, { phase: "canceled", busy: false, stage: "恢复已取消", targetPath: "未创建恢复副本" });
        return { canceled: true as const };
      }
      updateManagedProjectOperation(operationId, { stage: "备份来源已选择，等待恢复目标", targetPath: path.resolve(backupRoot) });
      const target = await dialog.showOpenDialog({
        title: "选择恢复后的新位置（不会覆盖原工程）",
        defaultPath: defaultManagedProjectsRoot(),
        properties: ["openDirectory", "createDirectory"],
      });
      const targetParent = target.filePaths[0];
      if (target.canceled || !targetParent) {
        updateManagedProjectOperation(operationId, { phase: "canceled", busy: false, stage: "恢复已取消", targetPath: "未创建恢复副本" });
        return { canceled: true as const };
      }
      updateManagedProjectOperation(operationId, { stage: "正在校验备份并恢复到新目录", targetPath: path.resolve(targetParent) });
      const restored = await restoreManagedProjectBackup(backupRoot, targetParent, {
        forbiddenProjectRoots: activeBeforeRestore?.primaryRoot ? [activeBeforeRestore.primaryRoot] : [],
      });
      const restoredShell = await requireManagedStudioProject(restored.projectRoot);
      const absoluteRestoredRoot = path.resolve(restored.projectRoot);
      pendingRestoredProjects.set(absoluteRestoredRoot, { projectRoot: absoluteRestoredRoot, rendererValidated: false, operationId });
      updateManagedProjectOperation(operationId, { phase: "running", busy: true, stage: "恢复副本已校验，正在由桌面打开并激活", targetPath: absoluteRestoredRoot });
      return {
        canceled: false as const,
        projectRoot: absoluteRestoredRoot,
        projectName: restoredShell.project.name,
        fileCount: restored.manifest.fileCount,
        fingerprint: restored.manifest.fingerprint,
      };
    } catch (reason) {
      updateManagedProjectOperation(operationId, {
        phase: "failed",
        busy: false,
        stage: "恢复失败，活动工程保持不变",
        error: reason instanceof Error ? reason.message : String(reason),
      });
      throw reason;
    }
  });
  ipcMain.handle("canvas:get-agent-connection-status", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    const serverPath = app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "dist-mcp", "mcp", "server.js")
      : path.join(app.getAppPath(), "dist-mcp", "mcp", "server.js");
    const [codexPath, grokPath, serverAvailable] = await Promise.all([
      executableOnPath("codex"),
      executableOnPath("grok"),
      access(serverPath).then(() => true, () => false),
    ]);
    if (!app.isPackaged || !serverAvailable) {
      return {
        projectRoot,
        serverAvailable,
        packaged: app.isPackaged,
        codex: { installed: Boolean(codexPath), configured: false, current: false, executable: codexPath },
        grok: { installed: Boolean(grokPath), configured: false, current: false, executable: grokPath },
        repairAvailable: false,
        repairNeeded: false,
        message: app.isPackaged ? "安装版 MCP runtime 不可用，已禁止修复。" : "当前是开发环境，只做连接诊断；修复 Agent 连接请在正式安装的软件中操作。",
      };
    }
    const launch = await packagedAgentRuntimeLaunch();
    const inspected = await inspectAgentConnections({
      homeDirectory: os.homedir(),
      ...(codexPath ? { codexExecutable: codexPath } : {}),
      ...(grokPath ? { grokExecutable: grokPath } : {}),
      launch,
    });
    const codexCurrent = inspected.codex.current;
    const repairAvailable = Boolean(codexPath && serverAvailable);
    const repairNeeded = Boolean(repairAvailable && !codexCurrent);
    const grokCurrentOrOptional = !grokPath || inspected.grok.current;
    return {
      projectRoot,
      serverAvailable,
      packaged: app.isPackaged,
      codex: { ...inspected.codex, executable: codexPath },
      grok: { ...inspected.grok, executable: grokPath },
      repairAvailable,
      repairNeeded,
      message: codexCurrent && grokCurrentOrOptional
        ? (grokPath ? "Codex 已连接当前安装版；已安装的 Grok 也已就绪。" : "Codex 已连接当前安装版；未安装 Grok 不影响使用。")
        : repairNeeded
          ? "检测到 Codex 连接需要更新；点击后将先备份再修复。Grok 始终保持可选且不会被修改。"
          : codexCurrent
            ? "Codex 已连接；可选 Grok 尚未就绪，但不影响当前生产。"
          : "未找到 Codex CLI，当前无法自动修复；Grok 不是必需项。",
    };
  });
  ipcMain.handle("canvas:repair-agent-connections", async (_event, projectRoot: string) => {
    await requireManagedStudioProject(projectRoot);
    if (!app.isPackaged) throw new Error("开发版禁止修改 Agent 配置；请使用 /Applications 中的安装版。");
    const [codexPath, launch] = await Promise.all([
      executableOnPath("codex"),
      packagedAgentRuntimeLaunch(),
    ]);
    if (!codexPath) throw new Error("必须先安装 Codex CLI；Grok 不是必需项，配置未修改。");
    const result = await repairCodexConnectionOnly({
      homeDirectory: os.homedir(),
      codexExecutable: codexPath,
      launch,
    });
    return {
      backupDirectory: result.backupDirectory,
      codex: result.codex,
      grok: result.grok,
    };
  });
  ipcMain.handle("canvas:pick-project", async (_event, title?: string) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: title || "选择 AI 漫剧项目主根" });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("canvas:pick-story-source", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], title: "选择小说或剧本原文", filters: [{ name: "原文文件", extensions: ["txt", "md", "markdown", "docx"] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("canvas:pick-otio", async () => {
    const result = await dialog.showOpenDialog({ title: "选择 OpenTimelineIO 时间线", properties: ["openFile"], filters: [{ name: "OpenTimelineIO", extensions: ["otio", "json"] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("canvas:remove-project", (_event, projectRoot: string) => removeProjectRegistration(projectRoot));
  ipcMain.handle("canvas:get-mcp-info", async (_event, _projectRoot: string) => {
    const serverPath = app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "dist-mcp", "mcp", "server.js")
      : path.join(app.getAppPath(), "dist-mcp", "mcp", "server.js");
    const available = await access(serverPath).then(() => true).catch(() => false);
    const identity = await resolveRuntimeBuildIdentity(app.isPackaged ? process.resourcesPath : app.getAppPath());
    const artifactSha256 = await runtimeArtifactSha256(serverPath);
    const manifestPath = path.join(process.resourcesPath, "release-manifest.json");
    const launch = app.isPackaged
      ? createPackagedMcpRuntimeLaunchContract({
        appExecutable: process.execPath,
        serverPath,
          releaseManifestPath: manifestPath,
          sourceDigest: identity.sourceDigest,
          runtimeArtifactSha256: artifactSha256,
          builtAt: identity.artifactBuiltAt ?? identity.builtAt,
        workspacePath: process.resourcesPath,
      })
      : {
        command: "/usr/bin/env" as const,
        args: ["ELECTRON_RUN_AS_NODE=1", process.execPath, serverPath] as const,
        cwd: path.dirname(serverPath),
        env: {
          AI_CANVAS_WORKSPACE: app.getAppPath(),
          AI_CANVAS_RECORDED_SOURCE_DIGEST: identity.sourceDigest,
          AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: artifactSha256,
          AI_CANVAS_BUILD_TIMESTAMP: identity.artifactBuiltAt ?? identity.builtAt,
        },
      };
    const config = `[mcp_servers.ai-drama-canvas]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\ncwd = ${JSON.stringify(launch.cwd)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\ndefault_tools_approval_mode = "writes"\n\n[mcp_servers.ai-drama-canvas.env]\n${Object.entries(launch.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`;
    return {
      serverPath,
      available,
      packaged: app.isPackaged,
      transport: "stdio" as const,
      toolCount: identity.capabilities.mcpToolCount,
      runtimeArtifactSha256: artifactSha256,
      config,
    };
  });
  // T16 MCP 热切换：健康检查与版本握手（新构建健康检查后优雅切换）
  ipcMain.handle("canvas:mcp-health-check", async (_event, _projectRoot: string) => {
    const serverPath = app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "dist-mcp", "mcp", "server.js")
      : path.join(app.getAppPath(), "dist-mcp", "mcp", "server.js");
    const available = await access(serverPath).then(() => true).catch(() => false);
    const identity = await resolveRuntimeBuildIdentity(app.isPackaged ? process.resourcesPath : app.getAppPath());
    return {
      healthy: available,
      version: identity.packageVersion,
      buildId: identity.buildId,
      sourceDigest: identity.sourceDigest,
      builtAt: identity.artifactBuiltAt ?? identity.builtAt,
      toolCount: identity.capabilities.mcpToolCount,
      serverPath,
    };
  });
  // 验收 7：构建身份只读展示——安装版读 App Resources 内受签名保护的 manifest，
  // 源码预览读工作区根 manifest；projectRoot 由渲染层传入当前工程并归一为绝对路径。
  ipcMain.handle("canvas:get-build-identity", async (_event, projectRoot?: string) => {
    const manifestPath = app.isPackaged
      ? path.join(process.resourcesPath, RELEASE_MANIFEST_FILE_NAME)
      : path.join(app.getAppPath(), RELEASE_MANIFEST_FILE_NAME);
    const fields = await readBuildIdentityManifestFields(manifestPath);
    return {
      ...fields,
      runtimeMode: app.isPackaged ? "packaged" as const : "source-dev" as const,
      manifestPath,
      projectRoot: typeof projectRoot === "string" && projectRoot.trim() ? path.resolve(projectRoot) : null,
    };
  });
  ipcMain.handle("canvas:copy-text", (_event, value: string) => clipboard.writeText(value));
  ipcMain.handle("canvas:save-project-config", async (_event, config: ProjectConfig) => {
    if (config?.primaryRoot) await requireLegacyProjectRoot(config.primaryRoot);
    return saveProjectConfig(config);
  });
  ipcMain.handle("canvas:list-script-documents", (_event, projectRoot: string) => listScriptDocuments(projectRoot));
  ipcMain.handle("canvas:read-script-document", (_event, projectRoot: string, filePath: string) => readScriptDocument(projectRoot, filePath));
  ipcMain.handle(
    "canvas:save-script-document",
    (_event, projectRoot: string, filePath: string, content: string, expectedModifiedAt?: string) =>
      saveScriptDocument(projectRoot, filePath, content, expectedModifiedAt),
  );
  ipcMain.handle(
    "canvas:create-script-document",
    (_event, projectRoot: string, input: { episode: number; unit: number; title: string; content?: string }) =>
      createScriptDocument(projectRoot, input),
  );
  ipcMain.handle("canvas:get-unit-timelines", (_event, projectRoot: string, episode?: number) => getUnitTimelines(projectRoot, episode));
  ipcMain.handle("canvas:list-continuity-tracks", (_event, projectRoot: string, query?: Parameters<typeof listContinuityTracks>[1]) =>
    listContinuityTracks(projectRoot, query),
  );
  ipcMain.handle("canvas:get-continuity-spans", (_event, projectRoot: string, assetId: string, query?: Parameters<typeof getContinuitySpans>[2]) =>
    getContinuitySpans(projectRoot, assetId, query),
  );
  ipcMain.handle("canvas:audit-fusion-panel-references", (_event, projectRoot: string) =>
    auditFusionPanelReferences(projectRoot),
  );
  ipcMain.handle("canvas:inspect-fusion-panel-reference-currentness", (_event, projectRoot: string) =>
    inspectFusionPanelReferenceCurrentness(projectRoot),
  );
  ipcMain.handle(
    "canvas:list-fusion-panel-reference-resolutions",
    (_event, projectRoot: string, query?: Parameters<typeof listFusionPanelReferenceResolutions>[1]) =>
      listFusionPanelReferenceResolutions(projectRoot, query),
  );
  ipcMain.handle(
    "canvas:get-fusion-panel-reference-resolution",
    (_event, projectRoot: string, contractId: string, panelId: string) =>
      getFusionPanelReferenceResolution(projectRoot, contractId, panelId),
  );
  ipcMain.handle("canvas:inspect-fusion-panel-visual-constraint-currentness", (_event, projectRoot: string) =>
    inspectFusionPanelVisualConstraintCurrentness(projectRoot),
  );
  ipcMain.handle(
    "canvas:get-fusion-panel-visual-constraint",
    (_event, projectRoot: string, contractId: string, panelId: string) =>
      getFusionPanelVisualConstraint(projectRoot, contractId, panelId),
  );
  ipcMain.handle(
    "canvas:list-derived-panel-reference-assets",
    (_event, projectRoot: string, query?: Parameters<typeof listDerivedPanelReferenceAssets>[1]) =>
      listDerivedPanelReferenceAssets(projectRoot, query),
  );
  ipcMain.handle("canvas:save-unit-timeline", (_event, projectRoot: string, unitId: string, timings: ShotTiming[]) =>
    saveUnitTimeline(projectRoot, unitId, timings),
  );
  ipcMain.handle("canvas:create-shot-task-pack", (_event, projectRoot: string, unitId: string, mode?: TaskPack["mode"]) =>
    createShotTaskPack(projectRoot, unitId, mode),
  );
  ipcMain.handle("canvas:set-authoritative-artifact", (_event, projectRoot: string, itemId: string, artifactId: string, note?: string) =>
    setAuthoritativeArtifact(projectRoot, itemId, artifactId, note),
  );
  ipcMain.handle("canvas:promote-asset-to-hard-lock", (_event, projectRoot: string, itemId: string, note?: string) =>
    promoteAssetToHardLock(projectRoot, itemId, note),
  );
  ipcMain.handle("canvas:get-generation-settings", (_event, projectRoot: string) => getGenerationSettings(projectRoot));
  ipcMain.handle("canvas:save-generation-settings", (_event, projectRoot: string, settings: GenerationSettings) => saveGenerationSettings(projectRoot, settings));
  ipcMain.handle("canvas:list-generation-jobs", (_event, projectRoot: string) => listGenerationJobs(projectRoot));
  ipcMain.handle(
    "canvas:enqueue-generation",
    (_event, projectRoot: string, input: { itemIds: string[]; kind: GenerationKind; providerId?: string; taskId?: string; prompt?: string }) =>
      enqueueGeneration(projectRoot, input),
  );
  ipcMain.handle("canvas:process-generation-queue", (_event, projectRoot: string, jobId?: string) => processGenerationQueue(projectRoot, { jobId }));
  ipcMain.handle("canvas:update-subagent-image-generation", (_event, projectRoot: string, jobId: string, input: Parameters<typeof updateSubagentImageGenerationJob>[2]) => updateSubagentImageGenerationJob(projectRoot, jobId, input));
  ipcMain.handle("canvas:cancel-generation-job", (_event, projectRoot: string, jobId: string) => cancelGenerationJob(projectRoot, jobId));
  ipcMain.handle("canvas:get-task-center", (_event, projectRoot: string) => getTaskCenter(projectRoot));
  ipcMain.handle(
    "canvas:create-task-pack",
    (
      _event,
      projectRoot: string,
      options: { itemIds?: string[]; episode?: number; mode?: TaskPack["mode"]; kind?: "image" | "video" },
    ) => createTaskPack(projectRoot, options),
  );
  ipcMain.handle("canvas:claim-task", (_event, projectRoot: string, taskId: string, input: Parameters<typeof claimTask>[2]) => claimTask(projectRoot, taskId, input));
  ipcMain.handle("canvas:heartbeat-task", (_event, projectRoot: string, taskId: string, input: Parameters<typeof heartbeatTask>[2]) => heartbeatTask(projectRoot, taskId, input));
  ipcMain.handle("canvas:release-task", (_event, projectRoot: string, taskId: string, input: Parameters<typeof releaseTask>[2]) => releaseTask(projectRoot, taskId, input));
  ipcMain.handle(
    "canvas:finish-batch",
    (
      _event,
      projectRoot: string,
      taskId: string,
      input: Parameters<typeof finishBatch>[2],
    ) => finishBatch(projectRoot, taskId, input),
  );
  ipcMain.handle("canvas:start-watch", async (_event, projectRoot: string) => {
    return startWatcher(await requireLegacyProjectRoot(projectRoot));
  });
  ipcMain.handle("canvas:stop-watch", async (_event, projectRoot?: string) => {
    await stopWatcher(projectRoot);
    return true;
  });
}

async function stopWatcher(projectRoot?: string): Promise<void> {
  const targetRoot = projectRoot ? path.resolve(projectRoot) : path.resolve(watchedRoot);
  // F-08c（main 审查）：仅当目标是当前监听工程时才停 watcher；其他工程只取消其手动扫描。
  manualScanControllers.get(targetRoot)?.abort("项目已切换，取消旧项目手动扫描。");
  manualScanControllers.delete(targetRoot);
  if (path.resolve(watchedRoot) !== targetRoot) return;
  // 即使稍后重新打开相同 root，也必须让旧 watcher incarnation 永久失效（ABA）。
  watcherEpoch += 1;
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = null;
  watcherScanController?.abort("项目监听已停止。");
  watcherScanController = null;
  await Promise.allSettled([watcher?.close(), semanticWatcher?.close()]);
  watcher = null;
  semanticWatcher = null;
  watchedRoot = DEFAULT_PROJECT_ROOT;
}

function legacyWatcherIdentityIsCurrent(identity: LegacyWatcherIdentity): boolean {
  return identity.watcherEpoch === watcherEpoch
    && identity.projectRoot === path.resolve(watchedRoot);
}

async function startWatcher(projectRoot: string): Promise<LegacyWatcherIdentity> {
  await stopWatcher(watchedRoot);
  const resolvedRoot = path.resolve(projectRoot);
  watchedRoot = resolvedRoot;
  const identity: LegacyWatcherIdentity = {
    projectRoot: resolvedRoot,
    watcherEpoch: ++watcherEpoch,
  };
  if (await isManagedProject(resolvedRoot)) {
    await getManagedProjectShell(resolvedRoot);
    if (!legacyWatcherIdentityIsCurrent(identity)) throw new Error("项目监听请求已被更新的工程替代。");
    return identity;
  }
  if (!legacyWatcherIdentityIsCurrent(identity)) throw new Error("项目监听请求已被更新的工程替代。");
  watcher = chokidar.watch(resolvedRoot, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 120 },
    ignored: (candidate) => {
      const normalized = candidate.replaceAll("\\", "/");
      return normalized.includes("/.aicanvas/") || normalized.endsWith("/00_画布进度.md") || normalized.includes("/.git/");
    },
  });
  const schedule = (changedPath: string) => {
    if (!legacyWatcherIdentityIsCurrent(identity)) return;
    if (!isRelevantFile(changedPath)) return;
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherScanController?.abort("检测到更新文件，取消旧扫描并合并为新一轮。");
    watcherTimer = setTimeout(async () => {
      watcherTimer = null;
      const controller = new AbortController();
      watcherScanController = controller;
      try {
        const index = await runRuntimeGatedBackgroundWrite(
          "legacy-project-watcher-scan",
          () => trackActiveScan(scanAndPersist(identity.projectRoot, { signal: controller.signal })),
        );
        if (!legacyWatcherIdentityIsCurrent(identity)) return;
        mainWindow?.webContents.send("canvas:index-updated", index);
      } catch (error) {
        if (legacyWatcherIdentityIsCurrent(identity)
          && !(error instanceof Error && error.name === "AbortError")) {
          mainWindow?.webContents.send("canvas:watch-error", error instanceof Error ? error.message : String(error));
        }
        if (error && typeof error === "object" && "code" in error
          && (error as { code?: unknown }).code === "runtime-restart-required") {
          await stopWatcher(identity.projectRoot);
        }
      } finally {
        if (watcherScanController === controller) watcherScanController = null;
      }
    }, 1_200);
  };
  watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
  const semanticPath = path.resolve(getSidecarPaths(identity.projectRoot).canvasSemantic);
  semanticWatcher = chokidar.watch(getSidecarPaths(identity.projectRoot).root, {
    ignoreInitial: true,
    persistent: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 80 },
  });
  const sendSemanticState = async (changedPath: string) => {
    if (!legacyWatcherIdentityIsCurrent(identity)) return;
    if (path.resolve(changedPath) !== semanticPath) return;
    try {
      const state = await getCanvasSemanticState(identity.projectRoot);
      if (!legacyWatcherIdentityIsCurrent(identity)) return;
      mainWindow?.webContents.send("canvas:semantic-updated", {
        ...identity,
        state,
      });
    } catch (error) {
      if (legacyWatcherIdentityIsCurrent(identity)) {
        mainWindow?.webContents.send("canvas:watch-error", error instanceof Error ? error.message : String(error));
      }
    }
  };
  semanticWatcher.on("add", sendSemanticState).on("change", sendSemanticState).on("unlink", sendSemanticState);
  return identity;
}

function isRelevantFile(filePath: string): boolean {
  return /00_信息\.md$|EP.*15s.*\.(md|txt)$|EP.*镜.*\.(md|txt)$|_(raw|labeled)\.png$|\.(mp4|mov|webm|m4v)$|shot_manifest\.json$/i.test(
    filePath,
  );
}

// P27（main 审查 F-04）：单实例锁——第二实例聚焦已有窗口后退出，防双窗口并发写同一工程。
// 盲审 F-8：官方 else 模式——quit 后不再注册 whenReady 回调。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
  await startSourceRuntimeGateWatchers();
  protocol.handle("aicanvas-studio", async (request) => {
    try {
      const url = new URL(request.url);
      const projectRoot = url.searchParams.get("projectRoot");
      const target = url.hostname;
      const key = decodeURIComponent(url.pathname.replace(/^\//u, ""));
      if (!projectRoot || (target !== "media" && target !== "thumbnail" && target !== "derivative") || !/^[a-f0-9]{64}$/u.test(key)) {
        return new Response("Invalid managed media request", { status: 400 });
      }
      const rangeHeader = request.headers.get("range");
      const result = await streamStudioMediaRequest(projectRoot, target === "media"
        ? { mediaSha256: key, rangeHeader }
        : target === "thumbnail"
          ? { thumbnailRecipeKey: key, rangeHeader }
          : { derivativeRecipeKey: key, rangeHeader });
      if (result.resolution.status === 416) {
        return new Response(null, { status: 416, headers: result.resolution.headers });
      }
      const body = result.stream ? Readable.toWeb(result.stream) as unknown as BodyInit : null;
      return new Response(body, { status: result.resolution.status, headers: result.resolution.headers });
    } catch (error) {
      if (error instanceof StudioMediaProtocolError) return new Response(error.message, { status: error.httpStatus });
      return new Response("Managed media request failed", { status: 500 });
    }
  });
  const legacyThumbnailCacheRoot = path.join(app.getPath("userData"), "legacy-thumbnails");
  // P27（main 审查 F-01）：aicanvas-asset 协议加根限制（core/legacy-asset-confinement，可单测）。
  const legacyAssetContentType = (filePath: string): string => {
    const extension = path.extname(filePath).toLowerCase();
    return extension === ".png" ? "image/png"
      : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg"
      : extension === ".webp" ? "image/webp"
      : extension === ".gif" ? "image/gif"
      : extension === ".svg" ? "image/svg+xml"
      : extension === ".mp4" ? "video/mp4"
      : extension === ".webm" ? "video/webm"
      : extension === ".mov" ? "video/quicktime"
      : extension === ".mp3" ? "audio/mpeg"
      : extension === ".wav" ? "audio/wav"
      : "application/octet-stream";
  };
  protocol.handle("aicanvas-asset", async (request) => {
    const url = new URL(request.url);
    const requestedPath = url.searchParams.get("path");
    if (!requestedPath) return new Response("Missing path", { status: 400 });
    const expectedSha256 = url.searchParams.get("sha256");
    if (expectedSha256 && !/^[a-f0-9]{64}$/u.test(expectedSha256)) return new Response("Invalid SHA-256", { status: 400 });
    const absolutePath = path.resolve(requestedPath);
    try {
      const canonicalPath = await resolveLegacyAssetPath(absolutePath);
      if (!canonicalPath) return new Response("Path outside registered project roots or unsafe file identity", { status: 403 });
      if (!expectedSha256 && !isLegacyUnhashedMediaPathAllowed(canonicalPath)) {
        return new Response("Unhashed legacy requests are limited to media files", { status: 403 });
      }
      const asset = await readLegacyAssetBytes(canonicalPath);
      if (!asset) return new Response("Path outside registered project roots or unsafe file identity", { status: 403 });
      if (expectedSha256) {
        if (asset.sha256 !== expectedSha256) return new Response("Content SHA-256 mismatch", { status: 409 });
        // sha 已验证：thumb=1 时可安全改供由该内容派生的缩略图（F-01 修复：校验先于缩略分支）。
        if (url.searchParams.get("thumb") === "1") {
          const thumbnail = await resolveLegacyThumbnailFromBytes(legacyThumbnailCacheRoot, `${asset.canonicalPath}:${asset.sha256}`, asset.bytes);
          if (thumbnail) {
            const thumbBytes = await readFile(thumbnail.path);
            return new Response(new Uint8Array(thumbBytes), { status: 200, headers: { "content-type": "image/webp", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
          }
        }
        return new Response(new Uint8Array(asset.bytes), { status: 200, headers: { "content-type": legacyAssetContentType(asset.canonicalPath), "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      // P18：thumb=1 时优先返回懒生成的 512px WebP 缩略图；不可用时回退原图，不阻断渲染。
      if (url.searchParams.get("thumb") === "1") {
        const thumbnail = await resolveLegacyThumbnailFromBytes(legacyThumbnailCacheRoot, `${asset.canonicalPath}:${asset.sha256}`, asset.bytes);
        if (thumbnail) {
          const thumbBytes = await readFile(thumbnail.path);
          return new Response(new Uint8Array(thumbBytes), { status: 200, headers: { "content-type": "image/webp", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        }
      }
      return new Response(new Uint8Array(asset.bytes), { status: 200, headers: { "content-type": legacyAssetContentType(asset.canonicalPath), "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  registerIpc();
  await createWindow();
  // T11 启动重放：对当前活跃工程补缀并重放未消费画布投影事件（重启恢复）。
  // 失败不阻断启动，仅记诊断；消费方按 projectionRevision 幂等应用。
  void getActiveProject()
    .then((active) => (active?.available
      ? runRuntimeGatedBackgroundWrite(
        "canvas-projection-outbox-startup-replay",
        () => reconcileAndReplayCanvasProjectionOutbox(active.primaryRoot, "启动重放"),
      )
      : undefined))
    .catch((error) => {
      console.warn("[canvas-outbox] 启动重放被运行时写闸门拒绝或失败：", error instanceof Error ? error.message : String(error));
    });
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!quitSessionCleanupStarted && (activeEditorSessions.size > 0 || activeScanPromises.size > 0)) {
    event.preventDefault();
    quitSessionCleanupStarted = true;
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherScanController?.abort("应用正在退出。");
    for (const controller of manualScanControllers.values()) controller.abort("应用正在退出。");
    const scans = [...activeScanPromises];
    void Promise.allSettled([
      cleanupActiveEditorSessions(),
      watcher?.close(),
      semanticWatcher?.close(),
      generationLedgerWatcher?.close(),
      closeSourceRuntimeGateWatchers(),
      ...scans,
    ]).finally(() => app.quit());
    return;
  }
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherScanController?.abort("应用正在退出。");
  for (const controller of manualScanControllers.values()) controller.abort("应用正在退出。");
  manualScanControllers.clear();
  void watcher?.close();
  void semanticWatcher?.close();
  void generationLedgerWatcher?.close();
  void closeSourceRuntimeGateWatchers();
});
