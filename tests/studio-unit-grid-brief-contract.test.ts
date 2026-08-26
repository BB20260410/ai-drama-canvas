import { describe, expect, it } from "vitest";
import { buildStudioUnitGridAgentImagegenBrief } from "../src/core/codex.js";
import type { StudioUnitGridGenerationFreezePack } from "../src/core/studio-unit-grid-generation.js";
import {
  IDENTITY_SENTENCE_MAX_CHARS,
  UNIT_GRID_BRIEF_TEMPLATE_ID,
  composeUnitGridBriefContract,
  renderUnitGridBriefContractText,
} from "../src/core/unit-grid-brief-contract.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function nineHeads(assetId: string, panelId: string) {
  const fields = [
    "costume", "injury", "heldObject", "position", "facing",
    "emotion", "layout", "lighting", "referenceSha256",
  ] as const;
  return fields.map((field) => ({
    headKey: `${assetId}:${field}`,
    headRevision: 1,
    entryId: `entry-${panelId}-${field}`,
    entryFingerprint: SHA_C,
    field,
    scope: {
      kind: "panel" as const,
      scopeId: panelId,
      unitId: "S1E01-U01",
      unitRevision: 1,
      startMilliseconds: 0,
      endMilliseconds: 5000,
      fingerprint: SHA_C,
    },
    state: {
      status: "resolved" as const,
      value: field === "referenceSha256" ? SHA_A : `val-${field}`,
      provenance: [{ kind: "fixture", reference: `${panelId}-${field}`, fingerprint: SHA_C }],
      fingerprint: SHA_C,
    },
    fingerprint: SHA_C,
  }));
}

/** 最小可驱动 shipped brief builder 的 unit-grid pack 形状（不走 I/O）。 */
function minimalUnitGridPack(options?: {
  emptyControlReferences?: boolean;
  continuation?: boolean;
}): StudioUnitGridGenerationFreezePack {
  // 测试夹具：仅满足 brief builder 读取面，经 unknown 断言为 shipped 类型。
  const panelId = "panel-01";
  const continuity = {
    schemaVersion: 1 as const,
    kind: "studio-generation-continuity-snapshot" as const,
    scope: {
      kind: "panel" as const,
      scopeId: panelId,
      unitId: "S1E01-U01",
      unitRevision: 1,
      startMilliseconds: 0,
      endMilliseconds: 5000,
      fingerprint: SHA_C,
    },
    requiredFields: [
      "costume", "injury", "heldObject", "position", "facing",
      "emotion", "layout", "lighting", "referenceSha256",
    ] as const,
    assets: [{
      assetId: "character-qingdeng-ke",
      scope: {
        kind: "panel" as const,
        scopeId: panelId,
        unitId: "S1E01-U01",
        unitRevision: 1,
        startMilliseconds: 0,
        endMilliseconds: 5000,
        fingerprint: SHA_C,
      },
      requiredFields: [
        "costume", "injury", "heldObject", "position", "facing",
        "emotion", "layout", "lighting", "referenceSha256",
      ],
      timelineFingerprint: SHA_C,
      readinessFingerprint: SHA_C,
      heads: nineHeads("character-qingdeng-ke", panelId),
      fingerprint: SHA_C,
    }],
    fingerprint: SHA_C,
  };

  const controlReferences = options?.emptyControlReferences
    ? []
    : [{
      referenceId: "ref-char",
      mediaSha256: SHA_A,
      localPath: "/managed/cas/sha256/aa/" + SHA_A,
      coveredAssetIds: ["character-qingdeng-ke"],
      categories: ["character"],
      roles: ["主体"],
      referenceUsages: [{
        assetId: "character-qingdeng-ke",
        usage: {
          purpose: "identity" as const,
          inheritOnly: ["all"],
          excludeFromOutput: [],
          carrierPolicy: "none" as const,
        },
      }],
      fingerprint: SHA_C,
    }, {
      referenceId: "ref-scene",
      mediaSha256: SHA_B,
      localPath: "/managed/cas/sha256/bb/" + SHA_B,
      coveredAssetIds: ["scene-rainy-inn"],
      categories: ["scene"],
      roles: ["场景"],
      referenceUsages: [{
        assetId: "scene-rainy-inn",
        usage: {
          purpose: "scale-reference" as const,
          inheritOnly: ["碎片形制", "材质", "指纹", "相对尺度"],
          excludeFromOutput: ["手套", "手指", "夹持姿势", "背景"],
          carrierPolicy: "reference-only" as const,
        },
      }],
      fingerprint: SHA_C,
    }];

  const panelPack = {
    schemaVersion: 4 as const,
    kind: "studio-generation-freeze-pack" as const,
    provenance: "asset-binding-set" as const,
    id: "panel-pack-1",
    fingerprint: SHA_C,
    projectId: "project-test",
    managedManifestFingerprint: SHA_C,
    unitSnapshotFingerprint: SHA_C,
    continuity,
    target: {
      unitId: "S1E01-U01",
      unitRevision: 1,
      panelId,
      panelIndex: 1,
      panelCount: 2,
      seasonId: "S1",
      episodeId: "S1E1",
      unitSequence: 1,
      durationSeconds: 15,
      episodeAbsoluteStartSeconds: 0,
      episodeAbsoluteEndSeconds: 15,
    },
  };

  return {
    schemaVersion: 5,
    kind: "studio-generation-freeze-pack",
    provenance: "unit-grid-binding-sets",
    id: "studio-generation-freeze-grid-1",
    fingerprint: SHA_C,
    projectId: "project-test",
    managedManifestFingerprint: SHA_C,
    unitSnapshotFingerprint: SHA_C,
    continuityFingerprint: SHA_C,
    target: {
      targetKind: "unit-grid",
      targetId: "S1E01-U01",
      unitId: "S1E01-U01",
      seasonId: "S1",
      episodeId: "S1E1",
      unitSequence: 1,
      unitRevision: 1,
      panelCount: 2,
      durationSeconds: 15,
      episodeAbsoluteStartSeconds: 0,
      episodeAbsoluteEndSeconds: 15,
    },
    referencePolicy: {
      profileId: "studio-generic-unit-grid-v1",
      persisted: true,
      minControlReferences: 1,
      maxControlReferences: 5,
      fingerprint: SHA_C,
    },
    panels: [{
      order: 1,
      panelId,
      panelIndex: 1,
      startSeconds: 0,
      endSeconds: 7.5,
      durationSeconds: 7.5,
      panelPackId: "panel-pack-1",
      panelPackFingerprint: SHA_C,
      panelBindingScopeFingerprint: SHA_C,
      instruction: {
        visualAction: "停步",
        shotComposition: "中景",
        filmingMethod: "固定",
      },
      panelPack: panelPack as unknown as StudioUnitGridGenerationFreezePack["panels"][0]["panelPack"],
      fingerprint: SHA_C,
    }],
    controlReferences,
    ...(options?.continuation
      ? { continuationSource: { schemaVersion: 2, kind: "studio-unit-grid-continuation-source", referenceId: "cont-1" } }
      : {}),
    request: {
      schemaVersion: 5,
      kind: "studio-codex-generation-request",
      provenance: "unit-grid-binding-sets",
      id: "req-1",
      fingerprint: SHA_C,
      projectId: "project-test",
      executorKind: "agent-imagegen",
      allowedProviders: ["codex", "grok"],
      exactlyOneImage: true,
      maxCalls: 1,
      target: {
        targetKind: "unit-grid",
        targetId: "S1E01-U01",
        unitId: "S1E01-U01",
        seasonId: "S1",
        episodeId: "S1E1",
        unitSequence: 1,
        unitRevision: 1,
        panelCount: 2,
        durationSeconds: 15,
        episodeAbsoluteStartSeconds: 0,
        episodeAbsoluteEndSeconds: 15,
      },
      referencePolicy: {
        profileId: "studio-generic-unit-grid-v1",
        persisted: true,
        minControlReferences: 1,
        maxControlReferences: 5,
        fingerprint: SHA_C,
      },
      panelPacks: [],
      modelPayload: {
        exactlyOneImage: true,
        layout: "9:16-vertical-ordered-grid",
        renderedPrompt: "只生成一张 9:16 竖屏 2 宫格故事板",
        target: {
          targetKind: "unit-grid",
          targetId: "S1E01-U01",
          unitId: "S1E01-U01",
          seasonId: "S1",
          episodeId: "S1E1",
          unitSequence: 1,
          unitRevision: 1,
          panelCount: 2,
          durationSeconds: 15,
          episodeAbsoluteStartSeconds: 0,
          episodeAbsoluteEndSeconds: 15,
        },
        referenceUsages: controlReferences.flatMap((reference) =>
          reference.referenceUsages.map(({ assetId, usage }) => ({
            referenceId: reference.referenceId,
            assetId,
            usage,
          }))),
        panels: [],
      },
      controlReferences,
      forbidden: [
        "titles", "panel-numbers", "durations", "dialogue-text",
        "subtitles", "watermarks", "ui", "pseudo-text",
      ],
    },
  } as unknown as StudioUnitGridGenerationFreezePack;
}

describe("buildStudioUnitGridAgentImagegenBrief (shipped runtime)", () => {
  it("返回 controlReferences 身份与九字段 heads 摘要；codex/grok 对称", () => {
    const pack = minimalUnitGridPack();
    const codex = buildStudioUnitGridAgentImagegenBrief(pack, "codex");
    const grok = buildStudioUnitGridAgentImagegenBrief(pack, "grok");

    expect(codex.kind).toBe("studio-agent-imagegen-brief");
    expect(codex.provider).toBe("codex");
    expect(codex.exactlyOneImage).toBe(true);
    expect(codex.maxCalls).toBe(1);
    expect(codex.referenceCount).toBe(2);
    expect(codex.controlReferences).toEqual([
      {
        assetId: "character-qingdeng-ke",
        mediaSha256: SHA_A,
        categories: ["character"],
        roles: ["主体"],
        referenceUsages: [{
          assetId: "character-qingdeng-ke",
          usage: {
            purpose: "identity",
            inheritOnly: ["all"],
            excludeFromOutput: [],
            carrierPolicy: "none",
          },
        }],
        fingerprint: SHA_C,
      },
      {
        assetId: "scene-rainy-inn",
        mediaSha256: SHA_B,
        categories: ["scene"],
        roles: ["场景"],
        referenceUsages: [{
          assetId: "scene-rainy-inn",
          usage: {
            purpose: "scale-reference",
            inheritOnly: ["碎片形制", "材质", "指纹", "相对尺度"],
            excludeFromOutput: ["手套", "手指", "夹持姿势", "背景"],
            carrierPolicy: "reference-only",
          },
        }],
        fingerprint: SHA_C,
      },
    ]);
    expect(codex.continuityFingerprint).toBe(SHA_C);
    expect(codex.continuityNineFieldSummary).toHaveLength(1);
    const nine = codex.continuityNineFieldSummary[0]!;
    expect(nine.panelId).toBe("panel-01");
    expect(nine.assetId).toBe("character-qingdeng-ke");
    expect(nine.fields.heldObject).toBe("val-heldObject");
    expect(nine.fields.position).toBe("val-position");
    expect(nine.fields.referenceSha256).toBe(SHA_A);
    expect(nine.requiredFields).toContain("heldObject");

    expect(grok.provider).toBe("grok");
    expect(grok.controlReferences).toEqual(codex.controlReferences);
    expect(grok.continuityNineFieldSummary).toEqual(codex.continuityNineFieldSummary);
    expect(grok.tool.primaryTool).toMatch(/image_gen/);
    expect(codex.tool.primaryTool).toMatch(/image_gen|Codex/i);

    expect(codex.promptContract.templateId).toBe(UNIT_GRID_BRIEF_TEMPLATE_ID);
    expect(codex.promptContract.slots.STYLE_LOCK.aspect).toBe("9:16");
    expect(codex.promptContract.slots.IDENTITY_LOCK).toEqual([
      expect.objectContaining({
        assetId: "character-qingdeng-ke",
        mediaSha256: SHA_A,
        purpose: "identity",
      }),
    ]);
    expect(codex.promptContract.slots.IDENTITY_LOCK[0]!.identitySentence.length)
      .toBeLessThanOrEqual(IDENTITY_SENTENCE_MAX_CHARS);
    expect(codex.promptContract.slots.SCENE_LOCK[0]).toMatchObject({
      assetId: "scene-rainy-inn",
      mediaSha256: SHA_B,
    });
    expect(codex.promptContract.slots.BEATS[0]).toMatchObject({
      order: 1,
      panelId: "panel-01",
      shotComposition: "中景",
      filmingMethod: "固定",
      visualAction: "停步",
    });
    expect(codex.promptContract.slots.HARD_NEGS).toEqual(expect.arrayContaining(["字幕", "水印/标志"]));
    expect(codex.promptContract.slots.DELTA_ONLY).toBeNull();
    expect(codex.promptContract.slots.OUTPUT_RULES.some((rule) => rule.includes("只输出一张图"))).toBe(true);
    expect(codex.promptContractText).toContain("STYLE_LOCK");
    expect(codex.promptContractText).toContain("IDENTITY_LOCK");
    expect(grok.promptContract).toEqual(codex.promptContract);
    expect(codex.previousStandings).toEqual([{ panelId: "panel-01", previousStanding: null }]);
    expect(codex.frozenPanelOverlays).toBeUndefined();
    expect(codex.tool.notes.at(-1)).toContain("前镜交接");
    expect(codex.tool.notes.some((note) => note.includes("光线（宫格覆盖）"))).toBe(true);
    expect(grok.tool.notes.at(-1)).toContain("前镜交接");
  });

  it("续镜 pack 投影 DELTA_ONLY，且不改 renderedPrompt", () => {
    const pack = minimalUnitGridPack({ continuation: true });
    const brief = buildStudioUnitGridAgentImagegenBrief(pack, "codex");
    expect(brief.prompt).toBe("只生成一张 9:16 竖屏 2 宫格故事板");
    expect(brief.promptContract.continuation).toBe(true);
    expect(brief.promptContract.slots.DELTA_ONLY).toMatch(/只写变化/);
    expect(brief.promptContractText).toContain("DELTA_ONLY");
  });

  it("compose 与 brief 共用同一 fail-closed：零 controlRefs 禁止 text-only", () => {
    const pack = minimalUnitGridPack({ emptyControlReferences: true });
    expect(() => composeUnitGridBriefContract(pack)).toThrow(/controlReferences|text-only/);
  });

  it("多格 brief 把前镜站位写进 BEATS 文本，不改 pack.renderedPrompt", () => {
    const pack = minimalUnitGridPack();
    const first = pack.panels[0]!;
    pack.panels.push({
      ...first,
      order: 2,
      panelId: "panel-02",
      panelIndex: 2,
      startSeconds: 7.5,
      endSeconds: 15,
      instruction: {
        visualAction: "抬手",
        shotComposition: "近景",
        filmingMethod: "推",
      },
    });
    const originalPrompt = pack.request.modelPayload.renderedPrompt;
    const contract = composeUnitGridBriefContract(pack);
    expect(contract.slots.BEATS[0]?.previousStanding).toBeUndefined();
    expect(contract.slots.BEATS[1]?.previousStanding).toEqual({
      order: 1,
      shotComposition: "中景",
      filmingMethod: "固定",
      visualAction: "停步",
    });
    expect(pack.request.modelPayload.renderedPrompt).toBe(originalPrompt);
    const text = renderUnitGridBriefContractText(contract);
    expect(text).toContain("G2 7.5s 近景/推 抬手 ← G1 中景/固定");
    const standingLine = "前镜交接：G1 中景 · 停步 · 固定。本格必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。";
    pack.panels[1] = {
      ...pack.panels[1]!,
      panelPack: {
        ...pack.panels[1]!.panelPack,
        request: {
          modelPayload: { renderedPrompt: `头\n${standingLine}\n尾` },
        },
      } as typeof pack.panels[1]["panelPack"],
    };
    const brief = buildStudioUnitGridAgentImagegenBrief(pack, "codex");
    expect(brief.previousStandings).toEqual([
      { panelId: "panel-01", previousStanding: null },
      {
        panelId: "panel-02",
        previousStanding: {
          panelIndex: 1,
          panelId: "",
          shotComposition: "中景",
          visualAction: "停步",
          filmingMethod: "固定",
        },
      },
    ]);
    expect(brief.tool.notes.some((note) => note.includes("前镜交接"))).toBe(true);
    expect(brief.tool.notes.some((note) => note.includes("光线（宫格覆盖）"))).toBe(true);
    expect(brief.prompt).toBe(originalPrompt);
    expect(brief.frozenPanelOverlays).toBeUndefined();
  });

  it("多格 brief 把本格光线/服化写进 BEATS，并从 panelPack 投影 overlays", () => {
    const pack = minimalUnitGridPack();
    const first = pack.panels[0]!;
    pack.panels[0] = {
      ...first,
      instruction: {
        ...first.instruction,
        sceneLighting: "室内火光",
        costumeState: "深灰祭服",
      },
    };
    pack.panels.push({
      ...first,
      order: 2,
      panelId: "panel-02",
      panelIndex: 2,
      startSeconds: 7.5,
      endSeconds: 15,
      instruction: {
        visualAction: "抬手",
        shotComposition: "近景",
        filmingMethod: "推",
        sceneLighting: "走廊冷光",
      },
      panelPack: {
        ...first.panelPack,
        request: {
          modelPayload: { renderedPrompt: "头\n光线（宫格覆盖）：走廊冷光\n服装（宫格覆盖）：湿祭服\n尾" },
        },
      } as typeof first.panelPack,
    });
    const originalPrompt = pack.request.modelPayload.renderedPrompt;
    const contract = composeUnitGridBriefContract(pack);
    expect(contract.slots.BEATS[0]?.sceneLighting).toBe("室内火光");
    expect(contract.slots.BEATS[0]?.costumeState).toBe("深灰祭服");
    expect(contract.slots.BEATS[1]?.sceneLighting).toBe("走廊冷光");
    const text = renderUnitGridBriefContractText(contract);
    expect(text).toContain("光:室内火光");
    expect(text).toContain("服:深灰祭服");
    expect(text).toContain("光:走廊冷光");
    const brief = buildStudioUnitGridAgentImagegenBrief(pack, "codex");
    expect(brief.frozenPanelOverlays).toEqual([
      { panelId: "panel-02", lighting: "走廊冷光", costume: "湿祭服" },
    ]);
    expect(brief.prompt).toBe(originalPrompt);
  });

  it("controlReferences 为空时 fail-closed，禁止 text-only", () => {
    const pack = minimalUnitGridPack({ emptyControlReferences: true });
    expect(() => buildStudioUnitGridAgentImagegenBrief(pack, "codex")).toThrow(
      /controlReferences|text-only/,
    );
  });
});
