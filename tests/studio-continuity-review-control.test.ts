import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT,
  getStudioContinuityReviewControl,
  paginateStudioContinuityReviewItems,
} from "../src/core/studio-continuity-review-control.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const roots: string[] = [];
let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 连续性 / Review 只读聚合控制", () => {
  it("空受管工程不扫描历史工程，返回有界空投影和 Core 推导的唯一下一动作", async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-p7-control-empty-")));
    roots.push(temporaryRoot);
    const project = await createManagedProject({ parentRoot: temporaryRoot, name: "P7 空控制面" });

    const control = await getStudioContinuityReviewControl(project.paths.root, {
      unitId: "unit-empty",
      unitRevision: 1,
      panelId: "panel-empty-01",
      startMilliseconds: 0,
      endMilliseconds: 7_500,
      assetIds: [],
    });

    expect(control).toMatchObject({
      kind: "studio-continuity-review-control",
      assetIds: [],
      assets: [],
      conflicts: { total: 0, items: [] },
      checkpoint: {
        completedSlotCount: 0,
        fullBatchCount: 0,
        collectingSlotCount: 0,
        newSlotDispatchAllowed: true,
        batches: { total: 0, items: [] },
      },
      generation: { status: "blocked" },
      nextAction: { code: "resolve-generation-input" },
    });
    expect(control.review).toBeUndefined();
    expect(control.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("在 /tmp fixture 上显示九字段缺口，显式 seed 后变为 ready 且时间线只返回请求页", async () => {
    fixture = await createStudioP7Fixture();
    expect(path.resolve(fixture.root).startsWith(`${path.resolve(fixture.temporaryRoot)}${path.sep}`)).toBe(true);
    const unit = fixture.units.sixPanel;
    const panel = unit.panels[0]!;
    const assetIds = panel.assets.map((asset) => asset.assetId);
    const input = {
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      panelId: panel.id,
      startMilliseconds: Math.round(panel.startSeconds * 1_000),
      endMilliseconds: Math.round(panel.endSeconds * 1_000),
      assetIds,
      timelineLimit: 3,
    } as const;

    const unresolved = await getStudioContinuityReviewControl(fixture.root, input);
    expect(unresolved.assets).toHaveLength(3);
    expect(unresolved.assets.every((asset) => !asset.ready)).toBe(true);
    expect(unresolved.assets.every((asset) => asset.fields.length === 9)).toBe(true);
    expect(unresolved.assets.flatMap((asset) => asset.fields).every((field) => field.status === "missing")).toBe(true);
    expect(unresolved.nextAction).toMatchObject({
      code: "record-continuity-state",
      command: "append_studio_continuity_observation",
      assetId: assetIds[0],
    });

    await seedStudioP7ResolvedContinuity(fixture);
    const ready = await getStudioContinuityReviewControl(fixture.root, input);
    expect(ready.assets.every((asset) => asset.ready)).toBe(true);
    expect(ready.assets.flatMap((asset) => asset.fields).every((field) => field.status === "resolved")).toBe(true);
    expect(ready.generation).toMatchObject({ status: "ready" });
    for (const asset of ready.assets) {
      expect(asset.timeline).toMatchObject({ offset: 0, limit: 3, total: 9, nextOffset: 3 });
      expect(asset.timeline.items).toHaveLength(3);
      expect(asset.timeline.items.every((item) => item.startMilliseconds === 0 && item.endMilliseconds === 2_500)).toBe(true);
    }
    expect(ready.nextAction).toMatchObject({ code: "execute-agent-imagegen" });

    const pair = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
    const persisted = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const generationRunId = "p7-control-review-run-001";
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
      mediaSha256: pair.raw.imported.sha256,
    });
    const labeled = await registerStudioGenerationResult(fixture.root, {
      packId: persisted.packId,
      packFingerprint: persisted.fingerprint,
      generationRunId,
      variant: "labeled",
      mediaSha256: pair.labeled.imported.sha256,
    });
    await submitStudioGenerationReview(fixture.root, {
      operationId: "p7-control-review-observation-001",
      generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: raw.resultId,
      rawSha256: raw.mediaSha256,
      labeledResultId: labeled.resultId,
      labeledSha256: labeled.mediaSha256,
      expectedPackFingerprint: persisted.fingerprint,
      continuityFingerprint: persisted.pack.continuity.fingerprint,
      decision: "pass",
      criteria: [{ code: "mechanical-fixture", status: "pass", note: "只验证账本。" }],
      reviewer: "p7-control-test",
      note: "确定性 fixture Review，不声明真实视觉质量。",
    });
    const reviewed = await getStudioContinuityReviewControl(fixture.root, {
      ...input,
      generationRunId,
      reviewLimit: 1,
    });
    expect(reviewed.review).toMatchObject({
      control: { status: "pass", headRevision: 1, nextAction: "approved-raw-ready" },
      history: { limit: 1, items: [{ generationRunId, decision: "pass", current: true }] },
    });
    expect(reviewed.checkpoint).toMatchObject({
      completedSlotCount: 1,
      fullBatchCount: 0,
      collectingSlotCount: 1,
      newSlotDispatchAllowed: true,
    });
    expect(reviewed.nextAction).toMatchObject({ code: "approved-raw-ready", requiresWrite: false });

    // Dashboard 不传 generationRunId 时，必须从宫格结果账本自解析到同一 run。
    const autoResolved = await getStudioContinuityReviewControl(fixture.root, {
      ...input,
      reviewLimit: 1,
    });
    expect(autoResolved.resolvedGenerationRunId).toBe(generationRunId);
    expect(autoResolved.nextAction).toMatchObject({
      code: "approved-raw-ready",
      requiresWrite: false,
      generationRunId,
    });
  }, 120_000);

  it("纯分页器面对万项投影也只返回受控窗口，不把大列表传给 UI/MCP", () => {
    const large = Array.from({ length: 10_000 }, (_, index) => ({ id: index + 1 }));
    const first = paginateStudioContinuityReviewItems(
      large,
      0,
      STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT,
      STUDIO_CONTINUITY_REVIEW_TIMELINE_LIMIT,
    );
    expect(first).toMatchObject({
      offset: 0,
      limit: 36,
      total: 10_000,
      nextOffset: 36,
    });
    expect(first.items).toHaveLength(36);
    const tail = paginateStudioContinuityReviewItems(large, 9_990, 36, 36);
    expect(tail.items).toHaveLength(10);
    expect(tail.nextOffset).toBeUndefined();
    expect(() => paginateStudioContinuityReviewItems(large, 0, 37, 36)).toThrow(/limit/u);
  });
});
