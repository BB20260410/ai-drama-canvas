import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
  getStudioGenerationPlanProjection,
} from "../src/core/studio-generation-ledger.js";
import { createStudioP7Fixture, seedStudioP7ResolvedPanelContinuity, type StudioP7Fixture } from "./helpers/studio-p7-fixture.js";

/**
 * T24 全链演练（隔离 fixture，零扣费）。
 *
 * 完整链路：freeze → plan → dispatch → register raw+labeled → Review 就绪。
 * 验证 Agent 丢失本地 state 后可从 active-runs 恢复完整调用身份。
 *
 * 不涉及真实 imagegen 调用；仅验证账本链路完整性。
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

describe("T24 全链演练（fixture 零扣费）", () => {
  it("freeze → plan → dispatch → register pair → 投影 succeeded", async () => {
    const fixture = await p7();
    const unit = fixture.units.twoPanel;

    // 1. 种子连续性
    for (const panel of unit.panels) {
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
        assetIds: panel.assets.filter((a) => a.presence !== "forbidden").map((a) => a.assetId),
      });
    }

    // 2. freeze
    const panel = unit.panels[0]!;
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    expect(frozen.packId).toBeTruthy();
    expect(frozen.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    // 3. plan
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: panel.id }],
      sourceCommandRequestId: "t24-full-chain-plan-001",
    });
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/u);

    // 4. dispatch（使用 plan 推导的 runId）
    const planRunId = `${plan.planId}:node:1:attempt:1`;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: planRunId,
      provider: "codex",
    });

    // 5. register raw+labeled（模拟 fixture call 结果）
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
    await registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: planRunId,
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: planRunId,
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });

    // 6. 验证投影：plan 节点应为 succeeded
    const projection = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    expect(projection).toBeTruthy();
    const node = projection!.nodes.find((n) => n.nodeIndex === 1);
    expect(node).toBeTruthy();
    expect(node!.status).toBe("succeeded");
    expect(node!.generationRunId).toBe(planRunId);
    expect(node!.resultId).toBeTruthy();
  });

  it("active-runs 可恢复完整调用身份", async () => {
    const fixture = await p7();
    const unit = fixture.units.twoPanel;
    for (const panel of unit.panels) {
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
        assetIds: panel.assets.filter((a) => a.presence !== "forbidden").map((a) => a.assetId),
      });
    }
    const panel = unit.panels[0]!;
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const runId = "t24-recovery-run-001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: runId,
      provider: "codex",
    });

    // Agent 丢失本地 state 后，通过 active-runs 恢复
    const { listStudioGenerationActiveRuns } = await import("../src/core/studio-generation-ledger.js");
    const activeRuns = await listStudioGenerationActiveRuns(fixture.root, {
      unitId: unit.unit.id,
      targetKind: "panel",
      panelId: panel.id,
    });
    expect(activeRuns.runs.length).toBe(1);
    const run = activeRuns.runs[0]!;
    expect(run.generationRunId).toBe(runId);
    expect(run.packId).toBe(frozen.packId);
    expect(run.provider).toBe("codex");
    expect(run.terminal).toBe(false);
    // 阻断摘要应包含此 run
    expect(activeRuns.blockingRuns.length).toBe(1);
    expect(activeRuns.blockingRuns[0]!.generationRunId).toBe(runId);
  });

  it("failed run 可通过 retry 恢复", async () => {
    const fixture = await p7();
    const unit = fixture.units.twoPanel;
    for (const panel of unit.panels) {
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
        assetIds: panel.assets.filter((a) => a.presence !== "forbidden").map((a) => a.assetId),
      });
    }
    const panel = unit.panels[0]!;
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: unit.unit.id, panelId: panel.id }],
      sourceCommandRequestId: "t24-retry-plan-001",
    });
    const runId1 = `${plan.planId}:node:1:attempt:1`;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: runId1,
      provider: "codex",
    });
    // 模拟失败
    const { failStudioGenerationRun, retryStudioGenerationPlanNodes } = await import("../src/core/studio-generation-ledger.js");
    await failStudioGenerationRun(fixture.root, { generationRunId: runId1, errorClass: "agent-timeout" });

    // retry 应创建 attempt:2
    const retried = await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    expect(retried.retried.length).toBe(1);
    expect(retried.retried[0]!.attempt).toBe(2);
    expect(retried.retried[0]!.supersedesRunId).toBe(runId1);
  });
});
