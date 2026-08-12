import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import {
  getActiveManagedStudioContext,
} from "../src/core/active-managed-studio-context.js";
import {
  commitAgentImagegenResultBundle,
  proveAgentImagegenResultBundleOutcome,
  validateStudioRawAspectRatio,
} from "../src/core/studio-agent-imagegen-result-bundle.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  readStudioGenerationResultBundle,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { listStudioGenerationReviewHistory, submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  registerProject,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";
import {
  authorizeStudioHiggsfieldConnectorRequest,
  claimStudioHiggsfieldConnectorRequest,
  enqueueStudioHiggsfieldConnectorRequest,
  preflightStudioHiggsfieldConnectorRequest,
  reconcileStudioHiggsfieldConnectorRequest,
  recordStudioHiggsfieldConnectorSubmission,
} from "../src/core/studio-higgsfield-connector-queue.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  if (fixture) await fixture.cleanup();
  fixture = undefined;
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Agent imagegen RAW 画幅合同", () => {
  it("分别接受 9:16 竖屏与约 21:9 宽银幕，并拒绝交叉画幅", () => {
    expect(validateStudioRawAspectRatio(90, 160, "9:16-vertical").valid).toBe(true);
    expect(validateStudioRawAspectRatio(1919, 820, "cinematic-wide").valid).toBe(true);
    expect(validateStudioRawAspectRatio(1919, 820, "9:16-vertical").valid).toBe(false);
    expect(validateStudioRawAspectRatio(90, 160, "cinematic-wide").valid).toBe(false);
  });
});

function envelope(index: string, request: IdempotentCommandInput["request"]): IdempotentCommandInput {
  return {
    requestId: `bundle-request-${index}`,
    idempotencyKey: `bundle-idempotency-${index}`,
    request,
  };
}

describe.sequential("Agent imagegen v4 原子结果 bundle", () => {
  it.each([
    "writeback-root",
    "writeback-run",
    "writeback-temp",
    "receipt-root",
    "receipt-prefix",
    "receipt-temp",
  ] as const)("%s symlink 不得造成工程外写入；已废弃 temp 路径不再参与写入", async (target) => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    process.env.AI_CANVAS_REGISTRY_PATH = path.join("/tmp", `ai-canvas-bundle-confinement-${target}-${process.pid}-${Date.now()}`, "projects.json");
    fixture = await createStudioP7Fixture();
    process.env.AI_CANVAS_WORKSPACE = path.resolve(".");
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);
    const unit = fixture.units.twoPanel;
    const panel = unit.panels[0]!;
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const generationRunId = `bundle-confinement-${target}`;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();
    const rawPath = path.join(fixture.root, "fixture-inputs", `${generationRunId}.png`);
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#30465c" } }).png().toFile(rawPath);
    const rawSha256 = sha256(await readFile(rawPath));
    const outside = path.join(fixture.parentRoot, `outside-${target}`);
    await mkdir(outside);
    const writebackRoot = path.join(fixture.root, ".aicanvas", "studio-generation", "writebacks");
    const receiptRoot = path.join(fixture.root, ".aicanvas", "studio-generation", "writeback-receipts", "sha256");
    if (target === "writeback-root") {
      await mkdir(path.dirname(writebackRoot), { recursive: true });
      await symlink(outside, writebackRoot, "dir");
    } else if (target === "writeback-run") {
      await mkdir(writebackRoot, { recursive: true });
      await symlink(outside, path.join(writebackRoot, generationRunId), "dir");
    } else if (target === "writeback-temp") {
      await mkdir(writebackRoot, { recursive: true });
      await symlink(outside, path.join(writebackRoot, ".tmp"), "dir");
    } else if (target === "receipt-root") {
      await mkdir(path.dirname(receiptRoot), { recursive: true });
      await symlink(outside, receiptRoot, "dir");
    } else if (target === "receipt-prefix") {
      await mkdir(receiptRoot, { recursive: true });
      for (let value = 0; value < 256; value += 1) {
        await symlink(outside, path.join(receiptRoot, value.toString(16).padStart(2, "0")), "dir");
      }
    } else {
      await mkdir(receiptRoot, { recursive: true });
      await symlink(outside, path.join(receiptRoot, ".tmp"), "dir");
    }

    const committed = commitAgentImagegenResultBundle(fixture.root, {
      projectContextToken: context.projectContextToken,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
      rawPath,
      rawSha256,
      expectedRevision: frozen.pack.target.unitRevision,
      executionReceipt: {
        schemaVersion: 1,
        kind: "agent-imagegen-execution-receipt",
        provider: "codex",
        source: "fixture-canary",
        attestationLevel: "unverified-external-agent",
        cryptographicProviderReceipt: false,
        callId: `bundle-confinement-call-${target}`,
        model: "fixture-imagegen",
        generatedAt: "2026-07-22T12:00:00.000Z",
      },
    });
    if (target === "writeback-temp" || target === "receipt-temp") {
      await expect(committed).resolves.toMatchObject({ generationRunId, provider: "codex" });
      expect(await readStudioGenerationResultBundle(fixture.root, generationRunId)).not.toBeNull();
    } else {
      await expect(committed).rejects.toMatchObject({ code: "storage-unsafe" });
      expect(await readStudioGenerationResultBundle(fixture.root, generationRunId)).toBeNull();
    }
    expect(await readdir(outside)).toEqual([]);
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH), { recursive: true, force: true });
  }, 60_000);

  it("remote_succeeded 在 direct 与 command bundle 写回前拒绝，且不新增 ledger、labeled、CAS 或 receipt", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    process.env.AI_CANVAS_REGISTRY_PATH = path.join("/tmp", `ai-canvas-bundle-connector-gate-${process.pid}-${Date.now()}`, "projects.json");
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
    const panel = unit.panels[0]!;
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
    const generationRunId = "bundle-remote-succeeded-direct-command";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();
    const connector = await enqueueStudioHiggsfieldConnectorRequest(fixture.root, { kind: "image", imageGenerationRunId: generationRunId });
    const claim = await claimStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: connector.requestId,
      claimantId: "bundle-direct-command-gate",
      expectedRevision: connector.revision,
    });
    const observation = {
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
      requestBindingFingerprint: connector.requestBindingFingerprint,
      targetProfileFingerprint: connector.targetProfileFingerprint,
      workspaceSubjectHash: "b".repeat(64),
    };
    const ready = await preflightStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: connector.requestId,
      claimToken: claim.claimToken,
      expectedRevision: claim.revision,
      observation,
    });
    const authorized = await authorizeStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: connector.requestId,
      claimToken: claim.claimToken,
      expectedRevision: ready.revision,
      projectContextToken: context.projectContextToken,
    });
    const receipt = {
      schemaVersion: 1,
      requestBindingFingerprint: connector.requestBindingFingerprint,
      workspaceSubjectHash: observation.workspaceSubjectHash,
      billingMode: "unlimited" as const,
      estimatedCredits: 0 as const,
    };
    const submitted = await recordStudioHiggsfieldConnectorSubmission(fixture.root, {
      requestId: connector.requestId,
      claimToken: claim.claimToken,
      expectedRevision: authorized.revision,
      submissionNonce: authorized.submissionNonce,
      remoteJobId: "bundle-direct-command-gate-remote",
      zeroCreditReceipt: {
        ...receipt,
        receiptFingerprint: sha256(Buffer.from(JSON.stringify(receipt), "utf8")),
      },
    });
    await reconcileStudioHiggsfieldConnectorRequest(fixture.root, {
      requestId: connector.requestId,
      expectedRevision: submitted.revision,
      resolution: "remote_succeeded",
      remoteJobId: "bundle-direct-command-gate-remote",
      evidenceFingerprint: "a".repeat(64),
    });

    const rawPath = path.join(fixture.root, "fixture-inputs", `${generationRunId}.png`);
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#25384f" } }).png().toFile(rawPath);
    const rawSha256 = sha256(await readFile(rawPath));
    const payload = {
      projectContextToken: context.projectContextToken,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex" as const,
      rawPath,
      rawSha256,
      expectedRevision: frozen.pack.target.unitRevision,
      executionReceipt: {
        schemaVersion: 1 as const,
        kind: "agent-imagegen-execution-receipt" as const,
        provider: "codex" as const,
        source: "fixture-canary" as const,
        attestationLevel: "unverified-external-agent" as const,
        cryptographicProviderReceipt: false as const,
        callId: "bundle-direct-command-gate-call",
        model: "fixture-imagegen",
        generatedAt: "2026-08-11T00:00:00.000Z",
      },
    };
    await expect(commitAgentImagegenResultBundle(fixture.root, payload)).rejects.toThrow(/Higgsfield connector|绑定/u);
    await expect(executeIdempotentCommand(fixture.root, envelope("remote-succeeded-bundle-gate", {
      command: "commit_agent_imagegen_result_bundle",
      payload,
    }))).rejects.toThrow(/Higgsfield connector|绑定/u);

    await expect(readStudioGenerationResultBundle(fixture.root, generationRunId)).resolves.toBeNull();
    await expect(readdir(path.join(fixture.root, ".aicanvas", "studio-generation", "writebacks"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(fixture.root, ".aicanvas", "studio-generation", "writeback-receipts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(fixture.root, ".aicanvas", "objects", "sha256", rawSha256.slice(0, 2), rawSha256))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("token/provider/pack 完整核验，本地派生 labeled，原子成对登记并从崩溃点幂等恢复", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    // fixture 创建前将共享注册表隔离，禁止污染真实桌面活动工程。
    process.env.AI_CANVAS_REGISTRY_PATH = path.join("/tmp", `ai-canvas-bundle-registry-${process.pid}-${Date.now()}`, "projects.json");
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
    const panel = unit.panels[0]!;
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
    const secondPanel = unit.panels[1]!;
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: secondPanel.id,
      assetIds: secondPanel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    // P21 panel 互斥归因：invalidRatio 用例改走第二宫格的独立 pack（同 panel 多 in-flight 由 panel-run-in-flight 拒绝）。
    const frozenPanel2 = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: secondPanel.id,
    });
    const generationRunId = "bundle-codex-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const context = await getActiveManagedStudioContext();

    const rawPath = path.join(fixture.root, "fixture-inputs", "bundle-codex-run-0001_raw.png");
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#25384f" } })
      .png({ compressionLevel: 0 })
      .toFile(rawPath);
    const rawSha256 = sha256(await readFile(rawPath));
    const basePayload = {
      projectContextToken: context.projectContextToken,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      rawPath,
      rawSha256,
      expectedRevision: frozen.pack.target.unitRevision,
    };

    const invalidRatioRunId = "bundle-invalid-ratio-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozenPanel2.packId,
      packFingerprint: frozenPanel2.fingerprint,
      generationRunId: invalidRatioRunId,
      provider: "codex",
    });
    const invalidRatioPath = path.join(fixture.root, "fixture-inputs", "bundle-invalid-ratio_raw.png");
    await sharp({ create: { width: 90, height: 120, channels: 3, background: "#4c3825" } }).png().toFile(invalidRatioPath);
    await expect(executeIdempotentCommand(fixture.root, envelope("invalid-ratio", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        ...basePayload,
        packId: frozenPanel2.packId,
        packFingerprint: frozenPanel2.fingerprint,
        expectedRevision: frozenPanel2.pack.target.unitRevision,
        generationRunId: invalidRatioRunId,
        provider: "codex",
        rawPath: invalidRatioPath,
        rawSha256: sha256(await readFile(invalidRatioPath)),
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "codex",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: "codex-invalid-ratio-call-0001",
          model: "fixture-imagegen",
          generatedAt: "2026-07-18T08:00:30.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "raw-aspect-ratio-invalid" },
    });
    expect(await readStudioGenerationResultBundle(fixture.root, invalidRatioRunId)).toBeNull();

    await expect(executeIdempotentCommand(fixture.root, envelope("provider-mismatch", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        ...basePayload,
        provider: "grok",
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "grok",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: "grok-mismatched-call-0001",
          model: "grok-imagine",
          generatedAt: "2026-07-18T08:00:00.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "provider-mismatch" },
    });
    expect(await readStudioGenerationResultBundle(fixture.root, generationRunId)).toBeNull();

    const request = {
      command: "commit_agent_imagegen_result_bundle" as const,
      payload: {
        ...basePayload,
        provider: "codex" as const,
        executionReceipt: {
          schemaVersion: 1 as const,
          kind: "agent-imagegen-execution-receipt" as const,
          provider: "codex" as const,
          source: "fixture-canary" as const,
          attestationLevel: "unverified-external-agent" as const,
          cryptographicProviderReceipt: false as const,
          callId: "codex-fixture-call-0001",
          model: "fixture-imagegen",
          generatedAt: "2026-07-18T08:01:00.000Z",
        },
      },
    };
    const crashing = envelope("atomic-crash", request);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = request.command;
    await expect(executeIdempotentCommand(fixture.root, crashing)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;

    const recovered = await executeIdempotentCommand(fixture.root, {
      ...crashing,
      requestId: "bundle-request-atomic-crash-retry",
    });
    expect(recovered).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        schemaVersion: 4,
        kind: "studio-agent-imagegen-result-bundle-outcome",
        projectId: fixture.shell.project.id,
        generationRunId,
        provider: "codex",
        media: {
          raw: { sha256: rawSha256, width: 90, height: 160 },
          labeled: { width: 90, height: 160 },
        },
        results: {
          schemaVersion: 4,
          pairComplete: true,
          raw: { variant: "raw", status: "pending", pairComplete: true },
          labeled: { variant: "labeled", status: "pending", pairComplete: true },
        },
        review: { status: "pending", autoApproved: false },
        reconciled: true,
      },
    });
    expect((recovered.result as { media: { labeled: { sha256: string } } }).media.labeled.sha256).not.toBe(rawSha256);
    expect(JSON.stringify(recovered.result)).not.toContain("rawPath");
    expect(JSON.stringify(recovered.result)).not.toContain("objectPath");
    expect(JSON.stringify(recovered.result)).not.toContain("projectContextToken");

    const domainRetry = await executeIdempotentCommand(fixture.root, envelope("domain-retry", request));
    expect(domainRetry).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        generationRunId,
        results: {
          raw: { resultId: (recovered.result as { results: { raw: { resultId: string } } }).results.raw.resultId },
          labeled: { resultId: (recovered.result as { results: { labeled: { resultId: string } } }).results.labeled.resultId },
        },
      },
    });
    const receiptRoot = path.join(fixture.root, ".aicanvas", "studio-generation", "writeback-receipts", "sha256");
    const receiptPrefixes = (await readdir(receiptRoot)).filter((name) => name !== ".tmp");
    expect(receiptPrefixes).toHaveLength(1);
    const receiptDirectory = path.join(receiptRoot, receiptPrefixes[0]!);
    const receiptFiles = (await readdir(receiptDirectory)).filter((name) => name.endsWith(".json"));
    expect(receiptFiles).toHaveLength(1);
    const receiptPath = path.join(receiptDirectory, receiptFiles[0]!);
    const receiptBytes = await readFile(receiptPath);
    const outsideReceipt = path.join(fixture.parentRoot, "outside-receipt.json");
    await writeFile(outsideReceipt, receiptBytes);
    await rm(receiptPath);
    await symlink(outsideReceipt, receiptPath, "file");
    expect(await proveAgentImagegenResultBundleOutcome(fixture.root, request.payload)).toBeNull();
    expect(await readFile(outsideReceipt)).toEqual(receiptBytes);
    await rm(receiptRoot, { recursive: true, force: true });
    expect(await proveAgentImagegenResultBundleOutcome(fixture.root, request.payload)).toBeNull();
    await expect(readdir(receiptRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listStudioGenerationReviewHistory(fixture.root, { generationRunId, limit: 10 })).items).toEqual([]);

    // 门禁适配：同槽已有完整 raw+labeled 对，另开 legacyRunId 前必须先为该对提交 Review。
    const recoveredPair = recovered.result as {
      results: { raw: { resultId: string }; labeled: { resultId: string } };
      media: { labeled: { sha256: string } };
    };
    await submitStudioGenerationReview(fixture.root, {
      operationId: "bundle-review-run-0001",
      generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: recoveredPair.results.raw.resultId,
      rawSha256,
      labeledResultId: recoveredPair.results.labeled.resultId,
      labeledSha256: recoveredPair.media.labeled.sha256,
      expectedPackFingerprint: frozen.fingerprint,
      continuityFingerprint: frozen.pack.continuity.fingerprint,
      decision: "pass",
      criteria: [{ code: "identity-consistency", status: "pass", note: "崩溃恢复写回的结果对机械验收通过。" }],
      reviewer: "user",
      note: "另开 legacyRunId 用例前对 bundle-codex-run-0001 结果对的机械 Review。",
    });

    const legacyRunId = "bundle-legacy-pair-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: legacyRunId,
      provider: "codex",
    });
    const recoveredResult = recovered.result as {
      media: { labeled: { sha256: string } };
    };
    await registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: legacyRunId,
      provider: "codex",
      variant: "raw",
      mediaSha256: rawSha256,
    });
    await registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: legacyRunId,
      provider: "codex",
      variant: "labeled",
      mediaSha256: recoveredResult.media.labeled.sha256,
    });
    await expect(executeIdempotentCommand(fixture.root, envelope("legacy-pair-no-upgrade", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        ...request.payload,
        generationRunId: legacyRunId,
        executionReceipt: {
          ...request.payload.executionReceipt,
          callId: "codex-legacy-pair-call-0001",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "receipt-drift" },
    });

    await writeFile(
      path.join(identityWorkspace, "src", "mcp", "server.ts"),
      "server.registerTool(\"fixture\", {}, () => ({}));\nserver.registerTool(\"fixture2\", {}, () => ({}));\n",
    );
    await expect(executeIdempotentCommand(fixture.root, envelope("stale-build-token", request)))
      .rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: {
          entityType: "studio_generation_result_bundle",
          reason: "project_context_conflict",
          code: "project-context-token-mismatch",
        },
      });
    const refreshedContext = await getActiveManagedStudioContext();

    const other = await createManagedProject({ parentRoot: fixture.parentRoot, name: "切换后受管工程", slug: "bundle-other" });
    await registerProject(other.project);
    await setActiveProjectRegistration(other.paths.root);
    await expect(executeIdempotentCommand(fixture.root, envelope("stale-context", {
      ...request,
      payload: { ...request.payload, projectContextToken: refreshedContext.projectContextToken },
    })))
      .rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: {
          entityType: "studio_generation_result_bundle",
          reason: "project_context_conflict",
          code: "project-context-token-mismatch",
        },
      });

    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH), { recursive: true, force: true });
  }, 180_000);
});
