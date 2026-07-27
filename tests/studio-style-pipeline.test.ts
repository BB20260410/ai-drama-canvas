import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import { createPanelReferenceResolution } from "../src/core/panel-reference-resolution-core.js";
import { buildStudioUnitGridGenerationFreezePack } from "../src/core/studio-unit-grid-generation.js";
import { queryStudioGenerationFreeze } from "../src/core/studio-generation.js";
import { assertNineFieldCoverage, planContinuityFieldsForSubject } from "../src/core/studio-continuity-explicit-plan.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  initializeStudioProduction,
  recordStudioMentionDecision,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import {
  bindReadyUnitGridPanel,
  createUnitGridFixtureProject,
  createUnitGridTestImage,
  unitGridFixtureContinuationWaiver,
} from "./helpers/studio-unit-grid-fixture.js";

const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

describe("受管 Studio style 风格资产贯穿链", () => {
  it("style 可进入单元、提及、人工决策、BindingSet 与中立引用解析，且不会被重标为道具", async () => {
    const root = await temporaryRoot("studio-style-pipeline-");
    const scriptDocument = await createStudioScriptDocument(root, {
      id: "script-style",
      title: "风格测试剧本",
      expectedRevision: 0,
    });
    const script = (await appendStudioScriptRevision(root, {
      documentId: scriptDocument.id,
      expectedRevision: 0,
      body: "本镜保持古蜀青铜壁画风格。",
      source: "S1E2.md",
      sourceVersion: "v1",
    })).revision;
    const promptDocument = await createStudioPromptDocument(root, {
      id: "prompt-style",
      title: "风格测试提示词",
      expectedRevision: 0,
    });
    const prompt = (await appendStudioPromptRevision(root, {
      documentId: promptDocument.id,
      expectedRevision: 0,
      body: "古蜀青铜壁画风格，角色身份锁优先。",
      source: "S1E2.prompt.txt",
      sourceVersion: "v1",
    })).revision;
    const style = await createStudioCanonicalAsset(root, {
      id: "style-gushu-bronze-mural",
      category: "style",
      name: "古蜀青铜壁画风格",
      aliases: ["青铜壁画风"],
      expectedRevision: 0,
    });
    const panels: StudioProductionPanelInput[] = [
      { id: "panel-1", startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
      { id: "panel-2", startSeconds: 7, endSeconds: 15, durationSeconds: 8 },
    ].map((timing, index) => ({
      ...timing,
      title: `镜头 ${index + 1}`,
      visualAction: "角色沿神树向上观察。",
      shotComposition: "中景，轴线稳定。",
      filmingMethod: "克制微推。",
      promptRevisionId: prompt.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: script.body.length }],
      assets: [{
        assetId: style.id,
        category: "style",
        presence: "required",
        role: "只约束全片色彩、材质和光影，不替代角色、场景或道具身份。",
        continuityState: "两格保持同一古蜀青铜壁画视觉语法。",
        evidence: [{ kind: "style-lock", reference: style.id }],
      }],
    }));
    const unit = await createStudioProductionUnit(root, {
      id: "unit-style-001",
      season: "S1",
      episode: "E2",
      sequence: 1,
      title: "风格链测试",
      scriptRevisionId: script.id,
      panels,
      expectedRevision: 0,
    });
    const start = script.body.indexOf("古蜀青铜壁画风格");
    const analysis = await analyzeStudioPanelAssetMentions(root, {
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      unitFingerprint: unit.fingerprint,
      panelIndex: 1,
      scriptRevisionId: script.id,
      scriptSha256: script.bodySha256,
      expectedHeadRevision: 0,
      mentions: [{
        id: "mention-style",
        surfaceText: "古蜀青铜壁画风格",
        startOffsetUtf16: start,
        endOffsetUtf16: start + "古蜀青铜壁画风格".length,
        category: "style",
        presence: "required",
        role: "画风硬锁",
      }],
    });
    expect(analysis.proposals[0]).toMatchObject({
      category: "style",
      status: "matched",
      candidates: [{ assetId: style.id, category: "style" }],
    });
    const decision = await recordStudioMentionDecision(root, {
      receiptId: "style-decision-001",
      proposalId: analysis.proposals[0]!.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: 0,
      action: "accept",
      reviewer: "style-pipeline-test",
    });
    const binding = await freezeStudioPanelAssetBindingSet(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [decision.id],
      assetSources: [{
        assetId: style.id,
        category: "style",
        assetRevision: style.revision,
        definitionVersionId: style.currentDefinitionVersionId,
        authorityEventId: "style-authority-event-v1",
        authorityVersionId: "style-authority-version-v1",
        assetVersionId: "style-media-version-v1",
        mediaSha256: sha("style-media"),
        knowledgeFingerprint: sha("style-knowledge"),
        applicabilityFingerprint: sha("style-applicability"),
      }],
    });
    expect(binding.bindings).toHaveLength(1);
    expect(binding.bindings[0]).toMatchObject({ assetId: style.id, category: "style" });

    const resolution = createPanelReferenceResolution({
      project: { id: "project-style" },
      unit: { id: unit.unit.id, revision: 1 },
      panel: { id: "panel-1", index: 1, count: 2 },
      time: { unitLocalStartSeconds: 0, unitLocalEndSeconds: 7 },
      sourceSpans: [{
        id: "span-style",
        kind: "text",
        coordinateSystem: "utf16-code-unit",
        sourceId: script.id,
        sourceFingerprint: script.bodySha256,
        start,
        end: start + "古蜀青铜壁画风格".length,
        surfaceFingerprint: sha("古蜀青铜壁画风格"),
      }],
      semanticAssets: [{
        assetId: style.id,
        category: "style",
        presence: "required",
        role: "画风硬锁",
        sourceSpanIds: ["span-style"],
      }],
    });
    expect(resolution.semanticAssets[0]?.category).toBe("style");
    const continuityPlan = planContinuityFieldsForSubject({
      assetId: style.id,
      category: "style",
      role: "画风硬锁",
      mediaSha256: sha("style-media"),
      visualAction: "保持两格风格连续。",
      panelIndex: 1,
      startMilliseconds: 0,
      endMilliseconds: 7_000,
    });
    assertNineFieldCoverage(continuityPlan);
    expect(continuityPlan.find((entry) => entry.field === "position")?.state.status).toBe("not-applicable");
    expect(continuityPlan.find((entry) => entry.field === "layout")?.state).toMatchObject({
      status: "resolved",
      value: expect.stringContaining("不得借画风改写角色"),
    });
  });

  it("同一 schemaVersion=6 的旧 CHECK 表会原位放宽为 style，并恢复索引与追加式触发器", async () => {
    const root = await temporaryRoot("studio-style-migration-");
    await initializeStudioProduction(root);
    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA foreign_keys=OFF;
      PRAGMA legacy_alter_table=ON;
      BEGIN IMMEDIATE;
      ALTER TABLE studio_asset_mention_candidates RENAME TO studio_asset_mention_candidates_old_style_test;
      CREATE TABLE studio_asset_mention_candidates (
        proposal_id TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 100),
        kind TEXT NOT NULL CHECK(kind IN ('id', 'formal-name', 'alias', 'model')),
        asset_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('character', 'scene', 'prop')),
        matched_value TEXT NOT NULL,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
        PRIMARY KEY(proposal_id, rank),
        UNIQUE(proposal_id, kind, asset_id),
        FOREIGN KEY(proposal_id) REFERENCES studio_asset_mention_proposals(id) ON DELETE RESTRICT
      ) STRICT;
      DROP TABLE studio_asset_mention_candidates_old_style_test;
      COMMIT;
    `);
    db.close();

    expect((await initializeStudioProduction(root)).schemaVersion).toBe(6);
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    const sql = String((verified.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='studio_asset_mention_candidates'",
    ).get() as { sql?: string }).sql);
    const trigger = verified.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='studio_mention_candidates_no_update'",
    ).get();
    const index = verified.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='studio_mention_candidates_asset_idx'",
    ).get();
    verified.close();
    expect(sql).toContain("'style'");
    expect(trigger).toBeTruthy();
    expect(index).toBeTruthy();
  });

  it("unit-grid 的正式渲染提示词把 style 明确写作风格，不会降级成道具", async () => {
    const parent = await temporaryRoot("studio-style-grid-");
    const fixture = await createUnitGridFixtureProject(parent);
    const media = await createUnitGridTestImage(fixture.root, "style-authority", "#27403b");
    const created = await createStudioCanonicalAsset(fixture.root, {
      id: "style-gushu-bronze-mural",
      category: "style",
      name: "古蜀青铜壁画风格",
      identityFeatures: ["青铜绿锈", "暗金矿物颗粒"],
      positiveLocks: ["保持古蜀青铜壁画色彩与材质"],
      negativeLocks: ["禁止现代霓虹调色", "禁止塑料质感"],
      defaultPrompt: "古蜀青铜壁画风格，只约束画风。",
      expectedRevision: 0,
    });
    const version = await appendStudioAssetVersion(fixture.root, {
      assetId: created.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      expectedRevision: created.revision,
    });
    const reviewed = await reviewStudioAssetVersion(fixture.root, {
      assetId: created.id,
      versionId: version.version.id,
      decision: "approved",
      expectedRevision: version.assetRevision,
      note: "风格权威图通过。",
    });
    await setStudioPrimaryAuthority(fixture.root, {
      assetId: created.id,
      versionId: version.version.id,
      expectedRevision: reviewed.revision,
      note: "锁定风格母版。",
    });
    const panels: StudioProductionPanelInput[] = [
      { id: "style-panel-1", startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
      { id: "style-panel-2", startSeconds: 7, endSeconds: 15, durationSeconds: 8 },
    ].map((timing, index) => ({
      ...timing,
      title: `风格镜头 ${index + 1}`,
      visualAction: index === 0 ? "神树纹样显现。" : "镜头沿纹样上移。",
      shotComposition: "中景，主体居中。",
      filmingMethod: "稳定微推。",
      promptRevisionId: fixture.promptRevisionId,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 2 }],
      assets: [{
        assetId: created.id,
        category: "style",
        presence: "required",
        role: "全镜画风硬锁，不改变人物与道具身份。",
        continuityState: "两格色彩、笔触和材质一致。",
        evidence: [{ kind: "style-authority", reference: version.version.id }],
      }],
    }));
    await createStudioProductionUnit(fixture.root, {
      id: "unit-style-grid",
      season: fixture.season,
      episode: fixture.episode,
      sequence: 2,
      title: "风格提示词测试",
      scriptRevisionId: fixture.scriptRevisionId,
      panels,
      expectedRevision: 0,
    });
    await bindReadyUnitGridPanel(fixture.root, "unit-style-grid", "style-panel-1");
    await bindReadyUnitGridPanel(fixture.root, "unit-style-grid", "style-panel-2");
    const panelProbe = await queryStudioGenerationFreeze(fixture.root, {
      unitId: "unit-style-grid",
      panelId: "style-panel-1",
    });
    if (panelProbe.status !== "ready") throw new Error(JSON.stringify(panelProbe));

    const pack = await buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-style-grid",
      verifiedHistoricalImportContinuationWaiver: await unitGridFixtureContinuationWaiver(
        fixture.root,
        "unit-style-grid",
        "fixture:style-pipeline:grid",
      ),
    });
    expect(pack.request.modelPayload.renderedPrompt).toContain("风格「古蜀青铜壁画风格」");
    expect(pack.request.modelPayload.renderedPrompt).not.toContain("道具「古蜀青铜壁画风格」");
    expect(pack.request.controlReferences).toEqual([
      expect.objectContaining({ coveredAssetIds: [created.id], categories: ["style"] }),
    ]);
  });
});
