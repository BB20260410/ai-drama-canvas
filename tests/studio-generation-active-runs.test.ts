import { afterEach, describe, expect, it } from "vitest";
import {
  cancelStudioGenerationRun,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  freezeAndPersistStudioGenerationPack,
  listStudioGenerationActiveRuns,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { createStudioP7Fixture, seedStudioP7ResolvedPanelContinuity, type StudioP7Fixture } from "./helpers/studio-p7-fixture.js";

/**
 * T4 活动 run 可发现、可恢复：listStudioGenerationActiveRuns 定向测试。
 * 验证 Agent 丢失本地 state 后仅凭 unitId+targetKind 找回完整调用身份。
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

async function freezePanel(fixture: StudioP7Fixture) {
  const unit = fixture.units.twoPanel;
  for (const panel of unit.panels) {
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
  }
  const packs: Array<{ packId: string; fingerprint: string; panelId: string }> = [];
  for (const panel of unit.panels) {
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    packs.push({ packId: frozen.packId, fingerprint: frozen.fingerprint, panelId: panel.id });
  }
  return { unit, packs };
}

describe("T4 listStudioGenerationActiveRuns", () => {
  it("空槽位返回空 runs 与空 blockingRuns", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezePanel(fixture);
    const result = await listStudioGenerationActiveRuns(fixture.root, {
      unitId: unit.unit.id,
      targetKind: "panel",
      panelId: packs[0]!.panelId,
    });
    expect(result.targetKind).toBe("panel");
    expect(result.unitId).toBe(unit.unit.id);
    expect(result.panelId).toBe(packs[0]!.panelId);
    expect(result.runs).toHaveLength(0);
    expect(result.blockingRuns).toHaveLength(0);
  });

  it("dispatch 后投影 in-flight run：非终态、阻断、nextAction=prepare-call-or-await", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezePanel(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "t4-active-run-0001",
      provider: "codex",
    });
    const result = await listStudioGenerationActiveRuns(fixture.root, {
      unitId: unit.unit.id,
      targetKind: "panel",
      panelId: packs[0]!.panelId,
    });
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.generationRunId).toBe("t4-active-run-0001");
    expect(run.packId).toBe(packs[0]!.packId);
    expect(run.provider).toBe("codex");
    expect(run.terminal).toBe(false);
    expect(run.hasCallIntent).toBe(false);
    expect(run.callId).toBeNull();
    expect(run.hasResultPair).toBe(false);
    expect(run.reviewStatus).toBe("unreviewed");
    expect(run.nextAction).toBe("prepare-call-or-await");
    // 阻断摘要
    expect(result.blockingRuns).toHaveLength(1);
    expect(result.blockingRuns[0]!.generationRunId).toBe("t4-active-run-0001");
    expect(result.blockingRuns[0]!.reason).toContain("非终态");
  });

  it("failed 终态不阻断；成对结果无 Review 阻断且 nextAction=submit-review", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezePanel(fixture);
    const media = fixture.panelMediaPairs.find((entry) => entry.panelId === packs[0]!.panelId)!;
    // run-1：dispatch → fail（终态，不阻断）
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "t4-active-run-failed",
      provider: "codex",
    });
    await failStudioGenerationRun(fixture.root, { generationRunId: "t4-active-run-failed", errorClass: "agent-timeout" });
    // run-2：dispatch → raw+labeled 成对（终态但未 Review，阻断）
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "t4-active-run-pair",
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "t4-active-run-pair",
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "t4-active-run-pair",
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });
    const result = await listStudioGenerationActiveRuns(fixture.root, {
      unitId: unit.unit.id,
      targetKind: "panel",
      panelId: packs[0]!.panelId,
    });
    expect(result.runs).toHaveLength(2);
    // 最新在前（sequence DESC）
    const pairRun = result.runs.find((r) => r.generationRunId === "t4-active-run-pair")!;
    const failedRun = result.runs.find((r) => r.generationRunId === "t4-active-run-failed")!;
    expect(pairRun.terminal).toBe(true);
    expect(pairRun.hasResultPair).toBe(true);
    expect(pairRun.reviewStatus).toBe("unreviewed");
    expect(pairRun.nextAction).toBe("submit-review");
    expect(failedRun.terminal).toBe(true);
    expect(failedRun.latestEventKind).toBe("failed");
    expect(failedRun.nextAction).toBe("retry-or-new-attempt");
    // 只有成对未 Review 的 run 阻断
    expect(result.blockingRuns).toHaveLength(1);
    expect(result.blockingRuns[0]!.generationRunId).toBe("t4-active-run-pair");
    expect(result.blockingRuns[0]!.reason).toContain("成对结果未审片");
  });

  it("cancelled 终态不阻断", async () => {
    const fixture = await p7();
    const { unit, packs } = await freezePanel(fixture);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: packs[0]!.packId,
      packFingerprint: packs[0]!.fingerprint,
      generationRunId: "t4-active-run-cancelled",
      provider: "codex",
    });
    await cancelStudioGenerationRun(fixture.root, { generationRunId: "t4-active-run-cancelled", reason: "T4 测试" });
    const result = await listStudioGenerationActiveRuns(fixture.root, {
      unitId: unit.unit.id,
      targetKind: "panel",
      panelId: packs[0]!.panelId,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.terminal).toBe(true);
    expect(result.runs[0]!.latestEventKind).toBe("cancelled");
    expect(result.runs[0]!.nextAction).toBe("retry-or-new-attempt");
    expect(result.blockingRuns).toHaveLength(0);
  });
});
