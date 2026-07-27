import { describe, expect, it } from "vitest";
import type { FusionProjectManifest, FusionScheduleRow, ProductionAssetDefinition } from "../src/core/fusion-package.js";
import type { PanelReferenceResolution, PanelReferenceSemanticAsset } from "../src/core/fusion-panel-references.js";
import { buildFusionStoryboardGrid, type FusionStoryboardGridContract, type FusionStoryboardGridPanel } from "../src/core/fusion-storyboard-grid.js";
import {
  PANEL_VISUAL_WARNING_CODES,
  assertFusionPanelVisualConstraintStoreCurrent,
  assertPanelVisualModelPayloadSafe,
  auditPanelVisualConstraints,
  buildFusionPanelVisualConstraintStore,
  buildPanelVisualConstraint,
  buildPanelVisualModelPayload,
  getPanelVisualConstraint,
  panelVisualModelFingerprint,
  panelVisualReviewRulesFingerprint,
  validateFusionPanelVisualConstraintStore,
  validatePanelVisualConstraint,
  type PanelGoldenMaskRevealAuthorization,
  type PanelVisualPresenceOverride,
} from "../src/core/fusion-visual-constraints.js";
import type { StoryboardProductionContract } from "../src/core/types.js";
import { reconcileSupersededLegacyGenerationJobEvidence } from "../src/core/fusion-visual-constraint-store.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SOURCE_CONTENT_ADDRESS = `sha256:${"e".repeat(64)}` as const;

function definition(id: string, category: ProductionAssetDefinition["category"], name: string): ProductionAssetDefinition {
  return {
    id,
    category,
    name,
    declaredUsage: "定向测试",
    generationPrompts: [{ label: "权威", prompt: `${name} 参考` }],
    sourceMarkdownPath: "assets.md",
    sourceHeadingLine: 1,
    sourceSectionSha256: SHA_A,
    sourceSection: name,
    generationStatus: "not-generated",
    hardLockStatus: "unlocked",
  };
}

const ASSETS = [
  definition("C01", "character", "阿航"),
  definition("C02", "character", "\u561f\u561f"),
  definition("P01", "prop", "阿航胸前素麻布囊"),
  definition("S01", "scene", "封神榜前石室"),
];

function unitItemId(episode: number): string {
  return `season-三-ep${String(episode).padStart(2, "0")}-unit001`;
}

function rows(episode: number): StoryboardProductionContract[] {
  const itemId = unitItemId(episode);
  return [
    {
      storyboardRowId: `ep${episode}-row-1`,
      storyboardRowRevision: 3,
      itemId,
      shotItemId: `${itemId}-shot001`,
      order: 1,
      durationSeconds: 8,
      shotSize: "中景",
      cameraMovement: "侧移跟拍",
      action: episode === 32
        ? "阿航打开胸前布囊，完整黄金面具显现，\u561f\u561f仰头观看。"
        : "阿航按住胸前素麻布囊，内层贴身压着完整黄金面具，\u561f\u561f紧跟在他脚边。",
      expression: "警觉",
      emotion: "紧张",
      ambience: "风声",
      continuityBefore: "承接上集",
      continuityAfter: "走向石室深处",
      referenceNames: ["C01", "C02", "P01", "S01"],
      firstFramePrompt: "人物进入石室",
      endFramePrompt: "人物按住布囊",
      videoPrompt: "连续行走",
      referencePaths: [],
      referenceArtifactIds: [],
    },
    {
      storyboardRowId: `ep${episode}-row-2`,
      storyboardRowRevision: 4,
      itemId,
      shotItemId: `${itemId}-shot002`,
      order: 2,
      durationSeconds: 7,
      shotSize: "特写",
      cameraMovement: "缓慢推进",
      cameraAngle: "低机位",
      lens: "50mm",
      composition: "主体偏左，保留通道纵深",
      staging: "阿航在前，\u561f\u561f在后",
      action: "\u561f\u561f忽然停步，阿航顺着它的视线望向黑暗通道。",
      expression: "凝神",
      emotion: "戒备",
      ambience: "远处水滴声",
      continuityBefore: "承接行走",
      continuityAfter: "落在通道悬念",
      referenceNames: ["C01", "C02", "S01"],
      firstFramePrompt: "\u561f\u561f停步",
      endFramePrompt: "阿航望向通道",
      videoPrompt: "先停步再转头",
      referencePaths: [],
      referenceArtifactIds: [],
    },
  ];
}

function schedule(): FusionScheduleRow[] {
  return [
    { index: 0, startSeconds: 0, endSeconds: 8, durationSeconds: 8, label: "镜1", content: "行走", kind: "source-shot", sourceShotNumber: 1 },
    { index: 1, startSeconds: 8, endSeconds: 15, durationSeconds: 7, label: "镜2", content: "停步", kind: "source-shot", sourceShotNumber: 2 },
  ];
}

function contract(episode: number): FusionStoryboardGridContract {
  const itemId = unitItemId(episode);
  const storyboardRows = rows(episode);
  return buildFusionStoryboardGrid({
    unit: {
      unitId: itemId,
      title: `EP${episode} 约束测试`,
      episodeLabel: `EP${String(episode).padStart(2, "0")}`,
      unitSequence: 1,
      storyGoal: "验证结构化视觉约束",
      aspectRatio: "9:16",
      standardDurationSeconds: 15,
    },
    storyboardRevision: 9,
    rows: storyboardRows,
    schedule: schedule(),
    assetIdsByRowId: {
      [storyboardRows[0]!.storyboardRowId]: ["C01", "C02", "P01", "S01"],
      [storyboardRows[1]!.storyboardRowId]: ["C01", "C02", "S01"],
    },
    override: { panelCount: 2, expectedRevision: 9, reason: "两个原镜各保留一格" },
    referenceOverride: {
      expectedRevision: 9,
      reason: "P01 只作第二格连续性参考",
      additionalAssetIdsByRowId: { [storyboardRows[1]!.storyboardRowId]: ["P01"] },
      promptInstruction: "P01 保持同一布囊版本，未明确入画时可在画外",
    },
  });
}

function manifest(episode: number): FusionProjectManifest {
  const unitId = `EP${String(episode).padStart(2, "0")}_15s_001`;
  const unit = {
    id: unitId,
    episode: `EP${String(episode).padStart(2, "0")}`,
    episodeNumber: episode,
    sequence: 1,
    episodeTitle: "测试集",
    title: "约束测试",
    markdownPath: "04_15秒融合分镜/unit.md",
    markdownSha256: SHA_B,
    sourceScriptPath: "script.md",
    sourcePromptTablePath: "prompt.md",
    sourceShots: [1, 2],
    sourceDurationSeconds: 15,
    standardDurationSeconds: 15,
    aspectRatio: "9:16",
    storyGoal: "结构化约束",
    schedule: schedule(),
    assetIds: ASSETS.map((asset) => asset.id),
    referenceImagePaths: [],
  };
  return {
    schemaVersion: 1,
    kind: "fusion-project-manifest",
    projectId: "project-visual-constraints",
    contentAddress: SOURCE_CONTENT_ADDRESS,
    directoryName: "visual-constraints-fixture",
    manifestSha256: SHA_C,
    source: {
      root: "/read-only/source",
      packageRoot: "/read-only/source/package",
      readOnly: true,
      inventory: { algorithm: "sha256-portable-path-bytes-content-v1", aggregateSha256: SHA_D, totalBytes: 0, files: [] },
    },
    counts: {
      episodes: 1,
      units: 1,
      sourceShots: 2,
      scheduleRows: 2,
      assets: 4,
      characters: 2,
      scenes: 1,
      props: 1,
      standardDurationSeconds: 15,
      promptReferencedAssets: 4,
      indexReferencedAssets: 4,
    },
    assets: ASSETS,
    units: [unit],
    continuityTracks: ASSETS.map((asset) => ({
      assetId: asset.id,
      assetName: asset.name,
      category: asset.category,
      episodeCodes: [unit.episode],
      unitIds: [unit.id],
      spans: [{
        id: `${unit.id}:${asset.id}:span`,
        assetId: asset.id,
        episode: unit.episode,
        episodeNumber: episode,
        unitId: unit.id,
        unitSequence: 1,
        sourceShots: [1, 2],
        scheduleRowIndexes: [0, 1],
        startSeconds: 0,
        endSeconds: 15,
        usageSources: ["fusion-index"],
        characterAssetIds: ["C01", "C02"],
        sceneAssetIds: ["S01"],
        propAssetIds: ["P01"],
        referenceVersion: `${asset.id}-v1`,
      }],
    })),
  };
}

function semanticAsset(panel: FusionStoryboardGridPanel, assetId: string, contractId: string): PanelReferenceSemanticAsset {
  const asset = ASSETS.find((entry) => entry.id === assetId)!;
  const episode = Number(panel.id.match(/ep(\d+)/iu)?.[1] ?? 1);
  const rowReferences = rows(episode)
    .filter((row) => panel.storyboardRowIds.includes(row.storyboardRowId) && row.referenceNames?.includes(assetId));
  const bindingId = `binding-${contractId}-${panel.id}-${assetId}`;
  return {
    assetId,
    assetName: asset.name,
    category: asset.category,
    provenance: [
      ...rowReferences.map((row) => ({ kind: "storyboard-row" as const, storyboardRowId: row.storyboardRowId, note: "已确认分镜显式引用" })),
      { kind: "continuity-span" as const, continuitySpanIds: [`EP${String(episode).padStart(2, "0")}_15s_001:${assetId}:span`], note: "重叠连续性" },
      ...(panel.continuityReferenceAssetIds.includes(assetId)
        ? [{ kind: "panel-continuity-reference" as const, note: "仅连续性参考" }]
        : []),
    ],
    hardLock: {
      assetId,
      workItemId: `asset-${assetId}`,
      lockId: `lock-${assetId}`,
      authority: assetId === "C01" || assetId === "C02" ? "user-authority" : "reviewed-hard-lock",
      artifactId: `artifact-${assetId}`,
      reviewId: `review-${assetId}`,
      path: `/project/authorities/${assetId}.png`,
      sha256: SHA_A,
      referenceVersion: `${assetId}-hard-lock-v1`,
    },
    bindingId,
  };
}

function resolution(grid: FusionStoryboardGridContract, panel: FusionStoryboardGridPanel): PanelReferenceResolution {
  const semanticAssets = panel.assetIds.map((assetId) => semanticAsset(panel, assetId, grid.contractId));
  return {
    schemaVersion: 1,
    resolverVersion: "panel-reference-resolution-v1",
    resolutionId: `resolution-${grid.contractId}-${panel.id}`,
    resolutionFingerprint: `${panel.id}-fingerprint`,
    projectId: "project-visual-constraints",
    sourceContentAddress: SOURCE_CONTENT_ADDRESS,
    unitItemId: grid.unit.unitId,
    gridContractId: grid.contractId,
    gridSourceFingerprint: grid.sourceFingerprint,
    panelId: panel.id,
    panelIndex: panel.index,
    panelCount: grid.selection.panelCount,
    startSeconds: panel.startSeconds,
    endSeconds: panel.endSeconds,
    storyboardRowIds: [...panel.storyboardRowIds],
    sourceShotNumbers: [...panel.sourceShotNumbers],
    scheduleRowIndexes: [...panel.scheduleRowIndexes],
    inputSnapshot: {
      storyboardRevision: 9,
      storyboardsSha256: SHA_A,
      continuitySha256: SHA_B,
      productionAssetsSha256: SHA_C,
      projectConfigSha256: SHA_D,
      gridSelectionsSha256: SHA_A,
      gridContractsDigest: SHA_B,
      hardLockSnapshotsDigest: SHA_C,
      unitMarkdownsDigest: SHA_D,
      overrideRevision: 0,
      derivedDefinitionsDigest: SHA_A,
    },
    semanticAssets,
    excludedAssets: [],
    referenceSlots: semanticAssets.map((asset) => ({
      id: `slot-${asset.assetId}`,
      kind: "canonical-asset",
      coveredAssetIds: [asset.assetId],
      readiness: "ready",
      assetId: asset.assetId,
      artifactId: asset.hardLock!.artifactId,
      path: asset.hardLock!.path,
      sha256: asset.hardLock!.sha256,
      reviewId: asset.hardLock!.reviewId,
    })),
    timelineReconciliations: [],
    detectedOverflow: false,
    closureStatus: "resolved",
    generationReady: true,
    blockerCodes: [],
    issues: [],
  };
}

function fixture(episode = 1) {
  const grid = contract(episode);
  const projectManifest = manifest(episode);
  const storyboardRows = rows(episode);
  const resolutions = Object.fromEntries(grid.panels.map((panel) => [`${grid.contractId}:${panel.id}`, resolution(grid, panel)]));
  return { grid, projectManifest, storyboardRows, resolutions };
}

describe("P3 逐格结构化视觉约束", () => {
  it("EP32 前将黄金面具身份、路径和外观严格留在 Review 侧，模型侧只保留闭合不透明布囊", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const panel = grid.panels[0]!;
    const constraint = buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: resolutions[`${grid.contractId}:${panel.id}`]!,
      storyboardRows,
    });
    const modelPayload = buildPanelVisualModelPayload(constraint);

    expect(constraint.hiddenMaskPolicy).toEqual({ status: "concealed" });
    expect(constraint.modelPrompt).toContain("同一已验收的闭合不透明素麻布囊");
    expect(`${constraint.modelPrompt}\n${constraint.modelNegativePrompt}`).not.toMatch(/黄金面具|面具|\/Users\/|\/project\//u);
    expect(JSON.stringify(modelPayload)).not.toMatch(/\/project\/authorities/u);
    expect(constraint.reviewRules.find((rule) => rule.code === "HIDDEN_MASK_DISCLOSURE")?.instruction).toContain("黄金面具");
    expect(constraint.mustNotAppear.find((entry) => entry.subject === "p01-internal-content")?.modelInstruction).not.toContain("面具");
    expect(() => assertPanelVisualModelPayloadSafe(modelPayload)).not.toThrow();
  });

  it("语义资产按 on-screen / continuity-only / optional-offscreen 分层，不把连续性参考强行入画", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const panel = grid.panels[1]!;
    const panelResolution = resolutions[`${grid.contractId}:${panel.id}`]!;
    const dudu = panelResolution.semanticAssets.find((asset) => asset.assetId === "C02")!;
    const override: PanelVisualPresenceOverride = {
      contractId: grid.contractId,
      panelId: panel.id,
      assetId: "C02",
      expectedResolutionId: panelResolution.resolutionId,
      expectedBindingId: dudu.bindingId,
      presence: "optional-offscreen",
      reason: "通道构图可只留\u561f\u561f的画外声音，本格不强制入画",
    };
    const constraint = buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: panelResolution,
      storyboardRows,
      presenceOverrides: [override],
    });

    expect(constraint.assetPresence.find((entry) => entry.assetId === "P01")?.presence).toBe("continuity-only");
    expect(constraint.assetPresence.find((entry) => entry.assetId === "C02")?.presence).toBe("optional-offscreen");
    expect(constraint.mustAppear.map((entry) => entry.assetId)).not.toContain("P01");
    expect(constraint.mustAppear.map((entry) => entry.assetId)).not.toContain("C02");
    expect(constraint.identityLocks.map((entry) => entry.assetId)).toEqual(["C01", "C02", "P01", "S01"]);
    expect(buildPanelVisualModelPayload(constraint).referenceLocks.map((entry) => entry.assetId)).not.toContain("C02");
    expect(constraint.warnings.map((entry) => entry.code)).toContain("AMBIGUOUS_VISIBILITY");
  });

  it("未知空间字段显式 unresolved，不臆造值，仍保留人工视觉 Review 为最终裁决", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const panel = grid.panels[0]!;
    const constraint = buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: resolutions[`${grid.contractId}:${panel.id}`]!,
      storyboardRows,
    });

    expect(constraint.spatialLocks.find((entry) => entry.field === "shotSize")?.status).toBe("resolved");
    expect(constraint.spatialLocks.find((entry) => entry.field === "cameraAngle")).toMatchObject({ status: "unresolved", values: [] });
    expect(constraint.spatialLocks.find((entry) => entry.field === "axisSide")).toMatchObject({ status: "unresolved", values: [] });
    expect(constraint.warnings.map((entry) => entry.code)).toContain("SPATIAL_LOCK_UNKNOWN");
    expect(constraint.humanVisualReviewRequired).toBe(true);
    expect(constraint.reviewRules.every((rule) => rule.enforcement.includes("human-visual"))).toBe(true);
  });

  it("EP32 也必须使用与 contract/panel/resolution 精确绑定的逐格用户 reveal allowlist", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(32);
    const panel = grid.panels[0]!;
    const panelResolution = resolutions[`${grid.contractId}:${panel.id}`]!;
    const concealed = buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: panelResolution,
      storyboardRows,
    });
    expect(concealed.hiddenMaskPolicy.status).toBe("concealed");
    expect(concealed.modelPrompt).not.toContain("黄金面具");

    const authorization: PanelGoldenMaskRevealAuthorization = {
      schemaVersion: 1,
      subject: "golden-mask",
      authorizationId: "user-reveal-ep32-panel01",
      contractId: grid.contractId,
      panelId: panel.id,
      expectedGridSourceFingerprint: grid.sourceFingerprint,
      expectedResolutionId: panelResolution.resolutionId,
      approvedBy: "user",
      reason: "EP32 当前格是正式揭示镜头",
      modelRevealDescription: "当前格允许完整黄金面具从布囊中正式显现，保持已审核的完整结构。",
    };
    const revealed = buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: panelResolution,
      storyboardRows,
      revealAuthorization: authorization,
    });
    expect(revealed.hiddenMaskPolicy).toEqual({ status: "reveal-authorized", authorizationId: authorization.authorizationId });
    expect(revealed.modelPrompt).toContain("黄金面具");
    expect(() => buildPanelVisualModelPayload(revealed)).not.toThrow();
    const revealStore = buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
      revealAllowlist: [authorization],
    });
    expect(revealStore.revealAllowlist).toEqual([authorization]);
    expect(getPanelVisualConstraint(revealStore, grid.contractId, panel.id).hiddenMaskPolicy.status).toBe("reveal-authorized");

    const ep01 = fixture(1);
    const ep01Panel = ep01.grid.panels[0]!;
    expect(() => buildPanelVisualConstraint({
      manifest: ep01.projectManifest,
      contract: ep01.grid,
      panelId: ep01Panel.id,
      resolution: ep01.resolutions[`${ep01.grid.contractId}:${ep01Panel.id}`]!,
      storyboardRows: ep01.storyboardRows,
      revealAuthorization: {
        ...authorization,
        contractId: ep01.grid.contractId,
        panelId: ep01Panel.id,
        expectedGridSourceFingerprint: ep01.grid.sourceFingerprint,
        expectedResolutionId: ep01.resolutions[`${ep01.grid.contractId}:${ep01Panel.id}`]!.resolutionId,
      },
    })).toThrow(/EP32/u);
  });

  it("内容寻址 store 确定性、全量覆盖、审计和损坏失败关闭", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const first = buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
    });
    const second = buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
    });

    expect(second).toEqual(first);
    expect(first.presenceOverrides).toEqual([]);
    expect(first.revealAllowlist).toEqual([]);
    expect(first.legacyGenerationJobEvidence).toEqual({});
    expect(first.audit).toMatchObject({ expectedPanels: 2, constraints: 2, missingConstraints: 0, extraConstraints: 0, invalidConstraints: 0, closurePassed: true });
    expect(first.audit.modelPromptLeakPanels).toBe(0);
    expect(first.audit.modelPathLeakPanels).toBe(0);
    expect(Object.keys(first.constraints)).toHaveLength(2);
    expect(getPanelVisualConstraint(first, grid.contractId, grid.panels[0]!.id).constraintId).toMatch(/^panel-visual-/u);
    expect(() => validateFusionPanelVisualConstraintStore(first, projectManifest, [grid])).not.toThrow();
    expect(() => assertFusionPanelVisualConstraintStoreCurrent(first, {
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
    })).not.toThrow();

    const warningUnion = new Set(Object.values(first.constraints).flatMap((constraint) => constraint.warnings.map((warning) => warning.code)));
    expect([...PANEL_VISUAL_WARNING_CODES].every((code) => warningUnion.has(code))).toBe(true);

    const tampered = structuredClone(first);
    tampered.constraints[Object.keys(tampered.constraints)[0]!]!.modelPrompt += " 黄金面具";
    expect(() => validateFusionPanelVisualConstraintStore(tampered, projectManifest, [grid])).toThrow(/store 内容摘要不匹配/u);
    expect(auditPanelVisualConstraints({ contracts: [grid], constraints: tampered.constraints })).toMatchObject({ invalidConstraints: 1, invalidModelFingerprints: 1, modelPromptLeakPanels: 1, closurePassed: false });
  });

  it("丢失 P2 resolution、过期 presence CAS 和媒体路径 reveal 都失败关闭", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const [firstKey] = Object.keys(resolutions);
    const incomplete = { ...resolutions };
    delete incomplete[firstKey!];
    expect(() => buildFusionPanelVisualConstraintStore({ manifest: projectManifest, contracts: [grid], resolutions: incomplete, storyboardRows })).toThrow(/resolution 集合/u);

    const panel = grid.panels[0]!;
    const panelResolution = resolutions[`${grid.contractId}:${panel.id}`]!;
    expect(() => buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: panelResolution,
      storyboardRows,
      presenceOverrides: [{
        contractId: grid.contractId,
        panelId: panel.id,
        assetId: "C01",
        expectedResolutionId: "stale-resolution",
        expectedBindingId: panelResolution.semanticAssets.find((asset) => asset.assetId === "C01")!.bindingId,
        presence: "on-screen",
        reason: "过期 CAS",
      }],
    })).toThrow(/resolution CAS/u);

    const ep32 = fixture(32);
    const ep32Panel = ep32.grid.panels[0]!;
    expect(() => buildPanelVisualConstraint({
      manifest: ep32.projectManifest,
      contract: ep32.grid,
      panelId: ep32Panel.id,
      resolution: ep32.resolutions[`${ep32.grid.contractId}:${ep32Panel.id}`]!,
      storyboardRows: ep32.storyboardRows,
      revealAuthorization: {
        schemaVersion: 1,
        subject: "golden-mask",
        authorizationId: "unsafe-path",
        contractId: ep32.grid.contractId,
        panelId: ep32Panel.id,
        expectedGridSourceFingerprint: ep32.grid.sourceFingerprint,
        expectedResolutionId: ep32.resolutions[`${ep32.grid.contractId}:${ep32Panel.id}`]!.resolutionId,
        approvedBy: "user",
        reason: "测试路径禁止",
        modelRevealDescription: "请按 /Users/hxx/Desktop/黄金面具.png 生成",
      },
    })).toThrow(/本地路径/u);
  });

  it("store 正式持久 presence/reveal 裁决与旧 Job 约束身份，可确定性重建", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const panel = grid.panels[1]!;
    const panelResolution = resolutions[`${grid.contractId}:${panel.id}`]!;
    const asset = panelResolution.semanticAssets.find((entry) => entry.assetId === "C02")!;
    const presenceOverride: PanelVisualPresenceOverride = {
      contractId: grid.contractId,
      panelId: panel.id,
      assetId: "C02",
      expectedResolutionId: panelResolution.resolutionId,
      expectedBindingId: asset.bindingId,
      presence: "optional-offscreen",
      reason: "当前格允许\u561f\u561f保持画外",
    };
    const decided = buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
      presenceOverrides: [presenceOverride],
    });
    const constraint = getPanelVisualConstraint(decided, grid.contractId, panel.id);
    const legacyEvidence = {
      "legacy-job-1": {
        jobId: "legacy-job-1",
        contractId: grid.contractId,
        panelId: panel.id,
        constraintId: constraint.constraintId,
        constraintFingerprint: constraint.fingerprint,
        modelFingerprint: constraint.modelFingerprint,
        reviewRulesFingerprint: constraint.reviewRulesFingerprint,
        jobLedgerFingerprint: SHA_D,
        disposition: "current-constraint-readonly" as const,
      },
    };
    const withLegacy = buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
      presenceOverrides: [presenceOverride],
      legacyGenerationJobEvidence: legacyEvidence,
    });
    expect(withLegacy.presenceOverrides).toEqual([presenceOverride]);
    expect(withLegacy.legacyGenerationJobEvidence).toEqual(legacyEvidence);
    expect(withLegacy.storeFingerprint).not.toBe(decided.storeFingerprint);
    expect(() => validateFusionPanelVisualConstraintStore(withLegacy, projectManifest, [grid])).not.toThrow();
    expect(() => assertFusionPanelVisualConstraintStoreCurrent(withLegacy, {
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
      presenceOverrides: [presenceOverride],
      legacyGenerationJobEvidence: legacyEvidence,
    })).not.toThrow();

    const driftedEvidence = structuredClone(legacyEvidence);
    driftedEvidence["legacy-job-1"].modelFingerprint = SHA_A;
    expect(() => buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
      presenceOverrides: [presenceOverride],
      legacyGenerationJobEvidence: driftedEvidence,
    })).toThrow(/当前约束身份已漂移/u);

    const replacement = structuredClone(constraint);
    replacement.constraintId = `panel-visual-${SHA_A.slice(0, 28)}`;
    replacement.fingerprint = SHA_A;
    const superseded = reconcileSupersededLegacyGenerationJobEvidence(legacyEvidence, {
      [`${grid.contractId}:${panel.id}`]: replacement,
    });
    expect(superseded["legacy-job-1"]).toMatchObject({
      disposition: "superseded-constraint-readonly",
      supersededReason: "current-constraint-identity-changed",
      supersededByConstraintId: replacement.constraintId,
      constraintId: constraint.constraintId,
      constraintFingerprint: constraint.fingerprint,
    });
    expect(() => buildFusionPanelVisualConstraintStore({
      manifest: projectManifest,
      contracts: [grid],
      resolutions,
      storyboardRows,
      presenceOverrides: [presenceOverride],
      legacyGenerationJobEvidence: superseded,
    })).not.toThrow();
  });

  it("约束本身任意字段漂移都会改变 fingerprint 并作废原证据", () => {
    const { grid, projectManifest, storyboardRows, resolutions } = fixture(1);
    const panel = grid.panels[0]!;
    const original = buildPanelVisualConstraint({
      manifest: projectManifest,
      contract: grid,
      panelId: panel.id,
      resolution: resolutions[`${grid.contractId}:${panel.id}`]!,
      storyboardRows,
    });
    const reviewTampered = structuredClone(original);
    reviewTampered.reviewRules[0]!.instruction += "漂移";
    expect(panelVisualModelFingerprint(reviewTampered)).toBe(original.modelFingerprint);
    expect(panelVisualReviewRulesFingerprint(reviewTampered)).not.toBe(original.reviewRulesFingerprint);
    expect(() => validatePanelVisualConstraint(reviewTampered)).toThrow(/Review 规则摘要/u);
    expect(auditPanelVisualConstraints({ contracts: [grid], constraints: { [`${grid.contractId}:${panel.id}`]: reviewTampered } })).toMatchObject({
      invalidModelFingerprints: 0,
      invalidReviewRulesFingerprints: 1,
      closurePassed: false,
    });

    const modelTampered = structuredClone(original);
    modelTampered.modelPrompt += " 深景深加强。";
    expect(panelVisualModelFingerprint(modelTampered)).not.toBe(original.modelFingerprint);
    expect(panelVisualReviewRulesFingerprint(modelTampered)).toBe(original.reviewRulesFingerprint);
    expect(() => validatePanelVisualConstraint(modelTampered)).toThrow(/模型载荷/u);
    expect(auditPanelVisualConstraints({ contracts: [grid], constraints: { [`${grid.contractId}:${panel.id}`]: modelTampered } })).toMatchObject({
      invalidModelFingerprints: 1,
      invalidReviewRulesFingerprints: 0,
      closurePassed: false,
    });
  });
});
