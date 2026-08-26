import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createT23IpcPerformanceProbe } from "./t23-ipc-performance-probe.js";
import { createRendererWindowCloseRequestBridge } from "./window-close-bridge.js";
import type { EditOperation } from "../core/editor.js";
import type {
  CanvasPosition,
  CanvasEntity,
  CanvasHistoryInfo,
  CanvasSemanticLink,
  CanvasSemanticState,
  AgentSkill,
  AgentSkillCategory,
  ContinuationSnapshot,
  ContextSearchHit,
  EditMediaItem,
  EditMediaPage,
  EditMediaQuery,
  EditMediaPreview,
  EditNestedTimelinePreview,
  EditProject,
  EditRenderJob,
  EditorSessionOpenResult,
  EditorSessionResolution,
  EditorSessionState,
  LastFrameExtraction,
  TimelineFrameExtraction,
  GenerationKind,
  GenerationSettings,
  ProjectConfig,
  ProjectImportOptions,
  ProjectImportPreview,
  ProjectImportMode,
  ProjectContextEntry,
  ProjectContextDeleteInput,
  ProjectContextKind,
  ProjectContextUpsertInput,
  ProjectIndex,
  ReviewDecision,
  ReviewRecord,
  ReviewQueueEntry,
  SubmitReviewInput,
  ShotTiming,
  StoryChapter,
  StoryChapterContent,
  StoryContextBundle,
  StoryEvent,
  StoryEventStatus,
  StorySource,
  SubagentImageGenerationUpdateStatus,
  TaskPack,
  UnitTimeline,
  VideoEngineInfo,
  VideoContinuationPack,
  WorkItemStatus,
  CreativeBible,
  CreativeBibleKind,
  CreativeBibleUpsertInput,
  ProductionWorkflow,
  ProductionWorkflowStageId,
  ProductionWorkflowStageStatus,
  ProductionWorkflowStageUpdateInput,
  StoryboardRow,
  StoryboardRowUpsertInput,
  AssetRelation,
  AssetRelationKind,
  AssetRelationUpsertInput,
  VoiceIdentity,
  VoiceIdentityUpsertInput,
  AdaptationPlan,
  AdaptationChangeImpact,
  AdaptationStore,
  AdaptationValidation,
  NarrativeBeat,
  NovelFact,
  NovelAnalysisTask,
  NovelAnalysisReviewItem,
  NovelAnalysisProviderSettings,
  NovelAnalysisRunProgress,
} from "../core/types.js";

export type StudioMediaIpcItem = Omit<import("../core/material-studio.js").StudioMediaMetadata, "objectPath" | "thumbnail"> & {
  mediaUrl: string;
  thumbnail?: Omit<NonNullable<import("../core/material-studio.js").StudioMediaMetadata["thumbnail"]>, "path"> & { url: string };
};

export interface StudioMediaIpcPage {
  items: StudioMediaIpcItem[];
  nextCursor?: string;
}

export interface ManagedProjectOperationIpcState {
  operationId: string;
  kind?: "backup" | "restore";
  phase: "idle" | "running" | "succeeded" | "failed" | "canceled";
  busy: boolean;
  stage: string;
  sourceRoot?: string;
  targetPath?: string;
  error?: string;
  updatedAt: string;
}

export interface LegacyWatcherIdentity {
  projectRoot: string;
  watcherEpoch: number;
}

export interface CanvasSemanticUpdatedEvent extends LegacyWatcherIdentity {
  state: CanvasSemanticState;
}

/** 验收 7：构建身份只读展示；manifest 缺失字段如实为 null。 */
export interface BuildIdentityIpcResult {
  version: string | null;
  buildId: string | null;
  sourceDigest: string | null;
  builtAt: string | null;
  mcpToolCount: number | null;
  runtimeMode: "source-dev" | "packaged";
  manifestPath: string;
  projectRoot: string | null;
}

export type StudioMediaDerivativeIpcItem = Omit<import("../core/studio-media-derivatives.js").StudioMediaDerivativeRecord, "relativePath"> & {
  url?: string;
};

export type StudioMediaDerivativeIpcResult = Omit<import("../core/studio-media-derivatives.js").MaterializeStudioMediaDerivativesResult, "derivatives"> & {
  derivatives: StudioMediaDerivativeIpcItem[];
};

type NovelCoreCommandRequest = import("../core/novel-command-runtime.js").NovelCommandRequest;
type NovelCoreImportCommandRequest = Extract<
  NovelCoreCommandRequest,
  { command: "novel_import_external_snapshot" }
>;

export type NovelDesktopImportCommandRequest = {
  command: "novel_import_external_snapshot";
  payload: Omit<NovelCoreImportCommandRequest["payload"], "projectsRoot">;
};

export type NovelDesktopCommandRequest =
  | Exclude<NovelCoreCommandRequest, { command: "novel_import_external_snapshot" }>
  | NovelDesktopImportCommandRequest;

export type NovelDesktopCommandInput = Omit<import("../core/command-bus.js").IdempotentCommandInput, "request"> & {
  request: NovelDesktopCommandRequest;
};

export type NovelDesktopCommandResult = Omit<
  import("../core/command-bus.js").IdempotentCommandResult,
  "storageRoot" | "durableReconciliation"
>;

export type NovelDesktopPreflightResult = Omit<import("../core/novel-types.js").NovelImportPreflight, "sourcePath" | "sourceRoot"> & {
  sourceName: string;
  authorization: import("../core/novel-import.js").NovelImportPreflightAuthorizationTicket | null;
};

export type NovelDesktopSourceSelection = import("../core/novel-source-selection.js").NovelSourceSelectionTicket;
export type NovelDesktopDestinationSelection = import("../core/novel-destination-selection.js").NovelDestinationSelectionTicket;

const t23PerformanceProbeEnabled = process.env.AI_CANVAS_T23_PERF_PROBE === "1";
const t23IpcPerformanceProbe = createT23IpcPerformanceProbe(
  t23PerformanceProbeEnabled,
  <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>,
);
const rendererWindowCloseRequestBridge = createRendererWindowCloseRequestBridge();
ipcRenderer.on("canvas:window-close-requested", (_event, request: { requestId: string }) => {
  rendererWindowCloseRequestBridge.receive(request);
});

const api = {
  /** T23 源码 dev 验收只读探针；生产默认 disabled 且不累计。 */
  t23PerformanceProbeEnabled,
  recordT23RendererMilestone: (milestone: string): void => {
    t23IpcPerformanceProbe.recordRendererMilestone(milestone, performance.now());
  },
  recordT23StartupRuntimeGate: (
    phase: "baseline" | "first-card" | "final",
    mutationChecks: number,
  ): void => t23IpcPerformanceProbe.recordStartupRuntimeGateSnapshot(phase, mutationChecks),
  getT23IpcPerformanceProbeSnapshot: () => t23IpcPerformanceProbe.snapshot(),
  listProjects: (
    options?: import("../core/service.js").ListProjectsRequestOptions,
  ): ReturnType<typeof import("../core/service.js").listProjects> => ipcRenderer.invoke("canvas:list-projects", options),
  cancelProjectListRequest: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke("canvas:cancel-project-list-request", requestId),
  getActiveProject: (): ReturnType<typeof import("../core/service.js").getActiveProjectReadOnly> => ipcRenderer.invoke("canvas:get-active-project"),
  preflightActiveManagedProjectStartup: (input: Parameters<typeof import("../core/service.js").preflightActiveManagedProjectStartupReadOnly>[0]): ReturnType<typeof import("../core/service.js").preflightActiveManagedProjectStartupReadOnly> =>
    ipcRenderer.invoke("canvas:preflight-active-managed-project-startup", input),
  ensureActiveManagedProjectGenerationWatcher: (input: Parameters<typeof import("../core/service.js").reconcileActiveManagedProjectStartup>[0]): Promise<{ projectId: string }> =>
    ipcRenderer.invoke("canvas:ensure-active-managed-project-generation-watcher", input),
  reconcileActiveManagedProjectStartup: (input: Parameters<typeof import("../core/service.js").reconcileActiveManagedProjectStartup>[0]): ReturnType<typeof import("../core/service.js").reconcileActiveManagedProjectStartup> =>
    ipcRenderer.invoke("canvas:reconcile-active-managed-project-startup", input),
  getManagedProjectOperationState: (): Promise<ManagedProjectOperationIpcState> => ipcRenderer.invoke("canvas:get-managed-project-operation-state"),
  activateProject: (projectRoot: string): ReturnType<typeof import("../core/service.js").activateProject> => ipcRenderer.invoke("canvas:activate-project", projectRoot),
  getManagedProjectShell: (projectRoot: string): ReturnType<typeof import("../core/service.js").getManagedProjectShell> => ipcRenderer.invoke("canvas:get-managed-project-shell", projectRoot),
  validateRestoredManagedProjectShell: (projectRoot: string): ReturnType<typeof import("../core/managed-project.js").inspectManagedProjectReadOnly> =>
    ipcRenderer.invoke("canvas:validate-restored-managed-project-shell", projectRoot),
  releaseRestoredManagedProjectShellValidation: (projectRoot: string): Promise<boolean> =>
    ipcRenderer.invoke("canvas:release-restored-managed-project-shell-validation", projectRoot),
  createManagedStudioProject: (input: import("../core/managed-project.js").CreateManagedProjectOptions): ReturnType<typeof import("../core/service.js").createManagedStudioProject> => ipcRenderer.invoke("canvas:create-managed-studio-project", input),
  getDefaultManagedProjectsRoot: (): Promise<string> => ipcRenderer.invoke("canvas:get-default-managed-projects-root"),
  pickManagedProjectsParent: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke("canvas:pick-managed-projects-parent", defaultPath),
  setActiveStudioContext: (projectRoot: string, context: Parameters<typeof import("../core/sidecar.js").setActiveStudioContext>[1]): ReturnType<typeof import("../core/sidecar.js").setActiveStudioContext> => ipcRenderer.invoke("canvas:set-active-studio-context", projectRoot, context),
  getActiveHybridWorkspacePreference: (projectId: string): ReturnType<typeof import("../core/sidecar.js").getActiveHybridWorkspacePreference> => ipcRenderer.invoke("canvas:get-active-hybrid-workspace-preference", projectId),
  setActiveHybridWorkspacePreference: (projectId: string, mode: Parameters<typeof import("../core/sidecar.js").setActiveHybridWorkspacePreference>[1]): ReturnType<typeof import("../core/sidecar.js").setActiveHybridWorkspacePreference> => ipcRenderer.invoke("canvas:set-active-hybrid-workspace-preference", projectId, mode),
  novel: {
    getWorkspace: (projectRoot: string): ReturnType<typeof import("../core/novel-manuscript.js").getNovelWorkspaceSnapshot> =>
      ipcRenderer.invoke("canvas:novel-get-workspace", projectRoot),
    getNavigation: (
      projectRoot: string,
      page: { offset: number; limit: number; anchorVolumeId?: string },
    ): ReturnType<typeof import("../core/novel-manuscript.js").getNovelWorkspaceNavigation> =>
      ipcRenderer.invoke("canvas:novel-get-navigation", projectRoot, page),
    listChapters: (
      projectRoot: string,
      page: { offset: number; limit: number; volumeId?: string; anchorChapterId?: string },
    ): ReturnType<typeof import("../core/novel-manuscript.js").listNovelChapters> =>
      ipcRenderer.invoke("canvas:novel-list-chapters", projectRoot, page),
    readChapter: (
      projectRoot: string,
      chapterId: string,
    ): ReturnType<typeof import("../core/novel-manuscript.js").readNovelChapter> =>
      ipcRenderer.invoke("canvas:novel-read-chapter", projectRoot, chapterId),
    searchChapters: (
      projectRoot: string,
      input: import("../core/novel-types.js").SearchNovelChaptersInput,
    ): ReturnType<typeof import("../core/novel-manuscript.js").searchNovelChapters> =>
      ipcRenderer.invoke("canvas:novel-search-chapters", projectRoot, input),
    listFacts: (projectRoot: string): Promise<import("../core/novel-memory-authority.js").NovelMemoryAuthorityProjection> =>
      ipcRenderer.invoke("canvas:novel-list-facts", projectRoot),
    getWritingDashboard: (
      projectRoot: string,
      input: import("../core/novel-desktop-writing-os.js").NovelDesktopWritingDashboardInput,
    ): ReturnType<typeof import("../core/novel-desktop-writing-os.js").getNovelDesktopWritingDashboard> =>
      ipcRenderer.invoke("canvas:novel-get-writing-dashboard", projectRoot, input),
    reviewStateCandidate: (
      projectRoot: string,
      input: import("../core/novel-desktop-writing-os.js").NovelDesktopStateCandidateReviewInput,
    ): ReturnType<typeof import("../core/novel-desktop-writing-os.js").reviewNovelDesktopStateCandidate> =>
      ipcRenderer.invoke("canvas:novel-review-state-candidate", projectRoot, input),
    /** @deprecated managed novel/hybrid 的正典变更必须走 Story Bible candidate + owner review。 */
    upsertFact: (
      projectRoot: string,
      input: Parameters<typeof import("../core/adaptation.js").upsertNovelFact>[1],
    ): ReturnType<typeof import("../core/adaptation.js").upsertNovelFact> =>
      ipcRenderer.invoke("canvas:novel-upsert-fact", projectRoot, input),
    pickSource: (
      selectionKind: import("../core/novel-source-selection.js").NovelSourceSelectionKind,
    ): Promise<NovelDesktopSourceSelection | null> =>
      ipcRenderer.invoke("canvas:novel-pick-source", selectionKind),
    pickDestination: (): Promise<NovelDesktopDestinationSelection | null> =>
      ipcRenderer.invoke("canvas:novel-pick-destination"),
    preflightSource: (destinationId: string, selectionId: string): Promise<NovelDesktopPreflightResult> =>
      ipcRenderer.invoke("canvas:novel-preflight-source", destinationId, selectionId),
    executeNovelCommand: (root: string | null, input: NovelDesktopCommandInput): Promise<NovelDesktopCommandResult> =>
      ipcRenderer.invoke("canvas:novel-execute-command", root, input),
  },
  upgradeManagedStudioProject: (projectRoot: string): ReturnType<typeof import("../core/service.js").upgradeManagedStudioProject> => ipcRenderer.invoke("canvas:upgrade-managed-studio-project", projectRoot),
  getMaterialStudioState: (projectRoot: string): ReturnType<typeof import("../core/material-studio.js").getMaterialStudioState> => ipcRenderer.invoke("canvas:get-material-studio-state", projectRoot),
  listStudioMedia: (projectRoot: string, query: import("../core/material-studio.js").StudioMediaListQuery = {}): Promise<StudioMediaIpcPage> => ipcRenderer.invoke("canvas:list-studio-media", projectRoot, query),
  getStudioMedia: (projectRoot: string, sha256: string): Promise<StudioMediaIpcItem | null> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-media", projectRoot, sha256),
  ensureStudioImageThumbnail: (projectRoot: string, sha256: string): Promise<StudioMediaIpcItem> => ipcRenderer.invoke("canvas:ensure-studio-image-thumbnail", projectRoot, sha256),
  getStudioMediaDerivatives: (projectRoot: string, sha256: string): Promise<StudioMediaDerivativeIpcItem[]> => ipcRenderer.invoke("canvas:get-studio-media-derivatives", projectRoot, sha256),
  prepareStudioMediaDerivatives: (projectRoot: string, sha256: string): Promise<StudioMediaDerivativeIpcResult> => ipcRenderer.invoke("canvas:prepare-studio-media-derivatives", projectRoot, sha256),
  listStudioAssets: (projectRoot: string, query: import("../core/material-studio.js").StudioCanonicalAssetListQuery = {}): ReturnType<typeof import("../core/material-studio.js").listStudioCanonicalAssets> => ipcRenderer.invoke("canvas:list-studio-assets", projectRoot, query),
  listGlobalStudioAssets: (query: import("../core/studio-global-asset-catalog.js").GlobalStudioAssetCatalogQuery): ReturnType<typeof import("../core/studio-global-asset-catalog.js").listGlobalStudioAssetCatalog> => ipcRenderer.invoke("canvas:list-global-studio-assets", query),
  listGlobalStudioAssetImages: (query: import("../core/studio-global-asset-catalog.js").GlobalStudioAssetResourceImageQuery): ReturnType<typeof import("../core/studio-global-asset-catalog.js").listGlobalStudioAssetResourceImages> => ipcRenderer.invoke("canvas:list-global-studio-asset-images", query),
  getGlobalStudioAssetImage: (projectRoot: string, mediaSha256: string): ReturnType<typeof import("../core/studio-global-asset-catalog.js").getGlobalStudioAssetResourceImage> => ipcRenderer.invoke("canvas:get-global-studio-asset-image", projectRoot, mediaSha256),
  listGlobalStudioImageResources: (query: import("../core/studio-global-image-resource-catalog.js").GlobalStudioImageResourceQuery): ReturnType<typeof import("../core/studio-global-image-resource-catalog.js").listGlobalStudioImageResources> => ipcRenderer.invoke("canvas:list-global-studio-image-resources", query),
  getGlobalStudioImageResource: (projectRoot: string, mediaSha256: string): ReturnType<typeof import("../core/studio-global-image-resource-catalog.js").getGlobalStudioImageResource> => ipcRenderer.invoke("canvas:get-global-studio-image-resource", projectRoot, mediaSha256),
  listGlobalStudioMediaResources: (query: import("../core/studio-global-asset-catalog.js").GlobalStudioMediaResourceQuery): ReturnType<typeof import("../core/studio-global-asset-catalog.js").listGlobalStudioMediaResources> => ipcRenderer.invoke("canvas:list-global-studio-media-resources", query),
  getGlobalStudioMediaResource: (projectRoot: string, mediaSha256: string): ReturnType<typeof import("../core/studio-global-asset-catalog.js").getGlobalStudioMediaResource> => ipcRenderer.invoke("canvas:get-global-studio-media-resource", projectRoot, mediaSha256),
  getStudioAsset: (projectRoot: string, assetId: string): ReturnType<typeof import("../core/material-studio.js").getStudioCanonicalAsset> => ipcRenderer.invoke("canvas:get-studio-asset", projectRoot, assetId),
  getStudioProductionState: (projectRoot: string): ReturnType<typeof import("../core/studio-production.js").getStudioProductionState> => ipcRenderer.invoke("canvas:get-studio-production-state", projectRoot),
  getStudioGenerationLedgerState: (projectRoot: string): ReturnType<typeof import("../core/studio-generation-ledger.js").getStudioGenerationLedgerState> => ipcRenderer.invoke("canvas:get-studio-generation-ledger-state", projectRoot),
  getStudioGenerationPlanProgress: (projectRoot: string): ReturnType<typeof import("../core/studio-generation-plan-progress.js").buildStudioGenerationPlanProgress> => ipcRenderer.invoke("canvas:get-studio-generation-plan-progress", projectRoot),
  getDuduReadonlyImportControl: (projectRoot: string): ReturnType<typeof import("../core/dudu-readonly-import.js").getDuduReadonlyImportControl> => ipcRenderer.invoke("canvas:get-dudu-readonly-import-control", projectRoot),
  discoverDuduReadonlyImportProjects: (projectsRoot: string): ReturnType<typeof import("../core/dudu-readonly-import.js").discoverDuduReadonlyImportProjects> => ipcRenderer.invoke("canvas:discover-dudu-readonly-import-projects", projectsRoot),
  getStudioVideoPackageControl: (projectRoot: string, query: import("../core/studio-video-package.js").StudioVideoPackageControlQuery): Promise<import("../core/studio-video-package.js").StudioVideoPackagePublicControlLookup> => ipcRenderer.invoke("canvas:get-studio-video-package-control", projectRoot, query),
  getStudioHiggsfieldVideoGenerationControl: (projectRoot: string, intentId: string): Promise<import("../core/studio-higgsfield-video-generation.js").StudioHiggsfieldVideoControl> => ipcRenderer.invoke("canvas:get-studio-higgsfield-video-generation-control", projectRoot, intentId),
  getStudioGenerationControl: (projectRoot: string, query: import("../core/codex.js").StudioGenerationControlQuery): ReturnType<typeof import("../core/codex.js").getStudioGenerationControlEnvelope> => ipcRenderer.invoke("canvas:get-studio-generation-control", projectRoot, query),
  getStudioDetachedUnknownUnitStates: (
    projectRoot: string,
    unitIds: readonly string[],
  ): ReturnType<typeof import("../core/studio-generation-ledger.js").getStudioDetachedGenerationUnknownUnitStates> =>
    ipcRenderer.invoke("canvas:get-studio-detached-unknown-unit-states", projectRoot, unitIds),
    // T9 批量时间线投影
    getApprovedTimelineProjection: (projectRoot: string, query: { season?: string; episode?: string; fastMode?: boolean; unitIds?: string[]; limit?: number }): Promise<import("../core/studio-approved-timeline-projection.js").ApprovedTimelineProjection> =>
      t23IpcPerformanceProbe.invoke("canvas:get-approved-timeline-projection", projectRoot, query),
    // T19 持续生图状态机
    getContinuousGenerationState: (projectRoot: string, input: { season?: string; episode?: string }): Promise<import("../core/studio-continuous-generation-state.js").ContinuousGenerationStateProjection> => ipcRenderer.invoke("canvas:get-continuous-generation-state", projectRoot, input),
    // T15 单元级写租约查询
    getStudioUnitWriteLeases: (projectRoot: string): Promise<import("../core/studio-project-write-lease.js").StudioUnitWriteLeaseProjection> => ipcRenderer.invoke("canvas:get-studio-unit-write-leases", projectRoot),
    // T14 生产诊断（真实状态，禁止推算）
    getStudioProductionDiagnostics: (projectRoot: string): Promise<import("../core/studio-production-diagnostics.js").StudioProductionDiagnostics> => ipcRenderer.invoke("canvas:get-studio-production-diagnostics", projectRoot),
    // 运行时构建身份（版本 / buildId / sourceDigest / fingerprint）
    getRuntimeBuildIdentity: (): Promise<import("../core/build-identity.js").BuildIdentity> => ipcRenderer.invoke("canvas:get-runtime-build-identity"),
    getRuntimeWriteGate: (): Promise<(import("../core/runtime-write-gate.js").RuntimeWriteGateStatus & {
      runtimeGateMetrics?: import("../core/runtime-write-gate.js").RuntimeGateControllerMetrics;
      runtimeIpcMetrics?: import("../core/runtime-ipc-observability.js").RuntimeIpcPerformanceSnapshot;
      runtimeStorageReadMetrics?: import("../core/runtime-storage-observability.js").RuntimeStorageReadMetrics;
    }) | {
      schemaVersion: 1;
      kind: "packaged-runtime-write-gate";
      allowed: true;
      restartRequired: false;
      checkedAt: string;
      reasons: [];
    }> => ipcRenderer.invoke("canvas:get-runtime-write-gate"),
  readStudioMediaBytes: (projectRoot: string, sha256: string): Promise<Uint8Array> => ipcRenderer.invoke("canvas:read-studio-media-bytes", projectRoot, sha256),
  listStudioGenerationPanelHistory: (projectRoot: string, query: import("../core/studio-generation-ledger.js").StudioGenerationPanelHistoryQuery): ReturnType<typeof import("../core/studio-generation-ledger.js").listStudioGenerationPanelHistory> => ipcRenderer.invoke("canvas:list-studio-generation-panel-history", projectRoot, query),
  listStudioGenerationUnitGridHistory: (projectRoot: string, query: import("../core/studio-generation-ledger.js").StudioGenerationUnitGridHistoryQuery): ReturnType<typeof import("../core/studio-generation-ledger.js").listStudioGenerationUnitGridHistory> =>
    t23IpcPerformanceProbe.invoke("canvas:list-studio-generation-unit-grid-history", projectRoot, query),
  getStudioGenerationCheckpointCanvasProjection: (projectRoot: string): ReturnType<typeof import("../core/studio-generation-checkpoint.js").getStudioGenerationCheckpointCanvasProjection> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-generation-checkpoint-canvas-projection", projectRoot),
  getStudioHistoricalGenerationEvidenceByUnit: (projectRoot: string, unitId: string): ReturnType<typeof import("../core/studio-generation-ledger.js").readStudioHistoricalGenerationEvidenceByUnit> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-historical-generation-evidence-by-unit", projectRoot, unitId),
  getStudioGenerationReviewControl: (projectRoot: string, generationRunId: string): ReturnType<typeof import("../core/studio-generation-review.js").getStudioGenerationReviewControl> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-generation-review-control", projectRoot, generationRunId),
  getStudioPostResultObservationControl: (
    projectRoot: string,
    generationRunId: string,
  ): ReturnType<typeof import("../core/studio-post-result-observation.js").getStudioPostResultObservationControl> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-post-result-observation-control", projectRoot, generationRunId),
  getStudioGenerationReviewIdentity: (projectRoot: string, packId: string): Promise<{ packId: string; packFingerprint: string; continuityFingerprint: string }> => ipcRenderer.invoke("canvas:get-studio-generation-review-identity", projectRoot, packId),
  listStudioTextDocuments: (projectRoot: string, query: import("../core/studio-production.js").StudioTextDocumentListQuery = {}): ReturnType<typeof import("../core/studio-production.js").listStudioTextDocuments> => ipcRenderer.invoke("canvas:list-studio-text-documents", projectRoot, query),
  getStudioTextDocument: (projectRoot: string, documentId: string): ReturnType<typeof import("../core/studio-production.js").getStudioTextDocument> => ipcRenderer.invoke("canvas:get-studio-text-document", projectRoot, documentId),
  getLatestStudioTextRevisionMetadata: (projectRoot: string, documentId: string): ReturnType<typeof import("../core/studio-production.js").getLatestStudioTextRevisionMetadata> => ipcRenderer.invoke("canvas:get-latest-studio-text-revision-metadata", projectRoot, documentId),
  getStudioTextRevision: (projectRoot: string, revisionId: string): ReturnType<typeof import("../core/studio-production.js").getStudioTextRevision> => ipcRenderer.invoke("canvas:get-studio-text-revision", projectRoot, revisionId),
  listStudioProductionUnits: (projectRoot: string, query: import("../core/studio-production.js").StudioProductionUnitListQuery = {}): ReturnType<typeof import("../core/studio-production.js").listStudioProductionUnits> => ipcRenderer.invoke("canvas:list-studio-production-units", projectRoot, query),
  getStudioProductionUnit: (projectRoot: string, unitId: string): ReturnType<typeof import("../core/studio-production.js").getStudioProductionUnitSnapshot> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-production-unit", projectRoot, unitId),
  listStudioBindingUnits: (projectRoot: string, query: Parameters<typeof import("../core/studio-binding-control.js").listStudioBindingUnits>[1] = {}): ReturnType<typeof import("../core/studio-binding-control.js").listStudioBindingUnits> => ipcRenderer.invoke("canvas:list-studio-binding-units", projectRoot, query),
  getStudioBindingControl: (projectRoot: string, input: Parameters<typeof import("../core/studio-binding-control.js").getStudioBindingControl>[1]): ReturnType<typeof import("../core/studio-binding-control.js").getStudioBindingControl> => ipcRenderer.invoke("canvas:get-studio-binding-control", projectRoot, input),
  getStudioContinuityReviewControl: (projectRoot: string, input: import("../core/studio-continuity-review-control.js").StudioContinuityReviewControlInput): ReturnType<typeof import("../core/studio-continuity-review-control.js").getStudioContinuityReviewControl> => ipcRenderer.invoke("canvas:get-studio-continuity-review-control", projectRoot, input),
  // P24：追溯只读通道（规范 §2.3）。
  getStudioFrozenPack: (projectRoot: string, packId: string): ReturnType<typeof import("../core/studio-generation-ledger.js").readAnyStudioGenerationFrozenPack> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-frozen-pack", projectRoot, packId),
  getStudioPackCurrentness: (projectRoot: string, packId: string): Promise<import("../core/studio-trace.js").StudioGenerationPackCurrentness> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-pack-currentness", projectRoot, packId),
  getStudioTrace: (
    projectRoot: string,
    selector: { packId?: string; runId?: string; resultId?: string },
  ): Promise<import("../core/studio-trace.js").StudioGenerationTrace> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-trace", projectRoot, selector),
  listStudioTextRevisions: (projectRoot: string, query: { documentId: string; limit?: number; cursor?: string }): ReturnType<typeof import("../core/studio-production.js").listStudioTextRevisions> => ipcRenderer.invoke("canvas:list-studio-text-revisions", projectRoot, query),
  getStudioProductionDashboard: (projectRoot: string, query: import("../core/studio-production-dashboard.js").StudioProductionDashboardQuery): ReturnType<typeof import("../core/studio-production-dashboard.js").getStudioProductionDashboard> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-production-dashboard", projectRoot, query),
  getStudioProductionProjectionBundle: (
    projectRoot: string,
    query: import("../core/studio-production-projection-bundle.js").StudioProductionProjectionBundleQuery,
  ): ReturnType<typeof import("../core/studio-production-projection-bundle.js").buildStudioProductionProjectionBundle> =>
    t23IpcPerformanceProbe.invoke("canvas:get-studio-production-projection-bundle", projectRoot, query),
  previewLocalCreativeProductionUnits: (
    projectRoot: string,
    input: import("../core/local-creative-production-unit-preview.js").LocalCreativeProductionUnitPreviewInput = {},
  ): ReturnType<typeof import("../core/local-creative-production-unit-preview.js").previewLocalCreativeProductionUnits> =>
    ipcRenderer.invoke("canvas:preview-local-creative-production-units", projectRoot, input),
  getLocalCreativeProjectIngestStatus: (
    projectRoot: string,
    query: import("../core/local-creative-project-ingest-status.js").LocalCreativeProjectIngestStatusQuery = {},
  ): ReturnType<typeof import("../core/local-creative-project-ingest-status.js").getLocalCreativeProjectIngestStatus> =>
    ipcRenderer.invoke("canvas:get-local-creative-project-ingest-status", projectRoot, query),
  getStudioMultimediaTimeline: (
    projectRoot: string,
    query: { unitId: string },
  ): ReturnType<typeof import("../core/studio-multimedia-timeline.js").getStudioMultimediaTimelineProjection> =>
    ipcRenderer.invoke("canvas:get-studio-multimedia-timeline", projectRoot, query),
  getStudioScriptMediaAlignBoard: (
    projectRoot: string,
    query: { season: string; episode: string; documentId?: string; revisionId?: string; evidenceDir?: string },
  ): ReturnType<typeof import("../core/studio-script-media-align.js").getStudioScriptMediaAlignBoard> =>
    ipcRenderer.invoke("canvas:get-studio-script-media-align-board", projectRoot, query),
  getStudioScriptSpanMediaMap: (
    projectRoot: string,
    query: { season: string; episode: string; startOffsetUtf16: number; endOffsetUtf16: number; limit?: number },
  ): ReturnType<typeof import("../core/studio-script-library-projection.js").getStudioScriptSpanMediaMap> =>
    ipcRenderer.invoke("canvas:get-studio-script-span-media-map", projectRoot, query),
  planSsl5MissingToGen: (
    projectRoot: string,
    query: { season: string; episode: string; documentId?: string; evidenceDir?: string },
  ): ReturnType<typeof import("../core/studio-ssl5-missing-to-gen.js").planSsl5MissingToGen> =>
    ipcRenderer.invoke("canvas:plan-ssl5-missing-to-gen", projectRoot, query),
  getStudioScriptLibraryIndex: (
    projectRoot: string,
    query: { limit?: number; kind?: "script" | "prompt" } = {},
  ): ReturnType<typeof import("../core/studio-script-library-projection.js").getStudioScriptLibraryIndex> =>
    ipcRenderer.invoke("canvas:get-studio-script-library-index", projectRoot, query),
  getStudioScriptReaderView: (
    projectRoot: string,
    query: {
      documentId?: string;
      revisionId?: string;
      season?: string;
      episode?: string;
      includeBody?: boolean;
      evidenceDir?: string;
    },
  ): ReturnType<typeof import("../core/studio-script-library-reader.js").getStudioScriptReaderView> =>
    ipcRenderer.invoke("canvas:get-studio-script-reader-view", projectRoot, query),
  openStudioStoryboardWizard: (
    projectRoot: string,
    input: {
      scriptRevisionId: string;
      panelCount?: number;
      sourceRange?: { startOffsetUtf16: number; endOffsetUtf16: number };
    },
  ): ReturnType<typeof import("../core/studio-storyboard-wizard.js").openStudioStoryboardWizard> =>
    ipcRenderer.invoke("canvas:open-studio-storyboard-wizard", projectRoot, input),
  loadStudioCanvasLayout: (projectRoot: string): ReturnType<typeof import("../core/studio-canvas-layout-store.js").loadStudioCanvasLayout> => ipcRenderer.invoke("canvas:load-studio-canvas-layout", projectRoot),
  saveStudioCanvasLayout: (projectRoot: string, input: import("../core/studio-canvas-layout-store.js").SaveStudioCanvasLayoutInput): ReturnType<typeof import("../core/studio-canvas-layout-store.js").saveStudioCanvasLayout> => ipcRenderer.invoke("canvas:save-studio-canvas-layout", projectRoot, input),
  runStudioCanvasWorkflowGroup: (
    projectRoot: string,
    group: import("../core/studio-canvas-layout-types.js").StudioCanvasWorkflowGroup,
    options: import("../core/studio-canvas-workflow-runner.js").StudioCanvasWorkflowRunOptions,
  ): ReturnType<typeof import("../core/studio-canvas-workflow-runner.js").runStudioCanvasWorkflowGroup> =>
    ipcRenderer.invoke("canvas:run-studio-canvas-workflow-group", projectRoot, group, options),
  queryStudioAssetTimeline: (projectRoot: string, query: import("../core/studio-production.js").StudioAssetTimelineQuery): ReturnType<typeof import("../core/studio-production.js").queryStudioAssetTimeline> => ipcRenderer.invoke("canvas:query-studio-asset-timeline", projectRoot, query),
  executeStudioCommand: (projectRoot: string, input: import("../core/studio-command-runtime.js").StudioIdempotentCommandInput & { request: import("../core/studio-command-runtime.js").StudioPublicCommandRequest }): ReturnType<typeof import("../core/command-bus.js").executeIdempotentCommand> => ipcRenderer.invoke("canvas:execute-studio-command", projectRoot, input),
  pickStudioMediaFiles: (): Promise<string[]> => ipcRenderer.invoke("canvas:pick-studio-media-files"),
  pickStudioCrossProjectAssetExportRoot: (): Promise<string | null> =>
    ipcRenderer.invoke("canvas:pick-studio-cross-project-asset-export-root"),
  pickStudioCrossProjectAssetPackage: (): Promise<{
    packageRoot: string;
    manifest: import("../core/studio-cross-project-asset-reuse.js").CrossProjectAssetExportManifest;
  } | null> => ipcRenderer.invoke("canvas:pick-studio-cross-project-asset-package"),
  pickAndImportStudioScript: (projectRoot: string): Promise<{ imported: boolean; entryId?: string; unchanged?: boolean; revision?: unknown }> => ipcRenderer.invoke("canvas:pick-and-import-studio-script", projectRoot),
  pickAndImportStudioPrompt: (projectRoot: string): Promise<{ imported: boolean; entryId?: string; unchanged?: boolean; revision?: unknown }> => ipcRenderer.invoke("canvas:pick-and-import-studio-prompt", projectRoot),
  getIndex: (projectRoot?: string, refresh = false): Promise<ProjectIndex> => ipcRenderer.invoke("canvas:get-index", projectRoot, refresh),
  scan: (projectRoot?: string): Promise<ProjectIndex> => ipcRenderer.invoke("canvas:scan", projectRoot),
  cancelScan: (projectRoot?: string): Promise<boolean> => ipcRenderer.invoke("canvas:cancel-scan", projectRoot),
  previewScan: (projectRoot: string): Promise<ProjectIndex> => ipcRenderer.invoke("canvas:preview-scan", projectRoot),
  getCanonicalAssetCatalogState: (projectRoot: string): ReturnType<typeof import("../core/canonical-assets.js").getCanonicalAssetCatalogState> => ipcRenderer.invoke("canvas:get-canonical-asset-catalog-state", projectRoot),
  listCanonicalAssets: (projectRoot: string, input: Pick<NonNullable<Parameters<typeof import("../core/canonical-assets.js").listCanonicalAssets>[1]>, "category" | "search" | "authority"> & { offset: number; limit: number }): ReturnType<typeof import("../core/canonical-assets.js").listCanonicalAssets> => ipcRenderer.invoke("canvas:list-canonical-assets", projectRoot, input),
  getCanonicalAsset: (projectRoot: string, assetId: string): ReturnType<typeof import("../core/canonical-assets.js").getCanonicalAsset> => ipcRenderer.invoke("canvas:get-canonical-asset", projectRoot, assetId),
  previewCanonicalAssetMigration: (projectRoot: string): ReturnType<typeof import("../core/canonical-assets.js").previewCanonicalAssetMigration> => ipcRenderer.invoke("canvas:preview-canonical-asset-migration", projectRoot),
  prepareImport: (options: ProjectImportOptions): Promise<ProjectImportPreview> => ipcRenderer.invoke("canvas:prepare-import", options),
  commitImport: (input: { previewId: string; config: ProjectConfig; projectMode?: ProjectImportMode }): Promise<ProjectIndex> => ipcRenderer.invoke("canvas:commit-import", input),
  listContext: (projectRoot: string, options?: { kind?: ProjectContextKind; tag?: string; itemId?: string; limit?: number }): Promise<ProjectContextEntry[]> => ipcRenderer.invoke("canvas:list-context", projectRoot, options),
  searchContext: (projectRoot: string, query: string, limit?: number): Promise<ContextSearchHit[]> => ipcRenderer.invoke("canvas:search-context", projectRoot, query, limit),
  upsertContext: (projectRoot: string, input: ProjectContextUpsertInput): Promise<ProjectContextEntry> => ipcRenderer.invoke("canvas:upsert-context", projectRoot, input),
  deleteContext: (projectRoot: string, input: ProjectContextDeleteInput): Promise<void> => ipcRenderer.invoke("canvas:delete-context", projectRoot, input),
  listSkills: (projectRoot: string, options?: { enabledOnly?: boolean }): Promise<AgentSkill[]> => ipcRenderer.invoke("canvas:list-skills", projectRoot, options),
  readSkill: (projectRoot: string, skillId: string): Promise<AgentSkill> => ipcRenderer.invoke("canvas:read-skill", projectRoot, skillId),
  saveSkill: (projectRoot: string, input: { id: string; name: string; description: string; category: AgentSkillCategory; enabled: boolean; content: string; expectedUpdatedAt?: string }): Promise<AgentSkill> => ipcRenderer.invoke("canvas:save-skill", projectRoot, input),
  deleteSkill: (projectRoot: string, skillId: string): Promise<void> => ipcRenderer.invoke("canvas:delete-skill", projectRoot, skillId),
  getContinuation: (projectRoot: string, options?: { itemId?: string }): Promise<ContinuationSnapshot> => ipcRenderer.invoke("canvas:get-continuation", projectRoot, options),
  createHandoff: (projectRoot: string, options?: { itemId?: string }): Promise<{ path: string; snapshot: ContinuationSnapshot }> => ipcRenderer.invoke("canvas:create-handoff", projectRoot, options),
  importStoryFile: (projectRoot: string, filePath: string, title?: string): Promise<{ source: StorySource; chapters: StoryChapter[]; warnings: string[] }> => ipcRenderer.invoke("canvas:import-story-file", projectRoot, filePath, title),
  importStoryText: (projectRoot: string, input: { title: string; content: string; kind?: "text" | "markdown" }): Promise<{ source: StorySource; chapters: StoryChapter[]; warnings: string[] }> => ipcRenderer.invoke("canvas:import-story-text", projectRoot, input),
  listStorySources: (projectRoot: string): Promise<StorySource[]> => ipcRenderer.invoke("canvas:list-story-sources", projectRoot),
  listStoryChapters: (projectRoot: string, sourceId?: string): Promise<StoryChapter[]> => ipcRenderer.invoke("canvas:list-story-chapters", projectRoot, sourceId),
  readStoryChapter: (projectRoot: string, chapterId: string): Promise<StoryChapterContent> => ipcRenderer.invoke("canvas:read-story-chapter", projectRoot, chapterId),
  listStoryEvents: (projectRoot: string, options?: { chapterId?: string; itemId?: string; status?: StoryEventStatus; includeOrphans?: boolean }): Promise<StoryEvent[]> => ipcRenderer.invoke("canvas:list-story-events", projectRoot, options),
  upsertStoryEvent: (projectRoot: string, input: Parameters<typeof import("../core/story.js").upsertStoryEvent>[1]): Promise<StoryEvent> => ipcRenderer.invoke("canvas:upsert-story-event", projectRoot, input),
  connectStoryEvents: (projectRoot: string, sourceEventId: string, targetEventId: string): Promise<StoryEvent> => ipcRenderer.invoke("canvas:connect-story-events", projectRoot, sourceEventId, targetEventId),
  buildStoryContext: (projectRoot: string, itemId: string): Promise<StoryContextBundle> => ipcRenderer.invoke("canvas:build-story-context", projectRoot, itemId),
  getAdaptationWorkspace: (projectRoot: string): Promise<AdaptationStore> => ipcRenderer.invoke("canvas:get-adaptation-workspace", projectRoot),
  analyzeNovelChapters: (projectRoot: string, input: { expectedRevision: number }): Promise<AdaptationStore> => ipcRenderer.invoke("canvas:analyze-novel-chapters", projectRoot, input),
  generateAdaptationPlans: (projectRoot: string, input: { expectedRevision: number; episode?: number; startUnit?: number }): Promise<{ workspace: AdaptationStore; plans: AdaptationPlan[] }> => ipcRenderer.invoke("canvas:generate-adaptation-plans", projectRoot, input),
  selectAdaptationPlan: (projectRoot: string, planId: string, expectedRevision: number): Promise<AdaptationStore> => ipcRenderer.invoke("canvas:select-adaptation-plan", projectRoot, planId, expectedRevision),
  materializeAdaptationPlan: (projectRoot: string, input: { expectedRevision: number }): Promise<{ workspace: AdaptationStore; plan: AdaptationPlan; unitPaths: string[]; storyboardRows: StoryboardRow[]; validation: AdaptationValidation }> => ipcRenderer.invoke("canvas:materialize-adaptation-plan", projectRoot, input),
  analyzeAdaptationImpact: (projectRoot: string, input: { factIds?: string[]; beatIds?: string[] }): Promise<AdaptationChangeImpact> => ipcRenderer.invoke("canvas:analyze-adaptation-impact", projectRoot, input),
  regenerateAdaptationScope: (projectRoot: string, input: { planId: string; expectedRevision: number; factIds?: string[]; beatIds?: string[] }): Promise<{ workspace: AdaptationStore; plan: AdaptationPlan; impact: AdaptationChangeImpact; regeneratedUnitIds: string[] }> => ipcRenderer.invoke("canvas:regenerate-adaptation-scope", projectRoot, input),
  createNovelAnalysisTask: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis.js").createNovelAnalysisTask>[1]): Promise<{ workspace: AdaptationStore; task: NovelAnalysisTask }> => ipcRenderer.invoke("canvas:create-novel-analysis-task", projectRoot, input),
  listNovelAnalysisReviews: (projectRoot: string, options?: { status?: NovelAnalysisReviewItem["status"]; taskId?: string }): Promise<NovelAnalysisReviewItem[]> => ipcRenderer.invoke("canvas:list-novel-analysis-reviews", projectRoot, options),
  reviewNovelAnalysisItem: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis.js").reviewNovelAnalysisItem>[1]): Promise<{ workspace: AdaptationStore; review: NovelAnalysisReviewItem; appliedEntity?: NovelFact | NarrativeBeat }> => ipcRenderer.invoke("canvas:review-novel-analysis-item", projectRoot, input),
  reviewNovelAnalysisBatch: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis.js").reviewNovelAnalysisBatch>[1]): Promise<{ workspace: AdaptationStore; reviews: NovelAnalysisReviewItem[]; appliedEntityIds: Record<string,string> }> => ipcRenderer.invoke("canvas:review-novel-analysis-batch", projectRoot, input),
  getNovelAnalysisProviders: (projectRoot: string): Promise<NovelAnalysisProviderSettings> => ipcRenderer.invoke("canvas:get-novel-analysis-providers", projectRoot),
  upsertNovelAnalysisProvider: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").upsertNovelAnalysisProvider>[1]): Promise<NovelAnalysisProviderSettings> => ipcRenderer.invoke("canvas:upsert-novel-analysis-provider", projectRoot, input),
  probeNovelAnalysisProvider: (projectRoot: string, providerId: string): Promise<import("../core/novel-analysis-provider.js").NovelAnalysisProviderProbe> => ipcRenderer.invoke("canvas:probe-novel-analysis-provider", projectRoot, providerId),
  planNovelAnalysisRun: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").planNovelAnalysisRun>[1]): Promise<{ workspace: AdaptationStore; runId: string; tasks: NovelAnalysisTask[]; progress: NovelAnalysisRunProgress }> => ipcRenderer.invoke("canvas:plan-novel-analysis-run", projectRoot, input),
  listNovelAnalysisRuns: (projectRoot: string): Promise<NovelAnalysisRunProgress[]> => ipcRenderer.invoke("canvas:list-novel-analysis-runs", projectRoot),
  getNovelAnalysisRun: (projectRoot: string, runId: string): Promise<NovelAnalysisRunProgress> => ipcRenderer.invoke("canvas:get-novel-analysis-run", projectRoot, runId),
  executeNextNovelAnalysisRunTask: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").executeNextNovelAnalysisRunTask>[1]): Promise<import("../core/novel-analysis-provider.js").ExecuteNextNovelAnalysisRunResult> => ipcRenderer.invoke("canvas:execute-next-novel-analysis-run-task", projectRoot, input),
  replaceNovelAnalysisRunTask: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").replaceNovelAnalysisRunTask>[1]): Promise<Awaited<ReturnType<typeof import("../core/novel-analysis-provider.js").replaceNovelAnalysisRunTask>>> => ipcRenderer.invoke("canvas:replace-novel-analysis-run-task", projectRoot, input),
  executeNovelAnalysisTask: (projectRoot: string, input: Parameters<typeof import("../core/novel-analysis-provider.js").executeNovelAnalysisTask>[1]): Promise<import("../core/novel-analysis-provider.js").ExecuteNovelAnalysisTaskResult> => ipcRenderer.invoke("canvas:execute-novel-analysis-task", projectRoot, input),
  validateAdaptationPlan: (projectRoot: string, planId: string): Promise<AdaptationValidation> => ipcRenderer.invoke("canvas:validate-adaptation-plan", projectRoot, planId),
  upsertNovelFact: (projectRoot: string, input: Parameters<typeof import("../core/adaptation.js").upsertNovelFact>[1]): Promise<NovelFact> => ipcRenderer.invoke("canvas:upsert-novel-fact", projectRoot, input),
  upsertNarrativeBeat: (projectRoot: string, input: Parameters<typeof import("../core/adaptation.js").upsertNarrativeBeat>[1]): Promise<NarrativeBeat> => ipcRenderer.invoke("canvas:upsert-narrative-beat", projectRoot, input),
  exportAdaptation: (projectRoot: string, input: { format: "json" | "markdown"; outputPath: string; planId?: string }): Promise<{ path: string; format: "json" | "markdown" }> => ipcRenderer.invoke("canvas:export-adaptation", projectRoot, input),
  getProductionWorkflow: (projectRoot: string): Promise<ProductionWorkflow> => ipcRenderer.invoke("canvas:get-production-workflow", projectRoot),
  updateProductionWorkflowStage: (projectRoot: string, input: ProductionWorkflowStageUpdateInput): Promise<ProductionWorkflow> => ipcRenderer.invoke("canvas:update-production-workflow-stage", projectRoot, input),
  listCreativeBibles: (projectRoot: string, kind?: CreativeBibleKind): Promise<CreativeBible[]> => ipcRenderer.invoke("canvas:list-creative-bibles", projectRoot, kind),
  upsertCreativeBible: (projectRoot: string, input: CreativeBibleUpsertInput): Promise<CreativeBible> => ipcRenderer.invoke("canvas:upsert-creative-bible", projectRoot, input),
  getStoryboard: (projectRoot: string, itemId?: string): Promise<{ revision: number; rows: StoryboardRow[]; totalDurationSeconds: number; valid: boolean; issues: string[] }> => ipcRenderer.invoke("canvas:get-storyboard", projectRoot, itemId),
  upsertStoryboardRow: (projectRoot: string, input: StoryboardRowUpsertInput): Promise<StoryboardRow> => ipcRenderer.invoke("canvas:upsert-storyboard-row", projectRoot, input),
  buildFusionStoryboardGrid: (projectRoot: string, input: {
    itemId: string;
    override?: import("../core/fusion-storyboard-grid.js").FusionStoryboardGridOverride;
    referenceOverride?: import("../core/fusion-storyboard-grid.js").FusionStoryboardGridReferenceOverride;
  }): Promise<import("../core/fusion-storyboard-grid.js").FusionStoryboardGridContract> => ipcRenderer.invoke("canvas:build-fusion-storyboard-grid", projectRoot, input),
  migrateFusionStoryboardEvidence: (projectRoot: string, input: { itemIds?: string[] } = {}): Promise<import("../core/fusion-storyboard-migration.js").FusionStoryboardEvidenceMigrationResult> => ipcRenderer.invoke("canvas:migrate-fusion-storyboard-evidence", projectRoot, input),
  getFusionStoryboardSheetState: (projectRoot: string, input: Parameters<typeof import("../core/fusion-storyboard-sheet-evidence.js").getFusionStoryboardSheetState>[1]): Promise<import("../core/fusion-storyboard-sheet-evidence.js").FusionStoryboardSheetState> => ipcRenderer.invoke("canvas:get-fusion-storyboard-sheet-state", projectRoot, input),
  listFusionStoryboardSheets: (projectRoot: string, input: Parameters<typeof import("../core/fusion-storyboard-sheet-evidence.js").listFusionStoryboardSheets>[1] = {}): ReturnType<typeof import("../core/fusion-storyboard-sheet-evidence.js").listFusionStoryboardSheets> => ipcRenderer.invoke("canvas:list-fusion-storyboard-sheets", projectRoot, input),
  migrateFusionStoryboardSheets: (projectRoot: string, input: Parameters<typeof import("../core/fusion-storyboard-sheet-migration.js").migrateFusionStoryboardSheets>[1]): Promise<import("../core/fusion-storyboard-sheet-migration.js").FusionStoryboardSheetMigrationResult> => ipcRenderer.invoke("canvas:migrate-fusion-storyboard-sheets", projectRoot, input),
  renderFusionStoryboardSheet: (projectRoot: string, input: import("../core/fusion-storyboard-production.js").RenderCompletedFusionStoryboardSheetInput): Promise<import("../core/fusion-storyboard-production.js").FusionStoryboardSheetProductionResult> => ipcRenderer.invoke("canvas:render-fusion-storyboard-sheet", projectRoot, input),
  getFusionAssetConsistency: (projectRoot: string): Promise<import("../core/fusion-asset-consistency.js").FusionAssetConsistencyState> => ipcRenderer.invoke("canvas:get-fusion-asset-consistency", projectRoot),
  prepareFusionAssetConsistencyReview: (projectRoot: string, input: { batchId?: string }): Promise<{ prepared: boolean; state: import("../core/fusion-asset-consistency.js").FusionAssetConsistencyState; board?: import("../core/fusion-asset-consistency.js").FusionAssetConsistencyReviewBoard }> => ipcRenderer.invoke("canvas:prepare-fusion-asset-consistency-review", projectRoot, input),
  submitFusionAssetConsistencyReview: (projectRoot: string, input: import("../core/fusion-asset-consistency.js").SubmitFusionAssetConsistencyReviewInput): Promise<import("../core/fusion-asset-consistency.js").FusionAssetConsistencyState> => ipcRenderer.invoke("canvas:submit-fusion-asset-consistency-review", projectRoot, input),
  sealFinalFusionAssetConsistencyBatch: (projectRoot: string, input: { batchId: string; expectedRevision: number }): Promise<import("../core/fusion-asset-consistency.js").FusionAssetConsistencyState> => ipcRenderer.invoke("canvas:seal-final-fusion-asset-consistency-batch", projectRoot, input),
  analyzeChangeImpact: (projectRoot: string, input: { targetType: "item" | "story_event" | "hard_lock" | "bible"; targetId: string }) => ipcRenderer.invoke("canvas:analyze-change-impact", projectRoot, input),
  listAssetRelations: (projectRoot: string, options?: { itemId?: string; artifactId?: string; kind?: AssetRelationKind }): Promise<AssetRelation[]> => ipcRenderer.invoke("canvas:list-asset-relations", projectRoot, options),
  upsertAssetRelation: (projectRoot: string, input: AssetRelationUpsertInput): Promise<AssetRelation> => ipcRenderer.invoke("canvas:upsert-asset-relation", projectRoot, input),
  listVoiceIdentities: (projectRoot: string): Promise<VoiceIdentity[]> => ipcRenderer.invoke("canvas:list-voice-identities", projectRoot),
  upsertVoiceIdentity: (projectRoot: string, input: VoiceIdentityUpsertInput): Promise<VoiceIdentity> => ipcRenderer.invoke("canvas:upsert-voice-identity", projectRoot, input),
  listEditProjects: (projectRoot: string): Promise<EditProject[]> => ipcRenderer.invoke("canvas:list-edit-projects", projectRoot),
  getEditorSession: (projectRoot: string): Promise<EditorSessionState | null> => ipcRenderer.invoke("canvas:get-editor-session", projectRoot),
  beginEditorSession: (projectRoot: string): Promise<EditorSessionOpenResult> => ipcRenderer.invoke("canvas:begin-editor-session", projectRoot),
  setEditorSessionProject: (projectRoot: string, sessionId: string, editProjectId: string): Promise<EditorSessionState> => ipcRenderer.invoke("canvas:set-editor-session-project", projectRoot, sessionId, editProjectId),
  resolveEditorSessionRecovery: (projectRoot: string, sessionId: string, choice: "stable" | "latest"): Promise<EditorSessionResolution> => ipcRenderer.invoke("canvas:resolve-editor-session-recovery", projectRoot, sessionId, choice),
  closeEditorSession: (projectRoot: string, sessionId: string): Promise<EditorSessionState | null> => ipcRenderer.invoke("canvas:close-editor-session", projectRoot, sessionId),
  getEditProject: (projectRoot: string, editProjectId: string): Promise<EditProject> => ipcRenderer.invoke("canvas:get-edit-project", projectRoot, editProjectId),
  createEditProject: (projectRoot: string, input?: { name?: string; episode?: number; width?: number; height?: number; fps?: number; autoPopulate?: boolean }): Promise<EditProject> => ipcRenderer.invoke("canvas:create-edit-project", projectRoot, input),
  saveEditProject: (projectRoot: string, project: EditProject, expectedRevision: number): Promise<EditProject> => ipcRenderer.invoke("canvas:save-edit-project", projectRoot, project, expectedRevision),
  applyEditOperation: (projectRoot: string, editProjectId: string, expectedRevision: number, operation: EditOperation): Promise<{ project: EditProject; affectedTrackIds: string[]; affectedClipIds: string[] }> => ipcRenderer.invoke("canvas:apply-edit-operation", projectRoot, editProjectId, expectedRevision, operation),
  getEditHistoryInfo: (projectRoot: string, editProjectId: string): Promise<{ canUndo: boolean; canRedo: boolean; pastCount: number; futureCount: number }> => ipcRenderer.invoke("canvas:get-edit-history-info", projectRoot, editProjectId),
  undoEditProject: (projectRoot: string, editProjectId: string, expectedRevision: number): Promise<EditProject> => ipcRenderer.invoke("canvas:undo-edit-project", projectRoot, editProjectId, expectedRevision),
  redoEditProject: (projectRoot: string, editProjectId: string, expectedRevision: number): Promise<EditProject> => ipcRenderer.invoke("canvas:redo-edit-project", projectRoot, editProjectId, expectedRevision),
  exportEditOtio: (projectRoot: string, editProjectId: string, expectedRevision: number, outputPath?: string): Promise<{ path: string; editProjectId: string; revision: number; clips: number }> => ipcRenderer.invoke("canvas:export-edit-otio", projectRoot, editProjectId, expectedRevision, outputPath),
  importEditOtio: (projectRoot: string, filePath: string, name?: string): Promise<EditProject> => ipcRenderer.invoke("canvas:import-edit-otio", projectRoot, filePath, name),
  listEditMedia: (projectRoot: string, episode?: number): Promise<EditMediaItem[]> => ipcRenderer.invoke("canvas:list-edit-media", projectRoot, episode),
  listEditMediaPage: (projectRoot: string, query?: EditMediaQuery): Promise<EditMediaPage> => ipcRenderer.invoke("canvas:list-edit-media-page", projectRoot, query),
  prepareEditMediaPreview: (projectRoot: string, artifactId: string): Promise<EditMediaPreview> => ipcRenderer.invoke("canvas:prepare-edit-media-preview", projectRoot, artifactId),
  prepareEditMediaProxy: (projectRoot: string, artifactId: string): Promise<EditMediaPreview> => ipcRenderer.invoke("canvas:prepare-edit-media-proxy", projectRoot, artifactId),
  prepareNestedTimelinePreview: (projectRoot: string, parentEditProjectId: string, expectedRevision: number, clipId: string): Promise<EditNestedTimelinePreview> => ipcRenderer.invoke("canvas:prepare-nested-timeline-preview", projectRoot, parentEditProjectId, expectedRevision, clipId),
  probeVideoEngine: (): Promise<VideoEngineInfo> => ipcRenderer.invoke("canvas:probe-video-engine"),
  listEditRenderJobs: (projectRoot: string): Promise<EditRenderJob[]> => ipcRenderer.invoke("canvas:list-edit-render-jobs", projectRoot),
  renderEditProject: (projectRoot: string, editProjectId: string, options: { expectedRevision: number; outputDirectory?: string }): Promise<EditRenderJob> => ipcRenderer.invoke("canvas:render-edit-project", projectRoot, editProjectId, options),
  startEditRender: (projectRoot: string, editProjectId: string, options: { expectedRevision: number; outputDirectory?: string }): Promise<EditRenderJob> => ipcRenderer.invoke("canvas:start-edit-render", projectRoot, editProjectId, options),
  getEditRenderJob: (projectRoot: string, renderId: string): Promise<EditRenderJob> => ipcRenderer.invoke("canvas:get-edit-render-job", projectRoot, renderId),
  cancelEditRender: (projectRoot: string, renderId: string): Promise<EditRenderJob> => ipcRenderer.invoke("canvas:cancel-edit-render", projectRoot, renderId),
  extractTimelineFrame: (projectRoot: string, input: { editProjectId: string; expectedRevision: number; timeSeconds?: number; itemId?: string; registerAsEndFrame?: boolean; registerVariant?: "start" | "end" }): Promise<TimelineFrameExtraction> => ipcRenderer.invoke("canvas:extract-timeline-frame", projectRoot, input),
  prepareTimelineContinuation: (projectRoot: string, input: { editProjectId: string; targetItemId: string; expectedRevision: number; timeSeconds?: number; prompt?: string; providerId?: string; enqueue?: boolean }): Promise<{ extraction: TimelineFrameExtraction; pack: VideoContinuationPack; generationJob?: unknown }> => ipcRenderer.invoke("canvas:prepare-timeline-continuation", projectRoot, input),
  listTimelineFrames: (projectRoot: string, editProjectId?: string, limit?: number): Promise<TimelineFrameExtraction[]> => ipcRenderer.invoke("canvas:list-timeline-frames", projectRoot, editProjectId, limit),
  extractLastFrame: (projectRoot: string, input: { itemId: string; artifactId?: string; videoPath?: string }): Promise<LastFrameExtraction> => ipcRenderer.invoke("canvas:extract-last-frame", projectRoot, input),
  createVideoContinuation: (projectRoot: string, input: { itemId: string; sourceVideoPath?: string; lastFramePath: string; prompt?: string }): Promise<VideoContinuationPack> => ipcRenderer.invoke("canvas:create-video-continuation", projectRoot, input),
  listVideoContinuations: (projectRoot: string, itemId?: string): Promise<VideoContinuationPack[]> => ipcRenderer.invoke("canvas:list-video-continuations", projectRoot, itemId),
  updateVideoContinuation: (projectRoot: string, continuationId: string, input: { expectedRevision: number; status: "failed" | "cancelled"; error: string }): Promise<VideoContinuationPack> => ipcRenderer.invoke("canvas:update-video-continuation", projectRoot, continuationId, input),
  getItem: (projectRoot: string, itemId: string) => ipcRenderer.invoke("canvas:get-item", projectRoot, itemId),
  updateStatus: (projectRoot: string, itemId: string, status: WorkItemStatus, note?: string, authoritativePath?: string) =>
    ipcRenderer.invoke("canvas:update-status", projectRoot, itemId, status, note, authoritativePath),
  saveLayout: (projectRoot: string, viewKey: string, positions: Record<string, CanvasPosition>) =>
    ipcRenderer.invoke("canvas:save-layout", projectRoot, viewKey, positions),
  loadLayout: (projectRoot: string, viewKey: string): Promise<Record<string, CanvasPosition>> =>
    ipcRenderer.invoke("canvas:load-layout", projectRoot, viewKey),
  getCanvasSemanticState: (projectRoot: string): Promise<CanvasSemanticState> => ipcRenderer.invoke("canvas:get-semantic-state", projectRoot),
  upsertCanvasEntity: (projectRoot: string, input: Partial<CanvasEntity> & Pick<CanvasEntity, "kind" | "title">): Promise<{ state: CanvasSemanticState; entity: CanvasEntity }> =>
    ipcRenderer.invoke("canvas:upsert-entity", projectRoot, input),
  moveCanvasEntities: (projectRoot: string, positions: Record<string, CanvasPosition>): Promise<CanvasSemanticState> =>
    ipcRenderer.invoke("canvas:move-entities", projectRoot, positions),
  deleteCanvasEntity: (projectRoot: string, entityId: string): Promise<CanvasSemanticState> => ipcRenderer.invoke("canvas:delete-entity", projectRoot, entityId),
  upsertCanvasLink: (projectRoot: string, input: Partial<CanvasSemanticLink> & Pick<CanvasSemanticLink, "sourceId" | "targetId">): Promise<{ state: CanvasSemanticState; link: CanvasSemanticLink }> =>
    ipcRenderer.invoke("canvas:upsert-link", projectRoot, input),
  deleteCanvasLink: (projectRoot: string, linkId: string): Promise<CanvasSemanticState> => ipcRenderer.invoke("canvas:delete-link", projectRoot, linkId),
  getCanvasHistoryInfo: (projectRoot: string): Promise<CanvasHistoryInfo> => ipcRenderer.invoke("canvas:get-history-info", projectRoot),
  undoCanvasSemanticState: (projectRoot: string): Promise<{ state: CanvasSemanticState; history: CanvasHistoryInfo }> => ipcRenderer.invoke("canvas:undo-semantic", projectRoot),
  redoCanvasSemanticState: (projectRoot: string): Promise<{ state: CanvasSemanticState; history: CanvasHistoryInfo }> => ipcRenderer.invoke("canvas:redo-semantic", projectRoot),
  getReviewQueue: (projectRoot: string, options?: { episode?: number; includeResolved?: boolean }): Promise<ReviewQueueEntry[]> => ipcRenderer.invoke("canvas:get-review-queue", projectRoot, options),
  listReviewRecords: (projectRoot: string, options?: { itemId?: string; decision?: ReviewDecision; limit?: number }): Promise<ReviewRecord[]> => ipcRenderer.invoke("canvas:list-review-records", projectRoot, options),
  submitReview: (projectRoot: string, input: SubmitReviewInput) => ipcRenderer.invoke("canvas:submit-review", projectRoot, input),
  showInFolder: (filePath: string) => ipcRenderer.invoke("canvas:show-in-folder", filePath),
  openPath: (filePath: string) => ipcRenderer.invoke("canvas:open-path", filePath),
  /** 主进程复验并物化拖出复制体；renderer 仅接收一次性 token，不接收任何路径。 */
  prepareStudioMediaExport: (
    projectRoot: string,
    mediaSha256: string,
    suggestedName?: string,
  ): Promise<{
    token: string;
    fileName: string;
    kind: "image" | "video" | "audio";
    mimeType: string;
    sha256: string;
    sizeBytes: number;
    expiresAt: string;
  }> => ipcRenderer.invoke("canvas:prepare-studio-media-export", projectRoot, mediaSha256, suggestedName),
  /** OS 原生拖出：须在独立拖出手柄的 dragstart 内同步调用。 */
  startNativeFileDrag: (token: string): void => {
    ipcRenderer.send("canvas:start-native-file-drag", token);
  },
  backupManagedProject: (projectRoot: string): Promise<{ canceled: true } | { canceled: false; backupRoot: string; fileCount: number; fingerprint: string; createdAt: string }> => ipcRenderer.invoke("canvas:backup-managed-project", projectRoot),
  restoreManagedProject: (): Promise<{ canceled: true } | { canceled: false; projectRoot: string; projectName: string; fileCount: number; fingerprint: string }> => ipcRenderer.invoke("canvas:restore-managed-project"),
  getAgentConnectionStatus: (projectRoot: string): Promise<{
    projectRoot: string;
    serverAvailable: boolean;
    packaged: boolean;
    codex: { installed: boolean; configured: boolean; current: boolean; executable: string | null };
    grok: { installed: boolean; configured: boolean; current: boolean; executable: string | null };
    repairAvailable: boolean;
    repairNeeded: boolean;
    message: string;
  }> => ipcRenderer.invoke("canvas:get-agent-connection-status", projectRoot),
  repairAgentConnections: (projectRoot: string): Promise<{
    backupDirectory: string;
    codex: { installed: boolean; configured: boolean; current: boolean };
    grok: { installed: boolean; configured: boolean; current: boolean };
  }> => ipcRenderer.invoke("canvas:repair-agent-connections", projectRoot),
  pickProject: (title?: string): Promise<string | null> => ipcRenderer.invoke("canvas:pick-project", title),
  pickStorySource: (): Promise<string | null> => ipcRenderer.invoke("canvas:pick-story-source"),
  pickOtio: (): Promise<string | null> => ipcRenderer.invoke("canvas:pick-otio"),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  removeProject: (projectRoot: string): Promise<void> => ipcRenderer.invoke("canvas:remove-project", projectRoot),
  getMcpInfo: (projectRoot: string): Promise<{ serverPath: string; available: boolean; packaged: boolean; transport: "stdio"; toolCount: number; config: string }> =>
    ipcRenderer.invoke("canvas:get-mcp-info", projectRoot),
  getBuildIdentity: (projectRoot?: string): Promise<BuildIdentityIpcResult> => ipcRenderer.invoke("canvas:get-build-identity", projectRoot),
  copyText: (value: string): Promise<void> => ipcRenderer.invoke("canvas:copy-text", value),
  saveProjectConfig: (config: ProjectConfig): Promise<ProjectIndex> => ipcRenderer.invoke("canvas:save-project-config", config),
  listScriptDocuments: (projectRoot: string) => ipcRenderer.invoke("canvas:list-script-documents", projectRoot),
  readScriptDocument: (projectRoot: string, filePath: string) => ipcRenderer.invoke("canvas:read-script-document", projectRoot, filePath),
  saveScriptDocument: (projectRoot: string, filePath: string, content: string, expectedModifiedAt?: string) =>
    ipcRenderer.invoke("canvas:save-script-document", projectRoot, filePath, content, expectedModifiedAt),
  createScriptDocument: (projectRoot: string, input: { episode: number; unit: number; title: string; content?: string }) =>
    ipcRenderer.invoke("canvas:create-script-document", projectRoot, input),
  getUnitTimelines: (projectRoot: string, episode?: number): Promise<UnitTimeline[]> =>
    ipcRenderer.invoke("canvas:get-unit-timelines", projectRoot, episode),
  listContinuityTracks: (
    projectRoot: string,
    query?: import("../core/continuity.js").ContinuityTrackQuery,
  ): Promise<import("../core/continuity.js").ContinuityTrackPage> =>
    ipcRenderer.invoke("canvas:list-continuity-tracks", projectRoot, query),
  getContinuitySpans: (
    projectRoot: string,
    assetId: string,
    query?: import("../core/continuity.js").ContinuitySpanQuery,
  ): Promise<import("../core/continuity.js").ContinuitySpanPage> =>
    ipcRenderer.invoke("canvas:get-continuity-spans", projectRoot, assetId, query),
  auditFusionPanelReferences: (
    projectRoot: string,
  ): Promise<import("../core/fusion-panel-references.js").FusionPanelReferenceAudit> =>
    ipcRenderer.invoke("canvas:audit-fusion-panel-references", projectRoot),
  inspectFusionPanelReferenceCurrentness: (
    projectRoot: string,
  ): Promise<import("../core/fusion-panel-references.js").FusionPanelReferenceCurrentness> =>
    ipcRenderer.invoke("canvas:inspect-fusion-panel-reference-currentness", projectRoot),
  listFusionPanelReferenceResolutions: (
    projectRoot: string,
    query?: import("../core/fusion-panel-references.js").PanelReferenceResolutionQuery,
  ): Promise<import("../core/fusion-panel-references.js").PanelReferenceResolutionPage> =>
    ipcRenderer.invoke("canvas:list-fusion-panel-reference-resolutions", projectRoot, query),
  getFusionPanelReferenceResolution: (
    projectRoot: string,
    contractId: string,
    panelId: string,
  ): Promise<import("../core/fusion-panel-references.js").PanelReferenceResolution> =>
    ipcRenderer.invoke("canvas:get-fusion-panel-reference-resolution", projectRoot, contractId, panelId),
  inspectFusionPanelVisualConstraintCurrentness: (
    projectRoot: string,
  ): Promise<import("../core/fusion-visual-constraint-store.js").FusionPanelVisualConstraintCurrentness> =>
    ipcRenderer.invoke("canvas:inspect-fusion-panel-visual-constraint-currentness", projectRoot),
  getFusionPanelVisualConstraint: (
    projectRoot: string,
    contractId: string,
    panelId: string,
  ): Promise<import("../core/fusion-visual-constraints.js").PanelVisualConstraint> =>
    ipcRenderer.invoke("canvas:get-fusion-panel-visual-constraint", projectRoot, contractId, panelId),
  listDerivedPanelReferenceAssets: (
    projectRoot: string,
    query?: { offset?: number; limit?: number },
  ): Promise<{ total: number; offset: number; limit: number; items: import("../core/fusion-panel-references.js").DerivedPanelReferenceAsset[]; storeRevision: number }> =>
    ipcRenderer.invoke("canvas:list-derived-panel-reference-assets", projectRoot, query),
  saveUnitTimeline: (projectRoot: string, unitId: string, timings: ShotTiming[]): Promise<UnitTimeline> =>
    ipcRenderer.invoke("canvas:save-unit-timeline", projectRoot, unitId, timings),
  createShotTaskPack: (projectRoot: string, unitId: string, mode?: TaskPack["mode"]): Promise<{ task: TaskPack; path: string }> =>
    ipcRenderer.invoke("canvas:create-shot-task-pack", projectRoot, unitId, mode),
  setAuthoritativeArtifact: (projectRoot: string, itemId: string, artifactId: string, note?: string) =>
    ipcRenderer.invoke("canvas:set-authoritative-artifact", projectRoot, itemId, artifactId, note),
  promoteAssetToHardLock: (projectRoot: string, itemId: string, note?: string) =>
    ipcRenderer.invoke("canvas:promote-asset-to-hard-lock", projectRoot, itemId, note),
  getGenerationSettings: (projectRoot: string): Promise<GenerationSettings> => ipcRenderer.invoke("canvas:get-generation-settings", projectRoot),
  saveGenerationSettings: (projectRoot: string, settings: GenerationSettings): Promise<GenerationSettings> =>
    ipcRenderer.invoke("canvas:save-generation-settings", projectRoot, settings),
  listGenerationJobs: (projectRoot: string) => ipcRenderer.invoke("canvas:list-generation-jobs", projectRoot),
  enqueueGeneration: (
    projectRoot: string,
    input: { itemIds: string[]; kind: GenerationKind; providerId?: string; taskId?: string; prompt?: string; fusionStoryboardPanel?: { contractId: string; panelIndex: number } },
  ) => ipcRenderer.invoke("canvas:enqueue-generation", projectRoot, input),
  processGenerationQueue: (projectRoot: string, jobId?: string) => ipcRenderer.invoke("canvas:process-generation-queue", projectRoot, jobId),
  updateSubagentImageGenerationJob: (
    projectRoot: string,
    jobId: string,
    input: {
      expectedRevision: number;
      status: SubagentImageGenerationUpdateStatus;
      agentTaskName?: string;
      owner?: string;
      agentRunId?: string;
      runId?: string;
      callId?: string;
      leaseId?: string;
      fence?: number;
      leaseSeconds?: number;
      generatedPath?: string;
      reviewer?: string;
      reconciliationResult?: "not_invoked" | "candidate_found";
      confirmNoInvocation?: boolean;
      evidenceReference?: string;
      error?: string;
      note?: string;
    },
  ) => ipcRenderer.invoke("canvas:update-subagent-image-generation", projectRoot, jobId, input),
  cancelGenerationJob: (projectRoot: string, jobId: string) => ipcRenderer.invoke("canvas:cancel-generation-job", projectRoot, jobId),
  getTaskCenter: (projectRoot: string) => ipcRenderer.invoke("canvas:get-task-center", projectRoot),
  createTaskPack: (
    projectRoot: string,
    options: { itemIds?: string[]; episode?: number; mode?: TaskPack["mode"]; kind?: "image" | "video" },
  ) => ipcRenderer.invoke("canvas:create-task-pack", projectRoot, options),
  claimTask: (projectRoot: string, taskId: string, input: { agentId?: string; leaseSeconds?: number; expectedRevision: number }): Promise<TaskPack> => ipcRenderer.invoke("canvas:claim-task", projectRoot, taskId, input),
  heartbeatTask: (projectRoot: string, taskId: string, input: { leaseId: string; agentId?: string; leaseSeconds?: number; expectedRevision: number }): Promise<TaskPack> => ipcRenderer.invoke("canvas:heartbeat-task", projectRoot, taskId, input),
  releaseTask: (projectRoot: string, taskId: string, input: { leaseId: string; agentId?: string; expectedRevision: number; reason?: string }): Promise<TaskPack> => ipcRenderer.invoke("canvas:release-task", projectRoot, taskId, input),
  finishBatch: (
    projectRoot: string,
    taskId: string,
    input: { leaseId: string; agentId?: string; expectedRevision: number; status?: "completed" | "blocked"; completedItemIds?: string[]; failedItemIds?: string[]; note?: string },
  ): Promise<TaskPack> => ipcRenderer.invoke("canvas:finish-batch", projectRoot, taskId, input),
  startWatch: (projectRoot: string): Promise<LegacyWatcherIdentity> => ipcRenderer.invoke("canvas:start-watch", projectRoot),
  stopWatch: (projectRoot?: string) => ipcRenderer.invoke("canvas:stop-watch", projectRoot),
  onWindowCloseRequested: (callback: (request: { requestId: string }) => void) => {
    return rendererWindowCloseRequestBridge.subscribe(callback);
  },
  respondToWindowClose: (requestId: string, allow: boolean): void => {
    ipcRenderer.send("canvas:window-close-response", requestId, allow);
  },
  onIndexUpdated: (callback: (index: ProjectIndex) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, index: ProjectIndex) => callback(index);
    ipcRenderer.on("canvas:index-updated", listener);
    return () => ipcRenderer.removeListener("canvas:index-updated", listener);
  },
  onWatchError: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("canvas:watch-error", listener);
    return () => ipcRenderer.removeListener("canvas:watch-error", listener);
  },
  onCanvasSemanticUpdated: (callback: (event: CanvasSemanticUpdatedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: CanvasSemanticUpdatedEvent) => callback(event);
    ipcRenderer.on("canvas:semantic-updated", listener);
    return () => ipcRenderer.removeListener("canvas:semantic-updated", listener);
  },
  onManagedProjectOperationState: (callback: (state: ManagedProjectOperationIpcState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ManagedProjectOperationIpcState) => callback(state);
    ipcRenderer.on("canvas:managed-project-operation-state", listener);
    return () => ipcRenderer.removeListener("canvas:managed-project-operation-state", listener);
  },
  onStudioGenerationProgress: (callback: (payload: { projectId: string; projectionHash: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { projectId: string; projectionHash: string }) => callback(payload);
    ipcRenderer.on("canvas:studio-generation-progress", listener);
    return () => ipcRenderer.removeListener("canvas:studio-generation-progress", listener);
  },
};

contextBridge.exposeInMainWorld("canvasApi", api);
// 必须在低层 listener 与 contextBridge 都已就绪后通知 main；close 请求即使先于
// Vue onMounted 到达，也会由 preload bridge 缓冲。
ipcRenderer.send("canvas:window-close-bridge-ready");

export type CanvasApi = typeof api;
