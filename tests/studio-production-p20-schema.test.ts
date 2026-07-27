import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  confirmStudioPanelEntityClosureEmpty,
  createStudioPanelBindingScopeFingerprint,
  createStudioProductionUnitFingerprint,
  createStudioPromptDocument,
  createStudioProductionUnit,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
  readStudioProductionUnitSnapshot,
  reviseStudioProductionUnit,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";

/**
 * P20 schema 迁移与 shotType 规则定向测试（规范 v2.1 §4-7..13）。
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "p20-schema-"));
  roots.push(root);
  return root;
}

const SCRIPT_BODY = "阿航带着完整黄金面具走入石室。火把的光从左侧墙壁滑落。他停在三步外没有伸手。";

async function textFixture(root: string, body = SCRIPT_BODY) {
  const script = await createStudioScriptDocument(root, { id: "script-p20", title: "EP01", expectedRevision: 0 });
  const scriptAppended = await appendStudioScriptRevision(root, {
    documentId: script.id,
    expectedRevision: 0,
    body,
    source: "scripts/EP01.md",
    sourceVersion: "v1",
  });
  const prompt = await createStudioPromptDocument(root, { id: "prompt-p20", title: "提示词", expectedRevision: 0 });
  const promptAppended = await appendStudioPromptRevision(root, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "电影写实。",
    source: "prompts/a.txt",
    sourceVersion: "v1",
  });
  return { script, scriptRevision: scriptAppended.revision, prompt, promptRevision: promptAppended.revision };
}

function makePanel(promptRevisionId: string, overrides: Partial<StudioProductionPanelInput> & { startSeconds: number; durationSeconds: number }): StudioProductionPanelInput {
  return {
    title: "镜头",
    visualAction: "阿航走入石室。",
    shotComposition: "中景。",
    filmingMethod: "固定机位。",
    promptRevisionId,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY.length }],
    assets: [],
    ...overrides,
  };
}

async function createUnit(root: string, panels: StudioProductionPanelInput[], scriptRevisionId: string) {
  return createStudioProductionUnit(root, {
    season: "season-three",
    episode: "ep01",
    sequence: 1,
    title: "P20 单元",
    scriptRevisionId,
    panels,
    expectedRevision: 0,
  });
}

/** 模拟 P20 前存量：摘除 append-only 触发器后删除该单元 spans 行，使格呈零 spans legacy 态。 */
function makeLegacyZeroSpanUnit(root: string, unitId: string): void {
  const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("DROP TRIGGER IF EXISTS studio_panel_source_spans_no_delete");
  db.prepare("DELETE FROM studio_production_panel_source_spans WHERE unit_id = ?").run(unitId);
  db.close();
}

describe("P20 §4-7 schema 迁移：旧行默认值 + 双指纹零漂移 + 重开库读回", () => {
  it("v4 形状 panels 表（无 5 列）迁移后默认值正确，快照指纹与新建同内容单元一致", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const fresh = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5 }),
    ], fixture.scriptRevision.id);

    // 把 panels 表回滚成 v4 形状（无 5 列），再触发迁移。
    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE studio_production_panels RENAME TO studio_production_panels_v5;
      CREATE TABLE studio_production_panels (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        panel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        visual_action TEXT NOT NULL,
        shot_composition TEXT NOT NULL,
        filming_method TEXT NOT NULL,
        dialogue TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        prompt_revision_id TEXT NOT NULL,
        PRIMARY KEY(unit_id, unit_revision, panel_index),
        UNIQUE(unit_id, unit_revision, panel_id)
      ) STRICT;
      INSERT INTO studio_production_panels
        SELECT unit_id, unit_revision, panel_index, panel_id, title, visual_action,
               shot_composition, filming_method, dialogue, subtitle, start_ms, end_ms,
               duration_ms, prompt_revision_id
        FROM studio_production_panels_v5;
      DROP TABLE studio_production_panels_v5;
      PRAGMA foreign_keys=ON;
    `);
    db.close();

    const state = await initializeStudioProduction(root);
    expect(state.schemaVersion).toBe(6);
    const migrated = await getStudioProductionUnitSnapshot(root, fresh.unit.id);
    expect(migrated).not.toBeNull();
    expect(migrated!.fingerprint).toBe(fresh.fingerprint);
    // R1-F6a：迁移路径 binding scope 指纹直接断言（不仅靠快照相等推导）。
    expect(createStudioPanelBindingScopeFingerprint(migrated!, 1)).toBe(createStudioPanelBindingScopeFingerprint(fresh, 1));
    for (const panel of migrated!.panels) {
      expect(panel.shotType).toBe("original");
      expect(panel.transition).toBe("");
      expect(panel.costumeState).toBe("");
      expect(panel.sceneLighting).toBe("");
      expect(panel.negativePrompt).toBe("");
    }

    // 关闭重开库：旧行默认值仍正确。
    const reopened = await readStudioProductionUnitSnapshot(root, fresh.unit.id, fresh.unit.revision);
    expect(reopened).not.toBeNull();
    expect(reopened!.panels.every((panel) => panel.shotType === "original")).toBe(true);
  });
});

describe("P20 §4-8 shotType 规则", () => {
  it("original 零 spans 拒绝；extension 带 spans 拒绝；extension 不在末尾后缀拒绝；全 extension 拒绝", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    await expect(createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5, sourceSpans: [] }),
      makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5 }),
    ], fixture.scriptRevision.id)).rejects.toThrow(/文本覆盖证据/u);

    await expect(createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5, shotType: "extension" }),
    ], fixture.scriptRevision.id)).rejects.toThrow(/禁止携带 sourceSpans/u);

    await expect(createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 5, shotType: "extension", sourceSpans: [] }),
      makePanel(fixture.promptRevision.id, { startSeconds: 5, durationSeconds: 10 }),
    ], fixture.scriptRevision.id)).rejects.toThrow(/不得作为首格/u);

    await expect(createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 5, shotType: "extension", sourceSpans: [] }),
      makePanel(fixture.promptRevision.id, { startSeconds: 5, durationSeconds: 5, shotType: "original" }),
      makePanel(fixture.promptRevision.id, { startSeconds: 10, durationSeconds: 5, shotType: "extension", sourceSpans: [] }),
    ], fixture.scriptRevision.id)).rejects.toThrow(/不得作为首格/u);

    await expect(createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 5 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 5, durationSeconds: 5, shotType: "extension", sourceSpans: [] }),
      makePanel(fixture.promptRevision.id, { startSeconds: 10, durationSeconds: 5, shotType: "original" }),
    ], fixture.scriptRevision.id)).rejects.toThrow(/末尾的连续后缀/u);
  });

  it("末尾后缀 extension 接受；5 字段往返；4 格严格 15 秒快照", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const snapshot = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 4 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 4, durationSeconds: 4 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 8, durationSeconds: 4 }),
      makePanel(fixture.promptRevision.id, {
        startSeconds: 12,
        durationSeconds: 3,
        shotType: "extension",
        sourceSpans: [],
        transition: "叠化至下一格",
        costumeState: "整格统一深灰祭服",
        sceneLighting: "整格统一左侧火光",
        negativePrompt: "不要文字；不要水印",
      }),
    ], fixture.scriptRevision.id);
    expect(snapshot.panels).toHaveLength(4);
    const extension = snapshot.panels[3]!;
    expect(extension.shotType).toBe("extension");
    expect(extension.transition).toBe("叠化至下一格");
    expect(extension.costumeState).toBe("整格统一深灰祭服");
    expect(extension.sceneLighting).toBe("整格统一左侧火光");
    expect(extension.negativePrompt).toBe("不要文字；不要水印");
    expect(snapshot.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBeCloseTo(15, 5);

    const reopened = await readStudioProductionUnitSnapshot(root, snapshot.unit.id, snapshot.unit.revision);
    expect(reopened!.panels[3]!.negativePrompt).toBe("不要文字；不要水印");
  });

  it("revise 祖辈规则：legacy 零 spans 格沿未变化可保留；变化格必须补齐", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const created = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5 }),
    ], fixture.scriptRevision.id);

    // 模拟 P20 前的存量数据：使两个 original 格变为零 spans legacy 态。
    makeLegacyZeroSpanUnit(root, created.unit.id);
    const legacy = await getStudioProductionUnitSnapshot(root, created.unit.id);
    expect(legacy!.panels.every((panel) => panel.sourceSpans.length === 0)).toBe(true);

    const unchanged = legacy!.panels.map((panel): StudioProductionPanelInput => ({
      id: panel.id,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      startSeconds: panel.startSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: panel.promptRevisionId,
      sourceSpans: [],
      assets: [],
      transition: panel.transition,
      costumeState: panel.costumeState,
      sceneLighting: panel.sceneLighting,
      shotType: panel.shotType,
      negativePrompt: panel.negativePrompt,
    }));
    const revised = await reviseStudioProductionUnit(root, {
      unitId: created.unit.id,
      expectedRevision: created.unit.revision,
      season: created.unit.season,
      episode: created.unit.episode,
      sequence: created.unit.sequence,
      title: created.unit.title,
      scriptRevisionId: created.unit.scriptRevisionId,
      panels: unchanged,
    });
    expect(revised.unit.revision).toBe(created.unit.revision + 1);
    expect(revised.panels.every((panel) => panel.sourceSpans.length === 0)).toBe(true);

    const changed = unchanged.map((panel, index) => index === 0 ? { ...panel, title: "改过的镜头" } : panel);
    await expect(reviseStudioProductionUnit(root, {
      unitId: created.unit.id,
      expectedRevision: revised.unit.revision,
      season: created.unit.season,
      episode: created.unit.episode,
      sequence: created.unit.sequence,
      title: created.unit.title,
      scriptRevisionId: created.unit.scriptRevisionId,
      panels: changed,
    })).rejects.toThrow(/文本覆盖证据/u);
  });
});

describe("P20 §4-8 extension 格冻结链路（豁免 → 零提案 → confirmed-empty → BindingSet）", () => {
  it("extension 格豁免产出零提案分析；未裁决冻结拒绝；裁决后放行；original 无豁免仍拒绝", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const snapshot = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 10 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 10, durationSeconds: 5, shotType: "extension", sourceSpans: [] }),
    ], fixture.scriptRevision.id);
    const extensionPanel = snapshot.panels[1]!;

    // extension 格：豁免后可建零提案分析。
    const analysis = await analyzeStudioPanelAssetMentions(root, {
      unitId: snapshot.unit.id,
      unitRevision: snapshot.unit.revision,
      unitFingerprint: snapshot.fingerprint,
      panelIndex: extensionPanel.index,
      scriptRevisionId: snapshot.scriptRevision.id,
      scriptSha256: snapshot.scriptRevision.bodySha256,
      mentions: [],
      expectedHeadRevision: 0,
    } as Parameters<typeof analyzeStudioPanelAssetMentions>[1]);
    expect(analysis.proposals).toEqual([]);

    // 未做 confirmed-empty 裁决时冻结 BindingSet 拒绝。
    await expect(freezeStudioPanelAssetBindingSet(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [],
    })).rejects.toThrow(/emptyConfirmationId/u);

    // confirmed-empty 裁决（extension 格豁免路径）后冻结放行。
    const confirmation = await confirmStudioPanelEntityClosureEmpty(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedConfirmationHeadRevision: 0,
      reviewer: "codex",
      note: "extension 格无资产（扩写补格）。",
    });
    const bindingSet = await freezeStudioPanelAssetBindingSet(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [],
      emptyConfirmationId: confirmation.id,
    });
    expect(bindingSet).toBeDefined();

    // original 格（legacy 零 spans）无豁免仍拒绝实体解析：另建独立单元置 legacy 态验证。
    const legacyUnit = await createStudioProductionUnit(root, {
      season: "season-three",
      episode: "ep01",
      sequence: 2,
      title: "legacy 单元",
      scriptRevisionId: fixture.scriptRevision.id,
      panels: [
        makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5 }),
        makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5 }),
      ],
      expectedRevision: 0,
    });
    makeLegacyZeroSpanUnit(root, legacyUnit.unit.id);
    const legacySnapshot = await getStudioProductionUnitSnapshot(root, legacyUnit.unit.id);
    const legacyOriginal = legacySnapshot!.panels[0]!;
    expect(legacyOriginal.sourceSpans).toEqual([]);
    await expect(analyzeStudioPanelAssetMentions(root, {
      unitId: legacySnapshot!.unit.id,
      unitRevision: legacySnapshot!.unit.revision,
      unitFingerprint: legacySnapshot!.fingerprint,
      panelIndex: legacyOriginal.index,
      scriptRevisionId: legacySnapshot!.scriptRevision.id,
      scriptSha256: legacySnapshot!.scriptRevision.bodySha256,
      mentions: [],
      expectedHeadRevision: 0,
    })).rejects.toThrow(/sourceSpans/u);
  });

  it("extension 格 freeze→persist→dispatch 全链放行（豁免 0 spans，原盲审 P0 回归）", async () => {
    const parentRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "p20-extension-chain-")));
    roots.push(parentRoot);
    const { createManagedProject } = await import("../src/core/managed-project.js");
    const root = (await createManagedProject({ parentRoot, name: "P20 extension 全链" })).paths.root;
    const fixture = await textFixture(root);
    const snapshot = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 10 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 10, durationSeconds: 5, shotType: "extension", sourceSpans: [] }),
    ], fixture.scriptRevision.id);
    const extensionPanel = snapshot.panels[1]!;

    const analysis = await analyzeStudioPanelAssetMentions(root, {
      unitId: snapshot.unit.id,
      unitRevision: snapshot.unit.revision,
      unitFingerprint: snapshot.fingerprint,
      panelIndex: extensionPanel.index,
      scriptRevisionId: snapshot.scriptRevision.id,
      scriptSha256: snapshot.scriptRevision.bodySha256,
      mentions: [],
      expectedHeadRevision: 0,
    } as Parameters<typeof analyzeStudioPanelAssetMentions>[1]);
    const confirmation = await confirmStudioPanelEntityClosureEmpty(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedConfirmationHeadRevision: 0,
      reviewer: "codex",
      note: "extension 格无资产（扩写补格）。",
    });
    await freezeStudioPanelAssetBindingSet(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [],
      emptyConfirmationId: confirmation.id,
    });

    // 此前 assertRequestIntegrity 硬要 1–64 spans，extension 格在此必炸（input-drift）。
    const { freezeAndPersistStudioGenerationPack, readStudioGenerationFrozenPack, dispatchStudioGenerationPack } =
      await import("../src/core/studio-generation-ledger.js");
    const frozen = await freezeAndPersistStudioGenerationPack(root, { unitId: snapshot.unit.id, panelId: extensionPanel.id });
    const pack = await readStudioGenerationFrozenPack(root, frozen.packId);
    expect(pack).toBeTruthy();
    expect(pack!.request.modelPayload.panel.shotType).toBe("extension");
    expect(pack!.request.sourceRevisions.sourceSpans).toEqual([]);
    expect(pack!.request.modelPayload.renderedPrompt).toContain("扩写延续");

    await dispatchStudioGenerationPack(root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "p20-extension-run-001",
      provider: "codex",
    });
  }, 60_000);
});

describe("P20 §4-11 旧 revision 行为", () => {
  it("rev N 建 unit → 剧本推进 N+1 → 旧 unit 不变、span 仍锚 rev N、建议器输出新锚点", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const snapshot = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5 }),
    ], fixture.scriptRevision.id);

    const nextBody = `${SCRIPT_BODY}阿航踏上第一级台阶。`;
    await appendStudioScriptRevision(root, {
      documentId: fixture.script.id,
      expectedRevision: fixture.scriptRevision.ordinal,
      body: nextBody,
      source: "scripts/EP01.md",
      sourceVersion: "v2",
    });

    const reopened = await getStudioProductionUnitSnapshot(root, snapshot.unit.id);
    expect(reopened!.unit.revision).toBe(snapshot.unit.revision);
    expect(reopened!.scriptRevision.id).toBe(fixture.scriptRevision.id);
    expect(reopened!.scriptRevision.bodySha256).toBe(fixture.scriptRevision.bodySha256);
    for (const panel of reopened!.panels) {
      for (const span of panel.sourceSpans) {
        expect(span.scriptRevisionId).toBe(fixture.scriptRevision.id);
        expect(span.scriptSha256).toBe(fixture.scriptRevision.bodySha256);
      }
    }

    const { suggestStudioStoryboardDraft } = await import("../src/core/studio-storyboard-draft.js");
    const { listStudioTextRevisions } = await import("../src/core/studio-production.js");
    const revisions = await listStudioTextRevisions(root, { documentId: fixture.script.id, limit: 10 });
    const latest = [...revisions.items].sort((left, right) => right.ordinal - left.ordinal)[0]!;
    expect(latest.bodySha256).not.toBe(fixture.scriptRevision.bodySha256);
    const suggestion = await suggestStudioStoryboardDraft(root, { scriptRevisionId: latest.id, panelCount: 2 });
    expect(suggestion.scriptRevisionId).toBe(latest.id);
    expect(suggestion.panels.flatMap((panel) => panel.sourceSpans).some((span) => span.endOffsetUtf16 > SCRIPT_BODY.length)).toBe(true);
  });
});

describe("P20 §4-9/12 冻结包指令投影：negativePrompt 合并与覆盖渲染", () => {
  it("覆盖行抑制全部资产账本行并标注来源；负提示词按条去重合并；旧包不回算", async () => {
    const { createStudioP7Fixture, seedStudioP7ResolvedPanelContinuity } = await import("./helpers/studio-p7-fixture.js");
    const { freezeAndPersistStudioGenerationPack, readStudioGenerationFrozenPack } = await import("../src/core/studio-generation-ledger.js");
    const fixture = await createStudioP7Fixture();
    try {
      const unit = fixture.units.twoPanel;
      const panel = unit.panels[0]!;
      // 先为 r1 作用域布好连续性头（BindingSet 复用 r1 scope，指纹不变时不会因修订升级）。
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
        assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
      });
      // F-R2-02：revise 前先冻结旧包，作为"旧包不回算"的真实基准。
      const oldFrozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
      });
      const oldPack = await readStudioGenerationFrozenPack(fixture.root, oldFrozen.packId);
      expect(oldPack).not.toBeNull();
      const { getStudioCanonicalAsset } = await import("../src/core/material-studio.js");
      const assetLocks: string[] = [];
      for (const ref of oldPack!.request.modelPayload.assets as ReadonlyArray<{ assetId: string }>) {
        const detail = await getStudioCanonicalAsset(fixture.root, ref.assetId);
        assetLocks.push(...(detail?.negativeLocks ?? []));
      }
      expect(assetLocks.length).toBeGreaterThan(0);
      const firstAssetLock = assetLocks[0]!;
      const snapshot = await getStudioProductionUnitSnapshot(fixture.root, unit.unit.id);
      const revisedPanels = snapshot!.panels.map((item, index): StudioProductionPanelInput => ({
        id: item.id,
        title: item.title,
        visualAction: item.visualAction,
        shotComposition: item.shotComposition,
        filmingMethod: item.filmingMethod,
        dialogue: item.dialogue,
        subtitle: item.subtitle,
        startSeconds: item.startSeconds,
        durationSeconds: item.durationSeconds,
        promptRevisionId: item.promptRevisionId,
        sourceSpans: item.sourceSpans.map((span) => ({ startOffsetUtf16: span.startOffsetUtf16, endOffsetUtf16: span.endOffsetUtf16 })),
        assets: item.assets.map((asset) => ({
          assetId: asset.assetId,
          category: asset.category,
          presence: asset.presence,
          role: asset.role,
          continuityState: asset.continuityState,
          evidence: asset.evidence.map((entry) => ({ kind: entry.kind, reference: entry.reference, note: entry.note })),
        })),
        transition: index === 0 ? "叠化至下一格" : item.transition,
        costumeState: index === 0 ? "整格统一深灰祭服" : item.costumeState,
        sceneLighting: index === 0 ? "整格统一左侧火光" : item.sceneLighting,
        shotType: item.shotType,
        negativePrompt: index === 0 ? `不要文字；不要水印；不要文字；${firstAssetLock}` : item.negativePrompt,
      }));
      await reviseStudioProductionUnit(fixture.root, {
        unitId: snapshot!.unit.id,
        expectedRevision: snapshot!.unit.revision,
        season: snapshot!.unit.season,
        episode: snapshot!.unit.episode,
        sequence: snapshot!.unit.sequence,
        title: snapshot!.unit.title,
        scriptRevisionId: snapshot!.unit.scriptRevisionId,
        panels: revisedPanels,
      });
      const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
      });
      const pack = await readStudioGenerationFrozenPack(fixture.root, frozen.packId);
      expect(pack).not.toBeNull();
      const instruction = pack!.request.modelPayload.panel;
      expect(instruction.transition).toBe("叠化至下一格");
      expect(instruction.costumeState).toBe("整格统一深灰祭服");
      expect(instruction.sceneLighting).toBe("整格统一左侧火光");
      expect(instruction.negativePrompt).toBe(`不要文字；不要水印；不要文字；${firstAssetLock}`);
      expect(instruction.shotType).toBe("original");

      const rendered = pack!.request.modelPayload.renderedPrompt;
      expect(rendered).toContain("服装（宫格覆盖）：整格统一深灰祭服");
      expect(rendered).toContain("光线（宫格覆盖）：整格统一左侧火光");
      expect(rendered).toContain("转场：叠化至下一格");
      expect(rendered).toContain("镜头类型：原镜");
      expect(rendered).not.toContain("连续性账本 costume");
      expect(rendered).not.toContain("连续性账本 lighting");
      const negativeLine = rendered.split("\n").find((line) => line.startsWith("本格负提示词："));
      expect(negativeLine).toBeDefined();
      const parts = negativeLine!.replace("本格负提示词：", "").split("；");
      expect(parts.filter((part) => part === "不要文字")).toHaveLength(1);
      expect(parts).toContain("不要水印");
      // F-R2-03.2：合并行含全部资产 negativeLocks、跨源精确去重、保序（先资产后本格）。
      for (const lock of assetLocks) expect(parts).toContain(lock);
      expect(parts.filter((part) => part === firstAssetLock)).toHaveLength(1);
      const firstPanelItemIndex = parts.indexOf("不要文字");
      const lastLockIndex = Math.max(...assetLocks.map((lock) => parts.indexOf(lock)));
      expect(lastLockIndex).toBeGreaterThanOrEqual(0);
      expect(lastLockIndex).toBeLessThan(firstPanelItemIndex);

      // F-R2-02 旧包不回算（真实旧包）：新包指纹 ≠ 旧包；旧包读回逐字段不变且不回算覆盖行。
      expect(frozen.fingerprint).not.toBe(oldFrozen.fingerprint);
      const oldPackReadBack = await readStudioGenerationFrozenPack(fixture.root, oldFrozen.packId);
      expect(oldPackReadBack!.fingerprint).toBe(oldFrozen.fingerprint);
      expect(oldPackReadBack!.request.modelPayload.renderedPrompt).not.toContain("宫格覆盖");
      expect(oldPackReadBack!.request.modelPayload.panel.costumeState).toBe("");
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});

describe("P20 §4-10 5 字段双指纹排除（直接防回归）", () => {
  it("纯函数层：变异克隆 5 字段 → snapshot/scope 指纹均不变；revise 路径：scope 不变、历史 revision 指纹不变", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    const created = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 7.5 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 7.5, durationSeconds: 7.5 }),
    ], fixture.scriptRevision.id);
    const scopeBefore = createStudioPanelBindingScopeFingerprint(created, 1);

    // 纯函数层直接钉死：5 字段即使被人加进指纹 payload，本断言立即变红。
    const mutated = structuredClone(created);
    for (const panel of mutated.panels) {
      panel.transition = "变异转场";
      panel.costumeState = "变异服装";
      panel.sceneLighting = "变异光线";
      panel.negativePrompt = "变异负提示";
      panel.shotType = "extension";
    }
    expect(createStudioProductionUnitFingerprint(mutated)).toBe(created.fingerprint);
    expect(createStudioPanelBindingScopeFingerprint(mutated, 1)).toBe(scopeBefore);

    // revise 路径：snapshot 指纹按设计含 unit head 元数据（revision/updatedAt）必然变化；
    // binding scope 排除 head 元数据与 5 字段，必须不变。
    const revisedPanels = created.panels.map((panel, index): StudioProductionPanelInput => ({
      id: panel.id,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      startSeconds: panel.startSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: panel.promptRevisionId,
      sourceSpans: panel.sourceSpans.map((span) => ({ startOffsetUtf16: span.startOffsetUtf16, endOffsetUtf16: span.endOffsetUtf16 })),
      assets: [],
      transition: index === 0 ? "叠化至下一格" : panel.transition,
      costumeState: index === 0 ? "整格统一深灰祭服" : panel.costumeState,
      sceneLighting: index === 0 ? "整格统一左侧火光" : panel.sceneLighting,
      shotType: panel.shotType,
      negativePrompt: index === 0 ? "不要文字" : panel.negativePrompt,
    }));
    const revised = await reviseStudioProductionUnit(root, {
      unitId: created.unit.id,
      expectedRevision: created.unit.revision,
      season: created.unit.season,
      episode: created.unit.episode,
      sequence: created.unit.sequence,
      title: created.unit.title,
      scriptRevisionId: created.unit.scriptRevisionId,
      panels: revisedPanels,
    });
    expect(revised.unit.revision).toBe(created.unit.revision + 1);
    expect(revised.panels[0]!.costumeState).toBe("整格统一深灰祭服");
    expect(revised.fingerprint).not.toBe(created.fingerprint);
    expect(createStudioPanelBindingScopeFingerprint(revised, 1)).toBe(scopeBefore);

    // 历史 revision 读回不可变：旧指纹原样成立。
    const historical = await readStudioProductionUnitSnapshot(root, created.unit.id, created.unit.revision);
    expect(historical!.fingerprint).toBe(created.fingerprint);
  });
});

describe("P20 §4-12 零资产格覆盖渲染两分支", () => {
  it("零资产格：空值不渲染覆盖行；非空追加覆盖行（且 5 字段修订不破坏 BindingSet currentness）", async () => {
    const parentRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "p20-zero-asset-")));
    roots.push(parentRoot);
    const { createManagedProject } = await import("../src/core/managed-project.js");
    const root = (await createManagedProject({ parentRoot, name: "P20 零资产格" })).paths.root;
    const fixture = await textFixture(root);
    const created = await createUnit(root, [
      makePanel(fixture.promptRevision.id, { startSeconds: 0, durationSeconds: 10 }),
      makePanel(fixture.promptRevision.id, { startSeconds: 10, durationSeconds: 5 }),
    ], fixture.scriptRevision.id);
    const { freezeAndPersistStudioGenerationPack, readStudioGenerationFrozenPack } = await import("../src/core/studio-generation-ledger.js");

    // 零资产格（panel-1，original 带 spans、assets 空）：零提案分析 → confirmed-empty 裁决 → BindingSet 冻结。
    const analysis = await analyzeStudioPanelAssetMentions(root, {
      unitId: created.unit.id,
      unitRevision: created.unit.revision,
      unitFingerprint: created.fingerprint,
      panelIndex: 1,
      scriptRevisionId: fixture.scriptRevision.id,
      scriptSha256: fixture.scriptRevision.bodySha256,
      mentions: [],
      expectedHeadRevision: 0,
    } as Parameters<typeof analyzeStudioPanelAssetMentions>[1]);
    expect(analysis.proposals).toEqual([]);
    const confirmation = await confirmStudioPanelEntityClosureEmpty(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedConfirmationHeadRevision: 0,
      reviewer: "codex",
      note: "零资产格。",
    });
    await freezeStudioPanelAssetBindingSet(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [],
      emptyConfirmationId: confirmation.id,
    });

    // 空值分支：不渲染覆盖行。
    const emptyFrozen = await freezeAndPersistStudioGenerationPack(root, { unitId: created.unit.id, panelId: created.panels[0]!.id });
    const emptyPack = await readStudioGenerationFrozenPack(root, emptyFrozen.packId);
    expect(emptyPack!.request.modelPayload.renderedPrompt).not.toContain("宫格覆盖");

    // 非空分支：追加覆盖行；5 字段修订后 BindingSet 仍 current（指纹排除 5 字段的运行时证据）。
    const snapshot = await getStudioProductionUnitSnapshot(root, created.unit.id);
    await reviseStudioProductionUnit(root, {
      unitId: created.unit.id,
      expectedRevision: snapshot!.unit.revision,
      season: snapshot!.unit.season,
      episode: snapshot!.unit.episode,
      sequence: snapshot!.unit.sequence,
      title: snapshot!.unit.title,
      scriptRevisionId: snapshot!.unit.scriptRevisionId,
      panels: snapshot!.panels.map((panel, index): StudioProductionPanelInput => ({
        id: panel.id,
        title: panel.title,
        visualAction: panel.visualAction,
        shotComposition: panel.shotComposition,
        filmingMethod: panel.filmingMethod,
        startSeconds: panel.startSeconds,
        durationSeconds: panel.durationSeconds,
        promptRevisionId: panel.promptRevisionId,
        sourceSpans: panel.sourceSpans.map((span) => ({ startOffsetUtf16: span.startOffsetUtf16, endOffsetUtf16: span.endOffsetUtf16 })),
        assets: [],
        transition: panel.transition,
        costumeState: index === 0 ? "整格统一深灰祭服" : panel.costumeState,
        sceneLighting: index === 0 ? "整格统一左侧火光" : panel.sceneLighting,
        shotType: panel.shotType,
        negativePrompt: panel.negativePrompt,
      })),
    });
    const overridden = await freezeAndPersistStudioGenerationPack(root, { unitId: created.unit.id, panelId: created.panels[0]!.id });
    const overriddenPack = await readStudioGenerationFrozenPack(root, overridden.packId);
    const rendered = overriddenPack!.request.modelPayload.renderedPrompt;
    expect(rendered).toContain("服装（宫格覆盖）：整格统一深灰祭服");
    expect(rendered).toContain("光线（宫格覆盖）：整格统一左侧火光");
  }, 60_000);
});

describe("P20 §4-13 1288 单元 / 4235 格双规模迁移读回回归", () => {
  it("程序生成确定性批量行迁移后默认值正确且样本快照可读", async () => {
    const root = await project();
    const fixture = await textFixture(root);
    await initializeStudioProduction(root);
    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");

    // 把 panels 表回滚成 v4 形状（无 5 列），保留旧行（spans 外键不悬空）。
    const rollback = new DatabaseSync(databasePath);
    rollback.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE studio_production_panels RENAME TO studio_production_panels_v5;
      CREATE TABLE studio_production_panels (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        panel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        visual_action TEXT NOT NULL,
        shot_composition TEXT NOT NULL,
        filming_method TEXT NOT NULL,
        dialogue TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        prompt_revision_id TEXT NOT NULL,
        PRIMARY KEY(unit_id, unit_revision, panel_index),
        UNIQUE(unit_id, unit_revision, panel_id)
      ) STRICT;
      INSERT INTO studio_production_panels
        SELECT unit_id, unit_revision, panel_index, panel_id, title, visual_action,
               shot_composition, filming_method, dialogue, subtitle, start_ms, end_ms,
               duration_ms, prompt_revision_id
        FROM studio_production_panels_v5;
      DROP TABLE studio_production_panels_v5;
      -- SQLite RENAME 会把其他表的 FK 重写到 v5 备份名；spans/assets 需同步重建指回新 v4 表。
      ALTER TABLE studio_production_panel_source_spans RENAME TO studio_production_panel_source_spans_old;
      CREATE TABLE studio_production_panel_source_spans (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        span_index INTEGER NOT NULL,
        script_revision_id TEXT NOT NULL,
        script_sha256 TEXT NOT NULL,
        start_offset_utf16 INTEGER NOT NULL,
        end_offset_utf16 INTEGER NOT NULL,
        surface_sha256 TEXT NOT NULL,
        PRIMARY KEY(unit_id, unit_revision, panel_index, span_index)
      ) STRICT;
      INSERT INTO studio_production_panel_source_spans
        SELECT unit_id, unit_revision, panel_index, span_index, script_revision_id,
               script_sha256, start_offset_utf16, end_offset_utf16, surface_sha256
        FROM studio_production_panel_source_spans_old;
      DROP TABLE studio_production_panel_source_spans_old;
      ALTER TABLE studio_production_panel_assets RENAME TO studio_production_panel_assets_old;
      CREATE TABLE studio_production_panel_assets (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        unit_sequence INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        asset_id TEXT NOT NULL,
        category TEXT NOT NULL,
        presence TEXT NOT NULL,
        role TEXT NOT NULL,
        continuity_state TEXT NOT NULL,
        PRIMARY KEY(unit_id, unit_revision, panel_index, asset_id)
      ) STRICT;
      INSERT INTO studio_production_panel_assets
        SELECT unit_id, unit_revision, unit_sequence, panel_index, asset_id, category, presence, role, continuity_state
        FROM studio_production_panel_assets_old;
      DROP TABLE studio_production_panel_assets_old;
      PRAGMA foreign_keys=ON;
    `);
    rollback.close();

    // 程序生成 1288 单元 / 4235 格（1288×3 + 371×1）。
    const db = new DatabaseSync(databasePath);
    const now = "2026-07-19T00:00:00.000Z";
    const insertUnit = db.prepare(`INSERT INTO studio_production_units(
      id, season, episode, sequence, title, revision, duration_ms, panel_count,
      script_revision_id, created_at, updated_at
    ) VALUES(?, 'season-three', 'ep01', ?, ?, 1, 15000, ?, ?, ?, ?)`);
    const insertRevision = db.prepare(`INSERT INTO studio_production_unit_revisions(
      unit_id, revision, season, episode, sequence, title, duration_ms, panel_count,
      script_revision_id, created_at
    ) VALUES(?, 1, 'season-three', 'ep01', ?, ?, 15000, ?, ?, ?)`);
    const insertPanel = db.prepare(`INSERT INTO studio_production_panels(
      unit_id, unit_revision, panel_index, panel_id, title, visual_action,
      shot_composition, filming_method, dialogue, subtitle, start_ms, end_ms,
      duration_ms, prompt_revision_id
    ) VALUES(?, 1, ?, ?, '镜头', '动作', '中景', '固定机位', '', '', ?, ?, ?, ?)`);
    const insertSpan = db.prepare(`INSERT INTO studio_production_panel_source_spans(
      unit_id, unit_revision, panel_index, span_index, script_revision_id,
      script_sha256, start_offset_utf16, end_offset_utf16, surface_sha256
    ) VALUES(?, 1, ?, 1, ?, ?, 0, ?, ?)`);
    const scriptSha = fixture.scriptRevision.bodySha256;
    const bodyLength = SCRIPT_BODY.length;
    const surfaceSha = createHash("sha256").update(SCRIPT_BODY).digest("hex");
    db.exec("BEGIN");
    try {
      for (let unitIndex = 1; unitIndex <= 1288; unitIndex += 1) {
        const unitId = `scale-unit-${String(unitIndex).padStart(4, "0")}`;
        const panelCount = unitIndex <= 371 ? 4 : 3;
        const duration = 15_000 / panelCount;
        insertUnit.run(unitId, unitIndex, `规模单元 ${unitIndex}`, panelCount, fixture.scriptRevision.id, now, now);
        insertRevision.run(unitId, unitIndex, `规模单元 ${unitIndex}`, panelCount, fixture.scriptRevision.id, now);
        for (let panelIndex = 1; panelIndex <= panelCount; panelIndex += 1) {
          const startMs = Math.round((panelIndex - 1) * duration);
          const endMs = Math.round(panelIndex * duration);
          insertPanel.run(unitId, panelIndex, `panel-scale-${unitIndex}-${panelIndex}`, startMs, endMs, endMs - startMs, fixture.promptRevision.id);
          insertSpan.run(unitId, panelIndex, fixture.scriptRevision.id, scriptSha, bodyLength, surfaceSha);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const startedAt = Date.now();
    const state = await initializeStudioProduction(root);
    const migrationMs = Date.now() - startedAt;
    expect(state.schemaVersion).toBe(6);
    const panelTotal = db.prepare("SELECT COUNT(*) AS c FROM studio_production_panels").get() as { c: number };
    expect(panelTotal.c).toBe(4_235);
    const unitTotal = db.prepare("SELECT COUNT(*) AS c FROM studio_production_units").get() as { c: number };
    expect(unitTotal.c).toBe(1_288);
    db.close();

    const sample = await readStudioProductionUnitSnapshot(root, "scale-unit-0001", 1);
    expect(sample).not.toBeNull();
    expect(sample!.panels).toHaveLength(4);
    expect(sample!.panels.every((panel) => panel.shotType === "original" && panel.transition === "" && panel.negativePrompt === "")).toBe(true);
    expect(sample!.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBeCloseTo(15, 5);
    expect(migrationMs).toBeLessThan(30_000);
  }, 120_000);
});
