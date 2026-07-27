import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

function parseToolResult(result: unknown): unknown {
  const response = result as { content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text ?? "{}";
  const parsed = JSON.parse(text) as { status?: string; result?: unknown };
  return parsed.status === "succeeded" && Object.hasOwn(parsed, "result") ? parsed.result : parsed;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

describe("stdio MCP 扫描进度与取消", () => {
  it("execute_command(scan_project) 传递进度和取消信号，并保留取消前稳定索引", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const root = path.join(os.tmpdir(), `ai-canvas-mcp-scan-cancel-${suffix}`);
    const registry = path.join(os.tmpdir(), `ai-canvas-mcp-scan-cancel-registry-${suffix}.json`);
    const directory = path.join(root, "EP09_15s_001_MCP取消");
    const pidPath = path.join(root, "mcp-fake-ffprobe.pid");
    const markerPath = path.join(root, "mcp-fake-ffprobe.terminated");
    const fakeProbe = path.join(root, "mcp-fake-ffprobe.mjs");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：验证 MCP 扫描取消。\n", "utf8");
    await writeFile(fakeProbe, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => { writeFileSync(${JSON.stringify(markerPath)}, "terminated"); process.exit(143); });\nsetInterval(() => {}, 1000);\n`, "utf8");
    await chmod(fakeProbe, 0o755);

    const compiledServer = process.env.AI_CANVAS_MCP_SERVER_PATH?.trim();
    const packagedRuntime = process.env.AI_CANVAS_MCP_RUNTIME?.trim();
    const transport = new StdioClientTransport({
      command: packagedRuntime && compiledServer ? "/usr/bin/env" : process.execPath,
      args: packagedRuntime && compiledServer
        ? ["ELECTRON_RUN_AS_NODE=1", path.resolve(packagedRuntime), path.resolve(compiledServer)]
        : compiledServer ? [path.resolve(compiledServer)] : ["--import", "tsx", "src/mcp/server.ts"],
      cwd: process.cwd(),
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry, FFPROBE_PATH: fakeProbe },
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-canvas-mcp-scan-cancel-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const capabilities = parseToolResult(await client.callTool({ name: "get_capabilities", arguments: {} })) as {
        server: { protocolVersion: string };
        scan: { mcpProgressNotifications: boolean; cancellableCommands: string[]; cancellationBoundary: string; cancellationLedgerStatus: string; cancelledKeyReplay: boolean; reservedPublicationTargetsExcluded: boolean; publicationSnapshotAfterDiscovery: boolean };
        editor: { features: string[]; missingForFullNle: string[]; keyframeCurves: { contractVersion: number; scope: string; segmentOwnership: string; custom: { easing: string; authored: { mode: string; controlPointRange: number[] }; derived: { mode: string; semanticAuthority: string; sourceTransform: string } }; persistence: { updateClipCas: boolean; undoRedoSnapshots: boolean }; editing: { arbitraryCurveSubdivision: boolean; splitTrim: string }; otio: { contract: string; acceptedContracts: string[]; foreignCurvePolicy: string } }; nestedTimelines: { contractVersion: number; contract: string; renderContract: string; maximumDepth: number; snapshots: { contentAddressedSha256: boolean; refreshPolicy: string }; timeMapping: { parentAuthority: string; childAuthority: string; fractionalTimebases: boolean; splitTrimLossless: boolean }; resolver: { consumers: string[] }; otio: { container: string; unknownStructurePolicy: string }; mcp: { operations: string[]; idempotentReplay: boolean } }; effectTransitions: { contractVersion: number; contract: string; linearTimeWarp: { schema: string; effectName: string; genericEffectPolicy: string }; smpteDissolve: { schema: string; transitionType: string; offsets: string }; rendering: { fractionalTimebase: boolean }; roundTrip: { unknownOrOpaquePolicy: string }; mcp: { operation: string; idempotentReplay: boolean } }; mediaScheduling: { scope: string; algorithm: string; machineCapacity: number; weights: { ffprobe: number; foregroundFfmpeg: number; renderFfmpeg: number }; lifecycle: { boundedOutput: boolean; stageTimeouts: boolean; processGroupTermination: boolean; deadOwnerReaping: boolean } } };
        publication: { registrationConsistency: { mode: string; persistentValidationState: boolean; validationOutsideProjectLock: boolean; sha256Source: string; concurrentSameIntent: string; cancellationWinsOverStaleValidation: boolean; stableMechanicalFailure: string } };
        generation: { httpRemoteRecovery: { observationStates: string[]; observationStages: string[]; stableClientJobId: boolean; persistRemoteIdentityBeforeDownload: boolean; retryablePollErrorsRemainWaitingRemote: boolean; publicationReservationPreservedAcrossRetries: boolean; automaticPostReplayAfterUnknown: boolean; isolatedDownloadPerJob: boolean; partialFileNeverSignalsCompletion: boolean; verifiedNoClobberPromotion: boolean; resultRedirectRevalidated: boolean; terminalRemoteFailureRequiresStructuredFailureValue: boolean; remoteResultExposure: string; remoteResultPersistence: string; recoveryScope: string; waitingRemoteRecoveryAction: string; submissionUnknownRecoveryAction: string } };
      };
      expect(capabilities.server.protocolVersion).toBe("1.1");
      expect(capabilities.scan).toEqual(expect.objectContaining({ mcpProgressNotifications: true, cancellableCommands: ["scan_project"], cancellationBoundary: "before-index-commit", cancellationLedgerStatus: "cancelled", cancelledKeyReplay: false, reservedPublicationTargetsExcluded: true, publicationSnapshotAfterDiscovery: true }));
      expect(capabilities.editor.mediaScheduling).toEqual(expect.objectContaining({ scope: "machine-cross-project-cross-process", algorithm: "strict-weighted-fifo", machineCapacity: 4, weights: { ffprobe: 1, foregroundFfmpeg: 2, renderFfmpeg: 3 }, lifecycle: { boundedOutput: true, stageTimeouts: true, processGroupTermination: true, deadOwnerReaping: true } }));
      expect(capabilities.editor.features).toContain("custom-bezier-curves");
      expect(capabilities.editor.features).toContain("arbitrary-keyframe-curve-subdivision");
      expect(capabilities.editor.features).toContain("main-track-transform-keyframes");
    expect(capabilities.editor.features).toContain("complex-nested-timelines");
      expect(capabilities.editor.features).toContain("otio-linear-time-warp");
      expect(capabilities.editor.features).toContain("otio-smpte-dissolve");
      expect(capabilities.editor.missingForFullNle).not.toContain("custom-bezier-curves");
      expect(capabilities.editor.missingForFullNle).not.toContain("arbitrary-keyframe-curve-subdivision");
      expect(capabilities.editor.missingForFullNle).not.toContain("main-track-transform-keyframes");
      expect(capabilities.editor.missingForFullNle).not.toContain("complex-nested-timelines");
      expect(capabilities.editor.missingForFullNle).not.toContain("third-party-effect-compatibility");
      expect(capabilities.editor.missingForFullNle).toEqual([]);
      expect(capabilities.editor.keyframeCurves).toEqual(expect.objectContaining({ contractVersion: 2, scope: "all-visual-tracks", segmentOwnership: "destination-keyframe-controls-entering-segment", custom: expect.objectContaining({ easing: "cubic_bezier", authored: expect.objectContaining({ mode: "unit", controlPointRange: [0, 1] }), derived: expect.objectContaining({ mode: "derived_monotone", semanticAuthority: "sourceWindow+sourceTransform", sourceTransform: "original-segment-start-and-end-transform-anchors" }) }), persistence: expect.objectContaining({ updateClipCas: true, undoRedoSnapshots: true }), editing: expect.objectContaining({ arbitraryCurveSubdivision: true, splitTrim: "arbitrary-frame-lossless-subdivision" }), otio: expect.objectContaining({ contract: "aicanvas.cubic-bezier.v2", acceptedContracts: ["aicanvas.cubic-bezier.v1", "aicanvas.cubic-bezier.v2"], foreignCurvePolicy: "reject" }) }));
      expect(capabilities.editor.nestedTimelines).toEqual(expect.objectContaining({ contractVersion: 1, contract: "aicanvas.nested-timeline.v1", renderContract: "aicanvas.nested-timeline.ffmpeg.v1", maximumDepth: 8, snapshots: expect.objectContaining({ contentAddressedSha256: true, refreshPolicy: "explicit-current-child-revision" }), timeMapping: expect.objectContaining({ parentAuthority: "integer-frame", childAuthority: "reduced-rational-source-offset-and-step", fractionalTimebases: true, splitTrimLossless: true }), resolver: expect.objectContaining({ consumers: ["synchronous-render", "background-render", "timeline-frame", "timeline-continuation", "electron-preview"] }), otio: expect.objectContaining({ container: "Stack.1-private-subset", unknownStructurePolicy: "reject" }), mcp: expect.objectContaining({ operations: ["add_nested_timeline", "refresh_nested_timeline"], idempotentReplay: true }) }));
      expect(capabilities.editor.effectTransitions).toEqual(expect.objectContaining({ contractVersion: 1, contract: "aicanvas.otio-effect-transition.v1", linearTimeWarp: expect.objectContaining({ schema: "LinearTimeWarp.1", effectName: "LinearTimeWarp", genericEffectPolicy: "reject" }), smpteDissolve: expect.objectContaining({ schema: "Transition.1", transitionType: "SMPTE_Dissolve", offsets: "positive-integer-frames" }), rendering: expect.objectContaining({ fractionalTimebase: true }), roundTrip: expect.objectContaining({ unknownOrOpaquePolicy: "reject" }), mcp: expect.objectContaining({ operation: "update_clip", idempotentReplay: true }) }));
      expect(capabilities.publication.registrationConsistency).toEqual(expect.objectContaining({ mode: "two-phase-snapshot-validate-cas", persistentValidationState: false, validationOutsideProjectLock: true, sha256Source: "fixed-o_nofollow-file-descriptor", concurrentSameIntent: "single-receipt", cancellationWinsOverStaleValidation: true, stableMechanicalFailure: "confirmed-failed" }));
      expect(capabilities.generation.httpRemoteRecovery).toEqual(expect.objectContaining({ observationStates: ["pending", "succeeded", "confirmed_failed", "retryable_or_unknown"], observationStages: ["submit", "poll", "download", "validation", "publish"], stableClientJobId: true, persistRemoteIdentityBeforeDownload: true, retryablePollErrorsRemainWaitingRemote: true, publicationReservationPreservedAcrossRetries: true, automaticPostReplayAfterUnknown: false, isolatedDownloadPerJob: true, partialFileNeverSignalsCompletion: true, verifiedNoClobberPromotion: true, resultRedirectRevalidated: true, terminalRemoteFailureRequiresStructuredFailureValue: true, remoteResultExposure: "hostname-only", remoteResultPersistence: "local-sidecar-only", recoveryScope: "single-job", waitingRemoteRecoveryAction: "process_generation_queue(jobId)", submissionUnknownRecoveryAction: "reconcile_http_generation_submission(jobId,expectedRevision,reconciliation)", submissionUnknownReconciliationCAS: true, submissionUnknownNotFoundRequiresExplicitConfirmation: true, submissionUnknownReconciliationMakesRemoteRequests: false, generationPublicationTerminalRequiresStructuredProvenance: true }));
      const curveOperation = {
        type: "update_clip",
        clipId: "clip-mcp-curve",
        patch: { keyframes: [{ id: "kf-mcp-curve", timeSeconds: 1, easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 0, positionY: 0, scale: 1, rotation: 0 }] },
      };
      const acceptedCurve = await client.callTool({ name: "apply_edit_operation", arguments: { projectRoot: root, requestId: "request-mcp-curve-valid-001", idempotencyKey: "mcp-curve-valid-v1", editProjectId: "edit-missing-curve", expectedRevision: 1, operation: curveOperation } });
      expect(acceptedCurve.isError).toBe(true);
      expect(JSON.stringify(acceptedCurve)).toContain("找不到剪辑工程");
      const rejectedCurve = await client.callTool({ name: "apply_edit_operation", arguments: { projectRoot: root, requestId: "request-mcp-curve-invalid-001", idempotencyKey: "mcp-curve-invalid-v1", editProjectId: "edit-missing-curve", expectedRevision: 1, operation: { ...curveOperation, patch: { keyframes: [{ ...curveOperation.patch.keyframes[0], bezier: { x1: 1.2, y1: .1, x2: .25, y2: 1 } }] } } } }).then((result) => result, (error: unknown) => error);
      expect(JSON.stringify(rejectedCurve)).toMatch(/bezier|小于等于1|Too big/i);
      const acceptedNested = await client.callTool({ name: "apply_edit_operation", arguments: { projectRoot: root, requestId: "request-mcp-nested-valid-001", idempotencyKey: "mcp-nested-valid-v1", editProjectId: "edit-parent-missing", expectedRevision: 1, operation: { type: "add_nested_timeline", trackId: "track-main", childEditProjectId: "edit-child-missing", childExpectedRevision: 1, startFrame: 0 } } });
      expect(acceptedNested.isError).toBe(true);
      expect(JSON.stringify(acceptedNested)).toContain("找不到剪辑工程");
      const rejectedNested = await client.callTool({ name: "apply_edit_operation", arguments: { projectRoot: root, requestId: "request-mcp-nested-invalid-001", idempotencyKey: "mcp-nested-invalid-v1", editProjectId: "edit-parent-missing", expectedRevision: 1, operation: { type: "add_nested_timeline", trackId: "track-main", childEditProjectId: "edit-child-missing", childExpectedRevision: 1, startFrame: .5 } } }).then((result) => result, (error: unknown) => error);
      expect(JSON.stringify(rejectedNested)).toMatch(/integer|整数|Invalid/i);
      const baselineResult = await client.callTool({
        name: "scan_project",
        arguments: { projectRoot: root, requestId: "request-mcp-scan-baseline-001", idempotencyKey: "mcp-scan-baseline-v1" },
      });
      expect(baselineResult.isError).not.toBe(true);
      const baselineIndex = JSON.parse(await readFile(path.join(root, ".aicanvas", "index.json"), "utf8")) as { scanId: string };

      const createdEditRaw = await client.callTool({ name: "create_edit_project", arguments: { projectRoot: root, requestId: "request-mcp-subdivision-create-001", idempotencyKey: "mcp-subdivision-create-v2", name: "MCP 任意曲线分段", width: 320, height: 320, fps: 23.976, autoPopulate: false } });
      if (createdEditRaw.isError) throw new Error(JSON.stringify(createdEditRaw));
      expect(createdEditRaw.isError).not.toBe(true);
      const createdEdit = parseToolResult(createdEditRaw) as any;
      const mainTrack = createdEdit.tracks.find((track: any) => track.kind === "visual");
      mainTrack.clips.push({
        id: "clip-mcp-subdivision", trackId: mainTrack.id, kind: "video", name: "MCP 主画面曲线片段", sourcePath: path.join(directory, "00_信息.md"),
        startSeconds: 0, durationSeconds: 1.001, trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: 1, muted: true,
        positionX: -80, positionY: 0, scale: .25, rotation: 0, filter: "none", filterIntensity: 1,
        keyframes: [
          { id: "kf-mcp-start", frame: 0, timeSeconds: 0, easing: "hold", positionX: -80, positionY: 0, scale: .25, rotation: 0 },
          { id: "kf-mcp-middle", frame: 12, timeSeconds: .501, easing: "cubic_bezier", bezier: { x1: 1, y1: 0, x2: 0, y2: 1 }, positionX: 0, positionY: 20, scale: .4, rotation: 5 },
          { id: "kf-mcp-end", frame: 24, timeSeconds: 1.001, easing: "linear", positionX: 80, positionY: 0, scale: .25, rotation: 0 },
        ],
      });
      const savedEdit = parseToolResult(await client.callTool({ name: "save_edit_project", arguments: { projectRoot: root, requestId: "request-mcp-subdivision-save-001", idempotencyKey: "mcp-subdivision-save-v2", project: createdEdit, expectedRevision: createdEdit.revision } })) as any;
      const splitRequest = {
        projectRoot: root,
        requestId: "request-mcp-subdivision-split-001",
        idempotencyKey: "mcp-subdivision-split-v2",
        request: { command: "apply_edit_operation", payload: { editProjectId: savedEdit.id, expectedRevision: savedEdit.revision, operation: { type: "split_clip", clipId: "clip-mcp-subdivision", timeSeconds: .25 } } },
      };
      const splitRaw = await client.callTool({ name: "execute_command", arguments: splitRequest });
      expect(splitRaw.isError).not.toBe(true);
      const splitResult = parseToolResult(splitRaw) as any;
      expect(splitResult.revision).toBe(savedEdit.revision + 1);
      const replayRaw = await client.callTool({ name: "execute_command", arguments: { ...splitRequest, requestId: "request-mcp-subdivision-split-002" } });
      expect((replayRaw.structuredContent as any)?.replayed).toBe(true);
      expect((parseToolResult(replayRaw) as any).revision).toBe(splitResult.revision);
      const rightClipId = splitResult.affectedClipIds.find((id: string) => id !== "clip-mcp-subdivision") as string;
      const afterSplit = parseToolResult(await client.callTool({ name: "get_edit_project", arguments: { projectRoot: root, editProjectId: savedEdit.id } })) as any;
      const splitRight = afterSplit.tracks.flatMap((track: any) => track.clips).find((clip: any) => clip.id === rightClipId);
      expect(splitRight.keyframes[0]).toEqual(expect.objectContaining({ sourceTransform: { start: { positionX: -80, positionY: 0, scale: .25, rotation: 0 }, end: { positionX: 0, positionY: 20, scale: .4, rotation: 5 } }, bezier: expect.objectContaining({ mode: "derived_monotone", sourceWindow: expect.objectContaining({ sourceEasing: "cubic_bezier", startFrame: 6, endFrame: 12, totalFrames: 12 }) }) }));
      const trimRaw = await client.callTool({ name: "execute_command", arguments: {
        projectRoot: root,
        requestId: "request-mcp-subdivision-trim-001",
        idempotencyKey: "mcp-subdivision-trim-v2",
        request: { command: "apply_edit_operation", payload: { editProjectId: savedEdit.id, expectedRevision: splitResult.revision, operation: { type: "trim_to_playhead", clipId: rightClipId, timeSeconds: .375, side: "start" } } },
      } });
      expect(trimRaw.isError).not.toBe(true);
      const trimResult = parseToolResult(trimRaw) as any;
      const afterTrim = parseToolResult(await client.callTool({ name: "get_edit_project", arguments: { projectRoot: root, editProjectId: savedEdit.id } })) as any;
      const trimmedRight = afterTrim.tracks.flatMap((track: any) => track.clips).find((clip: any) => clip.id === rightClipId);
      expect(trimResult.revision).toBe(splitResult.revision + 1);
      expect(trimmedRight).toEqual(expect.objectContaining({ startFrame: 9, durationFrames: 15 }));
      expect(trimmedRight.keyframes[0]).toEqual(expect.objectContaining({ sourceTransform: { start: { positionX: -80, positionY: 0, scale: .25, rotation: 0 }, end: { positionX: 0, positionY: 20, scale: .4, rotation: 5 } }, bezier: expect.objectContaining({ mode: "derived_monotone", sourceWindow: expect.objectContaining({ sourceEasing: "cubic_bezier", startFrame: 9, endFrame: 12, totalFrames: 12 }) }) }));

      const videoPath = path.join(directory, "EP09_15s_001_MCP取消.mp4");
      await writeFile(videoPath, Buffer.alloc(60_000, 9));
      const controller = new AbortController();
      const progress: Array<{ progress?: number; message?: string }> = [];
      const running = client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: root,
          requestId: "request-mcp-scan-cancel-001",
          idempotencyKey: "mcp-scan-cancel-v1",
          request: { command: "scan_project", payload: {} },
        },
      }, undefined, {
        signal: controller.signal,
        timeout: 20_000,
        resetTimeoutOnProgress: true,
        onprogress: (value) => progress.push(value),
      });

      for (let attempt = 0; attempt < 400 && !(await exists(pidPath)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await exists(pidPath)).toBe(true);
      const probePid = Number(await readFile(pidPath, "utf8"));
      controller.abort("MCP 客户端主动取消扫描");
      await expect(running).rejects.toThrow("MCP 客户端主动取消扫描");

      let cancelled: { status?: string; error?: { message?: string } } | undefined;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const ledgerResult = parseToolResult(await client.callTool({
          name: "list_command_ledger",
          arguments: { projectRoot: root, limit: 20 },
        })) as Array<{ idempotencyKey: string; status: string; error?: { message?: string } }>;
        cancelled = ledgerResult.find((entry) => entry.idempotencyKey === "mcp-scan-cancel-v1");
        if (cancelled?.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(cancelled).toEqual(expect.objectContaining({ status: "cancelled", error: expect.objectContaining({ message: "MCP 客户端主动取消扫描" }) }));
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.map((entry) => entry.progress)).toEqual([...progress.map((entry) => entry.progress)].sort((a, b) => Number(a) - Number(b)));
      expect(progress.some((entry) => entry.message?.includes("机械验收"))).toBe(true);
      expect(await exists(markerPath)).toBe(true);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(probePid, 0); }
        catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(() => process.kill(probePid, 0)).toThrow();
      const stableIndex = JSON.parse(await readFile(path.join(root, ".aicanvas", "index.json"), "utf8")) as { scanId: string };
      expect(stableIndex.scanId).toBe(baselineIndex.scanId);
      expect(await exists(path.join(root, ".aicanvas", "locks", "scan.lock"))).toBe(false);

      const ledgerResult = parseToolResult(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: root, limit: 10 } })) as Array<{ idempotencyKey: string; status: string }>;
      expect(ledgerResult.find((entry) => entry.idempotencyKey === "mcp-scan-cancel-v1")?.status).toBe("cancelled");
      const replayCancelled = await client.callTool({
        name: "execute_command",
        arguments: { projectRoot: root, requestId: "request-mcp-scan-cancel-002", idempotencyKey: "mcp-scan-cancel-v1", request: { command: "scan_project", payload: {} } },
      });
      expect(replayCancelled.isError).toBe(true);
      expect(JSON.stringify(replayCancelled.structuredContent)).toContain("已明确取消");

      await rm(videoPath, { force: true });
      const retry = await client.callTool({
        name: "execute_command",
        arguments: { projectRoot: root, requestId: "request-mcp-scan-cancel-003", idempotencyKey: "mcp-scan-cancel-v2", request: { command: "scan_project", payload: {} } },
      });
      expect(retry.isError).not.toBe(true);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
      await rm(registry, { force: true });
    }
  }, 60_000);
});
