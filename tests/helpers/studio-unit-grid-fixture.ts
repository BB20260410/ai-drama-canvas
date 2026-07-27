/**
 * unit-grid 生成链路共享测试夹具（T11 outbox 与 T14/T19 口径测试共用）。
 * 流程与 tests/studio-generation-ledger.test.ts 内私有 helper 同构：
 * 建工程 → 建单元 → 绑定就绪（含九字段 continuity）→ freeze/dispatch/prepare
 * → bundle 入账 → Review/abandon。全部为真实 core 调用，不伪造内部状态。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../../src/core/material-studio.js";
import { createManagedProject, inspectManagedProject } from "../../src/core/managed-project.js";
import { STUDIO_CONTINUITY_FIELDS } from "../../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../../src/core/studio-continuity-ledger.js";
import {
  abandonStudioGenerationUnknown,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  registerStudioVerifiedHistoricalImportContinuationWaiver,
  registerStudioGenerationResultBundle,
  type StudioGenerationResultBundleRecord,
} from "../../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../../src/core/studio-generation-review.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  recordStudioMentionDecision,
  type StudioProductionPanelInput,
} from "../../src/core/studio-production.js";

export interface UnitGridFixtureProject {
  root: string;
}

export async function createUnitGridTestImage(root: string, name: string, color: string) {
  const sourcePath = path.join(root, `${name}.png`);
  await sharp({ create: { width: 80, height: 120, channels: 3, background: color } }).png().toFile(sourcePath);
  return importStudioMedia(root, { sourcePath });
}

/**
 * 为规模/多单元夹具追加一张内容唯一的角色权威图。
 *
 * 默认 fixture 仍使用 character-ahang；只有显式调用者才会创建额外资产，
 * 从而能验证多个冻结参考不是同一 SHA/URL 的重复投影。
 */
export async function createUnitGridFixtureCharacterAuthority(
  root: string,
  input: {
    assetId: string;
    name: string;
    color: string;
  },
): Promise<{ assetId: string; mediaSha256: string }> {
  const referenceMedia = await createUnitGridTestImage(
    root,
    `${input.assetId}-authority`,
    input.color,
  );
  const asset = await createStudioCanonicalAsset(root, {
    id: input.assetId,
    expectedRevision: 0,
    category: "character",
    name: input.name,
    identityFeatures: [`${input.name} fixture 身份`, "黑色束发"],
    positiveLocks: ["固定脸", "素麻古蜀服"],
    negativeLocks: ["禁止换脸", "禁止现代服饰"],
    defaultPrompt: `${input.name}，电影写实，固定角色。`,
  });
  const version = await appendStudioAssetVersion(root, {
    assetId: asset.id,
    mediaSha256: referenceMedia.sha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: asset.id,
    versionId: version.version.id,
    decision: "approved",
    expectedRevision: version.assetRevision,
    note: "规模夹具唯一角色权威审核通过。",
  });
  await setStudioPrimaryAuthority(root, {
    assetId: asset.id,
    versionId: version.version.id,
    expectedRevision: reviewed.revision,
    note: "规模夹具唯一角色主权威。",
  });
  return { assetId: asset.id, mediaSha256: referenceMedia.sha256 };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

export function unitGridFixtureDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function fixtureReadableContinuityValue(
  field: (typeof STUDIO_CONTINUITY_FIELDS)[number],
  panelId: string,
): string {
  const isFirstPanel = panelId === "panel-01";
  const values: Record<(typeof STUDIO_CONTINUITY_FIELDS)[number], string> = {
    costume: "棕色古蜀麻布短衣，腰束深色布带",
    injury: "无可见伤势",
    heldObject: "双手空置，完整黄金面具藏于布囊且不入画",
    position: isFirstPanel ? "画面中央偏左一步" : "画面中央停步",
    facing: isFirstPanel ? "身体与视线朝画面右侧" : "身体朝右，头回望左后方",
    emotion: "警觉且克制",
    layout: "古蜀石室入口在画面左侧，石道向画面右侧延伸",
    lighting: "冷灰石室侧逆光",
    referenceSha256: "",
  };
  return values[field];
}

function fixturePanels(
  promptRevisionId: string,
  requiredAssetId = "character-ahang",
): StudioProductionPanelInput[] {
  return [
    { startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
    { startSeconds: 7, endSeconds: 15, durationSeconds: 8 },
  ].map((timing, offset) => ({
    id: `panel-${String(offset + 1).padStart(2, "0")}`,
    title: `镜头 ${offset + 1}`,
    visualAction: offset === 0 ? "阿航走入石室。" : "阿航停步回头。",
    shotComposition: offset === 0 ? "中景居中。" : "近景侧逆光。",
    filmingMethod: offset === 0 ? "稳定器跟拍。" : "50mm 缓慢推近。",
    dialogue: offset === 0 ? "阿航：别出声。" : "",
    subtitle: offset === 0 ? "别出声" : "",
    ...timing,
    promptRevisionId,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 2 }],
    assets: [{
      assetId: requiredAssetId,
      category: "character",
      presence: "required",
      role: "画面主体，保持固定脸。",
      continuityState: `第 ${offset + 1} 格站位连续。`,
      evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "显式宫格绑定。" }],
    }, {
      assetId: "prop-complete-mask",
      category: "prop",
      presence: "forbidden",
      role: "藏在布囊内，当前不得露出。",
      continuityState: "始终为完整黄金面具。",
      evidence: [{ kind: "hard-lock", reference: "P04-complete-mask", note: "禁止半面具。" }],
    }],
  } satisfies StudioProductionPanelInput));
}

/** 与 ledger 测试同构的绑定就绪：mention 分析 + 决策 + 冻结 binding + 九字段 continuity。 */
export async function bindReadyUnitGridPanel(root: string, unitId: string, panelId: string) {
  const snapshot = await getStudioProductionUnitSnapshot(root, unitId);
  if (!snapshot) throw new Error(`missing unit：${unitId}`);
  const panel = snapshot.panels.find((item) => item.id === panelId)!;
  const details = await Promise.all(panel.assets.map((mention) => getStudioCanonicalAsset(root, mention.assetId)));
  if (details.some((detail) => !detail)) throw new Error("missing canonical asset");
  const analysis = await analyzeStudioPanelAssetMentions(root, {
    unitId,
    unitRevision: snapshot.unit.revision,
    unitFingerprint: snapshot.fingerprint,
    panelIndex: panel.index,
    scriptRevisionId: snapshot.scriptRevision.id,
    scriptSha256: snapshot.scriptRevision.bodySha256,
    expectedHeadRevision: 0,
    mentions: panel.assets.map((mention, index) => ({
      id: `fixture-mention-${unitId}-${panelId}-${index + 1}`,
      surfaceText: snapshot.scriptRevision.body.slice(index, index + 1),
      startOffsetUtf16: index,
      endOffsetUtf16: index + 1,
      category: mention.category,
      presence: mention.presence,
      role: mention.role,
      modelSuggestions: [{ assetId: mention.assetId, category: mention.category, confidence: 1 }],
    })),
    assets: details.map((detail) => ({
      assetId: detail!.id,
      category: detail!.category,
      formalName: detail!.name,
      aliases: detail!.aliases,
    })),
    resolverVersion: "unit-grid-fixture-v1",
  });
  const decisions = await Promise.all(analysis.proposals.map((proposal) => recordStudioMentionDecision(root, {
    receiptId: `fixture-decision-${unitId}-${panelId}-${proposal.mentionId}`,
    proposalId: proposal.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedDecisionHeadRevision: 0,
    action: "select",
    selectedAssetId: proposal.candidates.find((candidate) => candidate.kind === "model")!.assetId,
    presence: proposal.presence,
    role: proposal.role,
    reviewer: "unit-grid-fixture",
    note: "显式绑定确认。",
  })));
  const projectId = (await inspectManagedProject(root)).project.id;
  const target = {
    projectId,
    seasonId: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    unitId,
    unitLocalStartSeconds: panel.startSeconds,
    unitLocalEndSeconds: panel.endSeconds,
    episodeAbsoluteStartSeconds: (snapshot.unit.sequence - 1) * 15 + panel.startSeconds,
    episodeAbsoluteEndSeconds: (snapshot.unit.sequence - 1) * 15 + panel.endSeconds,
  };
  const assetSources = await Promise.all(details.map(async (detail) => {
    const definition = detail!.definitionVersions.find((entry) => entry.id === detail!.currentDefinitionVersionId)!;
    const authority = detail!.authorityHistory.at(-1)!;
    const version = detail!.versions.find((entry) => entry.id === detail!.primaryAuthority!.versionId)!;
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail!.id, target);
    const applicability = evaluateStudioAssetApplicability(definition.applicability, target);
    return {
      assetId: detail!.id,
      category: detail!.category,
      assetRevision: detail!.revision,
      definitionVersionId: definition.id,
      authorityEventId: authority.id,
      authorityVersionId: authority.versionId,
      assetVersionId: version.id,
      mediaSha256: version.mediaSha256,
      knowledgeFingerprint: knowledge!.fingerprint,
      applicabilityFingerprint: unitGridFixtureDigest(applicability),
    };
  }));
  const bindingSet = await freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: 0,
    decisionReceiptIds: decisions.map((decision) => decision.id),
    assetSources,
  });
  const scope = {
    kind: "panel" as const,
    scopeId: panel.id,
    unitId,
    unitRevision: bindingSet.unitRevision,
    startMilliseconds: Math.round(panel.startSeconds * 1_000),
    endMilliseconds: Math.round(panel.endSeconds * 1_000),
  };
  for (const binding of bindingSet.bindings.filter((entry) => entry.presence !== "forbidden")) {
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      const value = field === "referenceSha256"
        ? binding.mediaSha256
        : fixtureReadableContinuityValue(field, panelId);
      await appendStudioContinuityObservation(root, {
        operationId: `fixture-continuity-${unitId}-${bindingSet.unitRevision}-${panelId}-${binding.assetId}-${field}`,
        expectedHeadRevision: 0,
        scope,
        subjectId: binding.assetId,
        field,
        state: {
          status: "resolved",
          value,
          provenance: [{
            kind: "deterministic-fixture",
            reference: `${unitId}/${panelId}/${binding.assetId}/${field}`,
            sourceFingerprint: field === "referenceSha256" ? value : unitGridFixtureDigest({ unitId, panelId, assetId: binding.assetId, field, value }),
            note: "显式机械 fixture continuity，不代表视觉验收。",
          }],
        },
      });
    }
  }
  return bindingSet;
}

/**
 * 建立含规范资产/剧本/提示词的受管工程，并创建一个绑定就绪的单元。
 */
export async function createUnitGridFixtureProject(
  parentRoot: string,
  input: { unitId?: string; season?: string; episode?: string; sequence?: number } = {},
): Promise<UnitGridFixtureProject & {
  unitId: string;
  season: string;
  episode: string;
  scriptRevisionId: string;
  promptRevisionId: string;
}> {
  const root = (await createManagedProject({ parentRoot, name: "unit-grid 夹具工程" })).paths.root;
  const season = input.season ?? "S03";
  const episode = input.episode ?? "EP01";
  const scriptDocument = await createStudioScriptDocument(root, {
    id: "script-main",
    title: "主剧本",
    expectedRevision: 0,
  });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: "阿航走入古蜀石室。",
    source: "scripts/EP01.md",
    sourceVersion: "script-v1",
  });
  const promptDocument = await createStudioPromptDocument(root, {
    id: "prompt-main",
    title: "主提示词",
    expectedRevision: 0,
  });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "只生成一张电影写实分镜，保持阿航一致。",
    source: "prompts/EP01.txt",
    sourceVersion: "prompt-v1",
  });
  const referenceMedia = await createUnitGridTestImage(root, "ahang-authority", "#654b37");
  const asset = await createStudioCanonicalAsset(root, {
    id: "character-ahang",
    expectedRevision: 0,
    category: "character",
    name: "阿航",
    identityFeatures: ["东方青年面孔", "黑色束发"],
    positiveLocks: ["固定脸", "素麻古蜀服"],
    negativeLocks: ["禁止换脸", "禁止现代服饰"],
    defaultPrompt: "阿航，电影写实，固定角色。",
  });
  const version = await appendStudioAssetVersion(root, {
    assetId: asset.id,
    mediaSha256: referenceMedia.sha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: asset.id,
    versionId: version.version.id,
    decision: "approved",
    expectedRevision: version.assetRevision,
    note: "夹具主权威审核通过。",
  });
  await setStudioPrimaryAuthority(root, {
    assetId: asset.id,
    versionId: version.version.id,
    expectedRevision: reviewed.revision,
    note: "夹具主权威。",
  });
  const forbiddenAsset = await createStudioCanonicalAsset(root, {
    id: "prop-complete-mask",
    expectedRevision: 0,
    category: "prop",
    name: "完整黄金面具",
    identityFeatures: ["完整对称金面结构"],
    positiveLocks: ["始终保持完整面具"],
    negativeLocks: ["禁止半面具", "禁止当前格露出"],
    defaultPrompt: "完整黄金面具藏在布囊内，不入画。",
  });
  const forbiddenMedia = await createUnitGridTestImage(root, "mask-authority", "#9a7020");
  const forbiddenVersion = await appendStudioAssetVersion(root, {
    assetId: forbiddenAsset.id,
    mediaSha256: forbiddenMedia.sha256,
    reviewStatus: "pending",
    expectedRevision: forbiddenAsset.revision,
  });
  const forbiddenReviewed = await reviewStudioAssetVersion(root, {
    assetId: forbiddenAsset.id,
    versionId: forbiddenVersion.version.id,
    decision: "approved",
    expectedRevision: forbiddenVersion.assetRevision,
    note: "禁止资产权威审核通过。",
  });
  await setStudioPrimaryAuthority(root, {
    assetId: forbiddenAsset.id,
    versionId: forbiddenVersion.version.id,
    expectedRevision: forbiddenReviewed.revision,
    note: "禁止资产仅锁身份。",
  });
  const unitId = input.unitId ?? "unit-001";
  await createStudioProductionUnit(root, {
    id: unitId,
    expectedRevision: 0,
    season,
    episode,
    sequence: input.sequence ?? 1,
    title: `夹具单元 ${unitId}`,
    scriptRevisionId: script.revision.id,
    panels: fixturePanels(prompt.revision.id),
  });
  await bindReadyUnitGridPanel(root, unitId, "panel-01");
  await bindReadyUnitGridPanel(root, unitId, "panel-02");
  return { root, unitId, season, episode, scriptRevisionId: script.revision.id, promptRevisionId: prompt.revision.id };
}

/** 在既有工程追加一个绑定就绪的单元（多单元/多集口径测试用）。 */
export async function addUnitGridFixtureUnit(
  root: string,
  input: {
    unitId: string;
    season: string;
    episode: string;
    sequence: number;
    scriptRevisionId: string;
    promptRevisionId: string;
    requiredAssetId?: string;
  },
): Promise<void> {
  await createStudioProductionUnit(root, {
    id: input.unitId,
    expectedRevision: 0,
    season: input.season,
    episode: input.episode,
    sequence: input.sequence,
    title: `夹具单元 ${input.unitId}`,
    scriptRevisionId: input.scriptRevisionId,
    panels: fixturePanels(input.promptRevisionId, input.requiredAssetId),
  });
  await bindReadyUnitGridPanel(root, input.unitId, "panel-01");
  await bindReadyUnitGridPanel(root, input.unitId, "panel-02");
}

export interface UnitGridRunHandle {
  pack: Awaited<ReturnType<typeof freezeAndPersistStudioUnitGridGenerationPack>>;
  callId: string;
  generationRunId: string;
}

export async function unitGridFixtureContinuationWaiver(
  root: string,
  unitId: string,
  auditIdentity: string,
) {
  const normalizedAuditIdentity = auditIdentity.trim();
  if (!normalizedAuditIdentity) throw new Error("continuation waiver auditIdentity 不能为空。");
  const snapshot = await getStudioProductionUnitSnapshot(root, unitId);
  if (!snapshot) throw new Error(`continuation waiver unit 不存在：${unitId}`);
  const receipt = await registerStudioVerifiedHistoricalImportContinuationWaiver(root, {
    unitId,
    expectedUnitRevision: snapshot.unit.revision,
    sourceManifestFingerprint: createHash("sha256")
      .update(normalizedAuditIdentity, "utf8")
      .digest("hex"),
    authorizationEvidenceReference: `test-fixture:${normalizedAuditIdentity}`,
    mode: "test-fixture",
  });
  return {
    receiptId: receipt.receiptId,
    receiptFingerprint: receipt.fingerprint,
  };
}

/** freeze → dispatch → prepare（generation_unknown 待写回）。 */
export async function freezeDispatchPrepareUnitGrid(
  root: string,
  unitId: string,
  generationRunId: string,
  options: {
    continuationWaiver?: Awaited<ReturnType<typeof unitGridFixtureContinuationWaiver>>;
  } = {},
): Promise<UnitGridRunHandle> {
  const pack = await freezeAndPersistStudioUnitGridGenerationPack(root, {
    targetKind: "unit-grid",
    unitId,
    ...(options.continuationWaiver
      ? { verifiedHistoricalImportContinuationWaiver: options.continuationWaiver }
      : {}),
  });
  await dispatchStudioGenerationPack(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const intent = await prepareStudioImagegenCall(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
    projectContextToken: `fixture-token-${generationRunId}`,
    commandRequestId: `fixture-command-${generationRunId}`,
    expectedRevision: 0,
  });
  return { pack, callId: intent.callId, generationRunId };
}

/** 原子入账 raw/labeled bundle。 */
export async function commitUnitGridBundle(
  root: string,
  run: UnitGridRunHandle,
  tag: string,
  options: {
    rawColor?: string;
    labeledColor?: string;
  } = {},
): Promise<StudioGenerationResultBundleRecord> {
  const raw = await createUnitGridTestImage(
    root,
    `${tag}-raw`,
    options.rawColor ?? "#30495d",
  );
  const labeled = await createUnitGridTestImage(
    root,
    `${tag}-labeled`,
    options.labeledColor ?? "#715b43",
  );
  return registerStudioGenerationResultBundle(root, {
    packId: run.pack.packId,
    packFingerprint: run.pack.fingerprint,
    generationRunId: run.generationRunId,
    provider: "codex",
    rawMediaSha256: raw.sha256,
    labeledMediaSha256: labeled.sha256,
    callId: run.callId,
  });
}

/** Review PASS（observation，expectedHeadRevision 0）。 */
export async function passUnitGridReview(
  root: string,
  run: UnitGridRunHandle,
  bundle: StudioGenerationResultBundleRecord,
  operationId: string,
  options: {
    reviewer?: string;
    note?: string;
  } = {},
) {
  return submitStudioGenerationReview(root, {
    operationId,
    generationRunId: run.generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: bundle.raw.resultId,
    rawSha256: bundle.raw.mediaSha256,
    labeledResultId: bundle.labeled.resultId,
    labeledSha256: bundle.labeled.mediaSha256,
    expectedPackFingerprint: run.pack.fingerprint,
    continuityFingerprint: run.pack.pack.continuityFingerprint,
    decision: "pass",
    criteria: [
      { code: "identity", status: "pass" },
      { code: "grid-order", status: "pass" },
      { code: "no-text", status: "pass" },
    ],
    reviewer: options.reviewer ?? "unit-grid-fixture",
    note: options.note ?? "原尺寸人工复核 fixture：身份、宫格顺序与禁字均通过。",
  });
}

/** owner 封存 generation_unknown（终态闭合、候选永不复用）。 */
export async function abandonUnitGridRun(
  root: string,
  run: UnitGridRunHandle,
  tag: string,
) {
  const evidenceFingerprint = unitGridFixtureDigest({ tag, runId: run.generationRunId });
  return abandonStudioGenerationUnknown(root, {
    callId: run.callId,
    generationRunId: run.generationRunId,
    projectContextToken: `studioctx-v1-${unitGridFixtureDigest({ token: tag })}`,
    evidenceReference: `fixture-evidence://${tag}`,
    evidenceFingerprint,
    reason: `fixture 封存 ${tag}：远端调用可能存在，迟到结果将被永久拒收。`,
    acknowledgeRemoteMayExist: true,
    acknowledgeLateResultWillBeRejected: true,
  });
}
