import { afterEach, describe, expect, it } from "vitest";
import {
  abandonStudioGenerationUnknown,
  cancelStudioGenerationRun,
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  readStudioGenerationRunEventHistory,
  registerStudioGenerationResult,
  retryStudioGenerationPlanNodes,
} from "../src/core/studio-generation-ledger.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7ContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

/**
 * 终态失败/取消 run 的槽位占用矩阵（checkpoint dispatch 门禁定向测试）。
 * 只走核心层函数（不经 MCP）；全部 mkdtemp 隔离工程，不消费任何外部凭证。
 * 矩阵语义：
 * - failed/cancelled 且无结果、无未闭合 generation_unknown → 旧 run 不占槽，允许受管新 attempt；
 * - 任何结果行存在且无 Review → 维持“尚待人工验收”；
 * - 未闭合 generation_unknown call intent → 必须先 reconcile/abandon，拒绝另开 runId。
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

/** panel 槽位：连续性种子 + 冻结首格 pack。 */
async function freezePanelSlot(fixture: StudioP7Fixture) {
  const unit = fixture.units.twoPanel;
  const panel = unit.panels[0]!;
  await seedStudioP7ResolvedPanelContinuity(fixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
    assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
  });
  const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
  });
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  return { unit, panel, frozen, media };
}

/** unit-grid 槽位：两格连续性种子 + 冻结 unit-grid pack。 */
async function freezeUnitGridSlot(fixture: StudioP7Fixture) {
  const unit = fixture.units.twoPanel;
  for (const panel of unit.panels) {
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
  }
  const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
    targetKind: "unit-grid",
    unitId: unit.unit.id,
    verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
      fixture.root,
      unit,
      "fixture:dispatch-gate-matrix",
    ),
  });
  return { unit, frozen };
}

describe("checkpoint dispatch 门禁：终态占槽矩阵", () => {
  it("panel：dispatch → fail（无 call intent）→ 同槽新 runId dispatch 允许，旧 run 证据不动", async () => {
    const fixture = await p7();
    const { frozen } = await freezePanelSlot(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-panel-run-a",
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, {
      generationRunId: "gate-matrix-panel-run-a",
      errorClass: "agent-timeout",
      detail: "矩阵用例：失败后释放槽位",
    });
    // 修复前：failed 终态被“尚待人工验收”永久占槽。
    const reopened = await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-panel-run-b",
      provider: "codex",
    });
    expect(reopened.generationRunId).toBe("gate-matrix-panel-run-b");
    // 旧 run 证据与 lineage 不动。
    const history = await readStudioGenerationRunEventHistory(fixture.root, "gate-matrix-panel-run-a");
    expect(history.map((event) => event.kind)).toEqual(["dispatched", "failed"]);
  }, 120_000);

  it("unit-grid：dispatch → prepare（generation_unknown）→ fail/cancel 被拒 → 同槽新 runId dispatch 拒绝（generation-unknown）", async () => {
    const fixture = await p7();
    const { frozen } = await freezeUnitGridSlot(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-grid-run-a",
      provider: "codex",
    });
    const intent = await prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-grid-run-a",
      provider: "codex",
      projectContextToken: "gate-matrix-context-token",
      commandRequestId: "gate-matrix-prepare-command-001",
      expectedRevision: 0,
    });
    expect(intent.status).toBe("generation_unknown");
    // generation_unknown 未闭合：fail/cancel 均被受管路径拒绝。
    await expect(failStudioGenerationRun(fixture.root, {
      generationRunId: "gate-matrix-grid-run-a",
      errorClass: "agent-timeout",
    })).rejects.toMatchObject({ code: "generation-unknown" });
    await expect(cancelStudioGenerationRun(fixture.root, {
      generationRunId: "gate-matrix-grid-run-a",
      reason: "矩阵用例：unknown 禁止直接取消",
    })).rejects.toMatchObject({ code: "generation-unknown" });
    // 同槽新 runId：必须先 reconcile/abandon，details 指认 generation-unknown 与占用 runId。
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-grid-run-b",
      provider: "codex",
    })).rejects.toMatchObject({
      code: "checkpoint-required",
      details: expect.arrayContaining(["generation-unknown", "generationRunId=gate-matrix-grid-run-a"]),
    });
  }, 120_000);

  it("panel：dispatch → raw+labeled 成对结果 → 无 Review → 同槽新 runId dispatch 拒绝（尚待人工验收）", async () => {
    const fixture = await p7();
    const { frozen, media } = await freezePanelSlot(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-review-run-a",
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-review-run-a",
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-review-run-a",
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-review-run-b",
      provider: "codex",
    })).rejects.toMatchObject({
      code: "checkpoint-required",
      details: expect.arrayContaining(["review-missing", "generationRunId=gate-matrix-review-run-a"]),
    });
  }, 120_000);

  it("panel：dispatch → cancel（无 call intent）→ 同槽新 runId dispatch 允许，旧 run 证据不动", async () => {
    const fixture = await p7();
    const { frozen } = await freezePanelSlot(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-cancel-run-a",
      provider: "codex",
    });
    await cancelStudioGenerationRun(fixture.root, {
      generationRunId: "gate-matrix-cancel-run-a",
      reason: "矩阵用例：取消后释放槽位",
    });
    const reopened = await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-cancel-run-b",
      provider: "codex",
    });
    expect(reopened.generationRunId).toBe("gate-matrix-cancel-run-b");
    const history = await readStudioGenerationRunEventHistory(fixture.root, "gate-matrix-cancel-run-a");
    expect(history.map((event) => event.kind)).toEqual(["dispatched", "cancel-requested", "cancelled"]);
  }, 120_000);

  it("unit-grid：dispatch → prepare（generation_unknown）→ cancel 被拒 → 同槽新 runId dispatch 拒绝（须先对账）", async () => {
    const fixture = await p7();
    const { frozen } = await freezeUnitGridSlot(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-grid-cancel-a",
      provider: "codex",
    });
    await prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-grid-cancel-a",
      provider: "codex",
      projectContextToken: "gate-matrix-context-token",
      commandRequestId: "gate-matrix-prepare-command-002",
      expectedRevision: 0,
    });
    await expect(cancelStudioGenerationRun(fixture.root, {
      generationRunId: "gate-matrix-grid-cancel-a",
      reason: "矩阵用例：unknown 禁止绕过对账直接取消",
    })).rejects.toMatchObject({ code: "generation-unknown" });
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "gate-matrix-grid-cancel-b",
      provider: "codex",
    })).rejects.toMatchObject({
      code: "checkpoint-required",
      details: expect.arrayContaining(["generation-unknown", "generationRunId=gate-matrix-grid-cancel-a"]),
    });
  }, 120_000);

  it("unit-grid：dispatch → prepare → owner abandon → plan retry → 新 attempt prepare 允许（retry-superseded 不死锁）", async () => {
    const fixture = await p7();
    const { unit, frozen } = await freezeUnitGridSlot(fixture);
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: unit.unit.id }],
      sourceCommandRequestId: "gate-matrix-retry-plan-001",
    });
    const attempt1RunId = `${plan.planId}:node:1:attempt:1`;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: attempt1RunId,
      provider: "codex",
    });
    const intent = await prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: attempt1RunId,
      provider: "codex",
      projectContextToken: "gate-matrix-context-token",
      commandRequestId: "gate-matrix-prepare-command-003",
      expectedRevision: 0,
    });
    // generation_unknown 走受管 owner abandon 闭合（确认远端可能存在、迟到结果永久拒收）。
    await abandonStudioGenerationUnknown(fixture.root, {
      callId: intent.callId,
      generationRunId: attempt1RunId,
      projectContextToken: `studioctx-v1-${"a".repeat(64)}`,
      evidenceReference: "gate-matrix-abandon-evidence",
      evidenceFingerprint: "b".repeat(64),
      reason: "矩阵用例：恢复中断后封存未知调用",
      acknowledgeRemoteMayExist: true,
      acknowledgeLateResultWillBeRejected: true,
    });
    // plan retry：旧 attempt 追加 retry-superseded，新 attempt:2 派发。
    await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    const attempt2RunId = `${plan.planId}:node:1:attempt:2`;
    // 修复前：旧 run 的 retry-superseded 按“在途（保守）”重新占槽并要求 Review，
    // 而无结果 run 无法提交 Review → 永久死锁。修复后新 attempt 可直接 prepare。
    const reopened = await prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: attempt2RunId,
      provider: "codex",
      projectContextToken: "gate-matrix-context-token",
      commandRequestId: "gate-matrix-prepare-command-004",
      expectedRevision: 0,
    });
    expect(reopened).toMatchObject({
      generationRunId: attempt2RunId,
      status: "generation_unknown",
      callAllowed: true,
      idempotentReplay: false,
    });
    // 旧 attempt lineage 保留：含 cancelled(owner-abandoned)，末位为 retry-superseded。
    const history = await readStudioGenerationRunEventHistory(fixture.root, attempt1RunId);
    expect(history.map((event) => event.kind)).toContain("cancelled");
    expect(history[history.length - 1]!.kind).toBe("retry-superseded");
  }, 120_000);
});
