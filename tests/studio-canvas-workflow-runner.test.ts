import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
} from "./helpers/studio-p7-fixture.js";
import { normalizeStudioCanvasLayout } from "../src/core/studio-canvas-layout.js";
import {
  __setBeforeStudioCanvasWorkflowPanelFreezeHookForTests,
  runStudioCanvasWorkflowGroup,
} from "../src/core/studio-canvas-workflow-runner.js";
import { buildStudioGenerationFreezePack } from "../src/core/studio-generation.js";
import { getStudioGenerationLedgerState } from "../src/core/studio-generation-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  __setBeforeStudioCanvasWorkflowPanelFreezeHookForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

function expectGenerationEffectsUnchanged(
  before: Awaited<ReturnType<typeof getStudioGenerationLedgerState>>,
  after: Awaited<ReturnType<typeof getStudioGenerationLedgerState>>,
): void {
  expect(after.counts.packs).toBe(before.counts.packs);
  expect(after.counts.plans).toBe(before.counts.plans);
  expect(after.counts.dispatches).toBe(before.counts.dispatches);
  expect(after.counts.results).toBe(before.counts.results);
}

describe("studio-canvas-workflow-runner", () => {
  it("伪造 provider 在任何工程或账本读取写入前失败关闭", async () => {
    const missingRoot = path.join(await realpath(os.tmpdir()), `studio-provider-guard-${Date.now()}`);
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-provider-guard",
        title: "供应方门禁",
        panelIds: ["panel-provider-guard"],
        pipeline: ["image"],
        createdAt: "2026-07-22T00:00:00.000Z",
      }],
      updatedAt: "2026-07-22T00:00:00.000Z",
    }).workflowGroups[0]!;
    await expect(runStudioCanvasWorkflowGroup(missingRoot, group, {
      provider: "browser" as "codex",
      targets: [{ unitId: "unit-provider-guard", panelId: "panel-provider-guard" }],
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("不支持的 pipeline 在任何 pack/plan/dispatch/result 写入前失败关闭", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.twoPanel.panels[0]!;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-unsupported-pipeline",
        title: "禁止混合步骤",
        panelIds: [panel.id],
        pipeline: ["review", "image"],
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
      updatedAt: "2026-07-26T00:00:00.000Z",
    }).workflowGroups[0]!;
    const before = await getStudioGenerationLedgerState(fixture.root);

    await expect(runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      targets: [{ panelId: panel.id, unitId: fixture.units.twoPanel.unit.id }],
    })).rejects.toMatchObject({ code: "pipeline-unsupported" });

    expectGenerationEffectsUnchanged(before, await getStudioGenerationLedgerState(fixture.root));
    await fixture.cleanup();
  }, 120_000);

  it("旧 register 模式整批失败关闭，禁止 raw/labeled 单边登记", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);
    const unit = fixture.units.sixPanel;
    const [panelA, panelB] = unit.panels;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-register-fail-close",
        title: "旧登记模式失败关闭",
        panelIds: [panelA!.id, panelB!.id],
        pipeline: ["image"],
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
      updatedAt: "2026-07-26T00:00:00.000Z",
    }).workflowGroups[0]!;
    const before = await getStudioGenerationLedgerState(fixture.root);

    await expect(runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      imageMode: "freeze-dispatch-register",
      targets: [
        { panelId: panelA!.id, unitId: unit.unit.id },
        { panelId: panelB!.id, unitId: unit.unit.id },
      ],
      mediaShaByPanel: {
        [panelA!.id]: { raw: "a".repeat(64), labeled: "b".repeat(64) },
        [panelB!.id]: { raw: "c".repeat(64), labeled: "not-a-sha" },
      },
    })).rejects.toMatchObject({ code: "legacy-register-forbidden" });

    expectGenerationEffectsUnchanged(before, await getStudioGenerationLedgerState(fixture.root));
    await fixture.cleanup();
  }, 120_000);

  it("require 模式缺少写租约时在任何 panel freeze 前拒绝", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.twoPanel.panels[0]!;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-lease-required",
        title: "租约前置门禁",
        panelIds: [panel.id],
        pipeline: ["image"],
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
      updatedAt: "2026-07-26T00:00:00.000Z",
    }).workflowGroups[0]!;
    const before = await getStudioGenerationLedgerState(fixture.root);
    const priorMode = process.env.AI_CANVAS_WRITE_LEASE_MODE;
    process.env.AI_CANVAS_WRITE_LEASE_MODE = "require";
    try {
      await expect(runStudioCanvasWorkflowGroup(fixture.root, group, {
        provider: "codex",
        targets: [{ panelId: panel.id, unitId: fixture.units.twoPanel.unit.id }],
      })).rejects.toMatchObject({ code: "lease-required" });
    } finally {
      if (priorMode === undefined) delete process.env.AI_CANVAS_WRITE_LEASE_MODE;
      else process.env.AI_CANVAS_WRITE_LEASE_MODE = priorMode;
    }

    expectGenerationEffectsUnchanged(before, await getStudioGenerationLedgerState(fixture.root));
    await fixture.cleanup();
  }, 120_000);

  it("只读预检与实际冻结包指纹不一致时零计划、零派发", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.twoPanel.panels[0]!;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-freeze-fingerprint-conflict",
        title: "冻结指纹冲突",
        panelIds: [panel.id],
        pipeline: ["image"],
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
      updatedAt: "2026-07-26T00:00:00.000Z",
    }).workflowGroups[0]!;
    const before = await getStudioGenerationLedgerState(fixture.root);
    __setBeforeStudioCanvasWorkflowPanelFreezeHookForTests(({ expectedPacks }) => {
      const expected = expectedPacks.get(panel.id)!;
      expectedPacks.set(panel.id, { ...expected, fingerprint: "0".repeat(64) });
    });

    await expect(runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      targets: [{ panelId: panel.id, unitId: fixture.units.twoPanel.unit.id }],
    })).rejects.toMatchObject({ code: "workflow-freeze-conflict" });

    const after = await getStudioGenerationLedgerState(fixture.root);
    expect(after.counts.packs).toBe(before.counts.packs + 1);
    expect(after.counts.plans).toBe(before.counts.plans);
    expect(after.counts.dispatches).toBe(before.counts.dispatches);
    expect(after.counts.results).toBe(before.counts.results);
    await fixture.cleanup();
  }, 120_000);

  it("整单元只创建一个 unit-grid 冻结包、计划节点和派发 run", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);

    const unit = fixture.units.sixPanel;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-unit-grid-1",
        title: "整板串行试跑",
        panelIds: unit.panels.map((panel) => panel.id),
        pipeline: ["image"],
        createdAt: "2026-07-22T00:00:00.000Z",
      }],
      updatedAt: "2026-07-22T00:00:00.000Z",
    }).workflowGroups[0]!;
    const before = await getStudioGenerationLedgerState(fixture.root);
    const result = await runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      imageMode: "freeze-dispatch-only",
      generationRunIdPrefix: "test-unit-grid",
      targets: [{
        targetKind: "unit-grid",
        unitId: unit.unit.id,
      }],
    });

    expect(result).toMatchObject({ stoppedEarly: false });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      targetKind: "unit-grid",
      unitId: unit.unit.id,
      step: "image",
      ok: true,
      packId: expect.any(String),
      generationRunId: expect.stringMatching(/:node:\d+:attempt:1$/u),
      dispatchId: expect.any(String),
    });
    expect(result.outcomes[0]!.panelId).toBeUndefined();
    const after = await getStudioGenerationLedgerState(fixture.root);
    expect(after.counts.packs).toBe(before.counts.packs + 1);
    expect(after.counts.plans).toBe(before.counts.plans + 1);
    expect(after.counts.dispatches).toBe(before.counts.dispatches + 1);

    await fixture.cleanup();
  }, 120_000);

  it("画布草稿必须与正式 BindingSet 精确一致，且错配在任何账本副作用前失败", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);

    const panel = fixture.units.twoPanel.panels[0]!;
    const unitId = fixture.units.twoPanel.unit.id;
    const pack = await buildStudioGenerationFreezePack(fixture.root, { unitId, panelId: panel.id });
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-draft-guard",
        title: "草稿连接预检",
        panelIds: [panel.id],
        pipeline: ["image"],
        createdAt: "2026-07-19T00:00:00.000Z",
      }],
      updatedAt: "2026-07-19T00:00:00.000Z",
    }).workflowGroups[0]!;
    const panelNodeId = `panel:${panel.id}`;
    const scriptNodeId = `script:${pack.scriptRevision.documentId}`;
    const promptNodeId = `prompt:${pack.promptRevision.documentId}`;
    const assetNodes = pack.assets.map((asset) => ({
      id: `asset:${asset.assetId}`,
      kind: "asset" as const,
      assetId: asset.assetId,
    }));
    const nodes = [
      { id: panelNodeId, kind: "panel" as const, panelId: panel.id },
      { id: scriptNodeId, kind: "script" as const, documentId: pack.scriptRevision.documentId },
      { id: promptNodeId, kind: "prompt" as const, documentId: pack.promptRevision.documentId },
      ...assetNodes,
    ];
    const matchingEdges = [
      { sourceId: scriptNodeId, targetId: panelNodeId },
      { sourceId: promptNodeId, targetId: panelNodeId },
      ...assetNodes.map((asset) => ({ sourceId: asset.id, targetId: panelNodeId })),
    ];

    const before = await getStudioGenerationLedgerState(fixture.root);
    await expect(runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      targets: [{ panelId: panel.id, unitId }],
      draft: {
        nodes: nodes.map((node) => node.kind === "script"
          ? { ...node, documentId: "wrong-script-document" }
          : node),
        edges: matchingEdges,
      },
    })).rejects.toMatchObject({ code: "workflow-binding-mismatch" });
    const afterRejected = await getStudioGenerationLedgerState(fixture.root);
    expect(afterRejected.counts.packs).toBe(before.counts.packs);
    expect(afterRejected.counts.dispatches).toBe(before.counts.dispatches);

    const result = await runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      targets: [{ panelId: panel.id, unitId }],
      generationRunIdPrefix: "draft-guard-ok",
      draft: { nodes, edges: matchingEdges },
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ ok: true, panelId: panel.id });
    const afterAccepted = await getStudioGenerationLedgerState(fixture.root);
    expect(afterAccepted.counts.packs).toBe(before.counts.packs + 1);
    expect(afterAccepted.counts.dispatches).toBe(before.counts.dispatches + 1);

    await fixture.cleanup();
  }, 120_000);

  it("串行 freeze+dispatch 两格；失败即停且不假装真实生图", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);

    const panelA = fixture.units.twoPanel.panels[0]!;
    const panelB = fixture.units.twoPanel.panels[1]!;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-serial-1",
        title: "串行试跑",
        panelIds: [panelA.id, panelB.id],
        pipeline: ["image"],
        createdAt: "2026-07-18T00:00:00.000Z",
      }],
      updatedAt: "2026-07-18T00:00:00.000Z",
    }).workflowGroups[0]!;

    const result = await runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "grok",
      imageMode: "freeze-dispatch-only",
      generationRunIdPrefix: "test-wf",
      targets: [
        { panelId: panelA.id, unitId: fixture.units.twoPanel.unit.id },
        { panelId: panelB.id, unitId: fixture.units.twoPanel.unit.id },
      ],
    });

    expect(result.kind).toBe("studio-canvas-workflow-run");
    expect(result.stoppedEarly).toBe(false);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
    expect(result.outcomes.every((o) => o.packId && o.dispatchId)).toBe(true);
    // 顺序：先 A 后 B
    expect(result.outcomes[0]!.panelId).toBe(panelA.id);
    expect(result.outcomes[1]!.panelId).toBe(panelB.id);

    // 失败关闭：第二 panel 映射缺失时，必须在任何冻结/派发副作用前拒绝整组。
    const panelC = fixture.units.sixPanel.panels[0]!;
    const panelD = fixture.units.sixPanel.panels[1]!;
    const failGroup = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-serial-2",
        title: "串行试跑·失败即停",
        panelIds: [panelC.id, panelD.id],
        pipeline: ["image"],
        createdAt: "2026-07-18T00:00:00.000Z",
      }],
      updatedAt: "2026-07-18T00:00:00.000Z",
    }).workflowGroups[0]!;
    const beforeRejectedGroup = await getStudioGenerationLedgerState(fixture.root);
    await expect(runStudioCanvasWorkflowGroup(fixture.root, failGroup, {
      provider: "codex",
      imageMode: "freeze-dispatch-only",
      generationRunIdPrefix: "test-wf-fail",
      targets: [{ panelId: panelC.id, unitId: fixture.units.sixPanel.unit.id }],
      // panelD 无 target
    })).rejects.toMatchObject({ code: "target-scope-mismatch" });
    const afterRejectedGroup = await getStudioGenerationLedgerState(fixture.root);
    expect(afterRejectedGroup.counts.packs).toBe(beforeRejectedGroup.counts.packs);
    expect(afterRejectedGroup.counts.plans).toBe(beforeRejectedGroup.counts.plans);
    expect(afterRejectedGroup.counts.dispatches).toBe(beforeRejectedGroup.counts.dispatches);

    await fixture.cleanup();
  }, 120_000);

  it("终态 run 的幂等重放报失败并引导重试（R2 P2-5 回归）", async () => {
    const fixture = await createStudioP7Fixture();
    roots.push(path.dirname(fixture.root));
    await seedStudioP7ResolvedContinuity(fixture);
    const panel = fixture.units.twoPanel.panels[0]!;
    const unitId = fixture.units.twoPanel.unit.id;
    const group = normalizeStudioCanvasLayout({
      workflowGroups: [{
        id: "wg-terminal-replay",
        title: "终态重放",
        panelIds: [panel.id],
        pipeline: ["image"],
        createdAt: "2026-07-19T00:00:00.000Z",
      }],
      updatedAt: "2026-07-19T00:00:00.000Z",
    }).workflowGroups[0]!;
    const targets = [{ panelId: panel.id, unitId }];
    const first = await runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      imageMode: "freeze-dispatch-only",
      generationRunIdPrefix: "test-wf-terminal",
      targets,
    });
    expect(first.outcomes.every((outcome) => outcome.ok)).toBe(true);
    const runId = first.outcomes[0]!.generationRunId!;
    const { failStudioGenerationRun } = await import("../src/core/studio-generation-ledger.js");
    await failStudioGenerationRun(fixture.root, { generationRunId: runId, errorClass: "agent-timeout" });
    const replay = await runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      imageMode: "freeze-dispatch-only",
      generationRunIdPrefix: "test-wf-terminal",
      targets,
    });
    expect(replay.outcomes).toHaveLength(1);
    expect(replay.outcomes[0]).toMatchObject({ ok: false, code: "run-terminal-replay" });

    // R1 N-1 回归：attempt:1 failed → retry → attempt:2 也 failed → 重跑仍须报败（不得误报成功）。
    const planId = runId.split(":node:")[0]!;
    const { retryStudioGenerationPlanNodes } = await import("../src/core/studio-generation-ledger.js");
    const retried = await retryStudioGenerationPlanNodes(fixture.root, { planId });
    expect(retried.retried[0]).toMatchObject({ attempt: 2 });
    const attempt2RunId = retried.retried[0]!.generationRunId;
    await failStudioGenerationRun(fixture.root, { generationRunId: attempt2RunId, errorClass: "agent-timeout-again" });
    const replayAfterRetry = await runStudioCanvasWorkflowGroup(fixture.root, group, {
      provider: "codex",
      imageMode: "freeze-dispatch-only",
      generationRunIdPrefix: "test-wf-terminal",
      targets,
    });
    expect(replayAfterRetry.outcomes).toHaveLength(1);
    expect(replayAfterRetry.outcomes[0]).toMatchObject({ ok: false, code: "run-terminal-replay" });
    await fixture.cleanup();
  }, 120_000);
});
