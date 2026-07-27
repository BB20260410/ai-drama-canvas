import { describe, expect, it } from "vitest";
import { buildStudioUnitGridAgentImagegenBrief } from "../src/core/codex.js";
import type { StudioUnitGridGenerationFreezePack } from "../src/core/studio-unit-grid-generation.js";

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
      fingerprint: SHA_C,
    }, {
      referenceId: "ref-scene",
      mediaSha256: SHA_B,
      localPath: "/managed/cas/sha256/bb/" + SHA_B,
      coveredAssetIds: ["scene-rainy-inn"],
      categories: ["scene"],
      roles: ["场景"],
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
        fingerprint: SHA_C,
      },
      {
        assetId: "scene-rainy-inn",
        mediaSha256: SHA_B,
        categories: ["scene"],
        roles: ["场景"],
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
  });

  it("controlReferences 为空时 fail-closed，禁止 text-only", () => {
    const pack = minimalUnitGridPack({ emptyControlReferences: true });
    expect(() => buildStudioUnitGridAgentImagegenBrief(pack, "codex")).toThrow(
      /controlReferences|text-only/,
    );
  });
});
