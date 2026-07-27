import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import type { StudioBindingPanelControl } from "../src/core/studio-binding-control.js";
import {
  STUDIO_DASHBOARD_UNIT_PAGE_LIMIT,
  getStudioProductionDashboard,
  studioDashboardPanelControlAssetIds,
  type StudioDashboardAppearancesPage,
  type StudioDashboardAssetsPage,
  type StudioDashboardOverview,
  type StudioDashboardQueuePage,
  type StudioDashboardUnitDetail,
  type StudioDashboardUnitsPage,
} from "../src/core/studio-production-dashboard.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const roots: string[] = [];
let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_DASHBOARD_GENERATION_DELAY_LABEL;
  delete process.env.AI_CANVAS_TEST_DASHBOARD_GENERATION_DELAY_MS;
  await fixture?.cleanup();
  fixture = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P8 StudioProductionDashboard Core", () => {
  it("forbidden Binding 只保留为安全约束，不进入 Dashboard 控制资产或连续性 nextAction", () => {
    const proposal = (
      assetId: string,
      presence: "required" | "optional" | "forbidden",
    ): StudioBindingPanelControl["proposals"][number] => ({
      id: `proposal-${assetId}`,
      sourceExcerptId: `excerpt-${assetId}`,
      entityText: assetId,
      entityCategory: assetId.startsWith("scene-") ? "scene" : "character",
      status: "matched",
      matchKind: "exact",
      candidates: [],
      matchedAssetId: assetId,
      presence,
      role: `${presence} fixture`,
      blockerCodes: [],
    });
    const panel = {
      bindingSet: {
        id: "binding-set-current",
        fingerprint: "a".repeat(64),
        currentness: "current",
        frozenAt: "2026-07-22T00:00:00.000Z",
      },
      proposals: [
        proposal("char-visible", "required"),
        proposal("char-offscreen", "forbidden"),
        proposal("scene-visible", "optional"),
      ],
    } satisfies Pick<StudioBindingPanelControl, "bindingSet" | "proposals">;

    expect(studioDashboardPanelControlAssetIds(panel)).toEqual(["char-visible", "scene-visible"]);
    expect(studioDashboardPanelControlAssetIds({ ...panel, bindingSet: undefined })).toEqual([
      "char-visible",
      "scene-visible",
    ]);
  });

  it("空受管工程 overview 有界、Core nextAction、无路径泄漏", async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-p8-empty-")));
    roots.push(temporaryRoot);
    const project = await createManagedProject({ parentRoot: temporaryRoot, name: "P8 空驾驶舱" });

    const overview = await getStudioProductionDashboard(project.paths.root, { operation: "overview" }) as StudioDashboardOverview;
    expect(overview).toMatchObject({
      schemaVersion: 1,
      kind: "studio-production-dashboard",
      operation: "overview",
      projectId: project.project.id,
      counts: { units: 0, canonicalAssets: 0, scriptDocuments: 0 },
      nextAction: { code: "import-script", requiresWrite: true },
      capabilities: {
        sourceShot: "not-applicable",
        fusionStoryboardSheet: "not-applicable",
        legacyPublication: "not-applicable",
        p3VisualConstraints: "not-applicable",
      },
    });
    expect(overview.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(overview.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toMatch(/\.sqlite|objectPath|bodyPath|databasePath|\/Users\//u);

    const units = await getStudioProductionDashboard(project.paths.root, { operation: "units", limit: 36 }) as StudioDashboardUnitsPage;
    expect(units.operation).toBe("units");
    expect(units.page.items).toEqual([]);
    expect(units.page.limit).toBeLessThanOrEqual(STUDIO_DASHBOARD_UNIT_PAGE_LIMIT);

    const assets = await getStudioProductionDashboard(project.paths.root, { operation: "assets" }) as StudioDashboardAssetsPage;
    expect(assets.page.items).toEqual([]);

    for (const queue of ["ambiguity", "missing", "stale", "conflict", "rework"] as const) {
      const page = await getStudioProductionDashboard(project.paths.root, { operation: "queue", queue }) as StudioDashboardQueuePage;
      expect(page.operation).toBe("queue");
      expect(page.queue).toBe(queue);
      expect(page.page.items).toEqual([]);
      expect(page.page.limit).toBeLessThanOrEqual(36);
    }

    const again = await getStudioProductionDashboard(project.paths.root, { operation: "overview" }) as StudioDashboardOverview;
    expect(again.fingerprint).toBe(overview.fingerprint);
    expect(again.nextAction.code).toBe(overview.nextAction.code);
  });

  it("P7 fixture 上贯通 units/unit/assets/appearances，legacy 显式 not-applicable", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const root = fixture.root;

    const overview = await getStudioProductionDashboard(root, { operation: "overview" }) as StudioDashboardOverview;
    expect(overview.counts.units).toBeGreaterThanOrEqual(2);
    expect(overview.counts.canonicalAssets).toBeGreaterThanOrEqual(3);
    expect(overview.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const units = await getStudioProductionDashboard(root, { operation: "units", limit: 36 }) as StudioDashboardUnitsPage;
    expect(units.page.items.length).toBeGreaterThanOrEqual(2);
    expect(units.page.items.length).toBeLessThanOrEqual(36);
    const first = units.page.items[0]!;
    expect(first.locator).toMatchObject({ kind: "unit", unitId: first.id });

    const unit = await getStudioProductionDashboard(root, {
      operation: "unit",
      unitId: fixture.units.sixPanel.unit.id,
      panelId: fixture.units.sixPanel.panels[0]!.id,
    }) as StudioDashboardUnitDetail;
    expect(unit.operation).toBe("unit");
    expect(unit.panels.length).toBeGreaterThanOrEqual(2);
    expect(unit.panels.length).toBeLessThanOrEqual(6);
    expect(unit.selectedPanel).toBeDefined();
    expect(unit.selectedPanel!.controlAssets.length).toBeLessThanOrEqual(6);
    expect(unit.selectedPanel!.legacy).toEqual({
      sourceShot: "not-applicable",
      fusionStoryboardSheet: "not-applicable",
      p3VisualConstraints: "not-applicable",
      publication: "not-applicable",
    });
    expect(unit.nextAction.code).toBeTruthy();
    expect(unit.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(unit)).not.toMatch(/\.sqlite|objectPath|bodyPath/u);

    const assets = await getStudioProductionDashboard(root, { operation: "assets", limit: 36 }) as StudioDashboardAssetsPage;
    expect(assets.page.items.length).toBeGreaterThanOrEqual(3);
    const asset = assets.page.items.find((item) => item.id === fixture!.assets.ahang.id)!;
    expect(asset.hasPrimaryAuthority).toBe(true);
    // 权威图 thumbnail recipe 供画布节点 aicanvas-studio://thumbnail/... 渲染
    expect(asset.authorityMediaSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(asset.authorityThumbnailRecipeKey).toBeTruthy();
    expect(String(asset.authorityThumbnailRecipeKey)).toMatch(/^[a-f0-9]{16,}$/u);

    const exactAssets = await getStudioProductionDashboard(root, {
      operation: "assets",
      assetIds: [fixture.assets.ahang.id, fixture.assets.completeGoldenMask.id, "missing-pinned-asset"],
      limit: 3,
    }) as StudioDashboardAssetsPage;
    expect(exactAssets.page.items.map((item) => item.id)).toEqual([
      fixture.assets.ahang.id,
      fixture.assets.completeGoldenMask.id,
    ]);
    expect(exactAssets.requestedAssetIds).toEqual([
      fixture.assets.ahang.id,
      fixture.assets.completeGoldenMask.id,
      "missing-pinned-asset",
    ]);
    expect(exactAssets.missingAssetIds).toEqual(["missing-pinned-asset"]);

    const appearances = await getStudioProductionDashboard(root, {
      operation: "appearances",
      assetId: fixture.assets.ahang.id,
      limit: 36,
    }) as StudioDashboardAppearancesPage;
    expect(appearances.page.items.length).toBeGreaterThan(0);
    expect(appearances.page.items[0]!.locator).toMatchObject({
      kind: "panel",
      unitId: expect.any(String),
      panelId: expect.any(String),
    });
  }, 120_000);

  it("selected panel 的生成投影超时会保留控制资产并失败软降级", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    process.env.AI_CANVAS_TEST_DASHBOARD_GENERATION_DELAY_LABEL = "宫格连续性与生成投影";
    process.env.AI_CANVAS_TEST_DASHBOARD_GENERATION_DELAY_MS = "2100";

    const unit = await getStudioProductionDashboard(fixture.root, {
      operation: "unit",
      unitId: fixture.units.sixPanel.unit.id,
      panelId: fixture.units.sixPanel.panels[0]!.id,
    }) as StudioDashboardUnitDetail;

    expect(unit.operation).toBe("unit");
    expect(unit.selectedPanel).toBeDefined();
    expect(unit.selectedPanel!.controlAssets.length).toBeGreaterThan(0);
    expect(unit.selectedPanel!.controlAssets.length).toBeLessThanOrEqual(6);
    expect(unit.selectedPanel!.generation).toMatchObject({
      status: "blocked",
      code: "generation-projection-degraded",
    });
    expect(unit.selectedPanel!.legacy).toEqual({
      sourceShot: "not-applicable",
      fusionStoryboardSheet: "not-applicable",
      p3VisualConstraints: "not-applicable",
      publication: "not-applicable",
    });
    expect(unit.nextAction).toMatchObject({
      code: "generation-projection-degraded",
      requiresWrite: false,
    });
  }, 120_000);

  it("非法 operation / limit 失败关闭", async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-p8-invalid-")));
    roots.push(temporaryRoot);
    const project = await createManagedProject({ parentRoot: temporaryRoot, name: "P8 非法" });
    await expect(getStudioProductionDashboard(project.paths.root, { operation: "units", limit: 0 } as any))
      .rejects.toThrow(/limit/);
    await expect(getStudioProductionDashboard(project.paths.root, { operation: "unit", unitId: "missing-unit" }))
      .rejects.toThrow(/不存在|unit/);
    await expect(getStudioProductionDashboard(project.paths.root, {
      operation: "assets",
      assetIds: ["a", "b", "c", "d", "e", "f", "g"],
    })).rejects.toThrow(/assetIds/);
    await expect(getStudioProductionDashboard(project.paths.root, {
      operation: "assets",
      assetIds: ["a"],
      category: "character",
    })).rejects.toThrow(/不能与/);
  });
});
