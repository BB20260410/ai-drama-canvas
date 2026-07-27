import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioScaleMetadataFixture,
  expectedPanelCountForUnits,
  P9_SCALE_ASSET_CATEGORY_COUNTS,
  P9_SCALE_ASSET_COUNT,
  scaleAssetCategoryForIndex,
} from "../src/core/studio-scale-fixture.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { getStudioProductionState } from "../src/core/studio-production.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P9-R 规模夹具与精确宫格计数", () => {
  it("默认 77 项资产严格保持 24 角色、20 场景、33 道具", () => {
    const counts = Array.from({ length: P9_SCALE_ASSET_COUNT }, (_, index) => (
      scaleAssetCategoryForIndex(index, P9_SCALE_ASSET_COUNT)
    )).reduce<Record<"character" | "scene" | "prop", number>>((result, category) => {
      result[category] += 1;
      return result;
    }, { character: 0, scene: 0, prop: 0 });
    expect(counts).toEqual({
      character: P9_SCALE_ASSET_CATEGORY_COUNTS.character,
      scene: P9_SCALE_ASSET_CATEGORY_COUNTS.scene,
      prop: P9_SCALE_ASSET_CATEGORY_COUNTS.prop,
    });
  });

  it("SQL 精确 SUM 与 dashboard panels 一致，且含生产路径非零数据", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-scale-test-")));
    roots.push(parent);
    const unitCount = 8;
    const expectedPanels = expectedPanelCountForUnits(unitCount);
    const fixture = await createStudioScaleMetadataFixture({
      parentRoot: parent,
      unitCount,
      assetCount: 6,
      mediaMetaCount: 4,
      seedProductionPath: true,
      realAvDerivatives: true,
      name: "P9-R 定向规模",
    });
    roots.push(path.dirname(fixture.root));

    const production = await getStudioProductionState(fixture.root);
    expect(production.counts.units).toBe(unitCount);
    expect(production.counts.panels).toBe(expectedPanels);
    expect(fixture.counts.panels).toBe(expectedPanels);
    expect(fixture.counts.assetCategories).toEqual({ characters: 2, scenes: 2, props: 2 });

    const overview = await getStudioProductionDashboard(fixture.root, { operation: "overview" });
    if (overview.operation !== "overview") throw new Error("expected overview");
    expect(overview.counts.panels).toBe(expectedPanels);
    expect(overview.counts.panelsEstimated).toBe(expectedPanels);
    expect(fixture.dashboard.panelsMatchExact).toBe(true);

    expect(fixture.mediaQuality.placeholderSignatureOnly).toBe(false);
    expect(fixture.mediaQuality.imageWidth).toBeGreaterThanOrEqual(48);

    expect(fixture.counts.productionPath.panelCount).toBe(6);
    expect(fixture.counts.productionPath.bindingSets).toBe(6);
    expect(fixture.counts.productionPath.continuityReady).toBe(true);
    expect(fixture.counts.productionPath.generationRuns).toBe(6);
    expect(fixture.counts.productionPath.reviews).toBe(6);
    expect(fixture.counts.assetBindingSets).toBeGreaterThanOrEqual(6);

    // 首屏仍有界
    expect(fixture.dashboard.unitsPageSize).toBeLessThanOrEqual(36);
  }, 180_000);
});
