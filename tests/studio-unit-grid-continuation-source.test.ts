import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildStudioUnitGridAgentImagegenBrief,
  getStudioGenerationControlEnvelope,
} from "../src/core/codex.js";
import {
  finalizeDuduReadonlyManagedProject,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import {
  __setBeforeImagegenIntentTransactionHookForTests,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  readStudioImagegenCallIntentByRun,
  readStudioUnitGridGenerationFrozenPack,
  registerStudioGenerationResultBundle,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  getStudioPostResultObservationControl,
  submitStudioPostResultObservation,
} from "../src/core/studio-post-result-observation.js";
import { buildNextShotContinuitySnapshot } from "../src/core/studio-next-shot-continuity.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  assertStudioUnitGridGenerationFreezePackCurrent,
  buildStudioUnitGridGenerationFreezePack,
} from "../src/core/studio-unit-grid-generation.js";
import {
  __setStudioRequestSchemaCacheObserverForTests,
} from "../src/core/studio-request-schema-cache.js";
import {
  buildAndVerifyStudioVideoPackage,
  prepareStudioVideoPackageExport,
  prepareStudioVideoPackageSource,
} from "../src/core/studio-video-package.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  studioP7ContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";
import { createDuduReadonlySourceFixture } from "./helpers/dudu-readonly-source-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  __setBeforeImagegenIntentTransactionHookForTests(null);
  __setStudioRequestSchemaCacheObserverForTests(null);
  await fixture?.cleanup();
  fixture = undefined;
});

describe("unit-grid 上一单元 actual-tail 连续来源", () => {
  it("六格 build 每个 SQLite 深验域只执行一次，final currentness 使用全新 epoch", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const marks: string[] = [];
    __setStudioRequestSchemaCacheObserverForTests((event) => {
      if (event.kind === "mark") marks.push(event.cacheKey.split("\u0000", 1)[0]!);
    });

    const pack = await buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.sixPanel.unit.id,
    });
    const namespaces = [
      "material-studio-schema-v1",
      "studio-production-schema-v6",
      "studio-generation-preflight-v7",
      "studio-generation-schema-v7",
      "studio-continuity-schema-v1",
      "studio-continuity-content-v1",
    ];
    for (const namespace of namespaces) {
      expect(marks.filter((entry) => entry === namespace), namespace).toHaveLength(1);
    }

    await assertStudioUnitGridGenerationFreezePackCurrent(fixture.root, pack);
    for (const namespace of namespaces) {
      expect(marks.filter((entry) => entry === namespace), namespace).toHaveLength(2);
    }

    marks.length = 0;
    const readiness = await getStudioGenerationControlEnvelope(fixture.root, {
      operation: "readiness",
      targetKind: "unit-grid",
      unitId: fixture.units.sixPanel.unit.id,
    });
    expect(readiness).toMatchObject({ status: "ready", targetKind: "unit-grid" });
    // 初建 epoch + final currentness fresh epoch；逐格 media CAS 复核不能触发额外
    // material 全量 schema 初始化。
    expect(marks.filter((entry) => entry === "material-studio-schema-v1")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-production-schema-v6")).toHaveLength(3);
    for (const namespace of namespaces.slice(2)) {
      expect(marks.filter((entry) => entry === namespace), namespace).toHaveLength(2);
    }

  }, 120_000);

  it("六格 freeze 与 pack 投影复用请求内深验且保留 final fresh epoch", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const marks: string[] = [];
    __setStudioRequestSchemaCacheObserverForTests((event) => {
      if (event.kind === "mark") marks.push(event.cacheKey.split("\u0000", 1)[0]!);
    });
    const persisted = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.sixPanel.unit.id,
    });
    expect(marks.filter((entry) => entry === "material-studio-schema-v1")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-production-schema-v6")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-continuity-schema-v1")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-continuity-content-v1")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-generation-preflight-v7")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-generation-schema-v7")).toHaveLength(4);

    marks.length = 0;
    const projectedPack = await getStudioGenerationControlEnvelope(fixture.root, {
      operation: "pack",
      packId: persisted.packId,
    });
    expect(projectedPack).toMatchObject({
      status: "ready",
      targetKind: "unit-grid",
      controlReferencesExposed: true,
    });
    expect(marks.filter((entry) => entry === "material-studio-schema-v1")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-production-schema-v6")).toHaveLength(1);
    expect(marks.filter((entry) => entry === "studio-continuity-schema-v1")).toHaveLength(1);
    expect(marks.filter((entry) => entry === "studio-continuity-content-v1")).toHaveLength(1);
    expect(marks.filter((entry) => entry === "studio-generation-preflight-v7")).toHaveLength(2);
    expect(marks.filter((entry) => entry === "studio-generation-schema-v7")).toHaveLength(2);
  }, 180_000);

  it("sequence > 1 默认缺 actual-tail 即阻断；显式审计豁免进入 pack 指纹", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);

    await expect(buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
    })).rejects.toMatchObject({ code: "previous-review-invalid" });

    const first = await buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
        fixture.root,
        fixture.units.twoPanel,
        "decision:continuation-waiver:test-001",
      ),
    });
    const second = await buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
        fixture.root,
        fixture.units.twoPanel,
        "decision:continuation-waiver:test-002",
      ),
    });
    expect(first.continuationSource).toBeUndefined();
    expect(first.continuationWaiver).toMatchObject({
      kind: "studio-unit-grid-continuation-waiver",
      authorityKind: "verified-historical-import",
      authorizationEvidenceReference: "test-fixture:decision:continuation-waiver:test-001",
    });
    expect(first.request.continuationWaiver).toEqual(first.continuationWaiver);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  }, 180_000);

  it("v4 结构化末格成为 v3 下一镜来源；Observation 漂移使旧 pack stale；paid-call CAS 拦截 Review 竞态", async () => {
    const dudu = await createDuduReadonlySourceFixture();
    const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = dudu.registryPath;
    try {
      const staged = await stageDuduReadonlyManagedProject({
        projectsRoot: dudu.projectsRoot,
        source: dudu.source,
      });
      await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, dudu.source);
      const projectRoot = staged.shell.paths.root;
      const previousUnitId = "S1E01-U28";
      const nextUnitId = "S1E01-U29";
      const previousSnapshot = await getStudioProductionUnitSnapshot(projectRoot, previousUnitId);
      expect(previousSnapshot).not.toBeNull();

      const previousUnitReceipt = staged.receipt.units.find(
        (unit) => unit.unitId === previousUnitId,
      );
      expect(previousUnitReceipt?.packId).toBeTruthy();
      const ownerPreviousPack = await readStudioUnitGridGenerationFrozenPack(
        projectRoot,
        previousUnitReceipt!.packId!,
      );
      expect(ownerPreviousPack).not.toBeNull();
      const previousPack = {
        packId: ownerPreviousPack!.id,
        fingerprint: ownerPreviousPack!.fingerprint,
        pack: ownerPreviousPack!,
      };
      const previousRunId = "dudu-next-shot-actual-tail-u28-run";
      await dispatchStudioGenerationPack(projectRoot, {
        packId: previousPack.packId,
        packFingerprint: previousPack.fingerprint,
        generationRunId: previousRunId,
        provider: "codex",
      });
      const previousCall = await prepareStudioImagegenCall(projectRoot, {
        packId: previousPack.packId,
        packFingerprint: previousPack.fingerprint,
        generationRunId: previousRunId,
        provider: "codex",
        projectContextToken: "dudu-next-shot-actual-tail-context",
        commandRequestId: "dudu-next-shot-actual-tail-command",
        expectedRevision: 0,
      });
      expect(previousCall.callAllowed).toBe(true);

      const rawPath = path.join(dudu.root, "u28-next-shot-raw.png");
      const labeledPath = path.join(dudu.root, "u28-next-shot-labeled.png");
      await Promise.all([
        sharp({
          create: { width: 900, height: 1600, channels: 3, background: { r: 36, g: 60, b: 82 } },
        }).png({ compressionLevel: 9 }).toFile(rawPath),
        sharp({
          create: { width: 900, height: 1600, channels: 3, background: { r: 82, g: 60, b: 36 } },
        }).png({ compressionLevel: 9 }).toFile(labeledPath),
      ]);
      const [rawMedia, labeledMedia] = await Promise.all([
        importStudioMedia(projectRoot, { sourcePath: rawPath }),
        importStudioMedia(projectRoot, { sourcePath: labeledPath }),
      ]);
      const bundle = await registerStudioGenerationResultBundle(projectRoot, {
        packId: previousPack.packId,
        packFingerprint: previousPack.fingerprint,
        generationRunId: previousRunId,
        provider: "codex",
        rawMediaSha256: rawMedia.sha256,
        labeledMediaSha256: labeledMedia.sha256,
        callId: previousCall.callId,
      });
      const review = await submitStudioGenerationReview(projectRoot, {
        operationId: "dudu-next-shot-actual-tail-review",
        generationRunId: previousRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: bundle.raw.resultId,
        rawSha256: bundle.raw.mediaSha256,
        labeledResultId: bundle.labeled.resultId,
        labeledSha256: bundle.labeled.mediaSha256,
        expectedPackFingerprint: previousPack.fingerprint,
        continuityFingerprint: previousPack.pack.continuityFingerprint,
        decision: "pass",
        criteria: [
          { code: "fixture-identity", status: "pass", note: "仅用于确定性 next-shot 门禁测试。" },
          { code: "fixture-grid", status: "pass", note: "机械夹具，不代表真实视觉验收。" },
        ],
        reviewer: "next-shot-continuation-test",
        note: "确定性夹具 PASS，用于验证实际末格证据绑定。",
      });

      const observationBeforePackage = await getStudioPostResultObservationControl(
        projectRoot,
        previousRunId,
      );
      const managedSource = await prepareStudioVideoPackageSource(projectRoot, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: previousPack.fingerprint,
        expectedUnitSnapshotFingerprint: previousSnapshot!.fingerprint,
        expectedObservationControlFingerprint: observationBeforePackage.fingerprint,
        expectedObservationHeadRevision: observationBeforePackage.headRevision,
        expectedObservationStatus: observationBeforePackage.status,
        expectedObservationHeadId: observationBeforePackage.head?.observationId ?? null,
        expectedObservationHeadFingerprint: observationBeforePackage.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: observationBeforePackage.head?.evidenceSha256 ?? null,
      });
      const exportIntent = await prepareStudioVideoPackageExport(projectRoot, {
        operationId: "dudu-next-shot-video-package",
        authority: { kind: "studio-review", reviewId: review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: review.reviewId,
          expectedSourceFingerprint: managedSource.fingerprint,
          expectedReviewFingerprint: review.fingerprint,
          expectedPackFingerprint: previousPack.fingerprint,
          expectedUnitSnapshotFingerprint: previousSnapshot!.fingerprint,
          expectedObservationControlFingerprint: observationBeforePackage.fingerprint,
          expectedObservationHeadRevision: observationBeforePackage.headRevision,
          expectedObservationStatus: observationBeforePackage.status,
          expectedObservationHeadId: observationBeforePackage.head?.observationId ?? null,
          expectedObservationHeadFingerprint: observationBeforePackage.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: observationBeforePackage.head?.evidenceSha256 ?? null,
        },
      });
      const videoPackage = await buildAndVerifyStudioVideoPackage(
        projectRoot,
        exportIntent.intent.intentId,
        { destinationPolicy: "managed-evidence-only" },
      );
      const terminalPanel = previousPack.pack.panels.at(-1)!;
      const cropName = `${previousUnitId}-G${terminalPanel.order}_raw.png`;
      const cropReceipt = videoPackage.receipt.files.find((file) => file.path === cropName);
      expect(cropReceipt).toBeDefined();
      const cropPath = path.join(projectRoot, videoPackage.receipt.storageRelativePath, cropName);
      expect((await readFile(cropPath)).byteLength).toBeGreaterThan(0);
      const cropMedia = await importStudioMedia(projectRoot, { sourcePath: cropPath });
      expect(cropMedia.sha256).toBe(cropReceipt!.sha256);

      const submitObservation = async (revision: number, tag: string, position: string) => {
        const continuitySnapshot = buildNextShotContinuitySnapshot({
          sourceUnitId: previousUnitId,
          sourcePanelId: terminalPanel.panelId,
          sourceRawSha256: bundle.raw.mediaSha256,
          characters: [{
            assetId: "character-dudu",
            costumeState: "锁定毛色与颈部外观保持不变",
            position,
            facing: "面向画面左侧",
            gazeDirection: "注视画面左前方",
            actionEndPose: "站稳并保持专注",
            nextActionStart: "保持站稳姿态，先以视线承接下一镜",
            expression: "专注",
            injuryState: "无可见伤势",
          }],
          props: [],
          scene: {
            layout: "嘟嘟居中，背景保持锁定空间",
            axisLine: "角色保持在既定轴线一侧",
            screenDirection: "视线由画面中央指向画面左侧",
            entryExits: ["画面左侧"],
            lighting: "柔和暖光",
            timeOfDay: "日间",
            cutExit: "嘟嘟站稳并把视线锁向画面左侧时切出",
          },
          vfx: [],
          referenceSha256List: [bundle.raw.mediaSha256, cropMedia.sha256],
        });
        return submitStudioPostResultObservation(projectRoot, {
          operationId: `dudu-next-shot-observation-${tag}`,
          generationRunId: previousRunId,
          expectedHeadRevision: revision,
          expectedReviewId: review.reviewId,
          expectedReviewFingerprint: review.fingerprint,
          rawResultId: bundle.raw.resultId,
          rawSha256: bundle.raw.mediaSha256,
          labeledResultId: bundle.labeled.resultId,
          labeledSha256: bundle.labeled.mediaSha256,
          packId: previousPack.packId,
          packFingerprint: previousPack.fingerprint,
          plannedContinuityFingerprint: previousPack.pack.continuityFingerprint,
          evidenceKind: "terminal-panel-crop",
          evidenceSha256: cropMedia.sha256,
          terminalPanelId: terminalPanel.panelId,
          observedState: {
            costume: "实际末格中嘟嘟保持锁定毛色与外观。",
            injury: "实际末格无可见伤势。",
            heldObject: "实际末格没有持物。",
            position,
            facing: "实际末格面向画面左侧。",
            emotion: "实际末格神情专注。",
            layout: "实际末格嘟嘟居中，背景保持锁定空间。",
            lighting: "实际末格为柔和暖光。",
            referenceSha256: cropMedia.sha256,
            motionVector: "静态裁图无法观察。",
            cameraPhase: "静态裁图无法观察。",
            focusState: "实际末格焦点落在嘟嘟面部。",
            audioPhase: "静态裁图无法观察。",
          },
          observedAvailability: {
            costume: "observed",
            injury: "observed",
            heldObject: "observed",
            position: "observed",
            facing: "observed",
            emotion: "observed",
            layout: "observed",
            lighting: "observed",
            motionVector: "unknown",
            cameraPhase: "unknown",
            focusState: "observed",
            audioPhase: "unknown",
          },
          continuitySnapshot,
          observer: "next-shot-continuation-test",
          note: "只冻结受管视频包末格裁图中明确可见的实际末态。",
        });
      };

      const firstObservation = await submitObservation(0, "v1", "实际末格位于场景中央偏左。");
      expect(
        firstObservation.continuationIneligibleReasons,
        `首条末格观察未能晋级为可续作证据：${firstObservation.continuationIneligibleReasons.join(", ")}`,
      ).toEqual([]);
      expect(firstObservation).toMatchObject({
        evidenceContractVersion: 4,
        evidenceKind: "terminal-panel-crop",
        continuationEligible: true,
        observedState: {
          referenceSha256: cropMedia.sha256,
          position: "实际末格位于场景中央偏左。",
        },
      });
      expect(firstObservation.observedState).not.toHaveProperty("motionVector");

      const firstNextPack = await buildStudioUnitGridGenerationFreezePack(projectRoot, {
        targetKind: "unit-grid",
        unitId: nextUnitId,
      });
      expect(firstNextPack.continuationSource).toMatchObject({
        schemaVersion: 3,
        projectId: staged.shell.project.id,
        sourceUnitId: previousUnitId,
        observationId: firstObservation.observationId,
        observationRevision: 1,
        observationFingerprint: firstObservation.fingerprint,
        observationEvidenceContractVersion: 4,
        evidenceKind: "terminal-panel-crop",
        evidenceSha256: cropMedia.sha256,
        terminalPanelId: terminalPanel.panelId,
        authorityRawMediaSha256: bundle.raw.mediaSha256,
        actualState: {
          position: "实际末格位于场景中央偏左。",
        },
        continuitySnapshot: {
          sourceUnitId: previousUnitId,
          sourcePanelId: terminalPanel.panelId,
          sourceRawSha256: bundle.raw.mediaSha256,
          characters: [{ assetId: "character-dudu", position: "实际末格位于场景中央偏左。" }],
        },
      });
      expect(firstNextPack.continuationSource).not.toHaveProperty("mediaSha256");
      expect(firstNextPack.continuationSource).not.toHaveProperty("rawResultId");
      const continuationReference = firstNextPack.request.controlReferences.find(
        (reference) => reference.referenceId === firstNextPack.continuationSource?.referenceId,
      );
      expect(continuationReference?.mediaSha256).toBe(cropMedia.sha256);
      expect(continuationReference?.mediaSha256).not.toBe(bundle.raw.mediaSha256);
      expect(firstNextPack.request.modelPayload.renderedPrompt).toContain(
        "已验收 actual-tail 证据图，不是整张旧宫格",
      );
      expect(firstNextPack.request.modelPayload.renderedPrompt).toContain(
        "下一镜起拍动作=保持站稳姿态，先以视线承接下一镜",
      );
      expect(firstNextPack.request.modelPayload.renderedPrompt).toContain(
        "屏幕方向=视线由画面中央指向画面左侧",
      );
      expect(firstNextPack.request.modelPayload.renderedPrompt).toContain(
        "剪辑出点=嘟嘟站稳并把视线锁向画面左侧时切出",
      );
      const brief = buildStudioUnitGridAgentImagegenBrief(firstNextPack, "codex");
      expect(brief.continuationSource).toMatchObject({
        schemaVersion: 3,
        evidenceSha256: cropMedia.sha256,
        observationEvidenceContractVersion: 4,
        canonicalIdentityPriority: true,
      });

      const secondObservation = await submitObservation(1, "v2", "实际末格位于场景中央偏右。");
      const secondNextPack = await buildStudioUnitGridGenerationFreezePack(projectRoot, {
        targetKind: "unit-grid",
        unitId: nextUnitId,
      });
      expect(secondNextPack.fingerprint).not.toBe(firstNextPack.fingerprint);
      expect(secondNextPack.continuationSource).toMatchObject({
        observationId: secondObservation.observationId,
        observationRevision: 2,
        actualState: { position: "实际末格位于场景中央偏右。" },
      });
      await expect(assertStudioUnitGridGenerationFreezePackCurrent(projectRoot, firstNextPack))
        .rejects.toMatchObject({ code: "input-drift" });

      const persistedNext = await freezeAndPersistStudioUnitGridGenerationPack(projectRoot, {
        targetKind: "unit-grid",
        unitId: nextUnitId,
      });
      const nextRunId = "dudu-next-shot-paid-call-cas-u29-run";
      await dispatchStudioGenerationPack(projectRoot, {
        packId: persistedNext.packId,
        packFingerprint: persistedNext.fingerprint,
        generationRunId: nextRunId,
        provider: "codex",
      });
      __setBeforeImagegenIntentTransactionHookForTests(async () => {
        await submitStudioGenerationReview(projectRoot, {
          operationId: "dudu-next-shot-review-race-correction",
          generationRunId: previousRunId,
          kind: "correction",
          expectedHeadRevision: 1,
          supersedesReviewId: review.reviewId,
          rawResultId: bundle.raw.resultId,
          rawSha256: bundle.raw.mediaSha256,
          labeledResultId: bundle.labeled.resultId,
          labeledSha256: bundle.labeled.mediaSha256,
          expectedPackFingerprint: previousPack.fingerprint,
          continuityFingerprint: previousPack.pack.continuityFingerprint,
          decision: "rework",
          criteria: [{ code: "fixture-race", status: "fail", note: "在 final check 后注入 Review 漂移。" }],
          reviewer: "next-shot-continuation-test",
          note: "只验证 paid-call 事务 CAS，不代表真实审片。",
        });
      });
      await expect(prepareStudioImagegenCall(projectRoot, {
        packId: persistedNext.packId,
        packFingerprint: persistedNext.fingerprint,
        generationRunId: nextRunId,
        provider: "codex",
        projectContextToken: "dudu-next-shot-paid-call-cas-context",
        commandRequestId: "dudu-next-shot-paid-call-cas-command",
        expectedRevision: 0,
      })).rejects.toMatchObject({ code: "call-intent-conflict" });
      await expect(readStudioImagegenCallIntentByRun(projectRoot, nextRunId)).resolves.toBeNull();
    } finally {
      if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
      await dudu.cleanup();
    }
  }, 600_000);
});
