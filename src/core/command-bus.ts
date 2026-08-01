import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
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
  getSidecarPaths,
  readJson,
  withActiveProjectActivationFence,
  writeJsonAtomic,
} from "./sidecar.js";
import {
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
import { isStudioCommandName, parseStudioCommandRequestForCore } from "./studio-command-runtime.js";
import { ensureConfinedDirectory } from "./confined-project-storage.js";
import { commitProjectImport } from "./importer.js";
import type { EditProject, ProjectConfig, ProjectImportMode, StoryboardRowUpsertInput } from "./types.js";
import { runWithOperationContext } from "./operation-context.js";
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
import { executeNextNovelAnalysisRunTask, executeNovelAnalysisTask, planNovelAnalysisRun, replaceNovelAnalysisRunTask, upsertNovelAnalysisProvider } from "./novel-analysis-provider.js";
import { isConfirmedCommandFailure, isRejectedCommandFailure, RejectedCommandFailure } from "./command-outcome.js";
import { isSqliteBusyError, sqliteBusyDetailMessage, withSqliteBusyRetry, STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS } from "./studio-sqlite-busy.js";
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
import {
  appendStudioAssetRelation,
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  initializeMaterialStudio,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  updateStudioCanonicalAsset,
  type AppendStudioAssetVersionInput,
  type AppendStudioAssetRelationInput,
  type CreateStudioCanonicalAssetInput,
  type ImportStudioMediaInput,
  type ReviewStudioAssetVersionInput,
  type SetStudioPrimaryAuthorityInput,
  type UpdateStudioCanonicalAssetInput,
} from "./material-studio.js";
import {
  exportStudioCrossProjectAssetPackage,
  importStudioCrossProjectAssetPackage,
  type ExportStudioCrossProjectAssetPackageInput,
  type ImportStudioCrossProjectAssetPackageInput,
} from "./studio-cross-project-asset-reuse.js";
import { inspectManagedProject, isManagedProject } from "./managed-project.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptSectionRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
  proveStudioScriptSectionRevisionAppend,
  reviseStudioProductionUnit,
  StudioProductionConflictError,
  StudioScriptSectionLineageError,
  type AppendStudioScriptSectionRevisionInput,
  type AppendStudioTextRevisionInput,
  type CreateStudioProductionUnitInput,
  type CreateStudioPromptDocumentInput,
  type CreateStudioScriptDocumentInput,
  type ReviseStudioProductionUnitInput,
  type StudioBindingOperationCommand,
} from "./studio-production.js";
import {
  analyzeStudioScriptEntities,
  confirmStudioPanelEmptyFromControl,
  freezeStudioAssetBindingSetFromControl,
  proveStudioBindingOperationOutcome,
  resolveStudioEntityProposal,
  StudioBindingControlError,
  type StudioBindingAnalyzeInput,
  type StudioBindingConfirmEmptyInput,
  type StudioBindingFreezeInput,
  type StudioBindingResolveInput,
} from "./studio-binding-control.js";
import { StudioGenerationFreezeError, type StudioGenerationQueryInput } from "./studio-generation.js";
import {
  abandonStudioDetachedGenerationUnknown,
  abandonStudioGenerationUnknown,
  authorizeStudioUnitGridContinuationWaiver,
  cancelStudioGenerationRun,
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  getStudioGenerationPlanProjection,
  listStudioGenerationPlanProjections,
  prepareStudioImagegenCall,
  readStudioImagegenCallContextRebindByRun,
  readAnyStudioGenerationFrozenPack,
  readPersistedStudioGenerationPack,
  readStudioImagegenCallEventHistory,
  readStudioImagegenCallIntentByRun,
  readStudioDetachedGenerationUnknownDisposition,
  readStudioGenerationPlanNodeEventHistory,
  readStudioGenerationRunEventHistory,
  reconcileStudioImagegenCall,
  rebindStudioImagegenCallContext,
  registerStudioGenerationResult,
  retryStudioGenerationPlanNodes,
  sameStudioGenerationUnknownOwnerAbandonDetail,
  studioImagegenContextTokenHash,
  StudioGenerationLedgerError,
  StudioGenerationResultConflictError,
  type AbandonStudioGenerationUnknownInput,
  type AbandonStudioDetachedGenerationUnknownInput,
  type AuthorizeStudioUnitGridContinuationWaiverInput,
  type DispatchStudioGenerationPackInput,
  type PrepareStudioImagegenCallInput,
  type RebindStudioImagegenCallContextInput,
  type ReconcileStudioImagegenCallInput,
  type RegisterStudioGenerationResultInput,
  type StudioGenerationPlanNodeInput,
} from "./studio-generation-ledger.js";
import type { StudioUnitGridGenerationQueryInput } from "./studio-unit-grid-generation.js";
import {
  appendStudioContinuityCorrection,
  appendStudioContinuityObservation,
  readStudioContinuityOperationReceipt,
  type AppendStudioContinuityCorrectionInput,
  type AppendStudioContinuityObservationInput,
} from "./studio-continuity-ledger.js";
import {
  readStudioGenerationReviewOperationOutcome,
  submitStudioGenerationReview,
  type SubmitStudioGenerationReviewInput,
} from "./studio-generation-review.js";
import {
  proveStudioPostResultObservationOutcome,
  submitStudioPostResultObservation,
  type SubmitStudioPostResultObservationInput,
} from "./studio-post-result-observation.js";
import {
  attestStudioGenerationCheckpoint,
  readStudioGenerationCheckpointOperationReceipt,
  refreshStudioGenerationCheckpoint,
  type AttestStudioGenerationCheckpointInput,
  type RefreshStudioGenerationCheckpointInput,
} from "./studio-generation-checkpoint.js";
import {
  commitAgentImagegenResultBundle,
  proveAgentImagegenResultBundleOutcome,
  StudioAgentImagegenBundleError,
  type CommitAgentImagegenResultBundleInput,
} from "./studio-agent-imagegen-result-bundle.js";
import { StudioLabeledLayoutError } from "./studio-labeled-layout.js";
import {
  ActiveManagedStudioContextError,
  assertActiveManagedStudioContextToken,
} from "./active-managed-studio-context.js";
import {
  DuduReadonlyControlConflictError,
  discoverDuduReadonlyImportProjects,
  finalizeDuduReadonlyManagedProject,
  getDuduReadonlyImportControl,
  reconcileDuduReadonlyHistoricalPasses,
  proveDuduReadonlyFinalizationOutcome,
  proveDuduReadonlyStageCommandOutcome,
  resolveDuduReadonlyImportCommandRoot,
  stageDuduReadonlyManagedProject,
  summarizeDuduReadonlyStageResult,
  type StageDuduReadonlyManagedProjectInput,
} from "./dudu-readonly-import.js";
import type { DuduReadonlySourceInput } from "./dudu-readonly-source.js";
import {
  buildAndVerifyStudioVideoPackage,
  getStudioVideoPackageControl,
  prepareStudioVideoPackageExport,
  readStudioVideoPackageExportIntentByOperationId,
  StudioVideoPackageError,
  type StudioVideoPackageAuthorityInput,
  type StudioVideoPackageExpectedManagedSource,
} from "./studio-video-package.js";
import {
  attachStudioMultimediaTimelineMedia,
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

export type CommandRequest =
  | { command: "scan_project"; payload: Record<string, never> }
  | { command: "stage_dudu_readonly_managed_project"; payload: StageDuduReadonlyManagedProjectCommandPayload }
  | { command: "reconcile_dudu_readonly_historical_passes"; payload: ReconcileDuduReadonlyHistoricalPassesCommandPayload }
  | { command: "initialize_material_studio"; payload: Record<string, never> }
  | { command: "import_studio_media"; payload: ImportStudioMediaInput }
  | { command: "create_studio_asset"; payload: CreateStudioCanonicalAssetInput }
  | { command: "update_studio_asset"; payload: UpdateStudioCanonicalAssetInput }
  | { command: "append_studio_asset_relation"; payload: AppendStudioAssetRelationInput }
  | { command: "append_studio_asset_version"; payload: AppendStudioAssetVersionInput }
  | { command: "review_studio_asset_version"; payload: ReviewStudioAssetVersionInput }
  | { command: "set_studio_primary_authority"; payload: SetStudioPrimaryAuthorityInput }
  | { command: "export_studio_cross_project_asset_package"; payload: ExportStudioCrossProjectAssetPackageInput }
  | { command: "import_studio_cross_project_asset_package"; payload: ImportStudioCrossProjectAssetPackageInput }
  | { command: "initialize_studio_production"; payload: Record<string, never> }
  | { command: "create_studio_script_document"; payload: CreateStudioScriptDocumentInput }
  | { command: "create_studio_prompt_document"; payload: CreateStudioPromptDocumentInput }
  | { command: "append_studio_script_revision"; payload: AppendStudioTextRevisionInput }
  | { command: "append_studio_script_section_revision"; payload: AppendStudioScriptSectionRevisionInput }
  | { command: "append_studio_prompt_revision"; payload: AppendStudioTextRevisionInput }
  | { command: "create_studio_production_unit"; payload: CreateStudioProductionUnitInput }
  | { command: "revise_studio_production_unit"; payload: ReviseStudioProductionUnitInput }
  | { command: "materialize_local_creative_production_units"; payload: MaterializeLocalCreativeProductionUnitsCommandPayload }
  | { command: "analyze_studio_script_entities"; payload: StudioBindingAnalyzeInput }
  | { command: "resolve_studio_entity_proposal"; payload: StudioBindingResolveInput }
  | { command: "confirm_studio_panel_empty"; payload: StudioBindingConfirmEmptyInput }
  | { command: "freeze_studio_asset_binding_set"; payload: StudioBindingFreezeInput }
  | { command: "freeze_studio_generation_pack"; payload: (StudioGenerationQueryInput | StudioUnitGridGenerationQueryInput) & { expectedRevision: number } }
  | { command: "dispatch_studio_generation_pack"; payload: DispatchStudioGenerationPackInput & { expectedRevision: number } }
  | { command: "register_studio_generation_result"; payload: RegisterStudioGenerationResultInput & { expectedRevision: number } }
  | { command: "authorize_studio_unit_grid_continuation_waiver"; payload: AuthorizeStudioUnitGridContinuationWaiverCommandPayload }
  | { command: "prepare_studio_imagegen_call"; payload: PrepareStudioImagegenCallCommandPayload }
  | { command: "reconcile_studio_imagegen_call"; payload: ReconcileStudioImagegenCallCommandPayload }
  | { command: "abandon_studio_generation_unknown"; payload: AbandonStudioGenerationUnknownCommandPayload }
  | { command: "abandon_studio_detached_generation_unknown"; payload: AbandonStudioDetachedGenerationUnknownCommandPayload }
  | { command: "rebind_studio_imagegen_call_context"; payload: RebindStudioImagegenCallContextCommandPayload }
  | { command: "commit_agent_imagegen_result_bundle"; payload: CommitAgentImagegenResultBundleInput }
  | { command: "create_studio_generation_plan"; payload: { nodes: StudioGenerationPlanNodeInput[] } }
  | { command: "fail_studio_generation_run"; payload: { generationRunId: string; errorClass: string; detail?: string } }
  | { command: "cancel_studio_generation_run"; payload: { generationRunId: string; reason?: string } }
  | { command: "retry_studio_generation_plan_nodes"; payload: { planId: string; nodeIndexes?: number[] } }
  | { command: "append_studio_continuity_observation"; payload: AppendStudioContinuityObservationCommandPayload }
  | { command: "append_studio_continuity_correction"; payload: AppendStudioContinuityCorrectionCommandPayload }
  | { command: "submit_studio_generation_review"; payload: SubmitStudioGenerationReviewCommandPayload }
  | { command: "submit_studio_post_result_observation"; payload: SubmitStudioPostResultObservationCommandPayload }
  | { command: "refresh_studio_generation_checkpoint"; payload: RefreshStudioGenerationCheckpointCommandPayload }
  | { command: "attest_studio_generation_checkpoint"; payload: AttestStudioGenerationCheckpointCommandPayload }
  | { command: "finalize_dudu_readonly_managed_project"; payload: FinalizeDuduReadonlyManagedProjectCommandPayload }
  | { command: "prepare_studio_video_package_export"; payload: PrepareStudioVideoPackageExportCommandPayload }
  | { command: "build_studio_video_package"; payload: BuildStudioVideoPackageCommandPayload }
  | { command: "attach_studio_multimedia_timeline_media"; payload: AttachStudioMultimediaTimelineMediaCommandPayload }
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
  command:
    | "initialize_material_studio"
    | "import_studio_media"
    | "create_studio_asset"
    | "update_studio_asset"
    | "append_studio_asset_relation"
    | "append_studio_asset_version"
    | "review_studio_asset_version"
    | "set_studio_primary_authority"
    | "export_studio_cross_project_asset_package"
    | "import_studio_cross_project_asset_package"
    | "initialize_studio_production"
    | "create_studio_script_document"
    | "create_studio_prompt_document"
    | "append_studio_script_revision"
    | "append_studio_script_section_revision"
    | "append_studio_prompt_revision"
    | "create_studio_production_unit"
    | "revise_studio_production_unit"
    | "materialize_local_creative_production_units"
    | "analyze_studio_script_entities"
    | "resolve_studio_entity_proposal"
    | "confirm_studio_panel_empty"
    | "freeze_studio_asset_binding_set"
    | "freeze_studio_generation_pack"
    | "dispatch_studio_generation_pack"
    | "register_studio_generation_result"
    | "authorize_studio_unit_grid_continuation_waiver"
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
    | "finalize_dudu_readonly_managed_project"
    | "reconcile_dudu_readonly_historical_passes"
    | "prepare_studio_video_package_export"
    | "build_studio_video_package";
}>;

/**
 * Studio 写面的唯一命令分类器。Main、MCP 与渲染层不得再维护平行 allowlist，
 * 否则新增命令会出现“Core 可执行、桌面端被误拒绝”的路由漂移。
 */
export function isStudioCommandRequest(request: CommandRequest): request is StudioCommandRequest {
  return isStudioCommandName(request.command);
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
  storageRoot?: string;
  result?: unknown;
  // busyUncommitted：SQLite 瞬时锁导致的失败且事务确认未提交（busy 只可能在
  // COMMIT 成功前抛出），允许同一 idempotencyKey 受控重试；attempts/retryBudgetMs
  // 记录已用受控重试次数与预算，供审计与分类。
  error?: { message: string; observedAt: string; busyUncommitted?: boolean; attempts?: number; retryBudgetMs?: number };
  startedAt: string;
  executedAt?: string;
}

type DurableReconciliationCommandRequest = Extract<CommandRequest,
  { command:
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
  source: "dudu_readonly_import_receipts" | "local_creative_production_unit_receipts" | "studio_video_package_ledger" | "studio_multimedia_timeline_bindings" | "fusion-storyboard-sheet-store" | "fusion-storyboard-sheet-migration-candidate-fingerprint" | "canonical-asset-store" | "studio_script_section_revisions" | "studio_binding_operation_receipts" | "studio_continuity_operation_receipts" | "studio_generation_review_operation_receipts" | "studio_post_result_observation_operation_receipts" | "studio_generation_checkpoint_operation_receipts" | "studio_agent_imagegen_writeback_receipts" | "studio_generation_plan_run_ledger" | "studio_generation_call_ledger" | "studio_generation_detached_disposition_ledger";
  identity: Record<string, unknown>;
  result: unknown;
}

const DURABLE_RECONCILIATION_COMMAND_NAMES = new Set<DurableReconciliationCommandRequest["command"]>([
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
  if (record.command !== "prepare_studio_imagegen_call"
    || !record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
    return { ...record };
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

function revokeImagegenCallCapabilityFromResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return {
    ...(result as Record<string, unknown>),
    callAllowed: false,
    idempotentReplay: true,
  };
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

function commandRequestHash(projectRoot: string, request: CommandRequest): string {
  return createHash("sha256").update(stable({ projectRoot: path.resolve(projectRoot), request })).digest("hex");
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

function rejectStudioScriptSectionConflict(error: unknown): never {
  if (error instanceof StudioProductionConflictError) {
    throw new RejectedCommandFailure(error.message, {
      schemaVersion: 1,
      applied: false,
      entityType: "studio_script_section",
      entityId: error.entityId,
      sectionId: error.entityId,
      reason: "revision_conflict",
      expectedRevision: error.expectedRevision,
      currentRevision: error.actualRevision,
    });
  }
  if (error instanceof StudioScriptSectionLineageError) {
    throw new RejectedCommandFailure(error.message, {
      schemaVersion: 1,
      applied: false,
      entityType: "studio_script_section",
      entityId: error.sectionId,
      sectionId: error.sectionId,
      reason: "lineage_conflict",
      invariant: error.invariant,
      expectedValue: error.expectedValue,
      actualValue: error.actualValue,
    });
  }
  throw error;
}

function isDurableReconciliationCommand(request: CommandRequest): request is DurableReconciliationCommandRequest {
  return DURABLE_RECONCILIATION_COMMAND_NAMES.has(request.command as DurableReconciliationCommandRequest["command"]);
}

function durableReconciliationSnapshot(request: CommandRequest): DurableCommandReconciliationSnapshot | undefined {
  return isDurableReconciliationCommand(request)
    ? { schemaVersion: 1, request: structuredClone(request) }
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

async function proveDurableOutcome(projectRoot: string, request: DurableReconciliationCommandRequest): Promise<DurableCommandProof | undefined> {
  try {
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

function deterministicStudioTimelineRejection(
  request: Extract<CommandRequest, { command: "attach_studio_multimedia_timeline_media" }>,
): string | undefined {
  if (request.payload.role === "storyboard" && request.payload.panelIndex === undefined) {
    return "storyboard 绑定必须显式提供 panelIndex。";
  }
  return undefined;
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
  let proof = await proveDurableOutcome(root, input.request);
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

function rejectStudioBindingPrecondition(
  error: unknown,
  input: { unitId: string; panelId: string; expectedRevisionToken: string },
): never {
  if (isRejectedCommandFailure(error)) throw error;
  if (!(error instanceof StudioBindingControlError) && !(error instanceof StudioProductionConflictError)) throw error;
  const code = error instanceof StudioBindingControlError ? error.code : "revision-conflict";
  throw new RejectedCommandFailure(error.message, {
    schemaVersion: 1,
    applied: false,
    entityType: "studio_asset_binding",
    reason: code,
    unitId: input.unitId,
    panelId: input.panelId,
    expectedRevisionToken: input.expectedRevisionToken,
  });
}

type StudioGenerationCommandEntity = "studio_generation_pack" | "studio_generation_dispatch" | "studio_generation_call" | "studio_generation_result" | "studio_generation_result_bundle" | "studio_generation_plan" | "studio_generation_run";

function rejectStudioGenerationCommand(input: {
  entityType: StudioGenerationCommandEntity;
  reason: string;
  message: string;
  code?: string;
  unitId?: string;
  panelId?: string;
  packId?: string;
  expectedRevision?: unknown;
  currentRevision?: number;
}): never {
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    applied: false,
    entityType: input.entityType,
    reason: input.reason,
  };
  if (input.code !== undefined) result.code = input.code;
  if (input.unitId !== undefined) result.unitId = input.unitId;
  if (input.panelId !== undefined) result.panelId = input.panelId;
  if (input.packId !== undefined) result.packId = input.packId;
  if (input.expectedRevision !== undefined) result.expectedRevision = input.expectedRevision;
  if (input.currentRevision !== undefined) result.currentRevision = input.currentRevision;
  throw new RejectedCommandFailure(input.message, result);
}

function assertStudioGenerationExpectedRevision(
  entityType: StudioGenerationCommandEntity,
  expectedRevision: unknown,
  context: { unitId?: string; panelId?: string; packId?: string },
): asserts expectedRevision is number {
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    rejectStudioGenerationCommand({
      entityType,
      reason: "invalid_revision",
      message: "Studio generation expectedRevision 必须是正整数。",
      expectedRevision,
      ...context,
    });
  }
}

function isStudioUnitGridGenerationQuery(
  input: StudioGenerationQueryInput | StudioUnitGridGenerationQueryInput,
): input is StudioUnitGridGenerationQueryInput {
  return (input as { targetKind?: unknown }).targetKind === "unit-grid";
}

async function assertStudioGenerationUnitRevision(input: {
  projectRoot: string;
  entityType: StudioGenerationCommandEntity;
  unitId: string;
  panelId?: string;
  packId?: string;
  expectedRevision: number;
}): Promise<void> {
  const snapshot = await getStudioProductionUnitSnapshot(input.projectRoot, input.unitId);
  if (!snapshot) {
    rejectStudioGenerationCommand({
      entityType: input.entityType,
      reason: "not_found",
      message: `15 秒生产单元不存在：${input.unitId}`,
      unitId: input.unitId,
      panelId: input.panelId,
      packId: input.packId,
      expectedRevision: input.expectedRevision,
    });
  }
  if (snapshot.unit.revision !== input.expectedRevision) {
    rejectStudioGenerationCommand({
      entityType: input.entityType,
      reason: "revision_conflict",
      message: `生产单元 ${input.unitId} 已被其他窗口更新（当前 revision ${snapshot.unit.revision}），请重新冻结。`,
      unitId: input.unitId,
      panelId: input.panelId,
      packId: input.packId,
      expectedRevision: input.expectedRevision,
      currentRevision: snapshot.unit.revision,
    });
  }
}

function rejectStudioGenerationPrecondition(
  error: unknown,
  entityType: StudioGenerationCommandEntity,
  context: { unitId?: string; panelId?: string; packId?: string; expectedRevision?: number },
): never {
  if (isRejectedCommandFailure(error)) throw error;
  if (!(error instanceof StudioGenerationFreezeError) && !(error instanceof StudioGenerationLedgerError)) throw error;
  const code = error.code;
  const storageFailure = code === "storage-invalid"
    || code === "pack-cas-drift"
    || code === "result-media-drift"
    || code === "media-drift";
  const reason = storageFailure
    ? undefined
    : error instanceof StudioGenerationResultConflictError
      ? "result_conflict"
      : code === "unit-not-found" || code === "panel-not-found" || code === "pack-not-found"
        ? "not_found"
        : code.includes("conflict") || code.includes("drift")
          ? "revision_conflict"
          : "validation_failed";
  // 存储或实测 SHA 损坏的提交结果不能被误记为安全的写前拒绝。
  if (!reason) throw error;
  rejectStudioGenerationCommand({
    entityType,
    reason,
    code,
    message: error.message,
    ...context,
  });
}

function rejectStudioAgentImagegenBundlePrecondition(
  error: unknown,
  context: { packId: string; expectedRevision: number },
): never {
  if (isRejectedCommandFailure(error)) throw error;
  if (error instanceof StudioGenerationFreezeError || error instanceof StudioGenerationLedgerError) {
    rejectStudioGenerationPrecondition(error, "studio_generation_result_bundle", context);
  }
  if (error instanceof ActiveManagedStudioContextError) {
    rejectStudioGenerationCommand({
      entityType: "studio_generation_result_bundle",
      reason: "project_context_conflict",
      code: error.code,
      message: error.message,
      ...context,
    });
  }
  if (error instanceof StudioAgentImagegenBundleError) {
    const conflict = error.code === "pack-conflict"
      || error.code === "provider-mismatch"
      || error.code === "result-conflict"
      || error.code === "receipt-drift"
      || error.code === "labeled-conflict";
    rejectStudioGenerationCommand({
      entityType: "studio_generation_result_bundle",
      reason: conflict ? "revision_conflict" : "validation_failed",
      code: error.code,
      message: error.message,
      ...context,
    });
  }
  // labeled 在 CAS/media/ledger 任一写入前先以内存渲染；其校验、解码或渲染错误
  // 均是已确认的写前失败，不能锁成 OUTCOME_UNKNOWN。
  if (error instanceof StudioLabeledLayoutError) {
    rejectStudioGenerationCommand({
      entityType: "studio_generation_result_bundle",
      reason: "validation_failed",
      code: `labeled-${error.code}`,
      message: error.message,
      ...context,
    });
  }
  throw error;
}

function rejectP30OrchestrationCommand(input: {
  entityType: "dudu_readonly_import" | "studio_video_package";
  reason: "invalid_revision" | "revision_conflict" | "control_conflict" | "validation_failed";
  message: string;
  expectedRevision?: number;
  currentRevision?: number;
  expectedFingerprint?: string;
  currentFingerprint?: string;
}): never {
  throw new RejectedCommandFailure(input.message, {
    schemaVersion: 1,
    applied: false,
    ...input,
  });
}

async function execute(projectRoot: string, request: CommandRequest, options: Pick<PersistedScanOptions, "signal" | "onProgress"> = {}): Promise<unknown> {
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
    case "initialize_material_studio": {
      await inspectManagedProject(projectRoot);
      return initializeMaterialStudio(projectRoot);
    }
    case "import_studio_media": {
      await inspectManagedProject(projectRoot);
      const media = await importStudioMedia(projectRoot, request.payload);
      return {
        sha256: media.sha256,
        kind: media.kind,
        sizeBytes: media.sizeBytes,
        mimeType: media.mimeType,
        sourceBasename: media.sourceBasename,
        derivativeStatus: media.derivativeStatus,
        thumbnail: media.thumbnail ? {
          recipe: media.thumbnail.recipe,
          recipeKey: media.thumbnail.recipeKey,
          width: media.thumbnail.width,
          height: media.thumbnail.height,
          format: media.thumbnail.format,
        } : undefined,
        createdAt: media.createdAt,
      };
    }
    case "attach_studio_multimedia_timeline_media": {
      await inspectManagedProject(projectRoot);
      const deterministicRejection = deterministicStudioTimelineRejection(request);
      if (deterministicRejection) {
        throw new RejectedCommandFailure(deterministicRejection, {
          code: "INVALID_STORYBOARD_TIMELINE_BINDING",
          committed: false,
        });
      }
      try {
        return await attachStudioMultimediaTimelineMedia(projectRoot, {
          ...request.payload,
          operationId: commandRequestHash(projectRoot, request),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/^(?:媒体时码越出(?:单元范围| panel \d+ 的范围)|storyboard 绑定必须显式提供 panelIndex)/u.test(message)) {
          throw new RejectedCommandFailure(message, {
            code: "INVALID_STUDIO_TIMELINE_RANGE",
            committed: false,
          });
        }
        throw error;
      }
    }
    case "create_studio_asset": {
      await inspectManagedProject(projectRoot);
      return createStudioCanonicalAsset(projectRoot, request.payload);
    }
    case "update_studio_asset": {
      await inspectManagedProject(projectRoot);
      return updateStudioCanonicalAsset(projectRoot, request.payload);
    }
    case "append_studio_asset_relation": {
      await inspectManagedProject(projectRoot);
      return appendStudioAssetRelation(projectRoot, request.payload);
    }
    case "append_studio_asset_version": {
      await inspectManagedProject(projectRoot);
      return appendStudioAssetVersion(projectRoot, request.payload);
    }
    case "review_studio_asset_version": {
      await inspectManagedProject(projectRoot);
      return reviewStudioAssetVersion(projectRoot, request.payload);
    }
    case "set_studio_primary_authority": {
      await inspectManagedProject(projectRoot);
      return setStudioPrimaryAuthority(projectRoot, request.payload);
    }
    case "export_studio_cross_project_asset_package": {
      await inspectManagedProject(projectRoot);
      return exportStudioCrossProjectAssetPackage(projectRoot, request.payload);
    }
    case "import_studio_cross_project_asset_package": {
      await inspectManagedProject(projectRoot);
      return importStudioCrossProjectAssetPackage(projectRoot, request.payload);
    }
    case "initialize_studio_production": {
      await inspectManagedProject(projectRoot);
      return initializeStudioProduction(projectRoot);
    }
    case "create_studio_script_document": {
      await inspectManagedProject(projectRoot);
      return createStudioScriptDocument(projectRoot, request.payload);
    }
    case "create_studio_prompt_document": {
      await inspectManagedProject(projectRoot);
      return createStudioPromptDocument(projectRoot, request.payload);
    }
    case "append_studio_script_revision": {
      await inspectManagedProject(projectRoot);
      return appendStudioScriptRevision(projectRoot, request.payload);
    }
    case "append_studio_script_section_revision": {
      await inspectManagedProject(projectRoot);
      try {
        return await appendStudioScriptSectionRevision(projectRoot, request.payload);
      } catch (error) {
        rejectStudioScriptSectionConflict(error);
      }
    }
    case "append_studio_prompt_revision": {
      await inspectManagedProject(projectRoot);
      return appendStudioPromptRevision(projectRoot, request.payload);
    }
    case "create_studio_production_unit": {
      await inspectManagedProject(projectRoot);
      return createStudioProductionUnit(projectRoot, request.payload);
    }
    case "revise_studio_production_unit": {
      await inspectManagedProject(projectRoot);
      try {
        return await reviseStudioProductionUnit(projectRoot, request.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof StudioProductionConflictError
          || /生产单元宫格总时长必须严格等于声明时长|宫格时间.+(?:空洞|重叠)|起止时间与时长不一致|durationSeconds 必须大于 0|宫格 id 重复|重复提及资产|禁止携带 sourceSpans|必须提供至少一条非空 sourceSpans|extension (?:不得作为首格|仅允许作为单元末尾)/u.test(message)) {
          throw new RejectedCommandFailure(message, {
            schemaVersion: 1,
            applied: false,
            entityType: "studio_production_unit",
            reason: error instanceof StudioProductionConflictError ? "revision_conflict" : "validation_failed",
            unitId: request.payload.unitId,
            expectedRevision: request.payload.expectedRevision,
            ...(error instanceof StudioProductionConflictError
              ? { currentRevision: error.actualRevision }
              : {}),
          });
        }
        throw error;
      }
    }
    case "materialize_local_creative_production_units": {
      await inspectManagedProject(projectRoot);
      return materializeLocalCreativeProductionUnits(projectRoot, {
        ...request.payload,
        idempotencyKey: commandRequestHash(projectRoot, request),
      });
    }
    case "analyze_studio_script_entities": {
      await inspectManagedProject(projectRoot);
      try {
        return await analyzeStudioScriptEntities(projectRoot, request.payload, {
          requestHash: commandRequestHash(projectRoot, request),
          reviewer: "codex",
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "resolve_studio_entity_proposal": {
      await inspectManagedProject(projectRoot);
      try {
        return await resolveStudioEntityProposal(projectRoot, request.payload, {
          requestHash: commandRequestHash(projectRoot, request),
          reviewer: request.payload.reviewer,
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "confirm_studio_panel_empty": {
      await inspectManagedProject(projectRoot);
      try {
        return await confirmStudioPanelEmptyFromControl(projectRoot, request.payload, {
          requestHash: commandRequestHash(projectRoot, request),
          reviewer: request.payload.reviewer,
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "freeze_studio_asset_binding_set": {
      await inspectManagedProject(projectRoot);
      try {
        return await freezeStudioAssetBindingSetFromControl(projectRoot, request.payload, {
          requestHash: commandRequestHash(projectRoot, request),
          reviewer: "codex",
        });
      } catch (error) {
        rejectStudioBindingPrecondition(error, request.payload);
      }
    }
    case "freeze_studio_generation_pack": {
      await inspectManagedProject(projectRoot);
      const { expectedRevision, ...query } = request.payload;
      assertStudioGenerationExpectedRevision("studio_generation_pack", expectedRevision, query);
      if (isStudioUnitGridGenerationQuery(query)) {
        await assertStudioGenerationUnitRevision({
          projectRoot,
          entityType: "studio_generation_pack",
          unitId: query.unitId,
          expectedRevision,
        });
        try {
          return await freezeAndPersistStudioUnitGridGenerationPack(projectRoot, query);
        } catch (error) {
          rejectStudioGenerationPrecondition(error, "studio_generation_pack", {
            unitId: query.unitId,
            expectedRevision,
          });
        }
      }
      await assertStudioGenerationUnitRevision({
        projectRoot,
        entityType: "studio_generation_pack",
        unitId: query.unitId,
        panelId: query.panelId,
        expectedRevision,
      });
      try {
        // pack.target.unitRevision 锚定目标宫格 BindingSet 的历史修订；同单元其他宫格
        // 的无关修订不会改变该目标身份，因此不能把两者强行等同。
        // pack 是 Codex 本地生成所需的显式冻结数据；账本数据库和 pack CAS 路径不进入命令结果。
        return await freezeAndPersistStudioGenerationPack(projectRoot, query);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_pack", {
          unitId: query.unitId,
          panelId: query.panelId,
          expectedRevision,
        });
      }
    }
    case "dispatch_studio_generation_pack": {
      await inspectManagedProject(projectRoot);
      const { expectedRevision, ...dispatch } = request.payload;
      assertStudioGenerationExpectedRevision("studio_generation_dispatch", expectedRevision, { packId: dispatch.packId });
      try {
        const pack = await readAnyStudioGenerationFrozenPack(projectRoot, dispatch.packId);
        if (!pack) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_dispatch",
            reason: "not_found",
            message: `持久冻结包不存在：${dispatch.packId}`,
            packId: dispatch.packId,
            expectedRevision,
          });
        }
        if (pack.fingerprint !== dispatch.packFingerprint) {
          const panelId = pack.schemaVersion === 5 ? undefined : pack.target.panelId;
          rejectStudioGenerationCommand({
            entityType: "studio_generation_dispatch",
            reason: "revision_conflict",
            code: "pack-index-conflict",
            message: `packId ${dispatch.packId} 与 packFingerprint 不匹配。`,
            unitId: pack.target.unitId,
            ...(panelId ? { panelId } : {}),
            packId: dispatch.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        if (pack.target.unitRevision !== expectedRevision) {
          const panelId = pack.schemaVersion === 5 ? undefined : pack.target.panelId;
          rejectStudioGenerationCommand({
            entityType: "studio_generation_dispatch",
            reason: "revision_conflict",
            code: "pack-drift",
            message: `冻结包 ${dispatch.packId} 属于 unit revision ${pack.target.unitRevision}，与 expectedRevision ${expectedRevision} 不一致。`,
            unitId: pack.target.unitId,
            ...(panelId ? { panelId } : {}),
            packId: dispatch.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        return await dispatchStudioGenerationPack(projectRoot, dispatch);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_dispatch", {
          packId: dispatch.packId,
          expectedRevision,
        });
      }
    }
    case "prepare_studio_imagegen_call": {
      await inspectManagedProject(projectRoot);
      try {
        // pre-call 是唯一模型调用授权闸。与活动工程切换共享跨工程 fence，确保
        // token 首检、异步门禁、quarantine 准备和 call intent 落盘属于同一 activation。
        return await withActiveProjectActivationFence(async () => {
          await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
          return prepareStudioImagegenCall(projectRoot, {
            ...request.payload,
            commandRequestId: commandRequestHash(projectRoot, request),
          });
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            packId: request.payload.packId,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          packId: request.payload.packId,
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "authorize_studio_unit_grid_continuation_waiver": {
      await inspectManagedProject(projectRoot);
      try {
        return await authorizeStudioUnitGridContinuationWaiver(projectRoot, request.payload);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_pack",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            unitId: request.payload.unitId,
            expectedRevision: request.payload.expectedUnitRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_pack", {
          unitId: request.payload.unitId,
          expectedRevision: request.payload.expectedUnitRevision,
        });
      }
    }
    case "reconcile_studio_imagegen_call": {
      await inspectManagedProject(projectRoot);
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio imagegen call reconcile expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...reconciliation } = request.payload;
      try {
        await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
        return await reconcileStudioImagegenCall(projectRoot, reconciliation);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {});
      }
    }
    case "abandon_studio_generation_unknown": {
      await inspectManagedProject(projectRoot);
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio generation_unknown owner abandon expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...abandonment } = request.payload;
      try {
        await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
        return await abandonStudioGenerationUnknown(projectRoot, abandonment);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "abandon_studio_detached_generation_unknown": {
      await inspectManagedProject(projectRoot);
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio detached generation_unknown owner abandon expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...abandonment } = request.payload;
      try {
        const activeContext = await assertActiveManagedStudioContextToken(
          projectRoot,
          request.payload.projectContextToken,
        );
        return await abandonStudioDetachedGenerationUnknown(projectRoot, {
          ...abandonment,
          activeContext: {
            projectId: activeContext.projectId,
            manifestFingerprint: activeContext.manifestFingerprint,
            buildId: activeContext.build.buildId,
            sourceDigest: activeContext.build.sourceDigest,
          },
        });
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "rebind_studio_imagegen_call_context": {
      await inspectManagedProject(projectRoot);
      if (request.payload.expectedRevision !== 0) {
        rejectStudioGenerationCommand({
          entityType: "studio_generation_call",
          reason: "invalid_revision",
          message: "Studio imagegen context rebind expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      const { expectedRevision: _expectedRevision, ...rebind } = request.payload;
      try {
        await assertActiveManagedStudioContextToken(projectRoot, request.payload.projectContextToken);
        return await rebindStudioImagegenCallContext(projectRoot, rebind);
      } catch (error) {
        if (error instanceof ActiveManagedStudioContextError) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_call",
            reason: "project_context_conflict",
            code: error.code,
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        rejectStudioGenerationPrecondition(error, "studio_generation_call", {
          expectedRevision: request.payload.expectedRevision,
        });
      }
    }
    case "register_studio_generation_result": {
      await inspectManagedProject(projectRoot);
      const { expectedRevision, ...registration } = request.payload;
      assertStudioGenerationExpectedRevision("studio_generation_result", expectedRevision, { packId: registration.packId });
      try {
        const pack = await readPersistedStudioGenerationPack(projectRoot, registration.packId);
        if (!pack) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_result",
            reason: "not_found",
            message: `持久冻结包不存在：${registration.packId}`,
            packId: registration.packId,
            expectedRevision,
          });
        }
        if (pack.fingerprint !== registration.packFingerprint) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_result",
            reason: "revision_conflict",
            code: "pack-index-conflict",
            message: `packId ${registration.packId} 与 packFingerprint 不匹配。`,
            unitId: pack.target.unitId,
            panelId: pack.target.panelId,
            packId: registration.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        if (pack.target.unitRevision !== expectedRevision) {
          rejectStudioGenerationCommand({
            entityType: "studio_generation_result",
            reason: "revision_conflict",
            code: "pack-drift",
            message: `冻结包 ${registration.packId} 属于 unit revision ${pack.target.unitRevision}，与 expectedRevision ${expectedRevision} 不一致。`,
            unitId: pack.target.unitId,
            panelId: pack.target.panelId,
            packId: registration.packId,
            expectedRevision,
            currentRevision: pack.target.unitRevision,
          });
        }
        return await registerStudioGenerationResult(projectRoot, registration);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_result", {
          packId: registration.packId,
          expectedRevision,
        });
      }
    }
    case "commit_agent_imagegen_result_bundle": {
      await inspectManagedProject(projectRoot);
      const { packId, expectedRevision } = request.payload;
      assertStudioGenerationExpectedRevision(
        "studio_generation_result_bundle",
        expectedRevision,
        { packId },
      );
      try {
        return await commitAgentImagegenResultBundle(projectRoot, request.payload);
      } catch (error) {
        rejectStudioAgentImagegenBundlePrecondition(error, { packId, expectedRevision });
      }
    }
    case "create_studio_generation_plan": {
      await inspectManagedProject(projectRoot);
      try {
        return await createStudioGenerationPlan(projectRoot, {
          nodes: request.payload.nodes,
          sourceCommandRequestId: commandRequestHash(projectRoot, request),
        });
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_plan", {});
      }
    }
    case "fail_studio_generation_run": {
      await inspectManagedProject(projectRoot);
      try {
        return await failStudioGenerationRun(projectRoot, request.payload);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_run", {});
      }
    }
    case "cancel_studio_generation_run": {
      await inspectManagedProject(projectRoot);
      try {
        return await cancelStudioGenerationRun(projectRoot, request.payload);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_run", {});
      }
    }
    case "retry_studio_generation_plan_nodes": {
      await inspectManagedProject(projectRoot);
      try {
        return await retryStudioGenerationPlanNodes(projectRoot, request.payload);
      } catch (error) {
        rejectStudioGenerationPrecondition(error, "studio_generation_plan", {});
      }
    }
    case "append_studio_continuity_observation": {
      await inspectManagedProject(projectRoot);
      return appendStudioContinuityObservation(projectRoot, {
        ...request.payload,
        operationId: commandRequestHash(projectRoot, request),
      });
    }
    case "append_studio_continuity_correction": {
      await inspectManagedProject(projectRoot);
      return appendStudioContinuityCorrection(projectRoot, {
        ...request.payload,
        operationId: commandRequestHash(projectRoot, request),
      });
    }
    case "submit_studio_generation_review": {
      await inspectManagedProject(projectRoot);
      return submitStudioGenerationReview(projectRoot, {
        ...request.payload,
        operationId: commandRequestHash(projectRoot, request),
      });
    }
    case "submit_studio_post_result_observation": {
      await inspectManagedProject(projectRoot);
      return submitStudioPostResultObservation(projectRoot, {
        ...request.payload,
        operationId: commandRequestHash(projectRoot, request),
      });
    }
    case "refresh_studio_generation_checkpoint": {
      await inspectManagedProject(projectRoot);
      return refreshStudioGenerationCheckpoint(projectRoot, {
        ...request.payload,
        operationId: commandRequestHash(projectRoot, request),
      });
    }
    case "attest_studio_generation_checkpoint": {
      await inspectManagedProject(projectRoot);
      return attestStudioGenerationCheckpoint(projectRoot, {
        ...request.payload,
        operationId: commandRequestHash(projectRoot, request),
      });
    }
    case "finalize_dudu_readonly_managed_project": {
      await inspectManagedProject(projectRoot);
      const discovery = await discoverDuduReadonlyImportProjects(path.dirname(projectRoot));
      if (discovery.fingerprint !== request.payload.expectedDiscoveryFingerprint
        || discovery.status !== "single"
        || discovery.candidates.length !== 1
        || discovery.candidates[0]!.projectRoot !== path.resolve(projectRoot)) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu finalize discovery 已变化或存在多候选，禁止选择第一个。",
          expectedFingerprint: request.payload.expectedDiscoveryFingerprint,
          currentFingerprint: discovery.fingerprint,
        });
      }
      const control = await getDuduReadonlyImportControl(projectRoot);
      if (request.payload.expectedRevision !== 0) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "invalid_revision",
          message: "Dudu finalize expectedRevision 必须为 0。",
          expectedRevision: request.payload.expectedRevision,
        });
      }
      if (control.fingerprint !== request.payload.expectedControlFingerprint
        || control.identity.importReceiptFingerprint !== request.payload.expectedImportFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu finalize control/import 身份已变化，请重新读取只读控制面。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      return finalizeDuduReadonlyManagedProject(projectRoot, request.payload.source, {
        commandRequestHash: commandRequestHash(projectRoot, request),
      });
    }
    case "reconcile_dudu_readonly_historical_passes": {
      await inspectManagedProject(projectRoot);
      const control = await getDuduReadonlyImportControl(projectRoot);
      if (request.payload.expectedRevision !== 0 || control.status !== "active"
        || control.fingerprint !== request.payload.expectedControlFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "dudu_readonly_import",
          reason: "control_conflict",
          message: "Dudu 历史 PASS 回填控制面已变化或并非 active，禁止写入。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      return reconcileDuduReadonlyHistoricalPasses(projectRoot, request.payload.source);
    }
    case "prepare_studio_video_package_export": {
      await inspectManagedProject(projectRoot);
      const control = await getStudioVideoPackageControl(projectRoot, {
        by: "authority-latest",
        authority: request.payload.authority,
      });
      if (control.fingerprint !== request.payload.expectedControlFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 authority 控制面已变化，请重新读取后再 prepare。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      if (control.status === "conflict" || control.nextAction === "resolve-video-package-ledger-conflict") {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 authority 存在目的地或换代链冲突，禁止 prepare 并选择任一候选。",
          expectedFingerprint: request.payload.expectedControlFingerprint,
          currentFingerprint: control.fingerprint,
        });
      }
      try {
        return await prepareStudioVideoPackageExport(projectRoot, {
          operationId: commandRequestHash(projectRoot, request),
          authority: request.payload.authority,
          expectedRevision: request.payload.expectedRevision,
          ...(request.payload.expectedManagedSource
            ? { expectedManagedSource: request.payload.expectedManagedSource }
            : {}),
        });
      } catch (error) {
        if (error instanceof StudioVideoPackageError) {
          rejectP30OrchestrationCommand({
            entityType: "studio_video_package",
            reason: error.code === "operation-conflict" ? "revision_conflict" : "validation_failed",
            message: error.message,
            expectedRevision: request.payload.expectedRevision,
          });
        }
        throw error;
      }
    }
    case "build_studio_video_package": {
      await inspectManagedProject(projectRoot);
      const intentLookup = await getStudioVideoPackageControl(projectRoot, {
        by: "intent",
        intentId: request.payload.intentId,
      });
      if (intentLookup.fingerprint !== request.payload.expectedIntentControlFingerprint) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 intent 控制面已变化，请重新读取后再 build。",
          expectedFingerprint: request.payload.expectedIntentControlFingerprint,
          currentFingerprint: intentLookup.fingerprint,
        });
      }
      const intent = intentLookup.control?.intent;
      if (!intent || intent.intentId !== request.payload.intentId) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 intent 控制面未解析到唯一 intent。",
        });
      }
      if (intent.unitRevision !== request.payload.expectedRevision) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "revision_conflict",
          message: "视频包 intent unit revision 已变化，请刷新后再 build。",
          expectedRevision: request.payload.expectedRevision,
          currentRevision: intent.unitRevision,
        });
      }
      const authority: StudioVideoPackageAuthorityInput = intent.authorityKind === "historical-import"
        ? { kind: "historical-import", packId: intent.packId }
        : { kind: "studio-review", reviewId: intent.authorityId };
      const authorityLookup = await getStudioVideoPackageControl(projectRoot, {
        by: "authority-latest",
        authority,
      });
      if (authorityLookup.fingerprint !== request.payload.expectedAuthorityControlFingerprint
        || authorityLookup.status !== "resolved"
        || authorityLookup.selectedIntentId !== intent.intentId
        || authorityLookup.selectedIsDestinationHead !== true
        || authorityLookup.control?.intent.intentId !== intent.intentId) {
        rejectP30OrchestrationCommand({
          entityType: "studio_video_package",
          reason: "control_conflict",
          message: "视频包 intent 已不是 authority-latest/destination head，拒绝 build。",
          expectedFingerprint: request.payload.expectedAuthorityControlFingerprint,
          currentFingerprint: authorityLookup.fingerprint,
        });
      }
      return buildAndVerifyStudioVideoPackage(projectRoot, request.payload.intentId, {
        expectedRevision: request.payload.expectedRevision,
        destinationPolicy: request.payload.destinationPolicy,
        commandRequestHash: commandRequestHash(projectRoot, request),
      });
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

export async function executeIdempotentCommand(projectRoot: string, input: IdempotentCommandInput, options: {
  storageRoot?: string;
  waitForRunningMs?: number;
  signal?: AbortSignal;
  onProgress?: PersistedScanOptions["onProgress"];
  /** 跨代理写租约：有租约时生图相关写命令必须匹配 */
  writeLeaseHolderId?: string;
  writeLeaseToken?: string;
} = {}): Promise<IdempotentCommandResult> {
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
  assertStudioBindingPublicPayload(input.request);
  assertStudioScriptSectionPublicPayload(input.request);
  assertStudioContinuityReviewPublicPayload(input.request);
  assertP30OrchestrationPublicPayload(input.request);
  const root = path.resolve(projectRoot);
  const studioCommand = isStudioCommandRequest(input.request);
  const duduBootstrapCommand = input.request.command === "stage_dudu_readonly_managed_project";
  const managedProject = await isManagedProject(root);
  if (managedProject && !studioCommand) {
    throw new Error(`受管素材工程拒绝旧命令 ${input.request.command}；请使用素材中心专用命令，避免扫描或写入平行事实源。`);
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
  }
  const storageRoot = path.resolve(options.storageRoot ?? root);
  if (studioCommand && path.resolve(storageRoot) !== root) {
    throw new Error("受管素材工程禁止隐式跨根 command storageRoot；写入口必须固定 projectRoot。");
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
  const registration = await withProjectLock(storageRoot, "command-bus", async (): Promise<{ action: "execute"; record: IdempotentCommandResult } | { action: "replay"; record: IdempotentCommandResult } | { action: "recover"; record: IdempotentCommandResult } | { action: "wait" }> => {
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
            execution: { pid: process.pid, phase: "registered", heartbeatAt: restartedAt },
            startedAt: restartedAt,
          };
          await persistCommandLedgerEntry(storageRoot, record, restartedAt);
          await appendEvent(storageRoot, { actor: "codex", type: "command.started", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, projectRoot: root, retryAfterBusyUncommitted: true } });
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
    const record: IdempotentCommandResult = { schemaVersion: 1, requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, status: "running", replayed: false, requestHash, execution: { pid: process.pid, phase: "registered", heartbeatAt: startedAt }, durableReconciliation: durableReconciliationSnapshot(input.request), storageRoot: storageRoot !== root ? storageRoot : undefined, startedAt };
    await persistCommandLedgerEntry(storageRoot, record, startedAt);
    await appendEvent(storageRoot, { actor: "codex", type: "command.started", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, projectRoot: root } });
    return { action: "execute", record };
  });
  if (registration.action === "replay") return registration.record;
  if (registration.action === "recover") {
    const recovered = isDurableReconciliationCommand(input.request)
      ? await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: registration.record, request: input.request, replayRequestId: input.requestId })
      : undefined;
    if (recovered) return revokePersistedImagegenCallCapability(recovered);
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
      if (current.status === "succeeded") return { ...current, requestId: input.requestId, replayed: true };
      if (current.status === "failed") {
        if (isDurableReconciliationCommand(input.request) && current.execution?.phase === "side_effect_committed") {
          const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: current, request: input.request, replayRequestId: input.requestId });
          if (recovered) return recovered;
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
          if (recovered) return recovered;
        }
        throw new Error(`命令 ${current.command} 的执行结果为 unknown；禁止自动重放。请先读取命令账本和真实文件进行结果对账。`);
      }
      if (isDurableReconciliationCommand(input.request) && current.status === "running" && !processAlive(current.execution?.pid)) {
        const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot, record: current, request: input.request, replayRequestId: input.requestId });
        if (recovered) return recovered;
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

  record.execution = { pid: process.pid, phase: "executing", heartbeatAt: new Date().toISOString() };
  await persistRecord();
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
  let executeReturned = false;
  try {
    if (process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND === input.request.command) {
      await wait(Math.max(0, Math.min(5_000, Number(process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS) || 0)), signal);
    }
    const runCommand = () => runWithOperationContext(
      { requestId: input.requestId, idempotencyKey: input.idempotencyKey, requestHash, command: input.request.command },
      () => {
        // 测试注入：前 N 次执行抛 SQLITE_BUSY（errcode=5），模拟事务前/提交期瞬时写锁。
        if (process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND === input.request.command) {
          const busyKey = `${input.request.command}:${input.idempotencyKey}`;
          const injected = testBusyExecuteAttempts.get(busyKey) ?? 0;
          const injectTimes = Math.max(0, Math.min(12, Number(process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES) || 0));
          if (injected < injectTimes) {
            testBusyExecuteAttempts.set(busyKey, injected + 1);
            throw Object.assign(new Error("database is locked"), { errcode: 5 });
          }
        }
        return execute(root, input.request, { signal, onProgress: options.onProgress });
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
        : runCommand;
    // SQLITE_BUSY/SQLITE_LOCKED 只可能在 COMMIT 成功前抛出，即抛出该错误的事务确认
    // 未提交；仅在此未提交窗口内做有界指数退避（≤3 次、总预算 ≤5s）。重试沿用同一
    // requestId/idempotencyKey 的 running 账本记录，不产生重复派发或新账本键；
    // execute 返回后（副作用已提交）的 busy 不再重试，走 outcome_unknown 对账。
    const result = await withSqliteBusyRetry(executeOnce, {
      onAttempt: (attempt) => { busyAttempts = attempt; },
      sleep: (milliseconds) => wait(milliseconds, signal),
    });
    executeReturned = true;
    await stopHeartbeat();
    if (process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT === input.request.command) throw new Error("TEST_ONLY_CRASH_BEFORE_COMMIT_EVENT");
    const persistedResult = input.request.command === "prepare_studio_imagegen_call"
      ? revokeImagegenCallCapabilityFromResult(result)
      : result;
    const resultDigest = createHash("sha256").update(stable(persistedResult)).digest("hex");
    record.execution = { pid: process.pid, phase: "side_effect_committed", heartbeatAt: new Date().toISOString() };
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
    if (input.request.command === "prepare_studio_imagegen_call"
      && result && typeof result === "object" && !Array.isArray(result)
      && (result as { callAllowed?: unknown }).callAllowed === true) {
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
      if (stored.status === "succeeded") return { ...stored, replayed: true };
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      await appendEvent(storageRoot, { actor: "codex", type: "command.cancelled", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: record.error.message, projectRoot: root, committed: false } });
      throw cancellation;
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
        ? await proveDurableOutcome(root, input.request)
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
        return stored;
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
    if (isSqliteBusyError(error) && !executeReturned) {
      // busy 只可能在 COMMIT 成功前抛出：抛出该错误的事务确认未提交（连接关闭即回滚）。
      // 标记 failed(busyUncommitted) 而非 unknown——调用方可用同一 idempotencyKey
      // 受控重试（登记分支已放行）；重试次数与预算留账，MCP 侧分类 RESOURCE_BUSY。
      // execute 已返回后的 busy（executeReturned=true）落入下方 unknown 对账路径。
      // AggregateError（withFileLock 临界区与释放双失败）取首个 busy 成员文案，
      // 保证下方抛出与账本留存的 message 稳定命中 RESOURCE_BUSY 文本分类。
      const busyMessage = sqliteBusyDetailMessage(error);
      record.status = "failed";
      record.result = undefined;
      record.error = { message: busyMessage, observedAt, busyUncommitted: true, attempts: Math.max(1, busyAttempts), retryBudgetMs: STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS };
      record.executedAt = observedAt;
      const stored = await persistRecord();
      if (stored.status === "succeeded") return { ...stored, replayed: true };
      if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
      await appendEvent(storageRoot, { actor: "codex", type: "command.failed", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: busyMessage, projectRoot: root, committed: false, busyUncommitted: true, attempts: Math.max(1, busyAttempts) } });
      throw new Error(`数据库瞬时锁在 ${Math.max(1, busyAttempts)} 次受控重试（预算 ${STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS}ms）后仍未释放（command=${input.request.command}，事务未提交）：${busyMessage}`);
    }
    record.status = "unknown";
    record.error = { message: error instanceof Error ? error.message : String(error), observedAt };
    record.executedAt = observedAt;
    const stored = await persistRecord();
    if (stored.status === "succeeded") return { ...stored, replayed: true };
    if (storageRoot !== root) await mirrorLedgerRecord(root, stored);
    await appendEvent(storageRoot, { actor: "codex", type: "command.outcome-unknown", requestId: input.requestId, idempotencyKey: input.idempotencyKey, command: input.request.command, data: { requestHash, error: record.error.message, projectRoot: root } });
    throw new Error(`命令执行结果未确认，已锁定幂等键防止重复副作用：${record.error.message}`);
  }
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
  if (durableRequest
    && (durableCandidate.status === "unknown"
      || durableCandidate.status === "running"
      || (durableCandidate.status === "failed" && durableCandidate.execution?.phase === "side_effect_committed"))) {
    const durableStorageRoot = durableCandidate.storageRoot && path.resolve(durableCandidate.storageRoot) !== root
      ? path.resolve(durableCandidate.storageRoot)
      : root;
    const recovered = await recoverCommandFromDurableState({ projectRoot: root, storageRoot: durableStorageRoot, record: durableCandidate, request: durableRequest });
    if (recovered) return recovered;
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
