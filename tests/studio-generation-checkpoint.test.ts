import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  __commandRequestHashForTests,
  executeIdempotentCommand,
  listCommandLedger,
} from "../src/core/command-bus.js";
import { upsertCommandLedgerEntry } from "../src/core/command-ledger-store.js";
import {
  __setBeforeCheckpointSchemaPromotionHookForTests,
  __setBeforeCheckpointSchemaWritableOpenHookForTests,
  assertStudioGenerationCheckpointDispatchAllowed,
  attestStudioGenerationCheckpoint,
  getStudioGenerationCheckpointCanvasProjection,
  getStudioGenerationCheckpointControl,
  readStudioGenerationCheckpointOperationReceipt,
  readStudioGenerationCheckpointOperationRecordReadOnly,
  refreshStudioGenerationCheckpoint,
} from "../src/core/studio-generation-checkpoint.js";
import { __setBeforeGenerationWritableOpenHookForTests } from "../src/core/studio-generation-ledger-storage.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  readStudioGenerationDispatch,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { findEventsByIdempotencyKey } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

async function checkpointOwnerFilesystemSnapshot(projectRoot: string): Promise<Record<string, unknown>> {
  const root = path.join(projectRoot, ".aicanvas");
  const result: Record<string, unknown> = {};
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(root, relative);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result[relative] = null;
        return;
      }
      throw error;
    }
    if (metadata.isDirectory()) {
      result[relative] = { kind: "directory", ino: String(metadata.ino), mtimeMs: metadata.mtimeMs };
      for (const name of (await readdir(absolute)).sort()) await visit(`${relative}/${name}`);
      return;
    }
    result[relative] = {
      kind: "file",
      ino: String(metadata.ino),
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
    };
  }
  for (const relative of [
    "studio-generation-ledger.sqlite",
    "studio-generation-ledger.sqlite-wal",
    "studio-generation-ledger.sqlite-shm",
    "studio-generation",
  ]) await visit(relative);
  return result;
}

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  __setBeforeCheckpointSchemaPromotionHookForTests(null);
  __setBeforeCheckpointSchemaWritableOpenHookForTests(null);
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

function downgradeCheckpointOperationReceiptsToSchema1(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      DROP TRIGGER IF EXISTS studio_generation_checkpoint_receipts_no_update;
      DROP TRIGGER IF EXISTS studio_generation_checkpoint_receipts_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_checkpoint_receipts_require_head_revision;
      ALTER TABLE studio_generation_checkpoint_operation_receipts
        RENAME TO studio_generation_checkpoint_operation_receipts_pre_v1_fixture;
      CREATE TABLE studio_generation_checkpoint_operation_receipts (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('refresh', 'attest')),
        input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
        outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('checkpoint', 'attestation')),
        outcome_id TEXT NOT NULL,
        outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO studio_generation_checkpoint_operation_receipts(
        operation_id,operation_kind,input_fingerprint,outcome_kind,outcome_id,outcome_fingerprint,created_at
      )
      SELECT operation_id,operation_kind,input_fingerprint,outcome_kind,outcome_id,outcome_fingerprint,created_at
      FROM studio_generation_checkpoint_operation_receipts_pre_v1_fixture;
      DROP TABLE studio_generation_checkpoint_operation_receipts_pre_v1_fixture;
      CREATE TRIGGER studio_generation_checkpoint_receipts_no_update
        BEFORE UPDATE ON studio_generation_checkpoint_operation_receipts
        BEGIN SELECT RAISE(ABORT, 'generation checkpoint receipts are append-only'); END;
      CREATE TRIGGER studio_generation_checkpoint_receipts_no_delete
        BEFORE DELETE ON studio_generation_checkpoint_operation_receipts
        BEGIN SELECT RAISE(ABORT, 'generation checkpoint receipts are append-only'); END;
      UPDATE studio_generation_ledger_meta SET value='1' WHERE key='p7_checkpoint_schema_version';
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback after failed BEGIN */ }
    throw error;
  } finally {
    db.close();
  }
}

function downgradeCheckpointOperationReceiptsToDeployedSchema2(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      DROP TRIGGER IF EXISTS studio_generation_checkpoint_receipts_no_update;
      DROP TRIGGER IF EXISTS studio_generation_checkpoint_receipts_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_checkpoint_receipts_require_head_revision;
      ALTER TABLE studio_generation_checkpoint_operation_receipts
        RENAME TO studio_generation_checkpoint_operation_receipts_pre_v2_fixture;
      CREATE TABLE studio_generation_checkpoint_operation_receipts (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('refresh', 'attest')),
        input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
        outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('checkpoint', 'attestation')),
        outcome_id TEXT NOT NULL,
        outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
        head_revision INTEGER NOT NULL CHECK(head_revision >= 1),
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO studio_generation_checkpoint_operation_receipts(
        operation_id,operation_kind,input_fingerprint,outcome_kind,outcome_id,outcome_fingerprint,
        head_revision,created_at
      )
      SELECT operation_id,operation_kind,input_fingerprint,outcome_kind,outcome_id,outcome_fingerprint,
             head_revision,created_at
      FROM studio_generation_checkpoint_operation_receipts_pre_v2_fixture;
      DROP TABLE studio_generation_checkpoint_operation_receipts_pre_v2_fixture;
      CREATE TRIGGER studio_generation_checkpoint_receipts_no_update
        BEFORE UPDATE ON studio_generation_checkpoint_operation_receipts
        BEGIN SELECT RAISE(ABORT, 'generation checkpoint receipts are append-only'); END;
      CREATE TRIGGER studio_generation_checkpoint_receipts_no_delete
        BEFORE DELETE ON studio_generation_checkpoint_operation_receipts
        BEGIN SELECT RAISE(ABORT, 'generation checkpoint receipts are append-only'); END;
      UPDATE studio_generation_ledger_meta SET value='2' WHERE key='p7_checkpoint_schema_version';
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback after failed BEGIN */ }
    throw error;
  } finally {
    db.close();
  }
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
    expect(refreshRecord).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        reconciled: true,
        current: false,
        eligibleForPass: false,
        currentStaleReasons: expect.arrayContaining(["strict-recovery-currentness-not-proven"]),
      },
    });
    const refreshed = refreshRecord.result as Awaited<ReturnType<typeof refreshStudioGenerationCheckpoint>>;
    expect(refreshed).toMatchObject({ headRevision: 2, current: false, eligibleForPass: false });
    expect(refreshed.checkpointId).not.toBe(checkpoint.checkpointId);
    expect(refreshed.members[0]).toMatchObject({
      reviewId: correction.reviewId,
      reviewHeadRevision: 2,
      continuityFingerprint: first.pack.pack.continuity.fingerprint,
    });
    const persistedRefresh = (await listCommandLedger(fixture!.root))
      .find((entry) => entry.idempotencyKey === refreshCommand.idempotencyKey);
    expect(persistedRefresh?.result).toMatchObject({
      kind: "studio-operation-result-locator",
      operation: "generation-checkpoint-refresh",
      checkpointId: refreshed.checkpointId,
    });
    expect(JSON.stringify(persistedRefresh)).not.toContain("members");

    await expect(readStudioGenerationCheckpointOperationReceipt(
      fixture!.root,
      refreshRecord.requestHash,
    )).resolves.toMatchObject({ operationKind: "refresh", outcomeId: refreshed.checkpointId });
    const refreshCommandReplay = await executeIdempotentCommand(fixture!.root, {
      ...refreshCommand,
      requestId: "p7-checkpoint-command-refresh-replay-2",
    });
    expect(refreshCommandReplay).toMatchObject({
      status: "succeeded",
      replayed: true,
      requestHash: refreshRecord.requestHash,
      result: {
        checkpointId: refreshed.checkpointId,
        members: expect.any(Array),
        headRevision: 2,
        current: false,
        eligibleForPass: false,
        currentStaleReasons: expect.arrayContaining(["strict-recovery-currentness-not-proven"]),
      },
    });

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
    expect(attestRecord).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        reconciled: true,
        current: false,
        currentStaleReasons: expect.arrayContaining(["strict-recovery-currentness-not-proven"]),
      },
    });
    const reattestation = attestRecord.result as Awaited<ReturnType<typeof attestStudioGenerationCheckpoint>>;
    expect(reattestation).toMatchObject({ headRevision: 2, current: false, decision: "pass" });
    const persistedAttest = (await listCommandLedger(fixture!.root))
      .find((entry) => entry.idempotencyKey === attestCommand.idempotencyKey);
    expect(persistedAttest?.result).toMatchObject({
      kind: "studio-operation-result-locator",
      operation: "generation-checkpoint-attest",
      attestationId: reattestation.attestationId,
    });
    expect(JSON.stringify(persistedAttest)).not.toContain(attestCommand.request.payload.note);
    expect(JSON.stringify(persistedAttest)).not.toContain("reviewer");
    await expect(readStudioGenerationCheckpointOperationReceipt(
      fixture!.root,
      attestRecord.requestHash,
    )).resolves.toMatchObject({ operationKind: "attest", outcomeId: reattestation.attestationId });
    const attestReplay = await executeIdempotentCommand(fixture!.root, {
      ...attestCommand,
      requestId: "p7-checkpoint-command-attest-replay-2",
    });
    expect(attestReplay).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        attestationId: reattestation.attestationId,
        reviewer: "user",
        note: attestCommand.request.payload.note,
        headRevision: 2,
        current: false,
        currentStaleReasons: expect.arrayContaining(["strict-recovery-currentness-not-proven"]),
      },
    });
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

    let generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
    try {
      await expect(readStudioGenerationCheckpointOperationRecordReadOnly(fixture!.root, {
        operationId: attestRecord.requestHash,
        ...attestCommand.request.payload,
      })).resolves.toMatchObject({
        outcome: { attestationId: reattestation.attestationId, current: false },
      });
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);

    const ledgerDb = new DatabaseSync(path.join(fixture!.root, ".aicanvas", "command-ledger.sqlite"));
    try {
      const row = ledgerDb.prepare(
        "SELECT payload_json FROM command_ledger_entries WHERE idempotency_key=?",
      ).get(attestCommand.idempotencyKey) as { payload_json: string };
      const tampered = JSON.parse(row.payload_json) as { result: Record<string, unknown> };
      tampered.result.ownerFingerprint = "9".repeat(64);
      ledgerDb.prepare(
        "UPDATE command_ledger_entries SET payload_json=? WHERE idempotency_key=?",
      ).run(JSON.stringify(tampered), attestCommand.idempotencyKey);
    } finally {
      ledgerDb.close();
    }
    await expect(executeIdempotentCommand(fixture!.root, {
      ...attestCommand,
      requestId: "p7-checkpoint-command-attest-tampered-locator-2",
    })).rejects.toThrow(/摘要|冲突|locator|回执/u);

    const ownerDb = new DatabaseSync(path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite"));
    try {
      ownerDb.exec(`
        DROP TRIGGER studio_generation_checkpoint_receipts_no_update;
        CREATE TRIGGER studio_generation_checkpoint_receipts_no_update
          BEFORE UPDATE ON studio_generation_checkpoint_operation_receipts
          BEGIN SELECT 1; END;
      `);
    } finally {
      ownerDb.close();
    }
    const ownerBeforeStrictFailure = await checkpointOwnerFilesystemSnapshot(fixture!.root);
    generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
    try {
      await expect(readStudioGenerationCheckpointOperationRecordReadOnly(fixture!.root, {
        operationId: attestRecord.requestHash,
        ...attestCommand.request.payload,
      })).rejects.toThrow(/generation ledger 严格只读 proof 失败/u);
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);
    expect(await checkpointOwnerFilesystemSnapshot(fixture!.root)).toEqual(ownerBeforeStrictFailure);
  });

  it("refresh receipt 持久化历史 headRevision；terminal locator 缺失且 Head 被后续 refresh 推进后，durable recovery 不得用 live Head 猜", { timeout: 300_000 }, async () => {
    const produced = await produceReviewedSix();
    const first = produced[0]!;
    const refreshCommand = {
      requestId: "p7-checkpoint-historical-head-crash-request",
      idempotencyKey: "p7-checkpoint-historical-head-crash-key",
      request: {
        command: "refresh_studio_generation_checkpoint" as const,
        payload: { batchNumber: 1, expectedHeadRevision: 0 },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "refresh_studio_generation_checkpoint";
    await expect(executeIdempotentCommand(fixture!.root, refreshCommand)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;

    const ownerDbAfterCrash = new DatabaseSync(path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite"), {
      readOnly: true,
    });
    let crashedReceipt: { outcome_id: string; head_revision: number };
    try {
      crashedReceipt = ownerDbAfterCrash.prepare(`
        SELECT outcome_id, head_revision
        FROM studio_generation_checkpoint_operation_receipts
        WHERE operation_kind='refresh'
      `).get() as { outcome_id: string; head_revision: number };
      expect(Number(crashedReceipt.head_revision)).toBe(1);
      expect(ownerDbAfterCrash.prepare(
        "SELECT revision, checkpoint_id FROM studio_generation_checkpoint_heads WHERE batch_number=1",
      ).get()).toMatchObject({ revision: 1, checkpoint_id: crashedReceipt.outcome_id });
    } finally {
      ownerDbAfterCrash.close();
    }

    const firstCorrection = await submitStudioGenerationReview(fixture!.root, {
      operationId: "p7-checkpoint-historical-head-correction-1",
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
        { code: "identity-consistency", status: "pass", note: "推进 Head 前的 correction" },
        { code: "raw-labeled-pair", status: "pass", note: "同 run 成对" },
      ],
      reviewer: "p7-checkpoint-test",
      note: "使崩溃 refresh 的 checkpoint 不再是 live Head。",
    });
    expect(firstCorrection).toMatchObject({ headRevision: 2, current: true });

    const advanced = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-historical-head-advance",
      batchNumber: 1,
      expectedHeadRevision: 1,
    });
    expect(advanced).toMatchObject({ head: true, headRevision: 2, current: true });
    expect(advanced.checkpointId).not.toBe(crashedReceipt.outcome_id);

    const countsBeforeRecovery = (() => {
      const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite"), {
        readOnly: true,
      });
      try {
        const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number }).count);
        return {
          snapshots: count("studio_generation_checkpoint_snapshots"),
          receipts: count("studio_generation_checkpoint_operation_receipts"),
          liveRevision: Number((db.prepare(
            "SELECT revision FROM studio_generation_checkpoint_heads WHERE batch_number=1",
          ).get() as { revision: number }).revision),
        };
      } finally {
        db.close();
      }
    })();
    expect(countsBeforeRecovery).toMatchObject({ snapshots: 2, receipts: 2, liveRevision: 2 });

    let generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
    let recovered;
    try {
      recovered = await executeIdempotentCommand(fixture!.root, {
        ...refreshCommand,
        requestId: "p7-checkpoint-historical-head-crash-recovery",
      });
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);
    expect(recovered).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        reconciled: true,
        checkpointId: crashedReceipt.outcome_id,
        headRevision: 1,
        head: false,
        current: false,
        eligibleForPass: false,
        currentStaleReasons: expect.arrayContaining([
          "not-current-checkpoint-head",
          "strict-recovery-currentness-not-proven",
        ]),
      },
    });
    expect((recovered.result as { headRevision: number }).headRevision).not.toBe(countsBeforeRecovery.liveRevision);
    expect((recovered.result as { checkpointId: string }).checkpointId).not.toBe(advanced.checkpointId);

    const countsAfterRecovery = (() => {
      const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite"), {
        readOnly: true,
      });
      try {
        const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number }).count);
        const receipt = db.prepare(`
          SELECT outcome_id, head_revision
          FROM studio_generation_checkpoint_operation_receipts
          WHERE operation_id=?
        `).get(recovered.requestHash) as { outcome_id: string; head_revision: number };
        return {
          snapshots: count("studio_generation_checkpoint_snapshots"),
          receipts: count("studio_generation_checkpoint_operation_receipts"),
          liveRevision: Number((db.prepare(
            "SELECT revision FROM studio_generation_checkpoint_heads WHERE batch_number=1",
          ).get() as { revision: number }).revision),
          receipt,
        };
      } finally {
        db.close();
      }
    })();
    expect(countsAfterRecovery.snapshots).toBe(countsBeforeRecovery.snapshots);
    expect(countsAfterRecovery.receipts).toBe(countsBeforeRecovery.receipts);
    expect(countsAfterRecovery.liveRevision).toBe(2);
    expect(Number(countsAfterRecovery.receipt.head_revision)).toBe(1);
    expect(countsAfterRecovery.receipt.outcome_id).toBe(crashedReceipt.outcome_id);

    const persisted = (await listCommandLedger(fixture!.root))
      .find((entry) => entry.idempotencyKey === refreshCommand.idempotencyKey);
    expect(persisted?.result).toMatchObject({
      kind: "studio-operation-result-locator",
      operation: "generation-checkpoint-refresh",
      checkpointId: crashedReceipt.outcome_id,
      headRevision: 1,
    });

    await expect(readStudioGenerationCheckpointOperationRecordReadOnly(fixture!.root, {
      operationId: recovered.requestHash,
      batchNumber: 1,
      expectedHeadRevision: 0,
    })).resolves.toMatchObject({
      outcome: {
        checkpointId: crashedReceipt.outcome_id,
        headRevision: 1,
        current: false,
      },
    });
    await expect(readStudioGenerationCheckpointOperationRecordReadOnly(fixture!.root, {
      operationId: recovered.requestHash,
      batchNumber: 1,
      expectedHeadRevision: 0,
    }, { historicalHeadRevision: 2 })).rejects.toMatchObject({ code: "storage-invalid" });

    const liveControl = await getStudioGenerationCheckpointControl(fixture!.root);
    expect(liveControl.batches[0]).toMatchObject({
      checkpointHeadRevision: 2,
      checkpoint: { checkpointId: advanced.checkpointId, head: true },
    });
  });

  it("真实 dead owner 无 terminal：SIGKILL 后 Head 推进，同键按 receipt 历史锚恢复且不重写 owner", { timeout: 300_000 }, async () => {
    const produced = await produceReviewedSix();
    const first = produced[0]!;
    const request = {
      command: "refresh_studio_generation_checkpoint" as const,
      payload: { batchNumber: 1, expectedHeadRevision: 0 },
    };
    const requestHash = __commandRequestHashForTests(fixture!.root, request);
    const owner = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: requestHash,
      ...request.payload,
    });
    expect(owner).toMatchObject({ headRevision: 1, current: true });

    const databasePath = path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const ownerCounts = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number }).count);
        return {
          snapshots: count("studio_generation_checkpoint_snapshots"),
          receipts: count("studio_generation_checkpoint_operation_receipts"),
          headRevision: Number((db.prepare(
            "SELECT revision FROM studio_generation_checkpoint_heads WHERE batch_number=1",
          ).get() as { revision: number }).revision),
        };
      } finally {
        db.close();
      }
    };
    const idempotencyKey = "p7-checkpoint-real-dead-owner-key-0001";
    const startedAt = new Date().toISOString();
    const processOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      processOwner.once("spawn", resolve);
      processOwner.once("error", reject);
    });
    try {
      await upsertCommandLedgerEntry(fixture!.root, {
        schemaVersion: 1,
        requestId: "p7-checkpoint-real-dead-owner-request-0001",
        idempotencyKey,
        command: request.command,
        status: "running",
        replayed: false,
        requestHash,
        execution: { pid: processOwner.pid!, phase: "executing", heartbeatAt: startedAt },
        durableReconciliation: { schemaVersion: 1, request },
        startedAt,
      });
      expect((await findEventsByIdempotencyKey(fixture!.root, idempotencyKey, 20))
        .filter((event) => event.type === "command.side-effect-committed")).toHaveLength(0);

      expect(processOwner.kill("SIGKILL")).toBe(true);
      await new Promise<void>((resolve) => processOwner.once("exit", () => resolve()));

      const correction = await submitStudioGenerationReview(fixture!.root, {
        operationId: "p7-checkpoint-real-dead-owner-correction",
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
          { code: "identity-consistency", status: "pass", note: "真实 dead owner Head 推进" },
          { code: "raw-labeled-pair", status: "pass", note: "同 run 成对" },
        ],
        reviewer: "p7-checkpoint-real-dead-owner-test",
        note: "owner receipt 落盘并 SIGKILL 后推进 checkpoint Head。",
      });
      expect(correction).toMatchObject({ headRevision: 2, current: true });
      const advanced = await refreshStudioGenerationCheckpoint(fixture!.root, {
        operationId: "p7-checkpoint-real-dead-owner-head-advance",
        batchNumber: 1,
        expectedHeadRevision: 1,
      });
      expect(advanced).toMatchObject({ headRevision: 2, current: true });
      expect(advanced.checkpointId).not.toBe(owner.checkpointId);
      const beforeRecovery = ownerCounts();
      expect(beforeRecovery).toEqual({ snapshots: 2, receipts: 2, headRevision: 2 });

      let generationWritableOpens = 0;
      __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
      let recovered;
      try {
        recovered = await executeIdempotentCommand(fixture!.root, {
          requestId: "p7-checkpoint-real-dead-owner-waiter-0001",
          idempotencyKey,
          request,
        }, { waitForRunningMs: 10_000 });
      } finally {
        __setBeforeGenerationWritableOpenHookForTests(null);
      }
      expect(generationWritableOpens).toBe(0);
      expect(recovered).toMatchObject({
        status: "succeeded",
        replayed: true,
        result: {
          reconciled: true,
          checkpointId: owner.checkpointId,
          headRevision: 1,
          head: false,
          current: false,
          currentStaleReasons: expect.arrayContaining([
            "not-current-checkpoint-head",
            "strict-recovery-currentness-not-proven",
          ]),
        },
      });
      expect(ownerCounts()).toEqual(beforeRecovery);
      const persisted = (await listCommandLedger(fixture!.root))
        .find((entry) => entry.idempotencyKey === idempotencyKey);
      expect(persisted).toMatchObject({
        status: "succeeded",
        result: {
          kind: "studio-operation-result-locator",
          operation: "generation-checkpoint-refresh",
          checkpointId: owner.checkpointId,
          headRevision: 1,
        },
      });
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
      if (processOwner.exitCode === null && processOwner.signalCode === null) processOwner.kill("SIGKILL");
    }
  });

  it("schema 1 显式迁移到当前 schema 后可写；旧 receipt 仍因缺历史锚 fail-closed", { timeout: 300_000 }, async () => {
    const produced = await produceReviewedSix();
    expect(produced).toHaveLength(6);
    const refreshed = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-schema1-readonly-refresh",
      batchNumber: 1,
      expectedHeadRevision: 0,
    });
    expect(refreshed).toMatchObject({ headRevision: 1, current: true });

    const databasePath = path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeCheckpointOperationReceiptsToDeployedSchema2(databasePath);
    const migratedFromSchema2 = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-schema2-migrated-refresh",
      batchNumber: 1,
      expectedHeadRevision: 1,
    });
    expect(migratedFromSchema2).toMatchObject({
      checkpointId: refreshed.checkpointId,
      headRevision: 1,
      current: true,
    });
    const schema2Audit = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(schema2Audit.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'",
      ).get()).toEqual({ value: "3" });
      expect(schema2Audit.prepare(`
        SELECT operation_id, head_revision
        FROM studio_generation_checkpoint_operation_receipts
        WHERE operation_id IN (?, ?)
        ORDER BY operation_id
      `).all("p7-checkpoint-schema1-readonly-refresh", "p7-checkpoint-schema2-migrated-refresh"))
        .toEqual([
          { operation_id: "p7-checkpoint-schema1-readonly-refresh", head_revision: 1 },
          { operation_id: "p7-checkpoint-schema2-migrated-refresh", head_revision: 1 },
        ]);
    } finally {
      schema2Audit.close();
    }
    downgradeCheckpointOperationReceiptsToSchema1(databasePath);

    __setBeforeCheckpointSchemaPromotionHookForTests(() => {
      throw new Error("checkpoint test migration rollback");
    });
    await expect(refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-schema1-rollback-probe",
      batchNumber: 1,
      expectedHeadRevision: 1,
    })).rejects.toMatchObject({
      code: "storage-invalid",
      message: "六图停检无法初始化共享 generation ledger。",
    });
    __setBeforeCheckpointSchemaPromotionHookForTests(null);
    const rolledBack = new DatabaseSync(databasePath);
    try {
      expect(rolledBack.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'",
      ).get()).toEqual({ value: "1" });
      expect((rolledBack.prepare(
        "PRAGMA table_info(studio_generation_checkpoint_operation_receipts)",
      ).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("head_revision");
      expect(rolledBack.prepare(
        "SELECT COUNT(*) AS count FROM studio_generation_checkpoint_operation_receipts",
      ).get()).toEqual({ count: 2 });
    } finally {
      rolledBack.close();
    }

    const control = await getStudioGenerationCheckpointControl(fixture!.root);
    expect(control.batches[0]).toMatchObject({
      checkpointHeadRevision: 1,
      checkpoint: { checkpointId: refreshed.checkpointId, head: true },
    });

    await expect(readStudioGenerationCheckpointOperationRecordReadOnly(fixture!.root, {
      operationId: "p7-checkpoint-schema1-readonly-refresh",
      batchNumber: 1,
      expectedHeadRevision: 0,
    })).rejects.toMatchObject({
      code: "storage-invalid",
      details: expect.arrayContaining([
        expect.stringMatching(/缺少不可变历史 headRevision/u),
      ]),
    });

    const migratedRefresh = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-schema1-migrated-refresh",
      batchNumber: 1,
      expectedHeadRevision: 1,
    });
    expect(migratedRefresh).toMatchObject({
      checkpointId: refreshed.checkpointId,
      headRevision: 1,
      current: true,
    });

    const migratedAttestation = await attestStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-schema1-migrated-attest",
      batchNumber: 1,
      checkpointId: migratedRefresh.checkpointId,
      checkpointFingerprint: migratedRefresh.fingerprint,
      expectedHeadRevision: 0,
      decision: "pass",
      reviewer: "p7-checkpoint-schema-migration-test",
      note: "schema 1 显式迁移后写入的新 attestation。",
    });
    expect(migratedAttestation).toMatchObject({
      checkpointId: migratedRefresh.checkpointId,
      headRevision: 1,
      current: true,
    });

    await expect(readStudioGenerationCheckpointOperationRecordReadOnly(fixture!.root, {
      operationId: "p7-checkpoint-schema1-readonly-refresh",
      batchNumber: 1,
      expectedHeadRevision: 0,
    })).rejects.toMatchObject({
      code: "storage-invalid",
      details: expect.arrayContaining([
        expect.stringMatching(/缺少不可变历史 headRevision/u),
      ]),
    });

    const audit = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(audit.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='p7_checkpoint_schema_version'").get())
        .toEqual({ value: "3" });
      const columns = (audit.prepare("PRAGMA table_info(studio_generation_checkpoint_operation_receipts)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toContain("head_revision");
      expect(audit.prepare(`
        SELECT operation_id, head_revision
        FROM studio_generation_checkpoint_operation_receipts
        ORDER BY operation_id
      `).all()).toEqual(expect.arrayContaining([
        { operation_id: "p7-checkpoint-schema1-readonly-refresh", head_revision: null },
        { operation_id: "p7-checkpoint-schema1-migrated-refresh", head_revision: 1 },
        { operation_id: "p7-checkpoint-schema1-migrated-attest", head_revision: 1 },
      ]));
    } finally {
      audit.close();
    }
    const requireHeadRevision = new DatabaseSync(databasePath);
    try {
      expect(() => requireHeadRevision.prepare(`
        INSERT INTO studio_generation_checkpoint_operation_receipts(
          operation_id,operation_kind,input_fingerprint,outcome_kind,
          outcome_id,outcome_fingerprint,head_revision,created_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(
        "p7-checkpoint-null-head-rejected",
        "refresh",
        "a".repeat(64),
        "checkpoint",
        refreshed.checkpointId,
        refreshed.fingerprint,
        null,
        new Date().toISOString(),
      )).toThrow(/head revision is required/u);
    } finally {
      requireHeadRevision.close();
    }
  });

  it("并发迁移只读收敛必须绑定原 inode，合法 schema 3 换绑也失败关闭且零业务写", { timeout: 300_000 }, async () => {
    await produceReviewedSix();
    const refreshed = await refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-inode-swap-seed",
      batchNumber: 1,
      expectedHeadRevision: 0,
    });
    expect(refreshed).toMatchObject({ headRevision: 1, current: true });

    const databasePath = path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const replacementPath = path.join(fixture!.root, ".aicanvas", "checkpoint-valid-v3-replacement.sqlite");
    const detachedPath = path.join(fixture!.root, ".aicanvas", "checkpoint-original-schema1.sqlite");
    const source = new DatabaseSync(databasePath);
    try {
      source.exec(`VACUUM INTO '${replacementPath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    downgradeCheckpointOperationReceiptsToSchema1(databasePath);

    const businessCounts = (filePath: string) => {
      const db = new DatabaseSync(filePath, { readOnly: true });
      try {
        const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as { count: number }).count);
        return {
          snapshots: count("studio_generation_checkpoint_snapshots"),
          attestations: count("studio_generation_checkpoint_attestations"),
          receipts: count("studio_generation_checkpoint_operation_receipts"),
        };
      } finally {
        db.close();
      }
    };
    const originalBefore = businessCounts(databasePath);
    const replacementBefore = businessCounts(replacementPath);

    __setBeforeCheckpointSchemaWritableOpenHookForTests(() => {
      __setBeforeCheckpointSchemaWritableOpenHookForTests(null);
      for (const suffix of ["-wal", "-shm", "-journal"] as const) {
        if (existsSync(`${databasePath}${suffix}`)) {
          renameSync(`${databasePath}${suffix}`, `${detachedPath}${suffix}`);
        }
      }
      renameSync(databasePath, detachedPath);
      renameSync(replacementPath, databasePath);
    });

    await expect(refreshStudioGenerationCheckpoint(fixture!.root, {
      operationId: "p7-checkpoint-inode-swap-must-fail",
      batchNumber: 1,
      expectedHeadRevision: 1,
    })).rejects.toMatchObject({
      code: "storage-invalid",
      message: "六图停检无法初始化共享 generation ledger。",
    });

    expect(businessCounts(detachedPath)).toEqual(originalBefore);
    expect(businessCounts(databasePath)).toEqual(replacementBefore);
    for (const filePath of [detachedPath, databasePath]) {
      const db = new DatabaseSync(filePath, { readOnly: true });
      try {
        expect(db.prepare(`
          SELECT operation_id FROM studio_generation_checkpoint_operation_receipts
          WHERE operation_id='p7-checkpoint-inode-swap-must-fail'
        `).get()).toBeUndefined();
      } finally {
        db.close();
      }
    }
  });
});
