import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  assertStudioGenerationCheckpointDispatchAllowed,
  attestStudioGenerationCheckpoint,
  getStudioGenerationCheckpointCanvasProjection,
  getStudioGenerationCheckpointControl,
  readStudioGenerationCheckpointOperationReceipt,
  refreshStudioGenerationCheckpoint,
} from "../src/core/studio-generation-checkpoint.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  readStudioGenerationDispatch,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await fixture?.cleanup();
  fixture = undefined;
});

async function produceReviewedSix() {
  fixture = await createStudioP7Fixture();
  expect(path.resolve(fixture.root).startsWith(path.resolve(fixture.temporaryRoot) + path.sep)).toBe(true);
  await seedStudioP7ResolvedContinuity(fixture);
  const produced = [];
  for (const [index, panel] of fixture.units.sixPanel.panels.entries()) {
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
    const pack = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: fixture.units.sixPanel.unit.id,
      panelId: panel.id,
    });
    const generationRunId = `p7-checkpoint-run-${index + 1}`;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const raw = await registerStudioGenerationResult(fixture.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId,
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
    });
    const labeled = await registerStudioGenerationResult(fixture.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId,
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
    });
    const review = await submitStudioGenerationReview(fixture.root, {
      operationId: `p7-checkpoint-review-${index + 1}`,
      generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: raw.resultId,
      rawSha256: raw.mediaSha256,
      labeledResultId: labeled.resultId,
      labeledSha256: labeled.mediaSha256,
      expectedPackFingerprint: pack.fingerprint,
      continuityFingerprint: pack.pack.continuity.fingerprint,
      decision: "pass",
      criteria: [
        { code: "identity-consistency", status: "pass", note: "deterministic fixture" },
        { code: "raw-labeled-pair", status: "pass", note: "同 run 成对" },
      ],
      reviewer: "p7-checkpoint-test",
      note: `第 ${index + 1} 槽机械 Review。`,
    });
    produced.push({ panel, pack, generationRunId, raw, labeled, review });
  }
  return produced;
}

describe("P7 每六张生产图 checkpoint", () => {
  it("已有 PENDING 槽位在人工验收前禁止另开 generationRunId", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.sixPanel.panels[0]!;
    const pack = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: fixture.units.sixPanel.unit.id,
      panelId: panel.id,
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId: "p7-pending-slot-original-run",
      provider: "codex",
    });
    await expect(assertStudioGenerationCheckpointDispatchAllowed(fixture.root, {
      unitId: fixture.units.sixPanel.unit.id,
      panelId: panel.id,
    })).rejects.toMatchObject({
      code: "checkpoint-required",
      details: expect.arrayContaining(["review-missing"]),
    });
  });

  it("checkpoint future marker 与弱 schema 在 DDL 前失败关闭", async () => {
    fixture = await createStudioP7Fixture();
    await getStudioGenerationCheckpointControl(fixture.root);
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const future = new DatabaseSync(databasePath);
    future.prepare("UPDATE studio_generation_ledger_meta SET value='999' WHERE key='p7_checkpoint_schema_version'").run();
    future.close();

    await expect(getStudioGenerationCheckpointControl(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const futureAudit = new DatabaseSync(databasePath, { readOnly: true });
    expect(futureAudit.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'").get())
      .toEqual({ value: "999" });
    futureAudit.close();

    await fixture.cleanup();
    fixture = await createStudioP7Fixture();
    await getStudioGenerationCheckpointControl(fixture.root);
    const weakPath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const weak = new DatabaseSync(weakPath);
    weak.exec(`
      DROP TRIGGER studio_generation_checkpoint_snapshots_no_update;
      CREATE TRIGGER studio_generation_checkpoint_snapshots_no_update
        BEFORE UPDATE ON studio_generation_checkpoint_snapshots BEGIN SELECT 1; END;
    `);
    weak.close();

    await expect(getStudioGenerationCheckpointControl(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const weakAudit = new DatabaseSync(weakPath, { readOnly: true });
    expect(weakAudit.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='studio_generation_checkpoint_snapshots_no_update'").get())
      .toEqual({ count: 1 });
    weakAudit.close();

    await fixture.cleanup();
    fixture = await createStudioP7Fixture();
    await getStudioGenerationCheckpointControl(fixture.root);
    const wrongIndexPath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const wrongIndex = new DatabaseSync(wrongIndexPath);
    wrongIndex.exec(`
      DROP INDEX studio_generation_checkpoint_snapshot_batch_idx;
      CREATE INDEX studio_generation_checkpoint_snapshot_batch_idx
        ON studio_generation_checkpoint_snapshots(sequence);
    `);
    wrongIndex.close();
    await expect(getStudioGenerationCheckpointControl(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });

    await fixture.cleanup();
    fixture = await createStudioP7Fixture();
    await getStudioGenerationCheckpointControl(fixture.root);
    const extraPath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const extra = new DatabaseSync(extraPath);
    extra.exec(`
      CREATE TRIGGER studio_generation_checkpoint_extra_trigger
        AFTER INSERT ON studio_generation_checkpoint_snapshots
        BEGIN DELETE FROM studio_generation_checkpoint_heads; END;
      CREATE VIEW studio_generation_checkpoint_extra_view AS
        SELECT checkpoint_id FROM studio_generation_checkpoint_snapshots;
    `);
    extra.close();
    await expect(getStudioGenerationCheckpointControl(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
  });

  it("六槽阻断第七槽，pass 解锁；Review correction 使旧批准派生失效并要求重批准", { timeout: 300_000 }, async () => {
    const produced = await produceReviewedSix();
    const seventhPanel = fixture!.units.twoPanel.panels[0]!;
    const first = produced[0]!;

    const beforeCheckpoint = await getStudioGenerationCheckpointControl(fixture!.root);
    expect(beforeCheckpoint).toMatchObject({
      completedSlotCount: 6,
      fullBatchCount: 1,
      collectingSlotCount: 0,
      blockingBatchNumber: 1,
      newSlotDispatchAllowed: false,
    });
    expect(beforeCheckpoint.batches[0]).toMatchObject({
      batchNumber: 1,
      status: "refresh-required",
      checkpointHeadRevision: 0,
      attestationHeadRevision: 0,
    });
    expect(beforeCheckpoint.batches[0]!.liveCheckpoint?.members).toHaveLength(6);
    // 十二条 raw/labeled 结果只计算六个槽位。
    expect(beforeCheckpoint.completedSlotCount).toBe(produced.length);
    await expect(assertStudioGenerationCheckpointDispatchAllowed(fixture!.root, {
      unitId: fixture!.units.twoPanel.unit.id,
      panelId: seventhPanel.id,
    })).rejects.toMatchObject({ code: "checkpoint-required" });
    const seventhPack = await freezeAndPersistStudioGenerationPack(fixture!.root, {
      unitId: fixture!.units.twoPanel.unit.id,
      panelId: seventhPanel.id,
    });
    const blockedRunId = "p7-checkpoint-blocked-seventh-run";
    await expect(dispatchStudioGenerationPack(fixture!.root, {
      packId: seventhPack.packId,
      packFingerprint: seventhPack.fingerprint,
      generationRunId: blockedRunId,
    provider: "codex",
    })).rejects.toMatchObject({ code: "checkpoint-required" });
    await expect(readStudioGenerationDispatch(fixture!.root, blockedRunId)).resolves.toBeNull();

    const checkpoint = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-refresh-1",
      batchNumber: 1,
      expectedHeadRevision: 0,
    });
    expect(checkpoint).toMatchObject({
      batchNumber: 1,
      eligibleForPass: true,
      head: true,
      headRevision: 1,
      current: true,
    });
    expect(checkpoint.members).toHaveLength(6);
    expect(checkpoint.members.map((member) => member.slotOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const member of checkpoint.members) {
      expect(member).toMatchObject({
        reviewCurrent: true,
        reviewDecision: "pass",
      });
      expect(member.rawSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(member.labeledSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(member.reviewFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(member.continuityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(member.packFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    }
    await expect(readStudioGenerationCheckpointOperationReceipt(
      fixture!.root,
      "p7-checkpoint-refresh-1",
    )).resolves.toMatchObject({
      operationKind: "refresh",
      outcomeKind: "checkpoint",
      outcomeId: checkpoint.checkpointId,
      outcome: { checkpointId: checkpoint.checkpointId, current: true },
    });
    await expect(refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-refresh-1",
      batchNumber: 1,
      expectedHeadRevision: 1,
    })).rejects.toMatchObject({ code: "operation-conflict" });
    await expect(refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-refresh-stale-cas",
      batchNumber: 1,
      expectedHeadRevision: 0,
    })).rejects.toMatchObject({ code: "checkpoint-conflict" });

    const attestation = await attestStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-attest-1",
      batchNumber: 1,
      checkpointId: checkpoint.checkpointId,
      checkpointFingerprint: checkpoint.fingerprint,
      expectedHeadRevision: 0,
      decision: "pass",
      reviewer: "p7-checkpoint-test",
      note: "六张机械合同通过；不声明视觉验收。",
    });
    expect(attestation).toMatchObject({
      batchNumber: 1,
      checkpointId: checkpoint.checkpointId,
      decision: "pass",
      head: true,
      headRevision: 1,
      current: true,
    });
    const canvasProjection = await getStudioGenerationCheckpointCanvasProjection(fixture!.root);
    expect(canvasProjection).toMatchObject({
      kind: "studio-generation-checkpoint-canvas-projection",
      completedSlotCount: 6,
      fullBatchCount: 1,
      collectingSlotCount: 0,
      ledgerCurrent: true,
      blockers: [],
    });
    // 此 fixture 是 panel target；画布整板投影不会把 panel raw 冒充 unit-grid raw。
    expect(canvasProjection.attestedUnitGrid).toEqual([]);
    await expect(assertStudioGenerationCheckpointDispatchAllowed(fixture!.root, {
      unitId: fixture!.units.twoPanel.unit.id,
      panelId: seventhPanel.id,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "checkpoint-pass-current",
      completedSlotCount: 6,
    });

    const correction = await submitStudioGenerationReview(fixture!.root, {
      operationId: "p7-checkpoint-review-correction-1",
      generationRunId: first.generationRunId,
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: first.review.reviewId,
      rawResultId: first.raw.resultId,
      rawSha256: first.raw.mediaSha256,
      labeledResultId: first.labeled.resultId,
      labeledSha256: first.labeled.mediaSha256,
      expectedPackFingerprint: first.pack.fingerprint,
      continuityFingerprint: first.pack.pack.continuity.fingerprint,
      decision: "pass",
      criteria: [
        { code: "identity-consistency", status: "pass", note: "追加修正确认" },
        { code: "raw-labeled-pair", status: "pass", note: "同 run 成对" },
      ],
      reviewer: "p7-checkpoint-test",
      note: "同一生产槽位追加 Review correction。",
    });
    expect(correction).toMatchObject({ headRevision: 2, current: true, decision: "pass" });

    const afterCorrection = await getStudioGenerationCheckpointControl(fixture!.root);
    expect(afterCorrection.completedSlotCount).toBe(6);
    expect(afterCorrection.batches[0]).toMatchObject({
      status: "refresh-required",
      checkpointHeadRevision: 1,
      attestationHeadRevision: 1,
      checkpoint: { checkpointId: checkpoint.checkpointId, current: false },
      attestation: { attestationId: attestation.attestationId, current: false },
    });
    expect(afterCorrection.batches[0]!.liveCheckpoint?.checkpointId).not.toBe(checkpoint.checkpointId);
    const staleCanvasProjection = await getStudioGenerationCheckpointCanvasProjection(fixture!.root);
    expect(staleCanvasProjection).toMatchObject({ ledgerCurrent: false, attestedUnitGrid: [] });
    expect(staleCanvasProjection.blockers.some((entry) => entry.includes("review-head-changed"))).toBe(true);
    await expect(assertStudioGenerationCheckpointDispatchAllowed(fixture!.root, {
      unitId: fixture!.units.twoPanel.unit.id,
      panelId: seventhPanel.id,
    })).rejects.toMatchObject({ code: "checkpoint-required" });
    // 已进入过账本的六个槽位始终允许返工 dispatch，不会被误判为第七槽。
    await expect(assertStudioGenerationCheckpointDispatchAllowed(fixture!.root, {
      unitId: fixture!.units.sixPanel.unit.id,
      panelId: first.panel.id,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "existing-slot-rework",
      completedSlotCount: 6,
      blockingBatchNumber: 1,
    });

    const refreshCommand = {
      requestId: "p7-checkpoint-command-refresh-request-2",
      idempotencyKey: "p7-checkpoint-command-refresh-key-2",
      request: {
        command: "refresh_studio_generation_checkpoint" as const,
        payload: { batchNumber: 1, expectedHeadRevision: 1 },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "refresh_studio_generation_checkpoint";
    await expect(executeIdempotentCommand(fixture!.root, refreshCommand)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const refreshRecord = await executeIdempotentCommand(fixture!.root, {
      ...refreshCommand,
      requestId: "p7-checkpoint-command-refresh-recovery-2",
    });
    expect(refreshRecord).toMatchObject({ status: "succeeded", replayed: true, result: { reconciled: true } });
    const refreshed = refreshRecord.result as Awaited<ReturnType<typeof refreshStudioGenerationCheckpoint>>;
    expect(refreshed).toMatchObject({ headRevision: 2, current: true, eligibleForPass: true });
    expect(refreshed.checkpointId).not.toBe(checkpoint.checkpointId);
    expect(refreshed.members[0]).toMatchObject({
      reviewId: correction.reviewId,
      reviewHeadRevision: 2,
      continuityFingerprint: first.pack.pack.continuity.fingerprint,
    });

    await expect(readStudioGenerationCheckpointOperationReceipt(
      fixture!.root,
      refreshRecord.requestHash,
    )).resolves.toMatchObject({ operationKind: "refresh", outcomeId: refreshed.checkpointId });
    const refreshCommandReplay = await executeIdempotentCommand(fixture!.root, {
      ...refreshCommand,
      requestId: "p7-checkpoint-command-refresh-replay-2",
    });
    expect(refreshCommandReplay).toMatchObject({ status: "succeeded", replayed: true, requestHash: refreshRecord.requestHash });

    const attestCommand = {
      requestId: "p7-checkpoint-command-attest-request-2",
      idempotencyKey: "p7-checkpoint-command-attest-key-2",
      request: {
        command: "attest_studio_generation_checkpoint" as const,
        payload: {
          batchNumber: 1,
          checkpointId: refreshed.checkpointId,
          checkpointFingerprint: refreshed.fingerprint,
          expectedHeadRevision: 1,
          decision: "pass" as const,
          reviewer: "user" as const,
          note: "成员修正后对新内容地址重新批准。",
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "attest_studio_generation_checkpoint";
    await expect(executeIdempotentCommand(fixture!.root, attestCommand)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const attestRecord = await executeIdempotentCommand(fixture!.root, {
      ...attestCommand,
      requestId: "p7-checkpoint-command-attest-recovery-2",
    });
    expect(attestRecord).toMatchObject({ status: "succeeded", replayed: true, result: { reconciled: true } });
    const reattestation = attestRecord.result as Awaited<ReturnType<typeof attestStudioGenerationCheckpoint>>;
    expect(reattestation).toMatchObject({ headRevision: 2, current: true, decision: "pass" });
    await expect(readStudioGenerationCheckpointOperationReceipt(
      fixture!.root,
      attestRecord.requestHash,
    )).resolves.toMatchObject({ operationKind: "attest", outcomeId: reattestation.attestationId });
    await expect(assertStudioGenerationCheckpointDispatchAllowed(fixture!.root, {
      unitId: fixture!.units.twoPanel.unit.id,
      panelId: seventhPanel.id,
    })).resolves.toMatchObject({ allowed: true, reason: "checkpoint-pass-current" });

    const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas/studio-generation-ledger.sqlite"));
    try {
      const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number }).count);
      expect(count("studio_generation_checkpoint_snapshots")).toBe(2);
      expect(count("studio_generation_checkpoint_attestations")).toBe(2);
      expect(count("studio_generation_checkpoint_operation_receipts")).toBe(4);
    } finally {
      db.close();
    }
  });
});
