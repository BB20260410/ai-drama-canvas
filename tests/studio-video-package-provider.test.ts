import { createHash } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  finalizeDuduReadonlyManagedProject,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import {
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import {
  getStudioPostResultObservationControl,
  submitStudioPostResultObservation,
} from "../src/core/studio-post-result-observation.js";
import {
  getStudioProductionUnitSnapshot,
  reviseStudioProductionUnit,
} from "../src/core/studio-production.js";
import {
  buildAndVerifyStudioVideoPackage,
  discoverStudioVideoPackageTerminalCropReceiptLineage,
  getStudioVideoPackageControl,
  prepareStudioVideoPackageExport,
  prepareStudioVideoPackageSource,
} from "../src/core/studio-video-package.js";
import { createDuduReadonlySourceFixture } from "./helpers/dudu-readonly-source-fixture.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForPath(filePath: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await lstat(filePath).catch(() => null))) {
    if (Date.now() >= deadline) throw new Error(`等待测试路径超时：${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.sequential("Studio 视频包真实 provider 血缘", () => {
  it("Grok Review 产物沿既有 owner 生成 managed-evidence 静态视频包", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
    try {
      const staged = await stageDuduReadonlyManagedProject({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      });
      await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source);

      const unit = staged.receipt.units.find((entry) => entry.unitId === "S1E01-U28");
      expect(unit?.packId).toBeTruthy();
      const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, unit!.packId!);
      expect(pack).not.toBeNull();

      const generationRunId = "studio-video-provider-grok-fixture-run-1";
      await dispatchStudioGenerationPack(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "grok",
      });
      const preCallContext = await getActiveManagedStudioContext();
      const call = await prepareStudioImagegenCall(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "grok",
        projectContextToken: preCallContext.projectContextToken,
        commandRequestId: "studio-video-provider-grok-precall",
        expectedRevision: 0,
      });
      expect(call).toMatchObject({ callAllowed: true, provider: "grok", status: "generation_unknown" });

      const rawPath = path.join(fixture.root, "studio-video-provider-grok-raw.png");
      await sharp({
        create: { width: 900, height: 1600, channels: 3, background: { r: 38, g: 64, b: 88 } },
      }).png({ compressionLevel: 9 }).toFile(rawPath);
      const rawBytes = await readFile(rawPath);
      // pre-call 改变 Core nextAction，正式写回必须重新读取活动上下文。
      const commitContext = await getActiveManagedStudioContext();
      const committed = await commitAgentImagegenResultBundle(staged.shell.paths.root, {
        projectContextToken: commitContext.projectContextToken,
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "grok",
        rawPath,
        rawSha256: sha256(rawBytes),
        expectedRevision: pack!.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "grok",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: call.callId,
          model: "fixture-no-model",
          generatedAt: "2026-07-23T00:00:00.000Z",
        },
      });
      expect(committed).toMatchObject({
        provider: "grok",
        results: { pairComplete: true, raw: { provider: "grok" }, labeled: { provider: "grok" } },
      });

      const review = await submitStudioGenerationReview(staged.shell.paths.root, {
        operationId: "studio-video-provider-grok-review-pass",
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: committed.results.raw.resultId,
        rawSha256: committed.results.raw.mediaSha256,
        labeledResultId: committed.results.labeled.resultId,
        labeledSha256: committed.results.labeled.mediaSha256,
        expectedPackFingerprint: pack!.fingerprint,
        continuityFingerprint: pack!.continuityFingerprint,
        decision: "pass",
        criteria: [
          { code: "fixture-mechanical", status: "pass", note: "只验证 provider 与视频包软件闭环。" },
          { code: "fixture-identity", status: "pass", note: "确定性像素，不是模型视觉结论。" },
        ],
        reviewer: "studio-video-provider-test",
        note: "Grok fixture Review；不得解释为真实 Grok 或 Seedance canary。",
      });
      expect(review).toMatchObject({ decision: "pass", current: true, approvedRawEligible: true });
      const snapshot = await getStudioProductionUnitSnapshot(staged.shell.paths.root, pack!.target.unitId);
      const observationControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        review.generationRunId,
      );
      const managedSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: pack!.fingerprint,
        expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
        expectedObservationControlFingerprint: observationControl.fingerprint,
        expectedObservationHeadRevision: observationControl.headRevision,
        expectedObservationStatus: observationControl.status,
        expectedObservationHeadId: observationControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: observationControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: observationControl.head?.evidenceSha256 ?? null,
      });

      const authority = { kind: "studio-review" as const, reviewId: review.reviewId };
      const beforePrepare = await getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority,
      });
      const expectedManagedSource = {
          adapterKind: "managed-evidence-v1",
          reviewId: review.reviewId,
          expectedSourceFingerprint: managedSource.fingerprint,
          expectedReviewFingerprint: review.fingerprint,
          expectedPackFingerprint: pack!.fingerprint,
          expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
          expectedObservationControlFingerprint: observationControl.fingerprint,
          expectedObservationHeadRevision: observationControl.headRevision,
          expectedObservationStatus: observationControl.status,
          expectedObservationHeadId: observationControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: observationControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: observationControl.head?.evidenceSha256 ?? null,
      } as const;
      await expect(executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "studio-video-provider-missing-source-request",
        idempotencyKey: "studio-video-provider-missing-source-key",
        request: {
          command: "prepare_studio_video_package_export",
          payload: {
            authority,
            expectedRevision: pack!.target.unitRevision,
            expectedControlFingerprint: beforePrepare.fingerprint,
          },
        },
      })).rejects.toThrow(/载荷不符合合同/u);
      const preparedRecord = await executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "studio-video-provider-prepare-request",
        idempotencyKey: "studio-video-provider-prepare-key",
        request: {
          command: "prepare_studio_video_package_export",
          payload: {
            authority,
            expectedRevision: pack!.target.unitRevision,
            expectedControlFingerprint: beforePrepare.fingerprint,
            expectedManagedSource,
          },
        },
      });
      const prepared = preparedRecord.result as Awaited<ReturnType<typeof prepareStudioVideoPackageExport>>;
      expect(prepared.intent).toMatchObject({
        schemaVersion: 5,
        sourceClosureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const liveBuilderPath = path.join(
        prepared.intent.productionRoot,
        ...prepared.intent.builderRelativePath.split("/"),
      );
      const replacementBuilderPath = path.join(
        path.dirname(liveBuilderPath),
        ".studio-video-provider-replacement-builder.py",
      );
      await writeFile(
        replacementBuilderPath,
        "raise SystemExit('v5 build must not execute the replaced live builder')\n",
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(replacementBuilderPath, liveBuilderPath);
      const built = await buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        prepared.intent.intentId,
        { destinationPolicy: "managed-evidence-only" },
      );
      expect(built.receipt).toMatchObject({
        storageKind: "managed-evidence",
        mechanicalStatus: "verified",
        dynamicModelStatus: "not-run",
      });
      const videoSpecPath = path.join(
        staged.shell.paths.root,
        built.receipt.storageRelativePath,
        "S1E01-U28_video.json",
      );
      const videoSpec = JSON.parse(await readFile(videoSpecPath, "utf8")) as {
        generation?: { provider?: string; generation_run_id?: string };
      };
      expect(videoSpec.generation).toEqual(expect.objectContaining({
        provider: "grok",
        generation_run_id: generationRunId,
      }));

      const terminalPanel = [...pack!.panels].sort((left, right) =>
        left.endSeconds - right.endSeconds
        || left.order - right.order
        || left.panelId.localeCompare(right.panelId, "en")).at(-1)!;
      const terminalOffset = pack!.panels.findIndex(
        (panel) => panel.panelId === terminalPanel.panelId,
      );
      const terminalFile = `${pack!.target.unitId}-G${terminalOffset + 1}_raw.png`;
      const terminalMedia = await importStudioMedia(staged.shell.paths.root, {
        sourcePath: path.join(
          staged.shell.paths.root,
          built.receipt.storageRelativePath,
          terminalFile,
        ),
        kind: "image",
      });
      await expect(discoverStudioVideoPackageTerminalCropReceiptLineage(
        staged.shell.paths.root,
        {
          reviewId: review.reviewId,
          reviewFingerprint: review.fingerprint,
          generationRunId,
          rawResultId: committed.results.raw.resultId,
          rawSha256: committed.results.raw.mediaSha256,
          labeledResultId: committed.results.labeled.resultId,
          labeledSha256: committed.results.labeled.mediaSha256,
          packId: pack!.id,
          packFingerprint: pack!.fingerprint,
          terminalPanelId: terminalPanel.panelId,
          evidenceSha256: terminalMedia.sha256,
        },
      )).resolves.toMatchObject({
        status: "resolved",
        candidateCount: 1,
        lineage: {
          intentId: built.intent.intentId,
          receiptId: built.receipt.receiptId,
          filePath: terminalFile,
          fileSha256: terminalMedia.sha256,
        },
      });
      const observation = await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "studio-video-provider-terminal-observation",
        generationRunId,
        expectedHeadRevision: 0,
        expectedReviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        rawResultId: committed.results.raw.resultId,
        rawSha256: committed.results.raw.mediaSha256,
        labeledResultId: committed.results.labeled.resultId,
        labeledSha256: committed.results.labeled.mediaSha256,
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        plannedContinuityFingerprint: pack!.continuityFingerprint,
        evidenceKind: "terminal-panel-crop",
        evidenceSha256: terminalMedia.sha256,
        terminalPanelId: terminalPanel.panelId,
        observedState: {
          costume: "末格可见服装保持冻结。",
          injury: "末格伤势无法确认。",
          heldObject: "末格可见持物保持冻结。",
          position: "末格主体位于画面中央。",
          facing: "末格主体朝向画面左侧。",
          emotion: "末格表情警觉。",
          layout: "末格主体与场景锚点布局可见。",
          lighting: "末格左亮右暗。",
          referenceSha256: terminalMedia.sha256,
          motionVector: "静态裁图无法证明动作余势。",
          cameraPhase: "静态裁图无法证明镜头阶段。",
          focusState: "末格焦点落在主体。",
          audioPhase: "静态裁图无法证明声音尾相。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "observed",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "studio-video-provider-test",
        note: "真实 mechanically-verified 视频包末格裁图 observation。",
      });
      expect(observation).toMatchObject({
        evidenceContractVersion: 3,
        current: true,
        continuationEligible: true,
        evidenceLineage: {
          intentId: built.intent.intentId,
          intentFingerprint: built.intent.fingerprint,
          receiptId: built.receipt.receiptId,
          receiptFingerprint: built.receipt.fingerprint,
          manifestSha256: built.receipt.manifestSha256,
          manifestFingerprint: built.receipt.manifestFingerprint,
          filePath: terminalFile,
          fileSha256: terminalMedia.sha256,
        },
        observedState: {
          referenceSha256: terminalMedia.sha256,
          position: "末格主体位于画面中央。",
          focusState: "末格焦点落在主体。",
        },
      });
      expect(observation.observedState.injury).toBeUndefined();
      expect(observation.observedState.motionVector).toBeUndefined();

      const currentObservation = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        generationRunId,
      );
      expect(currentObservation).toMatchObject({
        status: "current",
        headRevision: 1,
        blockers: [],
      });
      const observedSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: pack!.fingerprint,
        expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
        expectedObservationControlFingerprint: currentObservation.fingerprint,
        expectedObservationHeadRevision: currentObservation.headRevision,
        expectedObservationStatus: currentObservation.status,
        expectedObservationHeadId: currentObservation.head?.observationId ?? null,
        expectedObservationHeadFingerprint: currentObservation.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: currentObservation.head?.evidenceSha256 ?? null,
      });
      const actual = observedSource.panels.at(-1)!.observed;
      if (actual.status !== "current") throw new Error("terminal observation did not project");
      expect(actual).toMatchObject({
        status: "current",
        endState: {
          referenceSha256: terminalMedia.sha256,
          position: "末格主体位于画面中央。",
          focusState: "末格焦点落在主体。",
        },
      });
      expect(actual.endState).not.toHaveProperty("injury");
      expect(actual.endState).not.toHaveProperty("motionVector");
      expect(JSON.stringify(observedSource)).not.toContain("末格伤势无法确认");
      expect(JSON.stringify(observedSource)).not.toContain("静态裁图无法证明动作余势");
    } finally {
      if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
      await fixture.cleanup();
    }
  }, 360_000);

  it("receipt 异步 CAS 返回后若 Observation 抢先提交，最终 source CAS 拒绝且不写 receipt", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
    const priorBarrier = process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
    process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
    try {
      const staged = await stageDuduReadonlyManagedProject({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      });
      await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source);
      const unit = staged.receipt.units.find((entry) => entry.unitId === "S1E01-U28");
      const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, unit!.packId!);
      expect(pack).not.toBeNull();

      const generationRunId = "studio-video-receipt-post-cas-run";
      await dispatchStudioGenerationPack(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
      });
      const preCallContext = await getActiveManagedStudioContext();
      const call = await prepareStudioImagegenCall(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        projectContextToken: preCallContext.projectContextToken,
        commandRequestId: "studio-video-receipt-post-cas-precall",
        expectedRevision: 0,
      });
      const rawPath = path.join(fixture.root, "studio-video-receipt-post-cas-raw.png");
      await sharp({
        create: { width: 900, height: 1600, channels: 3, background: { r: 44, g: 68, b: 92 } },
      }).png({ compressionLevel: 9 }).toFile(rawPath);
      const rawBytes = await readFile(rawPath);
      const commitContext = await getActiveManagedStudioContext();
      const committed = await commitAgentImagegenResultBundle(staged.shell.paths.root, {
        projectContextToken: commitContext.projectContextToken,
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        rawPath,
        rawSha256: sha256(rawBytes),
        expectedRevision: pack!.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "codex",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: call.callId,
          model: "fixture-no-model",
          generatedAt: "2026-07-23T00:00:00.000Z",
        },
      });
      const review = await submitStudioGenerationReview(staged.shell.paths.root, {
        operationId: "studio-video-receipt-post-cas-review",
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: committed.results.raw.resultId,
        rawSha256: committed.results.raw.mediaSha256,
        labeledResultId: committed.results.labeled.resultId,
        labeledSha256: committed.results.labeled.mediaSha256,
        expectedPackFingerprint: pack!.fingerprint,
        continuityFingerprint: pack!.continuityFingerprint,
        decision: "pass",
        criteria: [
          { code: "fixture-mechanical", status: "pass", note: "只验证 receipt CAS 事务门。" },
          { code: "fixture-identity", status: "pass", note: "确定性像素，不是视觉结论。" },
        ],
        reviewer: "studio-video-receipt-cas-test",
        note: "receipt post-CAS/pre-transaction 确定性竞态夹具。",
      });
      const snapshot = await getStudioProductionUnitSnapshot(staged.shell.paths.root, pack!.target.unitId);
      const observationControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        generationRunId,
      );
      expect(observationControl).toMatchObject({ status: "missing", headRevision: 0 });
      const managedSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: pack!.fingerprint,
        expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
        expectedObservationControlFingerprint: observationControl.fingerprint,
        expectedObservationHeadRevision: observationControl.headRevision,
        expectedObservationStatus: observationControl.status,
        expectedObservationHeadId: null,
        expectedObservationHeadFingerprint: null,
        expectedObservationEvidenceSha256: null,
      });
      const prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "studio-video-receipt-post-cas-export",
        authority: { kind: "studio-review", reviewId: review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: review.reviewId,
          expectedSourceFingerprint: managedSource.fingerprint,
          expectedReviewFingerprint: review.fingerprint,
          expectedPackFingerprint: pack!.fingerprint,
          expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
          expectedObservationControlFingerprint: observationControl.fingerprint,
          expectedObservationHeadRevision: observationControl.headRevision,
          expectedObservationStatus: observationControl.status,
          expectedObservationHeadId: null,
          expectedObservationHeadFingerprint: null,
          expectedObservationEvidenceSha256: null,
        },
      });

      const barrier = path.join(staged.shell.paths.root, "studio-video-receipt-post-cas-barrier");
      process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER = barrier;
      const buildOutcome = buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        prepared.intent.intentId,
        { destinationPolicy: "managed-evidence-only" },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForPath(`${barrier}.reached`);

      const evidencePath = path.join(fixture.root, "studio-video-receipt-post-cas-evidence.png");
      await sharp({
        create: { width: 450, height: 800, channels: 3, background: { r: 74, g: 93, b: 112 } },
      }).png({ compressionLevel: 9 }).toFile(evidencePath);
      const evidence = await importStudioMedia(staged.shell.paths.root, {
        sourcePath: evidencePath,
        kind: "image",
      });
      await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "studio-video-receipt-post-cas-observation",
        generationRunId,
        expectedHeadRevision: 0,
        expectedReviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        rawResultId: review.rawResultId,
        rawSha256: review.rawSha256,
        labeledResultId: review.labeledResultId,
        labeledSha256: review.labeledSha256,
        packId: review.packId,
        packFingerprint: review.packFingerprint,
        plannedContinuityFingerprint: review.continuityFingerprint,
        evidenceKind: "accepted-last-frame",
        evidenceSha256: evidence.sha256,
        observedState: {
          costume: "夹具服装状态。",
          injury: "夹具无可确认伤势。",
          heldObject: "夹具无可确认持物。",
          position: "夹具主体位于画面中央。",
          facing: "夹具主体朝向画面左侧。",
          emotion: "夹具表情平静。",
          layout: "夹具布局保持冻结。",
          lighting: "夹具光线保持冻结。",
          referenceSha256: evidence.sha256,
          motionVector: "静态图不可确认。",
          cameraPhase: "静态图不可确认。",
          focusState: "夹具焦点位于主体。",
          audioPhase: "静态图不可确认。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "unknown",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "studio-video-receipt-cas-test",
        note: "异步 CAS 返回后、receipt BEGIN IMMEDIATE 前推进 Observation Head。",
      });
      await writeFile(`${barrier}.release`, "release\n", { flag: "wx" });
      delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;

      const result = await buildOutcome;
      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" ? result.error : null).toMatchObject({ code: "input-drift" });
      const db = new DatabaseSync(staged.shell.paths.generationDatabase, { readOnly: true });
      try {
        const count = Number((db.prepare(`
          SELECT COUNT(*) AS count FROM studio_video_package_verify_receipts WHERE intent_id=?
        `).get(prepared.intent.intentId) as { count: number }).count);
        expect(count).toBe(0);
      } finally {
        db.close();
      }
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: prepared.intent.intentId,
      })).resolves.toMatchObject({ control: { status: "stale", receipt: null } });

    } finally {
      if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
      if (priorBarrier === undefined) {
        delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
      } else {
        process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER = priorBarrier;
      }
      await fixture.cleanup();
    }
  }, 600_000);

  it("receipt post-CAS barrier 内 Canonical Unit 漂移且 generation heads 不变时拒绝且 receipt=0", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
    const priorBarrier = process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
    process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
    try {
      const staged = await stageDuduReadonlyManagedProject({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      });
      await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source);
      const unit = staged.receipt.units.find((entry) => entry.unitId === "S1E01-U28");
      expect(unit?.packId).toBeTruthy();
      const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, unit!.packId!);
      expect(pack).not.toBeNull();

      const generationRunId = "studio-video-receipt-post-cas-unit-run";
      await dispatchStudioGenerationPack(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
      });
      const preCallContext = await getActiveManagedStudioContext();
      const call = await prepareStudioImagegenCall(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        projectContextToken: preCallContext.projectContextToken,
        commandRequestId: "studio-video-receipt-post-cas-unit-precall",
        expectedRevision: 0,
      });
      const rawPath = path.join(fixture.root, "studio-video-receipt-post-cas-unit-raw.png");
      await sharp({
        create: { width: 900, height: 1600, channels: 3, background: { r: 53, g: 72, b: 91 } },
      }).png({ compressionLevel: 9 }).toFile(rawPath);
      const rawBytes = await readFile(rawPath);
      const commitContext = await getActiveManagedStudioContext();
      const committed = await commitAgentImagegenResultBundle(staged.shell.paths.root, {
        projectContextToken: commitContext.projectContextToken,
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        rawPath,
        rawSha256: sha256(rawBytes),
        expectedRevision: pack!.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "codex",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: call.callId,
          model: "fixture-no-model",
          generatedAt: "2026-07-23T00:00:00.000Z",
        },
      });
      const review = await submitStudioGenerationReview(staged.shell.paths.root, {
        operationId: "studio-video-receipt-post-cas-unit-review",
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: committed.results.raw.resultId,
        rawSha256: committed.results.raw.mediaSha256,
        labeledResultId: committed.results.labeled.resultId,
        labeledSha256: committed.results.labeled.mediaSha256,
        expectedPackFingerprint: pack!.fingerprint,
        continuityFingerprint: pack!.continuityFingerprint,
        decision: "pass",
        criteria: [
          { code: "fixture-mechanical", status: "pass", note: "只验证 receipt CAS 事务门。" },
          { code: "fixture-identity", status: "pass", note: "确定性像素，不是视觉结论。" },
        ],
        reviewer: "studio-video-receipt-unit-cas-test",
        note: "Canonical Unit post-CAS/pre-transaction 确定性竞态夹具。",
      });
      const snapshot = await getStudioProductionUnitSnapshot(staged.shell.paths.root, pack!.target.unitId);
      expect(snapshot).not.toBeNull();
      const observationControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        generationRunId,
      );
      expect(observationControl).toMatchObject({ status: "missing", headRevision: 0 });
      const managedSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: pack!.fingerprint,
        expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
        expectedObservationControlFingerprint: observationControl.fingerprint,
        expectedObservationHeadRevision: observationControl.headRevision,
        expectedObservationStatus: observationControl.status,
        expectedObservationHeadId: null,
        expectedObservationHeadFingerprint: null,
        expectedObservationEvidenceSha256: null,
      });
      const prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "studio-video-receipt-post-cas-unit-export",
        authority: { kind: "studio-review", reviewId: review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: review.reviewId,
          expectedSourceFingerprint: managedSource.fingerprint,
          expectedReviewFingerprint: review.fingerprint,
          expectedPackFingerprint: pack!.fingerprint,
          expectedUnitSnapshotFingerprint: snapshot!.fingerprint,
          expectedObservationControlFingerprint: observationControl.fingerprint,
          expectedObservationHeadRevision: observationControl.headRevision,
          expectedObservationStatus: observationControl.status,
          expectedObservationHeadId: null,
          expectedObservationHeadFingerprint: null,
          expectedObservationEvidenceSha256: null,
        },
      });

      const readGenerationHeads = async () => {
        const db = new DatabaseSync(staged.shell.paths.generationDatabase, { readOnly: true });
        let reviewHead: unknown;
        try {
          reviewHead = db.prepare(`
            SELECT review_id,review_fingerprint FROM studio_generation_review_heads
            WHERE generation_run_id=?
          `).get(generationRunId);
        } finally {
          db.close();
        }
        const observationHead = await getStudioPostResultObservationControl(
          staged.shell.paths.root,
          generationRunId,
        );
        return {
          review: reviewHead,
          observation: {
            status: observationHead.status,
            headRevision: observationHead.headRevision,
            headId: observationHead.head?.observationId ?? null,
            headFingerprint: observationHead.head?.fingerprint ?? null,
          },
        };
      };
      const headsBeforeUnitDrift = await readGenerationHeads();
      const barrier = path.join(
        staged.shell.paths.root,
        "studio-video-receipt-post-cas-unit-barrier",
      );
      process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER = barrier;
      const buildOutcome = buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        prepared.intent.intentId,
        { destinationPolicy: "managed-evidence-only" },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForPath(`${barrier}.reached`);

      let headsAfterUnitDrift: Awaited<ReturnType<typeof readGenerationHeads>> | null = null;
      try {
        await reviseStudioProductionUnit(staged.shell.paths.root, {
          unitId: snapshot!.unit.id,
          expectedRevision: snapshot!.unit.revision,
          season: snapshot!.unit.season,
          episode: snapshot!.unit.episode,
          sequence: snapshot!.unit.sequence,
          title: `${snapshot!.unit.title}（receipt barrier 修订）`,
          durationSeconds: snapshot!.unit.durationSeconds,
          scriptRevisionId: snapshot!.unit.scriptRevisionId,
          panels: snapshot!.panels.map((panel) => ({
            id: panel.id,
            title: panel.title,
            visualAction: panel.visualAction,
            shotComposition: panel.shotComposition,
            filmingMethod: panel.filmingMethod,
            dialogue: panel.dialogue,
            subtitle: panel.subtitle,
            startSeconds: panel.startSeconds,
            endSeconds: panel.endSeconds,
            durationSeconds: panel.durationSeconds,
            promptRevisionId: panel.promptRevisionId,
            sourceSpans: panel.sourceSpans.map((span) => ({
              startOffsetUtf16: span.startOffsetUtf16,
              endOffsetUtf16: span.endOffsetUtf16,
            })),
            assets: panel.assets.map((asset) => ({
              assetId: asset.assetId,
              category: asset.category,
              presence: asset.presence,
              role: asset.role,
              continuityState: asset.continuityState,
              evidence: asset.evidence.map((evidence) => ({
                kind: evidence.kind,
                reference: evidence.reference,
                note: evidence.note,
              })),
            })),
            transition: panel.transition,
            costumeState: panel.costumeState,
            sceneLighting: panel.sceneLighting,
            shotType: panel.shotType,
            negativePrompt: panel.negativePrompt,
          })),
        });
        headsAfterUnitDrift = await readGenerationHeads();
      } finally {
        await writeFile(`${barrier}.release`, "release\n", { flag: "wx" }).catch(() => undefined);
        delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
      }
      expect(headsAfterUnitDrift).toEqual(headsBeforeUnitDrift);

      const result = await buildOutcome;
      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" ? result.error : null).toMatchObject({ code: "input-drift" });
      const receiptDb = new DatabaseSync(staged.shell.paths.generationDatabase, { readOnly: true });
      try {
        const count = Number((receiptDb.prepare(`
          SELECT COUNT(*) AS count FROM studio_video_package_verify_receipts WHERE intent_id=?
        `).get(prepared.intent.intentId) as { count: number }).count);
        expect(count).toBe(0);
      } finally {
        receiptDb.close();
      }
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: prepared.intent.intentId,
      })).resolves.toMatchObject({ control: { status: "stale", receipt: null } });
    } finally {
      if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
      if (priorBarrier === undefined) {
        delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
      } else {
        process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER = priorBarrier;
      }
      await fixture.cleanup();
    }
  }, 600_000);
});
