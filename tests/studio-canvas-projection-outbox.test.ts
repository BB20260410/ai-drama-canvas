/**
 * T11 Outbox 真实接入回归：
 * - ledger 初始化幂等建表，老库（无表）演进不影响既有表与 schema_version；
 * - raw/labeled 原子入账在同一 SQLite 事务内追加 outbox 事件（崩溃无半状态）；
 * - 重放按 projectionRevision 幂等，重复事件不产生重复节点；
 * - 重启恢复未消费事件；Review/连续性事实经 reconcile 幂等补缀。
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCanvasProjectionEvent,
  createCanvasProjectionEventApplier,
  ensureCanvasProjectionOutboxSchema,
  readUnconsumedCanvasProjectionEvents,
  reconcileCanvasProjectionOutbox,
  replayUnconsumedCanvasProjectionEvents,
  type CanvasProjectionEvent,
} from "../src/core/studio-canvas-projection-outbox.js";
import {
  getStudioGenerationLedgerState,
  initializeStudioGenerationLedger,
  registerStudioGenerationResultBundle,
} from "../src/core/studio-generation-ledger.js";
import {
  commitUnitGridBundle,
  createUnitGridFixtureProject,
  createUnitGridTestImage,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
} from "./helpers/studio-unit-grid-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureParent(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-outbox-parent-")));
  roots.push(parent);
  return parent;
}

function ledgerDatabasePath(root: string): string {
  return path.join(root, ".aicanvas", "studio-generation-ledger.sqlite");
}

function openLedgerDb(root: string): DatabaseSync {
  const db = new DatabaseSync(ledgerDatabasePath(root), { timeout: 5_000 });
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

function outboxRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM studio_canvas_projection_outbox ORDER BY sequence ASC").all() as Array<Record<string, unknown>>;
}

describe("T11 canvas projection outbox 真实接入", () => {
  it("ledger 初始化幂等建 outbox 表；模拟老库无表时演进且既有表与 schema_version 不受影响", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    // 首次初始化即建表（openDatabase 尾部 ensure）。
    const state = await initializeStudioGenerationLedger(fixture.root);
    expect(state.schemaVersion).toBe(7);
    let packsBefore = 0;
    let continuityBefore = 0;
    const db = openLedgerDb(fixture.root);
    try {
      const objects = () => db.prepare(`
        SELECT type, name FROM sqlite_master
        WHERE name LIKE 'studio_canvas_projection_outbox%' OR name LIKE 'idx_canvas_outbox%'
        ORDER BY type, name
      `).all() as Array<{ type: string; name: string }>;
      expect(objects()).toEqual([
        { type: "index", name: "idx_canvas_outbox_unconsumed" },
        { type: "index", name: "idx_canvas_outbox_unit" },
        { type: "table", name: "studio_canvas_projection_outbox" },
        { type: "trigger", name: "studio_canvas_projection_outbox_no_delete" },
        { type: "trigger", name: "studio_canvas_projection_outbox_no_update" },
      ]);
      // 模拟老库：无 outbox 表（既有业务表有真实行：fixture 已写九字段 continuity）。
      packsBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM studio_generation_packs").get() as { n: number }).n);
      continuityBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM studio_continuity_entries").get() as { n: number }).n);
      expect(continuityBefore).toBeGreaterThan(0);
      db.exec(`
        DROP TRIGGER studio_canvas_projection_outbox_no_update;
        DROP TRIGGER studio_canvas_projection_outbox_no_delete;
        DROP TABLE studio_canvas_projection_outbox;
      `);
      expect(objects()).toEqual([]);
    } finally {
      db.close();
    }
    // 老库演进：再次初始化补表，既有表行数与 schema_version 不变。
    const evolved = await initializeStudioGenerationLedger(fixture.root);
    expect(evolved.schemaVersion).toBe(7);
    const reopened = openLedgerDb(fixture.root);
    try {
      expect(Boolean(reopened.prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='studio_canvas_projection_outbox'",
      ).get())).toBe(true);
      const packsAfter = Number((reopened.prepare("SELECT COUNT(*) AS n FROM studio_generation_packs").get() as { n: number }).n);
      const continuityAfter = Number((reopened.prepare("SELECT COUNT(*) AS n FROM studio_continuity_entries").get() as { n: number }).n);
      expect(packsAfter).toBe(packsBefore);
      expect(continuityAfter).toBe(continuityBefore);
    } finally {
      reopened.close();
    }
  });

  it("raw/labeled 原子入账在同一事务追加 result-committed 事件；幂等回放与冲突回滚均不产生重复/半状态", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    const run = await freezeDispatchPrepareUnitGrid(fixture.root, fixture.unitId, "outbox-run-001");
    const bundle = await commitUnitGridBundle(fixture.root, run, "outbox-bundle-001");

    const db = openLedgerDb(fixture.root);
    try {
      const rows = outboxRows(db);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        projection_revision: 1,
        kind: "result-committed",
        unit_id: fixture.unitId,
        generation_run_id: "outbox-run-001",
        consumed: 0,
      });
      const payload = JSON.parse(String(rows[0]!.payload_json)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        rawResultId: bundle.raw.resultId,
        labeledResultId: bundle.labeled.resultId,
        targetKind: "unit-grid",
      });
    } finally {
      db.close();
    }

    // 幂等回放（同内容重复入账）：不重复追加事件。
    const replay = await registerStudioGenerationResultBundle(fixture.root, {
      packId: run.pack.packId,
      packFingerprint: run.pack.fingerprint,
      generationRunId: run.generationRunId,
      provider: "codex",
      rawMediaSha256: bundle.raw.mediaSha256,
      labeledMediaSha256: bundle.labeled.mediaSha256,
      callId: run.callId,
    });
    expect(replay.fingerprint).toBe(bundle.fingerprint);
    // 冲突（异内容）：事务内失败回滚，不得留下第二条事件（无半状态）。
    const otherRaw = await createUnitGridTestImage(fixture.root, "outbox-conflict-raw", "#111111");
    const otherLabeled = await createUnitGridTestImage(fixture.root, "outbox-conflict-labeled", "#222222");
    await expect(registerStudioGenerationResultBundle(fixture.root, {
      packId: run.pack.packId,
      packFingerprint: run.pack.fingerprint,
      generationRunId: run.generationRunId,
      provider: "codex",
      rawMediaSha256: otherRaw.sha256,
      labeledMediaSha256: otherLabeled.sha256,
      callId: run.callId,
    })).rejects.toMatchObject({ name: "StudioGenerationResultConflictError" });
    const verify = openLedgerDb(fixture.root);
    try {
      expect(outboxRows(verify).length).toBe(1);
    } finally {
      verify.close();
    }
  });

  it("append 参与调用方事务：ROLLBACK 无事件（崩溃注入无半状态），COMMIT 才可见", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    await initializeStudioGenerationLedger(fixture.root);
    const db = openLedgerDb(fixture.root);
    try {
      // 崩溃注入：事务内追加后回滚。
      db.exec("BEGIN IMMEDIATE");
      appendCanvasProjectionEvent(db, {
        kind: "unit-state-changed",
        unitId: fixture.unitId,
        payload: { stage: "crashed" },
      });
      db.exec("ROLLBACK");
      expect(outboxRows(db).length).toBe(0);
      // 正常提交：事件与业务写入同生共死。
      db.exec("BEGIN IMMEDIATE");
      const appended = appendCanvasProjectionEvent(db, {
        kind: "unit-state-changed",
        unitId: fixture.unitId,
        payload: { stage: "committed" },
      });
      db.exec("COMMIT");
      expect(appended.projectionRevision).toBe(1);
      expect(outboxRows(db).length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("重放按 projectionRevision 幂等：重复事件不产生重复节点，失败即停保持未消费", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    await initializeStudioGenerationLedger(fixture.root);
    const db = openLedgerDb(fixture.root);
    try {
      db.exec("BEGIN IMMEDIATE");
      appendCanvasProjectionEvent(db, { kind: "result-committed", unitId: fixture.unitId, generationRunId: "run-a" });
      appendCanvasProjectionEvent(db, { kind: "result-committed", unitId: fixture.unitId, generationRunId: "run-b" });
      // 同一逻辑节点（run-a）的第二条事件：revision 递增但节点 key 相同。
      appendCanvasProjectionEvent(db, { kind: "result-committed", unitId: fixture.unitId, generationRunId: "run-a" });
      db.exec("COMMIT");

      const applier = createCanvasProjectionEventApplier();
      const first = replayUnconsumedCanvasProjectionEvents(db, (event) => {
        applier.apply(event);
      });
      expect(first).toEqual({ applied: 3, consumed: 3, error: null });
      // 三条事件、两个逻辑节点：run-a 的重复事件 upsert 而非新增。
      expect(applier.nodes().size).toBe(2);
      expect(applier.appliedRevisions().size).toBe(3);
      // 再重放：无未消费事件。
      const second = replayUnconsumedCanvasProjectionEvents(db, (event) => {
        applier.apply(event);
      });
      expect(second).toEqual({ applied: 0, consumed: 0, error: null });
      // 同一 projectionRevision 重复 apply：跳过，不产生重复节点。
      const duplicate: CanvasProjectionEvent = {
        eventId: "dup",
        projectionRevision: 1,
        kind: "result-committed",
        unitId: fixture.unitId,
        generationRunId: "run-a",
        payload: {},
        consumed: false,
        createdAt: new Date().toISOString(),
      };
      expect(applier.apply(duplicate)).toBe("skipped-duplicate-revision");
      expect(applier.nodes().size).toBe(2);

      // 失败即停：追加两条新事件，第一条 apply 抛错 → 全部保持未消费。
      db.exec("BEGIN IMMEDIATE");
      appendCanvasProjectionEvent(db, { kind: "unit-state-changed", unitId: fixture.unitId });
      appendCanvasProjectionEvent(db, { kind: "unit-state-changed", unitId: "unit-other" });
      db.exec("COMMIT");
      const failing = replayUnconsumedCanvasProjectionEvents(db, () => {
        throw new Error("注入消费方崩溃");
      });
      expect(failing.applied).toBe(0);
      expect(failing.consumed).toBe(0);
      expect(failing.error).toContain("注入消费方崩溃");
      expect(readUnconsumedCanvasProjectionEvents(db).length).toBe(2);
    } finally {
      db.close();
    }
  });

  it("重启恢复：关闭重开数据库后未消费事件仍可读出并完成消费", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    const run = await freezeDispatchPrepareUnitGrid(fixture.root, fixture.unitId, "outbox-run-restart");
    await commitUnitGridBundle(fixture.root, run, "outbox-restart");

    const beforeRestart = openLedgerDb(fixture.root);
    let pending: CanvasProjectionEvent[];
    try {
      pending = readUnconsumedCanvasProjectionEvents(beforeRestart);
      expect(pending.length).toBe(1);
      expect(pending[0]).toMatchObject({ kind: "result-committed", projectionRevision: 1, consumed: false });
    } finally {
      beforeRestart.close();
    }
    // 模拟重启：全新连接读取并消费同一批事件。
    const afterRestart = openLedgerDb(fixture.root);
    try {
      const reread = readUnconsumedCanvasProjectionEvents(afterRestart);
      expect(reread.map((event) => event.eventId)).toEqual(pending.map((event) => event.eventId));
      const applier = createCanvasProjectionEventApplier();
      const replay = replayUnconsumedCanvasProjectionEvents(afterRestart, (event) => {
        applier.apply(event);
      });
      expect(replay).toEqual({ applied: 1, consumed: 1, error: null });
      expect(readUnconsumedCanvasProjectionEvents(afterRestart).length).toBe(0);
    } finally {
      afterRestart.close();
    }
    // 再次重启：无残留未消费事件，账本其他口径不受影响。
    const thirdOpen = openLedgerDb(fixture.root);
    try {
      expect(readUnconsumedCanvasProjectionEvents(thirdOpen).length).toBe(0);
    } finally {
      thirdOpen.close();
    }
    const state = await getStudioGenerationLedgerState(fixture.root);
    expect(state.counts.results).toBe(2);
  });

  it("reconcile 幂等补缀 Review/连续性事实（派生 eventId，重复执行不重复）", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    const run = await freezeDispatchPrepareUnitGrid(fixture.root, fixture.unitId, "outbox-run-review");
    const bundle = await commitUnitGridBundle(fixture.root, run, "outbox-review");
    const review = await passUnitGridReview(fixture.root, run, bundle, "outbox-review-operation-001");

    const db = openLedgerDb(fixture.root);
    try {
      const first = reconcileCanvasProjectionOutbox(db);
      expect(first.reviewAppended).toBe(1);
      // 两个 panel × 非 forbidden 资产 × 九字段 continuity heads 全部补缀。
      expect(first.continuityAppended).toBeGreaterThan(0);
      expect(first.skipped).toBe(0);
      const rows = outboxRows(db);
      // 1 条入账事件 + 1 条 review + N 条 continuity。
      expect(rows.length).toBe(1 + 1 + first.continuityAppended);
      const reviewRow = rows.find((row) => row.kind === "review-updated")!;
      expect(reviewRow).toMatchObject({
        event_id: `review-updated:${review.reviewId}`,
        unit_id: fixture.unitId,
        generation_run_id: "outbox-run-review",
        projection_revision: 2,
      });
      const reviewPayload = JSON.parse(String(reviewRow.payload_json)) as Record<string, unknown>;
      expect(reviewPayload).toMatchObject({ reviewId: review.reviewId, decision: "pass" });
      // 重复 reconcile：零新增（幂等）。
      const second = reconcileCanvasProjectionOutbox(db);
      expect(second).toEqual({ reviewAppended: 0, continuityAppended: 0, skipped: 0 });
      expect(outboxRows(db).length).toBe(rows.length);
    } finally {
      db.close();
    }
  });

  it("outbox 事件事实列不可改写、不可删除（append-only trigger 风格，仅 consumed 可推进）", async () => {
    const fixture = await createUnitGridFixtureProject(await fixtureParent());
    await initializeStudioGenerationLedger(fixture.root);
    const db = openLedgerDb(fixture.root);
    try {
      ensureCanvasProjectionOutboxSchema(db);
      db.exec("BEGIN IMMEDIATE");
      appendCanvasProjectionEvent(db, { kind: "unit-state-changed", unitId: fixture.unitId });
      db.exec("COMMIT");
      expect(() => db.prepare(
        "UPDATE studio_canvas_projection_outbox SET payload_json = '{}' WHERE projection_revision = 1",
      ).run()).toThrow(/immutable/u);
      expect(() => db.prepare(
        "DELETE FROM studio_canvas_projection_outbox WHERE projection_revision = 1",
      ).run()).toThrow(/append-only/u);
      // consumed 标记允许推进（消费语义所需）。
      expect(() => db.prepare(
        "UPDATE studio_canvas_projection_outbox SET consumed = 1 WHERE projection_revision = 1",
      ).run()).not.toThrow();
    } finally {
      db.close();
    }
  });
});
