import { describe, expect, it } from "vitest";
import {
  assertT23ScaleExactPassBindings,
  redactT23ScaleRendererProbeForEvidence,
  summarizeT23ScaleRendererProbe,
  type T23ScaleRendererProbeSnapshot,
} from "../scripts/lib/t23-scale-performance-probe.js";

const expectedBindings = Array.from({ length: 4 }, (_, index) => ({
  unitId: `S1E01-U0${index}`,
  rawMediaSha256: String(index + 1).repeat(64),
  referenceMediaSha256: String(index + 5).repeat(64),
}));

function snapshot(): T23ScaleRendererProbeSnapshot {
  return {
    unitNodeIds: Array.from({ length: 36 }, (_, index) => `S1E01-U${String(index).padStart(2, "0")}`),
    raws: Array.from({ length: 4 }, (_, index) => ({
      unitId: `S1E01-U0${index}`,
      rawMediaSha256: String(index + 1).repeat(64),
      thumbnailUrl: `aicanvas-studio://thumbnail/raw-${index + 1}`,
      verification: "deep-verified",
    })),
    references: Array.from({ length: 4 }, (_, index) => ({
      unitId: `S1E01-U0${index}`,
      mediaSha256: String(index + 5).repeat(64),
      thumbnailUrl: `aicanvas-studio://thumbnail/reference-${index + 1}`,
    })),
  };
}

describe("T23 renderer 规模只读 probe", () => {
  it("从实际图节点与媒体投影统计唯一 SHA/URL", () => {
    expect(summarizeT23ScaleRendererProbe(
      snapshot(),
      ["S1E01-U00", "S1E01-U01", "S1E01-U02", "S1E01-U03"],
    )).toEqual({
      projectedUnitNodeCount: 36,
      uniqueProjectedUnitNodeCount: 36,
      passRawCount: 4,
      uniqueRawShaCount: 4,
      uniqueRawUrlCount: 4,
      referenceCount: 4,
      uniqueReferenceShaCount: 4,
      uniqueReferenceUrlCount: 4,
    });
  });

  it("不会把重复 SHA/URL 或重复 unit 节点伪装成唯一项", () => {
    const input = snapshot();
    input.unitNodeIds[35] = input.unitNodeIds[34]!;
    input.raws[3]!.rawMediaSha256 = input.raws[2]!.rawMediaSha256;
    input.raws[3]!.thumbnailUrl = input.raws[2]!.thumbnailUrl;
    input.references[3]!.mediaSha256 = input.references[2]!.mediaSha256;
    input.references[3]!.thumbnailUrl = input.references[2]!.thumbnailUrl;
    expect(summarizeT23ScaleRendererProbe(
      input,
      ["S1E01-U00", "S1E01-U01", "S1E01-U02", "S1E01-U03"],
    )).toMatchObject({
      projectedUnitNodeCount: 36,
      uniqueProjectedUnitNodeCount: 35,
      uniqueRawShaCount: 3,
      uniqueRawUrlCount: 3,
      uniqueReferenceShaCount: 3,
      uniqueReferenceUrlCount: 3,
    });
  });

  it("逐单元冻结 raw/reference 映射正确时只返回精确缩略图", () => {
    expect(assertT23ScaleExactPassBindings(snapshot(), expectedBindings)).toEqual({
      rawThumbnailUrls: Array.from({ length: 4 }, (_, index) => `aicanvas-studio://thumbnail/raw-${index + 1}`),
      referenceThumbnailUrls: Array.from({ length: 4 }, (_, index) => `aicanvas-studio://thumbnail/reference-${index + 1}`),
    });
  });

  it("raw 或 reference 在单元间串位时失败关闭", () => {
    const rawSwapped = snapshot();
    [rawSwapped.raws[0]!.rawMediaSha256, rawSwapped.raws[1]!.rawMediaSha256] = [
      rawSwapped.raws[1]!.rawMediaSha256,
      rawSwapped.raws[0]!.rawMediaSha256,
    ];
    expect(() => assertT23ScaleExactPassBindings(rawSwapped, expectedBindings)).toThrow(/正式 raw/u);

    const referenceSwapped = snapshot();
    [referenceSwapped.references[0]!.mediaSha256, referenceSwapped.references[1]!.mediaSha256] = [
      referenceSwapped.references[1]!.mediaSha256,
      referenceSwapped.references[0]!.mediaSha256,
    ];
    expect(() => assertT23ScaleExactPassBindings(referenceSwapped, expectedBindings)).toThrow(/冻结参考/u);
  });

  it("正确参考缺缩略图时不能由同单元另一张图充数", () => {
    const input = snapshot();
    input.references[0]!.thumbnailUrl = undefined;
    input.references.push({
      unitId: input.references[0]!.unitId,
      mediaSha256: "f".repeat(64),
      thumbnailUrl: "aicanvas-studio://thumbnail/wrong-reference",
    });
    expect(() => assertT23ScaleExactPassBindings(input, expectedBindings)).toThrow(/冻结参考/u);
  });

  it("证据投影移除包含临时工程路径的缩略图 URL，但保留绑定身份", () => {
    const input = snapshot();
    input.raws[0]!.thumbnailUrl = "aicanvas-studio://thumbnail/raw?projectRoot=%2Fprivate%2Fvar%2Ffixture";
    input.references[0]!.thumbnailUrl = "aicanvas-studio://thumbnail/reference?projectRoot=/private/var/fixture";

    const evidence = redactT23ScaleRendererProbeForEvidence(input);
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain("thumbnailUrl");
    expect(serialized).not.toContain("projectRoot");
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("%2Fprivate");
    expect(evidence.raws[0]).toEqual({
      unitId: "S1E01-U00",
      rawMediaSha256: "1".repeat(64),
      verification: "deep-verified",
      thumbnailAvailable: true,
    });
    expect(evidence.references[0]).toEqual({
      unitId: "S1E01-U00",
      mediaSha256: "5".repeat(64),
      thumbnailAvailable: true,
    });
  });
});
