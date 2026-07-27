import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PANEL_REFERENCE_RESOLUTION_CORE_VERSION,
  PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS,
  adaptFusionPanelReferenceResolution,
  adaptStudioBindingSetToPanelReferenceResolution,
  assertPanelReferenceResolutionCurrent,
  assertPanelReferenceResolutionIntegrity,
  createPanelReferenceResolution,
  inspectPanelReferenceResolutionCurrentness,
  type PanelReferenceControlInput,
  type PanelReferenceResolutionDraft,
  type PanelReferenceSemanticAssetInput,
  type StudioPanelReferenceResolutionAdapterInput,
} from "../src/core/panel-reference-resolution-core.js";
import {
  FUSION_PANEL_REFERENCE_RESOLVER_VERSION,
  type PanelReferenceResolution as FusionPanelReferenceResolution,
} from "../src/core/fusion-panel-references.js";

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

function hash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function sourceSpan() {
  return {
    id: "span-script-1",
    kind: "text" as const,
    coordinateSystem: "utf16-code-unit" as const,
    sourceId: "script-revision-1",
    sourceFingerprint: hash("script-v1"),
    start: 0,
    end: 8,
    surfaceFingerprint: hash("阿航走入石室"),
  };
}

function semanticAsset(assetId: string, category: "character" | "scene" | "prop" = "character"): PanelReferenceSemanticAssetInput {
  return {
    assetId,
    category,
    presence: "required",
    role: `${assetId} 当前格可见`,
    mentionIds: [`mention-${assetId}`],
    sourceSpanIds: ["span-script-1"],
    identity: {
      definitionVersionId: `definition-${assetId}-v1`,
      authorityEventId: `authority-${assetId}-v1`,
      assetVersionId: `version-${assetId}-v1`,
      mediaSha256: hash(`media-${assetId}`),
      semanticFingerprint: hash(`semantic-${assetId}`),
    },
  };
}

function control(assetId: string): PanelReferenceControlInput {
  const mediaSha256 = hash(`media-${assetId}`);
  return {
    id: `control-${assetId}`,
    kind: "asset",
    coveredAssetIds: [assetId],
    readiness: "ready",
    contentAddress: `sha256:${mediaSha256}`,
    referenceVersion: `version-${assetId}-v1`,
  };
}

function continuityFrame(assetId: string, label = "previous-raw"): PanelReferenceControlInput {
  return {
    id: `continuity-frame-${label}`,
    kind: "continuity-frame",
    purpose: "continuity",
    coveredAssetIds: [assetId],
    readiness: "ready",
    contentAddress: hash(`continuity-media-${label}`),
    referenceVersion: `generation-result-${label}`,
    provenance: [
      { source: "studio-generation-result", reference: `generation-result-${label}`, sourceFingerprint: hash(`result-${label}`) },
      { source: "studio-result-review", reference: `review-${label}`, sourceFingerprint: hash(`review-${label}`) },
      { source: "studio-generation-pack", reference: `pack-${label}`, sourceFingerprint: hash(`pack-${label}`) },
    ],
  };
}

function continuityDependencies(label = "previous-raw") {
  return [
    { kind: "continuity-media", key: `continuity:media:${label}`, fingerprint: hash(`continuity-media-${label}`) },
    { kind: "generation-result", key: `continuity:result:${label}`, fingerprint: hash(`result-${label}`) },
    { kind: "result-review", key: `continuity:review:${label}`, fingerprint: hash(`review-${label}`) },
    { kind: "generation-pack", key: `continuity:pack:${label}`, fingerprint: hash(`pack-${label}`) },
  ];
}

function baseDraft(): PanelReferenceResolutionDraft {
  return {
    project: { id: "project-1", contentAddress: `sha256:${hash("project")}` },
    unit: {
      id: "unit-1",
      revision: 1,
      fingerprint: hash("unit-v1"),
      seasonId: "S03",
      episodeId: "EP01",
      sequence: 2,
    },
    panel: { id: "panel-1", index: 1, count: 2 },
    time: {
      unitLocalStartSeconds: 0,
      unitLocalEndSeconds: 7,
      episodeAbsoluteStartSeconds: 15,
      episodeAbsoluteEndSeconds: 22,
    },
    sourceSpans: [sourceSpan()],
    dependencies: [
      { kind: "script", key: "script:script-revision-1", fingerprint: hash("script-v1") },
      { kind: "unit", key: "unit:unit-1", fingerprint: hash("unit-v1") },
    ],
  };
}

describe("PanelReferenceResolution Core V3", () => {
  it("resolved 闭包内容寻址，所有集合排序后与输入顺序无关", () => {
    const first = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("scene-room", "scene"), semanticAsset("character-ahang")],
      controlReferences: [control("scene-room"), control("character-ahang")],
      provenance: [
        { source: "fixture", reference: "second", extensions: { ids: ["b", "a"] } },
        { source: "fixture", reference: "first" },
      ],
      extensions: { unordered: ["z", "a", "m"] },
    });
    const second = createPanelReferenceResolution({
      ...baseDraft(),
      sourceSpans: [...(baseDraft().sourceSpans ?? [])].reverse(),
      dependencies: [...(baseDraft().dependencies ?? [])].reverse(),
      semanticAssets: [semanticAsset("character-ahang"), semanticAsset("scene-room", "scene")],
      controlReferences: [control("character-ahang"), control("scene-room")],
      provenance: [
        { source: "fixture", reference: "first" },
        { source: "fixture", reference: "second", extensions: { ids: ["a", "b"] } },
      ],
      extensions: { unordered: ["m", "z", "a"] },
    });

    expect(first.closure).toBe("resolved");
    expect(first.schemaVersion).toBe(3);
    expect(first.resolverVersion).toBe(PANEL_REFERENCE_RESOLUTION_CORE_VERSION);
    expect(first.resolverVersion).toBe("panel-reference-resolution-core-v3");
    expect(first.generationReady).toBe(true);
    expect(first.blockers).toEqual([]);
    expect(first.semanticAssets.map((asset) => asset.assetId)).toEqual(["character-ahang", "scene-room"]);
    expect(first.controlReferences.map((entry) => entry.id)).toEqual(["control-character-ahang", "control-scene-room"]);
    expect(first.controlReferences.every((entry) => entry.purpose === "identity")).toBe(true);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.id).toBe(second.id);
    expect(assertPanelReferenceResolutionIntegrity(first)).toBe(first);
  });

  it("required/forbidden ambiguous 或 unmatched 显式阻断，optional unresolved 只保留警告", () => {
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang")],
      unresolved: [
        {
          subjectId: "mention-required",
          status: "ambiguous",
          presence: "required",
          candidateAssetIds: ["character-a", "character-b"],
          sourceSpanIds: ["span-script-1"],
          reason: "同名别名冲突",
        },
        {
          subjectId: "mention-forbidden",
          status: "unmatched",
          presence: "forbidden",
          sourceSpanIds: ["span-script-1"],
          reason: "禁止实体尚未锁定规范身份",
        },
        {
          subjectId: "mention-optional",
          status: "unmatched",
          presence: "optional",
          sourceSpanIds: ["span-script-1"],
          reason: "可选背景未登记",
        },
      ],
    });

    expect(resolution.closure).toBe("unresolved");
    expect(resolution.generationReady).toBe(false);
    expect(resolution.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "required-ambiguous",
      "forbidden-unmatched",
    ]));
    expect(resolution.warnings.map((entry) => entry.code)).toContain("optional-unmatched");
    expect(resolution.unresolved).toHaveLength(3);
  });

  it("只有显式确认才能得到 confirmed-empty", () => {
    const confirmed = createPanelReferenceResolution({
      ...baseDraft(),
      sourceSpans: [],
      confirmedEmpty: true,
    });
    const implicit = createPanelReferenceResolution({
      ...baseDraft(),
      sourceSpans: [],
    });

    expect(confirmed.closure).toBe("confirmed-empty");
    expect(confirmed.generationReady).toBe(true);
    expect(confirmed.controlReferences).toEqual([]);
    expect(implicit.closure).toBe("unresolved");
    expect(implicit.blockers.map((entry) => entry.code)).toContain("empty-not-confirmed");
  });

  it("forbidden-only 闭包不把安全约束冒充可见控制引用", () => {
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      forbiddenAssets: [{
        assetId: "prop-complete-mask",
        category: "prop",
        role: "仍藏在布囊内，禁止露出或变成半面具",
        mentionIds: ["mention-mask"],
        sourceSpanIds: ["span-script-1"],
        identity: {
          definitionVersionId: "mask-definition-v1",
          authorityEventId: "mask-authority-v1",
          assetVersionId: "mask-version-v1",
          mediaSha256: hash("mask-media"),
        },
      }],
      confirmedEmpty: true,
    });

    expect(resolution.closure).toBe("confirmed-empty");
    expect(resolution.generationReady).toBe(true);
    expect(resolution.semanticAssets).toEqual([]);
    expect(resolution.forbiddenAssets.map((asset) => asset.assetId)).toEqual(["prop-complete-mask"]);
    expect(resolution.controlReferences).toEqual([]);
  });

  it("完全重复输入显式合并 occurrences；同键冲突失败关闭", () => {
    const duplicate = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang"), semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang"), control("character-ahang")],
    });
    expect(duplicate.generationReady).toBe(true);
    expect(duplicate.semanticAssets).toHaveLength(1);
    expect(duplicate.semanticAssets[0]?.occurrences).toBe(2);
    expect(duplicate.controlReferences[0]?.occurrences).toBe(2);
    expect(duplicate.warnings.filter((entry) => entry.code === "duplicate-input-merged")).toHaveLength(2);

    const conflictingAsset = { ...semanticAsset("character-ahang"), role: "冲突角色作用" };
    const conflict = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang"), conflictingAsset],
      forbiddenAssets: [{
        assetId: "character-ahang",
        category: "character",
        role: "禁止出画",
        sourceSpanIds: ["span-script-1"],
      }],
      controlReferences: [control("character-ahang")],
    });
    expect(conflict.closure).toBe("unresolved");
    expect(conflict.generationReady).toBe(false);
    expect(conflict.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "conflicting-semantic-asset",
      "visible-forbidden-conflict",
    ]));
    expect(conflict.semanticAssets).toHaveLength(2);
  });

  it("上一格已验收 raw 作为 continuity-frame 进入同一闭包，但不重复计算 identity 覆盖", () => {
    const firstFrame = continuityFrame("character-ahang", "previous-raw-1");
    const secondFrame = continuityFrame("character-ahang", "previous-raw-2");
    delete secondFrame.purpose;
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang"), firstFrame, secondFrame],
      dependencies: [
        ...(baseDraft().dependencies ?? []),
        ...continuityDependencies("previous-raw-1"),
        ...continuityDependencies("previous-raw-2"),
      ],
    });

    expect(resolution.generationReady).toBe(true);
    expect(resolution.controlReferences).toHaveLength(3);
    expect(resolution.controlReferences.filter((entry) => entry.purpose === "identity")).toHaveLength(1);
    expect(resolution.controlReferences.filter((entry) => entry.purpose === "continuity")).toHaveLength(2);
    expect(resolution.controlReferences.filter((entry) => entry.kind === "continuity-frame")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "continuity-frame-previous-raw-1",
        purpose: "continuity",
        contentAddress: hash("continuity-media-previous-raw-1"),
        referenceVersion: "generation-result-previous-raw-1",
      }),
      expect.objectContaining({ id: "continuity-frame-previous-raw-2", purpose: "continuity" }),
    ]));
    expect(resolution.blockers.map((entry) => entry.code)).not.toContain("semantic-asset-multiply-covered");
  });

  it("旧 asset/composite 省略 purpose 时都规范化为 identity", () => {
    const composite = { ...control("scene-room"), kind: "composite" as const };
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang"), semanticAsset("scene-room", "scene")],
      controlReferences: [control("character-ahang"), composite],
    });

    expect(resolution.generationReady).toBe(true);
    expect(resolution.controlReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "asset", purpose: "identity" }),
      expect.objectContaining({ kind: "composite", purpose: "identity" }),
    ]));
  });

  it("continuity 控制不能代替 identity 覆盖，也不得覆盖 forbidden 或不可见资产", () => {
    const continuityOnly = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [continuityFrame("character-ahang", "continuity-only")],
      dependencies: [...(baseDraft().dependencies ?? []), ...continuityDependencies("continuity-only")],
    });
    expect(continuityOnly.generationReady).toBe(false);
    expect(continuityOnly.blockers.map((entry) => entry.code)).toContain("semantic-asset-uncovered");

    const forbiddenAndUnknown = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      forbiddenAssets: [{
        assetId: "prop-complete-mask",
        category: "prop",
        role: "本格禁止出现",
        sourceSpanIds: ["span-script-1"],
      }],
      controlReferences: [
        control("character-ahang"),
        continuityFrame("prop-complete-mask", "forbidden-frame"),
        continuityFrame("character-unseen", "unknown-frame"),
      ],
      dependencies: [
        ...(baseDraft().dependencies ?? []),
        ...continuityDependencies("forbidden-frame"),
        ...continuityDependencies("unknown-frame"),
      ],
    });
    expect(forbiddenAndUnknown.generationReady).toBe(false);
    expect(forbiddenAndUnknown.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "forbidden-control-reference",
      "control-reference-unknown-asset",
    ]));
  });

  it("identity 与 continuity 合计 7 项时全部进入 overflow，continuity 重复覆盖不额外阻断", () => {
    const labels = Array.from({ length: 6 }, (_, index) => `previous-raw-${index + 1}`);
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [
        control("character-ahang"),
        ...labels.map((label) => continuityFrame("character-ahang", label)),
      ],
      dependencies: [
        ...(baseDraft().dependencies ?? []),
        ...labels.flatMap((label) => continuityDependencies(label)),
      ],
    });

    expect(resolution.generationReady).toBe(false);
    expect(resolution.controlReferences).toEqual([]);
    expect(resolution.overflowControlReferences).toHaveLength(7);
    expect(resolution.overflowControlReferences.filter((entry) => entry.purpose === "continuity")).toHaveLength(6);
    expect(resolution.blockers.map((entry) => entry.code)).toContain("visible-control-reference-overflow");
    expect(resolution.blockers.map((entry) => entry.code)).not.toContain("semantic-asset-multiply-covered");
  });

  it("continuity-frame 的类型、内容地址、provenance 与依赖全部失败关闭", () => {
    expect(() => createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [{ ...continuityFrame("character-ahang"), purpose: "identity" }],
    })).toThrow(/purpose 必须是 continuity/);
    expect(() => createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [{ ...continuityFrame("character-ahang"), contentAddress: hash("continuity-media-previous-raw").toUpperCase() }],
    })).toThrow(/裸 64 位小写 SHA-256/);

    const incomplete = continuityFrame("character-ahang", "incomplete");
    delete incomplete.referenceVersion;
    incomplete.provenance = [];
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang"), incomplete],
    });
    expect(resolution.generationReady).toBe(false);
    expect(resolution.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "continuity-frame-reference-version-missing",
      "continuity-frame-provenance-missing",
      "continuity-frame-dependency-unverifiable",
    ]));

    const nonAddressed = continuityFrame("character-ahang", "non-addressed");
    nonAddressed.provenance = [{ source: "legacy-path", reference: "/tmp/previous.png" }];
    const nonAddressedResolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang"), nonAddressed],
      dependencies: [
        ...(baseDraft().dependencies ?? []),
        { kind: "continuity-media", key: "continuity:media:non-addressed", fingerprint: nonAddressed.contentAddress! },
      ],
    });
    expect(nonAddressedResolution.blockers.map((entry) => entry.code)).toContain("continuity-frame-provenance-not-content-addressed");
  });

  it("continuity-frame pending/stale 与依赖漂移继续失败关闭", () => {
    const pending = { ...continuityFrame("character-ahang", "pending"), readiness: "pending" as const };
    const stale = { ...continuityFrame("character-ahang", "stale"), readiness: "stale" as const };
    const blocked = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang"), pending, stale],
    });
    expect(blocked.generationReady).toBe(false);
    expect(blocked.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "control-reference-pending",
      "control-reference-stale",
    ]));

    const currentFrame = continuityFrame("character-ahang", "currentness");
    const current = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang"), currentFrame],
      dependencies: [...(baseDraft().dependencies ?? []), ...continuityDependencies("currentness")],
    });
    const observed = inspectPanelReferenceResolutionCurrentness(current, [
      ...(baseDraft().dependencies ?? []).map(({ key, fingerprint }) => ({ key, fingerprint })),
      ...continuityDependencies("currentness").map(({ key, fingerprint }, index) => ({
        key,
        fingerprint: index === 0 ? hash("changed-continuity-media") : fingerprint,
      })),
    ]);
    expect(observed.current).toBe(false);
    expect(observed.driftedDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "continuity:media:currentness", reason: "changed" }),
    ]));
  });

  it("超过 6 个控制引用时保留全部 overflow 候选，不选择前 6 项", () => {
    const assetIds = Array.from({ length: 7 }, (_, index) => `asset-${index + 1}`);
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: assetIds.map((assetId) => semanticAsset(assetId)),
      controlReferences: assetIds.map(control),
    });

    expect(PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS).toBe(6);
    expect(resolution.closure).toBe("resolved");
    expect(resolution.generationReady).toBe(false);
    expect(resolution.semanticAssets).toHaveLength(7);
    expect(resolution.controlReferences).toEqual([]);
    expect(resolution.overflowControlReferences.map((entry) => entry.id)).toHaveLength(7);
    expect(resolution.blockers.map((entry) => entry.code)).toContain("visible-control-reference-overflow");
  });

  it("检测结果篡改，并按局部依赖验证 currentness", () => {
    const resolution = createPanelReferenceResolution({
      ...baseDraft(),
      semanticAssets: [semanticAsset("character-ahang")],
      controlReferences: [control("character-ahang")],
    });
    const current = inspectPanelReferenceResolutionCurrentness(resolution, [
      { key: "unit:unit-1", fingerprint: hash("unit-v1") },
      { key: "unrelated:extra", fingerprint: hash("extra") },
      { key: "script:script-revision-1", fingerprint: hash("script-v1") },
    ]);
    expect(current.current).toBe(true);
    expect(assertPanelReferenceResolutionCurrent(resolution, [
      { key: "script:script-revision-1", fingerprint: hash("script-v1") },
      { key: "unit:unit-1", fingerprint: hash("unit-v1") },
    ])).toBe(resolution);

    const stale = inspectPanelReferenceResolutionCurrentness(resolution, [
      { key: "script:script-revision-1", fingerprint: hash("script-v2") },
    ]);
    expect(stale.current).toBe(false);
    expect(stale.driftedDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "script:script-revision-1", reason: "changed" }),
      expect.objectContaining({ key: "unit:unit-1", reason: "missing" }),
    ]));

    const tampered = structuredClone(resolution);
    tampered.semanticAssets[0]!.role = "攻击者改写角色作用";
    expect(() => assertPanelReferenceResolutionIntegrity(tampered)).toThrow(/内容地址无效|fingerprint/);
  });
});

function studioAdapterFixture(): StudioPanelReferenceResolutionAdapterInput {
  const sourceA = {
    assetId: "character-ahang",
    category: "character" as const,
    assetRevision: 3,
    definitionVersionId: "definition-ahang-v2",
    authorityEventId: "authority-event-ahang-v2",
    authorityVersionId: "asset-version-ahang-v2",
    assetVersionId: "asset-version-ahang-v2",
    mediaSha256: hash("ahang-media"),
    knowledgeFingerprint: hash("ahang-knowledge"),
    applicabilityFingerprint: hash("ahang-applicability"),
  };
  const sourceForbidden = {
    assetId: "prop-complete-mask",
    category: "prop" as const,
    assetRevision: 2,
    definitionVersionId: "definition-mask-v1",
    authorityEventId: "authority-event-mask-v1",
    authorityVersionId: "asset-version-mask-v1",
    assetVersionId: "asset-version-mask-v1",
    mediaSha256: hash("mask-media"),
    knowledgeFingerprint: hash("mask-knowledge"),
    applicabilityFingerprint: hash("mask-applicability"),
  };
  const bindingA = {
    presence: "required" as const,
    role: "主体，固定脸与服装",
    mentionIds: ["mention-ahang"],
    ...sourceA,
    semanticFingerprint: digest(sourceA),
  };
  const bindingForbidden = {
    presence: "forbidden" as const,
    role: "藏在布囊内，不可露出",
    mentionIds: ["mention-mask"],
    ...sourceForbidden,
    semanticFingerprint: digest(sourceForbidden),
  };
  const decisions = [
    {
      id: "decision-ahang",
      proposalId: "proposal-ahang",
      proposalFingerprint: hash("proposal-ahang"),
      action: "accept" as const,
      selectedAssetId: "character-ahang",
      presence: "required" as const,
      role: bindingA.role,
      reviewer: "user",
      note: "确认阿航",
      fingerprint: hash("decision-ahang"),
      createdAt: "2026-07-18T00:00:00.000Z",
    },
    {
      id: "decision-mask",
      proposalId: "proposal-mask",
      proposalFingerprint: hash("proposal-mask"),
      action: "accept" as const,
      selectedAssetId: "prop-complete-mask",
      presence: "forbidden" as const,
      role: bindingForbidden.role,
      reviewer: "user",
      note: "确认禁止露出完整面具",
      fingerprint: hash("decision-mask"),
      createdAt: "2026-07-18T00:00:00.000Z",
    },
  ];
  const bindingSetBase = {
    schemaVersion: 1 as const,
    kind: "studio-panel-asset-binding-set" as const,
    id: "asset-binding-set-fixture",
    revision: 1,
    analysisId: "analysis-fixture",
    unitId: "unit-fixture",
    unitRevision: 2,
    unitFingerprint: hash("unit-fixture-v2"),
    panelIndex: 1,
    scriptRevisionId: "script-revision-fixture",
    scriptSha256: hash("script-fixture"),
    promptRevisionId: "prompt-revision-fixture",
    promptSha256: hash("prompt-fixture"),
    bindings: [bindingA, bindingForbidden].sort((left, right) => left.assetId.localeCompare(right.assetId, "en")),
    identityKeyFingerprints: {
      "阿航::category:character": hash("identity-ahang"),
      "完整黄金面具::category:prop": hash("identity-mask"),
    },
    decisionReceiptIds: decisions.map((decision) => decision.id).sort(),
    unresolvedOptionalMentionIds: [],
    confirmedEmpty: false,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
  const analysisFingerprint = hash("analysis-fixture");
  const bindingSetFingerprint = digest({
    analysisId: bindingSetBase.analysisId,
    analysisFingerprint,
    unitId: bindingSetBase.unitId,
    unitRevision: bindingSetBase.unitRevision,
    unitFingerprint: bindingSetBase.unitFingerprint,
    panelIndex: bindingSetBase.panelIndex,
    scriptRevisionId: bindingSetBase.scriptRevisionId,
    scriptSha256: bindingSetBase.scriptSha256,
    promptRevisionId: bindingSetBase.promptRevisionId,
    promptSha256: bindingSetBase.promptSha256,
    bindings: bindingSetBase.bindings,
    identityKeyFingerprints: bindingSetBase.identityKeyFingerprints,
    decisionReceipts: decisions.map((decision) => ({ id: decision.id, fingerprint: decision.fingerprint }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    unresolvedOptionalMentionIds: [],
  });
  const bindingSet = { ...bindingSetBase, fingerprint: bindingSetFingerprint };
  const sourceSpans = [{
    scriptRevisionId: bindingSet.scriptRevisionId,
    scriptSha256: bindingSet.scriptSha256,
    startOffsetUtf16: 0,
    endOffsetUtf16: 8,
    surfaceSha256: hash("阿航走入石室"),
  }];
  const frozenResolution = bindingSet.bindings.map((binding) => {
    const semantic = {
      assetId: binding.assetId,
      category: binding.category,
      presence: binding.presence,
      role: binding.role,
      mentionIds: [...binding.mentionIds],
      definitionVersionId: binding.definitionVersionId,
      authorityEventId: binding.authorityEventId,
      authorityVersionId: binding.authorityVersionId,
      assetVersionId: binding.assetVersionId,
      mediaSha256: binding.mediaSha256,
      knowledgeFingerprint: binding.knowledgeFingerprint,
      applicabilityFingerprint: binding.applicabilityFingerprint,
      bindingSemanticFingerprint: binding.semanticFingerprint,
    };
    return { ...semantic, fingerprint: digest(semantic) };
  });
  const frozenBase = {
    bindingSet: {
      id: bindingSet.id,
      revision: bindingSet.revision,
      fingerprint: bindingSet.fingerprint,
      analysisId: bindingSet.analysisId,
      unitId: bindingSet.unitId,
      unitRevision: bindingSet.unitRevision,
      unitFingerprint: bindingSet.unitFingerprint,
      panelBindingScopeFingerprint: hash("panel-scope-fixture"),
      panelIndex: bindingSet.panelIndex,
      scriptRevisionId: bindingSet.scriptRevisionId,
      scriptSha256: bindingSet.scriptSha256,
      promptRevisionId: bindingSet.promptRevisionId,
      promptSha256: bindingSet.promptSha256,
      sourceSpans,
    },
    analysis: {
      id: bindingSet.analysisId,
      revision: 1,
      fingerprint: analysisFingerprint,
      resolverVersion: "exact-identity-v1",
      proposals: [
        {
          id: "proposal-ahang",
          mentionId: "mention-ahang",
          startOffsetUtf16: 0,
          endOffsetUtf16: 2,
          surfaceSha256: hash("阿航"),
          presence: "required" as const,
          role: bindingA.role,
          status: "matched" as const,
          normalizedIdentityKey: "阿航",
          candidateSetFingerprint: hash("identity-ahang"),
          decisionReceiptId: "decision-ahang",
          resolvedAssetId: "character-ahang",
          unresolvedOptional: false,
        },
        {
          id: "proposal-mask",
          mentionId: "mention-mask",
          startOffsetUtf16: 4,
          endOffsetUtf16: 8,
          surfaceSha256: hash("黄金面具"),
          presence: "forbidden" as const,
          role: bindingForbidden.role,
          status: "matched" as const,
          normalizedIdentityKey: "完整黄金面具",
          candidateSetFingerprint: hash("identity-mask"),
          decisionReceiptId: "decision-mask",
          resolvedAssetId: "prop-complete-mask",
          unresolvedOptional: false,
        },
      ],
    },
    decisions,
    assetResolutionSnapshots: frozenResolution,
    currentness: {
      head: true as const,
      current: true as const,
      ready: true as const,
      staleReasons: [] as [],
      blockers: [] as [],
      warnings: [],
    },
  };
  const frozen = { ...frozenBase, fingerprint: digest(frozenBase) };
  return {
    projectId: "studio-project-fixture",
    target: {
      unitId: bindingSet.unitId,
      seasonId: "S03",
      episodeId: "EP01",
      unitSequence: 1,
      unitRevision: bindingSet.unitRevision,
      panelId: "panel-fixture-1",
      panelIndex: 1,
      panelCount: 2,
      unitLocalStartSeconds: 0,
      unitLocalEndSeconds: 7,
      episodeAbsoluteStartSeconds: 0,
      episodeAbsoluteEndSeconds: 7,
      durationSeconds: 7,
      totalDurationSeconds: 15,
    },
    bindingSet,
    frozen,
  };
}

describe("PanelReferenceResolution adapters", () => {
  it("Studio adapter 复用 BindingSet/frozen resolution，并把 forbidden 留在安全闭包", () => {
    const source = studioAdapterFixture();
    const resolution = adaptStudioBindingSetToPanelReferenceResolution(source);

    expect(resolution.closure).toBe("resolved");
    expect(resolution.generationReady).toBe(true);
    expect(resolution.semanticAssets.map((asset) => asset.assetId)).toEqual(["character-ahang"]);
    expect(resolution.forbiddenAssets.map((asset) => asset.assetId)).toEqual(["prop-complete-mask"]);
    expect(resolution.controlReferences).toHaveLength(1);
    expect(resolution.controlReferences[0]?.coveredAssetIds).toEqual(["character-ahang"]);
    expect(resolution.controlReferences[0]?.purpose).toBe("identity");
    expect(resolution.dependencies.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      "binding-set",
      "binding-provenance",
      "asset-resolution",
    ]));
    expect((resolution as unknown as Record<string, unknown>).analysisId).toBeUndefined();
    expect(resolution.extensions.analysisId).toBe("analysis-fixture");
    expect(() => assertPanelReferenceResolutionIntegrity(resolution)).not.toThrow();
  });

  it("Studio adapter 对 BindingSet/frozen resolution 缺项或篡改失败关闭", () => {
    const source = studioAdapterFixture();
    source.bindingSet.bindings = source.bindingSet.bindings.filter((binding) => binding.assetId !== "character-ahang");
    const resolution = adaptStudioBindingSetToPanelReferenceResolution(source);

    expect(resolution.generationReady).toBe(false);
    expect(resolution.closure).toBe("unresolved");
    expect(resolution.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "studio-binding-set-fingerprint-mismatch",
      "studio-binding-resolution-mismatch",
    ]));
  });

  it("Fusion adapter 保持中立顶层，Fusion 专属字段只在 provenance/extensions", () => {
    const semantic = {
      schemaVersion: 1 as const,
      resolverVersion: FUSION_PANEL_REFERENCE_RESOLVER_VERSION,
      projectId: "fusion-project-fixture",
      sourceContentAddress: `sha256:${hash("fusion-project")}` as const,
      unitItemId: "season-三-ep01-unit001",
      gridContractId: "grid-0123456789abcdefabcd",
      gridSourceFingerprint: hash("fusion-grid-source"),
      panelId: "panel-01",
      panelIndex: 1,
      panelCount: 2,
      startSeconds: 0,
      endSeconds: 7,
      storyboardRowIds: ["storyboard-row-1"],
      sourceShotNumbers: [1],
      scheduleRowIndexes: [0],
      semanticAssets: [{
        assetId: "C01",
        assetName: "阿航",
        category: "character" as const,
        provenance: [{
          kind: "storyboard-row" as const,
          storyboardRowId: "storyboard-row-1",
          note: "分镜行显式声明",
        }],
        hardLock: {
          assetId: "C01",
          workItemId: "asset-C01",
          lockId: "authority-C01-v1",
          authority: "user-authority" as const,
          artifactId: "artifact-C01",
          reviewId: "review-C01",
          path: "/read-only/fusion/C01.png",
          sha256: hash("fusion-C01-media"),
          referenceVersion: "asset-version-C01-v1",
        },
        bindingId: "panel-binding-C01",
      }],
      excludedAssets: [],
      referenceSlots: [{
        id: "panel-slot-C01",
        kind: "canonical-asset" as const,
        coveredAssetIds: ["C01"],
        readiness: "ready" as const,
        assetId: "C01",
        artifactId: "artifact-C01",
        path: "/read-only/fusion/C01.png",
        sha256: hash("fusion-C01-media"),
        reviewId: "review-C01",
      }],
      timelineReconciliations: [],
      detectedOverflow: false,
      closureStatus: "resolved" as const,
      generationReady: true,
      blockerCodes: [],
      issues: [],
    };
    const resolutionFingerprint = digest(semantic);
    const source: FusionPanelReferenceResolution = {
      ...semantic,
      resolutionId: `panel-reference-${resolutionFingerprint.slice(0, 28)}`,
      resolutionFingerprint,
      inputSnapshot: {
        storyboardRevision: 1,
        storyboardsSha256: hash("storyboards"),
        continuitySha256: hash("continuity"),
        productionAssetsSha256: hash("assets"),
        projectConfigSha256: hash("config"),
        gridSelectionsSha256: hash("selections"),
        gridContractsDigest: hash("contracts"),
        hardLockSnapshotsDigest: hash("locks"),
        unitMarkdownsDigest: hash("markdown"),
        overrideRevision: 0,
        derivedDefinitionsDigest: hash("derived"),
      },
    };
    const adapted = adaptFusionPanelReferenceResolution(source);

    expect(adapted.closure).toBe("resolved");
    expect(adapted.generationReady).toBe(true);
    expect(adapted.semanticAssets.map((asset) => asset.assetId)).toEqual(["C01"]);
    expect(adapted.controlReferences[0]?.purpose).toBe("identity");
    expect(adapted.sourceSpans).toHaveLength(1);
    expect((adapted as unknown as Record<string, unknown>).gridContractId).toBeUndefined();
    expect(adapted.extensions.gridContractId).toBe(source.gridContractId);
    expect(adapted.provenance[0]?.source).toBe("fusion-panel-reference-resolution");
    expect(JSON.stringify(adapted)).not.toContain("/read-only/fusion/C01.png");
  });
});
