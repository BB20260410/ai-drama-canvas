import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { getCapabilities } from "../src/core/codex.js";
import { buildStudioGenerationFreezePack } from "../src/core/studio-generation.js";
import { initializeMaterialStudio } from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  analyzeStudioScriptEntities,
  freezeStudioAssetBindingSetFromControl,
  getStudioBindingControl,
} from "../src/core/studio-binding-control.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  confirmStudioPanelEntityClosureEmpty,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getCurrentStudioPanelAssetBindingSet,
  getCurrentStudioPanelAssetMentionAnalysis,
  getCurrentStudioPanelEntityClosureConfirmation,
  getStudioAssetBindingReadiness,
  getStudioPanelEntityClosureConfirmationCurrentness,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
  recordStudioBindingOperationReceipt,
  reviseStudioProductionUnit,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function envelope(index: number, request: StudioCommandRequest) {
  const suffix = String(index).padStart(4, "0");
  return {
    requestId: `confirmed-empty-request-${suffix}`,
    idempotencyKey: `confirmed-empty-key-${suffix}`,
    request,
  };
}

interface Fixture {
  root: string;
  unitId: string;
  scriptRevisionId: string;
  scriptSha256: string;
  scriptBodyLength: number;
  promptRevisionId: string;
  panels(firstAction?: string, secondAction?: string): StudioProductionPanelInput[];
}

async function fixture(label: string): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), `studio-confirmed-empty-${label}-`)));
  roots.push(parent);
  const root = (await createManagedProject({ parentRoot: parent, name: `Confirmed Empty ${label}` })).paths.root;
  await initializeMaterialStudio(root);
  const scriptDocument = await createStudioScriptDocument(root, {
    id: `script-empty-${label}`,
    title: "空镜剧本",
    expectedRevision: 0,
  });
  const scriptBody = "风吹过空旷石阶，尘埃缓慢落下。";
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: scriptBody,
    source: "fixture",
    sourceVersion: "confirmed-empty-v1",
  });
  const promptDocument = await createStudioPromptDocument(root, {
    id: `prompt-empty-${label}`,
    title: "空镜提示词",
    expectedRevision: 0,
  });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "电影写实空镜，石阶与尘埃连续。",
    source: "fixture",
    sourceVersion: "confirmed-empty-v1",
  });
  const panels = (
    firstAction = "空旷石阶上只有风与尘埃。",
    secondAction = "镜头转向同一片空旷石阶。",
  ): StudioProductionPanelInput[] => [{
    id: "panel-empty-01",
    title: "空阶",
    visualAction: firstAction,
    shotComposition: "低机位广角。",
    filmingMethod: "固定机位。",
    dialogue: "",
    subtitle: "",
    startSeconds: 0,
    endSeconds: 7,
    durationSeconds: 7,
    promptRevisionId: prompt.revision.id,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
    assets: [],
  }, {
    id: "panel-empty-02",
    title: "空阶续镜",
    visualAction: secondAction,
    shotComposition: "平视广角。",
    filmingMethod: "缓慢横移。",
    dialogue: "",
    subtitle: "",
    startSeconds: 7,
    endSeconds: 15,
    durationSeconds: 8,
    promptRevisionId: prompt.revision.id,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
    assets: [],
  }];
  const unitId = `unit-empty-${label}`;
  await createStudioProductionUnit(root, {
    id: unitId,
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "显式空闭包单元",
    scriptRevisionId: script.revision.id,
    panels: panels(),
  });
  return {
    root,
    unitId,
    scriptRevisionId: script.revision.id,
    scriptSha256: script.revision.bodySha256,
    scriptBodyLength: scriptBody.length,
    promptRevisionId: prompt.revision.id,
    panels,
  };
}

async function analyzeEmpty(target: Fixture, requestLabel: string) {
  const control = await getStudioBindingControl(target.root, { unitId: target.unitId });
  await analyzeStudioScriptEntities(target.root, {
    unitId: target.unitId,
    panelId: "panel-empty-01",
    expectedRevisionToken: control.revisionToken,
  }, { requestHash: hash(requestLabel), reviewer: "codex" });
  const analysis = await getCurrentStudioPanelAssetMentionAnalysis(target.root, target.unitId, "panel-empty-01");
  expect(analysis?.proposals).toEqual([]);
  return analysis!;
}

describe("P6 confirmed-empty vertical slice", () => {
  it("未确认失败关闭；显式确认后可冻结零资产 BindingSet，并支持 CAS、重启、命令恢复、MCP/Codex 与 UI 能力", async () => {
    const target = await fixture("main");
    const analysis = await analyzeEmpty(target, "confirmed-empty-main-analyze");
    const unconfirmed = await getStudioBindingControl(target.root, { unitId: target.unitId });
    const unconfirmedPanel = unconfirmed.panels.find((panel) => panel.id === "panel-empty-01")!;
    expect(unconfirmedPanel).toMatchObject({
      confirmEmptyAllowed: true,
      freezeAllowed: false,
      status: "pending",
    });
    expect(unconfirmedPanel.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "empty-confirmation-required", severity: "blocking" }),
    ]));
    await expect(freezeStudioAssetBindingSetFromControl(target.root, {
      unitId: target.unitId,
      panelId: "panel-empty-01",
      expectedRevisionToken: unconfirmed.revisionToken,
    }, { requestHash: hash("unconfirmed-freeze") })).rejects.toMatchObject({ code: "binding-blocked" });
    await expect(freezeStudioPanelAssetBindingSet(target.root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [],
    })).rejects.toThrow(/emptyConfirmationId|未审阅空结果/u);

    const confirmRequest = {
      command: "confirm_studio_panel_empty" as const,
      payload: {
        unitId: target.unitId,
        panelId: "panel-empty-01",
        expectedRevisionToken: unconfirmed.revisionToken,
        reviewer: "user" as const,
        note: "已逐段核对冻结剧本范围：只有环境动作，没有角色、场景或道具身份需要绑定。",
      },
    };
    await expect(executeIdempotentCommand(target.root, envelope(100, {
      ...confirmRequest,
      payload: { ...confirmRequest.payload, emptyConfirmationId: "forged" },
    } as unknown as StudioCommandRequest))).rejects.toThrow(/载荷不符合合同.*emptyConfirmationId/u);

    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "confirm_studio_panel_empty";
    await expect(executeIdempotentCommand(target.root, envelope(101, confirmRequest)))
      .rejects.toThrow(/执行结果未确认/u);
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const crashed = (await listCommandLedger(target.root))
      .find((entry) => entry.idempotencyKey === envelope(101, confirmRequest).idempotencyKey);
    expect(crashed?.durableReconciliation).toBeUndefined();
    expect(JSON.stringify(crashed)).not.toContain(confirmRequest.payload.note);
    const reconciled = await executeIdempotentCommand(target.root, {
      ...envelope(101, confirmRequest),
      requestId: "confirmed-empty-request-0101-recovery",
    });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: { reconciled: true, confirmationRevision: 1 },
    });
    const persistedReconciled = (await listCommandLedger(target.root))
      .find((entry) => entry.idempotencyKey === envelope(101, confirmRequest).idempotencyKey);
    expect(persistedReconciled?.result).toMatchObject({
      schemaVersion: 1,
      kind: "studio-operation-result-locator",
      operation: "confirm-panel-empty",
      confirmationRevision: 1,
    });
    expect(JSON.stringify(persistedReconciled)).not.toContain(confirmRequest.payload.note);
    const replayed = await executeIdempotentCommand(target.root, {
      ...envelope(101, confirmRequest),
      requestId: "confirmed-empty-request-0101-replay",
    });
    expect(replayed).toMatchObject({ status: "succeeded", replayed: true });

    const head = await getCurrentStudioPanelEntityClosureConfirmation(target.root, target.unitId, "panel-empty-01");
    expect(head?.confirmation).toMatchObject({
      closure: "confirmed-empty",
      analysisId: analysis.id,
      analysisFingerprint: analysis.fingerprint,
      panelId: "panel-empty-01",
      reviewer: "user",
      note: confirmRequest.payload.note,
    });
    expect(head?.confirmation.sourceSpans).toHaveLength(1);
    const exactRetry = await confirmStudioPanelEntityClosureEmpty(target.root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedConfirmationHeadRevision: 0,
      reviewer: "user",
      note: confirmRequest.payload.note,
    });
    expect(exactRetry.id).toBe(head?.confirmation.id);
    await expect(confirmStudioPanelEntityClosureEmpty(target.root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedConfirmationHeadRevision: 0,
      reviewer: "user",
      note: "另一条竞争审阅说明。",
    })).rejects.toMatchObject({ name: "StudioProductionConflictError", expectedRevision: 0, actualRevision: 1 });

    const confirmed = await getStudioBindingControl(target.root, { unitId: target.unitId });
    const confirmedPanel = confirmed.panels.find((panel) => panel.id === "panel-empty-01")!;
    expect(confirmedPanel).toMatchObject({
      status: "bound",
      confirmEmptyAllowed: false,
      freezeAllowed: true,
      emptyConfirmation: { currentness: "current", reviewer: "user" },
    });
    const freezeRequest = {
      command: "freeze_studio_asset_binding_set" as const,
      payload: {
        unitId: target.unitId,
        panelId: "panel-empty-01",
        expectedRevisionToken: confirmed.revisionToken,
      },
    };
    const frozen = await executeIdempotentCommand(target.root, envelope(102, freezeRequest));
    expect(frozen.status).toBe("succeeded");
    const bindingSet = await getCurrentStudioPanelAssetBindingSet(target.root, target.unitId, "panel-empty-01");
    expect(bindingSet).toMatchObject({
      bindings: [],
      decisionReceiptIds: [],
      confirmedEmpty: true,
      emptyConfirmationId: head?.confirmation.id,
    });
    const readiness = await getStudioAssetBindingReadiness(target.root, bindingSet!.id, {
      identityKeyFingerprints: {},
      assets: [],
    });
    expect(readiness).toMatchObject({ current: true, ready: true, blockers: [] });
    const readyControl = await getStudioBindingControl(target.root, { unitId: target.unitId });
    expect(readyControl.panels.find((panel) => panel.id === "panel-empty-01")).toMatchObject({
      status: "generation-ready",
      freezeAllowed: false,
      bindingSet: { currentness: "current" },
      emptyConfirmation: { currentness: "current" },
    });
    const generationPack = await buildStudioGenerationFreezePack(target.root, {
      unitId: target.unitId,
      panelId: "panel-empty-01",
    });
    expect(generationPack).toMatchObject({
      assets: [],
      forbiddenAssets: [],
      panelReferenceResolution: {
        closure: "confirmed-empty",
        confirmedEmpty: true,
        generationReady: true,
        controlReferences: [],
      },
      request: {
        controlReferences: [],
        modelPayload: { assets: [], forbiddenAssets: [] },
      },
    });
    expect(generationPack.panelReferenceResolution.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "entity-closure-confirmation",
        key: `studio:entity-closure-confirmation:${head?.confirmation.id}`,
      }),
    ]));

    const state = await initializeStudioProduction(target.root);
    expect(state).toMatchObject({ schemaVersion: 6, counts: { panelEntityClosureConfirmations: 1, assetBindingSets: 1 } });
    expect((await getCurrentStudioPanelEntityClosureConfirmation(target.root, target.unitId, 1))?.confirmation.id)
      .toBe(head?.confirmation.id);
    expect((await getCurrentStudioPanelAssetBindingSet(target.root, target.unitId, 1))?.confirmedEmpty).toBe(true);

    const capabilities = await getCapabilities(target.root);
    expect(capabilities.commandTypes).toContain("confirm_studio_panel_empty");
    expect(capabilities.managedStudio.bindingControl.writeCommands).toContain("confirm_studio_panel_empty");
    const component = await readFile(path.join(process.cwd(), "src/renderer/src/components/StudioBindingWorkbench.vue"), "utf8");
    expect(component).toContain('data-testid="binding-confirm-empty"');
    expect(component).toContain('data-testid="binding-empty-confirmation-status"');

    console.log(`P6_CONFIRMED_EMPTY_VERTICAL_SLICE ${JSON.stringify({
      unconfirmedBlocked: true,
      confirmedReady: true,
      generationPackConfirmedEmpty: true,
      retryCas: true,
      restart: true,
      durableReconciliation: true,
      mcpCodexUi: true,
    })}`);
  });

  it("其他 panel 变化不误伤；analysis head 或目标 panel scope 变化会使确认和零资产 BindingSet 过期", async () => {
    const target = await fixture("drift");
    const analysis = await analyzeEmpty(target, "confirmed-empty-drift-analyze");
    const confirmation = await confirmStudioPanelEntityClosureEmpty(target.root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedConfirmationHeadRevision: 0,
      reviewer: "codex",
      note: "Codex 已逐段核对：该格只有环境动作，无需绑定实体。",
    });
    const binding = await freezeStudioPanelAssetBindingSet(target.root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [],
      emptyConfirmationId: confirmation.id,
    });

    await reviseStudioProductionUnit(target.root, {
      unitId: target.unitId,
      expectedRevision: 1,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "显式空闭包单元",
      scriptRevisionId: target.scriptRevisionId,
      panels: target.panels(undefined, "另一宫格改成向右横移，目标空格不变。"),
    });
    expect(await getStudioPanelEntityClosureConfirmationCurrentness(target.root, confirmation.id))
      .toMatchObject({ current: true, staleReasons: [] });
    expect(await getStudioAssetBindingReadiness(target.root, binding.id, { identityKeyFingerprints: {}, assets: [] }))
      .toMatchObject({ current: true, ready: true });

    const unrelatedSnapshot = await getStudioProductionUnitSnapshot(target.root, target.unitId);
    const nextAnalysis = await analyzeStudioPanelAssetMentions(target.root, {
      unitId: target.unitId,
      unitRevision: unrelatedSnapshot!.unit.revision,
      unitFingerprint: unrelatedSnapshot!.fingerprint,
      panelIndex: 1,
      scriptRevisionId: unrelatedSnapshot!.scriptRevision.id,
      scriptSha256: unrelatedSnapshot!.scriptRevision.bodySha256,
      expectedHeadRevision: analysis.revision,
      mentions: [],
      resolverVersion: "confirmed-empty-analysis-head-change-v2",
    });
    const analysisStale = await getStudioPanelEntityClosureConfirmationCurrentness(target.root, confirmation.id);
    expect(analysisStale).toMatchObject({ current: false });
    expect(analysisStale?.staleReasons).toContain("analysis-head-changed");

    const nextConfirmation = await confirmStudioPanelEntityClosureEmpty(target.root, {
      analysisId: nextAnalysis.id,
      expectedAnalysisHeadRevision: nextAnalysis.revision,
      expectedConfirmationHeadRevision: 1,
      reviewer: "codex",
      note: "新 analysis head 仍为零提案，Codex 重新逐段确认。",
    });
    const nextBinding = await freezeStudioPanelAssetBindingSet(target.root, {
      analysisId: nextAnalysis.id,
      expectedAnalysisHeadRevision: nextAnalysis.revision,
      expectedBindingHeadRevision: binding.revision,
      decisionReceiptIds: [],
      assetSources: [],
      emptyConfirmationId: nextConfirmation.id,
    });
    await reviseStudioProductionUnit(target.root, {
      unitId: target.unitId,
      expectedRevision: 2,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "显式空闭包单元",
      scriptRevisionId: target.scriptRevisionId,
      panels: target.panels("目标宫格新增近景推进动作。", "另一宫格改成向右横移，目标空格不变。"),
    });
    const targetStale = await getStudioPanelEntityClosureConfirmationCurrentness(target.root, nextConfirmation.id);
    expect(targetStale).toMatchObject({ current: false });
    expect(targetStale?.staleReasons).toContain("panel-binding-scope-changed");
    expect(await getStudioAssetBindingReadiness(target.root, nextBinding.id, { identityKeyFingerprints: {}, assets: [] }))
      .toMatchObject({ current: false, ready: false });
  });

  it("v3 receipt CHECK 可迁移到 confirmed-empty 命令，初始化会恢复追加式触发器", async () => {
    const target = await fixture("migration");
    const state = await initializeStudioProduction(target.root);
    const db = new DatabaseSync(state.databasePath);
    db.exec(`
      DROP TRIGGER studio_binding_operation_receipts_no_update;
      DROP TRIGGER studio_binding_operation_receipts_no_delete;
      ALTER TABLE studio_binding_operation_receipts RENAME TO studio_binding_operation_receipts_v4;
      CREATE TABLE studio_binding_operation_receipts (
        id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL UNIQUE CHECK(length(request_hash) = 64),
        command TEXT NOT NULL CHECK(command IN (
          'analyze_studio_script_entities',
          'resolve_studio_entity_proposal',
          'freeze_studio_asset_binding_set'
        )),
        input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
        outcome_identity_json TEXT NOT NULL,
        outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO studio_binding_operation_receipts
        SELECT * FROM studio_binding_operation_receipts_v4;
      DROP TABLE studio_binding_operation_receipts_v4;
      DROP TRIGGER studio_panel_empty_confirmations_no_update;
      UPDATE studio_production_meta SET value = '3' WHERE key = 'schema_version';
    `);
    db.close();

    expect((await initializeStudioProduction(target.root)).schemaVersion).toBe(6);
    const receipt = await recordStudioBindingOperationReceipt(target.root, {
      requestHash: hash("migration-confirm-request"),
      command: "confirm_studio_panel_empty",
      inputFingerprint: hash("migration-confirm-input"),
      outcomeIdentity: { kind: "migration-schema-proof" },
    });
    expect(receipt.command).toBe("confirm_studio_panel_empty");
    const reopened = new DatabaseSync(state.databasePath);
    const receiptSql = String((reopened.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='studio_binding_operation_receipts'").get() as { sql: string }).sql);
    expect(receiptSql).toContain("confirm_studio_panel_empty");
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='studio_panel_empty_confirmations_no_update'").get())
      .toEqual({ name: "studio_panel_empty_confirmations_no_update" });
    reopened.close();
  });
});
