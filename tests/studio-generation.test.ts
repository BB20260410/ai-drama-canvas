import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendStudioAssetRelation,
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getStudioAssetRelationCurrentness,
  getStudioCanonicalAssetKnowledgeSnapshot,
  getStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  updateStudioCanonicalAsset,
  type StudioAssetApplicabilityInput,
  type StudioCanonicalAssetCategory,
} from "../src/core/material-studio.js";
import { createManagedProject, inspectManagedProject } from "../src/core/managed-project.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  analyzeStudioPanelAssetMentions,
  freezeStudioPanelAssetBindingSet,
  getCurrentStudioMentionDecision,
  getCurrentStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  recordStudioMentionDecision,
  createStudioProductionUnit,
  createStudioProductionContractProfile,
  reviseStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import {
  StudioGenerationFreezeError,
  assertStudioGenerationFreezePackCurrent,
  buildStudioAgentImagegenBrief,
  buildStudioGenerationFreezePack as buildStudioGenerationFreezePackRaw,
  deriveStudioReferenceUsage,
  effectiveStudioPanelImageLayout,
  inferStudioPanelImageLayout,
  isStudioOpaqueContinuityLocator,
  queryStudioGenerationFreeze,
  serializeStudioGenerationRequest,
} from "../src/core/studio-generation.js";
import {
  assertStudioUnitGridGenerationFreezePackCurrent,
  buildStudioUnitGridGenerationFreezePack,
  serializeStudioUnitGridGenerationRequest,
} from "../src/core/studio-unit-grid-generation.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedProject(): Promise<string> {
  const created = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-generation-parent-")));
  temporaryRoots.push(created);
  return (await createManagedProject({ parentRoot: created, name: "P5 Codex 冻结测试" })).paths.root;
}

async function textFixture(
  root: string,
  promptBody = "只生成一张电影写实分镜，保持阿航面孔、石室光线和完整黄金面具连续性。",
) {
  const script = await createStudioScriptDocument(root, {
    id: "script-ep01",
    title: "EP01 剧本",
    expectedRevision: 0,
  });
  const scriptResult = await appendStudioScriptRevision(root, {
    documentId: script.id,
    expectedRevision: 0,
    body: "阿航走入古蜀石室，完整黄金面具仍藏在布囊内。",
    source: "scripts/EP01.md",
    sourceVersion: "script-v1",
  });
  const prompt = await createStudioPromptDocument(root, {
    id: "prompt-ep01",
    title: "EP01 分镜提示词",
    expectedRevision: 0,
  });
  const promptResult = await appendStudioPromptRevision(root, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: promptBody,
    source: "prompts/EP01.txt",
    sourceVersion: "prompt-v1",
  });
  return { scriptRevision: scriptResult.revision, promptRevision: promptResult.revision };
}

function panelInputs(
  promptRevisionId: string,
  count: 2 | 6,
  options: { includeOptionalScene?: boolean } = {},
): StudioProductionPanelInput[] {
  const durations = count === 2 ? [7, 8] : [2, 2, 3, 3, 2, 3];
  let cursor = 0;
  return durations.map((duration, offset) => {
    const start = cursor;
    cursor += duration;
    return {
      id: `panel-${String(offset + 1).padStart(2, "0")}`,
      title: `宫格 ${offset + 1}`,
      visualAction: offset === 0 ? "阿航走入石室。" : "阿航按住藏有面具的布囊。",
      shotComposition: offset % 2 === 0 ? "中景，主体居中。" : "特写，保留右侧空间。",
      filmingMethod: offset % 2 === 0 ? "低机位稳定器跟拍。" : "50mm 缓慢推近。",
      dialogue: offset === 0 ? "阿航：别出声。" : "",
      subtitle: offset === 0 ? "别出声" : "",
      startSeconds: start,
      endSeconds: cursor,
      durationSeconds: duration,
      promptRevisionId,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 7 }],
      assets: [{
        assetId: "character-ahang",
        category: "character",
        presence: "required",
        role: "画面主体，必须保持固定脸、发型与服饰。",
        continuityState: `承接前格站位，当前第 ${offset + 1} 格。`,
        evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "显式宫格证据。" }],
      }, ...(options.includeOptionalScene === false ? [] : [{
        assetId: "scene-stone-room",
        category: "scene" as const,
        presence: "optional" as const,
        role: "作为背景控制参考。",
        continuityState: "火把光始终从画面左侧入射。",
        evidence: [{ kind: "script-source", reference: "scripts/EP01.md", note: "场景连续性证据。" }],
      }]), {
        assetId: "prop-complete-mask",
        category: "prop",
        presence: "forbidden",
        role: "当前格不可露出，禁止半面具。",
        continuityState: "完整黄金面具藏在布囊内。",
        evidence: [{ kind: "hard-lock", reference: "P04-complete-mask", note: "道具硬锁。" }],
      }],
    } satisfies StudioProductionPanelInput;
  });
}

async function createUnit(
  root: string,
  count: 2 | 6,
  includeOptionalScene = true,
  id = `unit-${count}`,
  promptBody?: string,
) {
  const text = await textFixture(root, promptBody);
  const snapshot = await createStudioProductionUnit(root, {
    id,
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence: count === 2 ? 1 : 2,
    title: `${count} 宫格生产单元`,
    scriptRevisionId: text.scriptRevision.id,
    panels: panelInputs(text.promptRevision.id, count, { includeOptionalScene }),
  });
  return { ...text, snapshot };
}

async function materializeAsset(
  root: string,
  input: {
    id: string;
    category: StudioCanonicalAssetCategory;
    color: string;
    reviewStatus?: "approved" | "pending";
    setAuthority?: boolean;
    applicability?: StudioAssetApplicabilityInput;
  },
) {
  const sourcePath = path.join(root, `${input.id}-source.png`);
  await sharp({ create: { width: 96, height: 128, channels: 3, background: input.color } }).png().toFile(sourcePath);
  const media = await importStudioMedia(root, { sourcePath });
  const created = await createStudioCanonicalAsset(root, {
    id: input.id,
    expectedRevision: 0,
    category: input.category,
    name: input.id === "character-ahang" ? "阿航" : "古蜀石室",
    description: "P5 冻结测试资产。",
    aliases: input.id === "character-ahang" ? ["男主"] : ["石室"],
    identityFeatures: input.id === "character-ahang" ? ["东方青年面孔", "黑色束发"] : ["灰黑石壁", "左侧火把光"],
    positiveLocks: input.id === "character-ahang" ? ["固定脸", "素麻古蜀服"] : ["同一石室空间"],
    negativeLocks: input.id === "character-ahang" ? ["禁止换脸", "禁止现代服饰"] : ["禁止现代建筑"],
    defaultPrompt: input.id === "character-ahang" ? "阿航，电影写实，固定角色。" : "古蜀石室，低饱和火光。",
    applicability: input.applicability,
  });
  const appended = await appendStudioAssetVersion(root, {
    assetId: input.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    expectedRevision: created.revision,
  });
  let detail = created;
  if ((input.reviewStatus ?? "approved") === "approved") {
    detail = await reviewStudioAssetVersion(root, {
      assetId: input.id,
      versionId: appended.version.id,
      decision: "approved",
      expectedRevision: appended.assetRevision,
      note: "P5 冻结测试资产审核通过。",
    });
  }
  if (input.setAuthority !== false && (input.reviewStatus ?? "approved") === "approved") {
    detail = await setStudioPrimaryAuthority(root, {
      assetId: input.id,
      versionId: appended.version.id,
      expectedRevision: detail.revision,
      note: "P5 当前主权威。",
    });
  }
  return { media, created, appended, detail };
}

async function createForbiddenMaskDefinition(root: string, applicability?: StudioAssetApplicabilityInput) {
  const created = await createStudioCanonicalAsset(root, {
    id: "prop-complete-mask",
    expectedRevision: 0,
    category: "prop",
    name: "完整黄金面具",
    description: "当前阶段只作为布囊内部身份来源。",
    aliases: ["黄金面具"],
    identityFeatures: ["完整结构"],
    positiveLocks: ["身份固定为完整黄金面具"],
    negativeLocks: ["禁止露出实体", "禁止半面具", "禁止裂面具"],
    defaultPrompt: "完整黄金面具藏在布囊内，画面中不可见。",
    applicability,
  });
  const sourcePath = path.join(root, `prop-complete-mask-${created.revision}.png`);
  await sharp({ create: { width: 96, height: 128, channels: 3, background: "#9a7020" } }).png().toFile(sourcePath);
  const media = await importStudioMedia(root, { sourcePath });
  const appended = await appendStudioAssetVersion(root, {
    assetId: created.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    expectedRevision: created.revision,
  });
  const approved = await reviewStudioAssetVersion(root, {
    assetId: created.id,
    versionId: appended.version.id,
    decision: "approved",
    expectedRevision: appended.assetRevision,
    note: "禁止资产也必须锁定可审计权威身份。",
  });
  return setStudioPrimaryAuthority(root, {
    assetId: created.id,
    versionId: appended.version.id,
    expectedRevision: approved.revision,
    note: "完整黄金面具权威仅用于禁止约束身份，不上传。",
  });
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

async function bindLegacyPanel(root: string, unitId: string, panelId: string, refresh = false) {
  const snapshot = await getStudioProductionUnitSnapshot(root, unitId);
  if (!snapshot) throw new Error(`missing test unit ${unitId}`);
  const panel = snapshot.panels.find((item) => item.id === panelId);
  if (!panel) throw new Error(`missing test panel ${panelId}`);
  const current = await getCurrentStudioPanelAssetBindingSet(root, unitId, panelId);
  if (current && !refresh) return current;
  let analysis;
  if (current) {
    const analyses = await import("../src/core/studio-production.js").then(({ getStudioAssetMentionAnalysis }) =>
      getStudioAssetMentionAnalysis(root, current.analysisId));
    if (!analyses) throw new Error("missing current analysis");
    analysis = analyses;
  } else {
    const details = await Promise.all(panel.assets.map((mention) => getStudioCanonicalAsset(root, mention.assetId)));
    if (details.some((detail) => !detail)) throw new Error("test binding requires every legacy mention to have a canonical asset");
    const body = snapshot.scriptRevision.body;
    const mentions = panel.assets.map((mention, index) => ({
      id: `mention-${unitId}-${panel.id}-${String(index + 1).padStart(2, "0")}`,
      surfaceText: body.slice(index, index + 1),
      startOffsetUtf16: index,
      endOffsetUtf16: index + 1,
      category: mention.category,
      presence: mention.presence,
      role: mention.role,
      modelSuggestions: [{ assetId: mention.assetId, category: mention.category, confidence: 1 }],
    }));
    analysis = await analyzeStudioPanelAssetMentions(root, {
      unitId,
      unitRevision: snapshot.unit.revision,
      unitFingerprint: snapshot.fingerprint,
      panelIndex: panel.index,
      scriptRevisionId: snapshot.scriptRevision.id,
      scriptSha256: snapshot.scriptRevision.bodySha256,
      expectedHeadRevision: 0,
      mentions,
      assets: details.map((detail) => ({
        assetId: detail!.id,
        category: detail!.category,
        formalName: detail!.name,
        aliases: detail!.aliases,
      })),
      resolverVersion: "generation-test-v1",
    });
  }
  const decisions = current
    ? await import("../src/core/studio-production.js").then(({ getStudioMentionDecisions }) =>
      getStudioMentionDecisions(root, current.decisionReceiptIds))
    : await Promise.all(analysis.proposals.map((proposal) => {
      const selectedAssetId = proposal.candidates.find((candidate) => candidate.kind === "model")?.assetId
        ?? proposal.candidates[0]?.assetId;
      if (!selectedAssetId) throw new Error(`test proposal has no candidate: ${proposal.id}`);
      return recordStudioMentionDecision(root, {
        receiptId: `decision-${proposal.mentionId}`,
        proposalId: proposal.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedDecisionHeadRevision: 0,
        action: proposal.status === "matched" && proposal.candidates.filter((candidate) => candidate.kind !== "model").length === 1
          ? "accept"
          : "select",
        selectedAssetId,
        presence: proposal.presence,
        role: proposal.role,
        reviewer: "generation-test",
        note: "显式测试确认。",
      });
    }));
  const unitLocalStartSeconds = panel.startSeconds;
  const unitLocalEndSeconds = panel.endSeconds;
  const episodeAbsoluteStartSeconds = (snapshot.unit.sequence - 1) * 15 + panel.startSeconds;
  const episodeAbsoluteEndSeconds = (snapshot.unit.sequence - 1) * 15 + panel.endSeconds;
  const assetSources = await Promise.all(panel.assets.map(async (mention) => {
    const detail = await getStudioCanonicalAsset(root, mention.assetId);
    if (!detail?.primaryAuthority) throw new Error(`test asset lacks authority: ${mention.assetId}`);
    const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId)!;
    const authority = detail.authorityHistory.at(-1)!;
    const version = detail.versions.find((entry) => entry.id === detail.primaryAuthority!.versionId)!;
    const target = {
      projectId: (await inspectManagedProject(root)).project.id,
      seasonId: snapshot.unit.season,
      episodeId: snapshot.unit.episode,
      unitId,
      unitLocalStartSeconds,
      unitLocalEndSeconds,
      episodeAbsoluteStartSeconds,
      episodeAbsoluteEndSeconds,
    };
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, mention.assetId, target);
    if (!knowledge) throw new Error(`missing knowledge ${mention.assetId}`);
    const applicability = evaluateStudioAssetApplicability(definition.applicability, target);
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
      applicabilityFingerprint: digest(applicability),
    };
  }));
  return freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: current?.revision ?? 0,
    decisionReceiptIds: decisions.map((decision) => decision.id),
    assetSources,
  });
}

async function buildStudioGenerationFreezePack(
  root: string,
  input: { unitId: string; panelId: string },
) {
  if (!await getCurrentStudioPanelAssetBindingSet(root, input.unitId, input.panelId)) {
    await bindLegacyPanel(root, input.unitId, input.panelId);
  }
  await seedResolvedContinuityForPanel(root, input.unitId, input.panelId);
  return buildStudioGenerationFreezePackRaw(root, input);
}

async function seedResolvedContinuityForPanel(root: string, unitId: string, panelId: string): Promise<void> {
  const snapshot = await getStudioProductionUnitSnapshot(root, unitId);
  const panel = snapshot?.panels.find((entry) => entry.id === panelId);
  const bindingSet = await getCurrentStudioPanelAssetBindingSet(root, unitId, panelId);
  if (!snapshot || !panel || !bindingSet) throw new Error(`missing continuity fixture target ${unitId}/${panelId}`);
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
        : `测试已确认：${field}`;
      await appendStudioContinuityObservation(root, {
        operationId: `p6-generation-continuity-${unitId}-${bindingSet.unitRevision}-${panelId}-${binding.assetId}-${field}`,
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
            sourceFingerprint: field === "referenceSha256" ? value : digest({ unitId, panelId, assetId: binding.assetId, field, value }),
            note: "P6 regression fixture explicit continuity seed.",
          }],
        },
      });
    }
  }
}

async function readyTwoPanelProject(promptBody?: string) {
  const root = await managedProject();
  const unit = await createUnit(root, 2, true, "unit-2", promptBody);
  const forbiddenMask = await createForbiddenMaskDefinition(root);
  const character = await materializeAsset(root, {
    id: "character-ahang",
    category: "character",
    color: "#66513d",
  });
  const scene = await materializeAsset(root, {
    id: "scene-stone-room",
    category: "scene",
    color: "#25282b",
  });
  return { root, unit, character, scene, forbiddenMask };
}

async function readyUnitGridProject(count: 2 | 3 | 6) {
  const root = await managedProject();
  const text = await textFixture(
    root,
    [
      "只生成一张电影写实分镜，保持阿航面孔、石室光线和完整黄金面具连续性。",
      "当前单元没有冻结 BindingSet；这里只保存锁版视觉投影，禁止冻结或派发生成。",
    ].join("\n"),
  );
  const source = count === 3
    ? panelInputs(text.promptRevision.id, 6).slice(0, 3).map((panel, offset) => ({
        ...panel,
        startSeconds: offset * 5,
        endSeconds: (offset + 1) * 5,
        durationSeconds: 5,
      }))
    : panelInputs(text.promptRevision.id, count);
  source[0] = {
    ...source[0]!,
    visualAction: "一道光痕从画面左下向右上飞行，阿航保持原站位。",
  };
  const snapshot = await createStudioProductionUnit(root, {
    id: `unit-grid-${count}`,
    expectedRevision: 0,
    season: "S1",
    episode: "S1E1",
    sequence: 1,
    title: `${count} 格整板测试`,
    scriptRevisionId: text.scriptRevision.id,
    panels: source,
  });
  await createForbiddenMaskDefinition(root);
  await materializeAsset(root, { id: "character-ahang", category: "character", color: "#66513d" });
  await materializeAsset(root, { id: "scene-stone-room", category: "scene", color: "#25282b" });
  for (const panel of snapshot.panels) {
    await bindLegacyPanel(root, snapshot.unit.id, panel.id);
    await seedResolvedContinuityForPanel(root, snapshot.unit.id, panel.id);
  }
  await createStudioProductionContractProfile(root, {
    profileId: `dudu-grid-${count}`,
    expectedRevision: 0,
    season: "S1",
    episode: "S1E1",
    minControlReferences: 1,
    maxControlReferences: 5,
    sourceFingerprint: createHash("sha256").update(`dudu-grid-contract-${count}`, "utf8").digest("hex"),
  });
  return { root, snapshot };
}

describe("P6 AssetBindingSet 一致性冻结包", () => {
  it("内部连续性 locator 不得被误认为可执行视觉状态", () => {
    expect(isStudioOpaqueContinuityLocator("s1e2:S1E2-U24:panel-fa7009385e31d4b0c3b04b883903e9f4912da5ca:char-shuo:position")).toBe(true);
    expect(isStudioOpaqueContinuityLocator("p6-fixture:S1E2-U01:panel-abc123:char-dudu:facing")).toBe(true);
    expect(isStudioOpaqueContinuityLocator("画面左侧藤窝内，面向右侧母狼")).toBe(false);
    expect(isStudioOpaqueContinuityLocator("d5878702ea948c2184effd8ab6b18d6a7ea6e6a520c64867b8e2cd749b3d1964")).toBe(false);
  });

  it("P30 unit-grid v5 对 2/3/6 格各冻结一次调用整板，且不改变 panel v4 身份", async () => {
    for (const count of [2, 3, 6] as const) {
      const fixture = await readyUnitGridProject(count);
      const firstPanel = fixture.snapshot.panels[0]!;
      const legacyBefore = await buildStudioGenerationFreezePackRaw(fixture.root, {
        unitId: fixture.snapshot.unit.id,
        panelId: firstPanel.id,
      });
      const legacyRequestBefore = serializeStudioGenerationRequest(legacyBefore.request);
      const grid = await buildStudioUnitGridGenerationFreezePack(fixture.root, {
        targetKind: "unit-grid",
        unitId: fixture.snapshot.unit.id,
      });

      expect(grid).toMatchObject({
        schemaVersion: 5,
        kind: "studio-generation-freeze-pack",
        provenance: "unit-grid-binding-sets",
        target: {
          targetKind: "unit-grid",
          targetId: fixture.snapshot.unit.id,
          unitId: fixture.snapshot.unit.id,
          panelCount: count,
          durationSeconds: 15,
          episodeAbsoluteStartSeconds: 0,
          episodeAbsoluteEndSeconds: 15,
        },
        referencePolicy: {
          persisted: true,
          minControlReferences: 1,
          maxControlReferences: 5,
        },
        request: {
          schemaVersion: 5,
          provenance: "unit-grid-binding-sets",
          exactlyOneImage: true,
          maxCalls: 1,
          modelPayload: { layout: "9:16-vertical-ordered-grid" },
        },
      });
      expect(grid.panels).toHaveLength(count);
      expect(grid.panels.map((panel) => panel.panelIndex)).toEqual(
        Array.from({ length: count }, (_, offset) => offset + 1),
      );
      expect(grid.controlReferences).toHaveLength(2);
      expect(grid.request.modelPayload.renderedPrompt).toContain(`电影写实的 ${count} 宫格完整故事板`);
      expect(grid.request.modelPayload.renderedPrompt).toContain("禁止标题、格号、时长、对白文字、字幕、水印、UI、标识和任何伪文字");
      expect(grid.request.modelPayload.renderedPrompt).toContain("角色槽位硬锁：必须出现 1 个唯一角色槽位");
      expect(grid.request.modelPayload.renderedPrompt).toContain("最亮头在右上");
      expect(grid.request.modelPayload.renderedPrompt).toContain("尾迹反向延伸至左下并由粗亮渐细渐暗");
      expect(grid.request.modelPayload.renderedPrompt).not.toContain("当前单元没有冻结 BindingSet");
      expect(grid.request.modelPayload.renderedPrompt).not.toContain("不要拼图、分屏");
      expect(JSON.parse(serializeStudioUnitGridGenerationRequest(grid.request))).toEqual(grid.request);
      await expect(assertStudioUnitGridGenerationFreezePackCurrent(fixture.root, grid)).resolves.toBe(grid);

      const legacyAfter = await buildStudioGenerationFreezePackRaw(fixture.root, {
        unitId: fixture.snapshot.unit.id,
        panelId: firstPanel.id,
      });
      expect(legacyAfter.id).toBe(legacyBefore.id);
      expect(legacyAfter.fingerprint).toBe(legacyBefore.fingerprint);
      expect(serializeStudioGenerationRequest(legacyAfter.request)).toBe(legacyRequestBefore);
    }
  });

  it("成功冻结显式 required/optional 资产、真实证据与修订 SHA，forbidden 绝不进入引用", async () => {
    const fixture = await readyTwoPanelProject();
    const pack = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" });

    expect(pack).toMatchObject({
      schemaVersion: 4,
      kind: "studio-generation-freeze-pack",
      provenance: "asset-binding-set",
      projectId: expect.any(String),
      target: {
        unitId: "unit-2",
        unitRevision: 1,
        panelId: "panel-01",
        panelIndex: 1,
        panelCount: 2,
        totalDurationSeconds: 15,
      },
      request: {
        schemaVersion: 4,
        kind: "studio-codex-generation-request",
        provenance: "asset-binding-set",
        executorKind: "agent-imagegen",
        allowedProviders: ["codex", "grok"],
        exactlyOneImage: true,
        maxCalls: 1,
      },
    });
    expect(pack.id).toBe(`studio-generation-freeze-${pack.fingerprint.slice(0, 32)}`);
    expect(pack.request.id).toBe(`studio-codex-request-${pack.request.fingerprint.slice(0, 32)}`);
    expect(pack.scriptRevision).toMatchObject({
      id: fixture.unit.scriptRevision.id,
      bodySha256: fixture.unit.scriptRevision.bodySha256,
      source: "scripts/EP01.md",
      sourceVersion: "script-v1",
    });
    expect(pack.scriptRevision).not.toHaveProperty("body");
    expect(pack.promptRevision).toMatchObject({
      id: fixture.unit.promptRevision.id,
      bodySha256: fixture.unit.promptRevision.bodySha256,
      body: fixture.unit.promptRevision.body,
    });
    expect(pack.assets.map((asset) => [asset.assetId, asset.presence])).toEqual([
      ["character-ahang", "required"],
      ["scene-stone-room", "optional"],
    ]);
    const character = pack.assets.find((asset) => asset.assetId === "character-ahang")!;
    expect(character).toMatchObject({
      semanticRevision: fixture.character.detail.revision,
      definition: {
        id: fixture.character.detail.currentDefinitionVersionId,
        identityFeatures: ["东方青年面孔", "黑色束发"],
        positiveLocks: ["固定脸", "素麻古蜀服"],
        negativeLocks: ["禁止换脸", "禁止现代服饰"],
        defaultPrompt: "阿航，电影写实，固定角色。",
      },
      authority: { current: true, versionId: fixture.character.appended.version.id },
      version: {
        id: fixture.character.appended.version.id,
        reviewStatus: "approved",
        mediaSha256: fixture.character.media.sha256,
      },
      media: {
        sha256: fixture.character.media.sha256,
        objectPath: fixture.character.media.objectPath,
        casVerified: true,
      },
      continuity: expect.objectContaining({
        assetId: "character-ahang",
        requiredFields: [...STUDIO_CONTINUITY_FIELDS],
        heads: expect.arrayContaining([
          expect.objectContaining({ field: "position", state: expect.objectContaining({ status: "resolved" }) }),
        ]),
      }),
    });
    expect(pack.forbiddenAssets).toEqual([
      expect.objectContaining({
        assetId: "prop-complete-mask",
        presence: "forbidden",
        definition: expect.objectContaining({
          id: fixture.forbiddenMask.currentDefinitionVersionId,
          negativeLocks: ["禁止露出实体", "禁止半面具", "禁止裂面具"],
        }),
      }),
    ]);
    expect(pack.request.modelPayload.forbiddenAssets).toEqual([
      expect.objectContaining({
        assetId: "prop-complete-mask",
        definitionVersionId: fixture.forbiddenMask.currentDefinitionVersionId,
        negativeLocks: ["禁止露出实体", "禁止半面具", "禁止裂面具"],
      }),
    ]);
    expect(pack.request.controlReferences.map((reference) => reference.assetId)).toEqual([
      "character-ahang",
      "scene-stone-room",
    ]);
    expect(pack.request.controlReferences.map((reference) => reference.referenceUsage)).toEqual([
      {
        purpose: "identity",
        inheritOnly: ["all"],
        excludeFromOutput: [],
        carrierPolicy: "none",
      },
      {
        purpose: "identity",
        inheritOnly: ["all"],
        excludeFromOutput: [],
        carrierPolicy: "none",
      },
    ]);
    expect(pack.request.controlReferences.some((reference) => reference.assetId === "prop-complete-mask")).toBe(false);
    expect(pack.request.safetyConstraints.map((constraint) => constraint.assetId)).toEqual(["prop-complete-mask"]);
    expect(pack.assetBinding).toMatchObject({
      bindingSet: { id: expect.stringMatching(/^asset-binding-set-/u), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      analysis: { id: expect.stringMatching(/^mention-analysis-/u), proposals: expect.any(Array) },
      currentness: { head: true, current: true, ready: true },
    });
    expect(pack.panelReferenceResolution).toMatchObject({
      schemaVersion: 3,
      kind: "panel-reference-resolution",
      closure: "resolved",
      generationReady: true,
      panel: { id: "panel-01", index: 1, count: 2 },
    });
    expect(pack.panelReferenceResolution.semanticAssets.map((asset) => asset.assetId).sort()).toEqual([
      "character-ahang",
      "scene-stone-room",
    ]);
    expect(pack.panelReferenceResolution.forbiddenAssets.map((asset) => asset.assetId)).toEqual(["prop-complete-mask"]);
    expect(pack.panelReferenceResolution.controlReferences).toHaveLength(2);
    expect(pack.request.assetBinding.referenceResolutionFingerprint).toBe(pack.panelReferenceResolution.fingerprint);
    expect(pack.assetBinding.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selectedAssetId: "character-ahang",
        presence: "required",
        role: "画面主体，必须保持固定脸、发型与服饰。",
      }),
      expect.objectContaining({
        selectedAssetId: "prop-complete-mask",
        presence: "forbidden",
        role: "当前格不可露出，禁止半面具。",
      }),
    ]));
    expect(pack.request.modelPayload.renderedPrompt).toContain("只生成一张 9:16 竖屏");
    expect(pack.request.modelPayload.layout).toBe("9:16-vertical");
    expect(pack.request.modelPayload.renderedPrompt).toContain("禁止换脸");
    expect(pack.request.modelPayload.renderedPrompt).toContain("禁止出画资产「完整黄金面具」");
    expect(pack.request.modelPayload.renderedPrompt).not.toContain(fixture.character.media.objectPath);

    const serialized = serializeStudioGenerationRequest(pack.request);
    expect(JSON.parse(serialized)).toEqual(pack.request);
    expect(JSON.parse(serialized).sourceRevisions.sourceSpans).toEqual([
      expect.objectContaining({
        startOffsetUtf16: 0,
        endOffsetUtf16: 7,
        surfaceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(serialized).toContain("startOffsetUtf16");
    expect(serialized).toContain("endOffsetUtf16");
  });

  it("definition 中的 reference-only 尺度载体约定自动冻结为结构化 usage，并防止载体语义被篡改", async () => {
    const fixture = await readyTwoPanelProject();
    const current = await getStudioCanonicalAsset(fixture.root, fixture.scene.detail.id);
    if (!current) throw new Error("missing reference-usage fixture asset");
    await updateStudioCanonicalAsset(fixture.root, {
      assetId: current.id,
      expectedRevision: current.revision,
      description: "微型暗铁硬壳碎片；approved Authority 用厚手套指尖提供实物尺度。手套、手指和夹持姿势仅是尺度载体，不属于碎片身份。",
      identityFeatures: [
        "微型暗铁硬壳碎片",
        "一端斜切尖角",
        "另一端半月缺口",
        "内部唯一红黑双脉",
      ],
      positiveLocks: [
        "只继承碎片本体的形制、材质、指纹和微小相对尺度",
      ],
      negativeLocks: [
        "不得复制 Authority 中用于标定尺度的手套、手指、夹持姿势或微距背景",
      ],
      defaultPrompt: "Authority 中手套、手指、夹持动作和背景均为 reference-only 标尺载体，必须排除。",
    });

    const expectedUsage = {
      purpose: "scale-reference" as const,
      inheritOnly: ["碎片形制", "材质", "指纹", "相对尺度"],
      excludeFromOutput: ["手套", "手指", "夹持姿势", "背景"],
      carrierPolicy: "reference-only" as const,
    };
    expect(deriveStudioReferenceUsage({
      description: "E-R1 尺度载体",
      identityFeatures: ["微型碎片"],
      positiveLocks: ["继承形制材质指纹相对尺度"],
      negativeLocks: ["排除手套、手指、夹持姿势和背景"],
      defaultPrompt: "reference-only 标尺载体",
    })).toEqual(expectedUsage);
    expect(deriveStudioReferenceUsage({
      description: "E-R1 与冥灯比例控制；冥灯只是尺度载体，不属于物证身份。",
      identityFeatures: ["E-R1 最长边约为灯笼主体宽度五分之一"],
      positiveLocks: ["只继承 E-R1 与灯笼的相对尺度"],
      negativeLocks: ["不得复制冥灯或背景"],
      defaultPrompt: "灯笼和背景均为 reference-only 尺度载体，必须排除。",
    })).toEqual({
      purpose: "scale-reference",
      inheritOnly: ["碎片形制", "材质", "指纹", "相对尺度"],
      excludeFromOutput: ["灯笼", "背景"],
      carrierPolicy: "reference-only",
    });

    const pack = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: fixture.unit.snapshot.unit.id,
      panelId: "panel-01",
    });
    const frozen = pack.assets.find((asset) => asset.assetId === fixture.scene.detail.id)!;
    const modelAsset = pack.request.modelPayload.assets.find((asset) => asset.assetId === fixture.scene.detail.id)!;
    const control = pack.request.controlReferences.find((reference) => reference.assetId === fixture.scene.detail.id)!;
    expect(frozen.referenceUsage).toEqual(expectedUsage);
    expect(modelAsset.referenceUsage).toEqual(expectedUsage);
    expect(control.referenceUsage).toEqual(expectedUsage);
    expect(pack.request.modelPayload.renderedPrompt).toContain("参考用途「古蜀石室」：scale-reference");
    expect(pack.request.modelPayload.renderedPrompt).toContain("只继承「古蜀石室」：碎片形制；材质；指纹；相对尺度");
    expect(pack.request.modelPayload.renderedPrompt).toContain("禁止复制载体「古蜀石室」：手套；手指；夹持姿势；背景");
    expect(pack.request.modelPayload.renderedPrompt).toContain("reference-only 参考的载体排除优先且不得被本句覆盖");
    expect(buildStudioAgentImagegenBrief(pack, "codex").controlReferences
      .find((reference) => reference.assetId === fixture.scene.detail.id)?.referenceUsage)
      .toEqual(expectedUsage);

    const tampered = structuredClone(pack.request);
    tampered.controlReferences.find((reference) => reference.assetId === fixture.scene.detail.id)!
      .referenceUsage!.excludeFromOutput = ["背景"];
    const { id: _tamperedId, fingerprint: _tamperedFingerprint, ...tamperedSemantic } = tampered;
    tampered.fingerprint = digest(tamperedSemantic);
    tampered.id = `studio-codex-request-${tampered.fingerprint.slice(0, 32)}`;
    expect(() => serializeStudioGenerationRequest(tampered)).toThrow(/referenceUsage.*不一致/u);
  });

  it("历史 schema v4 请求缺 layout 时保留原内容地址并按 9:16 双读", async () => {
    const fixture = await readyTwoPanelProject();
    const frozen = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: "unit-2",
      panelId: "panel-01",
    });
    const legacy = structuredClone(frozen.request);
    delete legacy.modelPayload.layout;
    const { id: _requestId, fingerprint: _requestFingerprint, ...semantic } = legacy;
    legacy.fingerprint = digest(semantic);
    legacy.id = `studio-codex-request-${legacy.fingerprint.slice(0, 32)}`;

    expect(effectiveStudioPanelImageLayout(legacy.modelPayload)).toBe("9:16-vertical");
    expect(JSON.parse(serializeStudioGenerationRequest(legacy))).toEqual(legacy);
  });

  it("source span 越界或与 BindingSet 来源链不一致时，即使重算内容地址也失败关闭", async () => {
    const fixture = await readyTwoPanelProject();
    const frozen = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    const outOfBounds = structuredClone(frozen.request);
    outOfBounds.sourceRevisions.sourceSpans[0]!.endOffsetUtf16 = outOfBounds.sourceRevisions.script.bodySizeUtf16 + 1;
    const { id: _requestId, fingerprint: _requestFingerprint, ...outOfBoundsSemantic } = outOfBounds;
    outOfBounds.fingerprint = digest(outOfBoundsSemantic);
    outOfBounds.id = `studio-codex-request-${outOfBounds.fingerprint.slice(0, 32)}`;
    expect(() => serializeStudioGenerationRequest(outOfBounds)).toThrow(/source span/u);

    const crossLinked = structuredClone(frozen);
    crossLinked.request.sourceRevisions.sourceSpans[0]!.startOffsetUtf16 = 1;
    crossLinked.request.sourceRevisions.sourceSpans[0]!.surfaceSha256 = digest("伪造但格式合法的来源表面");
    const { id: _crossRequestId, fingerprint: _crossRequestFingerprint, ...crossRequestSemantic } = crossLinked.request;
    crossLinked.request.fingerprint = digest(crossRequestSemantic);
    crossLinked.request.id = `studio-codex-request-${crossLinked.request.fingerprint.slice(0, 32)}`;
    const { id: _packId, fingerprint: _packFingerprint, ...crossPackSemantic } = crossLinked;
    crossLinked.fingerprint = digest(crossPackSemantic);
    crossLinked.id = `studio-generation-freeze-${crossLinked.fingerprint.slice(0, 32)}`;
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, crossLinked))
      .rejects.toMatchObject({ code: "input-drift", message: expect.stringContaining("provenance") });

    const resolutionTampered = structuredClone(frozen);
    resolutionTampered.panelReferenceResolution.generationReady = false;
    const { id: _resolutionPackId, fingerprint: _resolutionPackFingerprint, ...resolutionPackSemantic } = resolutionTampered;
    resolutionTampered.fingerprint = digest(resolutionPackSemantic);
    resolutionTampered.id = `studio-generation-freeze-${resolutionTampered.fingerprint.slice(0, 32)}`;
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, resolutionTampered))
      .rejects.toMatchObject({ code: "input-drift", message: expect.stringContaining("引用闭包") });
  });

  it("对 allowed 与 forbidden 都按真实项目、集、单元和宫格秒段做适用范围门禁", async () => {
    const root = await managedProject();
    await createUnit(root, 2, false);
    const projectId = (await inspectManagedProject(root)).project.id;
    const scopedApplicability: StudioAssetApplicabilityInput = {
      projects: [projectId],
      seasons: ["S03"],
      episodes: ["EP01"],
      units: ["unit-2"],
      timeRanges: [{ scope: "unit", scopeId: "unit-2", startSeconds: 0, endSeconds: 7, label: "第一格" }],
      tags: ["范围门禁"],
    };
    const character = await materializeAsset(root, {
      id: "character-ahang",
      category: "character",
      color: "#6b513c",
      applicability: scopedApplicability,
    });
    const forbiddenMask = await createForbiddenMaskDefinition(root, scopedApplicability);

    const inScope = await buildStudioGenerationFreezePack(root, { unitId: "unit-2", panelId: "panel-01" });
    expect(inScope.target).toMatchObject({
      seasonId: "S03",
      episodeId: "EP01",
      unitSequence: 1,
      unitLocalStartSeconds: 0,
      unitLocalEndSeconds: 7,
      episodeAbsoluteStartSeconds: 0,
      episodeAbsoluteEndSeconds: 7,
    });
    expect(inScope.assets[0]).toMatchObject({
      assetId: "character-ahang",
      applicabilityEvaluation: { applicable: true, reasons: [], matchedTimeRange: { label: "第一格" } },
      definition: { applicability: { projects: [projectId], seasons: ["S03"], episodes: ["EP01"], units: ["unit-2"] } },
    });
    expect(inScope.forbiddenAssets[0]).toMatchObject({
      assetId: "prop-complete-mask",
      applicabilityEvaluation: { applicable: true, reasons: [] },
    });

    await expect(buildStudioGenerationFreezePack(root, { unitId: "unit-2", panelId: "panel-02" }))
      .rejects.toMatchObject({ code: "asset-not-applicable", details: ["character-ahang:time-range-mismatch"] });
    const outOfScopeQuery = await queryStudioGenerationFreeze(root, { unitId: "unit-2", panelId: "panel-02" });
    expect(outOfScopeQuery).toMatchObject({ status: "blocked", code: "asset-not-applicable" });
    expect(outOfScopeQuery).not.toHaveProperty("request");

    await updateStudioCanonicalAsset(root, {
      assetId: character.detail.id,
      expectedRevision: character.detail.revision,
      applicability: { projects: [projectId], episodes: ["EP01"], units: ["unit-2"] },
    });
    await updateStudioCanonicalAsset(root, {
      assetId: forbiddenMask.id,
      expectedRevision: forbiddenMask.revision,
      applicability: { episodes: ["EP02"] },
    });
    await expect(buildStudioGenerationFreezePack(root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "asset-not-applicable", details: ["prop-complete-mask:episode-mismatch"] });
  });

  it("集级时间段使用跨单元绝对秒，季、集和绝对区间任一不符都阻断冻结", async () => {
    const root = await managedProject();
    const text = await textFixture(root);
    await createStudioProductionUnit(root, {
      id: "unit-ep01-sequence-2",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 2,
      title: "EP01 第二个 15 秒单元",
      scriptRevisionId: text.scriptRevision.id,
      panels: panelInputs(text.promptRevision.id, 2, { includeOptionalScene: false }),
    });
    const applicability: StudioAssetApplicabilityInput = {
      seasons: ["S03"],
      episodes: ["EP01"],
      units: ["unit-ep01-sequence-2"],
      timeRanges: [{ scope: "episode", scopeId: "EP01", startSeconds: 15, endSeconds: 22, label: "第二单元第一格" }],
    };
    const character = await materializeAsset(root, {
      id: "character-ahang",
      category: "character",
      color: "#6b513c",
      applicability,
    });
    await createForbiddenMaskDefinition(root, applicability);

    const firstPanel = await buildStudioGenerationFreezePack(root, {
      unitId: "unit-ep01-sequence-2",
      panelId: "panel-01",
    });
    expect(firstPanel.target).toMatchObject({
      seasonId: "S03",
      episodeId: "EP01",
      unitSequence: 2,
      unitLocalStartSeconds: 0,
      unitLocalEndSeconds: 7,
      episodeAbsoluteStartSeconds: 15,
      episodeAbsoluteEndSeconds: 22,
    });
    expect(firstPanel.assets[0]?.applicabilityEvaluation).toMatchObject({
      applicable: true,
      matchedTimeRange: { scope: "episode", label: "第二单元第一格" },
    });
    await expect(buildStudioGenerationFreezePack(root, {
      unitId: "unit-ep01-sequence-2",
      panelId: "panel-02",
    })).rejects.toMatchObject({ code: "asset-not-applicable", details: ["character-ahang:time-range-mismatch"] });

    const wrongSeason = await updateStudioCanonicalAsset(root, {
      assetId: character.detail.id,
      expectedRevision: character.detail.revision,
      applicability: { ...applicability, seasons: ["S04"] },
    });
    await expect(buildStudioGenerationFreezePack(root, {
      unitId: "unit-ep01-sequence-2",
      panelId: "panel-01",
    })).rejects.toMatchObject({ code: "asset-not-applicable", details: ["character-ahang:season-mismatch"] });

    await updateStudioCanonicalAsset(root, {
      assetId: character.detail.id,
      expectedRevision: wrongSeason.revision,
      applicability: {
        seasons: ["S03"],
        episodes: ["EP02"],
        units: ["unit-ep01-sequence-2"],
        timeRanges: [{ scope: "episode", scopeId: "EP02", startSeconds: 15, endSeconds: 22 }],
      },
    });
    await expect(buildStudioGenerationFreezePack(root, {
      unitId: "unit-ep01-sequence-2",
      panelId: "panel-01",
    })).rejects.toMatchObject({
      code: "asset-not-applicable",
      details: ["character-ahang:episode-mismatch", "character-ahang:time-range-mismatch"],
    });
  });

  it("组合资产冻结 inbound composite_member 的完整端点快照，不额外添加控制参考", async () => {
    const fixture = await readyTwoPanelProject();
    const relation = await appendStudioAssetRelation(fixture.root, {
      id: "relation-ahang-stone-room-composite",
      kind: "composite_member",
      subjectAssetId: fixture.character.detail.id,
      objectAssetId: fixture.scene.detail.id,
      expectedSubjectRevision: fixture.character.detail.revision,
      expectedObjectRevision: fixture.scene.detail.revision,
      ordinal: 1,
      role: "组合参考中的主角",
      note: "测试组合成员溯源",
    });

    const pack = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    const character = pack.assets.find((asset) => asset.assetId === fixture.character.detail.id)!;
    const composite = pack.assets.find((asset) => asset.assetId === fixture.scene.detail.id)!;
    expect(character.relations).toEqual([]);
    expect(composite.relations).toEqual([
      expect.objectContaining({
        current: true,
        relation: expect.objectContaining({
          id: relation.id,
          kind: "composite_member",
          ordinal: 1,
          fingerprint: relation.fingerprint,
          subject: expect.objectContaining({
            assetId: fixture.character.detail.id,
            definitionVersionId: fixture.character.detail.currentDefinitionVersionId,
            authorityVersionId: fixture.character.appended.version.id,
            authorityMediaSha256: fixture.character.media.sha256,
          }),
          object: expect.objectContaining({
            assetId: fixture.scene.detail.id,
            definitionVersionId: fixture.scene.detail.currentDefinitionVersionId,
            authorityVersionId: fixture.scene.appended.version.id,
            authorityMediaSha256: fixture.scene.media.sha256,
          }),
        }),
        subject: expect.objectContaining({
          semanticCurrent: true,
          snapshot: expect.objectContaining({ assetId: fixture.character.detail.id }),
          current: expect.objectContaining({ assetId: fixture.character.detail.id }),
        }),
        object: expect.objectContaining({
          semanticCurrent: true,
          snapshot: expect.objectContaining({ assetId: fixture.scene.detail.id }),
          current: expect.objectContaining({ assetId: fixture.scene.detail.id }),
        }),
      }),
    ]);
    expect(composite.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(pack.request.modelPayload.assets.find((asset) => asset.assetId === fixture.scene.detail.id)?.relations)
      .toEqual(composite.relations);
    expect(pack.request.controlReferences.map((reference) => reference.assetId)).toEqual([
      "character-ahang",
      "scene-stone-room",
    ]);
  });

  it("组合无权威时建立成员关系，锁定组合权威后可显式 rebase 恢复冻结且旧历史不阻断", async () => {
    const fixture = await readyTwoPanelProject();
    const composite = await createStudioCanonicalAsset(fixture.root, {
      id: "scene-composite-board",
      expectedRevision: 0,
      category: "scene",
      name: "阿航组合参考板",
      positiveLocks: ["组合成员位置固定"],
    });
    const first = await appendStudioAssetRelation(fixture.root, {
      id: "relation-composite-before-authority",
      kind: "composite_member",
      subjectAssetId: fixture.character.detail.id,
      objectAssetId: composite.id,
      expectedSubjectRevision: fixture.character.detail.revision,
      expectedObjectRevision: composite.revision,
      ordinal: 1,
      role: "左侧阿航",
      note: "组合板成员来源",
    });
    expect(first.object).not.toHaveProperty("authorityVersionId");

    const sourcePath = path.join(fixture.root, "scene-composite-board-authority.png");
    await sharp({ create: { width: 96, height: 128, channels: 3, background: "#30332f" } }).png().toFile(sourcePath);
    const media = await importStudioMedia(fixture.root, { sourcePath });
    const compositeAfterRelation = await getStudioCanonicalAsset(fixture.root, composite.id);
    const appended = await appendStudioAssetVersion(fixture.root, {
      assetId: composite.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      expectedRevision: compositeAfterRelation!.revision,
      sourceNote: "组合板权威图",
    });
    const approved = await reviewStudioAssetVersion(fixture.root, {
      assetId: composite.id,
      versionId: appended.version.id,
      decision: "approved",
      expectedRevision: appended.assetRevision,
      note: "组合板权威图审核通过。",
    });
    const authoritative = await setStudioPrimaryAuthority(fixture.root, {
      assetId: composite.id,
      versionId: appended.version.id,
      expectedRevision: approved.revision,
      note: "锁定组合板权威",
    });
    expect(await getStudioAssetRelationCurrentness(fixture.root, first.id)).toMatchObject({
      head: true,
      current: false,
      relation: { status: "stale" },
      object: { authorityCurrent: false },
    });

    const panels: StudioProductionPanelInput[] = [
      { id: "composite-panel-01", title: "组合板第一格", startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
      { id: "composite-panel-02", title: "组合板第二格", startSeconds: 7, endSeconds: 15, durationSeconds: 8 },
    ].map((panel) => ({
      ...panel,
      visualAction: "依据已锁定组合参考板生成画面。",
      shotComposition: "中景，人物居中。",
      filmingMethod: "固定机位。",
      promptRevisionId: fixture.unit.promptRevision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 7 }],
      assets: [{
        assetId: composite.id,
        category: "scene" as const,
        presence: "required" as const,
        role: "当前组合控制参考。",
        continuityState: "组合成员位置固定。",
        evidence: [{ kind: "relation-rebase-test", reference: first.id }],
      }],
    }));
    await createStudioProductionUnit(fixture.root, {
      id: "unit-composite-rebase",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 8,
      title: "组合关系重建单元",
      scriptRevisionId: fixture.unit.scriptRevision.id,
      panels,
    });
    await expect(buildStudioGenerationFreezePack(fixture.root, {
      unitId: "unit-composite-rebase",
      panelId: "composite-panel-01",
    })).rejects.toMatchObject({ code: "asset-relation-stale", message: expect.stringContaining(first.id) });

    const memberCurrent = await getStudioCanonicalAsset(fixture.root, fixture.character.detail.id);
    const second = await appendStudioAssetRelation(fixture.root, {
      id: "relation-composite-after-authority",
      supersedesRelationId: first.id,
      kind: first.kind,
      subjectAssetId: first.subject.assetId,
      objectAssetId: first.object.assetId,
      expectedSubjectRevision: memberCurrent!.revision,
      expectedObjectRevision: authoritative.revision,
      ordinal: first.ordinal,
      role: first.role,
      note: first.note,
    });
    await bindLegacyPanel(fixture.root, "unit-composite-rebase", "composite-panel-01", true);
    const pack = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: "unit-composite-rebase",
      panelId: "composite-panel-01",
    });
    const frozenComposite = pack.assets[0]!;
    expect(frozenComposite.relations).toHaveLength(1);
    expect(frozenComposite.relations[0]).toMatchObject({
      current: true,
      relation: {
        id: second.id,
        seriesId: first.id,
        revision: 2,
        supersedesRelationId: first.id,
        head: true,
      },
    });
    expect(frozenComposite.relations[0]!.relation.id).not.toBe(first.id);
    expect(frozenComposite.semanticRevision).toBe(authoritative.authorityHistory.at(-1)!.assetRevision);
    expect(frozenComposite.semanticRevision).toBeLessThan((await getStudioCanonicalAsset(fixture.root, composite.id))!.revision);

    const memberAfterRebase = await getStudioCanonicalAsset(fixture.root, fixture.character.detail.id);
    await updateStudioCanonicalAsset(fixture.root, {
      assetId: memberAfterRebase!.id,
      expectedRevision: memberAfterRebase!.revision,
      description: "成员端点再次漂移",
    });
    await expect(buildStudioGenerationFreezePack(fixture.root, {
      unitId: "unit-composite-rebase",
      panelId: "composite-panel-01",
    })).rejects.toMatchObject({ code: "asset-relation-stale", message: expect.stringContaining(second.id) });
  });

  it("派生资产只冻结自身 outgoing 关系，过期的 incoming derived 不会让来源资产失效", async () => {
    const root = await managedProject();
    const text = await textFixture(root);
    const derivative = await materializeAsset(root, {
      id: "character-derived-reference",
      category: "character",
      color: "#604b39",
    });
    const source = await materializeAsset(root, {
      id: "scene-source-reference",
      category: "scene",
      color: "#24292c",
    });
    const panelsFor = (
      prefix: string,
      assetId: string,
      category: StudioCanonicalAssetCategory,
    ): StudioProductionPanelInput[] => [7, 8].map((duration, index) => ({
      id: `${prefix}-panel-${index + 1}`,
      title: `${prefix} 宫格 ${index + 1}`,
      visualAction: "显式关系范围测试。",
      shotComposition: "中景。",
      filmingMethod: "固定机位。",
      startSeconds: index === 0 ? 0 : 7,
      endSeconds: index === 0 ? 7 : 15,
      durationSeconds: duration,
      promptRevisionId: text.promptRevision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 7 }],
      assets: [{
        assetId,
        category,
        presence: "required",
        role: "显式唯一控制参考。",
        continuityState: "沿用权威版本。",
        evidence: [{ kind: "relation-test", reference: assetId }],
      }],
    }));
    await createStudioProductionUnit(root, {
      id: "unit-derived-only",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "派生资产单元",
      scriptRevisionId: text.scriptRevision.id,
      panels: panelsFor("derived", derivative.detail.id, "character"),
    });
    await createStudioProductionUnit(root, {
      id: "unit-source-only",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 2,
      title: "来源资产单元",
      scriptRevisionId: text.scriptRevision.id,
      panels: panelsFor("source", source.detail.id, "scene"),
    });
    const sourcePackBeforeIncomingRelation = await buildStudioGenerationFreezePack(root, {
      unitId: "unit-source-only",
      panelId: "source-panel-1",
    });
    const relation = await appendStudioAssetRelation(root, {
      id: "relation-derived-source",
      kind: "derived_from",
      subjectAssetId: derivative.detail.id,
      objectAssetId: source.detail.id,
      expectedSubjectRevision: derivative.detail.revision,
      expectedObjectRevision: source.detail.revision,
      role: "由来源场景派生的角色参考",
    });
    await expect(assertStudioGenerationFreezePackCurrent(root, sourcePackBeforeIncomingRelation))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
    await bindLegacyPanel(root, "unit-source-only", "source-panel-1", true);
    const sourcePackAfterBindingRefresh = await buildStudioGenerationFreezePack(root, {
      unitId: "unit-source-only",
      panelId: "source-panel-1",
    });
    expect(sourcePackAfterBindingRefresh.id).not.toBe(sourcePackBeforeIncomingRelation.id);
    expect(sourcePackAfterBindingRefresh.assets[0]!.relations).toEqual([]);
    const currentDerived = await buildStudioGenerationFreezePack(root, {
      unitId: "unit-derived-only",
      panelId: "derived-panel-1",
    });
    expect(currentDerived.assets[0]!.relations).toEqual([
      expect.objectContaining({ current: true, relation: expect.objectContaining({ id: relation.id, kind: "derived_from" }) }),
    ]);

    const derivativeAfterRelation = await getStudioCanonicalAsset(root, derivative.detail.id);
    await updateStudioCanonicalAsset(root, {
      assetId: derivativeAfterRelation!.id,
      expectedRevision: derivativeAfterRelation!.revision,
      description: "派生资产定义已漂移。",
    });
    await expect(buildStudioGenerationFreezePack(root, {
      unitId: "unit-source-only",
      panelId: "source-panel-1",
    })).rejects.toMatchObject({ code: "asset-binding-stale" });
    await expect(assertStudioGenerationFreezePackCurrent(root, sourcePackBeforeIncomingRelation))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
    await expect(assertStudioGenerationFreezePackCurrent(root, sourcePackAfterBindingRefresh))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
    await expect(buildStudioGenerationFreezePack(root, {
      unitId: "unit-derived-only",
      panelId: "derived-panel-1",
    })).rejects.toMatchObject({ code: "asset-relation-stale", message: expect.stringContaining(relation.id) });
  });

  it.each(["definition", "authority"] as const)(
    "组合成员 %s 漂移时以 asset-relation-stale 拒绝冻结",
    async (driftKind) => {
      const fixture = await readyTwoPanelProject();
      const relation = await appendStudioAssetRelation(fixture.root, {
        id: `relation-member-${driftKind}-drift`,
        kind: "composite_member",
        subjectAssetId: fixture.character.detail.id,
        objectAssetId: fixture.scene.detail.id,
        expectedSubjectRevision: fixture.character.detail.revision,
        expectedObjectRevision: fixture.scene.detail.revision,
        ordinal: 1,
        role: "组合参考主角",
      });
      const member = await getStudioCanonicalAsset(fixture.root, fixture.character.detail.id);
      expect(member).not.toBeNull();
      if (driftKind === "definition") {
        await updateStudioCanonicalAsset(fixture.root, {
          assetId: member!.id,
          expectedRevision: member!.revision,
          positiveLocks: [...member!.positiveLocks, "成员定义已修订"],
        });
      } else {
        const replacementPath = path.join(fixture.root, "character-ahang-authority-replacement.png");
        await sharp({ create: { width: 96, height: 128, channels: 3, background: "#30261e" } }).png().toFile(replacementPath);
        const replacementMedia = await importStudioMedia(fixture.root, { sourcePath: replacementPath });
        const appended = await appendStudioAssetVersion(fixture.root, {
          assetId: member!.id,
          mediaSha256: replacementMedia.sha256,
          reviewStatus: "pending",
          expectedRevision: member!.revision,
        });
        const approved = await reviewStudioAssetVersion(fixture.root, {
          assetId: member!.id,
          versionId: appended.version.id,
          decision: "approved",
          expectedRevision: appended.assetRevision,
          note: "成员替换权威审核通过。",
        });
        await setStudioPrimaryAuthority(fixture.root, {
          assetId: member!.id,
          versionId: appended.version.id,
          expectedRevision: approved.revision,
          note: "成员权威漂移测试。",
        });
      }

      await expect(buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" }))
        .rejects.toMatchObject({
          code: "asset-relation-stale",
          message: expect.stringContaining(relation.id),
          details: [expect.stringContaining(`definition=${driftKind === "definition" ? "false" : "true"}`), expect.any(String)],
        });
    },
  );

  it("内容寻址与查询完全幂等，2 格和 6 格目标都可冻结", async () => {
    const fixture = await readyTwoPanelProject();
    const first = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-02" });
    const second = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-02" });
    expect(second).toEqual(first);
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, first)).resolves.toEqual(first);
    const query = await queryStudioGenerationFreeze(fixture.root, { unitId: "unit-2", panelId: "panel-02" });
    expect(query).toMatchObject({ status: "ready", packId: first.id, fingerprint: first.fingerprint, request: first.request });

    await createStudioProductionUnit(fixture.root, {
      id: "unit-6",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 2,
      title: "6 宫格生产单元",
      scriptRevisionId: fixture.unit.scriptRevision.id,
      panels: panelInputs(fixture.unit.promptRevision.id, 6),
    });
    const six = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-6", panelId: "panel-06" });
    expect(six.target).toMatchObject({
      seasonId: "S03",
      episodeId: "EP01",
      unitSequence: 2,
      panelIndex: 6,
      panelCount: 6,
      durationSeconds: 3,
      unitLocalEndSeconds: 15,
      episodeAbsoluteStartSeconds: 27,
      episodeAbsoluteEndSeconds: 30,
      totalDurationSeconds: 15,
    });
  });

  it("同一 15 秒单元只改其他宫格时保持目标格冻结包稳定，改目标格才失败关闭", async () => {
    const fixture = await readyTwoPanelProject();
    const first = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    const original = await getStudioProductionUnitSnapshot(fixture.root, "unit-2");
    expect(original).not.toBeNull();
    const otherPanelChanged = panelInputs(original!.panels[0]!.promptRevisionId, 2);
    otherPanelChanged[1]!.visualAction = "嘟嘟在第二格转身警戒；第一格保持完全不变。";
    const revised = await reviseStudioProductionUnit(fixture.root, {
      unitId: original!.unit.id,
      expectedRevision: original!.unit.revision,
      season: original!.unit.season,
      episode: original!.unit.episode,
      sequence: original!.unit.sequence,
      title: original!.unit.title,
      scriptRevisionId: original!.scriptRevision.id,
      panels: otherPanelChanged,
    });
    expect(revised.unit.revision).toBe(2);
    const rebuilt = await buildStudioGenerationFreezePackRaw(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    expect(rebuilt).toEqual(first);
    expect(rebuilt.target.unitRevision).toBe(1);
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, first)).resolves.toEqual(first);

    const targetPanelChanged = structuredClone(otherPanelChanged);
    targetPanelChanged[0]!.visualAction = "阿航在第一格突然回头，目标格语义已变化。";
    await reviseStudioProductionUnit(fixture.root, {
      unitId: revised.unit.id,
      expectedRevision: revised.unit.revision,
      season: revised.unit.season,
      episode: revised.unit.episode,
      sequence: revised.unit.sequence,
      title: revised.unit.title,
      scriptRevisionId: revised.scriptRevision.id,
      panels: targetPanelChanged,
    });
    await expect(buildStudioGenerationFreezePackRaw(fixture.root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, first))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
  });

  it("当前主权威版本未 approved 时失败关闭，blocked 查询不泄漏 request", async () => {
    const fixture = await readyTwoPanelProject();
    await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    const sourcePath = path.join(fixture.root, "character-ahang-pending.png");
    await sharp({ create: { width: 96, height: 128, channels: 3, background: "#704d36" } }).png().toFile(sourcePath);
    const media = await importStudioMedia(fixture.root, { sourcePath });
    const current = await getStudioCanonicalAsset(fixture.root, "character-ahang");
    const pending = await appendStudioAssetVersion(fixture.root, {
      assetId: "character-ahang",
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      expectedRevision: current!.revision,
    });
    const db = new DatabaseSync(path.join(fixture.root, ".aicanvas", "material-studio.sqlite"));
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    db.prepare("UPDATE studio_canonical_assets SET primary_version_id = ?, revision = revision + 1 WHERE id = ?")
      .run(pending.version.id, "character-ahang");
    db.exec("COMMIT");
    db.close();

    await expect(buildStudioGenerationFreezePackRaw(fixture.root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "version-not-approved" });
    const query = await queryStudioGenerationFreeze(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    expect(query).toMatchObject({ status: "blocked", code: "version-not-approved" });
    expect(query).not.toHaveProperty("request");
    expect(query).not.toHaveProperty("pack");
  });

  it("只有历史 panel.assets、缺少 current BindingSet 时永久失败关闭", async () => {
    const root = await managedProject();
    await createUnit(root, 2, false);
    await expect(buildStudioGenerationFreezePackRaw(root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "asset-binding-missing", message: expect.stringContaining("panel.assets") });
  });

  it("媒体 CAS 字节与冻结 SHA 漂移时立即拒绝", async () => {
    const root = await managedProject();
    await createUnit(root, 2, false);
    await createForbiddenMaskDefinition(root);
    const character = await materializeAsset(root, {
      id: "character-ahang",
      category: "character",
      color: "#59432f",
    });
    await bindLegacyPanel(root, "unit-2", "panel-01");
    expect(await readFile(character.media.objectPath)).not.toEqual(Buffer.from("tampered"));
    await writeFile(character.media.objectPath, "tampered", "utf8");

    await expect(buildStudioGenerationFreezePackRaw(root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "media-drift" });
  });

  it("冻结后 definition/锁定修订变化会被 currentness 校验识别为输入漂移", async () => {
    const root = await managedProject();
    await createUnit(root, 2, false);
    await createForbiddenMaskDefinition(root);
    const character = await materializeAsset(root, {
      id: "character-ahang",
      category: "character",
      color: "#4f3d31",
    });
    const frozen = await buildStudioGenerationFreezePack(root, { unitId: "unit-2", panelId: "panel-01" });
    await updateStudioCanonicalAsset(root, {
      assetId: "character-ahang",
      expectedRevision: character.detail.revision,
      negativeLocks: ["禁止换脸", "禁止现代服饰", "禁止半面具"],
    });

    await expect(assertStudioGenerationFreezePackCurrent(root, frozen))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
    await bindLegacyPanel(root, "unit-2", "panel-01", true);
    const refreshed = await buildStudioGenerationFreezePack(root, { unitId: "unit-2", panelId: "panel-01" });
    expect(refreshed.id).not.toBe(frozen.id);
    expect(refreshed.assets[0]!.definition.negativeLocks).toContain("禁止半面具");
  });

  it("decision 的 selected asset、presence 或 role 修订后旧 BindingSet 与冻结包立即 stale", async () => {
    const fixture = await readyTwoPanelProject();
    const frozen = await buildStudioGenerationFreezePack(fixture.root, { unitId: "unit-2", panelId: "panel-01" });
    const characterDecision = frozen.assetBinding.decisions.find((decision) => decision.selectedAssetId === "character-ahang")!;
    const head = await getCurrentStudioMentionDecision(fixture.root, characterDecision.proposalId);
    expect(head?.decision.id).toBe(characterDecision.id);
    await recordStudioMentionDecision(fixture.root, {
      receiptId: "decision-character-ahang-role-revision",
      proposalId: characterDecision.proposalId,
      expectedAnalysisHeadRevision: frozen.assetBinding.analysis.revision,
      expectedDecisionHeadRevision: head!.revision,
      action: "select",
      selectedAssetId: "character-ahang",
      presence: "optional",
      role: "改为远景路人，故意制造语义漂移。",
      reviewer: "generation-test",
      note: "验证 decision head 漂移必须使旧 BindingSet 失效。",
    });

    await expect(assertStudioGenerationFreezePackCurrent(fixture.root, frozen))
      .rejects.toMatchObject({
        code: "asset-binding-stale",
        details: expect.arrayContaining([expect.stringContaining("decision-head-changed")]),
      });
    await expect(buildStudioGenerationFreezePackRaw(fixture.root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "asset-binding-stale" });
  });

  it("单格超过 6 项控制参考时失败关闭，要求先建立组合派生资产", async () => {
    const root = await managedProject();
    const text = await textFixture(root);
    const references: StudioProductionPanelInput["assets"] = [];
    for (let index = 1; index <= 7; index += 1) {
      const id = `character-group-${index}`;
      const color = `#${(0x222222 + index * 0x080808).toString(16).padStart(6, "0").slice(-6)}`;
      await materializeAsset(root, { id, category: "character", color });
      references.push({
        assetId: id,
        category: "character" as const,
        presence: "required" as const,
        role: `群像角色 ${index}`,
        continuityState: "沿用当前权威版本。",
        evidence: [{ kind: "manual-lock", reference: id, note: "显式测试引用。" }],
      });
    }
    const twoPanels = panelInputs(text.promptRevision.id, 2, { includeOptionalScene: false })
      .map((panel) => ({ ...panel, assets: references }));
    await createStudioProductionUnit(root, {
      id: "unit-seven-references",
      expectedRevision: 0,
      season: "S03",
      episode: "EP99",
      sequence: 1,
      title: "七项引用门禁",
      scriptRevisionId: text.scriptRevision.id,
      panels: twoPanels,
    });

    await expect(buildStudioGenerationFreezePack(root, { unitId: "unit-seven-references", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "too-many-references" });
  });

  it("非受管目录无法构建冻结包", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-unmanaged-generation-")));
    temporaryRoots.push(root);
    await expect(buildStudioGenerationFreezePackRaw(root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toBeInstanceOf(StudioGenerationFreezeError);
    await expect(buildStudioGenerationFreezePackRaw(root, { unitId: "unit-2", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "unmanaged-project" });
    await expect(buildStudioUnitGridGenerationFreezePack(root, {
      targetKind: "unit-grid",
      unitId: "unit-2",
    })).rejects.toMatchObject({ code: "unmanaged-project" });
  });

  it("普通 panel 媒体文件缺失时保留 media-drift，而不是 epoch storage-invalid", async () => {
    const fixture = await readyTwoPanelProject();
    await bindLegacyPanel(fixture.root, "unit-2", "panel-01");
    await seedResolvedContinuityForPanel(fixture.root, "unit-2", "panel-01");
    await rm(fixture.character.media.objectPath);

    await expect(buildStudioGenerationFreezePackRaw(fixture.root, {
      unitId: "unit-2",
      panelId: "panel-01",
    })).rejects.toMatchObject({ code: "media-drift" });
  });

  it("unit-grid 缺 generation tmp 或 continuity marker 时零写失败关闭", async () => {
    const fixture = await readyUnitGridProject(2);
    const database = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const temporary = path.join(
      fixture.root,
      ".aicanvas",
      "studio-generation",
      "objects",
      ".tmp",
    );

    const db = new DatabaseSync(database);
    db.prepare(
      "DELETE FROM studio_generation_ledger_meta WHERE key = 'studio_continuity_schema_version'",
    ).run();
    db.close();
    const databaseBefore = await readFile(database);
    await expect(buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.snapshot.unit.id,
    })).rejects.toMatchObject({ code: "storage-invalid" });
    expect(await readFile(database)).toEqual(databaseBefore);

    await rm(temporary, { recursive: true });
    await expect(buildStudioUnitGridGenerationFreezePack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.snapshot.unit.id,
    })).rejects.toMatchObject({ code: "storage-invalid" });
    expect(await lstat(temporary).catch(() => null)).toBeNull();
  });
});

describe("单镜画幅合同", () => {
  it("显式电影横幅语义冻结为 cinematic-wide，未声明时保持历史 9:16 默认", () => {
    expect(inferStudioPanelImageLayout({
      visualAction: "电影横幅单幅无字 RAW，近景物证。",
      shotComposition: "100mm 微距",
      promptText: "保持人物与道具一致。",
    })).toBe("cinematic-wide");
    expect(inferStudioPanelImageLayout({
      visualAction: "电影写实分镜。",
      shotComposition: "中景",
      promptText: "保持人物与道具一致。",
    })).toBe("9:16-vertical");
  });

  it("真实 panel freeze 将显式电影横幅合同写入 request 与 renderedPrompt", async () => {
    const fixture = await readyTwoPanelProject(
      "只生成一张电影横幅单幅无字 RAW；保持阿航面孔与石室光线连续。",
    );
    const pack = await buildStudioGenerationFreezePack(fixture.root, {
      unitId: "unit-2",
      panelId: "panel-01",
    });
    expect(pack.request.modelPayload.layout).toBe("cinematic-wide");
    expect(pack.request.modelPayload.renderedPrompt).toContain("只生成一张电影宽银幕横幅");
    expect(pack.request.modelPayload.renderedPrompt).not.toContain("只生成一张 9:16 竖屏");
  });
});
