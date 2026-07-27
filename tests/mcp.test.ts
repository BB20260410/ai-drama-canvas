import path from "node:path";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

function payload(result: unknown): unknown {
  const content = (result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined;
  const parsed = JSON.parse(content?.find((entry) => entry.type === "text")?.text ?? "{}") as { status?: string; result?: unknown };
  return parsed.status === "succeeded" && "result" in parsed ? parsed.result : parsed;
}

describe("stdio MCP", () => {
  it("暴露生产与第二阶段工具且不监听网络端口", async () => {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-runtime-"));
    const importRoot = path.join(runtimeRoot, "project");
    await mkdir(importRoot, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd,
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-canvas-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        [
          "acquire_studio_project_write_lease",
          "analyze_adaptation_impact",
          "analyze_change_impact",
          "analyze_novel_chapters",
          "apply_edit_operation",
          "audit_fusion_panel_references",
          "audit_fusion_visual_constraints",
          "build_fusion_reference_board",
          "build_fusion_storyboard_grid",
          "build_story_context",
          "cancel_edit_render",
          "cancel_generation_job",
          "cancel_publication",
          "cancel_task",
          "claim_task",
          "commit_existing_production_recovery",
          "commit_project_import",
          "connect_story_events",
          "create_edit_project",
          "create_handoff",
          "create_novel_analysis_task",
          "create_shot_task_pack",
          "create_task_pack",
          "create_video_continuation",
          "delete_canvas_entity",
          "delete_canvas_link",
          "delete_context",
          "discover_dudu_readonly_import_projects",
          "doctor_project",
          "enqueue_generation",
          "evaluate_studio_fusion_helper",
          "execute_command",
          "execute_next_novel_analysis_run_task",
          "execute_novel_analysis_task",
          "execute_studio_shot_compose_local",
          "export_adaptation",
          "export_edit_otio",
          "extract_last_frame",
          "extract_timeline_frame",
          "fail_publication",
          "finish_batch",
          "generate_adaptation_plans",
          "get_active_managed_studio_context",
          "get_adaptation_workspace",
          "get_browser_generation_plan",
          "get_canonical_asset",
          "get_canonical_asset_catalog_state",
          "get_canvas_state",
          "get_capabilities",
          "get_continuation",
          "get_continuity_spans",
          "get_dudu_readonly_import_control",
          "get_edit_history_info",
          "get_edit_project",
          "get_edit_render_job",
          "get_fusion_asset_consistency",
          "get_fusion_panel_reference_resolution",
          "get_fusion_storyboard_sheet_state",
          "get_fusion_visual_constraint",
          "get_generation_provider",
          "get_generation_settings",
          "get_item",
          "get_local_creative_project_ingest_status",
          "get_managed_studio_overview",
          "get_next_task",
          "get_novel_analysis_providers",
          "get_novel_analysis_runs",
          "get_production_workflow",
          "get_progress",
          "get_project_snapshot",
          "get_review_queue",
          "get_storyboard",
          "get_studio_asset",
          "get_studio_binding_control",
          "get_studio_consistency_evaluation",
          "get_studio_continuity_review_control",
          "get_studio_episode_earliest",
          "get_studio_generation_control",
          "get_studio_generation_unknown_disposition",
          "get_studio_multimedia_timeline",
          "get_studio_production_dashboard",
          "get_studio_production_projection_bundle",
          "get_studio_production_unit_snapshot",
          "get_studio_project_write_lease",
          "get_studio_script_library_projection",
          "get_studio_text_revision",
          "get_studio_trace",
          "get_studio_video_package_control",
          "get_subagent_image_generation_plan",
          "get_unit_timelines",
          "heartbeat_studio_project_write_lease",
          "heartbeat_task",
          "import_edit_otio",
          "import_story_file",
          "import_story_text",
          "inspect_fusion_package",
          "list_asset_relations",
          "list_canonical_assets",
          "list_command_ledger",
          "list_context",
          "list_continuity_tracks",
          "list_creative_bibles",
          "list_derived_panel_reference_assets",
          "list_edit_media",
          "list_edit_projects",
          "list_edit_render_jobs",
          "list_fusion_panel_reference_resolutions",
          "list_fusion_production_assets",
          "list_fusion_storyboard_sheets",
          "list_fusion_visual_constraints",
          "list_generation_jobs",
          "list_novel_analysis_reviews",
          "list_projects",
          "list_publications",
          "list_reviews",
          "list_script_documents",
          "list_skills",
          "list_story_chapters",
          "list_story_events",
          "list_story_sources",
          "list_studio_assets",
          "list_studio_media",
          "list_studio_media_import_origins",
          "list_studio_production_units",
          "list_studio_text_documents",
          "list_timeline_frames",
          "list_video_continuations",
          "list_voice_identities",
          "materialize_adaptation_plan",
          "materialize_fusion_panel_references",
          "materialize_fusion_project",
          "materialize_fusion_visual_constraints",
          "migrate_fusion_storyboard_sheets",
          "plan_novel_analysis_run",
          "preflight_publication",
          "prepare_edit_media_preview",
          "prepare_edit_media_proxy",
          "prepare_fusion_asset_consistency_review",
          "prepare_timeline_continuation",
          "preview_existing_production_recovery",
          "preview_local_creative_production_units",
          "preview_project_import",
          "preview_scan_project",
          "probe_novel_analysis_provider",
          "probe_video_engine",
          "process_generation_queue",
          "promote_asset_to_hard_lock",
          "query_studio_asset_timeline",
          "read_script_document",
          "read_skill",
          "read_story_chapter",
          "reconcile_command",
          "reconcile_http_generation_submission",
          "redo_canvas",
          "redo_edit_project",
          "regenerate_adaptation_scope",
          "register_artifact",
          "register_derived_panel_reference_artifact",
          "register_publication",
          "release_studio_project_write_lease",
          "release_task",
          "render_fusion_storyboard_sheet",
          "replace_novel_analysis_run_task",
          "review_novel_analysis_batch",
          "review_novel_analysis_item",
          "save_edit_project",
          "save_script_document",
          "save_skill",
          "save_unit_timeline",
          "scan_project",
          "seal_final_fusion_asset_consistency_batch",
          "search_context",
          "select_adaptation_plan",
          "set_authoritative_artifact",
          "start_edit_render",
          "submit_fusion_asset_consistency_review",
          "submit_novel_analysis_proposal",
          "submit_review",
          "suggest_studio_storyboard_draft",
          "undo_canvas",
          "undo_edit_project",
          "update_browser_generation_job",
          "update_production_workflow_stage",
          "update_status",
          "update_subagent_image_generation_job",
          "update_video_continuation",
          "upsert_asset_relation",
          "upsert_canvas_entity",
          "upsert_canvas_link",
          "upsert_context",
          "upsert_creative_bible",
          "upsert_fusion_visual_constraint_override",
          "upsert_generation_provider",
          "upsert_narrative_beat",
          "upsert_novel_analysis_provider",
          "upsert_novel_fact",
          "upsert_panel_reference_override",
          "upsert_story_event",
          "upsert_storyboard_row",
          "upsert_voice_identity",
          "validate_adaptation_plan",
          "verify_item",
        ],
      );
      const localProductionPreviewTool = tools.tools.find(
        (tool) => tool.name === "preview_local_creative_production_units",
      );
      expect(localProductionPreviewTool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      const localProductionPreviewSchema = localProductionPreviewTool?.inputSchema as {
        required?: string[];
        properties?: Record<string, {
          type?: string;
          minLength?: number;
          maxLength?: number;
          enum?: string[];
          default?: unknown;
          pattern?: string;
        }>;
      };
      expect(localProductionPreviewSchema.required).toContain("projectRoot");
      expect(localProductionPreviewSchema.properties).toEqual(expect.objectContaining({
        projectRoot: expect.anything(),
        scopeId: expect.objectContaining({ type: "string", minLength: 1, maxLength: 200 }),
        adapterKind: expect.objectContaining({
          enum: ["auto", "dudu-world-prologue-v1"],
          default: "auto",
        }),
        expectedSourceFingerprint: expect.objectContaining({
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        }),
      }));
      const submitReviewSchema = tools.tools.find((tool) => tool.name === "submit_review")?.inputSchema as {
        properties?: {
          annotations?: {
            type?: string;
            maxItems?: number;
            items?: { properties?: Record<string, { enum?: string[]; minimum?: number; maximum?: number }> };
          };
        };
      };
      expect(submitReviewSchema.properties?.annotations).toEqual(expect.objectContaining({ type: "array", maxItems: 100 }));
      const annotationProperties = submitReviewSchema.properties?.annotations?.items?.properties;
      expect(annotationProperties?.artifactId).toBeDefined();
      expect(annotationProperties?.type?.enum).toEqual(["issue", "keep", "question", "continuity"]);
      expect(annotationProperties?.x).toEqual(expect.objectContaining({ minimum: 0, maximum: 1 }));
      expect(annotationProperties?.y).toEqual(expect.objectContaining({ minimum: 0, maximum: 1 }));
      expect(annotationProperties?.timeSeconds).toEqual(expect.objectContaining({ minimum: 0 }));
      const browserUpdateSchema = tools.tools.find((tool) => tool.name === "update_browser_generation_job")?.inputSchema as { properties?: Record<string, { type?: string; minimum?: number; enum?: string[]; properties?: Record<string, unknown> }> };
      expect(browserUpdateSchema.properties?.expectedRevision).toEqual(expect.objectContaining({ type: "integer", exclusiveMinimum: 0 }));
      expect(browserUpdateSchema.properties?.requestId).toBeDefined();
      expect(browserUpdateSchema.properties?.idempotencyKey).toBeDefined();
      expect(browserUpdateSchema.properties?.uploadEvidence?.properties).toHaveProperty("files");
      expect(browserUpdateSchema.properties?.status?.enum).toContain("submit_intent");
      expect(browserUpdateSchema.properties?.status?.enum).toContain("preflight_blocked");
      expect(browserUpdateSchema.properties?.preflightEvidence?.properties).toEqual(expect.objectContaining({ blockers: expect.anything(), observedGeneration: expect.anything() }));
      expect(browserUpdateSchema.properties?.submissionReconciliation?.properties).toEqual(expect.objectContaining({ method: expect.anything(), result: expect.anything(), note: expect.anything() }));
      const subagentUpdateSchema = tools.tools.find((tool) => tool.name === "update_subagent_image_generation_job")?.inputSchema as { properties?: Record<string, { type?: string; enum?: string[] }> };
      expect(subagentUpdateSchema.properties).toEqual(expect.objectContaining({ expectedRevision: expect.anything(), status: expect.anything(), targetProviderId: expect.anything(), agentTaskName: expect.anything(), owner: expect.anything(), agentRunId: expect.anything(), runId: expect.anything(), callId: expect.anything(), leaseId: expect.anything(), fence: expect.anything(), leaseSeconds: expect.anything(), generatedPath: expect.anything(), reviewer: expect.anything(), reconciliationResult: expect.anything(), confirmNoInvocation: expect.anything(), evidenceReference: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(subagentUpdateSchema.properties?.status?.enum).toEqual(["migrate_plan", "migrate_execution_state", "claim", "heartbeat", "takeover", "release", "start_call", "generated", "visual_accept", "visual_rejected", "reconcile_unknown", "failed"]);
      const listGenerationSchema = tools.tools.find((tool) => tool.name === "list_generation_jobs")?.inputSchema as { properties?: Record<string, { enum?: string[] }> };
      expect(listGenerationSchema.properties?.status?.enum).toEqual(["queued", "submitting", "submission_unknown", "waiting_external", "waiting_remote", "generating", "generation_unknown", "candidate_generated", "visual_rejected", "succeeded", "failed", "cancelled"]);
      const httpReconciliationSchema = tools.tools.find((tool) => tool.name === "reconcile_http_generation_submission")?.inputSchema as { properties?: Record<string, { anyOf?: unknown[]; oneOf?: unknown[] }>; required?: string[] };
      expect(httpReconciliationSchema.properties).toEqual(expect.objectContaining({ jobId: expect.anything(), expectedRevision: expect.anything(), reconciliation: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(httpReconciliationSchema.required).toEqual(expect.arrayContaining(["jobId", "expectedRevision", "reconciliation", "requestId", "idempotencyKey"]));
      const storyboardSchema = tools.tools.find((tool) => tool.name === "upsert_storyboard_row")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(storyboardSchema.properties).toEqual(expect.objectContaining({ cameraAngle: expect.anything(), lens: expect.anything(), composition: expect.anything(), staging: expect.anything(), eyeline: expect.anything(), axisSide: expect.anything(), referenceArtifactIds: expect.anything(), upstreamFactRefs: expect.anything(), sourceSpans: expect.anything(), continuityNotes: expect.anything() }));
      expect(storyboardSchema.required).not.toEqual(expect.arrayContaining(["itemId", "referencePaths"]));
      const recoveryPreviewSchema = tools.tools.find((tool) => tool.name === "preview_existing_production_recovery")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(recoveryPreviewSchema.required).toEqual(expect.arrayContaining(["itemIds", "allowedTargets", "contracts"]));
      expect(recoveryPreviewSchema.properties).not.toHaveProperty("requestId");
      const recoveryCommitSchema = tools.tools.find((tool) => tool.name === "commit_existing_production_recovery")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(recoveryCommitSchema.required).toEqual(expect.arrayContaining(["previewId", "expectedWorkflowRevision", "requestId", "idempotencyKey"]));
      const executeCommandSchema = tools.tools.find((tool) => tool.name === "execute_command")?.inputSchema as { properties?: { request?: { anyOf?: Array<{ properties?: { command?: { const?: string } } }>; oneOf?: Array<{ properties?: { command?: { const?: string } } }> } } };
      const commandVariants = executeCommandSchema.properties?.request?.anyOf ?? executeCommandSchema.properties?.request?.oneOf ?? [];
      const commandNames = commandVariants.map((variant) => variant.properties?.command?.const).filter(Boolean);
      expect(commandNames).toEqual(expect.arrayContaining(["review_novel_analysis_batch", "upsert_novel_analysis_provider", "execute_novel_analysis_task", "reconcile_http_generation_submission", "update_subagent_image_generation", "migrate_generation_execution_state", "preflight_publication_bundle", "register_publication_bundle", "cancel_publication_bundle", "fail_publication_bundle", "commit_existing_production_recovery", "freeze_studio_generation_pack", "dispatch_studio_generation_pack", "register_studio_generation_result", "build_fusion_storyboard_grid", "materialize_fusion_panel_references", "materialize_fusion_visual_constraints", "upsert_fusion_visual_constraint_override", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "migrate_fusion_storyboard_evidence", "migrate_fusion_storyboard_sheets", "prepare_fusion_asset_consistency_review", "submit_fusion_asset_consistency_review", "seal_final_fusion_asset_consistency_batch"]));
      const commandVariant = (name: string) => commandVariants.find((variant) => variant.properties?.command?.const === name) as { properties?: { payload?: { properties?: Record<string, { enum?: string[] }>; required?: string[] } } } | undefined;
      const enqueuePayload = commandVariant("enqueue_generation")?.properties?.payload;
      expect(enqueuePayload?.properties).toHaveProperty("continuation");
      expect(enqueuePayload?.properties).toHaveProperty("fusionStoryboardPanel");
      const submitReviewPayload = commandVariant("submit_review")?.properties?.payload;
      expect(submitReviewPayload?.properties).toEqual(expect.objectContaining({ expectedScanId: expect.anything(), expectedArtifactHashes: expect.anything(), expectedRequirementId: expect.anything() }));
      expect(submitReviewPayload?.required).toEqual(expect.arrayContaining(["expectedScanId", "expectedArtifactHashes"]));
      const continuationUpdatePayload = commandVariant("update_video_continuation")?.properties?.payload;
      expect(continuationUpdatePayload?.required).toEqual(expect.arrayContaining(["continuationId", "expectedRevision", "status", "error"]));
      expect(continuationUpdatePayload?.properties?.status?.enum).toEqual(["failed", "cancelled"]);
      const enqueueToolSchema = tools.tools.find((tool) => tool.name === "enqueue_generation")?.inputSchema as { properties?: Record<string, unknown> };
      expect(enqueueToolSchema.properties).toHaveProperty("continuation");
      expect(enqueueToolSchema.properties).toHaveProperty("fusionStoryboardPanel");
      const gridToolSchema = tools.tools.find((tool) => tool.name === "build_fusion_storyboard_grid")?.inputSchema as { properties?: Record<string, unknown> };
      expect(gridToolSchema.properties).toEqual(expect.objectContaining({ itemId: expect.anything(), override: expect.anything(), referenceOverride: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      const panelReferenceMaterializeSchema = tools.tools.find((tool) => tool.name === "materialize_fusion_panel_references")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(panelReferenceMaterializeSchema.properties).toEqual(expect.objectContaining({ projectRoot: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      const panelReferenceOverrideSchema = tools.tools.find((tool) => tool.name === "upsert_panel_reference_override")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(panelReferenceOverrideSchema.properties).toEqual(expect.objectContaining({ contractId: expect.anything(), panelId: expect.anything(), expectedResolutionId: expect.anything(), expectedStoreRevision: expect.anything(), includeAssetIds: expect.anything(), excludeAssetIds: expect.anything(), reason: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      const visualConstraintMaterializeSchema = tools.tools.find((tool) => tool.name === "materialize_fusion_visual_constraints")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(visualConstraintMaterializeSchema.properties).toEqual(expect.objectContaining({ projectRoot: expect.anything(), expectedStoreRevision: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(visualConstraintMaterializeSchema.required).toEqual(expect.arrayContaining(["expectedStoreRevision", "requestId", "idempotencyKey"]));
      const visualConstraintOverrideSchema = tools.tools.find((tool) => tool.name === "upsert_fusion_visual_constraint_override")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(visualConstraintOverrideSchema.properties).toEqual(expect.objectContaining({ projectRoot: expect.anything(), override: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(visualConstraintOverrideSchema.required).toEqual(expect.arrayContaining(["override", "requestId", "idempotencyKey"]));
      const visualConstraintListSchema = tools.tools.find((tool) => tool.name === "list_fusion_visual_constraints")?.inputSchema as { properties?: Record<string, { maximum?: number; enum?: string[] }> };
      expect(visualConstraintListSchema.properties?.limit?.maximum).toBe(50);
      expect(visualConstraintListSchema.properties?.warningCode?.enum).toEqual(expect.arrayContaining(["AHANG_IDENTITY", "DUDU_MARKINGS", "HIDDEN_MASK_DISCLOSURE", "OCR_OR_TEXT", "WATERMARK_OR_UI", "MODERN_OBJECT", "COLLAGE_OR_SPLIT", "PROP_STRUCTURE", "SCENE_LAYOUT", "EXTRA_CHARACTER", "AMBIGUOUS_VISIBILITY", "SPATIAL_LOCK_UNKNOWN"]));
      const derivedArtifactSchema = tools.tools.find((tool) => tool.name === "register_derived_panel_reference_artifact")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(derivedArtifactSchema.properties).toEqual(expect.objectContaining({ derivedAssetId: expect.anything(), expectedStoreRevision: expect.anything(), expectedVersion: expect.anything(), filePath: expect.anything(), expectedSha256: expect.anything(), reviewer: expect.anything(), reviewNote: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      const sheetMigrationSchema = tools.tools.find((tool) => tool.name === "migrate_fusion_storyboard_sheets")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(sheetMigrationSchema.properties).toEqual(expect.objectContaining({ projectRoot: expect.anything(), expectedStoreRevision: expect.anything(), expectedCandidateFingerprint: expect.anything(), itemIds: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(sheetMigrationSchema.required).toEqual(expect.arrayContaining(["projectRoot", "expectedStoreRevision", "expectedCandidateFingerprint", "requestId", "idempotencyKey"]));
      expect(sheetMigrationSchema.required).not.toContain("itemIds");
      const sheetToolSchema = tools.tools.find((tool) => tool.name === "render_fusion_storyboard_sheet")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(sheetToolSchema.properties).toEqual(expect.objectContaining({ itemId: expect.anything(), contractId: expect.anything(), expectedInputFingerprint: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(sheetToolSchema.required).toEqual(expect.arrayContaining(["expectedInputFingerprint"]));
      const consistencyToolSchema = tools.tools.find((tool) => tool.name === "submit_fusion_asset_consistency_review")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(consistencyToolSchema.properties).toEqual(expect.objectContaining({ batchId: expect.anything(), expectedRevision: expect.anything(), expectedSnapshotHash: expect.anything(), decision: expect.anything(), criteria: expect.anything(), requestId: expect.anything(), idempotencyKey: expect.anything() }));
      expect(consistencyToolSchema.required).toEqual(expect.arrayContaining(["batchId", "expectedRevision", "expectedSnapshotHash", "decision", "criteria", "requestId", "idempotencyKey"]));
      const continuationToolSchema = tools.tools.find((tool) => tool.name === "update_video_continuation")?.inputSchema as { properties?: Record<string, { enum?: string[] }>; required?: string[] };
      expect(continuationToolSchema.required).toEqual(expect.arrayContaining(["expectedRevision", "error"]));
      expect(continuationToolSchema.properties?.status?.enum).toEqual(["failed", "cancelled"]);
      const capabilitiesResult = await client.callTool({ name: "get_capabilities", arguments: {} });
      expect(payload(capabilitiesResult)).toEqual(expect.objectContaining({
        server: expect.objectContaining({ transport: "stdio", toolCount: EXPECTED_MCP_TOOL_COUNT }),
        principles: expect.objectContaining({ neverOverwriteAuthoritative: true }),
        domains: expect.objectContaining({ managedStudio: expect.arrayContaining(["get_active_managed_studio_context", "get_studio_generation_control"]), fusionProduction: expect.arrayContaining(["materialize_fusion_panel_references", "audit_fusion_panel_references", "list_fusion_panel_reference_resolutions", "get_fusion_panel_reference_resolution", "list_derived_panel_reference_assets", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "materialize_fusion_visual_constraints", "audit_fusion_visual_constraints", "list_fusion_visual_constraints", "get_fusion_visual_constraint", "upsert_fusion_visual_constraint_override", "get_fusion_storyboard_sheet_state", "list_fusion_storyboard_sheets", "migrate_fusion_storyboard_sheets"]) }),
        managedStudio: expect.objectContaining({
          generationControl: expect.objectContaining({
            tool: "get_studio_generation_control",
            operations: ["session-snapshot", "readiness", "pack", "history", "plan", "call", "active-runs", "detached-unknown"],
            directWriteTools: false,
            writes: "execute_command-only",
            targetKinds: ["panel", "unit-grid"],
            writeCommands: ["freeze_studio_generation_pack", "dispatch_studio_generation_pack", "prepare_studio_imagegen_call", "reconcile_studio_imagegen_call", "abandon_studio_generation_unknown", "abandon_studio_detached_generation_unknown", "rebind_studio_imagegen_call_context", "commit_agent_imagegen_result_bundle", "register_studio_generation_result", "create_studio_generation_plan", "fail_studio_generation_run", "cancel_studio_generation_run", "retry_studio_generation_plan_nodes"],
            unitGridPreCall: "prepare_studio_imagegen_call-first-success-only-callAllowed-true-replay-false",
            preferredWriteback: "commit_agent_imagegen_result_bundle-v4-v5-provider-required-atomic-pair",
          }),
          continuityReviewControl: expect.objectContaining({ tool: "get_studio_continuity_review_control", directWriteTools: false, writes: "execute_command-only" }),
        }),
        fusionProduction: expect.objectContaining({ canonicalAssets: expect.objectContaining({ store: "content-addressed-project-local", crossProjectSearch: false, migrationCommand: "migrate_canonical_assets" }), panelReferenceClosure: expect.objectContaining({ resolverVersion: "panel-reference-resolution-v1", supplierSlotMaximum: 6, overflowPolicy: "reviewed-derived-composite-no-silent-truncation", closureSeparateFromGenerationReadiness: true, paginatedReads: true, mcpReturnsBinary: false }), visualConstraints: expect.objectContaining({ builderVersion: "panel-visual-constraint-v1", modelReviewSeparation: true, hiddenMaskPolicy: "golden-mask-panel-allowlist-v1", humanVisualReviewRequired: true, casOverrides: ["presence", "golden-mask-reveal"], paginatedReads: true, mcpReturnsBinary: false }), writeCommands: expect.arrayContaining(["migrate_canonical_assets", "materialize_fusion_panel_references", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "materialize_fusion_visual_constraints", "upsert_fusion_visual_constraint_override", "migrate_fusion_storyboard_sheets"]) }),
        editor: expect.objectContaining({ features: expect.arrayContaining(["complex-nested-timelines", "frozen-nested-timeline-snapshots", "otio-linear-time-warp", "otio-smpte-dissolve"]), nestedTimelines: expect.objectContaining({ contract: "aicanvas.nested-timeline.v1", maximumDepth: 8, failurePolicy: "reject-missing-drifted-tampered-cyclic-overdepth-or-unprovable" }), effectTransitions: expect.objectContaining({ contract: "aicanvas.otio-effect-transition.v1", linearTimeWarp: expect.objectContaining({ schema: "LinearTimeWarp.1" }), smpteDissolve: expect.objectContaining({ transitionType: "SMPTE_Dissolve" }) }), missingForFullNle: [] }),
        generation: expect.objectContaining({ httpRemoteRecovery: expect.objectContaining({ observationStates: ["pending", "succeeded", "confirmed_failed", "retryable_or_unknown"], stableClientJobId: true, automaticPostReplayAfterUnknown: false, isolatedDownloadPerJob: true, verifiedNoClobberPromotion: true, remoteResultExposure: "hostname-only", recoveryScope: "single-job", waitingRemoteRecoveryAction: "process_generation_queue(jobId)", submissionUnknownRecoveryAction: "reconcile_http_generation_submission(jobId,expectedRevision,reconciliation)", submissionUnknownReconciliationCAS: true, submissionUnknownNotFoundRequiresExplicitConfirmation: true, submissionUnknownReconciliationMakesRemoteRequests: false, generationPublicationTerminalRequiresStructuredProvenance: true }), subagentImagegen: expect.objectContaining({ projectConcurrency: 1, providerConcurrency: 1, callIntentBeforeModel: true, callWithoutReceipt: "generation_unknown-no-retry", rawLabeledPublicationBundleRequired: true }) }),
        commandTypes: expect.arrayContaining(["migrate_canonical_assets", "import_story_file", "import_story_text", "create_novel_analysis_task", "upsert_novel_analysis_provider", "plan_novel_analysis_run", "execute_next_novel_analysis_run_task", "replace_novel_analysis_run_task", "execute_novel_analysis_task", "submit_novel_analysis_proposal", "review_novel_analysis_item", "review_novel_analysis_batch", "analyze_novel_chapters", "generate_adaptation_plans", "regenerate_adaptation_scope", "select_adaptation_plan", "materialize_adaptation_plan", "upsert_novel_fact", "upsert_narrative_beat", "export_adaptation", "create_task_pack", "claim_task", "heartbeat_task", "release_task", "cancel_task", "commit_existing_production_recovery", "freeze_studio_generation_pack", "dispatch_studio_generation_pack", "prepare_studio_imagegen_call", "reconcile_studio_imagegen_call", "abandon_studio_generation_unknown", "abandon_studio_detached_generation_unknown", "rebind_studio_imagegen_call_context", "commit_agent_imagegen_result_bundle", "register_studio_generation_result", "build_fusion_storyboard_grid", "materialize_fusion_panel_references", "materialize_fusion_visual_constraints", "upsert_fusion_visual_constraint_override", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "migrate_fusion_storyboard_evidence", "migrate_fusion_storyboard_sheets", "render_fusion_storyboard_sheet", "prepare_fusion_asset_consistency_review", "submit_fusion_asset_consistency_review", "seal_final_fusion_asset_consistency_batch", "upsert_generation_provider", "enqueue_generation", "cancel_generation", "update_subagent_image_generation", "migrate_generation_execution_state", "reconcile_http_generation_submission", "preflight_publication", "register_publication", "cancel_publication", "fail_publication", "preflight_publication_bundle", "register_publication_bundle", "cancel_publication_bundle", "fail_publication_bundle", "prepare_timeline_continuation", "start_edit_render", "cancel_edit_render"]),
        prompts: expect.arrayContaining(["managed_studio_lock_generate_writeback"]),
      }));
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining(["aicanvas://server/capabilities", "aicanvas://projects"]));
      const resourceTemplates = await client.listResourceTemplates();
      expect(resourceTemplates.resourceTemplates.map((resource) => resource.uriTemplate)).toEqual(expect.arrayContaining([
        "aicanvas://projects/{projectId}/snapshot",
        "aicanvas://projects/{projectId}/items/{itemId}",
        "aicanvas://projects/{projectId}/artifacts/{artifactId}",
        "aicanvas://projects/{projectId}/canvas",
        "aicanvas://projects/{projectId}/tasks",
        "aicanvas://projects/{projectId}/generation/{jobId}",
        "aicanvas://projects/{projectId}/editor/{editProjectId}",
        "aicanvas://projects/{projectId}/story/chapters/{chapterId}",
        "aicanvas://projects/{projectId}/changes/{cursor}",
      ]));
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining([
        "managed_studio_lock_generate_writeback",
        "resume_project",
        "produce_next_image_batch",
        "produce_next_video_batch",
        "run_browser_generation",
        "continue_video_from_last_frame",
        "review_visual_batch",
        "recover_interrupted_work",
      ]));
      const prompt = await client.getPrompt({ name: "resume_project", arguments: { projectRoot: importRoot } });
      expect((prompt.messages[0]?.content as { text?: string }).text).toContain("doctor_project");
      const browserPrompt = await client.getPrompt({ name: "run_browser_generation", arguments: { projectRoot: importRoot, jobId: "gen-prompt-test" } });
      const browserPromptText = (browserPrompt.messages[0]?.content as { text?: string }).text ?? "";
      expect(browserPromptText).toContain("status=preflight_blocked");
      expect(browserPromptText).toContain("status=preflight");
      expect(browserPromptText).toContain("status=uploaded");
      expect(browserPromptText).toContain("status=submit_intent");
      expect(browserPromptText).toContain("submissionReconciliation");
      expect(browserPromptText).toContain("expectedRevision");
      expect(browserPromptText).toContain("uploadEvidence");
      expect(browserPromptText).toContain("allowedUploads=[]");
      expect(browserPromptText).toContain("uploadEvidence={files:[],observedReferenceThumbnailCount:0}");
      expect(browserPromptText.indexOf("status=preflight")).toBeLessThan(browserPromptText.indexOf("status=uploaded"));
      expect(browserPromptText.indexOf("status=uploaded")).toBeLessThan(browserPromptText.indexOf("status=submit_intent"));
      expect(browserPromptText.indexOf("status=submit_intent")).toBeLessThan(browserPromptText.indexOf("status=submitted"));
      const continuationPrompt = await client.getPrompt({ name: "continue_video_from_last_frame", arguments: { projectRoot: importRoot, itemId: "main-ep01-unit001" } });
      const continuationPromptText = (continuationPrompt.messages[0]?.content as { text?: string }).text ?? "";
      expect(continuationPromptText).toContain("enqueue_generation");
      expect(continuationPromptText).toContain("update_browser_generation");
      expect(continuationPromptText).toContain("只读投影");
      expect(continuationPromptText).toContain("禁止独立回写 submitted/completed");
      expect(continuationPromptText).toContain("submission_unknown");
      const recoveryPrompt = await client.getPrompt({ name: "recover_interrupted_work", arguments: { projectRoot: importRoot, jobId: "gen-recovery-test" } });
      const recoveryPromptText = (recoveryPrompt.messages[0]?.content as { text?: string }).text ?? "";
      expect(recoveryPromptText).toContain("submissionIntent.clientJobId");
      expect(recoveryPromptText).toContain("submissionReconciliation");
      expect(recoveryPromptText).toContain("reconcile_http_generation_submission");
      expect(recoveryPromptText).toContain("confirmNoRemoteResult=true");
      expect(recoveryPromptText).toContain("绝对不能再次点击提交");
      expect(recoveryPromptText).toContain("production-evidence-drift");
      expect(recoveryPromptText).toContain("generation_unknown 只能核对既有调用证据");
      expect(recoveryPromptText).toContain("严禁 claim、takeover、cancel、process 或再次调用生图");
      expect(recoveryPromptText).toContain("raw/labeled");
      const resumePrompt = await client.getPrompt({ name: "resume_project", arguments: { projectRoot: importRoot } });
      expect((resumePrompt.messages[0]?.content as { text?: string }).text).toContain("submission_unknown");
      expect((resumePrompt.messages[0]?.content as { text?: string }).text).toContain("production-evidence-verification");
      expect((resumePrompt.messages[0]?.content as { text?: string }).text).toContain("productionDesign.evidence.nextRepair");
      const missingBrowserRevision = await client.callTool({ name: "update_browser_generation_job", arguments: { projectRoot: importRoot, requestId: "request-browser-no-revision", idempotencyKey: "browser-no-revision-v1", jobId: "gen-missing", status: "preflight", note: "测试" } });
      expect(missingBrowserRevision.isError).toBe(true);
      const directory = path.join(importRoot, "EP04_15s_001_MCP导入");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：MCP 两段式导入。\n尾帧提示词：保持连续。\n", "utf8");
      const previewResult = await client.callTool({ name: "preview_project_import", arguments: { primaryRoot: importRoot, name: "MCP 导入测试" } });
      const previewContent = previewResult.content as Array<{ type: string; text?: string }>;
      const previewText = previewContent.find((entry) => entry.type === "text");
      const preview = JSON.parse(previewText?.text ?? "{}") as { previewId?: string; canImport?: boolean; recognized?: { units?: number } };
      expect(preview.canImport).toBe(true);
      expect(preview.recognized?.units).toBe(1);
      await expect(access(path.join(importRoot, ".aicanvas"))).rejects.toThrow();
      const commitResult = await client.callTool({ name: "commit_project_import", arguments: { previewId: preview.previewId, requestId: "request-mcp-import-001", idempotencyKey: "mcp-import-project-v1", primaryRoot: importRoot, name: "MCP 导入测试" } });
      expect(commitResult.isError).not.toBe(true);
      await expect(access(path.join(importRoot, ".aicanvas", "index.json"))).resolves.toBeUndefined();
      const doctorResult = await client.callTool({ name: "doctor_project", arguments: { projectRoot: importRoot } });
      expect(payload(doctorResult)).toEqual(expect.objectContaining({ healthy: false, projectRoot: importRoot, productionEvidence: expect.objectContaining({ repairRequired: false, counts: expect.objectContaining({ completed: 0 }), nextStage: expect.objectContaining({ stageId: "source" }) }), checks: expect.arrayContaining([expect.objectContaining({ id: "existing-production-recovery", level: "error" })]), suggestedNextCalls: expect.arrayContaining(["preview_existing_production_recovery", "commit_existing_production_recovery"]) }));
      const recoveryArguments = {
        projectRoot: importRoot,
        itemIds: ["main-ep04-unit001"],
        allowedTargets: ["image"],
        contracts: [{
          itemId: "main-ep04-unit001",
          order: 1,
          durationSeconds: 15,
          shotSize: "大远景",
          cameraMovement: "缓慢推进",
          action: "MCP 既有制作包恢复镜头",
          firstFramePrompt: "MCP 两段式导入。",
          endFramePrompt: "保持连续。",
          videoPrompt: "缓慢推进并保持连续。",
          referencePaths: [],
          referenceArtifactIds: [],
        }],
        note: "MCP scoped recovery 回归",
      };
      const recoveryPreview = payload(await client.callTool({ name: "preview_existing_production_recovery", arguments: recoveryArguments })) as { previewId: string; expectedWorkflowRevision: number };
      expect(recoveryPreview).toEqual(expect.objectContaining({ previewId: expect.stringMatching(/^[a-f0-9]{64}$/), expectedWorkflowRevision: 0 }));
      const recoveryCommitArguments = {
        ...recoveryArguments,
        previewId: recoveryPreview.previewId,
        expectedWorkflowRevision: recoveryPreview.expectedWorkflowRevision,
        requestId: "request-mcp-existing-recovery-001",
        idempotencyKey: "mcp-existing-recovery-main-ep04-unit001-v1",
      };
      const recoveryCommit = await client.callTool({ name: "commit_existing_production_recovery", arguments: recoveryCommitArguments });
      expect(payload(recoveryCommit)).toEqual(expect.objectContaining({ revision: 1, existingProductionBaselines: [expect.objectContaining({ itemIds: ["main-ep04-unit001"], allowedTargets: ["image"] })] }));
      const recoveryReplay = await client.callTool({ name: "commit_existing_production_recovery", arguments: { ...recoveryCommitArguments, requestId: "request-mcp-existing-recovery-002" } });
      expect(payload(recoveryReplay)).toEqual(payload(recoveryCommit));
      const recoveredDoctor = payload(await client.callTool({ name: "doctor_project", arguments: { projectRoot: importRoot } })) as { healthy?: boolean; checks?: Array<{ id?: string; level?: string }> };
      expect(recoveredDoctor).toEqual(expect.objectContaining({ healthy: true, checks: expect.arrayContaining([expect.objectContaining({ id: "existing-production-recovery", level: "warning" })]) }));
      const generationSettingsPath = path.join(importRoot, ".aicanvas", "generation.json");
      await expect(access(generationSettingsPath)).rejects.toThrow();
      const defaultGenerationSettings = payload(await client.callTool({ name: "get_generation_settings", arguments: { projectRoot: importRoot } })) as { revision: number; providers: Array<{ id: string }> };
      expect(defaultGenerationSettings.revision).toBe(0);
      expect(defaultGenerationSettings.providers.map((provider) => provider.id)).toEqual(["folder-image", "folder-video"]);
      await expect(access(generationSettingsPath)).rejects.toThrow();
      const generationProviderArguments = {
        projectRoot: importRoot,
        idempotencyKey: "mcp-generation-provider-v1",
        expectedRevision: 0,
        setAsDefaultFor: "image",
        provider: { id: "mcp-browser", name: "MCP 网页生图", adapter: "codex-browser", kinds: ["image"], enabled: true, siteUrl: "https://example.com/generate", browserInstructions: "仅上传白名单资产。", executionSurface: { id: "codex-in-app-side-browser", version: "1" }, workflow: { schemaVersion: 1, name: "MCP 网页配方", version: "1", format: "browser-recipe", definition: { mode: "cinematic", slots: [{ role: "first_frame" }] } }, outputRoot: importRoot },
      };
      const generationProviderResult = await client.callTool({ name: "upsert_generation_provider", arguments: { ...generationProviderArguments, requestId: "request-mcp-generation-provider-001" } });
      expect(payload(generationProviderResult)).toEqual(expect.objectContaining({ revision: 1, defaultImageProviderId: "mcp-browser", providers: expect.arrayContaining([expect.objectContaining({ id: "mcp-browser", executionSurface: { id: "codex-in-app-side-browser", version: "1" } })]) }));
      const generationProviderReplay = await client.callTool({ name: "upsert_generation_provider", arguments: { ...generationProviderArguments, requestId: "request-mcp-generation-provider-002" } });
      expect(payload(generationProviderReplay)).toEqual(payload(generationProviderResult));
      const comfyProviderResult = await client.callTool({ name: "upsert_generation_provider", arguments: {
        projectRoot: importRoot,
        requestId: "request-mcp-comfyui-provider-001",
        idempotencyKey: "mcp-comfyui-provider-v1",
        expectedRevision: 1,
        provider: {
          id: "mcp-comfyui",
          name: "MCP ComfyUI 本机",
          adapter: "comfyui-local",
          kinds: ["image"],
          enabled: true,
          endpoint: "http://127.0.0.1:8188",
          workflow: { schemaVersion: 1, name: "MCP ComfyUI API", version: "1", format: "comfyui-api", definition: { "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } }, "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } } }, comfyUi: { promptInputs: [{ nodeId: "6", inputName: "text" }], outputNodeId: "9", outputIndex: 0 } },
          outputRoot: importRoot,
        },
      } });
      expect(payload(comfyProviderResult)).toEqual(expect.objectContaining({ revision: 2, providers: expect.arrayContaining([expect.objectContaining({ id: "mcp-comfyui", adapter: "comfyui-local", endpoint: "http://127.0.0.1:8188/", workflow: expect.objectContaining({ comfyUi: { promptInputs: [{ nodeId: "6", inputName: "text" }], outputNodeId: "9", outputIndex: 0 } }) })]) }));
      const detailedGenerationProvider = payload(await client.callTool({ name: "get_generation_provider", arguments: { projectRoot: importRoot, providerId: "mcp-browser" } })) as { settingsRevision: number; provider: { workflow?: { definition?: unknown } } };
      expect(detailedGenerationProvider.settingsRevision).toBe(2);
      expect(detailedGenerationProvider.provider.workflow?.definition).toEqual({ mode: "cinematic", slots: [{ role: "first_frame" }] });
      const staleGenerationProvider = await client.callTool({ name: "upsert_generation_provider", arguments: { ...generationProviderArguments, requestId: "request-mcp-generation-provider-stale", idempotencyKey: "mcp-generation-provider-stale-v1" } });
      expect(staleGenerationProvider.isError).toBe(true);
      const snapshotResult = await client.callTool({ name: "get_project_snapshot", arguments: { projectRoot: importRoot, focusItemId: "main-ep04-unit001" } });
      const snapshot = payload(snapshotResult) as { project?: { id?: string }; focus?: { id?: string }; runtimeResources?: unknown; productionDesign?: { evidence?: { repairRequired?: boolean; counts?: { completed?: number }; nextStage?: { stageId?: string } } }; suggestedNextCalls?: string[] };
      expect(snapshot.focus?.id).toBe("main-ep04-unit001");
      expect(snapshot.runtimeResources).toEqual(expect.objectContaining({ scan: expect.objectContaining({ active: false }), editor: expect.objectContaining({ foregroundCapacity: 1, renderCapacity: 1, activeRenderBlocksForegroundJobs: true }), blockedActions: [] }));
      expect(snapshot.productionDesign?.evidence).toMatchObject({ repairRequired: false, counts: { completed: 0 }, nextStage: { stageId: "source" } });
      expect(snapshot.suggestedNextCalls).toContain("get_item");
      const cancellableTaskId = "task-mcp-cancel";
      await writeFile(path.join(importRoot, ".aicanvas", "tasks", `${cancellableTaskId}.json`), JSON.stringify({
        schemaVersion: 2,
        id: cancellableTaskId,
        projectId: snapshot.project?.id,
        revision: 1,
        status: "ready",
        kind: "image",
        mode: "autopilot",
        itemIds: ["main-ep04-unit001"],
        createdAt: new Date().toISOString(),
        prompts: [],
        negativePrompts: [],
        hardLocks: [],
        skillRefs: [],
        outputRules: [],
        acceptanceCriteria: [],
        itemSnapshots: [],
      }, null, 2), "utf8");
      const missingRevisionCases = [
        { name: "claim_task", suffix: "claim", args: { agentId: "codex-mcp" } },
        { name: "heartbeat_task", suffix: "heartbeat", args: { leaseId: "lease-missing-revision", agentId: "codex-mcp" } },
        { name: "release_task", suffix: "release", args: { leaseId: "lease-missing-revision", agentId: "codex-mcp" } },
        { name: "finish_batch", suffix: "finish", args: { leaseId: "lease-missing-revision", agentId: "codex-mcp", completedItemIds: ["main-ep04-unit001"], failedItemIds: [] } },
      ];
      for (const entry of missingRevisionCases) {
        const result = await client.callTool({ name: entry.name, arguments: {
          projectRoot: importRoot,
          taskId: cancellableTaskId,
          requestId: `request-mcp-${entry.suffix}-no-revision`,
          idempotencyKey: `mcp-${entry.suffix}-no-revision-v1`,
          ...entry.args,
        } });
        expect(result.isError, entry.name).toBe(true);
      }
      const commandWithoutRevision = await client.callTool({ name: "execute_command", arguments: {
        projectRoot: importRoot,
        requestId: "request-mcp-command-no-revision",
        idempotencyKey: "mcp-command-no-revision-v1",
        request: { command: "claim_task", payload: { taskId: cancellableTaskId, agentId: "codex-mcp" } },
      } });
      expect(commandWithoutRevision.isError).toBe(true);
      const missingCancelReason = await client.callTool({ name: "cancel_task", arguments: { projectRoot: importRoot, requestId: "request-mcp-cancel-invalid", idempotencyKey: "mcp-cancel-invalid-v1", taskId: cancellableTaskId, expectedRevision: 1 } });
      expect(missingCancelReason.isError).toBe(true);
      const cancelResult = await client.callTool({ name: "cancel_task", arguments: { projectRoot: importRoot, requestId: "request-mcp-cancel-001", idempotencyKey: "mcp-cancel-task-v1", taskId: cancellableTaskId, expectedRevision: 1, reason: "MCP 测试任务不再需要" } });
      expect(payload(cancelResult)).toEqual(expect.objectContaining({
        id: cancellableTaskId,
        status: "cancelled",
        revision: 2,
        cancellation: expect.objectContaining({ reason: "MCP 测试任务不再需要", previousStatus: "ready" }),
      }));
      const commandTaskId = "task-mcp-command-cancel";
      await writeFile(path.join(importRoot, ".aicanvas", "tasks", `${commandTaskId}.json`), JSON.stringify({
        schemaVersion: 2,
        id: commandTaskId,
        projectId: snapshot.project?.id,
        revision: 1,
        status: "ready",
        kind: "image",
        mode: "autopilot",
        itemIds: ["main-ep04-unit001"],
        createdAt: new Date().toISOString(),
        prompts: [],
        negativePrompts: [],
        hardLocks: [],
        skillRefs: [],
        outputRules: [],
        acceptanceCriteria: [],
        itemSnapshots: [],
      }, null, 2), "utf8");
      const commandCancelResult = await client.callTool({ name: "execute_command", arguments: {
        projectRoot: importRoot,
        requestId: "request-mcp-command-cancel-001",
        idempotencyKey: "mcp-command-cancel-task-v1",
        request: { command: "cancel_task", payload: { taskId: commandTaskId, expectedRevision: 1, reason: "统一命令入口取消测试" } },
      } });
      expect(payload(commandCancelResult)).toEqual(expect.objectContaining({ id: commandTaskId, status: "cancelled", revision: 2 }));
      const commandLedgerResult = await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: importRoot } });
      expect(payload(commandLedgerResult)).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "cancel_task", status: "succeeded", idempotencyKey: "mcp-cancel-task-v1" }),
        expect.objectContaining({ command: "cancel_task", status: "succeeded", idempotencyKey: "mcp-command-cancel-task-v1" }),
      ]));
      const snapshotResource = await client.readResource({ uri: `aicanvas://projects/${snapshot.project?.id}/snapshot` });
      const snapshotResourceContent = snapshotResource.contents[0];
      const snapshotResourceValue = JSON.parse(snapshotResourceContent && "text" in snapshotResourceContent ? snapshotResourceContent.text : "{}") as { project?: { id?: string } };
      expect(snapshotResourceValue.project?.id).toBe(snapshot.project?.id);
      const scanResult = payload(await client.callTool({ name: "scan_project", arguments: { projectRoot: importRoot, requestId: "request-mcp-scan-001", idempotencyKey: "mcp-scan-project-v1" } })) as { scanStats?: { inspectedChecks?: number; reusedChecks?: number; inspectionConcurrency?: number } };
      expect(scanResult.scanStats).toMatchObject({ inspectedChecks: 0, reusedChecks: 1, inspectionConcurrency: 6 });
      const progressResult = payload(await client.callTool({ name: "get_progress", arguments: { projectRoot: importRoot } })) as { scanStats?: { reusedChecks?: number } };
      expect(progressResult.scanStats?.reusedChecks).toBe(1);
      const changeResource = await client.readResource({ uri: `aicanvas://projects/${snapshot.project?.id}/changes/start` });
      const changeContent = changeResource.contents[0];
      const changes = JSON.parse(changeContent && "text" in changeContent ? changeContent.text : "{}") as { changes?: Array<{ type?: string }>; nextCursor?: string };
      expect(changes.changes?.some((event) => event.type === "project.scanned")).toBe(true);
      expect(changes.nextCursor).toBeTruthy();
      const taskResource = await client.readResource({ uri: `aicanvas://projects/${snapshot.project?.id}/tasks` });
      const taskContent = taskResource.contents[0];
      expect(JSON.parse(taskContent && "text" in taskContent ? taskContent.text : "{}")).toEqual(expect.objectContaining({ tasks: expect.any(Array) }));
      const unguardedContext = await client.callTool({ name: "upsert_context", arguments: { projectRoot: importRoot, kind: "continuity", title: "绕过写入", content: "不应成功。" } });
      expect(unguardedContext.isError).toBe(true);
      const contextArguments = { projectRoot: importRoot, idempotencyKey: "mcp-context-continuity-v1", kind: "continuity", title: "MCP 连续性", content: "EP04 保持角色与完整面具一致。", tags: ["EP04"], itemIds: ["main-ep04-unit001"] };
      const contextResult = await client.callTool({ name: "upsert_context", arguments: { ...contextArguments, requestId: "request-mcp-context-001" } });
      expect(contextResult.isError).not.toBe(true);
      const replayedContext = await client.callTool({ name: "upsert_context", arguments: { ...contextArguments, requestId: "request-mcp-context-002" } });
      expect(replayedContext.isError).not.toBe(true);
      const skillsResult = await client.callTool({ name: "list_skills", arguments: { projectRoot: importRoot, enabledOnly: true } });
      expect(payload(skillsResult)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "task-orchestration", revision: 1 })]));
      const continuationResult = await client.callTool({ name: "get_continuation", arguments: { projectRoot: importRoot, itemId: "main-ep04-unit001" } });
      const continuation = payload(continuationResult) as { prompt?: string; relatedContext?: Array<{ title?: string }> };
      expect(continuation.prompt).toContain("MCP 导入测试");
      expect(continuation.relatedContext?.some((entry) => entry.title === "MCP 连续性")).toBe(true);
      const storyPath = path.join(importRoot, "原著.md");
      await writeFile(storyPath, "# 第一章 MCP 神落\n角色从雾中醒来。\n\n# 第二章 面具\n完整黄金面具发光。", "utf8");
      const storyImportResult = await client.callTool({ name: "import_story_file", arguments: { projectRoot: importRoot, requestId: "request-mcp-story-001", idempotencyKey: "mcp-story-import-v1", filePath: storyPath, title: "MCP 原著" } });
      const storyImport = payload(storyImportResult) as { chapters?: Array<{ id: string }> };
      expect(storyImport.chapters).toHaveLength(2);
      const unguardedAnalyze = await client.callTool({ name: "analyze_novel_chapters", arguments: { projectRoot: importRoot, expectedRevision: 0 } });
      expect(unguardedAnalyze.isError).toBe(true);
      const analyzeResult = await client.callTool({ name: "analyze_novel_chapters", arguments: { projectRoot: importRoot, requestId: "request-mcp-adapt-analyze-001", idempotencyKey: "mcp-adapt-analyze-v1", expectedRevision: 0 } });
      expect(analyzeResult.isError, JSON.stringify(analyzeResult)).not.toBe(true);
      const analyzed = payload(analyzeResult) as { revision: number; facts?: unknown[]; beats?: unknown[] };
      expect(analyzed.facts?.length).toBeGreaterThan(0);
      expect(analyzed.beats?.length).toBeGreaterThan(0);
      const plansResult = await client.callTool({ name: "generate_adaptation_plans", arguments: { projectRoot: importRoot, requestId: "request-mcp-adapt-plans-001", idempotencyKey: "mcp-adapt-plans-v1", expectedRevision: analyzed.revision, episode: 4, startUnit: 2 } });
      const planned = payload(plansResult) as { workspace: { revision: number }; plans: Array<{ id: string; mode: string; units: unknown[] }> };
      expect(planned.plans.map((plan) => plan.mode).sort()).toEqual(["concise", "split"]);
      const splitPlan = planned.plans.find((plan) => plan.mode === "split")!;
      const selectResult = await client.callTool({ name: "select_adaptation_plan", arguments: { projectRoot: importRoot, requestId: "request-mcp-adapt-select-001", idempotencyKey: "mcp-adapt-select-v1", planId: splitPlan.id, expectedRevision: planned.workspace.revision } });
      const selected = payload(selectResult) as { revision: number; selectedPlanId?: string };
      expect(selected.selectedPlanId).toBe(splitPlan.id);
      const materializeResult = await client.callTool({ name: "materialize_adaptation_plan", arguments: { projectRoot: importRoot, requestId: "request-mcp-adapt-materialize-001", idempotencyKey: "mcp-adapt-materialize-v1", expectedRevision: selected.revision } });
      const materialized = payload(materializeResult) as { unitPaths?: string[]; storyboardRows?: Array<{ status?: string }> };
      expect(materialized.unitPaths?.length).toBeGreaterThan(0);
      expect(materialized.storyboardRows?.every((row) => row.status === "draft")).toBe(true);
      const adaptationWorkspaceResult = await client.callTool({ name: "get_adaptation_workspace", arguments: { projectRoot: importRoot } });
      const adaptationWorkspace = payload(adaptationWorkspaceResult) as { revision: number; facts: Array<{ id: string }> };
      const impactResult = await client.callTool({ name: "analyze_adaptation_impact", arguments: { projectRoot: importRoot, factIds: [adaptationWorkspace.facts[0]!.id] } });
      const impact = payload(impactResult) as { plans: Array<{ planId: string; unitIds: string[] }> };
      expect(impact.plans.find((plan) => plan.planId === splitPlan.id)?.unitIds.length).toBeGreaterThan(0);
      const unguardedRegenerate = await client.callTool({ name: "regenerate_adaptation_scope", arguments: { projectRoot: importRoot, planId: splitPlan.id, expectedRevision: adaptationWorkspace.revision, factIds: [adaptationWorkspace.facts[0]!.id] } });
      expect(unguardedRegenerate.isError).toBe(true);
      const regenerateArguments = { projectRoot: importRoot, idempotencyKey: "mcp-adapt-regenerate-v1", planId: splitPlan.id, expectedRevision: adaptationWorkspace.revision, factIds: [adaptationWorkspace.facts[0]!.id] };
      const regenerateResult = await client.callTool({ name: "regenerate_adaptation_scope", arguments: { ...regenerateArguments, requestId: "request-mcp-adapt-regenerate-001" } });
      const regenerated = payload(regenerateResult) as { workspace: { revision: number }; regeneratedUnitIds: string[] };
      expect(regenerated.regeneratedUnitIds.length).toBeGreaterThan(0);
      const replayedRegenerate = await client.callTool({ name: "regenerate_adaptation_scope", arguments: { ...regenerateArguments, requestId: "request-mcp-adapt-regenerate-002" } });
      expect(payload(replayedRegenerate)).toEqual(payload(regenerateResult));
      const applyRegeneratedResult = await client.callTool({ name: "materialize_adaptation_plan", arguments: { projectRoot: importRoot, requestId: "request-mcp-adapt-apply-regenerated-001", idempotencyKey: "mcp-adapt-apply-regenerated-v1", expectedRevision: regenerated.workspace.revision } });
      expect((payload(applyRegeneratedResult) as { plan?: { status?: string } }).plan?.status).toBe("materialized");
      const validationResult = await client.callTool({ name: "validate_adaptation_plan", arguments: { projectRoot: importRoot, planId: splitPlan.id } });
      expect(payload(validationResult)).toEqual(expect.objectContaining({ hardErrors: [] }));
      const adaptationPath = path.join(importRoot, "MCP_小说分镜_v001.json");
      const exportResult = await client.callTool({ name: "export_adaptation", arguments: { projectRoot: importRoot, requestId: "request-mcp-adapt-export-001", idempotencyKey: "mcp-adapt-export-v1", format: "json", outputPath: adaptationPath, planId: splitPlan.id } });
      expect(payload(exportResult)).toEqual(expect.objectContaining({ path: adaptationPath, format: "json" }));
      await expect(access(adaptationPath)).resolves.toBeUndefined();
      const workspaceBeforeModelTask = payload(await client.callTool({ name: "get_adaptation_workspace", arguments: { projectRoot: importRoot } })) as { revision: number };
      const unguardedModelTask = await client.callTool({ name: "create_novel_analysis_task", arguments: { projectRoot: importRoot, expectedRevision: workspaceBeforeModelTask.revision, providerId: "codex" } });
      expect(unguardedModelTask.isError).toBe(true);
      const modelTaskResult = await client.callTool({ name: "create_novel_analysis_task", arguments: { projectRoot: importRoot, requestId: "request-mcp-model-task-001", idempotencyKey: "mcp-model-task-v1", expectedRevision: workspaceBeforeModelTask.revision, providerId: "codex", providerKind: "codex" } });
      const modelTask = payload(modelTaskResult) as { workspace: { revision: number }; task: { id: string; chapterRefs: Array<{ chapterId: string; sourceId: string; revision: number; sha256: string; path: string }> } };
      const modelChapter = modelTask.task.chapterRefs[0]!;
      const modelChapterText = await readFile(modelChapter.path, "utf8");
      const modelEvidence = "角色从雾中醒来。";
      const modelStart = modelChapterText.indexOf(modelEvidence);
      const modelSpan = { sourceId: modelChapter.sourceId, chapterId: modelChapter.chapterId, chapterRevision: modelChapter.revision, chapterSha256: modelChapter.sha256, startOffset: modelStart, endOffset: modelStart + modelEvidence.length, text: modelEvidence };
      const proposalResult = await client.callTool({ name: "submit_novel_analysis_proposal", arguments: { projectRoot: importRoot, requestId: "request-mcp-model-proposal-001", idempotencyKey: "mcp-model-proposal-v1", taskId: modelTask.task.id, expectedRevision: modelTask.workspace.revision, facts: [{ id: "model-awakening", kind: "event", epistemicStatus: "confirmed", statement: modelEvidence, sourceSpans: [modelSpan], tags: ["MCP模型提案"] }], beats: [] } });
      const proposal = payload(proposalResult) as { workspace: { revision: number }; reviews: Array<{ id: string; revision: number; status: string; evidenceIssues: string[] }> };
      expect(proposal.reviews[0]).toEqual(expect.objectContaining({ status: "pending", evidenceIssues: [] }));
      const reviewQueueResult = await client.callTool({ name: "list_novel_analysis_reviews", arguments: { projectRoot: importRoot, status: "pending", taskId: modelTask.task.id } });
      expect((payload(reviewQueueResult) as { reviews: unknown[] }).reviews).toHaveLength(1);
      const acceptedModelFact = await client.callTool({ name: "review_novel_analysis_item", arguments: { projectRoot: importRoot, requestId: "request-mcp-model-review-001", idempotencyKey: "mcp-model-review-v1", reviewId: proposal.reviews[0]!.id, decision: "accepted", expectedRevision: proposal.workspace.revision, reviewExpectedRevision: proposal.reviews[0]!.revision, note: "MCP原文证据核验通过" } });
      expect(payload(acceptedModelFact)).toEqual(expect.objectContaining({ review: expect.objectContaining({ status: "accepted" }), appliedEntity: expect.objectContaining({ statement: modelEvidence }) }));
      const storyEventResult = await client.callTool({ name: "upsert_story_event", arguments: { projectRoot: importRoot, requestId: "request-mcp-event-001", idempotencyKey: "mcp-story-event-v1", chapterId: storyImport.chapters?.[0]?.id, title: "角色苏醒", description: "角色从雾中醒来。", sourceExcerpt: "角色从雾中醒来。", episode: 4, unit: 1, itemIds: ["main-ep04-unit001"], status: "confirmed" } });
      expect(storyEventResult.isError).not.toBe(true);
      const storyContextResult = await client.callTool({ name: "build_story_context", arguments: { projectRoot: importRoot, itemId: "main-ep04-unit001" } });
      const storyContext = payload(storyContextResult) as { events?: Array<{ title?: string }>; prompt?: string };
      expect(storyContext.events?.[0]?.title).toBe("角色苏醒");
      expect(storyContext.prompt).toContain("原文证据");
      const engineResult = await client.callTool({ name: "probe_video_engine", arguments: {} });
      expect(payload(engineResult)).toEqual(expect.objectContaining({ available: true }));
      const editResult = await client.callTool({ name: "create_edit_project", arguments: { projectRoot: importRoot, requestId: "request-mcp-editor-001", idempotencyKey: "mcp-editor-create-v1", name: "MCP 剪辑工程", episode: 4, width: 1080, height: 1920, fps: 24, autoPopulate: false } });
      const editProject = payload(editResult) as { id?: string; tracks?: unknown[]; revision?: number };
      expect(editProject.id).toMatch(/^edit-/);
      expect(editProject.tracks).toHaveLength(3);
      expect(editProject.revision).toBe(1);

      for (let version = 1; version <= 12; version += 1) {
        for (const [variant, suffix] of [["首帧", "raw"], ["首帧", "labeled"], ["尾帧", "raw"], ["尾帧", "labeled"]] as const) {
          await sharp({ create: { width: 720 + version, height: 1280, channels: 3, background: { r: 20 + version, g: suffix === "raw" ? 80 : 120, b: variant === "首帧" ? 140 : 180 } } })
            .png({ compressionLevel: 0 })
            .toFile(path.join(directory, `EP04_15s_001_${variant}_v${version}_${suffix}.png`));
        }
      }
      await client.callTool({ name: "scan_project", arguments: { projectRoot: importRoot, requestId: "request-mcp-review-versions-scan", idempotencyKey: "mcp-review-versions-scan-v1" } });
      const reviewQueue = payload(await client.callTool({ name: "get_review_queue", arguments: { projectRoot: importRoot, limit: 100 } })) as Array<{
        item: { id: string };
        reviewType: "image" | "video";
        artifactTotal: number;
        artifactsTruncated: boolean;
        artifacts: Array<{ id: string; path: string; kind: string; variant: string; authoritative: boolean; deprecated: boolean }>;
        reviewSnapshot: { scanId: string; artifactHashes: Record<string, string> };
      }>;
      if (!Array.isArray(reviewQueue)) throw new Error(`get_review_queue 未返回数组：${JSON.stringify(reviewQueue).slice(0, 500)}`);
      const versionedEntry = reviewQueue.find((entry) => entry.item.id === "main-ep04-unit001");
      if (!versionedEntry) throw new Error(`get_review_queue 缺少 main-ep04-unit001；实际节点：${reviewQueue.map((entry) => `${entry.item.id}:${entry.reviewType}`).join("、")}`);
      expect(versionedEntry.artifactTotal).toBeGreaterThan(20);
      expect(versionedEntry.artifactsTruncated).toBe(true);
      expect(versionedEntry.artifacts).toHaveLength(20);
      const authoritative = versionedEntry.artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated && ["raw-image", "labeled-image"].includes(artifact.kind));
      expect(authoritative).toHaveLength(4);
      expect(authoritative.every((artifact) => artifact.path.includes("_v12_"))).toBe(true);
      expect(authoritative.every((artifact) => /^[a-f0-9]{64}$/.test(versionedEntry.reviewSnapshot.artifactHashes[artifact.id] ?? ""))).toBe(true);

      const staleReviewCommand = {
        projectRoot: importRoot,
        idempotencyKey: "mcp-submit-review-stale-v1",
        request: {
          command: "submit_review",
          payload: {
            itemId: versionedEntry.item.id,
            reviewType: "image",
            artifactIds: authoritative.map((artifact) => artifact.id),
            expectedScanId: versionedEntry.reviewSnapshot.scanId,
            expectedArtifactHashes: Object.fromEntries(authoritative.map((artifact) => [artifact.id, "0".repeat(64)])),
            decision: "pass",
            criteria: ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"].map((key) => ({ key, result: "pass" })),
          },
        },
      };
      const staleResult = await client.callTool({ name: "execute_command", arguments: { ...staleReviewCommand, requestId: "request-mcp-submit-review-stale-001" } });
      expect(staleResult.isError).toBe(true);
      const staleLedger = payload(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: importRoot } })) as Array<{ idempotencyKey: string; status: string }>;
      expect(staleLedger.find((entry) => entry.idempotencyKey === staleReviewCommand.idempotencyKey)?.status).toBe("failed");
      const reviewHistory = payload(await client.callTool({ name: "list_reviews", arguments: { projectRoot: importRoot, itemId: versionedEntry.item.id } })) as unknown[];
      expect(reviewHistory).toHaveLength(0);
      const handoffResult = await client.callTool({ name: "create_handoff", arguments: { projectRoot: importRoot, requestId: "request-mcp-handoff-001", idempotencyKey: "mcp-handoff-unit001-v1", itemId: "main-ep04-unit001" } });
      const handoff = payload(handoffResult) as { path?: string };
      await expect(access(handoff.path!)).resolves.toBeUndefined();
    } finally {
      await client.close();
      await rm(runtimeRoot, { recursive: true, force: true });
    }
    // 真实 stdio 子进程 + 数十次工具调用（每次 mutation 门禁约 200ms 全仓摘要），
    // 实测约 43 秒；30 秒默认 testTimeout 处于边缘，对齐其余 MCP 集成测试的 120 秒。
  }, 120_000);
});
