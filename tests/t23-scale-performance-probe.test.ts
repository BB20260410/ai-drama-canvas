import { describe, expect, it } from "vitest";
import {
  summarizeT23ScaleRendererProbe,
  type T23ScaleRendererProbeSnapshot,
} from "../scripts/lib/t23-scale-performance-probe.js";

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
});
