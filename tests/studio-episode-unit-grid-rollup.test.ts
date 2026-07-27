/**
 * T14/T19 统一口径回归：
 * - 诊断按 projectRoot+season+episode+targetKind=unit-grid 过滤；
 * - PASS 数、completedUnits、raw 节点数严格同源（同一 canonical 投影）；
 * - 失败/待审/拒绝/未知分别统计；owner-abandoned 闭合不可复用，不计入 unknown。
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getContinuousGenerationState } from "../src/core/studio-continuous-generation-state.js";
import { getStudioProductionDiagnostics } from "../src/core/studio-production-diagnostics.js";
import {
  abandonUnitGridRun,
  addUnitGridFixtureUnit,
  commitUnitGridBundle,
  createUnitGridFixtureProject,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
  unitGridFixtureContinuationWaiver,
} from "./helpers/studio-unit-grid-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T14/T19 诊断与连续状态统一口径", () => {
  it("诊断按集过滤；completedUnits==PASS；owner-abandoned 不误报 generation_unknown", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-rollup-parent-")));
    roots.push(parent);
    // S03/EP01：unit-001 PASS、unit-002 待审、unit-003 unknown、unit-004 owner-abandoned。
    const fixture = await createUnitGridFixtureProject(parent, {
      unitId: "unit-001",
      season: "S03",
      episode: "EP01",
      sequence: 1,
    });
    const root = fixture.root;
    for (const [unitId, sequence] of [["unit-002", 2], ["unit-003", 3], ["unit-004", 4]] as const) {
      await addUnitGridFixtureUnit(root, {
        unitId,
        season: "S03",
        episode: "EP01",
        sequence,
        scriptRevisionId: fixture.scriptRevisionId,
        promptRevisionId: fixture.promptRevisionId,
      });
    }
    // S03/EP02：另一集单元（验证过滤口径，不得混入 EP01）。
    await addUnitGridFixtureUnit(root, {
      unitId: "unit-e02",
      season: "S03",
      episode: "EP02",
      sequence: 1,
      scriptRevisionId: fixture.scriptRevisionId,
      promptRevisionId: fixture.promptRevisionId,
    });

    const run1 = await freezeDispatchPrepareUnitGrid(root, "unit-001", "rollup-run-001");
    const bundle1 = await commitUnitGridBundle(root, run1, "rollup-bundle-001");
    await passUnitGridReview(root, run1, bundle1, "rollup-review-001");

    const run2 = await freezeDispatchPrepareUnitGrid(root, "unit-002", "rollup-run-002", {
      continuationWaiver: await unitGridFixtureContinuationWaiver(
        root,
        "unit-002",
        "fixture:rollup:unit-002",
      ),
    });
    await commitUnitGridBundle(root, run2, "rollup-bundle-002");

    await freezeDispatchPrepareUnitGrid(root, "unit-003", "rollup-run-003", {
      continuationWaiver: await unitGridFixtureContinuationWaiver(
        root,
        "unit-003",
        "fixture:rollup:unit-003",
      ),
    });

    const run4 = await freezeDispatchPrepareUnitGrid(root, "unit-004", "rollup-run-004", {
      continuationWaiver: await unitGridFixtureContinuationWaiver(
        root,
        "unit-004",
        "fixture:rollup:unit-004",
      ),
    });
    await abandonUnitGridRun(root, run4, "rollup-abandon-004");

    const runE02 = await freezeDispatchPrepareUnitGrid(root, "unit-e02", "rollup-run-e02");
    const bundleE02 = await commitUnitGridBundle(root, runE02, "rollup-bundle-e02");
    await passUnitGridReview(root, runE02, bundleE02, "rollup-review-e02");

    // 诊断：EP01 过滤口径。
    const diag = await getStudioProductionDiagnostics(root, { season: "S03", episode: "EP01" });
    expect(diag.episodeScope).toMatchObject({
      season: "S03",
      episode: "EP01",
      totalUnits: 4,
      dispatchedUnits: 4,
      completedUnits: 1,
      passCount: 1,
      // unit-001 + unit-002 各 1 raw / 1 labeled；EP02 不混入。
      rawResultCount: 2,
      labeledResultCount: 2,
      pendingReviewCount: 1,
      reworkCount: 0,
      rejectedCount: 0,
      failedCount: 0,
      generationUnknownCount: 1,
      ownerAbandonedCount: 1,
    });
    expect(diag.episodeScope.generationUnknownUnitIds).toEqual(["unit-003"]);
    // owner-abandoned 明确闭合：单独标记且绝不计入 generation_unknown。
    expect(diag.episodeScope.ownerAbandonedUnitIds).toEqual(["unit-004"]);
    expect(diag.episodeScope.generationUnknownUnitIds).not.toContain("unit-004");

    // 连续状态：与诊断复用同一 canonical 投影，completedUnits === PASS 数。
    const state = await getContinuousGenerationState(root, { season: "S03", episode: "EP01" });
    expect(state.progress.totalUnits).toBe(4);
    expect(state.progress.completedUnits).toBe(1);
    expect(state.progress.completedUnits).toBe(diag.episodeScope.passCount);
    expect(state.progress.completedUnits).toBe(diag.episodeScope.completedUnits);
    expect(state.progress.passUnits).toBe(1);
    expect(state.progress.ownerAbandonedUnits).toBe(1);

    // 过滤口径：EP02 独立成集。
    const diagE02 = await getStudioProductionDiagnostics(root, { season: "S03", episode: "EP02" });
    expect(diagE02.episodeScope).toMatchObject({
      totalUnits: 1,
      completedUnits: 1,
      passCount: 1,
      rawResultCount: 1,
      labeledResultCount: 1,
      generationUnknownCount: 0,
      ownerAbandonedCount: 0,
    });
    const stateE02 = await getContinuousGenerationState(root, { season: "S03", episode: "EP02" });
    expect(stateE02.progress.totalUnits).toBe(1);
    expect(stateE02.progress.completedUnits).toBe(1);
  }, 120_000);
});
