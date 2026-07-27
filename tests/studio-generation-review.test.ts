import path from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
  listStudioGenerationReviewHistory,
  readStudioGenerationReview,
  readStudioGenerationReviewOperationOutcome,
  submitStudioGenerationReview,
} from "../src/core/studio-generation-review.js";
import { getStudioCanonicalAsset } from "../src/core/material-studio.js";
import { getCurrentStudioPanelAssetBindingSet, getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function registeredPair() {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  const panel = fixture.units.sixPanel.panels[0]!;
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  const persisted = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: fixture.units.sixPanel.unit.id,
    panelId: panel.id,
  });
  const generationRunId = "p7-review-run-001";
  await dispatchStudioGenerationPack(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  return { panel, persisted, generationRunId, raw, labeled };
}

async function initializeReviewSchemaByWrite(): Promise<string> {
  const pair = await registeredPair();
  await submitStudioGenerationReview(fixture!.root, {
    operationId: "p7-review-schema-initialization-write",
    generationRunId: pair.generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: pair.raw.resultId,
    rawSha256: pair.raw.mediaSha256,
    labeledResultId: pair.labeled.resultId,
    labeledSha256: pair.labeled.mediaSha256,
    expectedPackFingerprint: pair.persisted.fingerprint,
    continuityFingerprint: pair.persisted.pack.continuity.fingerprint,
    decision: "pass",
    criteria: [{ code: "schema-write-proof", status: "pass" }],
    reviewer: "p7-test",
    note: "显式写命令初始化 Review schema。",
  });
  return fixture!.root;
}

describe("P7 Studio generation Review 追加账本", () => {
  it("纯查询在 Review schema 或数据库缺失时保持零写足迹并返回未审/空结果", async () => {
    fixture = await createStudioP7Fixture();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const beforeBytes = await readFile(databasePath);
    const beforeStat = await stat(databasePath, { bigint: true });
    const before = new DatabaseSync(databasePath, { readOnly: true });
    expect(before.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
    ).get()).toBeUndefined();
    expect(before.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name GLOB 'studio_generation_review_*'",
    ).get()).toEqual({ count: 0 });
    before.close();

    await expect(getStudioGenerationReviewControl(fixture.root, "review-readonly-missing-schema"))
      .resolves.toMatchObject({
        generationRunId: "review-readonly-missing-schema",
        headRevision: 0,
        status: "unreviewed",
        blockers: ["review-missing"],
        nextAction: "submit-observation",
      });
    await expect(readStudioGenerationReview(fixture.root, "missing-review")).resolves.toBeNull();
    await expect(readStudioGenerationReviewOperationOutcome(fixture.root, "missing-operation"))
      .resolves.toBeNull();
    await expect(listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: "review-readonly-missing-schema",
    })).resolves.toEqual({ items: [] });

    const afterBytes = await readFile(databasePath);
    const afterStat = await stat(databasePath, { bigint: true });
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    expect(afterStat.ctimeNs).toBe(beforeStat.ctimeNs);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    expect(after.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
    ).get()).toBeUndefined();
    expect(after.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name GLOB 'studio_generation_review_*'",
    ).get()).toEqual({ count: 0 });
    after.close();

    await rm(databasePath);
    await expect(getStudioGenerationReviewControl(fixture.root, "review-readonly-missing-database"))
      .resolves.toMatchObject({
        headRevision: 0,
        status: "unreviewed",
        blockers: ["review-missing"],
      });
    await expect(readStudioGenerationReview(fixture.root, "missing-review")).resolves.toBeNull();
    await expect(readStudioGenerationReviewOperationOutcome(fixture.root, "missing-operation"))
      .resolves.toBeNull();
    await expect(listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: "review-readonly-missing-database",
    })).resolves.toEqual({ items: [] });
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Review future marker 与弱 schema 在 DDL 前失败关闭", async () => {
    const projectRoot = await initializeReviewSchemaByWrite();
    const databasePath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
    const future = new DatabaseSync(databasePath);
    future.prepare("UPDATE studio_generation_ledger_meta SET value='999' WHERE key='p7_review_schema_version'").run();
    future.close();

    await expect(getStudioGenerationReviewControl(projectRoot, "review-schema-probe-run"))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const futureAudit = new DatabaseSync(databasePath, { readOnly: true });
    expect(futureAudit.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'").get())
      .toEqual({ value: "999" });
    futureAudit.close();
    const futureRepair = new DatabaseSync(databasePath);
    futureRepair.prepare(
      "UPDATE studio_generation_ledger_meta SET value='1' WHERE key='p7_review_schema_version'",
    ).run();
    futureRepair.close();

    const weakPath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
    const weak = new DatabaseSync(weakPath);
    weak.exec(`
      DROP TRIGGER studio_generation_review_events_no_update;
      CREATE TRIGGER studio_generation_review_events_no_update
        BEFORE UPDATE ON studio_generation_review_events BEGIN SELECT 1; END;
    `);
    weak.close();

    await expect(getStudioGenerationReviewControl(projectRoot, "review-schema-probe-run"))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const weakAudit = new DatabaseSync(weakPath, { readOnly: true });
    expect(weakAudit.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='studio_generation_review_events_no_update'").get())
      .toEqual({ count: 1 });
    weakAudit.close();
    const weakRepair = new DatabaseSync(weakPath);
    weakRepair.exec(`
      DROP TRIGGER studio_generation_review_events_no_update;
      CREATE TRIGGER studio_generation_review_events_no_update
        BEFORE UPDATE ON studio_generation_review_events
        BEGIN SELECT RAISE(ABORT, 'generation review events are append-only'); END;
    `);
    weakRepair.close();

    const wrongIndexPath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
    const wrongIndex = new DatabaseSync(wrongIndexPath);
    wrongIndex.exec(`
      DROP INDEX studio_generation_review_run_sequence_idx;
      CREATE INDEX studio_generation_review_run_sequence_idx
        ON studio_generation_review_events(sequence);
    `);
    wrongIndex.close();
    await expect(getStudioGenerationReviewControl(projectRoot, "review-schema-probe-run"))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const wrongIndexRepair = new DatabaseSync(wrongIndexPath);
    wrongIndexRepair.exec(`
      DROP INDEX studio_generation_review_run_sequence_idx;
      CREATE INDEX studio_generation_review_run_sequence_idx
        ON studio_generation_review_events(generation_run_id, sequence);
    `);
    wrongIndexRepair.close();

    const extraPath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
    const extra = new DatabaseSync(extraPath);
    extra.exec(`
      CREATE TRIGGER studio_generation_review_extra_trigger
        AFTER INSERT ON studio_generation_review_events
        BEGIN DELETE FROM studio_generation_review_heads; END;
      CREATE VIEW studio_generation_review_extra_view AS
        SELECT review_id FROM studio_generation_review_events;
    `);
    extra.close();
    await expect(getStudioGenerationReviewControl(projectRoot, "review-schema-probe-run"))
      .rejects.toMatchObject({ code: "storage-invalid" });
  });

  it("observation/correction 仅追加，Head 使用 CAS，不改写资产、BindingSet 或剧本", async () => {
    const pair = await registeredPair();
    const before = {
      asset: await getStudioCanonicalAsset(fixture!.root, fixture!.assets.ahang.id),
      binding: await getCurrentStudioPanelAssetBindingSet(
        fixture!.root,
        fixture!.units.sixPanel.unit.id,
        pair.panel.id,
      ),
      unit: await getStudioProductionUnitSnapshot(fixture!.root, fixture!.units.sixPanel.unit.id),
    };
    const base = {
      generationRunId: pair.generationRunId,
      rawResultId: pair.raw.resultId,
      rawSha256: pair.raw.mediaSha256,
      labeledResultId: pair.labeled.resultId,
      labeledSha256: pair.labeled.mediaSha256,
      expectedPackFingerprint: pair.persisted.fingerprint,
      continuityFingerprint: pair.persisted.pack.continuity.fingerprint,
      criteria: [
        { code: "identity-consistency", status: "pass" as const, note: "机械 fixture 通过。" },
        { code: "raw-labeled-pair", status: "pass" as const, note: "SHA 成对。" },
      ],
      reviewer: "p7-test",
    };
    const observation = await submitStudioGenerationReview(fixture!.root, {
      ...base,
      operationId: "p7-review-observation-001",
      kind: "observation",
      expectedHeadRevision: 0,
      decision: "pass",
      note: "首次结果观察。",
    });
    expect(observation).toMatchObject({
      kind: "observation",
      headRevision: 1,
      currentAtSubmission: true,
      advancesHead: true,
      head: true,
      current: true,
      approvedRawEligible: true,
    });
    expect((await getStudioGenerationReviewControl(fixture!.root, pair.generationRunId))).toMatchObject({
      headRevision: 1,
      status: "pass",
      blockers: [],
      nextAction: "approved-raw-ready",
    });

    const replay = await submitStudioGenerationReview(fixture!.root, {
      ...base,
      operationId: "p7-review-observation-001",
      kind: "observation",
      expectedHeadRevision: 0,
      decision: "pass",
      note: "首次结果观察。",
    });
    expect(replay.reviewId).toBe(observation.reviewId);
    await expect(submitStudioGenerationReview(fixture!.root, {
      ...base,
      operationId: "p7-review-observation-001",
      kind: "observation",
      expectedHeadRevision: 0,
      decision: "pass",
      note: "同回执键异载荷。",
    })).rejects.toMatchObject({ code: "operation-conflict" });

    const correction = await submitStudioGenerationReview(fixture!.root, {
      ...base,
      operationId: "p7-review-correction-001",
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: observation.reviewId,
      decision: "rework",
      note: "人工复核后追加返工修正。",
    });
    expect(correction).toMatchObject({
      kind: "correction",
      baseHeadRevision: 1,
      headRevision: 2,
      supersedesReviewId: observation.reviewId,
      decision: "rework",
      head: true,
      current: true,
      approvedRawEligible: false,
    });
    expect((await getStudioGenerationReviewControl(fixture!.root, pair.generationRunId))).toMatchObject({
      headRevision: 2,
      status: "rework",
      blockers: ["review-rework"],
      nextAction: "submit-correction",
    });
    await expect(submitStudioGenerationReview(fixture!.root, {
      ...base,
      operationId: "p7-review-stale-cas",
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: observation.reviewId,
      decision: "pass",
      note: "旧 Head CAS 不得复活。",
    })).rejects.toMatchObject({ code: "review-conflict" });

    const history = await listStudioGenerationReviewHistory(fixture!.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    });
    expect(history.items).toHaveLength(2);
    expect(history.items.map((entry) => [entry.kind, entry.head])).toEqual([
      ["observation", false],
      ["correction", true],
    ]);
    const after = {
      asset: await getStudioCanonicalAsset(fixture!.root, fixture!.assets.ahang.id),
      binding: await getCurrentStudioPanelAssetBindingSet(
        fixture!.root,
        fixture!.units.sixPanel.unit.id,
        pair.panel.id,
      ),
      unit: await getStudioProductionUnitSnapshot(fixture!.root, fixture!.units.sixPanel.unit.id),
    };
    expect(after).toEqual(before);
    console.log(`P7_REVIEW_APPEND_ONLY_CAS ${JSON.stringify({ history: history.items.length, upstreamMutationCount: 0 })}`);
  });

  it("拒绝错配 raw/labeled 身份，失败时不建立 Review Head", async () => {
    const pair = await registeredPair();
    await expect(submitStudioGenerationReview(fixture!.root, {
      operationId: "p7-review-invalid-pair",
      generationRunId: pair.generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: pair.labeled.resultId,
      rawSha256: pair.labeled.mediaSha256,
      labeledResultId: pair.raw.resultId,
      labeledSha256: pair.raw.mediaSha256,
      expectedPackFingerprint: pair.persisted.fingerprint,
      continuityFingerprint: pair.persisted.pack.continuity.fingerprint,
      decision: "pass",
      criteria: [{ code: "identity-consistency", status: "pass" }],
      reviewer: "p7-test",
      note: "故意颠倒变体。",
    })).rejects.toMatchObject({ code: "result-pair-invalid" });
    expect(await getStudioGenerationReviewControl(fixture!.root, pair.generationRunId)).toMatchObject({
      headRevision: 0,
      status: "unreviewed",
      blockers: ["review-missing"],
    });

    await expect(submitStudioGenerationReview(fixture!.root, {
      operationId: "p7-review-invalid-continuity",
      generationRunId: pair.generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: pair.raw.resultId,
      rawSha256: pair.raw.mediaSha256,
      labeledResultId: pair.labeled.resultId,
      labeledSha256: pair.labeled.mediaSha256,
      expectedPackFingerprint: pair.persisted.fingerprint,
      continuityFingerprint: "d".repeat(64),
      decision: "pass",
      criteria: [{ code: "identity-consistency", status: "pass" }],
      reviewer: "p7-test",
      note: "故意伪造连续性快照指纹。",
    })).rejects.toMatchObject({ code: "result-pair-invalid" });
    expect(await getStudioGenerationReviewControl(fixture!.root, pair.generationRunId)).toMatchObject({
      headRevision: 0,
      status: "unreviewed",
      blockers: ["review-missing"],
    });
  });
});
