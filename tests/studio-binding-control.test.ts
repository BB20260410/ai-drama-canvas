import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  type StudioCanonicalAssetCategory,
} from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  analyzeStudioScriptEntities,
  freezeStudioAssetBindingSetFromControl,
  getStudioBindingControl,
  proveStudioBindingOperationOutcome,
  resolveStudioEntityProposal,
} from "../src/core/studio-binding-control.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  appendStudioScriptSectionRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioAssetBindingSet,
  getCurrentStudioMentionDecision,
  getCurrentStudioPanelAssetMentionAnalysis,
  getCurrentStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  reviseStudioProductionUnit,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import {
  assertStudioGenerationFreezePackCurrent,
  buildStudioGenerationFreezePack,
} from "../src/core/studio-generation.js";
import { seedStudioP7ResolvedPanelContinuity } from "./helpers/studio-p7-fixture.js";

const roots: string[] = [];
const SCRIPT_BODY = "金面与守卫在门前，玄鸟使者旁观。";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function requestHash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

async function managedProject(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-binding-control-")));
  roots.push(parent);
  return (await createManagedProject({ parentRoot: parent, name: "P6 Binding Control 纵向测试" })).paths.root;
}

async function authoritativeAsset(
  root: string,
  input: {
    id: string;
    category: StudioCanonicalAssetCategory;
    name: string;
    aliases: string[];
    color: string;
  },
) {
  const sourcePath = path.join(root, `${input.id}.png`);
  await sharp({ create: { width: 80, height: 120, channels: 3, background: input.color } }).png().toFile(sourcePath);
  const media = await importStudioMedia(root, { sourcePath });
  const created = await createStudioCanonicalAsset(root, {
    id: input.id,
    expectedRevision: 0,
    category: input.category,
    name: input.name,
    aliases: input.aliases,
    identityFeatures: [`${input.name} 固定身份`],
    positiveLocks: ["保持当前 approved 权威图"],
    negativeLocks: ["禁止串换身份"],
    defaultPrompt: `${input.name}，电影写实。`,
  });
  const version = await appendStudioAssetVersion(root, {
    assetId: created.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    expectedRevision: created.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: created.id,
    versionId: version.version.id,
    decision: "approved",
    expectedRevision: version.assetRevision,
    note: "Binding Control 纵向测试审核通过。",
  });
  return setStudioPrimaryAuthority(root, {
    assetId: created.id,
    versionId: version.version.id,
    expectedRevision: reviewed.revision,
    note: "Binding Control 当前主权威。",
  });
}

async function fixture(withSourceSpan: boolean) {
  const root = await managedProject();
  await authoritativeAsset(root, {
    id: "prop-mask",
    category: "prop",
    name: "完整黄金面具",
    aliases: ["金面"],
    color: "#9b7423",
  });
  await authoritativeAsset(root, {
    id: "character-guard-a",
    category: "character",
    name: "甲卫",
    aliases: ["守卫"],
    color: "#4a4038",
  });
  await authoritativeAsset(root, {
    id: "character-guard-b",
    category: "character",
    name: "乙卫",
    aliases: ["守卫"],
    color: "#38424a",
  });
  const scriptDocument = await createStudioScriptDocument(root, {
    id: "script-binding-control",
    title: "Binding Control 剧本",
    expectedRevision: 0,
  });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: SCRIPT_BODY,
    source: "scripts/EP01.md",
    sourceVersion: "v1",
  });
  const promptDocument = await createStudioPromptDocument(root, {
    id: "prompt-binding-control",
    title: "Binding Control 提示词",
    expectedRevision: 0,
  });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "电影写实，保持身份与道具铁律。",
    source: "prompts/EP01.txt",
    sourceVersion: "v1",
  });
  const panelAssets: StudioProductionPanelInput["assets"] = [{
    assetId: "prop-mask",
    category: "prop",
    presence: "forbidden",
    role: "布囊内身份铁律，当前不得出画。",
    continuityState: "完整黄金面具保持隐藏。",
    evidence: [{ kind: "hard-lock", reference: "mask-lock" }],
  }, {
    assetId: "character-guard-a",
    category: "character",
    presence: "required",
    role: "门口守卫。",
    continuityState: "站位保持。",
    evidence: [{ kind: "script", reference: script.revision.id }],
  }, {
    assetId: "character-guard-b",
    category: "character",
    presence: "required",
    role: "门口守卫。",
    continuityState: "站位保持。",
    evidence: [{ kind: "script", reference: script.revision.id }],
  }];
  const panels: StudioProductionPanelInput[] = [{
    id: "panel-01",
    title: "门前",
    visualAction: "守卫守在门前，黄金面具不得出现。",
    shotComposition: "中景。",
    filmingMethod: "固定机位。",
    dialogue: "",
    subtitle: "",
    startSeconds: 0,
    endSeconds: 7,
    durationSeconds: 7,
    promptRevisionId: prompt.revision.id,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: script.revision.body.length }],
    assets: panelAssets,
  }, {
    id: "panel-02",
    title: "门内",
    visualAction: "镜头转向门内。",
    shotComposition: "近景。",
    filmingMethod: "缓慢推近。",
    dialogue: "",
    subtitle: "",
    startSeconds: 7,
    endSeconds: 15,
    durationSeconds: 8,
    promptRevisionId: prompt.revision.id,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: script.revision.body.length }],
    assets: panelAssets,
  }];
  const unit = await createStudioProductionUnit(root, {
    id: "unit-binding-control",
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "Binding Control 纵向单元",
    scriptRevisionId: script.revision.id,
    panels,
  });
  if (!withSourceSpan) {
    // 需要零 spans 的用例：模拟 P20 前存量（摘除 append-only 触发器后删除 spans 行）。
    const databasePath = path.join(root, ".aicanvas", "studio-production.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("DROP TRIGGER IF EXISTS studio_panel_source_spans_no_delete");
    db.prepare("DELETE FROM studio_production_panel_source_spans WHERE unit_id = ?").run(unit.unit.id);
    db.close();
    return { root, unit: (await getStudioProductionUnitSnapshot(root, unit.unit.id))!, script, panels };
  }
  return { root, unit, script, panels };
}

async function analyzeAndResolveMaskGuard(root: string, unitId: string, label: string) {
  let control = await getStudioBindingControl(root, { unitId });
  await analyzeStudioScriptEntities(root, {
    unitId,
    panelId: "panel-01",
    expectedRevisionToken: control.revisionToken,
  }, { requestHash: requestHash(`${label}-analyze`), reviewer: "codex" });
  control = await getStudioBindingControl(root, { unitId });
  const mask = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "金面")!;
  const guard = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "守卫")!;
  await resolveStudioEntityProposal(root, {
    unitId,
    panelId: "panel-01",
    proposalId: mask.id,
    decision: "accept",
    selectedAssetId: "prop-mask",
    presence: "forbidden",
    role: "不得出画。",
    expectedRevisionToken: control.revisionToken,
  }, { requestHash: requestHash(`${label}-mask`), reviewer: "codex" });
  control = await getStudioBindingControl(root, { unitId });
  await resolveStudioEntityProposal(root, {
    unitId,
    panelId: "panel-01",
    proposalId: guard.id,
    decision: "select",
    selectedAssetId: "character-guard-a",
    presence: "required",
    role: "门口守卫。",
    expectedRevisionToken: control.revisionToken,
  }, { requestHash: requestHash(`${label}-guard`), reviewer: "codex" });
  return getStudioBindingControl(root, { unitId });
}

describe("P6 Studio Binding Control 纵向门禁", () => {
  it("单元详情也返回 Core canonical successor，跨页固定单元不会丢失下一镜", async () => {
    const { root, unit, script, panels } = await fixture(true);
    await createStudioProductionUnit(root, {
      id: "unit-binding-control-successor",
      expectedRevision: 0,
      season: unit.unit.season,
      episode: unit.unit.episode,
      sequence: 2,
      title: "Binding Control 下一单元",
      scriptRevisionId: script.revision.id,
      panels: panels.map((panel, index) => ({
        ...panel,
        id: `successor-panel-${index + 1}`,
      })),
    });
    await expect(getStudioBindingControl(root, { unitId: unit.unit.id }))
      .resolves.toMatchObject({
        unit: { canonicalSuccessorUnitId: "unit-binding-control-successor" },
      });
  });

  it("缺少 source span 时不解析、不从 panel.assets 自动建绑定，旧 revision token 失败关闭", async () => {
    const { root, unit } = await fixture(false);
    const control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const panel = control.panels[0]!;
    expect(panel.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "panel-source-span-missing", severity: "blocking" }),
    ]));
    expect(panel.proposals).toEqual([]);
    expect(panel.bindingSet).toBeUndefined();
    await expect(analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("missing-span") }))
      .rejects.toMatchObject({ code: "source-span-missing" });
    expect(await getCurrentStudioPanelAssetBindingSet(root, unit.unit.id, panel.id)).toBeNull();

    await expect(analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      expectedRevisionToken: "0".repeat(64),
    }, { requestHash: requestHash("old-token") }))
      .rejects.toMatchObject({ code: "revision-conflict" });
  });

  it("extractedMentions 以 UTF-16 原文 span 追加 unmatched proposal，模型候选不自动选择且无效输入失败关闭", async () => {
    const { root, unit } = await fixture(true);
    const initial = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const start = SCRIPT_BODY.indexOf("玄鸟使者");
    const end = start + "玄鸟使者".length;
    const base = {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: initial.revisionToken,
    };

    await expect(analyzeStudioScriptEntities(root, {
      ...base,
      extractedMentions: [{
        startOffsetUtf16: start,
        endOffsetUtf16: end,
        category: "character",
        presence: "required",
        role: "未知来客。",
        candidateAssetIds: ["a", "b", "c", "d", "e", "f"],
      }],
    }, { requestHash: requestHash("extracted-too-many-candidates") }))
      .rejects.toMatchObject({ code: "invalid-input" });
    await expect(analyzeStudioScriptEntities(root, {
      ...base,
      extractedMentions: [{
        startOffsetUtf16: start,
        endOffsetUtf16: SCRIPT_BODY.length + 1,
        category: "character",
        presence: "required",
        role: "越界实体。",
      }],
    }, { requestHash: requestHash("extracted-out-of-bounds") }))
      .rejects.toMatchObject({ code: "invalid-input" });
    await expect(analyzeStudioScriptEntities(root, {
      ...base,
      extractedMentions: [{
        startOffsetUtf16: start,
        endOffsetUtf16: end,
        category: "prop",
        presence: "required",
        role: "故意错误类别。",
        candidateAssetIds: ["character-guard-a"],
      }],
    }, { requestHash: requestHash("extracted-wrong-category") }))
      .rejects.toThrow(/分类|category/u);
    expect((await getStudioBindingControl(root, { unitId: unit.unit.id })).revisionToken).toBe(initial.revisionToken);

    const outcome = await analyzeStudioScriptEntities(root, {
      ...base,
      extractedMentions: [{
        startOffsetUtf16: start,
        endOffsetUtf16: end,
        category: "character",
        presence: "required",
        role: "未知来客，待人工确认。",
        candidateAssetIds: ["character-guard-a"],
      }],
    }, { requestHash: requestHash("extracted-valid-model-candidate"), reviewer: "codex" });
    expect(outcome.analysisRevision).toBe(1);
    const control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const extracted = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "玄鸟使者")!;
    expect(extracted).toMatchObject({
      status: "unmatched",
      presence: "required",
      role: "未知来客，待人工确认。",
      blockerCodes: expect.arrayContaining(["human-decision-required", "unmatched"]),
    });
    expect(extracted.resolvedAssetId).toBeUndefined();
    expect(extracted.candidates).toEqual([
      expect.objectContaining({ assetId: "character-guard-a", category: "character", matchKind: "model" }),
    ]);
    expect(control.panels[0]!.freezeAllowed).toBe(false);
    expect(await getCurrentStudioPanelAssetBindingSet(root, unit.unit.id, "panel-01")).toBeNull();
  });

  it("exact alias 只产提案、歧义必须人工选择，决策 CAS/presence/role 进入冻结与 receipt proof", async () => {
    const { root, unit } = await fixture(true);
    const initial = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const analyzeHash = requestHash("binding-analyze");
    const analyzed = await analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: initial.revisionToken,
    }, { requestHash: analyzeHash, reviewer: "codex" });
    const afterAnalyze = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const panel = afterAnalyze.panels[0]!;
    const mask = panel.proposals.find((proposal) => proposal.entityText === "金面")!;
    const guard = panel.proposals.find((proposal) => proposal.entityText === "守卫")!;
    expect(mask).toMatchObject({ status: "matched", matchedAssetId: "prop-mask" });
    expect(mask.resolvedAssetId).toBeUndefined();
    expect(guard).toMatchObject({ status: "ambiguous" });
    expect(guard.resolvedAssetId).toBeUndefined();
    expect(guard.candidates.map((candidate) => candidate.assetId)).toEqual(["character-guard-a", "character-guard-b"]);
    expect(guard.candidates.map((candidate) => candidate.assetName)).toEqual(["甲卫", "乙卫"]);
    expect(panel.freezeAllowed).toBe(false);
    expect(await getCurrentStudioPanelAssetBindingSet(root, unit.unit.id, panel.id)).toBeNull();
    await expect(freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      expectedRevisionToken: afterAnalyze.revisionToken,
    }, { requestHash: requestHash("freeze-before-decisions") }))
      .rejects.toMatchObject({ code: "binding-blocked" });
    await expect(resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      proposalId: guard.id,
      decision: "accept",
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门口守卫。",
      expectedRevisionToken: afterAnalyze.revisionToken,
    }, { requestHash: requestHash("ambiguous-accept") }))
      .rejects.toThrow(/accept/u);

    const maskResolveHash = requestHash("resolve-mask");
    const maskResolved = await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      proposalId: mask.id,
      decision: "accept",
      selectedAssetId: "prop-mask",
      presence: "forbidden",
      role: "布囊内身份铁律，当前不得出画。",
      expectedRevisionToken: afterAnalyze.revisionToken,
    }, { requestHash: maskResolveHash, reviewer: "codex" });
    const afterMask = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const maskRetry = await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      proposalId: mask.id,
      decision: "accept",
      selectedAssetId: "prop-mask",
      presence: "forbidden",
      role: "布囊内身份铁律，当前不得出画。",
      expectedRevisionToken: afterMask.revisionToken,
    }, { requestHash: requestHash("resolve-mask-current-head-retry"), reviewer: "codex" });
    expect(maskRetry).toMatchObject({
      decisionId: maskResolved.decisionId,
      decisionRevision: maskResolved.decisionRevision,
      decisionFingerprint: maskResolved.decisionFingerprint,
    });
    expect((await getStudioBindingControl(root, { unitId: unit.unit.id })).revisionToken).toBe(afterMask.revisionToken);
    await expect(resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      proposalId: guard.id,
      decision: "select",
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门口守卫。",
      expectedRevisionToken: afterAnalyze.revisionToken,
    }, { requestHash: requestHash("stale-resolve-token") }))
      .rejects.toMatchObject({ code: "revision-conflict" });

    const guardResolveHash = requestHash("resolve-guard-a");
    const guardResolved = await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      proposalId: guard.id,
      decision: "select",
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门口守卫。",
      expectedRevisionToken: afterMask.revisionToken,
    }, { requestHash: guardResolveHash, reviewer: "codex" });
    const afterDecisions = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(afterDecisions.panels[0]).toMatchObject({ status: "bound", freezeAllowed: true });
    const maskHead = await getCurrentStudioMentionDecision(root, mask.id);
    const guardHead = await getCurrentStudioMentionDecision(root, guard.id);
    expect(maskHead?.decision).toMatchObject({
      id: maskResolved.decisionId,
      selectedAssetId: "prop-mask",
      presence: "forbidden",
      role: "布囊内身份铁律，当前不得出画。",
    });
    expect(guardHead?.decision).toMatchObject({
      id: guardResolved.decisionId,
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门口守卫。",
    });

    const freezeHash = requestHash("freeze-current-binding");
    const frozen = await freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      expectedRevisionToken: afterDecisions.revisionToken,
    }, { requestHash: freezeHash, reviewer: "codex" });
    const currentBinding = await getCurrentStudioPanelAssetBindingSet(root, unit.unit.id, panel.id);
    expect(currentBinding).toMatchObject({ id: frozen.bindingSetId, fingerprint: frozen.bindingSetFingerprint });
    expect(currentBinding?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: "prop-mask", presence: "forbidden", role: "布囊内身份铁律，当前不得出画。" }),
      expect.objectContaining({ assetId: "character-guard-a", presence: "required", role: "门口守卫。" }),
    ]));
    await seedStudioP7ResolvedPanelContinuity(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: ["character-guard-a"],
    });
    const generationPack = await buildStudioGenerationFreezePack(root, { unitId: unit.unit.id, panelId: panel.id });
    expect(generationPack.assetBinding.bindingSet.sourceSpans).toEqual([
      expect.objectContaining({
        scriptRevisionId: generationPack.scriptRevision.id,
        scriptSha256: generationPack.scriptRevision.bodySha256,
        startOffsetUtf16: 0,
        endOffsetUtf16: SCRIPT_BODY.length,
        surfaceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(generationPack.assetBinding.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ selectedAssetId: "prop-mask", presence: "forbidden", role: "布囊内身份铁律，当前不得出画。" }),
      expect.objectContaining({ selectedAssetId: "character-guard-a", presence: "required", role: "门口守卫。" }),
    ]));
    expect(generationPack.request.controlReferences.map((reference) => reference.assetId)).toEqual(["character-guard-a"]);
    expect(generationPack.request.safetyConstraints.map((constraint) => constraint.assetId)).toEqual(["prop-mask"]);
    expect((await getStudioBindingControl(root, { unitId: unit.unit.id })).panels[0]).toMatchObject({
      status: "generation-ready",
      bindingSet: { currentness: "current" },
    });

    await expect(proveStudioBindingOperationOutcome(root, analyzeHash, "analyze_studio_script_entities"))
      .resolves.toMatchObject({ receipt: { id: analyzed.receiptId }, outcome: { analysisId: analyzed.analysisId } });
    await expect(proveStudioBindingOperationOutcome(root, maskResolveHash, "resolve_studio_entity_proposal"))
      .resolves.toMatchObject({ receipt: { id: maskResolved.receiptId }, outcome: { decisionId: maskResolved.decisionId } });
    await expect(proveStudioBindingOperationOutcome(root, guardResolveHash, "resolve_studio_entity_proposal"))
      .resolves.toMatchObject({ receipt: { id: guardResolved.receiptId }, outcome: { decisionId: guardResolved.decisionId } });
    await expect(proveStudioBindingOperationOutcome(root, freezeHash, "freeze_studio_asset_binding_set"))
      .resolves.toMatchObject({ receipt: { id: frozen.receiptId }, outcome: { bindingSetId: frozen.bindingSetId } });

    const beforeDecisionRevision = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      proposalId: guard.id,
      decision: "select",
      selectedAssetId: "character-guard-a",
      presence: "optional",
      role: "远景守卫，故意修订语义。",
      expectedRevisionToken: beforeDecisionRevision.revisionToken,
    }, { requestHash: requestHash("resolve-guard-revision"), reviewer: "codex" });
    const stale = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(stale.panels[0]).toMatchObject({ status: "stale", bindingSet: { currentness: "stale" } });
    await expect(assertStudioGenerationFreezePackCurrent(root, generationPack))
      .rejects.toMatchObject({
        code: "asset-binding-stale",
        details: expect.arrayContaining([expect.stringContaining("decision-head-changed")]),
      });
    await expect(freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      expectedRevisionToken: beforeDecisionRevision.revisionToken,
    }, { requestHash: requestHash("freeze-with-old-head-token") }))
      .rejects.toMatchObject({ code: "revision-conflict" });
  });

  it("旧 BindingSet 因 prompt/unit 修订过期后，当前重分析与决策可追加冻结 replacement head", async () => {
    const { root, unit, panels } = await fixture(true);
    const panelId = "panel-01";

    let control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId,
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-analyze-v1"), reviewer: "codex" });
    control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const maskV1 = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "金面")!;
    const guardV1 = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "守卫")!;
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId,
      proposalId: maskV1.id,
      decision: "accept",
      selectedAssetId: "prop-mask",
      presence: "forbidden",
      role: "不得出画。",
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-mask-v1"), reviewer: "codex" });
    control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId,
      proposalId: guardV1.id,
      decision: "select",
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门口守卫。",
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-guard-v1"), reviewer: "codex" });
    control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const frozenV1 = await freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId,
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-freeze-v1"), reviewer: "codex" });
    const oldBinding = await getStudioAssetBindingSet(root, frozenV1.bindingSetId);
    expect(oldBinding).toMatchObject({ unitRevision: 1, promptRevisionId: unit.panels[0]!.promptRevisionId });
    expect((await getStudioBindingControl(root, { unitId: unit.unit.id })).panels[0])
      .toMatchObject({ status: "generation-ready", bindingSet: { currentness: "current" } });

    const promptV1 = unit.panels[0]!.promptRevision;
    const promptV2 = await appendStudioPromptRevision(root, {
      documentId: promptV1.documentId,
      expectedRevision: promptV1.ordinal,
      body: "电影写实，保持身份与道具铁律；当前宫格明确不得出现黄金面具。",
      source: "prompts/EP01.txt",
      sourceVersion: "v2",
    });
    const revised = await reviseStudioProductionUnit(root, {
      unitId: unit.unit.id,
      expectedRevision: unit.unit.revision,
      season: unit.unit.season,
      episode: unit.unit.episode,
      sequence: unit.unit.sequence,
      title: unit.unit.title,
      scriptRevisionId: unit.unit.scriptRevisionId,
      panels: panels.map((panel) => panel.id === panelId
        ? { ...panel, promptRevisionId: promptV2.revision.id }
        : panel),
    });
    expect(revised.unit.revision).toBe(2);
    const stale = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(stale.panels[0]).toMatchObject({
      status: "stale",
      freezeAllowed: false,
      bindingSet: { id: frozenV1.bindingSetId, currentness: "stale" },
    });
    expect(stale.panels[0]!.blockers.map((entry) => entry.code)).toContain("analysis-panel-scope-stale");

    await analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId,
      expectedRevisionToken: stale.revisionToken,
    }, { requestHash: requestHash("replacement-binding-analyze-v2"), reviewer: "codex" });
    control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const maskV2 = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "金面")!;
    const guardV2 = control.panels[0]!.proposals.find((proposal) => proposal.entityText === "守卫")!;
    expect(maskV2.id).not.toBe(maskV1.id);
    expect(guardV2.id).not.toBe(guardV1.id);
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId,
      proposalId: maskV2.id,
      decision: "accept",
      selectedAssetId: "prop-mask",
      presence: "forbidden",
      role: "不得出画。",
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-mask-v2"), reviewer: "codex" });
    control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId,
      proposalId: guardV2.id,
      decision: "select",
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门口守卫。",
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-guard-v2"), reviewer: "codex" });
    control = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(control.panels[0]).toMatchObject({
      status: "stale",
      freezeAllowed: true,
      bindingSet: { id: frozenV1.bindingSetId, currentness: "stale" },
    });
    expect(control.panels[0]!.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "stale:analysis-head-changed",
      "stale:unit-changed",
      "stale:prompt-changed",
    ]));
    expect(control.panels[0]!.blockers.map((entry) => entry.code)).not.toContain("analysis-panel-scope-stale");
    expect(control.nextAction).toContain("冻结当前 AssetBindingSet");
    const frozenV2 = await freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId,
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("replacement-binding-freeze-v2"), reviewer: "codex" });
    expect(frozenV2.bindingSetId).not.toBe(frozenV1.bindingSetId);
    expect(await getCurrentStudioPanelAssetBindingSet(root, unit.unit.id, panelId)).toMatchObject({
      id: frozenV2.bindingSetId,
      unitRevision: 2,
      promptRevisionId: promptV2.revision.id,
    });
    expect(await getStudioAssetBindingSet(root, frozenV1.bindingSetId)).toEqual(oldBinding);
    expect((await getStudioBindingControl(root, { unitId: unit.unit.id })).panels[0])
      .toMatchObject({ status: "generation-ready", freezeAllowed: false, bindingSet: { currentness: "current" } });
  });

  it("replacement-ready 后 identity key 再漂移时重新失败关闭", async () => {
    const { root, unit, panels } = await fixture(true);
    let control = await analyzeAndResolveMaskGuard(root, unit.unit.id, "identity-redrift-v1");
    await freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("identity-redrift-freeze-v1"), reviewer: "codex" });
    const promptV1 = unit.panels[0]!.promptRevision;
    const promptV2 = await appendStudioPromptRevision(root, {
      documentId: promptV1.documentId,
      expectedRevision: promptV1.ordinal,
      body: "电影写实，身份候选二次漂移测试。",
      source: "prompts/EP01.txt",
      sourceVersion: "identity-redrift-v2",
    });
    await reviseStudioProductionUnit(root, {
      unitId: unit.unit.id,
      expectedRevision: unit.unit.revision,
      season: unit.unit.season,
      episode: unit.unit.episode,
      sequence: unit.unit.sequence,
      title: unit.unit.title,
      scriptRevisionId: unit.unit.scriptRevisionId,
      panels: panels.map((panel) => panel.id === "panel-01"
        ? { ...panel, promptRevisionId: promptV2.revision.id }
        : panel),
    });
    control = await analyzeAndResolveMaskGuard(root, unit.unit.id, "identity-redrift-v2");
    expect(control.panels[0]).toMatchObject({ freezeAllowed: true, bindingSet: { currentness: "stale" } });

    await authoritativeAsset(root, {
      id: "character-guard-c",
      category: "character",
      name: "丙卫",
      aliases: ["守卫"],
      color: "#5a4b42",
    });
    const drifted = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(drifted.panels[0]).toMatchObject({ status: "stale", freezeAllowed: false });
    expect(drifted.panels[0]!.blockers.map((entry) => entry.code)).toContain("analysis-identity-key-stale");
    await expect(freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: drifted.revisionToken,
    }, { requestHash: requestHash("identity-redrift-blocked"), reviewer: "codex" }))
      .rejects.toMatchObject({ code: "binding-blocked" });
  });

  it("replacement-ready 后 section head 再漂移时重新失败关闭", async () => {
    const { root, unit, script, panels } = await fixture(true);
    const sectionV1 = await appendStudioScriptSectionRevision(root, {
      sectionId: "scene-replacement-redrift",
      expectedRevision: 0,
      kind: "scene",
      title: "门前守卫",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: script.revision.body.length,
    });
    let control = await analyzeAndResolveMaskGuard(root, unit.unit.id, "section-redrift-v1");
    await freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: control.revisionToken,
    }, { requestHash: requestHash("section-redrift-freeze-v1"), reviewer: "codex" });
    const promptV1 = unit.panels[0]!.promptRevision;
    const promptV2 = await appendStudioPromptRevision(root, {
      documentId: promptV1.documentId,
      expectedRevision: promptV1.ordinal,
      body: "电影写实，章节 head 二次漂移测试。",
      source: "prompts/EP01.txt",
      sourceVersion: "section-redrift-v2",
    });
    await reviseStudioProductionUnit(root, {
      unitId: unit.unit.id,
      expectedRevision: unit.unit.revision,
      season: unit.unit.season,
      episode: unit.unit.episode,
      sequence: unit.unit.sequence,
      title: unit.unit.title,
      scriptRevisionId: unit.unit.scriptRevisionId,
      panels: panels.map((panel) => panel.id === "panel-01"
        ? { ...panel, promptRevisionId: promptV2.revision.id }
        : panel),
    });
    control = await analyzeAndResolveMaskGuard(root, unit.unit.id, "section-redrift-v2");
    expect(control.panels[0]).toMatchObject({ freezeAllowed: true, bindingSet: { currentness: "stale" } });

    await appendStudioScriptSectionRevision(root, {
      sectionId: sectionV1.sectionId,
      expectedRevision: sectionV1.revision,
      kind: "scene",
      title: "门前守卫（二次修订）",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: sectionV1.startOffsetUtf16,
      endOffsetUtf16: sectionV1.endOffsetUtf16,
    });
    const drifted = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(drifted.panels[0]).toMatchObject({ status: "stale", freezeAllowed: false });
    expect(drifted.panels[0]!.blockers.map((entry) => entry.code)).toContain("analysis-section-head-stale");
    await expect(freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: drifted.revisionToken,
    }, { requestHash: requestHash("section-redrift-blocked"), reviewer: "codex" }))
      .rejects.toMatchObject({ code: "binding-blocked" });
  });

  it("章节/场景来源由 Core 关联，最窄场景 revision 冻结入生成包且场景 Head 变化只使依赖绑定过期", async () => {
    const { root, unit, script } = await fixture(true);
    const chapter = await appendStudioScriptSectionRevision(root, {
      sectionId: "chapter-binding-01",
      expectedRevision: 0,
      kind: "chapter",
      title: "第一章 门前异动",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: script.revision.body.length,
    });
    const sceneEnd = SCRIPT_BODY.indexOf("，玄鸟使者");
    const scene = await appendStudioScriptSectionRevision(root, {
      sectionId: "scene-binding-door",
      expectedRevision: 0,
      kind: "scene",
      title: "门前守卫",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: sceneEnd,
    });

    const initial = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(initial.panels[0]!.sourceExcerpts[0]!.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: chapter.id, kind: "chapter", title: "第一章 门前异动" }),
      expect.objectContaining({ revisionId: scene.id, kind: "scene", title: "门前守卫" }),
    ]));
    await analyzeStudioScriptEntities(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: initial.revisionToken,
    }, { requestHash: requestHash("binding-sections-analyze"), reviewer: "codex" });
    const analysis = await getCurrentStudioPanelAssetMentionAnalysis(root, unit.unit.id, 1);
    expect(analysis?.proposals.filter((proposal) => proposal.surfaceText === "金面" || proposal.surfaceText === "守卫"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ surfaceText: "金面", sectionRevisionId: scene.id }),
        expect.objectContaining({ surfaceText: "守卫", sectionRevisionId: scene.id }),
      ]));

    const analyzed = await getStudioBindingControl(root, { unitId: unit.unit.id });
    const mask = analyzed.panels[0]!.proposals.find((proposal) => proposal.entityText === "金面")!;
    const guard = analyzed.panels[0]!.proposals.find((proposal) => proposal.entityText === "守卫")!;
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      proposalId: mask.id,
      decision: "accept",
      selectedAssetId: "prop-mask",
      presence: "forbidden",
      role: "不得出画。",
      expectedRevisionToken: analyzed.revisionToken,
    }, { requestHash: requestHash("binding-sections-mask"), reviewer: "codex" });
    const afterMask = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await resolveStudioEntityProposal(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      proposalId: guard.id,
      decision: "select",
      selectedAssetId: "character-guard-a",
      presence: "required",
      role: "门前守卫。",
      expectedRevisionToken: afterMask.revisionToken,
    }, { requestHash: requestHash("binding-sections-guard"), reviewer: "codex" });
    const resolved = await getStudioBindingControl(root, { unitId: unit.unit.id });
    await freezeStudioAssetBindingSetFromControl(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      expectedRevisionToken: resolved.revisionToken,
    }, { requestHash: requestHash("binding-sections-freeze"), reviewer: "codex" });
    await seedStudioP7ResolvedPanelContinuity(root, {
      unitId: unit.unit.id,
      panelId: "panel-01",
      assetIds: ["character-guard-a"],
    });
    const pack = await buildStudioGenerationFreezePack(root, { unitId: unit.unit.id, panelId: "panel-01" });
    expect(pack.assetBinding.analysis.proposals.filter((proposal) => proposal.id === mask.id || proposal.id === guard.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sectionRevisionId: scene.id, sectionFingerprint: scene.fingerprint }),
        expect.objectContaining({ sectionRevisionId: scene.id, sectionFingerprint: scene.fingerprint }),
      ]));
    expect(pack.panelReferenceResolution.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `studio:script-section:${scene.id}`, fingerprint: scene.fingerprint }),
    ]));

    const observerStart = SCRIPT_BODY.indexOf("玄鸟使者");
    const unrelated = await appendStudioScriptSectionRevision(root, {
      sectionId: "scene-binding-observer",
      expectedRevision: 0,
      kind: "scene",
      title: "旁观者",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: observerStart,
      endOffsetUtf16: observerStart + "玄鸟使者旁观。".length,
    });
    await appendStudioScriptSectionRevision(root, {
      sectionId: unrelated.sectionId,
      expectedRevision: unrelated.revision,
      kind: "scene",
      title: "旁观者（修订）",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: unrelated.startOffsetUtf16,
      endOffsetUtf16: unrelated.endOffsetUtf16,
    });
    await expect(assertStudioGenerationFreezePackCurrent(root, pack)).resolves.toMatchObject({ id: pack.id });
    expect((await getStudioBindingControl(root, { unitId: unit.unit.id })).panels[0])
      .toMatchObject({ status: "generation-ready", bindingSet: { currentness: "current" } });

    const revisedScene = await appendStudioScriptSectionRevision(root, {
      sectionId: scene.sectionId,
      expectedRevision: scene.revision,
      kind: "scene",
      title: "门前守卫（修订）",
      scriptRevisionId: script.revision.id,
      scriptSha256: script.revision.bodySha256,
      startOffsetUtf16: scene.startOffsetUtf16,
      endOffsetUtf16: scene.endOffsetUtf16,
    });
    expect(revisedScene.id).not.toBe(scene.id);
    const stale = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(stale.panels[0]).toMatchObject({ status: "stale", freezeAllowed: false, bindingSet: { currentness: "stale" } });
    expect(stale.panels[0]!.blockers.map((blocker) => blocker.code))
      .toEqual(expect.arrayContaining([expect.stringContaining("section-head-changed:scene-binding-door")]));
    await expect(assertStudioGenerationFreezePackCurrent(root, pack)).rejects.toMatchObject({
      code: "asset-binding-stale",
      details: expect.arrayContaining([expect.stringContaining("section-head-changed:scene-binding-door")]),
    });
  });
});
