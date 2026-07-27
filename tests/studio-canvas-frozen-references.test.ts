import { describe, expect, it } from "vitest";
import {
  projectStudioCanvasFrozenReferences,
  StudioCanvasFrozenReferenceError,
} from "../src/core/studio-canvas-frozen-references.js";
import type { StudioUnitGridGenerationFreezePack } from "../src/core/studio-unit-grid-generation.js";

const CHARACTER_SHA = "a".repeat(64);
const SCENE_SHA = "b".repeat(64);
const FORBIDDEN_SHA = "c".repeat(64);

function unitGridPack(): StudioUnitGridGenerationFreezePack {
  return {
    schemaVersion: 5,
    kind: "studio-generation-freeze-pack",
    provenance: "unit-grid-binding-sets",
    panels: [{
      panelPack: {
        assets: [{
          assetId: "char-dudu-v1",
          category: "character",
          role: "CHARACTER_IDENTITY",
          media: { sha256: CHARACTER_SHA },
          definition: { name: "嘟嘟" },
        }, {
          assetId: "scene-stone-cave-v1",
          category: "scene",
          role: "SCENE_TOPOLOGY",
          media: { sha256: SCENE_SHA },
          definition: { name: "石穴全景" },
        }],
        forbiddenAssets: [{
          assetId: "meteor-v2-rejected",
          category: "prop",
          role: "forbidden",
          media: { sha256: FORBIDDEN_SHA },
          definition: { name: "失败纹样" },
        }],
      },
    }],
    controlReferences: [{
      referenceId: "ref-character",
      mediaSha256: CHARACTER_SHA,
      coveredAssetIds: ["char-dudu-v1"],
      categories: ["character"],
      roles: ["CHARACTER_IDENTITY"],
    }, {
      referenceId: "ref-scene",
      mediaSha256: SCENE_SHA,
      coveredAssetIds: ["scene-stone-cave-v1"],
      categories: ["scene"],
      roles: ["SCENE_TOPOLOGY"],
    }],
  } as unknown as StudioUnitGridGenerationFreezePack;
}

describe("studio-canvas-frozen-references", () => {
  it("只投影 pack 实际 controlReferences，并保留角色/场景类型", () => {
    const projected = projectStudioCanvasFrozenReferences(unitGridPack());
    expect(projected.map((item) => [item.title, item.referenceType, item.typeLabel])).toEqual([
      ["嘟嘟", "character", "角色参考"],
      ["石穴全景", "scene", "场景参考"],
    ]);
    expect(JSON.stringify(projected)).not.toContain("meteor-v2-rejected");
    expect(JSON.stringify(projected)).not.toContain(FORBIDDEN_SHA);
  });

  it("control reference 与冻结资产媒体不一致时失败关闭", () => {
    const pack = unitGridPack();
    pack.controlReferences[0] = { ...pack.controlReferences[0]!, mediaSha256: "d".repeat(64) };
    expect(() => projectStudioCanvasFrozenReferences(pack)).toThrow(StudioCanvasFrozenReferenceError);
  });

  it("STYLE_ONLY 和流星纹按语义标成风格/VFX，不伪装成普通道具", () => {
    const pack = unitGridPack();
    const styleSha = "e".repeat(64);
    const vfxSha = "f".repeat(64);
    const panelPack = pack.panels[0]!.panelPack;
    panelPack.assets.push({
      assetId: "style-ref-4",
      category: "prop",
      role: "STYLE_ONLY",
      media: { sha256: styleSha },
      definition: { name: "电影风格参考" },
    } as never, {
      assetId: "vfx-meteor-glow",
      category: "prop",
      role: "VFX_STATE",
      media: { sha256: vfxSha },
      definition: { name: "流星纹发光态" },
    } as never);
    pack.controlReferences.push({
      referenceId: "ref-style",
      mediaSha256: styleSha,
      coveredAssetIds: ["style-ref-4"],
      categories: ["prop"],
      roles: ["STYLE_ONLY"],
    } as never, {
      referenceId: "ref-vfx",
      mediaSha256: vfxSha,
      coveredAssetIds: ["vfx-meteor-glow"],
      categories: ["prop"],
      roles: ["VFX_STATE"],
    } as never);
    const projected = projectStudioCanvasFrozenReferences(pack);
    expect(projected.at(-2)?.referenceType).toBe("style");
    expect(projected.at(-1)?.referenceType).toBe("vfx");
  });
});
