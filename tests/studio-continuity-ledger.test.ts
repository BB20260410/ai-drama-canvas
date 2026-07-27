import { mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  STUDIO_CONTINUITY_FIELDS,
  normalizeStudioContinuityState,
  type StudioContinuityFieldStateInput,
  type StudioContinuityScopeInput,
} from "../src/core/studio-continuity.js";
import {
  appendStudioContinuityCorrection,
  appendStudioContinuityObservation,
  appendStudioContinuityObservations,
  getStudioContinuityReadiness,
  initializeStudioContinuityLedger,
  listOpenStudioContinuityConflicts,
  queryStudioContinuityTimeline,
  queryStudioContinuityTimelines,
  readStudioContinuityOperationReceipt,
} from "../src/core/studio-continuity-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedProject(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-continuity-parent-")));
  roots.push(parent);
  return (await createManagedProject({ parentRoot: parent, name: "P7 连续性账本测试" })).paths.root;
}

function scope(
  startMilliseconds: number,
  endMilliseconds: number,
  overrides: Partial<StudioContinuityScopeInput> = {},
): StudioContinuityScopeInput {
  return {
    kind: "panel",
    scopeId: "panel-01",
    unitId: "unit-01",
    unitRevision: 1,
    startMilliseconds,
    endMilliseconds,
    ...overrides,
  };
}

function resolved(value: string, reference: string): StudioContinuityFieldStateInput {
  return {
    status: "resolved",
    value,
    provenance: [{ kind: "test-evidence", reference }],
  };
}

function unresolved(reason: string, reference: string): StudioContinuityFieldStateInput {
  return {
    status: "unresolved",
    reason,
    provenance: [{ kind: "test-evidence", reference }],
  };
}

describe("studio continuity ledger", () => {
  it("原子批量追加保留逐项 receipt、支持整批重放并在后项冲突时完整回滚", async () => {
    const root = await managedProject();
    const batch = [{
      operationId: "batch-costume",
      expectedHeadRevision: 0,
      scope: scope(0, 1_000),
      subjectId: "character-01",
      field: "costume" as const,
      state: resolved("黑色猎装", "batch-costume-evidence"),
    }, {
      operationId: "batch-lighting",
      expectedHeadRevision: 0,
      scope: scope(0, 1_000),
      subjectId: "character-01",
      field: "lighting" as const,
      state: resolved("冷蓝侧光", "batch-lighting-evidence"),
    }];

    const first = await appendStudioContinuityObservations(root, batch);
    const replay = await appendStudioContinuityObservations(root, batch);
    expect(first).toHaveLength(2);
    expect(first.every((item) => item.replayed === false)).toBe(true);
    expect(replay.map((item) => item.receiptId)).toEqual(first.map((item) => item.receiptId));
    expect(replay.every((item) => item.replayed === true)).toBe(true);

    await expect(appendStudioContinuityObservations(root, [{
      operationId: "batch-rollback-emotion",
      expectedHeadRevision: 0,
      scope: scope(0, 1_000),
      subjectId: "character-01",
      field: "emotion",
      state: resolved("克制", "batch-rollback-evidence"),
    }, {
      ...batch[0]!,
      state: resolved("冲突换载荷", "batch-conflict-evidence"),
    }])).rejects.toMatchObject({ code: "operation-conflict" });
    expect(await readStudioContinuityOperationReceipt(root, "batch-rollback-emotion")).toBeNull();
    expect((await initializeStudioContinuityLedger(root)).counts).toMatchObject({
      entries: 2,
      heads: 2,
      conflicts: 0,
      operationReceipts: 2,
    });
  });

  it("批量可混合恢复旧 receipt 与新项，并在后项 head CAS 失败时回滚 entry/head/conflict/receipt", async () => {
    const root = await managedProject();
    const replayInput = {
      operationId: "batch-recovery-existing",
      expectedHeadRevision: 0,
      scope: scope(0, 2_000),
      subjectId: "character-01",
      field: "position" as const,
      state: resolved("画面左侧", "batch-recovery-existing-evidence"),
    };
    await appendStudioContinuityObservation(root, replayInput);
    const mixed = await appendStudioContinuityObservations(root, [replayInput, {
      operationId: "batch-recovery-fresh",
      expectedHeadRevision: 0,
      scope: scope(0, 2_000),
      subjectId: "character-01",
      field: "costume",
      state: resolved("黑色猎装", "batch-recovery-fresh-evidence"),
    }]);
    expect(mixed.map((item) => item.replayed)).toEqual([true, false]);

    await expect(appendStudioContinuityObservations(root, [{
      operationId: "batch-conflict-must-rollback",
      expectedHeadRevision: 0,
      scope: scope(1_000, 3_000),
      subjectId: "character-01",
      field: "position",
      state: resolved("画面右侧", "batch-conflict-must-rollback-evidence"),
    }, {
      operationId: "batch-stale-head",
      expectedHeadRevision: 0,
      scope: scope(0, 2_000),
      subjectId: "character-01",
      field: "costume",
      state: resolved("白色长袍", "batch-stale-head-evidence"),
    }])).rejects.toMatchObject({ code: "head-conflict", expectedRevision: 0, actualRevision: 1 });

    expect(await readStudioContinuityOperationReceipt(root, "batch-conflict-must-rollback")).toBeNull();
    expect(await readStudioContinuityOperationReceipt(root, "batch-stale-head")).toBeNull();
    expect((await initializeStudioContinuityLedger(root)).counts).toMatchObject({
      entries: 2,
      heads: 2,
      conflicts: 0,
      openConflicts: 0,
      operationReceipts: 2,
    });
  });

  it("批量边界与归一化后重复 operationId 在开事务前 fail closed 且零写入", async () => {
    const root = await managedProject();
    const input = {
      operationId: "duplicate-normalized",
      expectedHeadRevision: 0,
      scope: scope(0, 1_000),
      subjectId: "character-01",
      field: "costume" as const,
      state: resolved("黑色猎装", "duplicate-normalized-evidence"),
    };
    await expect(appendStudioContinuityObservations(root, [])).rejects.toMatchObject({ code: "invalid-input" });
    await expect(appendStudioContinuityObservations(root, Array.from({ length: 501 }, (_, index) => ({
      ...input,
      operationId: `oversized-${index}`,
    })))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(appendStudioContinuityObservations(root, [input, {
      ...input,
      operationId: " duplicate-normalized ",
    }])).rejects.toMatchObject({ code: "invalid-input" });
    expect((await initializeStudioContinuityLedger(root)).counts).toMatchObject({
      entries: 0,
      heads: 0,
      conflicts: 0,
      operationReceipts: 0,
    });
  });

  it("索引化冲突候选只在同锚点实体字段的半开重叠异值间建 conflict", async () => {
    const root = await managedProject();
    const results = await appendStudioContinuityObservations(root, [{
      operationId: "candidate-base",
      expectedHeadRevision: 0,
      scope: scope(0, 2_000),
      subjectId: "character-01",
      field: "costume",
      state: resolved("黑色猎装", "candidate-base-evidence"),
    }, {
      operationId: "candidate-overlap",
      expectedHeadRevision: 0,
      scope: scope(1_000, 3_000),
      subjectId: "character-01",
      field: "costume",
      state: resolved("白色长袍", "candidate-overlap-evidence"),
    }, {
      operationId: "candidate-non-overlap",
      expectedHeadRevision: 0,
      scope: scope(3_000, 4_000),
      subjectId: "character-01",
      field: "costume",
      state: resolved("红色斗篷", "candidate-non-overlap-evidence"),
    }, {
      operationId: "candidate-other-subject",
      expectedHeadRevision: 0,
      scope: scope(1_000, 3_000),
      subjectId: "character-02",
      field: "costume",
      state: resolved("白色长袍", "candidate-other-subject-evidence"),
    }, {
      operationId: "candidate-other-field",
      expectedHeadRevision: 0,
      scope: scope(1_000, 3_000),
      subjectId: "character-01",
      field: "lighting",
      state: resolved("冷蓝侧光", "candidate-other-field-evidence"),
    }, {
      operationId: "candidate-other-revision",
      expectedHeadRevision: 0,
      scope: scope(1_000, 3_000, { unitRevision: 2 }),
      subjectId: "character-01",
      field: "costume",
      state: resolved("白色长袍", "candidate-other-revision-evidence"),
    }]);
    expect(results.map((item) => item.createdConflicts.length)).toEqual([0, 1, 0, 0, 0, 0]);
    expect((await initializeStudioContinuityLedger(root)).counts).toMatchObject({
      entries: 6,
      heads: 6,
      conflicts: 1,
      openConflicts: 1,
      operationReceipts: 6,
    });
  });

  it("在 generation ledger 同库初始化固定九字段 schema，并严格校验显式状态与 reference SHA", async () => {
    const root = await managedProject();
    const state = await initializeStudioContinuityLedger(root);

    expect(STUDIO_CONTINUITY_FIELDS).toEqual([
      "costume",
      "injury",
      "heldObject",
      "position",
      "facing",
      "emotion",
      "layout",
      "lighting",
      "referenceSha256",
    ]);
    expect(state.databasePath).toBe(path.join(root, ".aicanvas", "studio-generation-ledger.sqlite"));
    expect(state.generationLedgerReused).toBe(true);
    expect(state.counts).toEqual({
      entries: 0,
      heads: 0,
      conflicts: 0,
      openConflicts: 0,
      conflictResolutions: 0,
      operationReceipts: 0,
    });

    const db = new DatabaseSync(state.databasePath, { readOnly: true });
    try {
      const marker = db.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key = 'studio_continuity_schema_version'",
      ).get() as { value: string };
      expect(marker.value).toBe("1");
      const tables = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'studio_continuity_*' ORDER BY name",
      ).all() as unknown as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toHaveLength(6);
    } finally {
      db.close();
    }
    expect((await readdir(path.join(root, ".aicanvas"))).filter((name) => name.startsWith("studio-continuity")))
      .toEqual([]);

    expect(normalizeStudioContinuityState("costume", resolved("黑色猎装", "ref-resolved")).status).toBe("resolved");
    expect(normalizeStudioContinuityState("injury", unresolved("伤势待确认", "ref-unresolved")).status).toBe("unresolved");
    expect(normalizeStudioContinuityState("heldObject", {
      status: "not-applicable",
      reason: "该镜头明确空手",
      provenance: [{ kind: "test-evidence", reference: "ref-na" }],
    }).status).toBe("not-applicable");
    expect(() => normalizeStudioContinuityState("referenceSha256", resolved("A".repeat(64), "uppercase")))
      .toThrow(/64 位小写 SHA-256/u);
    expect(() => normalizeStudioContinuityState("referenceSha256", resolved("a".repeat(63), "short")))
      .toThrow(/64 位小写 SHA-256/u);
    expect(() => normalizeStudioContinuityState("referenceSha256", resolved(` ${"a".repeat(64)}`, "whitespace")))
      .toThrow(/64 位小写 SHA-256/u);
    expect(normalizeStudioContinuityState("referenceSha256", resolved("a".repeat(64), "valid")).status)
      .toBe("resolved");
  });

  it("提供 operation idempotency、同键异载荷拒绝与 head CAS，失败时不遗留半事务 receipt", async () => {
    const root = await managedProject();
    const input = {
      operationId: "observe-position-001",
      expectedHeadRevision: 0,
      scope: scope(0, 1_000),
      subjectId: "character-ahang",
      field: "position" as const,
      state: resolved("画面左侧", "script-line-1"),
    };
    const first = await appendStudioContinuityObservation(root, input);
    const replay = await appendStudioContinuityObservation(root, input);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.fingerprint).toBe(first.fingerprint);
    expect(replay.head.revision).toBe(1);

    await expect(appendStudioContinuityObservation(root, {
      ...input,
      state: resolved("画面右侧", "changed-payload"),
    })).rejects.toMatchObject({ code: "operation-conflict" });
    await expect(appendStudioContinuityObservation(root, {
      ...input,
      operationId: "observe-position-stale",
      state: resolved("画面左侧", "new-provenance"),
    })).rejects.toMatchObject({ code: "head-conflict", expectedRevision: 0, actualRevision: 1 });

    const stateAfterFailures = await initializeStudioContinuityLedger(root);
    expect(stateAfterFailures.counts.entries).toBe(1);
    expect(stateAfterFailures.counts.operationReceipts).toBe(1);

    const sameValueNewEvidence = await appendStudioContinuityObservation(root, {
      ...input,
      operationId: "observe-position-new-evidence",
      expectedHeadRevision: 1,
      state: resolved("画面左侧", "camera-blocking-note"),
    });
    expect(sameValueNewEvidence.head.revision).toBe(2);
    expect(sameValueNewEvidence.createdConflicts).toEqual([]);
    expect((await readStudioContinuityOperationReceipt(root, input.operationId))?.receiptId).toBe(first.receiptId);
  });

  it("保留 source-shot 离散半开区间与真实空档，readiness 不填洞且阻断 unresolved", async () => {
    const root = await managedProject();
    const shotScope = { kind: "source-shot" as const, scopeId: "source-shot-01" };
    await appendStudioContinuityObservation(root, {
      operationId: "gap-left",
      expectedHeadRevision: 0,
      scope: scope(0, 1_000, shotScope),
      subjectId: "character-dudu",
      field: "costume",
      state: resolved("红色斗篷", "shot-a"),
    });
    await appendStudioContinuityObservation(root, {
      operationId: "gap-right",
      expectedHeadRevision: 0,
      scope: scope(3_000, 4_000, shotScope),
      subjectId: "character-dudu",
      field: "costume",
      state: resolved("红色斗篷", "shot-b"),
    });
    await appendStudioContinuityObservation(root, {
      operationId: "unresolved-injury",
      expectedHeadRevision: 0,
      scope: scope(0, 4_000, shotScope),
      subjectId: "character-dudu",
      field: "injury",
      state: unresolved("伤口是否渗血待确认", "shot-c"),
    });

    const timeline = await queryStudioContinuityTimeline(root, {
      scopeAnchor: { ...shotScope, unitId: "unit-01", unitRevision: 1 },
      subjectId: "character-dudu",
      field: "costume",
    });
    expect(timeline.items.map((item) => [
      item.entry.scope.startMilliseconds,
      item.entry.scope.endMilliseconds,
    ])).toEqual([[0, 1_000], [3_000, 4_000]]);
    const batched = await queryStudioContinuityTimelines(root, [{
      scopeAnchor: { ...shotScope, unitId: "unit-01", unitRevision: 1 },
      subjectId: "character-dudu",
      field: "costume",
    }, {
      scopeAnchor: { ...shotScope, unitId: "unit-01", unitRevision: 1 },
      subjectId: "character-dudu",
      field: "injury",
    }]);
    expect(batched[0]).toEqual(timeline);
    expect(batched[1]!.items).toHaveLength(1);

    const readiness = await getStudioContinuityReadiness(root, {
      scope: scope(0, 4_000, shotScope),
      subjectId: "character-dudu",
      requiredFields: ["costume", "injury"],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "required-state-gap",
        field: "costume",
        startMilliseconds: 1_000,
        endMilliseconds: 3_000,
      }),
      expect.objectContaining({ code: "required-state-unresolved", field: "injury" }),
    ]));
  });

  it("持久化重叠异值 conflict，不做 last-write-wins，并由 correction 显式解决", async () => {
    const root = await managedProject();
    const left = await appendStudioContinuityObservation(root, {
      operationId: "costume-left-black",
      expectedHeadRevision: 0,
      scope: scope(0, 3_000),
      subjectId: "character-ahang",
      field: "costume",
      state: resolved("黑色猎装", "panel-left"),
    });
    const right = await appendStudioContinuityObservation(root, {
      operationId: "costume-right-white",
      expectedHeadRevision: 0,
      scope: scope(2_000, 4_000),
      subjectId: "character-ahang",
      field: "costume",
      state: resolved("白色长袍", "panel-right"),
    });
    expect(right.createdConflicts).toHaveLength(1);
    const conflict = right.createdConflicts[0]!;
    expect(conflict.status).toBe("open");
    expect([conflict.leftEntry.state, conflict.rightEntry.state].map((state) => state.status === "resolved" && state.value))
      .toEqual(expect.arrayContaining(["黑色猎装", "白色长袍"]));

    const before = await queryStudioContinuityTimeline(root, {
      scopeAnchor: { kind: "panel", scopeId: "panel-01", unitId: "unit-01", unitRevision: 1 },
      subjectId: "character-ahang",
      field: "costume",
    });
    expect(before.items).toHaveLength(2);
    expect(before.openConflicts).toHaveLength(1);
    expect((await getStudioContinuityReadiness(root, {
      scope: scope(0, 4_000),
      subjectId: "character-ahang",
      requiredFields: ["costume"],
    })).blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "required-state-conflict", conflictId: conflict.id }),
    ]));

    const correction = await appendStudioContinuityCorrection(root, {
      operationId: "correct-right-to-black",
      expectedHeadRevision: 1,
      scope: scope(2_000, 4_000),
      subjectId: "character-ahang",
      field: "costume",
      state: resolved("黑色猎装", "continuity-review"),
      supersedesEntryId: right.entry.id,
      resolvesConflicts: [{ conflictId: conflict.id, expectedRevision: 1 }],
    });
    expect(correction.head.revision).toBe(2);
    expect(correction.resolvedConflictIds).toEqual([conflict.id]);
    expect(correction.createdConflicts).toEqual([]);
    expect(await listOpenStudioContinuityConflicts(root, { scope: scope(0, 4_000) })).toEqual([]);
    const ready = await getStudioContinuityReadiness(root, {
      scope: scope(0, 4_000),
      subjectId: "character-ahang",
      requiredFields: ["costume"],
    });
    expect(ready.ready).toBe(true);

    const after = await queryStudioContinuityTimeline(root, {
      scopeAnchor: { kind: "panel", scopeId: "panel-01", unitId: "unit-01", unitRevision: 1 },
      subjectId: "character-ahang",
      field: "costume",
    });
    expect(after.items.map((item) => [item.entry.scope.startMilliseconds, item.entry.scope.endMilliseconds]))
      .toEqual([[0, 3_000], [2_000, 4_000]]);
    expect(left.head.revision).toBe(1);

    const state = await initializeStudioContinuityLedger(root);
    const historyDb = new DatabaseSync(state.databasePath);
    try {
      const resolution = historyDb.prepare(
        "SELECT resolution_id FROM studio_continuity_conflict_resolutions WHERE conflict_id = ?",
      ).get(conflict.id) as { resolution_id: string };
      expect(() => historyDb.prepare("UPDATE studio_continuity_conflicts SET created_at = created_at WHERE conflict_id = ?")
        .run(conflict.id)).toThrow(/append-only/u);
      expect(() => historyDb.prepare("DELETE FROM studio_continuity_conflicts WHERE conflict_id = ?")
        .run(conflict.id)).toThrow(/append-only/u);
      expect(() => historyDb.prepare(
        "UPDATE studio_continuity_conflict_resolutions SET created_at = created_at WHERE resolution_id = ?",
      ).run(resolution.resolution_id)).toThrow(/append-only/u);
      expect(() => historyDb.prepare("DELETE FROM studio_continuity_conflict_resolutions WHERE resolution_id = ?")
        .run(resolution.resolution_id)).toThrow(/append-only/u);
    } finally {
      historyDb.close();
    }
  });

  it("同一精确 span 的异值 observation 只追加候选与 conflict，不覆盖当前 head", async () => {
    const root = await managedProject();
    const original = await appendStudioContinuityObservation(root, {
      operationId: "exact-span-black",
      expectedHeadRevision: 0,
      scope: scope(0, 3_000),
      subjectId: "character-ahang",
      field: "costume",
      state: resolved("黑色猎装", "exact-original"),
    });
    const candidate = await appendStudioContinuityObservation(root, {
      operationId: "exact-span-white-candidate",
      expectedHeadRevision: 1,
      scope: scope(0, 3_000),
      subjectId: "character-ahang",
      field: "costume",
      state: resolved("白色长袍", "exact-candidate"),
    });
    expect(candidate.entry.id).not.toBe(original.entry.id);
    expect(candidate.head.entry.id).toBe(original.entry.id);
    expect(candidate.head.revision).toBe(1);
    expect(candidate.createdConflicts).toHaveLength(1);

    const conflict = candidate.createdConflicts[0]!;
    const corrected = await appendStudioContinuityCorrection(root, {
      operationId: "exact-span-correction",
      expectedHeadRevision: 1,
      scope: scope(0, 3_000),
      subjectId: "character-ahang",
      field: "costume",
      state: resolved("白色长袍", "explicit-review"),
      supersedesEntryId: original.entry.id,
      resolvesConflicts: [{ conflictId: conflict.id, expectedRevision: 1 }],
    });
    expect(corrected.head.entry.state).toMatchObject({ status: "resolved", value: "白色长袍" });
    expect(corrected.head.revision).toBe(2);
    expect(await listOpenStudioContinuityConflicts(root, { scope: scope(0, 3_000) })).toEqual([]);
  });

  it("重启后恢复相同 projection/fingerprint，并由 SQLite trigger 拒绝历史 update/delete", async () => {
    const root = await managedProject();
    const first = await appendStudioContinuityObservation(root, {
      operationId: "restart-observation",
      expectedHeadRevision: 0,
      scope: scope(0, 2_000),
      subjectId: "prop-complete-mask",
      field: "referenceSha256",
      state: resolved("b".repeat(64), "mask-authority"),
    });
    const query = {
      scopeAnchor: { kind: "panel" as const, scopeId: "panel-01", unitId: "unit-01", unitRevision: 1 },
      subjectId: "prop-complete-mask",
    };
    const before = await queryStudioContinuityTimeline(root, query);
    const restarted = await initializeStudioContinuityLedger(root);
    const after = await queryStudioContinuityTimeline(root, query);
    expect(restarted.counts.entries).toBe(1);
    expect(after).toEqual(before);
    expect((await readStudioContinuityOperationReceipt(root, "restart-observation"))?.fingerprint)
      .toBe(first.fingerprint);

    const db = new DatabaseSync(restarted.databasePath);
    try {
      expect(() => db.prepare("UPDATE studio_continuity_entries SET created_at = created_at WHERE entry_id = ?")
        .run(first.entry.id)).toThrow(/append-only/u);
      expect(() => db.prepare("DELETE FROM studio_continuity_entries WHERE entry_id = ?")
        .run(first.entry.id)).toThrow(/append-only/u);
      expect(() => db.prepare("UPDATE studio_continuity_operation_receipts SET created_at = created_at WHERE operation_id = ?")
        .run("restart-observation")).toThrow(/append-only/u);
      expect(() => db.prepare("DELETE FROM studio_continuity_operation_receipts WHERE operation_id = ?")
        .run("restart-observation")).toThrow(/append-only/u);
    } finally {
      db.close();
    }
  });

  it("marker 存在但 continuity table 损坏时 fail closed，不静默重建", async () => {
    const root = await managedProject();
    const state = await initializeStudioContinuityLedger(root);
    const db = new DatabaseSync(state.databasePath);
    try {
      db.exec("DROP TABLE studio_continuity_conflicts");
    } finally {
      db.close();
    }
    await expect(initializeStudioContinuityLedger(root)).rejects.toMatchObject({ code: "storage-invalid" });
  });
});
