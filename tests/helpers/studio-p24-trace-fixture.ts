/**
 * P24：追溯 golden 确定性夹具构建器（规范 §2.7）。
 * 复用 P7 夹具的项目/资产/绑定/媒体播种（不改 P7 已验收语义），追加 4 格单元与追溯用驱动器。
 * 全部 mkdtemp 隔离；无 Date.now/随机源；媒体为固定像素，不代表任何视觉验收。
 */
import { createHash } from "node:crypto";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  type StudioP7Fixture,
} from "./studio-p7-fixture.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  freezeStudioPanelAssetBindingSet,
  getCurrentStudioMentionDecisionsForAnalysis,
  getCurrentStudioPanelAssetBindingSet,
  getCurrentStudioPanelAssetMentionAnalysis,
  getStudioProductionPanelTimeContext,
  getStudioTextRevision,
  listStudioTextDocuments,
  readStudioProductionUnitSnapshot,
  recordStudioMentionDecision,
  reviseStudioProductionUnit,
  type StudioProductionPanel,
  type StudioProductionPanelInput,
  type StudioProductionUnitSnapshot,
} from "../../src/core/studio-production.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../../src/core/studio-generation-ledger.js";
import {
  appendStudioAssetVersion,
  evaluateStudioAssetApplicability,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../../src/core/material-studio.js";

export interface StudioP24TraceFixture {
  p7: StudioP7Fixture;
  root: string;
  projectId: string;
  units: { two: StudioProductionUnitSnapshot; four: StudioProductionUnitSnapshot; six: StudioProductionUnitSnapshot };
  scriptDocumentId: string;
  promptDocumentId: string;
  scriptBody: string;
  cleanup(): Promise<void>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

const P24_ASSET_IDS = ["character-ahang", "scene-stone-room", "prop-complete-golden-mask"] as const;

function p24PanelAssets(promptRevisionId: string): StudioProductionPanelInput["assets"] {
  return [{
    assetId: "character-ahang",
    category: "character",
    presence: "required",
    role: "画面主体，固定身份与服饰。",
    continuityState: "legacy evidence；P24 仅复用 P7 机械语义。",
    evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "P24 fixture 明确绑定。" }],
  }, {
    assetId: "scene-stone-room",
    category: "scene",
    presence: "required",
    role: "固定石室空间与左侧火光。",
    continuityState: "legacy evidence；P24 仅复用 P7 机械语义。",
    evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "P24 fixture 明确绑定。" }],
  }, {
    assetId: "prop-complete-golden-mask",
    category: "prop",
    presence: "required",
    role: "完整黄金面具，不得变成半面具。",
    continuityState: "legacy evidence；P24 仅复用 P7 机械语义。",
    evidence: [{ kind: "hard-lock", reference: "complete-golden-mask", note: "禁止半面具。" }],
  }];
}

function p24PanelsForUnit(
  unitId: string,
  promptRevisionId: string,
  panelDurationsSeconds: readonly number[],
  spanEndOffsetUtf16: number,
): StudioProductionPanelInput[] {
  let cursor = 0;
  return panelDurationsSeconds.map((durationSeconds, offset) => {
    const startSeconds = cursor;
    cursor += durationSeconds;
    const panelIndex = offset + 1;
    return {
      id: `${unitId}-panel-${String(panelIndex).padStart(2, "0")}`,
      title: `${unitId} 宫格 ${panelIndex}`,
      visualAction: panelIndex === 1 ? "阿航在石室中捧着完整黄金面具。" : `阿航承接前格站位，完成第 ${panelIndex} 格动作。`,
      shotComposition: panelIndex % 2 === 1 ? "中景，主体居中。" : "近景，保留右侧空间。",
      filmingMethod: panelIndex % 2 === 1 ? "固定机位。" : "50mm 缓慢推近。",
      dialogue: panelIndex === 1 ? "阿航：不要动。" : "",
      subtitle: panelIndex === 1 ? "不要动" : "",
      startSeconds,
      endSeconds: cursor,
      durationSeconds,
      promptRevisionId,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: spanEndOffsetUtf16 }],
      assets: p24PanelAssets(promptRevisionId),
    };
  });
}

/** 复刻 P7 的 analyze→decide→freeze 绑定流（公开 API 组合，不改 P7 语义）；expected 修订全部从当前 head 实读。 */
export async function freezeP24PanelBindingSet(
  root: string,
  projectId: string,
  unit: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
  scriptBody: string,
  resolverVersion = "p24-deterministic-fixture-v1",
) {
  const assetNames: Array<{ id: string; category: "character" | "scene" | "prop"; name: string }> = [
    { id: "character-ahang", category: "character", name: "阿航" },
    { id: "scene-stone-room", category: "scene", name: "石室" },
    { id: "prop-complete-golden-mask", category: "prop", name: "完整黄金面具" },
  ];
  const mentions = assetNames.map((asset, index) => {
    const startOffsetUtf16 = scriptBody.indexOf(asset.name);
    if (startOffsetUtf16 < 0) throw new Error(`P24 fixture 剧本缺少资产名称：${asset.name}`);
    const legacyMention = panel.assets.find((entry) => entry.assetId === asset.id);
    if (!legacyMention) throw new Error(`P24 fixture panel 缺少资产：${asset.id}`);
    return {
      id: `p24-mention-${unit.unit.id}-${panel.index}-${index}-${asset.id}-${resolverVersion}`,
      surfaceText: asset.name,
      startOffsetUtf16,
      endOffsetUtf16: startOffsetUtf16 + asset.name.length,
      category: asset.category,
      presence: legacyMention.presence,
      role: legacyMention.role,
    };
  });
  const previousAnalysis = await getCurrentStudioPanelAssetMentionAnalysis(root, unit.unit.id, panel.id);
  const analysis = await analyzeStudioPanelAssetMentions(root, {
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    unitFingerprint: unit.fingerprint,
    panelIndex: panel.index,
    scriptRevisionId: unit.scriptRevision.id,
    scriptSha256: unit.scriptRevision.bodySha256,
    expectedHeadRevision: previousAnalysis?.revision ?? 0,
    mentions,
    resolverVersion,
  });
  const decisionHeads = await getCurrentStudioMentionDecisionsForAnalysis(root, analysis.id);
  const decisions = await Promise.all(analysis.proposals.map(async (proposal) => {
    if (proposal.status !== "matched" || proposal.candidates.filter((candidate) => candidate.kind !== "model").length !== 1) {
      throw new Error(`P24 fixture 必须得到唯一 exact matched：${proposal.mentionId}`);
    }
    const head = decisionHeads.find((entry) => entry.proposalId === proposal.id);
    return recordStudioMentionDecision(root, {
      receiptId: `p24-decision-${unit.unit.id}-${panel.index}-${proposal.mentionId}-${analysis.revision}`,
      proposalId: proposal.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: head?.revision ?? 0,
      action: "accept",
      presence: proposal.presence,
      role: proposal.role,
      reviewer: "p24-fixture",
      note: "确定性 fixture 显式确认 exact 身份。",
    });
  }));
  const time = getStudioProductionPanelTimeContext(unit.unit, panel);
  const target = { projectId, seasonId: unit.unit.season, episodeId: unit.unit.episode, unitId: unit.unit.id, ...time };
  const assetSources = await Promise.all(panel.assets.map(async (mention) => {
    const detail = await getStudioCanonicalAsset(root, mention.assetId);
    if (!detail?.primaryAuthority) throw new Error(`P24 fixture 资产缺少主权威：${mention.assetId}`);
    const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId);
    const authority = detail.authorityHistory.at(-1);
    const version = detail.versions.find((entry) => entry.id === detail.primaryAuthority!.versionId);
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail.id, target);
    if (!definition || !authority || !version || !knowledge) throw new Error(`P24 fixture 资产知识闭包不完整：${detail.id}`);
    return {
      assetId: detail.id,
      category: detail.category,
      assetRevision: detail.revision,
      definitionVersionId: definition.id,
      authorityEventId: authority.id,
      authorityVersionId: authority.versionId,
      assetVersionId: version.id,
      mediaSha256: version.mediaSha256,
      knowledgeFingerprint: knowledge.fingerprint,
      applicabilityFingerprint: digest(evaluateStudioAssetApplicability(definition.applicability, target)),
    };
  }));
  const previousBindingSet = await getCurrentStudioPanelAssetBindingSet(root, unit.unit.id, panel.index);
  return freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: previousBindingSet?.revision ?? 0,
    decisionReceiptIds: decisions.map((decision) => decision.id),
    assetSources,
  });
}

/** 构建 P24 夹具：P7 基底 + 4 格单元（含绑定）。 */
export async function createStudioP24TraceFixture(): Promise<StudioP24TraceFixture> {
  const p7 = await createStudioP7Fixture();
  try {
    const root = p7.root;
    const projectId = p7.shell.project.id;
    const scriptRevisionId = p7.units.twoPanel.scriptRevision.id;
    const scriptRevision = await getStudioTextRevision(root, scriptRevisionId);
    if (!scriptRevision) throw new Error("P24 fixture 读取剧本修订失败。");
    const scriptBody = scriptRevision.body;
    const documents = await listStudioTextDocuments(root, {});
    const scriptDocument = documents.items.find((entry) => entry.kind === "script");
    const promptDocument = documents.items.find((entry) => entry.kind === "prompt");
    if (!scriptDocument || !promptDocument) throw new Error("P24 fixture 缺少剧本/提示词文档。");
    const promptRevisionId = p7.units.twoPanel.panels[0]!.promptRevisionId;
    const four = await createStudioProductionUnit(root, {
      id: "p24-unit-four-panel",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 9,
      title: "P24 四格追溯单元",
      scriptRevisionId,
      panels: p24PanelsForUnit("p24-unit-four", promptRevisionId, [3.75, 3.75, 3.75, 3.75], scriptBody.length),
    });
    for (const panel of four.panels) {
      await freezeP24PanelBindingSet(root, projectId, four, panel, scriptBody);
    }
    return {
      p7,
      root,
      projectId,
      units: { two: p7.units.twoPanel, four, six: p7.units.sixPanel },
      scriptDocumentId: scriptDocument.id,
      promptDocumentId: promptDocument.id,
      scriptBody,
      cleanup: p7.cleanup,
    };
  } catch (error) {
    await p7.cleanup();
    throw error;
  }
}

export interface StudioP24FrozenPack {
  unit: StudioProductionUnitSnapshot;
  panel: StudioProductionPanel;
  packId: string;
  fingerprint: string;
}

/** 播种连续性并对指定宫格冻结包。 */
export async function freezeP24Pack(
  fixture: StudioP24TraceFixture,
  unit: StudioProductionUnitSnapshot,
  panelIndex: number,
): Promise<StudioP24FrozenPack> {
  const panel = unit.panels.find((entry) => entry.index === panelIndex);
  if (!panel) throw new Error(`P24 fixture 单元 ${unit.unit.id} 无宫格 index=${panelIndex}。`);
  await seedStudioP7ResolvedPanelContinuity(fixture.root, {
    unitId: unit.unit.id,
    panelId: panel.id,
    assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
  });
  const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
  return { unit, panel, packId: frozen.packId, fingerprint: frozen.fingerprint };
}

/** 派发并登记 raw/labeled 成对结果（复用 P7 媒体，机械身份足够，不代表视觉验收）。 */
export async function dispatchAndRegisterP24Pair(
  fixture: StudioP24TraceFixture,
  pack: StudioP24FrozenPack,
  generationRunId: string,
): Promise<{ rawResultId: string; labeledResultId: string }> {
  await dispatchStudioGenerationPack(fixture.root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const media = fixture.p7.panelMediaPairs[0]!;
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
    provider: "codex",
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
    provider: "codex",
  });
  return { rawResultId: raw.resultId, labeledResultId: labeled.resultId };
}

/** 推进提示词修订（预期变化触发器：prompt-changed）。 */
export async function advanceP24PromptRevision(fixture: StudioP24TraceFixture) {
  return appendStudioPromptRevision(fixture.root, {
    documentId: fixture.promptDocumentId,
    expectedRevision: 1,
    body: "只生成一张电影写实分镜；保持阿航、石室和完整黄金面具的规范身份，不得换脸、串景或改成半面具；追加 P24 确定性后缀。",
    source: "fixture/p24/EP01.txt",
    sourceVersion: "p24-fixture-v2",
  });
}

/** 推进剧本修订（预期变化触发器：script-changed）。 */
export async function advanceP24ScriptRevision(fixture: StudioP24TraceFixture) {
  return appendStudioScriptRevision(fixture.root, {
    documentId: fixture.scriptDocumentId,
    expectedRevision: 1,
    body: `${fixture.scriptBody}（P24 确定性续写：阿航再次确认面具完整。）`,
    source: "fixture/p24/EP01.md",
    sourceVersion: "p24-fixture-v2",
  });
}

/** 资产再版本并提升权威（非预期变化触发器：asset-semantic-changed:<assetId>）。 */
export async function reversionP24AssetAuthority(
  fixture: StudioP24TraceFixture,
  assetId: string,
): Promise<void> {
  const root = fixture.root;
  const detail = await getStudioCanonicalAsset(root, assetId);
  if (!detail) throw new Error(`P24 fixture 资产不存在：${assetId}`);
  // 复用任一 P7 媒体作为"新版本"来源——机械触发语义指纹变化即可，不代表视觉验收。
  const media = fixture.p7.panelMediaPairs[1] ?? fixture.p7.panelMediaPairs[0]!;
  const appended = await appendStudioAssetVersion(root, {
    assetId,
    mediaSha256: media.raw.imported.sha256,
    reviewStatus: "pending",
    sourceNote: "P24 确定性再版本触发器。",
    expectedRevision: detail.revision,
  });
  const approved = await reviewStudioAssetVersion(root, {
    assetId,
    versionId: appended.version.id,
    decision: "approved",
    expectedRevision: appended.assetRevision,
    note: "P24 仅批准 fixture 身份/CAS，不代表视觉验收。",
  });
  await setStudioPrimaryAuthority(root, {
    assetId,
    versionId: appended.version.id,
    expectedRevision: approved.revision,
    note: "P24 非预期变化触发器：权威切换。",
  });
}

/** 推进单元修订并缩小首格 spans 结束偏移（预期变化触发器：unit-changed；spans 内容经 trace 还原验证）。 */
export async function reviseP24UnitSpans(
  fixture: StudioP24TraceFixture,
  unit: StudioProductionUnitSnapshot,
) {
  const current = await readStudioProductionUnitSnapshot(fixture.root, unit.unit.id);
  if (!current) throw new Error(`P24 fixture 读取单元快照失败：${unit.unit.id}`);
  return reviseStudioProductionUnit(fixture.root, {
    unitId: current.unit.id,
    expectedRevision: current.unit.revision,
    season: current.unit.season,
    episode: current.unit.episode,
    sequence: current.unit.sequence,
    title: current.unit.title,
    scriptRevisionId: current.scriptRevision.id,
    panels: current.panels.map((panel, index) => ({
      id: panel.id,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: panel.dialogue,
      subtitle: panel.subtitle,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: panel.promptRevisionId,
      sourceSpans: panel.sourceSpans.map((span, spanIndex) => (index === 0 && spanIndex === 0
        ? { ...span, endOffsetUtf16: span.endOffsetUtf16 - 1 }
        : { ...span })),
      assets: panel.assets.map((asset) => ({ ...asset })),
    })),
  });
}

/** 重冻结绑定集产生新 head（预期变化触发器：binding-set-not-head；用 v2 resolver 使分析产生新 head）。 */
export async function rebindP24PanelToNewHead(
  fixture: StudioP24TraceFixture,
  unit: StudioProductionUnitSnapshot,
  panelIndex: number,
) {
  const current = await readStudioProductionUnitSnapshot(fixture.root, unit.unit.id);
  if (!current) throw new Error(`P24 fixture 读取单元快照失败：${unit.unit.id}`);
  const panel = current.panels.find((entry) => entry.index === panelIndex);
  if (!panel) throw new Error(`P24 fixture 单元 ${unit.unit.id} 无宫格 index=${panelIndex}。`);
  return freezeP24PanelBindingSet(fixture.root, fixture.projectId, current, panel, fixture.scriptBody, "p24-deterministic-fixture-v2");
}

/** 把单元推进到新剧本/提示词修订（预期变化触发器：script-changed/prompt-changed/unit-changed）。 */
export async function reviseP24UnitToNewRevisions(
  fixture: StudioP24TraceFixture,
  unit: StudioProductionUnitSnapshot,
  revisions: { scriptRevisionId?: string; promptRevisionId?: string },
) {
  const current = await readStudioProductionUnitSnapshot(fixture.root, unit.unit.id);
  if (!current) throw new Error(`P24 fixture 读取单元快照失败：${unit.unit.id}`);
  const promptRevisionId = revisions.promptRevisionId ?? current.panels[0]!.promptRevisionId;
  return reviseStudioProductionUnit(fixture.root, {
    unitId: current.unit.id,
    expectedRevision: current.unit.revision,
    season: current.unit.season,
    episode: current.unit.episode,
    sequence: current.unit.sequence,
    title: current.unit.title,
    scriptRevisionId: revisions.scriptRevisionId ?? current.scriptRevision.id,
    panels: current.panels.map((panel) => ({
      id: panel.id,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: panel.dialogue,
      subtitle: panel.subtitle,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId,
      sourceSpans: panel.sourceSpans.map((span) => ({ ...span })),
      assets: panel.assets.map((asset) => ({ ...asset })),
    })),
  });
}
