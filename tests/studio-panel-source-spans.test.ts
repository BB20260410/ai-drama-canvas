import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioCanonicalAsset } from "../src/core/material-studio.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  appendStudioScriptSectionRevision,
  createStudioPanelBindingScopeFingerprint,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getStudioAssetBindingSetCurrentness,
  getStudioMentionIdentityKeyFingerprint,
  getStudioPanelBindingScopeFingerprint,
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
  recordStudioMentionDecision,
  reviseStudioProductionUnit,
  studioIdentityDependencyKey,
  type StudioAssetBindingSourceSnapshot,
  type StudioProductionPanelInput,
  type StudioProductionPanelSourceSpanInput,
  type StudioProductionUnitSnapshot,
} from "../src/core/studio-production.js";

const roots: string[] = [];
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-panel-source-spans-"));
  roots.push(root);
  return root;
}

const SCRIPT_BODY_TEXT = "序😀阿航进入石室，火把照亮完整黄金面具。";
const FULL_BODY_SPAN = [{ startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY_TEXT.length }];

async function fixture(root: string) {
  const script = await createStudioScriptDocument(root, {
    id: "script-source-spans",
    title: "source spans 剧本",
    expectedRevision: 0,
  });  const scriptRevision = (await appendStudioScriptRevision(root, {
    documentId: script.id,
    expectedRevision: 0,
    body: SCRIPT_BODY_TEXT,
    source: "scripts/EP01.md",
    sourceVersion: "script-source-spans-v1",
  })).revision;
  const prompt = await createStudioPromptDocument(root, {
    id: "prompt-source-spans",
    title: "source spans 提示词",
    expectedRevision: 0,
  });
  const promptRevision = (await appendStudioPromptRevision(root, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "电影写实，阿航和完整黄金面具保持连续。",
    source: "prompts/EP01.txt",
    sourceVersion: "prompt-source-spans-v1",
  })).revision;
  return { scriptRevision, promptRevision };
}

function panels(
  promptRevisionId: string,
  firstPanelSourceSpans: StudioProductionPanelSourceSpanInput[] = FULL_BODY_SPAN,
  secondPanelSourceSpans: StudioProductionPanelSourceSpanInput[] = FULL_BODY_SPAN,
): StudioProductionPanelInput[] {
  return [{
    id: "panel-1",
    title: "进入石室",
    visualAction: "阿航进入石室。",
    shotComposition: "中景，主体居中。",
    filmingMethod: "稳定器跟拍。",
    startSeconds: 0,
    endSeconds: 7,
    durationSeconds: 7,
    promptRevisionId,
    sourceSpans: firstPanelSourceSpans,
    assets: [{
      assetId: "character-ahang",
      category: "character",
      presence: "required",
      role: "主体。",
      continuityState: "固定脸、发型与服饰。",
      evidence: [{ kind: "script-source", reference: "scripts/EP01.md" }],
    }],
  }, {
    id: "panel-2",
    title: "看向面具",
    visualAction: "阿航看向布囊。",
    shotComposition: "近景，面具在右下三分点。",
    filmingMethod: "50mm 缓慢推近。",
    startSeconds: 7,
    endSeconds: 15,
    durationSeconds: 8,
    promptRevisionId,
    sourceSpans: secondPanelSourceSpans,
    assets: [{
      assetId: "character-ahang",
      category: "character",
      presence: "required",
      role: "主体。",
      continuityState: "承接上一格站位。",
      evidence: [{ kind: "script-source", reference: "scripts/EP01.md" }],
    }],
  }];
}

async function createUnit(
  root: string,
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  id: string,
  sequence: number,
  sourceSpans?: StudioProductionPanelSourceSpanInput[],
  secondPanelSourceSpans: StudioProductionPanelSourceSpanInput[] = FULL_BODY_SPAN,
): Promise<StudioProductionUnitSnapshot> {
  return createStudioProductionUnit(root, {
    id,
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence,
    title: id,
    scriptRevisionId: fixtureValue.scriptRevision.id,
    panels: panels(fixtureValue.promptRevision.id, sourceSpans, secondPanelSourceSpans),
  });
}

function bindingSource(): StudioAssetBindingSourceSnapshot {
  return {
    assetId: "character-ahang",
    category: "character",
    assetRevision: 1,
    definitionVersionId: "definition-ahang-v1",
    authorityEventId: "authority-ahang-v1",
    authorityVersionId: "authority-version-ahang-v1",
    assetVersionId: "asset-version-ahang-v1",
    mediaSha256: digest("ahang-media"),
    knowledgeFingerprint: digest("ahang-knowledge"),
    applicabilityFingerprint: digest("ahang-applicability"),
  };
}

async function prepareBinding(
  root: string,
  unit: StudioProductionUnitSnapshot,
  suffix: string,
  panelIndex = 1,
  sectionRevisionId?: string,
) {
  const body = unit.scriptRevision.body;
  const start = body.indexOf("阿航");
  const analysis = await analyzeStudioPanelAssetMentions(root, {
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    unitFingerprint: unit.fingerprint,
    panelIndex,
    scriptRevisionId: unit.scriptRevision.id,
    scriptSha256: unit.scriptRevision.bodySha256,
    expectedHeadRevision: 0,
    mentions: [{
      id: `mention-${suffix}`,
      surfaceText: "阿航",
      startOffsetUtf16: start,
      endOffsetUtf16: start + "阿航".length,
      ...(sectionRevisionId ? { sectionRevisionId } : {}),
      category: "character",
      presence: "required",
      role: "主角",
    }],
  });
  const decision = await recordStudioMentionDecision(root, {
    receiptId: `receipt-${suffix}`,
    proposalId: analysis.proposals[0]!.id,
    expectedAnalysisHeadRevision: 1,
    expectedDecisionHeadRevision: 0,
    action: "accept",
    reviewer: "tester",
  });
  return { analysis, decision };
}

async function freezeBinding(
  root: string,
  unit: StudioProductionUnitSnapshot,
  suffix: string,
  panelIndex = 1,
  sectionRevisionId?: string,
) {
  const { analysis, decision } = await prepareBinding(root, unit, suffix, panelIndex, sectionRevisionId);
  return freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: 1,
    expectedBindingHeadRevision: 0,
    decisionReceiptIds: [decision.id],
    assetSources: [bindingSource()],
  });
}

describe("P6 panel 剧本 source spans", () => {
  it("新建、读取与重启均保留 UTF-16 锚点/SHA，表结构为外键、索引和只追加", async () => {
    const root = await project();
    const seeded = await fixture(root);
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("完整黄金面具");
    const inputSpans = [{
      startOffsetUtf16: ahangStart,
      endOffsetUtf16: ahangStart + "阿航".length,
    }, {
      startOffsetUtf16: maskStart,
      endOffsetUtf16: maskStart + "完整黄金面具".length,
    }];

    const created = await createUnit(root, seeded, "unit-source-spans", 1, inputSpans);
    expect(ahangStart).toBe(3);
    expect(created.panels[0]!.sourceSpans).toEqual(inputSpans.map((span) => ({
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      ...span,
      surfaceSha256: digest(body.slice(span.startOffsetUtf16, span.endOffsetUtf16)),
    })));
    expect(created.panels[1]!.sourceSpans).toEqual([{
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: body.length,
      surfaceSha256: digest(body),
    }]);

    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    const rows = db.prepare(`SELECT * FROM studio_production_panel_source_spans
      WHERE unit_id = ? ORDER BY unit_revision, panel_index, span_index`).all(created.unit.id) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => Number(row.span_index))).toEqual([1, 2, 1]);
    expect(new Set((db.prepare("PRAGMA foreign_key_list(studio_production_panel_source_spans)").all() as Array<{ table: string }>).map((row) => row.table)))
      .toEqual(new Set(["studio_production_panels", "studio_text_revisions"]));
    expect((db.prepare("PRAGMA index_list(studio_production_panel_source_spans)").all() as Array<{ name: string }>).map((row) => row.name))
      .toContain("studio_panel_source_spans_script_offset_idx");
    expect(() => db.prepare(`UPDATE studio_production_panel_source_spans
      SET surface_sha256 = surface_sha256 WHERE unit_id = ?`).run(created.unit.id)).toThrow(/append-only/u);
    expect(() => db.prepare("DELETE FROM studio_production_panel_source_spans WHERE unit_id = ?").run(created.unit.id)).toThrow(/append-only/u);
    db.close();

    expect((await initializeStudioProduction(root)).schemaVersion).toBe(6);
    const reopened = await getStudioProductionUnitSnapshot(root, created.unit.id);
    expect(reopened?.fingerprint).toBe(created.fingerprint);
    expect(reopened?.panels.map((panel) => panel.sourceSpans)).toEqual(created.panels.map((panel) => panel.sourceSpans));

    const corrupted = new DatabaseSync(databasePath);
    corrupted.exec("DROP TRIGGER studio_panel_source_spans_no_update");
    corrupted.prepare(`UPDATE studio_production_panel_source_spans SET surface_sha256 = ?
      WHERE unit_id = ? AND unit_revision = 1 AND panel_index = 1 AND span_index = 1`)
      .run("0".repeat(64), created.unit.id);
    corrupted.close();
    await expect(getStudioProductionUnitSnapshot(root, created.unit.id)).rejects.toThrow(/source span SHA/u);
  });

  it("source span 修订进入 unit fingerprint，只使相关单元的 BindingSet stale", async () => {
    const root = await project();
    const seeded = await fixture(root);
    await createStudioCanonicalAsset(root, {
      id: "character-ahang",
      category: "character",
      name: "阿航",
      expectedRevision: 0,
    });
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("完整黄金面具");
    const unitA = await createUnit(root, seeded, "unit-span-a", 1, [{
      startOffsetUtf16: ahangStart,
      endOffsetUtf16: ahangStart + "阿航".length,
    }]);
    const unitB = await createUnit(root, seeded, "unit-span-b", 2, [{
      startOffsetUtf16: ahangStart,
      endOffsetUtf16: ahangStart + "阿航".length,
    }]);
    const bindingA = await freezeBinding(root, unitA, "span-a");
    const bindingB = await freezeBinding(root, unitB, "span-b");
    const dependencyKey = studioIdentityDependencyKey("阿航", "character");
    const context = {
      identityKeyFingerprints: {
        [dependencyKey]: await getStudioMentionIdentityKeyFingerprint(root, "阿航", "character"),
      },
      assets: [bindingSource()],
    };
    expect((await getStudioAssetBindingSetCurrentness(root, bindingA.id, context))?.current).toBe(true);
    expect((await getStudioAssetBindingSetCurrentness(root, bindingB.id, context))?.current).toBe(true);

    const revised = await reviseStudioProductionUnit(root, {
      unitId: unitA.unit.id,
      expectedRevision: unitA.unit.revision,
      season: unitA.unit.season,
      episode: unitA.unit.episode,
      sequence: unitA.unit.sequence,
      title: unitA.unit.title,
      scriptRevisionId: seeded.scriptRevision.id,
      panels: panels(seeded.promptRevision.id, [{
        startOffsetUtf16: maskStart,
        endOffsetUtf16: maskStart + "完整黄金面具".length,
      }]),
    });
    expect(revised.fingerprint).not.toBe(unitA.fingerprint);
    expect(revised.panels[0]!.sourceSpans[0]).toMatchObject({
      startOffsetUtf16: maskStart,
      endOffsetUtf16: maskStart + "完整黄金面具".length,
      surfaceSha256: digest("完整黄金面具"),
    });
    expect((await getStudioAssetBindingSetCurrentness(root, bindingA.id, context))?.staleReasons).toContain("unit-changed");
    expect((await getStudioAssetBindingSetCurrentness(root, bindingB.id, context))?.current).toBe(true);
    expect((await getStudioProductionUnitSnapshot(root, unitB.unit.id))?.fingerprint).toBe(unitB.fingerprint);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    expect((db.prepare(`SELECT unit_revision, start_offset_utf16 FROM studio_production_panel_source_spans
      WHERE unit_id = ? AND panel_index = 1 ORDER BY unit_revision`).all(unitA.unit.id) as Array<{ unit_revision: number; start_offset_utf16: number }>))
      .toEqual([{ unit_revision: 1, start_offset_utf16: ahangStart }, { unit_revision: 2, start_offset_utf16: maskStart }]);
    db.close();
  });

  it("同 unit 仅其他 panel 变化时可用历史 scope 安全冻结且 B 保持 current，相关 section/目标 panel 才使 B stale", async () => {
    const root = await project();
    const seeded = await fixture(root);
    await createStudioCanonicalAsset(root, {
      id: "character-ahang",
      category: "character",
      name: "阿航",
      expectedRevision: 0,
    });
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("完整黄金面具");
    const ahangSpan = [{
      startOffsetUtf16: ahangStart,
      endOffsetUtf16: ahangStart + "阿航".length,
    }];
    const maskSpan = [{
      startOffsetUtf16: maskStart,
      endOffsetUtf16: maskStart + "完整黄金面具".length,
    }];
    const unit = await createUnit(root, seeded, "unit-panel-scope", 1, ahangSpan, ahangSpan);
    const unrelatedUnit = await createUnit(root, seeded, "unit-panel-scope-unrelated", 2, ahangSpan, ahangSpan);
    const section = await appendStudioScriptSectionRevision(root, {
      sectionId: "scene-panel-b",
      expectedRevision: 0,
      kind: "scene",
      title: "石室",
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: body.length,
    });
    const preparedPanelB = await prepareBinding(root, unit, "panel-scope-b", 2, section.id);
    const unrelatedBinding = await freezeBinding(root, unrelatedUnit, "panel-scope-unrelated", 2);
    const dependencyKey = studioIdentityDependencyKey("阿航", "character");
    const context = {
      identityKeyFingerprints: {
        [dependencyKey]: await getStudioMentionIdentityKeyFingerprint(root, "阿航", "character"),
      },
      assets: [bindingSource()],
    };
    const originalPanelAScope = createStudioPanelBindingScopeFingerprint(unit, 1);
    const originalPanelBScope = createStudioPanelBindingScopeFingerprint(unit, 2);
    expect(await getStudioPanelBindingScopeFingerprint(root, unit.unit.id, 2)).toBe(originalPanelBScope);
    expect(await getStudioPanelBindingScopeFingerprint(root, unit.unit.id, 2, unit.unit.revision)).toBe(originalPanelBScope);

    const changedPanelAInput = panels(seeded.promptRevision.id, maskSpan, ahangSpan);
    changedPanelAInput[0]!.visualAction = "火把照亮完整黄金面具。";
    const changedPanelA = await reviseStudioProductionUnit(root, {
      unitId: unit.unit.id,
      expectedRevision: unit.unit.revision,
      season: unit.unit.season,
      episode: unit.unit.episode,
      sequence: unit.unit.sequence,
      title: unit.unit.title,
      scriptRevisionId: seeded.scriptRevision.id,
      panels: changedPanelAInput,
    });
    expect(changedPanelA.fingerprint).not.toBe(unit.fingerprint);
    expect(createStudioPanelBindingScopeFingerprint(changedPanelA, 1)).not.toBe(originalPanelAScope);
    expect(createStudioPanelBindingScopeFingerprint(changedPanelA, 2)).toBe(originalPanelBScope);
    expect(await getStudioPanelBindingScopeFingerprint(root, unit.unit.id, 2)).toBe(originalPanelBScope);
    expect(await getStudioPanelBindingScopeFingerprint(root, unit.unit.id, 2, unit.unit.revision)).toBe(originalPanelBScope);

    const panelBBinding = await freezeStudioPanelAssetBindingSet(root, {
      analysisId: preparedPanelB.analysis.id,
      expectedAnalysisHeadRevision: 1,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [preparedPanelB.decision.id],
      assetSources: [bindingSource()],
    });
    expect(panelBBinding).toMatchObject({
      unitRevision: unit.unit.revision,
      unitFingerprint: unit.fingerprint,
      panelIndex: 2,
    });
    expect((await getStudioAssetBindingSetCurrentness(root, panelBBinding.id, context))?.current).toBe(true);
    expect((await getStudioAssetBindingSetCurrentness(root, unrelatedBinding.id, context))?.current).toBe(true);

    await appendStudioScriptSectionRevision(root, {
      sectionId: section.sectionId,
      expectedRevision: section.revision,
      kind: section.kind,
      title: "石室（修订）",
      scriptRevisionId: section.scriptRevisionId,
      scriptSha256: section.scriptSha256,
      startOffsetUtf16: section.startOffsetUtf16,
      endOffsetUtf16: section.endOffsetUtf16,
    });
    const sectionStale = await getStudioAssetBindingSetCurrentness(root, panelBBinding.id, context);
    expect(sectionStale?.current).toBe(false);
    expect(sectionStale?.staleReasons).toContain(`section-head-changed:${section.sectionId}`);
    expect(sectionStale?.staleReasons).not.toContain("unit-changed");
    expect((await getStudioAssetBindingSetCurrentness(root, unrelatedBinding.id, context))?.current).toBe(true);

    const changedPanelBInput = panels(seeded.promptRevision.id, maskSpan, maskSpan);
    changedPanelBInput[0]!.visualAction = changedPanelAInput[0]!.visualAction;
    changedPanelBInput[1]!.visualAction = "阿航走近完整黄金面具。";
    await reviseStudioProductionUnit(root, {
      unitId: unit.unit.id,
      expectedRevision: changedPanelA.unit.revision,
      season: changedPanelA.unit.season,
      episode: changedPanelA.unit.episode,
      sequence: changedPanelA.unit.sequence,
      title: changedPanelA.unit.title,
      scriptRevisionId: seeded.scriptRevision.id,
      panels: changedPanelBInput,
    });
    const panelStale = await getStudioAssetBindingSetCurrentness(root, panelBBinding.id, context);
    expect(panelStale?.current).toBe(false);
    expect(panelStale?.staleReasons).toContain("unit-changed");
    expect((await getStudioAssetBindingSetCurrentness(root, unrelatedBinding.id, context))?.current).toBe(true);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    expect(db.prepare("SELECT unit_revision, unit_fingerprint FROM studio_asset_binding_sets WHERE id = ?")
      .get(panelBBinding.id)).toEqual({ unit_revision: unit.unit.revision, unit_fingerprint: unit.fingerprint });
    db.close();
  });

  it("binding scope 忽略 unit revision/时间戳和其他 panel，但覆盖 unit 位置/剧本/panelCount 与目标 panel 全部语义", async () => {
    const root = await project();
    const seeded = await fixture(root);
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("完整黄金面具");
    const ahangSpan = [{ startOffsetUtf16: ahangStart, endOffsetUtf16: ahangStart + "阿航".length }];
    const unit = await createUnit(root, seeded, "unit-scope-fields", 1, ahangSpan, ahangSpan);
    const baseline = createStudioPanelBindingScopeFingerprint(unit, 2);

    const unrelated = structuredClone(unit);
    unrelated.unit.revision += 1;
    unrelated.unit.updatedAt = new Date(Date.parse(unrelated.unit.updatedAt) + 1_000).toISOString();
    unrelated.panels[0]!.visualAction = "其他 panel 视觉已变化。";
    unrelated.panels[0]!.sourceSpans = [{
      ...unrelated.panels[0]!.sourceSpans[0]!,
      startOffsetUtf16: maskStart,
      endOffsetUtf16: maskStart + "完整黄金面具".length,
      surfaceSha256: digest("完整黄金面具"),
    }];
    expect(createStudioPanelBindingScopeFingerprint(unrelated, 2)).toBe(baseline);

    const mutations: Array<(snapshot: StudioProductionUnitSnapshot) => void> = [
      (snapshot) => { snapshot.unit.season = "S04"; },
      (snapshot) => { snapshot.unit.episode = "EP02"; },
      (snapshot) => { snapshot.unit.sequence = 2; },
      (snapshot) => {
        snapshot.unit.scriptRevisionId = "script-revision-changed";
        snapshot.scriptRevision.id = "script-revision-changed";
      },
      (snapshot) => { snapshot.unit.panelCount = 3; },
      (snapshot) => { snapshot.panels[1]!.visualAction = "目标 panel 视觉已变化。"; },
      (snapshot) => {
        snapshot.panels[1]!.promptRevisionId = "prompt-revision-changed";
        snapshot.panels[1]!.promptRevision.id = "prompt-revision-changed";
      },
      (snapshot) => {
        snapshot.panels[1]!.sourceSpans = [{
          ...snapshot.panels[1]!.sourceSpans[0]!,
          startOffsetUtf16: maskStart,
          endOffsetUtf16: maskStart + "完整黄金面具".length,
          surfaceSha256: digest("完整黄金面具"),
        }];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(unit);
      mutate(changed);
      expect(createStudioPanelBindingScopeFingerprint(changed, 2)).not.toBe(baseline);
    }
  });

  it("拒绝非整数、空范围、越界、逆序与重叠 span，且失败不落单元", async () => {
    const root = await project();
    const seeded = await fixture(root);
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("完整黄金面具");
    const invalidCases: Array<{ id: string; spans: StudioProductionPanelSourceSpanInput[]; message: RegExp }> = [{
      id: "non-integer",
      spans: [{ startOffsetUtf16: ahangStart + 0.5, endOffsetUtf16: ahangStart + 2 }],
      message: /UTF-16/u,
    }, {
      id: "empty",
      spans: [{ startOffsetUtf16: ahangStart, endOffsetUtf16: ahangStart }],
      message: /UTF-16/u,
    }, {
      id: "out-of-bounds",
      spans: [{ startOffsetUtf16: ahangStart, endOffsetUtf16: body.length + 1 }],
      message: /UTF-16/u,
    }, {
      id: "reverse-order",
      spans: [{
        startOffsetUtf16: maskStart,
        endOffsetUtf16: maskStart + 2,
      }, {
        startOffsetUtf16: ahangStart,
        endOffsetUtf16: ahangStart + 2,
      }],
      message: /升序/u,
    }, {
      id: "overlap",
      spans: [{
        startOffsetUtf16: ahangStart,
        endOffsetUtf16: maskStart + 1,
      }, {
        startOffsetUtf16: maskStart,
        endOffsetUtf16: maskStart + 2,
      }],
      message: /不得重叠/u,
    }];
    for (const invalid of invalidCases) {
      await expect(createUnit(root, seeded, `unit-invalid-${invalid.id}`, 1, invalid.spans)).rejects.toThrow(invalid.message);
    }
    expect((await getStudioProductionState(root)).counts.units).toBe(0);
  });

  it("v1/v2/v3 无 source span 历史库均原位补表并读为空，不从 panel.assets 伪造", async () => {
    for (const schemaVersion of [1, 2, 3]) {
      const root = await project();
      const seeded = await fixture(root);
      const unit = await createUnit(root, seeded, `unit-legacy-empty-${schemaVersion}`, 1, [{
        startOffsetUtf16: 0,
        endOffsetUtf16: seeded.scriptRevision.body.length,
      }]);
      const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
      const db = new DatabaseSync(databasePath);
      db.exec("PRAGMA foreign_keys=OFF; DROP TABLE studio_production_panel_source_spans;");
      db.prepare("UPDATE studio_production_meta SET value = ? WHERE key = 'schema_version'").run(String(schemaVersion));
      db.close();

      expect((await initializeStudioProduction(root)).schemaVersion).toBe(6);
      const snapshot = await getStudioProductionUnitSnapshot(root, unit.unit.id);
      expect(snapshot?.panels.map((panel) => panel.sourceSpans)).toEqual([[], []]);
      expect(snapshot?.panels.every((panel) => panel.assets.length > 0)).toBe(true);
    }
  });
});
