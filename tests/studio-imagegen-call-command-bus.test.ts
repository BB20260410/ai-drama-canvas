import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  dispatchStudioGenerationPack,
  createStudioGenerationPlan,
  freezeAndPersistStudioUnitGridGenerationPack,
  getStudioGenerationPlanProjection,
  readStudioGenerationRunEventHistory,
  readStudioImagegenCallIntentByRun,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7UserContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
const originalCrashAfterExecute = process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
const originalCrashBeforeCommitEvent = process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
let fixture: StudioP7Fixture | undefined;
let registryParent: string | undefined;

afterEach(async () => {
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  if (originalCrashAfterExecute === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = originalCrashAfterExecute;
  if (originalCrashBeforeCommitEvent === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
  else process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = originalCrashBeforeCommitEvent;
  if (fixture) await fixture.cleanup();
  if (registryParent) await rm(registryParent, { recursive: true, force: true });
  fixture = undefined;
  registryParent = undefined;
});

function envelope(index: string, request: IdempotentCommandInput["request"]): IdempotentCommandInput {
  return {
    requestId: `call-request-${index}`,
    idempotencyKey: `call-idempotency-${index}`,
    request,
  };
}

describe.sequential("Studio imagegen call 命令总线 capability", () => {
  it("只有首次 prepare 返回一次 callAllowed，账本、重放与 generic reconcile 永久降权", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    registryParent = path.join("/tmp", `ai-canvas-call-registry-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    fixture = await createStudioP7Fixture();
    const identityWorkspace = path.join(fixture.parentRoot, "stable-build-identity");
    await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
    await Promise.all([
      writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
      writeFile(path.join(identityWorkspace, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
    ]);
    process.env.AI_CANVAS_WORKSPACE = identityWorkspace;
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);

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
      continuationWaiver: await studioP7UserContinuationWaiver(
        fixture.root,
        unit,
        "fixture:imagegen-call-command-bus",
      ),
    });
    const generationRunId = "unit-grid-call-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "grok",
    });
    const context = await getActiveManagedStudioContext();
    const prepareRequest = {
      command: "prepare_studio_imagegen_call" as const,
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        provider: "grok" as const,
        projectContextToken: context.projectContextToken,
        callerAgentId: "codex-session-fixture-0001",
        expectedRevision: 0 as const,
      },
    };
    const firstEnvelope = envelope("prepare-0001", prepareRequest);
    const first = await executeIdempotentCommand(fixture.root, firstEnvelope);
    expect(first).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        callAllowed: true,
        idempotentReplay: false,
        callerAgentId: "codex-session-fixture-0001",
      },
    });
    const prepared = first.result as {
      callId: string;
      inputFingerprint: string;
      quarantine: { candidatePath: string; receiptPath: string };
    };
    const callId = prepared.callId;
    await expect(readStudioImagegenCallIntentByRun(fixture.root, generationRunId))
      .resolves.toMatchObject({
        callId,
        callerAgentId: "codex-session-fixture-0001",
      });

    const listed = (await listCommandLedger(fixture.root))
      .find((entry) => entry.idempotencyKey === firstEnvelope.idempotencyKey);
    expect(listed).toMatchObject({ result: { callId, callAllowed: false, idempotentReplay: true } });
    const replay = await executeIdempotentCommand(fixture.root, {
      ...firstEnvelope,
      requestId: "call-request-prepare-replay-0001",
    });
    expect(replay).toMatchObject({ replayed: true, result: { callId, callAllowed: false, idempotentReplay: true } });
    const reconciled = await reconcileCommand(fixture.root, { idempotencyKey: firstEnvelope.idempotencyKey });
    expect(reconciled).toMatchObject({ replayed: true, result: { callId, callAllowed: false, idempotentReplay: true } });

    await expect(executeIdempotentCommand(fixture.root, envelope("reconcile-stale", {
      command: "reconcile_studio_imagegen_call",
      payload: {
        callId,
        projectContextToken: "studioctx-v1-".concat("0".repeat(64)),
        result: "not-invoked",
        evidenceReference: "stale-context-must-not-land",
        evidenceFingerprint: "1".repeat(64),
        expectedRevision: 0,
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", reason: "project_context_conflict" },
    });
    const rawPath = prepared.quarantine.candidatePath;
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#26384a" } })
      .png({ compressionLevel: 0 })
      .toFile(rawPath);
    const rawSha256 = createHash("sha256").update(await readFile(rawPath)).digest("hex");
    const executionReceipt = {
      schemaVersion: 1 as const,
      kind: "agent-imagegen-execution-receipt" as const,
      provider: "grok" as const,
      source: "grok-build-imagine" as const,
      attestationLevel: "agent-session-direct" as const,
      cryptographicProviderReceipt: false as const,
      callId,
      model: "grok-4.5",
      agentSessionId: "grok-session-fixture-0001",
      toolCallId: "grok-tool-call-fixture-0001",
      toolName: "image_gen" as const,
      toolInvocationCount: 1 as const,
      inputFingerprint: prepared.inputFingerprint,
      candidateSha256: rawSha256,
      startedAt: "2026-07-22T00:00:00.000Z",
      generatedAt: "2026-07-22T00:00:01.000Z",
    };
    await writeFile(prepared.quarantine.receiptPath, `${JSON.stringify(executionReceipt, null, 2)}\n`);
    const committed = await executeIdempotentCommand(fixture.root, envelope("commit-unit-grid", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        provider: "grok",
        rawPath,
        rawSha256,
        executionReceiptPath: prepared.quarantine.receiptPath,
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt,
      },
    }));
    expect(committed).toMatchObject({
      status: "succeeded",
      result: {
        generationRunId,
        target: { targetKind: "unit-grid", targetKey: `unit-grid:${unit.unit.id}`, panelCount: unit.panels.length },
        results: { schemaVersion: 5, pairComplete: true },
        review: { status: "pending", autoApproved: false },
      },
    });
    await expect(executeIdempotentCommand(fixture.root, envelope("reconcile-after-result", {
      command: "reconcile_studio_imagegen_call",
      payload: {
        callId,
        projectContextToken: context.projectContextToken,
        result: "not-invoked",
        evidenceReference: "result-already-committed",
        evidenceFingerprint: "2".repeat(64),
        expectedRevision: 0,
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", code: "call-intent-conflict" },
    });

    // 门禁适配：同槽已有完整 raw+labeled 对，另开 generationRunId 前必须先为该对提交 Review。
    const committedResults = committed.result as {
      results: { raw: { resultId: string }; labeled: { resultId: string } };
      media: { labeled: { sha256: string } };
    };
    await submitStudioGenerationReview(fixture.root, {
      operationId: "call-review-run-0001",
      generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: committedResults.results.raw.resultId,
      rawSha256,
      labeledResultId: committedResults.results.labeled.resultId,
      labeledSha256: committedResults.media.labeled.sha256,
      expectedPackFingerprint: frozen.fingerprint,
      continuityFingerprint: frozen.pack.continuityFingerprint,
      decision: "pass",
      criteria: [{ code: "identity-consistency", status: "pass", note: "run-0001 bundle 机械验收通过。" }],
      reviewer: "user",
      note: "另开 run-0002 故障门用例前对 run-0001 结果对的机械 Review。",
    });

    // 故障门：第二个 run 在 Core 已追加 pre-call intent 后、command receipt 落盘前崩溃。
    // 恢复只能对账同一 callId，任何同参新 operation 都不能再次获得模型调用授权。
    const crashRunId = "unit-grid-call-run-0002";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: crashRunId,
      provider: "codex",
    });
    const crashRequest = {
      command: "prepare_studio_imagegen_call" as const,
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: crashRunId,
        provider: "codex" as const,
        projectContextToken: context.projectContextToken,
        expectedRevision: 0 as const,
      },
    };
    const crashEnvelope = envelope("prepare-crash-0002", crashRequest);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = crashRequest.command;
    try {
      await expect(executeIdempotentCommand(fixture.root, crashEnvelope)).rejects.toThrow("执行结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === crashEnvelope.idempotencyKey))
      .toMatchObject({ status: "unknown", durableReconciliation: { schemaVersion: 1, request: crashRequest } });
    const recoveredCrash = await reconcileCommand(fixture.root, { idempotencyKey: crashEnvelope.idempotencyKey });
    expect(recoveredCrash).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: { generationRunId: crashRunId, callAllowed: false, idempotentReplay: true },
    });
    const postCrashNewOperation = await executeIdempotentCommand(fixture.root, envelope("prepare-after-crash-0002", crashRequest));
    expect(postCrashNewOperation).toMatchObject({
      status: "succeeded",
      result: {
        callId: (recoveredCrash.result as { callId: string }).callId,
        generationRunId: crashRunId,
        status: "generation_unknown",
        callAllowed: false,
        idempotentReplay: true,
      },
    });

    const abandonedCallId = (recoveredCrash.result as { callId: string }).callId;
    const abandonRequest = {
      command: "abandon_studio_generation_unknown" as const,
      payload: {
        callId: abandonedCallId,
        generationRunId: crashRunId,
        projectContextToken: context.projectContextToken,
        evidenceReference: "command-bus-owner-confirmation-20260723",
        evidenceFingerprint: "3".repeat(64),
        reason: "用户接受远端调用仍可能存在，并要求封存旧 run、永久拒收迟到结果。",
        acknowledgeRemoteMayExist: true as const,
        acknowledgeLateResultWillBeRejected: true as const,
        expectedRevision: 0 as const,
      },
    };
    const abandonEnvelope = envelope("owner-abandon-crash-0002", abandonRequest);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = abandonRequest.command;
    try {
      await expect(executeIdempotentCommand(fixture.root, abandonEnvelope)).rejects.toThrow("执行结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === abandonEnvelope.idempotencyKey))
      .toMatchObject({ status: "unknown", durableReconciliation: { schemaVersion: 1, request: abandonRequest } });
    const recoveredAbandon = await reconcileCommand(fixture.root, { idempotencyKey: abandonEnvelope.idempotencyKey });
    expect(recoveredAbandon).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        generationRunId: crashRunId,
        kind: "cancelled",
        callId: abandonedCallId,
        status: "owner-abandoned",
        reconciled: true,
        detail: {
          disposition: "owner-abandoned-generation-unknown",
          remoteInvocation: "unknown-may-exist",
          lateResultPolicy: "quarantine-and-reject",
          publicationPolicy: "forbidden",
        },
      },
    });
    await expect(readStudioImagegenCallIntentByRun(fixture.root, crashRunId))
      .resolves.toMatchObject({ callId: abandonedCallId, status: "owner-abandoned", callAllowed: false });
    expect((await readStudioGenerationRunEventHistory(fixture.root, crashRunId)).map((event) => event.kind))
      .toEqual(["dispatched", "cancel-requested", "cancelled"]);

    const secondOperation = await executeIdempotentCommand(
      fixture.root,
      envelope("owner-abandon-replay-0002", abandonRequest),
    );
    expect(secondOperation).toMatchObject({
      status: "succeeded",
      result: { eventId: (recoveredAbandon.result as { eventId: string }).eventId, kind: "cancelled" },
    });
    await expect(executeIdempotentCommand(fixture.root, envelope("owner-abandon-drift-0002", {
      ...abandonRequest,
      payload: { ...abandonRequest.payload, reason: "改变后的理由不得覆盖已落账的 owner abandon 事实。" },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", code: "call-intent-conflict" },
    });

    // 第三个 run 已完成唯一一次模型调用并写入授权 quarantine；随后仅本地源码/构建身份变化。
    // rebind 只能让同一 candidate 在当前 token 下写回，永不返回 callAllowed=true。
    // 门禁适配：不能再用 retryStudioGenerationPlanNodes 派生第三个 run——retry 会给
    // crashRunId 追加 retry-superseded 事件，使其按"在途/superseded 且无 Review"重新占槽；
    // crashRunId 无结果行、无法提交 Review，第三个 run 的 prepare 会被"尚待人工验收"永久拦截。
    // crashRunId 已经 owner-abandon 终态闭合且无完整结果对，改为直接按 plan 推导 runId
    // （attempt:1）派发：门禁按"终态放槽"放行，与门禁新合同一致。
    const rebindPlan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: unit.unit.id }],
      sourceCommandRequestId: "context-rebind-command-bus-plan-0003",
    });
    const rebindRunId = `${rebindPlan.planId}:node:1:attempt:1`;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: rebindRunId,
      provider: "codex",
    });
    const rebindPrepareRequest = {
      command: "prepare_studio_imagegen_call" as const,
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: rebindRunId,
        provider: "codex" as const,
        projectContextToken: context.projectContextToken,
        expectedRevision: 0 as const,
      },
    };
    const rebindPreparedCommand = await executeIdempotentCommand(
      fixture.root,
      envelope("prepare-context-rebind-0003", rebindPrepareRequest),
    );
    const rebindPrepared = rebindPreparedCommand.result as {
      callId: string;
      inputFingerprint: string;
      createdAt: string;
      quarantine: { candidatePath: string; receiptPath: string };
    };
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#30485c" } })
      .png({ compressionLevel: 0 })
      .toFile(rebindPrepared.quarantine.candidatePath);
    const originalRebindCandidateBytes = await readFile(rebindPrepared.quarantine.candidatePath);
    const rebindCandidateSha256 = createHash("sha256")
      .update(originalRebindCandidateBytes)
      .digest("hex");
    const rebindStartedAt = new Date(Date.parse(rebindPrepared.createdAt) + 1_000).toISOString();
    const rebindGeneratedAt = new Date(Date.parse(rebindPrepared.createdAt) + 2_000).toISOString();
    const rebindAuditReceipt = {
      schemaVersion: 1,
      kind: "agent-imagegen-execution-receipt",
      provider: "codex",
      source: "codex-imagegen",
      attestationLevel: "agent-session-direct",
      cryptographicProviderReceipt: false,
      callId: rebindPrepared.callId,
      model: "built-in image_gen",
      agentSessionId: "context-rebind-command-bus-test",
      toolName: "image_gen",
      toolInvocationCount: 1,
      inputFingerprint: rebindPrepared.inputFingerprint,
      candidateSha256: rebindCandidateSha256,
      startedAt: rebindStartedAt,
      generatedAt: rebindGeneratedAt,
    };
    await writeFile(
      rebindPrepared.quarantine.receiptPath,
      `${JSON.stringify(rebindAuditReceipt, null, 2)}\n`,
    );
    const rebindReceiptSha256 = createHash("sha256")
      .update(await readFile(rebindPrepared.quarantine.receiptPath))
      .digest("hex");

    await writeFile(
      path.join(identityWorkspace, "src", "mcp", "server.ts"),
      "server.registerTool(\"fixture\", {}, () => ({}));\n// source digest changed after imagegen invocation\n",
    );
    const reboundContext = await getActiveManagedStudioContext();
    expect(reboundContext.projectContextToken).not.toBe(context.projectContextToken);

    const baseCodexReceipt = {
      schemaVersion: 1 as const,
      kind: "agent-imagegen-execution-receipt" as const,
      provider: "codex" as const,
      source: "codex-imagegen" as const,
      attestationLevel: "agent-session-direct" as const,
      cryptographicProviderReceipt: false as const,
      callId: rebindPrepared.callId,
      model: "built-in image_gen",
      generatedAt: rebindGeneratedAt,
    };
    const commitReboundRequest = {
      command: "commit_agent_imagegen_result_bundle" as const,
      payload: {
        projectContextToken: reboundContext.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: rebindRunId,
        provider: "codex" as const,
        rawPath: rebindPrepared.quarantine.candidatePath,
        rawSha256: rebindCandidateSha256,
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: baseCodexReceipt,
      },
    };
    await expect(executeIdempotentCommand(
      fixture.root,
      envelope("commit-before-context-rebind-0003", commitReboundRequest),
    )).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "call-intent-conflict" },
    });

    const rebindRequest = {
      command: "rebind_studio_imagegen_call_context" as const,
      payload: {
        callId: rebindPrepared.callId,
        generationRunId: rebindRunId,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        inputFingerprint: rebindPrepared.inputFingerprint,
        candidateSha256: rebindCandidateSha256,
        receiptSha256: rebindReceiptSha256,
        projectContextToken: reboundContext.projectContextToken,
        evidenceReference: "user-context-rebind-authority-20260723",
        evidenceFingerprint: "5".repeat(64),
        reason: "唯一模型调用已完成，仅本地源码与构建身份随后变化，授权同一候选写回且禁止第二次调用。",
        acknowledgeBuildChangedAfterInvocation: true as const,
        acknowledgeNoSecondModelCall: true as const,
        expectedRevision: 0 as const,
      },
    };
    const rebindEnvelope = envelope("context-rebind-crash-0003", rebindRequest);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = rebindRequest.command;
    try {
      await expect(executeIdempotentCommand(fixture.root, rebindEnvelope)).rejects.toThrow("执行结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    const recoveredRebind = await reconcileCommand(fixture.root, { idempotencyKey: rebindEnvelope.idempotencyKey });
    expect(recoveredRebind).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        callId: rebindPrepared.callId,
        generationRunId: rebindRunId,
        candidateSha256: rebindCandidateSha256,
        receiptSha256: rebindReceiptSha256,
        callAllowed: false,
        idempotentReplay: true,
        reconciled: true,
      },
    });
    await expect(readStudioImagegenCallIntentByRun(fixture.root, rebindRunId)).resolves.toMatchObject({
      callId: rebindPrepared.callId,
      status: "generation_unknown",
      callAllowed: false,
    });
    await expect(executeIdempotentCommand(fixture.root, envelope("not-invoked-after-context-rebind-0003", {
      command: "reconcile_studio_imagegen_call",
      payload: {
        callId: rebindPrepared.callId,
        projectContextToken: reboundContext.projectContextToken,
        result: "not-invoked",
        evidenceReference: "forbidden-not-invoked-after-context-rebind",
        evidenceFingerprint: "6".repeat(64),
        note: "context-token-expired-recovery: candidate/receipt 已存在时仍必须拒绝 not-invoked",
        expectedRevision: 0,
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", code: "call-intent-conflict" },
    });
    await expect(executeIdempotentCommand(fixture.root, envelope("owner-abandon-after-context-rebind-0003", {
      command: "abandon_studio_generation_unknown",
      payload: {
        callId: rebindPrepared.callId,
        generationRunId: rebindRunId,
        projectContextToken: reboundContext.projectContextToken,
        evidenceReference: "forbidden-owner-abandon-after-context-rebind",
        evidenceFingerprint: "7".repeat(64),
        reason: "已有候选和回执，不得封存后开启第二次模型调用。",
        acknowledgeRemoteMayExist: true,
        acknowledgeLateResultWillBeRejected: true,
        expectedRevision: 0,
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", code: "call-intent-conflict" },
    });
    for (const [index, request] of [
      {
        command: "fail_studio_generation_run" as const,
        payload: { generationRunId: rebindRunId, errorClass: "must-not-unlock-retry" },
      },
      {
        command: "cancel_studio_generation_run" as const,
        payload: { generationRunId: rebindRunId, reason: "must-not-unlock-retry" },
      },
      {
        command: "retry_studio_generation_plan_nodes" as const,
        payload: { planId: rebindPlan.planId, nodeIndexes: [1] },
      },
    ].entries()) {
      await expect(executeIdempotentCommand(
        fixture.root,
        envelope(`context-rebind-no-unlock-${index}`, request),
      )).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { code: "generation-unknown" },
      });
    }
    await expect(getStudioGenerationPlanProjection(fixture.root, rebindPlan.planId)).resolves.toMatchObject({
      nodes: [{ generationRunId: rebindRunId, attempt: 1, status: "dispatched" }],
    });

    const originalRebindReceiptBytes = await readFile(rebindPrepared.quarantine.receiptPath);
    await rm(rebindPrepared.quarantine.receiptPath);
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-context-rebind-receipt-missing-0003", {
      ...commitReboundRequest,
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { code: "receipt-drift" },
    });
    await writeFile(rebindPrepared.quarantine.receiptPath, originalRebindReceiptBytes);
    await writeFile(rebindPrepared.quarantine.receiptPath, `${JSON.stringify({
      ...rebindAuditReceipt,
      agentSessionId: "context-rebind-command-bus-test-tampered",
    }, null, 2)}\n`);
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-context-rebind-receipt-extra-drift-0003", {
      ...commitReboundRequest,
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { code: "receipt-drift" },
    });
    await writeFile(rebindPrepared.quarantine.receiptPath, originalRebindReceiptBytes);

    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#6d3f31" } })
      .png({ compressionLevel: 0 })
      .toFile(rebindPrepared.quarantine.candidatePath);
    const replacedCandidateSha256 = createHash("sha256")
      .update(await readFile(rebindPrepared.quarantine.candidatePath))
      .digest("hex");
    expect(replacedCandidateSha256).not.toBe(rebindCandidateSha256);
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-context-rebind-path-replaced-0003", {
      ...commitReboundRequest,
      payload: { ...commitReboundRequest.payload, rawSha256: replacedCandidateSha256 },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { code: "receipt-drift" },
    });
    await writeFile(rebindPrepared.quarantine.candidatePath, originalRebindCandidateBytes);
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-context-rebind-candidate-drift-0003", {
      ...commitReboundRequest,
      payload: { ...commitReboundRequest.payload, rawSha256: "8".repeat(64) },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "raw-sha-mismatch" },
    });
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-context-rebind-receipt-drift-0003", {
      ...commitReboundRequest,
      payload: {
        ...commitReboundRequest.payload,
        executionReceipt: { ...baseCodexReceipt, model: "different-model" },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "receipt-drift" },
    });

    // 同一 quarantine 在正式写回前再经历一次构建身份轮换。第二环 from 必须指向
    // 第一环 to；崩溃恢复只能依赖完整连续链与 latest.to，不能把 latest.from
    // 错当成原始 call token。
    await writeFile(
      path.join(identityWorkspace, "src", "mcp", "server.ts"),
      "server.registerTool(\"fixture\", {}, () => ({}));\n// second source digest rotation before result commit\n",
    );
    const twiceRotatedContext = await getActiveManagedStudioContext();
    expect(twiceRotatedContext.projectContextToken).not.toBe(reboundContext.projectContextToken);
    const secondRebindRequest = {
      ...rebindRequest,
      payload: {
        ...rebindRequest.payload,
        projectContextToken: twiceRotatedContext.projectContextToken,
        evidenceReference: "user-context-rebind-authority-second-rotation-20260723",
        evidenceFingerprint: "9".repeat(64),
        reason: "唯一候选仍保持密封，第二次构建身份轮换只追加连续 rebind，继续禁止第二次模型调用。",
      },
    };
    const secondRebind = await executeIdempotentCommand(
      fixture.root,
      envelope("context-rebind-second-before-commit-0003", secondRebindRequest),
    );
    expect(secondRebind).toMatchObject({
      status: "succeeded",
      result: {
        callId: rebindPrepared.callId,
        generationRunId: rebindRunId,
        toContextTokenHash: expect.any(String),
        callAllowed: false,
      },
    });
    expect((secondRebind.result as { fromContextTokenHash: string }).fromContextTokenHash)
      .toBe((recoveredRebind.result as { toContextTokenHash: string }).toContextTokenHash);

    const commitTwiceReboundRequest = {
      ...commitReboundRequest,
      payload: {
        ...commitReboundRequest.payload,
        projectContextToken: twiceRotatedContext.projectContextToken,
      },
    };
    const commitReboundEnvelope = envelope("commit-context-rebind-crash-0003", commitTwiceReboundRequest);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = commitTwiceReboundRequest.command;
    try {
      await expect(executeIdempotentCommand(fixture.root, commitReboundEnvelope)).rejects.toThrow("执行结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
    }
    const recoveredCommit = await reconcileCommand(fixture.root, {
      idempotencyKey: commitReboundEnvelope.idempotencyKey,
    });
    expect(recoveredCommit).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        generationRunId: rebindRunId,
        results: { pairComplete: true },
        review: { status: "pending", autoApproved: false },
      },
    });
    const postCommitRebindReplay = await executeIdempotentCommand(
      fixture.root,
      envelope("context-rebind-after-commit-replay-0003", secondRebindRequest),
    );
    expect(postCommitRebindReplay).toMatchObject({
      status: "succeeded",
      result: {
        eventId: (secondRebind.result as { eventId: string }).eventId,
        callAllowed: false,
        idempotentReplay: true,
      },
    });

    await writeFile(
      path.join(identityWorkspace, "src", "mcp", "server.ts"),
      "server.registerTool(\"fixture\", {}, () => ({}));\n// third source digest rotation\n",
    );
    const thirdRotatedContext = await getActiveManagedStudioContext();
    expect(thirdRotatedContext.projectContextToken).not.toBe(twiceRotatedContext.projectContextToken);
    await expect(executeIdempotentCommand(fixture.root, envelope("context-rebind-third-token-rotation-0003", {
      ...rebindRequest,
      payload: { ...rebindRequest.payload, projectContextToken: thirdRotatedContext.projectContextToken },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", code: "call-intent-conflict" },
    });
  }, 120_000);
});
