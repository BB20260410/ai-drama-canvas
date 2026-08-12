import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setBeforeStudioHiggsfieldAuthorizeTransactionHookForTests,
  assertNoActiveStudioHiggsfieldConnectorReservation,
  authorizeStudioHiggsfieldConnectorRequest,
  claimStudioHiggsfieldConnectorRequest,
  enqueueStudioHiggsfieldConnectorRequest,
  getStudioHiggsfieldConnectorRequest,
  getStudioHiggsfieldConnectorRequestByTarget,
  getStudioHiggsfieldConnectorWorkQueue,
  preflightStudioHiggsfieldConnectorRequest,
  reconcileStudioHiggsfieldConnectorRequest,
  recordStudioHiggsfieldConnectorSubmission,
  setStudioHiggsfieldConnectorNowForTests,
} from "../src/core/studio-higgsfield-connector-queue.js";
import {
  abandonStudioGenerationUnknown,
  cancelStudioGenerationRun,
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  reconcileStudioImagegenCall,
  readStudioGenerationRunEventHistory,
  registerStudioGenerationResult,
  registerStudioGenerationResultBundle,
  retryStudioGenerationPlanNodes,
} from "../src/core/studio-generation-ledger.js";
import { initializeStudioGenerationLedger } from "../src/core/studio-generation-ledger.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7ContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const fixtures: StudioP7Fixture[] = [];
afterEach(async () => {
  setStudioHiggsfieldConnectorNowForTests();
  __setBeforeStudioHiggsfieldAuthorizeTransactionHookForTests(null);
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function formalCodexImageRun(): Promise<{
  root: string;
  fixture: StudioP7Fixture;
  runId: string;
  packId: string;
  packFingerprint: string;
  rawMediaSha256: string;
  labeledMediaSha256: string;
}> {
  const fixture = await createStudioP7Fixture();
  fixtures.push(fixture);
  const unit = fixture.units.twoPanel;
  const panel = unit.panels[0]!;
  await seedStudioP7ResolvedPanelContinuity(fixture.root, {
    unitId: unit.unit.id, panelId: panel.id,
    assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
  });
  const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
  const runId = "higgsfield-queue-codex-run-001";
  await dispatchStudioGenerationPack(fixture.root, { packId: frozen.packId, packFingerprint: frozen.fingerprint, generationRunId: runId, provider: "codex" });
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  return {
    root: fixture.root,
    fixture,
    runId,
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    rawMediaSha256: media.raw.imported.sha256,
    labeledMediaSha256: media.labeled.imported.sha256,
  };
}

async function secondFormalRun(root: string, fixture: StudioP7Fixture, runId: string): Promise<void> {
  const unit = fixture.units.twoPanel;
  const panel = unit.panels[1]!;
  await seedStudioP7ResolvedPanelContinuity(root, {
    unitId: unit.unit.id,
    panelId: panel.id,
    assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
  });
  const frozen = await freezeAndPersistStudioGenerationPack(root, { unitId: unit.unit.id, panelId: panel.id });
  await dispatchStudioGenerationPack(root, { packId: frozen.packId, packFingerprint: frozen.fingerprint, generationRunId: runId, provider: "codex" });
}

async function formalCodexUnitGridDispatchedRun(): Promise<{
  root: string;
  runId: string;
  planId: string;
  packId: string;
  packFingerprint: string;
}> {
  const fixture = await createStudioP7Fixture();
  fixtures.push(fixture);
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
    verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
      fixture.root,
      unit,
      "fixture:higgsfield-owner-abandon-atomicity",
    ),
  });
  const plan = await createStudioGenerationPlan(fixture.root, {
    nodes: [{ targetKind: "unit-grid", unitId: unit.unit.id }],
    sourceCommandRequestId: "higgsfield-owner-atomicity-plan-001",
  });
  const runId = `${plan.planId}:node:1:attempt:1`;
  await dispatchStudioGenerationPack(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId: runId,
    provider: "codex",
  });
  return {
    root: fixture.root,
    runId,
    planId: plan.planId,
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
  };
}

async function formalCodexUnitGridUnknownRun(): Promise<{
  root: string;
  runId: string;
  planId: string;
  callId: string;
  projectContextToken: string;
}> {
  const run = await formalCodexUnitGridDispatchedRun();
  const projectContextToken = "higgsfield-owner-abandon-context";
  const intent = await prepareStudioImagegenCall(run.root, {
    packId: run.packId,
    packFingerprint: run.packFingerprint,
    generationRunId: run.runId,
    provider: "codex",
    projectContextToken,
    commandRequestId: "higgsfield-owner-abandon-prepare-001",
    expectedRevision: 0,
  });
  return { root: run.root, runId: run.runId, planId: run.planId, callId: intent.callId, projectContextToken };
}

async function connectorReadyForAuthorization(root: string, runId: string, claimantId: string) {
  const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
  const claimed = await claimStudioHiggsfieldConnectorRequest(root, {
    requestId: queued.requestId,
    claimantId,
    expectedRevision: queued.revision,
  });
  const ready = await preflightStudioHiggsfieldConnectorRequest(root, {
    requestId: queued.requestId,
    claimToken: claimed.claimToken,
    expectedRevision: claimed.revision,
    observation: observation(queued),
  });
  return { queued, claimed, ready };
}

/** 模拟修复前已持久化的 connector/formal 双 owner 状态，验证所有后续门禁 fail-close。 */
async function forceLegacyConnectorReservation(
  root: string,
  requestId: string,
  status: "authorized" | "succeeded" = "authorized",
): Promise<void> {
  const generation = await initializeStudioGenerationLedger(root);
  const db = new DatabaseSync(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare(`SELECT sequence, revision FROM studio_higgsfield_connector_request_events
      WHERE request_id = ? ORDER BY revision DESC, sequence DESC LIMIT 1`).get(requestId) as {
        sequence: number;
        revision: number;
      } | undefined;
    if (!row) throw new Error(`connector request 不存在：${requestId}`);
    const nextRevision = Number(row.revision) + 1;
    const createdAt = new Date().toISOString();
    const fingerprint = createHash("sha256")
      .update(`legacy-dual-owner:${requestId}:${status}:${nextRevision}`, "utf8")
      .digest("hex");
    db.prepare(`INSERT INTO studio_higgsfield_connector_request_events(
      request_id,request_kind,target_key,request_binding_fingerprint,target_profile_fingerprint,
      image_generation_run_id,intent_id,execution_adapter,revision,status,claimant_id,
      claim_token_hash,preflight_json,preflight_observation_json,blockers_json,submission_nonce_hash,
      remote_job_id,remote_status,reconciliation_evidence_fingerprint,created_at,fingerprint
    ) SELECT
      request_id,request_kind,target_key,request_binding_fingerprint,target_profile_fingerprint,
      image_generation_run_id,intent_id,execution_adapter,?, ?,claimant_id,
      claim_token_hash,preflight_json,preflight_observation_json,blockers_json,submission_nonce_hash,
      remote_job_id,remote_status,reconciliation_evidence_fingerprint,?,?
    FROM studio_higgsfield_connector_request_events WHERE sequence = ?`).run(
      nextRevision,
      status,
      createdAt,
      fingerprint,
      row.sequence,
    );
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function zeroCreditReceipt(request: { requestBindingFingerprint: string }) {
  const body = {
    schemaVersion: 1,
    requestBindingFingerprint: request.requestBindingFingerprint,
    workspaceSubjectHash: "a".repeat(64),
    billingMode: "unlimited" as const,
    estimatedCredits: 0 as const,
  };
  return {
    requestBindingFingerprint: body.requestBindingFingerprint,
    workspaceSubjectHash: body.workspaceSubjectHash,
    billingMode: body.billingMode,
    estimatedCredits: body.estimatedCredits,
    receiptFingerprint: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  };
}

function observation(request: { requestBindingFingerprint: string; targetProfileFingerprint: string }, extra: Record<string, unknown> = {}) {
  return {
    source: "higgsfield-connector" as const,
    observedAt: new Date().toISOString(),
    unlimAvailable: true,
    supportsUnlim: true,
    billingMode: "unlimited" as const,
    zeroCredits: true,
    model: "gpt_image_2",
    mode: "image_generation",
    durationSeconds: 1,
    resolution: "1k",
    adjustments: [],
    requestBindingFingerprint: request.requestBindingFingerprint,
    targetProfileFingerprint: request.targetProfileFingerprint,
    workspaceSubjectHash: "a".repeat(64),
    ...extra,
  };
}

describe("Higgsfield connector 有界请求队列", () => {
  it("旧队列表可无损迁移，缺失绑定指纹的历史请求永远不能通过预检", async () => {
    const fixture = await createStudioP7Fixture();
    fixtures.push(fixture);
    const generation = await initializeStudioGenerationLedger(fixture.root);
    const db = new DatabaseSync(generation.databasePath);
    try {
      db.exec(`CREATE TABLE studio_higgsfield_connector_request_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        target_key TEXT NOT NULL,
        image_generation_run_id TEXT,
        intent_id TEXT,
        execution_adapter TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','blocked_by_provider','claimed','authorized','submitted','submission_unknown','cancelled')),
        claimant_id TEXT,
        claim_token_hash TEXT,
        preflight_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        submission_nonce_hash TEXT,
        remote_job_id TEXT,
        remote_status TEXT,
        created_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        UNIQUE(request_id, revision)
      ) STRICT;`);
      db.prepare(`INSERT INTO studio_higgsfield_connector_request_events(
        request_id,request_kind,target_key,image_generation_run_id,intent_id,execution_adapter,revision,status,
        claimant_id,claim_token_hash,preflight_json,blockers_json,submission_nonce_hash,remote_job_id,remote_status,created_at,fingerprint
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "legacy-higgs-request", "image", "image:legacy-formal-run", "legacy-formal-run", null,
        "higgsfield-connector", 1, "queued", null, null, '{"callAllowed":false,"blockers":[]}', "[]",
        null, null, null, new Date().toISOString(), "b".repeat(64),
      );
    } finally {
      db.close();
    }
    const migrated = await getStudioHiggsfieldConnectorRequest(fixture.root, "legacy-higgs-request");
    expect(migrated?.requestBindingFingerprint).toBe("0".repeat(64));
    expect(migrated?.targetProfileFingerprint).toBe("0".repeat(64));
    const claimed = await claimStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: "legacy-higgs-request", claimantId: "codex-legacy", expectedRevision: 1,
    });
    const blocked = await preflightStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: claimed.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision,
      observation: observation(migrated!),
    });
    expect(blocked.status).toBe("blocked_by_provider");
    expect(blocked.blockers).toContain("legacy-request-binding-untrusted");
  }, 120_000);

  it("只接受真实 Codex formal image run；预检与单次授权绑定同一 request/profile/workspace", async () => {
    const { root, runId } = await formalCodexImageRun();
    await expect(enqueueStudioHiggsfieldConnectorRequest(root, { kind: "video", intentId: "video-intent-missing" })).rejects.toThrow(/schema marker|机械验证/u);
    const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
    expect(queued.status).toBe("queued");
    expect(JSON.stringify(queued)).not.toContain(root);
    const claimed = await claimStudioHiggsfieldConnectorRequest(root, { requestId: queued.requestId, claimantId: "codex-host-001", expectedRevision: queued.revision });
    const ready = await preflightStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision, observation: observation(queued),
    });
    expect(ready.preflight.callAllowed).toBe(true);
    const authorized = await authorizeStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: ready.revision, projectContextToken: `studioctx-v1-${"a".repeat(64)}`,
    });
    expect(authorized.submissionNonce).toMatch(/^higgsnonce-/u);
    await expect(authorizeStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: authorized.revision, projectContextToken: `studioctx-v1-${"a".repeat(64)}`,
    })).rejects.toThrow(/一次/u);
    const queue = await getStudioHiggsfieldConnectorWorkQueue(root, { statuses: ["authorized"] });
    expect(queue.items.map((item) => item.requestId)).toContain(queued.requestId);
    expect(JSON.stringify(queue)).not.toContain("higgsclaim-");
  }, 120_000);

  it("不安全/不匹配预检会被拒绝；缺 zero-credit receipt 或 jobId 一律进入 unknown 且禁止重放", async () => {
    const { root, runId } = await formalCodexImageRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
    const claimed = await claimStudioHiggsfieldConnectorRequest(root, { requestId: queued.requestId, claimantId: "codex-host-002", expectedRevision: queued.revision });
    await expect(preflightStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision,
      observation: observation(queued, { adjustments: ["https://secret.example/token"] }),
    })).rejects.toThrow(/不得含路径/u);
    const ready = await preflightStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision,
      observation: observation(queued, { zeroCredits: false }),
    });
    expect(ready.status).toBe("blocked_by_provider");
    expect(ready.blockers).toContain("provider-cost-not-zero");
  }, 120_000);

  it("binding/profile 不匹配不能授权；提交无回执必须 unknown 且禁止重放", async () => {
    const { root, runId } = await formalCodexImageRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
    const claimed = await claimStudioHiggsfieldConnectorRequest(root, { requestId: queued.requestId, claimantId: "codex-host-003", expectedRevision: queued.revision });
    const mismatch = await preflightStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision,
      observation: observation(queued, { requestBindingFingerprint: "b".repeat(64) }),
    });
    expect(mismatch.status).toBe("blocked_by_provider");
    expect(mismatch.blockers).toContain("provider-request-binding-mismatch");

    // 用另一个真实 formal run 走到提交登记，证明 jobId 不能替代 zero-credit receipt。
    const second = await formalCodexImageRun();
    const queued2 = await enqueueStudioHiggsfieldConnectorRequest(second.root, { kind: "image", imageGenerationRunId: second.runId });
    const claim2 = await claimStudioHiggsfieldConnectorRequest(second.root, { requestId: queued2.requestId, claimantId: "codex-host-004", expectedRevision: queued2.revision });
    const ready2 = await preflightStudioHiggsfieldConnectorRequest(second.root, { requestId: queued2.requestId, claimToken: claim2.claimToken, expectedRevision: claim2.revision, observation: observation(queued2) });
    const authorized2 = await authorizeStudioHiggsfieldConnectorRequest(second.root, { requestId: queued2.requestId, claimToken: claim2.claimToken, expectedRevision: ready2.revision, projectContextToken: `studioctx-v1-${"b".repeat(64)}` });
    const unknown = await recordStudioHiggsfieldConnectorSubmission(second.root, {
      requestId: queued2.requestId, claimToken: claim2.claimToken, expectedRevision: authorized2.revision,
      submissionNonce: authorized2.submissionNonce, remoteJobId: "higgsfield-remote-job-001",
    });
    expect(unknown.status).toBe("submission_unknown");
    expect(unknown.remoteJobId).toBe("higgsfield-remote-job-001");
    await expect(preflightStudioHiggsfieldConnectorRequest(second.root, {
      requestId: queued2.requestId, claimToken: claim2.claimToken, expectedRevision: unknown.revision, observation: observation(queued2),
    })).rejects.toThrow(/unknown/u);
  }, 120_000);

  it("崩溃后的 claim/authorize 租约会有界收口，不会永久占住其他请求", async () => {
    let clock = Date.parse("2026-08-10T00:00:00.000Z");
    setStudioHiggsfieldConnectorNowForTests(() => clock);
    const fixture = await createStudioP7Fixture();
    fixtures.push(fixture);
    const unit = fixture.units.twoPanel;
    const panel = unit.panels[0]!;
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id, panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
    await dispatchStudioGenerationPack(fixture.root, { packId: frozen.packId, packFingerprint: frozen.fingerprint, generationRunId: "higgsfield-lease-run-a", provider: "codex" });
    await secondFormalRun(fixture.root, fixture, "higgsfield-lease-run-b");
    const first = await enqueueStudioHiggsfieldConnectorRequest(fixture.root, { kind: "image", imageGenerationRunId: "higgsfield-lease-run-a" });
    await claimStudioHiggsfieldConnectorRequest(fixture.root, { requestId: first.requestId, claimantId: "codex-crashed-a", expectedRevision: first.revision });
    const second = await enqueueStudioHiggsfieldConnectorRequest(fixture.root, { kind: "image", imageGenerationRunId: "higgsfield-lease-run-b" });
    await expect(claimStudioHiggsfieldConnectorRequest(fixture.root, { requestId: second.requestId, claimantId: "codex-b", expectedRevision: second.revision })).rejects.toThrow(/并发上限/u);

    clock += 5 * 60_000 + 1;
    const claimedSecond = await claimStudioHiggsfieldConnectorRequest(fixture.root, { requestId: second.requestId, claimantId: "codex-b", expectedRevision: second.revision });
    expect(claimedSecond.status).toBe("claimed");
    expect((await getStudioHiggsfieldConnectorRequest(fixture.root, first.requestId))?.status).toBe("queued");
  }, 120_000);

  it("submitted 可落远端终态释放并发；unknown 只能凭人工未提交证据关闭", async () => {
    const fixture = await createStudioP7Fixture();
    fixtures.push(fixture);
    const unit = fixture.units.twoPanel;
    for (const [index, runId] of ["higgsfield-terminal-run-a", "higgsfield-terminal-run-b"].entries()) {
      const panel = unit.panels[index]!;
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id, panelId: panel.id,
        assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
      });
      const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
      await dispatchStudioGenerationPack(fixture.root, { packId: frozen.packId, packFingerprint: frozen.fingerprint, generationRunId: runId, provider: "codex" });
    }
    const first = await enqueueStudioHiggsfieldConnectorRequest(fixture.root, { kind: "image", imageGenerationRunId: "higgsfield-terminal-run-a" });
    const claim = await claimStudioHiggsfieldConnectorRequest(fixture.root, { requestId: first.requestId, claimantId: "codex-terminal", expectedRevision: first.revision });
    const ready = await preflightStudioHiggsfieldConnectorRequest(fixture.root, { requestId: first.requestId, claimToken: claim.claimToken, expectedRevision: claim.revision, observation: observation(first) });
    const authorized = await authorizeStudioHiggsfieldConnectorRequest(fixture.root, { requestId: first.requestId, claimToken: claim.claimToken, expectedRevision: ready.revision, projectContextToken: `studioctx-v1-${"c".repeat(64)}` });
    const submitted = await recordStudioHiggsfieldConnectorSubmission(fixture.root, {
      requestId: first.requestId, claimToken: claim.claimToken, expectedRevision: authorized.revision,
      submissionNonce: authorized.submissionNonce, remoteJobId: "higgsfield-job-terminal-a", zeroCreditReceipt: zeroCreditReceipt(first),
    });
    expect(submitted.status).toBe("submitted");
    const publicSubmitted = (await getStudioHiggsfieldConnectorWorkQueue(fixture.root, { statuses: ["submitted"] })).items[0]!;
    expect(publicSubmitted).toMatchObject({
      status: "submitted",
      evidenceTrust: "legacy_untrusted",
      zeroCreditVerified: false,
      blockers: expect.arrayContaining(["trusted-connector-evidence-unavailable"]),
    });
    const done = await reconcileStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: first.requestId, expectedRevision: submitted.revision, resolution: "remote_succeeded",
      remoteJobId: "higgsfield-job-terminal-a", evidenceFingerprint: "d".repeat(64),
    });
    expect(done.status).toBe("succeeded");
    const publicSucceeded = await getStudioHiggsfieldConnectorRequestByTarget(fixture.root, {
      kind: "image",
      imageGenerationRunId: "higgsfield-terminal-run-a",
    });
    expect(publicSucceeded).toMatchObject({
      status: "succeeded",
      evidenceTrust: "legacy_untrusted",
      zeroCreditVerified: false,
      blockers: expect.arrayContaining(["trusted-connector-evidence-unavailable"]),
    });
    const second = await enqueueStudioHiggsfieldConnectorRequest(fixture.root, { kind: "image", imageGenerationRunId: "higgsfield-terminal-run-b" });
    expect((await claimStudioHiggsfieldConnectorRequest(fixture.root, { requestId: second.requestId, claimantId: "codex-next", expectedRevision: second.revision })).status).toBe("claimed");

    const unknownRoot = await formalCodexImageRun();
    const unknownQueued = await enqueueStudioHiggsfieldConnectorRequest(unknownRoot.root, { kind: "image", imageGenerationRunId: unknownRoot.runId });
    const unknownClaim = await claimStudioHiggsfieldConnectorRequest(unknownRoot.root, { requestId: unknownQueued.requestId, claimantId: "codex-unknown", expectedRevision: unknownQueued.revision });
    const unknownReady = await preflightStudioHiggsfieldConnectorRequest(unknownRoot.root, { requestId: unknownQueued.requestId, claimToken: unknownClaim.claimToken, expectedRevision: unknownClaim.revision, observation: observation(unknownQueued) });
    const unknownAuth = await authorizeStudioHiggsfieldConnectorRequest(unknownRoot.root, { requestId: unknownQueued.requestId, claimToken: unknownClaim.claimToken, expectedRevision: unknownReady.revision, projectContextToken: `studioctx-v1-${"e".repeat(64)}` });
    const unknown = await recordStudioHiggsfieldConnectorSubmission(unknownRoot.root, { requestId: unknownQueued.requestId, claimToken: unknownClaim.claimToken, expectedRevision: unknownAuth.revision, submissionNonce: unknownAuth.submissionNonce, remoteJobId: null });
    await expect(reconcileStudioHiggsfieldConnectorRequest(unknownRoot.root, {
      requestId: unknown.requestId, expectedRevision: unknown.revision, resolution: "not_submitted", evidenceFingerprint: "f".repeat(64),
    })).rejects.toThrow(/明确证明/u);
    expect((await reconcileStudioHiggsfieldConnectorRequest(unknownRoot.root, {
      requestId: unknown.requestId, expectedRevision: unknown.revision, resolution: "not_submitted",
      evidenceFingerprint: "f".repeat(64), confirmNoRemoteSubmission: true,
    })).status).toBe("cancelled");
  }, 120_000);

  it("授权时复验 formal owner；authorized reservation 阻止旁路终态写入", async () => {
    const { root, runId } = await formalCodexImageRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
    const claimed = await claimStudioHiggsfieldConnectorRequest(root, { requestId: queued.requestId, claimantId: "codex-owner", expectedRevision: queued.revision });
    const ready = await preflightStudioHiggsfieldConnectorRequest(root, { requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision, observation: observation(queued) });
    await failStudioGenerationRun(root, { generationRunId: runId, errorClass: "owner-moved" });
    await expect(authorizeStudioHiggsfieldConnectorRequest(root, { requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: ready.revision, projectContextToken: `studioctx-v1-${"1".repeat(64)}` })).rejects.toThrow(/非 dispatched/u);

    const second = await formalCodexImageRun();
    const q2 = await enqueueStudioHiggsfieldConnectorRequest(second.root, { kind: "image", imageGenerationRunId: second.runId });
    const c2 = await claimStudioHiggsfieldConnectorRequest(second.root, { requestId: q2.requestId, claimantId: "codex-reservation", expectedRevision: q2.revision });
    const p2 = await preflightStudioHiggsfieldConnectorRequest(second.root, { requestId: q2.requestId, claimToken: c2.claimToken, expectedRevision: c2.revision, observation: observation(q2) });
    await authorizeStudioHiggsfieldConnectorRequest(second.root, { requestId: q2.requestId, claimToken: c2.claimToken, expectedRevision: p2.revision, projectContextToken: `studioctx-v1-${"2".repeat(64)}` });
    await expect(assertNoActiveStudioHiggsfieldConnectorReservation(second.root, second.runId)).rejects.toThrow(/保留|绑定/u);
  }, 120_000);

  it("authorized reservation 后 formal result/terminal 的四个直接入口必须零写拒绝", async () => {
    const { root, runId, packId, packFingerprint, rawMediaSha256, labeledMediaSha256 } = await formalCodexImageRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
    const claimed = await claimStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimantId: "codex-single-result-race",
      expectedRevision: queued.revision,
    });
    const ready = await preflightStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimToken: claimed.claimToken,
      expectedRevision: claimed.revision,
      observation: observation(queued),
    });
    await authorizeStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimToken: claimed.claimToken,
      expectedRevision: ready.revision,
      projectContextToken: `studioctx-v1-${"3".repeat(64)}`,
    });

    const generation = await initializeStudioGenerationLedger(root);
    const countResults = (): number => {
      const db = new DatabaseSync(generation.databasePath, { readOnly: true });
      try {
        return Number((db.prepare(
          "SELECT COUNT(*) AS count FROM studio_generation_results WHERE generation_run_id = ?",
        ).get(runId) as { count: number }).count);
      } finally {
        db.close();
      }
    };
    const before = countResults();
    let rejected = false;
    try {
      await registerStudioGenerationResult(root, {
        packId,
        packFingerprint,
        generationRunId: runId,
        variant: "raw",
        mediaSha256: rawMediaSha256,
        provider: "codex",
      });
    } catch (error) {
      rejected = /Higgsfield connector|保留|绑定/u.test(error instanceof Error ? error.message : String(error));
    }
    expect({ rejected, before, after: countResults() }).toEqual({ rejected: true, before: 0, after: 0 });
    await expect(registerStudioGenerationResultBundle(root, {
      packId,
      packFingerprint,
      generationRunId: runId,
      provider: "codex",
      rawMediaSha256,
      labeledMediaSha256,
    })).rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    await expect(failStudioGenerationRun(root, {
      generationRunId: runId,
      errorClass: "must-not-bypass-reservation",
    })).rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    await expect(cancelStudioGenerationRun(root, {
      generationRunId: runId,
      reason: "must-not-bypass-reservation",
    })).rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    expect(countResults()).toBe(0);
  }, 120_000);

  it("authorize 的事务外 owner 复验后若 formal terminal 抢先提交，双方不能双赢", async () => {
    const { root, runId } = await formalCodexImageRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(root, { kind: "image", imageGenerationRunId: runId });
    const claimed = await claimStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimantId: "codex-authorize-race",
      expectedRevision: queued.revision,
    });
    const ready = await preflightStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimToken: claimed.claimToken,
      expectedRevision: claimed.revision,
      observation: observation(queued),
    });
    __setBeforeStudioHiggsfieldAuthorizeTransactionHookForTests(async () => {
      await failStudioGenerationRun(root, { generationRunId: runId, errorClass: "terminal-won-race" });
    });

    await expect(authorizeStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimToken: claimed.claimToken,
      expectedRevision: ready.revision,
      projectContextToken: `studioctx-v1-${"4".repeat(64)}`,
    })).rejects.toThrow(/formal run|dispatched/u);
    expect((await getStudioHiggsfieldConnectorRequest(root, queued.requestId))?.status).toBe("claimed");
  }, 120_000);

  it("既有 Codex call intent 阻止 connector authorize", async () => {
    const { root, runId } = await formalCodexUnitGridUnknownRun();
    const { queued, claimed, ready } = await connectorReadyForAuthorization(
      root,
      runId,
      "codex-intent-won",
    );
    await expect(authorizeStudioHiggsfieldConnectorRequest(root, {
      requestId: queued.requestId,
      claimToken: claimed.claimToken,
      expectedRevision: ready.revision,
      projectContextToken: `studioctx-v1-${"5".repeat(64)}`,
    })).rejects.toThrow(/call intent|执行 owner/u);
    expect((await getStudioHiggsfieldConnectorRequest(root, queued.requestId))?.status).toBe("claimed");
  }, 120_000);

  it("authorized connector reservation 阻止首次 Codex call intent", async () => {
    const run = await formalCodexUnitGridDispatchedRun();
    const { queued, claimed, ready } = await connectorReadyForAuthorization(
      run.root,
      run.runId,
      "connector-won",
    );
    await authorizeStudioHiggsfieldConnectorRequest(run.root, {
      requestId: queued.requestId,
      claimToken: claimed.claimToken,
      expectedRevision: ready.revision,
      projectContextToken: `studioctx-v1-${"6".repeat(64)}`,
    });
    await expect(prepareStudioImagegenCall(run.root, {
      packId: run.packId,
      packFingerprint: run.packFingerprint,
      generationRunId: run.runId,
      provider: "codex",
      projectContextToken: "connector-won-context",
      commandRequestId: "connector-won-prepare-001",
      expectedRevision: 0,
    })).rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    const generation = await initializeStudioGenerationLedger(run.root);
    const db = new DatabaseSync(generation.databasePath, { readOnly: true });
    try {
      expect(Number((db.prepare(
        "SELECT COUNT(*) AS count FROM studio_generation_call_intents WHERE generation_run_id = ?",
      ).get(run.runId) as { count: number }).count)).toBe(0);
    } finally {
      db.close();
    }
  }, 120_000);

  it("remote_succeeded 释放全局 connector 槽位，但永久占住同一 formal run 的 prepare/result/terminal", async () => {
    const first = await formalCodexImageRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(first.root, { kind: "image", imageGenerationRunId: first.runId });
    const claimed = await claimStudioHiggsfieldConnectorRequest(first.root, {
      requestId: queued.requestId, claimantId: "codex-remote-succeeded", expectedRevision: queued.revision,
    });
    const ready = await preflightStudioHiggsfieldConnectorRequest(first.root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: claimed.revision, observation: observation(queued),
    });
    const authorized = await authorizeStudioHiggsfieldConnectorRequest(first.root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: ready.revision,
      projectContextToken: `studioctx-v1-${"a".repeat(64)}`,
    });
    const submitted = await recordStudioHiggsfieldConnectorSubmission(first.root, {
      requestId: queued.requestId, claimToken: claimed.claimToken, expectedRevision: authorized.revision,
      submissionNonce: authorized.submissionNonce, remoteJobId: "higgsfield-terminal-succeeded",
      zeroCreditReceipt: zeroCreditReceipt(queued),
    });
    const succeeded = await reconcileStudioHiggsfieldConnectorRequest(first.root, {
      requestId: queued.requestId, expectedRevision: submitted.revision, resolution: "remote_succeeded",
      remoteJobId: "higgsfield-terminal-succeeded", evidenceFingerprint: "a".repeat(64),
    });
    expect(succeeded.status).toBe("succeeded");
    await expect(assertNoActiveStudioHiggsfieldConnectorReservation(first.root, first.runId))
      .rejects.toThrow(/Higgsfield connector|绑定/u);
    // remote terminal 释放项目级单槽，其他 target 仍可领取；仅同一 formal run 被绑定。
    await secondFormalRun(first.root, first.fixture, "higgsfield-remote-succeeded-other-target");
    const otherTarget = await enqueueStudioHiggsfieldConnectorRequest(first.root, {
      kind: "image", imageGenerationRunId: "higgsfield-remote-succeeded-other-target",
    });
    expect((await claimStudioHiggsfieldConnectorRequest(first.root, {
      requestId: otherTarget.requestId, claimantId: "codex-other-target", expectedRevision: otherTarget.revision,
    })).status).toBe("claimed");

    const generation = await initializeStudioGenerationLedger(first.root);
    const counts = (): { intents: number; results: number; runEvents: number } => {
      const db = new DatabaseSync(generation.databasePath, { readOnly: true });
      try {
        return {
          intents: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_generation_call_intents WHERE generation_run_id=?").get(first.runId) as { count: number }).count),
          results: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_generation_results WHERE generation_run_id=?").get(first.runId) as { count: number }).count),
          runEvents: Number((db.prepare("SELECT COUNT(*) AS count FROM studio_generation_run_events WHERE generation_run_id=?").get(first.runId) as { count: number }).count),
        };
      } finally { db.close(); }
    };
    const before = counts();
    const remoteSucceededPrepareCallAllowed = await prepareStudioImagegenCall(first.root, {
      packId: first.packId, packFingerprint: first.packFingerprint, generationRunId: first.runId,
      provider: "codex", projectContextToken: "remote-succeeded-prepare", commandRequestId: "remote-succeeded-prepare-001", expectedRevision: 0,
    }).then((result) => result.callAllowed, (error: unknown) => {
      expect(error).toMatchObject({ code: "run-terminal" });
      return false;
    });
    expect(remoteSucceededPrepareCallAllowed).toBe(false);
    await expect(registerStudioGenerationResult(first.root, {
      packId: first.packId, packFingerprint: first.packFingerprint, generationRunId: first.runId,
      variant: "raw", mediaSha256: first.rawMediaSha256, provider: "codex",
    })).rejects.toThrow(/Higgsfield connector|绑定/u);
    await expect(registerStudioGenerationResultBundle(first.root, {
      packId: first.packId, packFingerprint: first.packFingerprint, generationRunId: first.runId, provider: "codex",
      rawMediaSha256: first.rawMediaSha256, labeledMediaSha256: first.labeledMediaSha256,
    })).rejects.toThrow(/Higgsfield connector|绑定/u);
    await expect(failStudioGenerationRun(first.root, { generationRunId: first.runId, errorClass: "remote-succeeded-no-bypass" })).rejects.toThrow(/Higgsfield connector|绑定/u);
    await expect(cancelStudioGenerationRun(first.root, { generationRunId: first.runId, reason: "remote-succeeded-no-bypass" })).rejects.toThrow(/Higgsfield connector|绑定/u);
    expect(counts()).toEqual(before);
  }, 120_000);

  it("legacy remote_succeeded 双 owner 下 abandon/not-invoked 均零写拒绝", async () => {
    const { root, runId, callId, projectContextToken } = await formalCodexUnitGridUnknownRun();
    const { queued } = await connectorReadyForAuthorization(root, runId, "legacy-terminal-guard");
    await forceLegacyConnectorReservation(root, queued.requestId, "succeeded");

    const countCancelEvents = async (): Promise<number> => (await readStudioGenerationRunEventHistory(root, runId))
      .filter((event) => event.kind === "cancel-requested" || event.kind === "cancelled").length;
    await expect(abandonStudioGenerationUnknown(root, {
      callId,
      generationRunId: runId,
      projectContextToken: `studioctx-v1-${"7".repeat(64)}`,
      evidenceReference: "higgsfield-owner-abandon-atomicity-evidence",
      evidenceFingerprint: "8".repeat(64),
      reason: "Higgsfield reservation 存在时禁止 owner abandon 终态写入。",
      acknowledgeRemoteMayExist: true,
      acknowledgeLateResultWillBeRejected: true,
    })).rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    await expect(reconcileStudioImagegenCall(root, {
      callId,
      projectContextToken,
      result: "not-invoked",
      evidenceReference: "higgsfield-not-invoked-atomicity-evidence",
      evidenceFingerprint: "9".repeat(64),
      note: "legacy dual owner must fail closed",
    })).rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    const generation = await initializeStudioGenerationLedger(root);
    const db = new DatabaseSync(generation.databasePath, { readOnly: true });
    try {
      expect(Number((db.prepare(
        "SELECT COUNT(*) AS count FROM studio_generation_call_events WHERE generation_run_id = ?",
      ).get(runId) as { count: number }).count)).toBe(0);
    } finally {
      db.close();
    }
    expect(await countCancelEvents()).toBe(0);
  }, 120_000);

  it("legacy remote_succeeded connector 阻止 retry-superseded 与新 attempt", async () => {
    const run = await formalCodexUnitGridDispatchedRun();
    const queued = await enqueueStudioHiggsfieldConnectorRequest(run.root, { kind: "image", imageGenerationRunId: run.runId });
    await failStudioGenerationRun(run.root, {
      generationRunId: run.runId,
      errorClass: "legacy-terminal-before-authorize",
    });
    await forceLegacyConnectorReservation(run.root, queued.requestId, "succeeded");
    const before = await readStudioGenerationRunEventHistory(run.root, run.runId);
    await expect(retryStudioGenerationPlanNodes(run.root, { planId: run.planId }))
      .rejects.toThrow(/Higgsfield connector|保留|绑定/u);
    expect(await readStudioGenerationRunEventHistory(run.root, run.runId)).toEqual(before);
  }, 120_000);
});
