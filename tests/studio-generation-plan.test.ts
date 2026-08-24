import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelStudioGenerationRun,
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  freezeAndPersistStudioGenerationPack,
  getStudioGenerationLatestPlanForPanel,
  getStudioGenerationLedgerState,
  getStudioGenerationPlanProjection,
  listStudioGenerationPlanProjections,
  readStudioGenerationRetryOperationOutcomeReadOnly,
  registerStudioGenerationResult,
  retryStudioGenerationPlanNodes,
  type StudioGenerationPlanProjection,
} from "../src/core/studio-generation-ledger.js";
import { executeIdempotentCommand, listCommandLedger, reconcileCommand } from "../src/core/command-bus.js";
import { __setBeforeGenerationWritableOpenHookForTests } from "../src/core/studio-generation-ledger-storage.js";
import { buildStudioGenerationPlanProgress } from "../src/core/studio-generation-plan-progress.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { createStudioP7Fixture, seedStudioP7ResolvedPanelContinuity, type StudioP7Fixture } from "./helpers/studio-p7-fixture.js";

/**
 * P21 生成计划/事件/取消/失败/重试/投影定向测试（规范 v3.1 §4-1..7）。
 * 全部 mkdtemp 隔离工程；不消费任何外部凭证，不声称真实生图。
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

async function generationOwnerFilesystemSnapshot(projectRoot: string): Promise<Record<string, unknown>> {
  const aicanvas = path.join(projectRoot, ".aicanvas");
  const roots = [
    "studio-generation-ledger.sqlite",
    "studio-generation-ledger.sqlite-wal",
    "studio-generation-ledger.sqlite-shm",
    "studio-generation",
  ];
  const snapshot: Record<string, unknown> = {};
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(aicanvas, relative);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        snapshot[relative] = null;
        return;
      }
      throw error;
    }
    const identity = {
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    };
    if (metadata.isDirectory()) {
      snapshot[relative] = { kind: "directory", ...identity };
      for (const name of (await readdir(absolute)).sort((left, right) => left.localeCompare(right, "en"))) {
        await visit(`${relative}/${name}`);
      }
      return;
    }
    if (!metadata.isFile()) throw new Error(`generation owner 出现非普通文件：${relative}`);
    snapshot[relative] = {
      kind: "file",
      ...identity,
      sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"),
    };
  }
  for (const relative of roots) await visit(relative);
  return snapshot;
}

async function freezeTwoPanel(fixture: StudioP7Fixture) {
  const unit = fixture.units.twoPanel;
  for (const panel of unit.panels) {
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
  }
  const packs = [] as Array<{ panelId: string; packId: string; fingerprint: string }>;
  for (const panel of unit.panels) {
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
    packs.push({ panelId: panel.id, packId: frozen.packId, fingerprint: frozen.fingerprint });
  }
  return { unit, packs };
}

function planRunId(planId: string, nodeIndex: number, attempt: number): string {
  return `${planId}:node:${nodeIndex}:attempt:${attempt}`;
}

function nodeOf(plan: StudioGenerationPlanProjection, nodeIndex: number) {
  const node = plan.nodes.find((entry) => entry.nodeIndex === nodeIndex);
  expect(node).toBeDefined();
  return node!;
}

describe("P21 §4-1 迁移与 ledger 状态", () => {
  it("v4 三表 append-only；v3 库原位迁移旧行不受影响；重开库正常", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-migration-run-0001",
      provider: "codex",
    });
    await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[1]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0000",
    });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const db = new DatabaseSync(databasePath);
    for (const table of ["studio_generation_plans", "studio_generation_plan_nodes", "studio_generation_run_events"]) {
      expect(() => db.prepare(`UPDATE ${table} SET created_at = created_at`).run(), `${table} no-update`).toThrow(/append-only/u);
      expect(() => db.prepare(`DELETE FROM ${table}`).run(), `${table} no-delete`).toThrow(/append-only/u);
    }
    // 模拟真实 v3 存量：删 v4 表 + 全部 v5/v6 纯增对象（含 dispatch call identity 索引与
    // v6 detached disposition 扩展），再回滚版本。
    // P30 把 call-identity 索引列入 v5 扩展、v6 再加 disposition 表；若夹具只剥 v4/v5
    // 会误留 v6 残留，migrateV3ToV4 正确 fail-closed。
    const dispatchCount = Number((db.prepare("SELECT COUNT(*) AS c FROM studio_generation_dispatches").get() as { c: number }).c);
    const eventCount = Number((db.prepare("SELECT COUNT(*) AS c FROM studio_generation_run_events").get() as { c: number }).c);
    expect(dispatchCount).toBe(1);
    expect(eventCount).toBe(1);
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS studio_generation_plans_no_update;
      DROP TRIGGER IF EXISTS studio_generation_plans_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_plan_nodes_no_update;
      DROP TRIGGER IF EXISTS studio_generation_plan_nodes_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_run_events_no_update;
      DROP TRIGGER IF EXISTS studio_generation_run_events_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_pack_targets_no_update;
      DROP TRIGGER IF EXISTS studio_generation_pack_targets_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_dispatch_protocols_no_update;
      DROP TRIGGER IF EXISTS studio_generation_dispatch_protocols_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_call_intents_no_update;
      DROP TRIGGER IF EXISTS studio_generation_call_intents_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_call_events_no_update;
      DROP TRIGGER IF EXISTS studio_generation_call_events_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_historical_imports_no_update;
      DROP TRIGGER IF EXISTS studio_generation_historical_imports_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_detached_unknown_no_update;
      DROP TRIGGER IF EXISTS studio_generation_detached_unknown_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_plan_node_targets_no_update;
      DROP TRIGGER IF EXISTS studio_generation_plan_node_targets_no_delete;
      DROP TRIGGER IF EXISTS studio_generation_detached_disposition_no_update;
      DROP TRIGGER IF EXISTS studio_generation_detached_disposition_no_delete;
      DROP INDEX IF EXISTS studio_generation_dispatch_call_identity_idx;
      DROP INDEX IF EXISTS studio_generation_pack_targets_key_idx;
      DROP INDEX IF EXISTS studio_generation_call_events_call_idx;
      DROP INDEX IF EXISTS studio_generation_historical_import_target_idx;
      DROP INDEX IF EXISTS studio_generation_detached_unknown_target_idx;
      DROP INDEX IF EXISTS studio_generation_plan_node_targets_key_idx;
      DROP INDEX IF EXISTS studio_generation_detached_disposition_target_idx;
      DROP TABLE IF EXISTS studio_generation_detached_unknown_dispositions;
      DROP TABLE IF EXISTS studio_generation_run_events;
      DROP TABLE IF EXISTS studio_generation_plan_nodes;
      DROP TABLE IF EXISTS studio_generation_plans;
      DROP TABLE IF EXISTS studio_generation_plan_node_targets;
      DROP TABLE IF EXISTS studio_generation_detached_unknown_observations;
      DROP TABLE IF EXISTS studio_generation_historical_imports;
      DROP TABLE IF EXISTS studio_generation_call_events;
      DROP TABLE IF EXISTS studio_generation_call_intents;
      DROP TABLE IF EXISTS studio_generation_dispatch_protocols;
      DROP TABLE IF EXISTS studio_generation_pack_targets;
      UPDATE studio_generation_ledger_meta SET value = '3' WHERE key = 'schema_version';
      PRAGMA foreign_keys=ON;
    `);
    db.close();

    const state = await getStudioGenerationLedgerState(fixture.root);
    expect(state.schemaVersion).toBe(7);
    expect(state.counts.dispatches).toBe(1);
    expect(state.counts.plans).toBe(0);
    expect(state.counts.runEvents).toBe(0);
    // 旧行不受影响：既有 run 仍可读取（legacy 无事件，纯推导）。
    const reopened = new DatabaseSync(databasePath);
    expect(reopened.prepare("SELECT COUNT(*) AS c FROM studio_generation_dispatches").get()).toEqual({ c: 1 });
    reopened.close();
    // 迁移后写入仍正常，且 v4 触发器在有行时点火。
    const migratedPlan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[1]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-migrated",
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: planRunId(migratedPlan.planId, 1, 1),
      provider: "codex",
    });
    const verify = new DatabaseSync(databasePath);
    for (const table of ["studio_generation_plans", "studio_generation_plan_nodes", "studio_generation_run_events"]) {
      expect(() => verify.prepare(`DELETE FROM ${table}`).run(), `${table} no-delete after migration`).toThrow(/append-only/u);
    }
    verify.close();
  });
});

describe("P21 §4-2 create_plan 幂等与边界", () => {
  it("内容寻址幂等；dispatches 行数不变；未冻结/重复节点/越界拒绝；节点初始 planned", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const before = await getStudioGenerationLedgerState(fixture.root);
    const nodes = unit.panels.map((panel) => ({ unitId: unit.unit.id, panelId: panel.id }));
    const first = await createStudioGenerationPlan(fixture.root, { nodes, sourceCommandRequestId: "p21-test-create-plan-0001" });
    expect(first.idempotentReplay).toBe(false);
    expect(first.planId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.nodes).toHaveLength(2);
    const second = await createStudioGenerationPlan(fixture.root, { nodes, sourceCommandRequestId: "p21-test-create-plan-0002" });
    expect(second.idempotentReplay).toBe(true);
    expect(second.planId).toBe(first.planId);
    const after = await getStudioGenerationLedgerState(fixture.root);
    expect(after.counts.dispatches).toBe(before.counts.dispatches);

    const projection = await getStudioGenerationPlanProjection(fixture.root, first.planId);
    expect(projection).not.toBeNull();
    for (const node of projection!.nodes) {
      expect(node.status).toBe("planned");
      expect(node.packStale).toBe(false);
      expect(node.generationRunId).toBe(planRunId(first.planId, node.nodeIndex, 1));
    }

    await expect(createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: "panel-not-exists" }],
      sourceCommandRequestId: "p21-test-create-plan-0003",
    })).rejects.toMatchObject({ code: "pack-not-found" });
    await expect(createStudioGenerationPlan(fixture.root, {
      nodes: [nodes[0]!, nodes[0]!],
      sourceCommandRequestId: "p21-test-create-plan-0004",
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(createStudioGenerationPlan(fixture.root, {
      nodes: [],
      sourceCommandRequestId: "p21-test-create-plan-0005",
    })).rejects.toMatchObject({ code: "invalid-input" });

    const forPanel = await getStudioGenerationLatestPlanForPanel(fixture.root, unit.unit.id, packs[1]!.panelId);
    expect(forPanel?.planId).toBe(first.planId);
  });

  it("plan 创建前自由 runId 派发行为不变；命中 plan 节点的 pack 强制推导 runId", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    // 无 plan 的 pack：自由 runId 行为不变。
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-free-run-0001",
      provider: "codex",
    });
    // 命中 plan 节点后：错 runId 拒绝（detail 含期望），正确推导 runId 放行并同事务补事件。
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[1]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0006",
    });
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: "p21-wrong-run-0001",
      provider: "codex",
    })).rejects.toMatchObject({
      code: "plan-node-run-id-mismatch",
      details: expect.arrayContaining([`expectedGenerationRunId=${planRunId(plan.planId, 1, 1)}`]),
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    });
    const state = await getStudioGenerationLedgerState(fixture.root);
    // 自由 run 与 plan run 各写一条 dispatched 事件。
    expect(state.counts.runEvents).toBe(2);
    const projection = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(projection!, 1).status).toBe("dispatched");
    expect(nodeOf(projection!, 1).generationRunId).toBe(planRunId(plan.planId, 1, 1));
  });
});

describe("P21 §4-3 panel 互斥与多 run 投影", () => {
  it("同 panel 第二 in-flight 拒绝（detail 含 blocking）；cancel 后放行；多 run 只投影当前 run", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0007",
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    });
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1).replace("attempt:1", "attempt:x"),
      provider: "codex",
    })).rejects.toMatchObject({ code: "plan-node-run-id-mismatch" });
    // 逃生：blocking run 取消后，重试命令创建新 attempt 放行。
    await cancelStudioGenerationRun(fixture.root, { generationRunId: planRunId(plan.planId, 1, 1), reason: "互斥测试" });
    const retried = await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    expect(retried.retried).toHaveLength(1);
    expect(retried.retried[0]).toMatchObject({ nodeIndex: 1, attempt: 2, supersedesRunId: planRunId(plan.planId, 1, 1) });

    // 多 run 投影：attempt:2 为当前 run；登记结果后 succeeded；历史 run 不参与。
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[0]!.panelId)!;
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 2),
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 2),
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });
    const projection = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(projection!, 1).status).toBe("succeeded");
    expect(nodeOf(projection!, 1).attempt).toBe(2);
    expect(nodeOf(projection!, 1).resultId).toBeTruthy();
  });
});

describe("P21 §4-4 竞争闸", () => {
  it("成对结果后 cancel/fail 拒绝；cancel 后 register/bundle 双入口拒绝（run-cancelled EXISTS）；重复 cancel 幂等；fail 幂等/异内容冲突；终态拒绝", async () => {
    const fixture = await p7();
    const { packs } = await freezeTwoPanel(fixture);
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[0]!.panelId)!;
    const media2 = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[1]!.panelId)!;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-race-run-0001",
      provider: "codex",
    });
    // raw+labeled 成对 = succeeded 终态：cancel/fail 均拒绝。
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-race-run-0001",
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-race-run-0001",
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });
    await expect(cancelStudioGenerationRun(fixture.root, { generationRunId: "p21-race-run-0001" }))
      .rejects.toMatchObject({ code: "run-terminal" });
    await expect(failStudioGenerationRun(fixture.root, { generationRunId: "p21-race-run-0001", errorClass: "agent-timeout" }))
      .rejects.toMatchObject({ code: "run-terminal" });

    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: "p21-race-run-0002",
      provider: "codex",
    });
    const cancelled = await cancelStudioGenerationRun(fixture.root, { generationRunId: "p21-race-run-0002", reason: "用户取消" });
    expect(cancelled.kind).toBe("cancelled");
    const again = await cancelStudioGenerationRun(fixture.root, { generationRunId: "p21-race-run-0002", reason: "重复取消" });
    expect(again.eventId).toBe(cancelled.eventId);
    // cancelled EXISTS 闸：register 单入口拒绝。
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: "p21-race-run-0002",
      variant: "raw",
      mediaSha256: media2.raw.imported.sha256,
      provider: "codex",
    })).rejects.toMatchObject({ code: "run-cancelled" });
    // cancelled EXISTS 闸：bundle 入口同样拒绝（双入口覆盖）。
    const { registerStudioGenerationResultBundle } = await import("../src/core/studio-generation-ledger.js");
    await expect(registerStudioGenerationResultBundle(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: "p21-race-run-0002",
      provider: "codex",
      rawMediaSha256: media2.raw.imported.sha256,
      labeledMediaSha256: media2.labeled.imported.sha256,
    })).rejects.toMatchObject({ code: "run-cancelled" });
    await expect(failStudioGenerationRun(fixture.root, { generationRunId: "p21-race-run-0002", errorClass: "agent-timeout" }))
      .rejects.toMatchObject({ code: "run-terminal" });

    // P0-1 矩阵口径（用户裁决 2026-07-24）：成对结果无 Review 阻断同 panel 新 dispatch；
    // 并存 in-flight 互斥已在 §4-3 覆盖。
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-race-run-0003",
      provider: "codex",
    })).rejects.toMatchObject({
      code: "checkpoint-required",
      details: expect.arrayContaining(["review-missing", "generationRunId=p21-race-run-0001"]),
    });
  });

  it("failed 终态拒绝迟到的单图与 bundle，不能被结果登记复活", async () => {
    const fixture = await p7();
    const { packs } = await freezeTwoPanel(fixture);
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[0]!.panelId)!;
    const generationRunId = "p28-terminal-failed-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId,
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, { generationRunId, errorClass: "agent-timeout" });
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId,
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    })).rejects.toMatchObject({ code: "run-terminal" });
    const { registerStudioGenerationResultBundle } = await import("../src/core/studio-generation-ledger.js");
    await expect(registerStudioGenerationResultBundle(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId,
      provider: "codex",
      rawMediaSha256: media.raw.imported.sha256,
      labeledMediaSha256: media.labeled.imported.sha256,
    })).rejects.toMatchObject({ code: "run-terminal" });
  });

  it("raw 单边不锁死：可 cancel；cancel 后晚到 labeled 拒绝（run-cancelled）；retry 接管后可闭环", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0011",
    });
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[0]!.panelId)!;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    // raw 单边：投影 dispatched，cancel 可用（修复前：run-terminal 锁死）。
    const partial = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(partial!, 1).status).toBe("dispatched");
    await cancelStudioGenerationRun(fixture.root, { generationRunId: planRunId(plan.planId, 1, 1), reason: "raw 单边后放弃" });
    // cancel→（将来 retry 的 supersede 覆盖）后晚到 labeled 仍拒绝（EXISTS 语义回归）。
    await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    })).rejects.toMatchObject({ code: "run-cancelled" });
    // attempt:2 闭环。
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 2),
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 2),
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });
    const closed = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(closed!, 1).status).toBe("succeeded");
    expect(nodeOf(closed!, 1).attempt).toBe(2);
  });

  it("伪造 plan 形态 runId 拒绝；create_plan 对 in-flight 宫格拒绝（detail 含 blocking）且 cancel 后放行", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    // in-flight legacy 孤儿 run：create 拒绝，detail 含 blocking runId。
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-orphan-inflight-0001",
      provider: "codex",
    });
    await expect(createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0012",
    })).rejects.toMatchObject({
      code: "panel-run-in-flight",
      details: expect.arrayContaining(["blockingGenerationRunId=p21-orphan-inflight-0001"]),
    });
    // 逃生：cancel 后放行。
    await cancelStudioGenerationRun(fixture.root, { generationRunId: "p21-orphan-inflight-0001", reason: "逃生" });
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0012",
    });
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/u);

    // 伪造：plan 形态 runId 指向不存在 plan。
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: `${"b".repeat(64)}:node:1:attempt:1`,
      provider: "codex",
    })).rejects.toMatchObject({ code: "invalid-input" });
    // 伪造：存在的 plan 但节点 pack 不匹配（plan 节点指向 packs[0]，派发 packs[1]）。
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("共享宫格的旧 plan 终态可由当前 plan 接管重试；36/37 边界与 nodeIndexes 越界", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const planA = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0013",
    });
    const planB = await createStudioGenerationPlan(fixture.root, {
      nodes: [
        { unitId: unit.unit.id, panelId: packs[0]!.panelId },
        { unitId: unit.unit.id, panelId: packs[1]!.panelId },
      ],
      sourceCommandRequestId: "p21-test-create-plan-0014",
    });
    expect(planB.planId).not.toBe(planA.planId);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(planA.planId, 1, 1),
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, { generationRunId: planRunId(planA.planId, 1, 1), errorClass: "agent-timeout" });
    // B 已采纳 A 的终态 run；必须能建立属于 B 的 attempt，避免新计划永久死路。
    const retried = await retryStudioGenerationPlanNodes(fixture.root, { planId: planB.planId, nodeIndexes: [1] });
    expect(retried.retried).toEqual([{
      nodeIndex: 1,
      generationRunId: planRunId(planB.planId, 1, 1),
      attempt: 1,
      supersedesRunId: planRunId(planA.planId, 1, 1),
      idempotentReplay: false,
    }]);
    const replay = await retryStudioGenerationPlanNodes(fixture.root, { planId: planB.planId, nodeIndexes: [1] });
    expect(replay.retried).toEqual([]);
    expect(replay.skipped[0]?.reason).toContain("不可重试");
    // nodeIndexes 越界。
    await expect(retryStudioGenerationPlanNodes(fixture.root, { planId: planB.planId, nodeIndexes: [99] }))
      .rejects.toMatchObject({ code: "invalid-input" });
    // 37 节点越界（36 上限）；空数组与重复在 §4-2 已覆盖。
    await expect(createStudioGenerationPlan(fixture.root, {
      nodes: Array.from({ length: 37 }, (_, index) => ({ unitId: unit.unit.id, panelId: `panel-x-${index}` })),
      sourceCommandRequestId: "p21-test-create-plan-0015",
    })).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("P21 §4-5 重试闭环", () => {
  it("failed 节点 retry：attempt 递增、supersedes 链、幂等重放、新 run 登记闭环、旧结果不动；retry_failed 只重排失败节点", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: unit.panels.map((panel) => ({ unitId: unit.unit.id, panelId: panel.id })),
      sourceCommandRequestId: "p21-test-create-plan-0008",
    });
    const media1 = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[0]!.panelId)!;
    // 节点 1：派发→登记成功（succeeded）。
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      variant: "raw",
      mediaSha256: media1.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      variant: "labeled",
      mediaSha256: media1.labeled.imported.sha256,
      provider: "codex",
    });
    // 节点 2：派发→失败。
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: planRunId(plan.planId, 2, 1),
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, {
      generationRunId: planRunId(plan.planId, 2, 1),
      errorClass: "agent-timeout",
      detail: "模拟 Agent 超时",
    });
    const failedAgain = await failStudioGenerationRun(fixture.root, {
      generationRunId: planRunId(plan.planId, 2, 1),
      errorClass: "agent-timeout",
      detail: "模拟 Agent 超时",
    });
    expect(failedAgain.kind).toBe("failed");
    await expect(failStudioGenerationRun(fixture.root, {
      generationRunId: planRunId(plan.planId, 2, 1),
      errorClass: "other-error",
    })).rejects.toMatchObject({ code: "run-terminal" });

    // retry_failed：只重排失败节点，succeeded 节点不动。
    const retry = await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    expect(retry.retried).toEqual([{
      nodeIndex: 2,
      generationRunId: planRunId(plan.planId, 2, 2),
      attempt: 2,
      supersedesRunId: planRunId(plan.planId, 2, 1),
      idempotentReplay: false,
    }]);
    expect(retry.skipped).toEqual([{
      nodeIndex: 1,
      reason: "当前状态 succeeded 不可重试（仅 failed/cancelled 或当前结果对的 Review Head=REWORK）",
    }]);
    // 幂等重放：同命令返回既有映射。
    const replay = await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    expect(replay.retried).toEqual([]);
    // 旧结果不动：节点 1 仍 succeeded。
    const projectionAfterRetry = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(projectionAfterRetry!, 1).status).toBe("succeeded");
    expect(nodeOf(projectionAfterRetry!, 2).status).toBe("dispatched");
    expect(nodeOf(projectionAfterRetry!, 2).attempt).toBe(2);

    // 闭环：新 run 可登记 bundle 结果。
    const media2 = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[1]!.panelId)!;
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: planRunId(plan.planId, 2, 2),
      variant: "raw",
      mediaSha256: media2.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[1]!.packId,
      packFingerprint: packs[1]!.fingerprint,
      generationRunId: planRunId(plan.planId, 2, 2),
      variant: "labeled",
      mediaSha256: media2.labeled.imported.sha256,
      provider: "codex",
    });
    const closed = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(closed!, 2).status).toBe("succeeded");
    // 三桶之 done：succeeded→done（N-3 补钉）。
    const progress = await buildStudioGenerationPlanProgress(fixture.root);
    expect(progress.counts).toEqual({ active: 0, done: 2, failed: 0 });
    expect(progress.nodes.every((node) => node.bucket === "done")).toBe(true);
  });

  it("adopted legacy：plan 创建前自由 runId 取消后 retry 从 attempt:1 起", async () => {    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "p21-legacy-free-run-0001",
      provider: "codex",
    });
    await cancelStudioGenerationRun(fixture.root, { generationRunId: "p21-legacy-free-run-0001", reason: "legacy 取消" });
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0009",
    });
    const before = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(nodeOf(before!, 1).status).toBe("cancelled");
    expect(nodeOf(before!, 1).adopted).toBe(true);
    expect(nodeOf(before!, 1).attempt).toBe(1);
    const retry = await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    expect(retry.retried).toEqual([{
      nodeIndex: 1,
      generationRunId: planRunId(plan.planId, 1, 1),
      attempt: 1,
      supersedesRunId: "p21-legacy-free-run-0001",
      idempotentReplay: false,
    }]);
  });

  it("并发 retry 同一失败节点：一者落地，另一者经 supersede 事件返回既有映射（真幂等）", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "p21-test-create-plan-0016",
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, { generationRunId: planRunId(plan.planId, 1, 1), errorClass: "agent-timeout" });
    const outcomes = await Promise.all([
      retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId }),
      retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId }),
    ]);
    const landed = outcomes.filter((outcome) => outcome.retried.some((entry) => !entry.idempotentReplay));
    const replays = outcomes.filter((outcome) => outcome.retried.some((entry) => entry.idempotentReplay));
    expect(landed).toHaveLength(1);
    expect(replays).toHaveLength(1);
    expect(replays[0]!.retried[0]).toMatchObject({
      nodeIndex: 1,
      generationRunId: planRunId(plan.planId, 1, 2),
      attempt: 2,
      idempotentReplay: true,
    });
    // 两路不重复派发：attempt:2 只有一条 dispatches 行。
    const state = await getStudioGenerationLedgerState(fixture.root);
    expect(state.counts.dispatches).toBe(2);
  });
});

describe("P21 §4-6/7 投影与 control plan operation", () => {
  it("plan-progress 有界、桶映射正确、确定性哈希；control plan operation 形状与无私有路径", async () => {
    const fixture = await p7();
    const { unit } = await freezeTwoPanel(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: unit.panels.map((panel) => ({ unitId: unit.unit.id, panelId: panel.id })),
      sourceCommandRequestId: "p21-test-create-plan-0010",
    });
    const first = await buildStudioGenerationPlanProgress(fixture.root);
    const second = await buildStudioGenerationPlanProgress(fixture.root);
    expect(second).toEqual(first);
    expect(first.kind).toBe("studio-generation-plan-progress");
    expect(first.planCount).toBe(1);
    expect(first.counts).toEqual({ active: 2, done: 0, failed: 0 });
    expect(first.nodes.every((node) => node.bucket === "active" && node.status === "planned")).toBe(true);
    expect(JSON.stringify(first)).not.toContain(fixture.root);
    expect(JSON.stringify(first)).not.toContain(".aicanvas");

    // 三桶映射与 errorClass 透出：dispatched→active、failed→failed、（succeeded→done 在 §4-5 闭环覆盖）。
    await dispatchStudioGenerationPack(fixture.root, {
      packId: (await getStudioGenerationPlanProjection(fixture.root, plan.planId))!.nodes[0]!.packId,
      packFingerprint: (await getStudioGenerationPlanProjection(fixture.root, plan.planId))!.nodes[0]!.packFingerprint,
      generationRunId: planRunId(plan.planId, 1, 1),
      provider: "codex",
    });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: (await getStudioGenerationPlanProjection(fixture.root, plan.planId))!.nodes[1]!.packId,
      packFingerprint: (await getStudioGenerationPlanProjection(fixture.root, plan.planId))!.nodes[1]!.packFingerprint,
      generationRunId: planRunId(plan.planId, 2, 1),
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, {
      generationRunId: planRunId(plan.planId, 2, 1),
      errorClass: "agent-timeout",
      detail: "三桶用例",
    });
    const withStates = await buildStudioGenerationPlanProgress(fixture.root);
    expect(withStates.counts).toEqual({ active: 1, done: 0, failed: 1 });
    const failedNode = withStates.nodes.find((node) => node.status === "failed");
    expect(failedNode).toMatchObject({ errorClass: "agent-timeout", errorDetail: "三桶用例", bucket: "failed" });
    expect(failedNode?.generationRunId).toBe(planRunId(plan.planId, 2, 1));

    const viaPlanId = await getStudioGenerationControlEnvelope(fixture.root, { operation: "plan", planId: plan.planId });
    expect(viaPlanId).toMatchObject({ operation: "plan", status: "ready", plan: { planId: plan.planId } });
    const missing = await getStudioGenerationControlEnvelope(fixture.root, { operation: "plan", planId: "a".repeat(64) });
    expect(missing).toMatchObject({ operation: "plan", status: "not_found" });
    const viaPanel = await getStudioGenerationControlEnvelope(fixture.root, {
      operation: "plan",
      unitId: unit.unit.id,
      panelId: unit.panels[0]!.id,
    });
    expect(viaPanel).toMatchObject({ operation: "plan", status: "ready" });
    const listed = await getStudioGenerationControlEnvelope(fixture.root, { operation: "plan" });
    expect(listed).toMatchObject({ operation: "plan", status: "ready" });
    expect(JSON.stringify(viaPlanId)).not.toContain(fixture.root);
    expect(JSON.stringify(viaPlanId)).not.toContain(".aicanvas");

    const plans = await listStudioGenerationPlanProjections(fixture.root, { limit: 36 });
    expect(plans.map((entry) => entry.planId)).toContain(plan.planId);
    await expect(listStudioGenerationPlanProjections(fixture.root, { limit: 37 })).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("P21 §4-9 durable reconciliation", () => {
  it("retry skipped 由同事务 operation receipt 恢复原始公开结果，账本仅保留安全 locator", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }],
      sourceCommandRequestId: "retry-skipped-plan-source",
    });
    const command = {
      requestId: "p21-retry-skipped-public-0001",
      idempotencyKey: "p21-retry-skipped-public-key-0001",
      request: {
        command: "retry_studio_generation_plan_nodes" as const,
        payload: { planId: plan.planId, nodeIndexes: [1] },
      },
    };
    const first = await executeIdempotentCommand(fixture.root, command);
    expect(first).toMatchObject({
      status: "succeeded",
      result: {
        planId: plan.planId,
        skipped: [{ nodeIndex: 1, reason: "planned（尚无 dispatch，直接派发即可，无需重试）" }],
      },
    });
    const replay = await executeIdempotentCommand(fixture.root, {
      ...command,
      requestId: "p21-retry-skipped-public-0002",
    });
    expect(replay).toMatchObject({
      status: "succeeded",
      result: {
        planId: plan.planId,
        skipped: [{ nodeIndex: 1, reason: "planned（尚无 dispatch，直接派发即可，无需重试）" }],
        reconciled: true,
      },
    });
    const crashCommand = {
      ...command,
      requestId: "p21-retry-skipped-crash-0001",
      idempotencyKey: "p21-retry-skipped-crash-key-0001",
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "retry_studio_generation_plan_nodes";
    await expect(executeIdempotentCommand(fixture.root, crashCommand)).rejects.toThrow(/执行结果未确认/u);
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    await expect(reconcileCommand(fixture.root, { idempotencyKey: crashCommand.idempotencyKey }))
      .resolves.toMatchObject({
        status: "succeeded",
        result: {
          planId: plan.planId,
          skipped: [{ nodeIndex: 1, reason: "planned（尚无 dispatch，直接派发即可，无需重试）" }],
          reconciled: true,
        },
      });

    const generationDb = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite"));
    try {
      const receipts = generationDb.prepare(
        "SELECT outcome_json AS outcomeJson FROM studio_generation_retry_operation_receipts",
      ).all() as Array<{ outcomeJson: string }>;
      expect(receipts).toHaveLength(1);
      for (const receipt of receipts) {
        expect(receipt.outcomeJson).toContain('"reasonCode":"planned-no-dispatch"');
        expect(receipt.outcomeJson).not.toContain("尚无 dispatch");
      }
    } finally {
      generationDb.close();
    }
    const commandDb = new DatabaseSync(path.join(fixture.root, ".aicanvas", "command-ledger.sqlite"), { readOnly: true });
    try {
      const row = commandDb.prepare(
        "SELECT payload_json AS payloadJson FROM command_ledger_entries WHERE idempotency_key = ?",
      ).get(command.idempotencyKey) as { payloadJson: string };
      const record = JSON.parse(row.payloadJson) as { result: { kind: string; receiptFingerprint: string; skipped: unknown[] } };
      const persisted = record.result;
      expect(persisted).toMatchObject({
        kind: "studio-operation-result-locator",
        operation: "generation-plan-retry",
        skipped: [{ nodeIndex: 1 }],
      });
      expect(persisted.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(row.payloadJson).not.toContain("尚无 dispatch");
    } finally {
      commandDb.close();
    }
    const tamperDb = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite"));
    try {
      tamperDb.exec("DROP TRIGGER studio_generation_retry_operation_receipts_no_update");
      tamperDb.exec(`
        CREATE TRIGGER studio_generation_retry_operation_receipts_no_update
        BEFORE UPDATE ON studio_generation_retry_operation_receipts WHEN 0
        BEGIN SELECT RAISE(ABORT, 'generation retry operation receipts are append-only'); END
      `);
    } finally {
      tamperDb.close();
    }
    await expect(readStudioGenerationRetryOperationOutcomeReadOnly(
      fixture.root,
      first.requestHash,
      command.request.payload,
    )).rejects.toThrow(/no_update trigger 漂移/u);
    const generationOwnerBeforeReplay = await generationOwnerFilesystemSnapshot(fixture.root);
    let generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => {
      generationWritableOpens += 1;
    });
    try {
      await expect(executeIdempotentCommand(fixture.root, {
        ...command,
        requestId: "p21-retry-skipped-tamper-0001",
      })).rejects.toThrow(/no_update trigger 漂移/u);
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);
    expect(await generationOwnerFilesystemSnapshot(fixture.root)).toEqual(generationOwnerBeforeReplay);
    const verifyTamperDb = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite"), { readOnly: true });
    try {
      const trigger = verifyTamperDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='studio_generation_retry_operation_receipts_no_update'",
      ).get() as { sql: string };
      expect(trigger.sql.replace(/\s+/gu, " ").toLowerCase()).toContain("when 0");
    } finally {
      verifyTamperDb.close();
    }
  });

  it("plan/fail/cancel/retry 命令崩溃后按各自 proof 锚点对账", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezeTwoPanel(fixture);
    // plan：崩溃后 reconcile → source_command_request_id 锚证明。
    const planCommand = {
      requestId: "p21-durable-plan-0001",
      idempotencyKey: "p21-durable-plan-key-0001",
      request: { command: "create_studio_generation_plan" as const, payload: { nodes: [{ unitId: unit.unit.id, panelId: packs[0]!.panelId }] } },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "create_studio_generation_plan";
    await expect(executeIdempotentCommand(fixture.root, planCommand)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const planReconciled = await reconcileCommand(fixture.root, { idempotencyKey: planCommand.idempotencyKey });
    expect(planReconciled).toMatchObject({ status: "succeeded", result: { reconciled: true } });
    const planId = (planReconciled.result as { planId: string }).planId;
    const reusedPlanCommand = {
      ...planCommand,
      requestId: "p21-durable-plan-reuse-0002",
      idempotencyKey: "p21-durable-plan-reuse-key-0002",
      request: {
        command: "create_studio_generation_plan" as const,
        payload: { nodes: [{ targetKind: "panel" as const, unitId: unit.unit.id, panelId: packs[0]!.panelId }] },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "create_studio_generation_plan";
    await expect(executeIdempotentCommand(fixture.root, reusedPlanCommand)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    await expect(reconcileCommand(fixture.root, { idempotencyKey: reusedPlanCommand.idempotencyKey }))
      .resolves.toMatchObject({ status: "succeeded", result: { planId, reconciled: true } });
    const reusedBeforeTerminalCommand = {
      ...reusedPlanCommand,
      requestId: "p21-durable-plan-reuse-0003",
      idempotencyKey: "p21-durable-plan-reuse-key-0003",
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = "create_studio_generation_plan";
    await expect(executeIdempotentCommand(fixture.root, reusedBeforeTerminalCommand)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
    await expect(reconcileCommand(fixture.root, { idempotencyKey: reusedBeforeTerminalCommand.idempotencyKey }))
      .rejects.toThrow(/未找到与 requestHash\/command 完全匹配的终态提交证据/u);
    expect((await listCommandLedger(fixture.root)).find((entry) =>
      entry.idempotencyKey === reusedBeforeTerminalCommand.idempotencyKey)).toMatchObject({ status: "unknown" });
    expect((await listStudioGenerationPlanProjections(fixture.root, { limit: 36 }))
      .filter((entry) => entry.planId === planId)).toHaveLength(1);

    // dispatch（直调 core 铺底）→ fail 命令崩溃 → 事件锚证明。
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: planRunId(planId, 1, 1),
      provider: "codex",
    });
    const failCommand = {
      requestId: "p21-durable-fail-0001",
      idempotencyKey: "p21-durable-fail-key-0001",
      request: { command: "fail_studio_generation_run" as const, payload: { generationRunId: planRunId(planId, 1, 1), errorClass: "agent-timeout", detail: "对账用例" } },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "fail_studio_generation_run";
    await expect(executeIdempotentCommand(fixture.root, failCommand)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const failReconciled = await reconcileCommand(fixture.root, { idempotencyKey: failCommand.idempotencyKey });
    expect(failReconciled).toMatchObject({ status: "succeeded", result: { reconciled: true, kind: "failed" } });

    // retry 命令崩溃 → attempt≥2 投影证明。
    const retryCommand = {
      requestId: "p21-durable-retry-0001",
      idempotencyKey: "p21-durable-retry-key-0001",
      request: { command: "retry_studio_generation_plan_nodes" as const, payload: { planId } },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "retry_studio_generation_plan_nodes";
    await expect(executeIdempotentCommand(fixture.root, retryCommand)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const retryReconciled = await reconcileCommand(fixture.root, { idempotencyKey: retryCommand.idempotencyKey });
    expect(retryReconciled).toMatchObject({ status: "succeeded", result: { reconciled: true, planId } });
    expect((retryReconciled.result as { retried: Array<{ attempt: number }> }).retried[0]?.attempt).toBe(2);

    // cancel 命令崩溃 → cancelled 事件锚证明（对 attempt:2 的在途 run）。
    const cancelCommand = {
      requestId: "p21-durable-cancel-0001",
      idempotencyKey: "p21-durable-cancel-key-0001",
      request: { command: "cancel_studio_generation_run" as const, payload: { generationRunId: planRunId(planId, 1, 2), reason: "对账用例" } },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "cancel_studio_generation_run";
    await expect(executeIdempotentCommand(fixture.root, cancelCommand)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const cancelReconciled = await reconcileCommand(fixture.root, { idempotencyKey: cancelCommand.idempotencyKey });
    expect(cancelReconciled).toMatchObject({ status: "succeeded", result: { reconciled: true, kind: "cancelled" } });

    const ownerBeforePublicReplay = await generationOwnerFilesystemSnapshot(fixture.root);
    let generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
    try {
      await expect(executeIdempotentCommand(fixture.root, {
        ...planCommand,
        requestId: "p21-durable-plan-public-replay-0004",
      })).resolves.toMatchObject({ status: "succeeded", result: { planId, nodes: [{ nodeIndex: 1 }] } });
      await expect(executeIdempotentCommand(fixture.root, {
        ...failCommand,
        requestId: "p21-durable-fail-public-replay-0002",
      })).resolves.toMatchObject({ status: "succeeded", result: { kind: "failed", eventId: expect.any(String) } });
      await expect(executeIdempotentCommand(fixture.root, {
        ...cancelCommand,
        requestId: "p21-durable-cancel-public-replay-0002",
      })).resolves.toMatchObject({ status: "succeeded", result: { kind: "cancelled", eventId: expect.any(String) } });
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);
    expect(await generationOwnerFilesystemSnapshot(fixture.root)).toEqual(ownerBeforePublicReplay);

    const generationDbPath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const cancelEventId = (cancelReconciled.result as { eventId: string }).eventId;
    const tamperCancelPairDb = new DatabaseSync(generationDbPath);
    try {
      tamperCancelPairDb.exec("DROP TRIGGER studio_generation_run_events_no_delete");
      tamperCancelPairDb.prepare(`DELETE FROM studio_generation_run_events
        WHERE generation_run_id = ? AND kind = 'cancel-requested'`)
        .run(cancelCommand.request.payload.generationRunId);
      tamperCancelPairDb.exec(`CREATE TRIGGER studio_generation_run_events_no_delete
        BEFORE DELETE ON studio_generation_run_events BEGIN SELECT RAISE(ABORT, 'generation run events are append-only'); END`);
    } finally {
      tamperCancelPairDb.close();
    }
    await expect(executeIdempotentCommand(fixture.root, {
      ...cancelCommand,
      requestId: "p21-durable-cancel-pair-tamper-0003",
    })).rejects.toThrow(/request\/terminal 事件不唯一或不成对/u);
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === cancelCommand.idempotencyKey))
      .toMatchObject({ status: "succeeded", result: { eventId: cancelEventId } });

    const tamperPlanDb = new DatabaseSync(generationDbPath);
    try {
      tamperPlanDb.exec("DROP TRIGGER studio_generation_plans_no_update");
      tamperPlanDb.prepare("UPDATE studio_generation_plans SET project_id = project_id || '-tampered' WHERE plan_id = ?").run(planId);
      tamperPlanDb.exec(`CREATE TRIGGER studio_generation_plans_no_update
        BEFORE UPDATE ON studio_generation_plans BEGIN SELECT RAISE(ABORT, 'generation plans are append-only'); END`);
    } finally {
      tamperPlanDb.close();
    }
    await expect(executeIdempotentCommand(fixture.root, {
      ...planCommand,
      requestId: "p21-durable-plan-content-id-tamper-0005",
    })).rejects.toThrow(/planId 内容寻址漂移/u);

    const failEventId = (failReconciled.result as { eventId: string }).eventId;
    const tamperRunDb = new DatabaseSync(generationDbPath);
    try {
      tamperRunDb.exec("DROP TRIGGER studio_generation_run_events_no_update");
      tamperRunDb.prepare("UPDATE studio_generation_run_events SET detail_json = '{}' WHERE event_id = ?").run(failEventId);
      tamperRunDb.exec(`CREATE TRIGGER studio_generation_run_events_no_update
        BEFORE UPDATE ON studio_generation_run_events BEGIN SELECT RAISE(ABORT, 'generation run events are append-only'); END`);
    } finally {
      tamperRunDb.close();
    }
    await expect(executeIdempotentCommand(fixture.root, {
      ...failCommand,
      requestId: "p21-durable-fail-content-id-tamper-0003",
    })).rejects.toThrow(/eventId 内容寻址漂移/u);
  });
});
