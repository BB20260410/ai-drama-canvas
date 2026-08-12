import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorProject, getCapabilities, getProjectSnapshot } from "../src/core/codex.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { preflightPublication } from "../src/core/publication.js";
import { updateProductionWorkflowStage } from "../src/core/production.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { importStoryFile } from "../src/core/story.js";
import { withProjectLock } from "../src/core/locks.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("项目医生损坏侧车诊断", () => {
  it("统一快照公开扫描、媒体和成片资源占用并调整下一动作", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-runtime-resources-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_资源占用");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：资源占用测试。\n", "utf8");
    await scanAndPersist(root);
    const pendingPublication = await preflightPublication(root, { idempotencyKey: "snapshot-publication-pending-001", requestedPath: path.join(root, "待校验结果.bin"), kind: "other", context: { purpose: "other", itemId: "main-ep01-unit001" } });
    await writeFile(pendingPublication.targetPath, "present but not yet validated", "utf8");
    const paths = getSidecarPaths(root);
    await writeJsonAtomic(paths.editorRenders, {
      schemaVersion: 1,
      jobs: [{ schemaVersion: 1, id: "render-runtime-resource", editProjectId: "edit-runtime-resource", status: "running", outputPath: path.join(root, "resource-render.mp4"), progress: .4, durationSeconds: 10, pid: process.pid, startedAt: new Date().toISOString() }],
    });

    const rendering = await getProjectSnapshot(root);
    expect(rendering.runtimeResources.machineMedia).toEqual(expect.objectContaining({ capacity: 4, activeWeight: 0, queueDepth: 0, algorithm: "strict-weighted-fifo" }));
    expect(rendering.publications).toEqual(expect.objectContaining({ counts: { reserved: 1, registered: 0, cancelled: 0, failed: 0 }, validationMode: "two-phase-snapshot-validate-cas", pending: [expect.objectContaining({ id: pendingPublication.id, targetPresentPendingValidation: true })] }));
    expect(rendering.publications.pending[0]).not.toHaveProperty("reservationToken");
    expect(rendering.runtimeResources.editor).toEqual(expect.objectContaining({ activeRenderIds: ["render-runtime-resource"], activeRenderPids: [process.pid], foregroundCapacity: 1, renderCapacity: 1, activeRenderBlocksForegroundJobs: true }));
    expect(rendering.runtimeResources.blockedActions).toEqual(expect.arrayContaining(["prepare_edit_media_proxy", "extract_timeline_frame", "start_edit_render"]));
    expect(rendering.suggestedNextCalls).toEqual(["get_edit_render_job", "get_project_snapshot"]);

    await writeJsonAtomic(paths.editorRenders, { schemaVersion: 1, jobs: [] });
    const foreground = await withProjectLock(root, "editor-media-capacity", () => getProjectSnapshot(root));
    expect(foreground.runtimeResources.editor).toEqual(expect.objectContaining({ foregroundMediaActive: true, foregroundMediaPid: process.pid, activeRenderIds: [] }));
    expect(foreground.suggestedNextCalls).toEqual(["get_project_snapshot"]);

    const scanning = await withProjectLock(root, "scan", () => getProjectSnapshot(root));
    expect(scanning.runtimeResources.scan).toEqual(expect.objectContaining({ active: true, pid: process.pid }));
    expect(scanning.runtimeResources.locks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "scan", stale: false })]));
    const capabilities = await getCapabilities(root);
    expect(capabilities.editor.mediaScheduling).toEqual(expect.objectContaining({ scope: "machine-cross-project-cross-process", algorithm: "strict-weighted-fifo", machineCapacity: 4, weights: { ffprobe: 1, foregroundFfmpeg: 2, renderFfmpeg: 3 } }));
    expect(capabilities.editor.features).toContain("custom-bezier-curves");
    expect(capabilities.editor.features).toContain("arbitrary-keyframe-curve-subdivision");
    expect(capabilities.editor.features).toContain("main-track-transform-keyframes");
    expect(capabilities.editor.features).toContain("complex-nested-timelines");
    expect(capabilities.editor.features).toContain("otio-linear-time-warp");
    expect(capabilities.editor.features).toContain("otio-smpte-dissolve");
    expect(capabilities.editor.keyframeCurves).toEqual(expect.objectContaining({
      contractVersion: 2,
      scope: "all-visual-tracks",
      segmentOwnership: "destination-keyframe-controls-entering-segment",
      custom: expect.objectContaining({ easing: "cubic_bezier", field: "bezier", authored: expect.objectContaining({ mode: "unit", controlPointRange: [0, 1], editable: true }), derived: expect.objectContaining({ mode: "derived_monotone", editable: false, semanticAuthority: "sourceWindow+sourceTransform", sourceTransform: "original-segment-start-and-end-transform-anchors" }) }),
      persistence: expect.objectContaining({ updateClipCas: true, undoRedoSnapshots: true, maxPerClip: 200, duplicateFramePolicy: "reject" }),
      editing: expect.objectContaining({ splitTrim: "arbitrary-frame-lossless-subdivision", arbitraryCurveSubdivision: true, quantization: "project-integer-frame" }),
      otio: expect.objectContaining({ contract: "aicanvas.cubic-bezier.v2", acceptedContracts: ["aicanvas.cubic-bezier.v1", "aicanvas.cubic-bezier.v2"], portability: "aicanvas-private-metadata", foreignCurvePolicy: "reject" }),
    }));
    expect(capabilities.editor.nestedTimelines).toEqual(expect.objectContaining({
      contractVersion: 1,
      clipKind: "timeline",
      contract: "aicanvas.nested-timeline.v1",
      renderContract: "aicanvas.nested-timeline.ffmpeg.v1",
      maximumDepth: 8,
      snapshots: expect.objectContaining({ immutable: true, contentAddressedSha256: true, historyIndependent: true, tamperDetection: true, refreshPolicy: "explicit-current-child-revision" }),
      timeMapping: expect.objectContaining({ parentAuthority: "integer-frame", childAuthority: "reduced-rational-source-offset-and-step", fractionalTimebases: true, splitTrimLossless: true }),
      editing: expect.objectContaining({ operations: ["add_nested_timeline", "refresh_nested_timeline"], revisionCas: true, genericPatchCannotForgeReference: true }),
      resolver: expect.objectContaining({ recursive: true, cycleDetection: true, depthLimit: 8, dependencyManifestSha256: true, renderPlanSha256: true, consumers: ["synchronous-render", "background-render", "timeline-frame", "timeline-continuation", "electron-preview"] }),
      media: expect.objectContaining({ childVisualTracks: true, childAudio: true, childSubtitles: true, browserPreview: "content-addressed-h264-aac-mp4" }),
      provenance: expect.objectContaining({ dependencyRefs: true, recursiveSourceClipRefs: true, renderJob: true, publicationReceipt: true, continuationPack: true }),
      otio: expect.objectContaining({ contract: "aicanvas.nested-timeline.v1", container: "Stack.1-private-subset", roundTrip: true, unknownStructurePolicy: "reject" }),
      mcp: expect.objectContaining({ tool: "apply_edit_operation", commandBus: "execute_command", operations: ["add_nested_timeline", "refresh_nested_timeline"], idempotentReplay: true }),
    }));
    expect(capabilities.editor.effectTransitions).toEqual(expect.objectContaining({
      contractVersion: 1,
      contract: "aicanvas.otio-effect-transition.v1",
      linearTimeWarp: expect.objectContaining({ schema: "LinearTimeWarp.1", effectName: "LinearTimeWarp", scalarRange: [.1, 8], requiresVerifiedLocalAvailableRange: true, genericEffectPolicy: "reject" }),
      smpteDissolve: expect.objectContaining({ schema: "Transition.1", transitionType: "SMPTE_Dissolve", offsets: "positive-integer-frames", audioPolicy: "independent-audio-track-time-unchanged" }),
      rendering: expect.objectContaining({ synchronous: true, background: true, timelineFrame: true, continuation: true, fractionalTimebase: true }),
      roundTrip: expect.objectContaining({ import: true, export: true, reimport: true, unknownOrOpaquePolicy: "reject" }),
      mcp: expect.objectContaining({ operation: "update_clip", idempotentReplay: true }),
    }));
    expect(capabilities.editor.missingForFullNle).not.toContain("custom-bezier-curves");
    expect(capabilities.editor.missingForFullNle).not.toContain("arbitrary-keyframe-curve-subdivision");
    expect(capabilities.editor.missingForFullNle).not.toContain("main-track-transform-keyframes");
    expect(capabilities.editor.missingForFullNle).not.toContain("complex-nested-timelines");
    expect(capabilities.editor.missingForFullNle).not.toContain("third-party-effect-compatibility");
    expect(capabilities.editor.missingForFullNle).toEqual([]);
    expect(capabilities.publication.registrationConsistency).toEqual(expect.objectContaining({ mode: "two-phase-snapshot-validate-cas", persistentValidationState: false, validationOutsideProjectLock: true, sha256Source: "fixed-o_nofollow-file-descriptor", concurrentSameIntent: "single-receipt", cancellationWinsOverStaleValidation: true, stableMechanicalFailure: "confirmed-failed" }));
    expect(capabilities.generation.httpRemoteRecovery).toEqual(expect.objectContaining({ observationStates: ["pending", "succeeded", "confirmed_failed", "retryable_or_unknown"], observationStages: ["submit", "poll", "download", "validation", "publish"], stableClientJobId: true, persistRemoteIdentityBeforeDownload: true, retryablePollErrorsRemainWaitingRemote: true, publicationReservationPreservedAcrossRetries: true, automaticPostReplayAfterUnknown: false, isolatedDownloadPerJob: true, partialFileNeverSignalsCompletion: true, verifiedNoClobberPromotion: true, resultRedirectRevalidated: true, terminalRemoteFailureRequiresStructuredFailureValue: true, remoteResultExposure: "hostname-only", remoteResultPersistence: "local-sidecar-only", recoveryScope: "single-job", waitingRemoteRecoveryAction: "process_generation_queue(jobId)", submissionUnknownRecoveryAction: "reconcile_http_generation_submission(jobId,expectedRevision,reconciliation)", submissionUnknownReconciliationCAS: true, submissionUnknownNotFoundRequiresExplicitConfirmation: true, submissionUnknownReconciliationMakesRemoteRequests: false, generationPublicationTerminalRequiresStructuredProvenance: true }));
    const doctor = await doctorProject(root);
    expect(doctor.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "machine-media-runtime", level: "ok", detail: expect.stringContaining("容量 0/4") })]));
  });

  it("Doctor 与统一快照阻断 completed 阶段的真实证据漂移", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-production-drift-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_证据漂移");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：雾中进入。\n尾帧提示词：保持连续。\n", "utf8");
    await scanAndPersist(root);
    const novelPath = path.join(root, "证据漂移小说.md");
    await writeFile(novelPath, "# 第一章\n\n阿航握紧完整黄金面具，走入雾中。\n", "utf8");
    const imported = await importStoryFile(root, novelPath);
    await updateProductionWorkflowStage(root, { stageId: "source", status: "completed", evidencePaths: [imported.source.snapshotPath], expectedRevision: 0 });
    await writeFile(novelPath, "# 第一章\n\n外部程序改写了原始导入文件。\n", "utf8");

    const report = await doctorProject(root);
    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "production-evidence-drift", level: "error", detail: expect.stringContaining("原始导入文件内容已变化") }),
      expect.objectContaining({ id: "production-evidence-verification", level: "ok" }),
    ]));
    expect(report.productionEvidence).toMatchObject({ repairRequired: true, counts: { invalidCompleted: 1, legacyUnverified: 0 }, blockers: [expect.objectContaining({ stageId: "source", statusEvidenceValid: false })], nextRepair: { stageId: "source", reason: "evidence_drift", mustRepairEvidenceFirst: true, executeCommand: { tool: "execute_command", requestIdHint: "request-production-source-r1", idempotencyKeyHint: "production-evidence-source-r1", request: { command: "update_workflow_stage", payload: { stageId: "source", status: "completed", expectedRevision: 1 } } } } });
    expect(report.suggestedNextCalls).toEqual(["get_production_workflow", "execute_command", "doctor_project"]);

    const snapshot = await getProjectSnapshot(root);
    expect(snapshot.nextItems).toEqual([]);
    expect(snapshot.productionDesign.evidence).toMatchObject({ repairRequired: true, blockers: [expect.objectContaining({ stageId: "source", issues: expect.arrayContaining([expect.stringContaining("原始导入文件内容已变化")]) })] });
    expect(snapshot.productionDesign.workflow).not.toHaveProperty("evidenceAudit");
    expect(snapshot.suggestedNextCalls).toEqual(["get_production_workflow", "execute_command", "doctor_project"]);
  });

  it("旧 completed 状态缺少证据指纹时主动警告且只读检查不创建渲染侧车", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-production-legacy-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_旧状态");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：旧状态核验。\n尾帧提示词：保持连续。\n", "utf8");
    await scanAndPersist(root);
    const novelPath = path.join(root, "旧状态小说.txt");
    await writeFile(novelPath, "第一章 归来\n\n阿航回到祭坛。\n", "utf8");
    const imported = await importStoryFile(root, novelPath);
    const sourceCompleted = await updateProductionWorkflowStage(root, { stageId: "source", status: "completed", evidencePaths: [imported.source.snapshotPath], expectedRevision: 0 });
    const completed = await updateProductionWorkflowStage(root, { stageId: "chapters", status: "completed", evidencePaths: imported.chapters.map((chapter) => chapter.path), expectedRevision: sourceCompleted.revision });
    delete completed.stages[0]!.evidenceVerification;
    delete completed.stages[1]!.evidenceVerification;
    const paths = getSidecarPaths(root);
    await writeJsonAtomic(paths.productionWorkflow, completed);
    await rm(paths.editorRenders, { force: true });
    await Promise.all([rm(paths.editorProjects, { recursive: true, force: true }), rm(paths.editorContinuations, { recursive: true, force: true }), rm(paths.skills, { recursive: true, force: true })]);

    const report = await doctorProject(root);
    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "production-evidence-drift", level: "ok" }),
      expect.objectContaining({ id: "production-evidence-verification", level: "warning", detail: expect.stringContaining("原文导入") }),
    ]));
    expect(report.productionEvidence).toMatchObject({ repairRequired: false, counts: { invalidCompleted: 0, legacyUnverified: 2 }, legacyUnverifiedStages: [expect.objectContaining({ stageId: "source", ready: true }), expect.objectContaining({ stageId: "chapters", ready: true })], nextRepair: { stageId: "source", reason: "legacy_unverified", mustRepairEvidenceFirst: false, executeCommand: { requestIdHint: "request-production-source-r2", request: { command: "update_workflow_stage", payload: { expectedRevision: 2 } } } } });
    expect(report.suggestedNextCalls).toEqual(["get_production_workflow", "execute_command", "doctor_project"]);
    const snapshot = await getProjectSnapshot(root);
    expect(snapshot.productionDesign.evidence.counts.legacyUnverified).toBe(2);
    expect(snapshot.suggestedNextCalls).toEqual(["get_production_workflow", "execute_command", "doctor_project"]);
    await Promise.all([paths.editorRenders, paths.editorProjects, paths.editorContinuations, paths.skills].map((candidate) => expect(access(candidate)).rejects.toThrow()));
    const lockNames = await readdir(path.join(root, ".aicanvas", "locks")).catch(() => [] as string[]);
    expect(lockNames.filter((name) => name.startsWith("editor-renders"))).toEqual([]);
    const repair = snapshot.productionDesign.evidence.nextRepair!.executeCommand;
    await executeIdempotentCommand(root, { requestId: repair.requestIdHint, idempotencyKey: repair.idempotencyKeyHint, request: repair.request });
    await expect(executeIdempotentCommand(root, { requestId: "request-stale-production-repair", idempotencyKey: "stale-production-repair-r2", request: repair.request })).rejects.toThrow("生产工作流已被其他窗口更新");
    const afterFirstRepair = await getProjectSnapshot(root);
    expect(afterFirstRepair.productionDesign.evidence).toMatchObject({ counts: { legacyUnverified: 1, verifiedCompleted: 1 }, nextRepair: { stageId: "chapters", executeCommand: { request: { payload: { expectedRevision: 3 } } } } });
    const chapterRepair = afterFirstRepair.productionDesign.evidence.nextRepair!.executeCommand;
    await executeIdempotentCommand(root, { requestId: chapterRepair.requestIdHint, idempotencyKey: chapterRepair.idempotencyKeyHint, request: chapterRepair.request });
    const repairedReport = await doctorProject(root);
    expect(repairedReport.productionEvidence).toMatchObject({ repairRequired: false, counts: { invalidCompleted: 0, legacyUnverified: 0, verifiedCompleted: 2 }, nextRepair: undefined });
    expect(repairedReport.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "production-evidence-verification", level: "ok" })]));
  });

  it("主动暴露网页提交结果待对账任务并让统一快照优先恢复", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-browser-reconcile-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_网页对账测试");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：网页对账。\n尾帧提示词：保持连续。\n", "utf8");
    const index = await scanAndPersist(root);
    const now = new Date().toISOString();
    await writeFile(getSidecarPaths(root).generationJobs, `${JSON.stringify([{
      schemaVersion: 1,
      id: "gen-browser-reconcile-test",
      projectId: index.project.id,
      itemId: "main-ep01-unit001",
      providerId: "browser-test",
      kind: "image",
      status: "submission_unknown",
      prompt: "网页对账测试",
      referencePaths: [],
      storyboardRevision: 0,
      storyboardRows: [],
      expectedOutputPath: path.join(root, "网页结果_raw.png"),
      requestPath: path.join(root, ".aicanvas", "generation-requests", "gen-browser-reconcile-test.browser.json"),
      browserState: "submission_unknown",
      browserCheckpoint: { revision: 4, stage: "submission_unknown", updatedAt: now, submissionIntent: { clientJobId: "gen-browser-reconcile-test", attempt: 1, createdAt: now } },
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    }], null, 2)}\n`, "utf8");

    const report = await doctorProject(root);
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "generation-jobs", level: "warning", detail: expect.stringContaining("1 个提交结果待对账"), suggestedAction: expect.stringContaining("get_browser_generation_plan") })]));
    expect(report.suggestedNextCalls).toEqual(["list_generation_jobs", "get_browser_generation_plan", "list_command_ledger"]);
    const snapshot = await getProjectSnapshot(root);
    expect(snapshot.generationJobs[0]).toMatchObject({ id: "gen-browser-reconcile-test", status: "submission_unknown", browserCheckpoint: { revision: 4, stage: "submission_unknown", submissionIntent: { clientJobId: "gen-browser-reconcile-test", attempt: 1 } } });
    expect(snapshot.suggestedNextCalls).toEqual(["get_browser_generation_plan", "list_command_ledger", "update_browser_generation_job"]);
  });

  it("Doctor 与统一快照暴露 HTTP 暂态观测并只建议恢复同一任务", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-http-retry-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_HTTP恢复测试");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：HTTP 恢复。\n", "utf8");
    const index = await scanAndPersist(root);
    const now = new Date().toISOString();
    const partialPath = path.join(getSidecarPaths(root).generationDownloads, "gen-http-retry-test", "result.partial");
    await mkdir(path.dirname(partialPath), { recursive: true });
    await writeFile(partialPath, "isolated partial only", "utf8");
    await writeFile(getSidecarPaths(root).generationJobs, `${JSON.stringify([{
      schemaVersion: 1,
      id: "gen-http-retry-test",
      projectId: index.project.id,
      itemId: "main-ep01-unit001",
      providerId: "http-test",
      kind: "image",
      status: "waiting_remote",
      prompt: "HTTP 恢复测试",
      referencePaths: [],
      storyboardRevision: 0,
      storyboardRows: [],
      expectedOutputPath: path.join(root, "HTTP恢复_raw.png"),
      clientJobId: "gen-http-retry-test",
      submissionIntent: { clientJobId: "gen-http-retry-test", attempt: 1, createdAt: now },
      externalTaskId: "remote-42",
      remoteResultUrl: "https://cdn.example/result.png?signature=must-not-leak",
      remoteAcceptedAt: now,
      remoteObservation: { state: "retryable_or_unknown", stage: "download", observedAt: now, httpStatus: 503, message: "下载中断", retryCount: 2, nextAction: "retry_same_task" },
      isolatedDownloadPath: path.join(path.dirname(partialPath), "result.ready"),
      partialDownloadPath: partialPath,
      pollAttempts: 4,
      downloadAttempts: 1,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    }], null, 2)}\n`, "utf8");

    const report = await doctorProject(root);
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "generation-jobs", level: "warning", detail: expect.stringContaining("1 个远端暂态/未知错误可定向恢复"), suggestedAction: expect.stringContaining("不会重新 POST") })]));
    expect(report.suggestedNextCalls).toEqual(["list_generation_jobs", "process_generation_queue", "doctor_project"]);
    const snapshot = await getProjectSnapshot(root);
    expect(snapshot.runtimeResources.generation).toMatchObject({ activeJobIds: ["gen-http-retry-test"], byStatus: { waiting_remote: 1 } });
    expect(snapshot.generationJobs[0]).toMatchObject({ id: "gen-http-retry-test", clientJobId: "gen-http-retry-test", externalTaskId: "remote-42", remoteObservation: { state: "retryable_or_unknown", stage: "download", httpStatus: 503, nextAction: "retry_same_task" }, partialDownloadPath: partialPath, pollAttempts: 4, downloadAttempts: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(snapshot.suggestedNextCalls).toEqual(["list_generation_jobs", "process_generation_queue", "doctor_project"]);
  });

  it("索引损坏时返回明确错误而不是回退为空项目", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-index-"));
    roots.push(root);
    await ensureSidecar(root);
    await writeFile(getSidecarPaths(root).index, "{}", "utf8");

    const report = await doctorProject(root);
    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "index-corrupt", level: "error", paths: [getSidecarPaths(root).index] })]));
  });

  it("命令账本损坏时隔离该侧车并继续完成其他检查", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-ledger-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_医生测试");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：测试。\n尾帧提示词：测试。\n", "utf8");
    await scanAndPersist(root);
    const publication = await preflightPublication(root, { idempotencyKey: "doctor-publication-ready-001", requestedPath: path.join(root, "待注册结果.bin"), kind: "other", context: { purpose: "other", itemId: "main-ep01-unit001" } });
    await writeFile(publication.targetPath, "ready", "utf8");
    await writeFile(getSidecarPaths(root).config, "[]", "utf8");
    await writeFile(getSidecarPaths(root).commandLedger, `${JSON.stringify({ schemaVersion: 1, entries: null, updatedAt: new Date().toISOString() })}\n`, "utf8");
    await mkdir(path.dirname(getSidecarPaths(root).storyAdaptation), { recursive: true });
    await writeFile(getSidecarPaths(root).storyAdaptation, `${JSON.stringify({ schemaVersion: 1, revision: "broken" })}\n`, "utf8");
    await writeFile(getSidecarPaths(root).events, "{not-json}\n", "utf8");

    const report = await doctorProject(root);
    expect(report.healthy).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "index", level: "ok" }),
      expect.objectContaining({ id: "command-ledger-corrupt", level: "error" }),
      expect.objectContaining({ id: "config-corrupt", level: "error" }),
      expect.objectContaining({ id: "event-log-corrupt", level: "error" }),
      expect.objectContaining({ id: "adaptation-store-corrupt", level: "error" }),
      expect.objectContaining({ id: "mechanical" }),
      expect.objectContaining({ id: "publications", level: "warning" }),
    ]));
    expect(report.checks.some((check) => check.id === "command-ledger")).toBe(false);
  });

  it("核心生产侧车损坏时 Doctor 在统一快照失败前逐项报告", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-doctor-critical-"));
    roots.push(root);
    await ensureSidecar(root);
    const unit = path.join(root, "EP01_15s_001_核心侧车测试");
    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：测试。\n尾帧提示词：测试。\n", "utf8");
    await scanAndPersist(root);
    const paths = getSidecarPaths(root);
    const corruptFiles = [
      paths.productionWorkflow,
      paths.creativeBibles,
      paths.storyboards,
      paths.reviews,
      paths.canvasSemantic,
      paths.canvasHistory,
      paths.storyIndex,
      paths.storyEvents,
      paths.timeline,
      paths.editorSession,
      paths.context,
    ];
    for (const filePath of corruptFiles) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "{not-json}\n", "utf8");
    }
    await mkdir(paths.editorProjects, { recursive: true });
    await writeFile(path.join(paths.editorProjects, "corrupt.json"), "{not-json}\n", "utf8");
    await mkdir(paths.skills, { recursive: true });
    await writeFile(path.join(paths.skills, "broken skill.md"), "无效 Skill ID", "utf8");

    const report = await doctorProject(root);
    expect(report.healthy).toBe(false);
    const ids = new Set(report.checks.filter((check) => check.level === "error").map((check) => check.id));
    expect([...ids]).toEqual(expect.arrayContaining([
      "production-workflow-corrupt",
      "creative-bible-store-corrupt",
      "storyboard-store-corrupt",
      "review-store-corrupt",
      "canvas-store-corrupt",
      "canvas-history-corrupt",
      "story-index-corrupt",
      "story-event-store-corrupt",
      "timeline-store-corrupt",
      "editor-project-store-corrupt",
      "editor-session-corrupt",
      "skill-store-corrupt",
      "context-store-corrupt",
      "critical-sidecars",
    ]));
    expect(report.checks.find((check) => check.id === "critical-sidecars")?.detail).toContain("13 个核心生产侧车损坏");
  });
});
