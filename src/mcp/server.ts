import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT_ROOT } from "../core/constants.js";
import {
  cancelTask,
  claimTask,
  createTaskPack,
  finishBatch,
  heartbeatTask,
  getItem,
  getProjectIndex,
  getNextTask,
  getProgress,
  listProjects,
  promoteAssetToHardLock,
  previewProjectScan,
  registerArtifact,
  releaseTask,
  scanAndPersist,
  setAuthoritativeArtifact,
  summarizeForMcp,
  updateStatus,
  verifyItem,
} from "../core/service.js";
import { listScriptDocuments, readScriptDocument, saveScriptDocument } from "../core/documents.js";
import { cancelGenerationJob, enqueueGeneration, getBrowserGenerationPlan, getGenerationProvider, getGenerationSettings, getHttpGenerationSubmissionCheckpoint, getSubagentImageGenerationPlan, listGenerationJobs, processGenerationQueue, reconcileHttpGenerationSubmission, updateBrowserGenerationJob, updateSubagentImageGenerationJob, upsertGenerationProvider } from "../core/generation.js";
import { createShotTaskPack, getUnitTimelines, saveUnitTimeline } from "../core/timeline.js";
import { deleteCanvasEntity, deleteCanvasLink, getCanvasHistoryInfo, getCanvasSemanticState, redoCanvasSemanticState, undoCanvasSemanticState, upsertCanvasEntity, upsertCanvasLink } from "../core/canvas-state.js";
import { BROWSER_PREFLIGHT_BLOCKER_CODES, PRODUCTION_WORKFLOW_STAGE_IDS, WORK_ITEM_STATUSES } from "../core/types.js";
import { REVIEW_ANNOTATION_TYPES, REVIEW_CRITERIA_KEYS } from "../core/types.js";
import { getReviewQueue, listReviewRecords, submitReview } from "../core/reviews.js";
import { commitProjectImport, prepareProjectImport } from "../core/importer.js";
import { listAgentSkills, readAgentSkill, saveAgentSkill } from "../core/skills.js";
import { createContinuationHandoff, deleteProjectContext, getContinuationSnapshot, listProjectContext, searchProjectContext, upsertProjectContext } from "../core/memory.js";
import { PROJECT_CONTEXT_KINDS } from "../core/types.js";
import { withAdaptation, type AdaptationModule } from "../core/adaptation-lazy.js";
import { withEditor } from "../core/editor-lazy.js";
import { withNovelAgent, type NovelAgentModule } from "../core/novel-agent-lazy.js";
import { withStory, type StoryModule } from "../core/story-lazy.js";
import { withNovelAnalysis, type NovelAnalysisModule } from "../core/novel-analysis-lazy.js";
import { withNovelAnalysisProvider, type NovelAnalysisProviderModule } from "../core/novel-analysis-provider-lazy.js";
import { editKeyframeCurveIssue, editKeyframeSourceTransformIssue } from "../core/keyframe-curve.js";
import { doctorProject, getCapabilities, getProjectChanges, getProjectSnapshot, getStudioGenerationControlEnvelope } from "../core/codex.js";
import { analyzeChangeImpact, commitExistingProductionRecovery, getProductionWorkflow, getStoryboard, listCreativeBibles, previewExistingProductionRecovery, updateProductionWorkflowStage, upsertCreativeBible, upsertStoryboardRow } from "../core/production.js";
import { listTaskPacks, loadIndex } from "../core/sidecar.js";
import { executeIdempotentCommand, isStudioCommandRequest, listCommandLedger, reconcileCommand, type CommandRequest } from "../core/command-bus.js";
import { isRejectedCommandFailure } from "../core/command-outcome.js";
import { classifyToolError } from "../core/tool-error-classification.js";
import {
  withStudioEpisodeEarliest,
  withStudioMultimediaTimeline,
  withStudioProductionDashboard,
  withStudioProductionProjectionBundle,
  withStudioProjectWriteLease,
  withStudioScriptLibraryReader,
  withStudioScriptMediaAlign,
  withStudioSsl5MissingToGen,
  type StudioEpisodeEarliestModule,
  type StudioMultimediaTimelineModule,
  type StudioProductionDashboardModule,
  type StudioProductionProjectionBundleModule,
  type StudioProjectWriteLeaseModule,
  type StudioScriptLibraryReaderModule,
  type StudioScriptMediaAlignModule,
  type StudioSsl5MissingToGenModule,
} from "../core/studio-readonly-diagnostics-lazy.js";
import type { StudioProductionDashboardQuery } from "../core/studio-production-dashboard.js";
import { listAssetRelations, listVoiceIdentities, upsertAssetRelation, upsertVoiceIdentity } from "../core/asset-registry.js";
import type { EditProject, GenerationJob, GenerationProvider, GenerationSettings } from "../core/types.js";
import { PUBLICATION_KINDS, PUBLICATION_PURPOSES, PUBLICATION_VARIANTS, listPublicationIntents, listPublicationReceipts } from "../core/publication.js";
import { isNovelWritingStateRejectedError } from "../core/novel-writing-state.js";
import { NOVEL_MANUSCRIPT_COMMAND_SCHEMA_OPTIONS } from "../core/novel-command-runtime.js";
import type { ScanProgress } from "../core/scanner.js";
import { inspectFusionPackage } from "../core/fusion-package.js";
import { loadFusionProductionAssets } from "../core/fusion-production.js";
import {
  getCanonicalAsset,
  getCanonicalAssetCatalogState,
  listCanonicalAssets,
  type CanonicalAssetDetail,
} from "../core/canonical-assets.js";
import { getContinuitySpans, listContinuityTracks } from "../core/continuity.js";
import { FUSION_ASSET_CONSISTENCY_CRITERIA, getFusionAssetConsistencyState } from "../core/fusion-asset-consistency.js";
import {
  getFusionPanelReferenceResolution,
  inspectFusionPanelReferenceAudit,
  listDerivedPanelReferenceAssets,
  listFusionPanelReferenceResolutions,
  type PanelReferenceResolution,
} from "../core/fusion-panel-references.js";
import {
  auditFusionPanelVisualConstraints,
  getFusionPanelVisualConstraint,
  listFusionPanelVisualConstraints,
} from "../core/fusion-visual-constraint-store.js";
import {
  getFusionStoryboardSheetState,
  listFusionStoryboardSheets,
} from "../core/fusion-storyboard-sheet-evidence.js";
import {
  PANEL_VISUAL_WARNING_CODES,
  type PanelVisualConstraint,
} from "../core/fusion-visual-constraints.js";
import { inspectManagedProject } from "../core/managed-project.js";
import {
  withLocalCreativeIngestStatus,
  withLocalCreativePreview,
  type LocalCreativeIngestStatusModule,
  type LocalCreativePreviewModule,
} from "../core/local-creative-lazy.js";
import {
  getMaterialStudioState,
  getStudioCanonicalAsset,
  listStudioCanonicalAssets,
  listStudioMedia,
  listStudioMediaImportOrigins,
} from "../core/material-studio.js";
import {
  getLatestStudioTextRevisionMetadata,
  getStudioProductionState,
  getStudioTextRevision,
  listStudioProductionUnits,
  listStudioTextDocuments,
  queryStudioAssetTimeline,
  readStudioProductionUnitSnapshotForCodex,
} from "../core/studio-production.js";
import {
  getStudioBindingSection,
  getStudioBindingControl,
  listStudioBindingSections,
  listStudioBindingUnits,
} from "../core/studio-binding-control.js";
import { evaluateStudioReviewTargetConsistency, getStudioContinuityReviewControl, resolveLatestStudioGenerationRunForPanel } from "../core/studio-continuity-review-control.js";
import { getStudioGenerationTrace, getStudioScriptRevisionImpact } from "../core/studio-trace.js";
import {
  getStudioEpisodeMissingMediaReport,
  getStudioEpisodeUnitMediaMap,
  getStudioScriptLibraryIndex,
  resolveScriptSpanMediaMap,
  withSpanMediaConsistencyPeeks,
} from "../core/studio-script-library-projection.js";
import { openStudioStoryboardWizard } from "../core/studio-storyboard-wizard.js";
import { suggestStudioStoryboardDraft } from "../core/studio-storyboard-draft.js";
import { runStudioFusionHelper } from "../core/studio-fusion-product-helpers.js";
import { executeStudioShotCompose } from "../core/studio-shot-compose.js";
import {
  resolveRuntimeBuildIdentity,
  sourceDigestPathIsRelevant,
  sourceDigestWatchPaths,
} from "../core/build-identity.js";
import {
  createRuntimeGateController,
  type RuntimeBootIdentity,
  type RuntimeWriteGateStatus,
} from "../core/runtime-write-gate.js";
import {
  runtimeMcpEffect,
  runtimeMcpGateMode,
} from "../core/runtime-mcp-effect.js";
import { createRuntimeMcpPerformanceProbe } from "../core/runtime-mcp-observability.js";
import { getActiveManagedStudioContext } from "../core/active-managed-studio-context.js";
import { withDuduReadonlyImport, type DuduReadonlyImportModule } from "../core/dudu-readonly-import-lazy.js";
import { withStudioVideoPackage, type StudioVideoPackageModule } from "../core/studio-video-package-lazy.js";
import type { StudioVideoPackageAuthorityInput } from "../core/studio-video-package.js";
import {
  withHiggsfieldQueue,
  withHiggsfieldVideo,
  type HiggsfieldQueueModule,
  type HiggsfieldVideoModule,
} from "../core/studio-higgsfield-lazy.js";
import { projectHiggsfieldPrepareConnectorRequestForMcp } from "../core/studio-higgsfield-mcp-projection.js";
import { AI_CANVAS_APPLICATION_VERSION, readRuntimeReleaseManifest } from "../core/release-manifest.js";
import { STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS, studioSha256Schema } from "../core/studio-command-runtime.js";
import { ensureConfinedDirectory } from "../core/confined-project-storage.js";
import { createMcpToolRegistrar } from "./tool-registrar.js";

const buildStoryContext = (...args: Parameters<StoryModule["buildStoryContext"]>) =>
  withStory((story) => story.buildStoryContext(...args));
const connectStoryEvents = (...args: Parameters<StoryModule["connectStoryEvents"]>) =>
  withStory((story) => story.connectStoryEvents(...args));
const importStoryFile = (...args: Parameters<StoryModule["importStoryFile"]>) =>
  withStory((story) => story.importStoryFile(...args));
const importStoryText = (...args: Parameters<StoryModule["importStoryText"]>) =>
  withStory((story) => story.importStoryText(...args));
const listStoryChapters = (...args: Parameters<StoryModule["listStoryChapters"]>) =>
  withStory((story) => story.listStoryChapters(...args));
const listStoryEvents = (...args: Parameters<StoryModule["listStoryEvents"]>) =>
  withStory((story) => story.listStoryEvents(...args));
const listStorySources = (...args: Parameters<StoryModule["listStorySources"]>) =>
  withStory((story) => story.listStorySources(...args));
const readStoryChapter = (...args: Parameters<StoryModule["readStoryChapter"]>) =>
  withStory((story) => story.readStoryChapter(...args));
const upsertStoryEvent = (...args: Parameters<StoryModule["upsertStoryEvent"]>) =>
  withStory((story) => story.upsertStoryEvent(...args));
const analyzeAdaptationChangeImpact = (...args: Parameters<AdaptationModule["analyzeAdaptationChangeImpact"]>) =>
  withAdaptation((adaptation) => adaptation.analyzeAdaptationChangeImpact(...args));
const analyzeNovelChapters = (...args: Parameters<AdaptationModule["analyzeNovelChapters"]>) =>
  withAdaptation((adaptation) => adaptation.analyzeNovelChapters(...args));
const exportAdaptation = (...args: Parameters<AdaptationModule["exportAdaptation"]>) =>
  withAdaptation((adaptation) => adaptation.exportAdaptation(...args));
const generateAdaptationPlans = (...args: Parameters<AdaptationModule["generateAdaptationPlans"]>) =>
  withAdaptation((adaptation) => adaptation.generateAdaptationPlans(...args));
const getAdaptationWorkspace = (...args: Parameters<AdaptationModule["getAdaptationWorkspace"]>) =>
  withAdaptation((adaptation) => adaptation.getAdaptationWorkspace(...args));
const materializeSelectedAdaptationPlan = (...args: Parameters<AdaptationModule["materializeSelectedAdaptationPlan"]>) =>
  withAdaptation((adaptation) => adaptation.materializeSelectedAdaptationPlan(...args));
const regenerateAdaptationScope = (...args: Parameters<AdaptationModule["regenerateAdaptationScope"]>) =>
  withAdaptation((adaptation) => adaptation.regenerateAdaptationScope(...args));
const selectAdaptationPlan = (...args: Parameters<AdaptationModule["selectAdaptationPlan"]>) =>
  withAdaptation((adaptation) => adaptation.selectAdaptationPlan(...args));
const upsertNarrativeBeat = (...args: Parameters<AdaptationModule["upsertNarrativeBeat"]>) =>
  withAdaptation((adaptation) => adaptation.upsertNarrativeBeat(...args));
const upsertNovelFact = (...args: Parameters<AdaptationModule["upsertNovelFact"]>) =>
  withAdaptation((adaptation) => adaptation.upsertNovelFact(...args));
const validateAdaptationPlan = (...args: Parameters<AdaptationModule["validateAdaptationPlan"]>) =>
  withAdaptation((adaptation) => adaptation.validateAdaptationPlan(...args));
const listNovelAnalysisReviews = (...args: Parameters<NovelAnalysisModule["listNovelAnalysisReviews"]>) =>
  withNovelAnalysis((novelAnalysis) => novelAnalysis.listNovelAnalysisReviews(...args));
const getNovelAnalysisProviderSettings = (...args: Parameters<NovelAnalysisProviderModule["getNovelAnalysisProviderSettings"]>) =>
  withNovelAnalysisProvider((provider) => provider.getNovelAnalysisProviderSettings(...args));
const probeNovelAnalysisProvider = (...args: Parameters<NovelAnalysisProviderModule["probeNovelAnalysisProvider"]>) =>
  withNovelAnalysisProvider((provider) => provider.probeNovelAnalysisProvider(...args));
const getNovelAnalysisRunProgress = (...args: Parameters<NovelAnalysisProviderModule["getNovelAnalysisRunProgress"]>) =>
  withNovelAnalysisProvider((provider) => provider.getNovelAnalysisRunProgress(...args));
const listNovelAnalysisRunProgress = (...args: Parameters<NovelAnalysisProviderModule["listNovelAnalysisRunProgress"]>) =>
  withNovelAnalysisProvider((provider) => provider.listNovelAnalysisRunProgress(...args));
const getNovelAnalysisExecutionRecoveryStatus = (...args: Parameters<NovelAnalysisProviderModule["getNovelAnalysisExecutionRecoveryStatus"]>) =>
  withNovelAnalysisProvider((provider) => provider.getNovelAnalysisExecutionRecoveryStatus(...args));
const buildNovelContextPack = (...args: Parameters<NovelAgentModule["buildNovelContextPack"]>) =>
  withNovelAgent((novelAgent) => novelAgent.buildNovelContextPack(...args));
const compareNovelWritingSourceReceipts = (...args: Parameters<NovelAgentModule["compareNovelWritingSourceReceipts"]>) =>
  withNovelAgent((novelAgent) => novelAgent.compareNovelWritingSourceReceipts(...args));
const doctorNovelAgent = (...args: Parameters<NovelAgentModule["doctorNovelAgent"]>) =>
  withNovelAgent((novelAgent) => novelAgent.doctorNovelAgent(...args));
const getNovelManuscriptWorkspace = (...args: Parameters<NovelAgentModule["getNovelManuscriptWorkspace"]>) =>
  withNovelAgent((novelAgent) => novelAgent.getNovelManuscriptWorkspace(...args));
const getNovelSearchIndexStatus = (...args: Parameters<NovelAgentModule["getNovelSearchIndexStatus"]>) =>
  withNovelAgent((novelAgent) => novelAgent.getNovelSearchIndexStatus(...args));
const getNovelStateRebuildStatus = (...args: Parameters<NovelAgentModule["getNovelStateRebuildStatus"]>) =>
  withNovelAgent((novelAgent) => novelAgent.getNovelStateRebuildStatus(...args));
const getNovelWritingState = (...args: Parameters<NovelAgentModule["getNovelWritingState"]>) =>
  withNovelAgent((novelAgent) => novelAgent.getNovelWritingState(...args));
const listNovelManuscriptChapters = (...args: Parameters<NovelAgentModule["listNovelManuscriptChapters"]>) =>
  withNovelAgent((novelAgent) => novelAgent.listNovelManuscriptChapters(...args));
const listNovelWritingSourceReceipts = (...args: Parameters<NovelAgentModule["listNovelWritingSourceReceipts"]>) =>
  withNovelAgent((novelAgent) => novelAgent.listNovelWritingSourceReceipts(...args));
const planNovelStateRebuild = (...args: Parameters<NovelAgentModule["planNovelStateRebuild"]>) =>
  withNovelAgent((novelAgent) => novelAgent.planNovelStateRebuild(...args));
const probeNovelChapterConsistency = (...args: Parameters<NovelAgentModule["probeNovelChapterConsistency"]>) =>
  withNovelAgent((novelAgent) => novelAgent.probeNovelChapterConsistency(...args));
const preflightNovelChapterWrite = (...args: Parameters<NovelAgentModule["preflightNovelChapterWrite"]>) =>
  withNovelAgent((novelAgent) => novelAgent.preflightNovelChapterWrite(...args));
const prepareNovelChapterWrite = (...args: Parameters<NovelAgentModule["prepareNovelChapterWrite"]>) =>
  withNovelAgent((novelAgent) => novelAgent.prepareNovelChapterWrite(...args));
const readNovelManuscriptRange = (...args: Parameters<NovelAgentModule["readNovelManuscriptRange"]>) =>
  withNovelAgent((novelAgent) => novelAgent.readNovelManuscriptRange(...args));
const searchNovelManuscript = (...args: Parameters<NovelAgentModule["searchNovelManuscript"]>) =>
  withNovelAgent((novelAgent) => novelAgent.searchNovelManuscript(...args));
const getLocalCreativeProjectIngestStatus = (...args: Parameters<LocalCreativeIngestStatusModule["getLocalCreativeProjectIngestStatus"]>) =>
  withLocalCreativeIngestStatus((ingest) => ingest.getLocalCreativeProjectIngestStatus(...args));
const previewLocalCreativeProductionUnits = (...args: Parameters<LocalCreativePreviewModule["previewLocalCreativeProductionUnits"]>) =>
  withLocalCreativePreview((preview) => preview.previewLocalCreativeProductionUnits(...args));
const discoverDuduReadonlyImportProjects = (...args: Parameters<DuduReadonlyImportModule["discoverDuduReadonlyImportProjects"]>) =>
  withDuduReadonlyImport((dudu) => dudu.discoverDuduReadonlyImportProjects(...args));
const getDuduReadonlyImportControl = (...args: Parameters<DuduReadonlyImportModule["getDuduReadonlyImportControl"]>) =>
  withDuduReadonlyImport((dudu) => dudu.getDuduReadonlyImportControl(...args));
const resolveDuduReadonlyImportCommandRoot = (...args: Parameters<DuduReadonlyImportModule["resolveDuduReadonlyImportCommandRoot"]>) =>
  withDuduReadonlyImport((dudu) => dudu.resolveDuduReadonlyImportCommandRoot(...args));
const getStudioVideoPackageControl = (...args: Parameters<StudioVideoPackageModule["getStudioVideoPackageControl"]>) =>
  withStudioVideoPackage((videoPackage) => videoPackage.getStudioVideoPackageControl(...args));
const getStudioHiggsfieldVideoGenerationControl = (...args: Parameters<HiggsfieldVideoModule["getStudioHiggsfieldVideoGenerationControl"]>) =>
  withHiggsfieldVideo((higgsfield) => higgsfield.getStudioHiggsfieldVideoGenerationControl(...args));
const getStudioHiggsfieldConnectorWorkQueue = (...args: Parameters<HiggsfieldQueueModule["getStudioHiggsfieldConnectorWorkQueue"]>) =>
  withHiggsfieldQueue((queue) => queue.getStudioHiggsfieldConnectorWorkQueue(...args));
const getStudioEpisodeEarliest = (...args: Parameters<StudioEpisodeEarliestModule["getStudioEpisodeEarliest"]>) =>
  withStudioEpisodeEarliest((earliest) => earliest.getStudioEpisodeEarliest(...args));
const buildStudioProductionProjectionBundle = (...args: Parameters<StudioProductionProjectionBundleModule["buildStudioProductionProjectionBundle"]>) =>
  withStudioProductionProjectionBundle((bundle) => bundle.buildStudioProductionProjectionBundle(...args));
const getStudioProductionDashboard = (...args: Parameters<StudioProductionDashboardModule["getStudioProductionDashboard"]>) =>
  withStudioProductionDashboard((dashboard) => dashboard.getStudioProductionDashboard(...args));
const getStudioMultimediaTimelineProjection = (...args: Parameters<StudioMultimediaTimelineModule["getStudioMultimediaTimelineProjection"]>) =>
  withStudioMultimediaTimeline((timeline) => timeline.getStudioMultimediaTimelineProjection(...args));
const getStudioProjectWriteLeasePublic = (...args: Parameters<StudioProjectWriteLeaseModule["getStudioProjectWriteLeasePublic"]>) =>
  withStudioProjectWriteLease((writeLease) => writeLease.getStudioProjectWriteLeasePublic(...args));
const acquireStudioProjectWriteLease = (...args: Parameters<StudioProjectWriteLeaseModule["acquireStudioProjectWriteLease"]>) =>
  withStudioProjectWriteLease((writeLease) => writeLease.acquireStudioProjectWriteLease(...args));
const heartbeatStudioProjectWriteLease = (...args: Parameters<StudioProjectWriteLeaseModule["heartbeatStudioProjectWriteLease"]>) =>
  withStudioProjectWriteLease((writeLease) => writeLease.heartbeatStudioProjectWriteLease(...args));
const releaseStudioProjectWriteLease = (...args: Parameters<StudioProjectWriteLeaseModule["releaseStudioProjectWriteLease"]>) =>
  withStudioProjectWriteLease((writeLease) => writeLease.releaseStudioProjectWriteLease(...args));
const recommendGenerationUnknownDisposition = (...args: Parameters<StudioProjectWriteLeaseModule["recommendGenerationUnknownDisposition"]>) =>
  withStudioProjectWriteLease((writeLease) => writeLease.recommendGenerationUnknownDisposition(...args));
const getStudioScriptReaderView = (...args: Parameters<StudioScriptLibraryReaderModule["getStudioScriptReaderView"]>) =>
  withStudioScriptLibraryReader((reader) => reader.getStudioScriptReaderView(...args));
const getStudioScriptMediaAlignBoard = (...args: Parameters<StudioScriptMediaAlignModule["getStudioScriptMediaAlignBoard"]>) =>
  withStudioScriptMediaAlign((align) => align.getStudioScriptMediaAlignBoard(...args));
const planSsl5MissingToGen = (...args: Parameters<StudioSsl5MissingToGenModule["planSsl5MissingToGen"]>) =>
  withStudioSsl5MissingToGen((ssl5) => ssl5.planSsl5MissingToGen(...args));

const server = new McpServer({
  name: "ai-drama-canvas",
  version: AI_CANVAS_APPLICATION_VERSION,
}, {
  instructions: [
    "这是 AI 漫剧画布的本机受管 Studio 服务。",
    "新会话先调用 get_capabilities，再调用零参数 get_active_managed_studio_context；禁止从项目列表静默选第一项。",
    "用户说‘继续当前项目’时，沿活动工程返回的 nextAction 和 UI locator 工作。",
    "生图标准环：readiness → freeze → plan → dispatch(provider=codex|grok) → unit-grid pre-call intent → Agent 单次生图 → 原子 raw/labeled 写回 → Review。",
    "所有写入走 execute_command；歧义、未锁、输入漂移、provider 错配或构建过期必须失败关闭。",
    "多代理写同一工程前先 acquire_studio_project_write_lease；有租约时异主禁止生图相关写；generation_unknown 只对账禁止 re-dispatch。",
  ].join(" "),
});

const MCP_RUNTIME_ARTIFACT_PATH = fileURLToPath(import.meta.url);
const MCP_RUNTIME_ARTIFACT_SHA256 = readFile(MCP_RUNTIME_ARTIFACT_PATH)
  .then((bytes) => createHash("sha256").update(bytes).digest("hex"));
const MCP_RUNTIME_WORKSPACE = path.resolve(
  process.env.AI_CANVAS_WORKSPACE?.trim()
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const MCP_RUNTIME_BUILD_IDENTITY = resolveRuntimeBuildIdentity(MCP_RUNTIME_WORKSPACE);
const MCP_RUNTIME_RELEASE_MANIFEST = readRuntimeReleaseManifest();
const MCP_RUNTIME_BOOT_IDENTITY: Promise<RuntimeBootIdentity> = Promise.all([
  MCP_RUNTIME_BUILD_IDENTITY,
  MCP_RUNTIME_ARTIFACT_SHA256,
  MCP_RUNTIME_RELEASE_MANIFEST,
]).then(([identity, loadedArtifactSha256, releaseManifest]) => {
  const explicitManifestPath = process.env.AI_CANVAS_RELEASE_MANIFEST_PATH?.trim();
  const sourceIdentityMode = releaseManifest
    && explicitManifestPath
    && path.dirname(path.resolve(explicitManifestPath)) === MCP_RUNTIME_WORKSPACE
    ? "release-manifest" as const
    : "workspace" as const;
  return ({
  schemaVersion: 1,
  kind: "runtime-boot-identity",
  runtimeBootId: `mcp-${process.pid}-${Date.now()}`,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  sourceIdentityMode,
  workspace: MCP_RUNTIME_WORKSPACE,
  loadedArtifactPath: MCP_RUNTIME_ARTIFACT_PATH,
  loadedArtifactSha256,
  artifactSourceDigest: process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST?.trim()
    || identity.sourceDigest,
  bootSourceDigest: identity.sourceDigest,
  });
});
const MCP_RUNTIME_GATE = createRuntimeGateController();
const MCP_RUNTIME_PERFORMANCE = createRuntimeMcpPerformanceProbe();
let mcpRuntimeGateWatchers: FSWatcher[] = [];

async function getMcpRuntimeArtifactCurrentness() {
  const recordedSourceDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST?.trim();
  const expectedSha256 = process.env.AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256?.trim();
  const loadedSha256 = await MCP_RUNTIME_ARTIFACT_SHA256;
  if (!recordedSourceDigest) {
    return {
      allowed: true,
      mode: "unrecorded-development" as const,
      loadedSha256,
      restartRequired: false,
    };
  }
  if (!expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    return {
      allowed: false,
      mode: "recorded-runtime" as const,
      loadedSha256,
      expectedSha256,
      restartRequired: true,
      reason: "已记录源码身份的 MCP 缺少有效 runtime artifact SHA-256。",
    };
  }
  if (expectedSha256 !== loadedSha256) {
    return {
      allowed: false,
      mode: "recorded-runtime" as const,
      loadedSha256,
      expectedSha256,
      restartRequired: true,
      reason: "MCP 实际载入文件与启动合同记录的 runtime artifact SHA-256 不一致。",
    };
  }
  return {
    allowed: true,
    mode: "recorded-runtime" as const,
    loadedSha256,
    expectedSha256,
    restartRequired: false,
  };
}

function buildCurrentnessProjection(
  status: RuntimeWriteGateStatus,
  buildId?: string,
): {
  allowed: boolean;
  buildId?: string;
  sourceDigest?: string;
  reason?: string;
} {
  return {
    allowed: status.allowed,
    ...(buildId ? { buildId } : {}),
    sourceDigest: status.currentSourceDigest ?? status.bootSourceDigest,
    ...(status.allowed
      ? {}
      : {
        reason: `源码运行身份失效：${status.reasons.join(", ") || status.error || "unknown"}`,
      }),
  };
}

async function assertMcpToolRuntimeCurrent(name: string): Promise<void> {
  const artifactCurrentness = await getMcpRuntimeArtifactCurrentness();
  if (!artifactCurrentness.allowed) {
    throw new Error(`BUILD_ARTIFACT_MISMATCH：${artifactCurrentness.reason} 请重启源码 MCP 并重新建立连接；仅 get_capabilities 可用于诊断。`);
  }
  const boot = await MCP_RUNTIME_BOOT_IDENTITY;
  const mode = runtimeMcpGateMode(name);
  const currentness = mode === "cached-read"
    ? await MCP_RUNTIME_GATE.checkRead(boot)
    : await MCP_RUNTIME_GATE.checkMutation(boot);
  if (!currentness.allowed) {
    const reason = currentness.reasons.join(", ") || currentness.error || "旧构建与当前源码不一致。";
    throw new Error(`BUILD_CURRENTNESS_MISMATCH：${reason} 请先更新构建；仅 get_capabilities 可用于诊断。`);
  }
}

async function startMcpRuntimeGateWatchers(): Promise<void> {
  if (mcpRuntimeGateWatchers.length > 0) return;
  const boot = await MCP_RUNTIME_BOOT_IDENTITY;
  // W4-E：默认只递归订 src/；tests/scripts 见 AI_CANVAS_RUNTIME_GATE_WATCH_TESTS_SCRIPTS
  const watchPaths = sourceDigestWatchPaths(boot.workspace);
  const workspaceRoot = watchPaths[0];
  if (!workspaceRoot) throw new Error("MCP 运行时源码 watcher 缺少 workspace 根。");
  const recursiveRoots = watchPaths.slice(1);
  let watcherFailed = false;
  const invalidateIfRelevant = (changedPath: string): void => {
    if (path.resolve(changedPath) === path.resolve(boot.loadedArtifactPath)
      || sourceDigestPathIsRelevant(boot.workspace, changedPath)) {
      MCP_RUNTIME_GATE.invalidate();
    }
  };
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
      MCP_RUNTIME_GATE.setWatcherHealthy(false);
      console.error(`[runtime-gate] MCP 源码 watcher 失效，已退化为每批完整核验：${error instanceof Error ? error.message : String(error)}`);
      settle();
    });
    watcher.on("add", invalidateIfRelevant);
    watcher.on("change", invalidateIfRelevant);
    watcher.on("unlink", invalidateIfRelevant);
  });
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
  mcpRuntimeGateWatchers = [shallowRootWatcher, recursiveSourceWatcher];
  await Promise.all(mcpRuntimeGateWatchers.map(observe));
  if (!watcherFailed) MCP_RUNTIME_GATE.setWatcherHealthy(true);
}

async function closeMcpRuntimeGateWatchers(): Promise<void> {
  const closing = mcpRuntimeGateWatchers;
  mcpRuntimeGateWatchers = [];
  MCP_RUNTIME_GATE.setWatcherHealthy(false);
  await Promise.all(closing.map((watcher) => watcher.close()));
}

const projectRootSchema = z.string().default(DEFAULT_PROJECT_ROOT).describe("AI 漫剧项目主根绝对路径");
const canonicalAssetProjectRootSchema = z.string().trim().min(1).refine((value) => path.isAbsolute(value), "projectRoot 必须是绝对路径");
const managedStudioProjectRootSchema = z.string().trim().min(1).refine((value) => path.isAbsolute(value), "projectRoot 必须是绝对路径")
  .describe("已通过 managed-project.json 完整性验证的受管项目根绝对路径");
const studioStableIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const studioAssetIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const studioCursorSchema = z.string().min(1).max(4_096);
const studioPageLimitSchema = z.number().int().min(1).max(100).default(50);
const studioGenerationControlQuerySchema = z.union([
  z.object({
    operation: z.literal("session-snapshot"),
    unitId: studioStableIdSchema,
    panelId: studioStableIdSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal("readiness"),
    targetKind: z.literal("panel").optional(),
    unitId: studioStableIdSchema,
    panelId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("readiness"),
    targetKind: z.literal("unit-grid"),
    unitId: studioStableIdSchema,
    continuationWaiver: z.object({
      receiptId: studioStableIdSchema,
      receiptFingerprint: z.string().trim().regex(/^[a-f0-9]{64}$/u),
    }).strict().optional(),
  }).strict(),
  z.object({
    operation: z.literal("pack"),
    packId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("history"),
    targetKind: z.literal("panel").optional(),
    unitId: studioStableIdSchema,
    panelId: studioStableIdSchema,
    cursor: studioCursorSchema.optional(),
    limit: studioPageLimitSchema,
    order: z.enum(["oldest-first", "newest-first"]).optional(),
  }).strict(),
  z.object({
    operation: z.literal("history"),
    targetKind: z.literal("unit-grid"),
    unitId: studioStableIdSchema,
    cursor: studioCursorSchema.optional(),
    limit: studioPageLimitSchema,
    order: z.enum(["oldest-first", "newest-first"]).optional(),
  }).strict(),
  z.object({ operation: z.literal("plan"), planId: studioStableIdSchema }).strict(),
  z.object({
    operation: z.literal("plan"),
    targetKind: z.literal("panel").optional(),
    unitId: studioStableIdSchema,
    panelId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("plan"),
    targetKind: z.literal("unit-grid"),
    unitId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("call"),
    generationRunId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("active-runs"),
    targetKind: z.literal("panel").optional(),
    unitId: studioStableIdSchema,
    panelId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("active-runs"),
    targetKind: z.literal("unit-grid"),
    unitId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("detached-unknown"),
    unitId: studioStableIdSchema,
  }).strict(),
]);
const studioBindingControlQuerySchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("list_units"),
    seasonId: z.string().trim().min(1).max(500).optional(),
    episodeId: z.string().trim().min(1).max(500).optional(),
    cursor: studioCursorSchema.optional(),
    limit: z.number().int().min(1).max(36).default(36),
  }).strict(),
  z.object({
    operation: z.literal("get_control"),
    unitId: studioStableIdSchema,
  }).strict(),
  z.object({
    operation: z.literal("list_sections"),
    scriptRevisionId: studioStableIdSchema,
    cursor: studioCursorSchema.optional(),
    limit: studioPageLimitSchema,
  }).strict(),
  z.object({
    operation: z.literal("get_section"),
    revisionId: studioStableIdSchema,
  }).strict(),
]);
const canonicalAssetAuthorityFilterSchema = z.enum(["any", "with-authority", "without-authority"]);
const fusionExpectedCountsSchema = z.object({
  episodes: z.number().int().positive().optional(),
  units: z.number().int().positive().optional(),
  sourceShots: z.number().int().positive().optional(),
  scheduleRows: z.number().int().positive().optional(),
  assets: z.number().int().positive().optional(),
  characters: z.number().int().min(0).optional(),
  scenes: z.number().int().min(0).optional(),
  props: z.number().int().min(0).optional(),
  standardDurationSeconds: z.number().positive().max(300).optional(),
}).strict();
const fusionInspectionInputShape = {
  packageRoot: z.string().min(1).describe("15s_fused_units.json 所在的只读融合包目录"),
  sourceRoot: z.string().min(1).optional().describe("第三季只读源根；默认取 packageRoot 上级"),
  indexPath: z.string().min(1).optional().describe("可选融合 JSON 索引路径"),
  assetLibraryPath: z.string().min(1).optional().describe("可选全季资产库 Markdown 路径"),
  expectedCounts: fusionExpectedCountsSchema.optional(),
};
const fusionAuthorityInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  assetId: z.string().regex(/^[CSP]\d{2}[a-z]?$/u).optional(),
  name: z.string().trim().min(1).max(200),
  sourcePath: z.string().min(1),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  rules: z.array(z.string().trim().min(1).max(2_000)).max(100),
  exposeToGeneration: z.boolean().describe("是否允许将隔离快照加入资产生图参考白名单"),
}).strict();
const normalizedSheetPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict();
const normalizedSheetRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict();
const fusionStoryboardSheetPlacementSchema = z.union([
  z.object({ fit: z.literal("contain").optional() }).strict(),
  z.object({ fit: z.literal("crop"), reason: z.string().trim().min(3).max(2_000), focalPoint: normalizedSheetPointSchema }).strict(),
  z.object({ fit: z.literal("crop"), reason: z.string().trim().min(3).max(2_000), rect: normalizedSheetRectSchema }).strict(),
]);
const fusionStoryboardSheetPlacementsSchema = z.record(z.string().min(1).max(500), fusionStoryboardSheetPlacementSchema);
const fusionVisualConstraintOverrideSchema = z.discriminatedUnion("overrideType", [
  z.object({
    overrideType: z.literal("presence"),
    contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
    panelId: z.string().min(1).max(500),
    assetId: z.string().regex(/^[CSP]\d{2}[a-z]?$/u),
    expectedStoreRevision: z.number().int().positive(),
    expectedConstraintId: z.string().regex(/^panel-visual-[a-f0-9]{28}$/u),
    expectedResolutionId: z.string().regex(/^panel-reference-[a-f0-9]{28}$/u),
    expectedBindingId: z.string().min(1).max(500),
    presence: z.enum(["on-screen", "continuity-only", "optional-offscreen"]),
    reason: z.string().trim().min(3).max(2_000),
  }).strict(),
  z.object({
    overrideType: z.literal("golden-mask-reveal"),
    action: z.enum(["set", "remove"]),
    contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
    panelId: z.string().min(1).max(500),
    expectedStoreRevision: z.number().int().positive(),
    expectedConstraintId: z.string().regex(/^panel-visual-[a-f0-9]{28}$/u),
    authorizationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/u).optional(),
    approvedBy: z.literal("user"),
    reason: z.string().trim().min(3).max(2_000),
    modelRevealDescription: z.string().trim().max(4_000).optional(),
  }).strict(),
]);
const browserPreflightEvidenceSchema = z.object({
  executionSurface: z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/), version: z.string().trim().min(1).max(120) }).optional(),
  observedHost: z.string().min(1).max(253),
  loginVerified: z.boolean(),
  pageReady: z.boolean(),
  generationModeVerified: z.boolean(),
  balanceChecked: z.boolean(),
  paidActionRequired: z.boolean(),
  paidActionAuthorized: z.boolean(),
  authorizationReference: z.string().max(1_000).optional(),
  blockers: z.array(z.enum(BROWSER_PREFLIGHT_BLOCKER_CODES)).max(BROWSER_PREFLIGHT_BLOCKER_CODES.length).optional(),
  observedGeneration: z.object({
    model: z.string().trim().min(1).max(500).optional(),
    aspectRatio: z.string().trim().min(1).max(100).optional(),
    resolution: z.string().trim().min(1).max(100).optional(),
    imageCount: z.number().int().min(1).max(100).optional(),
    generateEnabled: z.boolean().optional(),
    creditMessage: z.string().trim().min(1).max(2_000).optional(),
  }).optional(),
});
const generationReferenceRoleSchema = z.enum(["character", "costume", "prop", "scene", "style", "first_frame", "last_frame", "source_video", "mask"]);
const browserUploadEvidenceSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1),
    role: generationReferenceRoleSchema,
    order: z.number().int().min(0),
    slot: z.string().trim().min(1).max(200),
  })).max(110),
  observedReferenceThumbnailCount: z.number().int().min(0).max(100).optional()
    .describe("网页上传区当前可见参考缩略图数量；text-only/allowedUploads=[] 时必填且必须为 0"),
});
const browserSubmissionReconciliationSchema = z.object({
  method: z.enum(["provider_task_list", "client_job_id_search", "browser_history"]),
  result: z.enum(["found", "not_found"]),
  note: z.string().trim().min(1).max(4_000),
  externalTaskId: z.string().trim().min(1).max(500).optional(),
});
const httpSubmissionReconciliationMethodSchema = z.enum(["provider_task_list", "client_job_id_search", "provider_idempotency_lookup", "provider_request_log", "provider_support"]);
const httpSubmissionReconciliationNoteSchema = z.string().trim().min(3).max(1_000).refine((value) => !/https?:\/\/|\bBearer\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|signature|sig)\s*[:=]/i.test(value), "HTTP 提交对账 note 不能包含 URL 或凭据");
const httpSubmissionReconciliationSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("found"),
    method: httpSubmissionReconciliationMethodSchema,
    externalTaskId: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/),
    evidenceReference: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/),
    note: httpSubmissionReconciliationNoteSchema,
  }).strict(),
  z.object({
    result: z.literal("not_found"),
    method: httpSubmissionReconciliationMethodSchema,
    confirmNoRemoteResult: z.literal(true),
    evidenceReference: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/),
    note: httpSubmissionReconciliationNoteSchema,
  }).strict(),
]);
const reviewAnnotationSchema = z.object({
  artifactId: z.string().min(1).describe("批注绑定的不可变素材 ID，必须同时出现在本次 artifactIds 中"),
  type: z.enum(REVIEW_ANNOTATION_TYPES),
  timeSeconds: z.number().finite().min(0).optional().describe("视频时间码秒数；若素材有时长，不得超过素材时长"),
  x: z.number().finite().min(0).max(1).describe("相对画面左侧的标准化坐标"),
  y: z.number().finite().min(0).max(1).describe("相对画面顶部的标准化坐标"),
  text: z.string().trim().min(1).max(2_000),
});
const publicationContextSchema = z.object({
  purpose: z.enum(PUBLICATION_PURPOSES),
  itemId: z.string().max(200).optional(),
  taskId: z.string().max(200).optional(),
  jobId: z.string().max(200).optional(),
  metadata: z.record(z.string().max(120), z.union([z.string().max(4_000), z.number().finite(), z.boolean()])).optional(),
});
const sourceSpanSchema = z.object({ sourceId: z.string().min(1), chapterId: z.string().min(1), chapterRevision: z.number().int().positive(), chapterSha256: z.string().regex(/^[a-f0-9]{64}$/i), startOffset: z.number().int().min(0), endOffset: z.number().int().positive(), text: z.string().min(1).max(20_000) }).refine((value) => value.endOffset > value.startOffset, "endOffset 必须大于 startOffset");
const entityRevisionRefSchema = z.object({ id: z.string().min(1), revision: z.number().int().positive() });
const storyboardRowPatchSchema = {
  itemId: z.string().min(1).optional(), shotItemId: z.string().min(1).optional(), order: z.number().int().min(1).max(999).optional(), durationSeconds: z.number().positive().max(15).optional(),
  shotSize: z.string().max(100).optional(), cameraMovement: z.string().max(500).optional(), cameraAngle: z.string().max(500).optional(), lens: z.string().max(500).optional(), composition: z.string().max(2_000).optional(), staging: z.string().max(4_000).optional(),
  action: z.string().max(8_000).optional(), expression: z.string().max(2_000).optional(), emotion: z.string().max(2_000).optional(), eyeline: z.string().max(2_000).optional(), screenDirection: z.string().max(500).optional(), axisSide: z.string().max(500).optional(),
  dialogue: z.string().max(8_000).optional(), narration: z.string().max(8_000).optional(), ambience: z.string().max(4_000).optional(), soundEffects: z.array(z.string().max(1_000)).max(100).optional(),
  continuityBefore: z.string().max(4_000).optional(), continuityAfter: z.string().max(4_000).optional(), referenceNames: z.array(z.string().max(500)).max(100).optional(),
  firstFramePrompt: z.string().max(30_000).optional(), endFramePrompt: z.string().max(30_000).optional(), videoPrompt: z.string().max(30_000).optional(),
  referencePaths: z.array(z.string()).max(100).optional(), referenceArtifactIds: z.array(z.string().min(1)).max(100).optional(),
  upstreamFactRefs: z.array(entityRevisionRefSchema).max(200).optional(), upstreamBeatRefs: z.array(entityRevisionRefSchema).max(200).optional(), sourceSpans: z.array(sourceSpanSchema).max(200).optional(),
  adaptationPlanId: z.string().max(500).optional(), adaptationUnitId: z.string().max(500).optional(), directorIntent: z.string().max(2_000).optional(), emotionalIntent: z.string().max(2_000).optional(), continuityNotes: z.array(z.string().max(2_000)).max(100).optional(),
  status: z.enum(["draft", "confirmed", "deprecated"]).optional(),
};
function revisionedUpsertSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, id: z.string().trim().min(1).optional(), expectedRevision: z.number().int().positive().optional() }).superRefine((value, context) => {
    const revision = value as { id?: string; expectedRevision?: number };
    if (revision.id === undefined && revision.expectedRevision !== undefined) context.addIssue({ code: "custom", path: ["expectedRevision"], message: "创建时不能携带 expectedRevision" });
    if (revision.id !== undefined && revision.expectedRevision === undefined) context.addIssue({ code: "custom", path: ["expectedRevision"], message: "更新时必须携带 expectedRevision" });
  });
}
const creativeBibleInputShape = { kind: z.enum(["director", "visual", "character", "world"]), name: z.string().min(1).max(160), summary: z.string().max(30_000), rules: z.array(z.string().max(2_000)).max(300).optional(), forbidden: z.array(z.string().max(2_000)).max(300).optional(), referencePaths: z.array(z.string()).max(300).optional(), tags: z.array(z.string()).max(100).optional() };
const assetRelationInputShape = { kind: z.enum(["derived_from", "variant_of", "reference_of"]), parentArtifactId: z.string().min(1).optional(), parentItemId: z.string().min(1).optional(), childArtifactId: z.string().min(1).optional(), childItemId: z.string().min(1).optional(), operation: z.string().max(2_000).optional(), note: z.string().max(8_000).optional() };
const voiceIdentityInputShape = { name: z.string().min(1).max(160), provider: z.string().max(120).optional(), providerVoiceId: z.string().max(500).optional(), language: z.string().max(80).optional(), description: z.string().max(20_000).optional(), samplePaths: z.array(z.string()).max(100).optional(), characterAssetIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(100).optional(), characterItemIds: z.array(z.string()).max(500).optional(), sampleMediaSha256s: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).max(32).optional(), hardLockId: z.string().min(1).optional(), tags: z.array(z.string()).max(100).optional() };
const projectContextInputShape = { kind: z.enum(PROJECT_CONTEXT_KINDS), title: z.string().min(1).max(160), content: z.string().max(100_000), tags: z.array(z.string()).max(40).optional(), itemIds: z.array(z.string()).max(100).optional(), sourcePaths: z.array(z.string()).max(100).optional() };
const novelFactKindSchema = z.enum(["event", "character", "location", "prop", "rule", "dialogue", "relationship", "time", "weather", "costume", "narration", "psychology", "environment"]);
const novelFactInputSchema = { id: z.string().min(1).optional(), kind: novelFactKindSchema, epistemicStatus: z.enum(["confirmed", "inferred", "uncertain"]), statement: z.string().min(1).max(20_000), subject: z.string().max(1_000).optional(), predicate: z.string().max(1_000).optional(), object: z.string().max(4_000).optional(), sourceSpans: z.array(sourceSpanSchema).min(1).max(100), tags: z.array(z.string().max(200)).max(100), expectedRevision: z.number().int().positive().optional() };
const narrativeBeatInputSchema = { id: z.string().min(1).optional(), order: z.number().int().positive(), title: z.string().min(1).max(180), summary: z.string().min(1).max(20_000), narrativePurpose: z.string().min(1).max(2_000), visualAction: z.string().min(1).max(8_000), emotionalShift: z.string().min(1).max(2_000), conflict: z.string().max(4_000).optional(), turn: z.string().max(4_000).optional(), outcome: z.string().max(4_000).optional(), narration: z.string().max(8_000).optional(), psychology: z.string().max(8_000).optional(), ambience: z.string().max(4_000).optional(), mustKeep: z.array(z.string().max(2_000)).max(100), estimatedDurationSeconds: z.number().min(0.5).max(120), factIds: z.array(z.string().min(1)).max(200), sourceSpans: z.array(sourceSpanSchema).min(1).max(100), dialogue: z.string().max(8_000).optional(), intensity: z.number().int().min(1).max(5), expectedRevision: z.number().int().positive().optional() };
const novelFactProposalSchema = z.object(novelFactInputSchema).omit({ expectedRevision: true });
const narrativeBeatProposalSchema = z.object(narrativeBeatInputSchema).omit({ expectedRevision: true });
const novelAnalysisProviderSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/),
  name: z.string().min(1).max(200),
  adapter: z.enum(["openai-compatible", "mock"]),
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2_000).optional(),
  model: z.string().min(1).max(500),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i).optional(),
  allowPrivateNetwork: z.boolean().default(false),
  allowStoryUpload: z.boolean().default(false),
  useJsonResponseFormat: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(5).max(300).default(120),
  maxInputCharacters: z.number().int().min(1_000).max(2_000_000).default(200_000),
  temperature: z.number().min(0).max(2).default(0),
  revision: z.number().int().positive().optional(),
});
const generationCapabilitiesSchema = z.object({
  referenceModes: z.array(z.enum(["text", "first_frame", "last_frame", "first_last_frame", "multi_image", "video_reference"])).min(1).max(20),
  maxReferenceImages: z.number().int().min(0).max(100),
  maxReferenceVideos: z.number().int().min(0).max(10),
  supportedDurations: z.array(z.number().positive().max(300)).max(100),
  supportedAspectRatios: z.array(z.string().min(1).max(100)).max(50),
  supportedResolutions: z.array(z.string().min(1).max(100)).max(50),
  models: z.array(z.string().min(1).max(500)).max(100),
  maxConcurrency: z.number().int().min(1).max(20),
  supportsCancel: z.boolean(),
});
const generationWorkflowEnvironmentSchema = z.object({
  engine: z.string().max(500).optional(),
  engineVersion: z.string().max(500).optional(),
  platform: z.string().max(500).optional(),
  device: z.string().max(500).optional(),
  models: z.array(z.object({ name: z.string().min(1).max(500), version: z.string().max(500).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), nodeId: z.string().max(500).optional() })).max(500).optional(),
  customNodes: z.array(z.object({ name: z.string().min(1).max(500), version: z.string().max(500).optional(), commit: z.string().max(160).optional() })).max(500).optional(),
  notes: z.array(z.string().max(2_000)).max(200).optional(),
});
const generationWorkflowSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(120),
  format: z.enum(["generic-json", "comfyui-api", "browser-recipe"]),
  definition: z.record(z.string(), z.any()),
  environment: generationWorkflowEnvironmentSchema.optional(),
  comfyUi: z.object({
    promptInputs: z.array(z.object({ nodeId: z.string().min(1).max(200), inputName: z.string().min(1).max(200) })).min(1).max(20),
    outputNodeId: z.string().min(1).max(200),
    outputIndex: z.number().int().min(0).max(99),
  }).optional(),
});
const generationProviderUpsertSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/),
  name: z.string().min(1).max(200),
  adapter: z.enum(["folder-bridge", "http-json", "comfyui-local", "codex-browser", "codex-subagent-imagegen", "mock"]),
  kinds: z.array(z.enum(["image", "video"])).min(1).max(2),
  enabled: z.boolean(),
  model: z.string().max(500).optional(),
  endpoint: z.string().max(2_000).optional(),
  pollEndpoint: z.string().max(2_000).optional(),
  cancelEndpoint: z.string().max(2_000).optional(),
  cancelMethod: z.enum(["POST", "DELETE"]).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i).optional(),
  taskIdPath: z.string().max(500).optional(),
  statusPath: z.string().max(500).optional(),
  resultUrlPath: z.string().max(500).optional(),
  successValues: z.array(z.string().max(500)).max(100).optional(),
  failureValues: z.array(z.string().max(500)).max(100).optional(),
  siteUrl: z.string().url().max(2_000).optional(),
  browserInstructions: z.string().max(20_000).optional(),
  subagentInstructions: z.string().max(20_000).optional(),
  executionSurface: z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/), version: z.string().trim().min(1).max(120) }).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  allowedResultHosts: z.array(z.string().max(253)).max(50).optional(),
  sendLocalPaths: z.boolean().optional(),
  capabilities: generationCapabilitiesSchema.optional(),
  workflow: generationWorkflowSchema.optional(),
  outputRoot: z.string().min(1).optional(),
});

function textResult(value: unknown) {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function structuredResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function isManagedStudioCommand(command: CommandRequest["command"]): boolean {
  // 分类真相只来自 command-bus；这里的 payload 占位不会被分类器读取。
  return isStudioCommandRequest({ command, payload: {} } as CommandRequest);
}

const MANAGED_STUDIO_PRIVATE_PATH_FIELDS = new Set([
  "bodyPath",
  "databasePath",
  "objectPath",
  "objectRoot",
  "textCasRoot",
  "thumbnailRoot",
  "packCasRoot",
  "packCasPath",
  "contentRelpath",
  "localPath",
]);

function isManagedStudioPathField(key: string): boolean {
  return ["path", "source", "root", "directory", "file"].includes(key.toLowerCase())
    || /(?:path|paths|root|roots|directory|directories|realpath)$/iu.test(key);
}

function sanitizeManagedStudioValue(value: unknown, contextKey = "root"): unknown {
  if (typeof value === "string") {
    return isManagedStudioPathField(contextKey) && path.isAbsolute(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeManagedStudioValue(entry, contextKey))
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !MANAGED_STUDIO_PRIVATE_PATH_FIELDS.has(key))
    .map(([key, entry]) => [key, sanitizeManagedStudioValue(entry, key)] as const)
    .filter(([, entry]) => entry !== undefined));
}

function assertManagedStudioProjectionSafe(value: unknown): void {
  const visit = (candidate: unknown, key = "root"): void => {
    if (candidate === null || candidate === undefined) return;
    if (Buffer.isBuffer(candidate) || ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      throw new Error(`受管素材 MCP 响应禁止返回媒体二进制：${key}`);
    }
    if (typeof candidate === "string") {
      if (/^data:[^;,]+;base64,/iu.test(candidate)) throw new Error(`受管素材 MCP 响应禁止返回 base64：${key}`);
      const field = key.split(".").at(-1)?.replace(/\[\d+\]$/u, "") ?? key;
      if (path.isAbsolute(candidate) && isManagedStudioPathField(field)) {
        throw new Error(`受管素材 MCP 响应禁止在路径字段返回绝对路径：${key}`);
      }
      if (path.isAbsolute(candidate) && /(?:^|[\\/])\.aicanvas[\\/](?:objects[\\/]sha256|studio-production[\\/]objects[\\/]sha256|studio-generation[\\/]objects[\\/]sha256)(?:[\\/]|$)/u.test(candidate)) {
        throw new Error(`受管素材 MCP 响应禁止返回绝对 CAS 路径：${key}`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${key}[${index}]`));
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [childKey, childValue] of Object.entries(candidate)) {
      if (MANAGED_STUDIO_PRIVATE_PATH_FIELDS.has(childKey)) throw new Error(`受管素材 MCP 响应禁止返回 ${childKey}。`);
      visit(childValue, `${key}.${childKey}`);
    }
  };
  visit(value);
}

function managedStudioResult(value: unknown) {
  const sanitized = sanitizeManagedStudioValue(value);
  assertManagedStudioProjectionSafe(sanitized);
  return textResult(sanitized);
}

function activeManagedStudioContextResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("活动受管工程上下文结构无效。");
  }
  const raw = value as Record<string, unknown>;
  const projectRoot = raw.projectRoot;
  if (raw.kind !== "active-managed-studio-context"
    || typeof projectRoot !== "string"
    || !path.isAbsolute(projectRoot)
    || path.normalize(projectRoot) !== projectRoot) {
    throw new Error("活动受管工程上下文缺少 canonical projectRoot。");
  }
  // 通用受管投影继续剔除所有绝对路径；只有已由 Core 完整验证且绑定
  // projectContextToken 的顶层 projectRoot 通过这个专用投影重新加入。
  const sanitized = sanitizeManagedStudioValue({ ...raw, projectRoot: undefined });
  assertManagedStudioProjectionSafe(sanitized);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    throw new Error("活动受管工程上下文清洗后结构无效。");
  }
  return textResult({ ...(sanitized as Record<string, unknown>), projectRoot });
}

function studioGenerationControlResult(projectRoot: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex generation control envelope 结构无效。");
  }
  const envelope = value as Record<string, unknown>;
  const operation = envelope.operation;
  const mediaCasRoot = path.join(path.resolve(projectRoot), ".aicanvas", "objects", "sha256");
  const visit = (candidate: unknown, key = "root"): void => {
    if (candidate === null || candidate === undefined) return;
    if (Buffer.isBuffer(candidate) || ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      throw new Error(`Codex generation control envelope 禁止返回二进制：${key}`);
    }
    if (typeof candidate === "string") {
      if (/^data:[^;,]+;base64,/iu.test(candidate)) {
        throw new Error(`Codex generation control envelope 禁止返回 base64：${key}`);
      }
      if (/(?:^|[\\/])\.aicanvas[\\/]studio-generation[\\/]objects(?:[\\/]|$)/u.test(candidate)) {
        throw new Error(`Codex generation control envelope 禁止返回冻结包 CAS 路径：${key}`);
      }
      if (path.isAbsolute(candidate)
        && /(?:^|[\\/])\.aicanvas[\\/](?:objects[\\/]sha256|studio-production[\\/]objects[\\/]sha256)(?:[\\/]|$)/u.test(candidate)
        && !key.endsWith(".localPath")) {
        throw new Error(`Codex generation control envelope 禁止在控制引用外返回 CAS 绝对路径：${key}`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${key}[${index}]`));
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [childKey, childValue] of Object.entries(candidate)) {
      if (MANAGED_STUDIO_PRIVATE_PATH_FIELDS.has(childKey) && childKey !== "localPath") {
        throw new Error(`Codex generation control envelope 禁止返回 ${childKey}。`);
      }
      const childPath = `${key}.${childKey}`;
      if (childKey === "localPath") {
        const relative = typeof childValue === "string" ? path.relative(mediaCasRoot, childValue) : "";
        const allowedLocation = operation === "pack"
          && /^(?:root\.request|root\.pack\.request)\.controlReferences\[\d+\]\.localPath$/u.test(childPath)
          && typeof childValue === "string"
          && path.isAbsolute(childValue)
          && relative !== ""
          && relative !== ".."
          && !relative.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relative);
        if (!allowedLocation) {
          throw new Error(`Codex generation control envelope 禁止在未验证位置返回 localPath：${childPath}`);
        }
      }
      visit(childValue, childPath);
    }
  };
  visit(value);
  return textResult(value);
}

function canonicalAssetReadResult(value: object) {
  const visit = (candidate: unknown, key = "root"): void => {
    if (candidate === null || candidate === undefined) return;
    if (Buffer.isBuffer(candidate) || ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      throw new Error(`规范资产只读响应禁止返回媒体二进制：${key}`);
    }
    if (typeof candidate === "string") {
      if (/^data:[^;,]+;base64,/iu.test(candidate)) throw new Error(`规范资产只读响应禁止返回 base64：${key}`);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${key}[${index}]`));
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [childKey, childValue] of Object.entries(candidate)) {
      if (/^(?:base64|binary|dataUrl|imageData|mediaData)$/iu.test(childKey) && childValue !== null && childValue !== undefined) {
        throw new Error(`规范资产只读响应禁止返回内嵌媒体字段：${childKey}`);
      }
      visit(childValue, `${key}.${childKey}`);
    }
  };
  visit(value);
  return structuredResult(value);
}

/**
 * MCP 是模型侧生产读取面，默认只暴露当前且明确允许用于生成的权威。
 * 完整历史（含人工复核专用、禁止上传的媒体）仍可由 Electron 人工界面读取，
 * 但不能经本工具静默进入提示词或供应商上传白名单。
 */
function modelSafeCanonicalAssetDetail(detail: CanonicalAssetDetail) {
  const currentAuthorityIds = new Set([
    detail.asset.primaryAuthorityId,
    ...(detail.asset.currentSupportingAuthorityIds ?? []),
  ].filter((value): value is string => Boolean(value)));
  const allowedAuthorities = detail.authorities.filter((authority) => currentAuthorityIds.has(authority.id)
    && authority.exposure === "allowed"
    && authority.scope.usage === "generation-reference");
  const allowedAuthorityIds = new Set(allowedAuthorities.map((authority) => authority.id));
  const allowedVersionIds = new Set(allowedAuthorities.map((authority) => authority.assetVersionId));
  const currentVersionIds = new Set(detail.authorities
    .filter((authority) => currentAuthorityIds.has(authority.id))
    .map((authority) => authority.assetVersionId));
  const currentForbiddenVersionIds = new Set(detail.authorities
    .filter((authority) => currentAuthorityIds.has(authority.id) && !allowedAuthorityIds.has(authority.id))
    .map((authority) => authority.assetVersionId));
  const allowedLockIds = new Set(allowedAuthorities.flatMap((authority) => [
    ...authority.positiveLocks.map((rule) => rule.id),
    ...authority.negativeLocks.map((rule) => rule.id),
  ]));
  const currentDefinitionVersions = detail.definitionVersions
    .filter((version) => version.id === detail.asset.currentDefinitionVersionId);
  const currentContractVersions = detail.contractVersions
    .filter((version) => version.id === detail.asset.currentContractVersionId);
  const allowedVersions = detail.versions.filter((version) => allowedVersionIds.has(version.id));
  const relations = detail.relations.filter((relation) => [relation.from, relation.to]
    .every((endpoint) => endpoint.kind === "asset" || allowedVersionIds.has(endpoint.id)));
  const currentForbiddenAuthorityCount = detail.authorities.filter((authority) => currentAuthorityIds.has(authority.id)
    && !allowedAuthorityIds.has(authority.id)).length;

  return {
    ...detail,
    asset: {
      ...detail.asset,
      positiveLocks: detail.asset.positiveLocks.filter((rule) => allowedLockIds.has(rule.id)),
      negativeLocks: detail.asset.negativeLocks.filter((rule) => allowedLockIds.has(rule.id)),
      ...(detail.asset.primaryAuthorityId && allowedAuthorityIds.has(detail.asset.primaryAuthorityId)
        ? { primaryAuthorityId: detail.asset.primaryAuthorityId }
        : { primaryAuthorityId: undefined }),
      currentSupportingAuthorityIds: (detail.asset.currentSupportingAuthorityIds ?? [])
        .filter((authorityId) => allowedAuthorityIds.has(authorityId)),
    },
    definitionVersions: currentDefinitionVersions,
    contractVersions: currentContractVersions,
    versions: allowedVersions,
    authorities: allowedAuthorities,
    relations,
    generationPolicy: {
      authorityOverridesDefinition: true,
      currentAuthorityOnly: true,
      forbiddenAndHistoricalOmitted: true,
      mediaMayBeUsedOnlyWhenReturnedByThisProjection: true,
    },
    redactions: {
      currentForbiddenAuthorityCount,
      historicalAuthorityCount: detail.authorities.filter((authority) => !currentAuthorityIds.has(authority.id)).length,
      currentForbiddenVersionCount: detail.versions.filter((version) => currentForbiddenVersionIds.has(version.id)).length,
      historicalVersionCount: detail.versions.filter((version) => !currentVersionIds.has(version.id)).length,
      omittedVersionCount: detail.versions.filter((version) => !allowedVersionIds.has(version.id)).length,
      historicalDefinitionVersionCount: detail.definitionVersions.length - currentDefinitionVersions.length,
      historicalContractVersionCount: detail.contractVersions.length - currentContractVersions.length,
      omittedAssetLockCount: detail.asset.positiveLocks.length + detail.asset.negativeLocks.length - allowedLockIds.size,
      policy: "当前允许生成权威以外的媒体、来源、SHA、锁规则与历史关系均不返回；完整历史仅供本地人工复核界面查看。",
    },
  };
}

// P27（MCP 审查 F6）：错误消息中的绝对路径通用归一化——保留 basename 隐藏目录结构，不误伤 URL。
const ABSOLUTE_PATH_IN_MESSAGE = /(?<!:)(?:\/[\w.@%+=;,()一-鿿-]+){2,}/gu;
function normalizeAbsolutePathsInMessage(message: string): string {
  return message.replace(ABSOLUTE_PATH_IN_MESSAGE, (candidate) => {
    const base = candidate.split("/").filter(Boolean).at(-1) ?? "";
    return base ? `<path:${base}>` : "<path>";
  });
}

function toolError(error: unknown, context?: { requestId?: string; idempotencyKey?: string; command?: string }) {
  if (isRejectedCommandFailure(error) || isNovelWritingStateRejectedError(error)) {
    // 纯前置 CAS/输入拒绝：账本只落 failed、键不毒化成 unknown；MCP 面显式给出
    // 机器可读 reason 与可重试语义，不得把 CAS 冲突误标为不可重试的输入错误。
    const result = error.result && typeof error.result === "object" && !Array.isArray(error.result)
      ? error.result as Record<string, unknown>
      : undefined;
    const reason = result && typeof result.reason === "string" ? result.reason : "validation_failed";
    const message = normalizeAbsolutePathsInMessage(sanitizeDiagnosticText(error.message) ?? error.message);
    const conflict = ["revision_conflict", "control_conflict", "context_preflight_stale", "chapter_write_lease_conflict", "chapter_write_lease_stale"].includes(reason);
    const code = conflict ? "CONFLICT" : reason === "not_found" ? "NOT_FOUND" : "VALIDATION_ERROR";
    const nextAction = result && typeof result.nextAction === "string" ? result.nextAction : undefined;
    const projectedNextTools = result && Array.isArray(result.nextTools)
      ? result.nextTools
      : (["context_preflight_stale", "chapter_write_lease_required", "chapter_write_lease_conflict", "chapter_write_lease_stale"].includes(reason)
        ? [{
          tool: "prepare_novel_chapter_write",
          argsMode: "partial",
          args: typeof result?.chapterId === "string" ? { targetChapterId: result.chapterId } : {},
          requiredArgs: ["projectRoot", "attribution"],
          purpose: nextAction ?? "重新准备目标章并获取新租约",
        }]
        : []);
    const structuredContent = {
      error: {
        code,
        message,
        retryable: conflict,
        suggestedAction: conflict
          ? "重新读取当前修订或控制面指纹，修正后使用新的幂等键重试；原键不会重放。"
          : "修正输入后使用新的幂等键重试；原键不会重放。",
        applied: false,
        reason,
        ...(nextAction ? { nextAction } : {}),
        ...(projectedNextTools.length ? { nextTools: projectedNextTools } : {}),
        ...((result?.requiresHumanOwner === true || reason === "actor_forbidden") ? { requiresHumanOwner: true } : {}),
      },
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  }
  const observedMessage = error instanceof Error ? error.message : String(error);
  // 账本、绑定或连续性合同会携带精确但非机密的 diagnostics；此前 MCP
  // 只返回总错误，驾驶舱一旦降级，Agent 无法分辨 WAL 竞态、schema 或
  // 数据合同问题。保留有界、脱敏后的细节，绝不暴露 CAS/SQLite 绝对路径。
  const diagnostics = error
    && typeof error === "object"
    && Array.isArray((error as { details?: unknown }).details)
    ? (error as { details: unknown[] }).details
      .filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0)
      .slice(0, 8)
      .map((detail) => normalizeAbsolutePathsInMessage(sanitizeDiagnosticText(detail) ?? detail))
    : [];
  const rawMessage = /(?:^|[\\/])\.aicanvas[\\/](?:objects[\\/]sha256|studio-production[\\/]objects[\\/]sha256|studio-generation[\\/]objects[\\/]sha256|material-studio\.sqlite|studio-production\.sqlite|studio-generation-ledger\.sqlite)(?:[\\/\s:]|$)/u.test(observedMessage)
    ? "受管素材存储校验失败；本地 CAS 或数据库路径已隐藏。"
    : observedMessage;
  const message = normalizeAbsolutePathsInMessage(sanitizeDiagnosticText(rawMessage) ?? rawMessage);
  const cancelled = error instanceof Error && error.name === "AbortError";
  // 分类逻辑抽到 src/core/tool-error-classification.ts（纯函数，可单测）。
  // 关键顺序：outcomeUnknown > busy > conflict —— "响应丢失"必须强制先对账；
  // SQLITE_BUSY/SQLITE_LOCKED（"database is locked"）是资源瞬时锁，
  // 绝不落入 VALIDATION_ERROR。
  const classification = classifyToolError({ message, cancelled });
  const { code, retryable, suggestedAction } = classification;
  const structuredContent = {
    error: {
      code,
      message,
      retryable,
      suggestedAction,
      // busy：事务确认未提交（COMMIT 未成功才抛 busy），可安全用同键重试；
      // outcomeUnknown：副作用可能已提交，applied 未知，必须先读 receipt 对账。
      ...(classification.busy ? { applied: false as const } : {}),
      ...(classification.outcomeUnknown ? { applied: "unknown" as const, outcome: "unknown" as const } : {}),
      ...(((classification.busy || classification.outcomeUnknown) && context?.requestId) ? { requestId: context.requestId } : {}),
      ...(((classification.busy || classification.outcomeUnknown) && context?.idempotencyKey) ? { idempotencyKey: context.idempotencyKey } : {}),
      ...(((classification.busy || classification.outcomeUnknown) && context?.command) ? { command: context.command } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

type ToolRequestExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;
};

function createScanRequestBridge(extra: ToolRequestExtra | undefined, enabled = true): {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  flush: () => Promise<void>;
} {
  if (!enabled) return { flush: async () => undefined };
  const token = extra?._meta?.progressToken;
  let sequence = 0;
  let notifications = Promise.resolve();
  const phaseLabels: Record<ScanProgress["phase"], string> = {
    discover: "发现文件",
    "read-text": "读取文本",
    inspect: "机械验收",
    build: "构建索引",
  };
  return {
    signal: extra?.signal,
    onProgress: token === undefined || !extra?.sendNotification ? undefined : (progress) => {
      sequence += 1;
      const skipped = progress.reservedPublicationFilesSkipped ? `，跳过写入中 ${progress.reservedPublicationFilesSkipped}` : "";
      const message = `${phaseLabels[progress.phase]}：候选 ${progress.candidateFiles}${skipped}，已检查 ${progress.completedChecks}/${progress.totalChecks || "待统计"}（新检 ${progress.inspectedChecks}，复用 ${progress.reusedChecks}）`;
      notifications = notifications.then(() => extra.sendNotification!({
        method: "notifications/progress",
        params: { progressToken: token, progress: sequence, message },
      })).catch(() => undefined);
    },
    flush: () => notifications,
  };
}

async function ensureImportCommandStorageRoot(primaryRoot: string): Promise<string> {
  const base = process.env.AI_CANVAS_REGISTRY_PATH ? path.dirname(path.resolve(process.env.AI_CANVAS_REGISTRY_PATH)) : path.join(os.homedir(), ".aicanvas");
  const storageRoot = path.join(base, "import-transactions", createHash("sha256").update(path.resolve(primaryRoot)).digest("hex").slice(0, 24));
  return (await ensureConfinedDirectory(base, storageRoot)).canonicalDirectory;
}

const GUARDED_WRITE_COMMANDS: Partial<Record<string, CommandRequest["command"]>> = {
  scan_project: "scan_project",
  materialize_fusion_project: "materialize_fusion_project", build_fusion_reference_board: "build_fusion_reference_board", build_fusion_storyboard_grid: "build_fusion_storyboard_grid", materialize_fusion_panel_references: "materialize_fusion_panel_references", materialize_fusion_visual_constraints: "materialize_fusion_visual_constraints", upsert_fusion_visual_constraint_override: "upsert_fusion_visual_constraint_override", upsert_panel_reference_override: "upsert_panel_reference_override", register_derived_panel_reference_artifact: "register_derived_panel_reference_artifact", migrate_fusion_storyboard_evidence: "migrate_fusion_storyboard_evidence", migrate_fusion_storyboard_sheets: "migrate_fusion_storyboard_sheets", render_fusion_storyboard_sheet: "render_fusion_storyboard_sheet",
  prepare_fusion_asset_consistency_review: "prepare_fusion_asset_consistency_review", submit_fusion_asset_consistency_review: "submit_fusion_asset_consistency_review", seal_final_fusion_asset_consistency_batch: "seal_final_fusion_asset_consistency_batch",
  upsert_context: "upsert_context", delete_context: "delete_context", save_skill: "save_skill", import_story_file: "import_story_file",
  upsert_story_event: "upsert_story_event", connect_story_events: "connect_story_events", update_production_workflow_stage: "update_workflow_stage", commit_existing_production_recovery: "commit_existing_production_recovery",
  import_story_text: "import_story_text", analyze_novel_chapters: "analyze_novel_chapters", generate_adaptation_plans: "generate_adaptation_plans", select_adaptation_plan: "select_adaptation_plan", materialize_adaptation_plan: "materialize_adaptation_plan", regenerate_adaptation_scope: "regenerate_adaptation_scope", upsert_novel_fact: "upsert_novel_fact", upsert_narrative_beat: "upsert_narrative_beat", export_adaptation: "export_adaptation", create_novel_analysis_task: "create_novel_analysis_task", submit_novel_analysis_proposal: "submit_novel_analysis_proposal", review_novel_analysis_item: "review_novel_analysis_item",
  upsert_creative_bible: "upsert_creative_bible", upsert_storyboard_row: "upsert_storyboard_row", create_handoff: "create_handoff",
  upsert_canvas_entity: "upsert_canvas_entity", delete_canvas_entity: "delete_canvas_entity", upsert_canvas_link: "upsert_canvas_link", delete_canvas_link: "delete_canvas_link", undo_canvas: "undo_canvas", redo_canvas: "redo_canvas",
  submit_review: "submit_review", claim_task: "claim_task", heartbeat_task: "heartbeat_task", release_task: "release_task", cancel_task: "cancel_task", create_task_pack: "create_task_pack", save_unit_timeline: "save_unit_timeline", create_shot_task_pack: "create_shot_task_pack",
  register_artifact: "register_artifact", verify_item: "verify_item", update_status: "update_status", finish_batch: "finish_batch", save_script_document: "save_script_document", set_authoritative_artifact: "set_authoritative_artifact", promote_asset_to_hard_lock: "promote_asset_to_hard_lock",
  upsert_asset_relation: "upsert_asset_relation", upsert_voice_identity: "upsert_voice_identity", upsert_generation_provider: "upsert_generation_provider", enqueue_generation: "enqueue_generation", process_generation_queue: "process_generation_queue", cancel_generation_job: "cancel_generation", update_browser_generation_job: "update_browser_generation", update_subagent_image_generation_job: "update_subagent_image_generation", reconcile_http_generation_submission: "reconcile_http_generation_submission",
  preflight_publication: "preflight_publication", register_publication: "register_publication", cancel_publication: "cancel_publication", fail_publication: "fail_publication",
  create_edit_project: "create_edit_project", save_edit_project: "save_edit_project", apply_edit_operation: "apply_edit_operation", undo_edit_project: "undo_edit_project", redo_edit_project: "redo_edit_project", export_edit_otio: "export_edit_otio", import_edit_otio: "import_edit_otio",
  prepare_edit_media_preview: "prepare_edit_media_preview", prepare_edit_media_proxy: "prepare_edit_media_proxy", start_edit_render: "start_edit_render", cancel_edit_render: "cancel_edit_render", extract_timeline_frame: "extract_timeline_frame", extract_last_frame: "extract_last_frame", create_video_continuation: "create_video_continuation", update_video_continuation: "update_video_continuation",
};

// P27（MCP 审查 F1/F2/F3/F15）：命名写工具的公开参数形状 → command-bus union payload 形状的归一化，
// 并在派发前用 union 做闸口校验（错配=确定性 VALIDATION_ERROR，不再深入账本毒化为 unknown）。
const GUARDED_PAYLOAD_NORMALIZERS: Partial<Record<string, (payload: Record<string, unknown>) => Record<string, unknown>>> = {
  // 命名工具公开字段 path → command-bus 合同 filePath。
  save_script_document: (payload) => {
    const { path: legacyPath, ...rest } = payload;
    return legacyPath === undefined ? payload : { ...rest, filePath: legacyPath };
  },
  // 命名工具公开字段 shots → command-bus 合同 timings（补 order）。
  save_unit_timeline: (payload) => {
    const { shots, ...rest } = payload;
    if (!Array.isArray(shots)) return payload;
    return {
      ...rest,
      timings: shots.map((shot, order) => (shot && typeof shot === "object" ? { ...(shot as Record<string, unknown>), order } : shot)),
    };
  },
  // 命名工具公开扁平 x/y → command-bus 合同 position 嵌套（此前坐标被静默丢弃写 (0,0)）。
  upsert_canvas_entity: (payload) => {
    const { x, y, position, ...rest } = payload;
    if (position !== undefined) return { ...rest, position };
    if (x === undefined && y === undefined) return rest;
    return { ...rest, position: { x: Number(x ?? 0), y: Number(y ?? 0) } };
  },
};

// 所有可映射的直接写工具统一进入持久幂等命令账本，避免平铺工具绕过修订、跨进程锁和崩溃窗口保护。
// registrar 保持 runtime currentness/effect/metric 在外、guarded schema/ledger 在内；此处只提供既有本地合同与 owner。
const registrar = createMcpToolRegistrar({
  rawRegisterTool: server.registerTool.bind(server),
  runtimeMcpEffect,
  runtimeMcpGateMode,
  assertRuntimeCurrent: assertMcpToolRuntimeCurrent,
  recordRuntimePerformance: (entry) => MCP_RUNTIME_PERFORMANCE.record(entry),
  toolError,
  guardedWriteCommands: GUARDED_WRITE_COMMANDS,
  guardedPayloadNormalizers: GUARDED_PAYLOAD_NORMALIZERS,
  getCommandRequestSchema: () => commandRequestSchema,
  createGuardedWriteBridge: (command, extra) => createScanRequestBridge(extra as ToolRequestExtra | undefined, command === "scan_project"),
  executeGuardedWrite: async ({ command, projectRoot, requestId, idempotencyKey, writeLeaseHolderId, writeLeaseToken, payload, bridge }) => {
    const scanBridge = bridge as ReturnType<typeof createScanRequestBridge>;
    const record = await executeIdempotentCommand(String(projectRoot ?? DEFAULT_PROJECT_ROOT), {
      requestId: String(requestId),
      idempotencyKey: String(idempotencyKey),
      request: { command: command as CommandRequest["command"], payload } as CommandRequest,
    }, {
      signal: scanBridge.signal,
      onProgress: scanBridge.onProgress,
      ...(typeof writeLeaseHolderId === "string" ? { writeLeaseHolderId } : {}),
      ...(typeof writeLeaseToken === "string" ? { writeLeaseToken } : {}),
    });
    return structuredResult(sanitizeCommandRecord(record, typeof payload.jobId === "string" ? payload.jobId : undefined));
  },
});

function remoteResultHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).hostname; }
  catch { return undefined; }
}

function sanitizeDiagnosticText(value: string | undefined): string | undefined {
  return value?.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|credential|authorization|set[_-]?cookie|cookie|password|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 2_000);
}

function sanitizeProviderUrlForMcp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const sensitiveQueryKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|credential|authorization|cookie|password|secret|x-amz-(?:credential|signature|security-token))/i;
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return sanitizeDiagnosticText(value);
  }
}

function sanitizeGenerationProviderForMcp(provider: GenerationProvider): GenerationProvider {
  return {
    ...provider,
    endpoint: sanitizeProviderUrlForMcp(provider.endpoint),
    pollEndpoint: sanitizeProviderUrlForMcp(provider.pollEndpoint),
    cancelEndpoint: sanitizeProviderUrlForMcp(provider.cancelEndpoint),
    siteUrl: sanitizeProviderUrlForMcp(provider.siteUrl),
  };
}

function sanitizeGenerationSettingsForMcp(settings: GenerationSettings): GenerationSettings {
  return { ...settings, providers: settings.providers.map(sanitizeGenerationProviderForMcp) };
}

function sanitizedGenerationCheckpoint<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizedGenerationCheckpoint(entry)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, typeof entry === "string" && ["note", "error", "authorizationReference", "externalTaskId", "model", "aspectRatio", "resolution", "creditMessage"].includes(key) ? sanitizeDiagnosticText(entry) : sanitizedGenerationCheckpoint(entry)])) as T;
}

function generationSummary(job: Awaited<ReturnType<typeof listGenerationJobs>>[number]) {
  return {
    id: job.id,
    itemId: job.itemId,
    taskId: job.taskId,
    providerId: job.providerId,
    kind: job.kind,
    purpose: job.purpose,
    fusionStoryboardPanel: job.fusionStoryboardPanel,
    continuationId: job.continuationId,
    continuationFirstFrameArtifactId: job.continuationFirstFrameArtifactId,
    status: job.status,
    model: job.model,
    parameters: job.parameters,
    executionSnapshot: job.executionSnapshot ? {
      capturedAt: job.executionSnapshot.capturedAt,
      snapshotHash: job.executionSnapshot.snapshotHash,
      workflowHash: job.executionSnapshot.workflowHash,
      promptSha256: job.executionSnapshot.promptSha256,
      parametersSha256: job.executionSnapshot.parametersSha256,
      storyboardRowsSha256: job.executionSnapshot.storyboardRowsSha256,
      referencesSha256: job.executionSnapshot.referencesSha256,
      provider: {
        id: job.executionSnapshot.provider.id,
        name: job.executionSnapshot.provider.name,
        adapter: job.executionSnapshot.provider.adapter,
        model: job.executionSnapshot.provider.model,
        executionSurface: job.executionSnapshot.provider.executionSurface,
        updatedAt: job.executionSnapshot.provider.updatedAt,
      },
      workflow: job.executionSnapshot.provider.workflow ? {
        name: job.executionSnapshot.provider.workflow.name,
        version: job.executionSnapshot.provider.workflow.version,
        format: job.executionSnapshot.provider.workflow.format,
      } : undefined,
    } : undefined,
    references: job.references,
    expectedOutputPath: job.expectedOutputPath,
    expectedCompanionPath: job.expectedCompanionPath,
    requestPath: job.requestPath,
    resultPath: job.resultPath,
    companionPath: job.companionPath,
    clientJobId: job.clientJobId ?? job.id,
    submissionIntent: job.submissionIntent,
    externalTaskId: sanitizeDiagnosticText(job.externalTaskId),
    remoteResultHost: remoteResultHost(job.remoteResultUrl),
    remoteAcceptedAt: job.remoteAcceptedAt,
    remoteObservation: job.remoteObservation ? { ...job.remoteObservation, observedStatus: sanitizeDiagnosticText(job.remoteObservation.observedStatus), message: sanitizeDiagnosticText(job.remoteObservation.message) } : undefined,
    httpSubmissionCheckpoint: sanitizedGenerationCheckpoint(getHttpGenerationSubmissionCheckpoint(job)),
    comfyUiCheckpoint: sanitizedGenerationCheckpoint(job.comfyUiCheckpoint),
    browserState: job.browserState,
    browserCheckpoint: sanitizedGenerationCheckpoint(job.browserCheckpoint),
    subagentCheckpoint: sanitizedGenerationCheckpoint(job.subagentCheckpoint),
    isolatedDownloadPath: job.isolatedDownloadPath,
    partialDownloadPath: job.partialDownloadPath,
    downloadBytes: job.downloadBytes,
    pollAttempts: job.pollAttempts ?? 0,
    downloadAttempts: job.downloadAttempts ?? 0,
    resultSha256: job.resultSha256,
    resultMagic: job.resultMagic,
    publicationBundleId: job.publicationBundleId,
    publicationIntentId: job.publicationIntentId,
    publicationReceiptId: job.publicationReceiptId,
    companionPublicationIntentId: job.companionPublicationIntentId,
    companionPublicationReceiptId: job.companionPublicationReceiptId,
    lastPolledAt: job.lastPolledAt,
    error: sanitizeDiagnosticText(job.error),
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function generationJobsFromCommandResult(value: unknown): GenerationJob[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is GenerationJob => Boolean(entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"));
}

function generationJobFromCommandResult(value: unknown): GenerationJob | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string" ? value as GenerationJob : undefined;
}

function sanitizedGenerationCommandResult(command: CommandRequest["command"], value: unknown, focusJobId?: string): unknown {
  if (command === "upsert_generation_provider" && value && typeof value === "object" && Array.isArray((value as { providers?: unknown }).providers)) {
    return sanitizeGenerationSettingsForMcp(value as GenerationSettings);
  }
  if (command === "enqueue_generation") return generationJobsFromCommandResult(value).map(generationSummary);
  if (command === "process_generation_queue") {
    const jobs = generationJobsFromCommandResult(value);
    const counts = jobs.reduce<Record<string, number>>((current, job) => ({ ...current, [job.status]: (current[job.status] ?? 0) + 1 }), {});
    return { processedJobId: focusJobId, counts, recent: jobs.filter((job) => !focusJobId || job.id === focusJobId).slice(0, 50).map(generationSummary) };
  }
  if (command === "cancel_generation" || command === "update_browser_generation" || command === "update_subagent_image_generation" || command === "migrate_generation_execution_state") {
    const job = generationJobFromCommandResult(value);
    return job ? generationSummary(job) : { resultUnavailable: true };
  }
  if (command === "reconcile_http_generation_submission") return sanitizedGenerationCheckpoint(value);
  return value;
}

function sanitizeCommandRecord<T extends Awaited<ReturnType<typeof executeIdempotentCommand>>>(record: T, focusJobId?: string, projectRoot?: string): T {
  const generationCommand = ["upsert_generation_provider", "enqueue_generation", "process_generation_queue", "cancel_generation", "update_browser_generation", "update_subagent_image_generation", "migrate_generation_execution_state", "reconcile_http_generation_submission"].includes(record.command);
  const p30OrchestrationCommand = [
    "stage_dudu_readonly_managed_project",
    "finalize_dudu_readonly_managed_project",
    "prepare_studio_video_package_export",
    "build_studio_video_package",
  ].includes(record.command);
  const isHiggsfieldPrepare = record.command === "prepare_studio_higgsfield_video_generation";
  const isHiggsfieldAuthorize = record.command === "authorize_studio_higgsfield_connector_request";
  const preparedResult = (isHiggsfieldPrepare || isHiggsfieldAuthorize)
    ? projectHiggsfieldPrepareConnectorRequestForMcp(record.result, projectRoot ?? record.storageRoot ?? "")
    : record.result;
  const result = generationCommand
    ? sanitizedGenerationCommandResult(record.command, preparedResult, focusJobId)
    : isHiggsfieldPrepare || isHiggsfieldAuthorize
      ? preparedResult
    : isManagedStudioCommand(record.command) || p30OrchestrationCommand
      ? sanitizeManagedStudioValue(preparedResult)
      : preparedResult;
  if (!isHiggsfieldPrepare && !isHiggsfieldAuthorize && (isManagedStudioCommand(record.command) || p30OrchestrationCommand)) assertManagedStudioProjectionSafe(result);
  // durableReconciliation 含完整写入 payload，storageRoot 暴露内部账本拓扑；二者仅供
  // 本机 Core 崩溃恢复，绝不进入 MCP 公共响应。
  const { durableReconciliation: _durableReconciliation, storageRoot: _storageRoot, ...publicRecord } = record;
  return {
    ...publicRecord,
    result,
    error: record.error ? {
      ...record.error,
      message: normalizeAbsolutePathsInMessage(sanitizeDiagnosticText(record.error.message) ?? ""),
    } : undefined,
  } as T;
}

function summarizeFusionPackageInspection(inspection: Awaited<ReturnType<typeof inspectFusionPackage>>) {
  const inventoryKinds = Object.fromEntries([...new Set(inspection.inventory.files.map((file) => file.kind))]
    .sort()
    .map((kind) => [kind, inspection.inventory.files.filter((file) => file.kind === kind).length]));
  return {
    schemaVersion: inspection.schemaVersion,
    kind: inspection.kind,
    readOnly: inspection.readOnly,
    sourceRoot: inspection.sourceRoot,
    packageRoot: inspection.packageRoot,
    indexPath: inspection.indexPath,
    assetLibraryPath: inspection.assetLibraryPath,
    counts: inspection.counts,
    expectedCounts: inspection.expectedCounts,
    inventory: {
      algorithm: inspection.inventory.algorithm,
      aggregateSha256: inspection.inventory.aggregateSha256,
      totalBytes: inspection.inventory.totalBytes,
      fileCount: inspection.inventory.files.length,
      byKind: inventoryKinds,
    },
    assets: {
      total: inspection.assets.length,
      byCategory: Object.fromEntries((["character", "scene", "prop"] as const).map((category) => [category, inspection.assets.filter((asset) => asset.category === category).length])),
    },
    units: {
      total: inspection.units.length,
      firstId: inspection.units[0]?.id,
      lastId: inspection.units.at(-1)?.id,
      episodes: [...new Set(inspection.units.map((unit) => unit.episode))],
    },
    continuity: {
      trackCount: inspection.continuityTracks.length,
      spanCount: inspection.continuityTracks.reduce((total, track) => total + track.spans.length, 0),
    },
    responsePolicy: "仅返回计数、路径和 SHA-256 摘要；不返回源正文、图片内容或 base64。",
  };
}

async function listFusionProductionAssetsForMcp(projectRoot: string, query: {
  category?: "character" | "scene" | "prop";
  assetId?: string;
  search?: string;
  generationStatus?: "not-generated" | "authority-accepted" | "generated-and-accepted" | "rework";
  hardLockStatus?: "unlocked" | "hard-locked";
  offset: number;
  limit: number;
}) {
  const canonicalSearch = query.search?.trim() || query.assetId;
  const firstCanonicalPage = await listCanonicalAssets(projectRoot, {
    category: query.category,
    search: canonicalSearch,
    authority: "any",
    offset: 0,
    limit: 100,
  });
  if (firstCanonicalPage.available) {
    const summaries = [...firstCanonicalPage.items];
    for (let offset = summaries.length; offset < firstCanonicalPage.total; offset += 100) {
      const page = await listCanonicalAssets(projectRoot, {
        category: query.category,
        search: canonicalSearch,
        authority: "any",
        offset,
        limit: 100,
      });
      if (!page.available || page.storeFingerprint !== firstCanonicalPage.storeFingerprint) {
        throw new Error("规范资产库在兼容分页期间发生变化，请重试。");
      }
      summaries.push(...page.items);
    }
    const projected = summaries.map((item) => {
      const generationStatus = item.hasPrimaryAuthority ? "authority-accepted" as const : "not-generated" as const;
      const hardLockStatus = item.hasPrimaryAuthority ? "hard-locked" as const : "unlocked" as const;
      return {
        assetId: item.id,
        assetName: item.canonicalName,
        category: item.category,
        workItemId: `asset-${item.id}`,
        generationStatus,
        hardLockStatus,
        currentStatus: item.hasPrimaryAuthority ? "已完成" : "待首帧",
        hardLockIds: item.primaryAuthorityId ? [item.primaryAuthorityId] : [],
        aliases: item.aliases.map((alias) => alias.value),
        primaryAuthorityId: item.primaryAuthorityId,
        primaryVersionId: item.primaryVersionId,
        versionCount: item.versionCount,
        authorityCount: item.authorityCount,
        migrationAnomalies: item.migrationAnomalies.map((anomaly) => ({ code: anomaly.code, severity: anomaly.severity })),
      };
    }).filter((entry) => !query.assetId || entry.assetId === query.assetId)
      .filter((entry) => !query.generationStatus || entry.generationStatus === query.generationStatus)
      .filter((entry) => !query.hardLockStatus || entry.hardLockStatus === query.hardLockStatus);
    return {
      available: true,
      deprecated: true,
      compatibilitySource: "canonical-assets" as const,
      storeRevision: firstCanonicalPage.storeRevision,
      storeFingerprint: firstCanonicalPage.storeFingerprint,
      queryFingerprint: firstCanonicalPage.queryFingerprint,
      total: projected.length,
      offset: query.offset,
      limit: query.limit,
      items: projected.slice(query.offset, query.offset + query.limit),
      responsePolicy: "已迁移项目仅返回规范资产摘要兼容投影；详情请使用 get_canonical_asset，永不返回媒体二进制或 base64。",
    };
  }
  const catalog = await loadFusionProductionAssets(projectRoot);
  if (!catalog) return { available: false, total: 0, offset: query.offset, limit: query.limit, items: [] };
  if (catalog.schemaVersion !== 1 || catalog.kind !== "fusion-production-assets" || !/^sha256:[a-f0-9]{64}$/u.test(catalog.sourceContentAddress)) {
    throw new Error("融合生产资产目录合同无效。");
  }
  const index = await loadIndex(projectRoot);
  const itemsById = new Map((index?.items ?? []).map((item) => [item.id, item]));
  const needle = query.search?.normalize("NFKC").trim().toLocaleLowerCase("zh-CN") ?? "";
  const items = catalog.assets.map((entry) => {
    const current = itemsById.get(entry.workItemId);
    const generationStatus = entry.authority
      ? "authority-accepted" as const
      : current?.status === "已完成"
        ? "generated-and-accepted" as const
        : current?.status === "返工"
          ? "rework" as const
          : "not-generated" as const;
    const hardLockStatus = current?.hardLockIds.length || entry.authority ? "hard-locked" as const : "unlocked" as const;
    return {
      assetId: entry.definition.id,
      assetName: entry.definition.name,
      category: entry.definition.category,
      workItemId: entry.workItemId,
      generationStatus,
      hardLockStatus,
      currentStatus: current?.status,
      hardLockIds: current?.hardLockIds ?? (entry.authority ? [entry.definition.id] : []),
      definition: {
        declaredUsage: entry.definition.declaredUsage,
        generationPrompts: entry.definition.generationPrompts,
        sourceMarkdownPath: entry.definition.sourceMarkdownPath,
        sourceHeadingLine: entry.definition.sourceHeadingLine,
        sourceSectionSha256: entry.definition.sourceSectionSha256,
      },
      contract: entry.contract,
      paths: { directoryPath: entry.directoryPath, infoPath: entry.infoPath, outputDirectory: entry.outputDirectory },
      authority: entry.authority ? {
        id: entry.authority.id,
        name: entry.authority.name,
        sourcePath: entry.authority.sourcePath,
        sourceSha256: entry.authority.sourceSha256,
        snapshotPath: entry.authority.snapshotPath,
        snapshotSha256: entry.authority.snapshotSha256,
        rules: entry.authority.rules,
        exposeToGeneration: entry.authority.exposeToGeneration,
      } : undefined,
    };
  }).filter((entry) => !query.category || entry.category === query.category)
    .filter((entry) => !query.assetId || entry.assetId === query.assetId)
    .filter((entry) => !query.generationStatus || entry.generationStatus === query.generationStatus)
    .filter((entry) => !query.hardLockStatus || entry.hardLockStatus === query.hardLockStatus)
    .filter((entry) => !needle || `${entry.assetId} ${entry.assetName}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(needle))
    .sort((left, right) => left.assetId.localeCompare(right.assetId, "en", { numeric: true }));
  return {
    available: true,
    projectId: catalog.projectId,
    sourceContentAddress: catalog.sourceContentAddress,
    revision: catalog.revision,
    updatedAt: catalog.updatedAt,
    currentIndexAvailable: Boolean(index),
    total: items.length,
    offset: query.offset,
    limit: query.limit,
    items: items.slice(query.offset, query.offset + query.limit),
    responsePolicy: "仅返回生产合同、状态、本地路径和 SHA-256；不返回图片内容或 base64。",
  };
}

function summarizePanelReferenceResolution(resolution: PanelReferenceResolution) {
  return {
    resolutionId: resolution.resolutionId,
    resolutionFingerprint: resolution.resolutionFingerprint,
    resolverVersion: resolution.resolverVersion,
    projectId: resolution.projectId,
    sourceContentAddress: resolution.sourceContentAddress,
    unitItemId: resolution.unitItemId,
    gridContractId: resolution.gridContractId,
    gridSourceFingerprint: resolution.gridSourceFingerprint,
    panelId: resolution.panelId,
    panelIndex: resolution.panelIndex,
    panelCount: resolution.panelCount,
    startSeconds: resolution.startSeconds,
    endSeconds: resolution.endSeconds,
    storyboardRowIds: resolution.storyboardRowIds,
    sourceShotNumbers: resolution.sourceShotNumbers,
    scheduleRowIndexes: resolution.scheduleRowIndexes,
    semanticAssets: resolution.semanticAssets.map((asset) => ({
      assetId: asset.assetId,
      assetName: asset.assetName,
      category: asset.category,
      bindingId: asset.bindingId,
      provenance: asset.provenance.map((entry) => ({
        kind: entry.kind,
        storyboardRowId: entry.storyboardRowId,
        scheduleRowIndexes: entry.scheduleRowIndexes,
        sourceShotNumbers: entry.sourceShotNumbers,
        continuitySpanIds: entry.continuitySpanIds,
        note: entry.note,
      })),
      hardLock: asset.hardLock ? {
        authority: asset.hardLock.authority,
        artifactId: asset.hardLock.artifactId,
        reviewId: asset.hardLock.reviewId,
        path: asset.hardLock.path,
        sha256: asset.hardLock.sha256,
        referenceVersion: asset.hardLock.referenceVersion,
      } : undefined,
    })),
    excludedAssets: resolution.excludedAssets,
    referenceSlots: resolution.referenceSlots.map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      readiness: slot.readiness,
      coveredAssetIds: slot.coveredAssetIds,
      assetId: slot.assetId,
      derivedAssetId: slot.derivedAssetId,
      artifactId: slot.artifactId,
      path: slot.path,
      sha256: slot.sha256,
      reviewId: slot.reviewId,
    })),
    timelineReconciliations: resolution.timelineReconciliations,
    detectedOverflow: resolution.detectedOverflow,
    overflowHandledByDerivedAssetId: resolution.overflowHandledByDerivedAssetId,
    closureStatus: resolution.closureStatus,
    generationReady: resolution.generationReady,
    blockerCodes: resolution.blockerCodes,
    issues: resolution.issues.slice(0, 20),
  };
}

function panelReferenceResponsePolicy() {
  return "只返回引用语义、来源、本地路径与 SHA-256 摘要；不返回图片、base64 或全季未分页数组。";
}

function summarizePanelVisualConstraint(constraint: PanelVisualConstraint) {
  const presenceCounts = constraint.assetPresence.reduce<Record<string, number>>((counts, entry) => ({
    ...counts,
    [entry.presence]: (counts[entry.presence] ?? 0) + 1,
  }), {});
  return {
    constraintId: constraint.constraintId,
    fingerprint: constraint.fingerprint,
    modelFingerprint: constraint.modelFingerprint,
    reviewRulesFingerprint: constraint.reviewRulesFingerprint,
    projectId: constraint.projectId,
    sourceContentAddress: constraint.sourceContentAddress,
    unitItemId: constraint.unitItemId,
    episodeNumber: constraint.episodeNumber,
    gridContractId: constraint.gridContractId,
    panelId: constraint.panelId,
    panelIndex: constraint.panelIndex,
    presenceCounts,
    mustAppearAssetIds: constraint.mustAppear.map((entry) => entry.assetId),
    mustNotAppearCodes: constraint.mustNotAppear.map((entry) => entry.warningCode),
    lockCounts: {
      identity: constraint.identityLocks.length,
      unresolvedIdentity: constraint.identityLocks.filter((entry) => entry.status === "unresolved").length,
      spatial: constraint.spatialLocks.length,
      unresolvedSpatial: constraint.spatialLocks.filter((entry) => entry.status === "unresolved").length,
      continuity: constraint.continuityLocks.length,
      unresolvedContinuity: constraint.continuityLocks.filter((entry) => entry.status === "unresolved").length,
    },
    hiddenMaskPolicy: constraint.hiddenMaskPolicy,
    warningCodes: [...new Set(constraint.warnings.map((entry) => entry.code))],
    reviewRuleCount: constraint.reviewRules.length,
    humanVisualReviewRequired: constraint.humanVisualReviewRequired,
    generationGate: constraint.generationGate,
  };
}

function detailPanelVisualConstraint(constraint: PanelVisualConstraint) {
  return {
    ...summarizePanelVisualConstraint(constraint),
    builderVersion: constraint.builderVersion,
    inputSnapshot: constraint.inputSnapshot,
    assetPresence: constraint.assetPresence,
    mustAppear: constraint.mustAppear,
    mustNotAppear: constraint.mustNotAppear,
    identityLocks: constraint.identityLocks,
    spatialLocks: constraint.spatialLocks,
    continuityLocks: constraint.continuityLocks,
    modelPrompt: constraint.modelPrompt,
    modelNegativePrompt: constraint.modelNegativePrompt,
    reviewRules: constraint.reviewRules,
    warnings: constraint.warnings,
  };
}

function panelVisualConstraintResponsePolicy() {
  return "列表仅返回分页身份、锁计数、警告码和门禁摘要；单格详情才返回模型提示与人工审核规则。永不返回图片、base64 或 4330 格全量数组。";
}

registrar.registerTool(
  "get_capabilities",
  {
    title: "读取画布能力清单",
    description: "让 Codex 在执行前理解本应用的工具域、批次边界、安全约束、剪辑能力、资源和提示词模板。可选传入项目根以读取该项目的适配器就绪状态。",
    inputSchema: { projectRoot: z.string().min(1).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      const [identity, runtimeStatus, runtimeArtifactCurrentness] = await Promise.all([
        MCP_RUNTIME_BUILD_IDENTITY,
        MCP_RUNTIME_GATE.checkDiagnostic(await MCP_RUNTIME_BOOT_IDENTITY),
        getMcpRuntimeArtifactCurrentness(),
      ]);
      const capabilities = await getCapabilities(projectRoot, {
        buildIdentity: identity,
        buildCurrentness: buildCurrentnessProjection(runtimeStatus, identity.buildId),
      });
      return structuredResult({
        ...capabilities,
        runtimeArtifactCurrentness,
        runtimeGateMetrics: MCP_RUNTIME_GATE.getMetrics(),
        runtimeMcpMetrics: MCP_RUNTIME_PERFORMANCE.snapshot(),
      });
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_active_managed_studio_context",
  {
    title: "读取当前桌面受管工程",
    description: "零参数读取桌面软件明确选择的活动受管工程、当前焦点、锁定资产摘要、唯一下一步、项目上下文令牌与写租约投影；缺失或冲突时失败关闭，绝不从项目列表偷选。writeLease.held 时异主禁止生图写。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return activeManagedStudioContextResult(await getActiveManagedStudioContext({
        runtimeBuildIdentity: await MCP_RUNTIME_BUILD_IDENTITY,
      }));
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_project_write_lease",
  {
    title: "读取项目写租约",
    description: "只读：是否有人持有该受管工程的写租约、holder、过期时间与拒绝提示。有租约时其他代理不得对生图相关命令 execute_command。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await getStudioProjectWriteLeasePublic(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "acquire_studio_project_write_lease",
  {
    title: "获取项目写租约",
    description: "为 Codex/Grok/脚本获取跨代理写租约。同 holder+leaseToken 可幂等续租；异主占用时失败关闭。forceTakeover 需 ≥8 字原因（慎用）。返回 leaseToken，后续生图写命令经 execute_command 传入。",
    inputSchema: {
      projectRoot: projectRootSchema,
      holderId: z.string().trim().min(1).max(128),
      holderKind: z.enum(["grok", "codex", "agent", "desktop-ui", "script"]).optional(),
      sessionId: z.string().trim().min(1).max(128).optional(),
      ttlSeconds: z.number().int().min(30).max(3600).optional(),
      note: z.string().trim().max(500).optional(),
      leaseToken: z.string().trim().regex(/^lease-[a-f0-9]{32}$/u).optional(),
      forceTakeover: z.boolean().optional(),
      takeoverReason: z.string().trim().min(8).max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      return structuredResult(await acquireStudioProjectWriteLease(input.projectRoot, {
        holderId: input.holderId,
        holderKind: input.holderKind,
        sessionId: input.sessionId,
        ttlSeconds: input.ttlSeconds,
        note: input.note,
        leaseToken: input.leaseToken,
        forceTakeover: input.forceTakeover,
        takeoverReason: input.takeoverReason,
      }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "heartbeat_studio_project_write_lease",
  {
    title: "续心跳写租约",
    description: "持有者续期写租约；必须 holderId+leaseToken。",
    inputSchema: {
      projectRoot: projectRootSchema,
      holderId: z.string().trim().min(1).max(128),
      leaseToken: z.string().trim().regex(/^lease-[a-f0-9]{32}$/u),
      ttlSeconds: z.number().int().min(30).max(3600).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, holderId, leaseToken, ttlSeconds }) => {
    try {
      return structuredResult(await heartbeatStudioProjectWriteLease(projectRoot, { holderId, leaseToken, ttlSeconds }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "release_studio_project_write_lease",
  {
    title: "释放项目写租约",
    description: "仅当前 holder+leaseToken 可释放；释放后其他代理可 acquire。",
    inputSchema: {
      projectRoot: projectRootSchema,
      holderId: z.string().trim().min(1).max(128),
      leaseToken: z.string().trim().regex(/^lease-[a-f0-9]{32}$/u),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, holderId, leaseToken }) => {
    try {
      return structuredResult(await releaseStudioProjectWriteLease(projectRoot, { holderId, leaseToken }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_generation_unknown_disposition",
  {
    title: "generation_unknown 只读处置建议",
    description: "对 generationRunId 只读给出处置：reconcile_only / may_fail_run / may_abandon_call / wait / clear。allowRedispatch 永远 false。禁止据此自动 re-dispatch。",
    inputSchema: {
      projectRoot: projectRootSchema,
      generationRunId: z.string().trim().min(3).max(255),
      remoteMayExist: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, generationRunId, remoteMayExist }) => {
    try {
      await inspectManagedProject(projectRoot);
      const {
        readStudioGenerationDispatch,
        readStudioImagegenCallIntentByRun,
        readStudioGenerationResultBundle,
      } = await import("../core/studio-generation-ledger.js");
      const [dispatch, callIntent, bundle] = await Promise.all([
        readStudioGenerationDispatch(projectRoot, generationRunId).catch(() => null),
        readStudioImagegenCallIntentByRun(projectRoot, generationRunId).catch(() => null),
        readStudioGenerationResultBundle(projectRoot, generationRunId).catch(() => null),
      ]);
      const hasCallIntent = Boolean(callIntent);
      const hasCommittedResult = Boolean(
        (bundle as any)?.raw || (bundle as any)?.results?.raw || (bundle as any)?.pair?.raw,
      );
      // run terminal from events is not always on dispatch; keep null if unknown
      const runTerminal = null as "failed" | "cancelled" | "succeeded" | null;
      const advice = await recommendGenerationUnknownDisposition({
        hasCallIntent,
        hasCommittedResult,
        runTerminal,
        remoteMayExist: remoteMayExist === true,
      });
      return structuredResult({
        schemaVersion: 1,
        kind: "studio-generation-unknown-disposition",
        generationRunId,
        hasDispatch: Boolean(dispatch),
        hasCallIntent,
        hasCommittedResult,
        ...advice,
        nextTools: advice.disposition === "reconcile_only"
          ? ["reconcile_studio_imagegen_call", "get_studio_generation_control"]
          : advice.disposition === "may_abandon_call"
            ? ["reconcile_studio_imagegen_call", "abandon_studio_generation_unknown"]
            : advice.disposition === "may_fail_run"
              ? ["fail_studio_generation_run"]
              : ["get_studio_generation_control", "get_studio_trace"],
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_episode_earliest",
  {
    title: "集级 earliest 单元（人机同一真相）",
    description: "只读：按 sequence 扫描集内 unit-grid，结合 05_canvas formal 证据与六图闸/写租约，返回 earliestUnitId 与 statusLine。UI/STATUS 应镜像此投影，不各自推导 nextAction。",
    inputSchema: {
      projectRoot: projectRootSchema,
      season: z.string().trim().min(1).max(32).optional(),
      episode: z.string().trim().min(1).max(32).optional(),
      evidenceDir: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, season, episode, evidenceDir }) => {
    try {
      return structuredResult(await getStudioEpisodeEarliest(projectRoot, { season, episode, evidenceDir }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "doctor_project",
  {
    title: "体检项目与运行环境",
    description: "只读取已有侧车和真实路径，检查导入、扫描时效、15 阶段 completed 证据漂移/旧状态指纹、根目录权限、机械失败、队列、剪辑任务与 FFmpeg；不会偷偷扫描、恢复渲染任务或写回侧车。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await doctorProject(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_project_snapshot",
  {
    title: "读取 Codex 统一项目快照",
    description: "一次返回真实扫描进度、焦点、下一任务、阻塞、验收、任务包、生成/剪辑/续接队列、硬锁、Skill、故事层、15 阶段证据摘要和后续建议。completed 证据漂移时优先阻断下游任务；没有索引时明确要求先导入。",
    inputSchema: { projectRoot: projectRootSchema, focusItemId: z.string().min(1).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, focusItemId }) => {
    try { return structuredResult(await getProjectSnapshot(projectRoot, focusItemId)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "inspect_fusion_package",
  {
    title: "只读预检第三季融合包",
    description: "严格只读核验 15s_fused_units.json、单元 Markdown、源提示词表、源剧本和全季资产库，验证精确计数、15 秒排期、资产使用与源文件 SHA-256。响应只含摘要，不返回正文或图片内容。",
    inputSchema: fusionInspectionInputShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (input) => {
    try { return structuredResult(summarizeFusionPackageInspection(await inspectFusionPackage(input))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_canonical_asset_catalog_state",
  {
    title: "读取规范资产库状态",
    description: "只读返回当前项目规范资产库的可用性、修订、指纹与审计摘要；不扫描、不写盘、不返回媒体二进制或 base64。",
    inputSchema: { projectRoot: canonicalAssetProjectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return canonicalAssetReadResult(await getCanonicalAssetCatalogState(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_canonical_assets",
  {
    title: "分页列出规范资产",
    description: "仅在当前项目内按显式类别、别名/结构化特征搜索与权威状态分页返回资产摘要；详情、版本和关系需通过 get_canonical_asset 懒加载。",
    inputSchema: {
      projectRoot: canonicalAssetProjectRootSchema,
      category: z.enum(["character", "scene", "prop"]).optional(),
      search: z.string().trim().max(200).optional(),
      authority: canonicalAssetAuthorityFilterSchema.optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, category, search, authority, offset, limit }) => {
    try { return canonicalAssetReadResult(await listCanonicalAssets(projectRoot, { category, search, authority, offset, limit })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_canonical_asset",
  {
    title: "读取规范资产详情",
    description: "按稳定资产 ID 只读返回当前且允许用于生成的权威、版本、媒体路径/SHA 与对应锁；禁止上传的辅助权威和全部历史默认脱敏，仅返回删减计数。缺失 ID 返回明确 not-found，不返回媒体二进制或 base64。",
    inputSchema: {
      projectRoot: canonicalAssetProjectRootSchema,
      assetId: z.string().trim().min(1).max(200),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, assetId }) => {
    try { return canonicalAssetReadResult(modelSafeCanonicalAssetDetail(await getCanonicalAsset(projectRoot, assetId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_fusion_production_assets",
  {
    title: "列出融合工程生产资产",
    description: "兼容读取旧融合工程资产。已迁移项目返回 deprecated canonical-assets 摘要投影，详情请改用 get_canonical_asset；未迁移项目保持旧合同行为。不扫描、不写盘、不返回图片或 base64。",
    inputSchema: {
      projectRoot: projectRootSchema,
      category: z.enum(["character", "scene", "prop"]).optional(),
      assetId: z.string().regex(/^[CSP]\d{2}[a-z]?$/u).optional(),
      search: z.string().max(200).optional(),
      generationStatus: z.enum(["not-generated", "authority-accepted", "generated-and-accepted", "rework"]).optional(),
      hardLockStatus: z.enum(["unlocked", "hard-locked"]).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...query }) => {
    try { return canonicalAssetReadResult(await listFusionProductionAssetsForMcp(projectRoot, query)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_continuity_tracks",
  {
    title: "列出角色与场景连续性轨道",
    description: "分页读取资产跨集、15 秒单元和秒段的连续性摘要；只读，不返回媒体二进制。",
    inputSchema: {
      projectRoot: projectRootSchema,
      category: z.enum(["character", "scene", "prop"]).optional(),
      assetId: z.string().regex(/^[CSP]\d{2}[a-z]?$/u).optional(),
      search: z.string().max(200).optional(),
      episode: z.number().int().min(1).max(999).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...query }) => {
    try { return structuredResult(await listContinuityTracks(projectRoot, query)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_continuity_spans",
  {
    title: "读取资产连续性秒段",
    description: "按资产读取其集、15 秒单元、原镜号、秒段、同场角色/场景/道具和参考版本；分页只读，不返回媒体内容。",
    inputSchema: {
      projectRoot: projectRootSchema,
      assetId: z.string().regex(/^[CSP]\d{2}[a-z]?$/u),
      episode: z.number().int().min(1).max(999).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(80),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, assetId, ...query }) => {
    try {
      if (!await loadIndex(projectRoot)) throw new Error("连续性秒段只读查询要求已有真实扫描索引；请先通过 execute_command(scan_project) 建立索引。");
      return structuredResult(await getContinuitySpans(projectRoot, assetId, query));
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "audit_fusion_panel_references",
  {
    title: "审计全季逐格引用闭包",
    description: "只读返回 1288 个当前宫格合同的闭包计数、语义绑定、超六项派生处理和生图就绪度；闭包通过不等于所有资产已硬锁。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      const snapshot = await inspectFusionPanelReferenceAudit(projectRoot);
      return structuredResult({ ...snapshot.audit, currentness: snapshot.currentness, storeRevision: snapshot.storeRevision, storeFingerprint: snapshot.storeFingerprint, responsePolicy: panelReferenceResponsePolicy() });
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_fusion_panel_reference_resolutions",
  {
    title: "分页列出逐格引用解析",
    description: "按集、单元、闭包状态、生图就绪度或超六项过滤当前 resolution；只返回分页语义引用、来源、槽位和阻塞摘要。",
    inputSchema: {
      projectRoot: projectRootSchema,
      episode: z.number().int().min(1).max(999).optional(),
      unitItemId: z.string().min(1).max(500).optional(),
      closureStatus: z.enum(["resolved", "confirmed-empty", "unresolved"]).optional(),
      generationReady: z.boolean().optional(),
      overflowOnly: z.boolean().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...query }) => {
    try {
      const page = await listFusionPanelReferenceResolutions(projectRoot, query);
      return structuredResult({
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        storeRevision: page.storeRevision,
        storeFingerprint: page.storeFingerprint,
        audit: page.audit,
        items: page.items.map(summarizePanelReferenceResolution),
        responsePolicy: panelReferenceResponsePolicy(),
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_fusion_panel_reference_resolution",
  {
    title: "读取单个逐格引用解析",
    description: "按当前宫格合同与格 ID 读取语义资产、来源、时间轴裁决、供应商引用槽和阻塞原因；不返回媒体二进制。",
    inputSchema: {
      projectRoot: projectRootSchema,
      contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
      panelId: z.string().min(1).max(500),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, contractId, panelId }) => {
    try { return structuredResult({ ...summarizePanelReferenceResolution(await getFusionPanelReferenceResolution(projectRoot, contractId, panelId)), responsePolicy: panelReferenceResponsePolicy() }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "audit_fusion_visual_constraints",
  {
    title: "审计全季逐格视觉约束",
    description: "只读核对 P3 结构化 must/must-not、身份/空间/连续性锁、模型与审核指纹、隐藏面具策略及预警闭包；自动检测只作预筛，最终仍需人工视觉 Review。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      const result = await auditFusionPanelVisualConstraints(projectRoot);
      return structuredResult({ ...result, responsePolicy: panelVisualConstraintResponsePolicy() });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_fusion_visual_constraints",
  {
    title: "分页列出逐格视觉约束",
    description: "按集、单元、生图门禁、预警、隐藏面具状态或未解析空间锁过滤 P3 当前约束；列表不返回模型提示词和完整审核规则。",
    inputSchema: {
      projectRoot: projectRootSchema,
      episode: z.number().int().min(1).max(999).optional(),
      unitItemId: z.string().min(1).max(500).optional(),
      generationReady: z.boolean().optional(),
      warningCode: z.enum(PANEL_VISUAL_WARNING_CODES).optional(),
      hiddenMaskStatus: z.enum(["not-applicable", "concealed", "reveal-authorized"]).optional(),
      unresolvedSpatialOnly: z.boolean().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...query }) => {
    try {
      const page = await listFusionPanelVisualConstraints(projectRoot, query);
      return structuredResult({
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        storeRevision: page.storeRevision,
        storeFingerprint: page.storeFingerprint,
        audit: page.audit,
        items: page.items.map(summarizePanelVisualConstraint),
        responsePolicy: panelVisualConstraintResponsePolicy(),
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_fusion_visual_constraint",
  {
    title: "读取单格结构化视觉约束",
    description: "按当前宫格合同和格 ID 读取该格模型载荷、must/must-not、身份/空间/连续性锁、人工审核规则、预警和独立指纹；不返回媒体二进制。",
    inputSchema: {
      projectRoot: projectRootSchema,
      contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
      panelId: z.string().min(1).max(500),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, contractId, panelId }) => {
    try {
      const constraint = await getFusionPanelVisualConstraint(projectRoot, contractId, panelId);
      return structuredResult({ ...detailPanelVisualConstraint(constraint), responsePolicy: panelVisualConstraintResponsePolicy() });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "materialize_fusion_visual_constraints",
  {
    title: "幂等物化全季逐格视觉约束",
    description: "在当前 P2 引用闭包和宫格合同上以 store revision CAS 构建 P3 结构化视觉约束仓，冻结模型与审核独立指纹、旧 Job 只读证据和隐藏面具逐格策略；首次物化 expectedStoreRevision=0，返回审计摘要而非 4330 格全量。",
    inputSchema: { projectRoot: projectRootSchema, expectedStoreRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("materialize_fusion_visual_constraints 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "upsert_fusion_visual_constraint_override",
  {
    title: "使用 CAS 修订逐格视觉约束",
    description: "统一写入资产显隐裁决或黄金面具逐格 reveal 授权。必须绑定当前 store revision 与 constraint ID；presence 另绑定 P2 resolution/binding，reveal 必须记录用户批准和理由。",
    inputSchema: { projectRoot: projectRootSchema, override: fusionVisualConstraintOverrideSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("upsert_fusion_visual_constraint_override 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "list_derived_panel_reference_assets",
  {
    title: "分页列出派生组合引用资产",
    description: "只读分页列出超六项宫格的群像/道具/混合组合定义、成员和视觉产物就绪状态；结构审核不伪装为视觉验收。",
    inputSchema: {
      projectRoot: projectRootSchema,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, offset, limit }) => {
    try {
      const page = await listDerivedPanelReferenceAssets(projectRoot, { offset, limit });
      return structuredResult({
        ...page,
        items: page.items.map((item) => ({
          id: item.id,
          version: item.version,
          kind: item.kind,
          name: item.name,
          memberAssetIds: item.memberAssetIds,
          memberDefinitionVersions: item.memberDefinitionVersions,
          definitionFingerprint: item.definitionFingerprint,
          definitionReview: item.definitionReview,
          visualArtifact: item.visualArtifact,
          status: item.status,
        })),
        responsePolicy: panelReferenceResponsePolicy(),
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "materialize_fusion_panel_references",
  {
    title: "幂等物化全季逐格引用闭包",
    description: "为全季当前 2–6 格合同构建统一 resolution 仓，显式调和分镜与连续性差异，超六项建立不丢成员的派生定义。返回审计摘要，不返回 4330 格全量数组。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("materialize_fusion_panel_references 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "upsert_panel_reference_override",
  {
    title: "使用 CAS 修订逐格引用",
    description: "在绑定当前 resolution ID 和引用仓修订的前提下，显式补入或排除已知资产并记录原因；成功后重新物化并返回该格摘要。",
    inputSchema: {
      projectRoot: projectRootSchema,
      contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
      panelId: z.string().min(1).max(500),
      expectedResolutionId: z.string().regex(/^panel-reference-[a-f0-9]{28}$/u),
      expectedStoreRevision: z.number().int().positive(),
      includeAssetIds: z.array(z.string().regex(/^[CSP]\d{2}[a-z]?$/u)).max(77).optional(),
      excludeAssetIds: z.array(z.string().regex(/^[CSP]\d{2}[a-z]?$/u)).max(77).optional(),
      reason: z.string().trim().min(3).max(2_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("upsert_panel_reference_override 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "register_derived_panel_reference_artifact",
  {
    title: "登记已视觉验收的派生组合引用图",
    description: "使用引用仓修订和派生资产版本 CAS，登记位于当前隔离工程内、SHA 可追溯且已人工视觉通过的组合图；核对全部成员当前硬锁摘要后重新物化受影响格。",
    inputSchema: {
      projectRoot: projectRootSchema,
      derivedAssetId: z.string().regex(/^derived-reference-[a-f0-9]{24}$/u),
      expectedStoreRevision: z.number().int().positive(),
      expectedVersion: z.number().int().positive(),
      filePath: z.string().min(1),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      reviewer: z.enum(["user", "codex"]),
      reviewNote: z.string().trim().min(3).max(4_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("register_derived_panel_reference_artifact 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "materialize_fusion_project",
  {
    title: "幂等物化第三季融合工程",
    description: "重新执行只读预检并按源内容地址建立隔离工程；源漂移、重复输入或目标冲突均失败关闭。权威输入必须携带 expectedSha256，并显式声明 exposeToGeneration。",
    inputSchema: {
      projectRoot: projectRootSchema.describe("承载幂等命令账本的现有画布工程根"),
      ...fusionInspectionInputShape,
      targetParent: z.string().min(1).describe("与只读源隔离的既有可写父目录"),
      authorities: z.array(fusionAuthorityInputSchema).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("materialize_fusion_project 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "build_fusion_reference_board",
  {
    title: "幂等构建融合参考板",
    description: "从当前真实扫描索引和已验收硬锁资产构建唯一参考板；单镜最多 6 项，禁止静默裁剪。响应仅返回参考板本地路径、SHA-256 与冻结提示词，不返回图片内容。",
    inputSchema: {
      projectRoot: projectRootSchema,
      itemId: z.string().min(1),
      variant: z.enum(["asset", "start", "end", "shot"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("build_fusion_reference_board 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "build_fusion_storyboard_grid",
  {
    title: "幂等构建 15 秒宫格分镜合同",
    description: "按当前已确认分镜中的中文动作语义和连续 15 秒排期自动选择 2–6 格；强标点、动作转折和时间锚点形成可审计剧情节拍，通用延展固定一格，超过 6 个节拍透明连续归并。每格冻结独立动作与独立生图提示词；显式改格必须绑定当前 storyboard 修订并记录原因。",
    inputSchema: {
      projectRoot: projectRootSchema,
      itemId: z.string().min(1),
      override: z.object({
        panelCount: z.number().int().min(2).max(6),
        expectedRevision: z.number().int().positive(),
        reason: z.string().trim().min(3).max(2_000),
      }).optional(),
      referenceOverride: z.object({
        expectedRevision: z.number().int().positive(),
        reason: z.string().trim().min(3).max(2_000),
        promptInstruction: z.string().trim().min(3).max(4_000),
        additionalAssetIdsByRowId: z.record(z.string().min(1), z.array(z.string().min(1).max(80)).min(1).max(6)),
      }).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("build_fusion_storyboard_grid 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "get_fusion_storyboard_sheet_state",
  {
    title: "读取正式中文分镜板状态",
    description: "只读核验当前宫格合同、P3 逐规则 Review、逐格 Job/Publication/raw/labeled SHA、内容寻址输入指纹、current 与历史版本，并返回服务端计算的旧板迁移候选；不返回图片或 base64。",
    inputSchema: {
      projectRoot: z.string().min(1),
      itemId: z.string().min(1).max(500),
      contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u).optional(),
      placements: fusionStoryboardSheetPlacementsSchema.optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId, contractId, placements }) => {
    try { return structuredResult(await getFusionStoryboardSheetState(projectRoot, { itemId, contractId, placements })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_fusion_storyboard_sheets",
  {
    title: "分页列出正式中文分镜板版本",
    description: "按单元、sheetId 或派生状态分页读取 current/stale/invalid/legacy-invalid 历史和服务端迁移预检；只返回身份、原因与本地路径，不返回媒体二进制。",
    inputSchema: {
      projectRoot: z.string().min(1),
      itemId: z.string().min(1).max(500).optional(),
      sheetId: z.string().regex(/^(?:sheet-v2|legacy-sheet)-[a-f0-9]{32}$/u).optional(),
      status: z.enum(["current", "stale", "invalid", "legacy-invalid"]).optional(),
      placements: fusionStoryboardSheetPlacementsSchema.optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return structuredResult(await listFusionStoryboardSheets(projectRoot, input)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "migrate_fusion_storyboard_sheets",
  {
    title: "幂等登记旧中文分镜板历史",
    description: "按服务端候选指纹与 store revision 批量 CAS 登记 P4 前旧板，仅建立 stale/legacy-invalid 历史；不修改 Job、Publication、Review、raw/labeled，不触发生成。",
    inputSchema: {
      projectRoot: z.string().min(1),
      itemIds: z.array(z.string().min(1).max(500)).max(1_288).optional(),
      expectedStoreRevision: z.number().int().min(0),
      expectedCandidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("migrate_fusion_storyboard_sheets 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "render_fusion_storyboard_sheet",
  {
    title: "幂等生成本地中文分镜故事板",
    description: "只使用同一当前宫格合同下已完成、已发布、已通过当前 P3 逐规则 Review 且 raw/labeled 成对的逐格图片，本地生成无删字动态长版中文 SVG/PNG；必须提交刚读取的完整输入指纹，不让生图模型绘制文字，不覆盖逐格原图。",
    inputSchema: {
      projectRoot: z.string().min(1),
      itemId: z.string().min(1),
      contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
      expectedInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      placements: fusionStoryboardSheetPlacementsSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("render_fusion_storyboard_sheet 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "get_fusion_asset_consistency",
  {
    title: "读取六张资产一致性门禁",
    description: "只读返回每 6 张资产的批次归属、隐藏面具优先后按首次出场冻结的生产顺序与下一批、Publication/raw/labeled/单图 Review 就绪度、跨图复核有效性、硬锁进度和阻塞原因；不返回图片内容。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await getFusionAssetConsistencyState(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "prepare_fusion_asset_consistency_review",
  {
    title: "幂等准备六张一致性复核板",
    description: "安全接管仅 queued/plan_ready 的旧资产任务；六项 Publication、raw/labeled、机械验收和单图 Review 全部齐备后，本地生成 2×3 中文复核板。复核板仅供检查，不能作为正式资产或生图参考。",
    inputSchema: { projectRoot: projectRootSchema, batchId: z.string().regex(/^fusion-asset-batch-\d{3}$/u).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("prepare_fusion_asset_consistency_review 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "submit_fusion_asset_consistency_review",
  {
    title: "提交六张资产一致性复核",
    description: "以 store revision 和当前证据 snapshot SHA 做 CAS，逐项提交角色、时代风格、场景、比例、道具、洁净画面及隐藏面具铁律；通过前禁止硬锁和下一批。",
    inputSchema: {
      projectRoot: projectRootSchema,
      batchId: z.string().regex(/^fusion-asset-batch-\d{3}$/u),
      expectedRevision: z.number().int().positive(),
      expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
      decision: z.enum(["pass", "rework"]),
      criteria: z.array(z.object({ key: z.enum(FUSION_ASSET_CONSISTENCY_CRITERIA), result: z.enum(["pass", "fail", "na"]), note: z.string().max(2_000).optional() })).length(FUSION_ASSET_CONSISTENCY_CRITERIA.length),
      reworkItemIds: z.array(z.string().min(1)).max(6).optional(),
      note: z.string().max(4_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("submit_fusion_asset_consistency_review 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "seal_final_fusion_asset_consistency_batch",
  {
    title: "封存全季最终不足六项批次",
    description: "仅当全部无权威资产都已进入批次时，才允许把最后 1–5 项显式封存为 final_partial；同样必须完成跨图复核，禁止静默跳过。",
    inputSchema: { projectRoot: projectRootSchema, batchId: z.string().regex(/^fusion-asset-batch-\d{3}$/u), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("seal_final_fusion_asset_consistency_batch 必须通过幂等命令账本执行。")),
);

registrar.registerTool(
  "list_projects",
  {
    title: "列出 AI 漫剧画布项目",
    description: "列出本机已经登记的项目根目录，不扫描媒体内容。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => { try { return textResult(await listProjects()); } catch (error) { return toolError(error); } }
);

registrar.registerTool(
  "scan_project",
  {
    title: "扫描真实项目文件",
    description: "扫描 00_信息.md、提示词、raw/labeled 和视频；未变化文件复用带 ctime/mtime/尺寸/检查器版本签名的机械验收，更新侧车索引与 SQLite 缓存，并返回新检/复用统计。支持 MCP 进度通知和提交点前取消；取消不会覆盖稳定索引。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      return textResult(summarizeForMcp(await scanAndPersist(projectRoot)));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "preview_scan_project",
  {
    title: "只读预检项目",
    description: "扫描待导入目录并返回识别摘要，不创建 .aicanvas、不登记项目、不写缓存；支持 MCP 进度通知和随时取消。",
    inputSchema: { projectRoot: z.string().min(1).describe("待预检项目主根绝对路径") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }, extra) => {
    const scanBridge = createScanRequestBridge(extra);
    try {
      const index = await previewProjectScan(projectRoot, { signal: scanBridge.signal, onProgress: scanBridge.onProgress });
      const shots = index.items.filter((item) => item.type === "shot");
      return textResult({
        ...summarizeForMcp(index),
        hierarchy: {
          shots: shots.length,
          nestedShots: shots.filter((item) => item.parentId).length,
          orphanShots: shots.filter((item) => !item.parentId).length,
          assets: index.items.filter((item) => item.type === "asset").length,
        },
      });
    } catch (error) {
      return toolError(error);
    } finally { await scanBridge.flush(); }
  },
);

const importOptionsSchema = {
  primaryRoot: z.string().min(1).describe("待导入项目主根绝对路径"),
  projectMode: z.enum(["filesystem", "story_first"]).optional().describe("导入已有生产文件，或从空目录建立小说起步项目"),
  name: z.string().min(1).optional().describe("画布中的项目名称"),
  sourceRoots: z.array(z.string().min(1)).max(20).optional().describe("只读附加来源根"),
  outputRoots: z.array(z.string().min(1)).max(20).optional().describe("允许新版本落盘的输出根"),
  ignoreSegments: z.array(z.string().min(1)).max(50).optional().describe("旧版、弃用、备份等忽略目录关键词"),
  namingRules: z.object({
    patterns: z.array(z.object({ id: z.string().min(1).max(120), type: z.enum(["unit", "shot"]), pattern: z.string().min(1).max(2_000), scope: z.string().max(120).optional() })).max(50),
    manualMappings: z.array(z.object({ pathPrefix: z.string().min(1), type: z.enum(["unit", "shot"]), episode: z.number().int().positive(), unit: z.number().int().positive().optional(), shot: z.string().max(40).optional(), title: z.string().max(200).optional(), scope: z.string().max(120).optional() })).max(2_000),
  }).optional().describe("无法匹配默认 EP/15s/镜头命名时使用的自定义正则和手工路径映射"),
};

registrar.registerTool(
  "preview_project_import",
  {
    title: "预检项目导入",
    description: "在不创建侧车、不登记项目的前提下预检主根、附加来源、忽略规则、机械异常和跨根冲突。返回 previewId，确认导入时必须原样携带。",
    inputSchema: importOptionsSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (options) => {
    try { return textResult(await prepareProjectImport(options)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "commit_project_import",
  {
    title: "确认导入项目",
    description: "使用刚才的 previewId 和完全相同的导入规则建立或更新 .aicanvas；保留既有画布、任务和验收历史。",
    inputSchema: { previewId: z.string().min(1), requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), ...importOptionsSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ previewId, requestId, idempotencyKey, ...options }) => {
    try {
      const preview = await prepareProjectImport(options);
      return structuredResult(await executeIdempotentCommand(preview.config.primaryRoot, { requestId, idempotencyKey, request: { command: "commit_project_import", payload: { previewId, config: preview.config, projectMode: preview.projectMode } } }, { storageRoot: await ensureImportCommandStorageRoot(preview.config.primaryRoot) }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_progress",
  {
    title: "读取项目进度",
    description: "读取最近一次真实扫描的进度摘要，不返回图片数据。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      return textResult(await getProgress(projectRoot));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "list_context",
  {
    title: "列出项目记忆",
    description: "读取项目本地 context.json 中的世界观、角色、连续性、决策、问题和交接记录。",
    inputSchema: { projectRoot: projectRootSchema, kind: z.enum(PROJECT_CONTEXT_KINDS).optional(), tag: z.string().optional(), itemId: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...options }) => {
    try { return textResult(await listProjectContext(projectRoot, options)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "search_context",
  {
    title: "检索项目上下文",
    description: "联合检索项目记忆、真实生产节点、硬锁、验收和事件，不读取聊天历史。",
    inputSchema: { projectRoot: projectRootSchema, query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query, limit }) => {
    try { return textResult(await searchProjectContext(projectRoot, query, limit)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "upsert_context",
  {
    title: "写入项目记忆",
    description: "创建或更新项目本地记忆，可关联真实节点和来源路径；创建不得带 revision，更新必须携带当前 expectedRevision。",
    inputSchema: revisionedUpsertSchema({ projectRoot: projectRootSchema, ...projectContextInputShape }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return textResult(await upsertProjectContext(projectRoot, input as Parameters<typeof upsertProjectContext>[1], "codex")); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "delete_context",
  {
    title: "删除项目记忆",
    description: "删除指定项目记忆条目，不删除任何生产素材。",
    inputSchema: { projectRoot: projectRootSchema, contextId: z.string().min(1), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ projectRoot, contextId, expectedRevision }) => {
    try { await deleteProjectContext(projectRoot, { contextId, expectedRevision }, "codex"); return textResult({ deleted: contextId }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_skills",
  {
    title: "列出项目 Skill",
    description: "列出项目 .aicanvas/skills 中可编辑的 Codex 生产规则。",
    inputSchema: { projectRoot: projectRootSchema, enabledOnly: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, enabledOnly }) => {
    try { return textResult((await listAgentSkills(projectRoot, { enabledOnly })).map(({ content: _content, ...skill }) => skill)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "read_skill",
  {
    title: "读取项目 Skill",
    description: "读取一个项目 Skill 的完整 Markdown 内容和版本信息。",
    inputSchema: { projectRoot: projectRootSchema, skillId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, skillId }) => {
    try { return textResult(await readAgentSkill(projectRoot, skillId)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "save_skill",
  {
    title: "保存项目 Skill",
    description: "保存项目 Skill，覆盖前自动备份旧版本；expectedUpdatedAt 用于防止并发覆盖。",
    inputSchema: { projectRoot: projectRootSchema, id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), name: z.string().min(1).max(120), description: z.string().max(500), category: z.enum(["orchestration", "production", "continuity", "review", "custom"]), enabled: z.boolean(), content: z.string().max(200000), expectedUpdatedAt: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return textResult(await saveAgentSkill(projectRoot, input)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_continuation",
  {
    title: "生成 Codex 接续快照",
    description: "组合真实扫描进度、焦点节点、下一任务、项目记忆、最近验收和启用 Skill，并生成可复制提示词。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId }) => {
    try { return textResult(await getContinuationSnapshot(projectRoot, { itemId })); }
    catch (error) { return toolError(error); }
  },
);

const novelAgentProjectRootSchema = z.string().trim().min(1).optional()
  .describe("可选受管 novel/hybrid 工程绝对路径；省略时只使用桌面明确登记的活动工程，绝不从项目列表偷选");
const novelActorAttributionSchema = z.object({
  actorId: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(500),
  sessionId: z.string().trim().min(1).max(500),
  transport: z.enum(["mcp", "json_cli", "main", "internal"]),
}).strict();

registrar.registerTool(
  "doctor_novel_agent",
  {
    title: "诊断受管小说写章就绪度",
    description: "陌生 AI 的只读第一入口。自动解析活动/显式工程、推荐下一章，检查 locked、brief、required cast、人物声口/结构化外形/动态状态、上一章 completion、rebuild queue 与活动写租约，并返回可直接调用的 nextTools。不会获取租约或修改正文。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1).optional(),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId, workflowMode }) => {
    try { return structuredResult(await doctorNovelAgent(projectRoot, { targetChapterId, workflowMode })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_manuscript_workspace",
  {
    title: "读取受管小说 Agent 工作区",
    description: "AI 小说推荐入口。返回合同版本、权威来源、项目身份、卷章计数、manifest revision 和字符规模；不返回整本正文。projectRoot 省略时只认桌面明确活动工程。",
    inputSchema: { projectRoot: novelAgentProjectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await getNovelManuscriptWorkspace(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_novel_manuscript_chapters",
  {
    title: "分页列出受管小说章节",
    description: "按卷章顺序返回稳定 chapterId、相对 locator、revision、SHA-256 和字数；不返回正文。先读取 workspace，再按 nextOffset 翻页。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1).describe("当前任务目标章；列表只返回其 cutoff 内章节"),
      cutoff: z.enum(["before", "through"]).default("before"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId, cutoff, offset, limit }) => {
    try { return structuredResult(await listNovelManuscriptChapters(projectRoot, { offset, limit, taskScope: { targetChapterId, cutoff } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "read_novel_manuscript_range",
  {
    title: "按 UTF-16 区间读取小说章节",
    description: "有界读取一个 managed manuscript 章节。返回 chapter revision/SHA、UTF-16 半开区间与截断状态；外部改写时只返回 external_change，不把漂移正文交给 AI。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1).describe("当前任务目标章；读取不得越过其 cutoff"),
      cutoff: z.enum(["before", "through"]).default("before"),
      chapterId: z.string().min(1),
      startOffset: z.number().int().min(0).default(0),
      maxCharacters: z.number().int().min(1).max(200_000).default(12_000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId, cutoff, chapterId, startOffset, maxCharacters }) => {
    try { return structuredResult(await readNovelManuscriptRange(projectRoot, { chapterId, startOffset, maxCharacters, taskScope: { targetChapterId, cutoff } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "search_novel_manuscript",
  {
    title: "搜索受管小说全文",
    description: "在正文 SHA/字节/字符和 manifest revision 一致性校验下搜索 managed manuscript；优先使用 Canvas-owned FTS5 派生索引，缺失、陈旧、损坏、短词或正文身份漂移时安全回退全扫，并返回 engine/indexState/fallbackReason 审计字段。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1).describe("当前任务目标章；搜索不得越过其 cutoff"),
      cutoff: z.enum(["before", "through"]).default("before"),
      query: z.string().trim().min(2).max(200),
      limit: z.number().int().min(1).max(200).default(50),
      maxHitsPerChapter: z.number().int().min(1).max(20).default(5),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId, cutoff, query, limit, maxHitsPerChapter }) => {
    try { return structuredResult(await searchNovelManuscript(projectRoot, { query, limit, maxHitsPerChapter, taskScope: { targetChapterId, cutoff } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_search_index_status",
  {
    title: "读取小说全文索引状态",
    description: "物理零写读取 Canvas-owned 派生全文索引的 missing/building/fresh/stale/corrupt 状态、active generation 与覆盖计数；需要重建时只通过 execute_command(novel_rebuild_search_index) 显式执行。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await getNovelSearchIndexStatus(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_writing_state",
  {
    title: "读取小说时态正典与人物状态",
    description: "按目标章before/through截止语义读取来源可追溯的硬正典、人物声口与外形 Authority、角色八项动态状态、知情、关系、日历与伏笔；不读取未来章正文，不修改canon。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1),
      cutoff: z.enum(["before", "through"]),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId, cutoff, characterIds }) => {
    try { return structuredResult(await getNovelWritingState(projectRoot, { targetChapterId, cutoff, characterIds })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_novel_writing_source_receipts",
  {
    title: "列出小说写作资料快照回执",
    description: "列出由 human owner 一次性只读导入、已复制到工程内 raw/text CAS 的资料快照及 suggestedSourceId。绝不返回原外部目录绝对路径，也不自动把资料内容提升为正典。",
    inputSchema: { projectRoot: novelAgentProjectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await listNovelWritingSourceReceipts(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "compare_novel_writing_source_receipts",
  {
    title: "比较小说写作资料快照",
    description: "确定性比较两份不可变 writing source receipt，分类 unchanged、modified、唯一内容身份 rename、deleted 与 untracked；只返回安全相对路径和哈希，不回读或暴露原外部目录。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      baseReceiptId: z.string().regex(/^novel-writing-source-receipt-[a-f0-9]{32}$/u),
      currentReceiptId: z.string().regex(/^novel-writing-source-receipt-[a-f0-9]{32}$/u),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, baseReceiptId, currentReceiptId }) => {
    try { return structuredResult(await compareNovelWritingSourceReceipts(projectRoot, { baseReceiptId, currentReceiptId })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "plan_novel_state_rebuild",
  {
    title: "规划小说状态重建",
    description: "只读计算从旧章开始的受影响章节、可信历史覆盖与确定性 plan fingerprint；不会修改正文或状态。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId }) => {
    try { return structuredResult(await planNovelStateRebuild(projectRoot, { targetChapterId })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_state_rebuild_status",
  {
    title: "读取小说状态谱系与重建状态",
    description: "只读返回公开 head、shadow rebuild cursor、历史闭包健康度和未完成 state operation；recoveryRequired 时按 nextTools 调用 novel_recover_writing_state，禁止覆盖分叉。",
    inputSchema: { projectRoot: novelAgentProjectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await getNovelStateRebuildStatus(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "probe_novel_chapter_consistency",
  {
    title: "探测小说章节机械一致性",
    description: "写后只读探针：核对正文身份、状态提交、required cast、声口/外形 Authority、硬正典禁词、知情边界候选、身体/关系/时间线/伏笔生命周期。外形只扫描 owner 明确登记的矛盾词；启发式命中不冒充文学质量裁决。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      targetChapterId: z.string().min(1),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetChapterId, workflowMode }) => {
    try { return structuredResult(await probeNovelChapterConsistency(projectRoot, { targetChapterId, workflowMode })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "build_novel_context_pack",
  {
    title: "组装可追溯小说上下文包",
    description: "V1兼容按章节/搜索组正文；提供taskType+targetChapterId时启用2.0，formal 不可裁剪硬正典、任务、目标角色基础卡/声口/外形/动态状态/知情以及时态关键记忆，再用余量加入截止章前正文。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      query: z.string().trim().min(2).max(200).optional(),
      chapterIds: z.array(z.string().min(1)).max(50).optional(),
      cutoffChapterId: z.string().min(1).optional(),
      maxCharacters: z.number().int().min(256).max(200_000).default(12_000),
      maxSearchHits: z.number().int().min(1).max(50).default(20),
      taskType: z.enum(["continue_chapter", "revise_chapter", "review_chapter"]).optional(),
      targetChapterId: z.string().min(1).optional(),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal")
        .describe("formal 要求 locked 基线与完整 required cast；provisional 隔离演练必须显式 rehearsal"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query, chapterIds, cutoffChapterId, maxCharacters, maxSearchHits, taskType, targetChapterId, characterIds, workflowMode }) => {
    try {
      return structuredResult(await buildNovelContextPack(projectRoot, {
        query,
        chapterIds,
        cutoffChapterId,
        maxCharacters,
        maxSearchHits,
        taskType,
        targetChapterId,
        characterIds,
        workflowMode,
      }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "prepare_novel_chapter_write",
  {
    title: "一键准备受管小说写章",
    description: "陌生 AI 推荐唯一写章入口：一次完成 locked/cast 检查、Context Pack 2.0、preflight 与章级写租约；返回正文保存所需的完整 aiWriteContext 和 partial nextTools。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      taskType: z.enum(["continue_chapter", "revise_chapter"]).default("continue_chapter"),
      targetChapterId: z.string().min(1),
      query: z.string().trim().min(2).max(200).optional(),
      chapterIds: z.array(z.string().min(1)).max(50).optional(),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
      maxCharacters: z.number().int().min(256).max(200_000).default(12_000),
      maxSearchHits: z.number().int().min(1).max(50).default(20),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
      attribution: novelActorAttributionSchema,
      ttlSeconds: z.number().int().min(60).max(1_800).default(900),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return structuredResult(await prepareNovelChapterWrite(projectRoot, input)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "preflight_novel_chapter_write",
  {
    title: "预检AI小说写章身份",
    description: "重建Context Pack 2.0并检查目标章、上一章状态commit、正文manifest、writing-state与硬正典冲突；返回可绑定novel_save_chapter的稳定preflightId。",
    inputSchema: {
      projectRoot: novelAgentProjectRootSchema,
      taskType: z.enum(["continue_chapter", "revise_chapter"]).default("continue_chapter"),
      targetChapterId: z.string().min(1),
      contextPackFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      query: z.string().trim().min(2).max(200).optional(),
      chapterIds: z.array(z.string().min(1)).max(50).optional(),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
      maxCharacters: z.number().int().min(256).max(200_000).default(12_000),
      maxSearchHits: z.number().int().min(1).max(50).default(20),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal")
        .describe("正式写作使用 formal；未锁版隔离演练必须显式 rehearsal"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, taskType, targetChapterId, contextPackFingerprint, query, chapterIds, characterIds, maxCharacters, maxSearchHits, workflowMode }) => {
    try {
      return structuredResult(await preflightNovelChapterWrite(projectRoot, {
        taskType,
        targetChapterId,
        contextPackFingerprint,
        query,
        chapterIds,
        characterIds,
        maxCharacters,
        maxSearchHits,
        workflowMode,
      }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "import_story_file",
  {
    title: "导入小说或剧本原文",
    description: "从本地 TXT、Markdown 或 DOCX 提取文本快照并稳定拆章；不移动或修改原文件。",
    inputSchema: { projectRoot: projectRootSchema, filePath: z.string().min(1).describe("原文文件绝对路径"), title: z.string().max(200).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, filePath, title }) => {
    try { const result = await importStoryFile(projectRoot, filePath, title); return textResult({ source: result.source, chapters: result.chapters, warnings: result.warnings }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_story_sources",
  {
    title: "列出原文来源",
    description: "列出项目已导入的原文快照、格式、哈希、字数和版本。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => { try { return textResult(await listStorySources(projectRoot)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "list_story_chapters",
  {
    title: "列出原文章节",
    description: "列出章节元数据和本地快照路径，不返回整本原文。",
    inputSchema: { projectRoot: projectRootSchema, sourceId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, sourceId }) => { try { return textResult(await listStoryChapters(projectRoot, sourceId)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "read_story_chapter",
  {
    title: "读取一个原文章节",
    description: "读取指定章节的完整文本快照，单章导入时默认控制在约 1.2 万字。",
    inputSchema: { projectRoot: projectRootSchema, chapterId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, chapterId }) => { try { return textResult(await readStoryChapter(projectRoot, chapterId)); } catch (error) { return toolError(error); } },
);

const storyStatusSchema = z.enum(["draft", "confirmed", "deprecated"]);
registrar.registerTool(
  "list_story_events",
  {
    title: "列出故事事件图",
    description: "读取事件、确认状态、章节、生产节点关联和事件依赖。",
    inputSchema: { projectRoot: projectRootSchema, chapterId: z.string().optional(), itemId: z.string().optional(), status: storyStatusSchema.optional(), includeOrphans: z.boolean().default(true), limit: z.number().int().min(1).max(500).default(200), cursor: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...options }) => {
    try {
      // P27（MCP 审查 F4）：查询有界——默认 200 条 offset 游标分页，防巨型响应。
      const limit = Math.max(1, Math.min(Number(options.limit ?? 200) || 200, 500));
      const offset = options.cursor ? Number.parseInt(String(options.cursor), 10) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("cursor 无效。");
      const all = await listStoryEvents(projectRoot, options);
      const events = all.slice(offset, offset + limit);
      return structuredResult({
        events,
        truncated: offset + limit < all.length,
        ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "upsert_story_event",
  {
    title: "写入故事事件",
    description: "创建或更新章节事件。只有 confirmed 事件会进入生产上下文；更新可用 expectedRevision 防止并发覆盖。",
    inputSchema: { projectRoot: projectRootSchema, id: z.string().optional(), chapterId: z.string().min(1), order: z.number().int().min(1).optional(), title: z.string().min(1).max(180), description: z.string().max(20000), sourceExcerpt: z.string().max(8000).optional(), characters: z.array(z.string()).max(100).optional(), locations: z.array(z.string()).max(100).optional(), props: z.array(z.string()).max(100).optional(), tags: z.array(z.string()).max(100).optional(), episode: z.number().int().min(1).optional(), unit: z.number().int().min(1).optional(), itemIds: z.array(z.string()).max(100).optional(), dependencyIds: z.array(z.string()).max(100).optional(), status: storyStatusSchema.default("draft"), expectedRevision: z.number().int().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertStoryEvent(projectRoot, input, "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "connect_story_events",
  {
    title: "连接故事事件依赖",
    description: "建立 source → target 事件依赖，拒绝自连接和不存在端点。",
    inputSchema: { projectRoot: projectRootSchema, sourceEventId: z.string().min(1), targetEventId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, sourceEventId, targetEventId }) => { try { return textResult(await connectStoryEvents(projectRoot, sourceEventId, targetEventId, "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "build_story_context",
  {
    title: "生成生产节点故事上下文",
    description: "为一个真实生产节点组合 confirmed 事件、依赖事件、原文证据、硬锁和项目记忆；草稿事件不会进入。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId }) => { try { return textResult(await buildStoryContext(projectRoot, itemId)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "import_story_text",
  {
    title: "导入粘贴小说文本",
    description: "把小说或章节文本真实写入项目故事快照并稳定拆章；不会伪造生产单元。",
    inputSchema: { projectRoot: projectRootSchema, title: z.string().min(1).max(200), content: z.string().min(1).max(10_000_000), kind: z.enum(["text", "markdown"]).default("text") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await importStoryText(projectRoot, input)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "get_adaptation_workspace",
  {
    title: "读取小说自动改编工作区",
    description: "读取事实、剧情节拍、精简/拆分方案、15秒单元、镜头上游引用和当前修订；不返回整本原文。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...options }) => {
    try {
      // P27（MCP 审查 F4）：工作区集合有界（facts≤500/beats≤300，与提案上限对齐），超额给明确截断标记。
      const workspace = await getAdaptationWorkspace(projectRoot) as unknown as Record<string, unknown>;
      const capCollection = (key: string, cap: number): void => {
        const collection = workspace[key];
        if (Array.isArray(collection) && collection.length > cap) {
          workspace[key] = collection.slice(0, cap);
          workspace[`${key}Truncated`] = true;
          workspace[`${key}Total`] = collection.length;
        }
      };
      capCollection("facts", 500);
      capCollection("beats", 300);
      return structuredResult(workspace);
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "create_novel_analysis_task",
  {
    title: "创建可替换模型的小说分析任务",
    description: "为 Codex 或外部模型生成只含真实章节路径、哈希、约束和输出契约的任务包；模型结果不会直接写入事实层。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), expectedRevision: z.number().int().min(0), providerId: z.string().min(1).max(120).default("codex"), providerKind: z.enum(["codex", "external"]).default("codex"), chapterIds: z.array(z.string().min(1)).max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, ...payload }) => { try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "create_novel_analysis_task", payload } })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "submit_novel_analysis_proposal",
  {
    title: "提交模型事实与节拍提案",
    description: "验证原文字符区间、章节修订和事实引用后写入人工确认队列；不直接修改事实、节拍或分镜。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), taskId: z.string().min(1), expectedRevision: z.number().int().min(0), executionId: z.string().min(1).max(200).optional(), expectedExecutionFence: z.number().int().min(0).optional(), facts: z.array(novelFactProposalSchema).max(500), beats: z.array(narrativeBeatProposalSchema).max(300) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, ...payload }) => { try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "submit_novel_analysis_proposal", payload } })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "list_novel_analysis_reviews",
  {
    title: "读取模型分析人工确认队列",
    description: "列出待确认、已接受或已拒绝的模型事实/节拍提案及原文证据问题。",
    inputSchema: { projectRoot: projectRootSchema, status: z.enum(["pending", "accepted", "rejected"]).optional(), taskId: z.string().min(1).optional(), limit: z.number().int().min(1).max(500).default(100), cursor: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, status, taskId, ...options }) => {
    try {
      // P27（MCP 审查 F4）：查询有界——默认 100 条 offset 游标分页。
      const limit = Math.max(1, Math.min(Number(options.limit ?? 100) || 100, 500));
      const offset = options.cursor ? Number.parseInt(String(options.cursor), 10) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("cursor 无效。");
      const all = await listNovelAnalysisReviews(projectRoot, { status, taskId });
      const reviews = all.slice(offset, offset + limit);
      return structuredResult({
        reviews,
        truncated: offset + limit < all.length,
        ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "review_novel_analysis_item",
  {
    title: "接受或拒绝模型分析提案",
    description: "只有证据校验通过的提案才能接受；节拍必须等待引用事实先通过。决定写入追加审计并强制双重修订检查。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), reviewId: z.string().min(1), decision: z.enum(["accepted", "rejected"]), expectedRevision: z.number().int().min(0), reviewExpectedRevision: z.number().int().positive(), note: z.string().max(4_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, ...payload }) => { try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "review_novel_analysis_item", payload } })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "review_novel_analysis_batch",
  {
    title: "批量审核模型分析提案",
    description: "在一个修订事务中接受或拒绝最多 200 条提案；核心自动先处理事实再处理节拍，任一证据、引用或修订失败则整批不落盘。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), expectedRevision: z.number().int().min(0), decisions: z.array(z.object({ reviewId: z.string().min(1), decision: z.enum(["accepted", "rejected"]), reviewExpectedRevision: z.number().int().positive(), note: z.string().max(4_000).optional() })).min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, expectedRevision, decisions }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "review_novel_analysis_batch", payload: { expectedRevision, decisions } } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_analysis_providers",
  {
    title: "读取小说分析模型配置",
    description: "读取项目级 OpenAI 兼容/本地模型配置、修订和默认 Provider；只返回环境变量名，不返回密钥值。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => { try { return structuredResult(await getNovelAnalysisProviderSettings(projectRoot)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "upsert_novel_analysis_provider",
  {
    title: "保存小说分析模型配置",
    description: "通过命令账本新增或更新 Provider。密钥只能使用环境变量名；发送小说正文与访问本机/私网均须显式授权。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), expectedRevision: z.number().int().min(0), provider: novelAnalysisProviderSchema, setAsDefault: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, expectedRevision, provider, setAsDefault }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "upsert_novel_analysis_provider", payload: { expectedRevision, provider, setAsDefault } } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "probe_novel_analysis_provider",
  {
    title: "探测小说分析模型服务",
    description: "读取 OpenAI 兼容 /models 或测试本地模拟 Provider；拒绝重定向和未授权私网，不发送小说正文。",
    inputSchema: { projectRoot: projectRootSchema, providerId: z.string().min(1).max(120) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ projectRoot, providerId }) => { try { return structuredResult(await probeNovelAnalysisProvider(projectRoot, providerId)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "plan_novel_analysis_run",
  {
    title: "规划长篇小说模型分析运行",
    description: "按 Provider 输入上限和章节顺序创建可恢复批次；超长单章按绝对字符区间安全分段，不跨来源混批。只落任务包，不调用模型。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), expectedRevision: z.number().int().min(0), providerId: z.string().min(1).max(120), targetCharacters: z.number().int().min(1_000).max(2_000_000).optional(), maxChaptersPerBatch: z.number().int().min(1).max(100).optional(), sourceId: z.string().min(1).optional(), chapterIds: z.array(z.string().min(1)).max(5_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, ...payload }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "plan_novel_analysis_run", payload } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_analysis_runs",
  {
    title: "读取长篇小说分析运行进度",
    description: "从持久化任务状态派生批次进度、下一可执行批次和阻塞原因；不维护第二份队列状态。",
    inputSchema: { projectRoot: projectRootSchema, runId: z.string().min(1).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, runId }) => {
    try { return structuredResult(runId ? await getNovelAnalysisRunProgress(projectRoot, runId) : { runs: await listNovelAnalysisRunProgress(projectRoot) }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_novel_analysis_execution_recovery",
  {
    title: "读取小说分析执行恢复状态",
    description: "物理零写列出 lease 已过期或已隔离的 analysis execution、fence、request hash 与 dispatch checkpoint。只允许人工对账；不会重 POST、不会自动 failed、不会自动创建 replacement。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return structuredResult(await getNovelAnalysisExecutionRecoveryStatus(projectRoot)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "execute_next_novel_analysis_run_task",
  {
    title: "执行长篇小说分析下一批",
    description: "只执行运行中首个已解锁批次。前批未人工确认、失败或回执不明时拒绝推进，避免并发或重复付费提交。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), runId: z.string().min(1), expectedRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ projectRoot, requestId, idempotencyKey, runId, expectedRevision }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "execute_next_novel_analysis_run_task", payload: { runId, expectedRevision } } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "replace_novel_analysis_run_task",
  {
    title: "显式替换失败的长篇分析批次",
    description: "为 failed 或已人工对账确认无远端结果的 submission_unknown 批次创建新尝试；旧任务、错误和审计链全部保留，绝不原地重置。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), runId: z.string().min(1), batchIndex: z.number().int().positive(), expectedRevision: z.number().int().min(0), reason: z.string().trim().min(3).max(4_000), confirmNoRemoteResult: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, ...payload }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "replace_novel_analysis_run_task", payload } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "execute_novel_analysis_task",
  {
    title: "执行小说模型分析任务",
    description: "通过幂等命令账本读取真实章节并调用任务绑定的 Provider。模型 JSON 经核心 Schema、哈希和字符区间校验后只进入人工复核队列；回执不明时禁止自动重提。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), taskId: z.string().min(1), providerId: z.string().min(1).max(120), expectedRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ projectRoot, requestId, idempotencyKey, taskId, providerId, expectedRevision }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "execute_novel_analysis_task", payload: { taskId, providerId, expectedRevision } } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "analyze_novel_chapters",
  {
    title: "分析小说事实与剧情节拍",
    description: "从真实章节快照确定性提取可追溯事实和剧情节拍；expectedRevision 防止覆盖其他窗口修改。",
    inputSchema: { projectRoot: projectRootSchema, expectedRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, expectedRevision }) => { try { return structuredResult(await analyzeNovelChapters(projectRoot, { expectedRevision })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "upsert_novel_fact",
  {
    title: "局部保存小说事实",
    description: "创建或更新一条带原文来源片段和证据状态的小说事实；更新现有事实必须携带 expectedRevision。",
    inputSchema: { projectRoot: projectRootSchema, ...novelFactInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertNovelFact(projectRoot, input)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "upsert_narrative_beat",
  {
    title: "局部保存剧情节拍",
    description: "创建或更新一个可视化剧情节拍，不重写无关节拍；更新现有节拍必须携带 expectedRevision。",
    inputSchema: { projectRoot: projectRootSchema, ...narrativeBeatInputSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertNarrativeBeat(projectRoot, input)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "generate_adaptation_plans",
  {
    title: "生成精简与拆分改编方案",
    description: "根据当前事实和节拍同时生成精简/拆分方案；每个15秒单元最多6镜、累计不超过15秒。",
    inputSchema: { projectRoot: projectRootSchema, expectedRevision: z.number().int().min(0), episode: z.number().int().positive().default(1), startUnit: z.number().int().positive().default(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return structuredResult(await generateAdaptationPlans(projectRoot, input)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "validate_adaptation_plan",
  {
    title: "校验小说改编方案",
    description: "检查15秒/6镜、对白速率、来源证据、上游修订和硬锁禁项；主观导演判断只返回警告。",
    inputSchema: { projectRoot: projectRootSchema, planId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, planId }) => { try { const workspace = await getAdaptationWorkspace(projectRoot); const plan = workspace.plans.find((candidate) => candidate.id === planId); if (!plan) throw new Error(`找不到改编计划：${planId}`); return structuredResult(await validateAdaptationPlan(projectRoot, plan, workspace)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "analyze_adaptation_impact",
  {
    title: "分析小说改编局部影响",
    description: "在修改事实或节拍后，返回受影响的节拍、方案、15秒单元、镜头和生产节点，不执行写入。",
    inputSchema: { projectRoot: projectRootSchema, factIds: z.array(z.string().min(1)).max(200).optional(), beatIds: z.array(z.string().min(1)).max(200).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, factIds, beatIds }) => { try { return structuredResult(await analyzeAdaptationChangeImpact(projectRoot, { factIds, beatIds })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "regenerate_adaptation_scope",
  {
    title: "只重生成受影响的小说分镜单元",
    description: "按事实/节拍变化只重建指定方案中受影响的单元，保留其他单元原对象与镜头；物化方案会回到待应用状态。",
    inputSchema: { projectRoot: projectRootSchema, planId: z.string().min(1), expectedRevision: z.number().int().min(0), factIds: z.array(z.string().min(1)).max(200).optional(), beatIds: z.array(z.string().min(1)).max(200).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return structuredResult(await regenerateAdaptationScope(projectRoot, input)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "select_adaptation_plan",
  {
    title: "选定小说改编方案",
    description: "在精简或拆分方案中选定一个待物化方案，不创建文件。",
    inputSchema: { projectRoot: projectRootSchema, planId: z.string().min(1), expectedRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, planId, expectedRevision }) => { try { return structuredResult(await selectAdaptationPlan(projectRoot, planId, expectedRevision)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "materialize_adaptation_plan",
  {
    title: "物化真实15秒单元与草稿镜头",
    description: "把已选方案写成项目内真实单元文档并登记现有正式分镜表；自动镜头始终为 draft，不能绕过人工确认。",
    inputSchema: { projectRoot: projectRootSchema, expectedRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, expectedRevision }) => { try { return structuredResult(await materializeSelectedAdaptationPlan(projectRoot, { expectedRevision })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "export_adaptation",
  {
    title: "导出小说改编JSON或Markdown",
    description: "把工作区或指定方案导出到项目主根/允许输出根中的全新版本路径；拒绝覆盖现有文件。",
    inputSchema: { projectRoot: projectRootSchema, format: z.enum(["json", "markdown"]), outputPath: z.string().min(1), planId: z.string().min(1).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return structuredResult(await exportAdaptation(projectRoot, input)); } catch (error) { return toolError(error); } },
);

const existingProductionRecoveryContractSchema = z.object({
  itemId: z.string().min(1),
  shotItemId: z.string().min(1).optional(),
  order: z.number().int().min(1).max(6),
  durationSeconds: z.number().positive().max(15.001),
  shotSize: z.string().trim().min(1).max(200),
  cameraMovement: z.string().trim().min(1).max(500),
  cameraAngle: z.string().max(500).optional(),
  lens: z.string().max(200).optional(),
  composition: z.string().max(2_000).optional(),
  staging: z.string().max(2_000).optional(),
  action: z.string().trim().min(1).max(8_000),
  expression: z.string().max(1_000).optional(),
  emotion: z.string().max(1_000).optional(),
  eyeline: z.string().max(1_000).optional(),
  screenDirection: z.string().max(1_000).optional(),
  axisSide: z.string().max(1_000).optional(),
  dialogue: z.string().max(8_000).optional(),
  narration: z.string().max(8_000).optional(),
  ambience: z.string().max(4_000).optional(),
  soundEffects: z.array(z.string().max(1_000)).max(100).optional(),
  continuityBefore: z.string().max(4_000).optional(),
  continuityAfter: z.string().max(4_000).optional(),
  referenceNames: z.array(z.string().max(200)).max(100).optional(),
  firstFramePrompt: z.string().trim().min(1).max(30_000),
  endFramePrompt: z.string().trim().min(1).max(30_000),
  videoPrompt: z.string().trim().min(1).max(30_000),
  referencePaths: z.array(z.string().min(1)).max(120).optional(),
  referenceArtifactIds: z.array(z.string().min(1)).max(120).optional(),
  directorIntent: z.string().max(2_000).optional(),
  emotionalIntent: z.string().max(2_000).optional(),
  continuityNotes: z.array(z.string().max(1_000)).max(100).optional(),
});

const existingProductionRecoveryInputSchema = {
  projectRoot: projectRootSchema,
  itemIds: z.array(z.string().min(1)).min(1).max(20),
  allowedTargets: z.array(z.enum(["image", "video_continuation"])).min(1).max(2),
  contracts: z.array(existingProductionRecoveryContractSchema).min(1).max(120),
  note: z.string().max(8_000).optional(),
};

registrar.registerTool(
  "preview_existing_production_recovery",
  {
    title: "预检既有制作包接管",
    description: "只读冻结 filesystem 既有制作包的目标节点、正式合同、00_信息.md 和参考文件哈希；不伪造历史阶段，不创建侧车。",
    inputSchema: existingProductionRecoveryInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return structuredResult(await previewExistingProductionRecovery(projectRoot, input)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "commit_existing_production_recovery",
  {
    title: "确认既有制作包接管",
    description: "使用同一 scope/合同和 previewId 写入内容寻址 baseline；只授权列出的 image 或 video_continuation，production stages 保持原状。",
    inputSchema: {
      ...existingProductionRecoveryInputSchema,
      previewId: z.string().regex(/^[a-f0-9]{64}$/),
      expectedWorkflowRevision: z.number().int().min(0),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return structuredResult(await commitExistingProductionRecovery(projectRoot, input, "codex")); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_production_workflow",
  {
    title: "读取内容生产状态机",
    description: "读取原文→章节→事件→骨架→改编→分集→导演规划→视觉圣经→资产→分镜→首尾帧→视频→剪辑→总验收→发布的 15 阶段状态，并实时核验文件、哈希、引用、验收和发布回执证据。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => { try { return structuredResult(await getProductionWorkflow(projectRoot, { includeEvidenceAudit: true })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "update_production_workflow_stage",
  {
    title: "更新内容生产阶段",
    description: "更新一个生产阶段及证据路径；标记 completed 时强制检查前置阶段和真实文件/索引门禁。",
    inputSchema: { projectRoot: projectRootSchema, stageId: z.enum(PRODUCTION_WORKFLOW_STAGE_IDS), status: z.enum(["not_started", "in_progress", "review", "blocked", "completed"]), note: z.string().max(20_000).optional(), evidencePaths: z.array(z.string()).max(200).optional(), itemIds: z.array(z.string()).max(1_000).optional(), inputRequirements: z.array(z.string()).max(300).optional(), outputRequirements: z.array(z.string()).max(300).optional(), acceptanceCriteria: z.array(z.string()).max(300).optional(), failurePaths: z.array(z.string()).max(300).optional(), nextActions: z.array(z.string()).max(300).optional(), expectedRevision: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return structuredResult(await updateProductionWorkflowStage(projectRoot, input, "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "list_creative_bibles",
  {
    title: "读取导演与视觉 Bible",
    description: "读取导演、视觉、角色和世界观 Bible 的规则、禁项、参考路径和修订。",
    inputSchema: { projectRoot: projectRootSchema, kind: z.enum(["director", "visual", "character", "world"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, kind }) => { try { return textResult(await listCreativeBibles(projectRoot, kind)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "upsert_creative_bible",
  {
    title: "保存导演或视觉 Bible",
    description: "创建或修订创作 Bible；参考路径必须真实存在，expectedRevision 防止覆盖其他窗口。",
    inputSchema: revisionedUpsertSchema({ projectRoot: projectRootSchema, ...creativeBibleInputShape }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertCreativeBible(projectRoot, input as Parameters<typeof upsertCreativeBible>[1], "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "get_storyboard",
  {
    title: "读取正式分镜表",
    description: "读取镜号、时长、景别、运镜、动作、对白、首尾帧和视频提示词；校验每单元最多 6 镜、累计不超过 15 秒。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().optional(), limit: z.number().int().min(1).max(1_000).default(200), promptMaxChars: z.number().int().min(200).max(30_000).default(4_000) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId, ...options }) => {
    try {
      // P27（MCP 审查 F4）：行数与长提示词双有界——防全量分镜表数百 MB 响应。
      const limit = Math.max(1, Math.min(Number(options.limit ?? 200) || 200, 1_000));
      const promptMaxChars = Math.max(200, Math.min(Number(options.promptMaxChars ?? 4_000) || 4_000, 30_000));
      const board = await getStoryboard(projectRoot, itemId);
      const clip = (value: unknown): unknown => (typeof value === "string" && value.length > promptMaxChars ? `${value.slice(0, promptMaxChars)}…` : value);
      const rows = board.rows.slice(0, limit).map((row) => {
        const trimmed: Record<string, unknown> = { ...row };
        for (const [key, value] of Object.entries(trimmed)) trimmed[key] = clip(value);
        return trimmed;
      });
      return structuredResult({
        ...board,
        rows,
        truncated: board.rows.length > limit,
        promptMaxChars,
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "upsert_storyboard_row",
  {
    title: "创建或安全修订正式分镜行",
    description: "新建时提交完整镜头合同；修订时携带 id 与 expectedRevision，可只提交变化字段，未提交的机位、焦段、构图、调度、连续性、证据和参考资产会原样保留。执行 6 镜/15 秒门禁。",
    inputSchema: { projectRoot: projectRootSchema, id: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional(), ...storyboardRowPatchSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertStoryboardRow(projectRoot, input, "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "analyze_change_impact",
  {
    title: "分析创作变更影响",
    description: "在修改角色、硬锁、故事事件、生产节点或 Bible 前，读取下游节点、任务、生成结果、正式分镜和剪辑片段；只分析不改状态。",
    inputSchema: { projectRoot: projectRootSchema, targetType: z.enum(["item", "story_event", "hard_lock", "bible"]), targetId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, targetType, targetId }) => { try { return structuredResult(await analyzeChangeImpact(projectRoot, { targetType, targetId })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "create_handoff",
  {
    title: "落盘 Codex 接续文件",
    description: "在 .aicanvas/handoffs 中创建可恢复 Markdown 接续文件，并返回路径与焦点摘要。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId }) => {
    try { const result = await createContinuationHandoff(projectRoot, { itemId }); return textResult({ path: result.path, generatedAt: result.snapshot.generatedAt, focusItem: result.snapshot.focusItem?.id, nextItemIds: result.snapshot.nextItems.map((item) => item.id) }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_canvas_state",
  {
    title: "读取画布语义层",
    description: "读取导演批注、自定义分组和人工关系线；正文总输出受 30000 字符预算限制。",
    inputSchema: {
      projectRoot: projectRootSchema,
      limit: z.number().int().min(1).max(100).default(50),
      maxBodyChars: z.number().int().min(0).max(4_000).default(800),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, limit, maxBodyChars }) => {
    try {
      const [state, history] = await Promise.all([getCanvasSemanticState(projectRoot), getCanvasHistoryInfo(projectRoot)]);
      let remaining = 30_000;
      const entities = state.entities.slice(0, limit).map((entity) => {
        const body = entity.body.slice(0, Math.max(0, Math.min(maxBodyChars, remaining)));
        remaining -= body.length;
        return { ...entity, body, bodyTruncated: body.length < entity.body.length };
      });
      return textResult({ revision: state.revision, updatedAt: state.updatedAt, history, totalEntities: state.entities.length, totalLinks: state.links.length, entities, links: state.links.slice(0, 200) });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "upsert_canvas_entity",
  {
    title: "创建或编辑画布批注与分组",
    description: "只写 .aicanvas/canvas.json，不修改任何素材文件。传 id 时编辑既有实体。",
    inputSchema: {
      projectRoot: projectRootSchema,
      id: z.string().min(1).optional(),
      kind: z.enum(["note", "group"]),
      title: z.string().min(1).max(120),
      body: z.string().max(20_000).default(""),
      color: z.enum(["gold", "blue", "green", "red", "purple", "gray"]).default("gold"),
      x: z.number().finite().default(0),
      y: z.number().finite().default(0),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      memberIds: z.array(z.string().min(1)).max(1_000).optional(),
      memberOffsets: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, id, kind, title, body, color, x, y, width, height, memberIds, memberOffsets }) => {
    try {
      const result = await upsertCanvasEntity(projectRoot, { id, kind, title, body, color, position: { x, y }, width, height, memberIds, memberOffsets }, "codex");
      return textResult({ revision: result.state.revision, entity: result.entity });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "delete_canvas_entity",
  {
    title: "删除画布批注或分组",
    description: "删除自定义画布实体及其人工关系线；不会删除生产节点或素材文件。",
    inputSchema: { projectRoot: projectRootSchema, entityId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ projectRoot, entityId }) => {
    try { const state = await deleteCanvasEntity(projectRoot, entityId, "codex"); return textResult({ revision: state.revision, deleted: entityId }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "upsert_canvas_link",
  {
    title: "创建或编辑画布关系线",
    description: "连接生产节点、批注或分组，支持连续性、参考、依赖和说明关系。",
    inputSchema: {
      projectRoot: projectRootSchema,
      id: z.string().min(1).optional(),
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
      kind: z.enum(["continuity", "reference", "dependency", "comment"]).default("comment"),
      label: z.string().max(160).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, id, sourceId, targetId, kind, label }) => {
    try { const result = await upsertCanvasLink(projectRoot, { id, sourceId, targetId, kind, label }, "codex"); return textResult({ revision: result.state.revision, link: result.link }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "delete_canvas_link",
  {
    title: "删除画布关系线",
    description: "只删除人工关系线，不修改节点、状态或素材文件。",
    inputSchema: { projectRoot: projectRootSchema, linkId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ projectRoot, linkId }) => {
    try { const state = await deleteCanvasLink(projectRoot, linkId, "codex"); return textResult({ revision: state.revision, deleted: linkId }); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "undo_canvas",
  {
    title: "撤销画布操作",
    description: "撤销最近一次批注、分组、位置或人工关系线变更；历史跨应用重启保留。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return textResult(await undoCanvasSemanticState(projectRoot, "codex")); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "redo_canvas",
  {
    title: "重做画布操作",
    description: "重做最近一次已撤销的画布语义变更。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try { return textResult(await redoCanvasSemanticState(projectRoot, "codex")); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_next_task",
  {
    title: "获取下一生产任务",
    description: "按返工、机械验收、视觉验收、首尾帧和视频优先级返回待办节点。",
    inputSchema: {
      projectRoot: projectRootSchema,
      episode: z.number().int().positive().optional(),
      itemType: z.enum(["unit", "shot"]).default("unit"),
      limit: z.number().int().min(1).max(20).default(1),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, episode, itemType, limit }) => {
    try {
      const items = await getNextTask(projectRoot, { episode, itemType, limit });
      return textResult(items.map(({ id, title, episode: itemEpisode, unit, shot, status, stage, priority, infoPath, nextAction, failureReason, hardLockIds, sourcePaths, thumbnailPath, dependencies }) => ({
        id,
        title,
        episode: itemEpisode,
        unit,
        shot,
        status,
        stage,
        priority,
        infoPath,
        nextAction,
        failureReason,
        hardLockIds,
        sourcePaths: sourcePaths.slice(0, 6),
        sourcePathCount: sourcePaths.length,
        thumbnailPath,
        dependencies,
      })));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "get_review_queue",
  {
    title: "读取导演验收队列",
    description: "读取待视觉验收、待视频验收和返工节点及其真实版本路径，不返回媒体数据。",
    inputSchema: { projectRoot: projectRootSchema, episode: z.number().int().positive().optional(), includeResolved: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, episode, includeResolved, limit }) => {
    try {
      const queue = (await getReviewQueue(projectRoot, { episode, includeResolved })).slice(0, limit);
      return textResult(queue.map(({ item, reviewType, artifacts, reviewSnapshot, latestReview, reviewRequirement }) => {
        const visibleArtifacts = [...artifacts]
          .sort((a, b) => {
            const rank = (artifact: typeof a) => {
              const current = artifact.authoritative && !artifact.deprecated;
              const requiredKind = reviewType === "image" ? ["raw-image", "labeled-image"].includes(artifact.kind) : ["video", "raw-image", "labeled-image"].includes(artifact.kind);
              if (current && requiredKind) return 0;
              if (current) return 1;
              if (!artifact.deprecated) return 2;
              return 3;
            };
            return rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.variant.localeCompare(b.variant) || b.path.localeCompare(a.path);
          })
          .slice(0, 20);
        return {
          item: { id: item.id, parentId: item.parentId, type: item.type, title: item.title, episode: item.episode, unit: item.unit, shot: item.shot, status: item.status, nextAction: item.nextAction, hardLockIds: item.hardLockIds, fusionStoryboard: item.fusionStoryboard },
          reviewType,
          artifactTotal: artifacts.length,
          artifactsTruncated: artifacts.length > visibleArtifacts.length,
          artifacts: visibleArtifacts.map((artifact) => ({ id: artifact.id, path: artifact.path, kind: artifact.kind, variant: artifact.variant, versionLabel: artifact.versionLabel, authoritative: artifact.authoritative, deprecated: artifact.deprecated, fusionStoryboardPanel: artifact.fusionStoryboardPanel, check: artifact.check })),
          reviewSnapshot: { scanId: reviewSnapshot.scanId, artifactHashes: Object.fromEntries(visibleArtifacts.filter((artifact) => reviewSnapshot.artifactHashes[artifact.id]).map((artifact) => [artifact.id, reviewSnapshot.artifactHashes[artifact.id]!])) },
          reviewRequirement,
          latestReview,
        };
      }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_reviews",
  {
    title: "读取视觉验收历史",
    description: "读取追加式导演验收记录，可按节点或结论筛选。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1).optional(), decision: z.enum(["pending", "pass", "rework"]).optional(), limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId, decision, limit }) => {
    try { return textResult(await listReviewRecords(projectRoot, { itemId, decision, limit })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "submit_review",
  {
    title: "提交视觉验收结论",
    description: "提交逐项视觉结论并按机械门禁推进为待视频、已完成、返工或待定；不能绕过必需文件。",
    inputSchema: {
      projectRoot: projectRootSchema,
      itemId: z.string().min(1),
      reviewType: z.enum(["image", "video"]),
      artifactIds: z.array(z.string().min(1)).min(1).max(20),
      expectedScanId: z.string().min(1),
      expectedArtifactHashes: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
      expectedRequirementId: z.string().regex(/^fusion-review-[a-f0-9]{64}$/u).optional(),
      decision: z.enum(["pending", "pass", "rework"]),
      criteria: z.array(z.object({ key: z.enum(REVIEW_CRITERIA_KEYS), result: z.enum(["pass", "fail", "na"]), note: z.string().max(2_000).optional() })).max(20),
      annotations: z.array(reviewAnnotationSchema).max(100).optional(),
      note: z.string().max(8_000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, reviewType, artifactIds, expectedScanId, expectedArtifactHashes, expectedRequirementId, decision, criteria, annotations, note }) => {
    try { return textResult(await submitReview(projectRoot, { itemId, reviewType, artifactIds, expectedScanId, expectedArtifactHashes, expectedRequirementId, decision, criteria, annotations, note }, "codex")); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_item",
  {
    title: "读取生产节点",
    description: "读取节点、提示词摘要、绝对文件路径和机械验收结果。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId }) => {
    try {
      return textResult(await getItem(projectRoot, itemId));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "claim_task",
  {
    title: "领取任务包",
    description: "按当前任务修订号领取租约；活跃租约不能被其他执行者覆盖，过期后可审计恢复。建议通过 execute_command 调用。",
    inputSchema: { projectRoot: projectRootSchema, taskId: z.string().min(1), agentId: z.string().min(2).max(120).default("codex"), leaseSeconds: z.number().int().min(30).max(3_600).default(900), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, taskId, agentId, leaseSeconds, expectedRevision }) => {
    try {
      return textResult(await claimTask(projectRoot, taskId, { agentId, leaseSeconds, expectedRevision }));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "heartbeat_task",
  {
    title: "续租任务包",
    description: "由当前领取者延长任务租约并递增修订；错误领取者、租约 ID、旧修订或过期租约都会被拒绝。",
    inputSchema: { projectRoot: projectRootSchema, taskId: z.string().min(1), leaseId: z.string().min(8), agentId: z.string().min(2).max(120).default("codex"), leaseSeconds: z.number().int().min(30).max(3_600).optional(), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, taskId, leaseId, agentId, leaseSeconds, expectedRevision }) => {
    try { return textResult(await heartbeatTask(projectRoot, taskId, { leaseId, agentId, leaseSeconds, expectedRevision })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "release_task",
  {
    title: "释放任务包",
    description: "当前领取者按修订号主动释放租约并将任务退回待领取；保留释放原因和审计记录。",
    inputSchema: { projectRoot: projectRootSchema, taskId: z.string().min(1), leaseId: z.string().min(8), agentId: z.string().min(2).max(120).default("codex"), expectedRevision: z.number().int().positive(), reason: z.string().max(2_000).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, taskId, leaseId, agentId, expectedRevision, reason }) => {
    try { return textResult(await releaseTask(projectRoot, taskId, { leaseId, agentId, expectedRevision, reason })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "cancel_task",
  {
    title: "取消未开始或过期任务",
    description: "只允许取消 ready 或租约已过期的 claimed 任务；活跃租约、待视觉验收和终态任务一律拒绝。必须锁定当前修订并填写真实原因。",
    inputSchema: { projectRoot: projectRootSchema, taskId: z.string().min(1), expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, taskId, expectedRevision, reason }) => {
    try { return textResult(await cancelTask(projectRoot, taskId, { expectedRevision, reason })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "create_task_pack",
  {
    title: "创建 Codex 任务包",
    description: "从指定节点或下一批候选创建不跨集的受控任务包。",
    inputSchema: {
      projectRoot: projectRootSchema,
      itemIds: z.array(z.string()).max(20).optional(),
      episode: z.number().int().positive().optional(),
      mode: z.enum(["observe", "collaborate", "autopilot"]).default("autopilot"),
      kind: z.enum(["image", "video"]).default("image"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemIds, episode, mode, kind }) => {
    try {
      return textResult(await createTaskPack(projectRoot, { itemIds, episode, mode, kind }));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "get_unit_timelines",
  {
    title: "读取 15 秒原镜头时间线",
    description: "按集读取 15 秒单元与原镜头父子关系、镜头顺序和时长约束；仅返回路径与短摘要。",
    inputSchema: {
      projectRoot: projectRootSchema,
      episode: z.number().int().positive().optional(),
      onlyWithShots: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, episode, onlyWithShots, limit }) => {
    try {
      const all = (await getUnitTimelines(projectRoot, episode)).filter((timeline) => !onlyWithShots || timeline.shots.length > 0);
      return textResult({
        total: all.length,
        invalid: all.filter((timeline) => !timeline.valid).length,
        timelines: all.slice(0, limit).map((timeline) => ({
          unitId: timeline.unitId,
          title: timeline.title,
          episode: timeline.episode,
          unit: timeline.unit,
          totalDurationSeconds: timeline.totalDurationSeconds,
          valid: timeline.valid,
          issues: timeline.issues,
          shots: timeline.shots.map(({ item, timing }) => ({
            id: item.id,
            title: item.title,
            shot: item.shot,
            status: item.status,
            infoPath: item.infoPath,
            thumbnailPath: item.thumbnailPath,
            order: timing.order,
            durationSeconds: timing.durationSeconds,
          })),
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "save_unit_timeline",
  {
    title: "保存原镜头顺序与时长",
    description: "保存单个 15 秒单元的镜头顺序和时长；镜头集合必须匹配真实扫描，最多 6 镜且累计不超过 15 秒。",
    inputSchema: {
      projectRoot: projectRootSchema,
      unitId: z.string().min(1),
      shots: z.array(z.object({ shotId: z.string().min(1), durationSeconds: z.number().positive(), note: z.string().max(1_000).optional() })).min(1).max(6),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, unitId, shots }) => {
    try {
      return textResult(await saveUnitTimeline(projectRoot, unitId, shots.map((shot, order) => ({ ...shot, order }))));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "create_shot_task_pack",
  {
    title: "创建原镜头任务包",
    description: "从同一 15 秒单元的有效时间线创建不跨单元的图片任务包。",
    inputSchema: {
      projectRoot: projectRootSchema,
      unitId: z.string().min(1),
      mode: z.enum(["observe", "collaborate", "autopilot"]).default("autopilot"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, unitId, mode }) => {
    try {
      return textResult(await createShotTaskPack(projectRoot, unitId, mode));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "register_artifact",
  {
    title: "登记新素材",
    description: "登记已落盘的新版本并重新扫描；不会创建、覆盖或删除媒体文件。",
    inputSchema: {
      projectRoot: projectRootSchema,
      itemId: z.string().min(1),
      artifactPath: z.string().min(1),
      kind: z.enum(["info", "prompt", "raw-image", "labeled-image", "video", "audio", "manifest", "other"]),
      variant: z.enum(["start", "end", "generic"]).default("generic"),
      note: z.string().max(2_000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, artifactPath, kind, variant, note }) => {
    try {
      return textResult(await registerArtifact(projectRoot, { itemId, artifactPath, kind, variant, note }));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "verify_item",
  {
    title: "验收生产节点",
    description: "重新扫描并检查文件存在、大小、图片解码、尺寸和 raw/labeled 配对。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId }) => {
    try {
      return textResult(await verifyItem(projectRoot, itemId));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "update_status",
  {
    title: "更新节点状态",
    description: "写入人工或 Codex 状态覆盖；机械验收失败时禁止标记已完成。",
    inputSchema: {
      projectRoot: projectRootSchema,
      itemId: z.string().min(1),
      status: z.enum(WORK_ITEM_STATUSES),
      note: z.string().max(4_000).optional(),
      authoritativePath: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, status, note, authoritativePath }) => {
    try {
      return textResult(await updateStatus(projectRoot, itemId, status, note, authoritativePath));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "finish_batch",
  {
    title: "结束自动化批次",
    description: "写入批次结果并暂停到视觉验收点。",
    inputSchema: {
      projectRoot: projectRootSchema,
      taskId: z.string().min(1),
      leaseId: z.string().min(8),
      agentId: z.string().min(2).max(120).default("codex"),
      expectedRevision: z.number().int().positive(),
      status: z.enum(["completed", "blocked"]).default("completed"),
      completedItemIds: z.array(z.string()).default([]),
      failedItemIds: z.array(z.string()).default([]),
      note: z.string().max(4_000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, taskId, leaseId, agentId, expectedRevision, status, completedItemIds, failedItemIds, note }) => {
    try {
      return textResult(await finishBatch(projectRoot, taskId, { leaseId, agentId, expectedRevision, status, completedItemIds, failedItemIds, note }));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "list_script_documents",
  {
    title: "列出分集制作文档",
    description: "列出真实 Markdown/TXT 制作文档、节点映射、修改时间和短摘要。",
    inputSchema: { projectRoot: projectRootSchema, episode: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, episode, limit }) => {
    try {
      const documents = (await listScriptDocuments(projectRoot)).filter((document) => episode === undefined || document.episode === episode);
      return textResult({ total: documents.length, documents: documents.slice(0, limit).map((document) => ({ ...document, excerpt: document.excerpt.slice(0, 400) })) });
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "read_script_document",
  {
    title: "读取分集制作文档",
    description: "读取单个真实 Markdown/TXT 文档；默认最多返回 30000 字符，防止巨型 MCP 输出。",
    inputSchema: { projectRoot: projectRootSchema, path: z.string().min(1), maxChars: z.number().int().min(1_000).max(120_000).default(30_000) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, path: filePath, maxChars }) => {
    try {
      const result = await readScriptDocument(projectRoot, filePath);
      return textResult({ ...result, content: result.content.slice(0, maxChars), truncated: result.content.length > maxChars, totalChars: result.content.length });
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "save_script_document",
  {
    title: "保存分集制作文档",
    description: "显式保存真实 Markdown/TXT，自动备份旧版本并使用修改时间阻止并发覆盖。",
    inputSchema: { projectRoot: projectRootSchema, path: z.string().min(1), content: z.string().max(2_097_152), expectedModifiedAt: z.string().optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, path: filePath, content, expectedModifiedAt }) => {
    try {
      return textResult(await saveScriptDocument(projectRoot, filePath, content, expectedModifiedAt));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "set_authoritative_artifact",
  {
    title: "选择权威素材版本",
    description: "按 raw/labeled、首尾帧或视频维度选择机械验收通过的权威版本，保留其他历史文件。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1), artifactId: z.string().min(1), note: z.string().max(2_000).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, artifactId, note }) => {
    try {
      return textResult(await setAuthoritativeArtifact(projectRoot, itemId, artifactId, note));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "promote_asset_to_hard_lock",
  {
    title: "提升资产为显式硬锁",
    description: "将机械验收通过的项目资产登记为显式权威硬锁；不移动、覆盖或删除原文件。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1), note: z.string().max(2_000).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, note }) => {
    try {
      return textResult(await promoteAssetToHardLock(projectRoot, itemId, note));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "list_asset_relations",
  {
    title: "读取资产衍生血缘",
    description: "读取素材或资产节点之间的 derived_from、variant_of 和 reference_of 关系与修订。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().optional(), artifactId: z.string().optional(), kind: z.enum(["derived_from", "variant_of", "reference_of"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId, artifactId, kind }) => { try { return textResult(await listAssetRelations(projectRoot, { itemId, artifactId, kind })); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "upsert_asset_relation",
  {
    title: "保存资产衍生关系",
    description: "建立父素材/节点到子素材/节点的衍生、版本或参考关系；验证真实 ID、拒绝自连接和衍生循环。",
    inputSchema: revisionedUpsertSchema({ projectRoot: projectRootSchema, ...assetRelationInputShape }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertAssetRelation(projectRoot, input as Parameters<typeof upsertAssetRelation>[1], "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "list_voice_identities",
  {
    title: "读取角色音色身份",
    description: "读取音色供应商标识、样本路径、语言、角色节点和硬锁绑定；不保存账号密钥。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => { try { return textResult(await listVoiceIdentities(projectRoot)); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "upsert_voice_identity",
  {
    title: "保存角色音色身份",
    description: "创建或修订角色音色、供应商 voice ID、真实样本路径和角色/硬锁绑定；修订号防止并发覆盖。",
    inputSchema: revisionedUpsertSchema({ projectRoot: projectRootSchema, ...voiceIdentityInputShape }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => { try { return textResult(await upsertVoiceIdentity(projectRoot, input as Parameters<typeof upsertVoiceIdentity>[1], "codex")); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "get_generation_settings",
  {
    title: "读取生成供应商配置",
    description: "返回图片/视频供应商、能力、站点或端点、凭据环境变量名称以及工作流哈希；不返回密钥值、Cookie 或大型工作流 JSON。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      const settings = sanitizeGenerationSettingsForMcp(await getGenerationSettings(projectRoot));
      return structuredResult({
        ...settings,
        providers: settings.providers.map((provider) => ({
          ...provider,
          workflow: provider.workflow ? {
            schemaVersion: provider.workflow.schemaVersion,
            name: provider.workflow.name,
            version: provider.workflow.version,
            format: provider.workflow.format,
            environment: provider.workflow.environment,
          } : undefined,
        })),
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_generation_provider",
  {
    title: "读取单个生成供应商",
    description: "按 ID 返回一个生成供应商的完整非机密配置，包括受 512 KiB 上限保护的工作流 JSON 和当前设置修订号；不返回密钥值或 Cookie。",
    inputSchema: { projectRoot: projectRootSchema, providerId: z.string().min(2).max(120) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, providerId }) => {
    try {
      const result = await getGenerationProvider(projectRoot, providerId);
      return structuredResult({ ...result, provider: sanitizeGenerationProviderForMcp(result.provider) });
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "upsert_generation_provider",
  {
    title: "新增或更新生成供应商",
    description: "通过配置修订号和幂等命令账本增量保存单个生成网站、HTTP 接口或本地工作流；保留其他供应商，只保存 apiKeyEnv 环境变量名，不保存密钥值。",
    inputSchema: { projectRoot: projectRootSchema, expectedRevision: z.number().int().min(0), provider: generationProviderUpsertSchema, setAsDefaultFor: z.enum(["image", "video"]).optional(), concurrency: z.number().int().min(1).max(8).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, ...input }) => {
    try { return structuredResult(await upsertGenerationProvider(projectRoot, input, "codex")); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_generation_jobs",
  {
    title: "列出生成队列",
    description: "返回可恢复生成任务的状态、脱敏远端观测、恢复动作和本地隔离/结果路径；不返回提示词全文、签名结果 URL 或图片数据。",
    inputSchema: { projectRoot: projectRootSchema, status: z.enum(["queued", "submitting", "submission_unknown", "waiting_external", "waiting_remote", "generating", "generation_unknown", "candidate_generated", "visual_rejected", "succeeded", "failed", "cancelled"]).optional(), limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, status, limit }) => {
    try {
      return textResult((await listGenerationJobs(projectRoot)).filter((job) => !status || job.status === status).slice(0, limit).map(generationSummary));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "list_publications",
  {
    title: "读取发布合同与回执",
    description: "列出输出路径预留、终态和机械验收回执；不返回发布预留令牌或媒体二进制。",
    inputSchema: { projectRoot: projectRootSchema, status: z.enum(["reserved", "registered", "cancelled", "failed"]).optional(), limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, status, limit }) => {
    try {
      const intents = (await listPublicationIntents(projectRoot, status)).slice(0, limit).map(({ reservationToken: _token, ...intent }) => intent);
      const receipts = (await listPublicationReceipts(projectRoot)).filter((receipt) => intents.some((intent) => intent.id === receipt.intentId)).slice(0, limit);
      return textResult({ intents, receipts });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "preflight_publication",
  {
    title: "预留新版本发布路径",
    description: "在写文件前分配不覆盖既有素材的新版本路径，并返回后续注册所需的意图、修订号和预留令牌。",
    inputSchema: { projectRoot: projectRootSchema, requestedPath: z.string().min(1), allowedRoot: z.string().min(1).optional(), kind: z.enum(PUBLICATION_KINDS), variant: z.enum(PUBLICATION_VARIANTS).optional(), context: publicationContextSchema, note: z.string().max(4_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("发布预留必须通过命令账本执行。")),
);

registrar.registerTool(
  "register_publication",
  {
    title: "登记发布结果",
    description: "对预留路径上的真实文件做锁外机械验收，再按意图修订、令牌、状态和强文件身份 CAS 生成唯一不可变回执；必须携带令牌和当前修订号，取消或文件漂移不会被旧校验覆盖。",
    inputSchema: { projectRoot: projectRootSchema, intentId: z.string().min(1), reservationToken: z.string().min(8), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("发布登记必须通过命令账本执行。")),
);

registrar.registerTool(
  "cancel_publication",
  {
    title: "取消发布意图",
    description: "在没有登记结果时关闭路径预留，保留审计记录；不会删除任何文件。",
    inputSchema: { projectRoot: projectRootSchema, intentId: z.string().min(1), reservationToken: z.string().min(8), reason: z.string().trim().min(3).max(4_000), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("发布取消必须通过命令账本执行。")),
);

registrar.registerTool(
  "fail_publication",
  {
    title: "终结失败发布意图",
    description: "记录生成或机械验收失败并关闭路径预留，保留失败原因和审计记录。",
    inputSchema: { projectRoot: projectRootSchema, intentId: z.string().min(1), reservationToken: z.string().min(8), reason: z.string().trim().min(3).max(4_000), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => toolError(new Error("发布失败登记必须通过命令账本执行。")),
);

registrar.registerTool(
  "enqueue_generation",
  {
    title: "加入生成队列",
    description: "为同一批生产节点创建新版本生成任务；第三季 15 秒单元必须传 fusionStoryboardPanel，按 2–6 格合同逐格生成；末帧续作必须传 continuationId。只约定新输出路径，不覆盖权威文件。",
    inputSchema: { projectRoot: projectRootSchema, itemIds: z.array(z.string()).min(1).max(20), kind: z.enum(["image", "video"]), providerId: z.string().optional(), taskId: z.string().optional(), prompt: z.string().max(30_000).optional(), continuation: z.object({ continuationId: z.string().min(8), firstFrameArtifactId: z.string().min(1).optional() }).optional(), fusionStoryboardPanel: z.object({ contractId: z.string().min(8).max(200), panelIndex: z.number().int().min(1).max(6) }).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemIds, kind, providerId, taskId, prompt, continuation, fusionStoryboardPanel }) => {
    try {
      return textResult((await enqueueGeneration(projectRoot, { itemIds, kind, providerId, taskId, prompt, continuation, fusionStoryboardPanel })).map(generationSummary));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "process_generation_queue",
  {
    title: "提交并轮询生成队列",
    description: "可用 jobId 定向恢复单个既有 externalTaskId、远端轮询或隔离下载，不会顺带提交其他 queued 任务；省略 jobId 时才处理整个项目队列。submission_unknown 不会自动重提。",
    inputSchema: { projectRoot: projectRootSchema, jobId: z.string().min(3).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, jobId }) => {
    try {
      const jobs = await processGenerationQueue(projectRoot, { jobId });
      const counts = jobs.reduce<Record<string, number>>((current, job) => ({ ...current, [job.status]: (current[job.status] ?? 0) + 1 }), {});
      return textResult({ processedJobId: jobId, counts, recent: jobs.filter((job) => !jobId || job.id === jobId).slice(0, 50).map(generationSummary) });
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "reconcile_http_generation_submission",
  {
    title: "对账 HTTP 提交不明任务",
    description: "仅对 http-json 的 submission_unknown 任务执行 revisioned found/not_found 回写。found 绑定同一 externalTaskId 后等待定向轮询；not_found 必须显式确认且先闭合 Publication。命令本身不发 POST、GET、轮询或下载。",
    inputSchema: { projectRoot: projectRootSchema, jobId: z.string().min(3), expectedRevision: z.number().int().positive(), reconciliation: httpSubmissionReconciliationSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, jobId, expectedRevision, reconciliation }) => {
    try { return structuredResult(await reconcileHttpGenerationSubmission(projectRoot, jobId, { expectedRevision, reconciliation })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_browser_generation_plan",
  {
    title: "读取 Codex 网页生成计划",
    description: "读取用户配置网站的导航地址、现有登录态要求、允许上传的本地路径、提示词、输出路径、提交/下载/回写检查点；不包含密钥或媒体数据。",
    inputSchema: { projectRoot: projectRootSchema, jobId: z.string().min(3) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, jobId }) => {
    try { return structuredResult(await getBrowserGenerationPlan(projectRoot, jobId)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_subagent_image_generation_plan",
  {
    title: "读取一图一子代理生图计划",
    description: "读取冻结提示词/参数/参考 SHA、唯一代理租约状态、调用 intent/receipt、隔离候选目录和 raw/labeled Publication bundle 身份。只返回文件路径与哈希，不返回图片二进制；generation_unknown 只能对账，主代理视觉 Review 仍是独立必经门禁。",
    inputSchema: { projectRoot: projectRootSchema, jobId: z.string().min(3) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, jobId }) => {
    try { return structuredResult(await getSubagentImageGenerationPlan(projectRoot, jobId)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "cancel_generation_job",
  {
    title: "取消生成任务",
    description: "取消尚未完成的生成任务。已提交远端时必须由供应商声明并配置真实取消接口；否则拒绝只改本地状态造成假取消。",
    inputSchema: { projectRoot: projectRootSchema, jobId: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectRoot, jobId }) => {
    try { return textResult(generationSummary(await cancelGenerationJob(projectRoot, jobId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "update_browser_generation_job",
  {
    title: "回写网页生成进度",
    description: "Codex 按执行面校验→预检→上传→提交意图→单次提交→下载顺序回写网页任务。配置执行面变更时，只能在 plan_ready/preflight_blocked 用 refresh_plan + expectedSettingsRevision 刷新同一 job/Publication，旧预检证据立即失效。登录、页面、模式、额度或付费授权未通过时用 preflight_blocked 保留同一 job 和结构化阻塞证据，严禁上传或提交。点击可能付费的提交按钮前必须先持久化 submit_intent；每次使用当前检查点 revision 做 CAS。",
    inputSchema: { projectRoot: projectRootSchema, jobId: z.string().min(3), expectedRevision: z.number().int().positive(), expectedSettingsRevision: z.number().int().positive().optional(), status: z.enum(["refresh_plan", "preflight_blocked", "preflight", "uploaded", "submit_intent", "submitted", "processing", "downloaded", "failed"]), externalTaskId: z.string().max(500).optional(), downloadedPath: z.string().optional(), error: z.string().max(8_000).optional(), note: z.string().max(4_000).optional(), preflightEvidence: browserPreflightEvidenceSchema.optional(), uploadEvidence: browserUploadEvidenceSchema.optional(), submissionReconciliation: browserSubmissionReconciliationSchema.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, jobId, expectedRevision, expectedSettingsRevision, status, externalTaskId, downloadedPath, error, note, preflightEvidence, uploadEvidence, submissionReconciliation }) => {
    try { return textResult(generationSummary(await updateBrowserGenerationJob(projectRoot, jobId, { expectedRevision, expectedSettingsRevision, status, externalTaskId, downloadedPath, error, note, preflightEvidence, uploadEvidence, submissionReconciliation }))); }
    catch (cause) { return toolError(cause); }
  },
);

registrar.registerTool(
  "update_subagent_image_generation_job",
  {
    title: "迁移并推进可归因的一图一子代理任务",
    description: "严格执行 migrate_plan/迁移未知态→claim→heartbeat→start_call→generated(仅隔离候选)→visual_accept 或 visual_rejected。所有租约写入绑定 leaseId+owner+fence；模型调用前必须持久化 runId/callId，未知调用禁止重试；只有视觉通过后才原子登记 raw/labeled 双 Publication 回执。",
    inputSchema: {
      projectRoot: projectRootSchema,
      jobId: z.string().min(3),
      expectedRevision: z.number().int().min(0),
      expectedSettingsRevision: z.number().int().positive().optional(),
      status: z.enum(["migrate_plan", "migrate_execution_state", "claim", "heartbeat", "takeover", "release", "start_call", "generated", "visual_accept", "visual_rejected", "reconcile_unknown", "failed"]),
      targetProviderId: z.string().min(2).max(120).optional(),
      agentTaskName: z.string().min(6).max(200).optional(),
      owner: z.string().min(6).max(200).optional(),
      agentRunId: z.string().min(1).max(200).optional(),
      runId: z.string().min(1).max(200).optional(),
      callId: z.string().min(1).max(200).optional(),
      leaseId: z.string().min(8).max(200).optional(),
      fence: z.number().int().positive().optional(),
      leaseSeconds: z.number().int().min(30).max(3_600).optional(),
      generatedPath: z.string().min(1).optional(),
      reviewer: z.string().min(6).max(200).optional(),
      reconciliationResult: z.enum(["not_invoked", "candidate_found"]).optional(),
      confirmNoInvocation: z.boolean().optional(),
      evidenceReference: z.string().min(1).max(200).optional(),
      error: z.string().max(8_000).optional(),
      note: z.string().max(4_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, jobId, ...input }) => {
    try { return textResult(generationSummary(await updateSubagentImageGenerationJob(projectRoot, jobId, input))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "probe_video_engine",
  {
    title: "检查本地视频引擎",
    description: "检查 FFmpeg/FFprobe 的可执行路径与版本；不启动渲染。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => textResult(await withEditor((editor) => editor.probeVideoEngine())),
);

registrar.registerTool(
  "list_edit_projects",
  {
    title: "列出本地剪辑工程",
    description: "列出项目侧车内的成片剪辑工程与轨道/片段摘要。",
    inputSchema: { projectRoot: projectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      return textResult((await withEditor((editor) => editor.listEditProjects(projectRoot))).map((project) => ({
        id: project.id,
        name: project.name,
        episode: project.episode,
        width: project.width,
        height: project.height,
        fps: project.fps,
        revision: project.revision,
        tracks: project.tracks.length,
        clips: project.tracks.reduce((sum, track) => sum + track.clips.length, 0),
        updatedAt: project.updatedAt,
      })));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_edit_project",
  {
    title: "读取剪辑工程",
    description: "读取单个剪辑工程的画幅、轨道、片段、裁切与时序数据；只返回路径和 JSON 元数据。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId }) => {
    try { return textResult(await withEditor((editor) => editor.getEditProject(projectRoot, editProjectId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "create_edit_project",
  {
    title: "创建本地剪辑工程",
    description: "按全项目或单集创建剪辑工程，可从权威视频/图片自动建立主画面轨道；不修改素材。",
    inputSchema: {
      projectRoot: projectRootSchema,
      name: z.string().max(120).optional(),
      episode: z.number().int().positive().optional(),
      width: z.number().int().min(256).max(7_680).default(1_080),
      height: z.number().int().min(256).max(7_680).default(1_920),
      fps: z.number().min(12).max(120).default(24),
      autoPopulate: z.boolean().default(true),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, name, episode, width, height, fps, autoPopulate }) => {
    try { return textResult(await withEditor((editor) => editor.createEditProject(projectRoot, { name, episode, width, height, fps, autoPopulate }))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "save_edit_project",
  {
    title: "保存本地剪辑工程",
    description: "保存完整剪辑 JSON；检查素材可读、时间参数、片段重叠和乐观修订号，不覆盖媒体文件。",
    inputSchema: { projectRoot: projectRootSchema, project: z.any(), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ projectRoot, project, expectedRevision }) => {
    try { return textResult(await withEditor((editor) => editor.saveEditProject(projectRoot, project as EditProject, expectedRevision, "codex"))); }
    catch (error) { return toolError(error); }
  },
);

const editCubicBezierSourceWindowSchema = z.object({
  x1: z.number().finite(), y1: z.number().finite(), x2: z.number().finite(), y2: z.number().finite(),
  sourceEasing: z.enum(["linear", "ease_in", "ease_out", "ease_in_out", "cubic_bezier"]),
  startX: z.number().finite(), endX: z.number().finite(),
  startFrame: z.number().int().optional(), endFrame: z.number().int().optional(), totalFrames: z.number().int().optional(),
});
const editKeyframeTransformSchema = z.object({
  positionX: z.number().finite(), positionY: z.number().finite(), scale: z.number().finite(), rotation: z.number().finite(),
});
const editKeyframeSourceTransformSchema = z.object({ start: editKeyframeTransformSchema, end: editKeyframeTransformSchema });
const editCubicBezierSchema = z.object({
  x1: z.number().finite(), y1: z.number().finite(), x2: z.number().finite(), y2: z.number().finite(),
  mode: z.enum(["unit", "derived_monotone"]).optional(),
  sourceWindow: editCubicBezierSourceWindowSchema.optional(),
}).superRefine((curve, context) => {
  const issue = editKeyframeCurveIssue("cubic_bezier", curve);
  if (issue) context.addIssue({ code: "custom", message: issue });
});
const editKeyframeSchema = z.object({
  id: z.string().min(1),
  timeSeconds: z.number().min(0),
  easing: z.enum(["linear", "ease_in", "ease_out", "ease_in_out", "hold", "cubic_bezier"]).optional(),
  bezier: editCubicBezierSchema.optional(),
  sourceTransform: editKeyframeSourceTransformSchema.optional(),
  positionX: z.number(),
  positionY: z.number(),
  scale: z.number().min(.02).max(4),
  rotation: z.number(),
}).superRefine((keyframe, context) => {
  const issue = editKeyframeCurveIssue(keyframe.easing, keyframe.bezier);
  if (issue) context.addIssue({ code: "custom", path: ["bezier"], message: issue });
  const sourceTransformIssue = editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
  if (sourceTransformIssue) context.addIssue({ code: "custom", path: ["sourceTransform"], message: sourceTransformIssue });
});
const editSmpteDissolveSchema = z.object({
  contract: z.literal("aicanvas.otio-transition.v1"),
  kind: z.literal("smpte_dissolve"),
  targetClipId: z.string().min(1),
  inOffsetFrames: z.number().int().positive(),
  outOffsetFrames: z.number().int().positive(),
});
const editClipPatchSchema = z.object({
  name: z.string().max(120).optional(), startSeconds: z.number().min(0).optional(), durationSeconds: z.number().positive().optional(), trimStartSeconds: z.number().min(0).optional(), playbackRate: z.number().min(.1).max(8).optional(), volume: z.number().min(0).max(4).optional(), opacity: z.number().min(0).max(1).optional(), muted: z.boolean().optional(),
  positionX: z.number().optional(), positionY: z.number().optional(), scale: z.number().min(.02).max(4).optional(), rotation: z.number().optional(), filter: z.enum(["none", "grayscale", "sepia", "warm", "cool", "vivid", "contrast", "blur"]).optional(), filterIntensity: z.number().min(0).max(2).optional(), keyframes: z.array(editKeyframeSchema).max(200).optional(),
  fadeInSeconds: z.number().min(0).optional(), fadeOutSeconds: z.number().min(0).optional(), transitionOut: z.enum(["cut", "fade", "smpte_dissolve"]).optional(), transitionDurationSeconds: z.number().positive().max(3).optional(), transition: editSmpteDissolveSchema.optional(), text: z.string().max(20_000).optional(), fontSize: z.number().min(12).max(200).optional(), fontColor: z.string().optional(), subtitleBackground: z.string().optional(), note: z.string().max(4_000).optional(),
});
const editOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_track"), kind: z.enum(["visual", "audio", "subtitle"]), name: z.string().max(120).optional() }),
  z.object({ type: z.literal("remove_track"), trackId: z.string().min(1) }),
  z.object({ type: z.literal("add_media_clip"), trackId: z.string().min(1), mediaId: z.string().optional(), artifactId: z.string().optional(), startSeconds: z.number().min(0) }),
  z.object({ type: z.literal("add_nested_timeline"), trackId: z.string().min(1), childEditProjectId: z.string().min(3), childExpectedRevision: z.number().int().positive(), startFrame: z.number().int().min(0), sourceStartFrame: z.number().int().min(0).optional(), sourceDurationFrames: z.number().int().positive().optional() }),
  z.object({ type: z.literal("refresh_nested_timeline"), clipId: z.string().min(1), childExpectedRevision: z.number().int().positive() }),
  z.object({ type: z.literal("add_subtitle"), trackId: z.string().min(1), startSeconds: z.number().min(0), durationSeconds: z.number().positive(), text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal("update_clip"), clipId: z.string().min(1), patch: editClipPatchSchema }),
  z.object({ type: z.literal("move_clip"), clipId: z.string().min(1), targetTrackId: z.string().min(1), startSeconds: z.number().min(0) }),
  z.object({ type: z.literal("split_clip"), clipId: z.string().min(1), timeSeconds: z.number().min(0) }),
  z.object({ type: z.literal("trim_to_playhead"), clipId: z.string().min(1), timeSeconds: z.number().min(0), side: z.enum(["start", "end"]) }),
  z.object({ type: z.literal("ripple_delete"), clipId: z.string().min(1), allUnlockedTracks: z.boolean().default(true) }),
  z.object({ type: z.literal("ripple_insert_gap"), timeSeconds: z.number().min(0), durationSeconds: z.number().positive(), trackIds: z.array(z.string().min(1)).max(16).optional() }),
  z.object({ type: z.literal("remove_clip"), clipId: z.string().min(1) }),
]);

registrar.registerTool(
  "apply_edit_operation",
  {
    title: "原子执行剪辑操作",
    description: "让 Codex 用带 expectedRevision 的命令增删轨道、放入媒体/字幕、移动、裁切参数、分割或删除片段；冲突时拒绝覆盖其他窗口。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), operation: editOperationSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, expectedRevision, operation }) => {
    try { return textResult(await withEditor((editor) => editor.applyEditOperation(projectRoot, editProjectId, expectedRevision, operation))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_edit_history_info",
  {
    title: "读取剪辑撤销历史",
    description: "读取剪辑工程可撤销/重做状态和持久化历史数量。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId }) => { try { return textResult(await withEditor((editor) => editor.getEditHistoryInfo(projectRoot, editProjectId))); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "undo_edit_project",
  {
    title: "撤销剪辑操作",
    description: "恢复上一个持久化剪辑快照，同时生成新的单调修订号；不会修改或删除源媒体。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, expectedRevision }) => { try { return textResult(await withEditor((editor) => editor.undoEditProject(projectRoot, editProjectId, expectedRevision, "codex"))); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "redo_edit_project",
  {
    title: "重做剪辑操作",
    description: "恢复最近撤销的剪辑快照，同时生成新的单调修订号。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3), expectedRevision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, expectedRevision }) => { try { return textResult(await withEditor((editor) => editor.redoEditProject(projectRoot, editProjectId, expectedRevision, "codex"))); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "export_edit_otio",
  {
    title: "导出 OpenTimelineIO",
    description: "把当前剪辑修订导出为新的 Timeline.1 OTIO 文件，保留整数帧、轨道、Gap、媒体引用和 AI 画布元数据。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), outputPath: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, expectedRevision, outputPath }) => { try { return textResult(await withEditor((editor) => editor.exportEditProjectOtio(projectRoot, editProjectId, expectedRevision, outputPath))); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "import_edit_otio",
  {
    title: "导入 OpenTimelineIO",
    description: "从 Timeline.1 OTIO 建立新的本地剪辑工程；验证媒体绝对路径、整数帧和轨道类型，不改动源文件。",
    inputSchema: { projectRoot: projectRootSchema, filePath: z.string().min(1), name: z.string().max(120).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, filePath, name }) => { try { return textResult(await withEditor((editor) => editor.importEditProjectOtio(projectRoot, filePath, name))); } catch (error) { return toolError(error); } },
);

registrar.registerTool(
  "get_managed_studio_overview",
  {
    title: "读取受管素材中心概览",
    description: "校验 managed-project.json、项目配置、bootstrap 索引与受管存储后，返回项目 shell、素材库和生产知识库计数；不返回 SQLite、CAS 或 bodyPath 绝对路径。",
    inputSchema: { projectRoot: managedStudioProjectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      const shell = await inspectManagedProject(projectRoot);
      const [material, production] = await Promise.all([
        getMaterialStudioState(projectRoot),
        getStudioProductionState(projectRoot),
      ]);
      return managedStudioResult({
        schemaVersion: 1,
        kind: "managed-studio-overview",
        projectRoot,
        project: { id: shell.project.id, name: shell.project.name, createdAt: shell.project.createdAt },
        counts: shell.counts,
        nextAction: shell.nextAction,
        manifestFingerprint: shell.manifestFingerprint,
        policy: shell.manifest,
        material: { schemaVersion: material.schemaVersion, pragmas: material.pragmas, counts: material.counts },
        production: { schemaVersion: production.schemaVersion, pragmas: production.pragmas, counts: production.counts },
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_local_creative_project_ingest_status",
  {
    title: "读取本机创作项目导入与参考链状态",
    description: "对一个受管本机创作项目只读核对来源层、初次盘点、内容导入、媒体/文档计数、锁引用和 canonical 决策。结果有界分页，明确 visualAppearance=UNCONFIRMED 且不继承源 authority；不返回媒体字节、CAS/SQLite 私有路径或完整媒体清单。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      cursor: studioCursorSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
      refreshSource: z.boolean().default(true),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, cursor, limit, refreshSource }) => {
    try {
      return managedStudioResult(await getLocalCreativeProjectIngestStatus(
        projectRoot,
        { cursor, limit, refreshSource },
      ));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "preview_local_creative_production_units",
  {
    title: "预览本机项目的受管生产单元",
    description: "只读：从明确适配器与真实来源证据解析 1–15 秒、2–6 格生产单元候选；返回内容寻址预览，不写 Studio、不猜测无时码项目。来源在扫描期间变化会失败关闭。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      scopeId: z.string().trim().min(1).max(200).optional(),
      adapterKind: z.enum(["auto", "dudu-world-prologue-v1"]).default("auto"),
      expectedSourceFingerprint: studioSha256Schema.optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, scopeId, adapterKind, expectedSourceFingerprint }) => {
    try {
      return managedStudioResult(await previewLocalCreativeProductionUnits(projectRoot, {
        scopeId,
        adapterKind,
        expectedSourceFingerprint,
      }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_studio_assets",
  {
    title: "分页搜索受管角色场景道具",
    description: "仅在通过受管项目完整性校验后，按类别与关键词分页返回角色、场景、道具、风格摘要及结构化适用范围。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      search: z.string().trim().max(256).optional(),
      category: z.enum(["character", "scene", "prop", "style"]).optional(),
      cursor: studioCursorSchema.optional(),
      limit: studioPageLimitSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, search, category, cursor, limit }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await listStudioCanonicalAssets(projectRoot, { search, category, cursor, limit }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_studio_media",
  {
    title: "分页搜索受管媒体",
    description: "仅返回受管项目媒体的 SHA、类型、尺寸、MIME、原文件名和派生状态；不返回 objectPath、缩略图绝对路径或二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      search: z.string().trim().max(256).optional(),
      kind: z.enum(["image", "video", "audio"]).optional(),
      cursor: studioCursorSchema.optional(),
      limit: studioPageLimitSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, search, kind, cursor, limit }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await listStudioMedia(projectRoot, { search, kind, cursor, limit }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_studio_media_import_origins",
  {
    title: "分页追溯受管媒体导入来源",
    description: "按媒体 SHA 读取已记录的显式导入来源；工程内来源返回安全相对路径，外部来源返回明确绝对原路径。只查询不扫描目录，不返回 CAS objectPath、base64 或媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      mediaSha256: z.string().regex(/^[a-f0-9]{64}$/iu),
      cursor: studioCursorSchema.optional(),
      limit: studioPageLimitSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, mediaSha256, cursor, limit }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await listStudioMediaImportOrigins(projectRoot, mediaSha256, { cursor, limit }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_studio_text_documents",
  {
    title: "分页搜索受管剧本与提示词",
    description: "分页返回剧本/提示词文档头与最新冻结修订元数据，便于继续读取 revisionId；不返回 bodyPath。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      kind: z.enum(["script", "prompt"]).optional(),
      search: z.string().trim().max(256).optional(),
      cursor: studioCursorSchema.optional(),
      limit: studioPageLimitSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, kind, search, cursor, limit }) => {
    try {
      await inspectManagedProject(projectRoot);
      const page = await listStudioTextDocuments(projectRoot, { kind, search, cursor, limit });
      const items = await Promise.all(page.items.map(async (document) => ({
        ...document,
        latestRevision: await getLatestStudioTextRevisionMetadata(projectRoot, document.id),
      })));
      return managedStudioResult({ ...page, items });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_studio_production_units",
  {
    title: "分页读取 15 秒生产单元",
    description: "按季/集分页返回严格 15 秒、2–6 宫格生产单元摘要；sequence 在同季同集内唯一。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      season: z.string().trim().min(1).max(500).optional(),
      episode: z.string().trim().min(1).max(500).optional(),
      cursor: studioCursorSchema.optional(),
      limit: studioPageLimitSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, season, episode, cursor, limit }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await listStudioProductionUnits(projectRoot, { season, episode, cursor, limit }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "query_studio_asset_timeline",
  {
    title: "分页读取资产连续性时间线",
    description: "按资产 ID 分页返回其在当前 15 秒单元中的宫格、时码、角色、在场约束与连续性证据。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      assetId: studioAssetIdSchema,
      cursor: studioCursorSchema.optional(),
      limit: studioPageLimitSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, assetId, cursor, limit }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await queryStudioAssetTimeline(projectRoot, { assetId, cursor, limit }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_asset",
  {
    title: "读取受管资产详情",
    description: "返回角色/场景/道具定义、结构化适用范围、身份特征、正负锁、媒体版本、审核历史、当前权威及不可变端点关系快照；不返回媒体绝对路径。",
    inputSchema: { projectRoot: managedStudioProjectRootSchema, assetId: studioAssetIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, assetId }) => {
    try {
      await inspectManagedProject(projectRoot);
      const asset = await getStudioCanonicalAsset(projectRoot, assetId);
      if (!asset) throw new Error(`受管资产不存在：${assetId}`);
      return managedStudioResult(asset);
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_text_revision",
  {
    title: "读取冻结文本修订",
    description: "按 revisionId 返回剧本或提示词的不可变元数据与正文；不返回 bodyPath 或文本 CAS 绝对路径。",
    inputSchema: { projectRoot: managedStudioProjectRootSchema, revisionId: studioStableIdSchema, maxChars: z.number().int().min(1_000).max(1_000_000).default(100_000) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, revisionId, ...options }) => {
    try {
      await inspectManagedProject(projectRoot);
      const revision = await getStudioTextRevision(projectRoot, revisionId);
      if (!revision) throw new Error(`文本修订不存在：${revisionId}`);
      // P27（MCP 审查 F4）：正文有界截断（默认 100k 字符，带明确截断标记，不冒充全文）。
      const maxChars = Math.max(1_000, Math.min(Number(options.maxChars ?? 100_000) || 100_000, 1_000_000));
      const body = typeof revision.body === "string" ? revision.body : "";
      const truncated = body.length > maxChars;
      return managedStudioResult({
        ...revision,
        body: truncated ? body.slice(0, maxChars) : body,
        bodyTruncated: truncated,
        bodyChars: body.length,
      });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_production_unit_snapshot",
  {
    title: "读取 1–15 秒单元冻结快照",
    description: "返回含明确 season、同季同集 sequence、剧本修订、2–6 宫格提示词、资产约束与内容指纹的快照；不返回任何 bodyPath。",
    inputSchema: { projectRoot: managedStudioProjectRootSchema, unitId: studioStableIdSchema, unitRevision: z.number().int().min(1).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, unitId, unitRevision }) => {
    try {
      await inspectManagedProject(projectRoot);
      const snapshot = await readStudioProductionUnitSnapshotForCodex(projectRoot, unitId, unitRevision);
      if (!snapshot) throw new Error(`生产单元不存在：${unitId}`);
      return managedStudioResult(snapshot);
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_trace",
  {
    title: "Studio 生成全链双向追溯（只读）",
    description: "P24 双向追溯：by-pack/by-run/by-result 返回当时链投影（剧本 revision、原文 spans、单元修订、提示词 revision、BindingSet、连续性指纹、runs/results/reviews 有界列表、冻结提示词前镜 previousStandings（只从该包 renderedPrompt 还原，无该行则省略）、冻结宫格光线/服装覆盖 frozenPanelOverlays（无该行则省略）、一致性四态 peek（consistencyPeek，by-run 用该 run、否则本包 runs 最新一条只读 LRU；无 run 则省略以免改 P24 形状；未评估 ≠ 无法检查；不 evaluate 像素；机器不自动 Review PASS）、预期/非预期变化分类，历史身份一律经冻结包还原不读 head）；script-revision-impact 按剧本 revision 反查受影响单元修订→宫格→冻结包→runs→结果（两层分页，limit≤100）。只读，不写任何账本。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      operation: z.enum(["by-pack", "by-run", "by-result", "script-revision-impact"]),
      packId: studioStableIdSchema.optional(),
      runId: studioStableIdSchema.optional(),
      resultId: studioStableIdSchema.optional(),
      scriptRevisionId: studioStableIdSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: studioCursorSchema.optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, operation, packId, runId, resultId, scriptRevisionId, limit, cursor }) => {
    try {
      await inspectManagedProject(projectRoot);
      const selectors = [packId ? "packId" : undefined, runId ? "runId" : undefined, resultId ? "resultId" : undefined, scriptRevisionId ? "scriptRevisionId" : undefined]
        .filter((selector): selector is string => Boolean(selector));
      const expectedSelector = ({
        "by-pack": "packId",
        "by-run": "runId",
        "by-result": "resultId",
        "script-revision-impact": "scriptRevisionId",
      } as const)[operation];
      if (selectors.length !== 1 || selectors[0] !== expectedSelector) {
        throw new Error(`${operation} 只允许且必须提供 ${expectedSelector}，禁止混用其他追溯选择器。`);
      }
      if (operation !== "script-revision-impact" && (limit !== undefined || cursor !== undefined)) {
        throw new Error(`${operation} 不接受 limit/cursor；分页参数仅用于 script-revision-impact。`);
      }
      const pageQuery = { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) };
      if (operation === "by-pack") {
        if (!packId) throw new Error("by-pack 需要 packId。");
        return managedStudioResult(await getStudioGenerationTrace(projectRoot, { packId }));
      }
      if (operation === "by-run") {
        if (!runId) throw new Error("by-run 需要 runId。");
        return managedStudioResult(await getStudioGenerationTrace(projectRoot, { runId }));
      }
      if (operation === "by-result") {
        if (!resultId) throw new Error("by-result 需要 resultId。");
        return managedStudioResult(await getStudioGenerationTrace(projectRoot, { resultId }));
      }
      if (!scriptRevisionId) throw new Error("script-revision-impact 需要 scriptRevisionId。");
      return managedStudioResult(await getStudioScriptRevisionImpact(projectRoot, { scriptRevisionId, ...pageQuery }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_production_projection_bundle",
  {
    title: "读取当前单元聚合投影（单元驾驶舱）",
    description: "P2 只读聚合：一次调用返回当前单元 2—6 格详情（binding/review/freeze/raw 引用）、四轨时间线摘要、post-result observation、相邻单元摘要（adjacentLocator）与 Core 唯一 nextAction。各子投影带各自 revision/fingerprint 水位，跨库不伪称全局原子；不返回 SQLite/CAS 路径或媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: z.object({
        unitId: z.string().min(1).max(200),
        panelId: z.string().min(1).max(200).optional(),
      }),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await buildStudioProductionProjectionBundle(projectRoot, query));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_binding_control",
  {
    title: "读取 Studio 剧本资产绑定控制",
    description: "单一只读高层控制入口：list_units 最多 36 个单元；get_control 返回一个真实 1–15 秒单元的 2–6 宫格、每格最多 256 项提案且每项最多 5 个候选；list_sections 以 scriptRevisionId 锚定同一剧本文档并分页返回最多 100 个 current section heads；get_section 按不可变 revisionId 返回单个章节/场景元数据。section 查询不返回正文或路径；控制查询不返回 assetSources、内部 head revision、CAS 路径或二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: studioBindingControlQuerySchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }) => {
    try {
      await inspectManagedProject(projectRoot);
      if (query.operation === "list_units") {
        return managedStudioResult(await listStudioBindingUnits(projectRoot, {
          ...(query.seasonId ? { seasonId: query.seasonId } : {}),
          ...(query.episodeId ? { episodeId: query.episodeId } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit,
        }));
      }
      if (query.operation === "list_sections") {
        return managedStudioResult(await listStudioBindingSections(projectRoot, {
          scriptRevisionId: query.scriptRevisionId,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit,
        }));
      }
      if (query.operation === "get_section") {
        return managedStudioResult(await getStudioBindingSection(projectRoot, { revisionId: query.revisionId }));
      }
      return managedStudioResult(await getStudioBindingControl(projectRoot, { unitId: query.unitId }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_continuity_review_control",
  {
    title: "读取 Studio 连续性与 Review 控制面",
    description: "按一个真实 1–15 秒单元内宫格和最多 6 项资产，聚合固定九字段 readiness、有界连续性跨度、开放冲突、单个 generation run 的有界 Review 历史，以及有界六图 checkpoint 批次；唯一下一动作由 Core 推导。只读元数据，不返回数据库路径、CAS 路径或媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: z.object({
        unitId: studioStableIdSchema,
        unitRevision: z.number().int().positive(),
        panelId: studioStableIdSchema,
        startMilliseconds: z.number().int().min(0).max(14_999),
        endMilliseconds: z.number().int().min(1).max(15_000),
        assetIds: z.array(studioAssetIdSchema).max(6).superRefine((values, context) => {
          if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "assetIds 不得重复" });
        }),
        generationRunId: studioStableIdSchema.optional(),
        timelineOffset: z.number().int().nonnegative().default(0),
        timelineLimit: z.number().int().min(1).max(36).default(36),
        conflictOffset: z.number().int().nonnegative().default(0),
        conflictLimit: z.number().int().min(1).max(36).default(36),
        reviewCursor: studioCursorSchema.optional(),
        reviewLimit: z.number().int().min(1).max(20).default(20),
        checkpointOffset: z.number().int().nonnegative().default(0),
        checkpointLimit: z.number().int().min(1).max(12).default(12),
        evaluateConsistency: z.boolean().optional(),
      }).strict().superRefine((value, context) => {
        if (value.endMilliseconds <= value.startMilliseconds) {
          context.addIssue({
            code: "custom",
            path: ["endMilliseconds"],
            message: "endMilliseconds 必须大于 startMilliseconds",
          });
        }
      }),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }, extra) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await getStudioContinuityReviewControl(projectRoot, { ...query, signal: extra.signal }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_script_library_projection",
  {
    title: "剧本库只读投影（SSL-0/1/2/3/5 计划）",
    description:
      "剧本库投影只读入口。library-index；episode-unit-media-map；missing-media-report；reader-view（正文+大纲+earliest）；script-media-align（SSL-3 一键图文对照：unit→图 SHA/缺图/trace 钥匙/大纲锚/缺图报告 missingReport，需 season+episode，可选 documentId）；ssl5-missing-to-gen-plan（SSL-5 缺图→earliest 只读下一步，含焦点宫格场景/道具/角色回指 sceneBackReferenceLine/sceneBackReferences/propBackReferenceLine/propBackReferences/characterBackReferenceLine/characterBackReferences、锁版光线/服化 lightingCostumeLine、镜头类型/扩写格 shotTypeLine、风格锁 styleLockLine 与 15s 节拍 beatLine/unitBeatLine、一致性四态 peek consistencyPeek（复用已加载对照板焦点格/行，零额外评估；未评估 ≠ 无法检查；机器不自动 Review PASS）、六图闸 checkpoint/checkpointLine（复用对照板已投影闸，未放行新槽时禁止再建议 create-plan/dispatch；earliest wait/retry/Review 文案更具体时保留；不二次读闸）、写租约 writeLease/writeLeaseLine（复用对照板已投影租约，未持有时 recommendedPath 在 freeze 前插入 acquire-lease；不暴露 token、不抢租约；未投影不插）、焦点宫格自己的 focusPackId 与 create-plan 只读草稿 generationPlanDraft（只认缺图格 pack，禁止用同行已出图 packId；账本已有对应 plan 则 ready=false、按节点状态写 dispatch/wait/retry/Review；焦点即 earliest 且 earliest 已是 wait/retry/Review/对账时禁止再建议 create-plan/dispatch，下一步以 earliest 为准；可选 revisionImpact 为调用方已取回的 script-revision-impact 页（焦点 unexpected 则 recommendedPath=review，禁止再建议 create-plan/dispatch；earliest/六图闸文案更具体时保留；省略不自动查）；不执行、不 dispatch）；只扫已加载对照板）；script-span-media-map（点选 span→相交宫格/图/构图/前镜交接/锁版光线服化/镜头类型/风格锁/15s 节拍/场景回指/道具回指/角色回指/一致性四态 peek consistencyPeek（只读 LRU；未评估 ≠ 无法检查；不跑像素；机器不自动 Review PASS），需 season+episode+startOffsetUtf16+endOffsetUtf16）。不写账本；不返回 CAS 路径/媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      operation: z.enum([
        "library-index",
        "episode-unit-media-map",
        "missing-media-report",
        "reader-view",
        "script-media-align",
        "storyboard-wizard-suggest",
        "ssl5-missing-to-gen-plan",
        "script-span-media-map",
      ]),
      kind: z.enum(["script", "prompt"]).optional(),
      season: z.string().min(1).max(64).optional(),
      episode: z.string().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      documentId: studioStableIdSchema.optional(),
      revisionId: studioStableIdSchema.optional(),
      scriptRevisionId: studioStableIdSchema.optional(),
      panelCount: z.number().int().min(2).max(6).optional(),
      includeBody: z.boolean().optional(),
      startOffsetUtf16: z.number().int().min(0).optional(),
      endOffsetUtf16: z.number().int().min(0).optional(),
      revisionImpact: z.object({
        empty: z.boolean().optional(),
        nextCursor: z.string().optional(),
        items: z.array(z.object({
          unitId: z.string().min(1),
          unitRevision: z.number().int().optional(),
          rows: z.array(z.object({
            panelId: z.string().nullable(),
            targetKind: z.string().optional(),
            changeClassification: z.string().nullable(),
          })),
        })),
      }).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({
    projectRoot,
    operation,
    kind,
    season,
    episode,
    limit,
    documentId,
    revisionId,
    scriptRevisionId,
    panelCount,
    includeBody,
    startOffsetUtf16,
    endOffsetUtf16,
    revisionImpact,
  }) => {
    try {
      await inspectManagedProject(projectRoot);
      if (operation === "library-index") {
        return managedStudioResult(
          await getStudioScriptLibraryIndex(projectRoot, {
            ...(kind ? { kind } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      }
      if (operation === "reader-view") {
        return managedStudioResult(
          await getStudioScriptReaderView(projectRoot, {
            ...(documentId ? { documentId } : {}),
            ...(revisionId ? { revisionId } : {}),
            ...(season ? { season } : {}),
            ...(episode ? { episode } : {}),
            ...(includeBody !== undefined ? { includeBody } : {}),
          }),
        );
      }
      if (operation === "storyboard-wizard-suggest") {
        const sid = scriptRevisionId ?? revisionId;
        if (!sid) throw new Error("storyboard-wizard-suggest 需要 scriptRevisionId（或 revisionId）。");
        return managedStudioResult(
          await openStudioStoryboardWizard(projectRoot, {
            scriptRevisionId: sid,
            ...(panelCount !== undefined ? { panelCount } : {}),
          }),
        );
      }
      if (!season || !episode) {
        throw new Error(`${operation} 需要 season 与 episode。`);
      }
      if (operation === "script-media-align") {
        return managedStudioResult(
          await getStudioScriptMediaAlignBoard(projectRoot, {
            season,
            episode,
            ...(documentId ? { documentId } : {}),
            ...(revisionId ? { revisionId } : {}),
          }),
        );
      }
      if (operation === "ssl5-missing-to-gen-plan") {
        return managedStudioResult(
          await planSsl5MissingToGen(projectRoot, {
            season,
            episode,
            ...(documentId ? { documentId } : {}),
            ...(revisionImpact ? { revisionImpact } : {}),
          }),
        );
      }
      if (operation === "script-span-media-map") {
        if (startOffsetUtf16 === undefined || endOffsetUtf16 === undefined) {
          throw new Error("script-span-media-map 需要 startOffsetUtf16 与 endOffsetUtf16。");
        }
        const map = await getStudioEpisodeUnitMediaMap(projectRoot, {
          season,
          episode,
          ...(limit !== undefined ? { limit } : {}),
        });
        return managedStudioResult(
          await withSpanMediaConsistencyPeeks(
            resolveScriptSpanMediaMap(map, { startOffsetUtf16, endOffsetUtf16 }),
          ),
        );
      }
      if (operation === "episode-unit-media-map") {
        return managedStudioResult(
          await getStudioEpisodeUnitMediaMap(projectRoot, {
            season,
            episode,
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      }
      return managedStudioResult(
        await getStudioEpisodeMissingMediaReport(projectRoot, {
          season,
          episode,
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "get_studio_consistency_evaluation",
  {
    title: "读取生成结果一致性辅助判定（P19）",
    description: "对当前 Review 目标 generation run 的结果图与冻结包权威参考图做机器四态判定（一致/需复核/明显漂移/无法检查，按人物/场景/道具分类逐项，动物资产归入人物权重路径）。机器结论仅辅助人工 Review，不自动通过、不写入任何事实。有界评估（≤6 资产、≤2 并发、15s 预算，可取消）。只读元数据，不返回数据库路径、CAS 路径或媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: z.object({
        generationRunId: studioStableIdSchema.optional(),
        unitId: studioStableIdSchema.optional(),
        panelId: studioStableIdSchema,
      }).strict().superRefine((value, context) => {
        if (!value.generationRunId && !value.unitId) {
          context.addIssue({ code: "custom", path: ["unitId"], message: "未传 generationRunId 时必须提供 unitId 以自动解析最新 run" });
        }
      }),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }, extra) => {
    try {
      await inspectManagedProject(projectRoot);
      const generationRunId = query.generationRunId
        ?? (query.unitId ? await resolveLatestStudioGenerationRunForPanel(projectRoot, query.unitId, query.panelId) : undefined);
      if (!generationRunId) return toolError(new Error("该宫格不存在任何 generation run，无法评估。"));
      return managedStudioResult(await evaluateStudioReviewTargetConsistency(projectRoot, { generationRunId, signal: extra.signal }));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "suggest_studio_storyboard_draft",
  {
    title: "生成 15 秒宫格拆格建议（P20）",
    description: "对当前剧本修订做确定性拆格建议：拆句（全角/半角终止符+换行，连续终止符归并）→ 0.1s 边界时长分配（总和严格 15.0、最小格 1.0s，按文本长度贪心）→ 每格 sourceSpans 精确锚定与 shotType 规则（extension 仅末尾后缀且禁带 spans）→ 资产带入建议（exact matched 带入，ambiguous 必须显式裁决，不自动选第一个）。纯函数只读，不写任何事实；建议内容（动作/景别/对白/提示词）由 Agent 填写，软件负责 Schema/时长/资产/消歧/连续性/物化。注意：显式请求格数超过文本可拆格数时，末尾 extension 建议格的时间字段为 0/0/0，Agent 提交前必须在 15.0s 总额内重排全部格时长（normalizeUnitDraft 拒绝 0 时长）。不返回数据库路径、CAS 路径或媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: z.object({
        scriptRevisionId: studioStableIdSchema.optional(),
        unitId: studioStableIdSchema.optional(),
        panelCount: z.number().int().min(2).max(6).optional(),
      }).strict().superRefine((value, context) => {
        if (!value.scriptRevisionId && !value.unitId) {
          context.addIssue({ code: "custom", path: ["scriptRevisionId"], message: "scriptRevisionId 与 unitId 至少其一必填；不猜默认文档或最新 revision。" });
        }
      }),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await suggestStudioStoryboardDraft(projectRoot, query));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "evaluate_studio_fusion_helper",
  {
    title: "融合合同助手（只读）",
    description:
      "调用融合合同层纯函数：shot-compose-plan / element-bind / video-prompt / shot-draft / shot-number-* / binding-scope / panel-json / grid-split / tool-factory / staging-demo / publication-preflight。不写 CAS、不派生图、不读媒体二进制。payload 随 operation 变化。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema.optional(),
      operation: z.enum([
        "shot-compose-plan",
        "element-bind",
        "video-prompt",
        "shot-draft",
        "shot-number-intercalate",
        "shot-number-next",
        "binding-scope",
        "panel-json",
        "grid-split",
        "tool-factory",
        "staging-demo",
        "publication-preflight",
      ]),
      payload: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, operation, payload }) => {
    try {
      if (projectRoot) await inspectManagedProject(projectRoot);
      return managedStudioResult(runStudioFusionHelper({ operation, payload }));
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "execute_studio_shot_compose_local",
  {
    title: "本机单镜合成（ffmpeg）",
    description:
      "在显式 outputDir 下用本机 ffmpeg 执行单镜合成（静帧+时长→mp4，或视频可选混 TTS）。不写工程 CAS、不自动 Review；返回输出绝对路径与 sha256。禁止路径穿越。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema.optional(),
      visualPath: z.string().min(1),
      visualKind: z.enum(["video", "still"]),
      outputDir: z.string().min(1),
      outputFileName: z.string().min(1).max(200),
      durationSeconds: z.number().positive().max(60).optional(),
      ttsAudioPath: z.string().optional(),
      srtContent: z.string().max(50_000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  async ({ projectRoot, visualPath, visualKind, outputDir, outputFileName, durationSeconds, ttsAudioPath, srtContent }) => {
    try {
      if (projectRoot) await inspectManagedProject(projectRoot);
      const result = await executeStudioShotCompose({
        visualPath,
        visualKind,
        outputDir,
        outputFileName,
        durationSeconds,
        ttsAudioPath,
        srtContent,
      });
      return managedStudioResult({
        kind: "studio-shot-compose-execute-result",
        schemaVersion: 1,
        outputPath: result.outputPath,
        outputSha256: result.outputSha256,
        bytes: result.bytes,
        plan: result.plan,
      });
    } catch (error) {
      return toolError(error);
    }
  },
);

registrar.registerTool(
  "get_studio_generation_control",
  {
    title: "读取 Codex 生成一致性控制封装",
    description: "单一只读入口提供 session-snapshot、panel/unit-grid 的 readiness、pack、history、plan、call、active-runs、detached-unknown。session-snapshot 汇总当前宫格的剧本片段、BindingSet、参考角色、上一镜实际尾态、冻结提示词前镜交接（previousStanding，只从该包 renderedPrompt 还原、不读 head）、冻结宫格光线/服装覆盖（frozenPanelLighting / frozenPanelCostume，无该行则为 null）、冻结镜头类型只读句（shotTypeLine，只从该包 renderedPrompt 或 pack.panel.shotType 还原、不读 head，无扩写/原镜则为 null）、冻结风格锁只读句（styleLockLine，只从该包 controlReferences/assets 的 category=style 还原、不读 head，无风格控制参考则为 null）、冻结 15s 节拍只读句（beatLine，只从该包 target.unitLocalStartSeconds/unitLocalEndSeconds/durationSeconds 还原、不读 head，无时长则为 null）、一致性四态 peek（consistencyPeek，按当前宫格 newest-first 结果 run 或整板 latest run 只读 LRU；未评估 ≠ 无法检查；不进 fingerprint；不 evaluate 像素；机器不自动 Review PASS）、写租约只读 peek（writeLease，held/holderId/denialHint/line；经 withStudioProjectWriteLease 读 ReadOnly；不暴露 token；不进 fingerprint；不改 nextAction；失败关闭为未持有；不抢租约、不派发）、六图闸只读 peek（checkpoint，newSlotDispatchAllowed/blockingBatchNumber/line；动态 import 首屏 DashboardGate；不进 fingerprint；不改 nextAction；失败关闭为未放行；不执行停检、不派发）、create-plan 只读草稿（generationPlanDraft，有 query.panelId 只认该格已落盘单镜包；无 panelId 只认该单元已落盘 unit-grid pack，禁止猜第一格，禁止用 readiness 候选；账本已有对应 plan 则 ready=false、按节点状态写 dispatch/wait/retry/Review；驾驶舱 nextAction 已是 wait/retry/Review/对账时单镜/整板草稿不得再 ready；未冻结/未落盘 blocked，不进 fingerprint，不执行、不派发）、pack 的 agentExecution.generationPlanDraft（已落盘 pack 起草：单镜 {unitId,panelId}，整板 {targetKind:unit-grid,unitId}；禁止用 readiness 候选 pack；单镜 pack 若同单元 unit-grid 已在途/待重试/待审则草稿不得再 ready，next 跟 wait/retry/Review；不加 inspect；不执行、不派发）、跨单元场景/道具/角色回指（sceneMentions / sceneBackReferences / sceneBackReferenceNote / propMentions / propBackReferences / propBackReferenceNote / characterMentions / characterBackReferences / characterBackReferenceNote，只读生产库快照提及、不读 head、不是 BindingSet；无提及或无更早则空数组，缺库失败关闭为空且不建库）、机位与最高风险，不返回本地路径；就绪、历史与未知态同样不返回本地路径，仅 pack 返回已重验逐格闭包、受管 media CAS 边界和文件 SHA-256 的 controlReferences.localPath。call 读取不会重新授权模型调用；active-runs 返回指定单元/宫格所有 run 的完整状态投影、恢复动作与 envelope nextAction（本槽 unknown→对账、未审→Review、在途→wait；单镜另看同单元 unit-grid 在途则 wait/retry/Review；空槽 follow-core-readiness；generationBlocked 仍只认本槽 blockingRuns；不执行、不派发）；plan 信封 nextAction（按 planId/单元查：dispatched→wait、failed/cancelled→retry、planned→dispatch、全 succeeded→Review；无计划→create-plan；未限定列表或 not_found→follow-core-readiness；不执行、不派发）；history 信封 nextAction（只看本页 items：未成对→wait、成对 pending→Review、成对 rejected→retry、空页/全 approved→follow-core-readiness；要看最新请 newest-first；不执行、不派发、不自动 Review PASS）；history 信封 consistencyPeek（本页优先成对 run 只读 LRU；未评估 ≠ 无法检查；不 evaluate 像素；机器不自动 Review PASS）；detached-unknown 只投影防重证据，不导入候选。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: studioGenerationControlQuerySchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }) => {
    try {
      await inspectManagedProject(projectRoot);
      return studioGenerationControlResult(projectRoot, await getStudioGenerationControlEnvelope(projectRoot, query));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "discover_dudu_readonly_import_projects",
  {
    title: "发现《嘟嘟》隔离导入工程（P30）",
    description: "在显式 projectsRoot 下有界扫描直接子目录，按既有 bootstrap claim 返回 0/1/冲突三态；多候选绝不自动选择。纯只读，不恢复 bootstrap、不创建工程/锁/数据库/收据，响应不返回绝对候选路径。",
    inputSchema: {
      projectsRoot: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "projectsRoot 必须是绝对路径"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectsRoot }) => {
    try {
      return managedStudioResult(await discoverDuduReadonlyImportProjects(projectsRoot));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_dudu_readonly_import_control",
  {
    title: "读取《嘟嘟》隔离导入状态（P30）",
    description: "纯只读投影 Dudu staging、registration、activation、33 单元计数和唯一下一动作。不会执行 stage/finalize、补写收据、创建锁/WAL/表、登记或切换活动工程；不返回外部来源路径。",
    inputSchema: { projectRoot: managedStudioProjectRootSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot }) => {
    try {
      return managedStudioResult(await getDuduReadonlyImportControl(projectRoot));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_video_package_control",
  {
    title: "读取 Studio 视频包控制状态（P30）",
    description: "按既有 intentId 或 authority-latest 只读恢复 prepared/verified/stale、I2V 静态输入状态、阻塞和唯一下一动作。authority-latest 校验 append-only 换代链，未准备返回 not-prepared，冲突绝不猜测。只使用 query-only SQLite 与文件 SHA 复核，不启动 builder、不发布、不调用视频模型。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      by: z.enum(["intent", "authority-latest"]),
      intentId: studioStableIdSchema.optional(),
      authority: z.union([
        z.object({ kind: z.literal("historical-import"), packId: studioStableIdSchema }).strict(),
        z.object({ kind: z.literal("studio-review"), reviewId: studioStableIdSchema }).strict(),
      ]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, by, intentId, authority }) => {
    try {
      return managedStudioResult(await getStudioVideoPackageControl(
        projectRoot,
        by === "intent"
          ? { by, intentId: intentId ?? "" }
          : { by, authority: authority as StudioVideoPackageAuthorityInput },
      ));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_connector_work_queue",
  {
    title: "读取 Higgsfield connector 本地工作队列",
    description: "只读返回有界的本地画布→Codex connector 请求状态。不会返回路径、claim token、nonce、预检原文或任何凭据；不会上传、调用生成或消耗 credits。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      statuses: z.array(z.enum(["queued", "blocked_by_provider", "claimed", "authorized", "submitted", "submission_unknown", "succeeded", "failed", "cancelled"])).max(9).optional(),
      limit: z.number().int().min(1).max(36).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, statuses, limit }) => {
    try { return managedStudioResult(await getStudioHiggsfieldConnectorWorkQueue(projectRoot, { statuses, limit })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_video_generation_control",
  {
    title: "读取 Higgsfield Seedance 2.5 Unlimited 视频控制状态",
    description: "纯只读：返回固定 20 秒/720p/Unlimited-only profile、已机械验证视频包的参考数量、当前 run 和 connector capability 门禁。当前 connector 没有同时确认 unlimAvailable/supportsUnlim 时会明确 blocked；不会上传参考、调用生成、消耗 credits 或回退 priority 队列。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      intentId: studioStableIdSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, intentId }) => {
    try { return managedStudioResult(await getStudioHiggsfieldVideoGenerationControl(projectRoot, intentId)); }
    catch (error) { return toolError(error); }
  },
);

const studioProductionDashboardQuerySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("overview") }).strict(),
  z.object({
    operation: z.literal("units"),
    season: z.string().trim().min(1).max(500).optional(),
    episode: z.string().trim().min(1).max(500).optional(),
    cursor: studioCursorSchema.optional(),
    limit: z.number().int().min(1).max(36).default(36),
  }).strict(),
  z.object({
    operation: z.literal("unit"),
    unitId: studioStableIdSchema,
    panelId: studioStableIdSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal("assets"),
    category: z.enum(["character", "scene", "prop", "style"]).optional(),
    search: z.string().trim().max(256).optional(),
    cursor: studioCursorSchema.optional(),
    limit: z.number().int().min(1).max(36).default(36),
  }).strict(),
  z.object({
    operation: z.literal("appearances"),
    assetId: studioAssetIdSchema,
    cursor: studioCursorSchema.optional(),
    limit: z.number().int().min(1).max(36).default(36),
  }).strict(),
  z.object({
    operation: z.literal("queue"),
    queue: z.enum(["ambiguity", "missing", "stale", "conflict", "rework"]),
    cursor: studioCursorSchema.optional(),
    limit: z.number().int().min(1).max(36).default(36),
  }).strict(),
]);

registrar.registerTool(
  "get_studio_production_dashboard",
  {
    title: "读取无限画布生产驾驶舱投影",
    description: "单一只读聚合入口：overview / units / unit / assets / appearances / queue。复用 P5–P7 权威模块，返回 project identity、fingerprint、stable locator、Core nextAction 与有界分页；不返回 SQLite/CAS/localPath 或媒体二进制，不新增具名写工具。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      query: studioProductionDashboardQuerySchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, query }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await getStudioProductionDashboard(
        projectRoot,
        query as StudioProductionDashboardQuery,
      ));
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_studio_multimedia_timeline",
  {
    title: "读取 Studio 四媒体单元时间线",
    description: "按一个受管生产单元读取同轴剧本、逐格原文、正式 PASS raw/labeled、已绑定视频与对白/音乐/音效、精确时码和衍生物状态。只返回内容身份与缺口，不返回 CAS/SQLite 本机路径或媒体二进制。",
    inputSchema: {
      projectRoot: managedStudioProjectRootSchema,
      unitId: studioStableIdSchema,
      unitRevision: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, unitId, unitRevision }) => {
    try {
      await inspectManagedProject(projectRoot);
      return managedStudioResult(await getStudioMultimediaTimelineProjection(projectRoot, {
        unitId,
        ...(unitRevision !== undefined ? { unitRevision } : {}),
      }));
    } catch (error) { return toolError(error); }
  },
);

const duduReadonlyRelativePathSchema = z.string().min(1).max(1_000).superRefine((value, context) => {
  if (!value.trim()
    || value !== value.trim()
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === ".."
    || value.startsWith("../")
    || value.includes("\0")) {
    context.addIssue({ code: "custom", message: "必须是规范化、非穿越的受限相对路径" });
  }
});

const duduReadonlySourceSchema = z.object({
  lockedScriptPath: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "lockedScriptPath 必须是绝对路径"),
  productionRoot: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "productionRoot 必须是绝对路径"),
  contractRelativePath: duduReadonlyRelativePathSchema.optional(),
  machineStateRelativePath: duduReadonlyRelativePathSchema.optional(),
  referenceRegistryRelativePath: duduReadonlyRelativePathSchema.optional(),
  visualCanonRevisionRelativePath: duduReadonlyRelativePathSchema.optional(),
  visualExecutionRelativePath: duduReadonlyRelativePathSchema.optional(),
  visualConflictDecisionRelativePath: duduReadonlyRelativePathSchema.optional(),
  meteorVfxRuleRelativePath: duduReadonlyRelativePathSchema.optional(),
}).strict();

const duduDetachedUnknownObservationSchema = z.object({
  unitId: z.string().regex(/^S1E01-U(?:0[0-9]|[12][0-9]|3[0-2])$/u),
  sourceTaskId: studioStableIdSchema,
  evidenceReference: z.string().trim().min(1).max(2_000).refine((value) => !value.includes("\0"), "evidenceReference 禁止包含 NUL"),
  evidenceFingerprint: studioSha256Schema,
  candidateSha256: studioSha256Schema.optional(),
  candidateSizeBytes: z.number().int().positive().safe().optional(),
  candidateWidth: z.number().int().positive().safe().optional(),
  candidateHeight: z.number().int().positive().safe().optional(),
  note: z.string().max(2_000).optional(),
}).strict().superRefine((value, context) => {
  const hasMetrics = value.candidateSizeBytes !== undefined
    || value.candidateWidth !== undefined
    || value.candidateHeight !== undefined;
  if (hasMetrics && value.candidateSha256 === undefined) {
    context.addIssue({ code: "custom", path: ["candidateSha256"], message: "candidate 元数据必须携带 candidateSha256" });
  }
});

const commandRequestSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("scan_project"), payload: z.object({}) }),
  z.object({ command: z.literal("stage_dudu_readonly_managed_project"), payload: z.object({
    projectsRoot: z.string().trim().min(1).refine((value) => path.isAbsolute(value), "projectsRoot 必须是绝对路径"),
    source: duduReadonlySourceSchema,
    detachedUnknownObservations: z.array(duduDetachedUnknownObservationSchema).max(33).optional(),
    expectedRevision: z.literal(0),
    expectedDiscoveryFingerprint: studioSha256Schema,
  }).strict() }),
  ...STUDIO_CODEX_PUBLIC_COMMAND_SCHEMA_OPTIONS,
  ...NOVEL_MANUSCRIPT_COMMAND_SCHEMA_OPTIONS,
  z.object({ command: z.literal("materialize_fusion_project"), payload: z.object({
    ...fusionInspectionInputShape,
    targetParent: z.string().min(1),
    authorities: z.array(fusionAuthorityInputSchema).max(100).optional(),
  }) }),
  z.object({ command: z.literal("migrate_canonical_assets"), payload: z.object({
    expectedStoreRevision: z.number().int().min(0),
    expectedCandidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }) }),
  z.object({ command: z.literal("build_fusion_reference_board"), payload: z.object({
    itemId: z.string().min(1),
    variant: z.enum(["asset", "start", "end", "shot"]).optional(),
  }) }),
  z.object({ command: z.literal("build_fusion_storyboard_grid"), payload: z.object({
    itemId: z.string().min(1),
    override: z.object({ panelCount: z.number().int().min(2).max(6), expectedRevision: z.number().int().positive(), reason: z.string().trim().min(3).max(2_000) }).optional(),
    referenceOverride: z.object({
      expectedRevision: z.number().int().positive(),
      reason: z.string().trim().min(3).max(2_000),
      promptInstruction: z.string().trim().min(3).max(4_000),
      additionalAssetIdsByRowId: z.record(z.string().min(1), z.array(z.string().min(1).max(80)).min(1).max(6)),
    }).optional(),
  }) }),
  z.object({ command: z.literal("materialize_fusion_panel_references"), payload: z.object({}) }),
  z.object({ command: z.literal("materialize_fusion_visual_constraints"), payload: z.object({ expectedStoreRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("upsert_fusion_visual_constraint_override"), payload: z.object({
    override: fusionVisualConstraintOverrideSchema,
  }) }),
  z.object({ command: z.literal("upsert_panel_reference_override"), payload: z.object({
    contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
    panelId: z.string().min(1).max(500),
    expectedResolutionId: z.string().regex(/^panel-reference-[a-f0-9]{28}$/u),
    expectedStoreRevision: z.number().int().positive(),
    includeAssetIds: z.array(z.string().regex(/^[CSP]\d{2}[a-z]?$/u)).max(77).optional(),
    excludeAssetIds: z.array(z.string().regex(/^[CSP]\d{2}[a-z]?$/u)).max(77).optional(),
    reason: z.string().trim().min(3).max(2_000),
  }) }),
  z.object({ command: z.literal("register_derived_panel_reference_artifact"), payload: z.object({
    derivedAssetId: z.string().regex(/^derived-reference-[a-f0-9]{24}$/u),
    expectedStoreRevision: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    filePath: z.string().min(1),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    reviewer: z.enum(["user", "codex"]),
    reviewNote: z.string().trim().min(3).max(4_000),
  }) }),
  z.object({ command: z.literal("migrate_fusion_storyboard_evidence"), payload: z.object({
    itemIds: z.array(z.string().min(1)).max(1_288).optional(),
  }) }),
  z.object({ command: z.literal("migrate_fusion_storyboard_sheets"), payload: z.object({
    itemIds: z.array(z.string().min(1).max(500)).max(1_288).optional(),
    expectedStoreRevision: z.number().int().min(0),
    expectedCandidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }) }),
  z.object({ command: z.literal("render_fusion_storyboard_sheet"), payload: z.object({
    itemId: z.string().min(1),
    contractId: z.string().regex(/^grid-[a-f0-9]{20}$/u),
    expectedInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    placements: fusionStoryboardSheetPlacementsSchema.optional(),
  }) }),
  z.object({ command: z.literal("prepare_fusion_asset_consistency_review"), payload: z.object({ batchId: z.string().regex(/^fusion-asset-batch-\d{3}$/u).optional() }) }),
  z.object({ command: z.literal("submit_fusion_asset_consistency_review"), payload: z.object({
    batchId: z.string().regex(/^fusion-asset-batch-\d{3}$/u),
    expectedRevision: z.number().int().positive(),
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(["pass", "rework"]),
    criteria: z.array(z.object({ key: z.enum(FUSION_ASSET_CONSISTENCY_CRITERIA), result: z.enum(["pass", "fail", "na"]), note: z.string().max(2_000).optional() })).length(FUSION_ASSET_CONSISTENCY_CRITERIA.length),
    reworkItemIds: z.array(z.string().min(1)).max(6).optional(),
    note: z.string().max(4_000).optional(),
  }) }),
  z.object({ command: z.literal("seal_final_fusion_asset_consistency_batch"), payload: z.object({ batchId: z.string().regex(/^fusion-asset-batch-\d{3}$/u), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("commit_project_import"), payload: z.object({ previewId: z.string().min(1), config: z.any(), projectMode: z.enum(["filesystem", "story_first"]).optional() }) }),
  z.object({ command: z.literal("update_status"), payload: z.object({ itemId: z.string().min(1), status: z.enum(WORK_ITEM_STATUSES), note: z.string().max(8_000).optional(), authoritativePath: z.string().optional() }) }),
  z.object({ command: z.literal("claim_task"), payload: z.object({ taskId: z.string().min(1), agentId: z.string().min(2).max(120).optional(), leaseSeconds: z.number().int().min(30).max(3_600).optional(), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("heartbeat_task"), payload: z.object({ taskId: z.string().min(1), leaseId: z.string().min(8), agentId: z.string().min(2).max(120).optional(), leaseSeconds: z.number().int().min(30).max(3_600).optional(), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("release_task"), payload: z.object({ taskId: z.string().min(1), leaseId: z.string().min(8), agentId: z.string().min(2).max(120).optional(), expectedRevision: z.number().int().positive(), reason: z.string().max(2_000).optional() }) }),
  z.object({ command: z.literal("cancel_task"), payload: z.object({ taskId: z.string().min(1), expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2_000) }) }),
  z.object({ command: z.literal("finish_batch"), payload: z.object({ taskId: z.string().min(1), leaseId: z.string().min(8), agentId: z.string().min(2).max(120).optional(), expectedRevision: z.number().int().positive(), status: z.enum(["completed", "blocked"]).optional(), completedItemIds: z.array(z.string()).max(100).optional(), failedItemIds: z.array(z.string()).max(100).optional(), note: z.string().max(8_000).optional() }) }),
  z.object({ command: z.literal("apply_edit_operation"), payload: z.object({ editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), operation: editOperationSchema }) }),
  z.object({ command: z.literal("update_workflow_stage"), payload: z.object({ stageId: z.enum(PRODUCTION_WORKFLOW_STAGE_IDS), status: z.enum(["not_started", "in_progress", "review", "blocked", "completed"]), note: z.string().max(20_000).optional(), evidencePaths: z.array(z.string()).max(200).optional(), itemIds: z.array(z.string()).max(1_000).optional(), inputRequirements: z.array(z.string()).max(300).optional(), outputRequirements: z.array(z.string()).max(300).optional(), acceptanceCriteria: z.array(z.string()).max(300).optional(), failurePaths: z.array(z.string()).max(300).optional(), nextActions: z.array(z.string()).max(300).optional(), expectedRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("commit_existing_production_recovery"), payload: z.object({ ...existingProductionRecoveryInputSchema, projectRoot: z.never().optional(), previewId: z.string().regex(/^[a-f0-9]{64}$/), expectedWorkflowRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("upsert_creative_bible"), payload: revisionedUpsertSchema(creativeBibleInputShape) }),
  z.object({ command: z.literal("upsert_storyboard_row"), payload: z.object({ id: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional(), ...storyboardRowPatchSchema }) }),
  z.object({ command: z.literal("submit_review"), payload: z.object({ itemId: z.string().min(1), reviewType: z.enum(["image", "video"]), artifactIds: z.array(z.string()).min(1).max(20), expectedScanId: z.string().min(1), expectedArtifactHashes: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)), expectedRequirementId: z.string().regex(/^fusion-review-[a-f0-9]{64}$/u).optional(), decision: z.enum(["pending", "pass", "rework"]), criteria: z.array(z.object({ key: z.enum(REVIEW_CRITERIA_KEYS), result: z.enum(["pass", "fail", "na"]), note: z.string().max(2_000).optional() })).max(20), annotations: z.array(reviewAnnotationSchema).max(100).optional(), note: z.string().max(8_000).optional() }) }),
  z.object({ command: z.literal("upsert_asset_relation"), payload: revisionedUpsertSchema(assetRelationInputShape) }),
  z.object({ command: z.literal("upsert_voice_identity"), payload: revisionedUpsertSchema(voiceIdentityInputShape) }),
  z.object({ command: z.literal("update_browser_generation"), payload: z.object({ jobId: z.string().min(3), expectedRevision: z.number().int().positive(), expectedSettingsRevision: z.number().int().positive().optional(), status: z.enum(["refresh_plan", "preflight_blocked", "preflight", "uploaded", "submit_intent", "submitted", "processing", "downloaded", "failed"]), externalTaskId: z.string().max(500).optional(), downloadedPath: z.string().optional(), error: z.string().max(8_000).optional(), note: z.string().max(4_000).optional(), preflightEvidence: browserPreflightEvidenceSchema.optional(), uploadEvidence: browserUploadEvidenceSchema.optional(), submissionReconciliation: browserSubmissionReconciliationSchema.optional() }) }),
  z.object({ command: z.literal("update_subagent_image_generation"), payload: z.object({
    jobId: z.string().min(3),
    expectedRevision: z.number().int().min(0),
    expectedSettingsRevision: z.number().int().positive().optional(),
    status: z.enum(["migrate_plan", "migrate_execution_state", "claim", "heartbeat", "takeover", "release", "start_call", "generated", "visual_accept", "visual_rejected", "reconcile_unknown", "failed"]),
    targetProviderId: z.string().min(2).max(120).optional(),
    agentTaskName: z.string().min(6).max(200).optional(),
    owner: z.string().min(6).max(200).optional(),
    agentRunId: z.string().min(1).max(200).optional(),
    runId: z.string().min(1).max(200).optional(),
    callId: z.string().min(1).max(200).optional(),
    leaseId: z.string().min(8).max(200).optional(),
    fence: z.number().int().positive().optional(),
    leaseSeconds: z.number().int().min(30).max(3_600).optional(),
    generatedPath: z.string().min(1).optional(),
    reviewer: z.string().min(6).max(200).optional(),
    reconciliationResult: z.enum(["not_invoked", "candidate_found"]).optional(),
    confirmNoInvocation: z.boolean().optional(),
    evidenceReference: z.string().min(1).max(200).optional(),
    error: z.string().max(8_000).optional(),
    note: z.string().max(4_000).optional(),
  }) }),
  z.object({ command: z.literal("migrate_generation_execution_state"), payload: z.object({
    jobId: z.string().min(3),
    expectedRevision: z.number().int().positive(),
    evidenceReference: z.string().min(1).max(200).optional(),
    note: z.string().max(4_000).optional(),
  }) }),
  z.object({ command: z.literal("reconcile_http_generation_submission"), payload: z.object({ jobId: z.string().min(3), expectedRevision: z.number().int().positive(), reconciliation: httpSubmissionReconciliationSchema }) }),
  z.object({ command: z.literal("update_video_continuation"), payload: z.object({ continuationId: z.string().min(8), expectedRevision: z.number().int().positive(), status: z.enum(["failed", "cancelled"]), error: z.string().trim().min(1).max(8_000) }) }),
  z.object({ command: z.literal("prepare_timeline_continuation"), payload: z.object({ editProjectId: z.string().min(3), targetItemId: z.string().min(1), expectedRevision: z.number().int().positive(), timeSeconds: z.number().min(0).optional(), prompt: z.string().max(30_000).optional(), providerId: z.string().max(120).optional(), enqueue: z.boolean().optional() }) }),
  z.object({ command: z.literal("upsert_context"), payload: revisionedUpsertSchema(projectContextInputShape) }),
  z.object({ command: z.literal("delete_context"), payload: z.object({ contextId: z.string().min(1), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("upsert_story_event"), payload: z.object({ id: z.string().optional(), chapterId: z.string().min(1), order: z.number().int().min(1).optional(), title: z.string().min(1).max(180), description: z.string().max(20_000), sourceExcerpt: z.string().max(8_000).optional(), characters: z.array(z.string()).max(100).optional(), locations: z.array(z.string()).max(100).optional(), props: z.array(z.string()).max(100).optional(), tags: z.array(z.string()).max(100).optional(), episode: z.number().int().positive().optional(), unit: z.number().int().positive().optional(), itemIds: z.array(z.string()).max(100).optional(), dependencyIds: z.array(z.string()).max(100).optional(), status: z.enum(["draft", "confirmed", "deprecated"]).optional(), expectedRevision: z.number().int().positive().optional() }) }),
  z.object({ command: z.literal("connect_story_events"), payload: z.object({ sourceEventId: z.string().min(1), targetEventId: z.string().min(1) }) }),
  z.object({ command: z.literal("upsert_canvas_entity"), payload: z.object({ id: z.string().optional(), kind: z.enum(["note", "group"]), title: z.string().min(1).max(120), body: z.string().max(20_000).optional(), color: z.enum(["gold", "blue", "green", "red", "purple", "gray"]).optional(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), memberIds: z.array(z.string()).max(1_000).optional(), memberOffsets: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })).optional() }) }),
  z.object({ command: z.literal("delete_canvas_entity"), payload: z.object({ entityId: z.string().min(1) }) }),
  z.object({ command: z.literal("upsert_canvas_link"), payload: z.object({ id: z.string().optional(), sourceId: z.string().min(1), targetId: z.string().min(1), kind: z.enum(["continuity", "reference", "dependency", "comment"]).optional(), label: z.string().max(200).optional() }) }),
  z.object({ command: z.literal("delete_canvas_link"), payload: z.object({ linkId: z.string().min(1) }) }),
  z.object({ command: z.literal("undo_canvas"), payload: z.object({}) }),
  z.object({ command: z.literal("redo_canvas"), payload: z.object({}) }),
  z.object({ command: z.literal("create_task_pack"), payload: z.object({ itemIds: z.array(z.string()).max(20).optional(), episode: z.number().int().positive().optional(), mode: z.enum(["observe", "collaborate", "autopilot"]).optional(), kind: z.enum(["image", "video"]).optional() }) }),
  z.object({ command: z.literal("register_artifact"), payload: z.object({ itemId: z.string().min(1), artifactPath: z.string().min(1), kind: z.enum(["info", "prompt", "raw-image", "labeled-image", "video", "audio", "manifest", "other"]), variant: z.enum(["start", "end", "generic"]).optional(), note: z.string().max(8_000).optional() }) }),
  z.object({ command: z.literal("verify_item"), payload: z.object({ itemId: z.string().min(1) }) }),
  z.object({ command: z.literal("set_authoritative_artifact"), payload: z.object({ itemId: z.string().min(1), artifactId: z.string().min(1), note: z.string().max(8_000).optional() }) }),
  z.object({ command: z.literal("promote_asset_to_hard_lock"), payload: z.object({ itemId: z.string().min(1), note: z.string().max(8_000).optional() }) }),
  z.object({ command: z.literal("enqueue_generation"), payload: z.object({ itemIds: z.array(z.string()).min(1).max(20), kind: z.enum(["image", "video"]), providerId: z.string().max(120).optional(), taskId: z.string().optional(), prompt: z.string().max(30_000).optional(), continuation: z.object({ continuationId: z.string().min(8), firstFrameArtifactId: z.string().min(1).optional() }).optional(), fusionStoryboardPanel: z.object({ contractId: z.string().min(8).max(200), panelIndex: z.number().int().min(1).max(6) }).optional() }) }),
  z.object({ command: z.literal("upsert_generation_provider"), payload: z.object({ expectedRevision: z.number().int().min(0), provider: generationProviderUpsertSchema, setAsDefaultFor: z.enum(["image", "video"]).optional(), concurrency: z.number().int().min(1).max(8).optional() }) }),
  z.object({ command: z.literal("save_script_document"), payload: z.object({ filePath: z.string().min(1), content: z.string().max(2_097_152), expectedModifiedAt: z.string().optional() }) }),
  z.object({ command: z.literal("extract_last_frame"), payload: z.object({ itemId: z.string().min(1), artifactId: z.string().optional(), videoPath: z.string().optional() }) }),
  z.object({ command: z.literal("create_video_continuation"), payload: z.object({ itemId: z.string().min(1), sourceVideoPath: z.string().optional(), lastFramePath: z.string().min(1), prompt: z.string().max(30_000).optional(), sourceType: z.enum(["video", "timeline"]).optional(), editProjectId: z.string().optional(), editProjectRevision: z.number().int().positive().optional(), timelineFrameId: z.string().optional(), timelineTimeSeconds: z.number().min(0).optional(), targetFirstFrameArtifactId: z.string().optional() }) }),
  z.object({ command: z.literal("import_story_file"), payload: z.object({ filePath: z.string().min(1), title: z.string().max(200).optional() }) }),
  z.object({ command: z.literal("import_story_text"), payload: z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(10_000_000), kind: z.enum(["text", "markdown"]).optional() }) }),
  z.object({ command: z.literal("analyze_novel_chapters"), payload: z.object({ expectedRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("generate_adaptation_plans"), payload: z.object({ expectedRevision: z.number().int().min(0), episode: z.number().int().positive().optional(), startUnit: z.number().int().positive().optional() }) }),
  z.object({ command: z.literal("select_adaptation_plan"), payload: z.object({ planId: z.string().min(1), expectedRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("materialize_adaptation_plan"), payload: z.object({ expectedRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("regenerate_adaptation_scope"), payload: z.object({ planId: z.string().min(1), expectedRevision: z.number().int().min(0), factIds: z.array(z.string().min(1)).max(200).optional(), beatIds: z.array(z.string().min(1)).max(200).optional() }) }),
  z.object({ command: z.literal("upsert_novel_fact"), payload: z.object(novelFactInputSchema) }),
  z.object({ command: z.literal("upsert_narrative_beat"), payload: z.object(narrativeBeatInputSchema) }),
  z.object({ command: z.literal("export_adaptation"), payload: z.object({ format: z.enum(["json", "markdown"]), outputPath: z.string().min(1), planId: z.string().min(1).optional() }) }),
  z.object({ command: z.literal("create_novel_analysis_task"), payload: z.object({ expectedRevision: z.number().int().min(0), providerId: z.string().min(1).max(120).optional(), providerKind: z.enum(["codex", "external"]).optional(), chapterIds: z.array(z.string().min(1)).max(500).optional() }) }),
  z.object({ command: z.literal("plan_novel_analysis_run"), payload: z.object({ expectedRevision: z.number().int().min(0), providerId: z.string().min(1).max(120), targetCharacters: z.number().int().min(1_000).max(2_000_000).optional(), maxChaptersPerBatch: z.number().int().min(1).max(100).optional(), sourceId: z.string().min(1).optional(), chapterIds: z.array(z.string().min(1)).max(5_000).optional() }) }),
  z.object({ command: z.literal("upsert_novel_analysis_provider"), payload: z.object({ expectedRevision: z.number().int().min(0), provider: novelAnalysisProviderSchema, setAsDefault: z.boolean().optional() }) }),
  z.object({ command: z.literal("execute_novel_analysis_task"), payload: z.object({ taskId: z.string().min(1), providerId: z.string().min(1).max(120), expectedRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("execute_next_novel_analysis_run_task"), payload: z.object({ runId: z.string().min(1), expectedRevision: z.number().int().min(0) }) }),
  z.object({ command: z.literal("replace_novel_analysis_run_task"), payload: z.object({ runId: z.string().min(1), batchIndex: z.number().int().positive(), expectedRevision: z.number().int().min(0), reason: z.string().trim().min(3).max(4_000), confirmNoRemoteResult: z.boolean().optional() }) }),
  z.object({ command: z.literal("mark_novel_analysis_execution_reconciliation_required"), payload: z.object({ taskId: z.string().min(1), executionId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0), expectedTaskRevision: z.number().int().positive(), expectedExecutionFence: z.number().int().min(0), expectedLeaseUntil: z.string().datetime(), note: z.string().trim().min(3).max(4_000) }) }),
  z.object({ command: z.literal("reconcile_novel_analysis_execution"), payload: z.object({ taskId: z.string().min(1), executionId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0), expectedTaskRevision: z.number().int().positive(), expectedExecutionFence: z.number().int().min(0), result: z.enum(["found", "not_found"]), evidenceReference: z.string().trim().min(3).max(2_000), note: z.string().trim().min(3).max(4_000) }) }),
  z.object({ command: z.literal("submit_novel_analysis_proposal"), payload: z.object({ taskId: z.string().min(1), expectedRevision: z.number().int().min(0), executionId: z.string().min(1).max(200).optional(), expectedExecutionFence: z.number().int().min(0).optional(), facts: z.array(novelFactProposalSchema).max(500), beats: z.array(narrativeBeatProposalSchema).max(300) }) }),
  z.object({ command: z.literal("review_novel_analysis_item"), payload: z.object({ reviewId: z.string().min(1), decision: z.enum(["accepted", "rejected"]), expectedRevision: z.number().int().min(0), reviewExpectedRevision: z.number().int().positive(), note: z.string().max(4_000).optional() }) }),
  z.object({ command: z.literal("review_novel_analysis_batch"), payload: z.object({ expectedRevision: z.number().int().min(0), decisions: z.array(z.object({ reviewId: z.string().min(1), decision: z.enum(["accepted", "rejected"]), reviewExpectedRevision: z.number().int().positive(), note: z.string().max(4_000).optional() })).min(1).max(200) }) }),
  z.object({ command: z.literal("save_skill"), payload: z.object({ id: z.string().min(1), name: z.string().min(1).max(160), description: z.string().max(2_000), category: z.enum(["orchestration", "production", "continuity", "review", "custom"]), enabled: z.boolean(), content: z.string().max(200_000), expectedUpdatedAt: z.string().optional() }) }),
  z.object({ command: z.literal("create_handoff"), payload: z.object({ itemId: z.string().optional() }) }),
  z.object({ command: z.literal("save_unit_timeline"), payload: z.object({ unitId: z.string().min(1), timings: z.array(z.object({ shotId: z.string().min(1), order: z.number().int().min(0), durationSeconds: z.number().positive().max(15), note: z.string().max(1_000).optional() })).max(6) }) }),
  z.object({ command: z.literal("create_shot_task_pack"), payload: z.object({ unitId: z.string().min(1), mode: z.enum(["observe", "collaborate", "autopilot"]).optional() }) }),
  z.object({ command: z.literal("process_generation_queue"), payload: z.object({ jobId: z.string().min(3).optional() }) }),
  z.object({ command: z.literal("cancel_generation"), payload: z.object({ jobId: z.string().min(3) }) }),
  z.object({ command: z.literal("preflight_publication"), payload: z.object({ requestedPath: z.string().min(1), allowedRoot: z.string().min(1).optional(), kind: z.enum(PUBLICATION_KINDS), variant: z.enum(PUBLICATION_VARIANTS).optional(), context: publicationContextSchema, note: z.string().max(4_000).optional() }) }),
  z.object({ command: z.literal("register_publication"), payload: z.object({ intentId: z.string().min(1), reservationToken: z.string().min(8), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("cancel_publication"), payload: z.object({ intentId: z.string().min(1), reservationToken: z.string().min(8), reason: z.string().trim().min(3).max(4_000), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("fail_publication"), payload: z.object({ intentId: z.string().min(1), reservationToken: z.string().min(8), reason: z.string().trim().min(3).max(4_000), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("preflight_publication_bundle"), payload: z.object({
    bundleId: z.string().min(8).max(200),
    primaryRequestedPath: z.string().min(1),
    companionRequestedPath: z.string().min(1),
    allowedRoot: z.string().min(1).optional(),
    variant: z.enum(PUBLICATION_VARIANTS).optional(),
    context: publicationContextSchema,
    note: z.string().max(4_000).optional(),
  }) }),
  z.object({ command: z.literal("register_publication_bundle"), payload: z.object({
    bundleId: z.string().min(8).max(200),
    members: z.array(z.object({ member: z.enum(["primary", "companion"]), intentId: z.string().min(1), reservationToken: z.string().min(8), expectedRevision: z.number().int().positive() })).length(2),
  }) }),
  z.object({ command: z.literal("cancel_publication_bundle"), payload: z.object({
    bundleId: z.string().min(8).max(200),
    members: z.array(z.object({ member: z.enum(["primary", "companion"]), intentId: z.string().min(1), reservationToken: z.string().min(8), expectedRevision: z.number().int().positive() })).length(2),
    reason: z.string().trim().min(3).max(4_000),
  }) }),
  z.object({ command: z.literal("fail_publication_bundle"), payload: z.object({
    bundleId: z.string().min(8).max(200),
    members: z.array(z.object({ member: z.enum(["primary", "companion"]), intentId: z.string().min(1), reservationToken: z.string().min(8), expectedRevision: z.number().int().positive() })).length(2),
    reason: z.string().trim().min(3).max(4_000),
  }) }),
  z.object({ command: z.literal("create_edit_project"), payload: z.object({ name: z.string().max(120).optional(), episode: z.number().int().positive().optional(), width: z.number().int().min(256).max(7680).optional(), height: z.number().int().min(256).max(7680).optional(), fps: z.number().min(12).max(120).optional(), autoPopulate: z.boolean().optional() }) }),
  z.object({ command: z.literal("save_edit_project"), payload: z.object({ project: z.any(), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("undo_edit_project"), payload: z.object({ editProjectId: z.string().min(3), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("redo_edit_project"), payload: z.object({ editProjectId: z.string().min(3), expectedRevision: z.number().int().positive() }) }),
  z.object({ command: z.literal("export_edit_otio"), payload: z.object({ editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), outputPath: z.string().optional() }) }),
  z.object({ command: z.literal("import_edit_otio"), payload: z.object({ filePath: z.string().min(1), name: z.string().max(120).optional() }) }),
  z.object({ command: z.literal("start_edit_render"), payload: z.object({ editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), outputDirectory: z.string().optional() }) }),
  z.object({ command: z.literal("cancel_edit_render"), payload: z.object({ renderId: z.string().min(3) }) }),
  z.object({ command: z.literal("extract_timeline_frame"), payload: z.object({ editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), timeSeconds: z.number().min(0).optional(), itemId: z.string().optional(), registerAsEndFrame: z.boolean().optional(), registerVariant: z.enum(["start", "end"]).optional() }) }),
  z.object({ command: z.literal("prepare_edit_media_preview"), payload: z.object({ artifactId: z.string().min(1) }) }),
  z.object({ command: z.literal("prepare_edit_media_proxy"), payload: z.object({ artifactId: z.string().min(1) }) }),
]);

registrar.registerTool(
  "execute_command",
  {
    title: "执行幂等写命令",
    description: "Codex/Grok 首选写入口。每次携带 requestId 和 idempotencyKey；相同参数重试返回已持久化业务结果，不同参数复用同一键会拒绝。Review、实际末态观察及 generation checkpoint/attestation 是明确例外：重放返回完整不可变事件字段和只读 Head 提示，但 head/current/eligibleForPass/approvedRawEligible/continuationEligible 不构成重新授权；动态资格必须另读对应 control 刷新。生产 require 模式：生图相关写必须先 acquire_studio_project_write_lease 并传 writeLeaseHolderId+writeLeaseToken（无租约不准写）。generation_unknown 禁止 re-dispatch。scan_project 支持进度通知。",
    inputSchema: {
      projectRoot: projectRootSchema,
      requestId: z.string().min(8).max(160),
      idempotencyKey: z.string().min(8).max(200),
      request: commandRequestSchema,
      writeLeaseHolderId: z.string().trim().min(1).max(128).optional(),
      writeLeaseToken: z.string().trim().regex(/^lease-[a-f0-9]{32}$/u).optional(),
      novelWriteLeaseToken: z.string().regex(/^novel-lease-token-[A-Za-z0-9_-]{43}$/u).optional(),
      novelActorAttribution: novelActorAttributionSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, request, writeLeaseHolderId, writeLeaseToken, novelWriteLeaseToken, novelActorAttribution }, extra) => {
    const scanBridge = createScanRequestBridge(extra, request.command === "scan_project");
    try {
      if (isManagedStudioCommand(request.command)) await inspectManagedProject(projectRoot);
      if ((request.command === "resolve_studio_entity_proposal"
        || request.command === "confirm_studio_panel_empty"
        || request.command === "submit_studio_generation_review"
        || request.command === "attest_studio_generation_checkpoint")
        && request.payload.reviewer !== "codex") {
        throw new Error("MCP/Codex 的 Studio 裁决 reviewer 必须是 codex；用户裁决只能由桌面 UI 写入。");
      }
      let executionRoot = projectRoot;
      let executionRequest = request as CommandRequest;
      if (request.command === "stage_dudu_readonly_managed_project") {
        // stage 前目标工程尚不存在；账本固定在 canonical projectsRoot 下的独立
        // transaction root。禁止用 storageRoot 镜像，否则会形成两份命令账本。
        const outerCommandRoot = await resolveDuduReadonlyImportCommandRoot(projectRoot);
        const payloadCommandRoot = await resolveDuduReadonlyImportCommandRoot(request.payload.projectsRoot);
        if (outerCommandRoot !== payloadCommandRoot) {
          throw new Error("Dudu bootstrap execute_command 的 projectRoot 与 payload.projectsRoot 不一致。");
        }
        executionRoot = outerCommandRoot;
        executionRequest = {
          ...request,
          payload: {
            ...request.payload,
            projectsRoot: path.dirname(outerCommandRoot),
          },
        } as CommandRequest;
      }
      const importStorageRoot = request.command === "commit_project_import"
        ? await ensureImportCommandStorageRoot(request.payload.config.primaryRoot)
        : undefined;
      const record = await executeIdempotentCommand(executionRoot, { requestId, idempotencyKey, request: executionRequest }, {
        // P2-2（MCP F10）：commit_project_import 双入口统一账本根到 import-transactions（防同一幂等键双账本重复导入）。
        ...(importStorageRoot ? { storageRoot: importStorageRoot } : {}),
        signal: scanBridge.signal,
        onProgress: scanBridge.onProgress,
        ...(writeLeaseHolderId ? { writeLeaseHolderId } : {}),
        ...(writeLeaseToken ? { writeLeaseToken } : {}),
        ...(novelWriteLeaseToken ? { novelWriteLeaseToken } : {}),
        ...(novelActorAttribution ? { novelActorAttribution } : {}),
        studioWriteActor: "codex",
      });
      const focusJobId = request.command === "process_generation_queue" ? request.payload.jobId : undefined;
      return structuredResult(sanitizeCommandRecord(record, focusJobId, executionRoot));
    }
    catch (error) { return toolError(error, { requestId, idempotencyKey, command: request.command }); }
    finally { await scanBridge.flush(); }
  },
);

registrar.registerTool(
  "list_command_ledger",
  {
    title: "读取幂等命令账本",
    description: "读取最近命令的 requestId、幂等键、命令类型、哈希和结果，用于中断恢复和重复提交审计。scope=project 读取工程账本；scope=dudu-bootstrap 时 projectRoot 必须是 projectsRoot，并只映射到固定 bootstrap transaction root，不猜测或合并其他账本。状态包括 running、succeeded、cancelled 与 unknown。",
    inputSchema: {
      projectRoot: projectRootSchema,
      scope: z.enum(["project", "dudu-bootstrap"]).default("project"),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, scope, limit }) => {
    try {
      const ledgerRoot = scope === "dudu-bootstrap"
        ? await resolveDuduReadonlyImportCommandRoot(projectRoot)
        : projectRoot;
      return textResult((await listCommandLedger(ledgerRoot, limit)).map((record) => sanitizeCommandRecord(record)));
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "reconcile_command",
  {
    title: "对账未确认命令",
    description: "仅当追加式审计中存在同一幂等键的真实终态副作用证据时，才把 running/unknown 命令对账为 succeeded；不会重新执行原命令。scope=dudu-bootstrap 时 projectRoot 必须是 projectsRoot，并只映射到固定 bootstrap transaction root。cancelled 是已确认终态，不会推断成成功。",
    inputSchema: {
      projectRoot: projectRootSchema,
      scope: z.enum(["project", "dudu-bootstrap"]).default("project"),
      idempotencyKey: z.string().min(8).max(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, scope, idempotencyKey }) => {
    try {
      const ledgerRoot = scope === "dudu-bootstrap"
        ? await resolveDuduReadonlyImportCommandRoot(projectRoot)
        : projectRoot;
      return structuredResult(sanitizeCommandRecord(await reconcileCommand(ledgerRoot, { idempotencyKey })));
    }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_edit_media",
  {
    title: "列出剪辑素材库",
    description: "从真实扫描索引读取可解码的视频和图片素材；不返回二进制内容。",
    inputSchema: { projectRoot: projectRootSchema, episode: z.number().int().positive().optional(), limit: z.number().int().min(1).max(1_000).default(300) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, episode, limit }) => {
    try {
      const media = await withEditor((editor) => editor.listEditMedia(projectRoot, episode));
      return textResult({ total: media.length, media: media.slice(0, limit) });
    } catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "prepare_edit_media_preview",
  {
    title: "按需生成剪辑媒体预览",
    description: "为单个真实素材生成并缓存图片缩略图、五帧视频胶片条或音频波形；不会批量处理全项目或修改源素材。",
    inputSchema: { projectRoot: projectRootSchema, artifactId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, artifactId }) => {
    try { return textResult(await withEditor((editor) => editor.prepareEditMediaPreview(projectRoot, artifactId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "prepare_edit_media_proxy",
  {
    title: "生成本地剪辑代理",
    description: "为可解码视频生成最长边 1280 的 H.264 代理文件；预览可使用代理，正式导出仍使用原素材。",
    inputSchema: { projectRoot: projectRootSchema, artifactId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, artifactId }) => {
    try { return textResult(await withEditor((editor) => editor.prepareEditMediaProxy(projectRoot, artifactId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "start_edit_render",
  {
    title: "后台启动剪辑导出",
    description: "立即返回 running 任务，FFmpeg 在后台导出；同一项目最多一个活动成片导出，必须等待完成或用 cancel_edit_render 取消后才能启动下一项。输出目录必须位于项目允许根内。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), outputDirectory: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, expectedRevision, outputDirectory }) => {
    try { return textResult(await withEditor((editor) => editor.startEditRender(projectRoot, editProjectId, { expectedRevision, outputDirectory }))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "get_edit_render_job",
  {
    title: "读取后台导出进度",
    description: "读取单个后台导出任务的状态、0–1 进度、PID、输出和短错误；不返回巨型日志。",
    inputSchema: { projectRoot: projectRootSchema, renderId: z.string().min(3) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, renderId }) => {
    try { return textResult(await withEditor((editor) => editor.getEditRenderJob(projectRoot, renderId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "cancel_edit_render",
  {
    title: "取消后台剪辑导出",
    description: "请求终止当前 FFmpeg 进程并把任务标记为 cancelled；不会删除源素材。可能保留未完成的输出文件以供审计。",
    inputSchema: { projectRoot: projectRootSchema, renderId: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, renderId }) => {
    try { return textResult(await withEditor((editor) => editor.cancelEditRender(projectRoot, renderId))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_edit_render_jobs",
  {
    title: "读取剪辑导出记录",
    description: "读取导出状态、输出路径、命令记录和日志路径，不返回巨型日志。",
    inputSchema: { projectRoot: projectRootSchema, limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, limit }) => {
    try { return textResult((await withEditor((editor) => editor.listEditRenderJobs(projectRoot))).slice(0, limit)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "extract_timeline_frame",
  {
    title: "提取时间线合成帧",
    description: "在指定时间或成片最后一帧渲染多轨、滤镜、变换和字幕的真实合成 PNG，并记录源片段/素材/节点来源链；可登记为节点新尾帧。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3), expectedRevision: z.number().int().positive(), timeSeconds: z.number().min(0).optional(), itemId: z.string().optional(), registerAsEndFrame: z.boolean().default(false), registerVariant: z.enum(["start", "end"]).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, expectedRevision, timeSeconds, itemId, registerAsEndFrame, registerVariant }) => {
    try { return textResult(await withEditor((editor) => editor.extractTimelineFrame(projectRoot, { editProjectId, expectedRevision, timeSeconds, itemId, registerAsEndFrame, registerVariant }))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "prepare_timeline_continuation",
  {
    title: "从时间线末帧准备续视频",
    description: "幂等一键闭环：锁定剪辑修订，提取含画中画/滤镜/字幕的合成末帧，登记为目标节点新首帧，写入素材血缘，创建续接包并默认加入视频生成队列。",
    inputSchema: { projectRoot: projectRootSchema, requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200), editProjectId: z.string().min(3), targetItemId: z.string().min(1), expectedRevision: z.number().int().positive(), timeSeconds: z.number().min(0).optional(), prompt: z.string().max(30_000).optional(), providerId: z.string().max(120).optional(), enqueue: z.boolean().default(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, requestId, idempotencyKey, editProjectId, targetItemId, expectedRevision, timeSeconds, prompt, providerId, enqueue }) => {
    try { return structuredResult(await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "prepare_timeline_continuation", payload: { editProjectId, targetItemId, expectedRevision, timeSeconds, prompt, providerId, enqueue } } })); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_timeline_frames",
  {
    title: "读取合成帧来源历史",
    description: "读取时间线合成帧路径、工程修订、时间点及源片段/素材/节点 ID，不返回图片数据。",
    inputSchema: { projectRoot: projectRootSchema, editProjectId: z.string().min(3).optional(), limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, editProjectId, limit }) => {
    try { return textResult(await withEditor((editor) => editor.listTimelineFrameExtractions(projectRoot, editProjectId, limit))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "extract_last_frame",
  {
    title: "提取视频最后一帧",
    description: "从指定节点视频或显式视频路径提取最后可解码帧，输出新的尾帧 raw PNG、机械验图并登记回原节点。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1), artifactId: z.string().optional(), videoPath: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, artifactId, videoPath }) => {
    try { return textResult(await withEditor((editor) => editor.extractLastFrame(projectRoot, { itemId, artifactId, videoPath }))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "create_video_continuation",
  {
    title: "创建末帧续视频任务包",
    description: "把已提取末帧标记为下一段视频 first-frame 参考，生成提示词、硬锁、上传白名单、输出目录和验收条件。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().min(1), sourceVideoPath: z.string().min(1).optional(), lastFramePath: z.string().min(1), prompt: z.string().max(30_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ projectRoot, itemId, sourceVideoPath, lastFramePath, prompt }) => {
    try { return textResult(await withEditor((editor) => editor.createVideoContinuationPack(projectRoot, { itemId, sourceVideoPath, lastFramePath, prompt }))); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "list_video_continuations",
  {
    title: "列出末帧续视频任务",
    description: "读取可恢复的末帧续视频任务包、上传参考、供应商状态和新视频路径。",
    inputSchema: { projectRoot: projectRootSchema, itemId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectRoot, itemId, limit }) => {
    try { return textResult((await withEditor((editor) => editor.listVideoContinuationPacks(projectRoot, itemId))).slice(0, limit)); }
    catch (error) { return toolError(error); }
  },
);

registrar.registerTool(
  "update_video_continuation",
  {
    title: "放弃未入队的末帧续视频包",
    description: "仅允许按修订号放弃尚未绑定 GenerationJob 的续接包。已入队包是生成任务的只读投影，必须通过网页生成检查点、队列处理和对账接口推进，禁止独立回写提交或完成。",
    inputSchema: {
      projectRoot: projectRootSchema,
      continuationId: z.string().min(8),
      expectedRevision: z.number().int().positive(),
      status: z.enum(["failed", "cancelled"]),
      error: z.string().trim().min(1).max(8_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectRoot, continuationId, expectedRevision, status, error }) => {
    try { return textResult(await withEditor((editor) => editor.updateVideoContinuationPack(projectRoot, continuationId, { expectedRevision, status, error }))); }
    catch (cause) { return toolError(cause); }
  },
);

function jsonResource(uri: URL | string, value: unknown) {
  return { contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

async function resolveProjectById(projectId: string) {
  const project = (await listProjects()).find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`找不到已登记且可访问的项目：${projectId}`);
  return project;
}

server.registerResource(
  "server-capabilities",
  "aicanvas://server/capabilities",
  { title: "AI 漫剧画布能力清单", description: "Codex 可用工具域、安全边界、剪辑能力和适配器。", mimeType: "application/json" },
  async (uri) => jsonResource(uri, await getCapabilities()),
);

server.registerResource(
  "registered-projects",
  "aicanvas://projects",
  { title: "已登记项目", description: "只列出本机登记且当前可访问的项目，不触发扫描。", mimeType: "application/json" },
  async (uri) => jsonResource(uri, { projects: await listProjects() }),
);

server.registerResource(
  "project-snapshot",
  new ResourceTemplate("aicanvas://projects/{projectId}/snapshot", {
    list: async () => ({ resources: (await listProjects()).map((project) => ({ uri: `aicanvas://projects/${project.id}/snapshot`, name: `${project.name} · Codex 快照`, mimeType: "application/json", description: project.primaryRoot })) }),
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "项目统一快照", description: "按稳定 projectId 读取进度、下一任务、验收、队列、硬锁和故事层。", mimeType: "application/json" },
  async (uri, variables) => {
    const projectId = String(variables.projectId ?? "");
    const project = await resolveProjectById(projectId);
    return jsonResource(uri, await getProjectSnapshot(project.primaryRoot));
  },
);

server.registerResource(
  "project-item",
  new ResourceTemplate("aicanvas://projects/{projectId}/items/{itemId}", {
    list: undefined,
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "生产节点", description: "读取一个节点及其真实素材路径和机械验收。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    return jsonResource(uri, await getItem(project.primaryRoot, String(variables.itemId ?? "")));
  },
);

server.registerResource(
  "project-artifact",
  new ResourceTemplate("aicanvas://projects/{projectId}/artifacts/{artifactId}", {
    list: undefined,
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "素材版本", description: "读取素材路径、类型、版本、权威状态、机械验收和所属节点。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    const index = await getProjectIndex(project.primaryRoot);
    const artifact = index.artifacts.find((candidate) => candidate.id === String(variables.artifactId ?? ""));
    if (!artifact) throw new Error(`找不到素材版本：${String(variables.artifactId ?? "")}`);
    const item = index.items.find((candidate) => candidate.id === artifact.itemId);
    return jsonResource(uri, { artifact, item: item ? { id: item.id, title: item.title, status: item.status, episode: item.episode, unit: item.unit, shot: item.shot } : undefined, scanId: index.scanId });
  },
);

server.registerResource(
  "project-canvas",
  new ResourceTemplate("aicanvas://projects/{projectId}/canvas", {
    list: async () => ({ resources: (await listProjects()).map((project) => ({ uri: `aicanvas://projects/${project.id}/canvas`, name: `${project.name} · 画布语义`, mimeType: "application/json" })) }),
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "画布语义", description: "读取导演批注、自定义分组和人工关系线，不返回媒体数据。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    const state = await getCanvasSemanticState(project.primaryRoot);
    return jsonResource(uri, { ...state, entities: state.entities.slice(0, 500).map((entity) => ({ ...entity, body: entity.body.slice(0, 4_000), bodyTruncated: entity.body.length > 4_000 })), links: state.links.slice(0, 1_000) });
  },
);

server.registerResource(
  "project-tasks",
  new ResourceTemplate("aicanvas://projects/{projectId}/tasks", {
    list: async () => ({ resources: (await listProjects()).map((project) => ({ uri: `aicanvas://projects/${project.id}/tasks`, name: `${project.name} · 任务包`, mimeType: "application/json" })) }),
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "任务包", description: "读取可领取任务、批次边界、状态和本地任务包路径。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    return jsonResource(uri, { tasks: (await listTaskPacks(project.primaryRoot)).slice(0, 200) });
  },
);

server.registerResource(
  "generation-job",
  new ResourceTemplate("aicanvas://projects/{projectId}/generation/{jobId}", {
    list: undefined,
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "生成任务", description: "读取一个图片或视频生成任务、外部 ID、检查点与输出路径。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    const job = (await listGenerationJobs(project.primaryRoot)).find((candidate) => candidate.id === String(variables.jobId ?? ""));
    if (!job) throw new Error(`找不到生成任务：${String(variables.jobId ?? "")}`);
    return jsonResource(uri, generationSummary(job));
  },
);

server.registerResource(
  "edit-project",
  new ResourceTemplate("aicanvas://projects/{projectId}/editor/{editProjectId}", {
    list: undefined,
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "剪辑工程", description: "读取剪辑工程修订、轨道和片段；片段数量受资源预算限制。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    const edit = await withEditor((editor) => editor.getEditProject(project.primaryRoot, String(variables.editProjectId ?? "")));
    let remaining = 500;
    return jsonResource(uri, { ...edit, tracks: edit.tracks.map((track) => { const clips = track.clips.slice(0, Math.max(0, remaining)); remaining -= clips.length; return { ...track, clips, clipsTruncated: clips.length < track.clips.length }; }), totalClips: edit.tracks.reduce((sum, track) => sum + track.clips.length, 0) });
  },
);

server.registerResource(
  "story-chapter",
  new ResourceTemplate("aicanvas://projects/{projectId}/story/chapters/{chapterId}", {
    list: undefined,
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "故事章节", description: "读取一个已导入原文章节的文本证据和元数据。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    return jsonResource(uri, await readStoryChapter(project.primaryRoot, String(variables.chapterId ?? "")));
  },
);

server.registerResource(
  "project-changes",
  new ResourceTemplate("aicanvas://projects/{projectId}/changes/{cursor}", {
    list: undefined,
    complete: { projectId: async (value) => (await listProjects()).map((project) => project.id).filter((id) => id.includes(value)).slice(0, 20) },
  }),
  { title: "增量变更游标", description: "按事件 ID 游标读取扫描、任务、生成、验收、剪辑和画布变更；使用 start 从保留窗口起点读取。", mimeType: "application/json" },
  async (uri, variables) => {
    const project = await resolveProjectById(String(variables.projectId ?? ""));
    return jsonResource(uri, await getProjectChanges(project.primaryRoot, String(variables.cursor ?? "start"), 200));
  },
);

function promptMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

const promptProjectRoot = z.string().min(1).describe("已导入 AI 漫剧项目的绝对路径");

server.registerPrompt(
  "managed_studio_lock_generate_writeback",
  {
    title: "受管 Studio：读锁→生图→写回→审",
    description: "标准短环：同一受管工程上读取锁定人物/场景/道具与提示词，冻结 pack，agent 生图后 register 写回，再 Review；不查库、不粘贴全书。",
    argsSchema: {
      projectRoot: promptProjectRoot.optional(),
      provider: z.enum(["codex", "grok"]),
      unitId: z.string().min(1).optional().describe("可选 15 秒单元 ID"),
      panelId: z.string().min(1).optional().describe("可选宫格 ID"),
    },
  },
  async ({ projectRoot, provider, unitId, panelId }) => {
    const active = projectRoot ? undefined : await getActiveManagedStudioContext();
    const resolvedRoot = projectRoot ?? active!.projectRoot;
    return promptMessage([
      `受管 Studio 标准环 · 项目主根：${resolvedRoot}`,
      `执行供应方：${provider}`,
      active ? `活动项目令牌：${active.projectContextToken}` : "显式项目路径模式：写回前仍须读取活动上下文令牌",
      unitId ? `焦点单元：${unitId}` : "焦点：从驾驶舱 queue / readiness 自选 generation-ready 格",
      panelId ? `焦点宫格：${panelId}` : "",
      "",
      "只读（同一 projectId，勿查 SQLite/CAS 路径）：",
      "1) get_managed_studio_overview → project.id",
      "2) get_studio_production_dashboard(operation=overview|units|assets|queue)",
      "3) get_studio_binding_control / get_studio_generation_control(operation=readiness) 取已锁定人物·场景·道具与提示词锁",
      "3b) 若已取回 get_studio_trace(operation=script-revision-impact)，把该页作为 get_studio_script_library_projection(operation=ssl5-missing-to-gen-plan).revisionImpact 传入；未取回不要为了 ssl5 去查",
      "4) 未锁定/歧义/未命中 → 停止并请用户确认，禁止偷选第一候选",
      "",
      "写入（仅 execute_command，带稳定 requestId/idempotencyKey）：",
      "5) freeze_studio_generation_pack（generation-ready 且 revision 匹配）；unit-grid 必须显式 targetKind=unit-grid",
      `6) create_studio_generation_plan → get_studio_generation_control(operation=plan) 看 envelope nextAction；wait/retry/Review 时禁止 dispatch；仅 planned 才 dispatch_studio_generation_pack(provider=${provider})；若已取回 script-revision-impact，create-plan/dispatch 须带同一 revisionImpact（unexpected 则写路径拒绝）；未取回不要为了写命令去查；unit-grid 真正调用模型前必须 prepare_studio_imagegen_call`,
      "7) 仅首次 prepare 返回 callAllowed=true 时允许调用一次 imagegen；候选与回执只能写返回的 quarantine 精确路径；重放/恢复 callAllowed=false，必须先对账，禁止再次调用",
      "8) execute_command(commit_agent_imagegen_result_bundle)：必填活动 projectContextToken/provider/raw SHA/executionReceipt.callId，本地派生 labeled 并原子成对登记",
      "   Grok live source=grok-build-imagine，必须提交一次工具调用直观测字段与 quarantine 回执文件；cryptographicProviderReceipt=false，不得冒充供应商签名回执",
      "9) get_studio_generation_control(history order=newest-first|call|detached-unknown|pack) 看 envelope nextAction 与 consistencyPeek 对账调用与结果身份；Review 时禁止再 dispatch，交给 Review/连续性门",
      "",
      "禁止：第二套库、自动绑定偷选、浏览器/Artlist 供应链、把机械 pass 当视觉通过、覆盖权威素材。",
    ].filter(Boolean).join("\n"));
  },
);

server.registerPrompt(
  "resume_project",
  { title: "从真实文件接续项目", description: "让 Codex 先体检和读取统一快照，再继续最高优先级任务。", argsSchema: { projectRoot: promptProjectRoot, focusItemId: z.string().optional() } },
  async ({ projectRoot, focusItemId }) => promptMessage(`连接本机 AI 漫剧画布，项目主根：\n${projectRoot}\n\n先调用 get_capabilities，再调用 doctor_project。若医生报告 generation submission_unknown，先读取 get_project_snapshot：网页任务读取对应 get_browser_generation_plan；HTTP 任务读取 httpSubmissionCheckpoint.revision，并在供应商侧按 clientJobId 对账后调用 reconcile_http_generation_submission(found/not_found)。两类任务都禁止领取新任务、再次点击提交或调用队列自动重 POST。若医生报告 production-evidence-drift 或 production-evidence-verification，先调用 get_production_workflow 读取具体阶段和证据问题，再读取 get_project_snapshot.productionDesign.evidence.nextRepair；修复真实证据后，使用其中的 request/payload 和当前修订，经 execute_command(command=update_workflow_stage) 完成核验。每成功修复一个阶段都重新读取快照，Doctor 复检通过前禁止领取下游任务。若医生提示扫描过期，使用稳定 requestId/idempotencyKey 通过 execute_command(command=scan_project) 扫描；随后调用 get_project_snapshot${focusItemId ? `，focusItemId=${focusItemId}` : ""}。所有写操作都使用 execute_command；相同幂等键若为 running/unknown，先对账真实文件和审计事件，禁止盲目重放。只以真实文件、机械验收和视觉验收记录判断进度，不根据聊天记录猜测。读取焦点节点的 00_信息.md、提示词、硬锁和现有版本后，领取最高优先级任务。新结果必须独立落盘，不覆盖权威素材；每批视觉验收后暂停。`),
);

server.registerPrompt(
  "produce_next_image_batch",
  { title: "制作下一批图片", description: "按不跨集、最多六个单元的门禁创建并完成图片任务包。", argsSchema: { projectRoot: promptProjectRoot, episode: z.string().optional() } },
  async ({ projectRoot, episode }) => promptMessage(`项目主根：${projectRoot}\n目标：继续下一批图片生产${episode ? `，限定第 ${episode} 集` : ""}。\n先 doctor_project → 必要时 execute_command(scan_project) → get_project_snapshot → get_next_task。所有写入都带稳定 requestId/idempotencyKey 走 execute_command：create_task_pack(kind=image, mode=autopilot) 后 claim_task(agentId=当前稳定执行者, leaseSeconds=900)，保存 leaseId/revision，长任务定期 heartbeat_task。逐节点读取真实提示词、硬锁和 raw/labeled 版本；每张图单独生成，新版本落盘后 register_artifact、verify_item。批次不得跨集且最多六项。机械验收后用持有的 leaseId 调用 finish_batch，逐项列出 completed/failed；任务只进入 awaiting_review。导演 submit_review(pass) 后才自动完成，不能虚报视觉通过。`),
);

server.registerPrompt(
  "produce_next_video_batch",
  { title: "制作下一批视频", description: "只处理已通过首尾帧验收的单元，最多三个且不跨集。", argsSchema: { projectRoot: promptProjectRoot, episode: z.string().optional() } },
  async ({ projectRoot, episode }) => promptMessage(`项目主根：${projectRoot}\n目标：继续下一批图生视频${episode ? `，限定第 ${episode} 集` : ""}。\n先读取统一快照，只选择状态为待视频且首尾帧、硬锁和视觉验收完整的 15 秒单元。用 execute_command 创建 create_task_pack(kind=video)，再 claim_task 并保存 leaseId/revision；最多三项且不跨集。随后通过幂等命令 enqueue_generation 或按已配置浏览器流程提交，长任务定期 heartbeat_task。新视频必须独立落盘、可解码并登记回画布；finish_batch 只推进 awaiting_review，视频 submit_review(pass) 后任务才完成。`),
);

server.registerPrompt(
  "run_browser_generation",
  { title: "执行网页生成任务", description: "让 Codex 按白名单、登录态、提交检查点和隔离下载路径安全操作用户配置的生成网站。", argsSchema: { projectRoot: promptProjectRoot, jobId: z.string().min(3) } },
  async ({ projectRoot, jobId }) => promptMessage(`项目主根：${projectRoot}\n网页生成任务：${jobId}\n\n先调用 get_browser_generation_plan，并保存 currentCheckpoint.revision；后续每次回写都使用刚读取的 expectedRevision，成功后重新读取或采用返回的新修订，绝不能用过期修订覆盖另一窗口的进度。第一步核对允许域名、入口 URL、登录态、页面就绪、生成模式、余额/付费风险、模型能力、提示词、语义参考文件和期望输出路径。若登录、页面、模式、额度或付费授权任一未通过，立即用稳定 requestId/idempotencyKey 调用 execute_command(update_browser_generation,status=preflight_blocked)，提交 blockers 和当前可见 observedGeneration；该状态保留同一 job 与 Publication，禁止上传、填词、submit_intent 或点击 Generate。条件恢复后重读当前 revision，以 status=preflight 提交新的全部通过证据；成功预检必须机械比对冻结的 model、aspectRatio、resolution、imageCount，并明确 Generate 可用。第二步只上传 allowedUploads；逐文件记录 path、role、order 和实际 slot，调用 status=uploaded 并提交 uploadEvidence，路径、冻结 SHA-256、首尾帧顺序或语义角色不一致会被拒绝。若 allowedUploads=[]，从当前页面确认参考缩略图数量为 0，再以 uploadEvidence={files:[],observedReferenceThumbnailCount:0} 显式登记 text-only 零上传；不能省略 uploaded 检查点，也不能伪造槽位。不读取或保存 Cookie。第三步再次确认页面没有同一 clientJobId 的既有任务，然后在点击任何可能付费的提交按钮之前，先以新的稳定幂等命令和当前修订调用 status=submit_intent。只有返回 stage=submission_unknown 和新 revision 后才能点击提交一次；点击后立即用该新修订回写 status=submitted 和 externalTaskId。若点击后中断，重启后禁止再次点击，必须通过供应商任务列表、clientJobId 搜索或浏览器历史对账：找到时回写 submitted；确认未找到时提交 submissionReconciliation={method,result:not_found,note} 并将旧任务置 failed，再创建新版本。生成完成后下载原始文件到隔离路径，再以新幂等命令和当前修订回写 status=downloaded；只有远端身份、隔离下载与 downloaded 检查点完整一致，画布才会验证魔数、画幅、尺寸/体积、解码、非占位和新版本路径。任何页面异常、修订冲突、未授权付费动作或语义槽位不确定都持久化为检查点，不跳过门禁、不重复提交。`),
);

server.registerPrompt(
  "continue_video_from_last_frame",
  { title: "从最后一帧续接视频", description: "默认使用时间线合成末帧，建立可回收的续视频任务链。", argsSchema: { projectRoot: promptProjectRoot, itemId: z.string().min(1), editProjectId: z.string().optional(), sourceVideoPath: z.string().optional() } },
  async ({ projectRoot, itemId, editProjectId, sourceVideoPath }) => promptMessage(`项目主根：${projectRoot}\n续接目标节点：${itemId}${editProjectId ? `\n剪辑工程：${editProjectId}` : ""}${sourceVideoPath ? `\n源视频：${sourceVideoPath}` : ""}\n优先使用剪辑时间线合成末帧，因为它包含裁切、画中画、变换、滤镜、转场和字幕。先读取 get_edit_project 的当前修订，再用稳定 requestId/idempotencyKey 调用 prepare_timeline_continuation，它会锁定修订、提取合成帧、登记目标新首帧、写入血缘、创建续接包并通过 enqueue_generation 绑定唯一 GenerationJob。只有没有剪辑工程时才 get_item 后调用 extract_last_frame、create_video_continuation，再调用 enqueue_generation(kind=video, continuation={continuationId, firstFrameArtifactId})；不得让 ready 续接包脱离生成队列。网页流程统一读取 get_browser_generation_plan，并且只通过 execute_command(update_browser_generation) 依次写入 preflight、uploaded、submit_intent、submitted、processing、downloaded。续接包是 GenerationJob 的只读投影，禁止独立回写 submitted/completed，也禁止重复点击付费提交；update_video_continuation 只允许在尚未绑定任务时带 expectedRevision 和原因将包标记 failed/cancelled。遇到 submission_unknown 必须先按 clientJobId 对账。下载后由画布机械验收、PublicationReceipt 与 GenerationJob 自动投影 completed，并停在视频视觉验收。角色、完整黄金面具、道具、服装、场景和运动方向不得变化。`),
);

server.registerPrompt(
  "review_visual_batch",
  { title: "视觉验收当前批次", description: "把机械检查与导演视觉判断分开，逐项记录通过、返工或待定。", argsSchema: { projectRoot: promptProjectRoot, reviewType: z.enum(["image", "video"]).describe("image 或 video") } },
  async ({ projectRoot, reviewType }) => promptMessage(`项目主根：${projectRoot}\n验收类型：${reviewType}\n调用 get_review_queue，逐节点读取真实素材路径并进行视觉检查，同时保存该节点 reviewSnapshot 的 scanId 和所选 artifact 哈希。机械可解码不等于视觉通过。图片必须检查角色身份、硬锁、道具服装、场景连续性、构图、画质和 raw/labeled 配对；视频还要检查动作连续性与时长音频。使用 execute_command(submit_review) 写入每个检查项，并原样回传 expectedScanId 与所选素材的 expectedArtifactHashes；若内容漂移被拒绝，必须刷新队列并重新目视检查，不能复用旧结论。不确定就 pending，有明确问题就 rework 并写清原因。awaiting_review 任务只有全部关联节点 pass 后才自动完成。`),
);

server.registerPrompt(
  "recover_interrupted_work",
  { title: "恢复中断任务", description: "应用或浏览器中断后，通过项目体检、统一快照和变更游标恢复，不重复提交或覆盖。", argsSchema: { projectRoot: promptProjectRoot, lastCursor: z.string().optional(), jobId: z.string().optional() } },
  async ({ projectRoot, lastCursor, jobId }) => promptMessage(`项目主根：${projectRoot}${jobId ? `\n焦点任务：${jobId}` : ""}\n\n这是一次中断恢复。先调用 doctor_project、get_project_snapshot 和 list_command_ledger，不要新建任务。若 Doctor 报告 production-evidence-drift 或 production-evidence-verification，先调用 get_production_workflow 核对 completed 阶段的真实证据；证据漂移必须修复，旧状态必须按 get_project_snapshot.productionDesign.evidence.nextRepair 提供的当前修订和参数经 execute_command(update_workflow_stage) 重新核验，每次成功后刷新快照，复检前不得继续下游任务。${lastCursor ? `读取资源 aicanvas://projects/{projectId}/changes/${lastCursor} 获取游标后的增量变化。` : "读取项目最近事件与当前运行队列。"}核对任务 leaseId/leaseUntil、已存在输出、外部任务 ID、HTTP/浏览器检查点、生成状态和渲染 PID。running/unknown 命令先与真实文件及同键事件对账；只有审计已证明副作用存在时调用 reconcile_command，不能复用原键盲目重放。过期任务租约可由新 agentId 重新领取并留下 lease-expired 审计。若一图一子代理检查点存在，先调用 get_subagent_image_generation_plan：generation_unknown 只能核对既有调用证据，严禁 claim、takeover、cancel、process 或再次调用生图；candidate_generated 必须先核对隔离候选、call receipt 与 raw/labeled Publication bundle，再由主代理目视后执行 visual_accept/visual_rejected；leased 只有 v2 owner/heartbeat/leaseUntil/fence 完整、尚无 callIntent 且确已过期时才能安全接管；generating 失联必须转入 generation_unknown。若网页检查点为 submission_unknown，调用 get_browser_generation_plan 读取 submissionIntent.clientJobId 和当前 revision，绝对不能再次点击提交：在供应商任务列表、clientJobId 搜索或浏览器历史找到任务时，用新幂等键回写 status=submitted 和 externalTaskId；确认没有远端结果时，回写 status=failed，并提交 submissionReconciliation={method,result:not_found,note}。若 HTTP 检查点为 submission_unknown，读取 httpSubmissionCheckpoint.revision，在供应商任务列表、幂等查询或请求日志核对；找到时调用 reconcile_http_generation_submission(result=found,externalTaskId)，明确未建立任务时必须携带 confirmNoRemoteResult=true 和稳定 evidenceReference 调用 result=not_found。该 HTTP 对账命令不发网络请求或重 POST。若任务已 submitted/waiting_remote，只轮询或回收同一任务下载；若本地结果已存在，先机械验收再回写。只有结构化对账确认原任务不可恢复时才创建新版本任务，并记录真实失败原因。`),
);

// 生产默认：写租约 require（无租约不准写生图命令）。测试 setup 会改 compat。
if (!process.env.AI_CANVAS_WRITE_LEASE_MODE) {
  process.env.AI_CANVAS_WRITE_LEASE_MODE = "require";
}

const { acquireMcpProcessGuard, releaseMcpProcessGuard } = await import("../core/mcp-process-guard.js");
const mcpGuard = await acquireMcpProcessGuard({
  note: "ai-drama-canvas-mcp",
  // 信号统一走下方集中 shutdown；守护自带 handler 会在 watcher/transport 释放前
  // 提前 process.exit，截断关闭链。
  registerSignalHandlers: false,
});
if (!mcpGuard.acquired) {
  console.error(`[mcp-process-guard] ${mcpGuard.message}`);
  process.exit(1);
}
if (mcpGuard.mode === "singleton") {
  console.error(`[mcp-process-guard] ${mcpGuard.message}`);
}

// stdio 幂等 shutdown：SDK 的 StdioServerTransport 只订阅 stdin data/error，
// stdin EOF 不会触发 transport.onclose；persistent watcher 会让进程在宿主断开
// 后常驻。stdin end/close、退出信号与 transport 关闭共用同一条一次性释放链。
let mcpShutdownPromise: Promise<void> | null = null;
const shutdownMcpRuntime = (): Promise<void> => {
  mcpShutdownPromise ??= (async () => {
    await closeMcpRuntimeGateWatchers().catch(() => {});
    await server.close().catch(() => {});
    await releaseMcpProcessGuard().catch(() => {});
  })();
  return mcpShutdownPromise;
};
const shutdownMcpRuntimeAndExit = (exitCode: number): void => {
  // 释放链本身挂死时的最后保险：unref 定时器只在事件循环仍被残留句柄
  // 占用时兜底强制退出，不会拖住正常退出。
  const forceExit = setTimeout(() => process.exit(exitCode), 5_000);
  forceExit.unref();
  void shutdownMcpRuntime().finally(() => process.exit(exitCode));
};
// guard 写入 pid 锁后必须立刻接管信号，赶在 chokidar 递归 watcher 启动的真实
// 异步耗时之前；否则该窗口内的信号走 Node 默认终止，锁文件与半启动资源不清理。
process.stdin.once("end", () => shutdownMcpRuntimeAndExit(0));
process.stdin.once("close", () => shutdownMcpRuntimeAndExit(0));
process.once("SIGINT", () => shutdownMcpRuntimeAndExit(130));
process.once("SIGTERM", () => shutdownMcpRuntimeAndExit(143));
process.once("SIGHUP", () => shutdownMcpRuntimeAndExit(129));

await startMcpRuntimeGateWatchers();
const transport = new StdioServerTransport();
// transport.onclose 是被动释放路径：由 server.close()/transport.close() 的发起方
// 决定是否退出进程；资源全释放后事件循环转空即自然退出。
transport.onclose = () => {
  void shutdownMcpRuntime();
};
await server.connect(transport);
