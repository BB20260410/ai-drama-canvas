import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioCanonicalAsset } from "../src/core/material-studio.js";
import {
  StudioProductionConflictError,
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  appendStudioScriptSectionRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getCurrentStudioPanelAssetBindingSet,
  getStudioAssetBindingReadiness,
  getStudioAssetBindingSet,
  getStudioMentionIdentityKeyFingerprint,
  getStudioProductionState,
  initializeStudioProduction,
  listStudioAssetBindingSets,
  recordStudioMentionDecision,
  studioIdentityDependencyKey,
  type StudioAssetBindingSourceSnapshot,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";

const roots: string[] = [];
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "studio-bindings-"));
  roots.push(value);
  return value;
}

async function fixture(projectRoot: string) {
  const script = await createStudioScriptDocument(projectRoot, { id: "script-ep01", title: "EP01", expectedRevision: 0 });
  const scriptRevision = (await appendStudioScriptRevision(projectRoot, {
    documentId: script.id,
    expectedRevision: 0,
    body: "第一章😀阿航进入石室，布囊里的黄金面具不可露出。",
    source: "EP01.md",
    sourceVersion: "v1",
  })).revision;
  const prompt = await createStudioPromptDocument(projectRoot, { id: "prompt-ep01", title: "EP01 prompt", expectedRevision: 0 });
  const promptRevision = (await appendStudioPromptRevision(projectRoot, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "电影写实，角色与场景保持一致。",
    source: "EP01.txt",
    sourceVersion: "v1",
  })).revision;
  const panels: StudioProductionPanelInput[] = [0, 1].map((index) => ({
    id: `panel-${index + 1}`,
    title: `镜头${index + 1}`,
    visualAction: "阿航进入石室。",
    shotComposition: "中景。",
    filmingMethod: "固定机位。",
    startSeconds: index === 0 ? 0 : 7,
    durationSeconds: index === 0 ? 7 : 8,
    endSeconds: index === 0 ? 7 : 15,
    promptRevisionId: promptRevision.id,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptRevision.body.length }],
    assets: [{
      assetId: "legacy-ahang",
      category: "character",
      presence: "required",
      role: "旧声明，不得自动成为 P6 BindingSet。",
      continuityState: "legacy-unreviewed",
      evidence: [{ kind: "legacy", reference: "legacy" }],
    }],
  }));
  const unit = await createStudioProductionUnit(projectRoot, {
    id: "unit-ep01-001",
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "第一单元",
    scriptRevisionId: scriptRevision.id,
    panels,
    expectedRevision: 0,
  });
  const ahang = await createStudioCanonicalAsset(projectRoot, {
    id: "character-ahang",
    category: "character",
    name: "阿航",
    aliases: ["青年阿航"],
    expectedRevision: 0,
  });
  return { scriptRevision, promptRevision, unit, ahang };
}

function source(assetId = "character-ahang"): StudioAssetBindingSourceSnapshot {
  return {
    assetId,
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

describe("P6 追加式剧本资产提案与 BindingSet", () => {
  it("空库及有数据 v2 原位升级 v3，旧 panel.assets 不会伪造确认记录", async () => {
    const projectRoot = await root();
    const seeded = await fixture(projectRoot);
    const dbPath = path.join(projectRoot, ".aicanvas", "studio-production.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys=OFF");
    for (const table of [
      "studio_asset_binding_set_heads", "studio_asset_binding_dependencies", "studio_asset_binding_mentions",
      "studio_asset_bindings", "studio_asset_binding_sets", "studio_asset_mention_decisions",
      "studio_asset_mention_candidates", "studio_asset_mention_proposals", "studio_asset_mention_analysis_heads",
      "studio_asset_mention_analyses", "studio_script_section_heads", "studio_script_section_revisions",
    ]) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare("UPDATE studio_production_meta SET value = '2' WHERE key = 'schema_version'").run();
    db.close();

    const state = await initializeStudioProduction(projectRoot);
    expect(state.schemaVersion).toBe(6);
    expect(state.counts).toMatchObject({ mentionAnalyses: 0, mentionDecisions: 0, assetBindingSets: 0 });
    expect((await getStudioProductionState(projectRoot)).counts.units).toBe(1);
    expect((await listStudioAssetBindingSets(projectRoot)).items).toEqual([]);
    expect(await getCurrentStudioPanelAssetBindingSet(projectRoot, seeded.unit.unit.id, "panel-1")).toBeNull();
  });

  it("验证 UTF-16 span/SHA，exact 唯一命中仍须人工 accept，CAS 冻结并可重启读取", async () => {
    const projectRoot = await root();
    const seeded = await fixture(projectRoot);
    const body = seeded.scriptRevision.body;
    const chapterEnd = body.indexOf("，") + 1;
    const section = await appendStudioScriptSectionRevision(projectRoot, {
      sectionId: "chapter-01",
      expectedRevision: 0,
      kind: "chapter",
      title: "第一章",
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: chapterEnd,
    });
    const start = body.indexOf("阿航");
    await expect(analyzeStudioPanelAssetMentions(projectRoot, {
      unitId: seeded.unit.unit.id,
      unitRevision: 1,
      unitFingerprint: seeded.unit.fingerprint,
      panelIndex: 1,
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      expectedHeadRevision: 0,
      mentions: [{ id: "mention-bad", surfaceText: "阿航错", startOffsetUtf16: start, endOffsetUtf16: start + 2, category: "character", presence: "required", role: "主角" }],
    })).rejects.toThrow(/surfaceText.*slice/u);

    const analysis = await analyzeStudioPanelAssetMentions(projectRoot, {
      unitId: seeded.unit.unit.id,
      unitRevision: 1,
      unitFingerprint: seeded.unit.fingerprint,
      panelIndex: 1,
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      expectedHeadRevision: 0,
      mentions: [{
        id: "mention-ahang",
        surfaceText: "阿航",
        startOffsetUtf16: start,
        endOffsetUtf16: start + 2,
        sectionRevisionId: section.id,
        category: "character",
        presence: "required",
        role: "主角",
      }],
    });
    expect(analysis.proposals[0]).toMatchObject({ status: "matched", candidates: [{ kind: "formal-name", assetId: "character-ahang" }] });
    await expect(freezeStudioPanelAssetBindingSet(projectRoot, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: 1,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [],
      assetSources: [source()],
    })).rejects.toThrow(/缺少人工 decision/u);

    const decision = await recordStudioMentionDecision(projectRoot, {
      receiptId: "receipt-ahang-accept",
      proposalId: analysis.proposals[0]!.id,
      expectedAnalysisHeadRevision: 1,
      expectedDecisionHeadRevision: 0,
      action: "accept",
      reviewer: "human-reviewer",
    });
    const bindingSet = await freezeStudioPanelAssetBindingSet(projectRoot, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: 1,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: [decision.id],
      assetSources: [source()],
    });
    expect(bindingSet).toMatchObject({ revision: 1, decisionReceiptIds: [decision.id], unresolvedOptionalMentionIds: [] });
    expect(bindingSet.bindings[0]).toMatchObject({ assetId: "character-ahang", presence: "required", mentionIds: ["mention-ahang"] });
    expect((await getStudioAssetBindingSet(projectRoot, bindingSet.id))?.fingerprint).toBe(bindingSet.fingerprint);
    expect((await getCurrentStudioPanelAssetBindingSet(projectRoot, seeded.unit.unit.id, "panel-1"))?.id).toBe(bindingSet.id);
    expect((await initializeStudioProduction(projectRoot)).counts.assetBindingSets).toBe(1);
    const db = new DatabaseSync(path.join(projectRoot, ".aicanvas", "studio-production.sqlite"));
    expect(() => db.prepare("UPDATE studio_asset_binding_sets SET created_at = created_at WHERE id = ?").run(bindingSet.id)).toThrow(/append-only/u);
    db.close();
  });

  it("同一宫格重析可保留未变化提案并追加新提案，历史 proposal 身份不冲突", async () => {
    const projectRoot = await root();
    const seeded = await fixture(projectRoot);
    await createStudioCanonicalAsset(projectRoot, {
      id: "prop-golden-mask",
      category: "prop",
      name: "黄金面具",
      expectedRevision: 0,
    });
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("黄金面具");
    const first = await analyzeStudioPanelAssetMentions(projectRoot, {
      unitId: seeded.unit.unit.id,
      unitRevision: 1,
      unitFingerprint: seeded.unit.fingerprint,
      panelIndex: 1,
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      expectedHeadRevision: 0,
      mentions: [{
        id: "mention-ahang",
        surfaceText: "阿航",
        startOffsetUtf16: ahangStart,
        endOffsetUtf16: ahangStart + "阿航".length,
        category: "character",
        presence: "required",
        role: "主角",
      }],
    });
    const second = await analyzeStudioPanelAssetMentions(projectRoot, {
      unitId: seeded.unit.unit.id,
      unitRevision: 1,
      unitFingerprint: seeded.unit.fingerprint,
      panelIndex: 1,
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      expectedHeadRevision: 1,
      mentions: [{
        id: "mention-ahang",
        surfaceText: "阿航",
        startOffsetUtf16: ahangStart,
        endOffsetUtf16: ahangStart + "阿航".length,
        category: "character",
        presence: "required",
        role: "主角",
      }, {
        id: "mention-mask",
        surfaceText: "黄金面具",
        startOffsetUtf16: maskStart,
        endOffsetUtf16: maskStart + "黄金面具".length,
        category: "prop",
        presence: "forbidden",
        role: "本镜不得露出",
      }],
    });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.proposals).toHaveLength(2);
    expect(second.proposals.find((proposal) => proposal.mentionId === "mention-ahang")?.id)
      .not.toBe(first.proposals[0]?.id);
    expect(second.proposals.find((proposal) => proposal.mentionId === "mention-mask"))
      .toMatchObject({ status: "matched", candidates: [{ assetId: "prop-golden-mask" }] });
  });

  it("歧义与模型建议不自动匹配，人工 select/exclude 生效，forbidden 未决阻断", async () => {
    const projectRoot = await root();
    const seeded = await fixture(projectRoot);
    await createStudioCanonicalAsset(projectRoot, {
      id: "character-ahang-other",
      category: "character",
      name: "阿航",
      expectedRevision: 0,
    });
    const body = seeded.scriptRevision.body;
    const ahangStart = body.indexOf("阿航");
    const maskStart = body.indexOf("黄金面具");
    const analysis = await analyzeStudioPanelAssetMentions(projectRoot, {
      unitId: seeded.unit.unit.id,
      unitRevision: 1,
      unitFingerprint: seeded.unit.fingerprint,
      panelIndex: 1,
      scriptRevisionId: seeded.scriptRevision.id,
      scriptSha256: seeded.scriptRevision.bodySha256,
      expectedHeadRevision: 0,
      mentions: [{ id: "ambiguous", surfaceText: "阿航", startOffsetUtf16: ahangStart, endOffsetUtf16: ahangStart + 2, category: "character", presence: "required", role: "主角" }, {
        id: "forbidden-mask", surfaceText: "黄金面具", startOffsetUtf16: maskStart, endOffsetUtf16: maskStart + 4, category: "prop", presence: "forbidden", role: "禁止露出",
      }],
    });
    expect(analysis.proposals.map((proposal) => proposal.status)).toEqual(["ambiguous", "unmatched"]);
    const select = await recordStudioMentionDecision(projectRoot, {
      receiptId: "receipt-select-ahang", proposalId: analysis.proposals[0]!.id, expectedAnalysisHeadRevision: 1,
      expectedDecisionHeadRevision: 0,
      action: "select", selectedAssetId: "character-ahang", reviewer: "human",
    });
    await expect(freezeStudioPanelAssetBindingSet(projectRoot, {
      analysisId: analysis.id, expectedAnalysisHeadRevision: 1, expectedBindingHeadRevision: 0,
      decisionReceiptIds: [select.id], assetSources: [source()],
    })).rejects.toThrow(/forbidden.*缺少人工/u);
    const exclude = await recordStudioMentionDecision(projectRoot, {
      receiptId: "receipt-exclude-mask", proposalId: analysis.proposals[1]!.id, expectedAnalysisHeadRevision: 1,
      expectedDecisionHeadRevision: 0,
      action: "exclude", reviewer: "human", note: "这里是禁露规则语句，不作为可见资产提及。",
    });
    const frozen = await freezeStudioPanelAssetBindingSet(projectRoot, {
      analysisId: analysis.id, expectedAnalysisHeadRevision: 1, expectedBindingHeadRevision: 0,
      decisionReceiptIds: [select.id, exclude.id], assetSources: [source()],
    });
    expect(frozen.bindings).toHaveLength(1);
    await expect(recordStudioMentionDecision(projectRoot, {
      receiptId: "receipt-stale", proposalId: analysis.proposals[0]!.id, expectedAnalysisHeadRevision: 2,
      expectedDecisionHeadRevision: 1,
      action: "select", selectedAssetId: "character-ahang", reviewer: "human",
    })).rejects.toBeInstanceOf(StudioProductionConflictError);
  });

  it("currentness 只因同 identity key 或绑定资产语义变化失效，无关资产不失效", async () => {
    const projectRoot = await root();
    const seeded = await fixture(projectRoot);
    const body = seeded.scriptRevision.body;
    const start = body.indexOf("阿航");
    const analysis = await analyzeStudioPanelAssetMentions(projectRoot, {
      unitId: seeded.unit.unit.id, unitRevision: 1, unitFingerprint: seeded.unit.fingerprint, panelIndex: 1,
      scriptRevisionId: seeded.scriptRevision.id, scriptSha256: seeded.scriptRevision.bodySha256, expectedHeadRevision: 0,
      mentions: [{ id: "mention-ahang", surfaceText: "阿航", startOffsetUtf16: start, endOffsetUtf16: start + 2, category: "character", presence: "required", role: "主角" }],
    });
    const decision = await recordStudioMentionDecision(projectRoot, {
      receiptId: "receipt-current", proposalId: analysis.proposals[0]!.id, expectedAnalysisHeadRevision: 1,
      expectedDecisionHeadRevision: 0,
      action: "accept", reviewer: "human",
    });
    const frozen = await freezeStudioPanelAssetBindingSet(projectRoot, {
      analysisId: analysis.id, expectedAnalysisHeadRevision: 1, expectedBindingHeadRevision: 0,
      decisionReceiptIds: [decision.id], assetSources: [source()],
    });
    const dependencyKey = studioIdentityDependencyKey("阿航", "character");
    const initialIdentity = await getStudioMentionIdentityKeyFingerprint(projectRoot, "阿航", "character");
    const current = await getStudioAssetBindingReadiness(projectRoot, frozen.id, {
      identityKeyFingerprints: { [dependencyKey]: initialIdentity }, assets: [source()],
    });
    expect(current).toMatchObject({ ready: true, current: true, staleReasons: [] });

    await createStudioCanonicalAsset(projectRoot, { id: "prop-unrelated", category: "prop", name: "火把", expectedRevision: 0 });
    const unchangedIdentity = await getStudioMentionIdentityKeyFingerprint(projectRoot, "阿航", "character");
    expect(unchangedIdentity).toBe(initialIdentity);
    expect((await getStudioAssetBindingReadiness(projectRoot, frozen.id, {
      identityKeyFingerprints: { [dependencyKey]: unchangedIdentity }, assets: [source()],
    }))?.ready).toBe(true);

    await createStudioCanonicalAsset(projectRoot, { id: "character-collision", category: "character", name: "阿航", expectedRevision: 0 });
    const collidedIdentity = await getStudioMentionIdentityKeyFingerprint(projectRoot, "阿航", "character");
    const staleIdentity = await getStudioAssetBindingReadiness(projectRoot, frozen.id, {
      identityKeyFingerprints: { [dependencyKey]: collidedIdentity }, assets: [source()],
    });
    expect(staleIdentity?.ready).toBe(false);
    expect(staleIdentity?.staleReasons).toContain(`identity-key-changed:${dependencyKey}`);

    const changedSource = { ...source(), knowledgeFingerprint: digest("changed") };
    const staleAsset = await getStudioAssetBindingReadiness(projectRoot, frozen.id, {
      identityKeyFingerprints: { [dependencyKey]: initialIdentity }, assets: [changedSource],
    });
    expect(staleAsset?.staleReasons).toContain("asset-semantic-changed:character-ahang");
  });
});
