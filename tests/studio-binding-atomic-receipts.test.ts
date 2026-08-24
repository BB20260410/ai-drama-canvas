import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  analyzeStudioScriptEntities,
  confirmStudioPanelEmptyFromControl,
  freezeStudioAssetBindingSetFromControl,
  getStudioBindingControl,
  proveStudioBindingOperationOutcome,
  resolveStudioEntityProposal,
} from "../src/core/studio-binding-control.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getCurrentStudioMentionDecision,
  getCurrentStudioPanelAssetBindingSet,
  getCurrentStudioPanelAssetMentionAnalysis,
  getCurrentStudioPanelEntityClosureConfirmation,
  getStudioBindingOperationReceipt,
  type StudioBindingOperationCommand,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import { withStudioUnitsReadProbe } from "../src/core/studio-units-read-phase-timeline.js";

const roots: string[] = [];
const BOUND_TEXT = "阿航走进石室。";
const EMPTY_TEXT = "风吹过空旷石阶。";
const SCRIPT_BODY = `${BOUND_TEXT}${EMPTY_TEXT}`;

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_STUDIO_BINDING_FAIL_BEFORE_RECEIPT;
  delete process.env.AI_CANVAS_TEST_STUDIO_BINDING_CRASH_AFTER_ATOMIC_COMMIT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function envelope(index: number, request: StudioCommandRequest) {
  const suffix = String(index).padStart(4, "0");
  return {
    requestId: `binding-atomic-request-${suffix}`,
    idempotencyKey: `binding-atomic-key-${suffix}`,
    request,
  };
}

function tableCounts(root: string, tables: string[]): Record<string, number> {
  const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(tables.map((table) => {
      if (!/^[a-z_]+$/u.test(table)) throw new Error(`测试表名无效：${table}`);
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return [table, Number(row.count)];
    }));
  } finally {
    db.close();
  }
}

async function fixture(label: string): Promise<{ root: string; unitId: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), `studio-binding-atomic-${label}-`)));
  roots.push(parent);
  const root = (await createManagedProject({ parentRoot: parent, name: `P6 原子收据 ${label}` })).paths.root;

  const sourcePath = path.join(parent, "ahang-authority.png");
  await sharp({ create: { width: 48, height: 72, channels: 3, background: "#4b4037" } }).png().toFile(sourcePath);
  const media = await importStudioMedia(root, { sourcePath });
  const asset = await createStudioCanonicalAsset(root, {
    id: "character-ahang",
    expectedRevision: 0,
    category: "character",
    name: "阿航",
    aliases: ["青年阿航"],
    identityFeatures: ["固定脸"],
    positiveLocks: ["黑衣"],
    negativeLocks: ["禁止换脸"],
    defaultPrompt: "阿航，电影写实，固定脸与黑衣。",
  });
  const version = await appendStudioAssetVersion(root, {
    assetId: asset.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: asset.id,
    versionId: version.version.id,
    decision: "approved",
    expectedRevision: version.assetRevision,
    note: "P6 原子收据测试权威图审核通过。",
  });
  await setStudioPrimaryAuthority(root, {
    assetId: asset.id,
    versionId: version.version.id,
    expectedRevision: reviewed.revision,
    note: "P6 原子收据当前主权威。",
  });

  const scriptDocument = await createStudioScriptDocument(root, {
    id: `script-binding-atomic-${label}`,
    title: "P6 原子收据剧本",
    expectedRevision: 0,
  });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: SCRIPT_BODY,
    source: "fixture",
    sourceVersion: "binding-atomic-v1",
  });
  const promptDocument = await createStudioPromptDocument(root, {
    id: `prompt-binding-atomic-${label}`,
    title: "P6 原子收据提示词",
    expectedRevision: 0,
  });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "电影写实，阿航固定脸，空镜石阶保持连续。",
    source: "fixture",
    sourceVersion: "binding-atomic-v1",
  });
  const panels: StudioProductionPanelInput[] = [{
    id: "panel-bound",
    title: "阿航进场",
    visualAction: "阿航走进石室。",
    shotComposition: "中景。",
    filmingMethod: "稳定器跟拍。",
    startSeconds: 0,
    endSeconds: 7,
    durationSeconds: 7,
    promptRevisionId: prompt.revision.id,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: BOUND_TEXT.length }],
    assets: [{
      assetId: "character-ahang",
      category: "character",
      presence: "required",
      role: "主角",
      continuityState: "固定脸与黑衣。",
      evidence: [{ kind: "fixture", reference: script.revision.id }],
    }],
  }, {
    id: "panel-empty",
    title: "空阶",
    visualAction: "空旷石阶上只有风。",
    shotComposition: "广角空镜。",
    filmingMethod: "固定机位。",
    startSeconds: 7,
    endSeconds: 15,
    durationSeconds: 8,
    promptRevisionId: prompt.revision.id,
    sourceSpans: [{ startOffsetUtf16: BOUND_TEXT.length, endOffsetUtf16: SCRIPT_BODY.length }],
    assets: [],
  }];
  const unitId = `unit-binding-atomic-${label}`;
  await createStudioProductionUnit(root, {
    id: unitId,
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "P6 原子收据单元",
    scriptRevisionId: script.revision.id,
    panels,
  });
  return { root, unitId };
}

async function failBeforeReceipt<T>(
  root: string,
  command: StudioBindingOperationCommand,
  requestHash: string,
  action: () => Promise<T>,
): Promise<void> {
  process.env.AI_CANVAS_TEST_STUDIO_BINDING_FAIL_BEFORE_RECEIPT = command;
  try {
    await expect(action()).rejects.toThrow(`TEST_ONLY_STUDIO_BINDING_FAIL_BEFORE_RECEIPT:${command}`);
  } finally {
    delete process.env.AI_CANVAS_TEST_STUDIO_BINDING_FAIL_BEFORE_RECEIPT;
  }
  await expect(getStudioBindingOperationReceipt(root, requestHash)).resolves.toBeNull();
}

async function crashThenRecover(
  root: string,
  index: number,
  request: StudioCommandRequest,
  revisionProbe: () => Promise<number>,
) {
  const first = envelope(index, request);
  process.env.AI_CANVAS_TEST_STUDIO_BINDING_CRASH_AFTER_ATOMIC_COMMIT = request.command;
  try {
    await expect(executeIdempotentCommand(root, first)).rejects.toThrow("命令执行结果未确认");
  } finally {
    delete process.env.AI_CANVAS_TEST_STUDIO_BINDING_CRASH_AFTER_ATOMIC_COMMIT;
  }
  const unknown = (await listCommandLedger(root)).find((entry) => entry.idempotencyKey === first.idempotencyKey);
  expect(unknown).toMatchObject({ status: "unknown", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  const receiptBeforeRecovery = await getStudioBindingOperationReceipt(root, unknown!.requestHash);
  expect(receiptBeforeRecovery).toMatchObject({ command: request.command, requestHash: unknown!.requestHash });
  const revisionBeforeRecovery = await revisionProbe();

  const recovered = await executeIdempotentCommand(root, {
    ...first,
    requestId: `${first.requestId}-recovery`,
  });
  expect(recovered).toMatchObject({
    status: "succeeded",
    replayed: true,
    result: { reconciled: true },
  });
  expect(await revisionProbe()).toBe(revisionBeforeRecovery);
  expect((await getStudioBindingOperationReceipt(root, unknown!.requestHash))?.id).toBe(receiptBeforeRecovery?.id);
  return recovered;
}

describe.sequential("P6 Studio binding 原子业务收据", () => {
  it("业务写后、receipt 前失败时 analyze/resolve/freeze/confirm-empty 整笔回滚", async () => {
    const { root, unitId } = await fixture("rollback");

    const analyzeTables = [
      "studio_asset_mention_analyses",
      "studio_asset_mention_proposals",
      "studio_asset_mention_analysis_heads",
    ];
    const initial = await getStudioBindingControl(root, { unitId });
    const analyzeRequestHash = hash("rollback-analyze");
    const analyzeInput = {
      unitId,
      panelId: "panel-bound",
      expectedRevisionToken: initial.revisionToken,
    };
    const analyzeBefore = tableCounts(root, analyzeTables);
    await failBeforeReceipt(root, "analyze_studio_script_entities", analyzeRequestHash, () => (
      analyzeStudioScriptEntities(root, analyzeInput, { requestHash: analyzeRequestHash, reviewer: "codex" })
    ));
    expect(tableCounts(root, analyzeTables)).toEqual(analyzeBefore);
    expect(await getCurrentStudioPanelAssetMentionAnalysis(root, unitId, "panel-bound")).toBeNull();
    await analyzeStudioScriptEntities(root, analyzeInput, { requestHash: analyzeRequestHash, reviewer: "codex" });

    const afterAnalyze = await getStudioBindingControl(root, { unitId });
    const proposal = afterAnalyze.panels.find((panel) => panel.id === "panel-bound")!.proposals[0]!;
    expect(proposal).toMatchObject({ entityText: "阿航", matchedAssetId: "character-ahang" });
    const resolveRequestHash = hash("rollback-resolve");
    const resolveInput = {
      unitId,
      panelId: "panel-bound",
      proposalId: proposal.id,
      decision: "accept" as const,
      selectedAssetId: "character-ahang",
      presence: "required" as const,
      role: "主角",
      expectedRevisionToken: afterAnalyze.revisionToken,
      reviewer: "codex" as const,
    };
    const resolveTables = ["studio_asset_mention_decisions", "studio_asset_mention_decision_heads"];
    const resolveBefore = tableCounts(root, resolveTables);
    await failBeforeReceipt(root, "resolve_studio_entity_proposal", resolveRequestHash, () => (
      resolveStudioEntityProposal(root, resolveInput, { requestHash: resolveRequestHash, reviewer: "codex" })
    ));
    expect(tableCounts(root, resolveTables)).toEqual(resolveBefore);
    expect(await getCurrentStudioMentionDecision(root, proposal.id)).toBeNull();
    await resolveStudioEntityProposal(root, resolveInput, { requestHash: resolveRequestHash, reviewer: "codex" });

    const afterResolve = await getStudioBindingControl(root, { unitId });
    const freezeRequestHash = hash("rollback-freeze");
    const freezeInput = {
      unitId,
      panelId: "panel-bound",
      expectedRevisionToken: afterResolve.revisionToken,
    };
    const freezeTables = [
      "studio_asset_binding_sets",
      "studio_asset_bindings",
      "studio_asset_binding_mentions",
      "studio_asset_binding_dependencies",
      "studio_asset_binding_set_heads",
    ];
    const freezeBefore = tableCounts(root, freezeTables);
    await failBeforeReceipt(root, "freeze_studio_asset_binding_set", freezeRequestHash, () => (
      freezeStudioAssetBindingSetFromControl(root, freezeInput, { requestHash: freezeRequestHash, reviewer: "codex" })
    ));
    expect(tableCounts(root, freezeTables)).toEqual(freezeBefore);
    expect(await getCurrentStudioPanelAssetBindingSet(root, unitId, "panel-bound")).toBeNull();
    await freezeStudioAssetBindingSetFromControl(root, freezeInput, { requestHash: freezeRequestHash, reviewer: "codex" });

    const beforeEmptyAnalyze = await getStudioBindingControl(root, { unitId });
    await analyzeStudioScriptEntities(root, {
      unitId,
      panelId: "panel-empty",
      expectedRevisionToken: beforeEmptyAnalyze.revisionToken,
    }, { requestHash: hash("rollback-empty-analyze"), reviewer: "codex" });
    const beforeConfirm = await getStudioBindingControl(root, { unitId });
    const confirmRequestHash = hash("rollback-confirm-empty");
    const confirmInput = {
      unitId,
      panelId: "panel-empty",
      expectedRevisionToken: beforeConfirm.revisionToken,
      reviewer: "codex" as const,
      note: "已逐字核对冻结剧本范围，只有风与空旷石阶，无需绑定实体。",
    };
    const confirmTables = [
      "studio_panel_entity_closure_confirmations",
      "studio_panel_entity_closure_confirmation_heads",
    ];
    const confirmBefore = tableCounts(root, confirmTables);
    await failBeforeReceipt(root, "confirm_studio_panel_empty", confirmRequestHash, () => (
      confirmStudioPanelEmptyFromControl(root, confirmInput, { requestHash: confirmRequestHash, reviewer: "codex" })
    ));
    expect(tableCounts(root, confirmTables)).toEqual(confirmBefore);
    expect(await getCurrentStudioPanelEntityClosureConfirmation(root, unitId, "panel-empty")).toBeNull();
    await confirmStudioPanelEmptyFromControl(root, confirmInput, { requestHash: confirmRequestHash, reviewer: "codex" });
  });

  it("原子 commit 后、高层返回前崩溃时命令只凭 receipt 恢复且不重放", async () => {
    const { root, unitId } = await fixture("recovery");

    const initial = await getStudioBindingControl(root, { unitId });
    await crashThenRecover(root, 101, {
      command: "analyze_studio_script_entities",
      payload: {
        unitId,
        panelId: "panel-bound",
        expectedRevisionToken: initial.revisionToken,
      },
    }, async () => (await getCurrentStudioPanelAssetMentionAnalysis(root, unitId, "panel-bound"))?.revision ?? 0);

    const afterAnalyze = await getStudioBindingControl(root, { unitId });
    const proposal = afterAnalyze.panels.find((panel) => panel.id === "panel-bound")!.proposals[0]!;
    await crashThenRecover(root, 102, {
      command: "resolve_studio_entity_proposal",
      payload: {
        unitId,
        panelId: "panel-bound",
        proposalId: proposal.id,
        decision: "accept",
        selectedAssetId: "character-ahang",
        presence: "required",
        role: "主角",
        expectedRevisionToken: afterAnalyze.revisionToken,
        reviewer: "codex",
      },
    }, async () => (await getCurrentStudioMentionDecision(root, proposal.id))?.revision ?? 0);

    const afterResolve = await getStudioBindingControl(root, { unitId });
    await crashThenRecover(root, 103, {
      command: "freeze_studio_asset_binding_set",
      payload: {
        unitId,
        panelId: "panel-bound",
        expectedRevisionToken: afterResolve.revisionToken,
      },
    }, async () => (await getCurrentStudioPanelAssetBindingSet(root, unitId, "panel-bound"))?.revision ?? 0);

    const beforeEmptyAnalyze = await getStudioBindingControl(root, { unitId });
    await analyzeStudioScriptEntities(root, {
      unitId,
      panelId: "panel-empty",
      expectedRevisionToken: beforeEmptyAnalyze.revisionToken,
    }, { requestHash: hash("recovery-empty-analyze"), reviewer: "codex" });
    const beforeConfirm = await getStudioBindingControl(root, { unitId });
    await crashThenRecover(root, 104, {
      command: "confirm_studio_panel_empty",
      payload: {
        unitId,
        panelId: "panel-empty",
        expectedRevisionToken: beforeConfirm.revisionToken,
        reviewer: "codex",
        note: "已逐字核对冻结剧本范围，只有风与空旷石阶，无需绑定实体。",
      },
    }, async () => (await getCurrentStudioPanelEntityClosureConfirmation(root, unitId, "panel-empty"))?.revision ?? 0);

    const recoveredEntries = (await listCommandLedger(root)).filter((entry) => [101, 102, 103, 104]
      .map((index) => `binding-atomic-key-${String(index).padStart(4, "0")}`)
      .includes(entry.idempotencyKey));
    expect(recoveredEntries).toHaveLength(4);
    const strictProofs = await withStudioUnitsReadProbe(true, async () => Promise.all(
      recoveredEntries.map((entry) => proveStudioBindingOperationOutcome(
        root,
        entry.requestHash,
        entry.command as StudioBindingOperationCommand,
      )),
    ));
    expect(strictProofs.value.every(Boolean)).toBe(true);
    expect(strictProofs.snapshot?.counters).toMatchObject({
      productionDirectoryEnsureCalls: 0,
      productionOpenDatabaseCalls: 0,
      productionReadOnlyProbeConnections: 0,
      productionOwnerConnections: 0,
    });
    for (const entry of recoveredEntries) {
      expect(entry.result).toMatchObject({
        schemaVersion: 1,
        kind: "studio-operation-result-locator",
        operationId: entry.requestHash,
      });
      expect(entry.durableReconciliation).toBeUndefined();
    }

    process.stdout.write(`P6_BINDING_ATOMIC_RECEIPT_MATRIX ${JSON.stringify({
      schemaVersion: 1,
      beforeReceiptRollback: ["analyze", "resolve", "freeze", "confirm-empty"],
      afterCommitReceiptRecoveryWithoutReplay: ["analyze", "resolve", "freeze", "confirm-empty"],
      lowLevelWithoutOperationContext: "compatible",
    })}\n`);
  });
});
