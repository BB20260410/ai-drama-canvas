import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { upsertAssetRelation, upsertVoiceIdentity } from "./asset-registry.js";
import { deleteCanvasEntity, deleteCanvasLink, redoCanvasSemanticState, undoCanvasSemanticState, upsertCanvasEntity, upsertCanvasLink } from "./canvas-state.js";
import { saveScriptDocument } from "./documents.js";
import { applyEditOperation, cancelEditRender, createEditProject, createVideoContinuationPack, exportEditProjectOtio, extractLastFrame, extractTimelineFrame, importEditProjectOtio, prepareEditMediaPreview, prepareEditMediaProxy, prepareTimelineVideoContinuation, redoEditProject, saveEditProject, startEditRender, undoEditProject, updateVideoContinuationPack, type EditOperation } from "./editor.js";
import { cancelGenerationJob, enqueueGeneration, migrateGenerationExecutionState, processGenerationQueue, reconcileHttpGenerationSubmission, updateBrowserGenerationJob, updateSubagentImageGenerationJob, upsertGenerationProvider } from "./generation.js";
import { createContinuationHandoff, deleteProjectContext, upsertProjectContext } from "./memory.js";
import { commitExistingProductionRecovery, updateProductionWorkflowStage, upsertCreativeBible, upsertStoryboardRow } from "./production.js";
import { submitReview } from "./reviews.js";
import { cancelTask, claimTask, createTaskPack, finishBatch, getProjectIndex, heartbeatTask, promoteAssetToHardLock, registerArtifact, releaseTask, scanAndPersist, setAuthoritativeArtifact, summarizeForMcp, updateStatus, verifyItem, type PersistedScanOptions } from "./service.js";
import {
  appendEvent,
  findEventsByIdempotencyKey,
  getProjectRegistryPath,
  getSidecarPaths,
  readJson,
  withActiveProjectActivationFence,
  writeJsonAtomic,
} from "./sidecar.js";
import {
  getCommandLedgerEntriesByRequestHash,
  getCommandLedgerEntryByIdempotencyKey,
  getCommandLedgerEntryByRequestId,
  listCommandLedgerEntries,
  loadCommandLedger,
  replaceCommandLedger,
  upsertCommandLedgerEntry,
  type CommandLedgerEntry,
} from "./command-ledger-store.js";
import { saveAgentSkill } from "./skills.js";
import { connectStoryEvents, importStoryFile, importStoryText, upsertStoryEvent } from "./story.js";
import { analyzeNovelChapters, exportAdaptation, generateAdaptationPlans, materializeSelectedAdaptationPlan, regenerateAdaptationScope, selectAdaptationPlan, upsertNarrativeBeat, upsertNovelFact } from "./adaptation.js";
import { createShotTaskPack, saveUnitTimeline } from "./timeline.js";
import type { AssetRelationKind, BrowserGenerationUpdateStatus, BrowserPreflightInput, BrowserSubmissionReconciliationInput, BrowserUploadInput, CreativeBibleKind, ProductionWorkflowStageId, ProductionWorkflowStageStatus, ReconcileHttpGenerationSubmissionInput, ShotTiming, SubagentImageGenerationUpdateStatus, SubmitReviewInput, WorkItemStatus } from "./types.js";
import { withProjectLock } from "./locks.js";
import {
  isStudioCommandName,
  parseStudioCommandRequestForCore,
  type StudioRuntimeCommandRequest,
} from "./studio-command-runtime.js";
import { executeStudioCommand } from "./studio-command-executor.js";
import {
  deterministicStudioTimelineRejection,
  rejectP30OrchestrationCommand,
} from "./studio-command-errors.js";
import {
  canonicalNovelCommandRequestForPersistence,
  isNovelImportCommandRequest,
  isNovelWritingSourceImportCommandRequest,
  isNovelCommandName,
  parseNovelCommandRequestForCore,
  type NovelCommandRequest,
} from "./novel-command-runtime.js";
import {
  inspectNovelImportPreflightAuthorization,
  reserveNovelImportPreflightAuthorization,
} from "./novel-import.js";
import {
  assertNovelImportDestinationDoesNotOverlapPreflight,
  commitNovelExternalImport,
  proveCompletedNovelExternalImport,
  resolveNovelImportProjectsRoot,
} from "./novel-import-commit.js";
import { isNovelPreconditionRejectedError, NovelRepository } from "./novel-manuscript.js";
import {
  isNovelWritingStateRejectedError,
  loadNovelWritingStateOperationProof,
} from "./novel-writing-state.js";
import type { NovelActorAttribution } from "./novel-types.js";
import {
  assertConfinedRootIdentity,
  ensureConfinedDirectory,
} from "./confined-project-storage.js";
import { commitProjectImport } from "./importer.js";
import type { EditProject, ProjectConfig, ProjectImportMode, StoryboardRowUpsertInput } from "./types.js";
import {
  runWithOperationContext,
  type NovelImportDestinationExecutionIdentity,
} from "./operation-context.js";
import {
  cancelPublication,
  cancelPublicationBundle,
  failPublication,
  failPublicationBundle,
  preflightPublication,
  preflightPublicationBundle,
  registerPublication,
  registerPublicationBundle,
  type PreflightPublicationInput,
} from "./publication.js";
import { enrichPublicationIntentWithDiagnostics } from "./studio-publication-preflight-diagnostics.js";
import { createNovelAnalysisTask, reviewNovelAnalysisBatch, reviewNovelAnalysisItem, submitNovelAnalysisProposal } from "./novel-analysis.js";
import { executeNextNovelAnalysisRunTask, executeNovelAnalysisTask, isNovelAnalysisExecutionSafetyError, markNovelAnalysisExecutionReconciliationRequired, novelAnalysisExecutionSafeMessage, planNovelAnalysisRun, reconcileNovelAnalysisExecution, replaceNovelAnalysisRunTask, upsertNovelAnalysisProvider } from "./novel-analysis-provider.js";
import { isConfirmedCommandFailure, isRejectedCommandFailure, RejectedCommandFailure } from "./command-outcome.js";
import {
  RetrySafeSqliteBusyError,
  isRetrySafeSqliteBusyError,
  isSqliteBusyError,
  sqliteBusyDetailMessage,
  withSqliteBusyRetry,
  withStudioSqliteBusyDeadline,
  STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS,
} from "./studio-sqlite-busy.js";
import { inspectFusionPackage, type FusionPackageExpectedCounts } from "./fusion-package.js";
import { materializeFusionProject, type FusionAuthorityInput } from "./fusion-production.js";
import { buildFusionReferenceBoard, type FusionReferenceBoardVariant } from "./fusion-references.js";
import { buildFusionStoryboardGridForProject, renderCompletedFusionStoryboardSheetForProject } from "./fusion-storyboard-production.js";
import { buildFusionStoryboardSheetRenderPolicy, inspectFusionStoryboardSheetEvidence, type FusionStoryboardSheetPanelPlacement } from "./fusion-storyboard-sheet-evidence.js";
import { migrateFusionStoryboardSheets, previewFusionStoryboardSheetMigration } from "./fusion-storyboard-sheet-migration.js";
import {
  listFusionStoryboardSheetArtifactSnapshot,
  loadFusionStoryboardSheetRecord,
  loadFusionStoryboardSheetStore,
} from "./fusion-storyboard-sheet-store.js";
import type { FusionStoryboardGridOverride, FusionStoryboardGridReferenceOverride } from "./fusion-storyboard-grid.js";
import { prepareFusionAssetConsistencyReview, sealFinalFusionAssetConsistencyBatch, submitFusionAssetConsistencyReview, type SubmitFusionAssetConsistencyReviewInput } from "./fusion-asset-consistency.js";
import { migrateFusionStoryboardEvidence } from "./fusion-storyboard-migration.js";
import { materializeFusionPanelReferenceResolutions, registerDerivedPanelReferenceArtifact, upsertPanelReferenceOverride } from "./fusion-panel-references.js";
import {
  materializeFusionPanelVisualConstraints,
  loadFusionPanelVisualConstraintStore,
  upsertFusionPanelGoldenMaskRevealAuthorization,
  upsertFusionPanelVisualPresenceOverride,
} from "./fusion-visual-constraint-store.js";
import { FusionPanelVisualConstraintValidationError } from "./fusion-visual-constraints.js";
import {
  loadCanonicalAssetStore,
  migrateCanonicalAssets,
  previewCanonicalAssetMigration,
  type CanonicalAssetSourceSnapshot,
} from "./canonical-assets.js";
import { inspectManagedProject, inspectManagedProjectReadOnly, isManagedProject } from "./managed-project.js";
import {
  proveStudioScriptSectionRevisionAppend,
  type StudioBindingOperationCommand,
} from "./studio-production.js";
import {
  proveStudioBindingOperationOutcome,
} from "./studio-binding-control.js";
import {
  getStudioGenerationPlanProjection,
  listStudioGenerationPlanProjections,
  readStudioImagegenCallContextRebindByRun,
  readStudioImagegenCallEventHistory,
  readStudioImagegenCallIntentByRun,
  readStudioDetachedGenerationUnknownDisposition,
  readStudioGenerationPlanNodeEventHistory,
  readStudioGenerationRunEventHistory,
  sameStudioGenerationUnknownOwnerAbandonDetail,
  studioImagegenContextTokenHash,
  type AbandonStudioGenerationUnknownInput,
  type AbandonStudioDetachedGenerationUnknownInput,
  type AuthorizeStudioUnitGridContinuationWaiverInput,
  type PrepareStudioImagegenCallInput,
  type RebindStudioImagegenCallContextInput,
  type ReconcileStudioImagegenCallInput,
} from "./studio-generation-ledger.js";
import {
  readStudioContinuityOperationReceipt,
  type AppendStudioContinuityCorrectionInput,
  type AppendStudioContinuityObservationInput,
} from "./studio-continuity-ledger.js";
import {
  readStudioGenerationReviewOperationOutcome,
  type SubmitStudioGenerationReviewInput,
} from "./studio-generation-review.js";
import {
  proveStudioPostResultObservationOutcome,
  type SubmitStudioPostResultObservationInput,
} from "./studio-post-result-observation.js";
import {
  readStudioGenerationCheckpointOperationReceipt,
  type AttestStudioGenerationCheckpointInput,
  type RefreshStudioGenerationCheckpointInput,
} from "./studio-generation-checkpoint.js";
import {
  proveAgentImagegenResultBundleOutcome,
} from "./studio-agent-imagegen-result-bundle.js";
import {
  ActiveManagedStudioContextError,
  assertActiveManagedStudioContextToken,
} from "./active-managed-studio-context.js";
import {
  DuduReadonlyControlConflictError,
  discoverDuduReadonlyImportProjects,
  proveDuduReadonlyFinalizationOutcome,
  proveDuduReadonlyStageCommandOutcome,
  resolveDuduReadonlyImportCommandRoot,
  stageDuduReadonlyManagedProject,
  summarizeDuduReadonlyStageResult,
  type StageDuduReadonlyManagedProjectInput,
} from "./dudu-readonly-import.js";
import type { DuduReadonlySourceInput } from "./dudu-readonly-source.js";
import {
  getStudioVideoPackageControl,
  readStudioVideoPackageExportIntentByOperationId,
  type StudioVideoPackageAuthorityInput,
  type StudioVideoPackageExpectedManagedSource,
} from "./studio-video-package.js";
import type {
  AttestStudioHiggsfieldConnectorCapabilityInput,
  RecordStudioHiggsfieldSubmissionInput,
} from "./studio-higgsfield-video-generation.js";
import type {
  reconcileStudioHiggsfieldConnectorRequest,
  HiggsfieldDirectUnlimitedObservation,
} from "./studio-higgsfield-connector-queue.js";
import {
  readStudioMultimediaTimelineBindingByOperationId,
  type AttachStudioMultimediaTimelineMediaInput,
} from "./studio-multimedia-timeline.js";
import {
  materializeLocalCreativeProductionUnits,
  readLocalCreativeProductionUnitMaterializationOutcome,
  type LocalCreativeProductionUnitMaterializationReceipt,
  type MaterializeLocalCreativeProductionUnitsInput,
} from "./local-creative-production-unit-materializer.js";

export type AppendStudioContinuityObservationCommandPayload = Omit<AppendStudioContinuityObservationInput, "operationId">;
export type AppendStudioContinuityCorrectionCommandPayload = Omit<AppendStudioContinuityCorrectionInput, "operationId">;
export type SubmitStudioGenerationReviewCommandPayload = Omit<SubmitStudioGenerationReviewInput, "operationId">
  & { reviewer: "user" | "codex" };
export type SubmitStudioPostResultObservationCommandPayload =
  Omit<SubmitStudioPostResultObservationInput, "operationId" | "observer">
  & { observer: "user" | "codex" };
export type RefreshStudioGenerationCheckpointCommandPayload = Omit<RefreshStudioGenerationCheckpointInput, "operationId">;
export type AttestStudioGenerationCheckpointCommandPayload = Omit<AttestStudioGenerationCheckpointInput, "operationId" | "reviewer">
  & { reviewer: "user" | "codex" };
export type PrepareStudioImagegenCallCommandPayload = Omit<PrepareStudioImagegenCallInput, "commandRequestId">;
export type AuthorizeStudioUnitGridContinuationWaiverCommandPayload =
  AuthorizeStudioUnitGridContinuationWaiverInput;
export type ReconcileStudioImagegenCallCommandPayload = ReconcileStudioImagegenCallInput & { expectedRevision: 0 };
export type AbandonStudioGenerationUnknownCommandPayload = AbandonStudioGenerationUnknownInput & { expectedRevision: 0 };
export type AbandonStudioDetachedGenerationUnknownCommandPayload =
  Omit<AbandonStudioDetachedGenerationUnknownInput, "activeContext"> & { expectedRevision: 0 };
export type RebindStudioImagegenCallContextCommandPayload = RebindStudioImagegenCallContextInput & { expectedRevision: 0 };
export type AttachStudioMultimediaTimelineMediaCommandPayload =
  Omit<AttachStudioMultimediaTimelineMediaInput, "operationId">;
export type MaterializeLocalCreativeProductionUnitsCommandPayload =
  Omit<MaterializeLocalCreativeProductionUnitsInput, "idempotencyKey">;
export type StageDuduReadonlyManagedProjectCommandPayload = StageDuduReadonlyManagedProjectInput & {
  expectedRevision: 0;
  expectedDiscoveryFingerprint: string;
};
export type FinalizeDuduReadonlyManagedProjectCommandPayload = {
  source: DuduReadonlySourceInput;
  expectedRevision: 0;
  expectedDiscoveryFingerprint: string;
  expectedImportFingerprint: string;
  expectedControlFingerprint: string;
};
export type ReconcileDuduReadonlyHistoricalPassesCommandPayload = {
  source: DuduReadonlySourceInput;
  expectedRevision: 0;
  expectedControlFingerprint: string;
};
export type PrepareStudioVideoPackageExportCommandPayload = {
  authority: StudioVideoPackageAuthorityInput;
  expectedRevision: number;
  expectedControlFingerprint: string;
  expectedManagedSource?: StudioVideoPackageExpectedManagedSource;
};
export type BuildStudioVideoPackageCommandPayload = {
  intentId: string;
  expectedRevision: number;
  expectedIntentControlFingerprint: string;
  expectedAuthorityControlFingerprint: string;
  destinationPolicy: "managed-evidence-only";
};
export type PrepareStudioHiggsfieldVideoGenerationCommandPayload = {
  intentId: string;
  expectedVideoPackageControlFingerprint: string;
  projectContextToken: string;
};
export type RecordStudioHiggsfieldVideoSubmissionCommandPayload = RecordStudioHiggsfieldSubmissionInput;
export type AttestStudioHiggsfieldConnectorCapabilityCommandPayload = AttestStudioHiggsfieldConnectorCapabilityInput;
export type EnqueueStudioHiggsfieldConnectorRequestCommandPayload =
  | { kind: "video"; intentId: string }
  | { kind: "image"; imageGenerationRunId: string; executionAdapter: "higgsfield-connector" };
export type ClaimStudioHiggsfieldConnectorRequestCommandPayload = { requestId: string; claimantId: string; expectedRevision: number };
export type PreflightStudioHiggsfieldConnectorRequestCommandPayload = { requestId: string; claimToken: string; expectedRevision: number; observation: HiggsfieldDirectUnlimitedObservation };
export type AuthorizeStudioHiggsfieldConnectorRequestCommandPayload = { requestId: string; claimToken: string; expectedRevision: number; projectContextToken: string };
export type RecordStudioHiggsfieldConnectorSubmissionCommandPayload = { requestId: string; claimToken: string; expectedRevision: number; submissionNonce: string; remoteJobId: string | null; zeroCreditReceipt?: import("./studio-higgsfield-connector-queue.js").HiggsfieldZeroCreditReceipt; remoteStatus?: string };
export type ReconcileStudioHiggsfieldConnectorRequestCommandPayload = Parameters<typeof reconcileStudioHiggsfieldConnectorRequest>[1];

export type CommandRequest =
  | NovelCommandRequest
  | { command: "scan_project"; payload: Record<string, never> }
  | { command: "stage_dudu_readonly_managed_project"; payload: StageDuduReadonlyManagedProjectCommandPayload }
  | StudioRuntimeCommandRequest
  | { command: "materialize_fusion_project"; payload: { packageRoot: string; sourceRoot?: string; indexPath?: string; assetLibraryPath?: string; expectedCounts?: Partial<FusionPackageExpectedCounts>; targetParent: string; authorities?: FusionAuthorityInput[] } }
  | { command: "build_fusion_reference_board"; payload: { itemId: string; variant?: FusionReferenceBoardVariant } }
  | { command: "build_fusion_storyboard_grid"; payload: { itemId: string; override?: FusionStoryboardGridOverride; referenceOverride?: FusionStoryboardGridReferenceOverride } }
  | { command: "materialize_fusion_panel_references"; payload: Record<string, never> }
  | { command: "materialize_fusion_visual_constraints"; payload: { expectedStoreRevision: number } }
  | { command: "upsert_fusion_visual_constraint_override"; payload: { override:
        | {
          overrideType: "presence";
          contractId: string;
          panelId: string;
          assetId: string;
          expectedStoreRevision: number;
          expectedConstraintId: string;
          expectedResolutionId: string;
          expectedBindingId: string;
          presence: "on-screen" | "continuity-only" | "optional-offscreen";
          reason: string;
        }
        | {
          overrideType: "golden-mask-reveal";
          action: "set" | "remove";
          contractId: string;
          panelId: string;
          expectedStoreRevision: number;
          expectedConstraintId: string;
          authorizationId?: string;
          approvedBy: "user";
          reason: string;
          modelRevealDescription?: string;
        }
      } }
  | { command: "upsert_panel_reference_override"; payload: {
      contractId: string;
      panelId: string;
      expectedResolutionId: string;
      expectedStoreRevision: number;
      includeAssetIds?: string[];
      excludeAssetIds?: string[];
      reason: string;
    } }
  | { command: "register_derived_panel_reference_artifact"; payload: {
      derivedAssetId: string;
      expectedStoreRevision: number;
      expectedVersion: number;
      filePath: string;
      expectedSha256?: string;
      reviewer: "user" | "codex";
      reviewNote: string;
    } }
  | { command: "migrate_fusion_storyboard_evidence"; payload: { itemIds?: string[] } }
  | { command: "migrate_fusion_storyboard_sheets"; payload: { itemIds?: string[]; expectedStoreRevision: number; expectedCandidateFingerprint: string } }
  | { command: "migrate_canonical_assets"; payload: { expectedStoreRevision: number; expectedCandidateFingerprint: string } }
  | { command: "render_fusion_storyboard_sheet"; payload: { itemId: string; contractId: string; expectedInputFingerprint: string; placements?: Record<string, FusionStoryboardSheetPanelPlacement> } }
  | { command: "prepare_fusion_asset_consistency_review"; payload: { batchId?: string } }
  | { command: "submit_fusion_asset_consistency_review"; payload: SubmitFusionAssetConsistencyReviewInput }
  | { command: "seal_final_fusion_asset_consistency_batch"; payload: { batchId: string; expectedRevision: number } }
  | { command: "commit_project_import"; payload: { previewId: string; config: ProjectConfig; projectMode?: ProjectImportMode } }
  | { command: "update_status"; payload: { itemId: string; status: WorkItemStatus; note?: string; authoritativePath?: string } }
  | { command: "claim_task"; payload: { taskId: string; agentId?: string; leaseSeconds?: number; expectedRevision: number } }
  | { command: "heartbeat_task"; payload: { taskId: string; leaseId: string; agentId?: string; leaseSeconds?: number; expectedRevision: number } }
  | { command: "release_task"; payload: { taskId: string; leaseId: string; agentId?: string; expectedRevision: number; reason?: string } }
  | { command: "cancel_task"; payload: { taskId: string; expectedRevision: number; reason: string } }
  | { command: "finish_batch"; payload: { taskId: string; leaseId: string; agentId?: string; expectedRevision: number; status?: "completed" | "blocked"; completedItemIds?: string[]; failedItemIds?: string[]; note?: string } }
  | { command: "apply_edit_operation"; payload: { editProjectId: string; expectedRevision: number; operation: EditOperation } }
  | { command: "update_workflow_stage"; payload: Parameters<typeof updateProductionWorkflowStage>[1] }
  | { command: "commit_existing_production_recovery"; payload: Parameters<typeof commitExistingProductionRecovery>[1] }
  | { command: "upsert_creative_bible"; payload: Parameters<typeof upsertCreativeBible>[1] }
  | { command: "upsert_storyboard_row"; payload: StoryboardRowUpsertInput }
  | { command: "submit_review"; payload: SubmitReviewInput }
  | { command: "upsert_asset_relation"; payload: Parameters<typeof upsertAssetRelation>[1] }
  | { command: "upsert_voice_identity"; payload: Parameters<typeof upsertVoiceIdentity>[1] }
  | { command: "update_browser_generation"; payload: { jobId: string; expectedRevision: number; expectedSettingsRevision?: number; status: BrowserGenerationUpdateStatus; externalTaskId?: string; downloadedPath?: string; error?: string; note?: string; preflightEvidence?: BrowserPreflightInput; uploadEvidence?: BrowserUploadInput; submissionReconciliation?: BrowserSubmissionReconciliationInput } }
  | { command: "update_subagent_image_generation"; payload: {
      jobId: string;
      expectedRevision: number;
      expectedSettingsRevision?: number;
      status: SubagentImageGenerationUpdateStatus;
      targetProviderId?: string;
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
    } }
  | { command: "migrate_generation_execution_state"; payload: { jobId: string; expectedRevision: number; evidenceReference?: string; note?: string } }
  | { command: "reconcile_http_generation_submission"; payload: { jobId: string } & ReconcileHttpGenerationSubmissionInput }
  | { command: "update_video_continuation"; payload: { continuationId: string; expectedRevision: number; status: "failed" | "cancelled"; error: string } }
  | { command: "prepare_timeline_continuation"; payload: { editProjectId: string; targetItemId: string; expectedRevision: number; timeSeconds?: number; prompt?: string; providerId?: string; enqueue?: boolean } }
  | { command: "upsert_context"; payload: Parameters<typeof upsertProjectContext>[1] }
  | { command: "delete_context"; payload: Parameters<typeof deleteProjectContext>[1] }
  | { command: "upsert_story_event"; payload: Parameters<typeof upsertStoryEvent>[1] }
  | { command: "connect_story_events"; payload: { sourceEventId: string; targetEventId: string } }
  | { command: "upsert_canvas_entity"; payload: Parameters<typeof upsertCanvasEntity>[1] }
  | { command: "delete_canvas_entity"; payload: { entityId: string } }
  | { command: "upsert_canvas_link"; payload: Parameters<typeof upsertCanvasLink>[1] }
  | { command: "delete_canvas_link"; payload: { linkId: string } }
  | { command: "undo_canvas"; payload: Record<string, never> }
  | { command: "redo_canvas"; payload: Record<string, never> }
  | { command: "create_task_pack"; payload: Parameters<typeof createTaskPack>[1] }
  | { command: "register_artifact"; payload: Parameters<typeof registerArtifact>[1] }
  | { command: "verify_item"; payload: { itemId: string } }
  | { command: "set_authoritative_artifact"; payload: { itemId: string; artifactId: string; note?: string } }
  | { command: "promote_asset_to_hard_lock"; payload: { itemId: string; note?: string } }
  | { command: "enqueue_generation"; payload: Parameters<typeof enqueueGeneration>[1] }
  | { command: "upsert_generation_provider"; payload: Parameters<typeof upsertGenerationProvider>[1] }
  | { command: "save_script_document"; payload: { filePath: string; content: string; expectedModifiedAt?: string } }
  | { command: "extract_last_frame"; payload: Parameters<typeof extractLastFrame>[1] }
  | { command: "create_video_continuation"; payload: Parameters<typeof createVideoContinuationPack>[1] }
  | { command: "import_story_file"; payload: { filePath: string; title?: string } }
  | { command: "import_story_text"; payload: Parameters<typeof importStoryText>[1] }
  | { command: "analyze_novel_chapters"; payload: Parameters<typeof analyzeNovelChapters>[1] }
  | { command: "generate_adaptation_plans"; payload: Parameters<typeof generateAdaptationPlans>[1] }
  | { command: "select_adaptation_plan"; payload: { planId: string; expectedRevision: number } }
  | { command: "materialize_adaptation_plan"; payload: Parameters<typeof materializeSelectedAdaptationPlan>[1] }
  | { command: "regenerate_adaptation_scope"; payload: Parameters<typeof regenerateAdaptationScope>[1] }
  | { command: "upsert_novel_fact"; payload: Parameters<typeof upsertNovelFact>[1] }
  | { command: "upsert_narrative_beat"; payload: Parameters<typeof upsertNarrativeBeat>[1] }
  | { command: "export_adaptation"; payload: Parameters<typeof exportAdaptation>[1] }
  | { command: "create_novel_analysis_task"; payload: Parameters<typeof createNovelAnalysisTask>[1] }
  | { command: "submit_novel_analysis_proposal"; payload: Parameters<typeof submitNovelAnalysisProposal>[1] }
  | { command: "review_novel_analysis_item"; payload: Parameters<typeof reviewNovelAnalysisItem>[1] }
  | { command: "review_novel_analysis_batch"; payload: Parameters<typeof reviewNovelAnalysisBatch>[1] }
  | { command: "upsert_novel_analysis_provider"; payload: Parameters<typeof upsertNovelAnalysisProvider>[1] }
  | { command: "plan_novel_analysis_run"; payload: Parameters<typeof planNovelAnalysisRun>[1] }
  | { command: "execute_novel_analysis_task"; payload: Parameters<typeof executeNovelAnalysisTask>[1] }
  | { command: "execute_next_novel_analysis_run_task"; payload: Parameters<typeof executeNextNovelAnalysisRunTask>[1] }
  | { command: "replace_novel_analysis_run_task"; payload: Parameters<typeof replaceNovelAnalysisRunTask>[1] }
  | { command: "mark_novel_analysis_execution_reconciliation_required"; payload: Parameters<typeof markNovelAnalysisExecutionReconciliationRequired>[1] }
  | { command: "reconcile_novel_analysis_execution"; payload: Parameters<typeof reconcileNovelAnalysisExecution>[1] }
  | { command: "save_skill"; payload: Parameters<typeof saveAgentSkill>[1] }
  | { command: "create_handoff"; payload: { itemId?: string } }
  | { command: "save_unit_timeline"; payload: { unitId: string; timings: ShotTiming[] } }
  | { command: "create_shot_task_pack"; payload: { unitId: string; mode?: "observe" | "collaborate" | "autopilot" } }
  | { command: "process_generation_queue"; payload: { jobId?: string } }
  | { command: "cancel_generation"; payload: { jobId: string } }
  | { command: "preflight_publication"; payload: Omit<PreflightPublicationInput, "idempotencyKey"> }
  | { command: "register_publication"; payload: Parameters<typeof registerPublication>[1] }
  | { command: "cancel_publication"; payload: Parameters<typeof cancelPublication>[1] }
  | { command: "fail_publication"; payload: Parameters<typeof failPublication>[1] }
  | { command: "preflight_publication_bundle"; payload: Omit<Parameters<typeof preflightPublicationBundle>[1], "idempotencyKey"> }
  | { command: "register_publication_bundle"; payload: Parameters<typeof registerPublicationBundle>[1] }
  | { command: "cancel_publication_bundle"; payload: Parameters<typeof cancelPublicationBundle>[1] }
  | { command: "fail_publication_bundle"; payload: Parameters<typeof failPublicationBundle>[1] }
  | { command: "create_edit_project"; payload: Parameters<typeof createEditProject>[1] }
  | { command: "save_edit_project"; payload: { project: EditProject; expectedRevision: number } }
  | { command: "undo_edit_project"; payload: { editProjectId: string; expectedRevision: number } }
  | { command: "redo_edit_project"; payload: { editProjectId: string; expectedRevision: number } }
  | { command: "export_edit_otio"; payload: { editProjectId: string; expectedRevision: number; outputPath?: string } }
  | { command: "import_edit_otio"; payload: { filePath: string; name?: string } }
  | { command: "start_edit_render"; payload: { editProjectId: string; expectedRevision: number; outputDirectory?: string } }
  | { command: "cancel_edit_render"; payload: { renderId: string } }
  | { command: "extract_timeline_frame"; payload: Parameters<typeof extractTimelineFrame>[1] }
  | { command: "prepare_edit_media_preview"; payload: { artifactId: string } }
  | { command: "prepare_edit_media_proxy"; payload: { artifactId: string } };

export type StudioCommandRequest = Extract<CommandRequest, {
  command: StudioRuntimeCommandRequest["command"];
}>;

/**
 * Studio 写面的唯一命令分类器。Main、MCP 与渲染层不得再维护平行 allowlist，
 * 否则新增命令会出现“Core 可执行、桌面端被误拒绝”的路由漂移。
 */
export function isStudioCommandRequest(request: CommandRequest): request is StudioCommandRequest {
  return isStudioCommandName(request.command);
}

export function isNovelCommandRequest(request: CommandRequest): request is NovelCommandRequest {
  return isNovelCommandName(request.command);
}

function isNovelAnalysisExecutionCommand(request: CommandRequest): boolean {
  return request.command === "execute_novel_analysis_task" || request.command === "execute_next_novel_analysis_run_task";
}

export interface IdempotentCommandInput {
  requestId: string;
  idempotencyKey: string;
  request: CommandRequest;
}

export interface IdempotentCommandResult {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  command: CommandRequest["command"];
  status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  replayed: boolean;
  requestHash: string;
  execution?: { pid: number; phase: "registered" | "executing" | "side_effect_committed"; heartbeatAt: string };
  durableReconciliation?: DurableCommandReconciliationSnapshot;
  /**
   * 小说导入业务树与首次成功账本之间的跨 owner 不可变锚点。即使状态降为
   * unknown 也必须保留，后续 durable proof 不能用当前自洽闭包覆盖它。
   */
  novelImportResultAnchor?: NovelImportResultAnchor;
  storageRoot?: string;
  result?: unknown;
  // busyUncommitted：SQLite 瞬时锁导致的失败且事务确认未提交（busy 只可能在
  // COMMIT 成功前抛出），允许同一 idempotencyKey 受控重试；attempts/retryBudgetMs
  // 记录已用受控重试次数与预算，供审计与分类。
  error?: { message: string; observedAt: string; busyUncommitted?: boolean; attempts?: number; retryBudgetMs?: number };
  startedAt: string;
  executedAt?: string;
}

interface NovelImportResultAnchor {
  schemaVersion: 1;
  kind: "novel-import-result-anchor";
  receiptId: string;
  projectId: string;
  receiptFingerprint: string;
  stateChainFingerprint: string;
  chapterManifestSha256: string;
  canonicalReceiptSha256: string;
}

type DurableReconciliationCommandRequest = Extract<CommandRequest,
  { command:
      | "novel_import_external_snapshot"
      | "novel_import_writing_source_snapshot"
      | "novel_review_chapter_state_candidate"
      | "novel_review_story_bible_candidate"
      | "novel_invalidate_writing_state_from"
      | "stage_dudu_readonly_managed_project"
      | "finalize_dudu_readonly_managed_project"
      | "reconcile_dudu_readonly_historical_passes"
      | "prepare_studio_video_package_export"
      | "build_studio_video_package"
      | "migrate_fusion_storyboard_sheets"
      | "render_fusion_storyboard_sheet"
      | "migrate_canonical_assets"
      | "append_studio_script_section_revision"
      | "analyze_studio_script_entities"
      | "resolve_studio_entity_proposal"
      | "confirm_studio_panel_empty"
      | "freeze_studio_asset_binding_set"
      | "prepare_studio_imagegen_call"
      | "reconcile_studio_imagegen_call"
      | "abandon_studio_generation_unknown"
      | "abandon_studio_detached_generation_unknown"
      | "rebind_studio_imagegen_call_context"
      | "commit_agent_imagegen_result_bundle"
      | "create_studio_generation_plan"
      | "fail_studio_generation_run"
      | "cancel_studio_generation_run"
      | "retry_studio_generation_plan_nodes"
      | "append_studio_continuity_observation"
      | "append_studio_continuity_correction"
      | "submit_studio_generation_review"
      | "submit_studio_post_result_observation"
      | "refresh_studio_generation_checkpoint"
      | "attest_studio_generation_checkpoint"
      | "attach_studio_multimedia_timeline_media"
      | "materialize_local_creative_production_units"
  }>;

interface DurableCommandReconciliationSnapshot {
  schemaVersion: 1;
  request: DurableReconciliationCommandRequest;
}

interface DurableCommandProof {
  source: "novel_import_receipts" | "novel_writing_source_snapshot_receipts" | "novel_writing_state_operation_receipts" | "dudu_readonly_import_receipts" | "local_creative_production_unit_receipts" | "studio_video_package_ledger" | "studio_multimedia_timeline_bindings" | "fusion-storyboard-sheet-store" | "fusion-storyboard-sheet-migration-candidate-fingerprint" | "canonical-asset-store" | "studio_script_section_revisions" | "studio_binding_operation_receipts" | "studio_continuity_operation_receipts" | "studio_generation_review_operation_receipts" | "studio_post_result_observation_operation_receipts" | "studio_generation_checkpoint_operation_receipts" | "studio_agent_imagegen_writeback_receipts" | "studio_generation_plan_run_ledger" | "studio_generation_call_ledger" | "studio_generation_detached_disposition_ledger";
  identity: Record<string, unknown>;
  result: unknown;
}

const DURABLE_RECONCILIATION_COMMAND_NAMES = new Set<DurableReconciliationCommandRequest["command"]>([
  "novel_import_external_snapshot",
  "novel_import_writing_source_snapshot",
  "novel_review_chapter_state_candidate",
  "novel_review_story_bible_candidate",
  "novel_invalidate_writing_state_from",
  "stage_dudu_readonly_managed_project",
  "finalize_dudu_readonly_managed_project",
  "reconcile_dudu_readonly_historical_passes",
  "prepare_studio_video_package_export",
  "build_studio_video_package",
  "migrate_fusion_storyboard_sheets",
  "render_fusion_storyboard_sheet",
  "migrate_canonical_assets",
  "append_studio_script_section_revision",
  "analyze_studio_script_entities",
  "resolve_studio_entity_proposal",
  "confirm_studio_panel_empty",
  "freeze_studio_asset_binding_set",
  "prepare_studio_imagegen_call",
  "reconcile_studio_imagegen_call",
  "abandon_studio_generation_unknown",
  "abandon_studio_detached_generation_unknown",
  "rebind_studio_imagegen_call_context",
  "commit_agent_imagegen_result_bundle",
  "create_studio_generation_plan",
  "fail_studio_generation_run",
  "cancel_studio_generation_run",
  "retry_studio_generation_plan_nodes",
  "append_studio_continuity_observation",
  "append_studio_continuity_correction",
  "submit_studio_generation_review",
  "submit_studio_post_result_observation",
  "refresh_studio_generation_checkpoint",
  "attest_studio_generation_checkpoint",
  "attach_studio_multimedia_timeline_media",
  "materialize_local_creative_production_units",
]);

const STUDIO_BINDING_OPERATION_COMMAND_NAMES = new Set<StudioBindingOperationCommand>([
  "analyze_studio_script_entities",
  "resolve_studio_entity_proposal",
  "confirm_studio_panel_empty",
  "freeze_studio_asset_binding_set",
]);

interface CommandLedger { schemaVersion: 1; entries: IdempotentCommandResult[]; updatedAt: string }

async function readCommandLedger(projectRoot: string): Promise<CommandLedger> {
  // 仅列表/诊断路径使用全量快照；热路径请用 getCommandBy* 单条查询。
  const snapshot = await loadCommandLedger(projectRoot);
  return {
    schemaVersion: 1,
    entries: (snapshot.entries as IdempotentCommandResult[]).map(revokePersistedImagegenCallCapability),
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * prepare 的 callAllowed=true 是一次性、仅限首次调用栈的 capability，绝不能进入
 * 可重放命令账本。旧账本若曾写入 true，所有读取面也在投影时强制降权。
 */
function revokePersistedImagegenCallCapability(record: IdempotentCommandResult): IdempotentCommandResult {
  if (!(["prepare_studio_imagegen_call", "prepare_studio_higgsfield_video_generation", "claim_studio_higgsfield_connector_request", "authorize_studio_higgsfield_connector_request"] as const).includes(record.command as never)
    || !record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
    return { ...record };
  }
  if (record.command === "prepare_studio_higgsfield_video_generation") {
    return {
      ...record,
      result: projectHiggsfieldPrepareResultForPersistence(record.result),
    };
  }
  if (record.command === "claim_studio_higgsfield_connector_request" || record.command === "authorize_studio_higgsfield_connector_request") {
    return { ...record, result: projectHiggsfieldConnectorQueueResultForPersistence(record.command, record.result) };
  }
  return {
    ...record,
    result: {
      ...(record.result as Record<string, unknown>),
      callAllowed: false,
      idempotentReplay: true,
    },
  };
}

/** Queue 的 claim/nonce 与受控路径只允许首个调用栈可见，账本和重放一律删除。 */
export function projectHiggsfieldConnectorQueueResultForPersistence(command: string, result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const projected = { ...(result as Record<string, unknown>) };
  if (command === "claim_studio_higgsfield_connector_request") delete (projected as { claimToken?: unknown }).claimToken;
  if (command === "authorize_studio_higgsfield_connector_request") {
    delete (projected as { submissionNonce?: unknown }).submissionNonce;
    delete (projected as { connectorRequest?: unknown }).connectorRequest;
    (projected as { callAllowed?: unknown }).callAllowed = false;
  }
  return projected;
}

/**
 * Higgsfield 的 connectorRequest 含本机受控参考路径，只能存在于首次调用栈。
 * 任何持久账本、重放、列表或恢复投影都必须删除整个调用单并撤销一次性许可。
 */
export function projectHiggsfieldPrepareResultForPersistence(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const projected = {
    ...(result as Record<string, unknown>),
    callAllowed: false,
    idempotentReplay: true,
  };
  delete (projected as { connectorRequest?: unknown }).connectorRequest;
  return projected;
}

function revokeImagegenCallCapabilityFromResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const projected = {
    ...(result as Record<string, unknown>),
    callAllowed: false,
    idempotentReplay: true,
  };
  if ((result as { connectorRequest?: unknown }).connectorRequest !== undefined) {
    delete (projected as { connectorRequest?: unknown }).connectorRequest;
  }
  return projected;
}

async function getCommandByIdempotencyKey(
  projectRoot: string,
  idempotencyKey: string,
): Promise<IdempotentCommandResult | undefined> {
  const entry = await getCommandLedgerEntryByIdempotencyKey(projectRoot, idempotencyKey);
  return entry ? revokePersistedImagegenCallCapability(entry as IdempotentCommandResult) : undefined;
}

async function getCommandByRequestId(
  projectRoot: string,
  requestId: string,
): Promise<IdempotentCommandResult | undefined> {
  const entry = await getCommandLedgerEntryByRequestId(projectRoot, requestId);
  return entry ? revokePersistedImagegenCallCapability(entry as IdempotentCommandResult) : undefined;
}

async function persistCommandLedgerEntry(
  projectRoot: string,
  entry: IdempotentCommandResult,
  updatedAt = entry.executedAt ?? entry.startedAt,
): Promise<void> {
  await upsertCommandLedgerEntry(
    projectRoot,
    revokePersistedImagegenCallCapability(entry) as CommandLedgerEntry,
    updatedAt,
  );
}

async function persistCommandLedgerSnapshot(projectRoot: string, ledger: CommandLedger): Promise<void> {
  await replaceCommandLedger(projectRoot, {
    entries: ledger.entries.map(revokePersistedImagegenCallCapability) as CommandLedgerEntry[],
    updatedAt: ledger.updatedAt,
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalAssetSemanticSourceIdentity(snapshot: CanonicalAssetSourceSnapshot): unknown {
  return {
    algorithm: snapshot.algorithm,
    files: snapshot.files
      .map(({ role, semanticSha256 }) => ({ role, semanticSha256 }))
      .sort((left, right) => left.role.localeCompare(right.role, "en")),
    media: snapshot.media
      .map(({ path: mediaPath, bytes, sha256 }) => ({ path: mediaPath, bytes, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
}

function commandRequestForPersistence(request: CommandRequest): CommandRequest {
  return isNovelCommandRequest(request)
    ? canonicalNovelCommandRequestForPersistence(request) as CommandRequest
    : request;
}

function commandRequestHash(projectRoot: string, request: CommandRequest): string {
  return createHash("sha256").update(stable({
    projectRoot: path.resolve(projectRoot),
    request: commandRequestForPersistence(request),
  })).digest("hex");
}

function isStudioBindingOperationCommand(command: CommandRequest["command"]): command is StudioBindingOperationCommand {
  return STUDIO_BINDING_OPERATION_COMMAND_NAMES.has(command as StudioBindingOperationCommand);
}

function assertExactPublicPayload(payload: unknown, allowedKeys: readonly string[], command: string): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${command} payload 必须是 UI 安全对象。`);
  }
  const unexpected = Object.keys(payload as Record<string, unknown>).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${command} payload 包含非公开字段：${unexpected.sort((left, right) => left.localeCompare(right, "en")).join(", ")}。`);
  }
}

function assertRequiredPublicPayload(payload: unknown, requiredKeys: readonly string[], command: string): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${command} payload 必须是 UI 安全对象。`);
  }
  const missing = requiredKeys.filter((key) => !Object.hasOwn(payload, key));
  if (missing.length > 0) throw new Error(`${command} payload 缺少必需字段：${missing.join(", ")}。`);
}

function assertNextShotContinuitySnapshotPublicPayload(payload: unknown, command: string): void {
  const label = `${command}.continuitySnapshot`;
  const keys = [
    "schemaVersion", "kind", "sourceUnitId", "sourcePanelId", "sourceRawSha256",
    "characters", "props", "scene", "vfx", "referenceSha256List",
    "continuityFingerprint", "createdAt",
  ] as const;
  assertExactPublicPayload(payload, keys, label);
  assertRequiredPublicPayload(payload, keys, label);
  const snapshot = payload as SubmitStudioPostResultObservationCommandPayload["continuitySnapshot"];
  if (!snapshot) throw new Error(`${label} 必须是 UI 安全对象。`);
  if (!Array.isArray(snapshot.characters)
    || !Array.isArray(snapshot.props)
    || !Array.isArray(snapshot.vfx)
    || !Array.isArray(snapshot.referenceSha256List)) {
    throw new Error(`${label} 的 characters、props、vfx、referenceSha256List 必须是数组。`);
  }
  snapshot.characters.forEach((character, index) => {
    const itemLabel = `${label}.characters[${index}]`;
    assertExactPublicPayload(character, [
      "assetId", "costumeState", "position", "facing", "gazeDirection", "actionEndPose",
      "nextActionStart", "expression", "injuryState",
    ], itemLabel);
    assertRequiredPublicPayload(character, [
      "assetId", "position", "facing", "gazeDirection", "actionEndPose", "expression",
    ], itemLabel);
  });
  snapshot.props.forEach((prop, index) => {
    const itemLabel = `${label}.props[${index}]`;
    assertExactPublicPayload(prop, ["assetId", "heldBy", "position", "physicalState"], itemLabel);
    assertRequiredPublicPayload(prop, ["assetId", "heldBy", "physicalState"], itemLabel);
  });
  assertExactPublicPayload(snapshot.scene, [
    "layout", "axisLine", "screenDirection", "entryExits", "lighting", "timeOfDay", "weather", "cutExit",
  ], `${label}.scene`);
  assertRequiredPublicPayload(snapshot.scene, [
    "layout", "axisLine", "entryExits", "lighting", "timeOfDay",
  ], `${label}.scene`);
  if (!Array.isArray(snapshot.scene.entryExits)) {
    throw new Error(`${label}.scene.entryExits 必须是数组。`);
  }
  snapshot.vfx.forEach((vfx, index) => {
    const itemLabel = `${label}.vfx[${index}]`;
    assertExactPublicPayload(vfx, [
      "vfxId", "description", "intensity", "continuesToNext",
    ], itemLabel);
    assertRequiredPublicPayload(vfx, [
      "vfxId", "description", "intensity", "continuesToNext",
    ], itemLabel);
  });
}

/**
 * 命令总线只接收工作台可见的稳定 ID、人工决策与 revision token。
 * assetSources、analysis/decision/binding head revision 必须由 studio-binding-control
 * 在服务端重新读取，不得由调用方注入。
 */
function assertStudioBindingPublicPayload(request: CommandRequest): void {
  if (!isStudioBindingOperationCommand(request.command)) return;
  if (request.command === "analyze_studio_script_entities") {
    assertExactPublicPayload(request.payload, ["unitId", "panelId", "expectedRevisionToken", "extractedMentions"], request.command);
    if (request.payload.extractedMentions !== undefined) {
      if (!Array.isArray(request.payload.extractedMentions) || request.payload.extractedMentions.length > 256) {
        throw new Error("analyze_studio_script_entities.extractedMentions 必须是最多 256 项的数组。");
      }
      request.payload.extractedMentions.forEach((mention, index) => {
        assertExactPublicPayload(mention, ["startOffsetUtf16", "endOffsetUtf16", "category", "presence", "role", "candidateAssetIds"], `${request.command}.extractedMentions[${index}]`);
        if (mention.candidateAssetIds !== undefined
          && (!Array.isArray(mention.candidateAssetIds)
            || mention.candidateAssetIds.length > 5
            || new Set(mention.candidateAssetIds).size !== mention.candidateAssetIds.length)) {
          throw new Error(`${request.command}.extractedMentions[${index}].candidateAssetIds 最多允许 5 个不重复稳定 ID。`);
        }
      });
    }
    return;
  }
  if (request.command === "resolve_studio_entity_proposal") {
    assertExactPublicPayload(request.payload, ["unitId", "panelId", "proposalId", "decision", "selectedAssetId", "presence", "role", "expectedRevisionToken", "note", "reviewer"], request.command);
    if (!Object.hasOwn(request.payload, "reviewer") || (request.payload.reviewer !== "user" && request.payload.reviewer !== "codex")) {
      throw new Error(`${request.command} payload 必须显式声明 reviewer=user|codex。`);
    }
    return;
  }
  if (request.command === "confirm_studio_panel_empty") {
    assertExactPublicPayload(request.payload, ["unitId", "panelId", "expectedRevisionToken", "reviewer", "note"], request.command);
    if (!Object.hasOwn(request.payload, "reviewer") || (request.payload.reviewer !== "user" && request.payload.reviewer !== "codex")) {
      throw new Error(`${request.command} payload 必须显式声明 reviewer=user|codex。`);
    }
    if (!Object.hasOwn(request.payload, "note") || typeof request.payload.note !== "string"
      || !request.payload.note.trim() || request.payload.note.trim().length > 4_000) {
      throw new Error(`${request.command} payload 必须携带 1-4000 字符的真实审阅 note。`);
    }
    return;
  }
  assertExactPublicPayload(request.payload, ["unitId", "panelId", "expectedRevisionToken"], request.command);
}

function assertStudioScriptSectionPublicPayload(request: CommandRequest): void {
  if (request.command !== "append_studio_script_section_revision") return;
  const requiredKeys = [
    "sectionId",
    "expectedRevision",
    "kind",
    "title",
    "scriptRevisionId",
    "scriptSha256",
    "startOffsetUtf16",
    "endOffsetUtf16",
  ] as const;
  assertExactPublicPayload(request.payload, requiredKeys, request.command);
  const missing = requiredKeys.filter((key) => !Object.hasOwn(request.payload, key));
  if (missing.length > 0) {
    throw new Error(`${request.command} payload 缺少必需字段：${missing.join(", ")}。`);
  }
}

function assertStudioContinuityStatePublicPayload(state: unknown, command: string): void {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`${command}.state 必须是 UI 安全对象。`);
  }
  const record = state as Record<string, unknown>;
  const resolved = record.status === "resolved";
  assertExactPublicPayload(
    state,
    resolved ? ["status", "value", "provenance"] : ["status", "reason", "provenance"],
    `${command}.state`,
  );
  assertRequiredPublicPayload(
    state,
    resolved ? ["status", "value", "provenance"] : ["status", "reason", "provenance"],
    `${command}.state`,
  );
  if (!Array.isArray(record.provenance)) throw new Error(`${command}.state.provenance 必须是数组。`);
  record.provenance.forEach((provenance, index) => {
    const label = `${command}.state.provenance[${index}]`;
    assertExactPublicPayload(provenance, ["kind", "reference", "sourceFingerprint", "note", "fingerprint"], label);
    assertRequiredPublicPayload(provenance, ["kind", "reference"], label);
  });
}

/** P7 公开写面只允许 Core input 去掉业务 operationId 后的字段。 */
function assertStudioContinuityReviewPublicPayload(request: CommandRequest): void {
  if (request.command === "append_studio_continuity_observation"
    || request.command === "append_studio_continuity_correction") {
    const correction = request.command === "append_studio_continuity_correction";
    const allowed = correction
      ? ["expectedHeadRevision", "scope", "subjectId", "field", "state", "supersedesEntryId", "resolvesConflicts"]
      : ["expectedHeadRevision", "scope", "subjectId", "field", "state"];
    const required = correction
      ? ["expectedHeadRevision", "scope", "subjectId", "field", "state", "supersedesEntryId"]
      : ["expectedHeadRevision", "scope", "subjectId", "field", "state"];
    assertExactPublicPayload(request.payload, allowed, request.command);
    assertRequiredPublicPayload(request.payload, required, request.command);
    assertExactPublicPayload(request.payload.scope, [
      "kind", "scopeId", "unitId", "unitRevision", "startMilliseconds", "endMilliseconds",
    ], `${request.command}.scope`);
    assertRequiredPublicPayload(request.payload.scope, [
      "kind", "scopeId", "unitId", "unitRevision", "startMilliseconds", "endMilliseconds",
    ], `${request.command}.scope`);
    assertStudioContinuityStatePublicPayload(request.payload.state, request.command);
    if (correction && request.payload.resolvesConflicts !== undefined) {
      if (!Array.isArray(request.payload.resolvesConflicts)) throw new Error(`${request.command}.resolvesConflicts 必须是数组。`);
      request.payload.resolvesConflicts.forEach((expectation, index) => {
        const label = `${request.command}.resolvesConflicts[${index}]`;
        assertExactPublicPayload(expectation, ["conflictId", "expectedRevision"], label);
        assertRequiredPublicPayload(expectation, ["conflictId", "expectedRevision"], label);
      });
    }
    return;
  }
  if (request.command === "submit_studio_post_result_observation") {
    const keys = [
      "generationRunId", "expectedHeadRevision", "expectedReviewId", "expectedReviewFingerprint",
      "rawResultId", "rawSha256", "labeledResultId", "labeledSha256",
      "packId", "packFingerprint", "plannedContinuityFingerprint",
      "evidenceKind", "evidenceSha256", "terminalPanelId",
      "observedState", "observedAvailability", "continuitySnapshot", "observer", "note",
    ] as const;
    assertExactPublicPayload(request.payload, keys, request.command);
    assertRequiredPublicPayload(
      request.payload,
      keys.filter((key) => key !== "terminalPanelId" && key !== "continuitySnapshot"),
      request.command,
    );
    const observedStateKeys = [
      "costume", "injury", "heldObject", "position", "facing", "emotion", "layout", "lighting",
      "referenceSha256", "motionVector", "cameraPhase", "focusState", "audioPhase",
    ] as const;
    assertExactPublicPayload(request.payload.observedState, observedStateKeys, `${request.command}.observedState`);
    assertRequiredPublicPayload(request.payload.observedState, observedStateKeys, `${request.command}.observedState`);
    const availabilityKeys = [
      "costume", "injury", "heldObject", "position", "facing", "emotion", "layout", "lighting",
      "motionVector", "cameraPhase", "focusState", "audioPhase",
    ] as const;
    assertExactPublicPayload(
      request.payload.observedAvailability,
      availabilityKeys,
      `${request.command}.observedAvailability`,
    );
    assertRequiredPublicPayload(
      request.payload.observedAvailability,
      availabilityKeys,
      `${request.command}.observedAvailability`,
    );
    if (request.payload.continuitySnapshot !== undefined) {
      assertNextShotContinuitySnapshotPublicPayload(
        request.payload.continuitySnapshot,
        request.command,
      );
    }
    if (request.payload.observer !== "user" && request.payload.observer !== "codex") {
      throw new Error(`${request.command} payload 必须显式声明 observer=user|codex。`);
    }
    return;
  }
  if (request.command === "refresh_studio_generation_checkpoint") {
    const keys = ["batchNumber", "expectedHeadRevision"] as const;
    assertExactPublicPayload(request.payload, keys, request.command);
    assertRequiredPublicPayload(request.payload, keys, request.command);
    return;
  }
  if (request.command === "attest_studio_generation_checkpoint") {
    const keys = [
      "batchNumber", "checkpointId", "checkpointFingerprint", "expectedHeadRevision",
      "decision", "reviewer", "note",
    ] as const;
    assertExactPublicPayload(request.payload, keys, request.command);
    assertRequiredPublicPayload(request.payload, keys, request.command);
    if (request.payload.reviewer !== "user" && request.payload.reviewer !== "codex") {
      throw new Error(`${request.command} payload 必须显式声明 reviewer=user|codex。`);
    }
    return;
  }
  if (request.command !== "submit_studio_generation_review") return;
  const allowed = [
    "generationRunId", "kind", "expectedHeadRevision", "supersedesReviewId",
    "rawResultId", "rawSha256", "labeledResultId", "labeledSha256",
    "expectedPackFingerprint", "continuityFingerprint", "decision", "criteria",
    "annotations", "reviewer", "note",
  ] as const;
  assertExactPublicPayload(request.payload, allowed, request.command);
  assertRequiredPublicPayload(request.payload, [
    "generationRunId", "kind", "expectedHeadRevision", "rawResultId", "rawSha256",
    "labeledResultId", "labeledSha256", "expectedPackFingerprint", "continuityFingerprint",
    "decision", "criteria", "reviewer", "note",
  ], request.command);
  if (request.payload.reviewer !== "user" && request.payload.reviewer !== "codex") {
    throw new Error(`${request.command} payload 必须显式声明 reviewer=user|codex。`);
  }
  if (!Array.isArray(request.payload.criteria)) throw new Error(`${request.command}.criteria 必须是数组。`);
  request.payload.criteria.forEach((criterion, index) => {
    const label = `${request.command}.criteria[${index}]`;
    assertExactPublicPayload(criterion, ["code", "status", "note"], label);
    assertRequiredPublicPayload(criterion, ["code", "status"], label);
  });
  if (request.payload.annotations !== undefined) {
    if (!Array.isArray(request.payload.annotations)) throw new Error(`${request.command}.annotations 必须是数组。`);
    request.payload.annotations.forEach((annotation, index) => {
      const label = `${request.command}.annotations[${index}]`;
      // P22 v2：id/kind 必填，category 可选。
      assertExactPublicPayload(annotation, ["id", "kind", "category", "x", "y", "width", "height", "note"], label);
      assertRequiredPublicPayload(annotation, ["id", "kind", "x", "y", "width", "height", "note"], label);
    });
  }
}

const P30_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const P30_STABLE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,199}$/u;

function assertDuduSourcePublicPayload(source: unknown, command: string): void {
  const allowed = [
    "lockedScriptPath", "productionRoot", "contractRelativePath", "machineStateRelativePath",
    "referenceRegistryRelativePath", "visualCanonRevisionRelativePath", "visualExecutionRelativePath",
    "visualConflictDecisionRelativePath", "meteorVfxRuleRelativePath",
  ] as const;
  assertExactPublicPayload(source, allowed, `${command}.source`);
  assertRequiredPublicPayload(source, ["lockedScriptPath", "productionRoot"], `${command}.source`);
  const record = source as Record<string, unknown>;
  for (const field of ["lockedScriptPath", "productionRoot"] as const) {
    if (typeof record[field] !== "string" || !path.isAbsolute(record[field])) {
      throw new Error(`${command}.source.${field} 必须是绝对路径。`);
    }
  }
  for (const field of allowed.filter((key) => key.endsWith("RelativePath"))) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 1_000
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || value === ".." || value.startsWith("../") || value.includes("\0")) {
      throw new Error(`${command}.source.${field} 必须是受限相对路径。`);
    }
  }
}

function assertP30OrchestrationPublicPayload(request: CommandRequest): void {
  const fingerprint = (value: unknown, field: string) => {
    if (typeof value !== "string" || !P30_SHA256_PATTERN.test(value)) {
      throw new Error(`${request.command}.${field} 必须是 SHA-256。`);
    }
  };
  if (request.command === "stage_dudu_readonly_managed_project") {
    assertExactPublicPayload(request.payload, [
      "projectsRoot", "source", "detachedUnknownObservations", "expectedRevision", "expectedDiscoveryFingerprint",
    ], request.command);
    assertRequiredPublicPayload(request.payload, [
      "projectsRoot", "source", "expectedRevision", "expectedDiscoveryFingerprint",
    ], request.command);
    if (!path.isAbsolute(request.payload.projectsRoot) || request.payload.expectedRevision !== 0) {
      throw new Error(`${request.command} projectsRoot 必须是绝对路径且 expectedRevision 必须为 0。`);
    }
    fingerprint(request.payload.expectedDiscoveryFingerprint, "expectedDiscoveryFingerprint");
    assertDuduSourcePublicPayload(request.payload.source, request.command);
    if (request.payload.detachedUnknownObservations !== undefined) {
      if (!Array.isArray(request.payload.detachedUnknownObservations)
        || request.payload.detachedUnknownObservations.length > 33) {
        throw new Error(`${request.command}.detachedUnknownObservations 最多允许 33 项。`);
      }
      request.payload.detachedUnknownObservations.forEach((observation, index) => {
        assertExactPublicPayload(observation, [
          "unitId", "sourceTaskId", "evidenceReference", "evidenceFingerprint", "candidateSha256",
          "candidateSizeBytes", "candidateWidth", "candidateHeight", "note",
        ], `${request.command}.detachedUnknownObservations[${index}]`);
        assertRequiredPublicPayload(observation, [
          "unitId", "sourceTaskId", "evidenceReference", "evidenceFingerprint",
        ], `${request.command}.detachedUnknownObservations[${index}]`);
      });
    }
    return;
  }
  if (request.command === "finalize_dudu_readonly_managed_project") {
    assertExactPublicPayload(request.payload, [
      "source", "expectedRevision", "expectedDiscoveryFingerprint",
      "expectedImportFingerprint", "expectedControlFingerprint",
    ], request.command);
    assertRequiredPublicPayload(request.payload, [
      "source", "expectedRevision", "expectedDiscoveryFingerprint",
      "expectedImportFingerprint", "expectedControlFingerprint",
    ], request.command);
    if (request.payload.expectedRevision !== 0) throw new Error(`${request.command}.expectedRevision 必须为 0。`);
    fingerprint(request.payload.expectedDiscoveryFingerprint, "expectedDiscoveryFingerprint");
    fingerprint(request.payload.expectedImportFingerprint, "expectedImportFingerprint");
    fingerprint(request.payload.expectedControlFingerprint, "expectedControlFingerprint");
    assertDuduSourcePublicPayload(request.payload.source, request.command);
    return;
  }
  if (request.command === "reconcile_dudu_readonly_historical_passes") {
    assertExactPublicPayload(request.payload, ["source", "expectedRevision", "expectedControlFingerprint"], request.command);
    assertRequiredPublicPayload(request.payload, ["source", "expectedRevision", "expectedControlFingerprint"], request.command);
    if (request.payload.expectedRevision !== 0) throw new Error(`${request.command}.expectedRevision 必须为 0。`);
    fingerprint(request.payload.expectedControlFingerprint, "expectedControlFingerprint");
    assertDuduSourcePublicPayload(request.payload.source, request.command);
    return;
  }
  if (request.command === "prepare_studio_video_package_export") {
    assertExactPublicPayload(request.payload, [
      "authority", "expectedRevision", "expectedControlFingerprint", "expectedManagedSource",
    ], request.command);
    assertRequiredPublicPayload(request.payload, ["authority", "expectedRevision", "expectedControlFingerprint"], request.command);
    const authority = request.payload.authority as StudioVideoPackageAuthorityInput;
    if (!authority || (authority.kind !== "studio-review" && authority.kind !== "historical-import")) {
      throw new Error(`${request.command}.authority.kind 无效。`);
    }
    assertExactPublicPayload(authority, authority.kind === "studio-review"
      ? ["kind", "reviewId"] : ["kind", "packId"], `${request.command}.authority`);
    const authorityId = authority.kind === "studio-review" ? authority.reviewId : authority.packId;
    if (!P30_STABLE_ID_PATTERN.test(authorityId)) throw new Error(`${request.command}.authority 稳定 ID 无效。`);
    if (!Number.isSafeInteger(request.payload.expectedRevision) || request.payload.expectedRevision < 1) {
      throw new Error(`${request.command}.expectedRevision 必须为正整数。`);
    }
    fingerprint(request.payload.expectedControlFingerprint, "expectedControlFingerprint");
    if (authority.kind === "historical-import") {
      if (request.payload.expectedManagedSource !== undefined) {
        throw new Error(`${request.command}.expectedManagedSource 不适用于 historical-import。`);
      }
      return;
    }
    const source = request.payload.expectedManagedSource;
    if (!source) throw new Error(`${request.command}.expectedManagedSource 对 studio-review 必填。`);
    const sourceKeys = [
      "adapterKind", "reviewId", "expectedSourceFingerprint", "expectedReviewFingerprint",
      "expectedPackFingerprint", "expectedUnitSnapshotFingerprint",
      "expectedObservationControlFingerprint", "expectedObservationHeadRevision",
      "expectedObservationStatus", "expectedObservationHeadId",
      "expectedObservationHeadFingerprint", "expectedObservationEvidenceSha256",
    ] as const;
    assertExactPublicPayload(source, sourceKeys, `${request.command}.expectedManagedSource`);
    assertRequiredPublicPayload(source, sourceKeys, `${request.command}.expectedManagedSource`);
    if (source.adapterKind !== "managed-evidence-v1"
      || source.reviewId !== authority.reviewId
      || !P30_STABLE_ID_PATTERN.test(source.reviewId)
      || !Number.isSafeInteger(source.expectedObservationHeadRevision)
      || source.expectedObservationHeadRevision < 0
      || (source.expectedObservationStatus !== "missing"
        && source.expectedObservationStatus !== "current"
        && source.expectedObservationStatus !== "stale")) {
      throw new Error(`${request.command}.expectedManagedSource 身份无效。`);
    }
    for (const field of [
      "expectedSourceFingerprint", "expectedReviewFingerprint", "expectedPackFingerprint",
      "expectedUnitSnapshotFingerprint", "expectedObservationControlFingerprint",
    ] as const) {
      fingerprint(source[field], `expectedManagedSource.${field}`);
    }
    const headPresent = source.expectedObservationHeadId !== null
      || source.expectedObservationHeadFingerprint !== null;
    if ((source.expectedObservationHeadId === null)
      !== (source.expectedObservationHeadFingerprint === null)
      || (source.expectedObservationHeadId !== null
        && !P30_STABLE_ID_PATTERN.test(source.expectedObservationHeadId))
      || (source.expectedObservationHeadFingerprint !== null
        && !P30_SHA256_PATTERN.test(source.expectedObservationHeadFingerprint))
      || (source.expectedObservationEvidenceSha256 !== null
        && !P30_SHA256_PATTERN.test(source.expectedObservationEvidenceSha256))
      || (source.expectedObservationHeadRevision === 0 && headPresent)
      || (source.expectedObservationHeadRevision > 0 && !headPresent)) {
      throw new Error(`${request.command}.expectedManagedSource Observation Head 身份不闭合。`);
    }
    return;
  }
  if (request.command === "build_studio_video_package") {
    assertExactPublicPayload(request.payload, [
      "intentId", "expectedRevision", "expectedIntentControlFingerprint",
      "expectedAuthorityControlFingerprint", "destinationPolicy",
    ], request.command);
    assertRequiredPublicPayload(request.payload, [
      "intentId", "expectedRevision", "expectedIntentControlFingerprint",
      "expectedAuthorityControlFingerprint", "destinationPolicy",
    ], request.command);
    fingerprint(request.payload.expectedIntentControlFingerprint, "expectedIntentControlFingerprint");
    fingerprint(request.payload.expectedAuthorityControlFingerprint, "expectedAuthorityControlFingerprint");
    if (!P30_STABLE_ID_PATTERN.test(request.payload.intentId)
      || !Number.isSafeInteger(request.payload.expectedRevision) || request.payload.expectedRevision < 1) {
      throw new Error(`${request.command} intentId/expectedRevision 无效。`);
    }
    if (request.payload.destinationPolicy !== "managed-evidence-only") {
      throw new Error(`${request.command}.destinationPolicy 仅允许 managed-evidence-only。`);
    }
  }
}

function isDurableReconciliationCommand(request: CommandRequest): request is DurableReconciliationCommandRequest {
  return DURABLE_RECONCILIATION_COMMAND_NAMES.has(request.command as DurableReconciliationCommandRequest["command"]);
}

function durableReconciliationSnapshot(request: CommandRequest): DurableCommandReconciliationSnapshot | undefined {
  return isDurableReconciliationCommand(request)
    ? { schemaVersion: 1, request: structuredClone(commandRequestForPersistence(request)) as DurableReconciliationCommandRequest }
    : undefined;
}

function localCreativeMaterializationProof(
  operationId: string,
  outcome: LocalCreativeProductionUnitMaterializationReceipt,
): DurableCommandProof {
  return {
    source: "local_creative_production_unit_receipts",
    identity: {
      operationId,
      receiptFingerprint: outcome.fingerprint,
      previewFingerprint: outcome.previewFingerprint,
      sourceFingerprint: outcome.sourceFingerprint,
      unitIds: outcome.units.map((unit) => unit.unitId),
    },
    result: { ...outcome, replayed: true, reconciled: true },
  };
}

function reconciliationRequestFromRecord(projectRoot: string, record: IdempotentCommandResult): DurableReconciliationCommandRequest | undefined {
  const snapshot = record.durableReconciliation;
  if (!snapshot || snapshot.schemaVersion !== 1 || !isDurableReconciliationCommand(snapshot.request)) return undefined;
  if (snapshot.request.command !== record.command || commandRequestHash(projectRoot, snapshot.request) !== record.requestHash) return undefined;
  return snapshot.request;
}

function novelImportResultAnchorFromResult(result: unknown): NovelImportResultAnchor {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("小说导入账本结果缺少可验证 receipt 锚点。");
  }
  const receipt = (result as Record<string, unknown>).receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("小说导入账本结果缺少 receipt 对象。");
  }
  const value = receipt as Record<string, unknown>;
  for (const key of [
    "receiptId", "projectId", "fingerprint", "stateChainFingerprint", "chapterManifestSha256",
  ] as const) {
    if (typeof value[key] !== "string" || !value[key]) {
      throw new Error(`小说导入账本 receipt 缺少 ${key} 锚点。`);
    }
  }
  return {
    schemaVersion: 1,
    kind: "novel-import-result-anchor",
    receiptId: String(value.receiptId),
    projectId: String(value.projectId),
    receiptFingerprint: String(value.fingerprint),
    stateChainFingerprint: String(value.stateChainFingerprint),
    chapterManifestSha256: String(value.chapterManifestSha256),
    canonicalReceiptSha256: createHash("sha256").update(stable(receipt)).digest("hex"),
  };
}

function assertNovelImportResultMatchesAnchor(
  result: unknown,
  expected: NovelImportResultAnchor,
): void {
  const actual = novelImportResultAnchorFromResult(result);
  if (stable(actual) !== stable(expected)) {
    throw new Error("小说导入当前 registered 闭包与首次成功账本锚点不一致。");
  }
}

function existingNovelImportResultAnchor(record: IdempotentCommandResult): NovelImportResultAnchor | null {
  const persisted = record.novelImportResultAnchor;
  if (persisted) {
    if (persisted.schemaVersion !== 1 || persisted.kind !== "novel-import-result-anchor") {
      throw new Error("小说导入账本锚点结构无效。");
    }
    if (record.result !== undefined) assertNovelImportResultMatchesAnchor(record.result, persisted);
    return persisted;
  }
  return record.result === undefined ? null : novelImportResultAnchorFromResult(record.result);
}

function expectedNovelImportResultAnchor(record: IdempotentCommandResult): NovelImportResultAnchor {
  const existing = existingNovelImportResultAnchor(record);
  if (!existing) throw new Error("小说导入 succeeded 账本缺少首次结果锚点。");
  return existing;
}

async function uniqueNovelImportRequestAnchor(
  storageRoot: string,
  requestHash: string,
): Promise<NovelImportResultAnchor | null> {
  const records = (await getCommandLedgerEntriesByRequestHash(storageRoot, requestHash))
    .filter((entry) => entry.command === "novel_import_external_snapshot") as IdempotentCommandResult[];
  let unique: NovelImportResultAnchor | null = null;
  for (const record of records) {
    const candidate = existingNovelImportResultAnchor(record);
    if (!candidate) continue;
    if (unique && stable(unique) !== stable(candidate)) {
      throw new Error("同一小说导入 requestHash 存在互相冲突的历史结果锚点，拒绝继续。");
    }
    unique = candidate;
  }
  return unique;
}

async function proveSafeCompletedNovelImportResult(
  request: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>,
  requestHash: string,
  ledgerRecord: IdempotentCommandResult,
): Promise<unknown> {
  const completed = await proveCompletedNovelExternalImport(request.payload, requestHash);
  if (!completed) {
    throw new Error("小说导入账本虽标记 succeeded，但未找到完整 registered 业务闭包；拒绝按账本伪成功重放。");
  }
  const { projectRoot: _absoluteProjectRoot, ...safeResult } = completed;
  const replay = { ...safeResult, replayed: true };
  assertNovelImportResultMatchesAnchor(replay, expectedNovelImportResultAnchor(ledgerRecord));
  return replay;
}

async function downgradeSucceededNovelImportClosureDrift(
  storageRoot: string,
  record: IdempotentCommandResult,
  error: unknown,
): Promise<IdempotentCommandResult | undefined> {
  const observedAt = new Date().toISOString();
  const message = `小说导入 succeeded 账本与 registered 业务闭包漂移：${error instanceof Error ? error.message : String(error)}`;
  const drifted = await withProjectLock(storageRoot, "command-bus", async () => {
    const current = await getCommandByIdempotencyKey(storageRoot, record.idempotencyKey);
    if (!current || current.requestHash !== record.requestHash || current.command !== record.command) return current;
    if (current.status === "succeeded") {
      current.novelImportResultAnchor ??= expectedNovelImportResultAnchor(current);
      current.status = "unknown";
      current.result = undefined;
      current.error = { message, observedAt };
      current.executedAt = observedAt;
      await persistCommandLedgerEntry(storageRoot, current, observedAt);
    }
    return current;
  });
  if (drifted?.status === "unknown") {
    await appendEvent(storageRoot, {
      actor: "codex",
      type: "command.outcome-drift",
      requestId: drifted.requestId,
      idempotencyKey: drifted.idempotencyKey,
      command: drifted.command,
      data: {
        requestHash: drifted.requestHash,
        observedAt,
        reason: "registered-business-closure-invalid",
      },
    });
  }
  return drifted;
}

async function proveDurableOutcome(projectRoot: string, request: DurableReconciliationCommandRequest): Promise<DurableCommandProof | undefined> {
  try {
    if (request.command === "novel_import_external_snapshot") {
      const operationId = commandRequestHash(projectRoot, request);
      const outcome = await runWithOperationContext(
        {
          requestId: `reconcile-${operationId.slice(0, 32)}`,
          idempotencyKey: `novel-import-reconcile-${operationId.slice(0, 32)}`,
          requestHash: operationId,
          command: request.command,
        },
        () => commitNovelExternalImport(request.payload),
      );
      const { projectRoot: _absoluteProjectRoot, ...safeOutcome } = outcome;
      return {
        source: "novel_import_receipts",
        identity: {
          operationId,
          receiptId: outcome.receipt.receiptId,
          projectId: outcome.receipt.projectId,
          receiptFingerprint: outcome.receipt.fingerprint,
          stateChainFingerprint: outcome.receipt.stateChainFingerprint,
        },
        result: { ...safeOutcome, replayed: true, reconciled: true },
      };
    }
    if (request.command === "novel_import_writing_source_snapshot") {
      const operationId = commandRequestHash(projectRoot, request);
      const outcome = await runWithOperationContext(
        {
          requestId: `reconcile-${operationId.slice(0, 32)}`,
          idempotencyKey: `writing-source-reconcile-${operationId.slice(0, 32)}`,
          requestHash: operationId,
          command: request.command,
        },
        () => new NovelRepository(projectRoot).importWritingSourceSnapshot(request.payload),
      );
      return {
        source: "novel_writing_source_snapshot_receipts",
        identity: {
          operationId,
          receiptId: outcome.receipt.receiptId,
          projectId: outcome.receipt.projectId,
          receiptFingerprint: outcome.receipt.fingerprint,
        },
        result: { ...outcome, replayed: true, reconciled: true },
      };
    }
    if (request.command === "novel_review_chapter_state_candidate"
      || request.command === "novel_review_story_bible_candidate"
      || request.command === "novel_invalidate_writing_state_from") {
      const operationId = commandRequestHash(projectRoot, request);
      const proof = await loadNovelWritingStateOperationProof(projectRoot, operationId);
      if (!proof || proof.command !== request.command) return undefined;
      const result = proof.result && typeof proof.result === "object" && !Array.isArray(proof.result)
        ? { ...proof.result as Record<string, unknown>, replayed: true, reconciled: true }
        : proof.result;
      return {
        source: "novel_writing_state_operation_receipts",
        identity: { operationId, projectId: proof.projectId, command: proof.command },
        result,
      };
    }
    if (request.command === "stage_dudu_readonly_managed_project") {
      const operationId = commandRequestHash(projectRoot, request);
      const {
        expectedRevision: _expectedRevision,
        expectedDiscoveryFingerprint: _expectedDiscoveryFingerprint,
        ...input
      } = request.payload;
      const outcome = await proveDuduReadonlyStageCommandOutcome(input, operationId);
      if (!outcome) return undefined;
      return {
        source: "dudu_readonly_import_receipts",
        identity: {
          operationId,
          projectId: outcome.projectId,
          importFingerprint: outcome.importFingerprint,
          sourceManifestFingerprint: outcome.sourceManifestFingerprint,
        },
        result: { ...outcome, replayed: true, reconciled: true },
      };
    }
    if (request.command === "finalize_dudu_readonly_managed_project") {
      const operationId = commandRequestHash(projectRoot, request);
      const outcome = await proveDuduReadonlyFinalizationOutcome(
        projectRoot,
        request.payload.source,
        request.payload.expectedImportFingerprint,
        operationId,
      );
      if (!outcome) return undefined;
      return {
        source: "dudu_readonly_import_receipts",
        identity: {
          operationId,
          projectId: outcome.projectId,
          importFingerprint: outcome.importFingerprint,
          activationId: outcome.activationId,
          activationReceiptFingerprint: outcome.activation.fingerprint,
        },
        result: outcome,
      };
    }
    if (request.command === "materialize_local_creative_production_units") {
      const operationId = commandRequestHash(projectRoot, request);
      const outcome = await readLocalCreativeProductionUnitMaterializationOutcome(projectRoot, {
        ...request.payload,
        idempotencyKey: operationId,
      });
      if (!outcome) return undefined;
      return localCreativeMaterializationProof(operationId, outcome);
    }
    if (request.command === "prepare_studio_video_package_export") {
      const operationId = commandRequestHash(projectRoot, request);
      const intent = await readStudioVideoPackageExportIntentByOperationId(projectRoot, operationId);
      const expectedSource = request.payload.expectedManagedSource;
      if (!intent || intent.schemaVersion !== 4
        || intent.unitRevision !== request.payload.expectedRevision
        || (request.payload.authority.kind === "historical-import"
          ? intent.authorityKind !== "historical-import" || intent.packId !== request.payload.authority.packId
          : intent.authorityKind !== "studio-review"
            || intent.authorityId !== request.payload.authority.reviewId
            || !expectedSource
            || intent.schemaVersion !== 4
            || intent.managedSourceFingerprint !== expectedSource.expectedSourceFingerprint
            || intent.managedSourceUnitSnapshotFingerprint !== expectedSource.expectedUnitSnapshotFingerprint
            || intent.observationControlFingerprint !== expectedSource.expectedObservationControlFingerprint
            || intent.observationControlStatus !== expectedSource.expectedObservationStatus
            || intent.observationHeadRevision !== expectedSource.expectedObservationHeadRevision
            || (intent.observationId ?? null) !== expectedSource.expectedObservationHeadId
            || (intent.observationHeadFingerprint ?? null) !== expectedSource.expectedObservationHeadFingerprint
            || (intent.observationEvidenceSha256 ?? null) !== expectedSource.expectedObservationEvidenceSha256)) {
        return undefined;
      }
      return {
        source: "studio_video_package_ledger",
        identity: { operationId, intentId: intent.intentId, inputFingerprint: intent.inputFingerprint },
        result: { intent, replayed: true, reconciled: true },
      };
    }
    if (request.command === "build_studio_video_package") {
      const operationId = commandRequestHash(projectRoot, request);
      const operationIntent = await readStudioVideoPackageExportIntentByOperationId(projectRoot, operationId);
      if (!operationIntent || operationIntent.intentId !== request.payload.intentId) return undefined;
      const intentLookup = await getStudioVideoPackageControl(projectRoot, {
        by: "intent",
        intentId: request.payload.intentId,
      });
      const intent = intentLookup.control?.intent;
      if (!intentLookup.control?.receipt || !intent
        || intent.unitRevision !== request.payload.expectedRevision
        || intentLookup.control.receipt.storageKind !== "managed-evidence"
        || intentLookup.control.status !== "mechanically-verified") return undefined;
      const authority: StudioVideoPackageAuthorityInput = intent.authorityKind === "historical-import"
        ? { kind: "historical-import", packId: intent.packId }
        : { kind: "studio-review", reviewId: intent.authorityId };
      const authorityLookup = await getStudioVideoPackageControl(projectRoot, {
        by: "authority-latest",
        authority,
      });
      if (authorityLookup.status !== "resolved"
        || authorityLookup.selectedIntentId !== intent.intentId
        || authorityLookup.selectedIsDestinationHead !== true
        || authorityLookup.control?.intent.intentId !== intent.intentId) return undefined;
      return {
        source: "studio_video_package_ledger",
        identity: {
          operationId,
          intentId: intent.intentId,
          receiptId: intentLookup.control.receipt.receiptId,
          manifestSha256: intentLookup.control.receipt.manifestSha256,
        },
        result: {
          intent,
          receipt: intentLookup.control.receipt,
          replayed: true,
          reconciled: true,
        },
      };
    }
    if (request.command === "attach_studio_multimedia_timeline_media") {
      const operationId = commandRequestHash(projectRoot, request);
      const binding = await readStudioMultimediaTimelineBindingByOperationId(projectRoot, operationId);
      const payload = request.payload;
      const normalizedNote = (payload.note ?? "").trim();
      if (!binding
        || binding.unitId !== payload.unitId
        || binding.unitRevision !== payload.unitRevision
        || binding.unitFingerprint !== payload.expectedUnitFingerprint
        || binding.slotId !== payload.slotId
        || binding.revision !== payload.expectedHeadRevision + 1
        || binding.panelIndex !== payload.panelIndex
        || binding.startSeconds !== payload.startSeconds
        || binding.endSeconds !== payload.endSeconds
        || binding.role !== payload.role
        || binding.mediaSha256 !== payload.mediaSha256
        || binding.note !== normalizedNote) {
        return undefined;
      }
      return {
        source: "studio_multimedia_timeline_bindings",
        identity: {
          operationId,
          recordId: binding.recordId,
          bindingFingerprint: binding.fingerprint,
          unitId: binding.unitId,
          slotId: binding.slotId,
          revision: binding.revision,
        },
        result: { binding, replayed: true, reconciled: true },
      };
    }
    if (request.command === "prepare_studio_imagegen_call") {
      const intent = await readStudioImagegenCallIntentByRun(projectRoot, request.payload.generationRunId);
      const expectedCommandRequestId = commandRequestHash(projectRoot, request);
      if (!intent
        || intent.commandRequestId !== expectedCommandRequestId
        || intent.packId !== request.payload.packId
        || intent.packFingerprint !== request.payload.packFingerprint
        || intent.provider !== request.payload.provider
        || intent.targetKind !== "unit-grid") return undefined;
      return {
        source: "studio_generation_call_ledger",
        identity: {
          callId: intent.callId,
          generationRunId: intent.generationRunId,
          inputFingerprint: intent.inputFingerprint,
          status: intent.status,
        },
        // 崩溃恢复绝不能再次授予模型调用；只返回既有 intent 身份。
        result: { ...intent, callAllowed: false, idempotentReplay: true, reconciled: true },
      };
    }
    if (request.command === "reconcile_studio_imagegen_call") {
      await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
      const expectedEvidenceReference = request.payload.evidenceReference.trim().slice(0, 500);
      const expectedNote = (request.payload.note ?? "").trim().slice(0, 500);
      const events = await readStudioImagegenCallEventHistory(projectRoot, request.payload.callId);
      const event = events.find((candidate) => candidate.kind === request.payload.result
        && candidate.evidenceReference === expectedEvidenceReference
        && candidate.evidenceFingerprint === request.payload.evidenceFingerprint.trim().toLowerCase()
        && candidate.note === expectedNote);
      if (!event) return undefined;
      return {
        source: "studio_generation_call_ledger",
        identity: { callId: event.callId, eventId: event.eventId, kind: event.kind },
        result: { ...event, reconciled: true },
      };
    }
    if (request.command === "abandon_studio_generation_unknown") {
      await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
      const intent = await readStudioImagegenCallIntentByRun(projectRoot, request.payload.generationRunId);
      if (!intent || intent.callId !== request.payload.callId || intent.status !== "owner-abandoned") return undefined;
      const history = await readStudioGenerationRunEventHistory(projectRoot, request.payload.generationRunId);
      const match = history.find((event) => event.kind === "cancelled"
        && sameStudioGenerationUnknownOwnerAbandonDetail(event.detail, {
          evidenceReference: request.payload.evidenceReference,
          evidenceFingerprint: request.payload.evidenceFingerprint,
          reason: request.payload.reason,
        }));
      if (!match) return undefined;
      return {
        source: "studio_generation_plan_run_ledger",
        identity: {
          callId: intent.callId,
          generationRunId: match.generationRunId,
          eventId: match.eventId,
          disposition: "owner-abandoned-generation-unknown",
        },
        result: { ...match, callId: intent.callId, status: intent.status, reconciled: true },
      };
    }
    if (request.command === "abandon_studio_detached_generation_unknown") {
      const disposition = await readStudioDetachedGenerationUnknownDisposition(
        projectRoot,
        request.payload.observationId,
      );
      const authorizationTextSha256 = createHash("sha256")
        .update(request.payload.authorizationText, "utf8")
        .digest("hex");
      if (!disposition
        || disposition.observationFingerprint !== request.payload.expectedObservationFingerprint
        || disposition.authorizationEvidenceReference !== request.payload.authorizationEvidenceReference
        || disposition.authorizationTextSha256 !== request.payload.authorizationTextSha256
        || authorizationTextSha256 !== request.payload.authorizationTextSha256
        || disposition.reason !== request.payload.reason.trim()
        || disposition.projectContext.contextTokenHash
          !== studioImagegenContextTokenHash(request.payload.projectContextToken)
        || disposition.detachedCandidatePolicy !== "never-import-or-reuse"
        || disposition.nextRunPolicy !== "fresh-formal-run-only"
        || disposition.callAllowed !== false) return undefined;
      return {
        source: "studio_generation_detached_disposition_ledger",
        identity: {
          observationId: disposition.observationId,
          dispositionId: disposition.dispositionId,
          fingerprint: disposition.fingerprint,
        },
        result: { ...disposition, idempotentReplay: true, reconciled: true },
      };
    }
    if (request.command === "rebind_studio_imagegen_call_context") {
      await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
      const rebind = await readStudioImagegenCallContextRebindByRun(
        projectRoot,
        request.payload.generationRunId,
      );
      if (!rebind
        || rebind.callId !== request.payload.callId
        || rebind.packId !== request.payload.packId
        || rebind.packFingerprint !== request.payload.packFingerprint
        || rebind.inputFingerprint !== request.payload.inputFingerprint
        || rebind.candidateSha256 !== request.payload.candidateSha256
        || rebind.receiptSha256 !== request.payload.receiptSha256
        || rebind.evidenceReference !== request.payload.evidenceReference.trim().slice(0, 500)
        || rebind.evidenceFingerprint !== request.payload.evidenceFingerprint.trim().toLowerCase()
        || rebind.reason !== request.payload.reason.normalize("NFC").trim()
        || rebind.toContextTokenHash !== studioImagegenContextTokenHash(request.payload.projectContextToken)
        || rebind.acknowledgeBuildChangedAfterInvocation !== true
        || rebind.acknowledgeNoSecondModelCall !== true
        || rebind.callAllowed !== false) return undefined;
      return {
        source: "studio_generation_call_ledger",
        identity: {
          callId: rebind.callId,
          generationRunId: rebind.generationRunId,
          eventId: rebind.eventId,
          fromContextTokenHash: rebind.fromContextTokenHash,
          toContextTokenHash: rebind.toContextTokenHash,
        },
        result: { ...rebind, idempotentReplay: true, reconciled: true },
      };
    }
    if (request.command === "commit_agent_imagegen_result_bundle") {
      const outcome = await proveAgentImagegenResultBundleOutcome(projectRoot, request.payload);
      if (!outcome) return undefined;
      return {
        source: "studio_agent_imagegen_writeback_receipts",
        identity: {
          generationRunId: outcome.generationRunId,
          packId: outcome.packId,
          packFingerprint: outcome.packFingerprint,
          provider: outcome.provider,
          rawResultId: outcome.results.raw.resultId,
          labeledResultId: outcome.results.labeled.resultId,
          writebackReceiptFingerprint: outcome.writebackReceiptFingerprint,
        },
        result: { ...outcome, reconciled: true },
      };
    }
    if (request.command === "create_studio_generation_plan") {
      // 以 source_command_request_id=commandRequestHash 为锚：证明精确节点集的 plan 已落账。
      const expectedAnchor = commandRequestHash(projectRoot, request);
      const wanted = new Set(request.payload.nodes.map((node) => JSON.stringify([
        node.targetKind ?? "panel",
        node.targetKind === "unit-grid" ? `unit-grid:${node.unitId}` : `panel:${node.unitId}:${node.panelId}`,
      ])));
      const candidates = await listStudioGenerationPlanProjections(projectRoot, { limit: 36 });
      const plan = candidates.find((candidate) => candidate.sourceCommandRequestId === expectedAnchor
        && candidate.nodes.length === wanted.size
        && candidate.nodes.every((node) => wanted.has(JSON.stringify([node.targetKind, node.targetKey]))));
      if (!plan) return undefined;
      return {
        source: "studio_generation_plan_run_ledger",
        identity: { planId: plan.planId, sourceCommandRequestId: plan.sourceCommandRequestId, nodeCount: plan.nodeCount },
        result: { ...plan, reconciled: true },
      };
    }
    if (request.command === "fail_studio_generation_run") {
      // 内容匹配任意位置：目标 failed 事件被 retry-superseded 覆盖也不影响证明。
      const history = await readStudioGenerationRunEventHistory(projectRoot, request.payload.generationRunId);
      const match = history.find((event) => {
        if (event.kind !== "failed") return false;
        const detail = event.detail as { errorClass?: unknown; detail?: unknown };
        return detail.errorClass === request.payload.errorClass && (detail.detail ?? "") === (request.payload.detail ?? "");
      });
      if (!match) return undefined;
      return {
        source: "studio_generation_plan_run_ledger",
        identity: { generationRunId: match.generationRunId, eventId: match.eventId, kind: match.kind },
        result: { ...match, reconciled: true },
      };
    }
    if (request.command === "cancel_studio_generation_run") {
      const history = await readStudioGenerationRunEventHistory(projectRoot, request.payload.generationRunId);
      const match = history.find((event) => event.kind === "cancelled");
      if (!match) return undefined;
      return {
        source: "studio_generation_plan_run_ledger",
        identity: { generationRunId: match.generationRunId, eventId: match.eventId, kind: match.kind },
        result: { ...match, reconciled: true },
      };
    }
    if (request.command === "retry_studio_generation_plan_nodes") {
      // 事件链证明：范围内每节点找"带 supersedes_run_id 的 dispatched 事件"（retry 产物，
      // adopted legacy 的 attempt:1 形态也覆盖）；否则该节点须本就不在 failed/cancelled（合法 skipped）。
      const plan = await getStudioGenerationPlanProjection(projectRoot, request.payload.planId);
      if (!plan) return undefined;
      const inScope = request.payload.nodeIndexes ?? plan.nodes.map((node) => node.nodeIndex);
      const retried: Array<{ nodeIndex: number; generationRunId: string; attempt: number }> = [];
      const skipped: Array<{ nodeIndex: number; reason: string }> = [];
      for (const nodeIndex of inScope) {
        const node = plan.nodes.find((entry) => entry.nodeIndex === nodeIndex);
        if (!node) return undefined;
        const nodeEvents = await readStudioGenerationPlanNodeEventHistory(projectRoot, plan.planId, nodeIndex);
        const retryDispatch = [...nodeEvents].reverse().find((event) => event.kind === "dispatched" && event.supersedesRunId);
        if (retryDispatch) {
          retried.push({ nodeIndex, generationRunId: retryDispatch.generationRunId, attempt: retryDispatch.attempt });
        } else if (node.status !== "failed" && node.status !== "cancelled") {
          skipped.push({ nodeIndex, reason: `当前状态 ${node.status} 无需/不可重试` });
        } else {
          return undefined;
        }
      }
      return {
        source: "studio_generation_plan_run_ledger",
        identity: { planId: plan.planId, retriedRunIds: retried.map((entry) => entry.generationRunId) },
        result: { planId: plan.planId, retried, skipped, reconciled: true },
      };
    }
    if (request.command === "append_studio_script_section_revision") {
      // 章节命令只从 immutable revision 行证明精确 payload 已落地；不重放
      // append，也不要求该 revision 仍为 Head，避免后续合法修订抹去恢复证据。
      const section = await proveStudioScriptSectionRevisionAppend(projectRoot, request.payload);
      if (!section) return undefined;
      return {
        source: "studio_script_section_revisions",
        identity: {
          table: "studio_script_section_revisions",
          revisionId: section.id,
          sectionId: section.sectionId,
          revision: section.revision,
          fingerprint: section.fingerprint,
        },
        result: {
          ...section,
          reconciled: true,
        },
      };
    }
    if (request.command === "append_studio_continuity_observation"
      || request.command === "append_studio_continuity_correction") {
      // P7 连续性恢复只认业务事务内的 immutable operation receipt。operationId
      // 是完整公开命令的 request hash，因此既不重放 append，也不从当前 Head 猜测。
      const operationId = commandRequestHash(projectRoot, request);
      const receipt = await readStudioContinuityOperationReceipt(projectRoot, operationId);
      const expectedCommand = request.command === "append_studio_continuity_observation"
        ? "append-observation"
        : "append-correction";
      if (!receipt
        || receipt.operationId !== operationId
        || receipt.command !== expectedCommand
        || receipt.entry.entryKind !== (expectedCommand === "append-observation" ? "observation" : "correction")
        || receipt.entry.subjectId !== request.payload.subjectId.trim()
        || receipt.entry.field !== request.payload.field
        || receipt.entry.scope.kind !== request.payload.scope.kind
        || receipt.entry.scope.scopeId !== request.payload.scope.scopeId.trim()
        || receipt.entry.scope.unitId !== request.payload.scope.unitId.trim()
        || receipt.entry.scope.unitRevision !== request.payload.scope.unitRevision
        || receipt.entry.scope.startMilliseconds !== request.payload.scope.startMilliseconds
        || receipt.entry.scope.endMilliseconds !== request.payload.scope.endMilliseconds
        || receipt.head.revision !== request.payload.expectedHeadRevision + 1) return undefined;
      if (request.command === "append_studio_continuity_correction"
        && receipt.entry.supersedesEntryId !== request.payload.supersedesEntryId.trim()) return undefined;
      return {
        source: "studio_continuity_operation_receipts",
        identity: {
          table: "studio_continuity_operation_receipts",
          operationId,
          receiptId: receipt.receiptId,
          requestFingerprint: receipt.requestFingerprint,
          entryId: receipt.entry.id,
          resultFingerprint: receipt.fingerprint,
        },
        result: {
          ...receipt,
          reconciled: true,
        },
      };
    }
    if (request.command === "submit_studio_generation_review") {
      // Review receipt API 先按 command request hash 定位 immutable operation row，
      // 再投影同一 review event；只校验不可变输入语义，不要求它仍是当前 Head。
      const operationId = commandRequestHash(projectRoot, request);
      const outcome = await readStudioGenerationReviewOperationOutcome(projectRoot, operationId);
      const expectedSupersedesReviewId = request.payload.supersedesReviewId?.trim();
      const expectedCriteria = request.payload.criteria
        .map((criterion) => ({
          code: criterion.code.trim(),
          status: criterion.status,
          note: criterion.note?.trim() ?? "",
        }))
        .sort((left, right) => left.code.localeCompare(right.code, "en"));
      const expectedAnnotations = (request.payload.annotations ?? []).map((annotation) => ({
        ...annotation,
        id: annotation.id.trim(),
        note: annotation.note.trim(),
      }));
      if (!outcome
        || outcome.generationRunId !== request.payload.generationRunId.trim()
        || outcome.kind !== request.payload.kind
        || outcome.baseHeadRevision !== request.payload.expectedHeadRevision
        || outcome.supersedesReviewId !== expectedSupersedesReviewId
        || outcome.rawResultId !== request.payload.rawResultId.trim()
        || outcome.rawSha256 !== request.payload.rawSha256
        || outcome.labeledResultId !== request.payload.labeledResultId.trim()
        || outcome.labeledSha256 !== request.payload.labeledSha256
        || outcome.packFingerprint !== request.payload.expectedPackFingerprint
        || outcome.continuityFingerprint !== request.payload.continuityFingerprint
        || outcome.decision !== request.payload.decision
        || outcome.reviewer !== request.payload.reviewer.trim()
        || outcome.note !== request.payload.note.trim()
        || stable(outcome.criteria) !== stable(expectedCriteria)
        || stable(outcome.annotations) !== stable(expectedAnnotations)) return undefined;
      return {
        source: "studio_generation_review_operation_receipts",
        identity: {
          table: "studio_generation_review_operation_receipts",
          operationId,
          reviewId: outcome.reviewId,
          generationRunId: outcome.generationRunId,
          resultFingerprint: outcome.fingerprint,
        },
        result: {
          ...outcome,
          reconciled: true,
        },
      };
    }
    if (request.command === "submit_studio_post_result_observation") {
      // 实际末态只能凭 observation owner 的 immutable operation receipt 对账。
      // 不调用 submit 回放，以免“无回执”的未知执行在恢复路径里产生新写。
      const operationId = commandRequestHash(projectRoot, request);
      const outcome = await proveStudioPostResultObservationOutcome(projectRoot, {
        ...request.payload,
        operationId,
      });
      if (!outcome) return undefined;
      return {
        source: "studio_post_result_observation_operation_receipts",
        identity: {
          table: "studio_post_result_observation_operation_receipts",
          operationId,
          observationId: outcome.observationId,
          generationRunId: outcome.generationRunId,
          outcomeFingerprint: outcome.fingerprint,
        },
        result: {
          ...outcome,
          reconciled: true,
        },
      };
    }
    if (request.command === "refresh_studio_generation_checkpoint"
      || request.command === "attest_studio_generation_checkpoint") {
      const operationId = commandRequestHash(projectRoot, request);
      const receipt = await readStudioGenerationCheckpointOperationReceipt(projectRoot, operationId);
      const expectedKind = request.command === "refresh_studio_generation_checkpoint" ? "refresh" : "attest";
      const expectedOutcomeKind = expectedKind === "refresh" ? "checkpoint" : "attestation";
      if (!receipt
        || receipt.operationId !== operationId
        || receipt.operationKind !== expectedKind
        || receipt.outcomeKind !== expectedOutcomeKind
        || receipt.outcome.batchNumber !== request.payload.batchNumber) return undefined;
      if (request.command === "refresh_studio_generation_checkpoint") {
        if (receipt.outcomeKind !== "checkpoint"
          || receipt.outcome.headRevision < request.payload.expectedHeadRevision) return undefined;
      } else {
        if (receipt.outcomeKind !== "attestation"
          || receipt.outcome.checkpointId !== request.payload.checkpointId.trim()
          || receipt.outcome.checkpointFingerprint !== request.payload.checkpointFingerprint
          || receipt.outcome.baseHeadRevision !== request.payload.expectedHeadRevision
          || receipt.outcome.decision !== request.payload.decision
          || receipt.outcome.reviewer !== request.payload.reviewer.trim()
          || receipt.outcome.note !== request.payload.note.trim()) return undefined;
      }
      return {
        source: "studio_generation_checkpoint_operation_receipts",
        identity: {
          table: "studio_generation_checkpoint_operation_receipts",
          operationId,
          operationKind: receipt.operationKind,
          outcomeId: receipt.outcomeId,
          outcomeFingerprint: receipt.outcomeFingerprint,
        },
        result: {
          ...receipt.outcome,
          operationReceipt: {
            operationId: receipt.operationId,
            operationKind: receipt.operationKind,
            inputFingerprint: receipt.inputFingerprint,
            outcomeId: receipt.outcomeId,
            outcomeFingerprint: receipt.outcomeFingerprint,
          },
          reconciled: true,
        },
      };
    }
    if (isStudioBindingOperationCommand(request.command)) {
      // P6 恢复边界只读追加式 studio_binding_operation_receipts。
      // 不重新执行 analyze/resolve/freeze，也不读其他 head 推测成功。
      const requestHash = commandRequestHash(projectRoot, request);
      const proven = await proveStudioBindingOperationOutcome(projectRoot, requestHash, request.command);
      if (!proven) return undefined;
      const { receipt, outcome } = proven;
      if (
        !receipt
        || receipt.requestHash !== requestHash
        || receipt.command !== request.command
        || receipt.inputFingerprint !== request.payload.expectedRevisionToken.trim().toLowerCase()) return undefined;
      const expectedKind = request.command === "analyze_studio_script_entities"
        ? "studio-binding-analyze-outcome"
        : request.command === "resolve_studio_entity_proposal"
          ? "studio-binding-resolve-outcome"
          : request.command === "confirm_studio_panel_empty"
            ? "studio-binding-confirm-empty-outcome"
            : "studio-binding-freeze-outcome";
      if (outcome.kind !== expectedKind
        || outcome.unitId !== request.payload.unitId
        || outcome.panelId !== request.payload.panelId) return undefined;
      const proofIdentity = {
        table: "studio_binding_operation_receipts",
        receiptId: receipt.id,
        requestHash: receipt.requestHash,
        command: receipt.command,
        inputFingerprint: receipt.inputFingerprint,
        outcomeFingerprint: receipt.outcomeFingerprint,
      };
      if (request.command === "analyze_studio_script_entities") {
        if (typeof outcome.analysisId !== "string"
          || !Number.isSafeInteger(outcome.analysisRevision)
          || Number(outcome.analysisRevision) < 1
          || typeof outcome.analysisFingerprint !== "string"
          || !/^[a-f0-9]{64}$/u.test(outcome.analysisFingerprint)) return undefined;
        return {
          source: "studio_binding_operation_receipts",
          identity: proofIdentity,
          result: {
            receiptId: receipt.id,
            receiptFingerprint: receipt.outcomeFingerprint,
            analysisId: outcome.analysisId,
            analysisRevision: outcome.analysisRevision,
            analysisFingerprint: outcome.analysisFingerprint,
            unitId: outcome.unitId,
            panelId: outcome.panelId,
            reconciled: true,
            message: "已从追加式 Studio binding 操作收据对账解析结果。",
          },
        };
      }
      if (request.command === "resolve_studio_entity_proposal") {
        if (outcome.proposalId !== request.payload.proposalId
          || typeof outcome.decisionId !== "string"
          || !Number.isSafeInteger(outcome.decisionRevision)
          || Number(outcome.decisionRevision) < 1
          || typeof outcome.decisionFingerprint !== "string"
          || !/^[a-f0-9]{64}$/u.test(outcome.decisionFingerprint)) return undefined;
        return {
          source: "studio_binding_operation_receipts",
          identity: proofIdentity,
          result: {
            receiptId: receipt.id,
            receiptFingerprint: receipt.outcomeFingerprint,
            decisionId: outcome.decisionId,
            decisionRevision: outcome.decisionRevision,
            decisionFingerprint: outcome.decisionFingerprint,
            unitId: outcome.unitId,
            panelId: outcome.panelId,
            proposalId: outcome.proposalId,
            reconciled: true,
            message: "已从追加式 Studio binding 操作收据对账人工决策。",
          },
        };
      }
      if (request.command === "confirm_studio_panel_empty") {
        if (typeof outcome.confirmationId !== "string"
          || !Number.isSafeInteger(outcome.confirmationRevision)
          || Number(outcome.confirmationRevision) < 1
          || typeof outcome.confirmationFingerprint !== "string"
          || !/^[a-f0-9]{64}$/u.test(outcome.confirmationFingerprint)) return undefined;
        return {
          source: "studio_binding_operation_receipts",
          identity: proofIdentity,
          result: {
            receiptId: receipt.id,
            receiptFingerprint: receipt.outcomeFingerprint,
            confirmationId: outcome.confirmationId,
            confirmationRevision: outcome.confirmationRevision,
            confirmationFingerprint: outcome.confirmationFingerprint,
            unitId: outcome.unitId,
            panelId: outcome.panelId,
            reconciled: true,
            message: "已从追加式 Studio binding 操作收据对账 confirmed-empty 裁决。",
          },
        };
      }
      if (typeof outcome.bindingSetId !== "string"
        || !Number.isSafeInteger(outcome.bindingSetRevision)
        || Number(outcome.bindingSetRevision) < 1
        || typeof outcome.bindingSetFingerprint !== "string"
        || !/^[a-f0-9]{64}$/u.test(outcome.bindingSetFingerprint)) return undefined;
      return {
        source: "studio_binding_operation_receipts",
        identity: proofIdentity,
        result: {
          receiptId: receipt.id,
          receiptFingerprint: receipt.outcomeFingerprint,
          bindingSetId: outcome.bindingSetId,
          bindingSetRevision: outcome.bindingSetRevision,
          bindingSetFingerprint: outcome.bindingSetFingerprint,
          unitId: outcome.unitId,
          panelId: outcome.panelId,
          reconciled: true,
          message: "已从追加式 Studio binding 操作收据对账冻结结果。",
        },
      };
    }

    if (request.command === "migrate_fusion_storyboard_sheets") {
      const store = await loadFusionStoryboardSheetStore(projectRoot);
      const preview = await previewFusionStoryboardSheetMigration(projectRoot, { itemIds: request.payload.itemIds }, { store });
      if (preview.candidateFingerprint !== request.payload.expectedCandidateFingerprint
        || preview.blockers.length > 0
        || preview.pendingCount !== 0
        || preview.candidates.some((candidate) => candidate.pending)) return undefined;
      const byStatus = {
        stale: preview.candidates.filter((candidate) => candidate.status === "stale").length,
        legacyInvalid: preview.candidates.filter((candidate) => candidate.status === "legacy-invalid").length,
      };
      const sheetIds = preview.candidates.map((candidate) => candidate.sheetId).sort((left, right) => left.localeCompare(right, "en"));
      return {
        source: "fusion-storyboard-sheet-migration-candidate-fingerprint",
        identity: {
          candidateFingerprint: preview.candidateFingerprint,
          storeRevision: store.revision,
          sheetIds,
        },
        // 这是此时再次调用业务 migration 会得到的确定性无写入结果；不猜测
        // 崩溃前首次调用的 created 数量。
        result: {
          schemaVersion: 1,
          kind: "fusion-storyboard-sheet-migration-result",
          applied: false,
          replayed: true,
          reconciled: true,
          previousRevision: store.revision,
          storeRevision: store.revision,
          candidateFingerprint: preview.candidateFingerprint,
          candidateCount: preview.candidateCount,
          pendingCount: 0,
          created: 0,
          unchanged: preview.candidateCount,
          byStatus,
          sheetIds,
        },
      };
    }

    if (request.command === "migrate_canonical_assets") {
      const store = await loadCanonicalAssetStore(projectRoot);
      if (!store) return undefined;
      const preview = await previewCanonicalAssetMigration(projectRoot);
      if (preview.blockers.length > 0
        || preview.pending
        || preview.candidateFingerprint !== request.payload.expectedCandidateFingerprint
        || store.candidateFingerprint !== request.payload.expectedCandidateFingerprint
        || preview.storeRevision !== store.revision
        || !preview.candidateStoreFingerprint
        || !preview.sourceSnapshot
        || stable(canonicalAssetSemanticSourceIdentity(preview.sourceSnapshot)) !== stable(canonicalAssetSemanticSourceIdentity(store.sourceSnapshot))
        || !preview.counts) return undefined;
      // candidateStoreFingerprint 还包含六个源 sidecar 的 raw SHA/bytes。命令提交
      // store 后，project.updatedAt 等非语义字节可能合法变化，因此不能拿它与
      // 已提交 store 的指纹作完成判据。candidateFingerprint + 语义输入/媒体快照
      // 才是迁移身份；已提交 store 本身则由 loadCanonicalAssetStore 完整校验。
      const confirmedStore = await loadCanonicalAssetStore(projectRoot);
      if (!confirmedStore
        || confirmedStore.revision !== store.revision
        || confirmedStore.candidateFingerprint !== store.candidateFingerprint
        || confirmedStore.storeFingerprint !== store.storeFingerprint) return undefined;
      return {
        source: "canonical-asset-store",
        identity: {
          candidateFingerprint: store.candidateFingerprint,
          storeFingerprint: store.storeFingerprint,
          observedCandidateStoreFingerprint: preview.candidateStoreFingerprint,
          rawSourceSnapshotChanged: preview.candidateStoreFingerprint !== store.storeFingerprint,
          storeRevision: store.revision,
          assetCount: store.assets.length,
          versionCount: store.versions.length,
          authorityCount: store.authorities.length,
        },
        // 此处只从当前不可变 store 重建幂等结果，不重新执行迁移或猜测首次
        // 调用的 applied 值。
        result: {
          schemaVersion: 1,
          kind: "canonical-asset-migration-result",
          applied: false,
          replayed: true,
          reconciled: true,
          previousRevision: store.revision,
          storeRevision: store.revision,
          candidateFingerprint: store.candidateFingerprint,
          storeFingerprint: store.storeFingerprint,
          counts: preview.counts,
        },
      };
    }

    if (request.command !== "render_fusion_storyboard_sheet") return undefined;

    const inputFingerprint = request.payload.expectedInputFingerprint;
    if (!/^[a-f0-9]{64}$/u.test(inputFingerprint)) return undefined;
    const sheetId = `sheet-v2-${inputFingerprint.slice(0, 32)}`;
    const store = await loadFusionStoryboardSheetStore(projectRoot);
    const entry = store.records[sheetId];
    const selected = store.currentByItemId[request.payload.itemId];
    if (!entry
      || entry.itemId !== request.payload.itemId
      || entry.contractId !== request.payload.contractId
      || entry.inputFingerprint !== inputFingerprint
      || selected?.sheetId !== sheetId
      || selected.inputFingerprint !== inputFingerprint) return undefined;
    const record = await loadFusionStoryboardSheetRecord(projectRoot, sheetId);
    if (record.itemId !== request.payload.itemId
      || record.contract.contractId !== request.payload.contractId
      || record.inputFingerprint !== inputFingerprint) return undefined;
    if (request.payload.placements !== undefined) {
      const requestedPolicy = buildFusionStoryboardSheetRenderPolicy(record.panels.map((panel) => panel.panelId), request.payload.placements);
      if (stable(requestedPolicy) !== stable(record.renderPolicy)) return undefined;
    }
    const inspected = await inspectFusionStoryboardSheetEvidence(projectRoot, request.payload);
    if (!inspected.currentEvidence
      || inspected.readiness.expectedInputFingerprint !== inputFingerprint
      || stable(inspected.currentEvidence) !== stable({
        projectId: record.projectId,
        sourceContentAddress: record.sourceContentAddress,
        itemId: record.itemId,
        contract: record.contract,
        requirement: record.requirement,
        review: record.review,
        panels: record.panels,
        renderPolicy: record.renderPolicy,
      })) return undefined;
    const snapshot = await listFusionStoryboardSheetArtifactSnapshot(projectRoot, {
      store,
      verifyFiles: true,
      currentEvidenceByItemId: { [record.itemId]: inspected.currentEvidence },
    });
    const artifactEvidence = snapshot.items.filter((artifact) => artifact.sheetId === sheetId);
    const expectedPaths = new Set([...record.outputs.map((output) => path.resolve(output.path)), path.resolve(record.receiptPath)]);
    if (artifactEvidence.length !== expectedPaths.size
      || artifactEvidence.some((artifact) => !expectedPaths.has(path.resolve(artifact.path)) || artifact.status !== "current")) return undefined;
    const generationJobIds = [...record.panels]
      .sort((left, right) => left.panelIndex - right.panelIndex)
      .map((panel) => panel.generationJobId);
    const pages = Array.from({ length: record.outputs[0]?.pageCount ?? 0 }, (_, offset) => {
      const pageIndex = offset + 1;
      const pngOutput = record.outputs.find((output) => output.role === "png" && output.pageIndex === pageIndex);
      const svgOutput = record.outputs.find((output) => output.role === "svg" && output.pageIndex === pageIndex);
      if (!pngOutput || !svgOutput) return undefined;
      return {
        pageIndex,
        width: pngOutput.width,
        height: pngOutput.height,
        png: { path: pngOutput.path, sha256: pngOutput.sha256, bytes: pngOutput.bytes, status: "existing" as const },
        svg: { path: svgOutput.path, sha256: svgOutput.sha256, bytes: svgOutput.bytes, status: "existing" as const },
      };
    });
    if (pages.length === 0 || pages.some((page) => !page)) return undefined;
    const completePages = pages as Array<NonNullable<(typeof pages)[number]>>;
    const firstPage = completePages[0]!;
    const cropByPanelId = new Map(record.renderEvidence.cropAudit.map((entry) => [entry.panelId, entry]));
    const panelInputs = [...record.panels].sort((left, right) => left.panelIndex - right.panelIndex).map((panel) => {
      const crop = cropByPanelId.get(panel.panelId)!;
      const policy = record.renderPolicy.panelImagePolicies[panel.panelId]!;
      const extension = path.extname(panel.raw.path).slice(1).toLowerCase();
      const format = extension === "jpg" ? "jpeg" : extension || "png";
      const transform = policy.fit === "contain"
        ? { fit: "contain" as const }
        : policy.evidence.kind === "normalized-focus"
          ? { fit: "crop" as const, focalPoint: { x: policy.evidence.x, y: policy.evidence.y } }
          : { fit: "crop" as const, rect: { x: policy.evidence.x, y: policy.evidence.y, width: policy.evidence.width, height: policy.evidence.height } };
      return {
        panelId: panel.panelId,
        path: panel.raw.path,
        sha256: panel.raw.sha256,
        bytes: panel.raw.bytes,
        width: crop.sourceWidth,
        height: crop.sourceHeight,
        format,
        transform,
      };
    });
    const panelInputsSha256 = createHash("sha256").update(stable(panelInputs.map(({ path: _path, bytes: _bytes, ...panel }) => panel))).digest("hex");
    const { panelImagePolicies: _panelImagePolicies, ...resolvedRenderPolicy } = record.renderPolicy;
    // scan index 是可重建投影，不是需要重做的渲染/登记副作用。硬崩溃若发生在
    // registered -> scan 之间，在返回成功前补齐投影；失败则仍保留 unknown/failed。
    await scanAndPersist(projectRoot, { includeHashPaths: [...record.outputs.map((output) => output.path), record.receiptPath] });
    return {
      source: "fusion-storyboard-sheet-store",
      identity: {
        sheetId,
        inputFingerprint,
        recordFingerprint: record.fingerprint,
        registrationFingerprint: record.registrationFingerprint,
        storeRevision: store.revision,
      },
      result: {
        schemaVersion: 2,
        kind: "fusion-storyboard-sheet-render",
        reconciled: true,
        contractId: record.contract.contractId,
        sourceFingerprint: record.contract.sourceFingerprint,
        renderFingerprint: record.renderEvidence.renderFingerprint,
        inputAudit: {
          contractSha256: record.contract.contractFingerprint,
          panelInputsSha256,
          renderFingerprint: record.renderEvidence.renderFingerprint,
        },
        renderPolicy: resolvedRenderPolicy,
        overflowReport: record.renderEvidence.overflowReport,
        cropAudit: record.renderEvidence.cropAudit,
        width: firstPage.width,
        height: firstPage.height,
        pageCount: completePages.length,
        pages: completePages,
        panelCount: record.panels.length,
        durationSeconds: 15,
        renderPurpose: "formal",
        formalProductionEligible: true,
        reused: true,
        png: firstPage.png,
        svg: firstPage.svg,
        panelImages: panelInputs.map(({ transform: _transform, ...panel }) => panel),
        itemId: record.itemId,
        sheetId: record.sheetId,
        inputFingerprint: record.inputFingerprint,
        recordFingerprint: record.fingerprint,
        registrationFingerprint: record.registrationFingerprint,
        storeRevision: store.revision,
        receiptPath: record.receiptPath,
        generationJobIds,
        reviewId: record.review.reviewId,
        requirementId: record.requirement.requirementId,
      },
    };
  } catch {
    // 恢复路径必须失败关闭：任何读取、结构、receipt 或输出完整性异常都不能
    // 被降级成“可能成功”，也绝不能触发一次新的渲染/迁移。
    return undefined;
  }
}

async function proveDurableOutcomeWithMutationFence(
  projectRoot: string,
  request: DurableReconciliationCommandRequest,
): Promise<DurableCommandProof | undefined> {
  if (request.command === "novel_import_external_snapshot") {
    return withProjectLock(projectRoot, "novel-import-mutation", () => proveDurableOutcome(projectRoot, request));
  }
  return proveDurableOutcome(projectRoot, request);
}

function abortError(signal?: AbortSignal): Error {
  const message = typeof signal?.reason === "string" ? signal.reason : signal?.reason instanceof Error ? signal.reason.message : "命令已取消。";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"); }
}

async function markDurableRecoveryRejected(input: {
  projectRoot: string;
  storageRoot: string;
  record: IdempotentCommandResult;
  message: string;
}): Promise<IdempotentCommandResult> {
  const root = path.resolve(input.projectRoot);
  const storageRoot = path.resolve(input.storageRoot);
  const observedAt = new Date().toISOString();
  const stored = await withProjectLock(storageRoot, "command-bus", async () => {
    const current = await getCommandByIdempotencyKey(storageRoot, input.record.idempotencyKey);
    if (!current || current.requestHash !== input.record.requestHash || current.command !== input.record.command) {
      throw new Error("持久恢复拒绝落账时命令记录消失或身份冲突。");
    }
    if (current.status === "succeeded") return current;
    if (current.status === "running" && processAlive(current.execution?.pid)) return current;
    current.status = "failed";
    current.result = undefined;
    current.error = { message: input.message, observedAt };
    current.execution = { pid: process.pid, phase: "executing", heartbeatAt: observedAt };
    current.executedAt = observedAt;
    await persistCommandLedgerEntry(storageRoot, current, observedAt);
    return current;
  });
  if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
  if (stored.status === "failed") {
    const event = {
      actor: "codex" as const,
      type: "command.failed",
      requestId: stored.requestId,
      idempotencyKey: stored.idempotencyKey,
      command: stored.command,
      data: {
        requestHash: stored.requestHash,
        projectRoot: root,
        committed: false,
        durableRecoveryRejected: true,
        error: input.message,
      },
    };
    await appendEvent(storageRoot, event);
    if (storageRoot !== root) await appendEvent(root, event);
  }
  return stored;
}

async function recoverCommandFromDurableState(input: {
  projectRoot: string;
  storageRoot: string;
  record: IdempotentCommandResult;
  request: DurableReconciliationCommandRequest;
  replayRequestId?: string;
}): Promise<IdempotentCommandResult | undefined> {
  const root = path.resolve(input.projectRoot);
  const storageRoot = path.resolve(input.storageRoot);
  if (input.record.command !== input.request.command || input.record.requestHash !== commandRequestHash(root, input.request)) return undefined;
  let proof = await proveDurableOutcomeWithMutationFence(root, input.request);
  if (proof && input.request.command === "novel_import_external_snapshot") {
    const recordAnchor = existingNovelImportResultAnchor(input.record);
    const requestAnchor = await uniqueNovelImportRequestAnchor(storageRoot, input.record.requestHash);
    if (recordAnchor && requestAnchor && stable(recordAnchor) !== stable(requestAnchor)) {
      throw new Error("小说导入当前命令锚点与同 requestHash 历史锚点冲突。");
    }
    const existing = recordAnchor ?? requestAnchor;
    if (existing) assertNovelImportResultMatchesAnchor(proof.result, existing);
  }
  if (!proof && input.request.command === "attach_studio_multimedia_timeline_media") {
    const rejection = deterministicStudioTimelineRejection(input.request);
    if (rejection) {
      return markDurableRecoveryRejected({
        projectRoot: root,
        storageRoot,
        record: input.record,
        message: rejection,
      });
    }
    return markDurableRecoveryRejected({
      projectRoot: root,
      storageRoot,
      record: input.record,
      message: "attach_studio_multimedia_timeline_media 未找到与 requestHash 原子绑定的 timeline operation receipt；业务事务未提交，可明确记为失败。",
    });
  }
  if (!proof && isStudioBindingOperationCommand(input.request.command)) {
    return markDurableRecoveryRejected({
      projectRoot: root,
      storageRoot,
      record: input.record,
      message: `${input.request.command} 未找到与 requestHash 原子绑定的 studio_binding_operation_receipts；业务事务未提交，可明确记为失败。`,
    });
  }
  if (!proof && input.request.command === "materialize_local_creative_production_units") {
    // 保留判别联合的窄化结果，避免进入异步锁回调后退化成整个
    // CommandRequest.payload 联合。
    const materializeRequest = input.request;
    const operationId = commandRequestHash(root, materializeRequest);
    try {
      const outcome = await withProjectLock(root, "studio-mutation", () =>
        materializeLocalCreativeProductionUnits(root, {
          ...materializeRequest.payload,
          idempotencyKey: operationId,
        }));
      proof = localCreativeMaterializationProof(operationId, outcome);
    } catch (error) {
      const message = `批物化崩溃恢复被精确拒绝：${error instanceof Error ? error.message : String(error)}`;
      const rejected = await markDurableRecoveryRejected({
        projectRoot: root,
        storageRoot,
        record: input.record,
        message,
      });
      if (rejected.status === "succeeded") {
        return { ...rejected, requestId: input.replayRequestId ?? rejected.requestId, replayed: true };
      }
      throw new Error(message, { cause: error });
    }
  }
  if (!proof) return undefined;
  const reconciledAt = new Date().toISOString();
  const stored = await withProjectLock(storageRoot, "command-bus", async (): Promise<IdempotentCommandResult | undefined> => {
    const current = await getCommandByIdempotencyKey(storageRoot, input.record.idempotencyKey);
    if (!current || current.requestHash !== input.record.requestHash || current.command !== input.record.command) return undefined;
    if (current.status === "succeeded") return current;
    const recoverableFailed = current.status === "failed" && current.execution?.phase === "side_effect_committed";
    if (current.status === "failed" && !recoverableFailed) return undefined;
    if (current.status === "cancelled") return undefined;
    if (current.status === "running" && processAlive(current.execution?.pid)) return undefined;
    if (input.request.command === "novel_import_external_snapshot") {
      const recordAnchor = existingNovelImportResultAnchor(current);
      const requestAnchor = await uniqueNovelImportRequestAnchor(storageRoot, current.requestHash);
      if (recordAnchor && requestAnchor && stable(recordAnchor) !== stable(requestAnchor)) {
        throw new Error("小说导入恢复账本锚点与同 requestHash 历史锚点冲突。");
      }
      const existing = recordAnchor ?? requestAnchor;
      const expected = existing ?? novelImportResultAnchorFromResult(proof.result);
      if (existing) assertNovelImportResultMatchesAnchor(proof.result, existing);
      current.novelImportResultAnchor = expected;
    }
    current.status = "succeeded";
    current.result = proof.result;
    current.error = undefined;
    current.execution = { pid: process.pid, phase: "side_effect_committed", heartbeatAt: reconciledAt };
    current.executedAt = reconciledAt;
    current.durableReconciliation ??= durableReconciliationSnapshot(input.request);
    await persistCommandLedgerEntry(storageRoot, current, reconciledAt);
    return current;
  });
  if (!stored) return undefined;
  if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
  const event = {
    actor: "codex" as const,
    type: "command.reconciled",
    requestId: stored.requestId,
    idempotencyKey: stored.idempotencyKey,
    command: stored.command,
    data: {
      evidenceEventIds: [],
      evidenceSource: proof.source,
      durableIdentity: proof.identity,
      reconciledAt,
    },
  };
  await appendEvent(storageRoot, event);
  if (storageRoot !== root) await appendEvent(root, event);
  return { ...stored, requestId: input.replayRequestId ?? stored.requestId, replayed: true };
}

async function markLostDurableExecutorUnknown(input: {
  projectRoot: string;
  storageRoot: string;
  record: IdempotentCommandResult;
}): Promise<IdempotentCommandResult> {
  const root = path.resolve(input.projectRoot);
  const storageRoot = path.resolve(input.storageRoot);
  const observedAt = new Date().toISOString();
  const stored = await withProjectLock(storageRoot, "command-bus", async () => {
    const current = await getCommandByIdempotencyKey(storageRoot, input.record.idempotencyKey);
    if (!current || current.requestHash !== input.record.requestHash) throw new Error("持久结果对账期间命令记录消失或请求哈希冲突；停止恢复。 ");
    if (current.status !== "running" || processAlive(current.execution?.pid)) return current;
    current.status = "unknown";
    current.error = { message: `执行进程 ${current.execution?.pid} 已退出，且不可变业务证据不足；已转为 unknown，禁止自动重放。`, observedAt };
    current.executedAt = observedAt;
    await persistCommandLedgerEntry(storageRoot, current, observedAt);
    return current;
  });
  if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
  if (stored.status === "unknown") {
    await appendEvent(storageRoot, { actor: "codex", type: "command.executor-lost", requestId: stored.requestId, idempotencyKey: stored.idempotencyKey, command: stored.command, data: { pid: input.record.execution?.pid, phase: input.record.execution?.phase, heartbeatAt: input.record.execution?.heartbeatAt, observedAt } });
  }
  return stored;
}

async function mirrorLedgerRecord(projectRoot: string, record: IdempotentCommandResult): Promise<void> {
  await withProjectLock(projectRoot, "command-bus", async () => {
    await persistCommandLedgerEntry(projectRoot, { ...record }, record.executedAt ?? record.startedAt);
  });
}

function rejectFusionVisualConstraintPrecondition(error: unknown, payload?: { expectedStoreRevision?: number; expectedConstraintId?: string }): never {
  if (isRejectedCommandFailure(error)) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const isValidation = error instanceof FusionPanelVisualConstraintValidationError
    || /^(?:P2|P3|宫格|黄金面具|presence override)/u.test(message);
  if (!isValidation) throw error;
  const reason = /revision 已变化|CAS 已冲突|已变化/u.test(message)
    ? "revision_conflict"
    : /尚未物化|缺少|找不到/u.test(message)
      ? "not_found_or_prerequisite_missing"
      : "validation_failed";
  throw new RejectedCommandFailure(message, {
    schemaVersion: 1,
    applied: false,
    entityType: "fusion_panel_visual_constraint_store",
    reason,
    expectedStoreRevision: payload?.expectedStoreRevision,
    expectedConstraintId: payload?.expectedConstraintId,
  });
}

async function executeNovelRepositoryCommand(projectRoot: string, request: NovelCommandRequest, options: {
  novelWriteActor?: "agent" | "agent_reviewer" | "human_owner" | "human_ui";
  novelWriteLeaseToken?: string;
  novelActorAttribution?: NovelActorAttribution;
} = {}): Promise<unknown> {
  if (request.command === "novel_import_external_snapshot") {
    const outcome = await commitNovelExternalImport(request.payload);
    const { projectRoot: _absoluteProjectRoot, ...safeOutcome } = outcome;
    return safeOutcome;
  }
  const repository = new NovelRepository(projectRoot);
  try {
    switch (request.command) {
      case "novel_initialize_manuscript": return await repository.initialize(request.payload.sourceMode ?? "managed_markdown");
      case "novel_create_volume": return await repository.createVolume(request.payload);
      case "novel_create_chapter": return await repository.createChapter(request.payload);
      case "novel_save_chapter": return await repository.saveChapter(request.payload, {
        requireWriteLease: options.novelWriteActor !== "human_owner"
          && options.novelWriteActor !== "human_ui"
          && (request.payload.aiWriteContext?.workflowMode ?? "formal") === "formal",
        ...(options.novelWriteLeaseToken && options.novelActorAttribution ? {
          writeLease: {
            leaseToken: options.novelWriteLeaseToken,
            attribution: options.novelActorAttribution,
          },
        } : {}),
      });
      case "novel_rename_chapter": return await repository.renameChapter(request.payload);
      case "novel_move_chapter": return await repository.moveChapter(request.payload);
      case "novel_reorder_chapters": return await repository.reorderChapters(request.payload);
      case "novel_rebuild_search_index": return await repository.rebuildSearchIndex();
      case "novel_recover_manuscript": return { recoveredOperations: await repository.recoverIncompleteOperations() };
      case "novel_recover_writing_state": return { recoveredOperations: await repository.recoverWritingStateOperations() };
      case "novel_seed_writing_state": return await repository.seedWritingState(request.payload);
      case "novel_import_writing_source_snapshot": return await repository.importWritingSourceSnapshot(request.payload);
      case "novel_stage_chapter_state_candidate": return await repository.stageChapterStateCandidate(request.payload);
      case "novel_review_chapter_state_candidate": return await repository.reviewChapterStateCandidate(request.payload);
      case "novel_stage_story_bible_candidate": return await repository.stageStoryBibleCandidate(request.payload);
      case "novel_review_story_bible_candidate": return await repository.reviewStoryBibleCandidate(request.payload);
      case "novel_invalidate_writing_state_from": return await repository.invalidateWritingStateFrom(request.payload);
      case "novel_attach_review_ticket": return await repository.attachReviewTicket(request.payload);
    }
  } catch (error) {
    // 只有 Repository 在任何本命令写入前明确分类的状态前置条件，才可落
    // failed(committed=false)。恢复证据损坏、写中/写后异常继续原样上抛，
    // 由 command bus 保持 unknown，禁止把不确定副作用误报成安全拒绝。
    if (isNovelPreconditionRejectedError(error)) {
      throw new RejectedCommandFailure(error.message, error.result);
    }
    if (isNovelWritingStateRejectedError(error)) {
      throw new RejectedCommandFailure(error.message, error.result);
    }
    throw error;
  }
}

async function execute(projectRoot: string, request: CommandRequest, options: Pick<PersistedScanOptions, "signal" | "onProgress"> & {
  operationId?: string;
  novelWriteActor?: "agent" | "agent_reviewer" | "human_owner" | "human_ui";
  novelWriteLeaseToken?: string;
  novelActorAttribution?: NovelActorAttribution;
} = {}): Promise<unknown> {
  if (isNovelCommandName(request.command)) {
    return executeNovelRepositoryCommand(projectRoot, request as NovelCommandRequest, options);
  }
  if (isStudioCommandRequest(request)) {
    // 可靠性壳在 operation context 内、业务 executor 前复检受管工程。
    // executor 不持有 managed shell、锁、lease、busy retry 或命令账本。
    await inspectManagedProject(projectRoot);
    const operationId = options.operationId ?? commandRequestHash(projectRoot, request);
    const executeStudio = () => executeStudioCommand(projectRoot, request, operationId);
    if (request.command === "prepare_studio_imagegen_call") {
      try {
        return await withActiveProjectActivationFence(async () => {
          await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
          return executeStudio();
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          throw new RejectedCommandFailure(error.message, {
            schemaVersion: 1,
            applied: false,
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            packId: request.payload.packId,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        throw error;
      }
    }
    if (request.command === "authorize_studio_higgsfield_connector_request") {
      try {
        return await withActiveProjectActivationFence(async () => {
          await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
          return executeStudio();
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          throw new RejectedCommandFailure(error.message, {
            schemaVersion: 1,
            applied: false,
            entityType: "studio_higgsfield_connector_request",
            reason: "project_context_conflict",
            code: error.code,
            requestId: request.payload.requestId,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        throw error;
      }
    }
    if (request.command === "prepare_studio_higgsfield_video_generation") {
      try {
        return await withActiveProjectActivationFence(async () => {
          await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
          return executeStudio();
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          throw new RejectedCommandFailure(error.message, {
            schemaVersion: 1,
            applied: false,
            entityType: "studio_higgsfield_video_generation",
            reason: "project_context_conflict",
            code: error.code,
            intentId: request.payload.intentId,
          });
        }
        throw error;
      }
    }
    return executeStudio();
  }
  switch (request.command) {
    case "scan_project": return summarizeForMcp(await scanAndPersist(projectRoot, options));
    case "stage_dudu_readonly_managed_project": {
      if (request.payload.expectedRevision !== 0) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "invalid_revision",
          message: "Dudu bootstrap expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const commandRoot = await resolveDuduReadonlyImportCommandRoot(request.payload.projectsRoot);
      if (path.resolve(projectRoot) !== commandRoot) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu bootstrap 必须使用唯一 import-transaction command root。",
        });
      }
      const discovery = await discoverDuduReadonlyImportProjects(request.payload.projectsRoot);
      if (discovery.fingerprint !== request.payload.expectedDiscoveryFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu staging 发现集已变化，请重新读取 discovery 后再执行。",
          expectedFingerprint: request.payload.expectedDiscoveryFingerprint,
          currentFingerprint: discovery.fingerprint,
        });
      }
      const resumableStatus = discovery.status === "none"
        || (discovery.status === "single"
          && discovery.candidates.length === 1
          && (discovery.candidates[0]!.controlStatus === "staging-incomplete"
            || discovery.candidates[0]!.controlStatus === "staging-verified"));
      if (!resumableStatus) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu staging 只允许无候选或未登记 staging owner；冲突、已登记或已激活 owner 必须走对应恢复面。",
          expectedFingerprint: request.payload.expectedDiscoveryFingerprint,
          currentFingerprint: discovery.fingerprint,
        });
      }
      const { expectedRevision: _expectedRevision, expectedDiscoveryFingerprint: _expectedDiscoveryFingerprint, ...input } = request.payload;
      try {
        return summarizeDuduReadonlyStageResult(await stageDuduReadonlyManagedProject(input, {
          commandRequestHash: commandRequestHash(projectRoot, request),
          expectedDiscoveryFingerprint: request.payload.expectedDiscoveryFingerprint,
        }));
      } catch (error) {
        if (error instanceof DuduReadonlyControlConflictError) {
          rejectP30OrchestrationCommand({
            entityType: "dudu_readonly_import",
            reason: "control_conflict",
            message: error.message,
            expectedFingerprint: error.expectedFingerprint ?? request.payload.expectedDiscoveryFingerprint,
            currentFingerprint: error.currentFingerprint,
          });
        }
        throw error;
      }
    }
    case "materialize_fusion_project": {
      const { targetParent, authorities, ...inspectionOptions } = request.payload;
      const inspection = await inspectFusionPackage(inspectionOptions);
      const result = await materializeFusionProject({ inspection, targetParent, authorities });
      return {
        created: result.created,
        targetRoot: result.targetRoot,
        projectId: result.manifest.projectId,
        contentAddress: result.manifest.contentAddress,
        directoryName: result.manifest.directoryName,
        manifestSha256: result.manifest.manifestSha256,
        receipt: {
          receiptId: result.receipt.receiptId,
          sourceInventorySha256: result.receipt.sourceInventorySha256,
          fusionManifestPath: result.receipt.fusionManifestPath,
          assetCatalogPath: result.receipt.assetCatalogPath,
          continuityStorePath: result.receipt.continuityStorePath,
          storyboardStorePath: result.receipt.storyboardStorePath,
          visualBiblePath: result.receipt.visualBiblePath,
          ownedFilesSha256: result.receipt.ownedFilesSha256,
          ownedFileCount: result.receipt.ownedFiles.length,
          authorityCount: result.receipt.authorities.length,
          counts: result.receipt.counts,
        },
        productionAssets: {
          total: result.assetCatalog.assets.length,
          byCategory: Object.fromEntries((["character", "scene", "prop"] as const).map((category) => [category, result.assetCatalog.assets.filter((entry) => entry.definition.category === category).length])),
        },
        continuityTracks: result.continuity.tracks.length,
      };
    }
    case "build_fusion_reference_board": {
      const index = await getProjectIndex(projectRoot);
      return buildFusionReferenceBoard(projectRoot, index, request.payload.itemId, request.payload.variant);
    }
    case "build_fusion_storyboard_grid": return buildFusionStoryboardGridForProject(projectRoot, request.payload.itemId, {
      override: request.payload.override,
      referenceOverride: request.payload.referenceOverride,
    });
    case "materialize_fusion_panel_references": {
      const store = await materializeFusionPanelReferenceResolutions(projectRoot);
      return {
        schemaVersion: store.schemaVersion,
        resolverVersion: store.resolverVersion,
        revision: store.revision,
        projectId: store.projectId,
        sourceContentAddress: store.sourceContentAddress,
        storeFingerprint: store.storeFingerprint,
        updatedAt: store.updatedAt,
        audit: store.audit,
        derivedDefinitions: Object.keys(store.derivedAssets).length,
        overrides: Object.keys(store.overrides).length,
        responsePolicy: "仅返回引用闭包审计与计数；逐格详情请使用分页只读工具。",
      };
    }
    case "materialize_fusion_visual_constraints": {
      let store: Awaited<ReturnType<typeof materializeFusionPanelVisualConstraints>>;
      try {
        const current = await loadFusionPanelVisualConstraintStore(projectRoot);
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== request.payload.expectedStoreRevision) {
          throw new RejectedCommandFailure(`P3 视觉约束仓已被其他窗口更新（当前 revision ${currentRevision}），请刷新后重试。`, {
            schemaVersion: 1,
            applied: false,
            entityType: "fusion_panel_visual_constraint_store",
            reason: "revision_conflict",
            expectedStoreRevision: request.payload.expectedStoreRevision,
            currentStoreRevision: currentRevision,
          });
        }
        store = await materializeFusionPanelVisualConstraints(projectRoot);
      }
      catch (error) { rejectFusionVisualConstraintPrecondition(error); }
      return {
        schemaVersion: store.schemaVersion,
        builderVersion: store.builderVersion,
        revision: store.revision,
        projectId: store.projectId,
        sourceContentAddress: store.sourceContentAddress,
        storeFingerprint: store.storeFingerprint,
        audit: store.audit,
        presenceOverrideCount: store.presenceOverrides.length,
        revealAuthorizationCount: store.revealAllowlist.length,
        legacyGenerationJobEvidenceCount: Object.keys(store.legacyGenerationJobEvidence).length,
        responsePolicy: "仅返回 P3 视觉约束仓身份、审计与计数；逐格规则请使用分页或单格只读工具。",
      };
    }
    case "upsert_fusion_visual_constraint_override": {
      const payload = request.payload.override;
      let store: Awaited<ReturnType<typeof materializeFusionPanelVisualConstraints>>;
      try {
        store = payload.overrideType === "presence"
          ? await upsertFusionPanelVisualPresenceOverride(projectRoot, payload)
          : await upsertFusionPanelGoldenMaskRevealAuthorization(projectRoot, payload);
      } catch (error) {
        rejectFusionVisualConstraintPrecondition(error, payload);
      }
      const constraint = store.constraints[`${payload.contractId}:${payload.panelId}`];
      if (!constraint) throw new Error("P3 覆盖写入后找不到对应视觉约束，已失败关闭。");
      return {
        revision: store.revision,
        storeFingerprint: store.storeFingerprint,
        audit: store.audit,
        appliedOverrideType: payload.overrideType,
        constraint: {
          constraintId: constraint.constraintId,
          fingerprint: constraint.fingerprint,
          modelFingerprint: constraint.modelFingerprint,
          reviewRulesFingerprint: constraint.reviewRulesFingerprint,
          contractId: constraint.gridContractId,
          panelId: constraint.panelId,
          panelIndex: constraint.panelIndex,
          generationGate: constraint.generationGate,
          hiddenMaskPolicy: constraint.hiddenMaskPolicy,
          assetPresenceCount: constraint.assetPresence.length,
          warningCount: constraint.warnings.length,
          reviewRuleCount: constraint.reviewRules.length,
        },
        presenceOverrideCount: store.presenceOverrides.length,
        revealAuthorizationCount: store.revealAllowlist.length,
        responsePolicy: "仅返回 CAS 写入后的约束身份与审计摘要；不返回全季约束数组。",
      };
    }
    case "upsert_panel_reference_override": {
      const store = await upsertPanelReferenceOverride(projectRoot, request.payload);
      const key = `${request.payload.contractId}:${request.payload.panelId}`;
      const resolution = store.resolutions[key];
      const override = store.overrides[key];
      return {
        revision: store.revision,
        storeFingerprint: store.storeFingerprint,
        audit: store.audit,
        override: override ? {
          id: override.id,
          revision: override.revision,
          contractId: override.contractId,
          panelId: override.panelId,
          includeAssetIds: override.includeAssetIds,
          excludeAssetIds: override.excludeAssetIds,
          reason: override.reason,
          updatedAt: override.updatedAt,
        } : undefined,
        resolution: resolution ? {
          resolutionId: resolution.resolutionId,
          resolutionFingerprint: resolution.resolutionFingerprint,
          closureStatus: resolution.closureStatus,
          generationReady: resolution.generationReady,
          blockerCodes: resolution.blockerCodes,
          semanticAssetIds: resolution.semanticAssets.map((asset) => asset.assetId),
          referenceSlotCount: resolution.referenceSlots.length,
        } : undefined,
      };
    }
    case "register_derived_panel_reference_artifact": {
      const store = await registerDerivedPanelReferenceArtifact(projectRoot, request.payload);
      const derived = store.derivedAssets[request.payload.derivedAssetId];
      const affectedPanels = Object.values(store.resolutions).filter((resolution) => resolution.overflowHandledByDerivedAssetId === request.payload.derivedAssetId);
      return {
        revision: store.revision,
        storeFingerprint: store.storeFingerprint,
        audit: store.audit,
        derivedAsset: derived ? {
          id: derived.id,
          version: derived.version,
          kind: derived.kind,
          name: derived.name,
          memberAssetIds: derived.memberAssetIds,
          definitionFingerprint: derived.definitionFingerprint,
          visualArtifact: derived.visualArtifact,
          status: derived.status,
        } : undefined,
        affectedPanelCount: affectedPanels.length,
        affectedPanels: affectedPanels.map((resolution) => ({
          resolutionId: resolution.resolutionId,
          unitItemId: resolution.unitItemId,
          panelId: resolution.panelId,
          generationReady: resolution.generationReady,
          blockerCodes: resolution.blockerCodes,
        })).slice(0, 200),
        responsePolicy: "仅返回派生资产、审计与受影响格摘要；不返回图片或 base64。",
      };
    }
    case "migrate_fusion_storyboard_evidence": return migrateFusionStoryboardEvidence(projectRoot, request.payload);
    case "migrate_fusion_storyboard_sheets": return migrateFusionStoryboardSheets(projectRoot, request.payload);
    case "migrate_canonical_assets": return migrateCanonicalAssets(projectRoot, request.payload);
    case "render_fusion_storyboard_sheet": return renderCompletedFusionStoryboardSheetForProject(projectRoot, request.payload);
    case "prepare_fusion_asset_consistency_review": return prepareFusionAssetConsistencyReview(projectRoot, request.payload.batchId);
    case "submit_fusion_asset_consistency_review": return submitFusionAssetConsistencyReview(projectRoot, request.payload, "codex");
    case "seal_final_fusion_asset_consistency_batch": return sealFinalFusionAssetConsistencyBatch(projectRoot, request.payload);
    case "commit_project_import": return summarizeForMcp(await commitProjectImport(request.payload));
    case "update_status": return updateStatus(projectRoot, request.payload.itemId, request.payload.status, request.payload.note, request.payload.authoritativePath, "codex");
    case "claim_task": {
      const { taskId, ...input } = request.payload;
      return claimTask(projectRoot, taskId, input);
    }
    case "heartbeat_task": {
      const { taskId, ...input } = request.payload;
      return heartbeatTask(projectRoot, taskId, input);
    }
    case "release_task": {
      const { taskId, ...input } = request.payload;
      return releaseTask(projectRoot, taskId, input);
    }
    case "cancel_task": {
      const { taskId, ...input } = request.payload;
      return cancelTask(projectRoot, taskId, input);
    }
    case "finish_batch": {
      const { taskId, ...input } = request.payload;
      return finishBatch(projectRoot, taskId, input);
    }
    case "apply_edit_operation": {
      const result = await applyEditOperation(projectRoot, request.payload.editProjectId, request.payload.expectedRevision, request.payload.operation, "codex");
      return { editProjectId: result.project.id, revision: result.project.revision, updatedAt: result.project.updatedAt, affectedTrackIds: result.affectedTrackIds, affectedClipIds: result.affectedClipIds };
    }
    case "update_workflow_stage": return updateProductionWorkflowStage(projectRoot, request.payload, "codex");
    case "commit_existing_production_recovery": return commitExistingProductionRecovery(projectRoot, request.payload, "codex");
    case "upsert_creative_bible": return upsertCreativeBible(projectRoot, request.payload, "codex");
    case "upsert_storyboard_row": return upsertStoryboardRow(projectRoot, request.payload, "codex");
    case "submit_review": return submitReview(projectRoot, request.payload, "codex");
    case "upsert_asset_relation": return upsertAssetRelation(projectRoot, request.payload, "codex");
    case "upsert_voice_identity": return upsertVoiceIdentity(projectRoot, request.payload, "codex");
    case "update_browser_generation": {
      const { jobId, ...input } = request.payload;
      return updateBrowserGenerationJob(projectRoot, jobId, input);
    }
    case "update_subagent_image_generation": {
      const { jobId, ...input } = request.payload;
      return updateSubagentImageGenerationJob(projectRoot, jobId, input);
    }
    case "migrate_generation_execution_state": return migrateGenerationExecutionState(projectRoot, request.payload);
    case "reconcile_http_generation_submission": {
      const { jobId, ...input } = request.payload;
      return reconcileHttpGenerationSubmission(projectRoot, jobId, input);
    }
    case "update_video_continuation": {
      const { continuationId, ...input } = request.payload;
      return updateVideoContinuationPack(projectRoot, continuationId, input);
    }
    case "prepare_timeline_continuation": return prepareTimelineVideoContinuation(projectRoot, request.payload);
    case "upsert_context": return upsertProjectContext(projectRoot, request.payload, "codex");
    case "delete_context": {
      await deleteProjectContext(projectRoot, request.payload, "codex");
      return { deleted: request.payload.contextId };
    }
    case "upsert_story_event": return upsertStoryEvent(projectRoot, request.payload, "codex");
    case "connect_story_events": return connectStoryEvents(projectRoot, request.payload.sourceEventId, request.payload.targetEventId, "codex");
    case "upsert_canvas_entity": return upsertCanvasEntity(projectRoot, request.payload, "codex");
    case "delete_canvas_entity": return deleteCanvasEntity(projectRoot, request.payload.entityId, "codex");
    case "upsert_canvas_link": return upsertCanvasLink(projectRoot, request.payload, "codex");
    case "delete_canvas_link": return deleteCanvasLink(projectRoot, request.payload.linkId, "codex");
    case "undo_canvas": return undoCanvasSemanticState(projectRoot, "codex");
    case "redo_canvas": return redoCanvasSemanticState(projectRoot, "codex");
    case "create_task_pack": return createTaskPack(projectRoot, request.payload);
    case "register_artifact": return registerArtifact(projectRoot, request.payload);
    case "verify_item": return verifyItem(projectRoot, request.payload.itemId);
    case "set_authoritative_artifact": return setAuthoritativeArtifact(projectRoot, request.payload.itemId, request.payload.artifactId, request.payload.note);
    case "promote_asset_to_hard_lock": return promoteAssetToHardLock(projectRoot, request.payload.itemId, request.payload.note);
    case "enqueue_generation": return enqueueGeneration(projectRoot, request.payload);
    case "upsert_generation_provider": return upsertGenerationProvider(projectRoot, request.payload, "codex");
    case "save_script_document": return saveScriptDocument(projectRoot, request.payload.filePath, request.payload.content, request.payload.expectedModifiedAt);
    case "extract_last_frame": return extractLastFrame(projectRoot, request.payload);
    case "create_video_continuation": return createVideoContinuationPack(projectRoot, request.payload);
    case "import_story_file": return importStoryFile(projectRoot, request.payload.filePath, request.payload.title);
    case "import_story_text": return importStoryText(projectRoot, request.payload);
    case "analyze_novel_chapters": return analyzeNovelChapters(projectRoot, request.payload);
    case "generate_adaptation_plans": return generateAdaptationPlans(projectRoot, request.payload);
    case "select_adaptation_plan": return selectAdaptationPlan(projectRoot, request.payload.planId, request.payload.expectedRevision);
    case "materialize_adaptation_plan": return materializeSelectedAdaptationPlan(projectRoot, request.payload);
    case "regenerate_adaptation_scope": return regenerateAdaptationScope(projectRoot, request.payload);
    case "create_novel_analysis_task": return createNovelAnalysisTask(projectRoot, request.payload);
    case "submit_novel_analysis_proposal": return submitNovelAnalysisProposal(projectRoot, request.payload);
    case "review_novel_analysis_item": return reviewNovelAnalysisItem(projectRoot, request.payload);
    case "review_novel_analysis_batch": return reviewNovelAnalysisBatch(projectRoot, request.payload);
    case "upsert_novel_analysis_provider": return upsertNovelAnalysisProvider(projectRoot, request.payload);
    case "plan_novel_analysis_run": return planNovelAnalysisRun(projectRoot, request.payload);
    case "execute_novel_analysis_task": return executeNovelAnalysisTask(projectRoot, request.payload);
    case "execute_next_novel_analysis_run_task": return executeNextNovelAnalysisRunTask(projectRoot, request.payload);
    case "replace_novel_analysis_run_task": return replaceNovelAnalysisRunTask(projectRoot, request.payload);
    case "mark_novel_analysis_execution_reconciliation_required": return markNovelAnalysisExecutionReconciliationRequired(projectRoot, request.payload);
    case "reconcile_novel_analysis_execution": return reconcileNovelAnalysisExecution(projectRoot, request.payload);
    case "upsert_novel_fact": return upsertNovelFact(projectRoot, request.payload);
    case "upsert_narrative_beat": return upsertNarrativeBeat(projectRoot, request.payload);
    case "export_adaptation": return exportAdaptation(projectRoot, request.payload);
    case "save_skill": return saveAgentSkill(projectRoot, request.payload);
    case "create_handoff": return createContinuationHandoff(projectRoot, request.payload);
    case "save_unit_timeline": return saveUnitTimeline(projectRoot, request.payload.unitId, request.payload.timings);
    case "create_shot_task_pack": return createShotTaskPack(projectRoot, request.payload.unitId, request.payload.mode);
    case "process_generation_queue": return processGenerationQueue(projectRoot, { jobId: request.payload.jobId });
    case "cancel_generation": return cancelGenerationJob(projectRoot, request.payload.jobId);
    case "preflight_publication": {
      const intent = await preflightPublication(projectRoot, request.payload, "codex");
      // OA-1：命令回包附 OpenAssetIO 风格预检诊断（额外字段，intent 字段保持）
      return enrichPublicationIntentWithDiagnostics(intent);
    }
    case "register_publication": return registerPublication(projectRoot, request.payload, "codex");
    case "cancel_publication": return cancelPublication(projectRoot, request.payload, "codex");
    case "fail_publication": return failPublication(projectRoot, request.payload, "codex");
    case "preflight_publication_bundle": return preflightPublicationBundle(projectRoot, request.payload, "codex");
    case "register_publication_bundle": return registerPublicationBundle(projectRoot, request.payload, "codex");
    case "cancel_publication_bundle": return cancelPublicationBundle(projectRoot, request.payload, "codex");
    case "fail_publication_bundle": return failPublicationBundle(projectRoot, request.payload, "codex");
    case "create_edit_project": return createEditProject(projectRoot, request.payload);
    case "save_edit_project": return saveEditProject(projectRoot, request.payload.project, request.payload.expectedRevision, "codex");
    case "undo_edit_project": return undoEditProject(projectRoot, request.payload.editProjectId, request.payload.expectedRevision, "codex");
    case "redo_edit_project": return redoEditProject(projectRoot, request.payload.editProjectId, request.payload.expectedRevision, "codex");
    case "export_edit_otio": return exportEditProjectOtio(projectRoot, request.payload.editProjectId, request.payload.expectedRevision, request.payload.outputPath);
    case "import_edit_otio": return importEditProjectOtio(projectRoot, request.payload.filePath, request.payload.name);
    case "start_edit_render": return startEditRender(projectRoot, request.payload.editProjectId, { expectedRevision: request.payload.expectedRevision, outputDirectory: request.payload.outputDirectory });
    case "cancel_edit_render": return cancelEditRender(projectRoot, request.payload.renderId);
    case "extract_timeline_frame": return extractTimelineFrame(projectRoot, request.payload);
    case "prepare_edit_media_preview": return prepareEditMediaPreview(projectRoot, request.payload.artifactId);
    case "prepare_edit_media_proxy": return prepareEditMediaProxy(projectRoot, request.payload.artifactId);
  }
}

// 测试注入计数（AI_CANVAS_TEST_COMMAND_BUSY_COMMAND/BUSY_EXECUTE_TIMES）：
// 记录某 command+idempotencyKey 已注入的 busy 次数，键隔离避免跨用例串扰。
const testBusyExecuteAttempts = new Map<string, number>();

/** 小说外部导入的命令账本 owner 固定在应用 registry 目录，与业务 projectsRoot 分离。 */
export function getNovelImportCommandOwnerRoot(): string {
  return path.join(path.dirname(getProjectRegistryPath()), "novel-import-command");
}

function sameOrDescendant(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNovelImportOwnerAndProjectsDisjoint(ownerRoot: string, projectsRoot: string): void {
  if (sameOrDescendant(ownerRoot, projectsRoot) || sameOrDescendant(projectsRoot, ownerRoot)) {
    throw new Error("小说导入 command owner 与业务 projectsRoot 必须完全分离。");
  }
}

async function assertCanonicalNovelImportOwnerParent(ownerRoot: string): Promise<void> {
  const parent = path.dirname(ownerRoot);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("小说导入 command owner 父目录必须是无符号链接的规范真实目录。");
  }
}

function matchesNovelImportReplayRecord(
  record: IdempotentCommandResult,
  requestHash: string,
): boolean {
  return record.command === "novel_import_external_snapshot" && record.requestHash === requestHash;
}

function allowsNovelImportTokenlessReplay(record: IdempotentCommandResult): boolean {
  if (record.status === "succeeded" || record.status === "unknown" || record.status === "running") return true;
  return record.status === "failed" && record.execution?.phase === "side_effect_committed";
}

/**
 * 必须在 owner mkdir、isManagedProject、lock 和 ledger 写入之前完成。有 capability
 * 时绑定服务端冻结预检并验证所有双向重叠；无 capability 时只读已有
 * app-owner 账本，不允许首次调用创建任何文件。
 */
async function authorizeNovelImportCommandBeforeLedger(input: {
  root: string;
  storageRoot: string;
  destinationIdentity?: NovelImportDestinationExecutionIdentity;
  envelope: IdempotentCommandInput & {
    request: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>;
  };
}): Promise<void> {
  const ownerRoot = path.resolve(getNovelImportCommandOwnerRoot());
  if (input.root !== ownerRoot || input.storageRoot !== ownerRoot) {
    throw new Error("小说外部导入必须以应用专用 transaction owner 作为 projectRoot/storageRoot。");
  }
  const requestHash = commandRequestHash(ownerRoot, input.envelope.request);
  const payload = input.envelope.request.payload;
  if (payload.preflightAuthorization === undefined) {
    // 只读重放也先锁定 owner 自身身份，避免 ledger 读取跟随被替换的符号链接。
    const metadata = await lstat(ownerRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(ownerRoot) !== ownerRoot) {
      throw new Error("小说导入 command owner 身份已变化或尚不存在。");
    }
    const [keyed, requested] = await Promise.all([
      getCommandByIdempotencyKey(ownerRoot, input.envelope.idempotencyKey),
      getCommandByRequestId(ownerRoot, input.envelope.requestId),
    ]);
    const candidates = [keyed, requested].filter((record): record is IdempotentCommandResult => Boolean(record));
    if (!candidates.length || candidates.some((record) => (
      !matchesNovelImportReplayRecord(record, requestHash) || !allowsNovelImportTokenlessReplay(record)
    ))) {
      throw new Error("无 preflight authorization 的小说导入只允许重放已有 app-owner 账本中的已完成、unknown 或待恢复命令。");
    }
    return;
  }

  // 纯内存 capability 解析必须先于任何 owner 文件系统写入。
  const preflight = inspectNovelImportPreflightAuthorization(payload.preflightAuthorization);
  if (preflight.preflightId !== payload.preflightId
    || preflight.fingerprint !== payload.preflightFingerprint
    || preflight.sourceTreeAggregateSha256 !== payload.sourceTreeAggregateSha256) {
    throw new Error("小说导入的稳定预检身份与 opaque authorization 不一致。");
  }
  const projectsRoot = await resolveNovelImportProjectsRoot(payload.projectsRoot);
  if (input.destinationIdentity) {
    if (input.destinationIdentity.projectsRoot !== projectsRoot
      || input.destinationIdentity.canonicalRoot !== projectsRoot) {
      throw new Error("小说导入命令的临时目标身份与服务端 projectsRoot 不一致。");
    }
    // Main-only 临时能力在 owner/ledger 任何写入前首次复验。
    await assertConfinedRootIdentity(input.destinationIdentity);
  }
  assertNovelImportDestinationDoesNotOverlapPreflight(projectsRoot, preflight);
  assertNovelImportDestinationDoesNotOverlapPreflight(ownerRoot, preflight);
  assertNovelImportOwnerAndProjectsDisjoint(ownerRoot, projectsRoot);
  await assertCanonicalNovelImportOwnerParent(ownerRoot);
  // 到此所有路径/身份检查仍是只读。现在原子钉住 capability 与稳定请求哈希，
  // 必须成功后才允许创建 owner 或命令账本；Core claim 复用同一 reservation。
  const reserved = reserveNovelImportPreflightAuthorization(
    payload.preflightAuthorization,
    requestHash,
  );
  if (reserved.preflightId !== preflight.preflightId
    || reserved.fingerprint !== preflight.fingerprint
    || reserved.sourceTreeAggregateSha256 !== preflight.sourceTreeAggregateSha256) {
    throw new Error("小说导入预检 authorization 在写前 reservation 期间发生变化。");
  }
  const owner = await ensureConfinedDirectory(path.dirname(ownerRoot), ownerRoot);
  if (owner.directory !== ownerRoot || owner.canonicalDirectory !== ownerRoot) {
    throw new Error("小说导入 command owner 规范身份不一致。");
  }
}

async function authorizeNovelWritingSourceImportBeforeLedger(input: {
  root: string;
  storageRoot: string;
  envelope: IdempotentCommandInput & {
    request: Extract<NovelCommandRequest, { command: "novel_import_writing_source_snapshot" }>;
  };
}): Promise<void> {
  if (input.storageRoot !== input.root) {
    throw new Error("writing source snapshot 命令账本必须固定在当前受管小说工程。");
  }
  const metadata = await lstat(input.root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(input.root) !== input.root) {
    throw new Error("writing source snapshot 目标必须是无符号链接的规范受管工程。");
  }
  const requestHash = commandRequestHash(input.root, input.envelope.request);
  const payload = input.envelope.request.payload;
  if (!payload.preflightAuthorization) {
    const [keyed, requested] = await Promise.all([
      getCommandByIdempotencyKey(input.root, input.envelope.idempotencyKey),
      getCommandByRequestId(input.root, input.envelope.requestId),
    ]);
    const candidates = [keyed, requested].filter((record): record is IdempotentCommandResult => Boolean(record));
    if (!candidates.length || candidates.some((record) => (
      record.command !== "novel_import_writing_source_snapshot"
      || record.requestHash !== requestHash
      || !allowsNovelImportTokenlessReplay(record)
    ))) {
      throw new Error("无 preflight authorization 的 writing source 导入只允许重放已有同身份命令。");
    }
    return;
  }
  const preflight = inspectNovelImportPreflightAuthorization(payload.preflightAuthorization);
  if (preflight.preflightId !== payload.preflightId
    || preflight.fingerprint !== payload.preflightFingerprint
    || preflight.sourceTreeAggregateSha256 !== payload.sourceTreeAggregateSha256) {
    throw new Error("writing source 导入的稳定预检身份与 opaque authorization 不一致。");
  }
  assertNovelImportDestinationDoesNotOverlapPreflight(input.root, preflight);
  const reserved = reserveNovelImportPreflightAuthorization(payload.preflightAuthorization, requestHash);
  if (reserved.preflightId !== preflight.preflightId || reserved.fingerprint !== preflight.fingerprint) {
    throw new Error("writing source 预检 authorization 在写前 reservation 期间发生变化。");
  }
}

export interface ExecuteIdempotentCommandOptions {
  storageRoot?: string;
  waitForRunningMs?: number;
  /** 同一命令内账本、业务 owner 与终态写回共享的绝对 SQLite 截止时间。 */
  deadlineAtMs?: number;
  signal?: AbortSignal;
  onProgress?: PersistedScanOptions["onProgress"];
  /** 跨代理写租约：有租约时生图相关写命令必须匹配 */
  writeLeaseHolderId?: string;
  writeLeaseToken?: string;
  /** Main 原生目录选择冻结的短期 inode；不进请求、哈希、账本或事件。 */
  novelImportDestinationIdentity?: NovelImportDestinationExecutionIdentity;
  /**
   * 小说正文保存的入口身份。默认按 Agent 失败关闭；只有桌面 Main 的人工编辑器
   * 可以显式声明 human_ui，以兼容不带 Writing OS preflight 的手工保存。
   * 该入口身份不进业务请求哈希或 durable 账本，但必须在账本读取前完成授权检查。
   */
  novelWriteActor?: "agent" | "agent_reviewer" | "human_owner" | "human_ui";
  /** prepare_novel_chapter_write 返回的短期能力；仅内存传递，禁止写入账本。 */
  novelWriteLeaseToken?: string;
  /** 模型/会话归因不是 owner 授权，只与租约 token 一起绑定正式 Agent 保存。 */
  novelActorAttribution?: NovelActorAttribution;
  studioWriteActor?: "codex" | "user";
}

async function executeIdempotentCommandWithinDeadline(projectRoot: string, input: IdempotentCommandInput, options: ExecuteIdempotentCommandOptions = {}): Promise<IdempotentCommandResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(input.requestId)) throw new Error("requestId 必须为 8–160 位稳定标识。 ");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(input.idempotencyKey)) throw new Error("idempotencyKey 必须为 8–200 位稳定标识。 ");
  // Studio 的公开命令与 2 条 Core-only 初始化命令必须在任何工程探测、
  // 锁或命令账本 I/O 之前经过同一份严格运行时 schema。MCP/Main 仍各自收紧 actor，
  // 此处作为最终 owner 闸口允许 user|codex，但绝不允许额外字段或坏 revision。
  const parsedStudioRequest = parseStudioCommandRequestForCore(input.request);
  if (parsedStudioRequest) {
    // The parsed object is the canonical command identity. It must drive every
    // later guard, hash, ledger row and owner call instead of the raw envelope.
    input = { ...input, request: parsedStudioRequest as CommandRequest };
  }
  if ((["claim_studio_higgsfield_connector_request", "preflight_studio_higgsfield_connector_request", "authorize_studio_higgsfield_connector_request", "record_studio_higgsfield_connector_submission", "reconcile_studio_higgsfield_connector_request", "prepare_studio_higgsfield_video_generation", "record_studio_higgsfield_video_submission", "attest_studio_higgsfield_connector_capability"] as const).includes(input.request.command as never)
    && options.studioWriteActor !== "codex") {
    throw new Error("Higgsfield connector 写命令只允许 Codex actor；必须在任何账本 I/O 前拒绝。");
  }
  const parsedNovelRequest = parseNovelCommandRequestForCore(input.request);
  if (parsedNovelRequest) {
    // novel parser 与 Studio 一样是 owner 边界：canonical 对象必须驱动
    // 后续分类、请求哈希、账本和 Repository 调用。
    input = { ...input, request: parsedNovelRequest as CommandRequest };
  }
  if (parsedNovelRequest?.command === "novel_save_chapter"
    && parsedNovelRequest.payload.aiWriteContext?.workflowMode === "rehearsal") {
    throw new RejectedCommandFailure("rehearsal 只用于上下文与写前检查，禁止同步到权威小说正文。", {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      reason: "workflow_mode_forbidden",
      chapterId: parsedNovelRequest.payload.chapterId,
      nextAction: "保留演练结果为外部草稿；如需写入权威正文，请重新执行 formal context pack、preflight 与章节写租约流程",
    });
  }
  if (parsedNovelRequest?.command === "novel_save_chapter"
    && options.novelWriteActor !== "human_ui"
    && !parsedNovelRequest.payload.aiWriteContext) {
    throw new RejectedCommandFailure("Agent 保存小说正文必须携带有效的 aiWriteContext；请先组装 context pack 并完成写前 preflight。", {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      reason: "context_preflight_required",
      chapterId: parsedNovelRequest.payload.chapterId,
      nextAction: "build_context_pack → preflight_chapter_write → 原样携带 aiWriteContext 保存",
    });
  }
  if (parsedNovelRequest?.command === "novel_save_chapter"
    && options.novelWriteActor === "agent_reviewer") {
    throw new RejectedCommandFailure("小说审稿 Agent 没有正文写权限；只能提交审稿票。", {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      reason: "actor_forbidden",
      chapterId: parsedNovelRequest.payload.chapterId,
      nextAction: "使用 novel_attach_review_ticket；由被授权主笔处理正文",
      nextTools: [{
        tool: "execute_command",
        argsMode: "partial",
        args: { request: { command: "novel_attach_review_ticket", payload: { chapterId: parsedNovelRequest.payload.chapterId } } },
        requiredArgs: ["projectRoot", "requestId", "idempotencyKey", "request.payload"],
        purpose: "只提交正文证据化审稿票，不修改正文",
      }],
    });
  }
  if (parsedNovelRequest?.command === "novel_save_chapter"
    && options.novelWriteActor !== "human_owner"
    && options.novelWriteActor !== "human_ui"
    && (parsedNovelRequest.payload.aiWriteContext?.workflowMode ?? "formal") === "formal"
    && (!parsedNovelRequest.payload.aiWriteContext?.leaseId
      || !parsedNovelRequest.payload.aiWriteContext.leaseFence
      || !parsedNovelRequest.payload.aiWriteContext.actorFingerprint
      || !options.novelWriteLeaseToken
      || !options.novelActorAttribution)) {
    throw new RejectedCommandFailure("正式 Agent 保存小说正文必须携带 prepare 签发的章节写租约与 actor 归因。", {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      reason: "chapter_write_lease_required",
      chapterId: parsedNovelRequest.payload.chapterId,
      nextAction: "执行 prepare_novel_chapter_write，并原样携带 aiWriteContext、novelWriteLeaseToken、novelActorAttribution",
      nextTools: [{
        tool: "prepare_novel_chapter_write",
        argsMode: "partial",
        args: { targetChapterId: parsedNovelRequest.payload.chapterId },
        requiredArgs: ["projectRoot", "attribution"],
        purpose: "重新生成 pack/preflight 并获取章级 fence/token",
      }],
    });
  }
  if (parsedNovelRequest?.command === "novel_create_chapter"
    && options.novelWriteActor !== "human_ui"
    && (parsedNovelRequest.payload.content?.length ?? 0) > 0) {
    throw new RejectedCommandFailure("Agent 创建小说章节时不得直接写入正文；请先创建空章，再完成 context pack 与写前 preflight 后保存正文。", {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      reason: "context_preflight_required",
      nextAction: "以空正文创建章节 → build_context_pack → preflight_chapter_write → 携带 aiWriteContext 保存正文",
    });
  }
  if (parsedNovelRequest
    && (parsedNovelRequest.command === "novel_seed_writing_state"
      || parsedNovelRequest.command === "novel_import_writing_source_snapshot"
      || parsedNovelRequest.command === "novel_review_chapter_state_candidate"
      || parsedNovelRequest.command === "novel_review_story_bible_candidate"
      || parsedNovelRequest.command === "novel_invalidate_writing_state_from")
    && options.novelWriteActor !== "human_owner"
    && options.novelWriteActor !== "human_ui") {
    throw new RejectedCommandFailure("该小说状态命令只允许受信任的人类 owner 执行；Agent 只能提交候选或审稿票。", {
      schemaVersion: 1,
      applied: false,
      entityType: "novel_writing_state",
      reason: "actor_forbidden",
      nextAction: "由桌面 owner 审核后执行；Agent 不得在 payload 中自称 human-owner",
    });
  }
  assertStudioBindingPublicPayload(input.request);
  assertStudioScriptSectionPublicPayload(input.request);
  assertStudioContinuityReviewPublicPayload(input.request);
  assertP30OrchestrationPublicPayload(input.request);
  const root = path.resolve(projectRoot);
  const studioCommand = isStudioCommandRequest(input.request);
  const novelCommand = isNovelCommandRequest(input.request);
  const novelImportRequest = isNovelCommandRequest(input.request) && isNovelImportCommandRequest(input.request)
    ? input.request
    : null;
  const novelImportCommand = novelImportRequest !== null;
  const novelWritingSourceImportRequest = isNovelCommandRequest(input.request)
    && isNovelWritingSourceImportCommandRequest(input.request)
    ? input.request
    : null;
  if (options.novelImportDestinationIdentity && !novelImportCommand) {
    throw new Error("小说导入目标身份只允许用于 novel_import_external_snapshot。");
  }
  const duduBootstrapCommand = input.request.command === "stage_dudu_readonly_managed_project";
  const storageRoot = path.resolve(options.storageRoot ?? root);
  if (novelImportCommand) {
    await authorizeNovelImportCommandBeforeLedger({
      root,
      storageRoot,
      envelope: input as IdempotentCommandInput & {
        request: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>;
      },
      destinationIdentity: options.novelImportDestinationIdentity,
    });
  }
  if (novelWritingSourceImportRequest) {
    await authorizeNovelWritingSourceImportBeforeLedger({
      root,
      storageRoot,
      envelope: input as IdempotentCommandInput & {
        request: Extract<NovelCommandRequest, { command: "novel_import_writing_source_snapshot" }>;
      },
    });
  }
  const managedProject = novelImportCommand ? false : await isManagedProject(root);
  if (managedProject && !studioCommand && !novelCommand) {
    throw new Error(`受管素材工程拒绝旧命令 ${input.request.command}；请使用素材中心专用命令，避免扫描或写入平行事实源。`);
  }
  if (novelCommand && !novelImportCommand && !managedProject) {
    throw new Error("novel 命令只允许写入 schema v2 novel/hybrid 受管工程。 ");
  }
  // Studio 命令在写统一命令账本前先验证受管壳，避免把普通/legacy 目录静默接管。
  // 正式写根强制为当前受管工程；禁止隐式跨根 storageRoot。
  let managedShell: Awaited<ReturnType<typeof inspectManagedProject>> | undefined;
  if (studioCommand) {
    managedShell = await inspectManagedProject(root);
    // 跨代理写租约：require 模式无租约不准写；compat 仅在有租约时挡异主。
    const { assertStudioProjectWriteLeaseForCommand } = await import("./studio-project-write-lease.js");
    await assertStudioProjectWriteLeaseForCommand(root, {
      command: input.request.command,
      holderId: options.writeLeaseHolderId,
      leaseToken: options.writeLeaseToken,
    });
  } else if (novelCommand && !novelImportCommand) {
    managedShell = await inspectManagedProjectReadOnly(root);
    if (managedShell.manifest.schemaVersion !== 2
      || (managedShell.workspaceMode !== "novel" && managedShell.workspaceMode !== "hybrid")) {
      throw new Error("novel 命令只允许写入 schema v2 novel/hybrid 受管工程。 ");
    }
  }
  if ((studioCommand || novelCommand) && storageRoot !== root) {
    throw new Error("受管工程禁止隐式跨根 command storageRoot；写入口必须固定 projectRoot。");
  }
  if (studioCommand && managedShell) {
    const payload = (input.request as { payload?: Record<string, unknown> }).payload;
    if (payload && typeof payload.projectId === "string" && payload.projectId !== managedShell.project.id) {
      throw new Error("写操作 projectId 与当前受管工程不一致，拒绝跨工程写入。");
    }
    if (payload && typeof payload.projectRoot === "string" && path.resolve(String(payload.projectRoot)) !== root) {
      throw new Error("写操作 projectRoot 与当前受管工程不一致，拒绝跨根写入。");
    }
  }
  if (input.request.command === "stage_dudu_readonly_managed_project") {
    const expectedRoot = await resolveDuduReadonlyImportCommandRoot(input.request.payload.projectsRoot);
    if (expectedRoot !== root || storageRoot !== root) {
      throw new Error("Dudu bootstrap 命令根必须等于 payload.projectsRoot 的唯一 transaction root。");
    }
    // transaction root 是 stage 前唯一允许建立的 bootstrap owner。路径已由
    // canonical projectsRoot 推导；严格 schema/CAS 已先完成，创建过程逐级拒绝 symlink。
    await ensureConfinedDirectory(path.dirname(root), root);
  }
  // 只有扫描具备明确的提交点与子进程中止语义。其他写命令不能因客户端断线
  // 被盲目取消，否则可能把已发生的付费或外部副作用误记为未执行。
  const signal = input.request.command === "scan_project" ? options.signal : undefined;
  throwIfAborted(signal);
  const requestHash = commandRequestHash(root, input.request);
  const verifyNovelImportReplay = async (
    record: IdempotentCommandResult,
  ): Promise<IdempotentCommandResult> => {
    if (!novelImportRequest) return record;
    try {
      return {
        ...record,
        replayed: true,
        result: await proveSafeCompletedNovelImportResult(novelImportRequest, requestHash, record),
      };
    } catch (error) {
      await downgradeSucceededNovelImportClosureDrift(storageRoot, record, error);
      throw new Error("小说导入 registered 业务闭包漂移；本次拒绝重放并将账本降为 unknown。", { cause: error });
    }
  };
  const registration = await withSqliteBusyRetry(() => withProjectLock(storageRoot, "command-bus", async (): Promise<{ action: "execute"; record: IdempotentCommandResult } | { action: "replay"; record: IdempotentCommandResult } | { action: "recover"; record: IdempotentCommandResult } | { action: "wait" }> => {
    const keyed = await getCommandByIdempotencyKey(storageRoot, input.idempotencyKey);
    if (keyed) {
      if (keyed.requestHash !== requestHash) throw new Error("幂等键已用于不同参数；拒绝执行以避免重复或错写。 ");
      if (keyed.status === "succeeded") return { action: "replay", record: { ...keyed, requestId: input.requestId, replayed: true } };
      if (keyed.status === "running") {
        if (isDurableReconciliationCommand(input.request) && !processAlive(keyed.execution?.pid)) return { action: "recover", record: { ...keyed } };
        return { action: "wait" };
      }
      if (keyed.status === "failed") {
        if (isDurableReconciliationCommand(input.request) && keyed.execution?.phase === "side_effect_committed") return { action: "recover", record: { ...keyed } };
        if (keyed.error?.busyUncommitted === true) {
          // SQLite 瞬时锁失败且事务确认未提交：允许同一 idempotencyKey（参数哈希已在
          // 上方校验一致）受控重试。重新登记 running，不新建账本键、不重放旧结果。
          const restartedAt = new Date().toISOString();
          const record: IdempotentCommandResult = {
            ...keyed,
            requestId: input.requestId,
            status: "running",
            replayed: false,
            result: undefined,
            error: undefined,
            executedAt: undefined,
            // 登记事务本身就是“该进程接下来可能进入 domain execute”的唯一耐久
            // 边界。直接持久化 executing，避免登记后再做第二次 SQLite phase 写；
            // 若进程在真正调用 owner 前退出，恢复路径保守按 uncertain 处理。
            execution: { pid: process.pid, phase: "executing", heartbeatAt: restartedAt },
            startedAt: restartedAt,
          };
          await persistCommandLedgerEntry(storageRoot, record, restartedAt);
          await appendEvent(storageRoot, {
            actor: "codex",
            type: "command.started",
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            command: input.request.command,
            data: isNovelAnalysisExecutionCommand(input.request)
              ? { requestHash, retryAfterBusyUncommitted: true }
              : { requestHash, projectRoot: root, retryAfterBusyUncommitted: true },
          });
          return { action: "execute", record };
        }
        throw new Error(`命令 ${keyed.command} 已明确失败：${keyed.error?.message ?? "已记录失败终态"}；原幂等键不会重放。`);
      }
      if (keyed.status === "cancelled") throw new Error(`命令 ${keyed.command} 已明确取消且未提交；如需重新执行，请使用新的 requestId 与 idempotencyKey。`);
      if (isDurableReconciliationCommand(input.request)) return { action: "recover", record: { ...keyed } };
      throw new Error(`命令 ${keyed.command} 的既有执行结果为 ${keyed.status}；禁止自动重放。请先读取命令账本和真实文件进行结果对账。`);
    }
    const requested = await getCommandByRequestId(storageRoot, input.requestId);
    if (requested && requested.requestHash !== requestHash) throw new Error("requestId 已用于不同命令；请生成新的 requestId。 ");
    if (requested) {
      if (requested.status === "succeeded") return { action: "replay", record: { ...requested, replayed: true } };
      if (requested.status === "running") {
        if (isDurableReconciliationCommand(input.request) && !processAlive(requested.execution?.pid)) return { action: "recover", record: { ...requested } };
        return { action: "wait" };
      }
      if (requested.status === "failed") {
        if (isDurableReconciliationCommand(input.request) && requested.execution?.phase === "side_effect_committed") return { action: "recover", record: { ...requested } };
        throw new Error(`requestId 对应命令已明确失败：${requested.error?.message ?? "已记录失败终态"}；请修正输入并使用新的 requestId 与 idempotencyKey。`);
      }
      if (requested.status === "cancelled") throw new Error(`requestId 对应命令已明确取消且未提交；如需重新执行，请使用新的 requestId 与 idempotencyKey。`);
      if (isDurableReconciliationCommand(input.request)) return { action: "recover", record: { ...requested } };
      throw new Error(`requestId 对应命令结果为 ${requested.status}；禁止自动重放。请先对账。`);
    }
    const startedAt = new Date().toISOString();
    const record: IdempotentCommandResult = { schemaVersion: 1, requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, status: "running", replayed: false, requestHash, execution: { pid: process.pid, phase: "executing", heartbeatAt: startedAt }, durableReconciliation: durableReconciliationSnapshot(input.request), storageRoot: storageRoot !== root ? storageRoot : undefined, startedAt };
    await persistCommandLedgerEntry(storageRoot, record, startedAt);
    await appendEvent(storageRoot, {
      actor: "codex",
      type: "command.started",
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      command: input.request.command,
      data: isNovelAnalysisExecutionCommand(input.request) ? { requestHash } : { requestHash, projectRoot: root },
    });
    return { action: "execute", record };
  }).catch((error: unknown) => {
    // command ledger entry/meta 现在同事务提交；登记失败发生在 domain execute 前，
    // 因而只有这一处能把原始 busy 提升为可安全重试的 typed proof。
    if (isSqliteBusyError(error)) {
      throw new RetrySafeSqliteBusyError(error, { kind: "before_domain_execute" });
    }
    throw error;
  }));
  if (registration.action === "replay") return verifyNovelImportReplay(registration.record);
  if (registration.action === "recover") {
    const recovered = isDurableReconciliationCommand(input.request)
      ? await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: registration.record, request: input.request, replayRequestId: input.requestId })
      : undefined;
    if (recovered) return verifyNovelImportReplay(revokePersistedImagegenCallCapability(recovered));
    const unresolved = registration.record.status === "running"
      ? await markLostDurableExecutorUnknown({ projectRoot: root, storageRoot, record: registration.record })
      : registration.record;
    if (unresolved.status === "failed") throw new Error(`命令 ${unresolved.command} 已明确失败：${unresolved.error?.message ?? "已记录失败终态"}；当前业务证据不能把它改判为成功。`);
    throw new Error(`命令 ${unresolved.command} 未能从不可变 store/候选指纹证明完成；保持 unknown，禁止自动重放。`);
  }
  if (registration.action === "wait") {
    const deadline = Date.now() + Math.max(250, options.waitForRunningMs ?? 30_000);
    while (Date.now() < deadline) {
      await wait(40, signal);
      const current = (await getCommandByIdempotencyKey(storageRoot, input.idempotencyKey))
        ?? (await getCommandByRequestId(storageRoot, input.requestId));
      if (!current) throw new Error("命令等待期间账本记录消失；已停止执行以避免重复副作用。 ");
      if (current.requestHash !== requestHash) throw new Error("命令等待期间请求哈希发生冲突；拒绝继续。 ");
      if (current.status === "succeeded") {
        return verifyNovelImportReplay({ ...current, requestId: input.requestId, replayed: true });
      }
      if (current.status === "failed") {
        if (isDurableReconciliationCommand(input.request) && current.execution?.phase === "side_effect_committed") {
          const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: current, request: input.request, replayRequestId: input.requestId });
          if (recovered) return verifyNovelImportReplay(recovered);
        }
        if (current.error?.busyUncommitted === true) {
          // 等待中目击到 busyUncommitted 失败终态：事务确认未提交，可安全重试。
          // 消息携带 canonical SQLITE_BUSY 文案，错误对象带结构化 busyUncommitted/retryable
          // 标记，MCP 分类稳定命中 RESOURCE_BUSY（不再依赖账本消息文本偶然匹配）。
          // 不自动重登记——登记语义不变，调用方用相同 requestId/idempotencyKey 重发即可。
          throw Object.assign(
            new Error(`命令 ${current.command} 因数据库瞬时锁在受控重试预算内仍未释放（SQLITE_BUSY，事务未提交），可用相同 requestId 与 idempotencyKey 安全重试：${current.error.message}`),
            { busyUncommitted: true, retryable: true },
          );
        }
        throw new Error(`命令 ${current.command} 已明确失败：${current.error?.message ?? "已记录失败终态"}；原幂等键不会重放。`);
      }
      if (current.status === "cancelled") throw new Error(`命令 ${current.command} 已明确取消且未提交；如需重新执行，请使用新的 requestId 与 idempotencyKey。`);
      if (current.status === "unknown") {
        if (isDurableReconciliationCommand(input.request)) {
          const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: current, request: input.request, replayRequestId: input.requestId });
          if (recovered) return verifyNovelImportReplay(recovered);
        }
        throw new Error(`命令 ${current.command} 的执行结果为 unknown；禁止自动重放。请先读取命令账本和真实文件进行结果对账。`);
      }
      if (isDurableReconciliationCommand(input.request) && current.status === "running" && !processAlive(current.execution?.pid)) {
        const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: current, request: input.request, replayRequestId: input.requestId });
        if (recovered) return verifyNovelImportReplay(recovered);
        await markLostDurableExecutorUnknown({ projectRoot: root, storageRoot, record: current });
        throw new Error(`命令 ${current.command} 的执行进程已退出，且不可变证据不足；保持 unknown，禁止自动重放。`);
      }
    }
    throw new Error("相同幂等命令仍在其他进程执行；本次没有重复运行，请稍后读取命令账本。 ");
  }

  const record = registration.record;
  const persistRecord = async (): Promise<IdempotentCommandResult> => withProjectLock(storageRoot, "command-bus", async () => {
    const existing = await getCommandByIdempotencyKey(storageRoot, record.idempotencyKey);
    if (!existing) throw new Error("命令执行后账本记录消失；停止回写以保留现场。 ");
    if (existing.requestHash !== record.requestHash) throw new Error("命令执行后账本请求哈希发生变化；停止回写。 ");
    if (existing.status === "succeeded" && record.status !== "succeeded") return existing;
    const next = { ...record };
    await persistCommandLedgerEntry(storageRoot, next, next.executedAt ?? next.startedAt);
    return next;
  });

  let heartbeatChain = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatChain = heartbeatChain.then(async () => {
      if (record.status !== "running" || !record.execution) return;
      record.execution.heartbeatAt = new Date().toISOString();
      await persistRecord();
    }).catch(() => undefined);
  }, 5_000);
  heartbeat.unref();
  const stopHeartbeat = async () => {
    clearInterval(heartbeat);
    await heartbeatChain;
  };

  let busyAttempts = 0;
  try {
    if (process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND === input.request.command) {
      await wait(Math.max(0, Math.min(5_000, Number(process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS) || 0)), signal);
    }
    const runCommand = () => runWithOperationContext(
      {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        command: input.request.command,
        ...(novelImportCommand && options.novelImportDestinationIdentity
          ? { novelImportDestinationIdentity: options.novelImportDestinationIdentity }
          : {}),
      },
      () => {
        // 测试注入：前 N 次执行抛 SQLITE_BUSY（errcode=5），模拟事务前/提交期瞬时写锁。
        if (process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND === input.request.command) {
          const busyKey = `${input.request.command}:${input.idempotencyKey}`;
          const injected = testBusyExecuteAttempts.get(busyKey) ?? 0;
          const injectTimes = Math.max(0, Math.min(12, Number(process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES) || 0));
          if (injected < injectTimes) {
            testBusyExecuteAttempts.set(busyKey, injected + 1);
            const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
            throw new RetrySafeSqliteBusyError(busy, { kind: "before_domain_execute" });
          }
        }
        return execute(root, input.request, {
          operationId: requestHash,
          signal,
          onProgress: options.onProgress,
          novelWriteActor: options.novelWriteActor,
          novelWriteLeaseToken: options.novelWriteLeaseToken,
          novelActorAttribution: options.novelActorAttribution,
        });
      },
    );
    // Studio 业务横跨 material / production / generation SQLite。所有公开 Studio 写入
    // 在同一项目级 fence 中串行，防止 Review 读取 pack/BindingSet 快照后，
    // 另一写者在 Review Head 落盘前改变上游身份。这不取代各账本内部 CAS。
    const executeOnce = studioCommand
      ? () => withProjectLock(root, "studio-mutation", async () => {
        // 初检与实际提交之间可能经历命令登记、排队和重试。进入唯一 Studio 写
        // fence 后必须复验同一 holder+leaseToken 代次；takeover/release 也受该
        // fence 串行化，因此复验成功到本次写结束之间不会发生 ABA 换主。
        const { assertStudioProjectWriteLeaseForCommand } = await import("./studio-project-write-lease.js");
        await assertStudioProjectWriteLeaseForCommand(root, {
          command: input.request.command,
          holderId: options.writeLeaseHolderId,
          leaseToken: options.writeLeaseToken,
        });
        return runCommand();
      })
      : duduBootstrapCommand
        ? () => withProjectLock(root, "dudu-bootstrap-mutation", runCommand)
        : novelImportCommand
          // 外部导入的业务写入横跨 transaction、项目 bootstrap 与 registry；
          // 在应用 owner 下全局串行，避免污染 projectsRoot 的锁目录。
          ? () => withProjectLock(root, "novel-import-mutation", runCommand)
          : runCommand;
    // 只有 typed RetrySafeSqliteBusyError 携带 owner 给出的零副作用证明时才重试。
    // 任意业务 owner 冒出的原始 SQLITE_BUSY 默认 outcome_unknown，不能从
    // “顶层 execute 尚未返回”推断跨 CAS/文件/多 SQLite owner 均未提交。
    const result = await withSqliteBusyRetry(executeOnce, {
      onAttempt: (attempt) => { busyAttempts = attempt; },
      sleep: (milliseconds) => wait(milliseconds, signal),
    });
    await stopHeartbeat();
    if (process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT === input.request.command) throw new Error("TEST_ONLY_CRASH_BEFORE_COMMIT_EVENT");
    const persistedResult = input.request.command === "prepare_studio_higgsfield_video_generation"
      ? projectHiggsfieldPrepareResultForPersistence(result)
      : (["claim_studio_higgsfield_connector_request", "authorize_studio_higgsfield_connector_request"] as const).includes(input.request.command as never)
        ? projectHiggsfieldConnectorQueueResultForPersistence(input.request.command, result)
      : input.request.command === "prepare_studio_imagegen_call"
        ? revokeImagegenCallCapabilityFromResult(result)
        : result;
    if (novelImportCommand) {
      await withProjectLock(root, "novel-import-mutation", async () => {
        const actual = novelImportResultAnchorFromResult(persistedResult);
        const historical = await uniqueNovelImportRequestAnchor(storageRoot, requestHash);
        if (historical) assertNovelImportResultMatchesAnchor(persistedResult, historical);
        record.novelImportResultAnchor = historical ?? actual;
        record.execution = { pid: process.pid, phase: "side_effect_committed", heartbeatAt: new Date().toISOString() };
        await persistRecord();
      });
    }
    const resultDigest = createHash("sha256").update(stable(persistedResult)).digest("hex");
    record.execution = { pid: process.pid, phase: "side_effect_committed", heartbeatAt: new Date().toISOString() };
    // 导入业务副作用已经闭合，先把首次 receipt 锚点与 side_effect_committed
    // 阶段持久化；即使随后响应丢失，unknown 恢复也不能采用另一套自洽闭包。
    // novel import 已在 mutation fence 内连同跨 key anchor 一起持久化。
    const terminalData = { requestHash, command: input.request.command, resultDigest, projectRoot: root };
    await appendEvent(storageRoot, { actor: "codex", type: "command.side-effect-committed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: terminalData });
    if (storageRoot !== root) {
      await appendEvent(root, { actor: "codex", type: "command.side-effect-committed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: terminalData });
      await mirrorLedgerRecord(root, record);
    }
    if (process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE === input.request.command) throw new Error("TEST_ONLY_CRASH_AFTER_EXECUTE");
    // 测试注入：副作用已提交后的响应丢失窗口抛 busy——必须走 outcome_unknown 对账，禁止重试。
    if (process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE === input.request.command) throw Object.assign(new Error("database is locked"), { errcode: 5 });
    record.status = "succeeded";
    record.result = persistedResult;
    record.executedAt = new Date().toISOString();
    const stored = await persistRecord();
    if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
    await appendEvent(storageRoot, { actor: "codex", type: "command.executed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, projectRoot: root } });
    // 首次成功调用栈可以消费唯一一次 true；任何账本、事件、等待者与后续重放都只见 false。
    if ((["prepare_studio_imagegen_call", "prepare_studio_higgsfield_video_generation", "claim_studio_higgsfield_connector_request", "authorize_studio_higgsfield_connector_request"] as const).includes(input.request.command as never)
      && result && typeof result === "object" && !Array.isArray(result)
      && (input.request.command === "claim_studio_higgsfield_connector_request"
        || input.request.command === "authorize_studio_higgsfield_connector_request"
        || (result as { callAllowed?: unknown }).callAllowed === true)) {
      return { ...stored, result };
    }
    return stored;
  } catch (error) {
    await stopHeartbeat();
    const observedAt = new Date().toISOString();
    if (isAbortError(error) && input.request.command === "scan_project") {
      const cancellation = abortError(signal);
      record.status = "cancelled";
      record.result = undefined;
      record.error = { message: cancellation.message, observedAt };
      record.executedAt = observedAt;
      const stored = await persistRecord();
      if (stored.status === "succeeded") return verifyNovelImportReplay({ ...stored, replayed: true });
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      await appendEvent(storageRoot, { actor: "codex", type: "command.cancelled", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: record.error.message, projectRoot: root, committed: false } });
      throw cancellation;
    }
    if (isNovelAnalysisExecutionCommand(input.request) && isNovelAnalysisExecutionSafetyError(error)) {
      // 小说正文外发通道的 pre-dispatch 与 post-dispatch 错误只能进入稳定投影。
      // 特别是不能复用通用 command 事件的 projectRoot 字段：它会把本机绝对路径
      // 和底层错误一起暴露给账本读取面或 Renderer。
      const safeMessage = novelAnalysisExecutionSafeMessage(error);
      const preDispatch = error.phase === "pre_dispatch";
      record.status = preDispatch ? "failed" : "unknown";
      record.result = undefined;
      record.error = { message: safeMessage, observedAt };
      record.executedAt = observedAt;
      const stored = await persistRecord();
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      const eventType = preDispatch ? "command.failed" : "command.outcome-unknown";
      const eventData = { requestHash, error: safeMessage, novelAnalysisSafetyCode: error.code, phase: error.phase };
      await appendEvent(storageRoot, { actor: "codex", type: eventType, requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: eventData });
      if (storageRoot !== root) await appendEvent(root, { actor: "codex", type: eventType, requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: eventData });
      throw error;
    }
    if (isRejectedCommandFailure(error)) {
      record.status = "failed";
      record.result = error.result;
      record.error = { message: error.message, observedAt };
      record.executedAt = observedAt;
      const stored = await persistRecord();
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      await appendEvent(storageRoot, { actor: "codex", type: "command.failed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: error.message, projectRoot: root, committed: false, result: error.result } });
      throw error;
    }
    if (isConfirmedCommandFailure(error)) {
      const durableProof = isDurableReconciliationCommand(input.request)
        ? await proveDurableOutcomeWithMutationFence(root, input.request)
        : undefined;
      if (durableProof) {
        const resultDigest = createHash("sha256").update(stable(durableProof.result)).digest("hex");
        record.execution = { pid: process.pid, phase: "side_effect_committed", heartbeatAt: observedAt };
        const terminalData = {
          requestHash,
          command: input.request.command,
          resultDigest,
          projectRoot: root,
          reconciledFromConfirmedFailure: true,
          evidenceSource: durableProof.source,
          durableIdentity: durableProof.identity,
        };
        await appendEvent(storageRoot, { actor: "codex", type: "command.side-effect-committed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: terminalData });
        if (storageRoot !== root) await appendEvent(root, { actor: "codex", type: "command.side-effect-committed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: terminalData });
        record.status = "succeeded";
        record.result = durableProof.result;
        record.error = undefined;
        record.executedAt = observedAt;
        const stored = await persistRecord();
        if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
        await appendEvent(storageRoot, { actor: "codex", type: "command.reconciled", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { evidenceEventIds: [], evidenceSource: durableProof.source, durableIdentity: durableProof.identity, reconciledAt: observedAt } });
        return verifyNovelImportReplay(stored);
      }
      const failureMessage = error.message;
      const resultDigest = createHash("sha256").update(stable(error.result)).digest("hex");
      record.execution = { pid: process.pid, phase: "side_effect_committed", heartbeatAt: observedAt };
      const terminalData = { requestHash, command: input.request.command, resultDigest, projectRoot: root, outcomeStatus: "failed", error: failureMessage, result: error.result };
      await appendEvent(storageRoot, { actor: "codex", type: "command.side-effect-committed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: terminalData });
      if (storageRoot !== root) await appendEvent(root, { actor: "codex", type: "command.side-effect-committed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: terminalData });
      record.status = "failed";
      record.result = error.result;
      record.error = { message: failureMessage, observedAt };
      record.executedAt = observedAt;
      const stored = await persistRecord();
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      await appendEvent(storageRoot, { actor: "codex", type: "command.failed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: failureMessage, projectRoot: root, committed: true } });
      throw error;
    }
    if (isRetrySafeSqliteBusyError(error)) {
      // 只有 typed proof 才能标记 failed(busyUncommitted) 并允许同键重试。
      const busyMessage = sqliteBusyDetailMessage(error);
      record.status = "failed";
      record.result = undefined;
      record.error = { message: busyMessage, observedAt, busyUncommitted: true, attempts: Math.max(1, busyAttempts), retryBudgetMs: STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS };
      record.executedAt = observedAt;
      const stored = await persistRecord();
      if (stored.status === "succeeded") return verifyNovelImportReplay({ ...stored, replayed: true });
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      await appendEvent(storageRoot, { actor: "codex", type: "command.failed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: busyMessage, projectRoot: root, committed: false, busyUncommitted: true, attempts: Math.max(1, busyAttempts) } });
      throw new Error(`数据库瞬时锁在 ${Math.max(1, busyAttempts)} 次受控重试（预算 ${STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS}ms）后仍未释放（command=${input.request.command}，事务未提交）：${busyMessage}`);
    }
    record.status = "unknown";
    record.error = { message: error instanceof Error ? error.message : String(error), observedAt };
    record.executedAt = observedAt;
    const stored = await persistRecord();
    if (stored.status === "succeeded") return verifyNovelImportReplay({ ...stored, replayed: true });
    if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
    await appendEvent(storageRoot, { actor: "codex", type: "command.outcome-unknown", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: record.error.message, projectRoot: root } });
    throw new Error(`命令执行结果未确认，已锁定幂等键防止重复副作用：${record.error.message}`);
  }
}

export async function executeIdempotentCommand(
  projectRoot: string,
  input: IdempotentCommandInput,
  options: ExecuteIdempotentCommandOptions = {},
): Promise<IdempotentCommandResult> {
  const now = Date.now();
  const defaultDeadlineAtMs = now + STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS;
  const deadlineAtMs = Math.min(options.deadlineAtMs ?? defaultDeadlineAtMs, defaultDeadlineAtMs);
  return withStudioSqliteBusyDeadline(deadlineAtMs, () =>
    executeIdempotentCommandWithinDeadline(projectRoot, input, options));
}

export async function reconcileCommand(projectRoot: string, input: { idempotencyKey: string }): Promise<IdempotentCommandResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(input.idempotencyKey)) throw new Error("idempotencyKey 必须为 8–200 位稳定标识。 ");
  const root = path.resolve(projectRoot);
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`命令账本中找不到幂等键：${input.idempotencyKey}`);
    }
    throw error;
  }
  const durableCandidate = await withProjectLock(root, "command-bus", async () => {
    const record = await getCommandByIdempotencyKey(root, input.idempotencyKey);
    if (!record) throw new Error(`命令账本中找不到幂等键：${input.idempotencyKey}`);
    return { ...record };
  });
  const durableRequest = reconciliationRequestFromRecord(root, durableCandidate);
  if (durableRequest?.command === "novel_import_external_snapshot"
    && durableCandidate.status === "succeeded") {
    try {
      return {
        ...durableCandidate,
        replayed: true,
        result: await proveSafeCompletedNovelImportResult(
          durableRequest as Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>,
          durableCandidate.requestHash,
          durableCandidate,
        ),
      };
    } catch (error) {
      await downgradeSucceededNovelImportClosureDrift(root, durableCandidate, error);
      throw new Error("小说导入 registered 业务闭包漂移；reconcile 拒绝返回 succeeded 并将账本降为 unknown。", { cause: error });
    }
  }
  if (durableRequest
    && (durableCandidate.status === "unknown"
      || durableCandidate.status === "running"
      || (durableCandidate.status === "failed" && durableCandidate.execution?.phase === "side_effect_committed"))) {
    const durableStorageRoot = durableCandidate.storageRoot && path.resolve(durableCandidate.storageRoot) !== root
      ? path.resolve(durableCandidate.storageRoot)
      : root;
    const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot: durableStorageRoot, record: durableCandidate, request: durableRequest });
    if (recovered) {
      if (durableRequest.command === "novel_import_external_snapshot") {
        try {
          return {
            ...recovered,
            replayed: true,
            result: await proveSafeCompletedNovelImportResult(
              durableRequest as Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>,
              durableCandidate.requestHash,
              recovered,
            ),
          };
        } catch (error) {
          await downgradeSucceededNovelImportClosureDrift(durableStorageRoot, recovered, error);
          throw new Error("小说导入恢复后 registered 业务闭包仍不完整；reconcile 拒绝返回 succeeded。", { cause: error });
        }
      }
      return recovered;
    }
  }
  const reconciled = await withProjectLock(root, "command-bus", async () => {
    const ledger = await readCommandLedger(root);
    const record = ledger.entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
    if (!record) throw new Error(`命令账本中找不到幂等键：${input.idempotencyKey}`);
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return { record: { ...record, replayed: true }, mirrorRoot: undefined as string | undefined };
    if (record.status === "unknown"
      && record.command === "revise_studio_production_unit"
      && record.execution?.phase === "executing"
      && /生产单元宫格总时长必须严格等于声明时长/u.test(record.error?.message ?? "")) {
      const reconciledAt = new Date().toISOString();
      record.status = "failed";
      record.result = {
        schemaVersion: 1,
        applied: false,
        entityType: "studio_production_unit",
        reason: "validation_failed",
        reconciled: true,
      };
      record.error = {
        message: record.error?.message ?? "生产单元时长校验失败。",
        observedAt: reconciledAt,
      };
      record.executedAt = reconciledAt;
      ledger.updatedAt = reconciledAt;
      await persistCommandLedgerSnapshot(root, ledger);
      await appendEvent(root, {
        actor: "codex",
        type: "command.reconciled",
        requestId: record.requestId,
        idempotencyKey: record.idempotencyKey,
        command: record.command,
        data: {
          evidenceEventIds: [],
          evidenceSource: "deterministic-studio-production-validation",
          reconciledAt,
          outcomeStatus: "failed",
        },
      });
      return {
        record: { ...record, replayed: true },
        mirrorRoot: record.storageRoot && path.resolve(record.storageRoot) !== root
          ? record.storageRoot
          : undefined,
      };
    }
    if (record.status === "unknown"
      && record.command === "commit_agent_imagegen_result_bundle"
      && record.execution?.phase === "executing"
      && /labels\.subtitle 过长（>120）/u.test(record.error?.message ?? "")) {
      const reconciledAt = new Date().toISOString();
      record.status = "failed";
      record.result = {
        schemaVersion: 1,
        applied: false,
        entityType: "studio_generation_result_bundle",
        reason: "validation_failed",
        reconciled: true,
      };
      record.error = {
        message: record.error?.message ?? "labeled 字幕输入校验失败。",
        observedAt: reconciledAt,
      };
      record.executedAt = reconciledAt;
      ledger.updatedAt = reconciledAt;
      await persistCommandLedgerSnapshot(root, ledger);
      await appendEvent(root, {
        actor: "codex",
        type: "command.reconciled",
        requestId: record.requestId,
        idempotencyKey: record.idempotencyKey,
        command: record.command,
        data: {
          evidenceEventIds: [],
          evidenceSource: "deterministic-studio-labeled-prewrite-validation",
          reconciledAt,
          outcomeStatus: "failed",
        },
      });
      return {
        record: { ...record, replayed: true },
        mirrorRoot: record.storageRoot && path.resolve(record.storageRoot) !== root
          ? record.storageRoot
          : undefined,
      };
    }
    const events = await findEventsByIdempotencyKey(root, input.idempotencyKey, 200);
    const evidence = events.filter((event) => event.type === "command.side-effect-committed"
      && event.requestId === record.requestId
      && event.command === record.command
      && event.data?.requestHash === record.requestHash
      && typeof event.data?.resultDigest === "string");
    if (!evidence.length) {
      if (record.status === "running" && record.execution?.pid && !processAlive(record.execution.pid)) {
        const observedAt = new Date().toISOString();
        record.status = "unknown";
        record.error = { message: `执行进程 ${record.execution.pid} 已退出，且没有终态提交证据；已转为 unknown，禁止自动重放。`, observedAt };
        record.executedAt = observedAt;
        ledger.updatedAt = observedAt;
        await persistCommandLedgerSnapshot(root, ledger);
        await appendEvent(root, { actor: "codex", type: "command.executor-lost", requestId: record.requestId, idempotencyKey: record.idempotencyKey, command: record.command, data: { pid: record.execution.pid, phase: record.execution.phase, heartbeatAt: record.execution.heartbeatAt, observedAt } });
        return { record: { ...record, replayed: true }, mirrorRoot: record.storageRoot && path.resolve(record.storageRoot) !== root ? record.storageRoot : undefined };
      }
      if (record.status === "running" && processAlive(record.execution?.pid)) throw new Error(`命令仍由进程 ${record.execution?.pid} 执行，不能提前对账。`);
      throw new Error("未找到与 requestHash/command 完全匹配的终态提交证据，不能把未确认命令推断为成功；中间业务事件不足以证明整条命令完成。 ");
    }
    const reconciledAt = new Date().toISOString();
    const failedEvidence = evidence.find((event) => event.data?.outcomeStatus === "failed");
    record.status = failedEvidence ? "failed" : "succeeded";
    record.error = failedEvidence ? { message: String(failedEvidence.data?.error ?? "命令已确认失败。"), observedAt: reconciledAt } : undefined;
    record.result = failedEvidence?.data?.result ?? { reconciled: true, evidenceEvents: evidence.map((event) => ({ id: event.id, type: event.type, at: event.at, itemId: event.itemId, taskId: event.taskId })) };
    record.executedAt = reconciledAt;
    ledger.updatedAt = reconciledAt;
    await persistCommandLedgerSnapshot(root, ledger);
    await appendEvent(root, { actor: "codex", type: "command.reconciled", requestId: record.requestId, idempotencyKey: record.idempotencyKey, command: record.command, data: { evidenceEventIds: evidence.map((event) => event.id), reconciledAt } });
    return { record: { ...record, replayed: true }, mirrorRoot: record.storageRoot && path.resolve(record.storageRoot) !== root ? record.storageRoot : undefined };
  });
  // 镜像账本必须在释放当前项目锁后更新，避免两个互为 storageRoot 的
  // 对账操作形成反向锁序。
  if (reconciled.mirrorRoot) await mirrorLedgerRecord(reconciled.mirrorRoot, reconciled.record);
  return revokePersistedImagegenCallCapability(reconciled.record);
}

export async function listCommandLedger(projectRoot: string, limit = 100): Promise<IdempotentCommandResult[]> {
  return ((await listCommandLedgerEntries(projectRoot, Math.max(1, Math.min(limit, 500)))) as IdempotentCommandResult[])
    .map(revokePersistedImagegenCallCapability);
}
