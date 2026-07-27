import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  getStudioGenerationPlanProjection,
  registerStudioGenerationResult,
  retryStudioGenerationPlanNodes,
} from "../src/core/studio-generation-ledger.js";
import {
  submitStudioGenerationReview,
  type StudioGenerationReviewDecision,
  type StudioGenerationReviewProjection,
} from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const fixtures: StudioP7Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function preparedSucceededPlan() {
  const fixture = await createStudioP7Fixture();
  fixtures.push(fixture);
  const unit = fixture.units.twoPanel;
  const panel = unit.panels[0]!;
  await seedStudioP7ResolvedPanelContinuity(fixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
    assetIds: panel.assets
      .filter((asset) => asset.presence !== "forbidden")
      .map((asset) => asset.assetId),
  });
  const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
  });
  const plan = await createStudioGenerationPlan(fixture.root, {
    nodes: [{ unitId: unit.unit.id, panelId: panel.id }],
    sourceCommandRequestId: `review-retry-plan-${fixtures.length}`,
  });
  const generationRunId = `${plan.planId}:node:1:attempt:1`;
  await dispatchStudioGenerationPack(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
    provider: "codex",
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
    provider: "codex",
  });
  return { fixture, frozen, plan, generationRunId, raw, labeled };
}

async function reviewCurrentPair(
  prepared: Awaited<ReturnType<typeof preparedSucceededPlan>>,
  decision: StudioGenerationReviewDecision,
  options: {
    operationId: string;
    kind?: "observation" | "correction";
    expectedHeadRevision?: number;
    supersedesReviewId?: string;
  },
): Promise<StudioGenerationReviewProjection> {
  return submitStudioGenerationReview(prepared.fixture.root, {
    operationId: options.operationId,
    generationRunId: prepared.generationRunId,
    kind: options.kind ?? "observation",
    expectedHeadRevision: options.expectedHeadRevision ?? 0,
    ...(options.supersedesReviewId ? { supersedesReviewId: options.supersedesReviewId } : {}),
    rawResultId: prepared.raw.resultId,
    rawSha256: prepared.raw.mediaSha256,
    labeledResultId: prepared.labeled.resultId,
    labeledSha256: prepared.labeled.mediaSha256,
    expectedPackFingerprint: prepared.frozen.fingerprint,
    continuityFingerprint: prepared.frozen.pack.continuity.fingerprint,
    decision,
    criteria: [{
      code: "original-size-visual-qc",
      status: decision === "pass" ? "pass" : "fail",
      note: decision === "rework" ? "机械 fixture 模拟人工返工裁决。" : "机械 fixture 决策。",
    }],
    reviewer: "review-retry-test",
    note: `测试当前结果对 Review Head=${decision}。`,
  });
}

describe("generation plan Review REWORK retry", () => {
  it("当前结果对的当前 REWORK Head 追加 retry-superseded 与 attempt:2，保留旧成功结果和 Review", async () => {
    const prepared = await preparedSucceededPlan();
    const review = await reviewCurrentPair(prepared, "rework", {
      operationId: "review-retry-positive-rework",
    });
    expect(review).toMatchObject({ head: true, current: true, decision: "rework" });

    const retried = await retryStudioGenerationPlanNodes(prepared.fixture.root, {
      planId: prepared.plan.planId,
      nodeIndexes: [1],
    });
    expect(retried).toEqual({
      planId: prepared.plan.planId,
      retried: [{
        nodeIndex: 1,
        generationRunId: `${prepared.plan.planId}:node:1:attempt:2`,
        attempt: 2,
        supersedesRunId: prepared.generationRunId,
        idempotentReplay: false,
      }],
      skipped: [],
    });
    await expect(getStudioGenerationPlanProjection(prepared.fixture.root, prepared.plan.planId))
      .resolves.toMatchObject({
        nodes: [{
          nodeIndex: 1,
          generationRunId: `${prepared.plan.planId}:node:1:attempt:2`,
          attempt: 2,
          status: "dispatched",
        }],
      });

    const db = new DatabaseSync(path.join(
      prepared.fixture.root,
      ".aicanvas",
      "studio-generation-ledger.sqlite",
    ), { readOnly: true });
    try {
      expect(db.prepare(
        "SELECT variant FROM studio_generation_results WHERE generation_run_id=? ORDER BY variant",
      ).all(prepared.generationRunId)).toEqual([{ variant: "labeled" }, { variant: "raw" }]);
      expect(db.prepare(`
        SELECT kind FROM studio_generation_run_events
        WHERE generation_run_id=? ORDER BY sequence
      `).all(prepared.generationRunId)).toEqual([
        { kind: "dispatched" },
        { kind: "retry-superseded" },
      ]);
      expect(db.prepare(`
        SELECT head.review_id AS reviewId, review.decision AS decision
        FROM studio_generation_review_heads head
        JOIN studio_generation_review_events review ON review.review_id=head.review_id
        WHERE head.generation_run_id=?
      `).get(prepared.generationRunId)).toEqual({
        reviewId: review.reviewId,
        decision: "rework",
      });
    } finally {
      db.close();
    }
  }, 120_000);

  it("无 Review 与当前 REJECT Head 均不可重试", async () => {
    const unreviewed = await preparedSucceededPlan();
    const unreviewedRetry = await retryStudioGenerationPlanNodes(unreviewed.fixture.root, {
      planId: unreviewed.plan.planId,
    });
    expect(unreviewedRetry.retried).toEqual([]);
    expect(unreviewedRetry.skipped[0]?.reason).toContain("不可重试");

    const rejected = await preparedSucceededPlan();
    await reviewCurrentPair(rejected, "reject", {
      operationId: "review-retry-negative-reject",
    });
    const rejectedRetry = await retryStudioGenerationPlanNodes(rejected.fixture.root, {
      planId: rejected.plan.planId,
    });
    expect(rejectedRetry.retried).toEqual([]);
    expect(rejectedRetry.skipped[0]?.reason).toContain("不可重试");
  }, 120_000);

  it("旧 REWORK 仍保留但当前 Head 已 PASS 时不可重试", async () => {
    const prepared = await preparedSucceededPlan();
    const staleRework = await reviewCurrentPair(prepared, "rework", {
      operationId: "review-retry-stale-rework",
    });
    const currentPass = await reviewCurrentPair(prepared, "pass", {
      operationId: "review-retry-current-pass",
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: staleRework.reviewId,
    });
    expect(currentPass).toMatchObject({
      head: true,
      current: true,
      decision: "pass",
      supersedesReviewId: staleRework.reviewId,
    });

    const retry = await retryStudioGenerationPlanNodes(prepared.fixture.root, {
      planId: prepared.plan.planId,
    });
    expect(retry.retried).toEqual([]);
    expect(retry.skipped[0]?.reason).toContain("不可重试");

    const db = new DatabaseSync(path.join(
      prepared.fixture.root,
      ".aicanvas",
      "studio-generation-ledger.sqlite",
    ), { readOnly: true });
    try {
      expect(db.prepare(`
        SELECT review_id AS reviewId, decision
        FROM studio_generation_review_events
        WHERE generation_run_id=? ORDER BY sequence
      `).all(prepared.generationRunId)).toEqual([
        { reviewId: staleRework.reviewId, decision: "rework" },
        { reviewId: currentPass.reviewId, decision: "pass" },
      ]);
    } finally {
      db.close();
    }
  }, 120_000);
});
