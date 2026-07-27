/**
 * 驾驶舱选单元（无 panel）→ selectedPanel / 准备清单：真实 shipped 路径，非字符串测。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveUnitPanelFetchPlan,
  unitDetailHasPrepChecklistSource,
} from "../src/core/studio-dashboard-unit-selection.js";
import {
  buildStudioPanelPreparationChecklist,
  preparationInputFromUnitDetail,
} from "../src/core/studio-panel-preparation-checklist.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("studio-dashboard-unit-selection · 准备清单可达", () => {
  it("pure：无 selectedPanel 时 plan 要求带 panelId 二次拉取", () => {
    const plan = resolveUnitPanelFetchPlan("unit-a", {
      panels: [{ id: "panel-1" }, { id: "panel-2" }],
    });
    expect(plan).toEqual({
      unitId: "unit-a",
      panelId: "panel-1",
      needsRefetchWithPanel: true,
    });
    expect(unitDetailHasPrepChecklistSource({ panels: [{ id: "panel-1" }] })).toBe(false);
    expect(unitDetailHasPrepChecklistSource({
      panels: [{ id: "panel-1" }],
      selectedPanel: { panel: { id: "panel-1" } },
    })).toBe(true);
  });

  it("shipped getDashboard(unit 无 panelId) 返回 selectedPanel，可建准备清单", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const root = fixture.root;

    const units = await getStudioProductionDashboard(root, { operation: "units", limit: 36 });
    if (units.operation !== "units") throw new Error("expected units");
    expect(units.page.items.length).toBeGreaterThan(0);
    const unitId = units.page.items[0]!.id;

    // 关键：不传 panelId
    const detail = await getStudioProductionDashboard(root, { operation: "unit", unitId });
    if (detail.operation !== "unit") throw new Error("expected unit");

    // Core 应自选一格；若仅 id 无对象，fetch plan 要求二次
    const plan = resolveUnitPanelFetchPlan(unitId, detail);
    let finalDetail = detail;
    if (plan.needsRefetchWithPanel && plan.panelId) {
      const again = await getStudioProductionDashboard(root, {
        operation: "unit",
        unitId,
        panelId: plan.panelId,
      });
      if (again.operation !== "unit") throw new Error("expected unit refetch");
      finalDetail = again;
    }

    expect(unitDetailHasPrepChecklistSource(finalDetail)).toBe(true);
    expect(finalDetail.selectedPanel?.panel.id).toBeTruthy();

    const input = preparationInputFromUnitDetail(finalDetail);
    expect(input).not.toBeNull();
    const checklist = buildStudioPanelPreparationChecklist(input!);
    expect(checklist.unitId).toBe(unitId);
    expect(checklist.panelId).toBe(finalDetail.selectedPanel!.panel.id);
    expect(checklist.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(checklist)).not.toMatch(/\.sqlite|bodyPath/u);
  }, 120_000);
});
