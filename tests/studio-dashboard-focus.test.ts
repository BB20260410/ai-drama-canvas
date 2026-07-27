import { describe, expect, it, vi } from "vitest";
import {
  loadStudioDashboardUnitForFocus,
  shouldPreferFocusOverDefaultUnit,
  studioDashboardUnitQueryForFocus,
} from "../src/core/studio-dashboard-focus.js";
import type { StudioProductionDashboardResponse } from "../src/core/studio-production-dashboard.js";

describe("studio-dashboard-focus（A3 回程真实查询路径）", () => {
  it("focus 生成 unit 查询且 load 走真实 getDashboard 入口", async () => {
    const focus = {
      unitId: "p7-unit-b-two-panel",
      panelId: "p7-unit-b-panel-01",
      fromMode: "canvas" as const,
    };
    const query = studioDashboardUnitQueryForFocus(focus);
    expect(query).toEqual({
      operation: "unit",
      unitId: "p7-unit-b-two-panel",
      panelId: "p7-unit-b-panel-01",
    });
    expect(shouldPreferFocusOverDefaultUnit(focus)).toBe(true);
    expect(shouldPreferFocusOverDefaultUnit(null)).toBe(false);

    const getDashboard = vi.fn(async (_root: string, q: { operation: string; unitId?: string; panelId?: string }) => {
      expect(q.operation).toBe("unit");
      expect(q.unitId).toBe("p7-unit-b-two-panel");
      expect(q.panelId).toBe("p7-unit-b-panel-01");
      return {
        operation: "unit",
        unit: { id: "p7-unit-b-two-panel", label: "two", panelCount: 2 },
        panels: [{ id: "p7-unit-b-panel-01", ordinal: 1, label: "1" }],
        selectedPanelId: "p7-unit-b-panel-01",
        fingerprint: "abc",
      } as unknown as StudioProductionDashboardResponse;
    });

    const unit = await loadStudioDashboardUnitForFocus(
      getDashboard,
      "/tmp/fake-managed-root",
      focus,
    );
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(getDashboard.mock.calls[0]![0]).toBe("/tmp/fake-managed-root");
    expect(getDashboard.mock.calls[0]![1]).toMatchObject({
      operation: "unit",
      unitId: "p7-unit-b-two-panel",
      panelId: "p7-unit-b-panel-01",
    });
    expect(unit.unit.id).toBe("p7-unit-b-two-panel");
    expect(unit.selectedPanelId).toBe("p7-unit-b-panel-01");
  });

  it("UI 源码在 units 加载与 watch immediate 路径上应用 focus", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const vue = readFileSync(resolve(root, "src/renderer/src/components/StudioProductionDashboardView.vue"), "utf8");
    expect(vue).toContain("applyExternalFocus");
    expect(vue).toContain("immediate: true");
    expect(vue).toContain("shouldPreferFocusOverDefaultUnit");
    expect(vue).toContain("await applyExternalFocus()");
    // 有 focus 时不默认抢第一项
    expect(vue).toMatch(/shouldPreferFocusOverDefaultUnit\(props\.focus\)[\s\S]*selectUnit\(props\.focus/);
  });
});

