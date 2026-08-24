import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type IdempotentCommandInput,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { readStudioPostResultObservationOutcomeByOperationId } from "../src/core/studio-post-result-observation.js";
import { __setBeforeGenerationWritableOpenHookForTests } from "../src/core/studio-generation-ledger-storage.js";
import { buildNextShotContinuitySnapshot } from "../src/core/studio-next-shot-continuity.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;
type PostResultObservationCommandRequest = Extract<
  StudioCommandRequest,
  { command: "submit_studio_post_result_observation" }
>;

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await fixture?.cleanup();
  fixture = undefined;
});

async function prepareCurrentPass() {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  const panel = fixture.units.sixPanel.panels[0]!;
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  const evidenceMedia = fixture.panelMediaPairs.find((entry) => entry.panelId !== panel.id)!.raw.imported;
  const pack = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: fixture.units.sixPanel.unit.id,
    panelId: panel.id,
  });
  const generationRunId = "observation-command-bus-run-001";
  await dispatchStudioGenerationPack(fixture.root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  const review = await submitStudioGenerationReview(fixture.root, {
    operationId: "observation-command-bus-review-001",
    generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: raw.resultId,
    rawSha256: raw.mediaSha256,
    labeledResultId: labeled.resultId,
    labeledSha256: labeled.mediaSha256,
    expectedPackFingerprint: pack.fingerprint,
    continuityFingerprint: pack.pack.continuity.fingerprint,
    decision: "pass",
    criteria: [{ code: "visual-pass", status: "pass", note: "夹具当前 PASS。" }],
    reviewer: "observation-command-bus-test",
    note: "为实际末态命令总线提供当前 PASS Review。",
  });
  return { panel, evidenceMedia, pack, generationRunId, raw, labeled, review };
}

function observationRequest(
  prepared: Awaited<ReturnType<typeof prepareCurrentPass>>,
): PostResultObservationCommandRequest {
  const continuitySnapshot = buildNextShotContinuitySnapshot({
    sourceUnitId: fixture!.units.sixPanel.unit.id,
    sourcePanelId: prepared.panel.id,
    sourceRawSha256: prepared.raw.mediaSha256,
    characters: [{
      assetId: "character-ahang",
      costumeState: "古蜀猎人服装完整，无新增污损",
      position: "画面中央",
      facing: "朝镜头略偏左",
      gazeDirection: "注视黄金面具",
      actionEndPose: "双手托住黄金面具",
      nextActionStart: "保持双手托举，从面具抬眼看向石门",
      expression: "警觉",
    }],
    props: [{
      assetId: "prop-golden-mask",
      heldBy: "character-ahang",
      position: "阿航胸前双手之间",
      physicalState: "完整、闭合",
    }],
    scene: {
      layout: "主体居中、场景锚点在后",
      axisLine: "主体与黄金面具构成前后轴线",
      screenDirection: "阿航视线由画面中央指向右后方",
      entryExits: ["画面右后方石门"],
      lighting: "左亮右暗",
      timeOfDay: "夜",
      cutExit: "阿航抬眼锁定右后方石门时切出",
    },
    vfx: [],
    referenceSha256List: [prepared.raw.mediaSha256, prepared.evidenceMedia.sha256],
  });
  return {
    command: "submit_studio_post_result_observation",
    payload: {
      generationRunId: prepared.generationRunId,
      expectedHeadRevision: 0,
      expectedReviewId: prepared.review.reviewId,
      expectedReviewFingerprint: prepared.review.fingerprint,
      rawResultId: prepared.raw.resultId,
      rawSha256: prepared.raw.mediaSha256,
      labeledResultId: prepared.labeled.resultId,
      labeledSha256: prepared.labeled.mediaSha256,
      packId: prepared.pack.packId,
      packFingerprint: prepared.pack.fingerprint,
      plannedContinuityFingerprint: prepared.pack.pack.continuity.fingerprint,
      evidenceKind: "accepted-last-frame",
      evidenceSha256: prepared.evidenceMedia.sha256,
      observedState: {
        costume: "实际画面服装保持冻结状态。",
        injury: "实际画面未见新增伤势。",
        heldObject: "实际画面双手持原道具。",
        position: "实际画面主体位于画面中央。",
        facing: "实际画面主体朝向镜头略偏左。",
        emotion: "实际画面神情警觉。",
        layout: "实际画面主体居中、场景锚点在后。",
        lighting: "实际画面左亮右暗。",
        referenceSha256: prepared.evidenceMedia.sha256,
        motionVector: "实际末帧动作已收稳。",
        cameraPhase: "实际末帧机位稳定。",
        focusState: "实际末帧焦点落在主体。",
        audioPhase: "实际末帧对白结束，环境声延续。",
      },
      observedAvailability: {
        costume: "observed",
        injury: "observed",
        heldObject: "observed",
        position: "observed",
        facing: "observed",
        emotion: "observed",
        layout: "observed",
        lighting: "observed",
        motionVector: "unknown",
        cameraPhase: "unknown",
        focusState: "observed",
        audioPhase: "unknown",
      },
      continuitySnapshot,
      observer: "codex",
      note: "只记录从当前 PASS raw 观察到的实际末态。",
    },
  };
}

function envelope(label: string, request: StudioCommandRequest): IdempotentCommandInput {
  return {
    requestId: `post-result-command-request-${label}`,
    idempotencyKey: `post-result-command-key-${label}`,
    request,
  };
}

describe("实际末态观察命令总线", () => {
  it("operationId 只由 request hash 注入，同键重放且异载荷/私有字段失败关闭", async () => {
    const prepared = await prepareCurrentPass();
    const request = observationRequest(prepared);
    const input = envelope("normal-001", request);
    const written = await executeIdempotentCommand(fixture!.root, input);
    expect(written).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        generationRunId: prepared.generationRunId,
        baseHeadRevision: 0,
        headRevision: 1,
        current: true,
        continuationEligible: true,
      },
    });
    await expect(readStudioPostResultObservationOutcomeByOperationId(fixture!.root, written.requestHash))
      .resolves.toMatchObject({
        observationId: (written.result as { observationId: string }).observationId,
        fingerprint: (written.result as { fingerprint: string }).fingerprint,
      });

    const replay = await executeIdempotentCommand(fixture!.root, {
      ...input,
      requestId: "post-result-command-request-normal-replay",
    });
    expect(replay).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        observationId: (written.result as { observationId: string }).observationId,
        current: false,
        continuationEligible: false,
        currentStaleReasons: ["strict-recovery-currentness-not-proven"],
      },
    });
    expect((replay.result as { continuationIneligibleReasons: string[] }).continuationIneligibleReasons)
      .not.toContain("strict-recovery-currentness-not-proven");
    const persisted = (await listCommandLedger(fixture!.root))
      .find((entry) => entry.idempotencyKey === input.idempotencyKey)!;
    expect(persisted.result).toMatchObject({
      schemaVersion: 1,
      kind: "studio-operation-result-locator",
      operation: "post-result-observation",
    });
    expect(JSON.stringify(persisted)).not.toMatch(/actual|实际画面|continuitySnapshot|observer|note|evidenceKind/u);
    await expect(executeIdempotentCommand(fixture!.root, {
      ...input,
      requestId: "post-result-command-request-normal-conflict",
      request: {
        ...request,
        payload: { ...request.payload, note: "同键异载荷必须拒绝。" },
      },
    })).rejects.toThrow("幂等键已用于不同参数");

    const forged = {
      ...request,
      payload: { ...request.payload, operationId: "forged-operation-id" },
    } as unknown as StudioCommandRequest;
    await expect(executeIdempotentCommand(fixture!.root, envelope("forged-operation", forged)))
      .rejects.toThrow(/operationId/u);
    expect((await listCommandLedger(fixture!.root))
      .some((entry) => entry.idempotencyKey === "post-result-command-key-forged-operation")).toBe(false);

    const forgedNested = {
      ...request,
      payload: {
        ...request.payload,
        continuitySnapshot: {
          ...request.payload.continuitySnapshot!,
          privatePath: "/forbidden",
        },
      },
    } as unknown as StudioCommandRequest;
    await expect(executeIdempotentCommand(
      fixture!.root,
      envelope("forged-continuity-snapshot", forgedNested),
    )).rejects.toThrow(/continuitySnapshot.*(?:非公开字段|Unrecognized key)/u);
  }, 90_000);

  it("crash-after-execute 后只凭 observation receipt 对账，不重复追加事件", async () => {
    const prepared = await prepareCurrentPass();
    const request = observationRequest(prepared);
    const input = envelope("crash-001", request);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = request.command;
    await expect(executeIdempotentCommand(fixture!.root, input)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;

    const unknown = (await listCommandLedger(fixture!.root))
      .find((entry) => entry.idempotencyKey === input.idempotencyKey)!;
    expect(unknown).toMatchObject({
      status: "unknown",
      execution: { phase: "side_effect_committed" },
    });
    expect(unknown.durableReconciliation).toBeUndefined();
    const persistedUnknown = JSON.stringify(unknown);
    expect(persistedUnknown).not.toContain("实际画面主体位于画面中央");
    expect(persistedUnknown).not.toContain("只记录从当前 PASS raw 观察到的实际末态");
    await expect(readStudioPostResultObservationOutcomeByOperationId(fixture!.root, unknown.requestHash))
      .resolves.toMatchObject({ generationRunId: prepared.generationRunId });

    const reconciled = await reconcileCommand(fixture!.root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        generationRunId: prepared.generationRunId,
        reconciled: true,
        current: false,
        continuationEligible: false,
        currentStaleReasons: ["strict-recovery-currentness-not-proven"],
      },
    });
    const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas/studio-generation-ledger.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM studio_post_result_observation_events").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM studio_post_result_observation_operation_receipts").get())
      .toEqual({ count: 1 });
    db.close();

    const commandLedgerDb = new DatabaseSync(path.join(fixture!.root, ".aicanvas", "command-ledger.sqlite"));
    try {
      const row = commandLedgerDb.prepare(
        "SELECT payload_json FROM command_ledger_entries WHERE idempotency_key = ?",
      ).get(input.idempotencyKey) as { payload_json: string };
      const tampered = JSON.parse(row.payload_json) as { result: Record<string, unknown> };
      tampered.result.fingerprint = "9".repeat(64);
      commandLedgerDb.prepare(
        "UPDATE command_ledger_entries SET payload_json = ? WHERE idempotency_key = ?",
      ).run(JSON.stringify(tampered), input.idempotencyKey);
    } finally {
      commandLedgerDb.close();
    }
    let generationWritableOpens = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
    try {
      await expect(executeIdempotentCommand(fixture!.root, {
        ...input,
        requestId: "post-result-command-request-crash-tampered-locator",
      })).rejects.toThrow(/摘要|冲突|locator|回执/u);
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
    }
    expect(generationWritableOpens).toBe(0);
  }, 90_000);
});
