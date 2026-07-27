import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type CommandRequest,
  type IdempotentCommandInput,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import {
  initializeStudioContinuityLedger,
  readStudioContinuityOperationReceipt,
  type StudioContinuityWriteResult,
} from "../src/core/studio-continuity-ledger.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import {
  listStudioGenerationReviewHistory,
  readStudioGenerationReviewOperationOutcome,
  type StudioGenerationReviewProjection,
} from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await fixture?.cleanup();
  fixture = undefined;
});

function envelope(label: string, request: CommandRequest): IdempotentCommandInput {
  return {
    requestId: `p7-command-request-${label}`,
    idempotencyKey: `p7-command-key-${label}`,
    request,
  };
}

async function crashThenRecover(
  root: string,
  label: string,
  request: StudioCommandRequest,
  viaExplicitReconciliation = false,
) {
  const first = envelope(label, request);
  process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = request.command;
  try {
    await expect(executeIdempotentCommand(root, first)).rejects.toThrow("执行结果未确认");
  } finally {
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  }
  expect((await listCommandLedger(root)).find((entry) => entry.idempotencyKey === first.idempotencyKey))
    .toMatchObject({
      status: "unknown",
      execution: { phase: "side_effect_committed" },
      durableReconciliation: { schemaVersion: 1, request },
    });
  const recovered = viaExplicitReconciliation
    ? await reconcileCommand(root, { idempotencyKey: first.idempotencyKey })
    : await executeIdempotentCommand(root, {
      ...first,
      requestId: `${first.requestId}-recovery`,
    });
  expect(recovered).toMatchObject({
    status: "succeeded",
    replayed: true,
    result: { reconciled: true },
  });
  return recovered;
}

async function registeredPair(root: string, currentFixture: StudioP7Fixture) {
  await seedStudioP7ResolvedContinuity(currentFixture);
  const panel = currentFixture.units.sixPanel.panels[0]!;
  const media = currentFixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  const pack = await freezeAndPersistStudioGenerationPack(root, {
    unitId: currentFixture.units.sixPanel.unit.id,
    panelId: panel.id,
  });
  const generationRunId = "p7-command-review-run-001";
  await dispatchStudioGenerationPack(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  return { pack, generationRunId, raw, labeled };
}

describe("P7 Studio continuity / Review 命令总线", () => {
  it("Observation 与 Correction 使用 request hash 回执、同键回放并拒绝异载荷和私有字段", async () => {
    fixture = await createStudioP7Fixture();
    const panel = fixture.units.sixPanel.panels[0]!;
    const scope = {
      kind: "panel" as const,
      scopeId: panel.id,
      unitId: fixture.units.sixPanel.unit.id,
      unitRevision: fixture.units.sixPanel.unit.revision,
      startMilliseconds: 0,
      endMilliseconds: 2_500,
    };
    const observationRequest = {
      command: "append_studio_continuity_observation" as const,
      payload: {
        expectedHeadRevision: 0,
        scope,
        subjectId: fixture.assets.ahang.id,
        field: "position" as const,
        state: {
          status: "resolved" as const,
          value: "石室中央，面向镜头右侧",
          provenance: [{ kind: "fixture", reference: panel.id, note: "P7 命令总线确定性证据。" }],
        },
      },
    };
    const firstEnvelope = envelope("continuity-observation", observationRequest);
    const first = await executeIdempotentCommand(fixture.root, firstEnvelope);
    const observation = first.result as StudioContinuityWriteResult;
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    expect(observation).toMatchObject({
      command: "append-observation",
      operationId: first.requestHash,
      applied: true,
      replayed: false,
      head: { revision: 1 },
    });
    expect(await readStudioContinuityOperationReceipt(fixture.root, first.requestHash))
      .toMatchObject({ receiptId: observation.receiptId, operationId: first.requestHash, replayed: true });

    const replay = await executeIdempotentCommand(fixture.root, {
      ...firstEnvelope,
      requestId: "p7-command-request-continuity-observation-replay",
    });
    expect(replay).toMatchObject({
      status: "succeeded",
      replayed: true,
      requestHash: first.requestHash,
      result: { receiptId: observation.receiptId, operationId: first.requestHash },
    });
    await expect(executeIdempotentCommand(fixture.root, {
      ...firstEnvelope,
      requestId: "p7-command-request-continuity-observation-different",
      request: {
        ...observationRequest,
        payload: { ...observationRequest.payload, subjectId: fixture.assets.completeGoldenMask.id },
      },
    })).rejects.toThrow("幂等键已用于不同参数");

    const correctionRequest = {
      command: "append_studio_continuity_correction" as const,
      payload: {
        ...observationRequest.payload,
        expectedHeadRevision: 1,
        supersedesEntryId: observation.entry.id,
        state: {
          status: "resolved" as const,
          value: "石室中央，面向镜头左侧",
          provenance: [{ kind: "user-review", reference: observation.entry.id, note: "方向修正。" }],
        },
      },
    };
    const correctionEnvelope = envelope("continuity-correction", correctionRequest);
    const correctionRecord = await executeIdempotentCommand(fixture.root, correctionEnvelope);
    const correction = correctionRecord.result as StudioContinuityWriteResult;
    expect(correction).toMatchObject({
      command: "append-correction",
      operationId: correctionRecord.requestHash,
      entry: { supersedesEntryId: observation.entry.id },
      head: { revision: 2 },
    });
    expect(await executeIdempotentCommand(fixture.root, {
      ...correctionEnvelope,
      requestId: "p7-command-request-continuity-correction-replay",
    })).toMatchObject({ replayed: true, result: { receiptId: correction.receiptId } });

    const crashRequest = {
      ...observationRequest,
      payload: {
        ...observationRequest.payload,
        field: "emotion" as const,
        state: {
          status: "unresolved" as const,
          reason: "等待逐帧人工核验表情。",
          provenance: [{ kind: "fixture", reference: "p7-emotion-pending" }],
        },
      },
    };
    const recovered = await crashThenRecover(fixture.root, "continuity-crash", crashRequest, true);
    expect(recovered.result).toMatchObject({
      command: "append-observation",
      operationId: recovered.requestHash,
      head: { revision: 1 },
    });
    expect((await initializeStudioContinuityLedger(fixture.root)).counts.operationReceipts).toBe(3);

    const operationInjection = {
      ...observationRequest,
      payload: { ...observationRequest.payload, operationId: "forged-operation" },
    } as unknown as StudioCommandRequest;
    await expect(executeIdempotentCommand(fixture.root, envelope("private-operation", operationInjection)))
      .rejects.toThrow(/载荷不符合合同.*operationId/u);
    const stateInjection = {
      ...observationRequest,
      payload: {
        ...observationRequest.payload,
        state: { ...observationRequest.payload.state, fingerprint: "f".repeat(64) },
      },
    } as unknown as StudioCommandRequest;
    await expect(executeIdempotentCommand(fixture.root, envelope("private-state", stateInjection)))
      .rejects.toThrow(/载荷不符合合同.*state.*fingerprint/u);

    const legacyReview = {
      command: "submit_review",
      payload: {
        itemId: "legacy-item",
        reviewType: "image",
        artifactIds: ["legacy-artifact"],
        expectedScanId: "legacy-scan",
        expectedArtifactHashes: { "legacy-artifact": "a".repeat(64) },
        decision: "pending",
        criteria: [],
      },
    } as unknown as CommandRequest;
    await expect(executeIdempotentCommand(fixture.root, envelope("legacy-review", legacyReview)))
      .rejects.toThrow(/受管素材工程拒绝旧命令 submit_review/u);
    const rejectedKeys = new Set(["p7-command-key-private-operation", "p7-command-key-private-state", "p7-command-key-legacy-review"]);
    expect((await listCommandLedger(fixture.root)).some((entry) => rejectedKeys.has(entry.idempotencyKey))).toBe(false);
  }, 60_000);

  it("Generation Review 支持 user 写面、同键回放，并在崩溃后只凭 Review operation receipt 对账", async () => {
    fixture = await createStudioP7Fixture();
    const pair = await registeredPair(fixture.root, fixture);
    const reviewBase = {
      generationRunId: pair.generationRunId,
      rawResultId: pair.raw.resultId,
      rawSha256: pair.raw.mediaSha256,
      labeledResultId: pair.labeled.resultId,
      labeledSha256: pair.labeled.mediaSha256,
      expectedPackFingerprint: pair.pack.fingerprint,
      continuityFingerprint: pair.pack.pack.continuity.fingerprint,
      decision: "pass" as const,
      criteria: [{ code: "identity-consistency", status: "pass" as const, note: "逐帧身份一致。" }],
      reviewer: "user" as const,
      note: "桌面用户完成首次生成验收。",
    };
    const observationRequest = {
      command: "submit_studio_generation_review" as const,
      payload: {
        ...reviewBase,
        kind: "observation" as const,
        expectedHeadRevision: 0,
      },
    };
    const firstEnvelope = envelope("review-observation", observationRequest);
    const first = await executeIdempotentCommand(fixture.root, firstEnvelope);
    const observation = first.result as StudioGenerationReviewProjection;
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    expect(observation).toMatchObject({
      generationRunId: pair.generationRunId,
      kind: "observation",
      baseHeadRevision: 0,
      headRevision: 1,
      reviewer: "user",
      head: true,
    });
    expect(await readStudioGenerationReviewOperationOutcome(fixture.root, first.requestHash))
      .toMatchObject({ reviewId: observation.reviewId, fingerprint: observation.fingerprint });
    expect(await executeIdempotentCommand(fixture.root, {
      ...firstEnvelope,
      requestId: "p7-command-request-review-observation-replay",
    })).toMatchObject({ replayed: true, result: { reviewId: observation.reviewId } });
    await expect(executeIdempotentCommand(fixture.root, {
      ...firstEnvelope,
      requestId: "p7-command-request-review-observation-different",
      request: {
        ...observationRequest,
        payload: { ...observationRequest.payload, note: "同幂等键异载荷必须拒绝。" },
      },
    })).rejects.toThrow("幂等键已用于不同参数");

    const correctionRequest = {
      command: "submit_studio_generation_review" as const,
      payload: {
        ...reviewBase,
        kind: "correction" as const,
        expectedHeadRevision: 1,
        supersedesReviewId: observation.reviewId,
        decision: "rework" as const,
        note: "崩溃前业务事务已提交的返工修正。",
      },
    };
    const recovered = await crashThenRecover(fixture.root, "review-crash", correctionRequest);
    const recoveredReview = recovered.result as StudioGenerationReviewProjection & { reconciled: true };
    expect(recoveredReview).toMatchObject({
      kind: "correction",
      baseHeadRevision: 1,
      headRevision: 2,
      supersedesReviewId: observation.reviewId,
      decision: "rework",
      reviewer: "user",
      reconciled: true,
    });
    expect(await readStudioGenerationReviewOperationOutcome(fixture.root, recovered.requestHash))
      .toMatchObject({ reviewId: recoveredReview.reviewId, fingerprint: recoveredReview.fingerprint });
    expect((await listStudioGenerationReviewHistory(fixture.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    })).items).toHaveLength(2);

    const operationInjection = {
      ...observationRequest,
      payload: { ...observationRequest.payload, operationId: "forged-review-operation" },
    } as unknown as StudioCommandRequest;
    await expect(executeIdempotentCommand(fixture.root, envelope("private-review-operation", operationInjection)))
      .rejects.toThrow(/载荷不符合合同.*operationId/u);
    const reviewerInjection = {
      ...observationRequest,
      payload: { ...observationRequest.payload, reviewer: "automation" },
    } as unknown as StudioCommandRequest;
    await expect(executeIdempotentCommand(fixture.root, envelope("private-reviewer", reviewerInjection)))
      .rejects.toThrow(/载荷不符合合同.*reviewer.*Invalid option/u);
    const ledger = await listCommandLedger(fixture.root);
    expect(ledger.some((entry) => entry.idempotencyKey === "p7-command-key-private-review-operation"
      || entry.idempotencyKey === "p7-command-key-private-reviewer")).toBe(false);
  }, 60_000);
});

describe("P22 submit review annotations 键集同步", () => {
  it("v2 批注键集经总线通过；旧五键形状被 required 拒绝", async () => {
    const fixture = await createStudioP7Fixture();
    const pair = await registeredPair(fixture.root, fixture);
    const base = {
      generationRunId: pair.generationRunId,
      rawResultId: pair.raw.resultId,
      rawSha256: pair.raw.mediaSha256,
      labeledResultId: pair.labeled.resultId,
      labeledSha256: pair.labeled.mediaSha256,
      expectedPackFingerprint: pair.pack.fingerprint,
      continuityFingerprint: pair.pack.pack.continuity.fingerprint,
      decision: "rework" as const,
      criteria: [{ code: "face", status: "fail" as const, note: "脸型不一致" }],
      reviewer: "user" as const,
      note: "键集用例",
    };
    const accepted = await executeIdempotentCommand(fixture.root, envelope("p22-ann-keys-accept", {
      command: "submit_studio_generation_review" as const,
      payload: {
        ...base,
        kind: "observation" as const,
        expectedHeadRevision: 0,
        annotations: [{
          id: "ann-keys-0001",
          kind: "rect" as const,
          category: "face" as const,
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
          note: "键集批注",
        }, {
          id: "ann-keys-0002",
          kind: "point" as const,
          x: 0.5,
          y: 0.5,
          width: 0,
          height: 0,
          note: "点位无 category 可选键",
        }],
      },
    }));
    expect(accepted).toMatchObject({ status: "succeeded", replayed: false });
    expect((accepted.result as { annotations: unknown[] }).annotations).toHaveLength(2);

    await expect(executeIdempotentCommand(fixture.root, envelope("p22-ann-keys-old-shape", {
      command: "submit_studio_generation_review" as const,
      payload: {
        ...base,
        kind: "observation" as const,
        expectedHeadRevision: 0,
        annotations: [{ x: 0, y: 0, width: 1, height: 1, note: "旧五键形状" }] as never,
      },
    }))).rejects.toThrow(/annotations\.0\.id/u);

    await fixture.cleanup();
  }, 120_000);
});

describe("P22 v2 批注提交的重放与崩溃对账", () => {
  it("同键重放 replayed:true；崩溃后 receipt 对账 reconciled（含 id trim 的 expectedAnnotations 比对）", async () => {
    const fixture = await createStudioP7Fixture();
    const pair = await registeredPair(fixture.root, fixture);
    const v2Annotations = [{
      id: "ann-replay-0001",
      kind: "rect" as const,
      category: "face" as const,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      note: "重放批注",
    }];
    const request = {
      command: "submit_studio_generation_review" as const,
      payload: {
        generationRunId: pair.generationRunId,
        rawResultId: pair.raw.resultId,
        rawSha256: pair.raw.mediaSha256,
        labeledResultId: pair.labeled.resultId,
        labeledSha256: pair.labeled.mediaSha256,
        expectedPackFingerprint: pair.pack.fingerprint,
        continuityFingerprint: pair.pack.pack.continuity.fingerprint,
        decision: "rework" as const,
        criteria: [{ code: "face", status: "fail" as const, note: "脸型不一致" }],
        reviewer: "user" as const,
        note: "重放用例",
        kind: "observation" as const,
        expectedHeadRevision: 0,
        annotations: v2Annotations,
      },
    };
    const first = await executeIdempotentCommand(fixture.root, envelope("p22-ann-replay", request));
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    const replay = await executeIdempotentCommand(fixture.root, envelope("p22-ann-replay", request));
    expect(replay).toMatchObject({ status: "succeeded", replayed: true });
    expect((replay.result as { reviewId: string }).reviewId).toBe((first.result as { reviewId: string }).reviewId);

    const crashEnvelope = envelope("p22-ann-crash", request);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "submit_studio_generation_review";
    await expect(executeIdempotentCommand(fixture.root, crashEnvelope)).rejects.toThrow();
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const reconciled = await reconcileCommand(fixture.root, { idempotencyKey: crashEnvelope.idempotencyKey });
    expect(reconciled).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(reconciled.result)).toContain("ann-replay-0001");

    await fixture.cleanup();
  }, 120_000);
});
