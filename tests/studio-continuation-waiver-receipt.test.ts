import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  __setBeforeImagegenIntentTransactionHookForTests,
  authorizeStudioUnitGridContinuationWaiver,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  readStudioImagegenCallIntentByRun,
  registerStudioVerifiedHistoricalImportContinuationWaiver,
} from "../src/core/studio-generation-ledger.js";
import {
  buildStudioUnitGridGenerationFreezePack,
} from "../src/core/studio-unit-grid-generation.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
let fixture: StudioP7Fixture | undefined;
let registryParent: string | undefined;

afterEach(async () => {
  __setBeforeImagegenIntentTransactionHookForTests(null);
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  await fixture?.cleanup();
  if (registryParent) await rm(registryParent, { recursive: true, force: true });
  fixture = undefined;
  registryParent = undefined;
});

describe.sequential("unit-grid continuation waiver authorization receipt", () => {
  it("拒绝自由文本自证；只接受绑定前后单元与活动上下文的 append-only receipt", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    registryParent = path.join("/tmp", `ai-canvas-waiver-receipt-${process.pid}-${Date.now()}`);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const identityWorkspace = path.join(registryParent, "stable-build-identity");
    const identityFile = path.join(identityWorkspace, "src", "mcp", "server.ts");
    const identitySource = "server.registerTool(\"fixture\", {}, () => ({}));\n";
    await mkdir(path.dirname(identityFile), { recursive: true });
    await Promise.all([
      writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
      writeFile(identityFile, identitySource),
    ]);
    process.env.AI_CANVAS_WORKSPACE = identityWorkspace;
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);

    await expect(buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      continuationWaiver: {
        reason: "调用方自由填写的理由不能再自证授权。",
        auditIdentity: "legacy-free-text-self-attestation",
      },
    } as never)).rejects.toMatchObject({ code: "previous-raw-invalid" });

    const context = await getActiveManagedStudioContext();
    const authorizationText = "我确认上一镜没有可用 actual-tail，并接受从锁定参考重新起拍的连续性风险。";
    const authorizationTextSha256 = createHash("sha256")
      .update(authorizationText, "utf8")
      .digest("hex");
    await expect(authorizeStudioUnitGridContinuationWaiver(fixture.root, {
      unitId: fixture.units.twoPanel.unit.id,
      expectedUnitRevision: fixture.units.twoPanel.unit.revision,
      projectContextToken: context.projectContextToken,
      authorizationEvidenceReference: "user-confirmation:test-waiver-receipt",
      authorizationText,
      authorizationTextSha256,
      reason: "测试显式授权 receipt 的风险确认门。",
      acknowledgePreviousActualTailUnavailable: true,
      acknowledgeCanonicalRestartMayBreakContinuity: false,
      acknowledgeIdentityAndSceneLocksRemainMandatory: true,
    } as never)).rejects.toMatchObject({ code: "invalid-input" });

    const receipt = await authorizeStudioUnitGridContinuationWaiver(fixture.root, {
      unitId: fixture.units.twoPanel.unit.id,
      expectedUnitRevision: fixture.units.twoPanel.unit.revision,
      projectContextToken: context.projectContextToken,
      authorizationEvidenceReference: "user-confirmation:test-waiver-receipt",
      authorizationText,
      authorizationTextSha256,
      reason: "测试显式授权 receipt 的风险确认门。",
      acknowledgePreviousActualTailUnavailable: true,
      acknowledgeCanonicalRestartMayBreakContinuity: true,
      acknowledgeIdentityAndSceneLocksRemainMandatory: true,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      authorityKind: "user-authorization",
      projectId: fixture.shell.project.id,
      currentUnitId: fixture.units.twoPanel.unit.id,
      previousUnitId: fixture.units.sixPanel.unit.id,
      activeContext: {
        contextTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });

    await writeFile(identityFile, `${identitySource}// build identity drift\n`);
    await expect(buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      continuationWaiver: {
        receiptId: receipt.receiptId,
        receiptFingerprint: receipt.fingerprint,
      },
    })).rejects.toMatchObject({ code: "previous-raw-invalid" });
    await writeFile(identityFile, identitySource);

    const pack = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      continuationWaiver: {
        receiptId: receipt.receiptId,
        receiptFingerprint: receipt.fingerprint,
      },
    });
    expect(pack.pack.continuationWaiver).toEqual(receipt);
  }, 180_000);

  it("verified historical import 使用独立分型 receipt，不能冒充用户授权", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const receipt = await registerStudioVerifiedHistoricalImportContinuationWaiver(fixture.root, {
      unitId: fixture.units.twoPanel.unit.id,
      expectedUnitRevision: fixture.units.twoPanel.unit.revision,
      sourceManifestFingerprint: "a".repeat(64),
      authorizationEvidenceReference: "fixture:verified-historical-import",
      mode: "test-fixture",
    });
    await expect(buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      continuationWaiver: {
        receiptId: receipt.receiptId,
        receiptFingerprint: receipt.fingerprint,
      },
    })).rejects.toMatchObject({ code: "previous-raw-invalid" });
    const pack = await buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      verifiedHistoricalImportContinuationWaiver: {
        receiptId: receipt.receiptId,
        receiptFingerprint: receipt.fingerprint,
      },
    });
    expect(pack.continuationWaiver).toMatchObject({
      authorityKind: "verified-historical-import",
      sourceManifestFingerprint: "a".repeat(64),
    });
    const persisted = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      verifiedHistoricalImportContinuationWaiver: {
        receiptId: receipt.receiptId,
        receiptFingerprint: receipt.fingerprint,
      },
    });
    const generationRunId = "waiver-final-cas-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: persisted.packId,
      packFingerprint: persisted.fingerprint,
      generationRunId,
      provider: "codex",
    });
    __setBeforeImagegenIntentTransactionHookForTests(() => {
      const db = new DatabaseSync(path.join(
        fixture!.root,
        ".aicanvas",
        "studio-generation-ledger.sqlite",
      ));
      try {
        db.exec("DROP TRIGGER studio_generation_continuation_waiver_no_update");
        db.prepare(`
          UPDATE studio_generation_continuation_waiver_receipts
          SET reason = ?
          WHERE receipt_id = ?
        `).run("事务前被篡改的历史豁免理由必须在 paid-call 最后一跳被拒绝。", receipt.receiptId);
      } finally {
        db.close();
      }
    });
    await expect(prepareStudioImagegenCall(fixture.root, {
      packId: persisted.packId,
      packFingerprint: persisted.fingerprint,
      generationRunId,
      provider: "codex",
      projectContextToken: `studioctx-v1-${"b".repeat(64)}`,
      commandRequestId: "waiver-final-cas-command-0001",
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: "storage-invalid" });
    await expect(readStudioImagegenCallIntentByRun(fixture.root, generationRunId))
      .resolves.toBeNull();
  }, 180_000);
});
