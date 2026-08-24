import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  __commandRequestHashForTests,
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import {
  getActiveManagedStudioContext,
} from "../src/core/active-managed-studio-context.js";
import {
  commitAgentImagegenResultBundle,
  proveAgentImagegenResultBundleOutcome,
  proveAgentImagegenResultBundleOutcomeByLocator,
  StudioAgentImagegenBundleError,
  validateStudioRawAspectRatio,
} from "../src/core/studio-agent-imagegen-result-bundle.js";
import { getCommandLedgerEntryByIdempotencyKey, upsertCommandLedgerEntry } from "../src/core/command-ledger-store.js";
import { __setBeforeGenerationWritableOpenHookForTests } from "../src/core/studio-generation-ledger-storage.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  readStudioGenerationResultBundle,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { listStudioGenerationReviewHistory, submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  appendEvent,
  findEventsByIdempotencyKey,
  registerProject,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";
import { commandTerminalJsonDigest } from "../src/core/command-terminal-receipt.js";
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
  delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE;
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_SAFE_CHECKPOINT;
  delete process.env.AI_CANVAS_TEST_COMMAND_PAUSE_AFTER_SAFE_CHECKPOINT;
  delete process.env.AI_CANVAS_TEST_COMMAND_PAUSE_AFTER_SAFE_CHECKPOINT_MS;
  __setBeforeGenerationWritableOpenHookForTests(null);
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

function stableTestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableTestValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableTestValue(entry)]));
}

function stableTestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableTestValue(value)), "utf8").digest("hex");
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
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === crashing.idempotencyKey))
      .toMatchObject({ status: "unknown" });

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
    const recoveredLedger = (await listCommandLedger(fixture.root))
      .find((entry) => entry.idempotencyKey === crashing.idempotencyKey);
    expect(recoveredLedger).toMatchObject({
      status: "succeeded",
      result: {
        schemaVersion: 1,
        kind: "studio-agent-imagegen-result-bundle-locator",
        generationRunId,
        results: {
          rawResultId: (recovered.result as { results: { raw: { resultId: string } } }).results.raw.resultId,
          labeledResultId: (recovered.result as { results: { labeled: { resultId: string } } }).results.labeled.resultId,
        },
      },
    });
    expect(recoveredLedger).not.toHaveProperty("durableReconciliation");
    const serializedLedger = JSON.stringify(recoveredLedger);
    for (const forbidden of [
      basePayload.rawPath,
      basePayload.projectContextToken,
      "executionReceiptPath",
      request.payload.executionReceipt.model,
      "agentSessionId",
      "toolCallId",
    ]) expect(serializedLedger).not.toContain(forbidden);
    const terminalReplay = await executeIdempotentCommand(fixture.root, {
      ...crashing,
      requestId: "bundle-request-atomic-crash-terminal-replay",
    });
    expect(terminalReplay).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId,
        reconciled: true,
      },
    });
    const ownerAfterReplay = await readStudioGenerationResultBundle(fixture.root, generationRunId);
    expect(ownerAfterReplay).toMatchObject({
      raw: { resultId: (recovered.result as { results: { raw: { resultId: string } } }).results.raw.resultId },
      labeled: { resultId: (recovered.result as { results: { labeled: { resultId: string } } }).results.labeled.resultId },
    });

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
    await expect(proveAgentImagegenResultBundleOutcome(fixture.root, request.payload)).rejects.toMatchObject({
      name: "StudioAgentImagegenBundleError",
      code: "storage-unsafe",
    });
    expect(await readFile(outsideReceipt)).toEqual(receiptBytes);
    await rm(receiptRoot, { recursive: true, force: true });
    await expect(proveAgentImagegenResultBundleOutcome(fixture.root, request.payload)).rejects.toMatchObject({
      name: "StudioAgentImagegenBundleError",
      code: "receipt-drift",
    });
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


function materialCasPath(root: string, sha: string): string {
  return path.join(root, ".aicanvas", "objects", "sha256", sha.slice(0, 2), sha);
}

async function prepareDispatchedBundleCommit(label: string): Promise<{
  request: Extract<IdempotentCommandInput["request"], { command: "commit_agent_imagegen_result_bundle" }>;
  generationRunId: string;
  rawSha256: string;
}> {
  delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  process.env.AI_CANVAS_REGISTRY_PATH = path.join("/tmp", `ai-canvas-bundle-${label}-${process.pid}-${Date.now()}`, "projects.json");
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
  const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
  });
  const generationRunId = `bundle-${label}-run`;
  await dispatchStudioGenerationPack(fixture.root, {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const context = await getActiveManagedStudioContext();
  const rawPath = path.join(fixture.root, "fixture-inputs", `${generationRunId}.png`);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await sharp({ create: { width: 90, height: 160, channels: 3, background: "#25384f" } }).png().toFile(rawPath);
  const rawSha256 = sha256(await readFile(rawPath));
  return {
    generationRunId,
    rawSha256,
    request: {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
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
          callId: "codex-fixture-call-0001",
          model: "fixture-imagegen",
          generatedAt: "2026-07-18T08:01:00.000Z",
        },
      },
    },
  };
}

describe.sequential("Agent imagegen result bundle 公开重放与瞬态恢复", () => {
  it("尚未提交时只读 proof 返回 null，不把缺失当成成功", async () => {
    const prepared = await prepareDispatchedBundleCommit("not-committed");
    expect(await proveAgentImagegenResultBundleOutcome(fixture!.root, prepared.request.payload)).toBeNull();
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("same-key 成功重放返回完整不可变结果，账本只存安全 locator", async () => {
    const prepared = await prepareDispatchedBundleCommit("same-key");
    const first = envelope("same-key", prepared.request);
    const committed = await executeIdempotentCommand(fixture!.root, first);
    expect(committed).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
      },
    });
    const replayed = await executeIdempotentCommand(fixture!.root, {
      ...first,
      requestId: "bundle-request-same-key-replay",
    });
    expect(replayed).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
        reconciled: true,
        results: {
          raw: { resultId: (committed.result as { results: { raw: { resultId: string } } }).results.raw.resultId },
          labeled: { resultId: (committed.result as { results: { labeled: { resultId: string } } }).results.labeled.resultId },
        },
      },
    });
    const stored = (await listCommandLedger(fixture!.root)).find((entry) => entry.idempotencyKey === first.idempotencyKey);
    expect(stored).toMatchObject({
      status: "succeeded",
      result: { kind: "studio-agent-imagegen-result-bundle-locator", generationRunId: prepared.generationRunId },
    });
    expect(JSON.stringify(stored)).not.toContain(prepared.request.payload.rawPath);
    expect(JSON.stringify(stored)).not.toContain(prepared.request.payload.projectContextToken);
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("safe checkpoint 落盘后 terminal 前异常：账本只留 locator，direct/same-key 纯读恢复 full", async () => {
    const prepared = await prepareDispatchedBundleCommit("safe-checkpoint-deterministic");
    const input = envelope("safe-checkpoint-deterministic", prepared.request);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_SAFE_CHECKPOINT = prepared.request.command;
    await expect(executeIdempotentCommand(fixture!.root, input)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_SAFE_CHECKPOINT;

    const ownerBefore = await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId);
    expect(ownerBefore).not.toBeNull();
    const rawStored = await getCommandLedgerEntryByIdempotencyKey(fixture!.root, input.idempotencyKey);
    expect(rawStored).toMatchObject({
      status: "unknown",
      execution: { phase: "side_effect_committed" },
      result: {
        kind: "studio-agent-imagegen-result-bundle-locator",
        writebackReceiptStorageKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(rawStored).not.toHaveProperty("durableReconciliation");
    const serialized = JSON.stringify(rawStored);
    for (const forbidden of [
      prepared.request.payload.projectContextToken,
      prepared.request.payload.rawPath,
      prepared.request.payload.executionReceipt.model,
      prepared.request.payload.executionReceipt.callId,
    ]) expect(serialized).not.toContain(forbidden);
    expect((await findEventsByIdempotencyKey(fixture!.root, input.idempotencyKey, 20))
      .filter((event) => event.type === "command.side-effect-committed")).toHaveLength(0);

    const reconciled = await reconcileCommand(fixture!.root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
        reconciled: true,
      },
    });
    const replayed = await executeIdempotentCommand(fixture!.root, {
      ...input,
      requestId: "bundle-request-safe-checkpoint-deterministic-replay",
    });
    expect(replayed).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
        reconciled: true,
      },
    });
    expect(await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId)).toEqual(ownerBefore);
    expect((await listCommandLedger(fixture!.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
      .toMatchObject({ status: "succeeded", result: { kind: "studio-agent-imagegen-result-bundle-locator" } });
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("真实硬崩溃窗：子进程安全落账后 terminal 前 SIGKILL，无请求扫描即恢复 full", async () => {
    const prepared = await prepareDispatchedBundleCommit("safe-checkpoint-sigkill");
    const input = envelope("safe-checkpoint-sigkill", prepared.request);
    const workerSource = `
      import { executeIdempotentCommand } from "./src/core/command-bus.ts";
      const root = process.env.AI_CANVAS_TEST_BUNDLE_ROOT;
      const input = JSON.parse(process.env.AI_CANVAS_TEST_BUNDLE_INPUT);
      await executeIdempotentCommand(root, input);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", workerSource], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        AI_CANVAS_TEST_BUNDLE_ROOT: fixture!.root,
        AI_CANVAS_TEST_BUNDLE_INPUT: JSON.stringify(input),
        AI_CANVAS_TEST_COMMAND_PAUSE_AFTER_SAFE_CHECKPOINT: prepared.request.command,
        AI_CANVAS_TEST_COMMAND_PAUSE_AFTER_SAFE_CHECKPOINT_MS: "30000",
      },
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      const deadline = Date.now() + 20_000;
      let rawStored = null;
      while (Date.now() < deadline) {
        const candidate = await getCommandLedgerEntryByIdempotencyKey(fixture!.root, input.idempotencyKey);
        rawStored = candidate;
        if ((candidate?.execution as { phase?: string } | undefined)?.phase === "side_effect_committed"
          && (candidate?.result as { kind?: string } | undefined)?.kind === "studio-agent-imagegen-result-bundle-locator") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!rawStored) throw new Error("safe checkpoint 未在有界时间内落盘。");
      expect(rawStored).toMatchObject({
        status: "running",
        execution: { pid: child.pid, phase: "side_effect_committed" },
        result: { kind: "studio-agent-imagegen-result-bundle-locator" },
      });
      expect(rawStored).not.toHaveProperty("durableReconciliation");
      const serialized = JSON.stringify(rawStored);
      for (const forbidden of [
        prepared.request.payload.projectContextToken,
        prepared.request.payload.rawPath,
        prepared.request.payload.executionReceipt.model,
        prepared.request.payload.executionReceipt.callId,
      ]) expect(serialized).not.toContain(forbidden);
      expect((await findEventsByIdempotencyKey(fixture!.root, input.idempotencyKey, 20))
        .filter((event) => event.type === "command.side-effect-committed")).toHaveLength(0);

      const ownerBefore = await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId);
      expect(ownerBefore).not.toBeNull();
      expect(child.kill("SIGKILL")).toBe(true);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      let generationWritableOpens = 0;
      __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
      let recovered;
      try {
        recovered = await reconcileCommand(fixture!.root, { idempotencyKey: input.idempotencyKey });
      } finally {
        __setBeforeGenerationWritableOpenHookForTests(null);
      }
      expect(generationWritableOpens).toBe(0);
      expect(recovered).toMatchObject({
        status: "succeeded",
        result: {
          kind: "studio-agent-imagegen-result-bundle-outcome",
          generationRunId: prepared.generationRunId,
          reconciled: true,
        },
      });
      expect(await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId)).toEqual(ownerBefore);
      await expect(executeIdempotentCommand(fixture!.root, {
        ...input,
        requestId: "bundle-request-safe-checkpoint-sigkill-replay",
      })).resolves.toMatchObject({
        status: "succeeded",
        replayed: true,
        result: { kind: "studio-agent-imagegen-result-bundle-outcome", generationRunId: prepared.generationRunId },
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 180_000);

  it("storageKey 定点 proof 严拒 tamper/extra；旧 locator 仅原 request 重放兼容，direct reconcile 失败关闭", async () => {
    const prepared = await prepareDispatchedBundleCommit("locator-boundary");
    const first = envelope("locator-boundary", prepared.request);
    const committed = await executeIdempotentCommand(fixture!.root, first);
    const stored = (await listCommandLedger(fixture!.root))
      .find((entry) => entry.idempotencyKey === first.idempotencyKey)!;
    const locator = stored.result as Record<string, unknown>;
    expect(locator).toMatchObject({
      kind: "studio-agent-imagegen-result-bundle-locator",
      writebackReceiptStorageKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(proveAgentImagegenResultBundleOutcomeByLocator(fixture!.root, locator)).resolves.toMatchObject({
      kind: "studio-agent-imagegen-result-bundle-outcome",
      generationRunId: prepared.generationRunId,
      writebackReceiptStorageKey: locator.writebackReceiptStorageKey,
    });
    await expect(proveAgentImagegenResultBundleOutcomeByLocator(fixture!.root, {
      ...locator,
      writebackReceiptStorageKey: "f".repeat(64),
    })).rejects.toMatchObject({ code: "receipt-drift" });
    await expect(proveAgentImagegenResultBundleOutcomeByLocator(fixture!.root, {
      ...locator,
      writebackReceiptFingerprint: "e".repeat(64),
    })).rejects.toMatchObject({ code: "receipt-drift" });
    await expect(proveAgentImagegenResultBundleOutcomeByLocator(fixture!.root, {
      ...locator,
      rawPath: prepared.request.payload.rawPath,
    })).rejects.toMatchObject({ code: "receipt-drift" });

    const full = committed.result as Record<string, unknown>;
    const legacyBody = Object.fromEntries(Object.entries(full)
      .filter(([key]) => key !== "fingerprint" && key !== "writebackReceiptStorageKey"));
    const { writebackReceiptStorageKey: _removed, ...legacyLocator } = locator;
    legacyLocator.outcomeFingerprint = stableTestDigest(legacyBody);
    const legacyDirectKey = "bundle-idempotency-locator-boundary-legacy-direct";
    const legacyRequestId = "bundle-request-locator-boundary-legacy-direct";
    await upsertCommandLedgerEntry(fixture!.root, {
      ...stored,
      requestId: legacyRequestId,
      idempotencyKey: legacyDirectKey,
      result: legacyLocator,
    });
    await appendEvent(fixture!.root, {
      actor: "codex",
      type: "command.side-effect-committed",
      requestId: legacyRequestId,
      idempotencyKey: legacyDirectKey,
      command: prepared.request.command,
      data: {
        requestHash: stored.requestHash,
        command: prepared.request.command,
        resultDigest: commandTerminalJsonDigest(legacyLocator),
        result: legacyLocator,
        projectRoot: fixture!.root,
        outcomeStatus: "succeeded",
      },
    });
    const legacySameKey = await executeIdempotentCommand(fixture!.root, {
      idempotencyKey: legacyDirectKey,
      requestId: "bundle-request-locator-boundary-legacy-replay",
      request: prepared.request,
    });
    expect(legacySameKey).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
      },
    });

    await expect(reconcileCommand(fixture!.root, { idempotencyKey: legacyDirectKey }))
      .rejects.toThrow(/缺少 writebackReceiptStorageKey|禁止扫描/u);
    expect(await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId)).toMatchObject({
      raw: { resultId: (full.results as { raw: { resultId: string } }).raw.resultId },
      labeled: { resultId: (full.results as { labeled: { resultId: string } }).labeled.resultId },
    });
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("BUSY_AFTER_EXECUTE wait 窗口同键对账成功，且不重做 labeled/register", async () => {
    const prepared = await prepareDispatchedBundleCommit("wait-busy");
    const input = envelope("wait-busy", prepared.request);
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE = prepared.request.command;
    await expect(executeIdempotentCommand(fixture!.root, input)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE;
    expect((await listCommandLedger(fixture!.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
      .toMatchObject({ status: "unknown" });
    const owner = await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId);
    expect(owner).not.toBeNull();
    const labeledPath = materialCasPath(fixture!.root, owner!.labeled.mediaSha256);
    const before = await lstat(labeledPath);
    const recovered = await executeIdempotentCommand(fixture!.root, {
      ...input,
      requestId: "bundle-request-wait-busy-retry",
    });
    expect(recovered).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
        reconciled: true,
        results: {
          raw: { resultId: owner!.raw.resultId },
          labeled: { resultId: owner!.labeled.resultId },
        },
      },
    });
    const after = await lstat(labeledPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId)).toMatchObject({
      raw: { resultId: owner!.raw.resultId },
      labeled: { resultId: owner!.labeled.resultId },
    });
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("真实 dead PID：owner 已提交且无 terminal 时同键只读恢复 full，owner 不增且账本不留敏感输入", async () => {
    const prepared = await prepareDispatchedBundleCommit("real-dead");
    const ownerOutcome = await commitAgentImagegenResultBundle(fixture!.root, prepared.request.payload);
    const ownerBefore = await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId);
    expect(ownerBefore).toMatchObject({
      raw: { resultId: ownerOutcome.results.raw.resultId },
      labeled: { resultId: ownerOutcome.results.labeled.resultId },
    });
    const requestHash = __commandRequestHashForTests(fixture!.root, prepared.request);
    const idempotencyKey = "bundle-idempotency-real-dead-owner";
    const startedAt = new Date().toISOString();
    const processOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      processOwner.once("spawn", resolve);
      processOwner.once("error", reject);
    });
    try {
      await upsertCommandLedgerEntry(fixture!.root, {
        schemaVersion: 1,
        requestId: "bundle-request-real-dead-owner",
        idempotencyKey,
        command: prepared.request.command,
        status: "running",
        replayed: false,
        requestHash,
        execution: { pid: processOwner.pid!, phase: "executing", heartbeatAt: startedAt },
        durableReconciliation: { schemaVersion: 1, request: prepared.request },
        startedAt,
      });
      let generationWritableOpens = 0;
      __setBeforeGenerationWritableOpenHookForTests(() => { generationWritableOpens += 1; });
      let waiterSettled = false;
      const waiter = executeIdempotentCommand(fixture!.root, {
        requestId: "bundle-request-real-dead-waiter",
        idempotencyKey,
        request: prepared.request,
      }, { waitForRunningMs: 10_000 }).then(
        (value) => {
          waiterSettled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          waiterSettled = true;
          return { ok: false as const, error };
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(waiterSettled).toBe(false);
      expect(processOwner.kill("SIGKILL")).toBe(true);
      await new Promise<void>((resolve) => processOwner.once("exit", () => resolve()));
      const waiterOutcome = await waiter;
      if (!waiterOutcome.ok) throw waiterOutcome.error;
      const recovered = waiterOutcome.value;
      __setBeforeGenerationWritableOpenHookForTests(null);
      expect(generationWritableOpens).toBe(0);
      expect(recovered).toMatchObject({
        status: "succeeded",
        replayed: true,
        result: {
          kind: "studio-agent-imagegen-result-bundle-outcome",
          generationRunId: prepared.generationRunId,
          writebackReceiptStorageKey: ownerOutcome.writebackReceiptStorageKey,
          results: {
            raw: { resultId: ownerOutcome.results.raw.resultId },
            labeled: { resultId: ownerOutcome.results.labeled.resultId },
          },
          reconciled: true,
        },
      });
      expect(await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId)).toEqual(ownerBefore);
      const persisted = (await listCommandLedger(fixture!.root))
        .find((entry) => entry.idempotencyKey === idempotencyKey);
      expect(persisted).toMatchObject({
        status: "succeeded",
        result: {
          kind: "studio-agent-imagegen-result-bundle-locator",
          writebackReceiptStorageKey: ownerOutcome.writebackReceiptStorageKey,
        },
      });
      expect(persisted).not.toHaveProperty("durableReconciliation");
      const serialized = JSON.stringify(persisted);
      for (const forbidden of [
        prepared.request.payload.projectContextToken,
        prepared.request.payload.rawPath,
        "executionReceiptPath",
        prepared.request.payload.executionReceipt.model,
      ]) expect(serialized).not.toContain(forbidden);
    } finally {
      __setBeforeGenerationWritableOpenHookForTests(null);
      if (processOwner.exitCode === null && processOwner.signalCode === null) processOwner.kill("SIGKILL");
    }
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("owner 已提交但 material CAS 无法证明时保持 unknown，禁止猜成功", async () => {
    const prepared = await prepareDispatchedBundleCommit("dead-cas");
    const input = envelope("dead-cas", prepared.request);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = prepared.request.command;
    await expect(executeIdempotentCommand(fixture!.root, input)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const owner = await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId);
    expect(owner).not.toBeNull();
    const labeledPath = materialCasPath(fixture!.root, owner!.labeled.mediaSha256);
    const outside = path.join(fixture!.parentRoot, "outside-labeled.png");
    await writeFile(outside, await readFile(labeledPath));
    await rm(labeledPath);
    await symlink(outside, labeledPath, "file");
    await expect(proveAgentImagegenResultBundleOutcome(fixture!.root, prepared.request.payload)).rejects.toMatchObject({
      name: "StudioAgentImagegenBundleError",
      code: "storage-unsafe",
    });
    await expect(executeIdempotentCommand(fixture!.root, {
      ...input,
      requestId: "bundle-request-dead-cas-retry",
    })).rejects.toThrow(/未能从不可变 store|保持 unknown/u);
    expect((await listCommandLedger(fixture!.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
      .toMatchObject({ status: "unknown" });
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);

  it("durable recovery / reconcile 只用只读 proof，不重做 labeled 派生或再次 register", async () => {
    const prepared = await prepareDispatchedBundleCommit("reconcile");
    const input = envelope("reconcile", prepared.request);
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = prepared.request.command;
    await expect(executeIdempotentCommand(fixture!.root, input)).rejects.toThrow("执行结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const owner = await readStudioGenerationResultBundle(fixture!.root, prepared.generationRunId);
    expect(owner).not.toBeNull();
    const labeledPath = materialCasPath(fixture!.root, owner!.labeled.mediaSha256);
    const before = await lstat(labeledPath);
    const reconciled = await reconcileCommand(fixture!.root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
        results: {
          raw: { resultId: owner!.raw.resultId },
          labeled: { resultId: owner!.labeled.resultId },
        },
        reconciled: true,
      },
    });
    const hydrated = await executeIdempotentCommand(fixture!.root, {
      ...input,
      requestId: "bundle-request-reconcile-hydrate",
    });
    expect(hydrated).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        kind: "studio-agent-imagegen-result-bundle-outcome",
        generationRunId: prepared.generationRunId,
        reconciled: true,
        results: {
          raw: { resultId: owner!.raw.resultId },
          labeled: { resultId: owner!.labeled.resultId },
        },
      },
    });
    const after = await lstat(labeledPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const stored = (await listCommandLedger(fixture!.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey);
    expect(stored).toMatchObject({
      status: "succeeded",
      result: { kind: "studio-agent-imagegen-result-bundle-locator" },
    });
    await rm(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true, force: true });
  }, 120_000);
});
