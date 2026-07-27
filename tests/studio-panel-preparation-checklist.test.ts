import { describe, expect, it } from "vitest";
import {
  buildStudioPanelPreparationChecklist,
  preparationInputFromUnitDetail,
  StudioPanelPreparationChecklistError,
} from "../src/core/studio-panel-preparation-checklist.js";

describe("studio-panel-preparation-checklist（Jellyfish JF-1 clean-room）", () => {
  it("全绿时 readyForGeneration=true", () => {
    const checklist = buildStudioPanelPreparationChecklist({
      unitId: "u1",
      panelId: "p1",
      panelStatus: "generation-ready",
      bindingCurrentness: "current",
      visualAction: "推镜头",
      controlAssetCount: 2,
      continuityConflictCount: 0,
      generationStatus: "ready",
    });
    expect(checklist.kind).toBe("studio-panel-preparation-checklist");
    expect(checklist.readyForGeneration).toBe(true);
    expect(checklist.pendingCount).toBe(0);
    expect(checklist.primaryBlocker).toBeUndefined();
    expect(checklist.items).toHaveLength(4);
    expect(checklist.items.every((i) => i.ready)).toBe(true);
  });

  it("绑定未就绪时 primaryBlocker=binding-closed", () => {
    const checklist = buildStudioPanelPreparationChecklist({
      unitId: "u1",
      panelId: "p2",
      panelStatus: "missing-binding",
      bindingCurrentness: "stale",
      visualAction: "",
      dialogue: "",
      controlAssetCount: 0,
      continuityConflictCount: 1,
      generationStatus: "blocked",
      generationMessage: "缺 freeze",
      nextActionReason: "先完成 BindingSet",
    });
    expect(checklist.readyForGeneration).toBe(false);
    expect(checklist.pendingCount).toBeGreaterThanOrEqual(2);
    expect(checklist.primaryBlocker?.id).toBe("binding-closed");
    expect(checklist.primaryBlocker?.reason).toContain("BindingSet");
  });

  it("preparationInputFromUnitDetail 从 dashboard 形状抽取", () => {
    const input = preparationInputFromUnitDetail({
      unit: { id: "unit-a" },
      selectedPanelId: "panel-a",
      selectedPanel: {
        panel: {
          id: "panel-a",
          status: "generation-ready",
          bindingCurrentness: "current",
          visualAction: "动作",
          assetIds: ["c1"],
        },
        continuityReview: { conflicts: [] },
        generation: { status: "ready" },
      },
      nextAction: { reason: "可生成" },
    });
    expect(input).toMatchObject({ unitId: "unit-a", panelId: "panel-a", controlAssetCount: 1 });
    const checklist = buildStudioPanelPreparationChecklist(input!);
    expect(checklist.readyForGeneration).toBe(true);
  });

  it("空 id 失败关闭", () => {
    expect(() =>
      buildStudioPanelPreparationChecklist({ unitId: "", panelId: "p", panelStatus: "x" }),
    ).toThrow(StudioPanelPreparationChecklistError);
  });
});
