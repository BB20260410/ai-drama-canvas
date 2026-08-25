import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  importStudioHistoricalGenerationEvidence,
  listStudioGenerationActiveRuns,
  listStudioGenerationLatestUnitGridRuns,
  prepareStudioImagegenCall,
  registerStudioGenerationResultBundle,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  getApprovedTimelineProjection,
  resolveApprovedTimelineFastMode,
} from "../src/core/studio-approved-timeline-projection.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  studioP7ContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

/**
 * T9 批量投影核心测试：
 * - listStudioGenerationLatestUnitGridRuns 批量结果与单项版 listStudioGenerationActiveRuns runs[0] 一致；
 * - 批量一并取回最新 PASS run 的真实 raw/labeled SHA（投影不再给占位符）；
 * - 投影 panelCount 直接取列表行 panel_count；
 * - 历史 PASS 合并：正式 run PASS 优先 > 已核验历史 PASS > 核验失败仅警告。
 * 全部 mkdtemp 隔离工程，不消费任何外部凭证。
 */

const fixtures: StudioP7Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function p7(): Promise<StudioP7Fixture> {
  const fixture = await createStudioP7Fixture();
  fixtures.push(fixture);
  return fixture;
}

/**
 * 双单元 unit-grid 槽位：
 * - twoPanel：dispatch → prepare → 成对 bundle → Review PASS（带真实 SHA）
 * - sixPanel：仅 dispatch（in-flight，无 SHA）
 */
async function seedUnitGridRuns(fixture: StudioP7Fixture) {
  await seedStudioP7ResolvedContinuity(fixture);
  const passUnit = fixture.units.twoPanel;
  const passMedia = fixture.panelMediaPairs.find((entry) => entry.unitId === passUnit.unit.id)!;
  const frozenPass = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
    targetKind: "unit-grid",
    unitId: passUnit.unit.id,
    verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
      fixture.root,
      passUnit,
      "fixture:t9-batch-run-pass",
    ),
  });
  await dispatchStudioGenerationPack(fixture.root, {
    packId: frozenPass.packId,
    packFingerprint: frozenPass.fingerprint,
    generationRunId: "t9-batch-run-pass",
    provider: "codex",
  });
  const intent = await prepareStudioImagegenCall(fixture.root, {
    packId: frozenPass.packId,
    packFingerprint: frozenPass.fingerprint,
    generationRunId: "t9-batch-run-pass",
    provider: "codex",
    projectContextToken: "t9-batch-context-token",
    commandRequestId: "t9-batch-prepare-command-001",
    expectedRevision: 0,
  });
  const bundle = await registerStudioGenerationResultBundle(fixture.root, {
    packId: frozenPass.packId,
    packFingerprint: frozenPass.fingerprint,
    generationRunId: "t9-batch-run-pass",
    provider: "codex",
    rawMediaSha256: passMedia.raw.imported.sha256,
    labeledMediaSha256: passMedia.labeled.imported.sha256,
    callId: intent.callId,
  });
  await submitStudioGenerationReview(fixture.root, {
    operationId: "t9-batch-review-operation-001",
    generationRunId: "t9-batch-run-pass",
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: bundle.raw.resultId,
    rawSha256: bundle.raw.mediaSha256,
    labeledResultId: bundle.labeled.resultId,
    labeledSha256: bundle.labeled.mediaSha256,
    expectedPackFingerprint: frozenPass.fingerprint,
    continuityFingerprint: frozenPass.pack.continuityFingerprint,
    decision: "pass",
    criteria: [
      { code: "identity", status: "pass" },
      { code: "grid-order", status: "pass" },
      { code: "no-text", status: "pass" },
    ],
    reviewer: "t9-batch-test",
    note: "T9 批量投影夹具：身份、宫格顺序与禁字均通过。",
  });

  const inflightUnit = fixture.units.sixPanel;
  const frozenInflight = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
    targetKind: "unit-grid",
    unitId: inflightUnit.unit.id,
  });
  await dispatchStudioGenerationPack(fixture.root, {
    packId: frozenInflight.packId,
    packFingerprint: frozenInflight.fingerprint,
    generationRunId: "t9-batch-run-inflight",
    provider: "codex",
  });
  return { passUnit, passMedia, inflightUnit, frozenPass };
}

/**
 * 历史 PASS 槽位：sixPanel freeze + 历史导入（零调用证据，不 dispatch）。
 * 媒体复用夹具 panelMediaPairs（已入受管 CAS），source SHA 与媒体一致（原字节合同）。
 */
async function seedHistoricalPass(fixture: StudioP7Fixture) {
  await seedStudioP7ResolvedContinuity(fixture);
  const histUnit = fixture.units.sixPanel;
  const histMedia = fixture.panelMediaPairs.find((entry) => entry.unitId === histUnit.unit.id)!;
  const frozenHist = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
    targetKind: "unit-grid",
    unitId: histUnit.unit.id,
  });
  const evidence = await importStudioHistoricalGenerationEvidence(fixture.root, {
    packId: frozenHist.packId,
    packFingerprint: frozenHist.fingerprint,
    rawMediaSha256: histMedia.raw.imported.sha256,
    labeledMediaSha256: histMedia.labeled.imported.sha256,
    sourceRawSha256: histMedia.raw.imported.sha256,
    sourceLabeledSha256: histMedia.labeled.imported.sha256,
    sourceManifestFingerprint: "a".repeat(64),
    qcEvidenceReference: "fixture/p7/six-panel-qc.md",
    qcEvidenceSha256: "b".repeat(64),
    externalStoryboardStatus: "PASS",
  });
  return { histUnit, histMedia, frozenHist, evidence };
}

describe("T9 listStudioGenerationLatestUnitGridRuns 批量最新 run", () => {
  it("空输入返回空数组", async () => {
    const fixture = await p7();
    await expect(listStudioGenerationLatestUnitGridRuns(fixture.root, [])).resolves.toEqual([]);
  });

  it("批量结果与单项版 runs[0] 逐字段一致，且带回成对结果真实 SHA", async () => {
    const fixture = await p7();
    const { passUnit, passMedia, inflightUnit, frozenPass } = await seedUnitGridRuns(fixture);
    const missingUnitId = "p7-unit-never-dispatched";
    const batch = await listStudioGenerationLatestUnitGridRuns(fixture.root, [
      passUnit.unit.id,
      inflightUnit.unit.id,
      missingUnitId,
    ]);
    expect(batch.map((entry) => entry.unitId)).toEqual([
      passUnit.unit.id,
      inflightUnit.unit.id,
      missingUnitId,
    ]);

    // 逐单元与单项版深比较（runs[0] 同口径）
    for (const unitId of [passUnit.unit.id, inflightUnit.unit.id]) {
      const single = await listStudioGenerationActiveRuns(fixture.root, {
        unitId,
        targetKind: "unit-grid",
      });
      const entry = batch.find((item) => item.unitId === unitId)!;
      expect(entry.latestRun).toEqual(single.runs[0] ?? null);
    }

    // PASS 单元：成对 SHA 与登记媒体一致
    const passEntry = batch.find((entry) => entry.unitId === passUnit.unit.id)!;
    expect(passEntry.latestRun?.generationRunId).toBe("t9-batch-run-pass");
    expect(passEntry.latestRun?.reviewStatus).toBe("pass");
    expect(passEntry.latestRun?.hasResultPair).toBe(true);
    expect(passEntry.rawMediaSha256).toBe(passMedia.raw.imported.sha256);
    expect(passEntry.labeledMediaSha256).toBe(passMedia.labeled.imported.sha256);
    expect(passEntry.approvedResultIdentity).toMatchObject({
      generationRunId: "t9-batch-run-pass",
      provider: "codex",
      packId: frozenPass.packId,
      packFingerprint: frozenPass.fingerprint,
      rawMediaSha256: passMedia.raw.imported.sha256,
      labeledMediaSha256: passMedia.labeled.imported.sha256,
    });
    expect(passEntry.approvedResultIdentity?.reviewId).toMatch(/^studio-generation-review-/u);
    expect(passEntry.approvedResultIdentity?.reviewFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(passEntry.approvedResultIdentity?.continuityFingerprint).toBe(
      frozenPass.pack.continuityFingerprint,
    );
    expect(passEntry.approvedResultIdentity?.postResultObservationHeadPresent).toBe(false);

    // in-flight 单元：无结果对，SHA 为 null
    const inflightEntry = batch.find((entry) => entry.unitId === inflightUnit.unit.id)!;
    expect(inflightEntry.latestRun?.generationRunId).toBe("t9-batch-run-inflight");
    expect(inflightEntry.latestRun?.terminal).toBe(false);
    expect(inflightEntry.rawMediaSha256).toBeNull();
    expect(inflightEntry.labeledMediaSha256).toBeNull();
    expect(inflightEntry.approvedResultIdentity).toBeNull();

    // 从未派发单元：latestRun 为 null
    const missingEntry = batch.find((entry) => entry.unitId === missingUnitId)!;
    expect(missingEntry.latestRun).toBeNull();
    expect(missingEntry.rawMediaSha256).toBeNull();
    expect(missingEntry.labeledMediaSha256).toBeNull();
    expect(missingEntry.approvedResultIdentity).toBeNull();
  }, 120_000);
});

describe("T9 getApprovedTimelineProjection 批量投影", () => {
  it("fastMode：PASS 单元给出真实 SHA（无占位符），panelCount 取列表行", async () => {
    const fixture = await p7();
    const { passUnit, passMedia, inflightUnit, frozenPass } = await seedUnitGridRuns(fixture);
    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      fastMode: true,
    });
    expect(projection.unitCount).toBe(2);
    expect(JSON.stringify(projection)).not.toContain("pending-sha-resolution");

    const passProjection = projection.units.find((unit) => unit.unitId === passUnit.unit.id)!;
    expect(passProjection.productionStatus).toBe("pass");
    expect(passProjection.selectedRawSha256).toBe(passMedia.raw.imported.sha256);
    expect(passProjection.selectedLabeledSha256).toBe(passMedia.labeled.imported.sha256);
    expect(passProjection.selectedRawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(passProjection.latestRunId).toBe("t9-batch-run-pass");
    expect(passProjection.reviewStatus).toBe("pass");
    expect(passProjection.panelCount).toBe(2);
    expect(passProjection.projectionError).toBeNull();
    // 正式 run 来源的选中归属字段
    expect(passProjection.selectedResultSource).toBe("generation-run");
    expect(passProjection.selectedGenerationRunId).toBe("t9-batch-run-pass");
    expect(passProjection.selectedPackFingerprint).toBe(frozenPass.fingerprint);
    expect(passProjection.selectedRunExecutionIdentity).toMatchObject({
      generationRunId: "t9-batch-run-pass",
      provider: "codex",
      packId: frozenPass.packId,
      packFingerprint: frozenPass.fingerprint,
      rawMediaSha256: passMedia.raw.imported.sha256,
      labeledMediaSha256: passMedia.labeled.imported.sha256,
    });
    expect(passProjection.historicalImportId).toBeNull();
    expect(passProjection.referenceClosureStatus).toBe("not-applicable");

    const inflightProjection = projection.units.find((unit) => unit.unitId === inflightUnit.unit.id)!;
    expect(inflightProjection.productionStatus).toBe("dispatched_no_call");
    expect(inflightProjection.selectedRawSha256).toBeNull();
    expect(inflightProjection.selectedLabeledSha256).toBeNull();
    expect(inflightProjection.panelCount).toBe(6);
    expect(inflightProjection.projectionError).toBeNull();
    // 在途 run 未选中任何正式结果
    expect(inflightProjection.selectedResultSource).toBeNull();
    expect(inflightProjection.selectedGenerationRunId).toBeNull();
    expect(inflightProjection.selectedPackFingerprint).toBeNull();
    expect(inflightProjection.selectedRunExecutionIdentity).toBeNull();
    expect(inflightProjection.referenceClosureStatus).toBe("not-applicable");
    expect(projection.fastMode).toBe(true);
    expect(projection.durationMs).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("显式 fastMode:false：PASS 单元同样给出真实 SHA", async () => {
    const fixture = await p7();
    const { passUnit, passMedia } = await seedUnitGridRuns(fixture);
    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      fastMode: false,
    });
    const passProjection = projection.units.find((unit) => unit.unitId === passUnit.unit.id)!;
    expect(passProjection.productionStatus).toBe("pass");
    expect(passProjection.selectedRawSha256).toBe(passMedia.raw.imported.sha256);
    expect(passProjection.selectedLabeledSha256).toBe(passMedia.labeled.imported.sha256);
    expect(projection.fastMode).toBe(false);
    expect(projection.durationMs).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("省略 fastMode 视为 true，与显式 true 投影一致", async () => {
    expect(resolveApprovedTimelineFastMode(undefined)).toBe(true);
    expect(resolveApprovedTimelineFastMode({})).toBe(true);
    expect(resolveApprovedTimelineFastMode({ fastMode: undefined })).toBe(true);
    expect(resolveApprovedTimelineFastMode({ fastMode: true })).toBe(true);
    expect(resolveApprovedTimelineFastMode({ fastMode: false })).toBe(false);

    const fixture = await p7();
    await seedUnitGridRuns(fixture);
    const omitted = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
    });
    const explicitFast = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      fastMode: true,
    });
    expect(omitted.units.map((unit) => ({
      unitId: unit.unitId,
      productionStatus: unit.productionStatus,
      selectedResultSource: unit.selectedResultSource,
      selectedRawSha256: unit.selectedRawSha256,
      selectedLabeledSha256: unit.selectedLabeledSha256,
    }))).toEqual(explicitFast.units.map((unit) => ({
      unitId: unit.unitId,
      productionStatus: unit.productionStatus,
      selectedResultSource: unit.selectedResultSource,
      selectedRawSha256: unit.selectedRawSha256,
      selectedLabeledSha256: unit.selectedLabeledSha256,
    })));
    expect(omitted.fastMode).toBe(true);
    expect(explicitFast.fastMode).toBe(true);
    expect(omitted.durationMs).toBeGreaterThanOrEqual(0);
    expect(omitted.bounded).toBe(false);
    expect(explicitFast.bounded).toBe(false);
  }, 120_000);

  it("unitIds 有界：返回集 ⊆ 请求 id，且 bounded=true", async () => {
    const fixture = await p7();
    const { passUnit } = await seedUnitGridRuns(fixture);
    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      unitIds: [passUnit.unit.id],
    });
    expect(projection.bounded).toBe(true);
    expect(projection.unitCount).toBe(1);
    expect(projection.units.map((unit) => unit.unitId)).toEqual([passUnit.unit.id]);
  }, 120_000);
});

describe("T9 历史 PASS 合并（正式 run 优先 > 已核验历史 PASS > 仅警告）", () => {
  it("无正式 run 时，已核验历史 PASS 提升为正式结果", async () => {
    const fixture = await p7();
    const { histUnit, histMedia, frozenHist, evidence } = await seedHistoricalPass(fixture);
    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      fastMode: true,
    });
    expect(projection.unitCount).toBe(2);
    expect(projection.summary.pass).toBe(1);

    const histProjection = projection.units.find((unit) => unit.unitId === histUnit.unit.id)!;
    expect(histProjection.productionStatus).toBe("pass");
    expect(histProjection.selectedResultSource).toBe("historical-import");
    expect(histProjection.historicalImportId).toBe(evidence.importId);
    expect(histProjection.selectedGenerationRunId).toBeNull();
    expect(histProjection.selectedPackFingerprint).toBe(frozenHist.fingerprint);
    expect(histProjection.selectedRunExecutionIdentity).toBeNull();
    expect(histProjection.selectedRawSha256).toBe(histMedia.raw.imported.sha256);
    expect(histProjection.selectedLabeledSha256).toBe(histMedia.labeled.imported.sha256);
    expect(histProjection.referenceClosureStatus).toBe("complete");
    // 历史来源不冒充 run 事实：无 run 字段保持 null
    expect(histProjection.latestRunId).toBeNull();
    expect(histProjection.reviewStatus).toBeNull();
    expect(histProjection.projectionError).toBeNull();
    // displayLabel 统一经 buildUnitDisplayIdentity（夹具 unitId 非 -U 编号，fullLabel 以权威 unitId 为准）
    expect(histProjection.displayLabel).toBe(`001｜${histUnit.unit.id}`);

    const idleProjection = projection.units.find((unit) => unit.unitId === fixture.units.twoPanel.unit.id)!;
    expect(idleProjection.productionStatus).toBe("ready_to_freeze");
    expect(idleProjection.selectedResultSource).toBeNull();
    expect(idleProjection.referenceClosureStatus).toBe("not-applicable");
  }, 120_000);

  it("正式 run PASS 与历史 PASS 共存时各按来源归属（正式 run 优先语义）", async () => {
    const fixture = await p7();
    // sixPanel 历史 PASS（不 dispatch）；twoPanel 完整正式 run PASS。
    const { histUnit, histMedia, frozenHist, evidence } = await seedHistoricalPass(fixture);
    const passUnit = fixture.units.twoPanel;
    const passMedia = fixture.panelMediaPairs.find((entry) => entry.unitId === passUnit.unit.id)!;
    const frozenPass = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: passUnit.unit.id,
      verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
        fixture.root,
        passUnit,
        "fixture:t9-hist-merge-run-pass",
      ),
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozenPass.packId,
      packFingerprint: frozenPass.fingerprint,
      generationRunId: "t9-hist-merge-run-pass",
      provider: "codex",
    });
    const intent = await prepareStudioImagegenCall(fixture.root, {
      packId: frozenPass.packId,
      packFingerprint: frozenPass.fingerprint,
      generationRunId: "t9-hist-merge-run-pass",
      provider: "codex",
      projectContextToken: "t9-hist-merge-context-token",
      commandRequestId: "t9-hist-merge-prepare-command-001",
      expectedRevision: 0,
    });
    const bundle = await registerStudioGenerationResultBundle(fixture.root, {
      packId: frozenPass.packId,
      packFingerprint: frozenPass.fingerprint,
      generationRunId: "t9-hist-merge-run-pass",
      provider: "codex",
      rawMediaSha256: passMedia.raw.imported.sha256,
      labeledMediaSha256: passMedia.labeled.imported.sha256,
      callId: intent.callId,
    });
    await submitStudioGenerationReview(fixture.root, {
      operationId: "t9-hist-merge-review-operation-001",
      generationRunId: "t9-hist-merge-run-pass",
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: bundle.raw.resultId,
      rawSha256: bundle.raw.mediaSha256,
      labeledResultId: bundle.labeled.resultId,
      labeledSha256: bundle.labeled.mediaSha256,
      expectedPackFingerprint: frozenPass.fingerprint,
      continuityFingerprint: frozenPass.pack.continuityFingerprint,
      decision: "pass",
      criteria: [
        { code: "identity", status: "pass" },
        { code: "grid-order", status: "pass" },
        { code: "no-text", status: "pass" },
      ],
      reviewer: "t9-hist-merge-test",
      note: "T9 历史合并夹具：正式 run PASS 与历史 PASS 共存。",
    });

    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      fastMode: true,
    });
    expect(projection.summary.pass).toBe(2);

    // 正式 run 来源：SHA 取成对结果，fingerprint 取 dispatch 登记
    const runProjection = projection.units.find((unit) => unit.unitId === passUnit.unit.id)!;
    expect(runProjection.selectedResultSource).toBe("generation-run");
    expect(runProjection.selectedGenerationRunId).toBe("t9-hist-merge-run-pass");
    expect(runProjection.selectedRawSha256).toBe(passMedia.raw.imported.sha256);
    expect(runProjection.selectedPackFingerprint).toBe(frozenPass.fingerprint);
    expect(runProjection.historicalImportId).toBeNull();
    expect(runProjection.referenceClosureStatus).toBe("not-applicable");

    // 历史来源：SHA 取导入证据，fingerprint 取 import 行
    const histProjection = projection.units.find((unit) => unit.unitId === histUnit.unit.id)!;
    expect(histProjection.selectedResultSource).toBe("historical-import");
    expect(histProjection.historicalImportId).toBe(evidence.importId);
    expect(histProjection.selectedRawSha256).toBe(histMedia.raw.imported.sha256);
    expect(histProjection.selectedPackFingerprint).toBe(frozenHist.fingerprint);
    expect(histProjection.referenceClosureStatus).toBe("complete");
  }, 120_000);

  it("历史候选未通过闭合核验（raw 媒体不可读）时不提升，仅警告", async () => {
    const fixture = await p7();
    const { histUnit, histMedia } = await seedHistoricalPass(fixture);
    // 删除 raw 媒体 CAS 对象（夹具临时工程内），触发"raw 可读"核验失败。
    // 账本行本身完整（SQL 级一致性不受文件删除影响），仅投影闭合核验判失败。
    const rawSha = histMedia.raw.imported.sha256;
    await rm(`${fixture.root}/.aicanvas/objects/sha256/${rawSha.slice(0, 2)}/${rawSha}`, { force: true });

    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: "S03",
      episode: "EP01",
      fastMode: true,
    });
    const histProjection = projection.units.find((unit) => unit.unitId === histUnit.unit.id)!;
    // 核验失败不提升：保持归约器原状态，不选任何正式结果
    expect(histProjection.productionStatus).toBe("ready_to_freeze");
    expect(histProjection.selectedResultSource).toBeNull();
    expect(histProjection.historicalImportId).toBeNull();
    expect(histProjection.selectedRawSha256).toBeNull();
    expect(histProjection.referenceClosureStatus).toBe("failed");
    expect(histProjection.candidateWarning).toContain("历史 PASS 未通过闭合核验");
    expect(histProjection.candidateWarning).toContain("raw 媒体 CAS 对象不可读");
    expect(histProjection.projectionError).toBeNull();
    expect(projection.summary.pass).toBe(0);
  }, 120_000);
});
