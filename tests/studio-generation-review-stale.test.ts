import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { __commandRequestHashForTests, executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  appendStudioAssetVersion,
  getStudioCanonicalAsset,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import {
  appendStudioScriptRevision,
  freezeStudioPanelAssetBindingSet,
  getCurrentStudioMentionDecision,
  getCurrentStudioPanelAssetBindingSet,
  getStudioAssetMentionAnalysis,
  getStudioProductionUnitSnapshot,
  getStudioTextDocument,
  recordStudioMentionDecision,
  reviseStudioProductionUnit,
  type StudioProductionPanel,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  initializeStudioGenerationLedger,
  readStudioGenerationResult,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { __setBeforeGenerationWritableOpenHookForTests } from "../src/core/studio-generation-ledger-storage.js";
import {
  getStudioGenerationReviewControl,
  listStudioGenerationReviewHistory,
  readStudioGenerationReview,
  submitStudioGenerationReview,
  type StudioGenerationReviewProjection,
  type SubmitStudioGenerationReviewInput,
} from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  isStudioP7TemporaryPath,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;
const originalPreflightDelay = process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS;

afterEach(async () => {
  if (originalPreflightDelay === undefined) delete process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS;
  else process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS = originalPreflightDelay;
  await fixture?.cleanup();
  fixture = undefined;
});

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type PersistedPack = Awaited<ReturnType<typeof freezeAndPersistStudioGenerationPack>>;
type GenerationResult = Awaited<ReturnType<typeof registerStudioGenerationResult>>;

interface RegisteredPair {
  persisted: PersistedPack;
  generationRunId: string;
  raw: GenerationResult;
  labeled: GenerationResult;
}

async function registeredPair(generationRunId: string, persisted?: PersistedPack): Promise<RegisteredPair> {
  if (!fixture) throw new Error("P7 Review fixture 尚未创建。");
  const panel = fixture.units.sixPanel.panels[0]!;
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id);
  if (!media) throw new Error("P7 Review fixture 缺少首格 raw/labeled。");
  const frozen = persisted ?? await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: fixture.units.sixPanel.unit.id,
    panelId: panel.id,
  });
  await dispatchStudioGenerationPack(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  return { persisted: frozen, generationRunId, raw, labeled };
}

function reviewBase(pair: RegisteredPair) {
  return {
    generationRunId: pair.generationRunId,
    rawResultId: pair.raw.resultId,
    rawSha256: pair.raw.mediaSha256,
    labeledResultId: pair.labeled.resultId,
    labeledSha256: pair.labeled.mediaSha256,
    expectedPackFingerprint: pair.persisted.fingerprint,
    continuityFingerprint: pair.persisted.pack.continuity.fingerprint,
    criteria: [
      { code: "identity-consistency", status: "pass" as const, note: "只验证确定性 fixture 合同。" },
      { code: "raw-labeled-pair", status: "pass" as const, note: "raw/labeled SHA 成对。" },
    ],
    reviewer: "p7-stale-audit",
  };
}

function panelInput(panel: StudioProductionPanel): StudioProductionPanelInput {
  return {
    id: panel.id,
    title: panel.title,
    visualAction: panel.visualAction,
    shotComposition: panel.shotComposition,
    filmingMethod: panel.filmingMethod,
    dialogue: panel.dialogue,
    subtitle: panel.subtitle,
    startSeconds: panel.startSeconds,
    endSeconds: panel.endSeconds,
    durationSeconds: panel.durationSeconds,
    promptRevisionId: panel.promptRevisionId,
    sourceSpans: panel.sourceSpans.map((span) => ({ ...span })),
    assets: panel.assets.map((asset) => ({
      assetId: asset.assetId,
      category: asset.category,
      presence: asset.presence,
      role: asset.role,
      continuityState: asset.continuityState,
      evidence: asset.evidence.map((entry) => ({ ...entry })),
    })),
  };
}

async function upstreamDigests(): Promise<{
  canonicalAsset: string;
  bindingSet: string;
  script: string;
  unit: string;
}> {
  if (!fixture) throw new Error("P7 Review fixture 尚未创建。");
  const unit = await getStudioProductionUnitSnapshot(fixture.root, fixture.units.sixPanel.unit.id);
  const bindingSet = await getCurrentStudioPanelAssetBindingSet(
    fixture.root,
    fixture.units.sixPanel.unit.id,
    fixture.units.sixPanel.panels[0]!.id,
  );
  const canonicalAsset = await getStudioCanonicalAsset(fixture.root, fixture.assets.ahang.id);
  if (!unit || !bindingSet || !canonicalAsset) throw new Error("P7 Review 上游摘要缺失。");
  return {
    canonicalAsset: digest(canonicalAsset),
    bindingSet: digest(bindingSet),
    script: digest(unit.scriptRevision),
    unit: digest({ unit: unit.unit, panels: unit.panels, fingerprint: unit.fingerprint }),
  };
}

async function advanceBindingSetHead(): Promise<void> {
  if (!fixture) throw new Error("P7 Review fixture 尚未创建。");
  const unitId = fixture.units.sixPanel.unit.id;
  const panelId = fixture.units.sixPanel.panels[0]!.id;
  const current = await getCurrentStudioPanelAssetBindingSet(fixture.root, unitId, panelId);
  if (!current) throw new Error("P7 Review fixture 缺少 BindingSet Head。");
  const analysis = await getStudioAssetMentionAnalysis(fixture.root, current.analysisId);
  if (!analysis) throw new Error("P7 Review fixture 缺少 BindingSet analysis。");
  const decisions = [];
  for (const proposal of analysis.proposals) {
    const head = await getCurrentStudioMentionDecision(fixture.root, proposal.id);
    if (!head) throw new Error(`P7 Review fixture 缺少 decision Head：${proposal.id}`);
    decisions.push(await recordStudioMentionDecision(fixture.root, {
      receiptId: `p7-stale-binding-${proposal.mentionId}`,
      proposalId: proposal.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: head.revision,
      action: head.decision.action,
      ...(head.decision.selectedAssetId ? { selectedAssetId: head.decision.selectedAssetId } : {}),
      presence: head.decision.presence,
      role: `${head.decision.role}；P7 stale 审计二次确认。`,
      reviewer: "p7-stale-audit",
      note: "制造显式 BindingSet Head 漂移。",
    }));
  }
  const next = await freezeStudioPanelAssetBindingSet(fixture.root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: current.revision,
    decisionReceiptIds: decisions.map((decision) => decision.id),
    assetSources: current.bindings.map((binding) => ({
      assetId: binding.assetId,
      category: binding.category,
      assetRevision: binding.assetRevision,
      definitionVersionId: binding.definitionVersionId,
      authorityEventId: binding.authorityEventId,
      authorityVersionId: binding.authorityVersionId,
      assetVersionId: binding.assetVersionId,
      mediaSha256: binding.mediaSha256,
      knowledgeFingerprint: binding.knowledgeFingerprint,
      applicabilityFingerprint: binding.applicabilityFingerprint,
    })),
  });
  expect(next.revision).toBe(current.revision + 1);
  expect(next.id).not.toBe(current.id);
}

async function advanceAuthority(): Promise<void> {
  if (!fixture) throw new Error("P7 Review fixture 尚未创建。");
  const current = await getStudioCanonicalAsset(fixture.root, fixture.assets.ahang.id);
  if (!current) throw new Error("P7 Review fixture 缺少阿航规范资产。");
  const replacementSha = fixture.panelMediaPairs[1]!.labeled.imported.sha256;
  const appended = await appendStudioAssetVersion(fixture.root, {
    assetId: current.id,
    mediaSha256: replacementSha,
    reviewStatus: "pending",
    sourceNote: "P7 stale 机械 fixture 权威漂移。",
    expectedRevision: current.revision,
  });
  const reviewed = await reviewStudioAssetVersion(fixture.root, {
    assetId: current.id,
    versionId: appended.version.id,
    decision: "approved",
    expectedRevision: appended.assetRevision,
    note: "仅批准 fixture 身份，不代表视觉验收。",
  });
  const authoritative = await setStudioPrimaryAuthority(fixture.root, {
    assetId: current.id,
    versionId: appended.version.id,
    expectedRevision: reviewed.revision,
    note: "P7 stale 审计权威漂移。",
  });
  expect(authoritative.primaryAuthority?.versionId).toBe(appended.version.id);
}

async function advanceScriptAndUnit(): Promise<void> {
  if (!fixture) throw new Error("P7 Review fixture 尚未创建。");
  const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.units.sixPanel.unit.id);
  if (!snapshot) throw new Error("P7 Review fixture 缺少生产单元。");
  const document = await getStudioTextDocument(fixture.root, snapshot.scriptRevision.documentId);
  if (!document) throw new Error("P7 Review fixture 缺少剧本文档。");
  const scriptV2 = await appendStudioScriptRevision(fixture.root, {
    documentId: document.id,
    expectedRevision: document.revision,
    body: `${snapshot.scriptRevision.body}\n阿航忽然转身，火光熄灭。`,
    source: "fixture/p7/EP01-stale-v2.md",
    sourceVersion: "p7-stale-script-v2",
  });
  const revised = await reviseStudioProductionUnit(fixture.root, {
    unitId: snapshot.unit.id,
    expectedRevision: snapshot.unit.revision,
    season: snapshot.unit.season,
    episode: snapshot.unit.episode,
    sequence: snapshot.unit.sequence,
    title: snapshot.unit.title,
    scriptRevisionId: scriptV2.revision.id,
    panels: snapshot.panels.map(panelInput),
  });
  expect(revised.unit.revision).toBe(snapshot.unit.revision + 1);
  expect(revised.scriptRevision.id).toBe(scriptV2.revision.id);
}

function correctionInput(
  pair: RegisteredPair,
  observation: StudioGenerationReviewProjection,
  operationId: string,
  decision: "pass" | "rework" | "reject",
  note: string,
): SubmitStudioGenerationReviewInput {
  return {
    ...reviewBase(pair),
    operationId,
    kind: "correction",
    expectedHeadRevision: 1,
    supersedesReviewId: observation.reviewId,
    decision,
    note,
  };
}

describe("P7 Studio generation Review stale/CAS 安全合同", () => {
  it("预检读取后 script/BindingSet/Authority 漂移时，correction 只追加历史且不移动 Head", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const temporaryRoot = await realpath("/tmp");
    expect(isStudioP7TemporaryPath(fixture.root, temporaryRoot)).toBe(true);
    expect(fixture.shell.project.sourceRoots).toEqual([]);
    expect(fixture.allMedia.every((media) => isStudioP7TemporaryPath(media.sourcePath, temporaryRoot))).toBe(true);

    const pair = await registeredPair("p7-review-stale-run-001");
    const beforeObservation = await upstreamDigests();
    const observation = await submitStudioGenerationReview(fixture.root, {
      ...reviewBase(pair),
      operationId: "p7-stale-observation-001",
      kind: "observation",
      expectedHeadRevision: 0,
      decision: "pass",
      note: "漂移前的 current observation。",
    });
    expect(observation).toMatchObject({ headRevision: 1, advancesHead: true, head: true, current: true });
    expect(await upstreamDigests()).toEqual(beforeObservation);

    const [rawBeforeDrift, labeledBeforeDrift] = await Promise.all([
      readStudioGenerationResult(fixture.root, pair.raw.resultId),
      readStudioGenerationResult(fixture.root, pair.labeled.resultId),
    ]);
    expect(rawBeforeDrift).toMatchObject({ inputCurrent: true, promotionEligible: true });
    expect(labeledBeforeDrift).toMatchObject({ inputCurrent: true, promotionEligible: true });

    const preDrift = await upstreamDigests();
    process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS = "3000";
    const pendingHistorical = submitStudioGenerationReview(fixture.root, correctionInput(
      pair,
      observation,
      "p7-stale-historical-correction-001",
      "rework",
      "预检读取后上游漂移，只允许历史留痕。",
    ));
    await wait(500);
    await advanceBindingSetHead();
    await advanceAuthority();
    await advanceScriptAndUnit();
    const driftedBeforeReviewWrite = await upstreamDigests();
    const historical = await pendingHistorical;
    if (originalPreflightDelay === undefined) delete process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS;
    else process.env.AI_CANVAS_TEST_REVIEW_PREFLIGHT_DELAY_MS = originalPreflightDelay;

    expect(driftedBeforeReviewWrite.canonicalAsset).not.toBe(preDrift.canonicalAsset);
    expect(driftedBeforeReviewWrite.bindingSet).not.toBe(preDrift.bindingSet);
    expect(driftedBeforeReviewWrite.script).not.toBe(preDrift.script);
    expect(driftedBeforeReviewWrite.unit).not.toBe(preDrift.unit);
    expect(await upstreamDigests()).toEqual(driftedBeforeReviewWrite);

    const [rawAfterDrift, labeledAfterDrift] = await Promise.all([
      readStudioGenerationResult(fixture.root, pair.raw.resultId),
      readStudioGenerationResult(fixture.root, pair.labeled.resultId),
    ]);
    for (const result of [rawAfterDrift, labeledAfterDrift]) {
      expect(result).toMatchObject({ inputCurrent: false, promotionEligible: false });
      expect(result!.staleReasons.length).toBeGreaterThan(0);
    }
    const control = await getStudioGenerationReviewControl(fixture.root, pair.generationRunId);
    const history = await listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    });
    const rereadObservation = await readStudioGenerationReview(fixture.root, observation.reviewId);
    expect(historical).toMatchObject({
      kind: "correction",
      baseHeadRevision: 1,
      supersedesReviewId: observation.reviewId,
      currentAtSubmission: false,
      advancesHead: false,
      head: false,
      current: false,
      approvedRawEligible: false,
    });
    expect(historical.headRevision).toBeUndefined();
    expect(historical.staleReasons).toContain("generation-input-stale");
    expect(control).toMatchObject({
      headRevision: 1,
      status: "stale",
      head: { reviewId: observation.reviewId, head: true, current: false },
    });
    expect(history.items.map((entry) => [entry.reviewId, entry.head, entry.current])).toEqual([
      [observation.reviewId, true, false],
      [historical.reviewId, false, false],
    ]);
    expect(rereadObservation).toMatchObject({ reviewId: observation.reviewId, head: true, current: false });

    const repeatedStaleRequest = {
      command: "submit_studio_generation_review" as const,
      payload: {
        ...reviewBase(pair),
        reviewer: "user" as const,
        kind: "correction" as const,
        expectedHeadRevision: 1,
        supersedesReviewId: observation.reviewId,
        decision: "rework" as const,
        note: "同一 stale Review 允许由两个不同 operation receipt 绑定。",
      },
    };
    const firstOperation = await submitStudioGenerationReview(fixture.root, {
      ...repeatedStaleRequest.payload,
      operationId: "p7-stale-review-direct-operation-0001",
    });
    await wait(5);
    const commandOperationId = __commandRequestHashForTests(fixture.root, repeatedStaleRequest);
    const secondOperation = await submitStudioGenerationReview(fixture.root, {
      ...repeatedStaleRequest.payload,
      operationId: commandOperationId,
    });
    expect(secondOperation).toMatchObject({
      reviewId: firstOperation.reviewId,
      currentAtSubmission: false,
      advancesHead: false,
    });
    const receiptDb = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite"), {
      readOnly: true,
    });
    try {
      expect(receiptDb.prepare(`
        SELECT COUNT(*) AS count, COUNT(DISTINCT created_at) AS distinctCreatedAt
        FROM studio_generation_review_operation_receipts
        WHERE review_id = ?
      `).get(firstOperation.reviewId)).toEqual({ count: 2, distinctCreatedAt: 2 });
    } finally {
      receiptDb.close();
    }
    const firstPublic = await executeIdempotentCommand(fixture.root, {
      requestId: "p7-stale-review-operation-request-0002",
      idempotencyKey: "p7-stale-review-operation-key-0002",
      request: repeatedStaleRequest,
    });
    expect(firstPublic.result).toMatchObject({
      reviewId: firstOperation.reviewId,
      currentAtSubmission: false,
      advancesHead: false,
    });
    let generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
    try {
      await expect(executeIdempotentCommand(fixture.root, {
        requestId: "p7-stale-review-operation-request-0002-replay",
        idempotencyKey: "p7-stale-review-operation-key-0002",
        request: repeatedStaleRequest,
      })).resolves.toMatchObject({
        status: "succeeded",
        replayed: true,
        result: {
          reviewId: firstOperation.reviewId,
          current: false,
          approvedRawEligible: false,
          currentStaleReasons: expect.arrayContaining(["strict-recovery-currentness-not-proven"]),
        },
      });
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);

    console.log(`P7_REVIEW_STALE_HISTORICAL_ONLY ${JSON.stringify({
      drifted: ["script", "binding-set", "authority"],
      historyCount: history.items.length,
      headRevision: control.headRevision,
      staleAdvancedHead: historical.advancesHead,
      upstreamMutationByReview: false,
    })}`);
  }, 45_000);

  it("同 Head 并发 correction 仅一个成功，同 operationId 异载荷零写，重启可恢复且 cursor 不串 run", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    expect(isStudioP7TemporaryPath(fixture.root, await realpath("/tmp"))).toBe(true);
    expect(fixture.shell.project.sourceRoots).toEqual([]);
    const pair = await registeredPair("p7-review-cas-run-001");
    const upstreamBefore = await upstreamDigests();
    const observation = await submitStudioGenerationReview(fixture.root, {
      ...reviewBase(pair),
      operationId: "p7-cas-observation-001",
      kind: "observation",
      expectedHeadRevision: 0,
      decision: "pass",
      note: "并发 correction 的 Head 1。",
    });
    const candidates = [
      correctionInput(pair, observation, "p7-cas-correction-a", "rework", "并发候选 A。"),
      correctionInput(pair, observation, "p7-cas-correction-b", "reject", "并发候选 B。"),
    ];
    const settled = await Promise.allSettled(candidates.map((input) => submitStudioGenerationReview(fixture!.root, input)));
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<StudioGenerationReviewProjection> => result.status === "fulfilled");
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "review-conflict" });
    const winner = fulfilled[0]!.value;
    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    const winnerInput = candidates[winnerIndex]!;

    const beforeConflictHistory = await listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    });
    const beforeConflictControl = await getStudioGenerationReviewControl(fixture.root, pair.generationRunId);
    expect(beforeConflictHistory.items).toHaveLength(2);
    expect(beforeConflictControl).toMatchObject({
      headRevision: 2,
      head: { reviewId: winner.reviewId, head: true, current: true },
    });
    await expect(submitStudioGenerationReview(fixture.root, {
      ...winnerInput,
      note: `${winnerInput.note}同 operationId 异载荷。`,
    })).rejects.toMatchObject({ code: "operation-conflict" });
    const afterConflictHistory = await listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    });
    const afterConflictControl = await getStudioGenerationReviewControl(fixture.root, pair.generationRunId);
    expect(afterConflictHistory).toEqual(beforeConflictHistory);
    expect(afterConflictControl).toEqual(beforeConflictControl);
    expect(await upstreamDigests()).toEqual(upstreamBefore);

    await initializeStudioGenerationLedger(fixture.root);
    const restoredHistory = await listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    });
    const restoredControl = await getStudioGenerationReviewControl(fixture.root, pair.generationRunId);
    expect(restoredHistory.items.map((entry) => entry.reviewId)).toEqual(beforeConflictHistory.items.map((entry) => entry.reviewId));
    expect(restoredControl).toMatchObject({
      headRevision: 2,
      head: { reviewId: winner.reviewId, fingerprint: winner.fingerprint },
    });

    const firstPage = await listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: pair.generationRunId,
      limit: 1,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondRun = await registeredPair("p7-review-cursor-run-002", pair.persisted);
    await submitStudioGenerationReview(fixture.root, {
      ...reviewBase(secondRun),
      operationId: "p7-cursor-observation-002",
      kind: "observation",
      expectedHeadRevision: 0,
      decision: "pass",
      note: "第二个 run 的独立 Review。",
    });
    await expect(listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: secondRun.generationRunId,
      cursor: firstPage.nextCursor,
      limit: 10,
    })).rejects.toMatchObject({ code: "invalid-cursor" });

    console.log(`P7_REVIEW_CAS_RECOVERY_CURSOR ${JSON.stringify({
      concurrentFulfilled: fulfilled.length,
      concurrentRejected: rejected.length,
      historyAfterOperationConflict: afterConflictHistory.items.length,
      restoredHeadRevision: restoredControl.headRevision,
      crossRunCursorRejected: true,
      upstreamMutationByReview: false,
    })}`);
  }, 45_000);
});
