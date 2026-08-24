import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  freezeAndPersistStudioUnitGridGenerationPack,
  readStudioDetachedGenerationUnknownDispositionByIdentityReadOnly,
  readStudioImagegenCallEventByIdentityReadOnly,
  recordStudioDetachedGenerationUnknownObservation,
} from "../src/core/studio-generation-ledger.js";
import { __setBeforeGenerationWritableOpenHookForTests } from "../src/core/studio-generation-ledger-storage.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7UserContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalCrashAfterExecute = process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
let fixture: StudioP7Fixture | undefined;
let registryParent: string | undefined;

function envelope(index: string, request: IdempotentCommandInput["request"]): IdempotentCommandInput {
  return {
    requestId: `strict-generation-recovery-request-${index}`,
    idempotencyKey: `strict-generation-recovery-key-${index}`,
    request,
  };
}

async function generationTree(projectRoot: string): Promise<string[]> {
  const root = path.join(projectRoot, ".aicanvas");
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        if (relative === "studio-generation" || relative.startsWith(`studio-generation${path.sep}`)) {
          result.push(`d:${relative}`);
          await walk(absolute);
        }
      } else if (relative.startsWith("studio-generation-ledger.sqlite")
        || relative.startsWith(`studio-generation${path.sep}`)) {
        const bytes = await readFile(absolute);
        result.push(`f:${relative}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  await walk(root);
  return result.sort();
}

afterEach(async () => {
  __setBeforeGenerationWritableOpenHookForTests(null);
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalCrashAfterExecute === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = originalCrashAfterExecute;
  if (fixture) await fixture.cleanup();
  if (registryParent) await rm(registryParent, { recursive: true, force: true });
  fixture = undefined;
  registryParent = undefined;
});

describe.sequential("Studio generation reconcile strict recovery", () => {
  it("以 v7 只读快照恢复 reconcile 与 detached disposition，账本仅保留 canonical locator", async () => {
    registryParent = path.join("/tmp", `ai-canvas-strict-generation-recovery-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    fixture = await createStudioP7Fixture();
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
      continuationWaiver: await studioP7UserContinuationWaiver(fixture.root, unit, "fixture:strict-generation-recovery"),
    });
    const generationRunId = "strict-generation-reconcile-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();
    const prepared = await executeIdempotentCommand(fixture.root, envelope("prepare", {
      command: "prepare_studio_imagegen_call",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        expectedRevision: 0,
      },
    }));
    const callId = (prepared.result as { callId: string }).callId;
    const reconcileEvidence = "sensitive-reconcile-evidence-must-not-persist";
    const reconcileNote = "sensitive reconcile note must not persist";
    const reconcileRequest = {
      command: "reconcile_studio_imagegen_call" as const,
      payload: {
        callId,
        projectContextToken: context.projectContextToken,
        result: "not-invoked" as const,
        evidenceReference: reconcileEvidence,
        evidenceFingerprint: "4".repeat(64),
        note: reconcileNote,
        expectedRevision: 0 as const,
      },
    };
    const reconcileEnvelope = envelope("reconcile-crash", reconcileRequest);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = reconcileRequest.command;
    await expect(executeIdempotentCommand(fixture.root, reconcileEnvelope)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;

    const reconcileUnknown = (await listCommandLedger(fixture.root))
      .find((entry) => entry.idempotencyKey === reconcileEnvelope.idempotencyKey);
    expect(reconcileUnknown).toMatchObject({ status: "unknown", durableReconciliation: undefined });
    expect(JSON.stringify(reconcileUnknown)).not.toContain(context.projectContextToken);
    expect(JSON.stringify(reconcileUnknown)).not.toContain(reconcileEvidence);
    expect(JSON.stringify(reconcileUnknown)).not.toContain(reconcileNote);
    const recoveredReconcile = await reconcileCommand(fixture.root, { idempotencyKey: reconcileEnvelope.idempotencyKey });
    expect(recoveredReconcile).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: { callId, generationRunId, kind: "not-invoked", reconciled: true },
    });
    const recoveredEvent = recoveredReconcile.result as { eventId: string };

    const detachedUnit = fixture.units.sixPanel;
    const observation = await recordStudioDetachedGenerationUnknownObservation(fixture.root, {
      unitId: detachedUnit.unit.id,
      unitRevision: detachedUnit.unit.revision,
      unitFingerprint: detachedUnit.fingerprint,
      sourceTaskId: "strict-detached-source-0001",
      evidenceReference: "sensitive-detached-observation-evidence",
      evidenceFingerprint: "5".repeat(64),
      candidateSha256: "6".repeat(64),
      candidateSizeBytes: 4096,
      candidateWidth: 720,
      candidateHeight: 1280,
      note: "sensitive detached observation note",
    });
    const authorizationText = "用户确认远端生成可能存在，旧候选永久隔离，并授权建立新的正式生成任务。";
    const authorizationTextSha256 = createHash("sha256").update(authorizationText, "utf8").digest("hex");
    const detachedEvidence = "sensitive-detached-authorization-evidence";
    const detachedReason = "用户确认承担重复调用风险，旧候选不导入也不复用，只允许新的正式任务。";
    const detachedRequest = {
      command: "abandon_studio_detached_generation_unknown" as const,
      payload: {
        observationId: observation.observationId,
        expectedObservationFingerprint: observation.fingerprint,
        projectContextToken: context.projectContextToken,
        authorizationEvidenceReference: detachedEvidence,
        authorizationText,
        authorizationTextSha256,
        reason: detachedReason,
        acknowledgeRemoteGenerationMayExist: true as const,
        acknowledgeDetachedCandidateWillNeverBeImportedOrReused: true as const,
        acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: true as const,
        expectedRevision: 0 as const,
      },
    };
    const detachedEnvelope = envelope("detached-crash", detachedRequest);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = detachedRequest.command;
    await expect(executeIdempotentCommand(fixture.root, detachedEnvelope)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;

    const detachedUnknown = (await listCommandLedger(fixture.root))
      .find((entry) => entry.idempotencyKey === detachedEnvelope.idempotencyKey);
    expect(detachedUnknown).toMatchObject({ status: "unknown", durableReconciliation: undefined });
    for (const sensitive of [context.projectContextToken, authorizationText, detachedEvidence, detachedReason]) {
      expect(JSON.stringify(detachedUnknown)).not.toContain(sensitive);
    }
    const recoveredDetached = await reconcileCommand(fixture.root, { idempotencyKey: detachedEnvelope.idempotencyKey });
    expect(recoveredDetached).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        observationId: observation.observationId,
        status: "owner-abandoned",
        detachedCandidatePolicy: "never-import-or-reuse",
        nextRunPolicy: "fresh-formal-run-only",
        reconciled: true,
      },
    });
    const recoveredDisposition = recoveredDetached.result as { dispositionId: string };

    const ledger = await listCommandLedger(fixture.root);
    const persistedReconcile = ledger.find((entry) => entry.idempotencyKey === reconcileEnvelope.idempotencyKey)!;
    const persistedDetached = ledger.find((entry) => entry.idempotencyKey === detachedEnvelope.idempotencyKey)!;
    expect(persistedReconcile).toMatchObject({
      status: "succeeded",
      result: {
        kind: "studio-operation-result-locator",
        operation: "imagegen-call-reconcile",
        operationId: persistedReconcile.requestHash,
        eventId: recoveredEvent.eventId,
      },
    });
    expect(persistedDetached).toMatchObject({
      status: "succeeded",
      result: {
        kind: "studio-operation-result-locator",
        operation: "detached-generation-abandon",
        operationId: persistedDetached.requestHash,
        dispositionId: recoveredDisposition.dispositionId,
      },
    });
    const persistedJson = JSON.stringify([persistedReconcile, persistedDetached]);
    for (const sensitive of [
      context.projectContextToken, reconcileEvidence, reconcileNote,
      authorizationText, detachedEvidence, detachedReason,
    ]) expect(persistedJson).not.toContain(sensitive);

    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const owner = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect((owner.prepare("SELECT COUNT(*) AS count FROM studio_generation_call_events WHERE event_id = ?")
        .get(recoveredEvent.eventId) as { count: number }).count).toBe(1);
      expect((owner.prepare("SELECT COUNT(*) AS count FROM studio_generation_detached_unknown_dispositions WHERE disposition_id = ?")
        .get(recoveredDisposition.dispositionId) as { count: number }).count).toBe(1);
    } finally {
      owner.close();
    }

    let writableOpenCount = 0;
    __setBeforeGenerationWritableOpenHookForTests(() => { writableOpenCount += 1; });
    const treeBefore = await generationTree(fixture.root);
    await expect(readStudioImagegenCallEventByIdentityReadOnly(fixture.root, {
      eventId: recoveredEvent.eventId,
      callId,
      generationRunId,
    })).resolves.toMatchObject({ eventId: recoveredEvent.eventId });
    await expect(readStudioDetachedGenerationUnknownDispositionByIdentityReadOnly(fixture.root, {
      observationId: observation.observationId,
      dispositionId: recoveredDisposition.dispositionId,
    })).resolves.toMatchObject({ dispositionId: recoveredDisposition.dispositionId });
    expect(writableOpenCount).toBe(0);
    expect(await generationTree(fixture.root)).toEqual(treeBefore);
    __setBeforeGenerationWritableOpenHookForTests(null);

    const replay = await executeIdempotentCommand(fixture.root, {
      ...detachedEnvelope,
      requestId: "strict-generation-recovery-request-detached-replay",
    });
    expect(replay).toMatchObject({
      replayed: true,
      result: {
        kind: "studio-detached-generation-unknown-disposition",
        dispositionId: recoveredDisposition.dispositionId,
        reconciled: true,
      },
    });

    const commandLedger = new DatabaseSync(path.join(fixture.root, ".aicanvas", "command-ledger.sqlite"));
    try {
      const row = commandLedger.prepare("SELECT payload_json FROM command_ledger_entries WHERE idempotency_key = ?")
        .get(reconcileEnvelope.idempotencyKey) as { payload_json: string };
      const tampered = JSON.parse(row.payload_json) as { result: Record<string, unknown> };
      tampered.result.eventId = `studio-generation-call-event-${"f".repeat(40)}`;
      commandLedger.prepare("UPDATE command_ledger_entries SET payload_json = ? WHERE idempotency_key = ?")
        .run(JSON.stringify(tampered), reconcileEnvelope.idempotencyKey);
    } finally {
      commandLedger.close();
    }
    await expect(executeIdempotentCommand(fixture.root, {
      ...reconcileEnvelope,
      requestId: "strict-generation-recovery-request-reconcile-tamper",
    })).rejects.toThrow(/摘要|冲突|locator|回执/u);
  }, 120_000);
});
